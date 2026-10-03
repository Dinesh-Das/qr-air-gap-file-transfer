import { OFFLINE_BLOCK_BYTES, OFFLINE_DATA_HEADER_BYTES } from "./webrtc-protocol";

export const RECEIVE_BATCH_BLOCKS = 64;
export const RECEIVE_COMMIT_INTERVAL_MS = 75;
// Includes the active commit, not just waiting messages. Normal sender window:
// 96 blocks. The extra window allows bounded duplicates without growing RAM.
export const RECEIVE_MAX_PENDING_BLOCKS = 192;
export const RECEIVE_MAX_PENDING_BYTES = RECEIVE_MAX_PENDING_BLOCKS * (OFFLINE_BLOCK_BYTES + OFFLINE_DATA_HEADER_BYTES);

interface Receiver { acceptBatch(values: readonly ArrayBuffer[]): Promise<number[]>; }
interface Options {
  batchBlocks?: number;
  commitIntervalMs?: number;
  onCommitted: (indices: number[]) => void;
  onError: (error: Error) => void;
}

/** One commit task and timer per connection; no Promise or ACK per payload. */
export class DurableReceiveQueue {
  private readonly batchBlocks: number;
  private readonly commitIntervalMs: number;
  private pending: ArrayBuffer[] = [];
  private retainedBlocks = 0;
  private retainedBytes = 0;
  private peakBytes = 0;
  private oldestPendingAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private flushRequested = false;
  private completing = false;
  private stopped = false;
  private error?: Error;

  constructor(private readonly receiver: Receiver, private readonly options: Options) {
    this.batchBlocks = options.batchBlocks ?? RECEIVE_BATCH_BLOCKS;
    this.commitIntervalMs = options.commitIntervalMs ?? RECEIVE_COMMIT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.batchBlocks) || this.batchBlocks < 1 || this.batchBlocks > 128 ||
        !Number.isFinite(this.commitIntervalMs) || this.commitIntervalMs < 1 || this.commitIntervalMs > 1000) {
      throw new Error("Invalid durable receive queue configuration.");
    }
  }

  get bufferedBytes(): number { return this.retainedBytes; }
  get peakBufferedBytes(): number { return this.peakBytes; }

  enqueue(value: ArrayBuffer): void {
    if (this.stopped || this.completing) throw this.error ?? new Error("The receive queue is closed.");
    if (!(value instanceof ArrayBuffer) || value.byteLength <= OFFLINE_DATA_HEADER_BYTES ||
        value.byteLength > OFFLINE_BLOCK_BYTES + OFFLINE_DATA_HEADER_BYTES) {
      throw new Error("Received data has an invalid message size.");
    }
    if (this.retainedBlocks >= RECEIVE_MAX_PENDING_BLOCKS ||
        this.retainedBytes + value.byteLength > RECEIVE_MAX_PENDING_BYTES) {
      throw new Error("The sender exceeded the bounded receive window. Reconnect to resume.");
    }
    if (this.pending.length === 0) this.oldestPendingAt = Date.now();
    this.pending.push(value);
    this.retainedBlocks += 1;
    this.retainedBytes += value.byteLength;
    this.peakBytes = Math.max(this.peakBytes, this.retainedBytes);
    if (this.pending.length >= this.batchBlocks) this.flushRequested = true;
    this.schedule();
  }

  async finish(): Promise<void> {
    if (this.stopped) throw this.error ?? new Error("The receive queue is closed.");
    this.completing = true;
    this.flushRequested = true;
    this.schedule();
    // Includes any work enqueued before the completion marker.
    while (this.active) await this.active;
    if (this.error) throw this.error;
    if (this.stopped) throw new Error("The receive queue was stopped.");
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    for (const value of this.pending) {
      this.retainedBytes -= value.byteLength;
      this.retainedBlocks -= 1;
    }
    this.pending = [];
    // Let any already-started durable commit settle. It must not ACK after
    // cancellation; reopening will discover whatever actually committed.
    return this.active ?? Promise.resolve();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.stopped || this.pending.length === 0) { this.clearTimer(); return; }
    if (this.flushRequested || this.completing || this.pending.length >= this.batchBlocks) {
      this.clearTimer();
      if (!this.active) {
        this.active = Promise.resolve().then(() => this.drain()).catch((caught: unknown) => {
          this.error = caught instanceof Error ? caught : new Error(String(caught));
          void this.stop();
          this.options.onError(this.error);
        }).finally(() => { this.active = undefined; this.schedule(); });
      }
    } else if (this.timer === undefined) {
      const delay = Math.max(0, this.commitIntervalMs - (Date.now() - this.oldestPendingAt));
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flushRequested = true;
        this.schedule();
      }, delay);
    }
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.pending.length > 0 &&
      (this.flushRequested || this.completing || this.pending.length >= this.batchBlocks)) {
      this.flushRequested = false;
      const values = this.pending.splice(0, this.batchBlocks);
      const bytes = values.reduce((sum, value) => sum + value.byteLength, 0);
      let indices: number[];
      try {
        indices = await this.receiver.acceptBatch(values);
      } finally {
        this.retainedBlocks -= values.length;
        this.retainedBytes -= bytes;
      }
      if (!this.stopped) this.options.onCommitted(indices);
    }
  }
}
