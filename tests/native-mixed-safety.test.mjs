import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { assertIndependentMixedOutput, closeMixedAudit, stableMixedNativeSample } from "../scripts/native-mixed-safety.mjs";

it("attempts every owned audit cleanup even after earlier failures", async () => {
  const calls = [], errors = [];
  await closeMixedAudit([
    async () => { calls.push("file"); throw Error("file close failed"); },
    async () => { calls.push("cdp"); throw Error("detach failed"); },
    async () => { calls.push("browser"); },
  ], errors);
  expect(calls).toEqual(["file", "cdp", "browser"]);
  expect(errors).toHaveLength(2);
});

it("rejects process inventory changes and missing after inventories", () => {
  const row = { before: [{ id: 1 }], after: [{ id: 1 }], native: {
    missingIds: [], missingReasons: [], processes: [{ id: 1, privateBytes: 1, workingSetBytes: 1 }],
  } };
  expect(stableMixedNativeSample(row)).toBe(true);
  expect(stableMixedNativeSample({ ...row, after: [{ id: 1 }, { id: 2 }] })).toBe(false);
  expect(stableMixedNativeSample({ ...row, after: [] })).toBe(false);
  expect(stableMixedNativeSample({ ...row, after: undefined })).toBe(false);
});

it("rejects source overlap and sealed ancestors before writing output", async () => {
  const parent = await mkdtemp(join(tmpdir(), "qrft-mixed-safety-test-"));
  try {
    const container = join(parent, "fixture"), source = join(container, "native-mixed-source");
    await mkdir(source, { recursive: true });
    const fixture = { sourceDirectory: source }, metadata = join(container, "FIXTURE.json");
    await writeFile(metadata, "{}");
    await expect(assertIndependentMixedOutput(join(source, "run"), metadata, fixture)).rejects.toThrow("overlap");
    await expect(assertIndependentMixedOutput(join(container, "run"), metadata, fixture)).rejects.toThrow("overlap");
    await expect(assertIndependentMixedOutput(join(container, "..run"), metadata, fixture)).rejects.toThrow("overlap");
    await expect(assertIndependentMixedOutput(join(parent, "run"), metadata, fixture)).resolves.toBeUndefined();
    await writeFile(join(parent, "CLOSURE-HASHES.json"), "{}");
    await expect(assertIndependentMixedOutput(join(parent, "run"), metadata, fixture)).rejects.toThrow("sealed");
    await expect(lstat(join(parent, "run"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    expect(dirname(resolve(parent))).toBe(resolve(tmpdir()));
    expect(basename(parent).startsWith("qrft-mixed-safety-test-")).toBe(true);
    expect((await lstat(parent)).isSymbolicLink()).toBe(false);
    await rm(parent, { recursive: true });
  }
});
