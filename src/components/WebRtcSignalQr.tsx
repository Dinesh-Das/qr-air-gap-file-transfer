import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import QrScanner from "qr-scanner";
import { AlertTriangle, Camera, QrCode as QrCodeIcon, RefreshCw } from "lucide-react";
import {
  OfflineSignalAccumulator,
  type OfflineSignalBundle,
  type OfflineSignalKind,
} from "../lib/webrtc-signaling";

export function WebRtcSignalDisplay({
  frames,
  label,
}: {
  frames: readonly string[];
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [index, setIndex] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    setIndex(0);
    if (frames.length < 2) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % frames.length),
      650,
    );
    return () => clearInterval(timer);
  }, [frames]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frames[index];
    if (!canvas || !frame) return;
    setRenderError(null);
    void QRCode.toCanvas(canvas, frame, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 720,
      color: { dark: "#132019", light: "#ffffff" },
    }).catch((caught) => setRenderError(
      caught instanceof Error ? caught.message : String(caught),
    ));
  }, [frames, index]);

  if (frames.length === 0) {
    return (
      <div className="qr-placeholder">
        <div className="qr-placeholder-inner">
          <QrCodeIcon size={42} />
          <strong>Preparing handshake</strong>
        </div>
      </div>
    );
  }

  return (
    <div className="qr-live">
      <div className="qr-canvas-wrap">
        <canvas ref={canvasRef} aria-label={label} />
      </div>
      <div className="qr-meta">
        <span className="live-dot">Handshake</span>
        <span>Frame {index + 1} / {frames.length}</span>
      </div>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${((index + 1) / frames.length) * 100}%` }} />
      </div>
      {renderError && <div className="status-box error compact-status"><AlertTriangle size={16} />Could not render this handshake QR: {renderError}</div>}
    </div>
  );
}

export function WebRtcSignalScanner({
  expected,
  onComplete,
  onError,
}: {
  expected: OfflineSignalKind;
  onComplete: (bundle: OfflineSignalBundle) => void;
  onError: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onComplete);
  const errorRef = useRef(onError);
  const [progress, setProgress] = useState({ received: 0, total: 0 });
  const [attempt, setAttempt] = useState(0);
  const [scannerError, setScannerError] = useState<string | null>(null);
  callbackRef.current = onComplete;
  errorRef.current = onError;

  useEffect(() => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay) return;
    const accumulator = new OfflineSignalAccumulator();
    let finished = false;
    setScannerError(null);
    setProgress({ received: 0, total: 0 });
    const scanner = new QrScanner(
      video,
      (result) => {
        if (finished) return;
        try {
          const next = accumulator.accept(result.data);
          setProgress({ received: next.received, total: next.total });
          if (!next.complete || !next.bundle) return;
          if (next.bundle.kind !== expected) throw new Error(`Expected a WebRTC ${expected} QR.`);
          finished = true;
          void scanner.pause(true);
          callbackRef.current(next.bundle);
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          if (/not a WebRTC handshake/i.test(message)) return;
          setScannerError(message);
          errorRef.current(message);
        }
      },
      {
        preferredCamera: "environment",
        maxScansPerSecond: 15,
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        overlay,
        onDecodeError: () => undefined,
      },
    );
    void scanner.start().catch((caught) => {
      if (finished) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setScannerError(message);
      errorRef.current(message);
    });
    return () => {
      finished = true;
      void scanner.pause(true).catch(() => undefined);
      scanner.destroy();
    };
  }, [attempt, expected]);

  return (
    <div>
      <div className="camera-shell signal-camera">
        <video ref={videoRef} muted playsInline />
        <div ref={overlayRef} className="scan-overlay">
          <div className="scan-line" />
        </div>
        <div className="camera-badge"><Camera size={12} /> Handshake scan</div>
      </div>
      <p className="microcopy signal-progress">
        {progress.total > 0
          ? `Captured ${progress.received} of ${progress.total} handshake frames`
          : "Hold the other device's animated QR inside the camera frame."}
      </p>
      {scannerError && <div className="status-box error compact-status"><AlertTriangle size={16} />{scannerError}</div>}
      {scannerError && <button className="button button-secondary button-wide signal-action" onClick={() => {
        errorRef.current("");
        setAttempt((current) => current + 1);
      }}><RefreshCw size={16} />Retry camera scan</button>}
    </div>
  );
}
