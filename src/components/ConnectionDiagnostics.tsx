import { useRef, useState } from "react";

import { connectionPath } from "../lib/connection-path";

type Snapshot = { peer: RTCPeerConnection; connection: string; ice: string; gathering: string; captured: string; path: ReturnType<typeof connectionPath> | null; statsFailed: boolean };

export function ConnectionDiagnostics({ peer }: { peer: RTCPeerConnection }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const request = useRef(0);
  const refresh = async () => {
    const id = ++request.current;
    const current: Snapshot = { peer, connection: peer.connectionState,
      ice: peer.iceConnectionState, gathering: peer.iceGatheringState,
      captured: new Date().toLocaleTimeString(), path: null, statsFailed: false };
    setSnapshot(current);
    try {
      const path = connectionPath(await peer.getStats());
      if (id === request.current) setSnapshot({ ...current, path });
    } catch {
      if (id === request.current) setSnapshot({ ...current, statsFailed: true });
    }
  };
  return <details className="connection-diagnostics" onToggle={(event) => {
    if (event.currentTarget.open) void refresh();
  }}>
    <summary>Connection details</summary>
    <p>These browser states can help troubleshoot pairing. They do not confirm file delivery.</p>
    {snapshot?.peer === peer && <dl>
      <dt>Connection</dt><dd>{snapshot.connection}</dd>
      <dt>Local network connection (ICE)</dt><dd>{snapshot.ice}</dd>
      <dt>Finding network addresses</dt><dd>{snapshot.gathering}</dd>
      <dt>Selected transport</dt><dd>{snapshot.path?.protocol ?? (snapshot.statsFailed ? "Unavailable" : "Reading…")}</dd>
      <dt>Round-trip time</dt><dd>{snapshot.path?.roundTripMs == null ? "Unavailable" : `${snapshot.path.roundTripMs.toFixed(1)} ms`}</dd>
      <dt>Snapshot time</dt><dd>{snapshot.captured}</dd>
    </dl>}
    <button className="button button-secondary" onClick={refresh}>Refresh connection details</button>
  </details>;
}
