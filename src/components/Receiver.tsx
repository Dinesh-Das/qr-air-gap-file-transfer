import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import QrScanner from "qr-scanner";
import {
  AlertTriangle,
  Camera,
  CameraOff,
  Check,
  CheckCircle2,
  Download,
  FolderCheck,
  RefreshCw,
  Save,
  ScanLine,
  ShieldCheck,
  StopCircle,
} from "lucide-react";
import {
  downloadArchive,
  extractArchive,
  writeAndVerifyArchive,
  type SelectedEntry,
  type VerificationReport,
} from "../lib/archive";
import {
  TransferAccumulator,
  type AccumulatorResult,
} from "../lib/protocol";
import { formatBytes, formatClock } from "../lib/format";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = 200_000;

function createAccumulator() {
  return new TransferAccumulator({
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxTotalChunks: MAX_CHUNKS,
  });
}

type ReceiverPhase =
  | "idle"
  | "starting"
  | "scanning"
  | "archive-ready"
  | "saving"
  | "verified";

interface ReceivedArchive {
  bytes: Uint8Array;
  entries: SelectedEntry[];
  rootName: string;
}

interface ProgressState {
  transferId?: number;
  rootName?: string;
  receivedChunks: number;
  totalChunks: number;
  receivedBytes: number;
  percent: number;
}

const EMPTY_PROGRESS: ProgressState = {
  receivedChunks: 0,
  totalChunks: 0,
  receivedBytes: 0,
  percent: 0,
};

export function Receiver() {
  const [phase, setPhase] = useState<ReceiverPhase>("idle");
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const [archive, setArchive] = useState<ReceivedArchive | null>(null);
  const [verification, setVerification] =
    useState<VerificationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [stalled, setStalled] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanOverlayRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const accumulatorRef = useRef(createAccumulator());
  const ingestQueueRef = useRef<Promise<void>>(Promise.resolve());
  const scanStartedAtRef = useRef<number | null>(null);
  const firstAcceptedAtRef = useRef<number | null>(null);
  const lastAcceptedAtRef = useRef<number | null>(null);
  const completionHandledRef = useRef(false);
  const receiverGenerationRef = useRef(0);

  const fileEntries = useMemo(
    () => archive?.entries.filter((entry) => !entry.directory) ?? [],
    [archive],
  );
  const uncompressedBytes = useMemo(
    () => fileEntries.reduce((sum, entry) => sum + entry.bytes.length, 0),
    [fileEntries],
  );
  const throughput = useMemo(() => {
    const started = firstAcceptedAtRef.current;
    if (!started || progress.receivedBytes === 0) return 0;
    const seconds = Math.max(0.25, (Date.now() - started) / 1000);
    return progress.receivedBytes / seconds;
  }, [elapsedSeconds, progress.receivedBytes]);

  const stopScanner = useCallback(async (destroy = false) => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    await scanner.pause(true);
    if (destroy) {
      scanner.destroy();
      if (scannerRef.current === scanner) scannerRef.current = null;
    }
  }, []);

  const handleAccumulatorResult = useCallback(
    async (result: AccumulatorResult) => {
      if (result.accepted && !result.duplicate) {
        const now = Date.now();
        firstAcceptedAtRef.current ??= now;
        lastAcceptedAtRef.current = now;
        setStalled(false);
      }

      if (result.accepted) {
        setProgress({
          transferId: result.transferId,
          rootName: result.rootName,
          receivedChunks: result.receivedChunks,
          totalChunks: result.totalChunks,
          receivedBytes: result.receivedBytes,
          percent: result.percent,
        });
      }

      if (result.status === "verification-failed") {
        setNotice(result.error ?? "Hash verification failed; scanning the next loop.");
        return;
      }
      if (
        result.status !== "complete" ||
        !result.archiveBytes ||
        !result.rootName ||
        completionHandledRef.current
      ) {
        return;
      }

      completionHandledRef.current = true;
      await stopScanner();
      try {
        const entries = extractArchive(result.archiveBytes);
        setArchive({
          bytes: result.archiveBytes,
          entries,
          rootName: result.rootName,
        });
        setProgress((current) => ({ ...current, percent: 100 }));
        setNotice(null);
        setError(null);
        setPhase("archive-ready");
      } catch (caught) {
        setError(
          toMessage(
            caught,
            "The archive passed transfer hashing but could not be safely unpacked.",
          ),
        );
        setPhase("idle");
      }
    },
    [stopScanner],
  );

  const queueDecodedFrame = useCallback(
    (encoded: string, generation: number) => {
      const accumulator = accumulatorRef.current;
      ingestQueueRef.current = ingestQueueRef.current
        .then(async () => {
          if (generation !== receiverGenerationRef.current) return;
          const result = await accumulator.ingest(encoded);
          if (generation !== receiverGenerationRef.current) return;
          await handleAccumulatorResult(result);
        })
        .catch((caught) => {
          if (generation !== receiverGenerationRef.current) return;
          setError(toMessage(caught, "A decoded frame could not be processed."));
        });
    },
    [handleAccumulatorResult],
  );

  const startScanner = useCallback(async () => {
    setError(null);
    setNotice(null);
    if (!window.isSecureContext) {
      setError(
        "Camera access requires a secure context. Open this app at http://127.0.0.1 or over HTTPS, not as a file.",
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not expose a camera API.");
      return;
    }

    setPhase("starting");
    try {
      if (!(await QrScanner.hasCamera())) {
        throw new Error("No camera was detected on this computer.");
      }
      const video = videoRef.current;
      if (!video) throw new Error("The camera view is not ready.");
      const scanOverlay = scanOverlayRef.current;
      if (!scanOverlay) throw new Error("The scan guide is not ready.");

      let scanner = scannerRef.current;
      if (!scanner) {
        const generation = receiverGenerationRef.current;
        scanner = new QrScanner(
          video,
          (result) => queueDecodedFrame(result.data, generation),
          {
            preferredCamera: "environment",
            maxScansPerSecond: 14,
            returnDetailedScanResult: true,
            highlightScanRegion: true,
            overlay: scanOverlay,
            onDecodeError: () => {
              // Most camera frames do not contain a fully readable QR. Misses
              // are normal and intentionally stay out of the error UI.
            },
          },
        );
        scannerRef.current = scanner;
      }
      await scanner.start();
      scanStartedAtRef.current ??= Date.now();
      setPhase("scanning");
    } catch (caught) {
      await stopScanner(true);
      setPhase("idle");
      setError(cameraErrorMessage(caught));
    }
  }, [queueDecodedFrame, stopScanner]);

  const pauseScanner = useCallback(async () => {
    await stopScanner();
    setPhase("idle");
    setNotice("Camera paused. Your received chunks are still held in memory.");
  }, [stopScanner]);

  const resetReceiver = useCallback(async () => {
    receiverGenerationRef.current += 1;
    setPhase("starting");
    await stopScanner(true);
    accumulatorRef.current = createAccumulator();
    ingestQueueRef.current = Promise.resolve();
    scanStartedAtRef.current = null;
    firstAcceptedAtRef.current = null;
    lastAcceptedAtRef.current = null;
    completionHandledRef.current = false;
    setPhase("idle");
    setProgress(EMPTY_PROGRESS);
    setArchive(null);
    setVerification(null);
    setElapsedSeconds(0);
    setStalled(false);
    setError(null);
    setNotice(null);
  }, [stopScanner]);

  const saveAndVerify = useCallback(async () => {
    if (!archive) return;
    setPhase("saving");
    setError(null);
    setNotice(null);
    try {
      const report = await writeAndVerifyArchive(
        archive.entries,
        archive.rootName,
      );
      setVerification(report);
      if (!report.ok) {
        setError(
          "Destination verification failed. At least one path or SHA-256 hash differs; success has not been reported.",
        );
        setPhase("archive-ready");
        return;
      }
      setPhase("verified");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setPhase("archive-ready");
        return;
      }
      setError(
        toMessage(
          caught,
          "The destination could not be written and verified. Choose another empty destination parent.",
        ),
      );
      setPhase("archive-ready");
    }
  }, [archive]);

  const downloadVerifiedZip = useCallback(() => {
    if (!archive) return;
    try {
      downloadArchive(archive.bytes, `${safeDownloadName(archive.rootName)}.zip`);
      setNotice(
        "The transferred ZIP hash is verified. Because extraction is manual, this browser cannot verify the final on-disk files.",
      );
    } catch (caught) {
      setError(toMessage(caught, "The verified ZIP could not be downloaded."));
    }
  }, [archive]);

  useEffect(() => {
    if (!scanStartedAtRef.current || phase !== "scanning") return;
    const update = () => {
      const now = Date.now();
      setElapsedSeconds(
        Math.floor((now - (scanStartedAtRef.current ?? now)) / 1000),
      );
      const lastAccepted = lastAcceptedAtRef.current;
      setStalled(
        progress.receivedChunks > 0 &&
          lastAccepted !== null &&
          now - lastAccepted > 30_000,
      );
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [phase, progress.receivedChunks]);

  useEffect(
    () => () => {
      const scanner = scannerRef.current;
      if (scanner) {
        void scanner.pause(true).finally(() => scanner.destroy());
      }
      scannerRef.current = null;
    },
    [],
  );

  const directWriteSupported = typeof window.showDirectoryPicker === "function";
  const scanning = phase === "scanning";

  return (
    <section className="workspace" aria-labelledby="receiver-title">
      <div className="page-heading">
        <span className="eyebrow">Optical receiver</span>
        <h1 id="receiver-title">Scan, reconstruct, and verify every byte.</h1>
        <p>
          Point this computer’s camera at the sender. Missed and repeated frames
          are handled automatically; output stays locked until SHA-256 passes.
        </p>
      </div>

      <div className="transfer-card receiver-layout">
        <div className="panel">
          <div className="panel-kicker">
            <ScanLine size={14} />
            Camera channel
          </div>
          <h2>Align the QR inside the guide</h2>
          <p className="panel-description">
            Keep the sender’s complete QR visible and hold both devices steady.
          </p>

          <div className="camera-shell">
            <video ref={videoRef} muted playsInline aria-label="Live camera view" />
            {!scanning && phase !== "starting" && (
              <div className="camera-empty">
                <span className="camera-empty-icon">
                  <Camera size={27} />
                </span>
                <strong>Camera is off</strong>
                <span>
                  Camera frames are processed locally and are never uploaded or
                  stored.
                </span>
              </div>
            )}
            {phase === "starting" && (
              <div className="camera-empty">
                <span className="camera-empty-icon">
                  <span className="spinner" />
                </span>
                <strong>Starting camera…</strong>
                <span>Approve the browser permission prompt if it appears.</span>
              </div>
            )}
            {scanning && <div className="camera-badge">Scanning live</div>}
            <div
              ref={scanOverlayRef}
              className={`scan-overlay ${scanning ? "visible" : ""}`}
            >
              <div className="scan-line" />
            </div>
          </div>

          <div className="playback-controls">
            <button
              type="button"
              className="button button-primary"
              disabled={
                phase === "starting" ||
                scanning ||
                phase === "saving" ||
                phase === "archive-ready" ||
                phase === "verified"
              }
              onClick={() => void startScanner()}
            >
              <Camera size={16} />
              {progress.receivedChunks > 0 ? "Resume camera" : "Start camera"}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={!scanning}
              onClick={() => void pauseScanner()}
            >
              <CameraOff size={16} />
              Pause camera
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="receiver-status">
            <div className="panel-kicker">
              <ShieldCheck size={14} />
              Integrity gate
            </div>

            {phase === "verified" && verification ? (
              <VerifiedSummary
                report={verification}
                elapsedSeconds={elapsedSeconds}
                onReset={resetReceiver}
              />
            ) : phase === "archive-ready" || phase === "saving" ? (
              <ArchiveReady
                archive={archive!}
                fileCount={fileEntries.length}
                totalBytes={uncompressedBytes}
                directWriteSupported={directWriteSupported}
                saving={phase === "saving"}
                onSave={() => void saveAndVerify()}
                onDownload={downloadVerifiedZip}
                onReset={resetReceiver}
              />
            ) : (
              <>
                <h2>Receiving transfer</h2>
                <p className="panel-description">
                  Progress counts unique, CRC-valid chunks only.
                </p>

                <div className="progress-ring-wrap">
                  <div
                    className="progress-ring"
                    style={
                      {
                        "--progress": `${Math.min(100, progress.percent)}%`,
                      } as CSSProperties
                    }
                  />
                  <div className="progress-ring-content">
                    <strong>{Math.floor(progress.percent)}%</strong>
                    <span>captured</span>
                  </div>
                </div>

                <dl className="stat-list">
                  <div className="stat-row">
                    <dt>Unique chunks</dt>
                    <dd>
                      {progress.receivedChunks.toLocaleString()} /{" "}
                      {progress.totalChunks
                        ? progress.totalChunks.toLocaleString()
                        : "—"}
                    </dd>
                  </div>
                  <div className="stat-row">
                    <dt>Valid payload</dt>
                    <dd>{formatBytes(progress.receivedBytes)}</dd>
                  </div>
                  <div className="stat-row">
                    <dt>Throughput</dt>
                    <dd>
                      {throughput ? `${formatBytes(throughput)}/s` : "—"}
                    </dd>
                  </div>
                  <div className="stat-row">
                    <dt>Elapsed</dt>
                    <dd>{formatClock(elapsedSeconds)}</dd>
                  </div>
                  <div className="stat-row">
                    <dt>Folder</dt>
                    <dd title={progress.rootName}>{progress.rootName ?? "Waiting…"}</dd>
                  </div>
                </dl>

                {stalled && (
                  <div className="status-box" role="status">
                    <AlertTriangle size={16} />
                    <span>
                      No new chunk for 30 seconds. Move closer, raise screen
                      brightness, reduce sender frame rate, and clean the lens.
                    </span>
                  </div>
                )}

                <button
                  type="button"
                  className="button button-secondary button-wide"
                  onClick={resetReceiver}
                  disabled={phase === "starting"}
                >
                  <RefreshCw size={15} />
                  Reset receiver
                </button>
              </>
            )}

            {error && (
              <div className="status-box error" role="alert">
                <AlertTriangle size={16} />
                <span>{error}</span>
              </div>
            )}
            {notice && (
              <div className="status-box" role="status">
                <AlertTriangle size={16} />
                <span>{notice}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="notice-strip">
        <ShieldCheck size={16} />
        <span>
          Unrelated or unreadable QR codes are ignored. No file is offered until
          the full archive length and SHA-256 match the sender’s manifest.
        </span>
      </div>
    </section>
  );
}

function ArchiveReady({
  archive,
  fileCount,
  totalBytes,
  directWriteSupported,
  saving,
  onSave,
  onDownload,
  onReset,
}: {
  archive: ReceivedArchive;
  fileCount: number;
  totalBytes: number;
  directWriteSupported: boolean;
  saving: boolean;
  onSave: () => void;
  onDownload: () => void;
  onReset: () => void;
}) {
  return (
    <div className="completion">
      <span className="completion-icon">
        <CheckCircle2 size={35} />
      </span>
      <h3>Archive hash verified</h3>
      <p>
        All {formatBytes(archive.bytes.length)} arrived intact. Choose where to
        reconstruct <strong>{archive.rootName}</strong>.
      </p>

      <div className="verification-list">
        <div className="verification-item">
          <Check size={14} />
          Complete ZIP SHA-256 matches
        </div>
        <div className="verification-item">
          <Check size={14} />
          {fileCount.toLocaleString()} files · {formatBytes(totalBytes)} unpacked
        </div>
        <div className="verification-item">
          <Check size={14} />
          Archive paths passed safety validation
        </div>
      </div>

      {directWriteSupported ? (
        <button
          type="button"
          className="button button-primary button-wide"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? (
            <>
              <span className="spinner" />
              Writing &amp; verifying every file…
            </>
          ) : (
            <>
              <Save size={16} />
              Choose destination &amp; verify
            </>
          )}
        </button>
      ) : (
        <button
          type="button"
          className="button button-primary button-wide"
          onClick={onDownload}
        >
          <Download size={16} />
          Download verified ZIP
        </button>
      )}

      <div className="playback-controls">
        {directWriteSupported && (
          <button
            type="button"
            className="button button-secondary"
            disabled={saving}
            onClick={onDownload}
          >
            <Download size={15} />
            ZIP fallback
          </button>
        )}
        <button
          type="button"
          className="button button-secondary"
          disabled={saving}
          onClick={onReset}
        >
          <RefreshCw size={15} />
          New transfer
        </button>
      </div>
    </div>
  );
}

function VerifiedSummary({
  report,
  elapsedSeconds,
  onReset,
}: {
  report: VerificationReport;
  elapsedSeconds: number;
  onReset: () => void;
}) {
  return (
    <div className="completion">
      <span className="completion-icon">
        <FolderCheck size={35} />
      </span>
      <h3>Transfer complete</h3>
      <p>
        <strong>{report.rootName}</strong> was written and independently
        re-read from the destination.
      </p>

      <div className="verification-list">
        <div className="verification-item">
          <Check size={14} />
          Exact path set: {report.filesWritten.toLocaleString()} /{" "}
          {report.expectedPaths.length.toLocaleString()}
        </div>
        <div className="verification-item">
          <Check size={14} />
          SHA-256: every destination file matches
        </div>
        <div className="verification-item">
          <Check size={14} />
          {formatBytes(report.totalBytes)} verified in{" "}
          {formatClock(elapsedSeconds)}
        </div>
      </div>

      <div className="status-box success">
        <ShieldCheck size={16} />
        <span>
          Verification passed. You can now stop the sender’s QR loop.
        </span>
      </div>

      <button
        type="button"
        className="button button-secondary button-wide"
        onClick={onReset}
      >
        <RefreshCw size={15} />
        Receive another folder
      </button>
    </div>
  );
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Camera permission was denied. Allow camera access for this site, then try again.";
    }
    if (error.name === "NotFoundError") {
      return "No camera was detected. Connect a camera and try again.";
    }
    if (error.name === "NotReadableError") {
      return "The camera is already in use by another application.";
    }
  }
  return toMessage(error, "The camera could not be started.");
}

function safeDownloadName(rootName: string): string {
  const safe = rootName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return safe || "qr-air-gap-transfer";
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
