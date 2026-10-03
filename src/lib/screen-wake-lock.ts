export type ScreenWakeState = "requesting" | "held" | "unavailable" | "hidden";

type Environment = {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  wakeLock?: Pick<WakeLock, "request">;
};

/** One bounded request at a time; visibility changes invalidate late grants. */
export function keepScreenAwake(environment: Environment, report: (state: ScreenWakeState) => void): () => void {
  const { document, wakeLock } = environment;
  let stopped = false;
  let pending = false;
  let generation = 0;
  let held: WakeLockSentinel | null = null;
  const release = (lock: WakeLockSentinel) => { void lock.release().catch(() => undefined); };
  const acquire = () => {
    if (stopped || pending || held || document.visibilityState !== "visible") return;
    if (!wakeLock) { report("unavailable"); return; }
    pending = true;
    const requestedGeneration = generation;
    report("requesting");
    void wakeLock.request("screen").then((lock) => {
      if (stopped || requestedGeneration !== generation || document.visibilityState !== "visible") {
        release(lock);
        return;
      }
      if (lock.released) { report("unavailable"); return; }
      held = lock;
      lock.addEventListener("release", () => {
        if (!stopped && held === lock) { held = null; report("unavailable"); }
      }, { once: true });
      report("held");
    }).catch(() => {
      if (!stopped && requestedGeneration === generation) report("unavailable");
    }).finally(() => {
      pending = false;
      if (!stopped && requestedGeneration !== generation) acquire();
    });
  };
  const visibility = () => {
    generation++;
    if (document.visibilityState !== "visible") {
      const previous = held;
      held = null;
      if (previous) release(previous);
      report("hidden");
    } else { acquire(); }
  };
  document.addEventListener("visibilitychange", visibility);
  visibility();
  return () => {
    stopped = true;
    generation++;
    document.removeEventListener("visibilitychange", visibility);
    const previous = held;
    held = null;
    if (previous) release(previous);
  };
}
