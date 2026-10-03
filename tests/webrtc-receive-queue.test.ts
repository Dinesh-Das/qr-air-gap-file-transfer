import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableReceiveQueue, RECEIVE_MAX_PENDING_BLOCKS, RECEIVE_MAX_PENDING_BYTES } from "../src/lib/webrtc-receive-queue";
import { decodeOfflineDataBlock, encodeOfflineDataBlock } from "../src/lib/webrtc-protocol";

function frame(index: number): ArrayBuffer { return encodeOfflineDataBlock(index, Uint8Array.of(7)).buffer as ArrayBuffer; }
function indexes(values: readonly ArrayBuffer[]): number[] { return values.map((value) => decodeOfflineDataBlock(value).index); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("bounded durable receive queue", () => {
  it("ACKs a group only after commit and flushes a short tail on the deadline", async () => {
    vi.useFakeTimers();
    const commit = deferred();
    const receiver = { acceptBatch: vi.fn(async (values: readonly ArrayBuffer[]) => { await commit.promise; return indexes(values); }) };
    const ack = vi.fn();
    const queue = new DurableReceiveQueue(receiver, { onCommitted: ack, onError: vi.fn() });
    for (let index = 0; index < 64; index += 1) queue.enqueue(frame(index));
    await Promise.resolve();
    expect(receiver.acceptBatch).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
    expect(queue.bufferedBytes).toBeGreaterThan(0);
    commit.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(ack.mock.calls[0][0]).toEqual(Array.from({ length: 64 }, (_, index) => index));
    queue.enqueue(frame(64));
    queue.enqueue(frame(65));
    await vi.advanceTimersByTimeAsync(74);
    expect(ack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ack.mock.calls[1][0]).toEqual([64, 65]);
    expect(queue.bufferedBytes).toBe(0);
    await queue.finish();
  });

  it("flushes a final short group without waiting for the timer", async () => {
    vi.useFakeTimers();
    const ack = vi.fn();
    const queue = new DurableReceiveQueue({ acceptBatch: async (values) => indexes(values) }, { onCommitted: ack, onError: vi.fn() });
    queue.enqueue(frame(0));
    await queue.finish();
    expect(ack).toHaveBeenCalledWith([0]);
    expect(() => queue.enqueue(frame(1))).toThrow(/closed/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds both an active stalled write and pending messages, then cancels without ACK", async () => {
    vi.useFakeTimers();
    const commit = deferred();
    const receiver = { acceptBatch: vi.fn(async (values: readonly ArrayBuffer[]) => { await commit.promise; return indexes(values); }) };
    const ack = vi.fn();
    const queue = new DurableReceiveQueue(receiver, { onCommitted: ack, onError: vi.fn() });
    for (let index = 0; index < 64; index += 1) queue.enqueue(frame(index));
    await Promise.resolve();
    for (let index = 64; index < RECEIVE_MAX_PENDING_BLOCKS; index += 1) queue.enqueue(frame(index));
    expect(() => queue.enqueue(frame(RECEIVE_MAX_PENDING_BLOCKS))).toThrow(/bounded receive window/);
    expect(queue.peakBufferedBytes).toBeLessThanOrEqual(RECEIVE_MAX_PENDING_BYTES);
    expect(receiver.acceptBatch).toHaveBeenCalledTimes(1);
    const stopped = queue.stop();
    commit.resolve();
    await stopped;
    expect(ack).not.toHaveBeenCalled();
    expect(queue.bufferedBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a queued tail without starting a write", async () => {
    vi.useFakeTimers();
    const receiver = { acceptBatch: vi.fn(async () => [0]) };
    const queue = new DurableReceiveQueue(receiver, { onCommitted: vi.fn(), onError: vi.fn() });
    queue.enqueue(frame(0));
    await queue.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(receiver.acceptBatch).not.toHaveBeenCalled();
    await expect(queue.finish()).rejects.toThrow(/closed/);
    expect(queue.bufferedBytes).toBe(0);
  });

  it("fails closed on journal/quota errors and drops the remaining bounded work", async () => {
    const failure = new DOMException("Disk full", "QuotaExceededError");
    const ack = vi.fn();
    const onError = vi.fn();
    const queue = new DurableReceiveQueue({ acceptBatch: async () => { throw failure; } }, { onCommitted: ack, onError });
    for (let index = 0; index < 100; index += 1) queue.enqueue(frame(index));
    await expect(queue.finish()).rejects.toBe(failure);
    expect(ack).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(queue.bufferedBytes).toBe(0);
  });

  it("rejects oversized messages before retaining or hashing them", () => {
    const queue = new DurableReceiveQueue({ acceptBatch: async () => [] }, { onCommitted: vi.fn(), onError: vi.fn() });
    expect(() => queue.enqueue(new ArrayBuffer(100_000))).toThrow(/message size/);
    expect(() => queue.enqueue(new ArrayBuffer(44))).toThrow(/message size/);
    expect(queue.bufferedBytes).toBe(0);
  });
});
