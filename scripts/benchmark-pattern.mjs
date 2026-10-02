// Bounded synthetic fixture generation, independent of the transfer protocol.
// The original index/offset byte formula repeats every 256 bytes. Doubling an
// initialized prefix avoids a per-byte multiplication loop at multi-GB offsets.
export function createBenchmarkPatternReader(fileIndex) {
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex > 0xffffffff) throw new Error("Invalid fixture file index.");
  const pattern = Uint8Array.from({ length: 256 }, (_, position) =>
    (fileIndex >>> ((position % 4) * 8)) ^ (position * 31));
  return (start, length) => {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0 ||
        length > 4 * 1024 * 1024 || !Number.isSafeInteger(start + length)) throw new Error("Invalid fixture slice.");
    const data = new Uint8Array(length);
    let filled = Math.min(256, length);
    const offset = start % 256;
    const first = Math.min(filled, 256 - offset);
    data.set(pattern.subarray(offset, offset + first));
    data.set(pattern.subarray(0, filled - first), first);
    while (filled < length) {
      const take = Math.min(filled, length - filled);
      data.set(data.subarray(0, take), filled);
      filled += take;
    }
    return data;
  };
}
