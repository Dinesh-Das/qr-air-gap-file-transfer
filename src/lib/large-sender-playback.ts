export interface Qrf3DisplayProgress {
  manifest: boolean;
  dataFramesShown: number;
}

/** Advances payload progress while repeated manifest frames leave it unchanged. */
export function advanceQrf3DisplayProgress(
  encoded: string,
  manifestFrame: string,
  dataFramesShown: number,
  blockCount: number,
): Qrf3DisplayProgress {
  if (
    !Number.isSafeInteger(dataFramesShown) ||
    dataFramesShown < 0 ||
    !Number.isSafeInteger(blockCount) ||
    blockCount < 0
  ) {
    throw new RangeError("QRF3 display progress must use non-negative safe integers.");
  }
  const manifest = encoded === manifestFrame;
  return {
    manifest,
    dataFramesShown: manifest
      ? Math.min(dataFramesShown, blockCount)
      : Math.min(dataFramesShown + 1, blockCount),
  };
}

/** A stopped connection test remains restartable while its exact plan exists. */
export function canResumeQrf3Probe(
  phase: string,
  hasActivePlan: boolean,
  playing: boolean,
): boolean {
  return phase === "testing" && hasActivePlan && !playing;
}
