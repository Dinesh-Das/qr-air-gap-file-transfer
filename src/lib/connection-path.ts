export function connectionPath(report: RTCStatsReport): { protocol: string; roundTripMs: number | null } {
  const selected = new Set<string>();
  report.forEach((entry) => {
    if (entry.type === "transport" && typeof entry.selectedCandidatePairId === "string") selected.add(entry.selectedCandidatePairId);
  });
  const unavailable = { protocol: "Unavailable", roundTripMs: null };
  if (selected.size !== 1) return unavailable;
  const pair = report.get([...selected][0]);
  if (!pair || pair.type !== "candidate-pair" || pair.state !== "succeeded") return unavailable;
  const local = report.get(pair.localCandidateId);
  const protocol = local?.type === "local-candidate" && ["udp", "tcp"].includes(local.protocol) ? local.protocol.toUpperCase() : "Unavailable";
  const seconds = pair.currentRoundTripTime;
  return { protocol, roundTripMs: typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null };
}
