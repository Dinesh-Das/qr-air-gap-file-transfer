import { afterEach, expect, it, vi } from "vitest";
import { watchWebRtcPeerHealth } from "../src/lib/webrtc-peer-health";

class Peer extends EventTarget {
  connectionState: RTCPeerConnectionState = "connecting";
  set(state: RTCPeerConnectionState) { this.connectionState = state; this.dispatchEvent(new Event("connectionstatechange")); }
}
afterEach(() => vi.useRealTimers());

it("replaces a connecting deadline when the peer becomes disconnected", () => {
  vi.useFakeTimers(); const peer = new Peer(); const fail = vi.fn();
  const stop = watchWebRtcPeerHealth(peer as unknown as RTCPeerConnection, () => true, fail);
  vi.advanceTimersByTime(20_000);
  peer.set("disconnected");
  vi.advanceTimersByTime(10_000); expect(fail).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5_000); expect(fail).toHaveBeenCalledOnce();
  stop();
});

it("uses a new connecting deadline and does not extend it for duplicate events", () => {
  vi.useFakeTimers(); const peer = new Peer(); peer.set("disconnected"); const fail = vi.fn();
  const stop = watchWebRtcPeerHealth(peer as unknown as RTCPeerConnection, () => true, fail);
  vi.advanceTimersByTime(5_000); peer.set("connecting");
  vi.advanceTimersByTime(20_000); peer.set("connecting");
  vi.advanceTimersByTime(9_999); expect(fail).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(fail).toHaveBeenCalledOnce(); stop();
});

it("clears deadlines on recovery, cleanup, and superseded sessions", () => {
  vi.useFakeTimers(); const peer = new Peer(); const fail = vi.fn(); let current = true;
  const stop = watchWebRtcPeerHealth(peer as unknown as RTCPeerConnection, () => current, fail);
  peer.set("connected"); vi.advanceTimersByTime(30_000); expect(fail).not.toHaveBeenCalled();
  peer.set("disconnected"); current = false;
  vi.advanceTimersByTime(15_000); expect(fail).not.toHaveBeenCalled();
  current = true; peer.set("connecting"); stop();
  peer.set("failed"); vi.advanceTimersByTime(30_000); expect(fail).not.toHaveBeenCalled();
});

it("reports a failed peer immediately", () => {
  vi.useFakeTimers(); const peer = new Peer(); const fail = vi.fn();
  const stop = watchWebRtcPeerHealth(peer as unknown as RTCPeerConnection, () => true, fail);
  peer.set("failed"); expect(fail).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(30_000); expect(fail).toHaveBeenCalledOnce(); stop();
});

