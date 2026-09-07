import { describe, expect, it } from "vitest";
import {
  OfflineSignalAccumulator,
  createAuthenticationCode,
  encodeOfflineSignal,
  limitSdpToLocalCandidates,
  waitForIceGatheringComplete,
  type OfflineSignalBundle,
} from "../src/lib/webrtc-signaling";

const offer: OfflineSignalBundle = {
  v: 1,
  kind: "offer",
  sessionId: "0123456789abcdef0123456789abcdef",
  sdp: "v=0\r\n" + Array.from(
    { length: 120 },
    (_, index) => `a=candidate:${index} 1 UDP ${2_000_000_000 - index} 192.168.${index % 255}.${(index * 17) % 255} ${5000 + index} typ host ufrag id${index}\r\n`,
  ).join(""),
};

describe("WebRTC QR signaling", () => {
  it("reassembles duplicate, out-of-order frames", () => {
    const frames = encodeOfflineSignal(offer);
    expect(frames.length).toBeGreaterThan(1);
    const accumulator = new OfflineSignalAccumulator();
    accumulator.accept(frames.at(-1)!);
    accumulator.accept(frames.at(-1)!);
    let result;
    for (const frame of frames.slice(0, -1).reverse()) result = accumulator.accept(frame);
    expect(result?.complete).toBe(true);
    expect(result?.bundle).toEqual(offer);
  });

  it("rejects a frame from another session", () => {
    const accumulator = new OfflineSignalAccumulator();
    accumulator.accept(encodeOfflineSignal(offer)[0]);
    const other = encodeOfflineSignal({ ...offer, sessionId: "f".repeat(32) })[0];
    expect(() => accumulator.accept(other)).toThrow(/different/i);
  });

  it("rejects an oversized individual QR frame", () => {
    const frame = `WRS1|O|${"0".repeat(32)}|0|1|00000000|${"A".repeat(751)}`;
    expect(() => new OfflineSignalAccumulator().accept(frame)).toThrow(/frame number/i);
  });

  it("produces the same authentication code for the same transcript", async () => {
    const first = await createAuthenticationCode(offer.sessionId, offer.sdp, "answer");
    const second = await createAuthenticationCode(offer.sessionId, offer.sdp, "answer");
    expect(first).toMatch(/^\d{6}$/);
    expect(first).toBe(second);
  });

  it("shares only private host candidates", () => {
    const sdp = [
      "v=0",
      "a=candidate:1 1 UDP 1 192.168.1.2 5000 typ host",
      "a=candidate:2 1 UDP 1 203.0.113.4 5001 typ host",
      "a=candidate:3 1 UDP 1 198.51.100.8 5002 typ srflx",
      "a=candidate:4 1 UDP 1 deadbeef.local 5003 typ host",
      "",
    ].join("\r\n");
    const limited = limitSdpToLocalCandidates(sdp);
    expect(limited).toContain("192.168.1.2");
    expect(limited).toContain("deadbeef.local");
    expect(limited).not.toContain("203.0.113.4");
    expect(limited).not.toContain("srflx");
  });

  it("refuses signaling when no private candidate is available", () => {
    expect(() => limitSdpToLocalCandidates([
      "v=0",
      "a=candidate:1 1 UDP 1 203.0.113.4 5001 typ host",
      "",
    ].join("\r\n"))).toThrow(/private-network/i);
  });

  it("does not wait when ICE gathering is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(waitForIceGatheringComplete(
      { iceGatheringState: "gathering" } as RTCPeerConnection,
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});
