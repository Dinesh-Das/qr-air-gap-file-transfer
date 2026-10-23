import { expect, it } from "vitest";
import { nativeUiPlan, nativeSampleComplete, writeNativeUiFixture } from "../scripts/native-ui-contract.mjs";

it("budgets all three new5GiB copies and preserves the reserve and margin", () => {
  expect(nativeUiPlan(undefined)).toMatchObject({ mib: 5120, fileBytes: 5368709120, requiredFreeBytes: 18673041408, smokeOnly: false });
});
it("labels16MiB smoke separately and cannot downgrade the large trial", () => {
  expect(nativeUiPlan("16")).toMatchObject({ mib: 16, fileBytes: 16777216, requiredFreeBytes: 2617245696, smokeOnly: true });
  expect(nativeUiPlan("5120").fileBytes).toBe(5368709120);
});
it.each(["0", "32", "016", "5120,16"])("rejects an unsupported native qualification size %s", value => {
  expect(() => nativeUiPlan(value)).toThrow(/16 or 5120/);
});
const row = () => ({ before: [{ id: 123, type: "browser" }, { id: 456, type: "renderer" }],
  native: { missingIds: [], missingReasons: [], processes: [
    { id: 123, privateBytes: 100, workingSetBytes: 200 }, { id: 456, privateBytes: 300, workingSetBytes: 400 },
  ] } });
it("accepts only complete readings of every selected PID", () => { expect(nativeSampleComplete(row())).toBe(true); });
it("keeps a missing PID invalid even if it exited before the after-list", () => {
  const sample = row(); sample.native.missingIds = [456]; sample.native.missingReasons = [{ id: 456, category: "ObjectNotFound" }]; sample.native.processes.pop(); sample.after = [{ id: 123 }];
  expect(nativeSampleComplete(sample)).toBe(false);
});
it.each(["duplicate", "extra", "invalid counter", "observer error"])("rejects %s instead of silently completing a memory sample", kind => {
  const sample = row();
  if (kind === "duplicate") sample.native.processes[1] = { ...sample.native.processes[0] };
  if (kind === "extra") sample.native.processes.push({ id: 789, privateBytes: 100, workingSetBytes: 100 });
  if (kind === "invalid counter") sample.native.processes[1].privateBytes = NaN;
  if (kind === "observer error") sample.error = "Observer timed out";
  expect(nativeSampleComplete(sample)).toBe(false);
});

it("writes the known native fixture completely and refuses to overwrite its source", async () => {
  const { mkdtemp, stat, rm, lstat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve, dirname, basename } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "qrft-native-fixture-test-")), file = join(root, "source.bin");
  try {
    const result = await writeNativeUiFixture(file, "16");
    expect(result.writtenBytes).toBe(16777216);
    expect(result.sha256).toBe("c5c5b38b9be32a4002c3e438b2c345623c56d2219b450d36e4c8df793ecbc006");
    expect((await stat(file)).size).toBe(16777216);
    await expect(writeNativeUiFixture(file, "16")).rejects.toMatchObject({ code: "EEXIST" });
    expect((await stat(file)).size).toBe(16777216);
  } finally {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(basename(root).startsWith("qrft-native-fixture-test-")).toBe(true);
    expect((await lstat(root)).isSymbolicLink()).toBe(false);
    await rm(root, { recursive: true });
  }
});

it("refuses malformed observer shapes instead of throwing away the raw result", () => {
  const sample = row(); sample.before = {};
  expect(nativeSampleComplete(sample)).toBe(false);
  const broken = row(); broken.native.processes[1] = null;
  expect(nativeSampleComplete(broken)).toBe(false);
});
it("retains the observer's64requested-PID ceiling", () => {
  const sample = row(); sample.before = Array(65).fill({ id: 123 });
  expect(nativeSampleComplete(sample)).toBe(false);
});
