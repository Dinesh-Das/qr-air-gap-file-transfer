import { decode as decodeBase45, encode as encodeBase45 } from '@digitalbazaar/base45'

export const FRAME_HEADER_SIZE = 23
export const DEFAULT_CHUNK_SIZE = 700
export const DEFAULT_MANIFEST_INTERVAL = 10
export const MAX_TOTAL_CHUNKS = 1_000_000
// Common filesystems cap one path segment at 255 encoded bytes. Keeping the
// manifest root to the same limit also guarantees the repeated manifest fits
// comfortably in a QR code.
export const MAX_ROOT_NAME_BYTES = 255

const MAGIC = new Uint8Array([0x51, 0x52, 0x46, 0x54]) // "QRFT"
const MANIFEST_FIXED_SIZE = 52
const SHA256_SIZE = 32
const BASE45_PATTERN = /^[0-9A-Z $%*+\-./:]*$/

export enum FrameType {
  Manifest = 0x01,
  Data = 0x02,
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export interface TransferManifest {
  archiveLength: number
  archiveSha256: Uint8Array
  chunkSize: number
  createdAtMs: number
  rootName: string
}

export interface ParsedFrame {
  type: FrameType
  transferId: number
  chunkIndex: number
  totalChunks: number
  payloadLength: number
  payloadCrc32: number
  payload: Uint8Array
  manifest?: TransferManifest
}

export interface PrepareTransferOptions {
  rootName: string
  chunkSize?: number
  transferId?: number
  createdAtMs?: number
  manifestInterval?: number
}

export interface PreparedTransfer {
  transferId: number
  manifest: TransferManifest
  manifestFrame: string
  dataFrames: string[]
  /** One complete sender pass. Repeat this sequence until the receiver finishes. */
  loopFrames: string[]
  totalChunks: number
}

export type AccumulatorStatus =
  | 'ignored'
  | 'receiving'
  | 'verifying'
  | 'complete'
  | 'verification-failed'

export interface AccumulatorResult {
  accepted: boolean
  status: AccumulatorStatus
  transferId?: number
  rootName?: string
  receivedChunks: number
  totalChunks: number
  receivedBytes: number
  percent: number
  duplicate?: boolean
  error?: string
  /** Present only after the manifest SHA-256 gate succeeds. */
  archiveBytes?: Uint8Array
}

export interface TransferAccumulatorOptions {
  maxArchiveBytes?: number
  maxTotalChunks?: number
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < table.length; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

/** IEEE CRC-32 (polynomial 0xEDB88320), returned as an unsigned integer. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const stableBytes = new Uint8Array(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', stableBytes)
  return new Uint8Array(digest)
}

/**
 * Manifest payload, all integers little-endian:
 *   u64 archive length
 *   32 bytes archive SHA-256
 *   u16 data chunk size
 *   u64 creation time in Unix milliseconds
 *   u16 UTF-8 root-name length
 *   root-name UTF-8 bytes
 */
export function encodeManifest(manifest: TransferManifest): Uint8Array {
  assertSafeUint64(manifest.archiveLength, 'archiveLength')
  assertUint16(manifest.chunkSize, 'chunkSize')
  if (manifest.chunkSize === 0) {
    throw new ProtocolError('chunkSize must be greater than zero.', 'INVALID_CHUNK_SIZE')
  }
  assertSafeUint64(manifest.createdAtMs, 'createdAtMs')
  if (manifest.archiveSha256.length !== SHA256_SIZE) {
    throw new ProtocolError('archiveSha256 must contain exactly 32 bytes.', 'INVALID_SHA256')
  }

  const rootNameBytes = encodeRootName(manifest.rootName)
  const payload = new Uint8Array(MANIFEST_FIXED_SIZE + rootNameBytes.length)
  const view = new DataView(payload.buffer)
  view.setBigUint64(0, BigInt(manifest.archiveLength), true)
  payload.set(manifest.archiveSha256, 8)
  view.setUint16(40, manifest.chunkSize, true)
  view.setBigUint64(42, BigInt(manifest.createdAtMs), true)
  view.setUint16(50, rootNameBytes.length, true)
  payload.set(rootNameBytes, MANIFEST_FIXED_SIZE)
  return payload
}

export function parseManifest(payload: Uint8Array): TransferManifest {
  if (payload.length < MANIFEST_FIXED_SIZE) {
    throw new ProtocolError('Manifest payload is truncated.', 'TRUNCATED_MANIFEST')
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const archiveLength = safeNumberFromUint64(view.getBigUint64(0, true), 'archiveLength')
  const chunkSize = view.getUint16(40, true)
  if (chunkSize === 0) {
    throw new ProtocolError('Manifest chunkSize must be greater than zero.', 'INVALID_CHUNK_SIZE')
  }
  const createdAtMs = safeNumberFromUint64(view.getBigUint64(42, true), 'createdAtMs')
  const rootNameLength = view.getUint16(50, true)
  if (rootNameLength > MAX_ROOT_NAME_BYTES) {
    throw new ProtocolError('Manifest root name is too large.', 'ROOT_NAME_TOO_LARGE')
  }
  if (payload.length !== MANIFEST_FIXED_SIZE + rootNameLength) {
    throw new ProtocolError('Manifest root-name length does not match its payload.', 'INVALID_MANIFEST_LENGTH')
  }

  let rootName: string
  try {
    rootName = new TextDecoder('utf-8', { fatal: true }).decode(
      payload.subarray(MANIFEST_FIXED_SIZE),
    )
  } catch {
    throw new ProtocolError('Manifest root name is not valid UTF-8.', 'INVALID_ROOT_NAME')
  }
  validateRootName(rootName)

  return {
    archiveLength,
    archiveSha256: payload.slice(8, 40),
    chunkSize,
    createdAtMs,
    rootName,
  }
}

export function encodeFrame(
  type: FrameType,
  transferId: number,
  chunkIndex: number,
  totalChunks: number,
  payload: Uint8Array,
): string {
  assertFrameType(type)
  assertUint32(transferId, 'transferId')
  assertUint32(chunkIndex, 'chunkIndex')
  assertUint32(totalChunks, 'totalChunks')
  assertUint16(payload.length, 'payloadLength')
  if (totalChunks > MAX_TOTAL_CHUNKS) {
    throw new ProtocolError('Frame chunk count exceeds the safety limit.', 'TOO_MANY_CHUNKS')
  }
  if (type === FrameType.Manifest && chunkIndex !== 0) {
    throw new ProtocolError('Manifest chunkIndex must be zero.', 'INVALID_MANIFEST_INDEX')
  }
  if (type === FrameType.Data && (totalChunks === 0 || chunkIndex >= totalChunks)) {
    throw new ProtocolError('Data chunk index is outside the transfer.', 'INVALID_CHUNK_INDEX')
  }

  const binary = new Uint8Array(FRAME_HEADER_SIZE + payload.length)
  binary.set(MAGIC, 0)
  const view = new DataView(binary.buffer)
  view.setUint8(4, type)
  view.setUint32(5, transferId, true)
  view.setUint32(9, chunkIndex, true)
  view.setUint32(13, totalChunks, true)
  view.setUint16(17, payload.length, true)
  view.setUint32(19, crc32(payload), true)
  binary.set(payload, FRAME_HEADER_SIZE)
  return encodeBase45(binary)
}

export function parseEncodedFrame(encoded: string): ParsedFrame {
  if (typeof encoded !== 'string' || !BASE45_PATTERN.test(encoded)) {
    throw new ProtocolError('Frame is not strict RFC 9285 Base45 text.', 'INVALID_BASE45')
  }

  let binary: Uint8Array
  try {
    binary = decodeBase45(encoded)
  } catch {
    throw new ProtocolError('Frame Base45 decoding failed.', 'INVALID_BASE45')
  }
  // Reject non-canonical encodings and guard against permissive decoder behavior.
  if (encodeBase45(binary) !== encoded) {
    throw new ProtocolError('Frame Base45 text is not canonical.', 'INVALID_BASE45')
  }
  if (binary.length < FRAME_HEADER_SIZE) {
    throw new ProtocolError('Frame header is truncated.', 'TRUNCATED_FRAME')
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (binary[i] !== MAGIC[i]) {
      throw new ProtocolError('Frame magic does not match QRFT.', 'INVALID_MAGIC')
    }
  }

  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
  const type = view.getUint8(4)
  assertFrameType(type)
  const transferId = view.getUint32(5, true)
  const chunkIndex = view.getUint32(9, true)
  const totalChunks = view.getUint32(13, true)
  const payloadLength = view.getUint16(17, true)
  const payloadCrc32 = view.getUint32(19, true)
  if (totalChunks > MAX_TOTAL_CHUNKS) {
    throw new ProtocolError('Frame chunk count exceeds the safety limit.', 'TOO_MANY_CHUNKS')
  }
  if (binary.length !== FRAME_HEADER_SIZE + payloadLength) {
    throw new ProtocolError('Frame payload length does not match its header.', 'INVALID_PAYLOAD_LENGTH')
  }
  if (type === FrameType.Manifest && chunkIndex !== 0) {
    throw new ProtocolError('Manifest chunkIndex must be zero.', 'INVALID_MANIFEST_INDEX')
  }
  if (type === FrameType.Data && (totalChunks === 0 || chunkIndex >= totalChunks)) {
    throw new ProtocolError('Data chunk index is outside the transfer.', 'INVALID_CHUNK_INDEX')
  }

  const payload = binary.slice(FRAME_HEADER_SIZE)
  if (crc32(payload) !== payloadCrc32) {
    throw new ProtocolError('Frame payload CRC-32 check failed.', 'CRC_MISMATCH')
  }

  const frame: ParsedFrame = {
    type,
    transferId,
    chunkIndex,
    totalChunks,
    payloadLength,
    payloadCrc32,
    payload,
  }
  if (type === FrameType.Manifest) {
    frame.manifest = parseManifest(payload)
  }
  return frame
}

export async function prepareTransfer(
  archiveBytes: Uint8Array,
  options: PrepareTransferOptions,
): Promise<PreparedTransfer> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  assertUint16(chunkSize, 'chunkSize')
  if (chunkSize === 0) {
    throw new ProtocolError('chunkSize must be greater than zero.', 'INVALID_CHUNK_SIZE')
  }
  const manifestInterval = options.manifestInterval ?? DEFAULT_MANIFEST_INTERVAL
  if (!Number.isSafeInteger(manifestInterval) || manifestInterval < 1) {
    throw new ProtocolError('manifestInterval must be a positive integer.', 'INVALID_MANIFEST_INTERVAL')
  }
  const transferId = options.transferId ?? randomUint32()
  assertUint32(transferId, 'transferId')
  const createdAtMs = options.createdAtMs ?? Date.now()
  assertSafeUint64(createdAtMs, 'createdAtMs')
  validateRootName(options.rootName)

  // Copy once so the hash and chunks describe the same immutable snapshot.
  const archive = new Uint8Array(archiveBytes)
  const totalChunks = Math.ceil(archive.length / chunkSize)
  if (totalChunks > MAX_TOTAL_CHUNKS) {
    throw new ProtocolError('Transfer requires too many chunks.', 'TOO_MANY_CHUNKS')
  }

  const manifest: TransferManifest = {
    archiveLength: archive.length,
    archiveSha256: await sha256(archive),
    chunkSize,
    createdAtMs,
    rootName: options.rootName,
  }
  const manifestFrame = encodeFrame(
    FrameType.Manifest,
    transferId,
    0,
    totalChunks,
    encodeManifest(manifest),
  )
  const dataFrames: string[] = []
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize
    dataFrames.push(
      encodeFrame(
        FrameType.Data,
        transferId,
        index,
        totalChunks,
        archive.subarray(start, Math.min(start + chunkSize, archive.length)),
      ),
    )
  }

  const loopFrames = [manifestFrame]
  for (let index = 0; index < dataFrames.length; index += 1) {
    loopFrames.push(dataFrames[index])
    if ((index + 1) % manifestInterval === 0 && index + 1 < dataFrames.length) {
      loopFrames.push(manifestFrame)
    }
  }

  return { transferId, manifest, manifestFrame, dataFrames, loopFrames, totalChunks }
}

export class TransferAccumulator {
  private readonly maxArchiveBytes: number
  private readonly maxTotalChunks: number
  private transferId?: number
  private totalChunks = 0
  private manifest?: TransferManifest
  private manifestPayload?: Uint8Array
  private readonly chunks = new Map<number, Uint8Array>()
  private receivedBytes = 0
  private completedArchive?: Uint8Array
  private verificationPromise?: Promise<Uint8Array | undefined>
  private generation = 0

  constructor(options: TransferAccumulatorOptions = {}) {
    this.maxArchiveBytes = options.maxArchiveBytes ?? 128 * 1024 * 1024
    this.maxTotalChunks = options.maxTotalChunks ?? MAX_TOTAL_CHUNKS
    if (!Number.isSafeInteger(this.maxArchiveBytes) || this.maxArchiveBytes < 0) {
      throw new ProtocolError('maxArchiveBytes must be a non-negative safe integer.', 'INVALID_LIMIT')
    }
    if (
      !Number.isSafeInteger(this.maxTotalChunks) ||
      this.maxTotalChunks < 0 ||
      this.maxTotalChunks > MAX_TOTAL_CHUNKS
    ) {
      throw new ProtocolError('maxTotalChunks is invalid.', 'INVALID_LIMIT')
    }
  }

  reset(): void {
    this.generation += 1
    this.transferId = undefined
    this.totalChunks = 0
    this.manifest = undefined
    this.manifestPayload = undefined
    this.chunks.clear()
    this.receivedBytes = 0
    this.completedArchive = undefined
    this.verificationPromise = undefined
  }

  async ingest(encoded: string): Promise<AccumulatorResult> {
    let frame: ParsedFrame
    try {
      frame = parseEncodedFrame(encoded)
    } catch (error) {
      return this.result(
        'ignored',
        false,
        error instanceof Error ? error.message : 'Invalid frame.',
      )
    }

    if (frame.totalChunks > this.maxTotalChunks) {
      return this.result('ignored', false, 'Frame exceeds the configured chunk-count limit.')
    }

    if (frame.type === FrameType.Manifest) {
      const manifest = frame.manifest!
      const expectedChunks = Math.ceil(manifest.archiveLength / manifest.chunkSize)
      if (manifest.archiveLength > this.maxArchiveBytes) {
        return this.result('ignored', false, 'Manifest exceeds the configured archive-size limit.')
      }
      if (expectedChunks !== frame.totalChunks) {
        return this.result('ignored', false, 'Manifest length and chunk count are inconsistent.')
      }
    } else if (this.transferId === undefined) {
      // Waiting for a repeated manifest bounds memory and prevents an arbitrary
      // data QR or damaged header from pinning the receiver to a bogus session.
      return this.result('ignored', false, 'Waiting for a valid transfer manifest.')
    }

    if (this.transferId === undefined) {
      this.transferId = frame.transferId
      this.totalChunks = frame.totalChunks
    } else if (frame.transferId !== this.transferId) {
      if (
        frame.type === FrameType.Manifest &&
        this.chunks.size === 0 &&
        this.manifestPayload &&
        bytesEqual(this.manifestPayload, frame.payload)
      ) {
        // Recover from a transfer-ID bit error in the unchecked v1 header when
        // the repeated, CRC-protected manifest payload is otherwise identical.
        this.transferId = frame.transferId
        this.totalChunks = frame.totalChunks
      } else {
        return this.result('ignored', false, 'Frame belongs to a different transfer.')
      }
    } else if (frame.totalChunks !== this.totalChunks) {
      return this.result('ignored', false, 'Frame conflicts with the transfer chunk count.')
    }

    if (this.completedArchive) {
      return this.result('complete', true, undefined, false, this.completedArchive)
    }

    let duplicate = false
    if (frame.type === FrameType.Manifest) {
      const manifest = frame.manifest!
      if (this.manifestPayload && !bytesEqual(this.manifestPayload, frame.payload)) {
        return this.result('ignored', false, 'Conflicting manifest received for this transfer.')
      }
      duplicate = this.manifestPayload !== undefined
      this.manifest = manifest
      this.manifestPayload = frame.payload.slice()
      this.dropChunksWithInvalidLength()
    } else {
      if (!this.manifest || !this.hasExpectedChunkLength(frame.chunkIndex, frame.payloadLength)) {
        return this.result('ignored', false, 'Data chunk length is inconsistent with the manifest.')
      }
      const existing = this.chunks.get(frame.chunkIndex)
      if (existing) {
        duplicate = true
      } else {
        const stored = frame.payload.slice()
        if (
          this.receivedBytes + stored.length > this.manifest.archiveLength ||
          this.receivedBytes + stored.length > this.maxArchiveBytes
        ) {
          return this.result('ignored', false, 'Data exceeds the configured archive-size limit.')
        }
        this.chunks.set(frame.chunkIndex, stored)
        this.receivedBytes += stored.length
      }
    }

    if (!this.manifest || this.chunks.size !== this.totalChunks) {
      return this.result('receiving', true, undefined, duplicate)
    }

    const verificationGeneration = this.generation
    const verification =
      this.verificationPromise ?? (this.verificationPromise = this.verifyCompleteArchive())
    const verifiedArchive = await verification
    if (verificationGeneration !== this.generation) {
      return this.result('ignored', false, 'Transfer was reset during verification.')
    }
    if (verifiedArchive) {
      this.completedArchive = verifiedArchive
      this.verificationPromise = undefined
      return this.result('complete', true, undefined, duplicate, verifiedArchive)
    }
    if (verification !== this.verificationPromise) {
      return this.result('receiving', true, undefined, duplicate)
    }
    this.verificationPromise = undefined

    // A CRC-valid frame can still have a corrupted header because the v1 wire
    // format checksums only its payload. Clear the pass so later loop repeats
    // can replace a payload that landed under the wrong index.
    this.chunks.clear()
    this.receivedBytes = 0
    return this.result(
      'verification-failed',
      true,
      'All chunks arrived, but the archive SHA-256 did not match; scanning continues.',
      duplicate,
    )
  }

  private async verifyCompleteArchive(): Promise<Uint8Array | undefined> {
    const manifest = this.manifest!
    const archive = new Uint8Array(manifest.archiveLength)
    let offset = 0
    for (let index = 0; index < this.totalChunks; index += 1) {
      const chunk = this.chunks.get(index)
      if (!chunk) return undefined
      archive.set(chunk, offset)
      offset += chunk.length
    }
    if (offset !== manifest.archiveLength) return undefined
    if (!bytesEqual(await sha256(archive), manifest.archiveSha256)) return undefined
    return archive
  }

  private hasExpectedChunkLength(index: number, actualLength: number): boolean {
    const manifest = this.manifest!
    const expectedLength =
      index === this.totalChunks - 1
        ? manifest.archiveLength - index * manifest.chunkSize
        : manifest.chunkSize
    return actualLength === expectedLength
  }

  private dropChunksWithInvalidLength(): void {
    for (const [index, chunk] of this.chunks) {
      if (!this.hasExpectedChunkLength(index, chunk.length)) {
        this.chunks.delete(index)
        this.receivedBytes -= chunk.length
      }
    }
  }

  private result(
    status: AccumulatorStatus,
    accepted: boolean,
    error?: string,
    duplicate?: boolean,
    archiveBytes?: Uint8Array,
  ): AccumulatorResult {
    const percent =
      this.totalChunks === 0
        ? this.manifest
          ? 100
          : 0
        : (this.chunks.size / this.totalChunks) * 100
    return {
      accepted,
      status,
      transferId: this.transferId,
      rootName: this.manifest?.rootName,
      receivedChunks: this.chunks.size,
      totalChunks: this.totalChunks,
      receivedBytes: this.receivedBytes,
      percent,
      duplicate,
      error,
      archiveBytes: archiveBytes?.slice(),
    }
  }
}

function randomUint32(): number {
  const value = new Uint32Array(1)
  globalThis.crypto.getRandomValues(value)
  return value[0]
}

function encodeRootName(rootName: string): Uint8Array {
  validateRootName(rootName)
  const bytes = new TextEncoder().encode(rootName)
  if (bytes.length > MAX_ROOT_NAME_BYTES) {
    throw new ProtocolError('Root name is too large for a manifest frame.', 'ROOT_NAME_TOO_LARGE')
  }
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== rootName) {
    throw new ProtocolError('Root name cannot be represented exactly as UTF-8.', 'INVALID_ROOT_NAME')
  }
  return bytes
}

function validateRootName(rootName: string): void {
  if (typeof rootName !== 'string' || rootName.length === 0) {
    throw new ProtocolError('Root name must not be empty.', 'INVALID_ROOT_NAME')
  }
  if (
    rootName === '.' ||
    rootName === '..' ||
    rootName.includes('\0') ||
    rootName.includes('/') ||
    rootName.includes('\\')
  ) {
    throw new ProtocolError('Root name is not safe.', 'INVALID_ROOT_NAME')
  }
}

function assertFrameType(type: number): asserts type is FrameType {
  if (type !== FrameType.Manifest && type !== FrameType.Data) {
    throw new ProtocolError(`Unsupported frame type ${type}.`, 'INVALID_FRAME_TYPE')
  }
}

function assertUint16(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new ProtocolError(`${field} must be an unsigned 16-bit integer.`, 'INTEGER_RANGE')
  }
}

function assertUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ProtocolError(`${field} must be an unsigned 32-bit integer.`, 'INTEGER_RANGE')
  }
}

function assertSafeUint64(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError(`${field} must be a non-negative safe integer.`, 'INTEGER_RANGE')
  }
}

function safeNumberFromUint64(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtocolError(`${field} exceeds JavaScript's safe-integer range.`, 'INTEGER_RANGE')
  }
  return Number(value)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let i = 0; i < left.length; i += 1) {
    difference |= left[i] ^ right[i]
  }
  return difference === 0
}
