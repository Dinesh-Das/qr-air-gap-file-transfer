import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { benchmarkWindowSource, readBenchmarkWindow } from "../scripts/benchmark-window.mjs";

it("defaults to the production window and explicitly permits the 64-block experiment", () => {
  expect(readBenchmarkWindow(undefined)).toBe(96);
  expect(readBenchmarkWindow("96")).toBe(96);
  expect(readBenchmarkWindow("64")).toBe(64);
});
it.each(["0", "32", "128", "064", "64,96"])("rejects unsupported or ambiguous experiment input %s", (value) => {
  expect(() => readBenchmarkWindow(value)).toThrow(/64 or 96/);
});
it("changes only the anchored window declaration and leaves the default source exact", () => {
  const source = readFileSync(new URL("../src/lib/webrtc-transfer.ts", import.meta.url), "utf8");
  const marker = "const MAX_IN_FLIGHT_BLOCKS = 96;";
  const pieces = source.split(marker);
  expect(pieces).toHaveLength(2);
  expect(benchmarkWindowSource(source, 96)).toBe(source);
  expect(benchmarkWindowSource(source, 64)).toBe(pieces[0] + "const MAX_IN_FLIGHT_BLOCKS = 64;" + pieces[1]);
});
it("refuses missing, duplicated or invalid overrides instead of silently testing another setup", () => {
  expect(() => benchmarkWindowSource("no marker", 64)).toThrow(/no longer matches/);
  expect(() => benchmarkWindowSource("const MAX_IN_FLIGHT_BLOCKS = 96;const MAX_IN_FLIGHT_BLOCKS = 96;", 64)).toThrow(/no longer matches/);
  expect(() => benchmarkWindowSource("const MAX_IN_FLIGHT_BLOCKS = 96;", 128)).toThrow(/64 or 96/);
});
