// Storage probes deliberately do not hash data; distinguish completed writes
// from a verified receive rather than treating verified:false as universal failure.
export function benchmarkResultPassed(result) {
  if (result.error || result.cleanupError) return false;
  if (result.mode === "OPFS-only quota probe") {
    return Number.isSafeInteger(result.mib) && result.mib > 0 &&
      result.writtenBytes === result.mib * 1024 * 1024;
  }
  return result.verified === true &&
    (result.destination === undefined || result.destination.verified === true);
}
