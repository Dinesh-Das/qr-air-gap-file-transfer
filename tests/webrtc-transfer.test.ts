import { describe, expect, it } from "vitest";
import { prepareLargeSource, readLargeTreeManifest, readPreparedLargeRange, type LargeSourceSelection } from "../src/lib/large-transfer";
import { createOfflineTransferManifest, decodeOfflineControl, OFFLINE_BLOCK_BYTES } from "../src/lib/webrtc-protocol";
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

function selectionWithLargeFile(): LargeSourceSelection {
  const bytes = Uint8Array.from({ length: OFFLINE_BLOCK_BYTES * 2 + 777 }, (_, index) => (index * 37) & 0xff);
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

  it("rejects an incomplete durable stream", async () => {
    const source = await prepareLargeSource(selectionWithLargeFile());
    const manifest = await createOfflineTransferManifest(source);
    const receiver = await OfflineDestinationReceiver.open(manifest, { backend: "memory" });
    await expect(receiver.verify(new AbortController().signal)).rejects.toThrow(/before all blocks/i);
    await receiver.store.delete();
  });
});
