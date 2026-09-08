import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FolderCheck,
  Link2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { formatBytes, formatRate } from "../lib/format";
import { readLargeTreeManifest, type LargeTreeManifest, type RandomAccessReader } from "../lib/large-transfer";
import { writeLargeTreeToDirectory, type LargeDestinationProgress, type LargeDestinationReport } from "../lib/large-destination";
import {
  OFFLINE_MAX_RESUME_RANGES,
  decodeOfflineControl,
  encodeOfflineControl,
  hexToBytes,
  type OfflineTransferManifest,
} from "../lib/webrtc-protocol";
import { OfflineDestinationReceiver, type OfflineTransferProgress } from "../lib/webrtc-transfer";
import { supportsDurableBlockStore } from "../lib/block-store";
import {
  limitSdpToLocalCandidates,
  waitForIceGatheringComplete,
} from "../lib/webrtc-signaling";
import {
  isValidPairingCode,
  joinRendezvousRoom,
  normalizePairingCode,
  publishRendezvousAnswer,
} from "../lib/webrtc-rendezvous";

type Phase = "pairing" | "preparing" | "waiting" | "receiving" | "verifying" | "complete" | "saving" | "saved" | "failed";

export function WebRtcReceiver({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const [capabilityError] = useState(() => offlineReceiverCapabilityError());
  const [phase, setPhase] = useState<Phase>(() => capabilityError ? "failed" : "pairing");
  const [pairingCode, setPairingCode] = useState("");
  const [connected, setConnected] = useState(false);
  const [manifest, setManifest] = useState<OfflineTransferManifest | null>(null);
  const [progress, setProgress] = useState<OfflineTransferProgress | null>(null);
  const [verifyBytes, setVerifyBytes] = useState(0);
  const [tree, setTree] = useState<LargeTreeManifest | null>(null);
  const [destinationProgress, setDestinationProgress] = useState<LargeDestinationProgress | null>(null);
  const [report, setReport] = useState<LargeDestinationReport | null>(null);
  const [cacheReclaimed, setCacheReclaimed] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [error, setError] = useState<string | null>(capabilityError);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const receiverRef = useRef<OfflineDestinationReceiver | null>(null);
  const readerRef = useRef<RandomAccessReader | null>(null);
  const manifestRef = useRef<OfflineTransferManifest | null>(null);
  const localConfirmedRef = useRef(false);
  const remoteConfirmedRef = useRef(false);
  const authorizedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const taskAbortRef = useRef<AbortController | null>(null);
  const destinationTaskRef = useRef<Promise<void>>(Promise.resolve());
  const peerHealthCleanupRef = useRef<(() => void) | null>(null);
  const verificationStartedRef = useRef(false);
  const lastProgressAtRef = useRef(0);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const terminateConnection = useCallback((reason?: Error) => {
    lifecycleRef.current += 1;
    taskAbortRef.current?.abort(reason ?? new DOMException("Stopped", "AbortError"));
    taskAbortRef.current = null;
    peerHealthCleanupRef.current?.();
    peerHealthCleanupRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
  }, []);

  const closeConnection = useCallback(async (reason?: Error) => {
    terminateConnection(reason);
    await Promise.allSettled([queueRef.current, destinationTaskRef.current]);
    await receiverRef.current?.store.close().catch(() => undefined);
    receiverRef.current = null;
  }, [terminateConnection]);

  useEffect(() => () => { void closeConnection(); }, [closeConnection]);

  const fail = useCallback((caught: unknown) => {
    if (caught instanceof DOMException && caught.name === "AbortError") return;
    const message = toMessage(caught);
    setError(message);
    setPhase("failed");
    const channel = channelRef.current;
    if (channel?.readyState === "open") {
      try {
        channel.send(encodeOfflineControl({ type: "error", message: message.slice(0, 2_000) }));
      } catch {
        // The terminal close below is authoritative.
      }
    }
    const receiver = receiverRef.current;
    terminateConnection(caught instanceof Error ? caught : new Error(message));
    if (receiver) {
      void queueRef.current.finally(async () => {
        await receiver.store.close().catch(() => undefined);
        if (receiverRef.current === receiver) receiverRef.current = null;
      });
    }
  }, [terminateConnection]);

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

  const busy = !["pairing", "complete", "saved", "failed"].includes(phase);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const acceptManifest = useCallback(async (nextManifest: OfflineTransferManifest, generation: number) => {
    if (!authorizedRef.current) throw new Error("A manifest arrived before both peers confirmed the device code.");
    if (receiverRef.current) throw new Error("A second transfer manifest was received.");
    const receiver = await OfflineDestinationReceiver.open(nextManifest);
    if (generation !== lifecycleRef.current) {
      await receiver.store.close();
      return;
    }
    receiverRef.current = receiver;
    manifestRef.current = nextManifest;
    setManifest(nextManifest);
    const resumedBytes = receiver.store.progress().receivedBytes;
    setProgress(receiver.progress(resumedBytes));
    const ranges = receiver.resumeRanges();
    const channel = channelRef.current;
    if (channel?.readyState !== "open") throw new Error("The local connection closed.");
    for (let index = 0; index < ranges.length; index += OFFLINE_MAX_RESUME_RANGES) {
      channel.send(encodeOfflineControl({ type: "resume-ranges", ranges: ranges.slice(index, index + OFFLINE_MAX_RESUME_RANGES) }));
    }
    channel.send(encodeOfflineControl({ type: "resume-complete" }));
    setStartedAt(Date.now());
    setPhase("waiting");
  }, []);

  const acceptData = useCallback(async (value: ArrayBuffer, generation: number) => {
    const receiver = receiverRef.current;
    const channel = channelRef.current;
    if (!receiver || !authorizedRef.current) throw new Error("File data arrived before the transfer was authorized.");
    if (verificationStartedRef.current) throw new Error("File data arrived after the sender's completion marker.");
    const index = await receiver.acceptData(value);
    if (generation !== lifecycleRef.current) return;
    const now = Date.now();
    const complete = receiver.store.progress().complete;
    if (complete || now - lastProgressAtRef.current >= 100) {
      lastProgressAtRef.current = now;
      setProgress((current) => receiver.progress(current?.resumedBytes ?? 0));
    }
    setPhase("receiving");
    if (channel?.readyState !== "open") throw new Error("The local connection closed before acknowledging durable data.");
    channel.send(encodeOfflineControl({ type: "ack", indices: [index] }));
  }, []);

  const verifyTransfer = useCallback(async (generation: number) => {
    const receiver = receiverRef.current;
    const channel = channelRef.current;
    if (!receiver) throw new Error("No received transfer is available to verify.");
    if (verificationStartedRef.current) return;
    verificationStartedRef.current = true;
    const controller = new AbortController();
    taskAbortRef.current = controller;
    setPhase("verifying");
    const reader = await receiver.verify(controller.signal, (completed) => setVerifyBytes(completed));
    const parsedTree = await readLargeTreeManifest(reader);
    if (generation !== lifecycleRef.current) return;
    readerRef.current = reader;
    setTree(parsedTree);
    setProgress((current) => current ? { ...current, completedBytes: current.totalBytes, completedBlocks: current.totalBlocks } : current);
    channel?.send(encodeOfflineControl({ type: "receiver-complete" }));
    phaseRef.current = "complete";
    setPhase("complete");
    peerHealthCleanupRef.current?.();
    peerHealthCleanupRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    setConnected(false);
  }, []);

  const confirmPairing = useCallback(() => {
    const channel = channelRef.current;
    if (localConfirmedRef.current || channel?.readyState !== "open") return;
    localConfirmedRef.current = true;
    authorizedRef.current = remoteConfirmedRef.current;
    channel.send(encodeOfflineControl({ type: "peer-confirmed" }));
    setPhase("waiting");
  }, []);

  const installChannel = useCallback((channel: RTCDataChannel, generation: number) => {
    channel.binaryType = "arraybuffer";
    channelRef.current = channel;
    channel.addEventListener("open", () => {
      if (generation !== lifecycleRef.current) return;
      setConnected(true);
      confirmPairing();
    });
    channel.addEventListener("close", () => {
      if (generation !== lifecycleRef.current) return;
      setConnected(false);
      if (["waiting", "receiving", "verifying"].includes(phaseRef.current)) {
        fail(new Error("The local connection closed. Reconnect and resend the same folder to resume."));
      }
    });
    channel.addEventListener("message", (event) => {
      if (generation !== lifecycleRef.current) return;
      queueRef.current = queueRef.current.then(async () => {
        if (generation !== lifecycleRef.current) return;
        if (typeof event.data !== "string") {
          if (!(event.data instanceof ArrayBuffer)) throw new Error("Unexpected WebRTC data message.");
          await acceptData(event.data, generation);
          return;
        }
        const message = decodeOfflineControl(event.data);
        switch (message.type) {
          case "peer-confirmed":
            remoteConfirmedRef.current = true;
            authorizedRef.current = localConfirmedRef.current;
            break;
          case "manifest":
            await acceptManifest(message.manifest, generation);
            break;
          case "sender-complete":
            await verifyTransfer(generation);
            break;
          case "cancel":
            throw new Error(message.reason ?? "The sender cancelled the transfer.");
          case "error":
            throw new Error(message.message);
          default:
            break;
        }
      }).catch(fail);
    });
  }, [acceptData, acceptManifest, confirmPairing, fail, verifyTransfer]);

  const connect = useCallback(async () => {
    if (!isValidPairingCode(pairingCode)) {
      setError("Enter the six-digit pairing code shown on the sender.");
      return;
    }
    const generation = lifecycleRef.current;
    const controller = new AbortController();
    taskAbortRef.current = controller;
    setError(null);
    setPhase("preparing");
    try {
      const join = await joinRendezvousRoom(pairingCode, controller.signal);
      const bundle = join.bundle;
      if (generation !== lifecycleRef.current) return;
      const peer = new RTCPeerConnection({ iceServers: [] });
      peerRef.current = peer;
      watchPeerHealth(peer, generation);
      peer.addEventListener("datachannel", (event) => installChannel(event.channel, generation), { once: true });
      await peer.setRemoteDescription({ type: "offer", sdp: bundle.sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await waitForIceGatheringComplete(peer, controller.signal);
      const rawSdp = peer.localDescription?.sdp;
      if (!rawSdp) throw new Error("The browser did not create a local connection answer.");
      const sdp = limitSdpToLocalCandidates(rawSdp);
      await publishRendezvousAnswer(join.joinId, { v: 1, kind: "answer", sessionId: bundle.sessionId, sdp }, controller.signal);
      if (generation !== lifecycleRef.current) return;
      confirmPairing();
    } catch (caught) {
      fail(caught);
    }
  }, [confirmPairing, fail, installChannel, pairingCode, watchPeerHealth]);

  const save = useCallback(() => {
    const task = (async () => {
    const nextTree = tree;
    const reader = readerRef.current;
    const nextManifest = manifestRef.current;
    const receiver = receiverRef.current;
    if (!nextTree || !reader || !nextManifest || !receiver || !window.showDirectoryPicker) {
      fail(new Error("This browser cannot choose a destination folder."));
      return;
    }
    setError(null);
    setPhase("saving");
    const controller = new AbortController();
    taskAbortRef.current = controller;
    try {
      const destination = await window.showDirectoryPicker({ id: "airgap-webrtc-destination", mode: "readwrite" });
      const result = await writeLargeTreeToDirectory(
        nextTree,
        reader,
        { transferId: shortHexToBytes(nextManifest.transferId), streamSha256: hexToBytes(nextManifest.streamSha256) },
        destination,
        { signal: controller.signal, onProgress: setDestinationProgress },
      );
      let reclaimed = false;
      try {
        await receiver.store.delete();
        receiverRef.current = null;
        readerRef.current = null;
        reclaimed = true;
      } catch (cleanupError) {
        setError(
          `Files are saved and verified, but temporary browser storage could not be reclaimed: ${toMessage(cleanupError)}`,
        );
      }
      setCacheReclaimed(reclaimed);
      setReport(result);
      setPhase("saved");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setPhase("complete");
        return;
      }
      fail(caught);
    }
    })();
    destinationTaskRef.current = task;
    return task;
  }, [fail, tree]);

  const reset = useCallback(async () => {
    await closeConnection();
    queueRef.current = Promise.resolve();
    manifestRef.current = null;
    readerRef.current = null;
    localConfirmedRef.current = false;
    remoteConfirmedRef.current = false;
    authorizedRef.current = false;
    verificationStartedRef.current = false;
    const nextCapabilityError = offlineReceiverCapabilityError();
    setPhase(nextCapabilityError ? "failed" : "pairing");
    setPairingCode("");
    setConnected(false);
    setManifest(null);
    setProgress(null);
    setVerifyBytes(0);
    setTree(null);
    setDestinationProgress(null);
    setReport(null);
    setCacheReclaimed(false);
    lastProgressAtRef.current = 0;
    setError(nextCapabilityError);
  }, [closeConnection]);

  const cleanupCache = useCallback(async () => {
    const receiver = receiverRef.current;
    if (!receiver) return;
    setError(null);
    try {
      await receiver.store.delete();
      if (receiverRef.current === receiver) receiverRef.current = null;
      readerRef.current = null;
      setCacheReclaimed(true);
    } catch (caught) {
      setError(`Temporary browser storage could not be reclaimed: ${toMessage(caught)}`);
    }
  }, []);

  const percentage = progress ? (progress.completedBytes / progress.totalBytes) * 100 : 0;
  const elapsed = startedAt ? Math.max(0.001, (Date.now() - startedAt) / 1000) : 0;
  const rate = progress && elapsed ? Math.max(0, progress.completedBytes - progress.resumedBytes) / elapsed : 0;

  return (
    <section className="workspace">
      <div className="page-heading"><span className="eyebrow">Offline network receiver</span><h1>Receive directly to durable storage.</h1><p>Enter the six-digit code shown on the sender, connect, and keep this tab open while blocks arrive.</p></div>
      <div className="notice-strip policy-warning"><AlertTriangle size={18} /><span>Both devices must already be on the same authorized offline Wi-Fi or hotspot. This mode does not bypass company controls or create an air gap.</span></div>
      <div className="transfer-card receiver-layout">
        <div className="panel">
          {phase === "pairing" ? <div className="pairing-entry"><span className="pairing-icon"><Link2 size={28} /></span><h2>Enter pairing code</h2><p>Use the six digits shown on the sending device.</p><input className="pairing-input" value={pairingCode} onChange={(event) => setPairingCode(normalizePairingCode(event.target.value))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" aria-label="Six-digit pairing code" /><button className="button button-primary button-wide" onClick={() => void connect()} disabled={!isValidPairingCode(pairingCode)}><Link2 size={16} />Connect to sender</button></div> : phase === "preparing" ? <div className="qr-placeholder"><div className="qr-placeholder-inner"><span className="spinner dark-spinner" /><strong>Finding sender and creating connection</strong><span>The local runtimes are exchanging WebRTC connection details over this LAN.</span></div></div> : <div className="qr-placeholder"><div className="qr-placeholder-inner">{phase === "saved" ? <FolderCheck size={48} /> : <Database size={48} />}<strong>{phase === "saved" ? "Files reconstructed" : connected ? "Devices connected" : "Pairing complete"}</strong><span>File bytes are written to private browser storage before acknowledgement.</span></div></div>}
        </div>
        <div className="panel receiver-status">
          <div className="panel-kicker"><Database size={15} /> Destination</div><h2>Verified receive</h2><p className="panel-description">Received blocks survive interruption. Reconnect and resend the same folder to resume automatically.</p>
          {phase === "preparing" && <div className="status-box compact-status"><span className="spinner" />Discovering the sender for code {pairingCode}…</div>}
          {phase === "waiting" && !manifest && <div className="status-box success compact-status"><ShieldCheck size={16} />Peer verified. Waiting for the folder manifest.</div>}
          {progress && (phase === "waiting" || phase === "receiving" || phase === "verifying" || phase === "complete") && <div className="transfer-progress-card"><div className="selection-header"><strong>{phase === "verifying" ? "Verifying whole stream" : phase === "complete" ? "Ready to save" : "Receiving to disk"}</strong><span>{phase === "verifying" && manifest ? `${((verifyBytes / manifest.totalBytes) * 100).toFixed(1)}%` : `${percentage.toFixed(1)}%`}</span></div><div className="progress-track"><div className="progress-fill" style={{ width: `${phase === "verifying" && manifest ? (verifyBytes / manifest.totalBytes) * 100 : percentage}%` }} /></div><div className="metric-grid"><div className="metric"><span>Durable</span><strong>{formatBytes(progress.completedBytes)}</strong></div><div className="metric"><span>Speed</span><strong>{formatRate(rate)}</strong></div><div className="metric"><span>Resumed</span><strong>{formatBytes(progress.resumedBytes)}</strong></div></div></div>}
          {phase === "complete" && tree && <><div className="status-box success compact-status"><CheckCircle2 size={17} />SHA-256 and folder metadata verified. Choose a parent folder to reconstruct “{tree.rootName}”.</div><button className="button button-primary button-wide confirm-button" onClick={save}><FolderCheck size={16} />Choose destination and save</button></>}
          {phase === "saving" && <div className="status-box compact-status"><span className="spinner" />{destinationProgress?.path ? `${destinationProgress.phase}: ${destinationProgress.path}` : "Reconstructing and verifying destination files…"}</div>}
          {phase === "saved" && report && <div className="completion"><span className="completion-icon"><CheckCircle2 size={35} /></span><h3>Transfer complete</h3><p>{report.filesWritten + report.filesReused} files verified in {report.rootName}. {cacheReclaimed ? "Temporary browser storage was reclaimed." : "The verified destination is safe, but temporary browser storage still needs cleanup."}</p></div>}
          {error && <div className="status-box error compact-status"><AlertTriangle size={17} />{error}</div>}
          {phase === "saved" && !cacheReclaimed && <button className="button button-secondary button-wide confirm-button" onClick={() => void cleanupCache()}><Database size={16} />Retry temporary storage cleanup</button>}
          {busy && <button className="button button-danger button-wide confirm-button" onClick={() => void reset()}>Stop and reconnect</button>}
          {(phase === "failed" || phase === "saved") && <button className="button button-secondary button-wide confirm-button" onClick={() => void reset()}><RefreshCw size={16} />{phase === "failed" ? "Reconnect and resume" : "Receive another folder"}</button>}
        </div>
      </div>
    </section>
  );
}

function shortHexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("Invalid transfer ID.");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function toMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function offlineReceiverCapabilityError(): string | null {
  if (typeof RTCPeerConnection === "undefined") {
    return "Offline network transfer requires WebRTC support.";
  }
  if (!supportsDurableBlockStore()) {
    return "Offline network receive requires Chromium OPFS, Web Locks, and dedicated Worker support.";
  }
  if (!window.showDirectoryPicker) {
    return "Offline network receive requires Chromium's destination folder picker.";
  }
  return null;
}
