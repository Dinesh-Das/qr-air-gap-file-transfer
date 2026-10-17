import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, link, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, afterAll, expect, it, describe } from "vitest";

describe.skipIf(process.platform !== "win32")("Windows command launcher", () => {
  let root, executable;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "qrft-cmd-test-"));
    await mkdir(join(root, "external runtime"));
    executable = join(root, "external runtime/node.exe");
    await copyFile(process.execPath, executable);
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function run({ bundled = true, pathNode = false, code = 0, corrupt = false } = {}) {
    const directory = join(root, `bundle with spaces & (symbols)! ${crypto.randomUUID()}`);
    await mkdir(join(directory, "scripts"), { recursive: true });
    await copyFile(resolve("Start AirGap QR.cmd"), join(directory, "Start AirGap QR.cmd"));
    await writeFile(join(directory, "scripts/launch.mjs"), `console.log('LAUNCH_PROBE:' + process.execPath); process.exitCode = ${code};`);
    if (bundled) {
      await mkdir(join(directory, "runtime"));
      if (corrupt) await writeFile(join(directory, "runtime/node.exe"), "not an executable");
      else await link(executable, join(directory, "runtime/node.exe"));
    }
    const system32 = join(process.env.SystemRoot, "System32");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = pathNode ? join(root, "external runtime") + ";" + system32 : system32;
    const child = spawnSync(join(system32, "cmd.exe"), ["/d", "/s", "/c", `""${join(directory, "Start AirGap QR.cmd")}""`], {
      cwd: root, env, input: "\r\n", encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 15000,
    });
    expect(child.error).toBeUndefined();
    return { ...child, output: child.stdout + child.stderr, directory };
  }

  it("uses its bundled runtime with Node absent from PATH and shell symbols in its path", async () => {
    const result = await run();
    expect(result.status).toBe(0);
    expect(result.output).toContain("LAUNCH_PROBE:" + join(result.directory, "runtime/node.exe"));
  });
  it("prefers its bundled runtime over an installed runtime", async () => {
    const result = await run({ pathNode: true });
    expect(result.status).toBe(0);
    expect(result.output).toContain("LAUNCH_PROBE:" + join(result.directory, "runtime/node.exe"));
  });
  it("preserves the launcher failure exit code", async () => {
    const result = await run({ code: 23 });
    expect(result.status).toBe(23);
  });
  it("supports the original external runtime package", async () => {
    const result = await run({ bundled: false, pathNode: true });
    expect(result.status).toBe(0);
    expect(result.output).toContain("LAUNCH_PROBE:" + executable);
  });
  it("reports a missing runtime when neither source exists", async () => {
    const result = await run({ bundled: false });
    expect(result.status).toBe(1);
    expect(result.output).toContain("could not find its required runtime");
  });
  it("does not silently fall back when the bundled runtime is broken", async () => {
    const result = await run({ corrupt: true, pathNode: true });
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("LAUNCH_PROBE:");
  });
});
