import { describe, expect, it } from "vitest";
import { TransferRateWindow } from "../src/lib/transfer-rate";

describe("recent transfer rate", () => {
  it("separates the current second from the smoother five-second estimate", () => {
    const current = new TransferRateWindow(1000);
    const recent = new TransferRateWindow();
    for (const [time, bytes] of [[0, 0], [500, 500], [1000, 1000], [1500, 1500]]) {
      current.sample(time, bytes);
      recent.sample(time, bytes);
    }
    expect(current.sample(2000, 10_000)).toBe(9000);
    expect(recent.sample(2000, 10_000)).toBe(5000);
    current.sample(2500, 10_000);
    recent.sample(2500, 10_000);
    expect(current.sample(3000, 10_000)).toBe(0);
    expect(recent.sample(3000, 10_000)).toBeCloseTo(10_000 / 3);
  });

  it("uses byte deltas rather than counting resumed bytes as new traffic", () => {
    const rate = new TransferRateWindow();
    expect(rate.sample(0, 1_000_000)).toBe(0);
    expect(rate.sample(1000, 1_001_000)).toBe(1000);
  });
  it("decays to zero after five idle seconds", () => {
    const rate = new TransferRateWindow();
    rate.sample(0, 0);
    rate.sample(1000, 1000);
    for (let time = 1500; time <= 6500; time += 500) rate.sample(time, 1000);
    expect(rate.sample(7000, 1000)).toBe(0);
  });
  it.each([1000, 5000] as const)("restarts the %i ms estimate after a sampling gap exceeds its window", (windowMilliseconds) => {
    const rate = new TransferRateWindow(windowMilliseconds);
    rate.sample(0, 0);
    expect(rate.sample(500, 1000)).toBe(2000);
    const resumedAt = 500 + windowMilliseconds + 1;
    // No observation locates these bytes within the advertised recent window.
    // Establish a new baseline instead of presenting the whole gap's average.
    expect(rate.sample(resumedAt, 2000)).toBe(0);
    expect(rate.sample(resumedAt + 500, 3000)).toBe(2000);
  });
  it("resets safely for a new transfer or clock discontinuity", () => {
    const rate = new TransferRateWindow();
    rate.sample(1000, 5000);
    expect(rate.sample(2000, 1)).toBe(0);
    expect(rate.sample(3000, 1001)).toBe(1000);
    expect(rate.sample(2500, 2000)).toBe(0);
    expect(rate.sample(4000, Number.NaN)).toBe(0);
  });
});
