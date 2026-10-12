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

function selectionWithLargeFile(blocks = 2): LargeSourceSelection {
  const bytes = Uint8Array.from({ length: OFFLINE_BLOCK_BYTES * blocks + 777 }, (_, index) => (index * 37) & 0xff);
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
  it.each(["abort", "unsent ACK"])("sends no block if %s arrives while native encoding is pending", async (action) => {
    const source = await prepareLargeSource(selectionWithLargeFile(0));
    const manifest = await createOfflineTransferManifest(source);
    const channel = new FakeDataChannel();
    const sent = vi.spyOn(channel, "send");
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    const controller = new AbortController();
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let markEntered!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      markEntered();
      await held;
      return original(...args);
    });
    try {
      const result = sender.run(controller.signal).catch((error: Error) => error);
      await entered;
      if (action === "abort") controller.abort(new Error("Stop during hashing"));
      else sender.acknowledge([0]);
      release();
      expect(await result).toEqual(expect.objectContaining({ message: expect.stringMatching(/Stop during hashing|not sent/) }));
      expect(sent).not.toHaveBeenCalled();
      expect(sender.isPayloadComplete).toBe(false);
    } finally { release(); digest.mockRestore(); sender.dispose(); }
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
