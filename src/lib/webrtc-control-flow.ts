import { encodeOfflineControl, type OfflineControlMessage } from "./webrtc-protocol";

export const MAX_CONTROL_BUFFER_BYTES = 1024 * 1024;
const RESUME_HIGH_WATER = 256 * 1024;
const RESUME_LOW_WATER = 64 * 1024;

export function sendBoundedControl(channel: RTCDataChannel, message: OfflineControlMessage): void {
  if (channel.readyState !== "open") throw new Error("The local connection closed.");
  const encoded = encodeOfflineControl(message);
  if (channel.bufferedAmount + new TextEncoder().encode(encoded).byteLength > MAX_CONTROL_BUFFER_BYTES) {
    throw new Error("The connection is not accepting acknowledgements. Reconnect to resume.");
  }
  channel.send(encoded);
}

export async function sendResumeState(
  channel: RTCDataChannel,
  pages: Iterable<Array<[number, number]>>,
  signal?: AbortSignal,
): Promise<void> {
  channel.bufferedAmountLowThreshold = RESUME_LOW_WATER;
  for (const ranges of pages) {
    await waitForControlDrain(channel, signal);
    if (signal?.aborted) throw signal.reason ?? new DOMException("Stopped", "AbortError");
    sendBoundedControl(channel, { type: "resume-ranges", ranges });
  }
  await waitForControlDrain(channel, signal);
  if (signal?.aborted) throw signal.reason ?? new DOMException("Stopped", "AbortError");
  sendBoundedControl(channel, { type: "resume-complete" });
}

async function waitForControlDrain(channel: RTCDataChannel, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Stopped", "AbortError");
  if (channel.readyState !== "open") throw new Error("The local connection closed.");
  if (channel.bufferedAmount < RESUME_HIGH_WATER) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      channel.removeEventListener("bufferedamountlow", drained);
      channel.removeEventListener("close", closed);
      channel.removeEventListener("error", closed);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const drained = () => { if (channel.bufferedAmount < RESUME_HIGH_WATER) finish(); };
    const closed = () => finish(new Error("The local connection closed while resuming."));
    const aborted = () => finish(signal?.reason ?? new DOMException("Stopped", "AbortError"));
    const timer = setTimeout(() => finish(new Error("The connection stopped accepting resume information. Reconnect to retry.")), 30_000);
    channel.addEventListener("bufferedamountlow", drained);
    channel.addEventListener("close", closed);
    channel.addEventListener("error", closed);
    signal?.addEventListener("abort", aborted, { once: true });
  });
  if (signal?.aborted) throw signal.reason ?? new DOMException("Stopped", "AbortError");
}
