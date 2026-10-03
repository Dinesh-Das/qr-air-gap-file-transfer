import { describe, expect, it, vi } from "vitest";
import { keepScreenAwake, type ScreenWakeState } from "../src/lib/screen-wake-lock";

class TestDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  show(state: DocumentVisibilityState) { this.visibilityState = state; this.dispatchEvent(new Event("visibilitychange")); }
}
class TestLock extends EventTarget {
  released = false;
  async release() { this.released = true; this.dispatchEvent(new Event("release")); }
}

describe("screen wake lock lifecycle", () => {
  it("releases on hide and stop, and reacquires when visible", async () => {
    const document = new TestDocument();
    const locks: TestLock[] = [];
    const request = vi.fn(async () => { const lock = new TestLock(); locks.push(lock); return lock as WakeLockSentinel; });
    const report = vi.fn();
    const stop = keepScreenAwake({ document, wakeLock: { request } }, report);
    await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith("held"));
    document.show("hidden");
    expect(locks[0].released).toBe(true);
    document.show("visible");
    await vi.waitFor(() => expect(locks).toHaveLength(2));
    stop();
    expect(locks[1].released).toBe(true);
    document.show("visible");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("releases a grant arriving after stop without reporting success", async () => {
    const document = new TestDocument();
    let grant!: (lock: WakeLockSentinel) => void;
    const report = vi.fn();
    const stop = keepScreenAwake({ document, wakeLock: { request: () => new Promise((resolve) => { grant = resolve; }) } }, report);
    stop();
    const lock = new TestLock(); grant(lock as WakeLockSentinel);
    await vi.waitFor(() => expect(lock.released).toBe(true));
    expect(report.mock.calls.map(([state]) => state)).toEqual(["requesting"]);
  });

  it("keeps requests bounded across visibility changes and does not spin on denial", async () => {
    const document = new TestDocument();
    let grant!: (lock: WakeLockSentinel) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }))
      .mockRejectedValue(new Error("Denied"));
    const states: ScreenWakeState[] = [];
    const stop = keepScreenAwake({ document, wakeLock: { request } }, (state) => states.push(state));
    document.show("hidden"); document.show("visible");
    expect(request).toHaveBeenCalledTimes(1);
    const stale = new TestLock(); grant(stale as WakeLockSentinel);
    await vi.waitFor(() => expect(states.at(-1)).toBe("unavailable"));
    expect(stale.released).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    stop();
  });

  it("reports an unavailable API and an unexpected system release", async () => {
    const document = new TestDocument();
    const report = vi.fn();
    keepScreenAwake({ document }, report)();
    expect(report).toHaveBeenLastCalledWith("unavailable");
    const lock = new TestLock();
    const stop = keepScreenAwake({ document, wakeLock: { request: async () => lock as WakeLockSentinel } }, report);
    await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith("held"));
    await lock.release();
    expect(report).toHaveBeenLastCalledWith("unavailable");
    stop();
  });
});
