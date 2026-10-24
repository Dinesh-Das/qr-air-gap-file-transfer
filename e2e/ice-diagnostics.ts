export interface IceDiagnosticPeer {
  events: Array<Record<string, unknown>>;
  descriptions: Array<{ atMs: number; state: string; sdpChars: number;
    candidateLineCount: number; candidateLines: string[]; clipped: boolean }>;
  droppedEvents: number;
  readError?: string;
}
export interface IceDiagnostics {
  version: 1;
  peers: IceDiagnosticPeer[];
  droppedPeers: number;
}
declare global {
  interface Window {
    __qrftIceDiagnostics?: IceDiagnostics;
    __qrftObservePeer?: (peer: RTCPeerConnection) => void;
  }
}

/** Test pages only. Credential extensions are redacted; native methods unchanged. */
export function installIceDiagnostics(): void {
  const started = performance.now(), report: IceDiagnostics = { version: 1, peers: [], droppedPeers: 0 };
  const safeCandidate = (line: string) => {
    const fields = line.trim().split(/\s+/);
    // Keep the first eight address/type fields used by the local policy intact.
    const extensions = fields.slice(8).join(" ").replace(/\b(ufrag|pwd|ice-ufrag|ice-pwd)\s+\S+/gi, "$1 [redacted]");
    return fields.slice(0, 8).join(" ") + (extensions ? " " + extensions : "");
  };
  window.__qrftIceDiagnostics = report;
  window.__qrftObservePeer = peer => {
    if (report.peers.length >= 16) { report.droppedPeers++; return; }
    const row: IceDiagnosticPeer = { events: [], descriptions: [], droppedEvents: 0 };
    report.peers.push(row);
    const capture = (type: string, detail: Record<string, unknown> = {}) => {
      const atMs = Math.round(performance.now() - started);
      row.events.push({ atMs, type, gathering: peer.iceGatheringState,
        connection: peer.connectionState, signaling: peer.signalingState, ...detail });
      if (row.events.length > 32) { row.events.shift(); row.droppedEvents++; }
      try {
        const sdp = peer.localDescription?.sdp;
        if (sdp !== undefined) {
          const all = sdp.split(/\r?\n/).filter(line => line.startsWith("a=candidate:"));
          row.descriptions.push({ atMs, state: peer.iceGatheringState, sdpChars: sdp.length,
            candidateLineCount: all.length, candidateLines: all.slice(0, 64).map(line => safeCandidate(line).slice(0, 512)),
            clipped: all.length > 64 || all.some(line => line.length > 512) });
          if (row.descriptions.length > 4) row.descriptions.shift();
        }
      } catch (error) { row.readError = String(error).slice(0, 512); }
    };
    peer.addEventListener("icegatheringstatechange", () => capture("gathering"));
    peer.addEventListener("connectionstatechange", () => capture("connection"));
    peer.addEventListener("icecandidate", event => capture("candidate", {
      value: event.candidate ? safeCandidate(event.candidate.candidate).slice(0, 512) : null,
    }));
    peer.addEventListener("icecandidateerror", event => capture("candidate-error", {
      code: event.errorCode, text: event.errorText.slice(0, 512),
    }));
    capture("created");
  };
}
