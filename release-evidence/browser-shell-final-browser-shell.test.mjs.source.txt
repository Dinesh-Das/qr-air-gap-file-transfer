import {spawnSync} from "node:child_process";
import {mkdtemp, mkdir, writeFile, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname, basename, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

describe.skipIf(process.platform !== "win32")("Windows browser opener shell selection", () => {
  let root, probe, cwd, shadow, windowsDirectory;
  beforeAll(async () => {
    windowsDirectory = process.env.SystemRoot;
    root = await mkdtemp(join(tmpdir(), "qrft-browser-shell-"));
    cwd = join(root, "empty cwd & हिन्दी"); shadow = join(root, "shadow");
    await mkdir(cwd); await mkdir(shadow);
    await writeFile(join(shadow, "cmd.exe"), "Harmless non-executable fixture.");
    probe = join(root, "probe.mjs");
    // Patch built-in exports only in this isolated child. Keep the production
    // executable selection/options, replacing browser dispatch with exit 0.
    await writeFile(probe, `
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const nativeSpawn = childProcess.spawn;
const seen = [];
childProcess.spawn = (executable, args, options) => {
  seen.push({executable,args,options});
  return nativeSpawn(executable, ['/d','/s','/c','exit 0'], options);
};
syncBuiltinESMExports();
const {openDefaultBrowser} = await import(process.argv[2]);
const rootOverride = JSON.parse(process.argv[3]);
if(rootOverride === null) delete process.env.SystemRoot;
else process.env.SystemRoot = rootOverride;
try { await openDefaultBrowser('http://127.0.0.1:4178'); console.log(JSON.stringify({success:true,seen})); }
catch(error) { console.log(JSON.stringify({success:false,message:error.message,seen})); process.exitCode=1; }
`);
  });
  afterAll(async () => {
    if (!root) return;
    const target = await realpath(root), parent = await realpath(tmpdir());
    if (dirname(target).toLowerCase() !== parent.toLowerCase() || !basename(target).startsWith("qrft-browser-shell-")) throw new Error("Unexpected fixture cleanup path");
    await rm(target, {recursive:true,force:true});
  });
  function run({workingDirectory = cwd, path = join(windowsDirectory,"System32"), systemRoot = windowsDirectory, comSpec} = {}) {
    const env = {...process.env};
    for (const key of Object.keys(env)) if (["path","systemroot","comspec"].includes(key.toLowerCase())) delete env[key];
    env.PATH = path;
    // Node itself needs a valid SystemRoot at process startup. Apply the
    // invalid-environment cases inside the child after module initialization.
    env.SystemRoot = windowsDirectory;
    if (comSpec) env.ComSpec = comSpec;
    const result = spawnSync(process.execPath, [probe, pathToFileURL(resolve("scripts/launch.mjs")).href, JSON.stringify(systemRoot)], {
      cwd:workingDirectory,env,encoding:"utf8",windowsHide:true,timeout:15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    return {...result, report:JSON.parse(result.stdout.trim())};
  }
  it.each(["cwd","PATH"])("ignores an unrelated invalid cmd.exe on %s", location => {
    const result = run(location === "cwd" ? {workingDirectory:shadow} : {path:shadow});
    expect(result.status).toBe(0);
    expect(result.report.success).toBe(true);
    expect(result.report.seen).toHaveLength(1);
    const call = result.report.seen[0];
    expect(call.executable.toLowerCase()).toBe(join(windowsDirectory,"System32","cmd.exe").toLowerCase());
    expect(call.args).toEqual(["/d","/s","/c",'start "" "http://127.0.0.1:4178"']);
    expect(call.options).toMatchObject({windowsHide:true,windowsVerbatimArguments:true,stdio:"ignore"});
  });
  it("does not use a caller supplied ComSpec in place of the Windows system shell", () => {
    const result = run({comSpec:join(shadow,"cmd.exe")});
    expect(result.status).toBe(0);
    expect(result.report.success).toBe(true);
  });
  it.each([null,"relative-windows"])("reports invalid SystemRoot %s before any process launch", systemRoot => {
    const result = run({systemRoot});
    expect(result.status).toBe(1);
    expect(result.report.message).toContain("Windows system directory is unavailable");
    expect(result.report.seen).toEqual([]);
  });
});
