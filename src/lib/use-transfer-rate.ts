import { useEffect, useRef, useState } from "react";
import { TransferRateWindow } from "./transfer-rate";
import type { OfflineTransferProgress } from "./webrtc-transfer";

export function useTransferRates(progress: OfflineTransferProgress | null, active: boolean): { currentRate: number; smoothedRate: number } {
  const latest = useRef(progress);
  latest.current = progress;
  const [rates, setRates] = useState({ currentRate: 0, smoothedRate: 0 });
  useEffect(() => {
    setRates({ currentRate: 0, smoothedRate: 0 });
    if (!active) return;
    const current = new TransferRateWindow(1000);
    const smoothed = new TransferRateWindow();
    const tick = () => {
      const progress = latest.current;
      const bytes = progress ? Math.max(0, progress.completedBytes - progress.resumedBytes) : 0;
      const now = performance.now();
      setRates({ currentRate: current.sample(now, bytes), smoothedRate: smoothed.sample(now, bytes) });
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [active]);
  return active ? rates : { currentRate: 0, smoothedRate: 0 };
}

/** One attempt, including pauses and verification; cleared when progress resets. */
export function useTransferElapsed(started: boolean, running: boolean): number {
  const start = useRef<number | null>(null);
  const end = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!started) {
      start.current = null;
      end.current = null;
      setElapsed(0);
      return;
    }
    const now = performance.now();
    start.current ??= now;
    if (!running) end.current ??= now;
    const tick = () => setElapsed(Math.max(0, ((end.current ?? performance.now()) - start.current!) / 1000));
    tick();
    if (end.current !== null) return;
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [started, running]);
  return started ? elapsed : 0;
}
