import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const positiveList = (value, allowed) => {
  const list = value.split(",").map(Number);
  if (!list.length || list.length > 8 || list.some((n) => !Number.isSafeInteger(n) || n < 1 || n > allowed)) throw new Error("Invalid benchmark size/repetition list.");
  return list;
};
const sizes = positiveList(process.env.QRFT_WEBRTC_MIB ?? "10,100", 10240);
const repeats = positiveList(process.env.QRFT_WEBRTC_REPEATS ?? "1", 5);
if (repeats.length !== 1) throw new Error("Use one repetition count.");
const fileCounts = positiveList(process.env.QRFT_WEBRTC_FILES ?? "1", 99_000);
if (fileCounts.length !== 1) throw new Error("Use one file count.");
const fileCount = fileCounts[0];
const modes = (process.env.QRFT_WEBRTC_MODES ?? "raw,transfer").split(",");
if (modes.length > 2 || new Set(modes).size !== modes.length || modes.some((mode) => !["raw", "transfer"].includes(mode))) throw new Error("Invalid benchmark modes.");
const profile = process.env.QRFT_WEBRTC_PROFILE !== "0";
const saveTree = process.env.QRFT_WEBRTC_SAVE_TREE === "1";
const corruptBlock = process.env.QRFT_WEBRTC_CORRUPT_BLOCK === undefined ? null : Number(process.env.QRFT_WEBRTC_CORRUPT_BLOCK);
if (corruptBlock !== null && (!Number.isSafeInteger(corruptBlock) || corruptBlock < 0)) throw new Error("Invalid injected block index.");
const timeoutMs = 30 * 60 * 1000;
const output = resolve(process.env.QRFT_WEBRTC_OUTPUT ?? ".tmp/webrtc-benchmark.json");

// Timed wrappers are confined to this dev server. Production modules on disk
// and the release bundle are unchanged. Record original hashes in every run.
const wrappers = {
  "/src/lib/large-transfer.ts": [["collectLargeDirectory", true, true], ["prepareLargeSource", true, true], ["readPreparedLargeRange", true, true]],
  "/src/lib/webrtc-protocol.ts": [["encodeOfflineDataBlock", false, true], ["decodeOfflineDataBlock", false, true], ["encodeOfflineDataBlockAsync", true, true], ["decodeOfflineDataBlockAsync", true, true]],
  "/src/lib/large-destination.ts": [["writeLargeTreeToDirectory", true, true], ["verifyCompleteDestination", true, false]],
};
const profilingPlugin = {
  name: "benchmark-stage-timers", enforce: "pre",
  transform(code, id) {
    if (!profile) return;
    const definitions = Object.entries(wrappers).find(([suffix]) => id.replaceAll("\\", "/").endsWith(suffix))?.[1];
    if (!definitions) return;
    for (const [name, async, exported] of definitions) {
      const prefix = `${exported ? "export " : ""}${async ? "async " : ""}function ${name}(`;
      if (code.split(prefix).length !== 2) throw new Error(`Benchmark instrumentation no longer matches ${name}.`);
      const renamed = `benchmarkOriginal_${name}`;
      code = code.replace(prefix, `${async ? "async " : ""}function ${renamed}(`);
      code += `\n${exported ? "export " : ""}${async ? "async " : ""}function ${name}(...args: Parameters<typeof ${renamed}>) {\n` +
        `const start = performance.now(); try { return ${async ? "await " : ""}${renamed}(...args); }\n` +
        `finally { (globalThis as any).__qrftBenchmarkRecord?.(${JSON.stringify(name)}, performance.now() - start); } }\n`;
    }
    return { code, map: null };
  },
};

async function fingerprints() {
  const paths = ["package.json", "package-lock.json"];
  async function walk(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  await walk("src"); await walk("scripts");
  return Promise.all(paths.sort().map(async (path) => ({ path, sha256: createHash("sha256").update(await readFile(resolve(root, path))).digest("hex") })));
}
function layout(bytes) {
  const empty = fileCount === 1 ? 0 : Math.ceil(fileCount / 10);
  let remainingBytes = bytes, remainingFiles = fileCount - empty;
  const directories = new Set();
  const files = Array.from({ length: fileCount }, (_, index) => {
    const size = fileCount > 1 && index % 10 === 0 ? 0 : Math.floor(remainingBytes / remainingFiles);
    if (!(fileCount > 1 && index % 10 === 0)) { remainingBytes -= size; remainingFiles--; }
    const name = `file-${String(index).padStart(6, "0")}.bin`;
    const directory = `group-${String(Math.floor(index / 100)).padStart(4, "0")}`;
    if (fileCount > 1) directories.add(directory);
    return { path: fileCount === 1 ? name : `${directory}/${name}`, size, index };
  });
  if (remainingBytes || remainingFiles || files.length + directories.size > 100_000) throw new Error("Invalid synthetic file layout.");
  return { files, directories: [...directories] };
}
const call = (page, method, value) => page.evaluate(async ({ method, value }) => {
  const module = await import("/scripts/benchmark-webrtc-page.mjs");
  return module[method](value);
}, { method, value });
const stringifyError = (error) => `${error.name ?? "Error"}: ${error.message ?? String(error)}`;
async function bounded(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function removeProfile(path) {
  const target = await realpath(path), parent = await realpath(tmpdir());
  if (dirname(target) !== parent || !basename(target).startsWith("qrft-webrtc-bench-")) throw new Error("Unexpected benchmark profile path.");
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
async function metrics(endpoint) {
  return { main: (await endpoint.cdp.send("Performance.getMetrics")).metrics,
    processes: (await endpoint.browserCdp.send("SystemInfo.getProcessInfo")).processInfo };
}
function cpuDelta(before, after) {
  const value = (report, key) => report.main.find((entry) => entry.name === key)?.value ?? null;
  const delta = (key) => value(before, key) === null || value(after, key) === null ? null : value(after, key) - value(before, key);
  const beforeMap = new Map(before.processes.map((entry) => [entry.id, entry]));
  const afterIds = new Set(after.processes.map((entry) => entry.id));
  return { mainThreadTaskSeconds: delta("TaskDuration"), mainThreadScriptSeconds: delta("ScriptDuration"),
    observedProcessCpuSeconds: after.processes.reduce((sum, entry) => sum + Math.max(0, entry.cpuTime - (beforeMap.get(entry.id)?.cpuTime ?? 0)), 0),
    exitedProcessCount: before.processes.filter((entry) => !afterIds.has(entry.id)).length,
    note: "CPU sums observed browser processes across their threads; CPU from processes that exited between snapshots is unavailable. Timing excludes launch/module import and includes preparation, transfer and verification." };
}

const evidence = { schema: "qrft-webrtc-benchmark-v1", startedAt: new Date().toISOString(), node: process.version,
  scope: "Two separate temporary normal Chromium processes on one Windows host; synthetic source slices and OPFS destination. Direct harness SDP exchange, not application pairing, human authorization, physical LAN, source disk or native destination validation.",
  profile, saveTree, corruptBlock, sizesMiB: sizes, fileCount, modes, repeats: repeats[0],
  rawBaseline: "Same ordered channel, 60 KiB payload plus 44 bytes, 96-block window, 8/2 MiB buffering thresholds and production 64-block/75 ms receive queue; pattern check and batched ACKs, no hashing/source reads/OPFS durability.",
  inputs: await fingerprints(), results: [], releaseReady: false };
const persist = async () => {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
};
// configFile:false avoids LAN discovery, app hooks and unrelated development UI.
const server = await createServer({ root, configFile: false, plugins: [profilingPlugin], appType: "custom",
  server: { host: "127.0.0.1", port: 0, open: false, hmr: false } });
server.middlewares.use((request, response, next) => {
  if (request.url !== "/benchmark") return next();
  response.setHeader("Content-Type", "text/html");
  response.end('<!doctype html><html><head><title>WebRTC benchmark</title><link rel="icon" href="data:,"></head><body>Local development benchmark</body></html>');
});
try {
  await server.listen();
  await persist();
  for (const mib of sizes) for (let repetition = 1; repetition <= repeats[0]; repetition++) {
    // Alternate mode order across repetitions to make order visible and reduce systematic bias.
    for (const mode of repetition % 2 ? modes : modes.toReversed()) {
      const endpoints = [], errors = [];
      const record = { mib, repetition, mode, profile, saveTree: mode === "transfer" && saveTree,
        startedAt: new Date().toISOString(), verified: false };
      evidence.results.push(record);
      let deadline;
      try {
        for (const role of ["sender", "receiver"]) {
          const profilePath = await mkdtemp(join(tmpdir(), "qrft-webrtc-bench-"));
          const endpoint = { role, profilePath };
          endpoints.push(endpoint);
          endpoint.context = await chromium.launchPersistentContext(profilePath, { headless: true, args: ["--enable-precise-memory-info"] });
          endpoint.page = await endpoint.context.newPage();
          endpoint.page.setDefaultTimeout(timeoutMs);
          endpoint.page.on("pageerror", (error) => errors.push(`${role}: ${stringifyError(error)}`));
          endpoint.page.on("console", (message) => {
            if (message.type() === "error") errors.push(`${role}: ${message.text()}`);
            if (message.text().startsWith("benchmark-progress")) console.log(message.text());
          });
          await endpoint.page.goto(server.resolvedUrls.local[0] + "benchmark");
          await endpoint.page.evaluate(() => import("/scripts/benchmark-webrtc-page.mjs").then(() => undefined));
          endpoint.cdp = await endpoint.context.newCDPSession(endpoint.page);
          endpoint.browserCdp = await endpoint.context.browser().newBrowserCDPSession();
          await endpoint.cdp.send("Performance.enable");
          endpoint.before = await metrics(endpoint);
        }
        const [sender, receiver] = endpoints;
        const options = { mode, bytes: mib * 1024 * 1024, layout: layout(mib * 1024 * 1024), profile, saveTree, timeoutMs, corruptBlock };
        const execute = async () => {
          const prepared = await call(sender.page, "setupSender", options);
          record.streamBytes = prepared.manifest?.totalBytes ?? options.bytes;
          record.blockSize = prepared.blockSize;
          record.dataHeaderBytes = prepared.dataHeaderBytes;
          await call(receiver.page, "setupReceiver", { ...options, manifest: prepared.manifest });
          const offer = await call(sender.page, "offer");
          const answer = await call(receiver.page, "answer", offer);
          await call(sender.page, "acceptAnswer", answer);
          await call(sender.page, "transmit");
          [record.sender, record.receiver] = await Promise.all(endpoints.map((entry) => call(entry.page, "result")));
          for (const entry of endpoints) record[entry.role].cpu = cpuDelta(entry.before, await metrics(entry));
          record.verified = record.sender.verified && record.receiver.verified && errors.length === 0;
          if (mode === "transfer" && (!record.receiver.streamVerified || (saveTree && !record.receiver.destinationVerified))) record.verified = false;
          if (record.verified) {
            const blocks = Math.ceil(record.streamBytes / record.blockSize);
            if (record.sender.binaryBytes !== record.receiver.binaryBytes || record.sender.binaryMessages !== record.receiver.binaryMessages ||
              record.receiver.receivedBytes !== record.streamBytes) throw new Error("Benchmark sender/receiver byte accounting disagrees.");
            if (record.sender.binaryBytes !== record.streamBytes + blocks * record.dataHeaderBytes || record.receiver.ackIndices !== blocks) {
              throw new Error("Benchmark durable ACK/frame accounting disagrees.");
            }
            record.accountingValidated = true;
          }
          if (mode === "transfer" && corruptBlock !== null && !record.sender.corruptionInjected) throw new Error("Requested corruption was never injected.");
          record.transferMBps = record.verified ? record.streamBytes / (mode === "raw" ? record.sender.confirmedMs : record.sender.transferMs) / 1000 : null;
          if (!Number.isFinite(record.transferMBps) || record.transferMBps <= 0) record.verified = false;
        };
        const timeout = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Node benchmark trial deadline exceeded.")), timeoutMs + 30_000); });
        await Promise.race([execute(), timeout]);
      } catch (error) { record.error = stringifyError(error); }
      finally {
        clearTimeout(deadline);
        record.browserErrors = errors;
        record.cleanupErrors = [];
        // Preserve partial/failing evidence before attempting resource cleanup.
        await persist();
        for (const endpoint of endpoints) {
          try { if (endpoint.page) await bounded(call(endpoint.page, "cleanup"), 10_000, "Browser store cleanup"); }
          catch (error) { record.cleanupErrors.push(`${endpoint.role}: ${stringifyError(error)}`); }
          let closed = !endpoint.context;
          try { await bounded(Promise.resolve(endpoint.context?.close()), 30_000, "Browser shutdown"); closed = true; }
          catch (error) { record.cleanupErrors.push(`${endpoint.role}: ${stringifyError(error)}`); }
          try { if (closed) await removeProfile(endpoint.profilePath); }
          catch (error) { record.cleanupErrors.push(`${endpoint.role} profile: ${stringifyError(error)}`); }
        }
        record.completedAt = new Date().toISOString();
        record.passed = record.verified && !record.error && !record.cleanupErrors.length && !record.browserErrors.length;
        if (!record.passed) process.exitCode = 1;
        await persist();
        console.log(JSON.stringify({ mib, mode, repetition, passed: record.passed, MBps: record.transferMBps,
          error: record.error ?? record.sender?.error ?? record.receiver?.error, cleanupErrors: record.cleanupErrors }));
      }
    }
  }
} catch (error) { evidence.error = stringifyError(error); process.exitCode = 1; }
finally {
  await server.close();
  evidence.inputsUnchanged = JSON.stringify(evidence.inputs) === JSON.stringify(await fingerprints());
  if (!evidence.inputsUnchanged) process.exitCode = 1;
  evidence.finishedAt = new Date().toISOString();
  await persist();
}
