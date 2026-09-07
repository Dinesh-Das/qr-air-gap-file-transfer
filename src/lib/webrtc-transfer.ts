import { sha256 } from "@noble/hashes/sha2.js";
import type { BlockStore, OpenBlockStoreOptions } from "./block-store";
import { openBlockStore } from "./block-store";
import {
  readPreparedLargeRange,
  type PreparedLargeSource,
  type RandomAccessReader,
} from "./large-transfer";
import {
  OFFLINE_BLOCK_BYTES,
  applyReceiptRanges,
  bytesToHex,
  decodeOfflineDataBlock,
  encodeOfflineControl,
  encodeOfflineDataBlock,
  isReceiptBitSet,
  receiptBitsToRanges,
  type OfflineTransferManifest,
} from "./webrtc-protocol";

const MAX_IN_FLIGHT_BLOCKS = 96;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const LOW_BUFFERED_BYTES = 2 * 1024 * 1024;

export interface OfflineTransferProgress {
  completedBytes: number;
  totalBytes: number;
  completedBlocks: number;
  totalBlocks: number;
  resumedBytes: number;
}

export class OfflineSourceSender {
  private readonly totalBlocks: number;
  private readonly receipts: Uint8Array;
  private readonly inFlight = new Set<number>();
  private readonly waiters = new Set<() => void>();
  private resumedBytes = 0;
  private acknowledgedBytes = 0;
  private acknowledgedBlocks = 0;
  private paused = false;
  private failed?: Error;
  private running = false;
  private progressCallback?: (progress: OfflineTransferProgress) => void;
  private lastProgressAt = 0;

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly source: PreparedLargeSource,
    readonly manifest: OfflineTransferManifest,
  ) {
    this.totalBlocks = Math.ceil(manifest.totalBytes / manifest.blockSize);
    this.receipts = new Uint8Array(Math.ceil(this.totalBlocks / 8));
    this.channel.bufferedAmountLowThreshold = LOW_BUFFERED_BYTES;
    this.channel.addEventListener("bufferedamountlow", this.wake);
    this.channel.addEventListener("close", this.onClose);
    this.channel.addEventListener("error", this.onClose);
  }

  applyResumeRanges(ranges: ReadonlyArray<readonly [number, number]>): void {
    if (this.running) throw new Error("Resume state arrived after transmission started.");
    applyReceiptRanges(this.receipts, ranges, this.totalBlocks);
  }

  acknowledge(indices: readonly number[]): void {
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.totalBlocks) {
        this.fail(new Error("The receiver acknowledged an invalid block."));
        return;
      }
      if (!this.inFlight.delete(index)) continue;
      setReceiptBit(this.receipts, index);
      this.acknowledgedBytes += blockLength(index, this.manifest.totalBytes, this.manifest.blockSize);
      this.acknowledgedBlocks += 1;
    }
    this.report(this.progressCallback);
    this.wake();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.wake();
  }

  fail(error: Error): void {
    this.failed ??= error;
    this.wake();
  }

  async run(
    signal: AbortSignal,
    onProgress?: (progress: OfflineTransferProgress) => void,
  ): Promise<void> {
    if (this.running) throw new Error("The transfer is already running.");
    this.running = true;
    this.progressCallback = onProgress;
    this.resumedBytes = countReceiptBytes(
      this.receipts,
      this.totalBlocks,
      this.manifest.totalBytes,
      this.manifest.blockSize,
    );
    this.acknowledgedBlocks = countReceiptBits(this.receipts, this.totalBlocks);
    this.acknowledgedBytes = this.resumedBytes;
    this.report(onProgress, true);

    for (let index = 0; index < this.totalBlocks; index += 1) {
      if (isReceiptBitSet(this.receipts, index)) continue;
      await this.waitUntilWritable(signal);
      const offset = index * this.manifest.blockSize;
      const length = blockLength(index, this.manifest.totalBytes, this.manifest.blockSize);
      const payload = await readPreparedLargeRange(this.source, BigInt(offset), length);
      throwIfAborted(signal);
      if (this.channel.readyState !== "open") throw new Error("The local connection closed.");
      const encoded = encodeOfflineDataBlock(index, payload);
      this.channel.send(encoded.buffer as ArrayBuffer);
      this.inFlight.add(index);
    }

    while (this.inFlight.size > 0) {
      await this.waitForWake(signal);
      this.throwIfFailed();
      this.report(onProgress);
    }
    this.report(onProgress, true);
    this.channel.send(encodeOfflineControl({ type: "sender-complete" }));
  }

  dispose(): void {
    this.channel.removeEventListener("bufferedamountlow", this.wake);
    this.channel.removeEventListener("close", this.onClose);
    this.channel.removeEventListener("error", this.onClose);
    this.progressCallback = undefined;
    this.fail(new Error("Transfer stopped."));
  }

  private async waitUntilWritable(signal: AbortSignal): Promise<void> {
    while (
      this.paused ||
      this.inFlight.size >= MAX_IN_FLIGHT_BLOCKS ||
      this.channel.bufferedAmount >= MAX_BUFFERED_BYTES
    ) {
      await this.waitForWake(signal);
      this.throwIfFailed();
    }
    this.throwIfFailed();
  }

  private waitForWake(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", onAbort);
        this.waiters.delete(finish);
        resolve();
      };
      const onAbort = () => {
        this.waiters.delete(finish);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      this.waiters.add(finish);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private readonly wake = () => {
    for (const waiter of [...this.waiters]) waiter();
  };

  private readonly onClose = () => {
    this.fail(new Error("The local WebRTC connection closed."));
  };

  private throwIfFailed(): void {
    if (this.failed) throw this.failed;
  }

  private report(
    callback?: (progress: OfflineTransferProgress) => void,
    force = false,
  ): void {
    const now = Date.now();
    if (!force && now - this.lastProgressAt < 100) return;
    this.lastProgressAt = now;
    callback?.({
      completedBytes: this.acknowledgedBytes,
      totalBytes: this.manifest.totalBytes,
      completedBlocks: this.acknowledgedBlocks,
      totalBlocks: this.totalBlocks,
      resumedBytes: this.resumedBytes,
    });
  }
}

export class OfflineDestinationReceiver {
  private constructor(
    readonly store: BlockStore,
    readonly manifest: OfflineTransferManifest,
  ) {}

  static async open(
    manifest: OfflineTransferManifest,
    options: OpenBlockStoreOptions = {},
  ): Promise<OfflineDestinationReceiver> {
    const store = await openBlockStore(
      {
        storeId: `webrtc:${manifest.manifestId}`,
        totalBytes: manifest.totalBytes,
        blockSize: manifest.blockSize,
      },
      { requestPersistence: true, checkQuota: true, ...options },
    );
    return new OfflineDestinationReceiver(store, manifest);
  }

  resumeRanges(): Array<[number, number]> {
    const checkpoint = this.store.checkpoint();
    return receiptBitsToRanges(checkpoint.receivedBlockBits, checkpoint.totalBlocks);
  }

  progress(resumedBytes = 0): OfflineTransferProgress {
    const progress = this.store.progress();
    return {
      completedBytes: progress.receivedBytes,
      totalBytes: progress.totalBytes,
      completedBlocks: progress.receivedBlocks,
      totalBlocks: progress.totalBlocks,
      resumedBytes,
    };
  }

  async acceptData(value: ArrayBuffer): Promise<number> {
    const { index, payload } = decodeOfflineDataBlock(value);
    if (index >= this.store.totalBlocks) throw new Error("Received block is outside the transfer.");
    const expected = blockLength(index, this.manifest.totalBytes, this.manifest.blockSize);
    if (payload.byteLength !== expected) throw new Error("Received block has the wrong length.");
    await this.store.writeBlock(index, payload);
    return index;
  }

  async verify(
    signal: AbortSignal,
    onProgress?: (bytes: number, total: number) => void,
  ): Promise<RandomAccessReader> {
    const checkpoint = this.store.checkpoint();
    if (!checkpoint.complete) throw new Error("The sender finished before all blocks arrived.");
    const hasher = sha256.create();
    const stream = await this.store.createReadStream({ chunkBytes: 4 * 1024 * 1024 });
    const reader = stream.getReader();
    let completed = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const next = await reader.read();
        if (next.done) break;
        hasher.update(next.value);
        completed += next.value.byteLength;
        onProgress?.(completed, this.manifest.totalBytes);
      }
    } finally {
      reader.releaseLock();
    }
    if (bytesToHex(hasher.digest()) !== this.manifest.streamSha256) {
      throw new Error("The complete stream failed its SHA-256 integrity check.");
    }
    return {
      size: BigInt(this.manifest.totalBytes),
      read: (offset, length) => {
        const numericOffset = Number(offset);
        if (!Number.isSafeInteger(numericOffset)) throw new Error("Invalid read offset.");
        return this.store.readRange(numericOffset, length);
      },
    };
  }
}

function countReceiptBits(bits: Uint8Array, totalBlocks: number): number {
  let count = 0;
  for (let index = 0; index < totalBlocks; index += 1) {
    if (isReceiptBitSet(bits, index)) count += 1;
  }
  return count;
}

function countReceiptBytes(
  bits: Uint8Array,
  totalBlocks: number,
  totalBytes: number,
  blockSize: number,
): number {
  let count = 0;
  for (let index = 0; index < totalBlocks; index += 1) {
    if (isReceiptBitSet(bits, index)) count += blockLength(index, totalBytes, blockSize);
  }
  return count;
}

function setReceiptBit(bits: Uint8Array, index: number): void {
  bits[index >>> 3] |= 1 << (index & 7);
}

function blockLength(index: number, totalBytes: number, blockSize: number): number {
  return Math.min(blockSize, totalBytes - index * blockSize);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
