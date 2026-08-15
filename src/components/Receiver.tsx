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
  Database,
  Download,
  FolderCheck,
  KeyRound,
  RefreshCw,
  Save,
  ScanLine,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  MAX_DIRECT_WRITE_ENTRIES,
  downloadArchive,
  extractArchive,
  writeAndVerifyArchive,
  type SelectedEntry,
  type VerificationReport,
} from "../lib/archive";
import {
  CONNECTION_TEST_ROOT_NAME,
  verifyConnectionTest,
  type FilesTransferBinding,
} from "../lib/connection";
import {
  FrameType,
  TransferAccumulator,
  TransferPurpose,
  parseEncodedFrame,
  type AccumulatorResult,
} from "../lib/protocol";
import {
  deleteResumeCheckpoint,
  deleteResumeCheckpointIfUnchanged,
  deleteResumeFrame,
  listResumeCheckpoints,
  loadResumeFrames,
  resumeCheckpointKey,
  saveResumeCheckpoint,
  saveResumeFrame,
  supportsDurableResume,
  verifyResumeCheckpointProof,
  type ResumeCheckpoint,
} from "../lib/resume";
import {
  formatBytes,
  formatClock,
  formatEta,
  formatRate,
} from "../lib/format";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = 200_000;
const RATE_WINDOW_MS = 8_000;
const STALE_AFTER_MS = 5_000;
const STALLED_AFTER_MS = 30_000;

type ScanMode = "connection-test" | "files";
type ReceiverPhase =
  | "idle"
  | "starting"
  | "testing"
  | "test-verified"
  | "scanning"
  | "finalizing"
  | "paused"
  | "restoring"
  | "archive-ready"
  | "archive-error"
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
  expectedArchiveBytes?: number;
  percent: number;
}

interface VerifiedConnection {
  connectionId: Uint8Array;
  filesBinding: FilesTransferBinding;
  receiptCode: string;
  probeTransferId: number;
  probeArchiveBytes: Uint8Array;
  restored: boolean;
}

interface RateSample {
  at: number;
  bytes: number;
}

interface CameraChoice {
  id: string;
  label: string;
}

const EMPTY_PROGRESS: ProgressState = {
  receivedChunks: 0,
  totalChunks: 0,
  receivedBytes: 0,
  percent: 0,
};

function createProbeAccumulator() {
  return new TransferAccumulator({
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxTotalChunks: MAX_CHUNKS,
    expectedPurpose: TransferPurpose.ConnectionTest,
  });
}

function createFilesAccumulator(binding: FilesTransferBinding) {
  return new TransferAccumulator({
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxTotalChunks: MAX_CHUNKS,
    expectedPurpose: TransferPurpose.Files,
    expectedConnectionId: binding.connectionId,
    expectedTransferId: binding.transferId,
    expectedArchiveSha256: binding.archiveSha256,
    expectedManifestSha256: binding.manifestSha256,
  });
}

function createResumeCheckpointForConnection(
  connection: VerifiedConnection,
  result?: AccumulatorResult,
): ResumeCheckpoint {
  if (
    result?.transferId !== undefined &&
    result.transferId !== connection.filesBinding.transferId
  ) {
    throw new Error("Files progress does not match the verified dummy binding.");
  }
  const connectionId = bytesToHex(connection.connectionId);
  const transferId = connection.filesBinding.transferId;
  return {
    version: 2,
    key: resumeCheckpointKey(connectionId, transferId),
    connectionId,
    probeTransferId: connection.probeTransferId,
    probeArchiveBytes: connection.probeArchiveBytes.slice(),
    transferId,
    rootName: result?.rootName,
    receivedChunks: result?.receivedChunks ?? 0,
    totalChunks: result?.totalChunks ?? 0,
    receivedBytes: result?.receivedBytes ?? 0,
    expectedArchiveBytes: result?.expectedArchiveBytes,
    expectedArchiveSha256: bytesToHex(
      connection.filesBinding.archiveSha256,
    ),
    expectedManifestSha256: bytesToHex(
      connection.filesBinding.manifestSha256,
    ),
    updatedAt: Date.now(),
  };
}

export function Receiver({ active = true }: { active?: boolean }) {
  const [phase, setPhase] = useState<ReceiverPhase>("idle");
  const [scanMode, setScanMode] = useState<ScanMode>("connection-test");
  const [connection, setConnection] = useState<VerifiedConnection | null>(null);
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const [archive, setArchive] = useState<ReceivedArchive | null>(null);
  const [verification, setVerification] =
    useState<VerificationReport | null>(null);
  const [savedCheckpoint, setSavedCheckpoint] =
    useState<ResumeCheckpoint | null>(null);
  const [activeCheckpointKey, setActiveCheckpointKey] = useState<string | null>(
    null,
  );
  const [checkpointStatus, setCheckpointStatus] = useState<
    "none" | "saving" | "saved" | "error"
  >("none");
  const [checkpointsLoaded, setCheckpointsLoaded] = useState(
    !supportsDurableResume(),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [metricsNow, setMetricsNow] = useState(Date.now());
  const [cameras, setCameras] = useState<CameraChoice[]>([]);
  const [selectedCamera, setSelectedCamera] = useState("environment");
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanOverlayRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const selectedCameraRef = useRef(selectedCamera);
  const accumulatorRef = useRef(createProbeAccumulator());
  const ingestQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const scanModeRef = useRef<ScanMode>("connection-test");
  const connectionRef = useRef<VerifiedConnection | null>(null);
  const lastReceivedBytesRef = useRef(0);
  const lastAcceptedAtRef = useRef<number | null>(null);
  const rateSamplesRef = useRef<RateSample[]>([]);
  const activeElapsedMsRef = useRef(0);
  const activeSegmentStartedRef = useRef<number | null>(null);
  const completionHandledRef = useRef(false);
  const receiverGenerationRef = useRef(0);
  const activeRef = useRef(active);
  const activeCheckpointKeyRef = useRef<string | null>(null);
  const pendingProofCheckpointKeyRef = useRef<string | null>(null);
  const pendingCheckpointWritesRef = useRef(0);
  const pendingCheckpointFramesRef = useRef(new Map<string, number>());
  const failedCheckpointFramesRef = useRef(new Set<string>());

  useEffect(() => {
    selectedCameraRef.current = selectedCamera;
  }, [selectedCamera]);

  useEffect(() => {
    if (!navigator.mediaDevices) return;
    const refresh = () => {
      void QrScanner.listCameras(false)
        .then((next) => setCameras(next))
        .catch(() => undefined);
    };
    refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () =>
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
  }, []);

  activeRef.current = active;
  connectionRef.current = connection;
  scanModeRef.current = scanMode;

  const fileEntries = useMemo(
    () => archive?.entries.filter((entry) => !entry.directory) ?? [],
    [archive],
  );
  const uncompressedBytes = useMemo(
    () => fileEntries.reduce((sum, entry) => sum + entry.bytes.length, 0),
    [fileEntries],
  );

  const beginMetrics = useCallback(() => {
    const now = Date.now();
    activeSegmentStartedRef.current ??= now;
    rateSamplesRef.current = [];
    lastAcceptedAtRef.current = now;
    setMetricsNow(now);
  }, []);

  const freezeMetrics = useCallback(() => {
    const started = activeSegmentStartedRef.current;
    if (started !== null) {
      activeElapsedMsRef.current += Date.now() - started;
      activeSegmentStartedRef.current = null;
    }
    setMetricsNow(Date.now());
  }, []);

  const resetMetrics = useCallback(() => {
    activeElapsedMsRef.current = 0;
    activeSegmentStartedRef.current = null;
    lastReceivedBytesRef.current = 0;
    lastAcceptedAtRef.current = null;
    rateSamplesRef.current = [];
    setMetricsNow(Date.now());
  }, []);

  const stopScannerInstance = useCallback(
    async (scanner: QrScanner, destroy = true) => {
      if (scannerRef.current === scanner) scannerRef.current = null;
      try {
        await scanner.pause(true);
      } finally {
        if (destroy) scanner.destroy();
      }
    },
    [],
  );

  const stopScanner = useCallback(async (destroy = true) => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    if (scannerRef.current === scanner) scannerRef.current = null;
    await stopScannerInstance(scanner, destroy);
  }, [stopScannerInstance]);

  const updateProgress = useCallback((result: AccumulatorResult) => {
    setProgress({
      transferId: result.transferId,
      rootName: result.rootName,
      receivedChunks: result.receivedChunks,
      totalChunks: result.totalChunks,
      receivedBytes: result.receivedBytes,
      expectedArchiveBytes: result.expectedArchiveBytes,
      percent: result.percent,
    });
  }, []);

  const queueCheckpointWrite = useCallback(
    (
      encoded: string,
      result: AccumulatorResult,
      generation: number,
      retryOnly = false,
    ) => {
      if (!supportsDurableResume()) return;
      const currentConnection = connectionRef.current;
      if (
        scanModeRef.current !== "files" ||
        !currentConnection ||
        result.transferId === undefined ||
        !result.connectionId
      ) {
        return;
      }
      let parsed;
      try {
        parsed = parseEncodedFrame(encoded);
      } catch {
        return;
      }
      const checkpoint = createResumeCheckpointForConnection(
        currentConnection,
        result,
      );
      const key = checkpoint.key;
      const position = parsed.type === FrameType.Manifest ? -1 : parsed.chunkIndex;
      const frameId = `${key}:${position}`;
      const pendingForFrame =
        pendingCheckpointFramesRef.current.get(frameId) ?? 0;
      if (
        retryOnly &&
        (!failedCheckpointFramesRef.current.has(frameId) || pendingForFrame > 0)
      ) {
        return;
      }
      setActiveCheckpointKey(key);
      activeCheckpointKeyRef.current = key;
      setSavedCheckpoint(checkpoint);
      setCheckpointStatus("saving");
      pendingCheckpointWritesRef.current += 1;
      pendingCheckpointFramesRef.current.set(frameId, pendingForFrame + 1);
      persistenceQueueRef.current = persistenceQueueRef.current
        .then(() => saveResumeFrame(checkpoint, position, encoded))
        .then(() => {
          pendingCheckpointWritesRef.current = Math.max(
            0,
            pendingCheckpointWritesRef.current - 1,
          );
          decrementPendingCheckpointFrame(
            pendingCheckpointFramesRef.current,
            frameId,
          );
          failedCheckpointFramesRef.current.delete(frameId);
          if (generation !== receiverGenerationRef.current) return;
          setCheckpointStatus(
            failedCheckpointFramesRef.current.size > 0
              ? "error"
              : pendingCheckpointWritesRef.current > 0
                ? "saving"
                : "saved",
          );
        })
        .catch((caught) => {
          pendingCheckpointWritesRef.current = Math.max(
            0,
            pendingCheckpointWritesRef.current - 1,
          );
          decrementPendingCheckpointFrame(
            pendingCheckpointFramesRef.current,
            frameId,
          );
          failedCheckpointFramesRef.current.add(frameId);
          if (generation !== receiverGenerationRef.current) return;
          setCheckpointStatus("error");
          setError(
            toMessage(
              caught,
              "Progress is still safe in memory, but its durable checkpoint could not be saved.",
            ),
          );
        });
    },
    [],
  );

  const queueCheckpointConflictDelete = useCallback(
    (encoded: string, result: AccumulatorResult, generation: number) => {
      if (!supportsDurableResume()) return;
      const currentConnection = connectionRef.current;
      if (
        !currentConnection ||
        result.transferId === undefined ||
        !result.connectionId
      ) {
        return;
      }
      let parsed;
      try {
        parsed = parseEncodedFrame(encoded);
      } catch {
        return;
      }
      const key = resumeCheckpointKey(
        bytesToHex(currentConnection.connectionId),
        result.transferId,
      );
      const position = parsed.type === FrameType.Manifest ? -1 : parsed.chunkIndex;
      const frameId = `${key}:${position}`;
      setCheckpointStatus("saving");
      pendingCheckpointWritesRef.current += 1;
      persistenceQueueRef.current = persistenceQueueRef.current
        .then(() => deleteResumeFrame(key, position))
        .then(() => {
          pendingCheckpointWritesRef.current = Math.max(
            0,
            pendingCheckpointWritesRef.current - 1,
          );
          failedCheckpointFramesRef.current.delete(frameId);
          if (generation !== receiverGenerationRef.current) return;
          setCheckpointStatus(
            failedCheckpointFramesRef.current.size > 0
              ? "error"
              : pendingCheckpointWritesRef.current > 0
                ? "saving"
                : "saved",
          );
          setNotice(
            "A conflicting chunk slot was removed from memory and the checkpoint; a later loop will reacquire it.",
          );
        })
        .catch((caught) => {
          pendingCheckpointWritesRef.current = Math.max(
            0,
            pendingCheckpointWritesRef.current - 1,
          );
          failedCheckpointFramesRef.current.add(frameId);
          if (generation !== receiverGenerationRef.current) return;
          setCheckpointStatus("error");
          setError(
            toMessage(caught, "A conflicted checkpoint slot could not be removed."),
          );
        });
    },
    [],
  );

  const finishFilesTransfer = useCallback(
    async (
      result: AccumulatorResult,
      accumulator: TransferAccumulator,
    ) => {
      if (
        result.status !== "complete" ||
        !result.archiveBytes ||
        !result.rootName ||
        completionHandledRef.current
      ) {
        return;
      }
      completionHandledRef.current = true;
      setPhase("finalizing");
      freezeMetrics();
      let scannerWarning: string | null = null;
      try {
        await stopScanner(true);
      } catch (caught) {
        scannerWarning = toMessage(
          caught,
          "The camera reported an error while stopping, but archive verification continued.",
        );
      }
      if (accumulator !== accumulatorRef.current) return;
      try {
        const entries = extractArchive(result.archiveBytes);
        setArchive({
          bytes: result.archiveBytes,
          entries,
          rootName: result.rootName,
        });
        setProgress((current) => ({ ...current, percent: 100 }));
        setNotice(scannerWarning);
        setError(null);
        setPhase("archive-ready");
      } catch (caught) {
        setError(
          toMessage(
            caught,
            "The archive passed transfer hashing but could not be safely unpacked.",
          ),
        );
        setPhase("archive-error");
      }
    },
    [freezeMetrics, stopScanner],
  );

  const finishConnectionTest = useCallback(
    async (
      result: AccumulatorResult,
      accumulator: TransferAccumulator,
    ) => {
      if (
        result.status !== "complete" ||
        !result.archiveBytes ||
        !result.connectionId ||
        result.transferId === undefined ||
        result.rootName !== CONNECTION_TEST_ROOT_NAME ||
        completionHandledRef.current
      ) {
        return;
      }
      completionHandledRef.current = true;
      setPhase("finalizing");
      freezeMetrics();
      let scannerWarning: string | null = null;
      try {
        await stopScanner(true);
      } catch (caught) {
        scannerWarning = toMessage(
          caught,
          "The camera reported an error while stopping, but dummy verification continued.",
        );
      }
      if (accumulator !== accumulatorRef.current) return;
      let persistedProofCheckpoint: ResumeCheckpoint | null = null;
      try {
        const verified = await verifyConnectionTest(
          result.archiveBytes,
          result.connectionId,
          result.transferId,
        );
        if (accumulator !== accumulatorRef.current) return;
        const nextConnection: VerifiedConnection = {
          connectionId: verified.connectionId.slice(),
          filesBinding: {
            transferId: verified.filesBinding.transferId,
            archiveSha256: verified.filesBinding.archiveSha256.slice(),
            manifestSha256: verified.filesBinding.manifestSha256.slice(),
            connectionId: verified.filesBinding.connectionId.slice(),
          },
          receiptCode: verified.receiptCode,
          probeTransferId: verified.probeTransferId,
          probeArchiveBytes: verified.archiveBytes.slice(),
          restored: false,
        };
        const verifiedGeneration = ++receiverGenerationRef.current;
        let persistenceError: string | null = null;
        if (supportsDurableResume()) {
          const proofCheckpoint =
            createResumeCheckpointForConnection(nextConnection);
          pendingProofCheckpointKeyRef.current = proofCheckpoint.key;
          setCheckpointStatus("saving");
          const proofWrite = persistenceQueueRef.current.then(async () => {
            const stored = await saveResumeCheckpoint(proofCheckpoint);
            // Reset/unmount may win while IndexedDB is committing. Do not let an
            // unpublished verified session reappear after that reset.
            if (
              verifiedGeneration !== receiverGenerationRef.current ||
              accumulator !== accumulatorRef.current
            ) {
              await deleteResumeCheckpointIfUnchanged(stored);
              return null;
            }
            return stored;
          });
          persistenceQueueRef.current = proofWrite.then(
            () => undefined,
            () => undefined,
          );
          try {
            persistedProofCheckpoint = await proofWrite;
          } catch (caught) {
            if (
              verifiedGeneration !== receiverGenerationRef.current ||
              accumulator !== accumulatorRef.current
            ) {
              return;
            }
            persistenceError = `The dummy is verified in memory, but its reload-safe proof could not be saved: ${toMessage(caught, "resume storage failed")}. Keep this page open or repeat the dummy after reloading.`;
          } finally {
            if (
              pendingProofCheckpointKeyRef.current === proofCheckpoint.key
            ) {
              pendingProofCheckpointKeyRef.current = null;
            }
          }
          // The awaited put is not authority by itself: publish it only if the
          // same accumulator and generation still own this result.
          if (
            verifiedGeneration !== receiverGenerationRef.current ||
            accumulator !== accumulatorRef.current
          ) {
            if (persistedProofCheckpoint) {
              await deleteResumeCheckpointIfUnchanged(
                persistedProofCheckpoint,
              );
            }
            return;
          }
          if (persistedProofCheckpoint) {
            activeCheckpointKeyRef.current = persistedProofCheckpoint.key;
            setActiveCheckpointKey(persistedProofCheckpoint.key);
            setSavedCheckpoint(persistedProofCheckpoint);
            setCheckpointStatus("saved");
          } else {
            activeCheckpointKeyRef.current = null;
            setActiveCheckpointKey(null);
            setSavedCheckpoint(null);
            setCheckpointStatus("error");
          }
        } else {
          setCheckpointStatus("none");
        }
        connectionRef.current = nextConnection;
        setConnection(nextConnection);
        scanModeRef.current = "files";
        setScanMode("files");
        accumulatorRef.current = createFilesAccumulator(
          nextConnection.filesBinding,
        );
        ingestQueueRef.current = Promise.resolve();
        completionHandledRef.current = false;
        setProgress(EMPTY_PROGRESS);
        resetMetrics();
        setNotice(scannerWarning);
        setError(persistenceError);
        setPhase("test-verified");
      } catch (caught) {
        let cleanupWarning = "";
        if (persistedProofCheckpoint) {
          try {
            await deleteResumeCheckpointIfUnchanged(persistedProofCheckpoint);
          } catch (cleanupError) {
            cleanupWarning = ` The just-created proof checkpoint could not be cleaned up: ${toMessage(cleanupError, "cleanup failed")}.`;
          }
        }
        receiverGenerationRef.current += 1;
        accumulatorRef.current = createProbeAccumulator();
        ingestQueueRef.current = Promise.resolve();
        completionHandledRef.current = false;
        setProgress(EMPTY_PROGRESS);
        setError(
          `${toMessage(caught, "The dummy connection test was not valid.")}${cleanupWarning}`,
        );
        setPhase("idle");
      }
    },
    [freezeMetrics, resetMetrics, stopScanner],
  );

  const handleAccumulatorResult = useCallback(
    async (
      encoded: string,
      result: AccumulatorResult,
      generation: number,
      accumulator: TransferAccumulator,
    ) => {
      if (result.accepted) {
        const now = Date.now();
        lastAcceptedAtRef.current = now;
        if (result.conflict) {
          rateSamplesRef.current = [];
        } else if (!result.duplicate) {
          const delta = Math.max(
            0,
            result.receivedBytes - lastReceivedBytesRef.current,
          );
          if (delta > 0) {
            rateSamplesRef.current.push({ at: now, bytes: delta });
            rateSamplesRef.current = rateSamplesRef.current.filter(
              (sample) => now - sample.at <= RATE_WINDOW_MS,
            );
          }
        }
        lastReceivedBytesRef.current = result.receivedBytes;
        setMetricsNow(now);
      }

      if (result.accepted) {
        updateProgress(result);
        if (scanModeRef.current === "files") {
          if (result.conflict) {
            queueCheckpointConflictDelete(encoded, result, generation);
          } else {
            queueCheckpointWrite(
              encoded,
              result,
              generation,
              result.duplicate === true,
            );
          }
        }
      }

      if (result.status === "verification-failed") {
        lastReceivedBytesRef.current = 0;
        rateSamplesRef.current = [];
        const currentConnection = connectionRef.current;
        accumulatorRef.current =
          scanModeRef.current === "files" && currentConnection
            ? createFilesAccumulator(currentConnection.filesBinding)
            : createProbeAccumulator();
        completionHandledRef.current = false;
        setProgress(EMPTY_PROGRESS);
        const key = activeCheckpointKeyRef.current;
        if (
          key &&
          scanModeRef.current === "files" &&
          currentConnection
        ) {
          const proofCheckpoint =
            createResumeCheckpointForConnection(currentConnection);
          setCheckpointStatus("saving");
          pendingCheckpointWritesRef.current += 1;
          persistenceQueueRef.current = persistenceQueueRef.current
            .then(() => saveResumeCheckpoint(proofCheckpoint))
            .then((stored) => {
              pendingCheckpointWritesRef.current = Math.max(
                0,
                pendingCheckpointWritesRef.current - 1,
              );
              pendingCheckpointFramesRef.current.clear();
              failedCheckpointFramesRef.current.clear();
              if (generation !== receiverGenerationRef.current) return;
              activeCheckpointKeyRef.current = stored.key;
              setActiveCheckpointKey(stored.key);
              setSavedCheckpoint(stored);
              setCheckpointStatus(
                pendingCheckpointWritesRef.current > 0 ? "saving" : "saved",
              );
              setNotice(
                "Archive verification failed. Saved Files frames were cleared, while the re-verified dummy proof was retained for a clean retry.",
              );
            })
            .catch((caught) => {
              pendingCheckpointWritesRef.current = Math.max(
                0,
                pendingCheckpointWritesRef.current - 1,
              );
              if (generation !== receiverGenerationRef.current) return;
              setCheckpointStatus("error");
              setError(
                `Invalid Files frames could not be cleared from the durable checkpoint: ${toMessage(caught, "resume storage failed")}. Keep scanning only in this page, or discard the checkpoint before reloading.`,
              );
            });
        } else if (key) {
          setCheckpointStatus("saving");
          pendingCheckpointWritesRef.current += 1;
          persistenceQueueRef.current = persistenceQueueRef.current
            .then(() => deleteResumeCheckpoint(key))
            .then(() => {
              pendingCheckpointWritesRef.current = Math.max(
                0,
                pendingCheckpointWritesRef.current - 1,
              );
              if (generation !== receiverGenerationRef.current) return;
              activeCheckpointKeyRef.current = null;
              setActiveCheckpointKey(null);
              setSavedCheckpoint(null);
              setCheckpointStatus("none");
            })
            .catch((caught) => {
              pendingCheckpointWritesRef.current = Math.max(
                0,
                pendingCheckpointWritesRef.current - 1,
              );
              if (generation !== receiverGenerationRef.current) return;
              setCheckpointStatus("error");
              setError(
                toMessage(
                  caught,
                  "The invalid durable checkpoint could not be cleared; discard it before reloading.",
                ),
              );
            });
        }
        setNotice(
          result.error ?? "Hash verification failed; scanning the next loop.",
        );
        return;
      }

      if (scanModeRef.current === "connection-test") {
        await finishConnectionTest(result, accumulator);
      } else {
        await finishFilesTransfer(result, accumulator);
      }
    },
    [
      finishConnectionTest,
      finishFilesTransfer,
      queueCheckpointConflictDelete,
      queueCheckpointWrite,
      updateProgress,
    ],
  );

  const queueDecodedFrame = useCallback(
    (encoded: string, generation: number) => {
      ingestQueueRef.current = ingestQueueRef.current
        .then(async () => {
          if (generation !== receiverGenerationRef.current) return;
          const accumulator = accumulatorRef.current;
          const result = await accumulator.ingest(encoded);
          if (accumulator !== accumulatorRef.current) return;
          // A pause may advance the camera generation while the final SHA-256
          // is in flight. The accumulator identity, not camera lifecycle, owns
          // that verified result, so commit it to the same session.
          const currentGeneration = receiverGenerationRef.current;
          await handleAccumulatorResult(
            encoded,
            result,
            currentGeneration,
            accumulator,
          );
        })
        .catch((caught) => {
          if (generation !== receiverGenerationRef.current) return;
          setError(toMessage(caught, "A decoded frame could not be processed."));
        });
    },
    [handleAccumulatorResult],
  );

  const startScanner = useCallback(
    async (mode: ScanMode) => {
      if (completionHandledRef.current) return;
      setError(null);
      setNotice(null);
      if (!window.isSecureContext) {
        setError(
          "Camera access requires http://127.0.0.1 or HTTPS; do not open the app as a file.",
        );
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This browser does not expose a camera API.");
        return;
      }
      const generation = ++receiverGenerationRef.current;
      let createdScanner: QrScanner | null = null;
      setPhase("starting");
      try {
        await stopScanner(true);
        if (!activeRef.current || generation !== receiverGenerationRef.current) {
          if (generation === receiverGenerationRef.current) setPhase("paused");
          return;
        }
        if (!(await QrScanner.hasCamera())) {
          throw new Error("No camera was detected on this computer.");
        }
        if (!activeRef.current || generation !== receiverGenerationRef.current) {
          if (generation === receiverGenerationRef.current) setPhase("paused");
          return;
        }
        const video = videoRef.current;
        const scanOverlay = scanOverlayRef.current;
        if (!video || !scanOverlay) throw new Error("The camera view is not ready.");
        const scanner = new QrScanner(
          video,
          (result) => queueDecodedFrame(result.data, generation),
          {
            preferredCamera: selectedCameraRef.current,
            maxScansPerSecond: 14,
            returnDetailedScanResult: true,
            highlightScanRegion: true,
            overlay: scanOverlay,
            onDecodeError: () => undefined,
          },
        );
        createdScanner = scanner;
        scannerRef.current = scanner;
        await scanner.start();
        const nextCameras = await QrScanner.listCameras(false);
        setCameras(nextCameras);
        if (!activeRef.current || generation !== receiverGenerationRef.current) {
          await stopScannerInstance(scanner, true);
          if (generation === receiverGenerationRef.current) setPhase("paused");
          return;
        }
        scanModeRef.current = mode;
        setScanMode(mode);
        beginMetrics();
        setPhase(mode === "connection-test" ? "testing" : "scanning");
      } catch (caught) {
        try {
          if (createdScanner) {
            await stopScannerInstance(createdScanner, true);
          } else if (generation === receiverGenerationRef.current) {
            await stopScanner(true);
          }
        } catch {
          // The original camera error is more useful than a secondary pause error.
        }
        freezeMetrics();
        if (generation === receiverGenerationRef.current) {
          setPhase(
            connectionRef.current || lastAcceptedAtRef.current !== null
              ? "paused"
              : "idle",
          );
          setError(cameraErrorMessage(caught));
        }
      }
    },
    [
      beginMetrics,
      freezeMetrics,
      queueDecodedFrame,
      stopScanner,
      stopScannerInstance,
    ],
  );

  const startConnectionTest = useCallback(async () => {
    if (!checkpointsLoaded || (savedCheckpoint && !connection)) return;
    receiverGenerationRef.current += 1;
    accumulatorRef.current = createProbeAccumulator();
    ingestQueueRef.current = Promise.resolve();
    completionHandledRef.current = false;
    pendingCheckpointFramesRef.current.clear();
    failedCheckpointFramesRef.current.clear();
    connectionRef.current = null;
    setConnection(null);
    scanModeRef.current = "connection-test";
    setScanMode("connection-test");
    setProgress(EMPTY_PROGRESS);
    resetMetrics();
    await startScanner("connection-test");
  }, [checkpointsLoaded, connection, resetMetrics, savedCheckpoint, startScanner]);

  const pauseScanner = useCallback(
    async (showNotice = true) => {
      const generation = ++receiverGenerationRef.current;
      freezeMetrics();
      try {
        await stopScanner(true);
      } catch (caught) {
        setError(toMessage(caught, "The camera could not be stopped cleanly."));
      }
      if (
        generation !== receiverGenerationRef.current ||
        completionHandledRef.current
      ) {
        return;
      }
      setPhase("paused");
      if (showNotice) {
        setNotice(
          activeCheckpointKey
            ? "Camera paused. Valid frames are held in memory and in the durable checkpoint."
            : "Camera paused. Valid frames are still held in memory.",
        );
      }
    },
    [activeCheckpointKey, freezeMetrics, stopScanner],
  );

  const resetReceiver = useCallback(
    async (confirmDiscard = true) => {
      const checkpointKeyToDelete =
        activeCheckpointKeyRef.current ??
        activeCheckpointKey ??
        savedCheckpoint?.key ??
        pendingProofCheckpointKeyRef.current ??
        null;
      if (
        confirmDiscard &&
        (progress.receivedChunks > 0 || checkpointKeyToDelete) &&
        !window.confirm(
          "Discard received chunks and the durable checkpoint? This cannot be undone.",
        )
      ) {
        return;
      }
      receiverGenerationRef.current += 1;
      // Invalidate any accumulator operation already awaiting SHA-256 before
      // camera/persistence cleanup yields control.
      accumulatorRef.current = createProbeAccumulator();
      ingestQueueRef.current = Promise.resolve();
      completionHandledRef.current = false;
      freezeMetrics();
      try {
        await stopScanner(true);
      } catch {
        // Reset still clears local state even if the camera library reports an error.
      }
      await persistenceQueueRef.current.catch(() => undefined);
      let checkpointCleanupError: string | null = null;
      if (checkpointKeyToDelete) {
        try {
          await deleteResumeCheckpoint(checkpointKeyToDelete);
        } catch (caught) {
          checkpointCleanupError = toMessage(
            caught,
            "The receiver reset, but its durable checkpoint could not be removed.",
          );
        }
      }
      persistenceQueueRef.current = Promise.resolve();
      pendingCheckpointWritesRef.current = 0;
      pendingCheckpointFramesRef.current.clear();
      failedCheckpointFramesRef.current.clear();
      completionHandledRef.current = false;
      connectionRef.current = null;
      setConnection(null);
      scanModeRef.current = "connection-test";
      setScanMode("connection-test");
      setPhase("idle");
      setProgress(EMPTY_PROGRESS);
      setArchive(null);
      setVerification(null);
      setSavedCheckpoint(null);
      activeCheckpointKeyRef.current = null;
      pendingProofCheckpointKeyRef.current = null;
      setActiveCheckpointKey(null);
      setCheckpointStatus("none");
      resetMetrics();
      setError(checkpointCleanupError);
      setNotice(null);
    },
    [
      activeCheckpointKey,
      freezeMetrics,
      progress.receivedChunks,
      resetMetrics,
      savedCheckpoint,
      stopScanner,
    ],
  );

  const discardSavedCheckpoint = useCallback(async () => {
    if (!savedCheckpoint) return;
    if (!window.confirm("Discard this saved transfer checkpoint?")) return;
    try {
      await deleteResumeCheckpoint(savedCheckpoint.key);
      const remaining = await listResumeCheckpoints();
      setSavedCheckpoint(remaining[0] ?? null);
      activeCheckpointKeyRef.current = null;
      setActiveCheckpointKey(null);
      setCheckpointStatus("none");
      setError(null);
    } catch (caught) {
      setError(toMessage(caught, "The saved checkpoint could not be removed."));
    }
  }, [savedCheckpoint]);

  const restoreSavedCheckpoint = useCallback(async () => {
    if (!savedCheckpoint) return;
    receiverGenerationRef.current += 1;
    const generation = receiverGenerationRef.current;
    accumulatorRef.current = createProbeAccumulator();
    ingestQueueRef.current = Promise.resolve();
    completionHandledRef.current = false;
    pendingCheckpointFramesRef.current.clear();
    failedCheckpointFramesRef.current.clear();
    setPhase("restoring");
    setError(null);
    setNotice(null);
    try {
      const verifiedProof =
        await verifyResumeCheckpointProof(savedCheckpoint);
      if (generation !== receiverGenerationRef.current) return;
      const binding: FilesTransferBinding = {
        transferId: verifiedProof.filesBinding.transferId,
        archiveSha256: verifiedProof.filesBinding.archiveSha256.slice(),
        manifestSha256: verifiedProof.filesBinding.manifestSha256.slice(),
        connectionId: verifiedProof.filesBinding.connectionId.slice(),
      };
      const restoredConnection: VerifiedConnection = {
        connectionId: verifiedProof.connectionId.slice(),
        filesBinding: binding,
        receiptCode: verifiedProof.receiptCode,
        probeTransferId: verifiedProof.probeTransferId,
        probeArchiveBytes: verifiedProof.archiveBytes.slice(),
        restored: true,
      };
      const storedFrames = await loadResumeFrames(savedCheckpoint.key);
      if (generation !== receiverGenerationRef.current) return;
      const parsedFrames = storedFrames.map((stored) => {
        const parsed = parseEncodedFrame(stored.encoded);
        const expectedPosition =
          parsed.type === FrameType.Manifest ? -1 : parsed.chunkIndex;
        if (stored.position !== expectedPosition) {
          throw new Error("A saved frame index does not match its protected header.");
        }
        if (parsed.transferId !== savedCheckpoint.transferId) {
          throw new Error("A saved frame belongs to a different transfer ID.");
        }
        return { stored, parsed };
      });
      const manifestRecord = parsedFrames.find(
        ({ parsed }) => parsed.type === FrameType.Manifest,
      );
      const manifest = manifestRecord?.parsed.manifest;
      if (storedFrames.length > 0) {
        if (!manifest) throw new Error("The saved transfer manifest is missing.");
        if (
          manifest.purpose !== TransferPurpose.Files ||
          bytesToHex(manifest.connectionId) !==
            bytesToHex(binding.connectionId) ||
          bytesToHex(manifest.archiveSha256) !==
            bytesToHex(binding.archiveSha256) ||
          (savedCheckpoint.expectedArchiveBytes !== undefined &&
            manifest.archiveLength !== savedCheckpoint.expectedArchiveBytes) ||
          (savedCheckpoint.rootName !== undefined &&
            manifest.rootName !== savedCheckpoint.rootName)
        ) {
          throw new Error(
            "The saved Files manifest does not exactly match its re-verified dummy proof.",
          );
        }
      }
      const accumulator = createFilesAccumulator(binding);
      let latest: AccumulatorResult | undefined;
      for (const { stored } of parsedFrames) {
        latest = await accumulator.ingest(stored.encoded);
        if (!latest.accepted || latest.status === "verification-failed") {
          throw new Error(latest.error ?? "A saved frame failed replay validation.");
        }
      }
      if (generation !== receiverGenerationRef.current) return;
      let restoredArchive: ReceivedArchive | null = null;
      if (latest?.status === "complete") {
        if (!latest.archiveBytes || !latest.rootName) {
          throw new Error("The completed checkpoint did not yield its archive.");
        }
        restoredArchive = {
          bytes: latest.archiveBytes,
          entries: extractArchive(latest.archiveBytes),
          rootName: latest.rootName,
        };
      }
      if (generation !== receiverGenerationRef.current) return;
      accumulatorRef.current = accumulator;
      connectionRef.current = restoredConnection;
      setConnection(restoredConnection);
      scanModeRef.current = "files";
      setScanMode("files");
      completionHandledRef.current = restoredArchive !== null;
      setActiveCheckpointKey(savedCheckpoint.key);
      activeCheckpointKeyRef.current = savedCheckpoint.key;
      setCheckpointStatus("saved");
      resetMetrics();
      lastReceivedBytesRef.current = latest?.receivedBytes ?? 0;
      setArchive(restoredArchive);
      setVerification(null);
      if (restoredArchive) {
        updateProgress(latest!);
        setPhase("archive-ready");
        setNotice("Complete checkpoint restored and SHA-256 verified again.");
      } else if (!latest) {
        setProgress(EMPTY_PROGRESS);
        setPhase("test-verified");
        setNotice(
          "Verified dummy proof restored and checked again. The receipt and exact Files binding are ready without any saved file frames.",
        );
      } else {
        updateProgress(latest);
        setPhase("paused");
        setNotice(
          `Restored ${latest.receivedChunks.toLocaleString()} integrity-checked chunks. Resume the camera with the same sender stream.`,
        );
      }
    } catch (caught) {
      setPhase("idle");
      setCheckpointStatus("error");
      setError(
        `${toMessage(caught, "The checkpoint failed dummy-proof and protected-frame replay validation.")} The saved checkpoint was retained unchanged; retry it or discard it explicitly before starting another connection.`,
      );
    }
  }, [resetMetrics, savedCheckpoint, updateProgress]);

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
          "Destination verification failed. At least one path or SHA-256 differs; success has not been reported.",
        );
        setPhase("archive-ready");
        return;
      }
      await persistenceQueueRef.current.catch(() => undefined);
      if (activeCheckpointKey) {
        try {
          await deleteResumeCheckpoint(activeCheckpointKey);
        } catch (caught) {
          setCheckpointStatus("error");
          setNotice(
            toMessage(
              caught,
              "Destination verification passed, but the durable incoming checkpoint could not be removed.",
            ),
          );
          setPhase("verified");
          return;
        }
      }
      setSavedCheckpoint(null);
      activeCheckpointKeyRef.current = null;
      setActiveCheckpointKey(null);
      setCheckpointStatus("none");
      setPhase("verified");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setPhase("archive-ready");
        return;
      }
      setError(
        toMessage(
          caught,
          "The destination could not be written and verified. For an interrupted write, choose the matching destination and checkpoint; otherwise choose another empty destination parent.",
        ),
      );
      setPhase("archive-ready");
    }
  }, [activeCheckpointKey, archive]);

  const downloadVerifiedZip = useCallback(() => {
    if (!archive) return;
    try {
      downloadArchive(archive.bytes, `${safeDownloadName(archive.rootName)}.zip`);
      setNotice(
        "The ZIP hash is verified. Manual extraction cannot be independently re-read by this browser; the resume checkpoint is retained.",
      );
    } catch (caught) {
      setError(toMessage(caught, "The verified ZIP could not be downloaded."));
    }
  }, [archive]);

  useEffect(() => {
    if (!supportsDurableResume()) return;
    let cancelled = false;
    void listResumeCheckpoints()
      .then((checkpoints) => {
        if (!cancelled && checkpoints[0]) setSavedCheckpoint(checkpoints[0]);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(toMessage(caught, "Saved transfer checkpoints could not be read."));
        }
      })
      .finally(() => {
        if (!cancelled) setCheckpointsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!active && (phase === "starting" || phase === "testing" || phase === "scanning")) {
      void pauseScanner(false);
    }
  }, [active, pauseScanner, phase]);

  useEffect(() => {
    const scanning = phase === "testing" || phase === "scanning";
    if (!scanning) return;
    const timer = window.setInterval(() => setMetricsNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(
    () => () => {
      receiverGenerationRef.current += 1;
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (scanner) void scanner.pause(true).finally(() => scanner.destroy());
    },
    [],
  );

  const scanning = phase === "testing" || phase === "scanning";
  const directWriteEntryLimitExceeded =
    (archive?.entries.length ?? 0) > MAX_DIRECT_WRITE_ENTRIES;
  const directWriteSupported =
    typeof window.showDirectoryPicker === "function" &&
    !directWriteEntryLimitExceeded;
  const elapsedSeconds =
    (activeElapsedMsRef.current +
      (activeSegmentStartedRef.current === null
        ? 0
        : metricsNow - activeSegmentStartedRef.current)) /
    1000;
  const recentSamples = rateSamplesRef.current.filter(
    (sample) => metricsNow - sample.at <= RATE_WINDOW_MS,
  );
  const signalStale =
    progress.receivedBytes > 0 &&
    lastAcceptedAtRef.current !== null &&
    metricsNow - lastAcceptedAtRef.current > STALE_AFTER_MS;
  const stallReference =
    lastAcceptedAtRef.current ?? activeSegmentStartedRef.current;
  const stalled =
    scanning &&
    stallReference !== null &&
    metricsNow - stallReference > STALLED_AFTER_MS;
  const rateSpanSeconds = recentSamples.length
    ? Math.max(1, (metricsNow - recentSamples[0].at) / 1000)
    : 0;
  const throughput = !signalStale && rateSpanSeconds
    ? recentSamples.reduce((sum, sample) => sum + sample.bytes, 0) /
      rateSpanSeconds
    : 0;
  const remainingBytes = Math.max(
    0,
    (progress.expectedArchiveBytes ?? progress.receivedBytes) -
      progress.receivedBytes,
  );
  const etaSeconds = throughput > 0
    ? remainingBytes / throughput
    : Number.POSITIVE_INFINITY;
  const speedText =
    phase === "paused"
      ? "Paused"
      : signalStale
        ? "Signal lost"
        : throughput > 0
          ? formatRate(throughput)
          : progress.receivedBytes > 0
            ? "Waiting for new chunks"
            : "Calculating…";
  const etaText =
    phase === "paused"
      ? "Paused"
      : signalStale
        ? "Signal lost"
        : remainingBytes === 0 && progress.expectedArchiveBytes
          ? "Verifying…"
          : formatEta(etaSeconds);
  const connectionHex = connection ? bytesToHex(connection.connectionId) : "";

  const startButton = (() => {
    if (connection) {
      return {
        label: progress.receivedChunks > 0 ? "Resume verified transfer" : "Receive verified files",
        action: () => void startScanner("files"),
      };
    }
    if (phase === "paused" && lastAcceptedAtRef.current !== null) {
      return {
        label: "Resume same connection test",
        action: () => void startScanner("connection-test"),
      };
    }
    return {
      label: "Start connection test",
      action: () => void startConnectionTest(),
    };
  })();

  return (
    <section className="workspace" aria-labelledby="receiver-title">
      <div className="page-heading">
        <span className="eyebrow">Optical receiver</span>
        <h1 id="receiver-title">Prove the dummy transfer before accepting files.</h1>
        <p>The camera first accepts only a ConnectionTest stream. Files remain blocked until the complete dummy and its embedded binding pass verification.</p>
      </div>

      <div className="connection-banner" role="status" aria-live="polite">
        <span className={`connection-indicator ${connection ? "verified" : scanning ? "testing" : "disconnected"}`} />
        <div>
          <strong>{connection ? "Connection verified" : scanning ? "Testing connection" : "Not connected"}</strong>
          <span>{connection ? `Session ${shortConnectionId(connectionHex)} · exact file transfer bound` : scanMode === "connection-test" ? "Files are rejected until the dummy test completes" : "Waiting for a verified session"}</span>
        </div>
      </div>

      {savedCheckpoint && !connection && phase === "idle" && (
        <div className="checkpoint-card" role="status">
          <Database size={22} />
          <div>
            <strong>Saved transfer available</strong>
            <span>{savedCheckpoint.rootName ?? "Verified session"} · {savedCheckpoint.receivedChunks.toLocaleString()} / {savedCheckpoint.totalChunks.toLocaleString()} chunks · saved {new Date(savedCheckpoint.updatedAt).toLocaleString()}</span>
          </div>
          <div className="checkpoint-actions">
            <button type="button" className="button button-primary" onClick={() => void restoreSavedCheckpoint()}>Resume saved transfer</button>
            <button type="button" className="button button-danger" onClick={() => void discardSavedCheckpoint()}><Trash2 size={15} />Discard</button>
          </div>
        </div>
      )}

      <div className="transfer-card receiver-layout">
        <div className="panel">
          <div className="panel-kicker"><ScanLine size={14} />Camera channel</div>
          <h2>Align the QR inside the guide</h2>
          <p className="panel-description">Scanning means the camera is on; the connection is verified only after the dummy receipt appears.</p>

          <div className="camera-shell">
            <video ref={videoRef} muted playsInline aria-label="Live camera view" />
            {!scanning && phase !== "starting" && (
              <div className="camera-empty"><span className="camera-empty-icon"><Camera size={27} /></span><strong>Camera is off</strong><span>Validated chunks remain in memory{activeCheckpointKey ? " and durable storage" : ""}.</span></div>
            )}
            {phase === "starting" && (
              <div className="camera-empty"><span className="camera-empty-icon"><span className="spinner" /></span><strong>Starting camera…</strong><span>Approve the browser permission prompt if it appears.</span></div>
            )}
            {scanning && <div className="camera-badge">{phase === "testing" ? "Dummy test only" : "Files scanning"}</div>}
            <div ref={scanOverlayRef} className={`scan-overlay ${scanning ? "visible" : ""}`} aria-hidden="true"><div className="scan-line" /></div>
          </div>

          <div className="field camera-picker">
            <label htmlFor="receiver-camera">Camera</label>
            <select
              id="receiver-camera"
              value={selectedCamera}
              disabled={phase === "starting" || phase === "finalizing"}
              onChange={(event) => {
                const camera = event.target.value;
                setSelectedCamera(camera);
                selectedCameraRef.current = camera;
                if (scannerRef.current) {
                  void scannerRef.current.setCamera(camera).catch((caught) =>
                    setError(cameraErrorMessage(caught)),
                  );
                }
              }}
            >
              <option value="environment">Rear / environment camera</option>
              <option value="user">Front / user camera</option>
              {cameras.map((camera) => (
                <option key={camera.id} value={camera.id}>
                  {camera.label}
                </option>
              ))}
            </select>
          </div>

          <div className="playback-controls">
            <button type="button" className="button button-primary" disabled={!checkpointsLoaded || phase === "starting" || phase === "restoring" || phase === "finalizing" || scanning || phase === "saving" || phase === "archive-ready" || phase === "archive-error" || phase === "verified" || (!!savedCheckpoint && !connection)} onClick={startButton.action}>
              <Camera size={16} />{startButton.label}
            </button>
            <button type="button" className="button button-secondary" disabled={!scanning} onClick={() => void pauseScanner()}><CameraOff size={16} />Pause camera</button>
          </div>
          {!!savedCheckpoint && !connection && phase === "idle" && <p className="microcopy">Resume or discard the saved checkpoint before starting a new connection.</p>}
        </div>

        <div className="panel">
          <div className="receiver-status">
            <div className="panel-kicker"><ShieldCheck size={14} />Integrity gate</div>

            {phase === "verified" && verification ? (
              <VerifiedSummary report={verification} elapsedSeconds={elapsedSeconds} checkpointRemoved={!activeCheckpointKey} onReset={() => void resetReceiver(false)} />
            ) : phase === "archive-ready" || phase === "saving" ? (
              <ArchiveReady archive={archive!} fileCount={fileEntries.length} totalBytes={uncompressedBytes} directWriteSupported={directWriteSupported} directWriteUnavailableReason={directWriteEntryLimitExceeded ? `Direct reconstruction is limited to ${MAX_DIRECT_WRITE_ENTRIES.toLocaleString()} files and folders so crash-safe journaling stays bounded.` : undefined} saving={phase === "saving"} checkpointRetained={!!activeCheckpointKey} onSave={() => void saveAndVerify()} onDownload={downloadVerifiedZip} onReset={() => void resetReceiver()} />
            ) : phase === "test-verified" && connection?.receiptCode ? (
              <div className="receipt-success" role="status" aria-live="polite">
                <span className="completion-icon"><KeyRound size={34} /></span>
                <h3>Dummy transfer verified</h3>
                <p>Enter this receipt on the sender. It proves the complete randomized dummy arrived and binds the exact prepared file archive.</p>
                <output className="receipt-code" aria-label={`Connection receipt ${connection.receiptCode}`}>{connection.receiptCode}</output>
                <div className="verification-list">
                  <div className="verification-item"><Check size={14} />ConnectionTest purpose verified</div>
                  <div className="verification-item"><Check size={14} />Dummy ZIP and embedded SHA-256 verified</div>
                  <div className="verification-item"><Check size={14} />Files transfer ID and archive hash bound</div>
                </div>
                <p className="microcopy">After the sender accepts the receipt, choose “Receive verified files.”</p>
              </div>
            ) : (
              <>
                <h2>{scanMode === "connection-test" ? "Receiving dummy test" : "Receiving verified files"}</h2>
                <p className="panel-description">Progress counts unique, complete-frame-CRC-valid chunks only.</p>
                <div className="progress-ring-wrap">
                  <div className="progress-ring" style={{ "--progress": `${Math.min(100, progress.percent)}%` } as CSSProperties} role="progressbar" aria-label={scanMode === "connection-test" ? "Dummy connection test progress" : "File transfer progress"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(progress.percent)} />
                  <div className="progress-ring-content" aria-hidden="true"><strong>{Math.floor(progress.percent)}%</strong><span>captured</span></div>
                </div>
                <dl className="stat-list">
                  <div className="stat-row"><dt>Unique chunks</dt><dd>{progress.receivedChunks.toLocaleString()} / {progress.totalChunks ? progress.totalChunks.toLocaleString() : "—"}</dd></div>
                  <div className="stat-row"><dt>Valid payload</dt><dd>{formatBytes(progress.receivedBytes)} / {progress.expectedArchiveBytes ? formatBytes(progress.expectedArchiveBytes) : "—"}</dd></div>
                  <div className="stat-row"><dt>Live capture speed</dt><dd>{speedText}</dd></div>
                  <div className="stat-row"><dt>Remaining</dt><dd>{progress.expectedArchiveBytes ? formatBytes(remainingBytes) : "—"}</dd></div>
                  <div className="stat-row"><dt>Capture ETA</dt><dd>{etaText}</dd></div>
                  <div className="stat-row"><dt>Active camera time</dt><dd>{formatClock(elapsedSeconds)}</dd></div>
                  <div className="stat-row"><dt>Checkpoint</dt><dd>{checkpointStatus === "saving" ? "Saving…" : checkpointStatus === "saved" ? "Saved" : checkpointStatus === "error" ? "Memory only" : supportsDurableResume() ? "Waiting" : "Unavailable"}</dd></div>
                  <div className="stat-row"><dt>Folder</dt><dd title={progress.rootName}>{progress.rootName ?? "Waiting…"}</dd></div>
                </dl>

                {stalled && <div className="status-box" role="status"><AlertTriangle size={16} /><span>No valid frame for 30 seconds. Move closer, raise screen brightness, reduce sender FPS, and confirm the sender resumed the same transfer.</span></div>}
                {phase === "archive-error" && <div className="status-box error" role="alert"><AlertTriangle size={16} /><span>The verified ZIP could not be unpacked. Resume cannot repair a valid but unsupported archive; discard the checkpoint to start again.</span></div>}
                <button type="button" className="button button-secondary button-wide" onClick={() => void resetReceiver()} disabled={phase === "starting" || phase === "restoring"}><RefreshCw size={15} />Discard and reset receiver</button>
              </>
            )}

            {error && <div className="status-box error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
            {notice && <div className="status-box" role="status"><AlertTriangle size={16} /><span>{notice}</span></div>}
          </div>
        </div>
      </div>

      <div className="notice-strip"><ShieldCheck size={16} /><span>A durable checkpoint is restored only by reparsing every protected frame through a fresh, session-bound accumulator. The file is offered only after the final archive SHA-256 passes again.</span></div>
    </section>
  );
}

function ArchiveReady({
  archive,
  fileCount,
  totalBytes,
  directWriteSupported,
  directWriteUnavailableReason,
  saving,
  checkpointRetained,
  onSave,
  onDownload,
  onReset,
}: {
  archive: ReceivedArchive;
  fileCount: number;
  totalBytes: number;
  directWriteSupported: boolean;
  directWriteUnavailableReason?: string;
  saving: boolean;
  checkpointRetained: boolean;
  onSave: () => void;
  onDownload: () => void;
  onReset: () => void;
}) {
  return (
    <div className="completion">
      <span className="completion-icon"><CheckCircle2 size={35} /></span>
      <h3>Archive hash verified</h3>
      <p>All {formatBytes(archive.bytes.length)} arrived intact. Choose where to reconstruct <strong>{archive.rootName}</strong>.</p>
      <div className="verification-list">
        <div className="verification-item"><Check size={14} />Complete ZIP SHA-256 matches</div>
        <div className="verification-item"><Check size={14} />{fileCount.toLocaleString()} files · {formatBytes(totalBytes)} unpacked</div>
        <div className="verification-item"><Check size={14} />{checkpointRetained ? "Durable checkpoint retained until destination verification" : "Archive paths passed safety validation"}</div>
      </div>
      {directWriteSupported ? (
        <button type="button" className="button button-primary button-wide" disabled={saving} onClick={onSave}>{saving ? <><span className="spinner" />Writing and verifying every file…</> : <><Save size={16} />Choose destination and verify</>}</button>
      ) : (
        <>
          {directWriteUnavailableReason && <p className="microcopy">{directWriteUnavailableReason}</p>}
          <button type="button" className="button button-primary button-wide" onClick={onDownload}><Download size={16} />Download verified ZIP</button>
        </>
      )}
      <div className="playback-controls">
        {directWriteSupported && <button type="button" className="button button-secondary" disabled={saving} onClick={onDownload}><Download size={15} />ZIP fallback</button>}
        <button type="button" className="button button-secondary" disabled={saving} onClick={onReset}><RefreshCw size={15} />New transfer</button>
      </div>
    </div>
  );
}

function VerifiedSummary({ report, elapsedSeconds, checkpointRemoved, onReset }: { report: VerificationReport; elapsedSeconds: number; checkpointRemoved: boolean; onReset: () => void }) {
  return (
    <div className="completion">
      <span className="completion-icon"><FolderCheck size={35} /></span>
      <h3>Transfer complete</h3>
      <p><strong>{report.rootName}</strong> was written and independently re-read from the destination.</p>
      <div className="verification-list">
        <div className="verification-item"><Check size={14} />Exact path set: {report.filesWritten.toLocaleString()} / {report.expectedPaths.length.toLocaleString()}</div>
        <div className="verification-item"><Check size={14} />SHA-256: every destination file matches</div>
        <div className="verification-item"><Check size={14} />{formatBytes(report.totalBytes)} verified in {formatClock(elapsedSeconds)}</div>
      </div>
      <div className="status-box success"><ShieldCheck size={16} /><span>{checkpointRemoved ? "Destination verification passed. The durable checkpoint was removed." : "Destination verification passed. Checkpoint cleanup needs another attempt."}</span></div>
      <button type="button" className="button button-secondary button-wide" onClick={onReset}><RefreshCw size={15} />Receive another folder</button>
    </div>
  );
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Camera permission was denied. Allow camera access, then try again.";
    if (error.name === "NotFoundError") return "No camera was detected. Connect a camera and try again.";
    if (error.name === "NotReadableError") return "The camera is already in use by another application.";
  }
  return toMessage(error, "The camera could not be started.");
}

function safeDownloadName(rootName: string): string {
  const safe = rootName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return safe || "qr-air-gap-transfer";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function shortConnectionId(value: string): string {
  return value ? `${value.slice(0, 6)}…${value.slice(-6)}` : "—";
}

function decrementPendingCheckpointFrame(
  pending: Map<string, number>,
  frameId: string,
): void {
  const next = (pending.get(frameId) ?? 1) - 1;
  if (next <= 0) pending.delete(frameId);
  else pending.set(frameId, next);
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
