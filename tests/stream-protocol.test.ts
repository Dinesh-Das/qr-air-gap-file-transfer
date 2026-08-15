import { decode as decodeBase45, encode as encodeBase45 } from '@digitalbazaar/base45'
import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'
import { MAX_BLOCK_STORE_BLOCKS } from '../src/lib/block-store'

import {
  QRF3_FRAME_HEADER_SIZE,
  Qrf3FrameType,
  Qrf3ProtocolError,
  Qrf3TransferPurpose,
  createQrf3Transfer,
  encodeQrf3DataFrame,
  encodeQrf3Manifest,
  encodeQrf3ManifestFrame,
  hashQrf3ByteSource,
  parseQrf3EncodedFrame,
  parseQrf3Manifest,
  qrf3Crc32,
  qrf3ManifestIdentity,
  qrf3Sha256,
  validateQrf3DataFrame,
  writeQrf3DataFrame,
  type Qrf3ByteSource,
  type Qrf3Manifest,
} from '../src/lib/stream-protocol'

const TRANSFER_ID = Uint8Array.from({ length: 16 }, (_, index) => index + 1)
const CONNECTION_ID = Uint8Array.from({ length: 16 }, (_, index) => 0xf0 + index)
const ARCHIVE_SHA256 = Uint8Array.from({ length: 32 }, (_, index) => index * 7)

function fixtureManifest(overrides: Partial<Qrf3Manifest> = {}): Qrf3Manifest {
  return {
    transferId: TRANSFER_ID,
    transferLength: 12_345,
    archiveSha256: ARCHIVE_SHA256,
    blockSize: 700,
    createdAtMs: 1_725_000_000_123,
    rootName: 'data folder 🚀',
    purpose: Qrf3TransferPurpose.Files,
    connectionId: CONNECTION_ID,
    ...overrides,
  }
}

class MemorySource implements Qrf3ByteSource {
  readonly reads: Array<{ offset: number; length: number }> = []

  constructor(readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.length
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.reads.push({ offset, length })
    return this.bytes.slice(offset, offset + length)
  }
}

describe('QRF3 streaming protocol', () => {
  it('round-trips a canonical manifest and binds its identity to exact bytes', async () => {
    const manifest = fixtureManifest()
    const payload = encodeQrf3Manifest(manifest)
    expect(parseQrf3Manifest(payload)).toEqual(manifest)

    const identity = await qrf3ManifestIdentity(manifest)
    expect(identity).toEqual(await qrf3Sha256(payload))

    const encoded = await encodeQrf3ManifestFrame(manifest)
    const binary = decodeBase45(encoded)
    expect(new TextDecoder().decode(binary.subarray(0, 4))).toBe('QRF3')

    const parsed = await parseQrf3EncodedFrame(encoded)
    expect(parsed.type).toBe(Qrf3FrameType.Manifest)
    expect(parsed.manifestId).toEqual(identity)
    expect(parsed.manifest).toEqual(manifest)
    expect(parsed.payload).toEqual(payload)
  })

  it('carries 16 TiB-plus lengths and offsets in little-endian u64 fields', async () => {
    const transferLength = 16 * 1024 ** 4 + 321
    const offset = transferLength - 3
    const encoded = await encodeQrf3DataFrame({
      transferId: TRANSFER_ID,
      manifestId: ARCHIVE_SHA256,
      transferLength,
      offset,
      payload: Uint8Array.of(7, 8, 9),
    })
    const binary = decodeBase45(encoded)
    const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
    expect(view.getBigUint64(56, true)).toBe(BigInt(transferLength))
    expect(view.getBigUint64(64, true)).toBe(BigInt(offset))

    const parsed = await parseQrf3EncodedFrame(encoded)
    expect(parsed.transferLength).toBe(transferLength)
    expect(parsed.offset).toBe(offset)
    expect(parsed.payload).toEqual(Uint8Array.of(7, 8, 9))
  })

  it('keeps the enforced 700-byte profile within an ECC-M QR symbol', async () => {
    const encoded = await encodeQrf3DataFrame({
      transferId: TRANSFER_ID,
      manifestId: ARCHIVE_SHA256,
      transferLength: 700,
      offset: 0,
      payload: new Uint8Array(700),
    })
    const symbol = QRCode.create(encoded, { errorCorrectionLevel: 'M' })
    expect(symbol.version).toBeGreaterThan(0)
    expect(symbol.version).toBeLessThanOrEqual(40)

    await expect(
      encodeQrf3DataFrame({
        transferId: TRANSFER_ID,
        manifestId: ARCHIVE_SHA256,
        transferLength: 701,
        offset: 0,
        payload: new Uint8Array(701),
      }),
    ).rejects.toMatchObject({ code: 'BLOCK_TOO_LARGE' })
  })

  it('rejects non-canonical text and SHA-detects mutations even with a repaired CRC', async () => {
    const encoded = await encodeQrf3DataFrame({
      transferId: TRANSFER_ID,
      manifestId: ARCHIVE_SHA256,
      transferLength: 6,
      offset: 0,
      payload: Uint8Array.of(1, 2, 3),
    })
    await expect(parseQrf3EncodedFrame(`${encoded}?`)).rejects.toMatchObject({
      code: 'INVALID_BASE45',
    })

    for (const mutateOffset of [8, QRF3_FRAME_HEADER_SIZE]) {
      const mutated = decodeBase45(encoded).slice()
      mutated[mutateOffset] ^= 0x01
      const view = new DataView(mutated.buffer)
      view.setUint32(108, 0, true)
      view.setUint32(108, qrf3Crc32(mutated), true)
      await expect(parseQrf3EncodedFrame(encodeBase45(mutated))).rejects.toMatchObject({
        code: 'BLOCK_HASH_MISMATCH',
      })
    }
  })

  it('rejects unsafe u64 values instead of rounding them', async () => {
    const encoded = await encodeQrf3DataFrame({
      transferId: TRANSFER_ID,
      manifestId: ARCHIVE_SHA256,
      transferLength: 10,
      offset: 0,
      payload: Uint8Array.of(1),
    })
    const mutated = decodeBase45(encoded).slice()
    const view = new DataView(mutated.buffer)
    view.setBigUint64(56, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true)
    view.setUint32(108, 0, true)
    view.setUint32(108, qrf3Crc32(mutated), true)
    await expect(parseQrf3EncodedFrame(encodeBase45(mutated))).rejects.toMatchObject({
      code: 'INTEGER_RANGE',
    })
  })

  it('hashes sources incrementally with a bounded read size', async () => {
    const bytes = Uint8Array.from({ length: 20_123 }, (_, index) => (index * 29) & 0xff)
    const source = new MemorySource(bytes)
    const actual = await hashQrf3ByteSource(source, 1_024)
    const expected = await qrf3Sha256(bytes)

    expect(actual).toEqual(expected)
    expect(source.reads.length).toBeGreaterThan(1)
    expect(Math.max(...source.reads.map((read) => read.length))).toBe(1_024)
    expect(source.reads.reduce((sum, read) => sum + read.length, 0)).toBe(bytes.length)
  })

  it('enforces the receiver block-store cap before hashing the source', async () => {
    const size = MAX_BLOCK_STORE_BLOCKS * 700 + 1
    const reads: Array<{ offset: number; length: number }> = []
    const source: Qrf3ByteSource = {
      size,
      async read(offset, length) {
        reads.push({ offset, length })
        return new Uint8Array(length).fill(offset & 0xff)
      },
    }
    await expect(createQrf3Transfer(source, {
      rootName: 'too-many-blocks.bin',
      blockSize: 700,
      transferId: TRANSFER_ID,
      connectionId: CONNECTION_ID,
      createdAtMs: 100,
    })).rejects.toMatchObject({ code: 'TOO_MANY_BLOCKS' })
    expect(reads).toEqual([])

    const boundary = await createQrf3Transfer(
      { ...source, size: MAX_BLOCK_STORE_BLOCKS * 700 },
      {
        rootName: 'boundary.bin',
        blockSize: 700,
        transferId: TRANSFER_ID,
        connectionId: CONNECTION_ID,
        createdAtMs: 100,
        archiveSha256: ARCHIVE_SHA256,
      },
    )
    expect(boundary.blockCount).toBe(MAX_BLOCK_STORE_BLOCKS)
    expect(reads).toEqual([])
  })

  it('generates passes lazily and rotates later passes without random disk order', async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index)
    const source = new MemorySource(bytes)
    const plan = await createQrf3Transfer(source, {
      rootName: 'pass.bin',
      blockSize: 2,
      transferId: TRANSFER_ID,
      connectionId: CONNECTION_ID,
      createdAtMs: 200,
      archiveSha256: ARCHIVE_SHA256,
    })

    const iterator = plan.passFrames({ pass: 1, manifestInterval: 2 })
    const first = await iterator.next()
    expect((await parseQrf3EncodedFrame(first.value!)).type).toBe(Qrf3FrameType.Manifest)
    expect(source.reads).toEqual([])

    const second = await iterator.next()
    const firstData = await parseQrf3EncodedFrame(second.value!)
    expect(firstData.offset % plan.blockSize).toBe(0)
    expect(source.reads).toHaveLength(1)
    await iterator.return(undefined)
  })

  it('moves periodic optical losses to different blocks on the second pass', async () => {
    const blockSize = 10
    const source = new MemorySource(new Uint8Array(blockSize * 23))
    const plan = await createQrf3Transfer(source, {
      rootName: 'losses.bin',
      blockSize,
      transferId: TRANSFER_ID,
      connectionId: CONNECTION_ID,
      createdAtMs: 250,
      archiveSha256: ARCHIVE_SHA256,
    })

    const blockOrder = async (pass: number): Promise<number[]> => {
      const order: number[] = []
      for await (const encoded of plan.passFrames({ pass, manifestInterval: 100 })) {
        const frame = await parseQrf3EncodedFrame(encoded)
        if (frame.type === Qrf3FrameType.Data) order.push(frame.offset / blockSize)
      }
      return order
    }
    const first = await blockOrder(0)
    const second = await blockOrder(1)
    const periodicallyLost = (order: number[]) =>
      new Set(order.filter((_, position) => position % 5 === 2))
    const firstLost = periodicallyLost(first)
    const secondLost = periodicallyLost(second)

    expect(new Set(first).size).toBe(plan.blockCount)
    expect(new Set(second).size).toBe(plan.blockCount)
    expect(secondLost).not.toEqual(firstLost)
    expect([...firstLost].some((block) => !secondLost.has(block))).toBe(true)
  })

  it('validates and writes one block directly to a random-access sink', async () => {
    const manifest = fixtureManifest({ transferLength: 5, blockSize: 3 })
    const manifestId = await qrf3ManifestIdentity(manifest)
    const frame = await parseQrf3EncodedFrame(
      await encodeQrf3DataFrame({
        transferId: manifest.transferId,
        manifestId,
        transferLength: 5,
        offset: 3,
        payload: Uint8Array.of(4, 5),
      }),
    )
    expect(validateQrf3DataFrame(frame, manifest, manifestId)).toBe(1)

    const writes: Array<{ offset: number; bytes: Uint8Array }> = []
    const result = await writeQrf3DataFrame(frame, manifest, manifestId, {
      async writeAt(offset, bytes) {
        writes.push({ offset, bytes: bytes.slice() })
      },
    })
    expect(result).toEqual({ blockIndex: 1, offset: 3, length: 2 })
    expect(writes).toEqual([{ offset: 3, bytes: Uint8Array.of(4, 5) }])

    expect(() => validateQrf3DataFrame(frame, manifest, new Uint8Array(32))).toThrow(
      Qrf3ProtocolError,
    )
  })

  it('requires canonical NFC names and exact source reads', async () => {
    expect(() =>
      encodeQrf3Manifest(fixtureManifest({ rootName: 'e\u0301.txt' })),
    ).toThrowError(Qrf3ProtocolError)

    const source: Qrf3ByteSource = {
      size: 5,
      async read() {
        return Uint8Array.of(1)
      },
    }
    const plan = await createQrf3Transfer(source, {
      rootName: 'short.bin',
      blockSize: 5,
      archiveSha256: ARCHIVE_SHA256,
      transferId: TRANSFER_ID,
      connectionId: CONNECTION_ID,
      createdAtMs: 300,
    })
    await expect(plan.dataFrame(0)).rejects.toMatchObject({ code: 'SHORT_SOURCE_READ' })
  })
})
