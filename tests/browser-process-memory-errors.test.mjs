import { expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({ error: null, stderr: "", stdin: { end: vi.fn() } }));
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(child.error, "", child.stderr));
    return { stdin: child.stdin };
  }),
}));
import { readWindowsProcessMemory } from "../scripts/browser-process-memory.mjs";

it.runIf(process.platform === "win32")("preserves native termination evidence without putting the script in the summary", async () => {
  const error = Object.assign(new Error("Command failed: powershell.exe FULL-SCRIPT"), {
    code: null, killed: true, signal: "SIGTERM",
  });
  child.error = error;
  child.stderr = "";
  const failure = await readWindowsProcessMemory([process.pid]).catch(error => error);
  expect(failure.cause).toBe(error);
  expect(failure.message).toContain("signal=SIGTERM");
  expect(failure.message).toContain("terminated");
  expect(failure.message).not.toContain("FULL-SCRIPT");
});

it.runIf(process.platform === "win32")("keeps the child error code and bounds stderr in the diagnostic summary", async () => {
  const error = Object.assign(new Error("Command failed"), { code: "EACCES", killed: false });
  child.error = error;
  child.stderr = "observer error ".repeat(100);
  const failure = await readWindowsProcessMemory([process.pid]).catch(error => error);
  expect(failure.cause).toBe(error);
  expect(failure.message).toContain("code=EACCES");
  expect(failure.message).toContain("observer error");
  expect(failure.message.length).toBeLessThan(400);
});

it.runIf(process.platform === "win32")("retains bounded observer stages when the child times out", async () => {
  child.error = Object.assign(new Error("Command failed"), { code: null, killed: true, signal: "SIGTERM" });
  child.stderr = "QRFT_MEMORY_STAGE entered 1792769955000\r\nQRFT_MEMORY_STAGE input-parsed 1792769955010\r\n";
  const failure = await readWindowsProcessMemory([process.pid]).catch(error => error);
  expect(failure.observerDiagnostic.stages).toEqual([
    { stage: "entered", atMs: 1792769955000 }, { stage: "input-parsed", atMs: 1792769955010 },
  ]);
  expect(failure.observerDiagnostic.lastStage).toBe("input-parsed");
  expect(failure.observerDiagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(failure.message).toContain("stage=input-parsed");
  expect(failure.cause).toBe(child.error);
});
it.runIf(process.platform === "win32")("reports unobserved stage without inventing startup evidence", async () => {
  child.error = Object.assign(new Error("Cannot spawn"), { code: "ENOENT" });
  child.stderr = "QRFT_MEMORY_STAGE secret 1792769955000\nQRFT_MEMORY_STAGE entered NaN\n";
  const failure = await readWindowsProcessMemory([process.pid]).catch(error => error);
  expect(failure.observerDiagnostic.lastStage).toBe("unobserved");
  expect(failure.observerDiagnostic.stages).toEqual([]);
  expect(failure.message).toContain("code=ENOENT");
});

it.runIf(process.platform === "win32")("bounds captured stage records even for repeated native stderr", async () => {
  child.error = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
  child.stderr = "QRFT_MEMORY_STAGE entered 1792769955000\n".repeat(100);
  const failure = await readWindowsProcessMemory([process.pid]).catch(error => error);
  expect(failure.observerDiagnostic.stages).toHaveLength(4);
  expect(failure.message.length).toBeLessThan(400);
});
