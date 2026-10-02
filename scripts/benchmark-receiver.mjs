import { mkdir, writeFile, mkdtemp, rm, realpath } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import { benchmarkResultPassed } from "./benchmark-result.mjs";

// Development-only harness: do not start LAN discovery during a storage bench.
process.env.VITEST = "1";
const { createServer } = await import("vite");
const sizes = (process.env.QRFT_BENCH_MIB ?? "10,100").split(",").map(Number);
const batches = (process.env.QRFT_BENCH_BATCHES ?? "1").split(",").map(Number);
const fileCount = Number(process.env.QRFT_BENCH_FILES ?? "1");
if (!Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount + (fileCount === 1 ? 0 : Math.ceil(fileCount / 100)) > 100_000) throw new Error("Invalid benchmark file count (including generated directories).");
if (sizes.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 10240) ||
    batches.some((n) => ![1, 16, 32, 64, 128].includes(n))) throw new Error("Invalid benchmark sizes/batches.");
const output = resolve(process.env.QRFT_BENCH_OUTPUT ?? ".tmp/receiver-benchmark.json");
const persistent = process.env.QRFT_BENCH_PERSISTENT === "1";
const storageProbe = process.env.QRFT_BENCH_STORAGE_PROBE === "1";
const saveTree = process.env.QRFT_BENCH_SAVE_TREE === "1";
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false, hmr: false } });
await server.listen();
const browser = persistent ? null : await chromium.launch({ args: ["--enable-precise-memory-info"] });
const results = [];
try {
  for (const mib of sizes) for (const batchBlocks of batches) {
    const profile = persistent ? await mkdtemp(join(tmpdir(), "qrft-bench-profile-")) : null;
    const context = persistent
      ? await chromium.launchPersistentContext(profile, { args: ["--enable-precise-memory-info"] })
      : await browser.newContext();
    try {
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.text().startsWith("benchmark-progress")) console.log(message.text());
    });
    await page.goto(server.resolvedUrls.local[0]);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const metricsBefore = (await cdp.send("Performance.getMetrics")).metrics;
    const result = await page.evaluate(async ({ mib, batchBlocks, storageProbe, fileCount, saveTree }) => {
      const { OfflineDestinationReceiver } = await import("/src/lib/webrtc-transfer.ts");
      const { openBlockStore } = await import("/src/lib/block-store.ts");
      const { prepareLargeSource, readPreparedLargeRange, readLargeTreeManifest } = await import("/src/lib/large-transfer.ts");
      const { writeLargeTreeToDirectory } = await import("/src/lib/large-destination.ts");
      const { createOfflineTransferManifest, encodeOfflineDataBlock } = await import("/src/lib/webrtc-protocol.ts");
      // No full-size fixture buffer: synthesize only the slices requested by
      // the real preparation/read path. This measures CPU/protocol/storage,
      // not physical source disk or Wi-Fi throughput.
      const size = mib * 1024 * 1024;
      const quotaBefore = await navigator.storage.estimate();
      if (storageProbe) {
        const store = await openBlockStore({ storeId: "benchmark-quota-probe", totalBytes: size, blockSize: 60 * 1024 });
        const payload = new Uint8Array(60 * 1024);
        const outcome = { mib, batchBlocks, mode: "OPFS-only quota probe", quotaBefore };
        try {
          for (let index = 0; index < store.totalBlocks;) {
            const blocks = [];
            for (let count = 0; count < batchBlocks && index < store.totalBlocks; count += 1, index += 1) {
              blocks.push({ index, bytes: payload.subarray(0, Math.min(payload.length, size - index * payload.length)) });
            }
            await store.writeBlocks(blocks);
          }
          outcome.verified = false;
          outcome.writtenBytes = store.progress().receivedBytes;
        } catch (error) {
          outcome.error = `${error.name}: ${error.message}`;
          outcome.writtenBytes = store.progress().receivedBytes;
          outcome.quotaAfter = await navigator.storage.estimate();
        } finally {
          try { await store.delete(); } catch (error) { outcome.cleanupError = error.message; await store.close(); }
        }
        return outcome;
      }
      const emptyFiles = fileCount === 1 ? 0 : Math.ceil(fileCount / 10);
      const nonemptyFiles = fileCount - emptyFiles;
      const directories = new Set();
      let remaining = size;
      let nonemptyRemaining = nonemptyFiles;
      const files = Array.from({ length: fileCount }, (_, index) => {
        const empty = fileCount > 1 && index % 10 === 0;
        const bytes = empty ? 0 : Math.floor(remaining / nonemptyRemaining);
        if (!empty) { remaining -= bytes; nonemptyRemaining--; }
        const name = fileCount === 1 ? "synthetic.bin" : `file-${String(index).padStart(6, "0")}.bin`;
        const directory = `group-${String(Math.floor(index / 100)).padStart(4, "0")}`;
        if (fileCount > 1) directories.add(directory);
        const file = { name, size: bytes, lastModified: 7,
          slice: (start, end) => {
            const data = new Uint8Array(end - start);
            if (saveTree) for (let offset = 0; offset < data.length; offset++) {
              const position = start + offset;
              data[offset] = (index >>> ((position % 4) * 8)) ^ (position * 31);
            }
            return new Blob([data]);
          } };
        return { path: fileCount === 1 ? name : `${directory}/${name}`, size: bytes, lastModified: 7, handle: { getFile: async () => file } };
      });
      if (remaining !== 0) throw new Error("Synthetic source byte accounting failed.");
      const selection = { rootName: "benchmark", directories: [...directories], totalFileBytes: BigInt(size),
        rootHandle: { kind: "directory", name: "benchmark" }, files };
      const startPrepare = performance.now();
      let reported = 0;
      const report = (phase, completed) => {
        if (completed - reported >= 128 * 1024 * 1024) {
          reported = completed;
          console.log(`benchmark-progress ${mib}MiB batch=${batchBlocks} ${phase} ${Math.floor(completed / 1024 / 1024)}MiB`);
        }
      };
      const source = await prepareLargeSource(selection, (progress) => report("prepare", Number(progress.bytesComplete)));
      const prepareMs = performance.now() - startPrepare;
      const manifest = await createOfflineTransferManifest(source);
      const counts = { payloadWrites: 0, payloadFlushes: 0, journalCommits: 0, ackGroups: 0 };
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message, ...args) {
        if (message.type === "write-payload") counts.payloadWrites += 1;
        if (message.type === "flush-payload") counts.payloadFlushes += 1;
        if (message.type === "append-journal") counts.journalCommits += 1;
        return postMessage.call(this, message, ...args);
      };
      const receiver = await OfflineDestinationReceiver.open(manifest, { requestPersistence: false });
      let sourceReadMs = 0;
      let encodeMs = 0;
      let acceptMs = 0;
      let peakJsHeap = performance.memory?.usedJSHeapSize ?? null;
      const startTransfer = performance.now();
      reported = 0;
      const outcome = { mib, batchBlocks, fileCount, emptyFiles, directoryCount: directories.size,
        metadataBytes: source.metadataBytes.byteLength, quotaBefore,
        fixture: saveTree ? "file-index and offset pattern" : "zero bytes" };
      try {
        for (let index = 0; index < receiver.store.totalBlocks;) {
          const values = [];
          for (let count = 0; count < batchBlocks && index < receiver.store.totalBlocks; count += 1, index += 1) {
            const offset = index * manifest.blockSize;
            let start = performance.now();
            const payload = await readPreparedLargeRange(source, BigInt(offset), Math.min(manifest.blockSize, manifest.totalBytes - offset));
            sourceReadMs += performance.now() - start;
            start = performance.now();
            values.push(encodeOfflineDataBlock(index, payload).buffer);
            encodeMs += performance.now() - start;
          }
          const start = performance.now();
          if (batchBlocks === 1) await receiver.acceptData(values[0]);
          else await receiver.acceptBatch(values);
          acceptMs += performance.now() - start;
          counts.ackGroups += 1;
          report("receive", Math.min(index * manifest.blockSize, manifest.totalBytes));
          if (performance.memory) peakJsHeap = Math.max(peakJsHeap ?? 0, performance.memory.usedJSHeapSize);
        }
        const transferMs = performance.now() - startTransfer;
        const verifyStart = performance.now();
        reported = 0;
        const reader = await receiver.verify(new AbortController().signal, (completed) => report("verify", completed));
        const verifyMs = performance.now() - verifyStart;
        if (saveTree) {
          const destinationStart = performance.now();
          const tree = await readLargeTreeManifest(reader);
          const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle("benchmark-destination", { create: true });
          const fromHex = (value) => Uint8Array.from(value.match(/../g), (pair) => parseInt(pair, 16));
          const operations = {};
          const measure = async (key, invoke) => {
            const start = performance.now();
            try { return await invoke(); } finally {
              const item = operations[key] ??= { calls: 0, ms: 0 };
              item.calls++;
              item.ms += performance.now() - start;
            }
          };
          const originalDirectory = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
          const originalFileHandle = FileSystemDirectoryHandle.prototype.getFileHandle;
          const originalFile = FileSystemFileHandle.prototype.getFile;
          FileSystemDirectoryHandle.prototype.getDirectoryHandle = function(...args) {
            return measure("directory.getDirectoryHandle", () => originalDirectory.apply(this, args));
          };
          FileSystemDirectoryHandle.prototype.getFileHandle = function(...args) {
            const kind = args[0] === ".airgap-qr-v3.partial.json" ? "journal" : "file";
            return measure(`${kind}.getFileHandle`, () => originalFileHandle.apply(this, args));
          };
          FileSystemFileHandle.prototype.getFile = function(...args) {
            const kind = this.name === ".airgap-qr-v3.partial.json" ? "journal" : "file";
            return measure(`${kind}.getFile`, () => originalFile.apply(this, args));
          };
          const originalCreate = FileSystemFileHandle.prototype.createWritable;
          FileSystemFileHandle.prototype.createWritable = async function(...args) {
            const kind = this.name === ".airgap-qr-v3.partial.json" ? "journal" : "file";
            const stream = await measure(`${kind}.createWritable`, () => originalCreate.apply(this, args));
            return Object.fromEntries(["write", "close", "abort"].map((method) => [method,
              (...values) => measure(`${kind}.${method}`, () => stream[method](...values))]));
          };
          let saved;
          let finalVerifyStarted;
          try {
          saved = await writeLargeTreeToDirectory(tree, reader,
            { transferId: fromHex(manifest.transferId), streamSha256: fromHex(manifest.streamSha256) }, parent,
            { onProgress: (progress) => {
              if (progress.phase === "verify") finalVerifyStarted ??= performance.now();
              if (progress.phase === "write" && progress.filesComplete > 0 && progress.filesComplete % 1000 === 0) {
                console.log(`benchmark-progress destination ${progress.filesComplete}/${fileCount} files`);
              }
            } });
          } finally {
            FileSystemFileHandle.prototype.createWritable = originalCreate;
            FileSystemDirectoryHandle.prototype.getDirectoryHandle = originalDirectory;
            FileSystemDirectoryHandle.prototype.getFileHandle = originalFileHandle;
            FileSystemFileHandle.prototype.getFile = originalFile;
            outcome.destinationOperations = operations;
          }
          outcome.destinationSaveMs = performance.now() - destinationStart;
          outcome.destinationFinalVerifyMs = finalVerifyStarted === undefined ? null : performance.now() - finalVerifyStarted;
          const auditStart = performance.now();
          const root = await parent.getDirectoryHandle("benchmark");
          const expected = new Map(files.map((file, index) => [file.path, { size: file.size, index }]));
          const expectedDirectories = new Set(directories);
          let checkedFiles = 0;
          let checkedBytes = 0;
          const walk = async (directory, prefix = "") => {
            for await (const [name, handle] of directory.entries()) {
              const path = prefix + name;
              if (handle.kind === "directory") {
                if (!expectedDirectories.delete(path)) throw new Error(`Unexpected destination directory: ${path}`);
                await walk(handle, `${path}/`);
              } else {
                const wanted = expected.get(path);
                if (!wanted) throw new Error(`Unexpected destination file: ${path}`);
                const file = await handle.getFile();
                if (file.size !== wanted.size) throw new Error(`Destination size mismatch: ${path}`);
                for (let start = 0; start < file.size; start += 1024 * 1024) {
                  const data = new Uint8Array(await file.slice(start, Math.min(file.size, start + 1024 * 1024)).arrayBuffer());
                  for (let offset = 0; offset < data.length; offset++) {
                    const position = start + offset;
                    const wantedByte = ((wanted.index >>> ((position % 4) * 8)) ^ (position * 31)) & 255;
                    if (data[offset] !== wantedByte) throw new Error(`Destination content mismatch: ${path} at ${position}`);
                  }
                }
                expected.delete(path);
                checkedFiles++;
                checkedBytes += file.size;
                if (checkedFiles % 1000 === 0) console.log(`benchmark-progress destination-audit ${checkedFiles}/${fileCount} files`);
              }
            }
          };
          await walk(root);
          if (expected.size || expectedDirectories.size || checkedBytes !== size) throw new Error("Destination tree is incomplete.");
          outcome.destination = { verified: true, checkedFiles, checkedBytes,
            filesWritten: saved.filesWritten, directoriesVerified: saved.directoriesVerified,
            independentAuditMs: performance.now() - auditStart };
          await (await navigator.storage.getDirectory()).removeEntry("benchmark-destination", { recursive: true });
        }
        return Object.assign(outcome, { verified: true, bytes: manifest.totalBytes, prepareMs, sourceReadMs, encodeMs, acceptMs,
          transferMs, verifyMs, transferMBps: manifest.totalBytes / transferMs / 1000,
          counts, peakJsHeap, userAgent: navigator.userAgent });
      } catch (error) {
        return Object.assign(outcome, { verified: false, error: `${error.name}: ${error.message}`,
          receivedBytes: receiver.store.progress().receivedBytes, counts,
          quotaAfter: await navigator.storage.estimate(), peakJsHeap });
      } finally {
        try { await receiver.store.delete(); } catch (error) {
          outcome.cleanupError = error.message;
          await receiver.store.close();
        }
        Worker.prototype.postMessage = postMessage;
      }
    }, { mib, batchBlocks, storageProbe, fileCount, saveTree });
    result.context = persistent ? "temporary persistent profile" : "incognito";
    const metricsAfter = (await cdp.send("Performance.getMetrics")).metrics;
    const metric = (metrics, name) => metrics.find((entry) => entry.name === name)?.value ?? 0;
    result.mainThreadTaskSeconds = metric(metricsAfter, "TaskDuration") - metric(metricsBefore, "TaskDuration");
    result.mainThreadScriptSeconds = metric(metricsAfter, "ScriptDuration") - metric(metricsBefore, "ScriptDuration");
    if (!benchmarkResultPassed(result)) process.exitCode = 1;
    results.push(result);
    console.log(JSON.stringify(result));
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
    } finally {
      await context.close();
      if (profile) {
        const target = await realpath(profile);
        const parent = await realpath(tmpdir());
        if (dirname(target) !== parent || !basename(target).startsWith("qrft-bench-profile-")) throw new Error("Unexpected benchmark profile path.");
        // Chromium may briefly retain its debug log after context.close on Windows.
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
