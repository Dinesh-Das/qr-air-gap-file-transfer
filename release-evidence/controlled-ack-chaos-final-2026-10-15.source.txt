import { describe, expect, it } from "vitest";
import { MemoryBlockStoreRepository } from "../src/lib/block-store";
import { prepareLargeSource, readLargeTreeManifest, type LargeSourceSelection } from "../src/lib/large-transfer";
import { OFFLINE_BLOCK_BYTES, decodeOfflineControl, createOfflineTransferManifest } from "../src/lib/webrtc-protocol";
import { DurableReceiveQueue, RECEIVE_MAX_PENDING_BYTES } from "../src/lib/webrtc-receive-queue";
import { OfflineDestinationReceiver, OfflineSourceSender, type OfflineTransferProgress } from "../src/lib/webrtc-transfer";

/** Delivery gates model delay without sleeps, clocks, or native-network claims. */
class ControlledChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  packets: ArrayBuffer[] = [];
  acks: number[][] = [];
  controls: string[] = [];
  private changed = new Set<() => void>();

  send(value: string | ArrayBuffer) {
    if (this.readyState !== "open") throw new Error("Controlled connection is closed");
    if (typeof value === "string") this.controls.push(value);
    else this.packets.push(value);
    this.notify();
  }
  commit(indices: number[]) { this.acks.push(indices); this.notify(); }
  async until(predicate: () => boolean) {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => { if (predicate()) { clearTimeout(timer); this.changed.delete(check); resolve(); } };
      const timer = setTimeout(() => { this.changed.delete(check); reject(new Error("Controlled delivery did not reach its expected gate")); }, 2500);
      this.changed.add(check);
    });
  }
  disconnect() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  private notify() { for (const callback of this.changed) callback(); }
}

async function fixture() {
  const bytes = Uint8Array.from({ length: OFFLINE_BLOCK_BYTES * 132 + 17 }, (_, i) => i * 29 + 7 & 255);
  const snapshot = new File([bytes], "payload.bin", { lastModified: 9 });
  const selection: LargeSourceSelection = {
    rootName: "chaos-fixture", rootHandle: { kind: "directory", name: "chaos-fixture" } as FileSystemDirectoryHandle,
    directories: ["empty"], totalFileBytes: BigInt(bytes.length),
    files: [{ path: "payload.bin", size: bytes.length, lastModified: 9,
      handle: { kind: "file", name: "payload.bin", async getFile() { return snapshot; } } as FileSystemFileHandle }],
  };
  const source = await prepareLargeSource(selection);
  return { source, manifest: await createOfflineTransferManifest(source), fileBytes: bytes.length };
}

async function audit(receiver: OfflineDestinationReceiver, fileBytes: number) {
  const reader = await receiver.verify(new AbortController().signal);
  const tree = await readLargeTreeManifest(reader);
  expect(tree.rootName).toBe("chaos-fixture");
  expect(tree.directories).toEqual(["empty"]);
  expect(tree.files.map(file => [file.path, file.size])).toEqual([["payload.bin", BigInt(fileBytes)]]);
  const file = tree.files[0];
  for (let offset = 0; offset < fileBytes; offset += 256 * 1024) {
    const bytes = await reader.read(file.offset + BigInt(offset), Math.min(256 * 1024, fileBytes - offset));
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== ((offset + i) * 29 + 7 & 255)) throw new Error(`Recovered byte mismatch at ${offset + i}`);
  }
}

function indices(channel: ControlledChannel) { return channel.packets.map(p => new DataView(p).getUint32(4, true)); }
function completed(channel: ControlledChannel) { return channel.controls.map(decodeOfflineControl); }
function makeQueue(receiver: OfflineDestinationReceiver, channel: ControlledChannel, sender: OfflineSourceSender) {
  return new DurableReceiveQueue(receiver, { onCommitted: values => channel.commit(values), onError: error => sender.fail(error) });
}
async function holdAtDurableBatch(channel: ControlledChannel, queue: DurableReceiveQueue, receiver: OfflineDestinationReceiver, sender: OfflineSourceSender) {
  // Fill the 96-block sender window before delivering anything. Then persist
  // one 64-block batch while withholding its ACK; no more payload may be sent.
  await channel.until(() => channel.packets.length === 96);
  expect(receiver.store.progress().receivedBlocks).toBe(0);
  for (const packet of channel.packets.slice(0, 64)) queue.enqueue(packet);
  await channel.until(() => channel.acks.length === 1);
  expect(channel.acks[0]).toEqual(Array.from({ length: 64 }, (_, i) => i));
  expect(receiver.store.progress().receivedBlocks).toBe(64);
  expect(channel.packets).toHaveLength(96);
  expect(sender.isPayloadComplete).toBe(false);
  expect(completed(channel)).toEqual([]);
}

describe("controlled delayed delivery and durable ACK loss", () => {
  it("drains a full window after delayed duplicate ACKs and verifies every byte", async () => {
    const { source, manifest, fileBytes } = await fixture();
    const receiver = await OfflineDestinationReceiver.open(manifest, { backend: "memory", memoryRepository: new MemoryBlockStoreRepository() });
    const channel = new ControlledChannel();
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    const queue = makeQueue(receiver, channel, sender);
    const progress: OfflineTransferProgress[] = [];
    const result = sender.run(new AbortController().signal, p => progress.push(p)).catch(error => error);
    try {
      await holdAtDurableBatch(channel, queue, receiver, sender);
      expect(progress.at(-1)?.completedBytes).toBe(0);
      sender.acknowledge(channel.acks[0]);
      sender.acknowledge(channel.acks[0]);
      const count = receiver.store.totalBlocks;
      await channel.until(() => channel.packets.length === count);
      for (const packet of channel.packets.slice(64)) queue.enqueue(packet);
      await queue.finish();
      expect(sender.isPayloadComplete).toBe(false);
      for (const ack of channel.acks.slice(1)) { sender.acknowledge(ack); sender.acknowledge(ack); }
      expect(await result).toBeUndefined();
      expect(progress.at(-1)).toMatchObject({ completedBytes: manifest.totalBytes, completedBlocks: count, resumedBytes: 0 });
      expect(indices(channel)).toEqual(Array.from({ length: count }, (_, i) => i));
      expect(completed(channel)).toEqual([{ type: "sender-complete" }]);
      expect(queue.peakBufferedBytes).toBeLessThanOrEqual(RECEIVE_MAX_PENDING_BYTES);
      await audit(receiver, fileBytes);
    } finally { sender.dispose(); await result; await queue.stop(); await receiver.store.delete(); }
  });

  it("reconnects after a batched durable ACK is lost without resending that batch", async () => {
    const { source, manifest, fileBytes } = await fixture();
    const repository = new MemoryBlockStoreRepository();
    const options = { backend: "memory" as const, memoryRepository: repository };
    const receiver = await OfflineDestinationReceiver.open(manifest, options);
    const channel = new ControlledChannel();
    const sender = new OfflineSourceSender(channel as unknown as RTCDataChannel, source, manifest);
    const queue = makeQueue(receiver, channel, sender);
    const result = sender.run(new AbortController().signal).catch(error => error);
    let resumed: OfflineDestinationReceiver | undefined;
    let second: OfflineSourceSender | undefined;
    let nextQueue: DurableReceiveQueue | undefined;
    let nextResult: Promise<unknown> | undefined;
    try {
      await holdAtDurableBatch(channel, queue, receiver, sender);
      channel.disconnect();
      expect(await result).toBeInstanceOf(Error);
      expect(sender.isPayloadComplete).toBe(false);
      expect(completed(channel)).toEqual([]);
      await queue.stop(); await receiver.store.close();
      resumed = await OfflineDestinationReceiver.open(manifest, options);
      expect(resumed.resumeRanges()).toEqual([[0, 64]]);
      const next = new ControlledChannel();
      second = new OfflineSourceSender(next as unknown as RTCDataChannel, source, manifest);
      second.applyResumeRanges(resumed.resumeRanges());
      const progress: OfflineTransferProgress[] = [];
      nextQueue = makeQueue(resumed, next, second);
      nextResult = second.run(new AbortController().signal, p => progress.push(p)).catch(error => error);
      const count = resumed.store.totalBlocks - 64;
      await next.until(() => next.packets.length === count);
      expect(indices(next)).toEqual(Array.from({ length: count }, (_, i) => i + 64));
      for (const packet of next.packets) nextQueue.enqueue(packet);
      await nextQueue.finish();
      for (const ack of next.acks) second.acknowledge(ack);
      expect(await nextResult).toBeUndefined();
      expect(indices(next)).toEqual(Array.from({ length: count }, (_, i) => i + 64));
      expect(progress[0]).toMatchObject({ completedBytes: 64 * manifest.blockSize, resumedBytes: 64 * manifest.blockSize });
      expect(progress.at(-1)?.completedBytes).toBe(manifest.totalBytes);
      expect(completed(next)).toEqual([{ type: "sender-complete" }]);
      await audit(resumed, fileBytes);
    } finally {
      sender.dispose(); second?.dispose(); await result; await nextResult;
      await queue.stop(); await nextQueue?.stop(); await (resumed ?? receiver).store.delete();
    }
  });
});
