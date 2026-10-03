import { describe, expect, it } from "vitest";
import { sendBoundedControl, sendResumeState, MAX_CONTROL_BUFFER_BYTES } from "../src/lib/webrtc-control-flow";
import { receiptBitsToRangePages, OFFLINE_MAX_RESUME_RANGES } from "../src/lib/webrtc-protocol";

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  messages: string[] = [];
  send(value: string) { this.messages.push(value); }
}

describe("bounded resume control flow", () => {
  it("pages highly fragmented receipt state", () => {
    const bits = new Uint8Array(1250).fill(0x55);
    const pages = [...receiptBitsToRangePages(bits, 10_000)];
    expect(pages.every((page) => page.length <= OFFLINE_MAX_RESUME_RANGES)).toBe(true);
    expect(pages.flat()).toEqual(Array.from({ length: 5000 }, (_, i) => [i * 2, i * 2 + 1]));
    expect([...receiptBitsToRangePages(new Uint8Array(1), 8)]).toEqual([]);
  });

  it("waits for channel backpressure before sending resume pages and completion", async () => {
    const channel = new Channel();
    channel.bufferedAmount = 256 * 1024;
    const task = sendResumeState(channel as unknown as RTCDataChannel, [[[1, 3]]]);
    expect(channel.messages).toEqual([]);
    channel.bufferedAmount = 0;
    channel.dispatchEvent(new Event("bufferedamountlow"));
    await task;
    expect(channel.messages.map((value) => JSON.parse(value))).toEqual([
      { type: "resume-ranges", ranges: [[1, 3]] }, { type: "resume-complete" },
    ]);
  });

  it.each([0, 256 * 1024])("cancels without transmitting a stale resume message at buffered amount %i", async (bufferedAmount) => {
    const channel = new Channel();
    channel.bufferedAmount = bufferedAmount;
    const controller = new AbortController();
    const task = sendResumeState(channel as unknown as RTCDataChannel, [[[1, 3]]], controller.signal);
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(channel.messages).toEqual([]);
  });

  it("fails closed instead of growing an unbounded acknowledgement buffer", () => {
    const channel = new Channel();
    channel.bufferedAmount = MAX_CONTROL_BUFFER_BYTES;
    expect(() => sendBoundedControl(channel as unknown as RTCDataChannel, { type: "ack", indices: [0] })).toThrow(/not accepting acknowledgements/);
    expect(channel.messages).toEqual([]);
  });
});
