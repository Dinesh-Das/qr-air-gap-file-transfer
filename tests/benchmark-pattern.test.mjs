import { describe, expect, it } from "vitest";
import { createBenchmarkPatternReader } from "../scripts/benchmark-pattern.mjs";

describe("bounded benchmark pattern", () => {
  it.each([0, 7, 99_999, 0xffffffff])("preserves the independent byte formula and alignment for file %i", (index) => {
    const read = createBenchmarkPatternReader(index);
    for (const offset of [0, 1, 255, 256, 2 ** 31 - 17, 2 ** 31 + 13, 2 ** 32 + 27, 5 * 1024 ** 3 - 5]) {
      for (const length of [0, 1, 13, 255, 257, 1000]) {
        const expected = Uint8Array.from({ length }, (_, n) =>
          (index >>> (((offset + n) % 4) * 8)) ^ ((offset + n) * 31));
        expect(read(offset, length)).toEqual(expected);
      }
    }
  });
  it("supports the largest source slice without aliasing subsequent reads", () => {
    const read = createBenchmarkPatternReader(77);
    const bytes = read(2 ** 32 + 9, 4 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index++) {
      const position = 2 ** 32 + 9 + index;
      if (bytes[index] !== (((77 >>> ((position % 4) * 8)) ^ (position * 31)) & 255)) throw new Error(`Wrong byte at ${index}`);
    }
    bytes.fill(0);
    expect(read(1, 1)[0]).toBe(31);
  });
  it("rejects invalid indices, oversized allocations and unsafe offsets", () => {
    for (const index of [-1, NaN, 0.1, 2 ** 32]) expect(() => createBenchmarkPatternReader(index)).toThrow();
    const read = createBenchmarkPatternReader(0);
    for (const [offset, length] of [[-1, 1], [1.5, 1], [0, -1], [0, NaN], [0, 4 * 1024 * 1024 + 1], [Number.MAX_SAFE_INTEGER, 1]]) {
      expect(() => read(offset, length)).toThrow();
    }
  });
});
