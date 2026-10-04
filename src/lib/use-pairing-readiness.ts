import { useCallback, useEffect, useState } from "react";
import { checkRendezvousReadiness } from "./webrtc-rendezvous";

export function usePairingReadiness(enabled: boolean) {
  const [state, setState] = useState<{ status: "checking" | "ready" | "failed" | "disabled"; error?: string }>({ status: enabled ? "checking" : "disabled" });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) { setState({ status: "disabled" }); return; }
    let current = true;
    const controller = new AbortController();
    setState({ status: "checking" });
    void checkRendezvousReadiness(controller.signal).then(() => {
      if (current) setState({ status: "ready" });
    }).catch((error: unknown) => {
      if (current) setState({ status: "failed", error: error instanceof Error
        ? error.cause instanceof Error ? error.cause.message : error.message : String(error) });
    });
    return () => { current = false; controller.abort(); };
  }, [enabled, revision]);
  return { ...state, ready: enabled && state.status === "ready", retry };
}
