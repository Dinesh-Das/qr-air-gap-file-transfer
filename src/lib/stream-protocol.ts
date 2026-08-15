import { decode as decodeBase45, encode as encodeBase45 } from '@digitalbazaar/base45'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { MAX_BLOCK_STORE_BLOCKS } from './block-store'
import { createOpticalPassSchedule } from './optical-schedule'

/**
 * QRF3 is intentionally separate from QRF2. Its offsets and transfer lengths
 * are unsigned 64-bit wire values, while its public number API is restricted to
 * JavaScript safe integers. This covers files through 8 PiB without silently
 * rounding an offset.
 *
 * The module never materializes a transfer or a pass. A source is read one
 * block at a time and receivers write verified blocks directly to a random
 * access sink. Receipt tracking and durable storage belong to the caller.
 */

export const QRF3_FRAME_HEADER_SIZE = 112
/**
 * QRF3's QR-safe profile. With the 112-byte header and Base45 expansion, a
 * 700-byte block fits comfortably in ordinary high-density QR workflows.
 * Higher wire payloads are deliberately rejected instead of producing codes
 * that a UI may render but typical cameras cannot scan reliably.
 */
export const QRF3_DEFAULT_BLOCK_SIZE = 700
export const QRF3_MAX_BLOCK_SIZE = 700
export const QRF3_MAX_ROOT_NAME_BYTES = 255
export const QRF3_TRANSFER_ID_SIZE = 16
export const QRF3_CONNECTION_ID_SIZE = 16
export const QRF3_SHA256_SIZE = 32
export const QRF3_DEFAULT_MANIFEST_INTERVAL = 128

const QRF3_MAGIC = Uint8Array.of(0x51, 0x52, 0x46, 0x33) // "QRF3"
const QRF3_MANIFEST_VERSION = 3
const QRF3_MANIFEST_FIXED_SIZE = 89
const QRF3_FLAGS_OFFSET = 5
const QRF3_HEADER_LENGTH_OFFSET = 6
const QRF3_TRANSFER_ID_OFFSET = 8
const QRF3_MANIFEST_ID_OFFSET = 24
const QRF3_TRANSFER_LENGTH_OFFSET = 56
const QRF3_BLOCK_OFFSET_OFFSET = 64
const QRF3_PAYLOAD_LENGTH_OFFSET = 72
const QRF3_BLOCK_SHA256_OFFSET = 76
const QRF3_CRC32_OFFSET = 108
const BASE45_PATTERN = /^[0-9A-Z $%*+\-./:]*$/
const BLOCK_COMMITMENT_DOMAIN = new TextEncoder().encode('QRF3-BLOCK\0')

export enum Qrf3FrameType {
  Manifest = 0x01,
  Data = 0x02,
}

export enum Qrf3TransferPurpose {
  ConnectionTest = 0x01,
  Files = 0x02,
}

export class Qrf3ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'Qrf3ProtocolError'
  }
}

export interface Qrf3Manifest {
  transferId: Uint8Array
  transferLength: number
  archiveSha256: Uint8Array
  blockSize: number
  createdAtMs: number
  rootName: string
  purpose: Qrf3TransferPurpose
  connectionId: Uint8Array
}

export interface Qrf3ParsedFrame {
  type: Qrf3FrameType
  transferId: Uint8Array
  manifestId: Uint8Array
  transferLength: number
  offset: number
  payloadLength: number
  blockSha256: Uint8Array
  frameCrc32: number
  payload: Uint8Array
  manifest?: Qrf3Manifest
}

/** A stable, random-access byte source. Blob is the preferred browser source. */
export interface Qrf3ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

/** A sink that durably resolves only after a block is written at its offset. */
export interface Qrf3RandomAccessSink {
  writeAt(offset: number, bytes: Uint8Array): Promise<void>
}

export interface CreateQrf3TransferOptions {
  rootName: string
  blockSize?: number
  transferId?: Uint8Array
  createdAtMs?: number
  purpose?: Qrf3TransferPurpose
  connectionId?: Uint8Array
  /**
   * A previously computed digest of this exact immutable source. When omitted,
   * the source is hashed incrementally with bounded memory before framing.
   */
  archiveSha256?: Uint8Array
  hashReadSize?: number
}

export interface Qrf3PassOptions {
  pass?: number
  manifestInterval?: number
}

export interface Qrf3DataFrameRange {
  startBlock?: number
  endBlock?: number
}

export interface Qrf3TransferPlan {
  readonly blockCount: number
  readonly transferLength: number
  readonly blockSize: number
  /** Returns a defensive copy. */
  readonly manifest: Qrf3Manifest
  /** SHA-256 of the canonical manifest payload. Returns a defensive copy. */
  readonly manifestId: Uint8Array
  manifestFrame(): Promise<string>
  dataFrame(blockIndex: number): Promise<string>
  dataFrames(range?: Qrf3DataFrameRange): AsyncGenerator<string>
  /**
   * Generates a complete pass lazily. Each pass uses a deterministic seeded
   * permutation, spreading periodic camera losses across different blocks.
   */
  passFrames(options?: Qrf3PassOptions): AsyncGenerator<string>
}

export class Qrf3BlobSource implements Qrf3ByteSource {
  readonly size: number

  constructor(private readonly blob: Blob) {
    this.size = blob.size
    assertSafeUnsigned(this.size, 'blob.size')
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    assertReadRange(offset, length, this.size)
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer())
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** IEEE CRC-32, used as a fast corruption check before SHA-256 verification. */
export function qrf3Crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export async function qrf3Sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return nobleSha256(bytes)
}

/**
 * Hashes a source without creating a whole-transfer byte array. The incremental
 * implementation keeps at most readSize plus one SHA-256 compression block.
 */
export async function hashQrf3ByteSource(
  source: Qrf3ByteSource,
  readSize = 8 * 1024 * 1024,
): Promise<Uint8Array> {
  const sourceSize = source.size
  assertSafeUnsigned(sourceSize, 'source.size')
  if (!Number.isSafeInteger(readSize) || readSize < 1) {
    throw new Qrf3ProtocolError('readSize must be a positive safe integer.', 'INVALID_READ_SIZE')
  }

  const hasher = nobleSha256.create()
  for (let offset = 0; offset < sourceSize; ) {
    const length = Math.min(readSize, sourceSize - offset)
    const bytes = await source.read(offset, length)
    assertExactRead(bytes, length)
    hasher.update(bytes)
    offset += length
  }
  if (source.size !== sourceSize) {
    throw new Qrf3ProtocolError('Source size changed while it was being hashed.', 'SOURCE_CHANGED')
  }
  return hasher.digest()
}

/**
 * Canonical QRF3 manifest payload, all integer fields little-endian:
 *   u16 schema version (3)
 *   16-byte transfer ID
 *   u64 creation time in Unix milliseconds
 *   u64 transfer length
 *   u32 block size
 *   32-byte whole-transfer SHA-256
 *   u8 purpose
 *   16-byte connection ID
 *   u16 UTF-8 root-name length
 *   root-name UTF-8 bytes (NFC)
 */
export function encodeQrf3Manifest(manifest: Qrf3Manifest): Uint8Array {
  const transferId = copyFixedBytes(
    manifest.transferId,
    QRF3_TRANSFER_ID_SIZE,
    'transferId',
  )
  assertSafeUnsigned(manifest.createdAtMs, 'createdAtMs')
  assertSafeUnsigned(manifest.transferLength, 'transferLength')
  assertBlockSize(manifest.blockSize)
  const archiveSha256 = copySha256(manifest.archiveSha256, 'archiveSha256')
  assertPurpose(manifest.purpose)
  const connectionId = copyFixedBytes(
    manifest.connectionId,
    QRF3_CONNECTION_ID_SIZE,
    'connectionId',
  )
  const rootName = encodeRootName(manifest.rootName)

  const payload = new Uint8Array(QRF3_MANIFEST_FIXED_SIZE + rootName.length)
  const view = new DataView(payload.buffer)
  view.setUint16(0, QRF3_MANIFEST_VERSION, true)
  payload.set(transferId, 2)
  view.setBigUint64(18, BigInt(manifest.createdAtMs), true)
  view.setBigUint64(26, BigInt(manifest.transferLength), true)
  view.setUint32(34, manifest.blockSize, true)
  payload.set(archiveSha256, 38)
  view.setUint8(70, manifest.purpose)
  payload.set(connectionId, 71)
  view.setUint16(87, rootName.length, true)
  payload.set(rootName, QRF3_MANIFEST_FIXED_SIZE)
  return payload
}

export function parseQrf3Manifest(payload: Uint8Array): Qrf3Manifest {
  if (!(payload instanceof Uint8Array) || payload.length < QRF3_MANIFEST_FIXED_SIZE) {
    throw new Qrf3ProtocolError('QRF3 manifest payload is truncated.', 'TRUNCATED_MANIFEST')
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  if (view.getUint16(0, true) !== QRF3_MANIFEST_VERSION) {
    throw new Qrf3ProtocolError('Unsupported QRF3 manifest schema.', 'INVALID_MANIFEST_VERSION')
  }

  const createdAtMs = safeNumberFromUint64(view.getBigUint64(18, true), 'createdAtMs')
  const transferLength = safeNumberFromUint64(
    view.getBigUint64(26, true),
    'transferLength',
  )
  const blockSize = view.getUint32(34, true)
  assertBlockSize(blockSize)
  const purpose = view.getUint8(70)
  assertPurpose(purpose)
  const rootNameLength = view.getUint16(87, true)
  if (rootNameLength > QRF3_MAX_ROOT_NAME_BYTES) {
    throw new Qrf3ProtocolError('Manifest root name is too large.', 'ROOT_NAME_TOO_LARGE')
  }
  if (payload.length !== QRF3_MANIFEST_FIXED_SIZE + rootNameLength) {
    throw new Qrf3ProtocolError(
      'Manifest root-name length does not match the payload.',
      'INVALID_MANIFEST_LENGTH',
    )
  }

  let rootName: string
  try {
    rootName = new TextDecoder('utf-8', { fatal: true }).decode(
      payload.subarray(QRF3_MANIFEST_FIXED_SIZE),
    )
  } catch {
    throw new Qrf3ProtocolError('Manifest root name is not valid UTF-8.', 'INVALID_ROOT_NAME')
  }
  validateRootName(rootName)

  const manifest: Qrf3Manifest = {
    transferId: payload.slice(2, 18),
    createdAtMs,
    transferLength,
    blockSize,
    archiveSha256: payload.slice(38, 70),
    purpose,
    connectionId: payload.slice(71, 87),
    rootName,
  }
  if (!bytesEqual(encodeQrf3Manifest(manifest), payload)) {
    throw new Qrf3ProtocolError('Manifest is not canonically encoded.', 'NON_CANONICAL_MANIFEST')
  }
  return manifest
}

export async function qrf3ManifestIdentity(manifest: Qrf3Manifest): Promise<Uint8Array> {
  return qrf3Sha256(encodeQrf3Manifest(manifest))
}

export async function encodeQrf3ManifestFrame(manifest: Qrf3Manifest): Promise<string> {
  const payload = encodeQrf3Manifest(manifest)
  const manifestId = await qrf3Sha256(payload)
  return encodeQrf3FrameBinary({
    type: Qrf3FrameType.Manifest,
    transferId: manifest.transferId,
    manifestId,
    transferLength: manifest.transferLength,
    offset: 0,
    payload,
  })
}

export interface EncodeQrf3DataFrameOptions {
  transferId: Uint8Array
  manifestId: Uint8Array
  transferLength: number
  offset: number
  payload: Uint8Array
}

export async function encodeQrf3DataFrame(
  options: EncodeQrf3DataFrameOptions,
): Promise<string> {
  if (!(options.payload instanceof Uint8Array) || options.payload.length === 0) {
    throw new Qrf3ProtocolError('A QRF3 data block must not be empty.', 'INVALID_PAYLOAD_LENGTH')
  }
  if (options.payload.length > QRF3_MAX_BLOCK_SIZE) {
    throw new Qrf3ProtocolError('Data block exceeds the QRF3 limit.', 'BLOCK_TOO_LARGE')
  }
  assertSafeUnsigned(options.transferLength, 'transferLength')
  assertSafeUnsigned(options.offset, 'offset')
  assertRangeEnd(options.offset, options.payload.length, options.transferLength)
  return encodeQrf3FrameBinary({
    type: Qrf3FrameType.Data,
    transferId: options.transferId,
    manifestId: options.manifestId,
    transferLength: options.transferLength,
    offset: options.offset,
    payload: options.payload,
  })
}

interface Qrf3FrameBinaryOptions {
  type: Qrf3FrameType
  transferId: Uint8Array
  manifestId: Uint8Array
  transferLength: number
  offset: number
  payload: Uint8Array
}

async function encodeQrf3FrameBinary(options: Qrf3FrameBinaryOptions): Promise<string> {
  assertFrameType(options.type)
  const transferId = copyFixedBytes(
    options.transferId,
    QRF3_TRANSFER_ID_SIZE,
    'transferId',
  )
  const manifestId = copySha256(options.manifestId, 'manifestId')
  assertSafeUnsigned(options.transferLength, 'transferLength')
  assertSafeUnsigned(options.offset, 'offset')
  if (!(options.payload instanceof Uint8Array)) {
    throw new Qrf3ProtocolError('payload must be a Uint8Array.', 'INVALID_PAYLOAD')
  }
  if (options.payload.length > QRF3_MAX_BLOCK_SIZE) {
    throw new Qrf3ProtocolError('Frame payload exceeds the QRF3 limit.', 'BLOCK_TOO_LARGE')
  }

  const payload = new Uint8Array(options.payload)
  const binary = new Uint8Array(QRF3_FRAME_HEADER_SIZE + payload.length)
  binary.set(QRF3_MAGIC, 0)
  const view = new DataView(binary.buffer)
  view.setUint8(4, options.type)
  view.setUint8(QRF3_FLAGS_OFFSET, 0)
  view.setUint16(QRF3_HEADER_LENGTH_OFFSET, QRF3_FRAME_HEADER_SIZE, true)
  binary.set(transferId, QRF3_TRANSFER_ID_OFFSET)
  binary.set(manifestId, QRF3_MANIFEST_ID_OFFSET)
  view.setBigUint64(QRF3_TRANSFER_LENGTH_OFFSET, BigInt(options.transferLength), true)
  view.setBigUint64(QRF3_BLOCK_OFFSET_OFFSET, BigInt(options.offset), true)
  view.setUint32(QRF3_PAYLOAD_LENGTH_OFFSET, payload.length, true)
  binary.set(payload, QRF3_FRAME_HEADER_SIZE)

  const blockSha256 = await blockCommitment(
    options.type,
    transferId,
    manifestId,
    options.transferLength,
    options.offset,
    payload,
  )
  binary.set(blockSha256, QRF3_BLOCK_SHA256_OFFSET)
  view.setUint32(QRF3_CRC32_OFFSET, 0, true)
  view.setUint32(QRF3_CRC32_OFFSET, qrf3Crc32(binary), true)
  return encodeBase45(binary)
}

export async function parseQrf3EncodedFrame(encoded: string): Promise<Qrf3ParsedFrame> {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    !BASE45_PATTERN.test(encoded)
  ) {
    throw new Qrf3ProtocolError(
      'Frame is not strict RFC 9285 Base45 text.',
      'INVALID_BASE45',
    )
  }

  let binary: Uint8Array
  try {
    binary = decodeBase45(encoded)
  } catch {
    throw new Qrf3ProtocolError('Frame Base45 decoding failed.', 'INVALID_BASE45')
  }
  if (encodeBase45(binary) !== encoded) {
    throw new Qrf3ProtocolError('Frame Base45 text is not canonical.', 'INVALID_BASE45')
  }
  if (binary.length < QRF3_FRAME_HEADER_SIZE) {
    throw new Qrf3ProtocolError('QRF3 frame header is truncated.', 'TRUNCATED_FRAME')
  }
  for (let index = 0; index < QRF3_MAGIC.length; index += 1) {
    if (binary[index] !== QRF3_MAGIC[index]) {
      throw new Qrf3ProtocolError('Frame magic does not match QRF3.', 'INVALID_MAGIC')
    }
  }

  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
  const type = view.getUint8(4)
  assertFrameType(type)
  if (view.getUint8(QRF3_FLAGS_OFFSET) !== 0) {
    throw new Qrf3ProtocolError('QRF3 frame flags must be zero.', 'INVALID_FLAGS')
  }
  if (view.getUint16(QRF3_HEADER_LENGTH_OFFSET, true) !== QRF3_FRAME_HEADER_SIZE) {
    throw new Qrf3ProtocolError('QRF3 frame header length is invalid.', 'INVALID_HEADER_LENGTH')
  }

  const payloadLength = view.getUint32(QRF3_PAYLOAD_LENGTH_OFFSET, true)
  if (payloadLength > QRF3_MAX_BLOCK_SIZE) {
    throw new Qrf3ProtocolError('Frame payload exceeds the QRF3 limit.', 'BLOCK_TOO_LARGE')
  }
  if (binary.length !== QRF3_FRAME_HEADER_SIZE + payloadLength) {
    throw new Qrf3ProtocolError(
      'Frame payload length does not match its header.',
      'INVALID_PAYLOAD_LENGTH',
    )
  }

  const expectedCrc32 = view.getUint32(QRF3_CRC32_OFFSET, true)
  const crcInput = binary.slice()
  new DataView(crcInput.buffer).setUint32(QRF3_CRC32_OFFSET, 0, true)
  if (qrf3Crc32(crcInput) !== expectedCrc32) {
    throw new Qrf3ProtocolError('QRF3 frame CRC-32 check failed.', 'CRC_MISMATCH')
  }

  const transferId = binary.slice(
    QRF3_TRANSFER_ID_OFFSET,
    QRF3_TRANSFER_ID_OFFSET + QRF3_TRANSFER_ID_SIZE,
  )
  const manifestId = binary.slice(
    QRF3_MANIFEST_ID_OFFSET,
    QRF3_MANIFEST_ID_OFFSET + QRF3_SHA256_SIZE,
  )
  const transferLength = safeNumberFromUint64(
    view.getBigUint64(QRF3_TRANSFER_LENGTH_OFFSET, true),
    'transferLength',
  )
  const offset = safeNumberFromUint64(
    view.getBigUint64(QRF3_BLOCK_OFFSET_OFFSET, true),
    'offset',
  )
  const payload = binary.slice(QRF3_FRAME_HEADER_SIZE)

  if (type === Qrf3FrameType.Manifest) {
    if (offset !== 0) {
      throw new Qrf3ProtocolError('Manifest offset must be zero.', 'INVALID_MANIFEST_OFFSET')
    }
  } else {
    if (payload.length === 0) {
      throw new Qrf3ProtocolError('A QRF3 data block must not be empty.', 'INVALID_PAYLOAD_LENGTH')
    }
    assertRangeEnd(offset, payload.length, transferLength)
  }

  const expectedBlockSha256 = binary.slice(
    QRF3_BLOCK_SHA256_OFFSET,
    QRF3_BLOCK_SHA256_OFFSET + QRF3_SHA256_SIZE,
  )
  const actualBlockSha256 = await blockCommitment(
    type,
    transferId,
    manifestId,
    transferLength,
    offset,
    payload,
  )
  if (!bytesEqual(expectedBlockSha256, actualBlockSha256)) {
    throw new Qrf3ProtocolError(
      'QRF3 block SHA-256 commitment does not match.',
      'BLOCK_HASH_MISMATCH',
    )
  }

  const parsed: Qrf3ParsedFrame = {
    type,
    transferId,
    manifestId,
    transferLength,
    offset,
    payloadLength,
    blockSha256: expectedBlockSha256,
    frameCrc32: expectedCrc32,
    payload,
  }
  if (type === Qrf3FrameType.Manifest) {
    const manifest = parseQrf3Manifest(payload)
    const actualManifestId = await qrf3Sha256(payload)
    if (!bytesEqual(manifestId, actualManifestId)) {
      throw new Qrf3ProtocolError('Manifest identity does not match its payload.', 'MANIFEST_ID_MISMATCH')
    }
    if (!bytesEqual(manifest.transferId, transferId)) {
      throw new Qrf3ProtocolError('Manifest transfer ID does not match its frame.', 'TRANSFER_ID_MISMATCH')
    }
    if (manifest.transferLength !== transferLength) {
      throw new Qrf3ProtocolError(
        'Manifest transfer length does not match its frame.',
        'TRANSFER_LENGTH_MISMATCH',
      )
    }
    parsed.manifest = manifest
  }
  return parsed
}

/** Validates a parsed data frame against one accepted manifest. */
export function validateQrf3DataFrame(
  frame: Qrf3ParsedFrame,
  manifest: Qrf3Manifest,
  manifestId: Uint8Array,
): number {
  if (frame.type !== Qrf3FrameType.Data) {
    throw new Qrf3ProtocolError('Expected a QRF3 data frame.', 'INVALID_FRAME_TYPE')
  }
  const expectedManifestId = copySha256(manifestId, 'manifestId')
  if (!bytesEqual(frame.transferId, manifest.transferId)) {
    throw new Qrf3ProtocolError('Data transfer ID does not match the manifest.', 'TRANSFER_ID_MISMATCH')
  }
  if (!bytesEqual(frame.manifestId, expectedManifestId)) {
    throw new Qrf3ProtocolError('Data frame belongs to another manifest.', 'MANIFEST_ID_MISMATCH')
  }
  if (frame.transferLength !== manifest.transferLength) {
    throw new Qrf3ProtocolError(
      'Data transfer length does not match the manifest.',
      'TRANSFER_LENGTH_MISMATCH',
    )
  }
  if (frame.offset % manifest.blockSize !== 0) {
    throw new Qrf3ProtocolError('Data offset is not block-aligned.', 'MISALIGNED_BLOCK')
  }
  const expectedLength = Math.min(
    manifest.blockSize,
    manifest.transferLength - frame.offset,
  )
  if (frame.payload.length !== expectedLength) {
    throw new Qrf3ProtocolError('Data block length does not match the manifest.', 'INVALID_BLOCK_LENGTH')
  }
  return frame.offset / manifest.blockSize
}

/** Writes one already parsed and verified block without accumulating it in RAM. */
export async function writeQrf3DataFrame(
  frame: Qrf3ParsedFrame,
  manifest: Qrf3Manifest,
  manifestId: Uint8Array,
  sink: Qrf3RandomAccessSink,
): Promise<{ blockIndex: number; offset: number; length: number }> {
  if (!sink || typeof sink.writeAt !== 'function') {
    throw new Qrf3ProtocolError('A random-access sink is required.', 'INVALID_SINK')
  }
  const blockIndex = validateQrf3DataFrame(frame, manifest, manifestId)
  await sink.writeAt(frame.offset, frame.payload)
  return { blockIndex, offset: frame.offset, length: frame.payload.length }
}

export async function createQrf3Transfer(
  source: Qrf3ByteSource,
  options: CreateQrf3TransferOptions,
): Promise<Qrf3TransferPlan> {
  if (!source || typeof source.read !== 'function') {
    throw new Qrf3ProtocolError('A random-access byte source is required.', 'INVALID_SOURCE')
  }
  const transferLength = source.size
  assertSafeUnsigned(transferLength, 'source.size')
  const blockSize = options.blockSize ?? QRF3_DEFAULT_BLOCK_SIZE
  assertBlockSize(blockSize)
  const blockCount = ceilDivision(transferLength, blockSize)
  if (blockCount > MAX_BLOCK_STORE_BLOCKS) {
    throw new Qrf3ProtocolError(
      `Transfer requires ${blockCount.toLocaleString()} blocks; the safe limit is ${MAX_BLOCK_STORE_BLOCKS.toLocaleString()}.`,
      'TOO_MANY_BLOCKS',
    )
  }
  const transferId =
    options.transferId === undefined
      ? randomBytes(QRF3_TRANSFER_ID_SIZE)
      : copyFixedBytes(options.transferId, QRF3_TRANSFER_ID_SIZE, 'transferId')
  const createdAtMs = options.createdAtMs ?? Date.now()
  assertSafeUnsigned(createdAtMs, 'createdAtMs')
  const purpose = options.purpose ?? Qrf3TransferPurpose.Files
  assertPurpose(purpose)
  const connectionId =
    options.connectionId === undefined
      ? randomBytes(QRF3_CONNECTION_ID_SIZE)
      : copyFixedBytes(options.connectionId, QRF3_CONNECTION_ID_SIZE, 'connectionId')
  validateRootName(options.rootName)

  const archiveSha256 =
    options.archiveSha256 === undefined
      ? await hashQrf3ByteSource(source, options.hashReadSize)
      : copySha256(options.archiveSha256, 'archiveSha256')
  if (source.size !== transferLength) {
    throw new Qrf3ProtocolError('Source size changed while preparing the transfer.', 'SOURCE_CHANGED')
  }

  const manifest: Qrf3Manifest = {
    transferId,
    transferLength,
    archiveSha256,
    blockSize,
    createdAtMs,
    rootName: options.rootName,
    purpose,
    connectionId,
  }
  const manifestPayload = encodeQrf3Manifest(manifest)
  const manifestId = await qrf3Sha256(manifestPayload)
  return new Qrf3TransferPlanImpl(source, manifest, manifestPayload, manifestId)
}

class Qrf3TransferPlanImpl implements Qrf3TransferPlan {
  readonly blockCount: number
  readonly transferLength: number
  readonly blockSize: number
  private readonly internalManifest: Qrf3Manifest
  private readonly internalManifestId: Uint8Array
  private manifestFramePromise?: Promise<string>

  constructor(
    private readonly source: Qrf3ByteSource,
    manifest: Qrf3Manifest,
    private readonly manifestPayload: Uint8Array,
    manifestId: Uint8Array,
  ) {
    this.internalManifest = cloneManifest(manifest)
    this.internalManifestId = manifestId.slice()
    this.transferLength = manifest.transferLength
    this.blockSize = manifest.blockSize
    this.blockCount = ceilDivision(this.transferLength, this.blockSize)
  }

  get manifest(): Qrf3Manifest {
    return cloneManifest(this.internalManifest)
  }

  get manifestId(): Uint8Array {
    return this.internalManifestId.slice()
  }

  manifestFrame(): Promise<string> {
    return (this.manifestFramePromise ??= encodeQrf3FrameBinary({
      type: Qrf3FrameType.Manifest,
      transferId: this.internalManifest.transferId,
      manifestId: this.internalManifestId,
      transferLength: this.transferLength,
      offset: 0,
      payload: this.manifestPayload,
    }))
  }

  async dataFrame(blockIndex: number): Promise<string> {
    assertBlockIndex(blockIndex, this.blockCount)
    const offset = blockIndex * this.blockSize
    if (!Number.isSafeInteger(offset)) {
      throw new Qrf3ProtocolError('Block offset exceeds the safe-integer range.', 'INTEGER_RANGE')
    }
    const length = Math.min(this.blockSize, this.transferLength - offset)
    if (this.source.size !== this.transferLength) {
      throw new Qrf3ProtocolError('Source size changed after transfer preparation.', 'SOURCE_CHANGED')
    }
    const payload = await this.source.read(offset, length)
    assertExactRead(payload, length)
    return encodeQrf3DataFrame({
      transferId: this.internalManifest.transferId,
      manifestId: this.internalManifestId,
      transferLength: this.transferLength,
      offset,
      payload,
    })
  }

  async *dataFrames(range: Qrf3DataFrameRange = {}): AsyncGenerator<string> {
    const startBlock = range.startBlock ?? 0
    const endBlock = range.endBlock ?? this.blockCount
    assertBlockBoundary(startBlock, this.blockCount, 'startBlock')
    assertBlockBoundary(endBlock, this.blockCount, 'endBlock')
    if (endBlock < startBlock) {
      throw new Qrf3ProtocolError('endBlock must not precede startBlock.', 'INVALID_BLOCK_RANGE')
    }
    for (let blockIndex = startBlock; blockIndex < endBlock; blockIndex += 1) {
      yield await this.dataFrame(blockIndex)
    }
  }

  async *passFrames(options: Qrf3PassOptions = {}): AsyncGenerator<string> {
    const pass = options.pass ?? 0
    if (!Number.isSafeInteger(pass) || pass < 0) {
      throw new Qrf3ProtocolError('pass must be a non-negative safe integer.', 'INVALID_PASS')
    }
    const manifestInterval =
      options.manifestInterval ?? QRF3_DEFAULT_MANIFEST_INTERVAL
    if (!Number.isSafeInteger(manifestInterval) || manifestInterval < 1) {
      throw new Qrf3ProtocolError(
        'manifestInterval must be a positive safe integer.',
        'INVALID_MANIFEST_INTERVAL',
      )
    }

    const manifestFrame = await this.manifestFrame()
    yield manifestFrame
    if (this.blockCount === 0) return
    const schedule = createOpticalPassSchedule({
      totalChunks: this.blockCount,
      pass,
      seed: transferSeed(this.internalManifest.transferId),
    })
    let position = 0
    for (const blockIndex of schedule) {
      yield await this.dataFrame(blockIndex)
      position += 1
      if (position % manifestInterval === 0 && position < this.blockCount) {
        yield manifestFrame
      }
    }
  }
}

async function blockCommitment(
  type: Qrf3FrameType,
  transferId: Uint8Array,
  manifestId: Uint8Array,
  transferLength: number,
  offset: number,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const metadata = new Uint8Array(1 + 16 + 32 + 8 + 8 + 4)
  const view = new DataView(metadata.buffer)
  view.setUint8(0, type)
  metadata.set(transferId, 1)
  metadata.set(manifestId, 17)
  view.setBigUint64(49, BigInt(transferLength), true)
  view.setBigUint64(57, BigInt(offset), true)
  view.setUint32(65, payload.length, true)

  const commitment = new Uint8Array(
    BLOCK_COMMITMENT_DOMAIN.length + metadata.length + payload.length,
  )
  commitment.set(BLOCK_COMMITMENT_DOMAIN, 0)
  commitment.set(metadata, BLOCK_COMMITMENT_DOMAIN.length)
  commitment.set(payload, BLOCK_COMMITMENT_DOMAIN.length + metadata.length)
  return qrf3Sha256(commitment)
}

function cloneManifest(manifest: Qrf3Manifest): Qrf3Manifest {
  return {
    ...manifest,
    transferId: manifest.transferId.slice(),
    archiveSha256: manifest.archiveSha256.slice(),
    connectionId: manifest.connectionId.slice(),
  }
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

function transferSeed(transferId: Uint8Array): number {
  return new DataView(
    transferId.buffer,
    transferId.byteOffset,
    transferId.byteLength,
  ).getUint32(0, true)
}

function encodeRootName(rootName: string): Uint8Array {
  validateRootName(rootName)
  const bytes = new TextEncoder().encode(rootName)
  if (bytes.length > QRF3_MAX_ROOT_NAME_BYTES) {
    throw new Qrf3ProtocolError('Root name is too large for QRF3.', 'ROOT_NAME_TOO_LARGE')
  }
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== rootName) {
    throw new Qrf3ProtocolError('Root name is not canonical UTF-8.', 'INVALID_ROOT_NAME')
  }
  return bytes
}

function validateRootName(rootName: string): void {
  if (typeof rootName !== 'string' || rootName.length === 0) {
    throw new Qrf3ProtocolError('Root name must not be empty.', 'INVALID_ROOT_NAME')
  }
  if (
    rootName !== rootName.normalize('NFC') ||
    rootName === '.' ||
    rootName === '..' ||
    rootName.includes('\0') ||
    rootName.includes('/') ||
    rootName.includes('\\')
  ) {
    throw new Qrf3ProtocolError('Root name is not canonical and safe.', 'INVALID_ROOT_NAME')
  }
}

function copySha256(bytes: Uint8Array, field: string): Uint8Array {
  return copyFixedBytes(bytes, QRF3_SHA256_SIZE, field)
}

function copyFixedBytes(bytes: Uint8Array, length: number, field: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Qrf3ProtocolError(
      `${field} must contain exactly ${length} bytes.`,
      'INVALID_BYTE_LENGTH',
    )
  }
  return bytes.slice()
}

function assertFrameType(type: number): asserts type is Qrf3FrameType {
  if (type !== Qrf3FrameType.Manifest && type !== Qrf3FrameType.Data) {
    throw new Qrf3ProtocolError(`Unsupported QRF3 frame type ${type}.`, 'INVALID_FRAME_TYPE')
  }
}

function assertPurpose(purpose: number): asserts purpose is Qrf3TransferPurpose {
  if (
    purpose !== Qrf3TransferPurpose.ConnectionTest &&
    purpose !== Qrf3TransferPurpose.Files
  ) {
    throw new Qrf3ProtocolError(`Unsupported QRF3 purpose ${purpose}.`, 'INVALID_PURPOSE')
  }
}

function assertBlockSize(blockSize: number): void {
  if (
    !Number.isSafeInteger(blockSize) ||
    blockSize < 1 ||
    blockSize > QRF3_MAX_BLOCK_SIZE
  ) {
    throw new Qrf3ProtocolError(
      `blockSize must be between 1 and ${QRF3_MAX_BLOCK_SIZE}.`,
      'INVALID_BLOCK_SIZE',
    )
  }
}

function assertSafeUnsigned(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Qrf3ProtocolError(
      `${field} must be a non-negative safe integer.`,
      'INTEGER_RANGE',
    )
  }
}

function safeNumberFromUint64(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Qrf3ProtocolError(
      `${field} exceeds JavaScript's safe-integer range.`,
      'INTEGER_RANGE',
    )
  }
  return Number(value)
}

function assertRangeEnd(offset: number, length: number, transferLength: number): void {
  const end = offset + length
  if (!Number.isSafeInteger(end) || offset >= transferLength || end > transferLength) {
    throw new Qrf3ProtocolError('Data block is outside the transfer.', 'INVALID_BLOCK_RANGE')
  }
}

function assertReadRange(offset: number, length: number, size: number): void {
  assertSafeUnsigned(offset, 'offset')
  assertSafeUnsigned(length, 'length')
  const end = offset + length
  if (!Number.isSafeInteger(end) || end > size) {
    throw new Qrf3ProtocolError('Read is outside the source.', 'INVALID_READ_RANGE')
  }
}

function assertExactRead(bytes: Uint8Array, expectedLength: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== expectedLength) {
    throw new Qrf3ProtocolError(
      `Source returned ${bytes instanceof Uint8Array ? bytes.length : 'non-byte'} data; expected ${expectedLength} bytes.`,
      'SHORT_SOURCE_READ',
    )
  }
}

function assertBlockIndex(blockIndex: number, blockCount: number): void {
  if (
    !Number.isSafeInteger(blockIndex) ||
    blockIndex < 0 ||
    blockIndex >= blockCount
  ) {
    throw new Qrf3ProtocolError('Block index is outside the transfer.', 'INVALID_BLOCK_INDEX')
  }
}

function assertBlockBoundary(value: number, blockCount: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > blockCount) {
    throw new Qrf3ProtocolError(`${field} is outside the transfer.`, 'INVALID_BLOCK_RANGE')
  }
}

function ceilDivision(dividend: number, divisor: number): number {
  if (dividend === 0) return 0
  return Math.floor((dividend - 1) / divisor) + 1
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}
