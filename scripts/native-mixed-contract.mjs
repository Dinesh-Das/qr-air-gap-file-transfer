import assert from "node:assert/strict";
import { createHash, createDecipheriv } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { nativeMixedTreePlan, requireExplicitNativeMixedPath } from "./native-mixed-tree.mjs";

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function validateNativeMixedFixture(fixture, mode = "qualification") {
  const plan = nativeMixedTreePlan(mode);
  // Pin the acceptance bar separately from the fixture writer's plan.
  assert.equal(plan.fileBytes, mode === "smoke" ? 8388673 : 104857600);
  assert.equal(plan.tinyFiles, mode === "smoke" ? 16 : 4000);
  assert.equal(plan.emptyFiles, mode === "smoke" ? 4 : 128);
  assert.equal(plan.groups, mode === "smoke" ? 4 : 64);
  assert.equal(plan.reserveBytes, 2147483648); assert.equal(plan.marginBytes, 419430400);
  assert.equal(plan.deadlineMs, 1800000);
  assert.equal(fixture?.complete, true, "Mixed fixture is incomplete");
  assert.equal(fixture.version, 1, "Mixed fixture version");
  for (const [key, value] of Object.entries(plan)) assert.equal(fixture[key], value, `Mixed fixture ${key}`);
  assert.equal(fixture.rootName, "native-mixed-source");
  const source = requireExplicitNativeMixedPath(fixture.sourceDirectory);
  assert.equal(basename(source), fixture.rootName);
  const directories = ["deep", "deep/level-01", "deep/level-01/level-02", "empty-only",
    ...Array.from({ length: plan.groups }, (_, i) => `group-${String(i).padStart(2, "0")}`)].sort(compare);
  const files = [];
  for (let i = 0; i < plan.tinyFiles + plan.emptyFiles; i++) files.push({
    path: `group-${String(i % plan.groups).padStart(2, "0")}/${i < plan.tinyFiles ? "tiny" : "empty"}-${String(i).padStart(5, "0")}.bin`, bytes: i < plan.tinyFiles ? 1024 : 0,
  });
  files.push({ path: "deep/level-01/level-02/large.bin", bytes: plan.fileBytes - plan.tinyFiles * 1024 });
  files.sort((a, b) => compare(a.path, b.path));
  assert.deepEqual(fixture.directories, directories, "Mixed directory paths/order");
  assert(Array.isArray(fixture.files)); assert.equal(fixture.files.length, files.length);
  for (let i = 0; i < files.length; i++) {
    const f = fixture.files[i]; assert.equal(f.path, files[i].path); assert.equal(f.bytes, files[i].bytes);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert(Number.isFinite(f.mtimeMs) && f.mtimeMs >= 0);
    assert(Number.isSafeInteger(f.lastModified) && f.lastModified === Math.trunc(f.mtimeMs));
  }
  return plan;
}

/** Independent native readback: exact tree, bytes, public recipe and identities. */
export async function auditNativeMixedSource(fixture, mode = "qualification") {
  const plan = validateNativeMixedFixture(fixture, mode), actualFiles = [], actualDirectories = [];
  assert(!(await lstat(fixture.sourceDirectory)).isSymbolicLink());
  async function walk(dir, prefix = "") {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      assert(!e.isSymbolicLink()); const relative = prefix + e.name;
      if (e.isDirectory()) { actualDirectories.push(relative); await walk(join(dir, e.name), relative + "/"); }
      else { assert(e.isFile()); actualFiles.push(relative); }
    }
  }
  await walk(fixture.sourceDirectory);
  assert.deepEqual(actualDirectories.sort(compare), fixture.directories);
  assert.deepEqual(actualFiles.sort(compare), fixture.files.map(f => f.path));
  const stream = createHash("sha256"), key = createHash("sha256").update("qrft-native-mixed-v1").digest();
  let everyByteCompared = 0;
  for (const f of fixture.files) {
    const path = join(fixture.sourceDirectory, f.path), before = await lstat(path);
    assert.equal(before.size, f.bytes); assert.equal(before.mtimeMs, f.mtimeMs);
    const hash = createHash("sha256"), cipher = createDecipheriv("aes-256-ctr", key,
      createHash("sha256").update(f.path).digest().subarray(0, 16));
    let size = 0;
    for await (const bytes of createReadStream(path, { highWaterMark: 1024 ** 2 })) {
      assert(!cipher.update(bytes).some(b => b !== 0), "Native public fixture recipe mismatch");
      hash.update(bytes); stream.update(bytes); size += bytes.length;
    }
    assert.equal(cipher.final().length, 0); assert.equal(size, f.bytes); assert.equal(hash.digest("hex"), f.sha256);
    const after = await lstat(path); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
    everyByteCompared += size;
  }
  assert.equal(everyByteCompared, plan.fileBytes);
  const metadata = Buffer.from(JSON.stringify({ schema: "airgap-qr-tree", version: 3, rootName: fixture.rootName,
    directories: fixture.directories, files: fixture.files.map(f => ({ path: f.path, size: String(f.bytes), sha256: f.sha256, lastModified: f.lastModified })) }));
  const footer = Buffer.alloc(16); footer.writeBigUInt64LE(BigInt(metadata.length)); footer.write("QRF3END1", 8);
  stream.update(metadata); stream.update(footer);
  return { everyByteCompared, files: fixture.files.length, directories: fixture.directories.length,
    streamSha256: stream.digest("hex"), streamBytes: plan.fileBytes + metadata.length + 16,
    metadataSha256: createHash("sha256").update(metadata).digest("hex"), metadataHex: metadata.toString("hex"), footerHex: footer.toString("hex"),
    scope: "Independent native source audit and canonical stream identity; no transfer or save proof.", releaseReady: false };
}
