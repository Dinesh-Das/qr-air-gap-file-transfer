import { describe, expect, it } from 'vitest'

import {
  FrameType,
  TransferAccumulator,
  crc32,
  encodeFrame,
  encodeManifest,
  parseEncodedFrame,
  parseManifest,
  prepareTransfer,
  sha256,
} from '../src/lib/protocol'

describe('QRFT protocol', () => {
  it('uses the standard CRC-32 vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('round-trips the little-endian manifest schema including Unicode', async () => {
    const manifest = {
      archiveLength: 123_456,
      archiveSha256: await sha256(new Uint8Array([1, 2, 3])),
      chunkSize: 700,
      createdAtMs: 1_725_000_000_123,
      rootName: '資料 folder 🚀',
    }
    const decoded = parseManifest(encodeManifest(manifest))
    expect(decoded).toEqual(manifest)
  })

  it('encodes and strictly validates a data frame', () => {
    const payload = new Uint8Array([0, 1, 2, 254, 255])
    const encoded = encodeFrame(FrameType.Data, 0x78563412, 2, 5, payload)
    const decoded = parseEncodedFrame(encoded)
    expect(decoded.transferId).toBe(0x78563412)
    expect(decoded.chunkIndex).toBe(2)
    expect(decoded.totalChunks).toBe(5)
    expect(decoded.payload).toEqual(payload)
    expect(() => parseEncodedFrame(`${encoded.slice(0, -1)}?`)).toThrow()
  })

  it('prepares frames with a manifest at the start and every ten data frames', async () => {
    const prepared = await prepareTransfer(new Uint8Array(25).map((_, index) => index), {
      rootName: 'fixture',
      chunkSize: 2,
      transferId: 7,
      createdAtMs: 10,
    })
    expect(prepared.totalChunks).toBe(13)
    expect(prepared.dataFrames).toHaveLength(13)
    expect(prepared.loopFrames).toHaveLength(15)
    expect(parseEncodedFrame(prepared.loopFrames[0]).type).toBe(FrameType.Manifest)
    expect(parseEncodedFrame(prepared.loopFrames[11]).type).toBe(FrameType.Manifest)
  })

  it('deduplicates and reconstructs byte-exact data received out of order', async () => {
    const source = new Uint8Array(4_097).map((_, index) => (index * 31) & 0xff)
    const prepared = await prepareTransfer(source, {
      rootName: 'exact',
      chunkSize: 257,
      transferId: 99,
      createdAtMs: 20,
    })
    const accumulator = new TransferAccumulator()
    // A pre-manifest data QR is intentionally ignored so unbounded or stale
    // frames cannot pin a receiver session.
    expect((await accumulator.ingest(prepared.dataFrames[3])).status).toBe('ignored')
    const shuffled = [
      prepared.manifestFrame,
      ...prepared.dataFrames.slice().reverse(),
      prepared.dataFrames[3],
    ]
    let result
    for (const frame of shuffled) result = await accumulator.ingest(frame)
    expect(result?.status).toBe('complete')
    expect(result?.archiveBytes).toEqual(source)
    expect(result?.receivedChunks).toBe(prepared.totalChunks)
  })

  it('never releases bytes when the final SHA-256 differs', async () => {
    const source = new Uint8Array([1, 2, 3, 4])
    const prepared = await prepareTransfer(source, {
      rootName: 'exact',
      chunkSize: 4,
      transferId: 100,
      createdAtMs: 30,
    })
    const wrongButCrcValid = encodeFrame(
      FrameType.Data,
      prepared.transferId,
      0,
      1,
      new Uint8Array([1, 2, 3, 5]),
    )
    const accumulator = new TransferAccumulator()
    await accumulator.ingest(prepared.manifestFrame)
    const rejected = await accumulator.ingest(wrongButCrcValid)
    expect(rejected.status).toBe('verification-failed')
    expect(rejected.archiveBytes).toBeUndefined()

    const recovered = await accumulator.ingest(prepared.dataFrames[0])
    expect(recovered.status).toBe('complete')
    expect(recovered.archiveBytes).toEqual(source)
  })

  it('does not let a rejected manifest pin the next valid transfer', async () => {
    const oversized = await prepareTransfer(new Uint8Array([1, 2]), {
      rootName: 'oversized',
      chunkSize: 2,
      transferId: 201,
      createdAtMs: 40,
    })
    const valid = await prepareTransfer(new Uint8Array([9]), {
      rootName: 'valid',
      chunkSize: 1,
      transferId: 202,
      createdAtMs: 41,
    })
    const accumulator = new TransferAccumulator({ maxArchiveBytes: 1 })

    const rejected = await accumulator.ingest(oversized.manifestFrame)
    expect(rejected.status).toBe('ignored')
    expect(rejected.transferId).toBeUndefined()

    await accumulator.ingest(valid.manifestFrame)
    const completed = await accumulator.ingest(valid.dataFrames[0])
    expect(completed.status).toBe('complete')
    expect(completed.transferId).toBe(valid.transferId)
    expect(completed.archiveBytes).toEqual(new Uint8Array([9]))
  })

  it('cannot commit a stale SHA result after reset', async () => {
    const first = await prepareTransfer(new Uint8Array([1, 2, 3]), {
      rootName: 'first',
      chunkSize: 3,
      transferId: 301,
      createdAtMs: 50,
    })
    const second = await prepareTransfer(new Uint8Array([7, 8]), {
      rootName: 'second',
      chunkSize: 2,
      transferId: 302,
      createdAtMs: 51,
    })
    const accumulator = new TransferAccumulator()
    await accumulator.ingest(first.manifestFrame)
    const staleVerification = accumulator.ingest(first.dataFrames[0])
    accumulator.reset()

    const staleResult = await staleVerification
    expect(staleResult.status).toBe('ignored')
    expect(staleResult.archiveBytes).toBeUndefined()

    await accumulator.ingest(second.manifestFrame)
    const completed = await accumulator.ingest(second.dataFrames[0])
    expect(completed.status).toBe('complete')
    expect(completed.transferId).toBe(second.transferId)
    expect(completed.rootName).toBe('second')
    expect(completed.archiveBytes).toEqual(new Uint8Array([7, 8]))
  })
})
