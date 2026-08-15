import { decode as decodeBase45, encode as encodeBase45 } from '@digitalbazaar/base45'
import { createOpticalPassSchedule } from './optical-schedule'

export const FRAME_HEADER_SIZE = 23
export const DEFAULT_CHUNK_SIZE = 700
export const DEFAULT_MANIFEST_INTERVAL = 10
export const MAX_TOTAL_CHUNKS = 1_000_000
export const CONNECTION_ID_SIZE = 16
// Common filesystems cap one path segment at 255 encoded bytes. Keeping the
// manifest root to the same limit also guarantees the repeated manifest fits
// comfortably in a QR code.
export const MAX_ROOT_NAME_BYTES = 255

const MAGIC = new Uint8Array([0x51, 0x52, 0x46, 0x32]) // "QRF2"
const MANIFEST_FIXED_SIZE = 69
const SHA256_SIZE = 32
const BASE45_PATTERN = /^[0-9A-Z $%*+\-./:]*$/

export enum FrameType {
  Manifest = 0x01,
  Data = 0x02,
}

export enum TransferPurpose {
  ConnectionTest = 0x01,
  Files = 0x02,
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
  purpose: TransferPurpose
  connectionId: Uint8Array
}

export interface ParsedFrame {
  type: FrameType
  transferId: number
  chunkIndex: number
  totalChunks: number
  payloadLength: number
  frameCrc32: number
  /** @deprecated QRF2 protects the complete frame, not only its payload. */
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
  purpose?: TransferPurpose
  connectionId?: Uint8Array
}

export interface PreparedTransfer {
  transferId: number
  manifest: TransferManifest
  manifestFrame: string
  dataFrames: string[]
  /** Initial sender pass. Build later passes with createTransferPassFrames. */
  loopFrames: string[]
  /** Number of data frames between repeated manifest frames. */
  manifestInterval: number
  totalChunks: number
  purpose: TransferPurpose
  connectionId: Uint8Array
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
  purpose?: TransferPurpose
  connectionId?: Uint8Array
  expectedArchiveBytes?: number
  receivedChunks: number
  totalChunks: number
  receivedBytes: number
  percent: number
  duplicate?: boolean
  conflict?: boolean
  error?: string
  /** Present only after the manifest SHA-256 gate succeeds. */
  archiveBytes?: Uint8Array
}

export interface TransferAccumulatorOptions {
  maxArchiveBytes?: number
  maxTotalChunks?: number
  expectedPurpose?: TransferPurpose
  expectedConnectionId?: Uint8Array
  expectedTransferId?: number
  expectedArchiveSha256?: Uint8Array
  /** SHA-256 of the canonical Base45 manifest frame for exact stream binding. */
  expectedManifestSha256?: Uint8Array
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
 *   u8 transfer purpose
 *   16-byte connection ID
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
  const archiveSha256 = copySha256(manifest.archiveSha256, 'archiveSha256')
  assertTransferPurpose(manifest.purpose)
  const connectionId = copyConnectionId(manifest.connectionId)

  const rootNameBytes = encodeRootName(manifest.rootName)
  const payload = new Uint8Array(MANIFEST_FIXED_SIZE + rootNameBytes.length)
  const view = new DataView(payload.buffer)
  view.setBigUint64(0, BigInt(manifest.archiveLength), true)
  payload.set(archiveSha256, 8)
  view.setUint16(40, manifest.chunkSize, true)
  view.setBigUint64(42, BigInt(manifest.createdAtMs), true)
  view.setUint8(50, manifest.purpose)
  payload.set(connectionId, 51)
  view.setUint16(67, rootNameBytes.length, true)
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
  const purpose = view.getUint8(50)
  assertTransferPurpose(purpose)
  const connectionId = payload.slice(51, 67)
  const rootNameLength = view.getUint16(67, true)
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
    purpose,
    connectionId,
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
  // The checksum field remains zero while calculating the integrity value, so
  // QRF2 binds every routing field (including type and chunk index) to the
  // payload rather than protecting the payload in isolation.
  view.setUint32(19, 0, true)
  binary.set(payload, FRAME_HEADER_SIZE)
  view.setUint32(19, crc32(binary), true)
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
      throw new ProtocolError('Frame magic does not match QRF2.', 'INVALID_MAGIC')
    }
  }

  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
  const type = view.getUint8(4)
  const transferId = view.getUint32(5, true)
  const chunkIndex = view.getUint32(9, true)
  const totalChunks = view.getUint32(13, true)
  const payloadLength = view.getUint16(17, true)
  const frameCrc32 = view.getUint32(19, true)
  if (binary.length !== FRAME_HEADER_SIZE + payloadLength) {
    throw new ProtocolError('Frame payload length does not match its header.', 'INVALID_PAYLOAD_LENGTH')
  }

  const checksumInput = binary.slice()
  new DataView(
    checksumInput.buffer,
    checksumInput.byteOffset,
    checksumInput.byteLength,
  ).setUint32(19, 0, true)
  if (crc32(checksumInput) !== frameCrc32) {
    throw new ProtocolError('QRF2 frame header/payload integrity check failed.', 'CRC_MISMATCH')
  }

  assertFrameType(type)
  if (totalChunks > MAX_TOTAL_CHUNKS) {
    throw new ProtocolError('Frame chunk count exceeds the safety limit.', 'TOO_MANY_CHUNKS')
  }
  if (type === FrameType.Manifest && chunkIndex !== 0) {
    throw new ProtocolError('Manifest chunkIndex must be zero.', 'INVALID_MANIFEST_INDEX')
  }
  if (type === FrameType.Data && (totalChunks === 0 || chunkIndex >= totalChunks)) {
    throw new ProtocolError('Data chunk index is outside the transfer.', 'INVALID_CHUNK_INDEX')
  }

  const payload = binary.slice(FRAME_HEADER_SIZE)

  const frame: ParsedFrame = {
    type,
    transferId,
    chunkIndex,
    totalChunks,
    payloadLength,
    frameCrc32,
    payloadCrc32: frameCrc32,
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
  const purpose = options.purpose ?? TransferPurpose.Files
  assertTransferPurpose(purpose)
  const connectionId =
    options.connectionId === undefined
      ? createConnectionId()
      : copyConnectionId(options.connectionId)
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
    purpose,
    connectionId: connectionId.slice(),
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

  const loopFrames = createTransferPassFrames(
    { transferId, manifestFrame, dataFrames, totalChunks, manifestInterval },
    0,
  )

  return {
    transferId,
    manifest,
    manifestFrame,
    dataFrames,
    loopFrames,
    manifestInterval,
    totalChunks,
    purpose,
    connectionId: connectionId.slice(),
  }
}

/**
 * Builds one complete, wire-compatible sender pass. Later passes permute only
 * the order of existing Data frames so periodic camera loss does not keep
 * erasing the same chunk indices.
 */
export function createTransferPassFrames(
  transfer: Pick<
    PreparedTransfer,
    'transferId' | 'manifestFrame' | 'dataFrames' | 'totalChunks' | 'manifestInterval'
  >,
  pass: number,
): string[] {
  if (!Number.isSafeInteger(pass) || pass < 0) {
    throw new ProtocolError('pass must be a non-negative safe integer.', 'INVALID_PASS')
  }
  if (transfer.totalChunks !== transfer.dataFrames.length) {
    throw new ProtocolError('Prepared transfer data-frame count is inconsistent.', 'INVALID_TRANSFER')
  }
  if (!Number.isSafeInteger(transfer.manifestInterval) || transfer.manifestInterval < 1) {
    throw new ProtocolError('manifestInterval must be a positive integer.', 'INVALID_MANIFEST_INTERVAL')
  }

  const frames = [transfer.manifestFrame]
  if (transfer.totalChunks === 0) return frames
  const schedule = createOpticalPassSchedule({
    totalChunks: transfer.totalChunks,
    pass,
    seed: transfer.transferId,
  })
  let position = 0
  for (const chunkIndex of schedule) {
    frames.push(transfer.dataFrames[chunkIndex])
    position += 1
    if (
      position % transfer.manifestInterval === 0 &&
      position < transfer.totalChunks
    ) {
      frames.push(transfer.manifestFrame)
    }
  }
  return frames
}

export class TransferAccumulator {
  private readonly maxArchiveBytes: number
  private readonly maxTotalChunks: number
  private readonly expectedPurpose?: TransferPurpose
  private readonly expectedConnectionId?: Uint8Array
  private readonly expectedTransferId?: number
  private readonly expectedArchiveSha256?: Uint8Array
  private readonly expectedManifestSha256?: Uint8Array
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
    this.expectedPurpose = options.expectedPurpose
    this.expectedConnectionId =
      options.expectedConnectionId === undefined
        ? undefined
        : copyConnectionId(options.expectedConnectionId)
    this.expectedTransferId = options.expectedTransferId
    this.expectedArchiveSha256 =
      options.expectedArchiveSha256 === undefined
        ? undefined
        : copySha256(options.expectedArchiveSha256, 'expectedArchiveSha256')
    this.expectedManifestSha256 =
      options.expectedManifestSha256 === undefined
        ? undefined
        : copySha256(options.expectedManifestSha256, 'expectedManifestSha256')
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
    if (this.expectedPurpose !== undefined) {
      assertTransferPurpose(this.expectedPurpose)
    }
    if (this.expectedTransferId !== undefined) {
      assertUint32(this.expectedTransferId, 'expectedTransferId')
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
    const ingestGeneration = this.generation
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
      if (
        this.expectedPurpose !== undefined &&
        manifest.purpose !== this.expectedPurpose
      ) {
        return this.result('ignored', false, 'Manifest purpose does not match this receiver.')
      }
      if (
        this.expectedConnectionId &&
        !bytesEqual(manifest.connectionId, this.expectedConnectionId)
      ) {
        return this.result('ignored', false, 'Manifest connection ID does not match this receiver.')
      }
      if (
        this.expectedTransferId !== undefined &&
        frame.transferId !== this.expectedTransferId
      ) {
        return this.result('ignored', false, 'Manifest transfer ID does not match this receiver.')
      }
      if (
        this.expectedArchiveSha256 &&
        !bytesEqual(manifest.archiveSha256, this.expectedArchiveSha256)
      ) {
        return this.result('ignored', false, 'Manifest archive hash does not match this receiver.')
      }
      if (
        this.expectedManifestSha256
      ) {
        const manifestSha256 = await sha256(new TextEncoder().encode(encoded))
        if (ingestGeneration !== this.generation) {
          return this.result('ignored', false, 'Transfer was reset during manifest verification.')
        }
        if (!bytesEqual(manifestSha256, this.expectedManifestSha256)) {
          return this.result('ignored', false, 'Manifest frame does not match the prepared transfer.')
        }
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
      return this.result('ignored', false, 'Frame belongs to a different transfer.')
    } else if (frame.totalChunks !== this.totalChunks) {
      return this.result('ignored', false, 'Frame conflicts with the transfer chunk count.')
    }

    if (this.completedArchive) {
      // Completion bytes are deliberately delivered once. Camera queues can
      // contain several frames by the time scanning is paused; cloning the
      // entire archive for every trailing frame creates avoidable memory spikes.
      return this.result('complete', true, undefined, true)
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
        if (bytesEqual(existing, frame.payload)) {
          duplicate = true
        } else {
          // Both payloads have a valid QRF2 checksum, so neither candidate is
          // privileged. Remove the ambiguous slot and wait for a later repeat.
          this.chunks.delete(frame.chunkIndex)
          this.receivedBytes -= existing.length
          return this.result(
            'receiving',
            true,
            'Conflicting payloads were received for one chunk; that slot will be reacquired.',
            false,
            undefined,
            true,
          )
        }
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
      if (this.completedArchive) {
        return this.result('complete', true, undefined, true)
      }
      this.completedArchive = verifiedArchive
      this.verificationPromise = undefined
      return this.result('complete', true, undefined, duplicate, verifiedArchive)
    }
    if (verification !== this.verificationPromise) {
      return this.result('receiving', true, undefined, duplicate)
    }
    this.verificationPromise = undefined

    // The QRF2 checksum rejects accidental frame corruption. A deliberately
    // forged but internally consistent payload can still fail the archive hash,
    // so retain the full SHA-256 gate as the final authority.
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
    conflict?: boolean,
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
      purpose: this.manifest?.purpose,
      connectionId: this.manifest?.connectionId.slice(),
      expectedArchiveBytes: this.manifest?.archiveLength,
      receivedChunks: this.chunks.size,
      totalChunks: this.totalChunks,
      receivedBytes: this.receivedBytes,
      percent,
      duplicate,
      conflict,
      error,
      archiveBytes: archiveBytes?.slice(),
    }
  }
}

export function createConnectionId(): Uint8Array {
  const connectionId = new Uint8Array(CONNECTION_ID_SIZE)
  globalThis.crypto.getRandomValues(connectionId)
  return connectionId
}

function randomUint32(): number {
  const value = new Uint32Array(1)
  globalThis.crypto.getRandomValues(value)
  return value[0]
}

function copyConnectionId(connectionId: Uint8Array): Uint8Array {
  if (
    !(connectionId instanceof Uint8Array) ||
    connectionId.length !== CONNECTION_ID_SIZE
  ) {
    throw new ProtocolError(
      `connectionId must contain exactly ${CONNECTION_ID_SIZE} bytes.`,
      'INVALID_CONNECTION_ID',
    )
  }
  return connectionId.slice()
}

function copySha256(value: Uint8Array, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== SHA256_SIZE) {
    throw new ProtocolError(`${field} must contain exactly ${SHA256_SIZE} bytes.`, 'INVALID_SHA256')
  }
  return value.slice()
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

function assertTransferPurpose(purpose: number): asserts purpose is TransferPurpose {
  if (
    purpose !== TransferPurpose.ConnectionTest &&
    purpose !== TransferPurpose.Files
  ) {
    throw new ProtocolError(`Unsupported transfer purpose ${purpose}.`, 'INVALID_PURPOSE')
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
