import { describe, expect, it } from "vitest";
import {
  estimateTransferSeconds,
  formatBytes,
  formatClock,
  formatDuration,
  formatEta,
  formatRate,
} from "../src/lib/format";

describe("format helpers", () => {
  it("formats sub-byte values without producing an invalid unit", () => {
    expect(formatBytes(0.5)).toBe("0.5 B");
    expect(formatRate(0.5)).toBe("0.5 B/s");
  });

  it("uses explicit invalid and terminal duration states", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(0)).toBe("0s");
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe("Calculating…");
    expect(formatEta(0)).toBe("Complete");
  });

  it("does not render non-finite clock components", () => {
    expect(formatClock(Number.NaN)).toBe("—");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("returns an unbounded estimate for an invalid channel rate", () => {
    expect(estimateTransferSeconds(100, 700, 0)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(estimateTransferSeconds(0, 700, 6)).toBe(0);
  });
});
