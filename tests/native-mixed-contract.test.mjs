import { beforeAll, afterAll, expect, it } from "vitest";
import { mkdtemp, readFile, open, stat, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname, resolve } from "node:path";
import { writeNativeMixedTree } from "../scripts/native-mixed-tree.mjs";
import { validateNativeMixedFixture, auditNativeMixedSource } from "../scripts/native-mixed-contract.mjs";
import { prepareLargeSource } from "../src/lib/large-transfer";

let parent, fixture;
beforeAll(async () => { parent = await mkdtemp(join(tmpdir(), "qrft-mixed-audit-test-")); fixture = await writeNativeMixedTree(join(parent, "fixture"), "smoke"); });
afterAll(async () => {
  if (!parent) return;
  expect(dirname(resolve(parent))).toBe(resolve(tmpdir()));
  expect(basename(parent).startsWith("qrft-mixed-audit-test-")).toBe(true);
  expect((await lstat(parent)).isSymbolicLink()).toBe(false);
  await rm(parent, { recursive: true });
});

it("binds an independently audited native tree to the actual application stream encoding", async () => {
  const audit = await auditNativeMixedSource(fixture, "smoke"), files = [];
  for (const f of fixture.files) {
    const file = new File([await readFile(join(fixture.sourceDirectory, f.path))], basename(f.path), { lastModified: f.lastModified });
    files.push({ path: f.path, size: file.size, lastModified: file.lastModified, handle: { getFile: async () => file } });
  }
  const source = await prepareLargeSource({ rootName: fixture.rootName, rootHandle: {}, files,
    directories: fixture.directories, totalFileBytes: BigInt(fixture.fileBytes) });
  expect(audit.streamSha256).toBe(Buffer.from(source.streamSha256).toString("hex"));
  expect(audit.metadataHex).toBe(Buffer.from(source.metadataBytes).toString("hex"));
  expect(audit.streamBytes).toBe(Number(source.totalStreamBytes));
  expect(audit.everyByteCompared).toBe(8388673);
});

it("cannot relabel smoke, incomplete or altered plans as qualification", () => {
  expect(() => validateNativeMixedFixture(fixture)).toThrow();
  for (const change of [{ complete: false }, { fileBytes: fixture.fileBytes - 1 }, { reserveBytes: 0 }, { deadlineMs: 3600000 }]) {
    expect(() => validateNativeMixedFixture({ ...fixture, ...change }, "smoke")).toThrow();
  }
});

it.each(["path", "bytes", "sha256", "lastModified"])("rejects corrupt %s identity before source access", key => {
  const copy = structuredClone(fixture);
  copy.files[0][key] = key === "path" ? "../elsewhere.bin" : key === "sha256" ? "not-a-hash" : -1;
  expect(() => validateNativeMixedFixture(copy, "smoke")).toThrow();
});

it("detects changed source bytes even when the recorded mtime is updated", async () => {
  const copy = structuredClone(fixture), first = copy.files[0], path = join(copy.sourceDirectory, first.path);
  const handle = await open(path, "r+");
  try { const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, 0); byte[0] ^= 1; await handle.write(byte, 0, 1, 0); await handle.sync(); }
  finally { await handle.close(); }
  first.mtimeMs = (await stat(path)).mtimeMs; first.lastModified = Math.trunc(first.mtimeMs);
  await expect(auditNativeMixedSource(copy, "smoke")).rejects.toThrow("public fixture recipe mismatch");
});
