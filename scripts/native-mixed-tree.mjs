import { createCipheriv, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const KEY = createHash("sha256").update("qrft-native-mixed-v1").digest();
const CHUNK_BYTES = 4 * 1024 ** 2;
const ROOT_NAME = "native-mixed-source";

export function nativeMixedTreePlan(mode = "qualification") {
  if (mode !== "qualification" && mode !== "smoke") throw new Error("Mixed-tree mode must be qualification or smoke.");
  const smokeOnly = mode === "smoke", fileBytes = smokeOnly ? 8 * 1024 ** 2 + 65 : 100 * 1024 ** 2;
  const reserveBytes = 2 * 1024 ** 3, marginBytes = 400 * 1024 ** 2;
  return Object.freeze({ mode, smokeOnly, fileBytes, tinyFiles: smokeOnly ? 16 : 4000,
    emptyFiles: smokeOnly ? 4 : 128, groups: smokeOnly ? 4 : 64, reserveBytes, marginBytes,
    requiredFreeBytes: 3 * fileBytes + reserveBytes + marginBytes, deadlineMs: 1_800_000 });
}

async function writeFileContent(path, relative, bytes) {
  const file = await open(path, "wx"), expected = createHash("sha256");
  const cipher = createCipheriv("aes-256-ctr", KEY, createHash("sha256").update(relative).digest().subarray(0, 16));
  const zeros = Buffer.alloc(Math.min(bytes, CHUNK_BYTES));
  let written = 0, maxWriteBufferBytes = 0;
  try {
    while (written < bytes) {
      const chunk = cipher.update(zeros.subarray(0, Math.min(zeros.length, bytes - written)));
      let offset = 0;
      while (offset < chunk.length) {
        const result = await file.write(chunk, offset, chunk.length - offset, written + offset);
        if (result.bytesWritten < 1) throw new Error("Fixture write made no progress.");
        offset += result.bytesWritten;
      }
      expected.update(chunk); written += chunk.length;
      maxWriteBufferBytes = Math.max(maxWriteBufferBytes, chunk.length);
    }
    if (cipher.final().length !== 0) throw new Error("Unexpected CTR final bytes.");
    await file.sync();
  } finally { await file.close(); }
  const actual = createHash("sha256");
  for await (const chunk of createReadStream(path)) actual.update(chunk);
  const sha256 = actual.digest("hex"), info = await stat(path);
  if (sha256 !== expected.digest("hex") || info.size !== bytes) throw new Error("Native fixture readback mismatch.");
  return { path: relative, bytes, sha256, mtimeMs: info.mtimeMs, lastModified: Math.trunc(info.mtimeMs), maxWriteBufferBytes };
}

async function publishFixtureManifest(root, manifest, phase) {
  const temporary = join(root, `FIXTURE.${phase}.tmp.json`);
  const file = await open(temporary, "wx");
  try { await file.writeFile(JSON.stringify(manifest, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, join(root, "FIXTURE.json"));
}

export function requireExplicitNativeMixedPath(output) {
  if (typeof output !== "string" || !isAbsolute(output) ||
      process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(output)) {
    throw new Error("Provide a new absolute fixture output path with an explicit drive or share on Windows.");
  }
  return resolve(output);
}

/** Public deterministic diagnostic data only. Never accepts an existing output. */
export async function writeNativeMixedTree(output, mode = "qualification") {
  const root = requireExplicitNativeMixedPath(output), plan = nativeMixedTreePlan(mode);
  const free = await statfs(dirname(root));
  if (!Number.isSafeInteger(free.bavail * free.bsize) || free.bavail * free.bsize < plan.requiredFreeBytes) {
    throw new Error("Mixed-tree fixture requires three-copy headroom plus the unchanged reserve and margin.");
  }
  await mkdir(root);
  // If this bootstrap fails, retain the directory and temp file but create no
  // payload. Missing/invalid manifests must never be accepted as complete.
  await publishFixtureManifest(root, { complete: false, plan, releaseReady: false }, "incomplete");
  await writeFile(join(root, "OWNER.json"), JSON.stringify({ purpose: "Public deterministic native mixed-tree fixture; preserve data and evidence.", mode, releaseReady: false }) + "\n", { flag: "wx" });
  const sourceDirectory = join(root, ROOT_NAME);
  await mkdir(sourceDirectory);
  const directories = ["deep", "deep/level-01", "deep/level-01/level-02", "empty-only"];
  for (let group = 0; group < plan.groups; group++) directories.push(`group-${String(group).padStart(2, "0")}`);
  directories.sort();
  for (const path of directories) await mkdir(join(sourceDirectory, path));
  const requested = [];
  for (let index = 0; index < plan.tinyFiles + plan.emptyFiles; index++) {
    const empty = index >= plan.tinyFiles;
    requested.push({ path: `group-${String(index % plan.groups).padStart(2, "0")}/${empty ? "empty" : "tiny"}-${String(index).padStart(5, "0")}.bin`, bytes: empty ? 0 : 1024 });
  }
  requested.push({ path: "deep/level-01/level-02/large.bin", bytes: plan.fileBytes - plan.tinyFiles * 1024 });
  requested.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const files = [];
  for (const entry of requested) files.push(await writeFileContent(join(sourceDirectory, entry.path), entry.path, entry.bytes));
  const fixture = { version: 1, complete: true, ...plan, sourceDirectory, rootName: ROOT_NAME, directories, files,
    recipe: "AES-256-CTR over zeros; key=SHA256(UTF8(qrft-native-mixed-v1)); IV=first16(SHA256(UTF8(relative path))); every file written, synced and independently read back.",
    maxWriteBufferBytes: Math.max(...files.map(f => f.maxWriteBufferBytes)), releaseReady: false };
  // Preserve the parseable incomplete marker until a fully synced replacement
  // is available. A failed/partial final write stays in the separate temp file.
  await publishFixtureManifest(root, fixture, "complete");
  return fixture;
}
