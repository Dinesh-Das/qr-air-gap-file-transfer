export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  const digits = index === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "under a minute";
  const seconds = Math.ceil(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const parts = [minutes, seconds].map((part) => part.toString().padStart(2, "0"));
  return hours > 0
    ? `${hours.toString().padStart(2, "0")}:${parts.join(":")}`
    : parts.join(":");
}

export function estimateTransferSeconds(
  bytes: number,
  chunkSize: number,
  framesPerSecond: number,
): number {
  // The optical channel usually retains roughly 72% of its nominal payload
  // rate after repeated manifests, missed frames, and loop recovery.
  const effectiveBytesPerSecond = Math.max(1, chunkSize * framesPerSecond * 0.72);
  return bytes / effectiveBytesPerSecond;
}
