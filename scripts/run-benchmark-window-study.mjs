// Controlled development experiment. No product default or acceptance threshold changes.
import { mkdir, mkdtemp, readFile, statfs, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { benchmarkWindowCases } from "./benchmark-window.mjs";

if (process.platform !== "win32") throw new Error("This study requires Windows.");
const work = fileURLToPath(new URL("../", import.meta.url));
const root = process.env.QRFT_WINDOW_STUDY_OUTPUT ? resolve(process.env.QRFT_WINDOW_STUDY_OUTPUT) : await mkdtemp(join(tmpdir(), "qrft-window-study-"));
if (process.env.QRFT_WINDOW_STUDY_OUTPUT) await mkdir(root); // Never overwrite prior evidence.
const temp = join(root, "temp"); await mkdir(temp);
const reserve = 2 * 1024 ** 3, deadline = Date.now() + 15 * 60_000;
const evidence = { startedAt: new Date().toISOString(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8", windowsHide: true }).trim(),
  node: process.version, os: release(), cpu: cpus()[0]?.model, logicalProcessors: cpus().length, totalMemoryBytes: totalmem(),
  planned: benchmarkWindowCases(), cases: [], resources: [], reserveBytes: reserve,
  scope: "Hosted/same-host Windows synthetic100MiB one-file raw/verified study. Four repetitions balance window/mode order. Each case uses fresh Vite and two Chromium processes; source override is in-memory and hashed. Hashing/durable ACK/stream and destination audits retained. Profile and native-memory observers off. No production tuning, native disk/picker, physical LAN, general memory or performance acceptance.",
  performanceAccepted: false, releaseReady: false };
const persist = () => writeFile(join(root, "STUDY.json"), JSON.stringify(evidence, null, 2) + "\n");
const freeBytes = async () => { const fs = await statfs(root); return fs.bavail * fs.bsize; };
let commonOriginal, commonInputs;
try {
  await persist();
  for (const planned of evidence.planned) {
    assert(await freeBytes() >= reserve + 512 * 1024 ** 2 + 2 * 100 * 1024 ** 2, "Insufficient disk headroom");
    assert(Date.now() < deadline, "Study deadline exceeded");
    const rawPath = join(root, planned.id + ".json"), log = openSync(join(root, planned.id + ".log"), "wx");
    const record = { ...planned, startedAt: new Date().toISOString(), diagnosticValid: false }; evidence.cases.push(record); await persist();
    let child, timer, busy = false, guardError, killing;
    const stopOwned = () => {
      if (!killing && Number.isSafeInteger(child?.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null) killing = new Promise((done) => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", done); killer.once("close", done);
      });
    };
    const sample = async () => {
      if (busy) return; busy = true;
      try { const free = await freeBytes(); evidence.resources.push({ at: new Date().toISOString(), case: planned.id, free });
        if (free < reserve) throw new Error("Disk reserve breached");
        if (Date.now() >= deadline) throw new Error("Study deadline exceeded");
      } catch (error) { guardError = String(error); stopOwned(); } finally { busy = false; }
    };
    try {
      const env = { ...process.env, TEMP: temp, TMP: temp, DEBUG: "pw:browser", QRFT_WEBRTC_MIB: "100", QRFT_WEBRTC_REPEATS: "1", QRFT_WEBRTC_FILES: "1",
        QRFT_WEBRTC_MODES: planned.mode, QRFT_WEBRTC_IN_FLIGHT_BLOCKS: String(planned.blocks), QRFT_WEBRTC_PROFILE: "0", QRFT_WEBRTC_NATIVE_HASHES: "1",
        QRFT_WEBRTC_SAVE_TREE: "1", QRFT_WEBRTC_PROCESS_MEMORY: "0", QRFT_WEBRTC_OUTPUT: rawPath };
      delete env.QRFT_WEBRTC_CORRUPT_BLOCK;
      child = spawn(process.execPath, [join(work, "scripts/benchmark-webrtc.mjs")], { cwd: work, env, windowsHide: true, stdio: ["ignore", log, log] });
      const closed = new Promise((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
      await sample(); timer = setInterval(() => void sample(), 1000);
      const exit = await closed; record.exit = exit; clearInterval(timer);
      while (busy) await new Promise((done) => setTimeout(done, 10)); await sample(); await killing;
      assert.equal(guardError, undefined, guardError); assert.equal(exit.code, 0); assert.equal(exit.signal, null);
      const raw = JSON.parse(await readFile(rawPath, "utf8")); assert.equal(raw.inputsUnchanged, true); assert.equal(raw.maxInFlightBlocks, planned.blocks);
      assert.equal(raw.profile, false); assert.equal(raw.nativeHashes, true); assert.equal(raw.saveTree, true); assert.equal(raw.processMemory, false); assert.equal(raw.results.length, 1);
      const trial = raw.results[0]; assert.equal(trial.mode, planned.mode); assert.equal(trial.passed, true); assert.equal(trial.accountingValidated, true);
      assert.equal(trial.senderWindowTransform.blocks, planned.blocks);
      const transform = trial.senderWindowTransform; if (commonOriginal) assert.equal(transform.originalSha256, commonOriginal); else commonOriginal = transform.originalSha256;
      if (planned.blocks === 96) assert.equal(transform.originalSha256, transform.transformedSha256); else assert.notEqual(transform.originalSha256, transform.transformedSha256);
      if (commonInputs) assert.deepEqual(raw.inputs, commonInputs); else commonInputs = raw.inputs;
      const count = Math.ceil(trial.streamBytes / trial.blockSize); assert.equal(trial.receiver.ackIndices, count);
      assert.equal(trial.sender.binaryBytes, trial.streamBytes + 44 * count); assert.equal(trial.receiver.binaryBytes, trial.sender.binaryBytes);
      if (planned.mode === "transfer") { assert(trial.receiver.streamVerified && trial.receiver.destinationVerified); assert.equal(trial.receiver.destinationCheckedBytes, 100 * 1024 ** 2); }
      const counters = {};
      for (const endpoint of [trial.sender, trial.receiver]) {
        assert(!endpoint.transportStatsError); assert(endpoint.timeline.some((e) => e.event === "finished"));
        const pair = endpoint.transportStats.candidatePairs.find((p) => p.selected); assert(pair); assert(Number.isSafeInteger(pair.packetsDiscardedOnSend));
        const channel = endpoint.transportStats.dataChannels[0]; assert(channel);
        assert.equal(channel.bytesSent, (endpoint.role === "sender" ? endpoint.binaryBytes : 0) + Object.values(endpoint.controls).reduce((sum, c) => sum + c.bytes, 0));
        counters[endpoint.role] = { packetsDiscardedOnSend: pair.packetsDiscardedOnSend, bytesDiscardedOnSend: pair.bytesDiscardedOnSend, roundTripSeconds: pair.currentRoundTripTime };
      }
      record.MBps = trial.transferMBps; record.counters = counters; record.senderWindowTransform = transform; record.diagnosticValid = true;
      console.log(JSON.stringify(record));
    } catch (error) { record.error = String(error); throw error; }
    finally { clearInterval(timer); while (busy) await new Promise((done) => setTimeout(done, 10)); await killing; closeSync(log); record.completedAt = new Date().toISOString(); await persist(); }
  }
  evidence.diagnosticComplete = evidence.cases.length === 16 && evidence.cases.every((c) => c.diagnosticValid);
} catch (error) { evidence.error = String(error); process.exitCode = 1; }
finally { evidence.finishedAt = new Date().toISOString(); await persist(); }
