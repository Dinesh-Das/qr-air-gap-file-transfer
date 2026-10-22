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
