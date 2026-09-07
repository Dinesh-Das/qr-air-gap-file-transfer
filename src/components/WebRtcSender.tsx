import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
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
import { formatBytes, formatRate } from "../lib/format";
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
  createAuthenticationCode,
  createOfflineSessionId,
  encodeOfflineSignal,
  limitSdpToLocalCandidates,
  waitForIceGatheringComplete,
  type OfflineSignalBundle,
} from "../lib/webrtc-signaling";
import { WebRtcSignalDisplay, WebRtcSignalScanner } from "./WebRtcSignalQr";

type Phase =
  | "idle"
  | "scanning"
  | "selected"
  | "preparing"
  | "offer"
  | "answer"
  | "confirming"
  | "waiting"
  | "transferring"
  | "verifying"
  | "complete"
  | "failed";

export function WebRtcSender({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [selection, setSelection] = useState<LargeSourceSelection | null>(null);
  const [hashProgress, setHashProgress] = useState<LargeTransferProgress | null>(null);
  const [frames, setFrames] = useState<string[]>([]);
  const [authCode, setAuthCode] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [localConfirmed, setLocalConfirmed] = useState(false);
  const [remoteConfirmed, setRemoteConfirmed] = useState(false);
  const [progress, setProgress] = useState<OfflineTransferProgress | null>(null);
  const [paused, setPaused] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const sourceRef = useRef<PreparedLargeSource | null>(null);
  const manifestRef = useRef<OfflineTransferManifest | null>(null);
  const senderRef = useRef<OfflineSourceSender | null>(null);
  const sessionIdRef = useRef("");
  const offerSdpRef = useRef("");
  const localConfirmedRef = useRef(false);
  const remoteConfirmedRef = useRef(false);
  const authorizedRef = useRef(false);
  const sendingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const taskAbortRef = useRef<AbortController | null>(null);
  const peerHealthCleanupRef = useRef<(() => void) | null>(null);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const closeConnection = useCallback((reason?: Error) => {
    lifecycleRef.current += 1;
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

  useEffect(() => closeConnection, [closeConnection]);

  const fail = useCallback((caught: unknown) => {
    if (caught instanceof DOMException && caught.name === "AbortError") return;
    const error = caught instanceof Error ? caught : new Error(String(caught));
    setError(error.message);
    setPhase("failed");
    const channel = channelRef.current;
    if (channel?.readyState === "open") {
      try {
        channel.send(encodeOfflineControl({ type: "error", message: error.message.slice(0, 2_000) }));
      } catch {
        // The terminal close below is authoritative.
      }
    }
    closeConnection(error);
  }, [closeConnection]);

  const watchPeerHealth = useCallback((peer: RTCPeerConnection, generation: number) => {
    let deadline: number | undefined;
    const clearDeadline = () => {
      if (deadline !== undefined) clearTimeout(deadline);
      deadline = undefined;
    };
    const onChange = () => {
      if (generation !== lifecycleRef.current) {
        clearDeadline();
        return;
      }
      if (peer.connectionState === "failed") {
        clearDeadline();
        fail(new Error("The browsers could not establish a direct local connection. Check the Wi-Fi and firewall, then retry."));
        return;
      }
      if (peer.connectionState === "connected") {
        clearDeadline();
        return;
      }
      if ((peer.connectionState === "connecting" || peer.connectionState === "disconnected") && deadline === undefined) {
        const expectedState = peer.connectionState;
        deadline = window.setTimeout(() => {
          deadline = undefined;
          if (generation === lifecycleRef.current && peer.connectionState === expectedState) {
            fail(new Error("The direct local connection timed out. Check that both devices are on the same non-isolated network."));
          }
        }, expectedState === "disconnected" ? 15_000 : 30_000);
      }
    };
    peer.addEventListener("connectionstatechange", onChange);
    onChange();
    peerHealthCleanupRef.current = () => {
      clearDeadline();
      peer.removeEventListener("connectionstatechange", onChange);
    };
  }, [fail]);

  const busy = !["idle", "selected", "complete", "failed"].includes(phase);
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
      !localConfirmedRef.current ||
      !remoteConfirmedRef.current ||
      channel?.readyState !== "open" ||
      !source ||
      !manifest
    ) return;
    const maxMessageSize = peerRef.current?.sctp?.maxMessageSize;
    if (
      maxMessageSize !== undefined &&
      maxMessageSize !== 0 &&
      maxMessageSize < manifest.blockSize + OFFLINE_DATA_HEADER_BYTES
    ) {
      fail(new Error(
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

  const beginSending = useCallback(() => {
    const sender = senderRef.current;
    if (!sender || sendingRef.current) return;
    sendingRef.current = true;
    const controller = new AbortController();
    taskAbortRef.current = controller;
    setStartedAt(Date.now());
    setPhase("transferring");
    void sender.run(controller.signal, setProgress)
      .then(() => setPhase("verifying"))
      .catch(fail);
  }, [fail]);

  const installChannel = useCallback((channel: RTCDataChannel, generation: number) => {
    channel.binaryType = "arraybuffer";
    channelRef.current = channel;
    channel.addEventListener("open", () => {
      if (generation !== lifecycleRef.current) return;
      setConnected(true);
      maybeAuthorize();
    });
    channel.addEventListener("close", () => {
      if (generation !== lifecycleRef.current || phaseRef.current === "complete") return;
      setConnected(false);
      if (["waiting", "transferring", "verifying"].includes(phaseRef.current)) {
        fail(new Error("The local connection closed. Reconnect to resume safely."));
      }
    });
    channel.addEventListener("message", (event) => {
      if (generation !== lifecycleRef.current || typeof event.data !== "string") return;
      try {
        const message = decodeOfflineControl(event.data);
        switch (message.type) {
          case "peer-confirmed":
            remoteConfirmedRef.current = true;
            setRemoteConfirmed(true);
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
            setConnected(false);
            break;
          case "cancel":
            throw new Error(message.reason ?? "The receiver cancelled the transfer.");
          case "error":
            throw new Error(message.message);
          default:
            break;
        }
      } catch (caught) {
        senderRef.current?.fail(caught instanceof Error ? caught : new Error(String(caught)));
        fail(caught);
      }
    });
  }, [beginSending, fail, maybeAuthorize]);

  const pickFolder = useCallback(async () => {
    if (!window.showDirectoryPicker) {
      fail(new Error("Offline network transfer requires a Chromium browser with the directory picker."));
      return;
    }
    closeConnection();
    const generation = lifecycleRef.current;
    setError(null);
    setPhase("scanning");
    try {
      const handle = await window.showDirectoryPicker({ id: "airgap-webrtc-source", mode: "read" });
      const next = await collectLargeDirectory(handle, setHashProgress);
      if (generation !== lifecycleRef.current) return;
      setSelection(next);
      setHashProgress(null);
      setPhase("selected");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      fail(caught);
    }
  }, [closeConnection, fail]);

  const prepare = useCallback(async () => {
    if (!selection) return;
    closeConnection();
    const generation = lifecycleRef.current;
    const controller = new AbortController();
    taskAbortRef.current = controller;
    setError(null);
    setPhase("preparing");
    try {
      const source = await prepareLargeSource(selection, setHashProgress, controller.signal);
      const manifest = await createOfflineTransferManifest(source);
      if (generation !== lifecycleRef.current) return;
      sourceRef.current = source;
      manifestRef.current = manifest;
      const sessionId = createOfflineSessionId();
      sessionIdRef.current = sessionId;
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
      offerSdpRef.current = sdp;
      setFrames(encodeOfflineSignal({ v: 1, kind: "offer", sessionId, sdp }));
      setHashProgress(null);
      setPhase("offer");
    } catch (caught) {
      fail(caught);
    }
  }, [closeConnection, fail, installChannel, selection, watchPeerHealth]);

  const acceptAnswer = useCallback(async (bundle: OfflineSignalBundle) => {
    try {
      if (bundle.sessionId !== sessionIdRef.current) throw new Error("This answer belongs to another connection offer.");
      const peer = peerRef.current;
      if (!peer) throw new Error("The local connection is no longer available.");
      await peer.setRemoteDescription({ type: "answer", sdp: bundle.sdp });
      const code = await createAuthenticationCode(bundle.sessionId, offerSdpRef.current, bundle.sdp);
      setAuthCode(code);
      setPhase("confirming");
    } catch (caught) {
      fail(caught);
    }
  }, [fail]);

  const confirmPeer = useCallback(() => {
    const channel = channelRef.current;
    if (channel?.readyState !== "open") return;
    localConfirmedRef.current = true;
    setLocalConfirmed(true);
    channel.send(encodeOfflineControl({ type: "peer-confirmed" }));
    maybeAuthorize();
  }, [maybeAuthorize]);

  const reset = useCallback(() => {
    closeConnection();
    sourceRef.current = null;
    manifestRef.current = null;
    localConfirmedRef.current = false;
    remoteConfirmedRef.current = false;
    authorizedRef.current = false;
    sendingRef.current = false;
    setSelection(null);
    setFrames([]);
    setAuthCode(null);
    setConnected(false);
    setLocalConfirmed(false);
    setRemoteConfirmed(false);
    setProgress(null);
    setPaused(false);
    setError(null);
    setPhase("idle");
  }, [closeConnection]);

  const percentage = progress ? (progress.completedBytes / progress.totalBytes) * 100 : 0;
  const elapsed = startedAt > 0 ? Math.max(0.001, (Date.now() - startedAt) / 1000) : 0;
  const rate = progress && elapsed ? Math.max(0, progress.completedBytes - progress.resumedBytes) / elapsed : 0;

  return (
    <section className="workspace">
      <div className="page-heading">
        <span className="eyebrow">Offline network sender</span>
        <h1>Send at local Wi-Fi speed.</h1>
        <p>Select a folder, exchange the connection QR, verify the same six-digit code on both screens, then transfer directly between browsers.</p>
      </div>
      <div className="notice-strip policy-warning"><AlertTriangle size={18} /><span>This is a local-network transfer, not an air gap. Use it only when both devices and the files are authorized on the same offline Wi-Fi or hotspot.</span></div>
      <div className="transfer-card sender-layout">
        <div className="panel">
          <div className="panel-kicker"><FolderOpen size={15} /> Source</div>
          <h2>Folder and connection</h2>
          <p className="panel-description">Nothing is uploaded. The complete stream is hashed before a connection offer is created.</p>
          {!selection ? (
            <div className="drop-zone"><div className="drop-zone-content"><span className="upload-icon"><FolderOpen /></span><h3>Choose a folder</h3><p>Files stay on this device until the peer is verified.</p><button className="button button-primary" onClick={pickFolder} disabled={phase === "scanning"}>{phase === "scanning" ? "Scanning…" : "Choose folder"}</button></div></div>
          ) : (
            <div className="selection-card">
              <div className="folder-identity"><span className="folder-icon"><FolderOpen /></span><div><strong>{selection.rootName}</strong><span>{selection.files.length} files · {formatBytes(Number(selection.totalFileBytes))}</span></div></div>
              <div className="metric-grid"><div className="metric"><span>Files</span><strong>{selection.files.length}</strong></div><div className="metric"><span>Folders</span><strong>{selection.directories.length}</strong></div><div className="metric"><span>Size</span><strong>{formatBytes(Number(selection.totalFileBytes))}</strong></div></div>
              {phase === "selected" && <div className="sender-actions"><button className="button button-primary button-wide" onClick={prepare}><Wifi size={16} />Prepare offline transfer</button></div>}
            </div>
          )}
          {(phase === "scanning" || phase === "preparing") && <div className="status-box compact-status"><span className="spinner" />{hashProgress?.path ? `${hashProgress.phase === "hash" ? "Hashing" : "Scanning"}: ${hashProgress.path}` : "Preparing the deterministic transfer stream…"}</div>}
          {authCode && (
            <div className="authentication-card"><ShieldCheck size={22} /><div><span>Compare on both devices</span><strong>{authCode.slice(0, 3)} {authCode.slice(3)}</strong><small>Confirm only if every digit matches.</small></div></div>
          )}
          {phase === "confirming" && remoteConfirmed && !localConfirmed && <div className="status-box success compact-status"><ShieldCheck size={16} />The receiver confirmed this connection. Compare the code before confirming here.</div>}
          {phase === "confirming" && <button className="button button-primary button-wide confirm-button" onClick={confirmPeer} disabled={!connected || localConfirmed}><ShieldCheck size={16} />{!connected ? "Waiting for local connection…" : localConfirmed ? "Confirmed — waiting for receiver" : "Codes match — trust this receiver"}</button>}
          {phase === "waiting" && <div className="status-box success compact-status"><Link2 size={16} />Peer verified. Receiver is opening durable storage and reporting resumable blocks.</div>}
          {(phase === "transferring" || phase === "verifying" || phase === "complete") && progress && (
            <div className="transfer-progress-card"><div className="selection-header"><strong>{phase === "complete" ? "Transfer verified" : phase === "verifying" ? "Receiver is verifying" : paused ? "Transfer paused" : "Sending directly"}</strong><span>{percentage.toFixed(1)}%</span></div><div className="progress-track"><div className="progress-fill" style={{ width: `${percentage}%` }} /></div><div className="metric-grid"><div className="metric"><span>Sent safely</span><strong>{formatBytes(progress.completedBytes)}</strong></div><div className="metric"><span>Speed</span><strong>{formatRate(rate)}</strong></div><div className="metric"><span>Resumed</span><strong>{formatBytes(progress.resumedBytes)}</strong></div></div>{phase === "transferring" && <button className="button button-secondary button-wide" onClick={() => { const next = !paused; setPaused(next); senderRef.current?.setPaused(next); }}>{paused ? <Play size={16} /> : <Pause size={16} />}{paused ? "Resume" : "Pause"}</button>}</div>
          )}
          {phase === "complete" && <div className="status-box success compact-status"><CheckCircle2 size={17} />The receiver verified the whole stream with SHA-256.</div>}
          {error && <div className="status-box error compact-status"><AlertTriangle size={17} />{error}</div>}
          {busy && <button className="button button-danger button-wide confirm-button" onClick={reset}>Stop and start over</button>}
          {(phase === "failed" || phase === "complete") && <button className="button button-secondary button-wide confirm-button" onClick={reset}><RefreshCw size={16} />New transfer</button>}
        </div>
        <div className="panel qr-stage">
          {phase === "offer" && <><WebRtcSignalDisplay frames={frames} label="WebRTC connection offer" /><button className="button button-primary button-wide signal-action" onClick={() => setPhase("answer")}>Scan receiver answer</button></>}
          {phase === "answer" && <WebRtcSignalScanner expected="answer" onComplete={acceptAnswer} onError={setError} />}
          {phase !== "offer" && phase !== "answer" && <div className="qr-placeholder"><div className="qr-placeholder-inner">{phase === "complete" ? <CheckCircle2 size={48} /> : <Link2 size={48} />}<strong>{phase === "idle" || phase === "selected" ? "Handshake appears here" : phase === "confirming" ? "Compare the device code" : phase === "complete" ? "Direct transfer complete" : "Local connection in progress"}</strong><span>QR carries connection details only. File bytes travel through encrypted WebRTC.</span></div></div>}
        </div>
      </div>
    </section>
  );
}

function toMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
