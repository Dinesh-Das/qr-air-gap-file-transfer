import { describe, expect, it } from 'vitest'

import {
  MAX_OPTICAL_CHUNKS,
  OpticalPassSchedule,
  createOpticalPassSchedule,
} from '../src/lib/optical-schedule'

function gcd(left: number, right: number): number {
  let a = left
  let b = right
  while (b !== 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

describe('optical pass scheduling', () => {
  it('is deterministic and supports restartable iteration', () => {
    const options = { totalChunks: 31, pass: 7, seed: 0x1234_5678 }
    const first = createOpticalPassSchedule(options)
    const second = createOpticalPassSchedule(options)

    expect([...first]).toEqual([...second])
    expect([...first]).toEqual([...first])
    expect([...first.indices(13)]).toEqual([...first].slice(13))
    expect([...first.indices(first.totalChunks)]).toEqual([])
  })

  it('emits every index exactly once for varied non-power-of-two sizes', () => {
    const sizes = [1, 2, 3, 5, 6, 7, 10, 31, 64, 97, 255, 256, 999, 4_093]
    for (const totalChunks of sizes) {
      for (let pass = 0; pass < 12; pass += 1) {
        const schedule = new OpticalPassSchedule({
          totalChunks,
          pass,
          seed: 0xdec0_de01,
        })
        const indices = [...schedule]

        expect(indices, `${totalChunks} chunks, pass ${pass}`).toHaveLength(totalChunks)
        expect(new Set(indices).size, `${totalChunks} chunks, pass ${pass}`).toBe(
          totalChunks,
        )
        expect(Math.min(...indices)).toBe(0)
        expect(Math.max(...indices)).toBe(totalChunks - 1)
        expect(gcd(schedule.stride, totalChunks)).toBe(1)
        indices.forEach((chunkIndex, position) => {
          expect(schedule.indexAt(position)).toBe(chunkIndex)
        })
      }
    }
  })

  it('holds the permutation property across deterministic randomized cases', () => {
    let state = 0x6d2b_79f5
    const randomUint32 = () => {
      state = Math.imul(state ^ (state >>> 15), 1 | state)
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state)
      return (state ^ (state >>> 14)) >>> 0
    }

    for (let example = 0; example < 160; example += 1) {
      const totalChunks = 1 + (randomUint32() % 20_000)
      const pass = randomUint32() * 0x20_000 + (randomUint32() % 0x20_000)
      const schedule = createOpticalPassSchedule({
        totalChunks,
        pass,
        seed: randomUint32(),
      })
      const seen = new Uint8Array(totalChunks)
      let emitted = 0

      for (const chunkIndex of schedule) {
        if (chunkIndex < 0 || chunkIndex >= totalChunks) {
          throw new Error(`Out-of-range index ${chunkIndex} for ${totalChunks} chunks.`)
        }
        if (seen[chunkIndex] !== 0) {
          throw new Error(`Duplicate index ${chunkIndex} for ${totalChunks} chunks.`)
        }
        seen[chunkIndex] = 1
        emitted += 1
      }
      expect(emitted).toBe(totalChunks)
    }
  })

  it('changes the phase on every consecutive pass', () => {
    for (const totalChunks of [2, 3, 10, 257, 65_537]) {
      let previous = createOpticalPassSchedule({
        totalChunks,
        pass: 0,
        seed: 42,
      })
      for (let pass = 1; pass < 100; pass += 1) {
        const current = createOpticalPassSchedule({ totalChunks, pass, seed: 42 })
        expect(current.phase).not.toBe(previous.phase)
        expect(current.indexAt(0)).not.toBe(previous.indexAt(0))
        previous = current
      }
    }
  })

  it('constructs and samples huge schedules without materializing them', () => {
    for (const totalChunks of [
      10_000_019,
      100_000_007,
      0x1_0000_0000 + 15,
      12_000_000_000_019,
      MAX_OPTICAL_CHUNKS,
    ]) {
      const schedule = createOpticalPassSchedule({
        totalChunks,
        pass: Number.MAX_SAFE_INTEGER,
        seed: 0xffff_ffff,
      })
      const positions = [0, 1, 2, Math.floor(totalChunks / 2), totalChunks - 2, totalChunks - 1]
      const values = positions.map((position) => schedule.indexAt(position))

      expect(values.every((value) => value >= 0 && value < totalChunks)).toBe(true)
      expect(new Set(values).size).toBe(values.length)
      expect([...schedule.indices(totalChunks - 3)]).toHaveLength(3)
    }
  })

  it('uses exact modular arithmetic when products exceed the safe integer range', () => {
    const totalChunks = 12_000_000_000_019
    const schedule = createOpticalPassSchedule({
      totalChunks,
      pass: 987_654_321,
      seed: 0xfeed_beef,
    })
    const position = totalChunks - 2
    const expected = Number(
      (BigInt(schedule.phase) +
        BigInt(schedule.stride) * BigInt(position)) %
        BigInt(schedule.totalChunks),
    )
    expect(schedule.indexAt(position)).toBe(expected)
  })

  it('rejects invalid options and positions', () => {
    const valid = { totalChunks: 10, pass: 0, seed: 0 }
    for (const totalChunks of [0, -1, 1.5, Number.NaN, MAX_OPTICAL_CHUNKS + 1]) {
      expect(() => createOpticalPassSchedule({ ...valid, totalChunks })).toThrow(RangeError)
    }
    for (const pass of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createOpticalPassSchedule({ ...valid, pass })).toThrow(RangeError)
    }
    for (const seed of [-1, 1.5, Number.NaN, 0x1_0000_0000]) {
      expect(() => createOpticalPassSchedule({ ...valid, seed })).toThrow(RangeError)
    }

    const schedule = createOpticalPassSchedule(valid)
    for (const position of [-1, 10, 1.5, Number.NaN]) {
      expect(() => schedule.indexAt(position)).toThrow(RangeError)
    }
    for (const startPosition of [-1, 11, 1.5, Number.NaN]) {
      expect(() => [...schedule.indices(startPosition)]).toThrow(RangeError)
    }
  })
})
