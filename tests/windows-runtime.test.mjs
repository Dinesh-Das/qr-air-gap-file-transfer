import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readPackagingOptions, prepareWindowsRuntime } from "../scripts/windows-runtime.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("preserves external-runtime packaging and accepts explicit pinned runtime inputs", () => {
  expect(readPackagingOptions(["output with spaces"])).toEqual({ output: "output with spaces" });
  expect(readPackagingOptions(["out", "--runtime-dir", "runtime with spaces", "--runtime-sha256", "a".repeat(64)]))
    .toEqual({ output: "out", runtimeDirectory: "runtime with spaces", runtimeSha256: "a".repeat(64) });
});
it.each([
  ["out", "--runtime-dir", "runtime"],
  ["out", "--runtime-sha256", "a".repeat(64)],
  ["out", "--runtime-dir", "runtime", "--runtime-sha256", "not-a-hash"],
  ["out", "--unknown", "value"],
  ["out", "extra"],
  ["out", "constructor", "value"],
  ["out", "--runtime-dir", "one", "--runtime-dir", "two", "--runtime-sha256", "a".repeat(64)],
])("rejects incomplete or ambiguous packaging arguments: %j", (...args) => {
  expect(() => readPackagingOptions(args)).toThrow();
});
it("rejects a runtime checksum mismatch before attempting to execute it", async () => {
  const root = await mkdtemp(join(tmpdir(), "qrft-runtime-input-")); roots.push(root);
  await writeFile(join(root, "node.exe"), "deliberately not executable");
  await writeFile(join(root, "LICENSE"), "fixture");
  await expect(prepareWindowsRuntime(root, "0".repeat(64))).rejects.toThrow("checksum");
});
it("rejects a missing or incomplete license before executing the runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "qrft-runtime-input-")); roots.push(root);
  const bytes = Buffer.from("deliberately not executable");
  const sha = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(root, "node.exe"), bytes);
  await expect(prepareWindowsRuntime(root, sha)).rejects.toThrow(/LICENSE/);
  await writeFile(join(root, "LICENSE"), "fixture");
  await expect(prepareWindowsRuntime(root, sha)).rejects.toThrow(/LICENSE/);
});
