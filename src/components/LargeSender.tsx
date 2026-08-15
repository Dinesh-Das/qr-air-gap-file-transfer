import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  FolderOpen,
  KeyRound,
  Link2,
  Pause,
  Play,
  QrCode as QrCodeIcon,
  Trash2,
} from "lucide-react";
import {
  collectLargeDirectory,
  createQrf3LargeSource,
  prepareLargeSource,
  type LargeSourceSelection,
  type LargeTransferProgress,
  type PreparedLargeSource,
} from "../lib/large-transfer";
import {
  Qrf3TransferPurpose,
  createQrf3Transfer,
  type Qrf3TransferPlan,
} from "../lib/stream-protocol";
import {
  prepareQrf3ConnectionTest,
  validateQrf3ReceiptCode,
  type PreparedQrf3ConnectionTest,
} from "../lib/large-connection";
import {
  deleteLargeSenderSession,
  loadLargeSenderSession,
  restoreLargeSenderSession,
  saveLargeSenderSession,
  supportsLargeSenderResume,
  type StoredLargeSenderSession,
} from "../lib/large-sender-resume";
import {
  advanceQrf3DisplayProgress,
  canResumeQrf3Probe,
} from "../lib/large-sender-playback";
import { formatBytes, formatClock, formatDuration } from "../lib/format";

type SenderPhase =
  | "idle"
  | "scanning"
  | "selected"
  | "preparing"
  | "testing"
  | "verified";

interface CurrentFrame {
  encoded: string;
  blockPosition: number;
  blockCount: number;
  pass: number;
  manifest: boolean;
}

const DEFAULT_FPS = 6;
const DEFAULT_BLOCK_BYTES = 700;
const MANIFEST_INTERVAL = 128;
const TAB_SESSION_KEY = "qr-air-gap-large-sender-session-key";

export function LargeSender({ active = true }: { active?: boolean }) {
  const [phase, setPhase] = useState<SenderPhase>("idle");
  const [selection, setSelection] = useState<LargeSourceSelection | null>(null);
  const [preparedSource, setPreparedSource] = useState<PreparedLargeSource | null>(null);
  const [filesPlan, setFilesPlan] = useState<Qrf3TransferPlan | null>(null);
  const [probe, setProbe] = useState<PreparedQrf3ConnectionTest | null>(null);
  const [activePlan, setActivePlan] = useState<Qrf3TransferPlan | null>(null);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [currentFrame, setCurrentFrame] = useState<CurrentFrame | null>(null);
  const [progress, setProgress] = useState<LargeTransferProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [resumeCandidate, setResumeCandidate] = useState<StoredLargeSenderSession | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const senderSessionRef = useRef<StoredLargeSenderSession | null>(null);
  const streamRef = useRef<{
    pass: number;
    position: number;
    iterator: AsyncGenerator<string>;
  } | null>(null);

  const totalBytes = selection ? Number(selection.totalFileBytes) : 0;
  const estimatedSeconds = selection
    ? Number(selection.totalFileBytes) / (DEFAULT_BLOCK_BYTES * fps)
    : 0;

  useEffect(() => {
    if (!supportsLargeSenderResume()) return;
    let cancelled = false;
    void loadLargeSenderSession(readRememberedSessionKey())
      .then((session) => {
        if (cancelled || !session) return;
        setResumeCandidate(session);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(toMessage(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  const pickFolder = useCallback(async () => {
    if (!window.showDirectoryPicker) {
      setError(
        "Large mode requires a Chromium browser with the directory picker. The compatibility picker would copy the whole tree into RAM.",
      );
      return;
    }
    const generation = ++generationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    try {
      const handle = await window.showDirectoryPicker({
        id: "qr-air-gap-large-sender",
        mode: "read",
      });
      setPhase("scanning");
      const next = await collectLargeDirectory(
        handle,
        (value) => generation === generationRef.current && setProgress(value),
        controller.signal,
      );
      if (generation !== generationRef.current) return;
      setSelection(next);
      setPreparedSource(null);
      setFilesPlan(null);
      setProbe(null);
      setActivePlan(null);
      setProgress(null);
      setPhase("selected");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (generation === generationRef.current) {
        setPhase(selection ? "selected" : "idle");
        setError(toMessage(caught));
      }
    }
  }, [selection]);

  const prepare = useCallback(async () => {
    if (!selection) return;
    const generation = ++generationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("preparing");
    setError(null);
    try {
      const source = await prepareLargeSource(
        selection,
        (value) => generation === generationRef.current && setProgress(value),
        controller.signal,
      );
      if (generation !== generationRef.current) return;
      const plan = await createQrf3Transfer(createQrf3LargeSource(source), {
        rootName: source.rootName,
        blockSize: DEFAULT_BLOCK_BYTES,
        purpose: Qrf3TransferPurpose.Files,
        archiveSha256: source.streamSha256,
      });
      const nextProbe = await prepareQrf3ConnectionTest(plan);
      if (generation !== generationRef.current) return;
      let storedSession: StoredLargeSenderSession | null = null;
      let persistenceWarning: string | null = null;
      if (supportsLargeSenderResume()) {
        try {
          const filesManifest = plan.manifest;
          const probeManifest = nextProbe.transfer.manifest;
          storedSession = await saveLargeSenderSession({
            phase: "testing",
            rootName: source.rootName,
            rootHandle: source.rootHandle,
            fileCount: source.files.length,
            directoryCount: source.directories.length,
            totalFileBytes: source.totalFileBytes.toString(),
            framesPerSecond: fps,
            blockSize: plan.blockSize,
            connectionId: filesManifest.connectionId,
            filesTransferId: filesManifest.transferId,
            filesCreatedAtMs: filesManifest.createdAtMs,
            filesManifestId: plan.manifestId,
            filesStreamSha256: filesManifest.archiveSha256,
            filesTransferLength: plan.transferLength,
            probeBytes: nextProbe.bytes,
            probeTransferId: probeManifest.transferId,
            probeCreatedAtMs: probeManifest.createdAtMs,
            probeManifestId: nextProbe.transfer.manifestId,
          });
        } catch (caught) {
          persistenceWarning = toMessage(caught);
        }
      }
      if (generation !== generationRef.current) {
        if (storedSession) {
          void deleteLargeSenderSession(storedSession).catch(() => undefined);
        }
        return;
      }
      senderSessionRef.current = storedSession;
      setResumeCandidate(null);
      if (storedSession) rememberSessionKey(storedSession.key);
      setPreparedSource(source);
      setFilesPlan(plan);
      setProbe(nextProbe);
      setActivePlan(nextProbe.transfer);
      setProgress(null);
      setReceipt("");
      setPhase("testing");
      setPlaying(true);
      setPaused(false);
      setStartedAt(Date.now());
      setResumeNotice(
        storedSession
          ? "The source handle and exact QRF3 identities are saved locally for reload-safe resume."
          : persistenceWarning
            ? `Reload recovery is unavailable: ${persistenceWarning}`
            : "Resume is available while this page remains open.",
      );
      streamRef.current = null;
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (generation === generationRef.current) {
        setPhase("selected");
        setError(toMessage(caught));
      }
    }
  }, [fps, selection]);

  const restoreSaved = useCallback(async () => {
    const session = resumeCandidate;
    if (!session) return;
    const generation = ++generationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRestoring(true);
    setError(null);
    try {
      const restored = await restoreLargeSenderSession(
        session,
        (value) => generation === generationRef.current && setProgress(value),
        controller.signal,
      );
      if (generation !== generationRef.current) return;
      senderSessionRef.current = session;
      rememberSessionKey(session.key);
      setResumeCandidate(null);
      setSelection(restored.selection);
      setPreparedSource(restored.preparedSource);
      setFilesPlan(restored.filesPlan);
      setProbe(restored.probe);
      setActivePlan(
        session.phase === "testing"
          ? restored.probe.transfer
          : restored.filesPlan,
      );
      setFps(session.framesPerSecond);
      setProgress(null);
      setReceipt("");
      setPhase(session.phase);
      setPlaying(session.phase === "testing");
      setPaused(false);
      setCurrentFrame(null);
      setStartedAt(session.phase === "testing" ? Date.now() : null);
      setResumeNotice(
        session.phase === "testing"
          ? "Restored and revalidated the exact saved probe and Files stream."
          : "Restored and revalidated the exact verified Files stream.",
      );
      streamRef.current = null;
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      if (generation === generationRef.current) {
        setProgress(null);
        setError(toMessage(caught));
      }
    } finally {
      if (generation === generationRef.current) setRestoring(false);
    }
  }, [resumeCandidate]);

  const validateReceipt = useCallback(async () => {
    if (!probe || !filesPlan) return;
    if (!validateQrf3ReceiptCode(receipt, probe.receiptCode)) {
      setError("That receipt does not match this exact QRF3 connection test.");
      return;
    }
    let persistenceWarning: string | null = null;
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
        const updated = await saveLargeSenderSession(
          { ...session, phase: "verified" },
          storedSession,
        );
        senderSessionRef.current = updated;
        rememberSessionKey(updated.key);
      } catch (caught) {
        persistenceWarning = toMessage(caught);
      }
    }
    setError(null);
    setActivePlan(filesPlan);
    setPhase("verified");
    setPlaying(false);
    setPaused(false);
    setCurrentFrame(null);
    setResumeNotice(
      senderSessionRef.current?.phase === "verified"
        ? "The exact verified QRF3 Files stream is saved locally for reload-safe resume."
        : persistenceWarning
          ? `The stream is unlocked, but verified reload recovery could not be saved: ${persistenceWarning}`
          : "Resume is available while this page remains open.",
    );
    streamRef.current = null;
  }, [filesPlan, probe, receipt]);

  const discard = useCallback(async () => {
    abortRef.current?.abort();
    generationRef.current += 1;
    const storedSession = senderSessionRef.current ?? resumeCandidate;
    if (storedSession) {
      try {
        const deleted = await deleteLargeSenderSession(storedSession);
        if (!deleted) {
          throw new Error(
            "This saved large sender session changed in another tab and was not deleted.",
          );
        }
      } catch (caught) {
        setError(toMessage(caught));
        return;
      }
    }
    senderSessionRef.current = null;
    forgetSessionKey();
    setResumeCandidate(null);
    setSelection(null);
    setPreparedSource(null);
    setFilesPlan(null);
    setProbe(null);
    setActivePlan(null);
    setCurrentFrame(null);
    setProgress(null);
    setPlaying(false);
    setPaused(false);
    setReceipt("");
    setResumeNotice(null);
    setError(null);
    setPhase("idle");
    streamRef.current = null;
  }, [resumeCandidate]);

  useEffect(() => {
    if (active) return;
    if (playing) setPaused(true);
    if (
      phase === "scanning" ||
      phase === "preparing" ||
      restoring
    ) {
      generationRef.current += 1;
      abortRef.current?.abort();
      setProgress(null);
      setRestoring(false);
      setPhase(selection ? "selected" : "idle");
    }
  }, [active, phase, playing, restoring, selection]);

  useEffect(() => {
    if (!playing || paused || !activePlan) return;
    let cancelled = false;
    let timeoutId: number | undefined;
    const generation = generationRef.current;
    const manifestFramePromise = activePlan.manifestFrame();

    const next = async () => {
      try {
        let stream = streamRef.current;
        if (!stream) {
          stream = {
            pass: 0,
            position: 0,
            iterator: activePlan.passFrames({
              pass: 0,
              manifestInterval: MANIFEST_INTERVAL,
            }),
          };
          streamRef.current = stream;
        }
        let value = await stream.iterator.next();
        if (value.done) {
          stream.pass += 1;
          stream.position = 0;
          stream.iterator = activePlan.passFrames({
            pass: stream.pass,
            manifestInterval: MANIFEST_INTERVAL,
          });
          value = await stream.iterator.next();
        }
        if (
          value.done ||
          cancelled ||
          generation !== generationRef.current ||
          !canvasRef.current
        ) {
          return;
        }
        const encoded = value.value;
        const nextProgress = advanceQrf3DisplayProgress(
          encoded,
          await manifestFramePromise,
          stream.position,
          activePlan.blockCount,
        );
        const manifest = nextProgress.manifest;
        stream.position = nextProgress.dataFramesShown;
        await QRCode.toCanvas(canvasRef.current, encoded, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 720,
          color: { dark: "#132019", light: "#ffffff" },
        });
        if (cancelled || generation !== generationRef.current) return;
        setCurrentFrame({
          encoded,
          blockPosition: Math.min(stream.position, activePlan.blockCount),
          blockCount: activePlan.blockCount,
          pass: stream.pass,
          manifest,
        });
        timeoutId = window.setTimeout(() => void next(), 1000 / fps);
      } catch (caught) {
        if (!cancelled) {
          setPlaying(false);
          setError(toMessage(caught));
        }
      }
    };
    void next();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [activePlan, fps, paused, playing]);

  const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;
  const selectedSummary = useMemo(() => {
    if (!selection) return null;
    return `${selection.files.length.toLocaleString()} files · ${selection.directories.length.toLocaleString()} folders`;
  }, [selection]);

  return (
    <section className="workspace" aria-labelledby="large-sender-title">
      <div className="page-heading">
        <span className="eyebrow">Disk-streamed optical sender</span>
        <h1 id="large-sender-title">Send very large trees without loading them into RAM.</h1>
        <p>QRF3 hashes file slices, generates each QR on demand, and changes block order on every pass so periodic camera loss does not repeat forever.</p>
      </div>

      <div className="notice-strip"><AlertTriangle size={16} /><span>QR is physically slow: at the default 700 bytes × 6 FPS, 1 GiB needs about 71 hours before retransmissions. Large mode makes multi-GB transfers reliable and bounded-memory, not fast.</span></div>

      <div className="transfer-card sender-layout">
        <div className="panel">
          <h2>Large source tree</h2>
          {!selection ? (
            <div className="drop-zone"><div className="drop-zone-content"><FolderOpen size={28} /><h3>{resumeCandidate ? `Resume ${resumeCandidate.rootName}` : "Choose a folder"}</h3><p>{resumeCandidate ? `A ${resumeCandidate.phase} QRF3 session is saved locally. The source will be re-scanned and re-hashed before it resumes.` : "Metadata is scanned first; file bytes stay on disk."}</p>{resumeCandidate && <button className="button button-primary" type="button" disabled={restoring} onClick={() => void restoreSaved()}><Play size={16} />{restoring ? "Revalidating source…" : "Resume saved transfer"}</button>}<button className="button button-secondary" type="button" disabled={phase === "scanning" || restoring} onClick={() => void pickFolder()}><FolderOpen size={16} />{phase === "scanning" ? "Scanning…" : "Browse folder"}</button>{resumeCandidate && <button className="button button-danger" type="button" disabled={restoring} onClick={() => void discard()}><Trash2 size={16} />Discard saved transfer</button>}</div></div>
          ) : (
            <div className="selection-card">
              <strong>{selection.rootName}</strong>
              <p>{selectedSummary}</p>
              <div className="metric-grid"><div className="metric"><span>Source size</span><strong>{formatBytes(totalBytes)}</strong></div><div className="metric"><span>One ideal pass</span><strong>{formatDuration(estimatedSeconds)}</strong></div><div className="metric"><span>Memory model</span><strong>Bounded</strong></div></div>
            </div>
          )}

          {progress && <div className="status-box" role="status"><span className="spinner" /><span>{progress.phase === "scan" ? "Scanning paths" : `Hashing ${progress.path ?? "source"}`} · {progress.filesComplete.toLocaleString()} / {progress.filesTotal.toLocaleString()} files · {formatBytes(Number(progress.bytesComplete))}</span></div>}
          {resumeNotice && <div className="status-box" role="status"><CheckCircle2 size={16} /><span>{resumeNotice}</span></div>}
          {phase === "testing" && probe && (
            <form className="receipt-panel" onSubmit={(event) => { event.preventDefault(); void validateReceipt(); }}><div className="panel-kicker"><KeyRound size={14} />Receiver receipt</div><label htmlFor="qrf3-receipt">Enter the code shown by the receiver</label><div className="receipt-entry"><input id="qrf3-receipt" value={receipt} onChange={(event) => setReceipt(event.target.value.toUpperCase().replace(/[^0-9A-Z-]/g, "").slice(0, 11))} /><button className="button button-primary" type="submit"><Link2 size={16} />Verify</button></div></form>
          )}
          {phase === "verified" && <div className="status-box success"><CheckCircle2 size={16} /><span>Probe verified. The exact prepared QRF3 Files stream is unlocked.</span></div>}
          {error && <div className="status-box error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}

          <div className="field"><label htmlFor="large-fps">Frames / second</label><input id="large-fps" type="number" min={1} max={12} value={fps} onChange={(event) => setFps(Math.max(1, Math.min(12, Number(event.target.value) || 1)))} /></div>
          <div className="sender-actions">
            {selection && (phase === "selected" || phase === "preparing") && <button className="button button-primary button-wide" type="button" disabled={phase === "preparing"} onClick={() => void prepare()}>{phase === "preparing" ? <><span className="spinner" />Hashing source…</> : <><Link2 size={16} />Prepare and test connection</>}</button>}
            {canResumeQrf3Probe(phase, activePlan !== null, playing) && <button className="button button-primary button-wide" type="button" onClick={() => { setPaused(false); setStartedAt((value) => value ?? Date.now()); setPlaying(true); }}><Play size={16} />Resume probe</button>}
            {phase === "verified" && !playing && <button className="button button-primary button-wide" type="button" onClick={() => { streamRef.current = null; setPaused(false); setStartedAt(Date.now()); setPlaying(true); }}><Play size={16} />Start verified Files stream</button>}
            {selection && <button className="button button-danger button-wide" type="button" onClick={() => void discard()}><Trash2 size={16} />Discard large transfer</button>}
          </div>
        </div>

        <div className="panel">
          <div className="qr-stage">
            {!activePlan ? <div className="qr-placeholder"><div className="qr-placeholder-inner"><QrCodeIcon size={57} /><strong>No QRF3 stream active</strong></div></div> : <div className="qr-live"><div className={`qr-canvas-wrap ${currentFrame ? "" : "qr-hidden"}`}><canvas ref={canvasRef} aria-label="Current QRF3 code" />{!currentFrame && <div className="qr-stopped-overlay"><QrCodeIcon size={44} /><strong>Stream stopped</strong></div>}</div><div className="qr-meta"><span className={`live-dot ${paused ? "paused" : playing ? "" : "stopped"}`}>{playing ? paused ? "Paused" : phase === "testing" ? "Connection test" : "Files broadcasting" : "Stopped"}</span><span>{currentFrame ? currentFrame.manifest ? "Manifest" : `Block ${currentFrame.blockPosition.toLocaleString()} / ${currentFrame.blockCount.toLocaleString()}` : "Ready"}</span></div>{currentFrame && <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.min(100, currentFrame.blockPosition / Math.max(1, currentFrame.blockCount) * 100)}%` }} /></div>}<div className="playback-controls"><button className="button button-secondary" type="button" disabled={!playing} onClick={() => setPaused((value) => !value)}>{paused ? <Play size={16} /> : <Pause size={16} />}{paused ? "Resume" : "Pause"}</button><button className="button button-secondary" type="button" disabled={!playing} onClick={() => { setPlaying(false); setPaused(false); setCurrentFrame(null); }}><CircleStop size={16} />Stop display</button></div><div className="notice-strip"><span>{phase === "testing" ? "Probe" : "Files"} · pass {(currentFrame?.pass ?? 0) + 1} · active {formatClock(elapsed)}</span></div></div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRememberedSessionKey(): string | null {
  try {
    return sessionStorage.getItem(TAB_SESSION_KEY);
  } catch {
    return null;
  }
}

function rememberSessionKey(key: string): void {
  try {
    sessionStorage.setItem(TAB_SESSION_KEY, key);
  } catch {
    // IndexedDB's latest-session lookup remains available.
  }
}

function forgetSessionKey(): void {
  try {
    sessionStorage.removeItem(TAB_SESSION_KEY);
  } catch {
    // Nothing else is required when per-tab storage is unavailable.
  }
}
