import { expect, it } from "vitest";
import { readWindowsProcessMemory } from "../scripts/browser-process-memory.mjs";

it("rejects malformed process IDs before invoking the observer", async () => {
  for (const ids of [[], [0], [-1], [1.5], ["1; exit 0"], [2 ** 31], Array(65).fill(1)]) {
    await expect(readWindowsProcessMemory(ids)).rejects.toThrow("Invalid process ID list");
  }
});

it.runIf(process.platform === "win32")("reads a live process and reports missing IDs without inventing memory", async () => {
  const result = await readWindowsProcessMemory([process.pid, process.pid, 2147483647]);
  expect(result.processes).toHaveLength(1);
  expect(result.processes[0].id).toBe(process.pid);
  expect(result.processes[0].privateBytes).toBeGreaterThan(0);
  expect(result.processes[0].workingSetBytes).toBeGreaterThan(0);
  expect(result.missingIds).toEqual([2147483647]);
  expect(result.sampleFinishedAtMs).toBeGreaterThanOrEqual(result.sampleStartedAtMs);
}, 20_000);
