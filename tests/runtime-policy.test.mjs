import { expect, it } from "vitest";
import { assertSupportedNode } from "../scripts/launch.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Security floors published on 21 October 2026, not API compatibility minima.
it.each(["20.19.0", "22.12.0", "22.23.3", "24.0.0", "24.22.0", "26.12.0",
  "25.0.0", "27.0.0", "28.0.0", "24.22.1-rc.1", "24.22.1junk", "24.22",
  "24.022.1", "24.22.1.0", "24.22.NaN", "", null, 24])(
  "rejects unpatched, unreviewed or invalid runtime %j", (version) => {
    expect(() => assertSupportedNode(version)).toThrow("newer runtime");
  });

it.each(["launch.mjs", "serve.mjs", "package-offline.mjs"])(
  "refuses an unpatched runtime at the %s entry point before starting work", (entry) => {
    const root = mkdtempSync(join(tmpdir(), "qrft-runtime-refusal-"));
    const output = join(root, "must not exist");
    try {
      const moduleUrl = pathToFileURL(resolve("scripts", entry)).href;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        Object.defineProperty(process.versions, 'node', {value: '24.22.0'});
        process.argv = [process.execPath, 'entry', ${JSON.stringify(output)}];
        const module = await import(${JSON.stringify(moduleUrl)});
        ${entry === "launch.mjs" ? `await module.launchOfflineApplication({directory: ${JSON.stringify(output)}});` : ""}
      `], { encoding: "utf8", timeout: 10000, windowsHide: true });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("newer runtime");
      expect(existsSync(output)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

it.each(["22.23.4", "22.24.0", "24.22.1", "24.22.2", "24.23.0", "26.12.1", "26.13.0"])(
  "accepts patched stable runtime %s", (version) => {
    expect(() => assertSupportedNode(version)).not.toThrow();
  });
