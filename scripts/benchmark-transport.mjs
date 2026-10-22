// Development-only snapshot; never imported by the product.
export function benchmarkTransportSnapshot(report) {
  const result = { transports: [], candidatePairs: [], dataChannels: [] };
  const selected = new Set([...report.values()].filter((s) => s.type === "transport" && typeof s.selectedCandidatePairId === "string").map((s) => s.selectedCandidatePairId));
  const commonCounters = ["bytesSent", "bytesReceived", "packetsSent", "packetsReceived"];
  // W3C WebRTC stats: unsupported readings remain absent, not fabricated zero.
  // https://www.w3.org/TR/webrtc-stats/#rtcicecandidatepairstats-dict*
  for (const stats of report.values()) {
    const row = {};
    if (typeof stats.id === "string") row.id = stats.id;
    if (Number.isFinite(stats.timestamp) && stats.timestamp >= 0) row.timestamp = stats.timestamp;
    let target, counters = commonCounters;
    if (stats.type === "transport") {
      target = result.transports;
      for (const key of ["selectedCandidatePairId", "dtlsState", "iceState", "iceRole"]) if (typeof stats[key] === "string") row[key] = stats[key];
      counters = [...counters, "selectedCandidatePairChanges"];
    } else if (stats.type === "candidate-pair") {
      target = result.candidatePairs;
      row.selected = selected.has(stats.id);
      if (typeof stats.state === "string") row.state = stats.state;
      if (typeof stats.nominated === "boolean") row.nominated = stats.nominated;
      counters = [...counters, "packetsDiscardedOnSend", "bytesDiscardedOnSend", "requestsSent", "requestsReceived", "responsesSent", "responsesReceived", "consentRequestsSent"];
      for (const key of ["currentRoundTripTime", "totalRoundTripTime", "availableOutgoingBitrate", "availableIncomingBitrate", "lastPacketSentTimestamp", "lastPacketReceivedTimestamp"]) if (Number.isFinite(stats[key]) && stats[key] >= 0) row[key] = stats[key];
    } else if (stats.type === "data-channel") {
      target = result.dataChannels;
      if (typeof stats.state === "string") row.state = stats.state;
      counters = ["messagesSent", "messagesReceived", "bytesSent", "bytesReceived"];
    } else continue;
    for (const key of counters) if (Number.isSafeInteger(stats[key]) && stats[key] >= 0) row[key] = stats[key];
    target.push(row);
  }
  return result;
}
