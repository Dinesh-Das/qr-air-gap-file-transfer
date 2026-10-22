// Development-only browser half of benchmark-webrtc.mjs. Never imported by the app.
import { collectLargeDirectory, prepareLargeSource, readLargeTreeManifest } from "../src/lib/large-transfer.ts";
import { writeLargeTreeToDirectory } from "../src/lib/large-destination.ts";
import { OfflineSourceSender, OfflineDestinationReceiver } from "../src/lib/webrtc-transfer.ts";
import { DurableReceiveQueue } from "../src/lib/webrtc-receive-queue.ts";
import { OFFLINE_BLOCK_BYTES, OFFLINE_DATA_HEADER_BYTES, createOfflineTransferManifest, decodeOfflineControl, encodeOfflineControl } from "../src/lib/webrtc-protocol.ts";
import { waitForIceGatheringComplete, limitSdpToLocalCandidates } from "../src/lib/webrtc-signaling.ts";
import { connectionPath } from "../src/lib/connection-path.ts";
import { createBenchmarkPatternReader } from "./benchmark-pattern.mjs";
import { benchmarkTransportSnapshot } from "./benchmark-transport.mjs";

let state;
function markEvent(event) {
  if (state.timeline.length >= 24) throw new Error("Unexpected benchmark phase count.");
  state.timeline.push({ event, epochMs: Date.now(), monotonicMs: performance.now() });
}
function phase(value) { state.phase = value; markEvent(value); }
const rawValue = 37;
const metric = (key, ms, bytes = 0) => {
  const item = state.operations[key] ??= { calls: 0, ms: 0, bytes: 0 };
  item.calls++;
  item.ms += ms;
  item.bytes += bytes;
};
const sampleHeap = () => {
  const value = performance.memory?.usedJSHeapSize;
  if (Number.isFinite(value)) {
    state.peakJsHeapBytes = Math.max(state.peakJsHeapBytes ?? 0, value);
    const phase = state.heapByPhase[state.phase] ??= { peakBytes: 0, lastBytes: 0, samples: 0 };
    phase.peakBytes = Math.max(phase.peakBytes, value);
    phase.lastBytes = value;
    phase.samples++;
  }
};
const errorText = (error) => `${error.name ?? "Error"}: ${error.message ?? String(error)}`;

function init(options, role) {
  if (state) throw new Error("Each benchmark page may run only one trial.");
  state = { ...options, role, operations: {}, controls: {}, heapByPhase: {}, binaryMessages: 0, binaryBytes: 0,
    peakChannelBufferedBytes: 0, peakJsHeapBytes: null, phase: "setup", receivedBytes: 0,
    controller: new AbortController(), startedAt: performance.now(), verified: false, finished: false, timeline: [] };
  markEvent("setup");
  state.rawAcknowledged = 0;
  state.rawNextIndex = 0;
  // Only counters are retained. No per-message, per-block or per-sample history.
  globalThis.__qrftBenchmarkRecord = (name, ms) => metric(`${state.phase}.${name}`, ms);
  state.result = new Promise((resolve) => { state.resolve = resolve; });
  state.peer = new RTCPeerConnection({ iceServers: [] });
  state.peer.addEventListener("connectionstatechange", () => {
    if (state.peer.connectionState === "failed") fail(new Error("Benchmark WebRTC connection failed."));
  });
  state.heapTimer = setInterval(sampleHeap, 100);
  sampleHeap();
  state.deadline = setTimeout(() => fail(new Error("Benchmark trial deadline exceeded.")), options.timeoutMs);
  state.nextReport = 128 * 1024 * 1024;
}

function report(bytes) {
  if (bytes >= state.nextReport) {
    console.log(`benchmark-progress ${state.role} ${state.mode} ${state.phase} ${Math.floor(bytes / 1024 / 1024)} MiB`);
    state.nextReport = bytes + 128 * 1024 * 1024;
  }
}

function finish(error) {
  if (state.finished) return;
  state.finished = true;
  if (error) state.error = errorText(error);
  clearTimeout(state.deadline);
  clearInterval(state.heapTimer);
  sampleHeap();
  state.elapsedMs = performance.now() - state.startedAt;
  markEvent(error ? "failed" : "finished");
  state.resolve();
}

function fail(error) {
  if (state.finished) return;
  state.controller.abort(error);
  state.sender?.fail(error);
  finish(error);
  state.channel?.close();
}

function bindChannel(channel) {
  state.channel = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 2 * 1024 * 1024;
  const nativeSend = channel.send.bind(channel);
  channel.send = (data) => {
    if (typeof data === "string") {
      const type = JSON.parse(data).type;
      const item = state.controls[type] ??= { messages: 0, bytes: 0 };
      item.messages++;
      item.bytes += new TextEncoder().encode(data).byteLength;
    } else {
      if (state.corruptBlock !== null && state.binaryMessages === state.corruptBlock && state.mode === "transfer") {
        data = data.slice(0);
        new Uint8Array(data)[OFFLINE_DATA_HEADER_BYTES] ^= 1;
        state.corruptionInjected = true;
      }
      state.binaryMessages++;
      state.binaryBytes += data.byteLength;
    }
    const start = performance.now();
    nativeSend(data);
    metric("channel.send", performance.now() - start);
    state.peakChannelBufferedBytes = Math.max(state.peakChannelBufferedBytes, channel.bufferedAmount);
  };
  channel.addEventListener("error", () => fail(new Error("Benchmark data channel error.")));
  channel.addEventListener("close", () => {
    if (!state.finished) fail(new Error("Benchmark data channel closed before verified completion."));
  });
  channel.addEventListener("message", (event) => {
    try {
      if (state.finished) return;
      if (state.role === "sender") {
        const message = decodeOfflineControl(event.data);
        if (message.type === "ack") {
          if (state.mode === "transfer") state.sender.acknowledge(message.indices);
          else for (const index of message.indices) {
            if (index !== state.rawAcknowledged++) throw new Error("Raw baseline ACK sequence mismatch.");
          }
        }
        else if (message.type === "receiver-complete" && state.payloadComplete) {
          state.verified = true;
          finish();
        } else throw new Error(`Unexpected sender control: ${message.type}`);
      } else if (typeof event.data !== "string") {
        if (state.receiveStartedAt === undefined) phase("receive");
        state.receiveStartedAt ??= performance.now();
        state.binaryMessages++;
        state.binaryBytes += event.data.byteLength;
        state.queue.enqueue(event.data);
      } else {
        const message = decodeOfflineControl(event.data);
        if (message.type !== "sender-complete" || state.completing) throw new Error("Unexpected receiver control.");
        state.completing = true;
        void completeReceiver().catch(fail);
      }
    } catch (error) { fail(error); }
  });
}

function fixtureTree(layout) {
  const directory = (name) => ({ kind: "directory", name, children: new Map(),
    async *entries() { yield* this.children.entries(); } });
  const root = directory("webrtc-benchmark");
  for (const descriptor of layout.files) {
    const readPattern = createBenchmarkPatternReader(descriptor.index);
    const segments = descriptor.path.split("/");
    const name = segments.pop();
    let parent = root;
    for (const segment of segments) {
      if (!parent.children.has(segment)) parent.children.set(segment, directory(segment));
      parent = parent.children.get(segment);
    }
    const file = { name, size: descriptor.size, lastModified: 7, slice(start, end) {
      const begin = performance.now();
      const data = readPattern(start, end - start);
      const blob = new Blob([data]);
      metric(`${state.phase}.syntheticSlice`, performance.now() - begin, data.length);
      return { async arrayBuffer() {
        const readStart = performance.now();
        try { return await blob.arrayBuffer(); }
        finally { metric(`${state.phase}.blobRead`, performance.now() - readStart, data.length); }
      } };
    } };
    parent.children.set(name, { kind: "file", name, getFile: async () => file });
  }
  return root;
}

export async function setupSender(options) {
  init(options, "sender");
  let manifest = null;
  if (state.mode === "transfer") {
    phase("scan");
    const begin = performance.now();
    const selection = await collectLargeDirectory(fixtureTree(options.layout));
    state.scanMs = performance.now() - begin;
    phase("prepare");
    const prepareStart = performance.now();
    state.source = await prepareLargeSource(selection, (value) => report(Number(value.bytesComplete)), state.controller.signal);
    state.prepareMs = performance.now() - prepareStart;
    manifest = await createOfflineTransferManifest(state.source);
  }
  state.manifest = manifest;
  phase("connect");
  bindChannel(state.peer.createDataChannel("benchmark", { ordered: true }));
  return { manifest, scanMs: state.scanMs, prepareMs: state.prepareMs, blockSize: OFFLINE_BLOCK_BYTES, dataHeaderBytes: OFFLINE_DATA_HEADER_BYTES };
}

async function profileWorker() {
  const OriginalWorker = globalThis.Worker;
  const pending = new WeakMap();
  globalThis.Worker = class extends OriginalWorker {
    constructor(...args) {
      super(...args);
      const requests = new Map();
      pending.set(this, requests);
      // Install BEFORE the client can register its response handler. Registering
      // in postMessage (even with capture:true) included consumer microtasks.
      this.addEventListener("message", (event) => {
        const request = requests.get(event.data.id);
        if (!request) return;
        requests.delete(event.data.id);
        metric(`worker.${request.phase}.${request.type}`, performance.now() - request.start, request.bytes);
      });
    }
    postMessage(message, ...args) {
      const requests = pending.get(this);
      if (requests.size >= 256) throw new Error("Benchmark observed an unbounded worker request queue.");
      requests.set(message.id, { phase: state.phase, type: message.type, start: performance.now(), bytes: message.bytes?.byteLength ?? message.length ?? 0 });
      try { return super.postMessage(message, ...args); }
      catch (error) { requests.delete(message.id); throw error; }
    }
  };
  state.restoreWorker = () => { globalThis.Worker = OriginalWorker; };
  // Assert listener ordering directly; a wall-time threshold would be flaky.
  const url = URL.createObjectURL(new Blob(["onmessage = event => postMessage({id:event.data.id})"], { type: "text/javascript" }));
  const worker = new Worker(url);
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Worker profiling calibration timed out.")), 5000);
      worker.onmessage = () => {
        if (state.operations["worker.setup.calibration"]?.calls !== 1) reject(new Error("Worker timer ran after its consumer."));
        else { state.workerProfilerBeforeConsumers = true; resolve(); }
      };
      worker.onerror = () => reject(new Error("Worker profiling calibration failed."));
      worker.postMessage({ id: 1, type: "calibration" });
    });
  } finally { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); delete state.operations["worker.setup.calibration"]; }
}

export async function setupReceiver(options) {
  init(options, "receiver");
  if (state.mode === "transfer") {
    if (state.profile) await profileWorker();
    state.receiver = await OfflineDestinationReceiver.open(state.manifest, { requestPersistence: false });
    // Matched codec control, AFTER store creation (which independently needs
    // WebCrypto for its directory name). This is not a no-WebCrypto app test.
    if (!options.nativeHashes) {
      const original = Object.getOwnPropertyDescriptor(crypto, "subtle");
      Object.defineProperty(crypto, "subtle", { value: undefined, configurable: true });
      state.restoreCrypto = () => {
        if (original) Object.defineProperty(crypto, "subtle", original);
        else delete crypto.subtle;
      };
    }
    const write = state.receiver.store.writeBlocks.bind(state.receiver.store);
    if (state.profile) state.receiver.store.writeBlocks = async (...args) => {
      const begin = performance.now();
      try { return await write(...args); }
      finally { metric("receive.storeWriteBlocks", performance.now() - begin); }
    };
    if (state.profile) {
      const accept = state.receiver.acceptBatch.bind(state.receiver);
      state.receiver.acceptBatch = async (...args) => {
        const begin = performance.now();
        try { return await accept(...args); }
        finally { metric("receive.acceptBatch", performance.now() - begin); }
      };
    }
  }
  const rawReceiver = { async acceptBatch(values) {
    const indices = [];
    for (const value of values) {
      const bytes = new Uint8Array(value), view = new DataView(value);
      const index = view.getUint32(4, true), length = view.getUint32(8, true);
      if (index !== state.rawNextIndex++ || length !== bytes.length - OFFLINE_DATA_HEADER_BYTES) throw new Error("Raw baseline frame mismatch.");
      for (let offset = OFFLINE_DATA_HEADER_BYTES; offset < bytes.length; offset++) {
        if (bytes[offset] !== rawValue) throw new Error("Raw transport content mismatch.");
      }
      state.receivedBytes += length;
      if (state.receivedBytes > state.bytes) throw new Error("Raw transport byte count exceeded fixture.");
      indices.push(index);
    }
    return indices;
  } };
  state.queue = new DurableReceiveQueue(state.mode === "transfer" ? state.receiver : rawReceiver, {
      onCommitted(indices) {
        state.ackIndices = (state.ackIndices ?? 0) + indices.length;
        state.channel.send(encodeOfflineControl({ type: "ack", indices }));
        if (state.mode === "transfer") state.receivedBytes = state.receiver.store.progress().receivedBytes;
        state.lastCommitAt = performance.now();
        sampleHeap();
        report(state.receivedBytes);
      }, onError: fail,
    });
  state.peer.addEventListener("datachannel", (event) => bindChannel(event.channel), { once: true });
}

export async function offer() {
  await state.peer.setLocalDescription(await state.peer.createOffer());
  await waitForIceGatheringComplete(state.peer, state.controller.signal);
  return { type: "offer", sdp: limitSdpToLocalCandidates(state.peer.localDescription.sdp) };
}
export async function answer(description) {
  await state.peer.setRemoteDescription(description);
  await state.peer.setLocalDescription(await state.peer.createAnswer());
  await waitForIceGatheringComplete(state.peer, state.controller.signal);
  return { type: "answer", sdp: limitSdpToLocalCandidates(state.peer.localDescription.sdp) };
}
export async function acceptAnswer(description) { await state.peer.setRemoteDescription(description); }

function waitChannelEvent(name, ready) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => {
      state.channel.removeEventListener(name, check);
      state.controller.signal.removeEventListener("abort", abort);
      state.channel.removeEventListener("close", closed);
    };
    const check = () => { if (ready()) { clean(); resolve(); } };
    const abort = () => { clean(); reject(state.controller.signal.reason); };
    const closed = () => { clean(); reject(new Error("Benchmark channel closed while waiting.")); };
    state.channel.addEventListener(name, check);
    state.controller.signal.addEventListener("abort", abort, { once: true });
    state.channel.addEventListener("close", closed, { once: true });
    if (state.controller.signal.aborted) abort(); else check();
  });
}

export async function transmit() {
  try {
    await waitChannelEvent("open", () => state.channel.readyState === "open");
    const required = OFFLINE_BLOCK_BYTES + OFFLINE_DATA_HEADER_BYTES;
    const max = state.peer.sctp?.maxMessageSize;
    if (max !== undefined && max !== 0 && max < required) throw new Error("SCTP maximum message size is too small.");
    phase("transfer");
    state.nextReport = 128 * 1024 * 1024;
    const begin = performance.now();
    if (state.mode === "transfer") {
      state.sender = new OfflineSourceSender(state.channel, state.source, state.manifest);
      await state.sender.run(state.controller.signal, (progress) => report(progress.completedBytes));
    } else {
      const payload = new Uint8Array(required).fill(rawValue);
      const view = new DataView(payload.buffer);
      const totalBlocks = Math.ceil(state.bytes / OFFLINE_BLOCK_BYTES);
      let index = 0;
      for (let sent = 0; sent < state.bytes;) {
        state.controller.signal.throwIfAborted();
        while (index - state.rawAcknowledged >= 96) {
          await waitChannelEvent("message", () => index - state.rawAcknowledged < 96);
        }
        if (state.channel.bufferedAmount >= 8 * 1024 * 1024) {
          await waitChannelEvent("bufferedamountlow", () => state.channel.bufferedAmount <= 2 * 1024 * 1024);
        }
        const take = Math.min(OFFLINE_BLOCK_BYTES, state.bytes - sent);
        view.setUint32(4, index++, true);
        view.setUint32(8, take, true);
        state.channel.send(payload.subarray(0, take + OFFLINE_DATA_HEADER_BYTES));
        sent += take;
      }
      while (state.rawAcknowledged < totalBlocks) {
        const before = state.rawAcknowledged;
        await waitChannelEvent("message", () => state.rawAcknowledged > before);
      }
      state.channel.send(encodeOfflineControl({ type: "sender-complete" }));
    }
    state.transferMs = performance.now() - begin;
    markEvent("payload-acked");
    state.payloadComplete = true;
    // Waiting for receiver-complete is separate from sender enqueue/ACK time.
    await state.result;
    state.confirmedMs = performance.now() - begin;
  } catch (error) { fail(error); }
}

async function completeReceiver() {
  await state.queue.finish();
  markEvent("payload-durable");
  if (state.mode === "raw") {
    if (state.receivedBytes !== state.bytes) throw new Error("Raw transport byte count mismatch.");
    state.transferMs = state.lastCommitAt - state.receiveStartedAt;
  } else {
    state.transferMs = state.lastCommitAt - state.receiveStartedAt;
    phase("verify");
    const start = performance.now();
    const reader = await state.receiver.verify(state.controller.signal);
    state.streamVerifyMs = performance.now() - start;
    state.streamVerified = true;
    if (state.saveTree) {
      phase("destination");
      const tree = await readLargeTreeManifest(reader);
      const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle("benchmark-destination", { create: true });
      const fromHex = (text) => Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16));
      const begin = performance.now();
      const saved = await writeLargeTreeToDirectory(tree, reader, {
        transferId: fromHex(state.manifest.transferId), streamSha256: fromHex(state.manifest.streamSha256),
      }, parent, { signal: state.controller.signal });
      state.destinationSaveMs = performance.now() - begin;
      state.destinationFilesWritten = saved.filesWritten;
      phase("audit");
      const auditStart = performance.now();
      await auditDestination(await parent.getDirectoryHandle("webrtc-benchmark"));
      state.destinationAuditMs = performance.now() - auditStart;
      state.destinationVerified = true;
    }
  }
  state.verified = true;
  state.channel.send(encodeOfflineControl({ type: "receiver-complete" }));
  finish();
}

async function auditDestination(root) {
  const expected = new Map(state.layout.files.map((file) => [file.path, file]));
  const directories = new Set(state.layout.directories);
  let checkedBytes = 0;
  async function walk(directory, prefix = "") {
    for await (const [name, handle] of directory.entries()) {
      const path = prefix + name;
      if (handle.kind === "directory") {
        if (!directories.delete(path)) throw new Error(`Unexpected destination directory: ${path}`);
        await walk(handle, path + "/");
      } else {
        const wanted = expected.get(path);
        if (!wanted) throw new Error(`Unexpected destination file: ${path}`);
        const file = await handle.getFile();
        if (file.size !== wanted.size) throw new Error(`Destination size mismatch: ${path}`);
        for (let start = 0; start < file.size; start += 4 * 1024 * 1024) {
          state.controller.signal.throwIfAborted();
          const bytes = new Uint8Array(await file.slice(start, start + 4 * 1024 * 1024).arrayBuffer());
          for (let offset = 0; offset < bytes.length; offset++) {
            const position = start + offset;
            const expectedByte = ((wanted.index >>> ((position & 3) * 8)) ^ (position * 31)) & 255;
            if (bytes[offset] !== expectedByte) throw new Error(`Destination content mismatch: ${path} at ${position}`);
          }
          checkedBytes += bytes.length;
          sampleHeap();
        }
        expected.delete(path);
      }
    }
  }
  await walk(root);
  if (expected.size || directories.size || checkedBytes !== state.bytes) throw new Error("Destination tree audit incomplete.");
  state.destinationCheckedBytes = checkedBytes;
}

export async function result() {
  await state.result;
  let path = { protocol: "Unavailable", roundTripMs: null }, transportStats, transportStatsError;
  try {
    const report = await state.peer.getStats();
    path = connectionPath(report);
    transportStats = benchmarkTransportSnapshot(report);
  } catch (error) { transportStatsError = errorText(error); }
  const keys = ["role", "mode", "verified", "error", "corruptionInjected", "scanMs", "prepareMs", "transferMs", "confirmedMs", "elapsedMs",
    "streamVerified", "streamVerifyMs", "destinationSaveMs", "destinationAuditMs", "destinationFilesWritten", "destinationCheckedBytes", "destinationVerified",
    "binaryMessages", "binaryBytes", "receivedBytes", "ackIndices", "controls", "operations", "peakChannelBufferedBytes", "peakJsHeapBytes", "heapByPhase", "workerProfilerBeforeConsumers", "timeline"];
  return { ...Object.fromEntries(keys.filter((key) => state[key] !== undefined).map((key) => [key, state[key]])),
    nativeDigestAvailable: typeof crypto.subtle?.digest === "function",
    maxMessageSize: state.peer.sctp?.maxMessageSize ?? null, selectedPath: path,
    peakReceiveQueueBytes: state.queue?.peakBufferedBytes ?? null, userAgent: navigator.userAgent,
    ...(transportStats ? { transportStats } : {}), ...(transportStatsError ? { transportStatsError } : {}) };
}

export function memoryObservation() {
  return { phase: state?.phase ?? "setup", finished: state?.finished ?? false };
}

export async function cleanup() {
  if (!state) return;
  if (!state.finished) fail(new Error("Benchmark cleanup before completion."));
  state.sender?.dispose();
  await state.queue?.stop();
  state.peer.close();
  state.restoreCrypto?.();
  try { await state.receiver?.store.delete(); }
  finally {
    await state.receiver?.store.close();
    state.restoreWorker?.();
    delete globalThis.__qrftBenchmarkRecord;
  }
}
