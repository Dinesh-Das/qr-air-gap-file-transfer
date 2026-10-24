import { afterEach, expect, it, vi } from "vitest";
import { installIceDiagnostics, type IceDiagnostics } from "../e2e/ice-diagnostics";

class Peer extends EventTarget {
  iceGatheringState = "new";
  connectionState = "new";
  signalingState = "stable";
  localDescription: { sdp: string } | null = null;
}
function install() {
  const state: { __qrftIceDiagnostics?: IceDiagnostics; __qrftObservePeer?: (peer: RTCPeerConnection) => void } = {};
  vi.stubGlobal("window", state); installIceDiagnostics();
  return { report: state.__qrftIceDiagnostics!, observe: (peer: Peer) => state.__qrftObservePeer!(peer as unknown as RTCPeerConnection) };
}
afterEach(() => vi.unstubAllGlobals());

it("retains a completed native description with zero candidates", () => {
  const { report, observe } = install(), peer = new Peer(); observe(peer);
  peer.localDescription = { sdp: "v=0\r\na=ice-pwd:do-not-record\r\n" };
  peer.iceGatheringState = "complete"; peer.dispatchEvent(new Event("icegatheringstatechange"));
  expect(report.peers[0].descriptions.at(-1)).toMatchObject({ state: "complete", candidateLineCount: 0, candidateLines: [], clipped: false });
  expect(JSON.stringify(report)).not.toContain("do-not-record");
});

it("preserves private and public candidates without applying the product policy", () => {
  const { report, observe } = install(), peer = new Peer(); observe(peer);
  const lines = ["a=candidate:1 1 UDP 1 192.168.1.2 1234 typ host", "a=candidate:2 1 UDP 1 203.0.113.2 5678 typ host"];
  peer.localDescription = { sdp: "v=0\r\n" + lines.join("\r\n") + "\r\n" };
  peer.dispatchEvent(new Event("icegatheringstatechange"));
  expect(report.peers[0].descriptions.at(-1)?.candidateLines).toEqual(lines);
});

it("redacts ICE credential extensions in both candidate events and descriptions", () => {
  const { report, observe } = install(), peer = new Peer(); observe(peer);
  const candidate = "candidate:1 1 UDP 1 192.168.1.2 1234 typ host ufrag secret-fragment network-cost 999";
  peer.localDescription = { sdp: "v=0\r\na=" + candidate + "\r\n" };
  const event = new Event("icecandidate"); Object.defineProperty(event, "candidate", { value: { candidate } });
  peer.dispatchEvent(event);
  expect(JSON.stringify(report)).not.toContain("secret-fragment");
  expect(report.peers[0].descriptions.at(-1)?.candidateLines).toEqual([
    "a=candidate:1 1 UDP 1 192.168.1.2 1234 typ host ufrag [redacted] network-cost 999",
  ]);
});

it("bounds peers, events and candidate snapshots and labels clipping", () => {
  const { report, observe } = install(), peer = new Peer(); observe(peer);
  peer.localDescription = { sdp: Array.from({ length: 65 }, () => "a=candidate:" + "x".repeat(600)).join("\r\n") };
  for (let i = 0; i < 40; i++) peer.dispatchEvent(new Event("icegatheringstatechange"));
  for (let i = 0; i < 16; i++) observe(new Peer());
  expect(report.peers).toHaveLength(16); expect(report.droppedPeers).toBe(1);
  const row = report.peers[0]; expect(row.events).toHaveLength(32); expect(row.droppedEvents).toBe(9);
  expect(row.descriptions).toHaveLength(4); expect(row.descriptions[0]).toMatchObject({ candidateLineCount: 65, clipped: true });
  expect(row.descriptions[0].candidateLines).toHaveLength(64);
  expect(row.descriptions[0].candidateLines.every(line => line.length <= 512)).toBe(true);
});

it("keeps the last description if a later native description read fails", () => {
  const { report, observe } = install(), peer = new Peer(); observe(peer);
  peer.localDescription = { sdp: "v=0\r\n" }; peer.dispatchEvent(new Event("icegatheringstatechange"));
  Object.defineProperty(peer, "localDescription", { get() { throw Error("native read unavailable"); } });
  expect(() => peer.dispatchEvent(new Event("connectionstatechange"))).not.toThrow();
  expect(report.peers[0].descriptions).toHaveLength(1);
  expect(report.peers[0].readError).toContain("native read unavailable");
});
