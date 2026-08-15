import { describe, expect, it } from "vitest";

import {
  advanceQrf3DisplayProgress,
  canResumeQrf3Probe,
} from "../src/lib/large-sender-playback";

describe("large sender playback", () => {
  it("counts data frames while leaving initial and repeated manifests out of progress", () => {
    let dataFramesShown = 0;
    const observed = ["manifest", "data-2", "manifest", "data-0", "data-1"].map(
      (encoded) => {
        const progress = advanceQrf3DisplayProgress(
          encoded,
          "manifest",
          dataFramesShown,
          3,
        );
        dataFramesShown = progress.dataFramesShown;
        return progress;
      },
    );

    expect(observed).toEqual([
      { manifest: true, dataFramesShown: 0 },
      { manifest: false, dataFramesShown: 1 },
      { manifest: true, dataFramesShown: 1 },
      { manifest: false, dataFramesShown: 2 },
      { manifest: false, dataFramesShown: 3 },
    ]);
  });

  it("offers probe resume after Stop display without unlocking Files", () => {
    expect(canResumeQrf3Probe("testing", true, false)).toBe(true);
    expect(canResumeQrf3Probe("testing", true, true)).toBe(false);
    expect(canResumeQrf3Probe("verified", true, false)).toBe(false);
  });
});
