import { useEffect, useState } from "react";
import { estimateBlockStorage, type BlockStorageEstimate } from "../lib/block-store";
import { formatBytes } from "../lib/format";

export function StorageReadiness() {
  const [estimate, setEstimate] = useState<BlockStorageEstimate | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setEstimate(null);
    setError(false);
    void estimateBlockStorage().then((value) => { if (current) setEstimate(value); })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [revision]);
  return <div className="readiness-card" aria-label="Receiver storage readiness">
    <strong>Temporary browser storage</strong>
    <p aria-live="polite">{error ? "The browser could not report available space. Retry the check before a large transfer."
      : !estimate ? "Checking available browser storage…"
      : estimate.available === undefined ? "Available browser space is unknown."
      : `${formatBytes(estimate.available)} estimated free for temporary transfer storage.`}</p>
    {estimate && <p>{estimate.persisted === true ? "Persistent browser storage is enabled."
      : estimate.persisted === false ? "Temporary data may be evicted by the browser."
      : "Browser persistence status is unknown."}</p>}
    <p>Space is checked again after pairing. Your destination folder will also need enough free space for the saved files.</p>
    <button className="button button-secondary" disabled={!estimate && !error} onClick={() => setRevision((value) => value + 1)}>Refresh storage check</button>
  </div>;
}
