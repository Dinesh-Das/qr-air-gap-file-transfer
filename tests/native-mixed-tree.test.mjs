import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, stat, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createHash, createCipheriv, randomUUID } from "node:crypto";
import { nativeMixedTreePlan, writeNativeMixedTree } from "../scripts/native-mixed-tree.mjs";

const fault = vi.hoisted(() => ({ completeManifestWrite: false, ownerWrite: false, bootstrapWrite: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal();
  const fail = () => Object.assign(new Error("Injected completed-manifest write failure"), { code: "EIO" });
  const shouldFail = (path, data) => fault.ownerWrite && String(path).endsWith("OWNER.json") ||
    fault.bootstrapWrite && /"complete"\s*:\s*false/.test(String(data)) ||
    fault.completeManifestWrite && /"complete"\s*:\s*true/.test(String(data));
  return { ...fs,
    writeFile: async (path, data, ...options) => {
      if (shouldFail(path, data)) {
        await fs.writeFile(path, "{", { flag: "w" }); throw fail();
      }
      return fs.writeFile(path, data, ...options);
    },
    open: async (path, ...options) => {
      const handle = await fs.open(path, ...options);
      if (!String(path).includes("FIXTURE")) return handle;
      return { writeFile: async (data) => {
        if (shouldFail(path, data)) { await handle.writeFile("{"); throw fail(); }
        return handle.writeFile(data);
      },
        sync: () => handle.sync(), close: () => handle.close() };
    },
  };
});

it.each(["ownerWrite", "bootstrapWrite"])("creates no payload when %s fails during initialization", async (failure) => {
  const parent = await mkdtemp(join(tmpdir(), "qrft-mixed-fixture-test-"));
  const output = join(parent, "failed initialization");
  try {
    fault[failure] = true;
    await expect(writeNativeMixedTree(output, "smoke")).rejects.toMatchObject({ code: "EIO" });
    await expect(lstat(join(output, "native-mixed-source"))).rejects.toMatchObject({ code: "ENOENT" });
    if (failure === "ownerWrite") {
      expect(JSON.parse(await readFile(join(output, "FIXTURE.json"), "utf8")).complete).toBe(false);
    } else {
      await expect(readFile(join(output, "FIXTURE.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    fault[failure] = false;
    expect(dirname(resolve(parent))).toBe(resolve(tmpdir()));
    expect(basename(parent).startsWith("qrft-mixed-fixture-test-")).toBe(true);
    expect((await lstat(parent)).isSymbolicLink()).toBe(false);
    await rm(parent, { recursive: true });
  }
});

it("keeps the native mixed case distinct from smoke and existing large qualification", () => {
  expect(nativeMixedTreePlan()).toMatchObject({ fileBytes: 104857600, tinyFiles: 4000, emptyFiles: 128, groups: 64, smokeOnly: false, reserveBytes: 2147483648, marginBytes: 419430400, deadlineMs: 1800000 });
  expect(nativeMixedTreePlan().requiredFreeBytes).toBe(2881486848);
  expect(nativeMixedTreePlan("smoke").smokeOnly).toBe(true);
  for (const bad of ["", "100", "5120", "SMOKE", null, 0, {}]) expect(() => nativeMixedTreePlan(bad)).toThrow();
});

it("writes independent deterministic bytes, nested/empty paths and exact file digests", async () => {
  const parent = await mkdtemp(join(tmpdir(), "qrft-mixed-fixture-test-"));
  const output = join(parent, "new fixture");
  try {
    const fixture = await writeNativeMixedTree(output, "smoke");
    expect(fixture.complete).toBe(true); expect(fixture.smokeOnly).toBe(true);
    expect(fixture.files).toHaveLength(21); expect(fixture.directories).toHaveLength(8);
    expect(fixture.files.reduce((n, f) => n + f.bytes, 0)).toBe(8388673);
    expect(await readdir(join(fixture.sourceDirectory, "empty-only"))).toEqual([]);
    const key = createHash("sha256").update("qrft-native-mixed-v1").digest();
    for (const entry of fixture.files) {
      const actual = await readFile(join(fixture.sourceDirectory, entry.path));
      const cipher = createCipheriv("aes-256-ctr", key, createHash("sha256").update(entry.path).digest().subarray(0, 16));
      const expected = Buffer.concat([cipher.update(Buffer.alloc(entry.bytes)), cipher.final()]);
      expect(actual.equals(expected)).toBe(true);
      expect(createHash("sha256").update(actual).digest("hex")).toBe(entry.sha256);
      expect((await stat(join(fixture.sourceDirectory, entry.path))).size).toBe(entry.bytes);
    }
    const before = await readFile(join(output, "FIXTURE.json"));
    await expect(writeNativeMixedTree(output, "smoke")).rejects.toMatchObject({ code: "EEXIST" });
    expect((await readFile(join(output, "FIXTURE.json"))).equals(before)).toBe(true);
    expect(fixture.maxWriteBufferBytes).toBeLessThanOrEqual(4194304);
  } finally {
    expect(dirname(resolve(parent))).toBe(resolve(tmpdir()));
    expect(basename(parent).startsWith("qrft-mixed-fixture-test-")).toBe(true);
    expect((await lstat(parent)).isSymbolicLink()).toBe(false);
    await rm(parent, { recursive: true });
  }
});

it("refuses an implicit or relative destination before creating data", async () => {
  await expect(writeNativeMixedTree("relative-fixture", "smoke")).rejects.toThrow("absolute");
  await expect(writeNativeMixedTree(undefined, "smoke")).rejects.toThrow("absolute");
  if (process.platform === "win32") {
    for (const bad of [`/qrft-missing-${randomUUID()}/child`, `\\qrft-missing-${randomUUID()}\\child`]) {
      // The old implementation reaches statfs; a verified missing parent makes
      // this regression probe fail without creating anything on a drive root.
      await expect(lstat(dirname(resolve(bad)))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(writeNativeMixedTree(bad, "smoke")).rejects.toThrow("absolute");
    }
  }
});

it("retains its parseable incomplete marker after a completed-manifest write fails", async () => {
  const parent = await mkdtemp(join(tmpdir(), "qrft-mixed-fixture-test-"));
  const output = join(parent, "interrupted manifest");
  try {
    fault.completeManifestWrite = true;
    await expect(writeNativeMixedTree(output, "smoke")).rejects.toMatchObject({ code: "EIO" });
    const marker = await readFile(join(output, "FIXTURE.json"), "utf8");
    expect(marker).toMatch(/"complete"\s*:\s*false/);
    expect(JSON.parse(marker).complete).toBe(false);
  } finally {
    fault.completeManifestWrite = false;
    expect(dirname(resolve(parent))).toBe(resolve(tmpdir()));
    expect(basename(parent).startsWith("qrft-mixed-fixture-test-")).toBe(true);
    expect((await lstat(parent)).isSymbolicLink()).toBe(false);
    await rm(parent, { recursive: true });
  }
});
