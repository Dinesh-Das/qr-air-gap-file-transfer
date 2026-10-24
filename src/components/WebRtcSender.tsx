import { ConnectionDiagnostics } from "./ConnectionDiagnostics";
import { PairingReadiness } from "./PairingReadiness";
import { usePairingReadiness } from "../lib/use-pairing-readiness";
import { supportsDurableBlockStore } from "../lib/block-store";
import { watchWebRtcPeerHealth } from "../lib/webrtc-peer-health";
import { useTransferElapsed, useTransferRates } from "../lib/use-transfer-rate";
import { TransferMetrics } from "./TransferMetrics";
import { TransferProblem } from "./TransferProblem";
import { describeTransferProblem, TransferMessageSizeError } from "../lib/transfer-problem";
import { collectSelectedFiles, collectSelectedItems, captureDroppedItems, type SelectedHandle } from "../lib/selected-files";
import { createSavedWebRtcSource, saveWebRtcSource, loadWebRtcSource, deleteWebRtcSource, restoreWebRtcSource, type SavedWebRtcSource } from "../lib/webrtc-sender-resume";
import { useCallback, useEffect, useRef, useState } from "react";
import { PeerAuthorization } from "../lib/webrtc-authorization";
import { VerifyDevice } from "./VerifyDevice";
import {
  CheckCircle2,
  FolderOpen,
  Link2,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import {
  collectLargeDirectory,
  prepareLargeSource,
  type LargeSourceSelection,
  type LargeTransferProgress,
  type PreparedLargeSource,
} from "../lib/large-transfer";
import { formatBytes } from "../lib/format";
import {
  OFFLINE_DATA_HEADER_BYTES,
  createOfflineTransferManifest,
  decodeOfflineControl,
  encodeOfflineControl,
  type OfflineTransferManifest,
} from "../lib/webrtc-protocol";
import {
  OfflineSourceSender,
  type OfflineTransferProgress,
} from "../lib/webrtc-transfer";
import {
  createOfflineSessionId,
  assertLocalSignalCandidates,
  limitSdpToLocalCandidates,
  waitForIceGatheringComplete,
} from "../lib/webrtc-signaling";
import {
  cancelRendezvousRoom,
  checkRendezvousReadiness,
  createRendezvousRoom,
  formatPairingCode,
  waitForRendezvousAnswer,
  type RendezvousRoom,
} from "../lib/webrtc-rendezvous";

type Phase =
  | "idle"
  | "scanning"
  | "checking"
  | "selected"
  | "preparing"
  | "pairing"
  | "verify-device"
  | "waiting"
  | "transferring"
  | "verifying"
  | "complete"
  | "failed";

export function WebRtcSender({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const [capabilityError] = useState(() => typeof RTCPeerConnection !== "function"
    ? "This browser cannot make a direct connection. Open this app in a current Edge or Chrome window."
    : !supportsDurableBlockStore() ? "This browser cannot store transfer data safely. Open this app in a current Edge or Chrome window."
    : !window.showDirectoryPicker && !window.showOpenFilePicker ? "This browser cannot select files for transfer. Open this app in a current Edge or Chrome window." : null);
  const readiness = usePairingReadiness(!capabilityError);
  const [savedSource, setSavedSource] = useState<SavedWebRtcSource | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const savedSourceRef = useRef<SavedWebRtcSource | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [selection, setSelection] = useState<LargeSourceSelection | null>(null);
  const [hashProgress, setHashProgress] = useState<LargeTransferProgress | null>(null);
  const [sourcePreparing, setSourcePreparing] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingAddresses, setPairingAddresses] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectionInterrupted, setConnectionInterrupted] = useState(false);
  const [verificationCode, setVerificationCode] = useState<string | null>(null);
  const [localConfirmed, setLocalConfirmed] = useState(false);
  const [progress, setProgress] = useState<OfflineTransferProgress | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const sourceRef = useRef<PreparedLargeSource | null>(null);
  const manifestRef = useRef<OfflineTransferManifest | null>(null);
  const senderRef = useRef<OfflineSourceSender | null>(null);
  const roomRef = useRef<RendezvousRoom | null>(null);
  const authorizationRef = useRef<PeerAuthorization | null>(null);
  const authorizedRef = useRef(false);
  const sendingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const taskAbortRef = useRef<AbortController | null>(null);
  const sourceAbortRef = useRef<AbortController | null>(null);
  const sourceLifecycleRef = useRef(0);
  const preparationRef = useRef<Promise<void> | null>(null);
  const peerHealthCleanupRef = useRef<(() => void) | null>(null);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const closeConnection = useCallback((reason?: Error) => {
    lifecycleRef.current += 1;
    authorizationRef.current?.close();
    authorizationRef.current = null;
    authorizedRef.current = false;
    sendingRef.current = false;
    const room = roomRef.current;
    roomRef.current = null;
    if (room) void cancelRendezvousRoom(room).catch(() => undefined);
    taskAbortRef.current?.abort(reason ?? new DOMException("Stopped", "AbortError"));
    taskAbortRef.current = null;
    peerHealthCleanupRef.current?.();
    peerHealthCleanupRef.current = null;
    if (reason) senderRef.current?.fail(reason);
    senderRef.current?.dispose();
    senderRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
  }, []);

  const cancelSourcePreparation = useCallback(() => {
    sourceLifecycleRef.current += 1;
    sourceAbortRef.current?.abort(new DOMException("Source discarded", "AbortError"));
    sourceAbortRef.current = null;
    preparationRef.current = null;
    setSourcePreparing(false);
    setHashProgress(null);
  }, []);

  useEffect(() => () => {
    closeConnection();
    cancelSourcePreparation();
  }, [closeConnection, cancelSourcePreparation]);

  useEffect(() => {
    let cancelled = false;
    void loadWebRtcSource().then((record) => {
      if (!cancelled && phaseRef.current === "idle") { setSavedSource(record); savedSourceRef.current = record; }
    }).catch(() => { if (!cancelled) setResumeNotice("Saved sources are unavailable in this browser."); });
    return () => { cancelled = true; };
  }, []);

  const fail = useCallback((caught: unknown, failurePhase?: Phase) => {
    if (caught instanceof DOMException && caught.name === "AbortError") return;
    const error = caught instanceof Error ? caught : new Error(String(caught));
    const problem = describeTransferProblem(error, { role: "sender", phase: failurePhase ?? phaseRef.current });
    setError(problem.message);
    setErrorDetails(problem.details);
    setConnected(false); setConnectionInterrupted(false);
    setPhase("failed");
    const channel = channelRef.current;
    if (channel?.readyState === "open") {
      try {
        // Preparation can fail while the connected device is still unconfirmed.
        // Keep filenames and other local diagnostics private until both consent.
        const remoteMessage = authorizationRef.current?.authorized ? error.message
          : "The sender stopped before both devices were confirmed. Reconnect to try again.";
        channel.send(encodeOfflineControl({ type: "error", message: remoteMessage.slice(0, 2_000) }));
      } catch {
        // The terminal close below is authoritative.
      }
    }
    closeConnection(error);
  }, [closeConnection]);

  const watchPeerHealth = useCallback((peer: RTCPeerConnection, generation: number) => {
    peerHealthCleanupRef.current = watchWebRtcPeerHealth(peer, () => generation === lifecycleRef.current, fail, (state) => setConnectionInterrupted(state === "disconnected"));
  }, [fail]);

  const busy = sourcePreparing || !["idle", "selected", "complete", "failed"].includes(phase);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const maybeAuthorize = useCallback(() => {
    const channel = channelRef.current;
    const source = sourceRef.current;
    const manifest = manifestRef.current;
    if (
      authorizedRef.current ||
      !authorizationRef.current?.authorized ||
      channel?.readyState !== "open"
    ) return;
    if (!source || !manifest) {
      setPhase("preparing");
      return;
    }
    const maxMessageSize = peerRef.current?.sctp?.maxMessageSize;
    if (
      maxMessageSize !== undefined &&
      maxMessageSize !== 0 &&
      maxMessageSize < manifest.blockSize + OFFLINE_DATA_HEADER_BYTES
    ) {
      fail(new TransferMessageSizeError(
        `This browser connection supports only ${formatBytes(maxMessageSize)} messages, which is below the transfer block size.`,
      ));
      return;
    }
    authorizedRef.current = true;
    const sender = new OfflineSourceSender(channel, source, manifest);
    senderRef.current = sender;
    channel.send(encodeOfflineControl({ type: "manifest", manifest }));
    setPhase("waiting");
  }, [fail]);

  const ensureSourcePrepared = useCallback(() => {
    if (sourceRef.current && manifestRef.current) { maybeAuthorize(); return; }
    if (!selection || preparationRef.current) return;
    const generation = sourceLifecycleRef.current;
    const controller = new AbortController();
    sourceAbortRef.current = controller;
    setSourcePreparing(true);
    // Connection teardown must not restart a multi-gigabyte hash pass. Only
    // discarding the source cancels this generation and its immutable snapshots.
    const job = (async () => {
      const source = await prepareLargeSource(selection, (next) => {
        if (generation === sourceLifecycleRef.current) setHashProgress(next);
      }, controller.signal);
      controller.signal.throwIfAborted();
      const manifest = await createOfflineTransferManifest(source);
      if (generation !== sourceLifecycleRef.current) return;
      if (savedSourceRef.current?.manifest.manifestId !== manifest.manifestId) {
        const record = createSavedWebRtcSource(source, manifest);
        try {
          await saveWebRtcSource(record);
          if (generation !== sourceLifecycleRef.current) { await deleteWebRtcSource(record.key); return; }
          savedSourceRef.current = record;
          setSavedSource(record);
          setResumeNotice("Your selection is saved on this device for recovery. Reopening it checks every file again.");
        } catch {
          if (generation !== sourceLifecycleRef.current) return;
          setResumeNotice("This source could not be saved for reload recovery. Keep this tab open or reselect the folder after reload.");
        }
      }
      if (generation !== sourceLifecycleRef.current) return;
      sourceRef.current = source;
      manifestRef.current = manifest;
      setHashProgress(null);
      setSourcePreparing(false);
      sourceAbortRef.current = null;
      maybeAuthorize();
    })();
    preparationRef.current = job;
    void job.catch((caught) => {
      if (generation !== sourceLifecycleRef.current) return;
      preparationRef.current = null;
      sourceAbortRef.current = null;
      setHashProgress(null);
      setSourcePreparing(false);
      fail(caught, "preparing");
    });
  }, [fail, maybeAuthorize, selection]);

  const confirmPairing = useCallback(() => {
    const channel = channelRef.current;
    const authorization = authorizationRef.current;
    if (!authorization || authorization.locallyConfirmed || channel?.readyState !== "open") return;
    try {
      channel.send(encodeOfflineControl(authorization.confirmLocal()));
      setLocalConfirmed(true);
      maybeAuthorize();
    } catch (caught) { fail(caught); }
  }, [fail, maybeAuthorize]);

  const beginSending = useCallback(() => {
    const sender = senderRef.current;
    authorizationRef.current?.requireAuthorized();
    if (!sender || !authorizedRef.current) throw new Error("Resume arrived before the transfer manifest.");
    if (sendingRef.current) return;
    sendingRef.current = true;
    const generation = lifecycleRef.current;
    const controller = new AbortController();
    taskAbortRef.current = controller;
    setPhase("transferring");
    void sender.run(controller.signal, (next) => {
      if (generation === lifecycleRef.current) setProgress(next);
    }).then(() => {
      if (generation === lifecycleRef.current && phaseRef.current !== "complete") setPhase("verifying");
    }).catch((caught) => { if (generation === lifecycleRef.current) fail(caught); });
  }, [fail]);

  const installChannel = useCallback((channel: RTCDataChannel, generation: number) => {
    channel.binaryType = "arraybuffer";
    channelRef.current = channel;
    channel.addEventListener("open", () => {
      if (generation !== lifecycleRef.current) return;
      setConnected(true);
    });
    channel.addEventListener("close", () => {
      if (generation !== lifecycleRef.current || phaseRef.current === "complete") return;
      setConnected(false); setConnectionInterrupted(false);
      if (["preparing", "pairing", "verify-device", "waiting", "transferring", "verifying"].includes(phaseRef.current)) {
        fail(new Error("The local connection closed. Reconnect to resume safely."));
      }
    });
    channel.addEventListener("message", (event) => {
      if (generation !== lifecycleRef.current || phaseRef.current === "complete") return;
      try {
        if (typeof event.data !== "string") throw new Error("Unexpected file data from the receiver.");
        const message = decodeOfflineControl(event.data);
        if (!["peer-confirmed", "cancel", "error"].includes(message.type)) {
          if (!authorizationRef.current) throw new Error("Device verification is not ready.");
          authorizationRef.current.requireAuthorized();
        }
        switch (message.type) {
          case "peer-confirmed":
            if (!authorizationRef.current) throw new Error("Device verification is not ready.");
            authorizationRef.current.acceptConfirmation(message);
            maybeAuthorize();
            break;
          case "resume-ranges":
            senderRef.current?.applyResumeRanges(message.ranges);
            break;
          case "resume-complete":
            beginSending();
            break;
          case "ack":
            senderRef.current?.acknowledge(message.indices);
            break;
          case "receiver-complete":
            if (!senderRef.current?.isPayloadComplete) throw new Error("The receiver reported completion before all data was acknowledged.");
            setProgress((current) => current ? { ...current, completedBytes: current.totalBytes, completedBlocks: current.totalBlocks } : current);
            phaseRef.current = "complete";
            setPhase("complete");
            peerHealthCleanupRef.current?.();
            peerHealthCleanupRef.current = null;
            senderRef.current?.dispose();
            senderRef.current = null;
            channelRef.current?.close();
            channelRef.current = null;
            peerRef.current?.close();
            peerRef.current = null;
            setConnected(false); setConnectionInterrupted(false);
            break;
          case "cancel":
            throw new Error(message.reason ?? "The receiver cancelled the transfer.");
          case "error":
            throw new Error(message.message);
          default:
            throw new Error("Unexpected control message from the receiver.");
        }
      } catch (caught) {
        senderRef.current?.fail(caught instanceof Error ? caught : new Error(String(caught)));
        fail(caught);
      }
    });
  }, [beginSending, fail, maybeAuthorize]);

  const pickSource = useCallback(async (kind: "folder" | "files" | "drop", dropped?: Promise<SelectedHandle[]>) => {
    if (phaseRef.current !== "idle" || !readiness.ready) return;
    if (kind !== "drop" && (kind === "folder" ? !window.showDirectoryPicker : !window.showOpenFilePicker)) {
      fail(new Error("This selection requires a Chromium browser with file-system pickers."));
      return;
    }
    closeConnection();
    const generation = lifecycleRef.current;
    const controller = new AbortController();
    taskAbortRef.current = controller;
    phaseRef.current = "scanning";
    setError(null); setErrorDetails(null);
    setPhase("scanning");
    try {
      const report = (progress: LargeTransferProgress) => { if (generation === lifecycleRef.current) setHashProgress(progress); };
      // Initial readiness has already passed. Invoke the picker directly from
      // the user action; preparation rechecks the service before hashing.
      const next = kind === "drop" ? await collectSelectedItems(await dropped!, report, controller.signal) : kind === "folder"
        ? await collectLargeDirectory(await window.showDirectoryPicker!({ id: "airgap-webrtc-source", mode: "read" }), report, controller.signal)
        : await collectSelectedFiles(await window.showOpenFilePicker!({ id: "airgap-webrtc-files", multiple: true }), report, controller.signal);
      if (generation !== lifecycleRef.current) return;
      setSelection(next);
      setHashProgress(null);
      setPhase("selected");
    } catch (caught) {
      if (generation !== lifecycleRef.current) return;
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setPhase("idle");
        return;
      }
      fail(caught);
    }
  }, [closeConnection, fail, readiness.ready]);

  const restoreSource = useCallback(async () => {
    if (!savedSource || selection || !["idle", "failed"].includes(phaseRef.current) || !readiness.ready) return;
    phaseRef.current = "checking";
    closeConnection();
    const generation = lifecycleRef.current;
    const controller = new AbortController();
    taskAbortRef.current = controller;
    setPhase("checking");
    setError(null); setErrorDetails(null);
    try {
      const restored = await restoreWebRtcSource(savedSource, (progress) => {
        if (generation === lifecycleRef.current) setHashProgress(progress);
      }, controller.signal, async () => {
        await checkRendezvousReadiness(controller.signal);
        controller.signal.throwIfAborted();
        setPhase("preparing");
      });
      if (generation !== lifecycleRef.current) return;
      sourceRef.current = restored.source;
      manifestRef.current = restored.manifest;
      setSelection(restored.selection);
      setHashProgress(null);
      setResumeNotice("Saved source checked and verified. Pair again to resume the transfer.");
      setPhase("selected");
    } catch (caught) { if (generation === lifecycleRef.current) fail(caught); }
  }, [savedSource, selection, closeConnection, fail, readiness.ready]);

  const discardSavedSource = useCallback(async () => {
    const record = savedSourceRef.current;
    if (!record) return;
    try {
      await deleteWebRtcSource(record.key);
      if (savedSourceRef.current?.key === record.key) {
        savedSourceRef.current = null;
        setSavedSource(null);
        setResumeNotice("Saved source discarded.");
      }
    } catch { setResumeNotice("Could not discard the saved source. Retry when browser storage is available."); }
  }, []);

  const prepare = useCallback(async () => {
    if (!selection || !["selected", "failed"].includes(phaseRef.current)) return;
    if (typeof RTCPeerConnection !== "function") {
      setError("This browser cannot make a direct connection. Open this app in a current Edge or Chrome window.");
      setErrorDetails(null);
      return;
    }
    phaseRef.current = "checking";
    closeConnection();
    const generation = lifecycleRef.current;
    const controller = new AbortController();
    taskAbortRef.current = controller;
    setError(null); setErrorDetails(null);
    setVerificationCode(null);
    setLocalConfirmed(false);
    setPairingCode(null);
    setConnected(false); setConnectionInterrupted(false);
    setProgress(null);
    setPaused(false);
    setPhase("checking");
    try {
      await checkRendezvousReadiness(controller.signal);
      if (generation !== lifecycleRef.current) return;
      const sessionId = createOfflineSessionId();
      const peer = new RTCPeerConnection({ iceServers: [] });
      peerRef.current = peer;
      watchPeerHealth(peer, generation);
      const channel = peer.createDataChannel("airgap-file-v1", { ordered: true });
      installChannel(channel, generation);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGatheringComplete(peer, controller.signal);
      const rawSdp = peer.localDescription?.sdp;
      if (!rawSdp) throw new Error("The browser did not create a local connection offer.");
      const sdp = limitSdpToLocalCandidates(rawSdp);
      const room = await createRendezvousRoom({ v: 1, kind: "offer", sessionId, sdp }, controller.signal);
      if (generation !== lifecycleRef.current) {
        void cancelRendezvousRoom(room).catch(() => undefined);
        return;
      }
      roomRef.current = room;
      setPairingCode(room.code);
      setPairingAddresses(room.addresses ?? []);
      setPhase("pairing");
      ensureSourcePrepared();
      const bundle = await waitForRendezvousAnswer(room, sessionId, controller.signal);
      if (generation !== lifecycleRef.current) return;
      assertLocalSignalCandidates(bundle.sdp);
      const authorization = await PeerAuthorization.create(sessionId, sdp, bundle.sdp);
      if (generation !== lifecycleRef.current) return;
      authorizationRef.current = authorization;
      await peer.setRemoteDescription({ type: "answer", sdp: bundle.sdp });
      if (generation !== lifecycleRef.current) return;
      setVerificationCode(authorization.code);
      setPhase("verify-device");
      void cancelRendezvousRoom(room).catch(() => undefined);
      roomRef.current = null;
    } catch (caught) {
      if (generation === lifecycleRef.current) fail(caught);
    }
  }, [closeConnection, ensureSourcePrepared, fail, installChannel, selection, watchPeerHealth]);

  const reset = useCallback(() => {
    closeConnection();
    cancelSourcePreparation();
    sourceRef.current = null;
    manifestRef.current = null;
    setVerificationCode(null);
    setLocalConfirmed(false);
    authorizedRef.current = false;
    sendingRef.current = false;
    setSelection(null);
    setPairingCode(null);
    setConnected(false); setConnectionInterrupted(false);
    setProgress(null);
    setPaused(false);
    setError(null); setErrorDetails(null);
    setPhase("idle");
    readiness.retry();
  }, [cancelSourcePreparation, closeConnection, readiness.retry]);

  const stopConnection = useCallback(() => {
    closeConnection();
    setConnected(false); setConnectionInterrupted(false);
    setPairingCode(null);
    setVerificationCode(null);
    setLocalConfirmed(false);
    setPhase(selection ? "selected" : "idle");
  }, [closeConnection, selection]);

  const percentage = progress ? (progress.completedBytes / progress.totalBytes) * 100 : 0;
  const { currentRate, smoothedRate: rate } = useTransferRates(progress, phase === "transferring" && !paused);
  const elapsed = useTransferElapsed(progress !== null, ["transferring", "verifying"].includes(phase));

  const hasTransferProgress = progress !== null && ["transferring", "verifying", "complete", "failed"].includes(phase);
  const problemNotice = (error || capabilityError) && <TransferProblem message={(error || capabilityError)!} details={error ? errorDetails : null} />;
  const retryAction = phase === "failed" && selection && <button className="button button-primary button-wide confirm-button" onClick={prepare}><RefreshCw size={16} />Retry connection</button>;
  const endActions = <>
          {busy && <button className="button button-danger button-wide confirm-button" onClick={stopConnection}>Stop and reconnect</button>}
          {(["selected", "failed", "complete"].includes(phase)) && <button className="button button-secondary button-wide confirm-button" onClick={reset}><RefreshCw size={16} />New transfer</button>}
  </>;
  const progressCard = hasTransferProgress && progress && (
    <div className="transfer-progress-card"><div className="selection-header"><strong>{phase === "failed" ? "Transfer stopped" : phase === "complete" ? "Transfer verified" : phase === "verifying" ? "Receiver is verifying" : paused ? "Transfer paused" : "Sending directly"}</strong><span>{percentage.toFixed(1)}%</span></div>{phase === "transferring" && <button className="button button-secondary button-wide" onClick={() => { const next = !paused; setPaused(next); senderRef.current?.setPaused(next); }}>{paused ? <Play size={16} /> : <Pause size={16} />}{paused ? "Resume" : "Pause"}</button>}<div className="progress-track"><div className="progress-fill" style={{ width: `${percentage}%` }} /></div><TransferMetrics progress={progress} rate={rate} currentRate={currentRate} elapsed={elapsed} direction="send" interrupted={phase === "failed"} /></div>
  );

  return (
    <section className="workspace network-workspace" onDragOver={(event) => {
      event.preventDefault(); event.dataTransfer.dropEffect = phaseRef.current === "idle" && readiness.ready ? "copy" : "none";
    }} onDrop={(event) => {
      event.preventDefault();
      if (phaseRef.current !== "idle" || !readiness.ready) return;
      void pickSource("drop", captureDroppedItems(event.dataTransfer.items));
    }}>
      <div className="page-heading">
        <h1>Send files to another laptop.</h1>
        <p>Choose files or a folder, then share the six-digit pairing code with the other laptop.</p>
      </div>
      <div className="transfer-card sender-layout">
        <div className="panel">
          <div className="panel-kicker"><FolderOpen size={15} /> Source</div>
          <h2>{hasTransferProgress ? "Source files" : "Select files"}</h2>
          <p className="panel-description">{hasTransferProgress ? "Keep these files unchanged until the receiver finishes saving." : "Choose your files below. You’ll compare a code on both laptops before any files are sent."}</p>
          {phase === "idle" && <PairingReadiness readiness={readiness} />}
          {resumeNotice && <p aria-live="polite">{resumeNotice}</p>}
          {!selection && savedSource && (phase === "idle" || phase === "failed") && <div className="selection-card"><strong>Saved source: {savedSource.manifest.rootName}</strong><p>Reopen and check these files before pairing again. Keep the source files unchanged.</p><button className="button button-primary" onClick={() => void restoreSource()} disabled={!readiness.ready}>{phase === "failed" ? "Retry source recovery" : "Recover saved source"}</button><button className="button button-secondary" onClick={() => void discardSavedSource()}>Discard saved source</button></div>}
          {!selection ? (
            <div className="drop-zone"><div className="drop-zone-content"><span className="upload-icon"><FolderOpen /></span><p>Drop files or folders here, or choose them below.</p><div className="source-picker-actions"><button className="button button-primary" onClick={() => void pickSource("files")} disabled={phase !== "idle" || !readiness.ready || !window.showOpenFilePicker}>Choose files</button><button className="button button-secondary" onClick={() => void pickSource("folder")} disabled={phase !== "idle" || !readiness.ready || !window.showDirectoryPicker}>{phase === "scanning" ? "Scanning…" : "Choose folder"}</button></div></div></div>
          ) : (
            <div className="selection-card">
              <div className="folder-identity"><span className="folder-icon"><FolderOpen /></span><div><strong>{selection.rootName}</strong><span>{selection.files.length} files · {formatBytes(Number(selection.totalFileBytes))}</span></div></div>
              <div className="metric-grid"><div className="metric"><span>Files</span><strong>{selection.files.length}</strong></div><div className="metric"><span>Folders</span><strong>{selection.directories.length}</strong></div><div className="metric"><span>Size</span><strong>{formatBytes(Number(selection.totalFileBytes))}</strong></div></div>
              {phase === "selected" && <div className="sender-actions"><button className="button button-primary button-wide" onClick={prepare}><Wifi size={16} />{sourceRef.current || preparationRef.current ? "Retry connection" : "Get pairing code"}</button></div>}
            </div>
          )}
          {(sourcePreparing || phase === "scanning" || phase === "preparing" || phase === "checking") && <div className="status-box compact-status"><span className="spinner" /><span>{phase === "checking" ? "Checking the local connection service…" : hashProgress?.path ? `${hashProgress.phase === "hash" ? "Checking files" : "Scanning"}: ${hashProgress.path}` : "Preparing your files…"}{sourcePreparing && <span> You can pair now. Files will wait until checking and device confirmation finish.</span>}</span></div>}
          {pairingCode && (phase === "pairing" || phase === "verify-device") && (
            <div className="authentication-card"><ShieldCheck size={22} /><div><span>Receiver pairing code</span><strong>{formatPairingCode(pairingCode)}</strong><small>Enter this code on the receiving device. It expires automatically.</small></div></div>
          )}
          {phase === "pairing" && <details><summary>Troubleshoot connection</summary><p>If automatic discovery fails, enter one of these addresses on the receiver along with the pairing code.</p>{pairingAddresses.length ? <ul>{pairingAddresses.map((address) => <li key={address}><code>{address}</code></li>)}</ul> : <p>No local IPv4 address is available. Connect this laptop to the same network as the receiver.</p>}</details>}
          {phase === "pairing" && <div className="status-box compact-status"><span className="spinner" />Waiting for the receiver to enter the pairing code…</div>}
          {peerRef.current && <ConnectionDiagnostics peer={peerRef.current} />}
          {phase === "verify-device" && verificationCode && <VerifyDevice code={verificationCode} connected={connected && !connectionInterrupted} confirmed={localConfirmed} onConfirm={confirmPairing} onReject={() => fail(new Error("Device codes did not match. No files were sent. Reconnect and verify the intended laptop."))} />}
          {phase === "waiting" && <div className="status-box success compact-status"><Link2 size={16} />Connected. The receiver is checking for an earlier transfer to resume.</div>}

          {!hasTransferProgress && <>{problemNotice}{retryAction}{endActions}</>}
        </div>
        <div className={hasTransferProgress ? "panel transfer-status-panel" : "panel qr-stage"}>
          {hasTransferProgress ? <>
            <p className="transfer-connection-status" role="status">{phase === "failed" ? "Connection stopped" : phase === "complete" ? "Connection finished" : connectionInterrupted ? "Connection interrupted" : "Devices connected"}</p>
            {problemNotice}
            {retryAction}
            {progressCard}
          {phase === "complete" && <div className="status-box success compact-status"><CheckCircle2 size={17} />The receiver checked every transferred byte. Save the files on the receiving laptop to finish.</div>}
            {endActions}
          </> : <div className="qr-placeholder"><div className="qr-placeholder-inner">{phase === "complete" ? <CheckCircle2 size={48} /> : <Link2 size={48} />}<strong className={phase === "pairing" && pairingCode ? "pairing-code-large" : undefined}>{phase === "pairing" && pairingCode ? formatPairingCode(pairingCode) : phase === "idle" || phase === "selected" ? "Pairing code appears here" : phase === "complete" ? "Sent and verified" : phase === "failed" ? "Connection stopped" : connectionInterrupted ? "Connection interrupted" : connected ? "Devices connected" : "Local connection in progress"}</strong><span>{phase === "pairing" ? "Enter this six-digit code on the receiving laptop." : "Your files travel over an encrypted connection between the laptops."}</span></div></div>}
        </div>
      </div>
    </section>
  );
}
