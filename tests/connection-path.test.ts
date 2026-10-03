import { expect, it } from "vitest";
import { connectionPath } from "../src/lib/connection-path";
const report = (entries: object[]) => new Map(entries.map((entry, index) => [String(index), entry])) as unknown as RTCStatsReport;
it("uses only the selected succeeded pair and converts RTT seconds", () => {
  expect(connectionPath(report([{ type: "transport", selectedCandidatePairId: "1" },
    { type: "candidate-pair", state: "succeeded", localCandidateId: "2", currentRoundTripTime: .012 },
    { type: "local-candidate", protocol: "udp" }]))).toEqual({ protocol: "UDP", roundTripMs: 12 });
});
it("does not guess an unselected or ambiguous path", () => {
  expect(connectionPath(report([{ type: "candidate-pair", state: "succeeded", currentRoundTripTime: 1 }])).roundTripMs).toBeNull();
  expect(connectionPath(report([{ type: "transport", selectedCandidatePairId: "a" }, { type: "transport", selectedCandidatePairId: "b" }])).protocol).toBe("Unavailable");
});
it.each([NaN, Infinity, -1, undefined])("rejects invalid RTT %s", (rtt) => {
  expect(connectionPath(report([{ type: "transport", selectedCandidatePairId: "1" },
    { type: "candidate-pair", state: "succeeded", currentRoundTripTime: rtt }])).roundTripMs).toBeNull();
});
