import { expect, it } from "vitest";
import { benchmarkTransportSnapshot } from "../scripts/benchmark-transport.mjs";

it("correlates selected pairs and retains transport/data-channel counters without addresses or labels", () => {
  const report = new Map([
    ["t", { type: "transport", id: "t", selectedCandidatePairId: "p", dtlsState: "connected", bytesSent: 400, iceLocalUsernameFragment: "private" }],
    ["p", { type: "candidate-pair", id: "p", state: "succeeded", nominated: true, bytesSent: 300, packetsDiscardedOnSend: 2, bytesDiscardedOnSend: 2420, currentRoundTripTime: 0.002, localCandidateId: "local" }],
    ["d", { type: "data-channel", id: "d", state: "open", messagesSent: 5, bytesSent: 250, label: "private-file-name" }],
    ["local", { type: "local-candidate", id: "local", address: "192.168.1.2", url: "private" }],
  ]);
  expect(benchmarkTransportSnapshot(report)).toEqual({
    transports: [{ id: "t", selectedCandidatePairId: "p", dtlsState: "connected", bytesSent: 400 }],
    candidatePairs: [{ id: "p", selected: true, state: "succeeded", nominated: true, bytesSent: 300, packetsDiscardedOnSend: 2, bytesDiscardedOnSend: 2420, currentRoundTripTime: 0.002 }],
    dataChannels: [{ id: "d", state: "open", messagesSent: 5, bytesSent: 250 }],
  });
});

it("distinguishes unsupported counters from real zero and excludes invalid numeric readings", () => {
  const value = benchmarkTransportSnapshot(new Map([
    ["p", { type: "candidate-pair", id: "p", bytesSent: 0, packetsDiscardedOnSend: undefined, bytesDiscardedOnSend: -1, currentRoundTripTime: NaN, availableOutgoingBitrate: Infinity }],
  ]));
  expect(value.candidatePairs).toEqual([{ id: "p", selected: false, bytesSent: 0 }]);
});

it("keeps unselected pairs separate and does not mutate the supplied report", () => {
  const p = Object.freeze({ type: "candidate-pair", id: "unselected", packetsDiscardedOnSend: 8 });
  const report = new Map([["p", p]]);
  expect(benchmarkTransportSnapshot(report).candidatePairs).toEqual([{ id: "unselected", selected: false, packetsDiscardedOnSend: 8 }]);
  expect(p).not.toHaveProperty("selected");
  expect(benchmarkTransportSnapshot(new Map())).toEqual({ transports: [], candidatePairs: [], dataChannels: [] });
});
