import { describe, expect, it, vi } from "vitest";
import { MemoryBlockStoreRepository } from "../src/lib/block-store";
import { DurableReceiveQueue } from "../src/lib/webrtc-receive-queue";
import { prepareLargeSource, readLargeTreeManifest, readPreparedLargeRange, type LargeSourceSelection } from "../src/lib/large-transfer";
import { createOfflineTransferManifest, decodeOfflineControl, encodeOfflineDataBlock, OFFLINE_BLOCK_BYTES } from "../src/lib/webrtc-protocol";
import { OfflineDestinationReceiver, OfflineSourceSender } from "../src/lib/webrtc-transfer";

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "open";
  onBinary?: (bytes: ArrayBuffer) => Promise<void>;
  controls: string[] = [];

  send(value: string | ArrayBuffer): void {
    if (typeof value === "string") {
      this.controls.push(value);
      return;
    }
    void this.onBinary?.(value);
  }
}

function selectionWithLargeFile(blocks = 2, byteCount = OFFLINE_BLOCK_BYTES * blocks + 777): LargeSourceSelection {
  const bytes = Uint8Array.from({ length: byteCount }, (_, index) => (index * 37) & 0xff);
  const snapshot = new File([bytes], "large.bin", { lastModified: 7 });
  return {
    rootName: "offline-fixture",
    rootHandle: { kind: "directory", name: "offline-fixture" } as FileSystemDirectoryHandle,
    files: [{
      path: "large.bin",
      handle: {
        kind: "file",
        name: "large.bin",
        async getFile() { return snapshot; },
      } as FileSystemFileHandle,
      size: snapshot.size,
      lastModified: snapshot.lastModified,
    }],
    directories: ["empty"],
    totalFileBytes: BigInt(snapshot.size),
  };
}

describe("offline WebRTC transfer", () => {
  it.each([
    ["empty file", 0, undefined],
    ["one-byte file", 1, undefined],
    ["file exactly one block", OFFLINE_BLOCK_BYTES, undefined],
    ["file block plus one", OFFLINE_BLOCK_BYTES + 1, undefined],
    ["stream exactly one block", undefined, OFFLINE_BLOCK_BYTES],
    ["stream block plus one", undefined, OFFLINE_BLOCK_BYTES + 1],
  ] as const)("transfers exact file and virtual-stream boundary: %s", async (_label, fileBytes, streamBytes) => {
    let source = await prepareLargeSource(selectionWithLargeFile(0, fileBytes ?? OFFLINE_BLOCK_BYTES));
    if (streamBytes !== undefined) {
      // Metadata byte length can depend on the decimal file-size width.
      // Reprepare until the actual encoded stream, not an estimated payload,
      // reaches the requested boundary.
      for (let attempt = 0; attempt < 4 && Number(source.totalStreamBytes) !== streamBytes; attempt++) {
        const adjusted = Number(source.totalFileBytes) + streamBytes - Number(source.totalStreamBytes);
        source = await prepareLargeSource(selectionWithLargeFile(0, adjusted));
      }
      expect(Number(source.totalStreamBytes)).toBe(streamBytes);
    } else expect(Number(source.totalFileBytes)).toBe(fileBytes);
    const manifest = await createOfflineTransferManifest(source);
    const receiver = await OfflineDestinationReceiver.open(manifest, { backend: "memory", memoryRepository: new MemoryBlockStoreRepository() });
    const channel = new FakeDataChannel();
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    const packets: Array<{ index: number; length: number }> = [];
    const queue = new DurableReceiveQueue(receiver, { onCommitted: indices => sender.acknowledge(indices), onError: error => sender.fail(error) });
    channel.onBinary = async bytes => {
      const view = new DataView(bytes);
      packets.push({ index: view.getUint32(4, true), length: view.getUint32(8, true) });
      queue.enqueue(bytes);
    };
    try {
      await sender.run(new AbortController().signal);
      await queue.finish();
      const blocks = Math.ceil(manifest.totalBytes / OFFLINE_BLOCK_BYTES);
      expect(receiver.store.totalBlocks).toBe(blocks);
      expect(packets).toEqual(Array.from({ length: blocks }, (_, index) => ({ index, length: Math.min(OFFLINE_BLOCK_BYTES, manifest.totalBytes - index * OFFLINE_BLOCK_BYTES) })));
      expect(packets.every(packet => packet.length > 0)).toBe(true);
      expect(receiver.store.progress()).toMatchObject({ complete: true, receivedBytes: manifest.totalBytes, receivedBlocks: blocks });
      expect(channel.controls.map(decodeOfflineControl)).toEqual([{ type: "sender-complete" }]);
      const reader = await receiver.verify(new AbortController().signal);
      const tree = await readLargeTreeManifest(reader);
      expect(tree.directories).toEqual(["empty"]);
      expect(tree.files).toHaveLength(1);
      expect(tree.files[0]).toMatchObject({ path: "large.bin", size: source.totalFileBytes });
      const file = await reader.read(tree.files[0].offset, Number(tree.files[0].size));
      expect(file).toEqual(Uint8Array.from({ length: Number(source.totalFileBytes) }, (_, index) => index * 37 & 255));
    } finally {
      sender.dispose();
      await receiver.store.delete();
    }
  });

  it.each([0, 1, 25, 50, 99, 100])("recovers exactly the missing blocks after interruption at %i of 100 durable blocks", async (cut) => {
    const calibration = await prepareLargeSource(selectionWithLargeFile(99));
    const overhead = Number(calibration.totalStreamBytes - calibration.totalFileBytes);
    const fileBytes = OFFLINE_BLOCK_BYTES * 100 - overhead;
    const source = await prepareLargeSource(selectionWithLargeFile(99, fileBytes));
    const manifest = await createOfflineTransferManifest(source);
    // Equal-width blocks make the required percentages exact byte boundaries,
    // including the virtual-tree trailer rather than only the payload file.
    expect(manifest.totalBytes).toBe(OFFLINE_BLOCK_BYTES * 100);
    const repository = new MemoryBlockStoreRepository();
    const options = { backend: "memory" as const, memoryRepository: repository };
    const initial = await OfflineDestinationReceiver.open(manifest, options);
    expect(initial.store.totalBlocks).toBe(100);
    const firstChannel = new FakeDataChannel();
    const firstSender = new OfflineSourceSender(firstChannel as unknown as RTCDataChannel, source, manifest);
    const abort = new AbortController();
    const reason = new DOMException("Simulated interrupted connection", "AbortError");
    const writes: Promise<void>[] = [];
    const errors: unknown[] = [];
    let admitted = 0;
    let committed = 0;
    firstChannel.onBinary = (bytes) => {
      // Drop packets in flight beyond the chosen disconnect boundary. The
      // last commit becomes durable, but its ACK is lost.
      if (admitted >= cut) return Promise.resolve();
      admitted += 1;
      const write = initial.acceptData(bytes).then(index => {
        committed += 1;
        if (committed === cut) {
          abort.abort(reason);
          firstChannel.readyState = "closed";
          firstChannel.dispatchEvent(new Event("close"));
        } else firstSender.acknowledge([index]);
      }).catch(error => { errors.push(error); firstSender.fail(error instanceof Error ? error : new Error(String(error))); });
      writes.push(write);
      return write;
    };
    if (cut === 0) abort.abort(reason);
    await expect(firstSender.run(abort.signal)).rejects.toBe(reason);
    await Promise.all(writes);
    expect(errors).toEqual([]);
    expect(committed).toBe(cut);
    expect(firstSender.isPayloadComplete).toBe(false);
    expect(firstChannel.controls.map(decodeOfflineControl)).not.toContainEqual({ type: "sender-complete" });
    firstSender.dispose();
    const resumedBytes = Math.min(cut * OFFLINE_BLOCK_BYTES, manifest.totalBytes);
    expect(initial.store.progress().receivedBytes).toBe(resumedBytes);
    await initial.store.close();
    const reopened = await OfflineDestinationReceiver.open(manifest, options);
    expect(reopened.resumeRanges()).toEqual(cut ? [[0, cut]] : []);
    const channel = new FakeDataChannel();
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    sender.applyResumeRanges(reopened.resumeRanges());
    const sentIndices: number[] = [];
    const queue = new DurableReceiveQueue(reopened, { batchBlocks: 32,
      onCommitted: indices => sender.acknowledge(indices), onError: error => sender.fail(error),
    });
    channel.onBinary = async bytes => { sentIndices.push(new DataView(bytes).getUint32(4, true)); queue.enqueue(bytes); };
    const progress: Array<{ completedBytes: number; resumedBytes: number }> = [];
    try {
      await sender.run(new AbortController().signal, value => progress.push(value));
      await queue.finish();
      expect(sentIndices).toEqual(Array.from({ length: 100 - cut }, (_, index) => cut + index));
      expect(progress[0]).toMatchObject({ completedBytes: resumedBytes, resumedBytes });
      expect(progress.at(-1)?.completedBytes).toBe(manifest.totalBytes);
      expect(channel.controls.map(decodeOfflineControl)).toEqual([{ type: "sender-complete" }]);
      const reader = await reopened.verify(new AbortController().signal);
      const tree = await readLargeTreeManifest(reader);
      const file = tree.files[0];
      expect(tree.files.map(entry => entry.path)).toEqual(["large.bin"]);
      expect(file.size).toBe(BigInt(fileBytes));
      // Audit the file pattern independently of the source/stream digests.
      for (let offset = 0; offset < Number(file.size); offset += 256 * 1024) {
        const bytes = await reader.read(file.offset + BigInt(offset), Math.min(256 * 1024, Number(file.size) - offset));
        for (let index = 0; index < bytes.length; index++) if (bytes[index] !== ((offset + index) * 37 & 255)) throw new Error(`Recovered fixture byte mismatch at ${offset + index}`);
      }
      console.info(JSON.stringify({ durableBytePercent: cut, totalBlocks: 100, resumedBytes, totalBytes: manifest.totalBytes, retransmittedBlocks: sentIndices.length, independentByteAudit: true }));
    } finally { sender.dispose(); await queue.stop(); await reopened.store.delete(); }
  });

  it("writes no part of a batch when one native digest rejects", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile(1));
    const manifest = await createOfflineTransferManifest(source);
    const receiver = await OfflineDestinationReceiver.open(manifest, { backend: "memory", memoryRepository: new MemoryBlockStoreRepository() });
    const blocks: ArrayBuffer[] = [];
    for (let index = 0; index < receiver.store.totalBlocks; index++) {
      const offset = index * manifest.blockSize;
      blocks.push(encodeOfflineDataBlock(index, await readPreparedLargeRange(source, BigInt(offset), Math.min(manifest.blockSize, manifest.totalBytes - offset))).buffer as ArrayBuffer);
    }
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const failure = new Error("Native hash failed mid-batch");
    let calls = 0;
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation((...args) => ++calls === 2 ? Promise.reject(failure) : original(...args));
    const write = vi.spyOn(receiver.store, "writeBlocks");
    try {
      await expect(receiver.acceptBatch(blocks)).rejects.toBe(failure);
      expect(write).not.toHaveBeenCalled();
      expect(receiver.store.progress().receivedBytes).toBe(0);
    } finally { digest.mockRestore(); await receiver.store.delete(); }
  });

  it("duplicate acknowledgments cannot extend the wait for missing receipts", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile(1));
    const manifest = await createOfflineTransferManifest(source);
    const channel = new FakeDataChannel();
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    let markSent!: () => void;
    const sent = new Promise<void>((resolve) => { markSent = resolve; });
    let packets = 0;
    channel.onBinary = async () => {
      if (packets++ === 0) sender.acknowledge([0]);
      if (packets === Math.ceil(manifest.totalBytes / manifest.blockSize)) markSent();
    };
    vi.useFakeTimers();
    try {
      const result = sender.run(new AbortController().signal).catch((error: Error) => error);
      await sent;
      await vi.advanceTimersByTimeAsync(60_000);
      sender.acknowledge([0, 0]);
      sender.acknowledge([]);
      sender.setPaused(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining("stopped responding") }));
      expect(sender.isPayloadComplete).toBe(false);
    } finally { sender.dispose(); vi.useRealTimers(); }
  });

  it("aborting a blocked sender clears its wait timer", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile(0));
    const manifest = await createOfflineTransferManifest(source);
    const channel = new FakeDataChannel(); channel.bufferedAmount = 8 * 1024 * 1024;
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const result = sender.run(controller.signal).catch((error: Error) => error);
      expect(vi.getTimerCount()).toBe(1);
      const reason = new Error("User cancelled"); controller.abort(reason);
      expect(await result).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
      expect(channel.controls).toEqual([]);
    } finally { sender.dispose(); vi.useRealTimers(); }
  });

  it("times out missing final acknowledgments without claiming payload completion", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile(0));
    const manifest = await createOfflineTransferManifest(source);
    const channel = new FakeDataChannel();
    let markSent!: () => void;
    const sent = new Promise<void>((resolve) => { markSent = resolve; });
    channel.onBinary = async () => { markSent(); };
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    vi.useFakeTimers();
    try {
      const result = sender.run(new AbortController().signal).catch((error: Error) => error);
      await sent;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining("stopped responding") }));
      expect(sender.isPayloadComplete).toBe(false);
      expect(channel.controls).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { sender.dispose(); vi.useRealTimers(); }
  });

  it("times out a silent open channel, suspends the deadline while paused, and cleans up", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile());
    const manifest = await createOfflineTransferManifest(source);
    const channel = new FakeDataChannel();
    // Force the sender to wait before a source read, making timer control exact.
    channel.bufferedAmount = 8 * 1024 * 1024;
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    vi.useFakeTimers();
    try {
      const result = sender.run(new AbortController().signal).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(60_000);
      sender.setPaused(true);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(sender.isPayloadComplete).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      sender.setPaused(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining("stopped responding") }));
      expect(channel.controls).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { sender.dispose(); vi.useRealTimers(); }
  });

  it.each([64, 128])("transfers beyond the sender window with %i-block batches without a tail deadlock", async (batchBlocks) => {
    const source = await prepareLargeSource(selectionWithLargeFile(200));
    const manifest = await createOfflineTransferManifest(source);
    const receiver = await OfflineDestinationReceiver.open(manifest, { backend: "memory", memoryRepository: new MemoryBlockStoreRepository() });
    const channel = new FakeDataChannel();
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    const ack = vi.fn((indices: number[]) => sender.acknowledge(indices));
    const queue = new DurableReceiveQueue(receiver, { batchBlocks, onCommitted: ack, onError: (error) => sender.fail(error) });
    channel.onBinary = async (bytes) => queue.enqueue(bytes);
    await sender.run(new AbortController().signal);
    await queue.finish();
    expect(sender.isPayloadComplete).toBe(true);
    expect(ack.mock.calls.length).toBeLessThan(10);
    expect(ack.mock.calls.flatMap(([indices]) => indices)).toHaveLength(receiver.store.totalBlocks);
    await expect(receiver.verify(new AbortController().signal)).resolves.toBeDefined();
    sender.dispose();
    await receiver.store.delete();
  });

  it("rejects a corrupted batch without marking any of that group durable", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile());
    const manifest = await createOfflineTransferManifest(source);
    const options = { backend: "memory" as const, memoryRepository: new MemoryBlockStoreRepository() };
    const receiver = await OfflineDestinationReceiver.open(manifest, options);
    const values: ArrayBuffer[] = [];
    for (let index = 0; index < receiver.store.totalBlocks; index += 1) {
      const offset = index * manifest.blockSize;
      const bytes = await readPreparedLargeRange(source, BigInt(offset), Math.min(manifest.blockSize, manifest.totalBytes - offset));
      values.push(encodeOfflineDataBlock(index, bytes).buffer as ArrayBuffer);
    }
    await receiver.acceptBatch([values[0], values[0]]);
    new Uint8Array(values[2])[44] ^= 1;
    await expect(receiver.acceptBatch(values.slice(1))).rejects.toThrow(/SHA-256/);
    expect(receiver.resumeRanges()).toEqual([[0, 1]]);
    await receiver.store.close();
    const reopened = await OfflineDestinationReceiver.open(manifest, options);
    expect(reopened.resumeRanges()).toEqual([[0, 1]]);
    await reopened.store.delete();
  });

  it("discards a complete corrupt stream so reconnect retransmits and verifies", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile());
    const manifest = await createOfflineTransferManifest(source);
    const options = { backend: "memory" as const, memoryRepository: new MemoryBlockStoreRepository() };
    const receiver = await OfflineDestinationReceiver.open(manifest, options);
    for (let index = 0; index < receiver.store.totalBlocks; index += 1) {
      const offset = index * manifest.blockSize;
      const bytes = await readPreparedLargeRange(source, BigInt(offset), Math.min(manifest.blockSize, manifest.totalBytes - offset));
      if (index === 0) bytes[0] ^= 1;
      await receiver.store.writeBlock(index, bytes);
    }
    expect(receiver.store.progress().complete).toBe(true);
    await expect(receiver.verify(new AbortController().signal)).rejects.toThrow(/was discarded.*Reconnect/);
    await receiver.store.close();

    const reopened = await OfflineDestinationReceiver.open(manifest, options);
    expect(reopened.resumeRanges()).toEqual([]);
    const channel = new FakeDataChannel();
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    let sent = 0;
    channel.onBinary = async (bytes) => {
      sent += 1;
      sender.acknowledge([await reopened.acceptData(bytes)]);
    };
    sender.applyResumeRanges(reopened.resumeRanges());
    await sender.run(new AbortController().signal);
    expect(sent).toBe(reopened.store.totalBlocks);
    await expect(reopened.verify(new AbortController().signal)).resolves.toHaveProperty("size", BigInt(manifest.totalBytes));
    sender.dispose();
    await reopened.store.delete();
  });

  it("does not discard valid durable data when verification is aborted", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile());
    const manifest = await createOfflineTransferManifest(source);
    const receiver = await OfflineDestinationReceiver.open(manifest, { backend: "memory", memoryRepository: new MemoryBlockStoreRepository() });
    for (let index = 0; index < receiver.store.totalBlocks; index += 1) {
      const offset = index * manifest.blockSize;
      await receiver.store.writeBlock(index, await readPreparedLargeRange(source, BigInt(offset), Math.min(manifest.blockSize, manifest.totalBytes - offset)));
    }
    const deletion = vi.spyOn(receiver.store, "delete");
    const controller = new AbortController();
    await expect(receiver.verify(controller.signal, () => controller.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(deletion).not.toHaveBeenCalled();
    expect(receiver.store.progress().complete).toBe(true);
    await expect(receiver.verify(new AbortController().signal)).resolves.toBeDefined();
    await receiver.store.delete();
  });

  it("resumes durable blocks, transfers the rest, and verifies the virtual tree", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile());
    const manifest = await createOfflineTransferManifest(source);
    const receiver = await OfflineDestinationReceiver.open(manifest, { backend: "memory" });
    const first = await readPreparedLargeRange(source, 0n, OFFLINE_BLOCK_BYTES);
    await receiver.store.writeBlock(0, first);

    const channel = new FakeDataChannel();
    let binaryMessages = 0;
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    sender.applyResumeRanges(receiver.resumeRanges());
    channel.onBinary = async (bytes) => {
      binaryMessages += 1;
      const index = await receiver.acceptData(bytes);
      sender.acknowledge([index]);
    };

    const updates: number[] = [];
    await sender.run(new AbortController().signal, (progress) => updates.push(progress.completedBytes));
    expect(updates[0]).toBe(OFFLINE_BLOCK_BYTES);
    expect(updates.at(-1)).toBe(manifest.totalBytes);
    expect(binaryMessages).toBe(receiver.store.totalBlocks - 1);
    expect(channel.controls.map(decodeOfflineControl)).toContainEqual({ type: "sender-complete" });

    const reader = await receiver.verify(new AbortController().signal);
    const tree = await readLargeTreeManifest(reader);
    expect(tree.rootName).toBe("offline-fixture");
    expect(tree.directories).toEqual(["empty"]);
    expect(tree.files.map((file) => file.path)).toEqual(["large.bin"]);
    await receiver.store.delete();
    sender.dispose();
  });

  it("aborts promptly while transmission is paused", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile());
    const manifest = await createOfflineTransferManifest(source);
    const channel = new FakeDataChannel();
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    const controller = new AbortController();
    sender.setPaused(true);
    const task = sender.run(controller.signal);
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    sender.dispose();
  });

  it("does not lose a failure that arrives before a paused sender starts waiting", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile());
    const manifest = await createOfflineTransferManifest(source);
    const sender = new OfflineSourceSender(new FakeDataChannel() as unknown as RTCDataChannel, source, manifest);
    sender.setPaused(true);
    sender.fail(new Error("Synthetic disconnect"));
    await expect(sender.run(new AbortController().signal)).rejects.toThrow("Synthetic disconnect");
    sender.dispose();
  });

  it("rejects repeated resume pages and acknowledgements for unsent blocks", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile());
    const manifest = await createOfflineTransferManifest(source);
    const sender = new OfflineSourceSender(new FakeDataChannel() as unknown as RTCDataChannel, source, manifest);
    sender.applyResumeRanges([[0, 1]]);
    expect(() => sender.applyResumeRanges([[0, 1]])).toThrow(/ordered/);
    sender.acknowledge([2]);
    await expect(sender.run(new AbortController().signal)).rejects.toThrow(/not sent/);
    sender.dispose();
  });

  it("rejects an incomplete durable stream", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile());
    const manifest = await createOfflineTransferManifest(source);
    const receiver = await OfflineDestinationReceiver.open(manifest, { backend: "memory" });
    await expect(receiver.verify(new AbortController().signal)).rejects.toThrow(/before all blocks/i);
    await receiver.store.delete();
  });
});

describe("verification cleanup error boundaries", () => {
  async function completeFixture() {
    const source = await prepareLargeSource(selectionWithLargeFile(0, 1));
    const manifest = await createOfflineTransferManifest(source);
    const receiver = await OfflineDestinationReceiver.open(manifest, { backend: "memory", memoryRepository: new MemoryBlockStoreRepository() });
    await receiver.store.writeBlock(0, await readPreparedLargeRange(source, 0n, manifest.totalBytes));
    expect(receiver.store.progress().complete).toBe(true);
    return receiver;
  }

  it("does not open a verification stream when already canceled", async () => {
    const receiver = await completeFixture();
    const open = vi.spyOn(receiver.store, "createReadStream");
    const controller = new AbortController();
    const reason = new DOMException("Stopped before verification", "AbortError");
    controller.abort(reason);
    try {
      await expect(receiver.verify(controller.signal)).rejects.toBe(reason);
      expect(open).not.toHaveBeenCalled();
      expect(receiver.store.progress().complete).toBe(true);
    } finally { await receiver.store.delete(); }
  });

  it.each(["abort", "progress", "read"] as const)("preserves primary %s failure when reader cancellation also rejects", async failure => {
    const receiver = await completeFixture();
    const primary = failure === "abort" ? new DOMException("Stop requested", "AbortError") : new Error(`Primary ${failure} failure`);
    const secondary = new Error("Secondary cancellation failure");
    const controller = new AbortController();
    const original = receiver.store.createReadStream.bind(receiver.store);
    let cancel: ReturnType<typeof vi.spyOn> | undefined;
    let release: ReturnType<typeof vi.spyOn> | undefined;
    const factory = vi.spyOn(receiver.store, "createReadStream").mockImplementation(async options => {
      const stream = failure === "read" ? new ReadableStream<Uint8Array>({ start(control) { control.error(primary); } }) : await original(options);
      const getReader = stream.getReader.bind(stream);
      vi.spyOn(stream, "getReader").mockImplementation(() => {
        const reader = getReader();
        cancel = vi.spyOn(reader, "cancel").mockRejectedValue(secondary);
        release = vi.spyOn(reader, "releaseLock");
        return reader;
      });
      return stream;
    });
    const deletion = vi.spyOn(receiver.store, "delete");
    try {
      await expect(receiver.verify(controller.signal, () => {
        if (failure === "abort") controller.abort(primary);
        else if (failure === "progress") throw primary;
      })).rejects.toBe(primary);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(deletion).not.toHaveBeenCalled();
      expect(receiver.store.progress().complete).toBe(true);
      factory.mockRestore();
      await expect(receiver.verify(new AbortController().signal)).resolves.toHaveProperty("size", BigInt(receiver.manifest.totalBytes));
    } finally { factory.mockRestore(); await receiver.store.delete(); }
  });
});

describe("aborted verification stream resource lifetime", () => {
  it("closes the verification stream after abort while preserving durable bytes", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile(2, 8 * 1024 * 1024));
    const manifest = await createOfflineTransferManifest(source);
    const receiver = await OfflineDestinationReceiver.open(manifest, { backend: "memory", memoryRepository: new MemoryBlockStoreRepository() });
    for (let index = 0; index < receiver.store.totalBlocks; index++) {
      const offset = index * manifest.blockSize;
      await receiver.store.writeBlock(index, await readPreparedLargeRange(source, BigInt(offset), Math.min(manifest.blockSize, manifest.totalBytes - offset)));
    }
    const originalStream = receiver.store.createReadStream.bind(receiver.store);
    let verificationStream: ReadableStream<Uint8Array> | undefined;
    vi.spyOn(receiver.store, "createReadStream").mockImplementation(async options => {
      verificationStream = await originalStream(options);
      return verificationStream;
    });
    const controller = new AbortController();
    try {
      await expect(receiver.verify(controller.signal, () => controller.abort())).rejects.toMatchObject({ name: "AbortError" });
      expect(receiver.store.progress().complete).toBe(true);
      expect(verificationStream!.locked).toBe(false);
      const afterAbort = verificationStream!.getReader();
      try {
        const next = await afterAbort.read();
        console.log(JSON.stringify({ afterAbortDone: next.done, retainedChunkBytes: next.value?.byteLength ?? 0 }));
        expect(next.done).toBe(true);
      } finally { await afterAbort.cancel(); afterAbort.releaseLock(); }
    } finally { await receiver.store.delete(); }
  });
});
