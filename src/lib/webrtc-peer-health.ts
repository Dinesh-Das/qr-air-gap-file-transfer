/** Every unhealthy state gets its own deadline; stale sessions cannot fail a retry. */
export function watchWebRtcPeerHealth(
  peer: RTCPeerConnection,
  isCurrent: () => boolean,
  fail: (error: Error) => void,
  onState?: (state: RTCPeerConnectionState) => void,
): () => void {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedState: RTCPeerConnectionState | undefined;
  let stopped = false;
  const clear = () => {
    if (deadline !== undefined) clearTimeout(deadline);
    deadline = undefined;
    timedState = undefined;
  };
  const onChange = () => {
    if (stopped || !isCurrent()) { clear(); return; }
    const state = peer.connectionState;
    onState?.(state);
    if (state === "failed") {
      clear();
      fail(new Error("The browsers could not establish a direct local connection. Check the Wi-Fi and firewall, then retry."));
      return;
    }
    if (state !== "connecting" && state !== "disconnected") { clear(); return; }
    if (deadline !== undefined && timedState === state) return;
    clear();
    timedState = state;
    deadline = setTimeout(() => {
      clear();
      if (!stopped && isCurrent() && peer.connectionState === state) {
        fail(new Error("The direct local connection timed out. Check that both devices are on the same non-isolated network."));
      }
    }, state === "disconnected" ? 15_000 : 30_000);
  };
  peer.addEventListener("connectionstatechange", onChange);
  onChange();
  return () => { stopped = true; clear(); peer.removeEventListener("connectionstatechange", onChange); };
}
