import { sha256 } from "@noble/hashes/sha2.js";
import type { BlockStore, OpenBlockStoreOptions } from "./block-store";
import { openBlockStore, discardOpfsBlockStore } from "./block-store";
import {
  readPreparedLargeRange,
  type PreparedLargeSource,
  type RandomAccessReader,
} from "./large-transfer";
import {
  OFFLINE_MAX_RESUME_RANGES,
  applyReceiptRanges,
  bytesToHex,
  decodeOfflineDataBlockAsync,
  encodeOfflineControl,
  encodeOfflineDataBlock,
  isReceiptBitSet,
  receiptBitsToRanges,
  receiptBitsToRangePages,
  type OfflineTransferManifest,
} from "./webrtc-protocol";

const MAX_IN_FLIGHT_BLOCKS = 96;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const LOW_BUFFERED_BYTES = 2 * 1024 * 1024;
const SILENT_CHANNEL_WAIT_MS = 120_000;

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
  private payloadComplete = false;
  private resumeEnd = 0;
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
    if (ranges.length > OFFLINE_MAX_RESUME_RANGES) throw new Error("Too many resume ranges.");
    let end = this.resumeEnd;
    for (const [start, nextEnd] of ranges) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(nextEnd) || start < end || nextEnd <= start || nextEnd > this.totalBlocks) {
        throw new Error("Resume ranges must be ordered, non-overlapping and inside this transfer.");
      }
      end = nextEnd;
    }
    applyReceiptRanges(this.receipts, ranges, this.totalBlocks);
    this.resumeEnd = end;
  }

  get isPayloadComplete(): boolean { return this.payloadComplete; }

  acknowledge(indices: readonly number[]): void {
    let advanced = false;
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.totalBlocks) {
        this.fail(new Error("The receiver acknowledged an invalid block."));
        return;
      }
      if (!this.inFlight.delete(index)) {
        if (isReceiptBitSet(this.receipts, index)) continue;
        this.fail(new Error("The receiver acknowledged a block that was not sent."));
        return;
      }
      setReceiptBit(this.receipts, index);
      this.acknowledgedBytes += blockLength(index, this.manifest.totalBytes, this.manifest.blockSize);
      this.acknowledgedBlocks += 1;
      advanced = true;
    }
    if (advanced) {
      this.report(this.progressCallback);
      this.wake();
    }
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
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
    throwIfAborted(signal);
    this.throwIfFailed();
    const assertSourceActive = () => {
      throwIfAborted(signal);
      this.throwIfFailed();
    };
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
      // A resolved window wait can race with Stop or connection failure before
      // this continuation runs. Do not start a new snapshot read afterward.
      throwIfAborted(signal);
      this.throwIfFailed();
      const offset = index * this.manifest.blockSize;
      const length = blockLength(index, this.manifest.totalBytes, this.manifest.blockSize);
      const payload = await readPreparedLargeRange(this.source, BigInt(offset), length, assertSourceActive);
      throwIfAborted(signal);
      this.throwIfFailed();
      if (this.channel.readyState !== "open") throw new Error("The local connection closed.");
      const encoded = encodeOfflineDataBlock(index, payload);
      this.inFlight.add(index);
      this.channel.send(encoded.buffer as ArrayBuffer);
    }

    while (this.inFlight.size > 0) {
      await this.waitForWake(signal);
      this.throwIfFailed();
      this.report(onProgress);
    }
    this.report(onProgress, true);
    this.throwIfFailed();
    throwIfAborted(signal);
    this.payloadComplete = true;
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
    this.throwIfFailed();
    throwIfAborted(signal);
    return new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        this.waiters.delete(finish);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      this.waiters.add(finish);
      signal.addEventListener("abort", onAbort, { once: true });
      if (!this.paused) timeout = setTimeout(() => {
        cleanup();
        const error = new Error("The receiver stopped responding for two minutes. Reconnect to resume from its saved progress.");
        this.fail(error);
        reject(error);
      }, SILENT_CHANNEL_WAIT_MS);
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

function offlineTransferStoreId(manifest: OfflineTransferManifest): string {
  return `webrtc:${manifest.manifestId}`;
}

export class OfflineDestinationReceiver {
  static async discardStoredCopy(manifest: OfflineTransferManifest): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(manifest.manifestId)) throw new Error("Invalid transfer identity.");
    await discardOpfsBlockStore(offlineTransferStoreId(manifest));
  }
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
        storeId: offlineTransferStoreId(manifest),
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

  resumeRangePages(): Iterable<Array<[number, number]>> {
    const checkpoint = this.store.checkpoint();
    return receiptBitsToRangePages(checkpoint.receivedBlockBits, checkpoint.totalBlocks);
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
    return (await this.acceptBatch([value]))[0];
  }

  async acceptBatch(values: readonly ArrayBuffer[]): Promise<number[]> {
    if (values.length < 1 || values.length > 128) throw new Error("Invalid receive batch size.");
    // Validate the entire bounded batch before starting any writes. A corrupt
    // payload cannot cause an ACK for this group, even if earlier groups exist.
    const blocks = await Promise.all(values.map(async (value) => {
      const { index, payload } = await decodeOfflineDataBlockAsync(value);
      if (index >= this.store.totalBlocks) throw new Error("Received block is outside the transfer.");
      const expected = blockLength(index, this.manifest.totalBytes, this.manifest.blockSize);
      if (payload.byteLength !== expected) throw new Error("Received block has the wrong length.");
      return { index, bytes: payload };
    }));
    await this.store.writeBlocks(blocks);
    return [...new Set(blocks.map(({ index }) => index))];
  }

  async verify(
    signal: AbortSignal,
    onProgress?: (bytes: number, total: number) => void,
  ): Promise<RandomAccessReader> {
    const checkpoint = this.store.checkpoint();
    if (!checkpoint.complete) throw new Error("The sender finished before all blocks arrived.");
    throwIfAborted(signal);
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
      // Releasing a reader leaves prefetched bytes queued on an interrupted
      // stream. Cancel it first; cleanup must preserve the verification error.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    throwIfAborted(signal);
    if (completed !== this.manifest.totalBytes || bytesToHex(hasher.digest()) !== this.manifest.streamSha256) {
      // Receipt bits prove durable writes, not authoritative stream integrity.
      // Remove the poisoned receipts while we still own the store's lifetime
      // lock, before the component closes it or a reconnect can advertise them.
      try {
        await this.store.delete();
      } catch (cause) {
        throw new Error(
          "Stored transfer data failed integrity verification. Temporary storage could not be discarded; clear this app's temporary transfer storage before retrying.",
          { cause },
        );
      }
      throw new Error("Stored transfer data failed integrity verification and was discarded. Reconnect to retransmit.");
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
