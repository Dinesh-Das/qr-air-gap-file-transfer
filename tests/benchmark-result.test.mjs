import { expect, it } from "vitest";
import { benchmarkResultPassed } from "../scripts/benchmark-result.mjs";

it("requires verified receive data and any requested destination audit", () => {
  expect(benchmarkResultPassed({ verified: true })).toBe(true);
  expect(benchmarkResultPassed({ verified: false })).toBe(false);
  expect(benchmarkResultPassed({})).toBe(false);
  expect(benchmarkResultPassed({ verified: true, destination: { verified: false } })).toBe(false);
  expect(benchmarkResultPassed({ verified: true, destination: { verified: true } })).toBe(true);
});
it("does not hide data or cleanup errors behind a verified result", () => {
  expect(benchmarkResultPassed({ verified: true, error: "quota failure" })).toBe(false);
  expect(benchmarkResultPassed({ verified: true, cleanupError: "locked store" })).toBe(false);
});
it("accepts a complete unverified storage probe but rejects partial writes", () => {
  const probe = { mode: "OPFS-only quota probe", verified: false, mib: 1, writtenBytes: 1048576 };
  expect(benchmarkResultPassed(probe)).toBe(true);
  expect(benchmarkResultPassed({ ...probe, writtenBytes: 1048575 })).toBe(false);
  expect(benchmarkResultPassed({ ...probe, error: "journal failed" })).toBe(false);
});
