import { useCallback, useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";
import {
  AlertTriangle,
  Camera,
  CameraOff,
  Check,
  CheckCircle2,
  Database,
  FolderCheck,
  KeyRound,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  LargeQrf3Receiver,
  LargeReceiverPoisonCleanupError,
  isLargeReceiverTerminalStorageError,
  type LargeReceiverStatus,
} from "../lib/large-receiver";
import {
  Qrf3TransferPurpose,
  type Qrf3Manifest,
} from "../lib/stream-protocol";
import {
  matchesQrf3FilesBinding,
  type Qrf3FilesBinding,
} from "../lib/large-connection";
import { readLargeTreeManifest, type LargeTreeManifest } from "../lib/large-transfer";
import {
  writeLargeTreeToDirectory,
  type LargeDestinationReport,
  type LargeDestinationProgress,
} from "../lib/large-destination";
import { formatBytes, formatEta, formatRate } from "../lib/format";
import {
  deleteAllBlockStores,
} from "../lib/block-store";
import {
  clearQrf3ReceiverConnection,
  loadQrf3ReceiverConnection,
  saveQrf3ReceiverConnection,
  supportsQrf3ReceiverResume,
} from "../lib/large-receiver-resume";

type Phase =
  | "idle"
  | "restoring"
  | "starting"
  | "testing"
  | "test-verified"
  | "ready-files"
  | "scanning"
  | "paused"
  | "verifying"
  | "complete"
  | "saving"
  | "verified"
  | "discarding"
  | "failed";

interface VerifiedProbe {
  receiptCode: string;
  filesBinding: Qrf3FilesBinding;
}

interface CameraChoice {
  id: string;
  label: string;
}

interface RateSample {
  at: number;
  bytes: number;
}

export function LargeReceiver({ active = true }: { active?: boolean }) {
  const [phase, setPhase] = useState<Phase>("restoring");
  const [status, setStatus] = useState<LargeReceiverStatus>({ state: "awaiting-manifest" });
  const [connection, setConnection] = useState<VerifiedProbe | null>(null);
  const [tree, setTree] = useState<LargeTreeManifest | null>(null);
  const [destinationProgress, setDestinationProgress] = useState<LargeDestinationProgress | null>(null);
  const [report, setReport] = useState<LargeDestinationReport | null>(null);
  const [cameras, setCameras] = useState<CameraChoice[]>([]);
  const [selectedCamera, setSelectedCamera] = useState("environment");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [metricsNow, setMetricsNow] = useState(Date.now());
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const receiverRef = useRef<LargeQrf3Receiver | null>(null);
  const readerRef = useRef<Awaited<ReturnType<LargeQrf3Receiver["verifyComplete"]>> | null>(null);
  const verificationAbortRef = useRef<AbortController | null>(null);
  const destinationAbortRef = useRef<AbortController | null>(null);
  const destinationTaskRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const modeRef = useRef<"probe" | "files">("probe");
  const connectionRef = useRef<VerifiedProbe | null>(null);
  const selectedCameraRef = useRef(selectedCamera);
  const samplesRef = useRef<RateSample[]>([]);
  const priorBytesRef = useRef(0);
  const completionStartedRef = useRef(false);
  const resetInFlightRef = useRef(false);
  const activeRef = useRef(active);

  activeRef.current = active;

  useEffect(() => {
    selectedCameraRef.current = selectedCamera;
  }, [selectedCamera]);

  useEffect(() => {
    if (largeReceiverStorageCapabilityError() || !navigator.mediaDevices) return;
    let mounted = true;
    const refresh = () => void QrScanner.listCameras(false)
      .then((nextCameras) => {
        if (mounted) setCameras(nextCameras);
      })
      .catch(() => undefined);
    refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      mounted = false;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  const stopScanner = useCallback(async (expected?: QrScanner) => {
    const scanner = expected ?? scannerRef.current;
    if (scannerRef.current === scanner) scannerRef.current = null;
    if (scanner) {
      try {
        await scanner.pause(true);
      } finally {
        scanner.destroy();
      }
    }
  }, []);

  const closeReceiver = useCallback(async (expected?: LargeQrf3Receiver) => {
    const receiver = expected ?? receiverRef.current;
    if (!receiver) return;
    await receiver.close();
    if (receiverRef.current === receiver) receiverRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const capabilityError = largeReceiverStorageCapabilityError();
    if (capabilityError) {
      setError(capabilityError);
      setPhase("idle");
    } else {
      void loadQrf3ReceiverConnection()
        .then((restored) => {
          if (cancelled) return;
          if (!restored) {
            setPhase("idle");
            return;
          }
          const next: VerifiedProbe = {
            receiptCode: restored.receiptCode,
            filesBinding: restored.filesBinding,
          };
          connectionRef.current = next;
          setConnection(next);
          setPhase("ready-files");
          setNotice(
            "Restored the verified QRF3 connection. Resume Files capture; already received blocks remain on disk.",
          );
        })
        .catch((caught) => {
          if (cancelled) return;
          setPhase("failed");
          setError(`The saved QRF3 receiver session is invalid: ${toMessage(caught)}`);
        });
    }

    return () => {
      cancelled = true;
      generationRef.current += 1;
      verificationAbortRef.current?.abort();
      destinationAbortRef.current?.abort();
      void stopScanner().catch(() => undefined);
      void Promise.allSettled([
        queueRef.current,
        destinationTaskRef.current,
      ]).then(() => closeReceiver().catch(() => undefined));
    };
  }, [closeReceiver, stopScanner]);

  const reset = useCallback(async () => {
    if (resetInFlightRef.current) return;
    resetInFlightRef.current = true;
    const generation = ++generationRef.current;
    completionStartedRef.current = false;
    setPhase("discarding");
    verificationAbortRef.current?.abort();
    verificationAbortRef.current = null;
    destinationAbortRef.current?.abort();
    await stopScanner().catch(() => undefined);
    await Promise.allSettled([queueRef.current, destinationTaskRef.current]);
    destinationAbortRef.current = null;
    const receiver = receiverRef.current;
    let cleanupError: string | null = null;
    await receiver?.delete().catch((caught) => {
      cleanupError = toMessage(caught);
    });
    if (!cleanupError && receiverRef.current === receiver) {
      receiverRef.current = null;
    }
    await deleteAllBlockStores().catch((caught: unknown) => {
      cleanupError = toMessage(caught);
    });
    await clearQrf3ReceiverConnection().catch((caught) => {
      cleanupError = toMessage(caught);
    });
    resetInFlightRef.current = false;
    if (generation !== generationRef.current) return;
    readerRef.current = null;
    queueRef.current = Promise.resolve();
    modeRef.current = "probe";
    connectionRef.current = null;
    setStatus({ state: "awaiting-manifest" });
    setConnection(null);
    setTree(null);
    setDestinationProgress(null);
    setReport(null);
    setError(cleanupError);
    setNotice(null);
    samplesRef.current = [];
    priorBytesRef.current = 0;
    setPhase(cleanupError ? "failed" : "idle");
  }, [stopScanner]);

  const finishProbe = useCallback(async (
    receiver: LargeQrf3Receiver,
    manifest: Qrf3Manifest,
    generation: number,
  ) => {
    const controller = new AbortController();
    verificationAbortRef.current = controller;
    const reader = await receiver.verifyComplete(controller.signal);
    throwIfLifecycleChanged(controller.signal, generation, generationRef.current);
    const bytes = await reader.read(0n, manifest.transferLength);
    throwIfLifecycleChanged(controller.signal, generation, generationRef.current);
    await receiver.delete();
    if (receiverRef.current === receiver) receiverRef.current = null;
    throwIfLifecycleChanged(controller.signal, generation, generationRef.current);
    const restored = await saveQrf3ReceiverConnection(bytes, manifest);
    throwIfLifecycleChanged(controller.signal, generation, generationRef.current);
    const next: VerifiedProbe = {
      receiptCode: restored.receiptCode,
      filesBinding: restored.filesBinding,
    };
    if (verificationAbortRef.current === controller) verificationAbortRef.current = null;
    connectionRef.current = next;
    setConnection(next);
    setStatus({ state: "awaiting-manifest" });
    setPhase("test-verified");
    setNotice("The complete QRF3 probe is verified. Enter the receipt on the sender, then start Files capture.");
  }, []);

  const finishFiles = useCallback(async (
    receiver: LargeQrf3Receiver,
    generation: number,
  ) => {
    const controller = new AbortController();
    verificationAbortRef.current = controller;
    const reader = await receiver.verifyComplete(controller.signal);
    throwIfLifecycleChanged(controller.signal, generation, generationRef.current);
    const verifiedStatus = receiver.status();
    const manifest = verifiedStatus.manifest;
    const verified = connectionRef.current;
    if (!manifest || !verified || !matchesQrf3FilesBinding(verified.filesBinding, manifest, verifiedStatus.manifestId)) {
      throw new Error("The completed Files stream does not match the verified QRF3 probe.");
    }
    const parsedTree = await readLargeTreeManifest(reader);
    throwIfLifecycleChanged(controller.signal, generation, generationRef.current);
    if (verificationAbortRef.current === controller) verificationAbortRef.current = null;
    readerRef.current = reader;
    setTree(parsedTree);
    setPhase("complete");
    setNotice("The disk-backed stream and SHA-256 are complete. Choose a destination to reconstruct and verify the tree.");
  }, []);

  const ingest = useCallback((encoded: string, generation: number) => {
    if (completionStartedRef.current) return;
    let taskGeneration = generation;
    queueRef.current = queueRef.current.then(async () => {
      if (generation !== generationRef.current || completionStartedRef.current) return;
      const receiver = receiverRef.current;
      if (!receiver) return;
      const next = await receiver.accept(encoded);
      if (generation !== generationRef.current) return;
      setStatus(next);
      const progress = next.progress;
      if (progress && !next.duplicate) {
        const now = Date.now();
        const delta = Math.max(0, progress.receivedBytes - priorBytesRef.current);
        priorBytesRef.current = progress.receivedBytes;
        if (delta > 0) samplesRef.current.push({ at: now, bytes: delta });
        samplesRef.current = samplesRef.current.filter((sample) => now - sample.at <= 8_000);
        setMetricsNow(now);
      }
      if (next.state !== "complete" || !next.manifest) return;
      completionStartedRef.current = true;
      taskGeneration = ++generationRef.current;
      setPhase("verifying");
      // Stop camera production before the whole-stream read. Already queued
      // callbacks carry the old generation and become no-ops.
      await stopScanner().catch(() => undefined);
      throwIfLifecycleChanged(undefined, taskGeneration, generationRef.current);
      if (modeRef.current === "probe") {
        await finishProbe(receiver, next.manifest, taskGeneration);
      } else {
        await finishFiles(receiver, taskGeneration);
      }
    }).catch(async (caught) => {
      if (taskGeneration !== generationRef.current) return;
      verificationAbortRef.current = null;
      if (isAbortError(caught)) return;
      if (
        !completionStartedRef.current &&
        isLargeReceiverTerminalStorageError(caught)
      ) {
        taskGeneration = ++generationRef.current;
        completionStartedRef.current = false;
        await stopScanner().catch(() => undefined);
        const receiver = receiverRef.current;
        if (receiverRef.current === receiver) receiverRef.current = null;
        let closeError: string | null = null;
        await receiver?.close().catch((error) => {
          closeError = toMessage(error);
        });
        if (taskGeneration !== generationRef.current) return;
        setStatus({ state: "awaiting-manifest" });
        setError(closeError);
        setPhase(connectionRef.current ? "ready-files" : "idle");
        setNotice(
          closeError
            ? `The latest block is durable, but the old disk session did not close cleanly: ${closeError}. Reload this page before resuming.`
            : "The latest block is durable. The disk session reached its receipt-journal safety limit, so capture stopped; start again and rescan the manifest to resume stored blocks.",
        );
        return;
      }
      setError(toMessage(caught));
      if (!completionStartedRef.current) return;
      completionStartedRef.current = false;
      const receiver = receiverRef.current;
      let cleanupError: string | null = caught instanceof LargeReceiverPoisonCleanupError
        ? toMessage(caught)
        : null;
      await receiver?.delete().catch((deleteError) => {
        cleanupError = toMessage(deleteError);
      });
      if (taskGeneration !== generationRef.current) return;
      if (!cleanupError && receiverRef.current === receiver) {
        receiverRef.current = null;
      }
      readerRef.current = null;
      if (cleanupError) {
        setPhase("failed");
        setNotice(
          `Completion failed, and durable cleanup also failed: ${cleanupError}. Use Discard stored data before retrying.`,
        );
      } else {
        setStatus({ state: "awaiting-manifest" });
        setPhase(connectionRef.current ? "ready-files" : "idle");
        setNotice("Completion failed and the received store was discarded. You can now restart a clean capture.");
      }
    });
  }, [finishFiles, finishProbe, stopScanner]);

  const start = useCallback(async (mode: "probe" | "files") => {
    const capabilityError = largeReceiverStartCapabilityError();
    if (capabilityError) {
      setError(capabilityError);
      return;
    }
    const verified = connectionRef.current;
    if (mode === "files" && !verified) {
      setError("Complete or restore a verified QRF3 connection test first.");
      return;
    }
    const generation = ++generationRef.current;
    completionStartedRef.current = false;
    verificationAbortRef.current?.abort();
    verificationAbortRef.current = null;
    let receiver: LargeQrf3Receiver | undefined;
    let scanner: QrScanner | undefined;
    try {
      await stopScanner().catch(() => undefined);
      await queueRef.current.catch(() => undefined);
      await closeReceiver();
      queueRef.current = Promise.resolve();
      if (!activeRef.current || generation !== generationRef.current) return;
      setError(null);
      setNotice(null);
      setPhase("starting");
      modeRef.current = mode;
      samplesRef.current = [];
      priorBytesRef.current = 0;
      receiver = new LargeQrf3Receiver({
        expectedPurpose: mode === "probe" ? Qrf3TransferPurpose.ConnectionTest : Qrf3TransferPurpose.Files,
        expectedConnectionId: verified?.filesBinding.connectionId,
        expectedTransferId: mode === "files" ? verified?.filesBinding.transferId : undefined,
        expectedManifestId: mode === "files" ? verified?.filesBinding.manifestId : undefined,
        checkQuota: true,
        requestPersistence: true,
        backend: "opfs",
      });
      receiverRef.current = receiver;
      setStatus({ state: "awaiting-manifest" });
      const video = videoRef.current;
      const overlay = overlayRef.current;
      if (!video || !overlay) throw new Error("The camera view is not ready.");
      scanner = new QrScanner(video, (result) => ingest(result.data, generation), {
        preferredCamera: selectedCameraRef.current,
        maxScansPerSecond: 14,
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        overlay,
        onDecodeError: () => undefined,
      });
      scannerRef.current = scanner;
      await scanner.start();
      if (!activeRef.current || generation !== generationRef.current) {
        await stopScanner(scanner).catch(() => undefined);
        await closeReceiver(receiver).catch(() => undefined);
        return;
      }
      const nextCameras = await QrScanner.listCameras(false);
      if (!activeRef.current || generation !== generationRef.current) {
        await stopScanner(scanner).catch(() => undefined);
        await closeReceiver(receiver).catch(() => undefined);
        return;
      }
      setCameras(nextCameras);
      setPhase(mode === "probe" ? "testing" : "scanning");
    } catch (caught) {
      if (scanner) await stopScanner(scanner).catch(() => undefined);
      let receiverCloseError: string | null = null;
      if (receiver) {
        await closeReceiver(receiver).catch((closeError) => {
          receiverCloseError = toMessage(closeError);
        });
      }
      if (generation !== generationRef.current) return;
      const receiverStillOpen = receiverRef.current !== null;
      setPhase(receiverStillOpen ? "failed" : connectionRef.current ? "ready-files" : "idle");
      if (receiverStillOpen) {
        setNotice(
          `The durable receiver could not be closed${receiverCloseError ? `: ${receiverCloseError}` : ""}. Discard stored data before retrying.`,
        );
      }
      setError(toMessage(caught));
    }
  }, [closeReceiver, ingest, stopScanner]);

  const pause = useCallback(async () => {
    const generation = ++generationRef.current;
    completionStartedRef.current = false;
    verificationAbortRef.current?.abort();
    verificationAbortRef.current = null;
    await stopScanner().catch(() => undefined);
    await queueRef.current.catch(() => undefined);
    let closeError: string | null = null;
    await closeReceiver().catch((caught) => {
      closeError = toMessage(caught);
    });
    queueRef.current = Promise.resolve();
    if (generation !== generationRef.current) return;
    if (closeError) {
      setError(closeError);
      setNotice("The durable receiver could not be closed. Discard stored data before retrying.");
      setPhase("failed");
      return;
    }
    if (activeRef.current && phase !== "verifying") {
      setNotice("Capture paused. Restarting will reopen the same durable transfer by manifest identity.");
    }
    setPhase("paused");
  }, [closeReceiver, phase, stopScanner]);

  useEffect(() => {
    if (
      !active &&
      (phase === "starting" ||
        phase === "testing" ||
        phase === "scanning" ||
        phase === "verifying")
    ) {
      void pause();
    }
    if (!active && phase === "saving") destinationAbortRef.current?.abort();
  }, [active, pause, phase]);

  const save = useCallback((): Promise<void> => {
    const reader = readerRef.current;
    const manifest = status.manifest;
    if (!tree || !reader || !manifest) return Promise.resolve();
    const showDirectoryPicker = window.showDirectoryPicker?.bind(window);
    if (!showDirectoryPicker) {
      setError("Large tree reconstruction requires the Chromium directory picker.");
      return Promise.resolve();
    }
    const generation = generationRef.current;
    const controller = new AbortController();
    destinationAbortRef.current?.abort();
    destinationAbortRef.current = controller;
    const operation = (async () => {
      try {
        setError(null);
        setDestinationProgress(null);
        setPhase("saving");
        const parent = await showDirectoryPicker({
          id: "qr-air-gap-large-destination",
          mode: "readwrite",
        });
        throwIfLifecycleChanged(controller.signal, generation, generationRef.current);
        const nextReport = await writeLargeTreeToDirectory(
          tree,
          reader,
          {
            transferId: manifest.transferId,
            streamSha256: manifest.archiveSha256,
          },
          parent,
          {
            onProgress: (progress) => {
              if (generation === generationRef.current && !controller.signal.aborted) {
                setDestinationProgress(progress);
              }
            },
            signal: controller.signal,
          },
        );
        throwIfLifecycleChanged(controller.signal, generation, generationRef.current);
        const receiver = receiverRef.current;
        let cleanupError: string | null = null;
        let receiverDeleteFailed = false;
        await receiver?.delete().catch((caught) => {
          receiverDeleteFailed = true;
          cleanupError = toMessage(caught);
        });
        await clearQrf3ReceiverConnection().catch((caught) => {
          cleanupError = toMessage(caught);
        });
        throwIfLifecycleChanged(controller.signal, generation, generationRef.current);
        if (!receiverDeleteFailed && receiverRef.current === receiver) {
          receiverRef.current = null;
        }
        readerRef.current = null;
        connectionRef.current = null;
        setConnection(null);
        setReport(nextReport);
        if (cleanupError) {
          setNotice(`The destination verified, but stored-transfer cleanup failed: ${cleanupError}`);
        }
        setPhase("verified");
      } catch (caught) {
        if (generation !== generationRef.current) return;
        setPhase("complete");
        if (isAbortError(caught)) {
          setNotice("Destination writing was cancelled. The verified source remains available to retry.");
        } else {
          setError(toMessage(caught));
        }
      } finally {
        if (destinationAbortRef.current === controller) {
          destinationAbortRef.current = null;
        }
      }
    })();
    const settled = operation.then(() => undefined, () => undefined);
    destinationTaskRef.current = settled;
    void settled.then(() => {
      if (destinationTaskRef.current === settled) {
        destinationTaskRef.current = Promise.resolve();
      }
    });
    return operation;
  }, [status.manifest, tree]);

  useEffect(() => {
    if (phase !== "testing" && phase !== "scanning") return;
    const timer = window.setInterval(() => setMetricsNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [phase]);

  const progress = status.progress;
  const percent = progress ? progress.receivedBlocks / Math.max(1, progress.totalBlocks) * 100 : 0;
  const samples = samplesRef.current.filter((sample) => metricsNow - sample.at <= 8_000);
  const seconds = samples.length > 1 ? Math.max(1, (metricsNow - samples[0].at) / 1000) : 0;
  const rate = seconds ? samples.reduce((sum, sample) => sum + sample.bytes, 0) / seconds : 0;
  const remaining = progress ? progress.totalBytes - progress.receivedBytes : 0;
  const scanning = phase === "testing" || phase === "scanning";
  const canStart = phase === "idle" || phase === "ready-files" || phase === "paused";

  return (
    <section className="workspace" aria-labelledby="large-receiver-title">
      <div className="page-heading"><span className="eyebrow">Disk-backed optical receiver</span><h1 id="large-receiver-title">Receive QRF3 directly into durable browser storage.</h1><p>Each integrity-checked block is written at its final offset. Reload-safe receipt bits, not gigabytes of QR text or byte arrays, stay in memory.</p></div>
      <div className="transfer-card receiver-layout">
        <div className="panel">
          <div className="panel-kicker"><ScanLine size={14} />Camera channel</div><h2>Align the QR inside the guide</h2>
          <div className="camera-shell"><video ref={videoRef} muted playsInline aria-label="Live camera view" />{!scanning && phase !== "starting" && <div className="camera-empty"><span className="camera-empty-icon"><Camera size={27} /></span><strong>Camera is off</strong><span>Received QRF3 blocks remain in durable storage.</span></div>}{phase === "starting" && <div className="camera-empty"><span className="spinner" /><strong>Starting camera…</strong></div>}{scanning && <div className="camera-badge">{phase === "testing" ? "QRF3 probe" : "QRF3 Files"}</div>}<div ref={overlayRef} className={`scan-overlay ${scanning ? "visible" : ""}`}><div className="scan-line" /></div></div>
          <div className="field camera-picker"><label htmlFor="large-camera">Camera</label><select id="large-camera" value={selectedCamera} onChange={(event) => { const camera = event.target.value; setSelectedCamera(camera); selectedCameraRef.current = camera; void scannerRef.current?.setCamera(camera).catch((caught) => setError(toMessage(caught))); }}><option value="environment">Rear / environment camera</option><option value="user">Front / user camera</option>{cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.label}</option>)}</select></div>
          <div className="playback-controls">{canStart && <button className="button button-primary" type="button" onClick={() => void start(connection ? "files" : "probe")}><Camera size={16} />{connection ? "Receive verified Files" : "Start QRF3 connection test"}</button>}<button className="button button-secondary" type="button" disabled={!scanning} onClick={() => void pause()}><CameraOff size={16} />Pause camera</button><button className="button button-secondary" type="button" disabled={phase === "discarding"} onClick={() => void reset()}><Trash2 size={16} />{phase === "discarding" ? "Discarding…" : "Discard stored data"}</button></div>
        </div>

        <div className="panel"><div className="receiver-status"><div className="panel-kicker"><ShieldCheck size={14} />Integrity gate</div>
          {phase === "test-verified" && connection ? <div className="receipt-success"><span className="completion-icon"><KeyRound size={34} /></span><h3>QRF3 probe verified</h3><p>Enter this receipt on the sender. It binds the exact Files manifest, stream hash, size, and session.</p><output className="receipt-code">{connection.receiptCode}</output><div className="verification-list"><div className="verification-item"><Check size={14} />Complete probe SHA-256</div><div className="verification-item"><Check size={14} />Exact Files manifest bound</div><div className="verification-item"><Check size={14} />Disk-backed resume ready</div></div><button className="button button-primary button-wide" type="button" onClick={() => { setPhase("ready-files"); setNotice("Start Files capture after the sender accepts the receipt."); }}>Continue</button></div>
          : phase === "complete" || phase === "saving" ? <div className="completion"><span className="completion-icon"><FolderCheck size={34} /></span><h3>Stream SHA-256 verified</h3><p>{tree?.files.length.toLocaleString()} files · {tree ? formatBytes(Number(tree.totalFileBytes)) : ""}. Reconstruction re-hashes every destination file.</p>{destinationProgress && <div className="status-box"><span className="spinner" /><span>{destinationProgress.phase} · {destinationProgress.path ?? "tree"} · {destinationProgress.filesComplete} / {destinationProgress.filesTotal}</span></div>}<button className="button button-primary button-wide" type="button" disabled={phase === "saving"} onClick={() => void save()}><FolderCheck size={16} />{phase === "saving" ? "Writing and verifying…" : "Choose destination and verify"}</button></div>
          : phase === "verified" && report ? <div className="completion"><span className="completion-icon"><CheckCircle2 size={34} /></span><h3>Large tree verified</h3><p>{report.filesWritten.toLocaleString()} files written, {report.filesReused.toLocaleString()} resumed, {report.directoriesVerified.toLocaleString()} folders verified.</p><button className="button button-secondary button-wide" type="button" onClick={() => void reset()}><RefreshCw size={15} />Receive another transfer</button></div>
          : <><h2>{connection ? "Receiving verified Files" : "Receiving QRF3 probe"}</h2><div className="progress-ring-wrap"><div className="progress-ring" style={{ "--progress": `${percent}%` } as React.CSSProperties} /><div className="progress-ring-content"><strong>{Math.floor(percent)}%</strong><span>captured</span></div></div><dl className="stat-list"><div className="stat-row"><dt>Unique blocks</dt><dd>{progress?.receivedBlocks.toLocaleString() ?? "—"} / {progress?.totalBlocks.toLocaleString() ?? "—"}</dd></div><div className="stat-row"><dt>Durable payload</dt><dd>{progress ? formatBytes(progress.receivedBytes) : "—"}</dd></div><div className="stat-row"><dt>Capture speed</dt><dd>{rate ? formatRate(rate) : "Measuring…"}</dd></div><div className="stat-row"><dt>ETA</dt><dd>{rate ? formatEta(remaining / rate) : "—"}</dd></div><div className="stat-row"><dt>Storage</dt><dd><Database size={14} /> OPFS disk</dd></div></dl></>}
          {error && <div className="status-box error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}{notice && <div className="status-box"><AlertTriangle size={16} /><span>{notice}</span></div>}
        </div></div>
      </div>
      <div className="notice-strip"><ShieldCheck size={16} /><span>Completion requires integrity-checked frame routing, a complete stream SHA-256, canonical tree metadata, exact destination paths, and a second per-file SHA-256 readback.</span></div>
    </section>
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfLifecycleChanged(
  signal: AbortSignal | undefined,
  expectedGeneration: number,
  currentGeneration: number,
): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was cancelled.", "AbortError");
  }
  if (expectedGeneration !== currentGeneration) {
    throw new DOMException("The receiver lifecycle changed.", "AbortError");
  }
}

function largeReceiverStorageCapabilityError(): string | null {
  if (typeof navigator.storage?.getDirectory !== "function") {
    return "Large receive mode requires Chromium Origin Private File System support.";
  }
  if (typeof Worker === "undefined") {
    return "Large receive mode requires dedicated Worker support for safe disk writes.";
  }
  if (typeof navigator.locks?.request !== "function") {
    return "Large receive mode requires Web Locks so another tab cannot corrupt the same durable transfer.";
  }
  if (!supportsQrf3ReceiverResume()) {
    return "Large receive mode requires IndexedDB to preserve the verified connection across reloads.";
  }
  return null;
}

function largeReceiverStartCapabilityError(): string | null {
  const storageError = largeReceiverStorageCapabilityError();
  if (storageError) return storageError;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return "Camera access requires http://127.0.0.1 or HTTPS in a browser with camera support.";
  }
  return null;
}
