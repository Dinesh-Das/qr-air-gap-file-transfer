// One guarded native UI case. No retry, size fallback or relaxed PID accounting.
import { mkdir, readFile, readdir, statfs, writeFile } from "node:fs/promises";
import { openSync, closeSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeUiPlan } from "./native-ui-contract.mjs";

if (process.platform !== "win32") throw new Error("Native UI qualification requires Windows.");
if (!process.env.QRFT_NATIVE_UI_OUTPUT) throw new Error("Provide a new owned output directory.");
const root = resolve(process.env.QRFT_NATIVE_UI_OUTPUT).replaceAll("\\", "/");
const work = fileURLToPath(new URL("../", import.meta.url));
const plan = nativeUiPlan(process.env.QRFT_NATIVE_UI_MIB);
const channel = process.env.QRFT_TEST_BROWSER_CHANNEL;
if (channel !== undefined && !["chrome", "msedge"].includes(channel)) throw new Error("Invalid browser channel.");
await mkdir(root); // Exclusive creation: do not reuse or overwrite prior evidence.
await mkdir(join(root, "temp"));
const hash = async (path) => {
  const h = createHash("sha256"); for await (const bytes of createReadStream(path)) h.update(bytes); return h.digest("hex");
};
const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--",
  "src", "scripts", "tests", "e2e", ".github", "SPEC-native-ui-qualification.md", "release-evidence/original-release-requirements.txt", "release-evidence/acceptance-obligations-2026-10-14.json", "package.json", "package-lock.json", "index.html", ".gitignore", "README.md",
  ".gitattributes", "vite.config.ts", "playwright.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"], { cwd: work, encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/);
const inputs = await Promise.all([...new Set(paths)].sort().map(async path => ({ path, sha256: await hash(join(work, path)) })));
const builtAssets = [];
async function assets(dir, prefix = "dist") {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw new Error("Unexpected built-asset link.");
    const path = `${prefix}/${e.name}`, full = join(dir, e.name);
    if (e.isDirectory()) await assets(full, path);
    else builtAssets.push({ path, sha256: await hash(full) });
  }
}
await assets(join(work, "dist"));
const knownAssets = JSON.parse(await readFile(join(work, "release-evidence/release-gate-latest.json"), "utf8")).currentAssets;
if (knownAssets.length !== builtAssets.length || builtAssets.some(a => !knownAssets.some(k => k.path === a.path && k.sha256 === a.sha256))) {
  await writeFile(join(root, "ASSET-MISMATCH.json"), JSON.stringify({ knownAssets, builtAssets, releaseReady: false }, null, 2) + "\n", { flag: "wx" });
  throw new Error("Compiled assets differ from the current qualified bundle.");
}
const context = { root, stage: work, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8", windowsHide: true }).trim(),
  worktreeStatus: execFileSync("git", ["status", "--short"], { cwd: work, encoding: "utf8", windowsHide: true }),
  node: process.version, runtimeSha256: await hash(process.execPath), plan, inputs, builtAssets,
  scope: "One same-host Windows compiled-app native-file case, with injected file/folder pickers and OPFS saved copy. No physical LAN, native permissions, GUI or general resource/throughput acceptance." };
await writeFile(join(root, "CONTEXT.json"), JSON.stringify(context, null, 2) + "\n", { flag: "wx" });
const resources = [], startedAt = Date.now(), deadline = startedAt + plan.deadlineMs;
let child, timer, busy = false, guardError, killing, log, exit, ended = false;
const persist = () => writeFile(join(root, "PARENT.json"), JSON.stringify({ startedAt, finishedAt: ended ? Date.now() : undefined,
  plan, exit, guardError, resources, releaseReady: false }, null, 2) + "\n");
const stopOwned = () => {
  if (killing || !Number.isSafeInteger(child?.pid) || child.pid < 1 || child.exitCode !== null || child.signalCode !== null) return;
  killing = new Promise(done => { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.once("error", done); killer.once("close", done); });
};
async function sample() {
  if (busy) return; busy = true;
  try { const s = await statfs(root), system = await statfs("C:/"), free = s.bavail * s.bsize, systemFree = system.bavail * system.bsize; resources.push({ at: new Date().toISOString(), free, systemFree });
    if (free < plan.reserveBytes || systemFree < plan.reserveBytes) throw new Error("Native UI disk reserve breached.");
    if (Date.now() >= deadline) throw new Error("Native UI parent deadline exceeded.");
  } catch (error) { guardError ??= String(error); stopOwned(); }
  finally { try { await persist(); } catch (error) { guardError ??= String(error); stopOwned(); } finally { busy = false; } }
}
try {
  const s = await statfs(root), system = await statfs("C:/");
  if (system.bavail * system.bsize < plan.reserveBytes + plan.marginBytes) throw new Error("Insufficient system-drive reserve/margin.");
  if (s.bavail * s.bsize < plan.requiredFreeBytes) throw new Error("Insufficient space for source, received and saved copies plus reserve/margin.");
  log = openSync(join(root, "diagnostic.log"), "wx");
  child = spawn(process.execPath, [join(work, "scripts/qualify-native-ui.mjs")], { cwd: work, windowsHide: true,
    env: { ...process.env, QRFT_NATIVE_UI_OUTPUT: root, QRFT_NATIVE_UI_MIB: String(plan.mib), TEMP: join(root, "temp"), TMP: join(root, "temp"), PATH: dirname(process.execPath) + ";" + process.env.PATH },
    stdio: ["ignore", log, log] });
  const closed = new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
  void closed.catch(() => undefined); // Preserve rejection until awaited, including during the first disk sample.
  await sample(); timer = setInterval(() => void sample(), 1000); exit = await closed;
} catch (error) { guardError ??= String(error); stopOwned(); }
finally {
  clearInterval(timer); while (busy) await new Promise(done => setTimeout(done, 10)); await killing;
  if (log !== undefined) closeSync(log); ended = true; await sample(); await persist();
}
let valid = false;
try {
  const raw = JSON.parse(await readFile(join(root, "evidence/RAW.json"), "utf8"));
  valid = exit?.code === 0 && !guardError && raw.functionalPassed && raw.nativeComplete && raw.sampledReserveMet &&
    raw.plan.fileBytes === plan.fileBytes && raw.plan.smokeOnly === plan.smokeOnly;
} catch { /* Missing/partial child output is retained as a failed attempt. */ }
const metadataFiles = [];
async function inventory(dir, prefix = "") {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${e.name}` : e.name, path = join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error("Unexpected evidence link.");
    if (e.isDirectory() && (relative === "evidence" || relative.startsWith("evidence/"))) await inventory(path, relative);
    else if (e.isFile() && (prefix === "evidence" || prefix.startsWith("evidence/") || !prefix && /\.(json|log)$/.test(e.name))) metadataFiles.push({ path: relative, sha256: await hash(path) });
  }
}
await inventory(root);
await writeFile(join(root, "METADATA-HASHES.json"), JSON.stringify({ files: metadataFiles, payloadsArchived: false,
  valid, smokeOnly: plan.smokeOnly, releaseReady: false }, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ root, valid, smokeOnly: plan.smokeOnly, exit, guardError, resourceSamples: resources.length,
  minimumFreeBytes: Math.min(...resources.map(r => r.free)) }));
process.exitCode = valid ? 0 : 1;
