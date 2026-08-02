import {
  createArchive,
  extractArchive,
  type SelectedEntry,
} from './archive'
import {
  CONNECTION_ID_SIZE,
  TransferPurpose,
  createConnectionId,
  prepareTransfer,
  sha256,
  type PreparedTransfer as ProtocolPreparedTransfer,
} from './protocol'

export const CONNECTION_TEST_ROOT_NAME = 'QRFT Connection Test'
export const CONNECTION_TEST_FILE_NAME = 'qrft-connection-test.bin'
export const DEFAULT_CONNECTION_TEST_BYTES = 4_096

const MIN_CONNECTION_TEST_BYTES = 128
const MAX_CONNECTION_TEST_BYTES = 16 * 1024
const SHA256_SIZE = 32
const PROBE_MAGIC = new TextEncoder().encode('QRF2PRB1')
const PROBE_FIXED_PREFIX_SIZE = 96
const RECEIPT_DOMAIN = new TextEncoder().encode('QRF2-CONNECTION-RECEIPT\0')
const RECEIPT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECEIPT_RAW_LENGTH = 10

export class ConnectionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'ConnectionError'
  }
}

export interface FilesTransferBinding {
  transferId: number
  archiveSha256: Uint8Array
  manifestSha256: Uint8Array
  connectionId: Uint8Array
}

export interface PrepareConnectionTestOptions {
  dummySize?: number
  chunkSize?: number
  /** Transfer ID for the probe itself, not the bound files transfer. */
  transferId?: number
  createdAtMs?: number
}

export interface PreparedConnectionTest {
  connectionId: Uint8Array
  dummyBytes: Uint8Array
  archiveBytes: Uint8Array
  transfer: ProtocolPreparedTransfer
  filesBinding: FilesTransferBinding
  receiptCode: string
}

export interface VerifiedConnectionTest {
  connectionId: Uint8Array
  dummyBytes: Uint8Array
  archiveBytes: Uint8Array
  probeTransferId: number
  filesBinding: FilesTransferBinding
  receiptCode: string
}

interface ParsedDummy {
  bytes: Uint8Array
  connectionId: Uint8Array
  probeTransferId: number
  filesBinding: FilesTransferBinding
}

/**
 * Captures the immutable identity that the connection probe commits to. The
 * sender must unlock this same prepared Files transfer after receipt validation;
 * rebuilding a new transfer would invalidate the receiver's binding.
 */
export async function createFilesTransferBinding(
  transfer: Pick<
    ProtocolPreparedTransfer,
    'transferId' | 'manifest' | 'manifestFrame'
  >,
): Promise<FilesTransferBinding> {
  if (transfer.manifest.purpose !== TransferPurpose.Files) {
    throw new ConnectionError(
      'A connection test can only bind a Files transfer.',
      'INVALID_FILES_BINDING',
    )
  }
  return copyFilesBinding({
    transferId: transfer.transferId,
    archiveSha256: transfer.manifest.archiveSha256,
    manifestSha256: await sha256(
      new TextEncoder().encode(transfer.manifestFrame),
    ),
    connectionId: transfer.manifest.connectionId,
  })
}

/**
 * Builds a randomized dummy ZIP and sends it through the exact same
 * manifest/data/final-SHA pipeline as a file transfer. The dummy commits to the
 * already-prepared main transfer ID and archive hash.
 */
export async function prepareConnectionTest(
  filesBinding: FilesTransferBinding,
  options: PrepareConnectionTestOptions = {},
): Promise<PreparedConnectionTest> {
  const binding = copyFilesBinding(filesBinding)
  const dummySize = options.dummySize ?? DEFAULT_CONNECTION_TEST_BYTES
  assertDummySize(dummySize)

  const probeTransferId =
    options.transferId === undefined
      ? randomUint32Excluding(binding.transferId)
      : assertDistinctProbeTransferId(options.transferId, binding.transferId)
  const dummyBytes = await createDummyBytes(binding, probeTransferId, dummySize)
  const archiveBytes = createArchive([
    { path: CONNECTION_TEST_FILE_NAME, bytes: dummyBytes },
  ])

  const transfer = await prepareTransfer(archiveBytes, {
    rootName: CONNECTION_TEST_ROOT_NAME,
    purpose: TransferPurpose.ConnectionTest,
    connectionId: binding.connectionId,
    transferId: probeTransferId,
    ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
    ...(options.createdAtMs === undefined ? {} : { createdAtMs: options.createdAtMs }),
  })
  const receiptCode = await deriveReceiptFromDummy(
    binding.connectionId,
    archiveBytes,
    await parseDummyArchive(archiveBytes),
  )

  return {
    connectionId: binding.connectionId.slice(),
    dummyBytes: dummyBytes.slice(),
    archiveBytes: archiveBytes.slice(),
    transfer,
    filesBinding: copyFilesBinding(binding),
    receiptCode,
  }
}

/**
 * Verifies the complete dummy ZIP, embedded session, observed probe transfer ID,
 * bound files transfer, and self-checking randomized payload.
 */
export async function verifyConnectionTest(
  archiveBytes: Uint8Array,
  connectionId: Uint8Array,
  probeTransferId: number,
): Promise<VerifiedConnectionTest> {
  const stableArchive = copyBytes(archiveBytes, 'archiveBytes')
  const expectedConnectionId = copyConnectionId(connectionId)
  assertUint32(probeTransferId, 'probeTransferId')
  const parsed = await parseDummyArchive(stableArchive)

  if (!bytesEqual(parsed.connectionId, expectedConnectionId)) {
    throw new ConnectionError(
      'Connection-test content belongs to a different connection.',
      'CONNECTION_ID_MISMATCH',
    )
  }
  if (parsed.probeTransferId !== probeTransferId) {
    throw new ConnectionError(
      'Connection-test content does not match the observed probe transfer ID.',
      'PROBE_TRANSFER_ID_MISMATCH',
    )
  }

  const receiptCode = await deriveReceiptFromDummy(
    expectedConnectionId,
    stableArchive,
    parsed,
  )
  return {
    connectionId: expectedConnectionId.slice(),
    dummyBytes: parsed.bytes.slice(),
    archiveBytes: stableArchive,
    probeTransferId,
    filesBinding: copyFilesBinding(parsed.filesBinding),
    receiptCode,
  }
}

/** Derives the manual receipt only after the entire dummy file can be extracted. */
export async function deriveConnectionReceiptCode(
  connectionId: Uint8Array,
  archiveBytes: Uint8Array,
): Promise<string> {
  const stableArchive = copyBytes(archiveBytes, 'archiveBytes')
  const expectedConnectionId = copyConnectionId(connectionId)
  const parsed = await parseDummyArchive(stableArchive)
  if (!bytesEqual(parsed.connectionId, expectedConnectionId)) {
    throw new ConnectionError(
      'Connection-test content belongs to a different connection.',
      'CONNECTION_ID_MISMATCH',
    )
  }
  return deriveReceiptFromDummy(expectedConnectionId, stableArchive, parsed)
}

/** Normalizes and groups a complete receipt as `XXXXX-XXXXX`. */
export function formatConnectionReceiptCode(value: string): string {
  if (typeof value !== 'string') {
    throw new ConnectionError('Receipt code must be text.', 'INVALID_RECEIPT_FORMAT')
  }
  const compact = value.toUpperCase().replace(/[ \t\r\n-]/g, '')
  if (
    compact.length !== RECEIPT_RAW_LENGTH ||
    Array.from(compact).some((character) => !RECEIPT_ALPHABET.includes(character))
  ) {
    throw new ConnectionError(
      'Receipt code must contain ten unambiguous letters or digits.',
      'INVALID_RECEIPT_FORMAT',
    )
  }
  return `${compact.slice(0, 5)}-${compact.slice(5)}`
}

/** Validates syntax and compares a typed receipt without early-exit matching. */
export async function validateConnectionReceiptCode(
  value: string,
  connectionId: Uint8Array,
  archiveBytes: Uint8Array,
): Promise<boolean> {
  let formatted: string
  try {
    formatted = formatConnectionReceiptCode(value)
  } catch {
    return false
  }
  const expected = await deriveConnectionReceiptCode(connectionId, archiveBytes)
  return constantTimeTextEqual(formatted, expected)
}

/** Convenience for callers that need a fresh session before preparing Files. */
export function createConnectionSessionId(): Uint8Array {
  return createConnectionId()
}

async function createDummyBytes(
  binding: FilesTransferBinding,
  probeTransferId: number,
  dummySize: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(dummySize)
  const view = new DataView(bytes.buffer)
  bytes.set(PROBE_MAGIC, 0)
  bytes.set(binding.connectionId, 8)
  view.setUint32(24, probeTransferId, true)
  view.setUint32(28, binding.transferId, true)
  bytes.set(binding.archiveSha256, 32)
  bytes.set(binding.manifestSha256, 64)
  globalThis.crypto.getRandomValues(
    bytes.subarray(PROBE_FIXED_PREFIX_SIZE, bytes.length - SHA256_SIZE),
  )
  bytes.set(await sha256(bytes.subarray(0, bytes.length - SHA256_SIZE)), bytes.length - SHA256_SIZE)
  return bytes
}

async function parseDummyArchive(archiveBytes: Uint8Array): Promise<ParsedDummy> {
  let entries: SelectedEntry[]
  try {
    entries = extractArchive(archiveBytes)
  } catch (error) {
    throw new ConnectionError(
      error instanceof Error
        ? `Connection-test ZIP is invalid: ${error.message}`
        : 'Connection-test ZIP is invalid.',
      'INVALID_CONNECTION_ARCHIVE',
    )
  }
  if (
    entries.length !== 1 ||
    entries[0].directory === true ||
    entries[0].path !== CONNECTION_TEST_FILE_NAME
  ) {
    throw new ConnectionError(
      `Connection-test ZIP must contain exactly ${CONNECTION_TEST_FILE_NAME}.`,
      'INVALID_CONNECTION_ARCHIVE',
    )
  }

  const bytes = entries[0].bytes.slice()
  assertDummySize(bytes.length)
  if (!bytesEqual(bytes.subarray(0, PROBE_MAGIC.length), PROBE_MAGIC)) {
    throw new ConnectionError('Connection-test file magic is invalid.', 'INVALID_DUMMY_CONTENT')
  }
  const expectedSelfHash = bytes.subarray(bytes.length - SHA256_SIZE)
  const actualSelfHash = await sha256(bytes.subarray(0, bytes.length - SHA256_SIZE))
  if (!bytesEqual(expectedSelfHash, actualSelfHash)) {
    throw new ConnectionError(
      'Connection-test file content hash does not match.',
      'INVALID_DUMMY_CONTENT',
    )
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const connectionId = bytes.slice(8, 8 + CONNECTION_ID_SIZE)
  const probeTransferId = view.getUint32(24, true)
  const filesTransferId = view.getUint32(28, true)
  if (probeTransferId === filesTransferId) {
    throw new ConnectionError(
      'Probe and files transfer IDs must be different.',
      'INVALID_DUMMY_CONTENT',
    )
  }
  return {
    bytes,
    connectionId,
    probeTransferId,
    filesBinding: {
      transferId: filesTransferId,
      archiveSha256: bytes.slice(32, 32 + SHA256_SIZE),
      manifestSha256: bytes.slice(64, 64 + SHA256_SIZE),
      connectionId: connectionId.slice(),
    },
  }
}

async function deriveReceiptFromDummy(
  connectionId: Uint8Array,
  archiveBytes: Uint8Array,
  parsed: ParsedDummy,
): Promise<string> {
  const receiptKey = await sha256(parsed.bytes)
  const archiveSha256 = await sha256(archiveBytes)
  const message = concatenateBytes([
    RECEIPT_DOMAIN,
    connectionId,
    uint32Bytes(parsed.probeTransferId),
    uint32Bytes(parsed.filesBinding.transferId),
    archiveSha256,
    parsed.filesBinding.archiveSha256,
    parsed.filesBinding.manifestSha256,
  ])
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new Uint8Array(receiptKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', key, new Uint8Array(message)),
  )
  return formatConnectionReceiptCode(encodeReceiptBits(mac))
}

function encodeReceiptBits(bytes: Uint8Array): string {
  let buffer = 0
  let bufferedBits = 0
  let output = ''
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bufferedBits += 8
    while (bufferedBits >= 5 && output.length < RECEIPT_RAW_LENGTH) {
      bufferedBits -= 5
      output += RECEIPT_ALPHABET[(buffer >>> bufferedBits) & 0x1f]
      buffer &= bufferedBits === 0 ? 0 : (1 << bufferedBits) - 1
    }
    if (output.length === RECEIPT_RAW_LENGTH) return output
  }
  throw new ConnectionError('Receipt digest is unexpectedly short.', 'RECEIPT_DERIVATION_FAILED')
}

function copyFilesBinding(binding: FilesTransferBinding): FilesTransferBinding {
  assertUint32(binding.transferId, 'files transferId')
  return {
    transferId: binding.transferId,
    archiveSha256: copySha256(binding.archiveSha256, 'files archiveSha256'),
    manifestSha256: copySha256(binding.manifestSha256, 'files manifestSha256'),
    connectionId: copyConnectionId(binding.connectionId),
  }
}

function copyConnectionId(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== CONNECTION_ID_SIZE) {
    throw new ConnectionError(
      `connectionId must contain exactly ${CONNECTION_ID_SIZE} bytes.`,
      'INVALID_CONNECTION_ID',
    )
  }
  return value.slice()
}

function copySha256(value: Uint8Array, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== SHA256_SIZE) {
    throw new ConnectionError(
      `${field} must contain exactly ${SHA256_SIZE} bytes.`,
      'INVALID_SHA256',
    )
  }
  return value.slice()
}

function copyBytes(value: Uint8Array, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new ConnectionError(`${field} must be a Uint8Array.`, 'INVALID_BYTES')
  }
  return value.slice()
}

function assertDummySize(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_CONNECTION_TEST_BYTES ||
    value > MAX_CONNECTION_TEST_BYTES
  ) {
    throw new ConnectionError(
      `dummySize must be between ${MIN_CONNECTION_TEST_BYTES} and ${MAX_CONNECTION_TEST_BYTES} bytes.`,
      'INVALID_DUMMY_SIZE',
    )
  }
}

function assertDistinctProbeTransferId(value: number, filesTransferId: number): number {
  assertUint32(value, 'probe transferId')
  if (value === filesTransferId) {
    throw new ConnectionError(
      'Probe and files transfer IDs must be different.',
      'TRANSFER_ID_COLLISION',
    )
  }
  return value
}

function assertUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ConnectionError(`${field} must be an unsigned 32-bit integer.`, 'INTEGER_RANGE')
  }
}

function randomUint32Excluding(excluded: number): number {
  const value = new Uint32Array(1)
  do {
    globalThis.crypto.getRandomValues(value)
  } while (value[0] === excluded)
  return value[0]
}

function uint32Bytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}
