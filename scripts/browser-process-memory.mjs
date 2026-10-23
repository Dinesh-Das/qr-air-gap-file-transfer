import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** Development-only observer; IDs come from the isolated benchmark browsers. */
export async function readWindowsProcessMemory(processIds) {
  if (!Array.isArray(processIds) || !processIds.length || processIds.length > 64 ||
      processIds.some((id) => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)) {
    throw new Error("Invalid process ID list.");
  }
  if (process.platform !== "win32") throw new Error("Process memory observation requires Windows.");
  const script = await readFile(new URL("./browser-process-memory.ps1", import.meta.url), "utf8");
  const startedAtMs = Date.now(), started = performance.now();
  return new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        // Fixed stage names only; retain partial stderr even when the native child is killed.
        const stages = [];
        for (const line of stderr.split(/\r?\n/)) {
          const match = /^QRFT_MEMORY_STAGE (entered|input-parsed|lookups-finished|output-ready) ([0-9]{1,16})$/.exec(line);
          if (match && Number.isSafeInteger(Number(match[2]))) stages.push({ stage: match[1], atMs: Number(match[2]) });
          if (stages.length === 4) break;
        }
        const observerDiagnostic = { startedAtMs, finishedAtMs: Date.now(), elapsedMs: performance.now() - started,
          stages, lastStage: stages.at(-1)?.stage ?? "unobserved" };
        if (error) {
          const status = [
            error.code != null ? `code=${error.code}` : "",
            error.signal ? `signal=${error.signal}` : "",
            error.killed ? "terminated" : "",
            `stage=${observerDiagnostic.lastStage}`,
          ].filter(Boolean).join(", ");
          const detail = stderr.trim().slice(0, 256);
          const failure = new Error(`Process memory observation failed${status ? ` (${status})` : ""}${detail ? `: ${detail}` : "."}`, { cause: error });
          failure.observerDiagnostic = observerDiagnostic;
          reject(failure);
          return;
        }
        try { resolve({ ...JSON.parse(stdout.trim().replace(/^\uFEFF/, "")), observerDiagnostic }); }
        catch (cause) { reject(new Error("Process memory observer returned invalid JSON.", { cause })); }
      });
    // IDs are data on stdin, never interpolated into PowerShell source.
    child.stdin.end(JSON.stringify([...new Set(processIds)]));
  });
}
