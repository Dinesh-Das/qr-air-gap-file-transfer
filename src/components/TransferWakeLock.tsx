import { useEffect, useState } from "react";
import { keepScreenAwake, type ScreenWakeState } from "../lib/screen-wake-lock";

export function TransferWakeLock() {
  const [state, setState] = useState<ScreenWakeState>("requesting");
  const [retry, setRetry] = useState(0);
  useEffect(() => keepScreenAwake({ document, wakeLock: navigator.wakeLock }, setState), [retry]);
  return <div className="notice-strip" aria-live="polite">
    <span>{state === "held" ? "Keeping the screen awake during this transfer."
      : state === "requesting" ? "Requesting permission to keep the screen awake…"
      : state === "hidden" ? "Return to this tab to keep its screen awake."
      : "The browser cannot keep the screen awake. Keep this laptop awake until verification finishes."}</span>
    {state === "unavailable" && <button className="button button-secondary" onClick={() => setRetry((value) => value + 1)}>Retry screen wake lock</button>}
  </div>;
}
