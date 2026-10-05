import { formatBytes, formatClock, formatDuration, formatRate } from "../lib/format";
import type { OfflineTransferProgress } from "../lib/webrtc-transfer";

export function TransferMetrics({ progress, rate, currentRate, elapsed, direction, interrupted = false }: {
  progress: OfflineTransferProgress;
  rate: number;
  currentRate: number;
  elapsed: number;
  direction: "send" | "receive";
  interrupted?: boolean;
}) {
  const remainingBytes = Math.max(0, progress.totalBytes - progress.completedBytes);
  const eta = rate > 0 && remainingBytes > 0 ? remainingBytes / rate : null;
  return <>
    <div className="metric-grid transfer-metrics">
      <div className="metric"><span>{direction === "send" ? interrupted ? "Last sent" : "Sent safely" : interrupted ? "Last received" : "Received safely"}</span><strong>{formatBytes(progress.completedBytes)} of {formatBytes(progress.totalBytes)}</strong></div>
      <div className="metric"><span>Remaining bytes</span><strong>{formatBytes(remainingBytes)}</strong></div>
      <div className="metric"><span>Current speed</span><strong>{formatRate(currentRate)}</strong></div>
      <div className="metric"><span>Recent speed</span><strong>{formatRate(rate)}</strong></div>
      <div className="metric"><span>Transfer ETA</span><strong>{eta !== null ? `~${formatDuration(eta)}` : "—"}</strong></div>
      <div className="metric"><span>Resumed</span><strong>{formatBytes(progress.resumedBytes)}</strong></div>
      <div className="metric"><span>Elapsed this attempt</span><strong>{formatClock(elapsed)}</strong></div>
    </div>
    <p className="transfer-metrics-note">{interrupted ? "This attempt was not verified. Reconnect to check which data can be reused." : "Elapsed includes pauses and checks for this attempt. Saving follows."}</p>
  </>;
}
