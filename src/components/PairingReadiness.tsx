import type { usePairingReadiness } from "../lib/use-pairing-readiness";

export function PairingReadiness({ readiness }: { readiness: ReturnType<typeof usePairingReadiness> }) {
  if (readiness.status === "disabled") return null;
  const retry = <button className="button button-secondary" disabled={readiness.status === "checking"} onClick={readiness.retry}>Retry connection check</button>;
  return <div className="readiness-card" aria-label="Local connection check">
    <strong aria-live="polite">{readiness.status === "checking" ? "Checking this device" : readiness.ready ? "Ready to connect" : "Local connection unavailable"}</strong>
    {readiness.ready ? <details><summary>Connection check details</summary><p>This device can start a connection. Both laptops must still be on the same local network. This check cannot detect a firewall blocking the other laptop.</p>{retry}</details> : <>
      <p>{readiness.status === "checking" ? "Checking the local app before preparing your files…"
        : "Close other copies of the app and retry this check. If it still fails, reopen the app using its launcher."}</p>
      {readiness.error && <details><summary>Connection check details</summary><p>{readiness.error}</p></details>}
      {readiness.status === "failed" && retry}
    </>}
  </div>;
}
