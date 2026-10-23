import { createCipheriv, createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

// Public deterministic test material, never user data or a secret key.
const KEY = "d6da9307f7c940f1050fa30864245233700cd997e14c5a12aca2b69a9e0c70be";
const IV = "51524654354769420000000000000000";
export function nativeUiPlan(value = "5120") {
  if (value !== "16" && value !== "5120") throw new Error("Native UI size must be 16 or 5120 MiB.");
  const mib = Number(value), fileBytes = mib * 1024 ** 2;
  return Object.freeze({ mib, fileBytes, reserveBytes: 2 * 1024 ** 3, marginBytes: 400 * 1024 ** 2,
    requiredFreeBytes: 3 * fileBytes + 2 * 1024 ** 3 + 400 * 1024 ** 2,
    smokeOnly: mib === 16, deadlineMs: mib === 16 ? 600_000 : 1_800_000,
    expectedSha256: mib === 16 ? "c5c5b38b9be32a4002c3e438b2c345623c56d2219b450d36e4c8df793ecbc006"
      : "059c8416a6df00a6b4bc391b82a8f2962888e083fb4ab4fec261a96954a06b90" });
}
export function nativeSampleComplete(row) {
  const n = row?.native;
  if (!Array.isArray(row?.before) || row.before.length > 64 || row.before.some(p => !p || typeof p !== "object")) return false;
  const ids = row.before.map(p => p.id);
  if (row?.error || !ids?.length || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647) ||
      !Array.isArray(n?.missingIds) || n.missingIds.length || !Array.isArray(n.missingReasons) || n.missingReasons.length ||
      !Array.isArray(n.processes) || n.processes.some(p => !p || typeof p !== "object") || n.processes.length !== new Set(ids).size ||
      new Set(n.processes.map(p => p.id)).size !== n.processes.length) return false;
  return n.processes.every(p => ids.includes(p.id) && [p.privateBytes, p.workingSetBytes].every(v => Number.isSafeInteger(v) && v >= 0));
}
export async function writeNativeUiFixture(path, value) {
  const plan = nativeUiPlan(value), file = await open(path, "wx"), digest = createHash("sha256");
  let writtenBytes = 0;
  try {
    const cipher = createCipheriv("aes-256-ctr", Buffer.from(KEY, "hex"), Buffer.from(IV, "hex"));
    const zeros = Buffer.alloc(4 * 1024 ** 2);
    while (writtenBytes < plan.fileBytes) {
      const bytes = cipher.update(zeros.subarray(0, Math.min(zeros.length, plan.fileBytes - writtenBytes)));
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.write(bytes, offset, bytes.length - offset, writtenBytes + offset);
        if (result.bytesWritten < 1) throw new Error("Fixture write made no progress.");
        offset += result.bytesWritten;
      }
      digest.update(bytes); writtenBytes += bytes.length;
    }
    if (cipher.final().length !== 0) throw new Error("Unexpected CTR final bytes.");
    await file.sync();
  } finally { await file.close(); }
  const sha256 = digest.digest("hex"), info = await stat(path);
  if (sha256 !== plan.expectedSha256 || info.size !== plan.fileBytes) throw new Error("Native fixture digest or size mismatch.");
  return { path, fileBytes: info.size, writtenBytes, sha256, mtimeMs: info.mtimeMs,
    algorithm: "Public AES-256-CTR over zero input; every byte written in bounded4MiB chunks", keyHex: KEY, ivHex: IV };
}
