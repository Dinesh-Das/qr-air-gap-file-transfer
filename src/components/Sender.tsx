import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import QRCode from "qrcode";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  FileArchive,
  Folder,
  FolderOpen,
  KeyRound,
  Link2,
  Pause,
  Play,
  QrCode as QrCodeIcon,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react";
import {
  collectDirectoryHandle,
  collectInputFiles,
  createArchive,
  extractArchive,
  validatePortableRootName,
  verifyEntryCollections,
  type SelectedEntry,
} from "../lib/archive";
import {
  CONNECTION_TEST_ROOT_NAME,
  createFilesTransferBinding,
  prepareConnectionTest,
  validateConnectionReceiptCode,
  verifyConnectionTest,
} from "../lib/connection";
import {
  createConnectionId,
  sha256,
  TransferPurpose,
} from "../lib/protocol";
import {
  decoratePreparedTransfer,
  prepareTransfer,
  type PreparedLoopFrame,
  type PreparedTransfer,
} from "../lib/transfer";
import {
  deleteSenderSession,
  loadSenderSession,
  saveSenderSession,
  supportsSenderResume,
  type StoredSenderSession,
} from "../lib/sender-resume";
import {
  estimateTransferSeconds,
  formatBytes,
  formatClock,
  formatDuration,
  formatEta,
  formatRate,
} from "../lib/format";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const METRIC_WINDOW_MS = 6_000;
const TAB_SESSION_KEY = "qr-air-gap-sender-session-key";

type ErrorCorrectionLevel = "L" | "M" | "Q";
type ConnectionPhase =
  | "disconnected"
  | "preparing"
  | "testing"
  | "verified";

interface FolderSelection {
  rootName: string;
  entries: SelectedEntry[];
  capturesEmptyDirectories: boolean;
}

interface SenderSettings {
  chunkSize: number;
  framesPerSecond: number;
  errorCorrectionLevel: ErrorCorrectionLevel;
}

interface RenderSample {
  at: number;
  payloadBytes: number;
}

export function Sender({ active = true }: { active?: boolean }) {
  const [selection, setSelection] = useState<FolderSelection | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [settings, setSettings] = useState<SenderSettings>({
    chunkSize: 700,
    framesPerSecond: 6,
    errorCorrectionLevel: "M",
  });
  const [prepared, setPrepared] = useState<PreparedTransfer | null>(null);
  const [filesPrepared, setFilesPrepared] = useState<PreparedTransfer | null>(
    null,
  );
  const [probeArchiveBytes, setProbeArchiveBytes] = useState<Uint8Array | null>(
    null,
  );
  const [connectionPhase, setConnectionPhase] =
    useState<ConnectionPhase>("disconnected");
  const [connectionId, setConnectionId] = useState<Uint8Array | null>(null);
  const [receiptInput, setReceiptInput] = useState("");
  const [validatingReceipt, setValidatingReceipt] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [restoringSession, setRestoringSession] = useState(
    supportsSenderResume(),
  );
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [hasRenderedFrame, setHasRenderedFrame] = useState(false);
  const [framePosition, setFramePosition] = useState(0);
  const [loopCount, setLoopCount] = useState(0);
  const [metricsNow, setMetricsNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderGenerationRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const buildGenerationRef = useRef(0);
  const activeElapsedMsRef = useRef(0);
  const activeSegmentStartedRef = useRef<number | null>(null);
  const renderSamplesRef = useRef<RenderSample[]>([]);
  const senderSessionRef = useRef<StoredSenderSession | null>(null);

  const fileEntries = useMemo(
    () => selection?.entries.filter((entry) => !entry.directory) ?? [],
    [selection],
  );
  const directoryCount = useMemo(
    () => selection?.entries.filter((entry) => entry.directory).length ?? 0,
    [selection],
  );
  const totalBytes = useMemo(
    () => fileEntries.reduce((sum, entry) => sum + entry.bytes.length, 0),
    [fileEntries],
  );
  const estimatedSeconds = estimateTransferSeconds(
    filesPrepared?.archiveBytes.length ?? totalBytes,
    settings.chunkSize,
    settings.framesPerSecond,
  );
  const activeFrame = prepared?.loopFrames[framePosition];
  const streamIsFiles = prepared?.purpose === TransferPurpose.Files;
  const connectionHex = connectionId ? bytesToHex(connectionId) : "";

  const resetMetrics = useCallback(() => {
    activeElapsedMsRef.current = 0;
    activeSegmentStartedRef.current = null;
    renderSamplesRef.current = [];
    setMetricsNow(Date.now());
  }, []);

  const beginMetrics = useCallback(() => {
    const now = Date.now();
    activeSegmentStartedRef.current ??= now;
    renderSamplesRef.current = [];
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

  const hideRenderedQr = useCallback(() => {
    setHasRenderedFrame(false);
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const clearConnection = useCallback(() => {
    buildGenerationRef.current += 1;
    renderGenerationRef.current += 1;
    freezeMetrics();
    resetMetrics();
    setPreparing(false);
    setPrepared(null);
    setFilesPrepared(null);
    setProbeArchiveBytes(null);
    setConnectionPhase("disconnected");
    setConnectionId(null);
    setReceiptInput("");
    setValidatingReceipt(false);
    senderSessionRef.current = null;
    setResumeNotice(null);
    setPlaying(false);
    setPaused(false);
    setFramePosition(0);
    setLoopCount(0);
    hideRenderedQr();
  }, [freezeMetrics, hideRenderedQr, resetMetrics]);

  useEffect(() => {
    if (!supportsSenderResume()) {
      setRestoringSession(false);
      return;
    }
    let cancelled = false;
    let loadedSession: StoredSenderSession | null = null;
    const preferredSessionKey = readTabSessionKey();
    void loadSenderSession(preferredSessionKey)
      .then(async (stored) => {
        if (!stored) {
          if (preferredSessionKey) forgetTabSessionKey(preferredSessionKey);
          return;
        }
        loadedSession = stored;
        if (cancelled) return;
        assertStoredSenderSession(stored);
        validatePortableRootName(stored.rootName);
        if (stored.archiveBytes.length > MAX_ARCHIVE_BYTES) {
          throw new Error("The saved sender archive exceeds the current safety limit.");
        }

        const entries = extractArchive(stored.archiveBytes);
        const restoredSourceBytes = entries.reduce(
          (total, entry) => total + (entry.directory ? 0 : entry.bytes.length),
          0,
        );
        if (restoredSourceBytes > MAX_SOURCE_BYTES) {
          throw new Error(
            "The saved sender source exceeds the current in-memory safety limit.",
          );
        }
        const files = await prepareTransfer(stored.archiveBytes, {
          rootName: stored.rootName,
          chunkSize: stored.chunkSize,
          purpose: TransferPurpose.Files,
          connectionId: stored.connectionId,
          transferId: stored.filesTransferId,
          createdAtMs: stored.filesCreatedAtMs,
        });
        const filesBinding = await createFilesTransferBinding(files);
        const verifiedProbe = await verifyConnectionTest(
          stored.probeArchiveBytes,
          stored.connectionId,
          stored.probeTransferId,
        );
        if (!sameFilesBinding(filesBinding, verifiedProbe.filesBinding)) {
          throw new Error(
            "The saved connection test does not bind the saved Files stream.",
          );
        }
        const probe = await prepareTransfer(stored.probeArchiveBytes, {
          rootName: CONNECTION_TEST_ROOT_NAME,
          chunkSize: stored.chunkSize,
          purpose: TransferPurpose.ConnectionTest,
          connectionId: stored.connectionId,
          transferId: stored.probeTransferId,
          createdAtMs: stored.probeCreatedAtMs,
        });
        const restoredProbeManifestSha256 = await sha256(
          new TextEncoder().encode(probe.manifestFrame),
        );
        if (
          bytesToHex(restoredProbeManifestSha256) !==
          bytesToHex(stored.probeManifestSha256)
        ) {
          throw new Error(
            "The saved connection-test manifest does not match the original dummy stream.",
          );
        }
        if (cancelled) return;

        senderSessionRef.current = stored;
        rememberTabSessionKey(stored.key);
        setSelection({
          rootName: stored.rootName,
          entries,
          capturesEmptyDirectories: stored.capturesEmptyDirectories,
        });
        setSettings({
          chunkSize: stored.chunkSize,
          framesPerSecond: stored.framesPerSecond,
          errorCorrectionLevel: stored.errorCorrectionLevel,
        });
        setFilesPrepared(files);
        setProbeArchiveBytes(stored.probeArchiveBytes.slice());
        setPrepared(stored.phase === "verified" ? files : probe);
        setConnectionId(stored.connectionId.slice());
        setConnectionPhase(stored.phase);
        setPlaying(false);
        setPaused(false);
        setFramePosition(0);
        setLoopCount(0);
        resetMetrics();
        setResumeNotice(
          stored.phase === "verified"
            ? "Restored the exact verified Files stream. Start it when the receiver is ready."
            : "Restored the exact dummy test. Resume it to obtain the receiver receipt.",
        );
      })
      .catch(async (caught) => {
        if (cancelled) return;
        senderSessionRef.current = null;
        let cleanupWarning = "";
        if (loadedSession) {
          try {
            const removed = await deleteSenderSession(loadedSession);
            if (removed) {
              forgetTabSessionKey(loadedSession.key);
            } else {
              cleanupWarning =
                " The record changed in another tab, so this stale tab did not remove it.";
            }
          } catch {
            cleanupWarning =
              " The invalid source archive also could not be removed from durable storage; clear this site's data if retrying still fails.";
          }
        }
        if (!cancelled) {
          setError(
            `${toMessage(caught, "The saved sender session could not be restored.")}${cleanupWarning}`,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setRestoringSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resetMetrics]);

  const useSelection = useCallback(
    (next: FolderSelection) => {
      const priorSession = senderSessionRef.current;
      clearConnection();
      setError(null);
      if (priorSession) {
        void deleteSenderSession(priorSession)
          .then((removed) => {
            if (removed) {
              forgetTabSessionKey(priorSession.key);
              return;
            }
            setError((current) => current ??
              "The prior sender session changed in another tab, so this tab did not remove its durable archive.");
          })
          .catch((caught) => {
            setError((current) => current ?? toMessage(
              caught,
              "The prior sender archive could not be removed from durable storage.",
            ));
          });
      }
      const selectedBytes = next.entries.reduce(
        (sum, entry) => sum + (entry.directory ? 0 : entry.bytes.length),
        0,
      );
      if (selectedBytes > MAX_SOURCE_BYTES) {
        setSelection(null);
        setError(
          `This folder is ${formatBytes(selectedBytes)}. The in-memory safety limit is ${formatBytes(MAX_SOURCE_BYTES)}.`,
        );
        return;
      }
      setSelection(next);
    },
    [clearConnection],
  );

  const pickFolder = useCallback(async () => {
    const generation = ++selectionGenerationRef.current;
    setCollecting(true);
    setError(null);
    try {
      if (window.showDirectoryPicker) {
        const handle = await window.showDirectoryPicker({
          id: "qr-air-gap-sender",
          mode: "read",
        });
        const entries = await collectDirectoryHandle(handle, MAX_SOURCE_BYTES);
        if (generation !== selectionGenerationRef.current) return;
        useSelection({
          rootName: handle.name,
          entries,
          capturesEmptyDirectories: true,
        });
        return;
      }
      inputRef.current?.click();
    } catch (caught) {
      if (generation !== selectionGenerationRef.current) return;
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(toMessage(caught, "The folder could not be read."));
    } finally {
      if (generation === selectionGenerationRef.current) setCollecting(false);
    }
  }, [useSelection]);

  const onInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      const generation = ++selectionGenerationRef.current;
      setCollecting(true);
      setError(null);
      try {
        const pickerPath = files[0].webkitRelativePath;
        const rootName = pickerPath
          ? pickerPath.split("/")[0]
          : "Transferred folder";
        const entries = await collectInputFiles(files, MAX_SOURCE_BYTES);
        if (generation !== selectionGenerationRef.current) return;
        useSelection({ rootName, entries, capturesEmptyDirectories: false });
      } catch (caught) {
        if (generation !== selectionGenerationRef.current) return;
        setError(toMessage(caught, "The selected folder could not be read."));
      } finally {
        event.target.value = "";
        if (generation === selectionGenerationRef.current) setCollecting(false);
      }
    },
    [useSelection],
  );

  const prepareConnection = useCallback(async () => {
    if (!selection || connectionPhase !== "disconnected") return;
    clearConnection();
    const generation = buildGenerationRef.current;
    setPreparing(true);
    setConnectionPhase("preparing");
    setError(null);
    try {
      await nextPaint();
      if (generation !== buildGenerationRef.current) return;
      validatePortableRootName(selection.rootName);
      const archiveBytes = createArchive(selection.entries);
      if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
        throw new Error(
          `The ZIP is ${formatBytes(archiveBytes.length)}, above the receiver’s ${formatBytes(MAX_ARCHIVE_BYTES)} safety limit.`,
        );
      }
      const sourceRoundTrip = await verifyEntryCollections(
        selection.entries,
        extractArchive(archiveBytes),
        selection.rootName,
      );
      if (!sourceRoundTrip.ok) {
        throw new Error(
          "ZIP round-trip verification failed; the connection test was not started.",
        );
      }
      if (generation !== buildGenerationRef.current) return;

      const nextConnectionId = createConnectionId();
      const nextFiles = await prepareTransfer(archiveBytes, {
        rootName: selection.rootName,
        chunkSize: settings.chunkSize,
        purpose: TransferPurpose.Files,
        connectionId: nextConnectionId,
      });
      const filesBinding = await createFilesTransferBinding(nextFiles);
      const probe = await prepareConnectionTest(filesBinding, {
        chunkSize: settings.chunkSize,
      });
      if (generation !== buildGenerationRef.current) return;

      let storedSession: StoredSenderSession | null = null;
      let persistenceWarning: string | null = null;
      if (supportsSenderResume()) {
        try {
          storedSession = await saveSenderSession({
            phase: "testing",
            rootName: selection.rootName,
            capturesEmptyDirectories: selection.capturesEmptyDirectories,
            archiveBytes,
            probeArchiveBytes: probe.archiveBytes,
            probeManifestSha256: await sha256(
              new TextEncoder().encode(probe.transfer.manifestFrame),
            ),
            connectionId: probe.connectionId,
            chunkSize: settings.chunkSize,
            framesPerSecond: settings.framesPerSecond,
            errorCorrectionLevel: settings.errorCorrectionLevel,
            filesTransferId: nextFiles.transferId,
            filesCreatedAtMs: nextFiles.manifest.createdAtMs,
            probeTransferId: probe.transfer.transferId,
            probeCreatedAtMs: probe.transfer.manifest.createdAtMs,
          });
        } catch (caught) {
          persistenceWarning = toMessage(
            caught,
            "This exact sender stream could not be saved for reload recovery.",
          );
        }
      }
      if (generation !== buildGenerationRef.current) {
        if (storedSession) {
          void deleteSenderSession(storedSession).catch(() => undefined);
        }
        return;
      }

      senderSessionRef.current = storedSession;
      if (storedSession) rememberTabSessionKey(storedSession.key);
      setFilesPrepared(nextFiles);
      setProbeArchiveBytes(probe.archiveBytes);
      setPrepared(decoratePreparedTransfer(probe.archiveBytes, probe.transfer));
      setConnectionId(probe.connectionId.slice());
      setConnectionPhase("testing");
      setFramePosition(0);
      setLoopCount(0);
      setPlaying(true);
      setPaused(false);
      resetMetrics();
      beginMetrics();
      setResumeNotice(
        storedSession
          ? "The exact dummy and Files streams are saved locally for reload-safe resume."
          : persistenceWarning ??
              "Resume is available while this sender page remains open.",
      );
    } catch (caught) {
      if (generation !== buildGenerationRef.current) return;
      setConnectionPhase("disconnected");
      setError(toMessage(caught, "The connection test could not be prepared."));
    } finally {
      if (generation === buildGenerationRef.current) setPreparing(false);
    }
  }, [
    beginMetrics,
    clearConnection,
    connectionPhase,
    resetMetrics,
    selection,
    settings,
  ]);

  const validateReceipt = useCallback(async () => {
    if (
      connectionPhase !== "testing" ||
      !connectionId ||
      !probeArchiveBytes ||
      !filesPrepared
    ) {
      return;
    }
    const generation = buildGenerationRef.current;
    setValidatingReceipt(true);
    setError(null);
    try {
      const valid = await validateConnectionReceiptCode(
        receiptInput,
        connectionId,
        probeArchiveBytes,
      );
      if (generation !== buildGenerationRef.current) return;
      if (!valid) {
        setError(
          "That receipt does not match this connection test. Keep the dummy QR running and enter the code shown by the receiver.",
        );
        return;
      }
      let persistenceWarning: string | null = null;
      let updatedStoredSession: StoredSenderSession | null = null;
      const storedSession = senderSessionRef.current;
      if (storedSession) {
        const {
          key: _key,
          version: _version,
          revision: _revision,
          updatedAt: _updatedAt,
          ...session
        } = storedSession;
        try {
          updatedStoredSession = await saveSenderSession({
            ...session,
            phase: "verified",
          }, storedSession);
        } catch (caught) {
          persistenceWarning = toMessage(
            caught,
            "The stream is unlocked, but its verified state could not be saved for reload recovery.",
          );
        }
      }
      if (generation !== buildGenerationRef.current) {
        if (updatedStoredSession) {
          void deleteSenderSession(updatedStoredSession).catch(() => undefined);
        }
        return;
      }
      if (updatedStoredSession) {
        senderSessionRef.current = updatedStoredSession;
        rememberTabSessionKey(updatedStoredSession.key);
      }
      renderGenerationRef.current += 1;
      freezeMetrics();
      resetMetrics();
      hideRenderedQr();
      setPrepared(filesPrepared);
      setFramePosition(0);
      setLoopCount(0);
      setPlaying(false);
      setPaused(false);
      setConnectionPhase("verified");
      setError(null);
      setResumeNotice(
        senderSessionRef.current?.phase === "verified"
          ? "The exact verified Files stream is saved locally for reload-safe resume."
          : persistenceWarning ??
              "Resume is available while this sender page remains open.",
      );
    } catch (caught) {
      if (generation !== buildGenerationRef.current) return;
      setError(toMessage(caught, "The receiver receipt could not be validated."));
    } finally {
      if (generation === buildGenerationRef.current) setValidatingReceipt(false);
    }
  }, [
    connectionId,
    connectionPhase,
    filesPrepared,
    freezeMetrics,
    hideRenderedQr,
    probeArchiveBytes,
    receiptInput,
    resetMetrics,
  ]);

  const startOrResumeStream = useCallback(() => {
    if (
      !prepared ||
      (prepared.purpose === TransferPurpose.Files &&
        connectionPhase !== "verified")
    ) {
      return;
    }
    setPlaying(true);
    setPaused(false);
    beginMetrics();
  }, [beginMetrics, connectionPhase, prepared]);

  const pauseStream = useCallback(() => {
    if (!playing || paused) return;
    renderGenerationRef.current += 1;
    freezeMetrics();
    setPaused(true);
  }, [freezeMetrics, paused, playing]);

  const resumePausedStream = useCallback(() => {
    if (!playing || !paused) return;
    setPaused(false);
    beginMetrics();
  }, [beginMetrics, paused, playing]);

  const stopStream = useCallback(() => {
    renderGenerationRef.current += 1;
    freezeMetrics();
    setPlaying(false);
    setPaused(false);
    hideRenderedQr();
  }, [freezeMetrics, hideRenderedQr]);

  const discardConnection = useCallback(async () => {
    if (
      !window.confirm(
        "Discard this connection and prepared transfer? The receiver checkpoint will no longer match a newly prepared stream.",
      )
    ) {
      return;
    }
    const storedSession = senderSessionRef.current;
    clearConnection();
    if (!storedSession) {
      setError(null);
      return;
    }
    try {
      const removed = await deleteSenderSession(storedSession);
      if (removed) {
        forgetTabSessionKey(storedSession.key);
        setError(null);
      } else {
        setError(
          "The local stream stopped, but this saved session changed in another tab and was retained there.",
        );
      }
    } catch (caught) {
      setError(
        toMessage(
          caught,
          "The stream stopped, but its source archive could not be removed from durable storage.",
        ),
      );
    }
  }, [clearConnection]);

  useEffect(() => {
    if (!active && playing && !paused) pauseStream();
  }, [active, pauseStream, paused, playing]);

  useEffect(() => {
    if (
      !playing ||
      paused ||
      !prepared ||
      prepared.loopFrames.length === 0 ||
      (prepared.purpose === TransferPurpose.Files &&
        connectionPhase !== "verified")
    ) {
      return;
    }
    let cancelled = false;
    const generation = ++renderGenerationRef.current;
    let timeoutId: number | undefined;

    const drawAndSchedule = async () => {
      const frame = prepared.loopFrames[framePosition];
      const canvas = canvasRef.current;
      if (!frame || !canvas || cancelled || generation !== renderGenerationRef.current) {
        return;
      }
      try {
        await QRCode.toCanvas(canvas, frame.encoded, {
          errorCorrectionLevel: settings.errorCorrectionLevel,
          margin: 2,
          width: 720,
          color: { dark: "#132019", light: "#ffffff" },
        });
      } catch (caught) {
        setError(
          toMessage(
            caught,
            "This frame does not fit at the selected chunk size and QR recovery level.",
          ),
        );
        stopStream();
        return;
      }
      if (cancelled || generation !== renderGenerationRef.current) return;
      const now = Date.now();
      const payloadBytes = framePayloadBytes(prepared, frame);
      renderSamplesRef.current.push({ at: now, payloadBytes });
      renderSamplesRef.current = renderSamplesRef.current.filter(
        (sample) => now - sample.at <= METRIC_WINDOW_MS,
      );
      setHasRenderedFrame(true);
      setMetricsNow(now);

      timeoutId = window.setTimeout(() => {
        if (cancelled || generation !== renderGenerationRef.current) return;
        setFramePosition((current) => {
          const next = current + 1;
          if (next >= prepared.loopFrames.length) {
            setLoopCount((count) => count + 1);
            return 0;
          }
          return next;
        });
      }, 1000 / settings.framesPerSecond);
    };

    void drawAndSchedule();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [
    framePosition,
    connectionPhase,
    paused,
    playing,
    prepared,
    settings.errorCorrectionLevel,
    settings.framesPerSecond,
    stopStream,
  ]);

  useEffect(() => {
    if (!playing || paused) return;
    const timer = window.setInterval(() => setMetricsNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [paused, playing]);

  const elapsedSeconds =
    (activeElapsedMsRef.current +
      (activeSegmentStartedRef.current === null
        ? 0
        : metricsNow - activeSegmentStartedRef.current)) /
    1000;
  const recentSamples = renderSamplesRef.current.filter(
    (sample) => metricsNow - sample.at <= METRIC_WINDOW_MS,
  );
  const sampleSpanSeconds = recentSamples.length
    ? Math.max(1, (metricsNow - recentSamples[0].at) / 1000)
    : 0;
  const renderedFps = sampleSpanSeconds
    ? recentSamples.length / sampleSpanSeconds
    : 0;
  const renderedPayloadRate = sampleSpanSeconds
    ? recentSamples.reduce((sum, sample) => sum + sample.payloadBytes, 0) /
      sampleSpanSeconds
    : 0;
  const nominalPayloadRate = prepared
    ? prepared.archiveBytes.length /
      (prepared.loopFrames.length / settings.framesPerSecond)
    : 0;
  const remainingFrames = prepared
    ? Math.max(
        0,
        prepared.loopFrames.length - framePosition - (hasRenderedFrame ? 1 : 0),
      )
    : 0;
  const effectiveRenderedFps =
    recentSamples.length >= 2 ? renderedFps : settings.framesPerSecond;
  const passEtaSeconds = prepared
    ? remainingFrames / Math.max(0.01, effectiveRenderedFps)
    : Number.POSITIVE_INFINITY;

  const updateNumberSetting = (
    key: "chunkSize" | "framesPerSecond",
    value: string,
  ) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const [minimum, maximum] = key === "chunkSize" ? [200, 900] : [1, 12];
    const bounded = Math.min(maximum, Math.max(minimum, Math.round(parsed)));
    setSettings((current) => ({ ...current, [key]: bounded }));
  };

  const connectionStatus =
    restoringSession
      ? "Restoring saved stream"
      : connectionPhase === "verified"
      ? "Connection verified"
      : connectionPhase === "testing"
        ? "Testing connection"
        : connectionPhase === "preparing"
          ? "Preparing test"
          : "Not connected";

  return (
    <section className="workspace" aria-labelledby="sender-title">
      <div className="page-heading">
        <span className="eyebrow">Optical sender</span>
        <h1 id="sender-title">Verify the receiver before sending any files.</h1>
        <p>
          AirGap QR first sends a randomized dummy archive. The real file stream
          stays locked until the receiver returns its cryptographic receipt.
        </p>
      </div>

      <div className="connection-banner" role="status" aria-live="polite">
        <span className={`connection-indicator ${connectionPhase}`} />
        <div>
          <strong>{connectionStatus}</strong>
          <span>
            {connectionPhase === "verified"
              ? `Session ${shortConnectionId(connectionHex)} · files unlocked`
              : connectionPhase === "testing"
                ? "Only dummy connection-test bytes are broadcasting"
                : "The file QR stream cannot start yet"}
          </span>
        </div>
      </div>

      <div className="transfer-card sender-layout">
        <div className="panel">
          <div className="panel-kicker">
            <FolderOpen size={14} />
            Source and connection
          </div>
          <h2>Select a folder</h2>
          <p className="panel-description">
            Files are packaged and hashed locally before the dummy connection
            test begins. Packaging never broadcasts file bytes.
          </p>

          {!selection ? (
            <div className="drop-zone">
              <div className="drop-zone-content">
                <span className="upload-icon"><Upload size={25} /></span>
                <h3>Choose the folder to transfer</h3>
                <p>Recommended: under 10 MB · Hard limit: 25 MB</p>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={collecting || restoringSession}
                  onClick={() => void pickFolder()}
                >
                  {restoringSession ? <><span className="spinner" />Restoring saved stream…</> : collecting ? <><span className="spinner" />Reading folder…</> : <><FolderOpen size={16} />Browse folder</>}
                </button>
              </div>
            </div>
          ) : (
            <div className="selection-card">
              <div className="selection-header">
                <div className="folder-identity">
                  <span className="folder-icon"><Folder size={21} /></span>
                  <span>
                    <strong title={selection.rootName}>{selection.rootName}</strong>
                    <span>{connectionPhase === "verified" ? "Connection verified" : "Ready to package"}</span>
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear selected folder"
                  disabled={connectionPhase !== "disconnected" || preparing || restoringSession}
                  onClick={() => {
                    selectionGenerationRef.current += 1;
                    setSelection(null);
                    clearConnection();
                    setError(null);
                  }}
                ><Trash2 size={16} /></button>
              </div>

              <div className="metric-grid">
                <div className="metric"><span>Files</span><strong>{fileEntries.length.toLocaleString()}</strong></div>
                <div className="metric"><span>Source size</span><strong>{formatBytes(totalBytes)}</strong></div>
                <div className="metric"><span>Est. capture</span><strong>{formatDuration(estimatedSeconds)}</strong></div>
              </div>

              {directoryCount > 0 && (
                <p className="microcopy left-copy">
                  {directoryCount.toLocaleString()} explicit folder{directoryCount === 1 ? "" : "s"} included, including empty folders.
                </p>
              )}
              {!selection.capturesEmptyDirectories && (
                <div className="status-box compact-status">
                  <AlertTriangle size={16} />
                  <span>This browser picker cannot expose empty folders. File paths and bytes remain exact.</span>
                </div>
              )}

              <details className="advanced">
                <summary><ChevronRight size={14} /><Settings2 size={14} />Advanced transfer settings</summary>
                <div className="setting-grid">
                  <div className="field">
                    <label htmlFor="chunk-size">Chunk bytes</label>
                    <input id="chunk-size" type="number" min={200} max={900} step={25} value={settings.chunkSize} disabled={connectionPhase !== "disconnected" || preparing} onChange={(event) => updateNumberSetting("chunkSize", event.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="frame-rate">Frames / sec</label>
                    <input id="frame-rate" type="number" min={1} max={12} step={1} value={settings.framesPerSecond} disabled={connectionPhase !== "disconnected" || preparing} onChange={(event) => updateNumberSetting("framesPerSecond", event.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="error-level">QR recovery</label>
                    <select id="error-level" value={settings.errorCorrectionLevel} disabled={connectionPhase !== "disconnected" || preparing} onChange={(event) => setSettings((current) => ({ ...current, errorCorrectionLevel: event.target.value as ErrorCorrectionLevel }))}>
                      <option value="L">Low</option><option value="M">Medium</option><option value="Q">Quartile</option>
                    </select>
                  </div>
                </div>
              </details>
            </div>
          )}

          {connectionPhase === "testing" && (
            <form className="receipt-panel" onSubmit={(event) => { event.preventDefault(); void validateReceipt(); }}>
              <div className="panel-kicker"><KeyRound size={14} />Receiver receipt</div>
              <label htmlFor="receipt-code">Enter the code shown by the receiver</label>
              <div className="receipt-entry">
                <input id="receipt-code" autoComplete="off" inputMode="text" value={receiptInput} placeholder="XXXXX-XXXXX" onChange={(event) => setReceiptInput(normalizeReceiptInput(event.target.value))} />
                <button type="submit" className="button button-primary" disabled={validatingReceipt || receiptInput.replace("-", "").length !== 10}>
                  {validatingReceipt ? <span className="spinner" /> : <Link2 size={16} />}
                  Verify
                </button>
              </div>
              <p>The receipt is derived from the complete dummy archive; a partial scan cannot produce it.</p>
            </form>
          )}

          {connectionPhase === "verified" && (
            <div className="status-box success" role="status">
              <CheckCircle2 size={17} />
              <span>Dummy transfer verified. The prepared Files transfer is bound to session <strong>{shortConnectionId(connectionHex)}</strong>.</span>
            </div>
          )}

          {error && <div className="status-box error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
          {resumeNotice && <div className="status-box" role="status"><FileArchive size={16} /><span>{resumeNotice}</span></div>}

          <div className="sender-actions">
            {connectionPhase === "disconnected" || connectionPhase === "preparing" ? (
              <button className="button button-primary button-wide" type="button" disabled={!selection || preparing || restoringSession} onClick={() => void prepareConnection()}>
                {preparing ? <><span className="spinner" />Packaging and preparing test…</> : <><Link2 size={17} />Prepare and test connection</>}
              </button>
            ) : !playing ? (
              <button className="button button-primary button-wide" type="button" onClick={startOrResumeStream}>
                <Play size={17} />
                {connectionPhase === "testing"
                  ? "Resume same dummy test"
                  : elapsedSeconds > 0
                    ? "Resume same file transfer"
                    : "Start verified file transfer"}
              </button>
            ) : null}
            {connectionPhase !== "disconnected" && (
              <button className="button button-danger button-wide" type="button" onClick={discardConnection}>
                <Trash2 size={16} />Discard connection and prepared stream
              </button>
            )}
            <p className="microcopy">Do not discard the session while the receiver has a matching checkpoint.</p>
          </div>
        </div>

        <div className="panel">
          <div className="qr-stage">
            {!prepared ? (
              <div className="qr-placeholder" aria-label="QR preview">
                <div className="qr-placeholder-inner"><QrCodeIcon size={57} strokeWidth={1.4} /><strong>No QR stream is active</strong><span>Package the files to start the dummy-only connection test.</span></div>
              </div>
            ) : (
              <div className="qr-live">
                <div className={`qr-canvas-wrap ${hasRenderedFrame ? "" : "qr-hidden"}`}>
                  <canvas ref={canvasRef} role="img" aria-label={streamIsFiles ? "Current verified file transfer QR code" : "Current dummy connection-test QR code"} />
                  {!hasRenderedFrame && <div className="qr-stopped-overlay"><QrCodeIcon size={44} /><strong>{connectionPhase === "verified" ? "Files unlocked" : "Broadcast stopped"}</strong><span>{connectionPhase === "verified" ? "Start when the receiver is ready." : "Resume to continue the same transfer ID."}</span></div>}
                </div>
                <div className="qr-meta">
                  <span role="status" aria-live="polite" className={`live-dot ${paused ? "paused" : playing ? "" : "stopped"}`}>{playing ? (paused ? "Paused" : streamIsFiles ? "Files broadcasting" : "Dummy test only") : "Stopped"}</span>
                  <span aria-hidden="true">{hasRenderedFrame ? describeFrame(activeFrame) : "Ready"}</span>
                </div>
                <div className="progress-track" role="progressbar" aria-label="Current broadcast pass" aria-valuemin={0} aria-valuemax={prepared.loopFrames.length} aria-valuenow={hasRenderedFrame ? framePosition + 1 : 0}>
                  <div className="progress-fill" style={{ width: `${hasRenderedFrame ? ((framePosition + 1) / prepared.loopFrames.length) * 100 : 0}%` }} />
                </div>
                <div className="metric-grid metric-grid-four">
                  <div className="metric"><span>Nominal payload</span><strong>{formatRate(nominalPayloadRate)}</strong></div>
                  <div className="metric"><span>Rendered payload</span><strong>{playing && !paused ? formatRate(renderedPayloadRate) : paused ? "Paused" : "Stopped"}</strong></div>
                  <div className="metric"><span>Pass remaining</span><strong>{playing && !paused ? formatEta(passEtaSeconds) : paused ? "Paused" : "Stopped"}</strong></div>
                  <div className="metric"><span>Active time</span><strong>{formatClock(elapsedSeconds)}</strong></div>
                </div>
                <div className="playback-controls">
                  <button type="button" className="button button-secondary" disabled={!playing} onClick={paused ? resumePausedStream : pauseStream}>
                    {paused ? <Play size={16} /> : <Pause size={16} />}{paused ? "Resume" : "Pause"}
                  </button>
                  <button type="button" className="button button-secondary" disabled={!playing} onClick={stopStream}><CircleStop size={16} />Stop display</button>
                </div>
                <div className="notice-strip"><FileArchive size={16} /><span>{streamIsFiles ? "Files" : "Connection test"} · {formatBytes(prepared.archiveBytes.length)} · transfer {prepared.transferId.toString(16).padStart(8, "0").toUpperCase()} · pass {loopCount + 1}</span></div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="notice-strip"><AlertTriangle size={16} /><span>Sender speed is the local rendered QR payload rate. It is not receiver completion speed; use the receiver’s capture ETA for that.</span></div>

      <input ref={inputRef} hidden type="file" multiple onChange={(event) => void onInputChange(event)} {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} />
    </section>
  );
}

function framePayloadBytes(
  transfer: PreparedTransfer,
  frame: PreparedLoopFrame,
): number {
  if (frame.kind !== "data" || frame.chunkIndex === undefined) return 0;
  const offset = frame.chunkIndex * transfer.manifest.chunkSize;
  return Math.max(
    0,
    Math.min(transfer.manifest.chunkSize, transfer.archiveBytes.length - offset),
  );
}

function describeFrame(frame: PreparedLoopFrame | undefined): string {
  if (!frame) return "Preparing";
  if (frame.kind === "manifest") return "Manifest";
  return `Chunk ${(frame.chunkIndex ?? 0) + 1} / ${frame.totalChunks}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function shortConnectionId(value: string): string {
  return value ? `${value.slice(0, 6)}…${value.slice(-6)}` : "—";
}

function normalizeReceiptInput(value: string): string {
  const compact = value
    .toUpperCase()
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, "")
    .slice(0, 10);
  return compact.length > 5
    ? `${compact.slice(0, 5)}-${compact.slice(5)}`
    : compact;
}

function assertStoredSenderSession(
  value: StoredSenderSession,
): asserts value is StoredSenderSession {
  const validUint32 = (candidate: number) =>
    Number.isInteger(candidate) && candidate >= 0 && candidate <= 0xffffffff;
  const validTimestamp = (candidate: number) =>
    Number.isSafeInteger(candidate) && candidate >= 0;
  if (
    !value ||
    typeof value.key !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.key) ||
    value.version !== 2 ||
    typeof value.revision !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.revision) ||
    (value.phase !== "testing" && value.phase !== "verified") ||
    typeof value.rootName !== "string" ||
    typeof value.capturesEmptyDirectories !== "boolean" ||
    !(value.archiveBytes instanceof Uint8Array) ||
    !(value.probeArchiveBytes instanceof Uint8Array) ||
    value.probeArchiveBytes.length > MAX_ARCHIVE_BYTES ||
    !(value.probeManifestSha256 instanceof Uint8Array) ||
    value.probeManifestSha256.length !== 32 ||
    !(value.connectionId instanceof Uint8Array) ||
    value.connectionId.length !== 16 ||
    !Number.isInteger(value.chunkSize) ||
    value.chunkSize < 200 ||
    value.chunkSize > 900 ||
    !Number.isInteger(value.framesPerSecond) ||
    value.framesPerSecond < 1 ||
    value.framesPerSecond > 12 ||
    !["L", "M", "Q"].includes(value.errorCorrectionLevel) ||
    !validUint32(value.filesTransferId) ||
    !validUint32(value.probeTransferId) ||
    value.filesTransferId === value.probeTransferId ||
    !validTimestamp(value.filesCreatedAtMs) ||
    !validTimestamp(value.probeCreatedAtMs)
  ) {
    throw new Error("The saved sender session record is invalid.");
  }
}

function readTabSessionKey(): string | null {
  try {
    return sessionStorage.getItem(TAB_SESSION_KEY);
  } catch {
    return null;
  }
}

function rememberTabSessionKey(key: string): void {
  try {
    sessionStorage.setItem(TAB_SESSION_KEY, key);
  } catch {
    // IndexedDB still provides durable recovery; this tab will use the newest
    // saved session if sessionStorage is unavailable on its next load.
  }
}

function forgetTabSessionKey(key: string): void {
  try {
    if (sessionStorage.getItem(TAB_SESSION_KEY) === key) {
      sessionStorage.removeItem(TAB_SESSION_KEY);
    }
  } catch {
    // Nothing else can be done when the browser blocks sessionStorage.
  }
}

function sameFilesBinding(
  left: Awaited<ReturnType<typeof createFilesTransferBinding>>,
  right: Awaited<ReturnType<typeof createFilesTransferBinding>>,
): boolean {
  return (
    left.transferId === right.transferId &&
    bytesToHex(left.connectionId) === bytesToHex(right.connectionId) &&
    bytesToHex(left.archiveSha256) === bytesToHex(right.archiveSha256) &&
    bytesToHex(left.manifestSha256) === bytesToHex(right.manifestSha256)
  );
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
