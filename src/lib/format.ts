export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.max(
    0,
    Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1,
    ),
  );
  const value = bytes / 1024 ** index;
  const digits = index === 0 ? (value < 1 ? 1 : 0) : value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  if (totalSeconds === 0) return "0s";
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

export function formatEta(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "Calculating…";
  if (totalSeconds === 0) return "Complete";
  return formatDuration(totalSeconds);
}

export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return "—";
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
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  if (
    !Number.isFinite(chunkSize) ||
    chunkSize <= 0 ||
    !Number.isFinite(framesPerSecond) ||
    framesPerSecond <= 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const effectiveBytesPerSecond = chunkSize * framesPerSecond * 0.72;
  return bytes / effectiveBytesPerSecond;
}
