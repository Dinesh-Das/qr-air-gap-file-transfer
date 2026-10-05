import { ConnectionDiagnostics } from "./ConnectionDiagnostics";
import { PairingReadiness } from "./PairingReadiness";
import { usePairingReadiness } from "../lib/use-pairing-readiness";
import { watchWebRtcPeerHealth } from "../lib/webrtc-peer-health";
import { useTransferElapsed, useTransferRates } from "../lib/use-transfer-rate";
import { TransferMetrics } from "./TransferMetrics";
import { TransferProblem } from "./TransferProblem";
import { describeTransferProblem } from "../lib/transfer-problem";
import { useCallback, useEffect, useRef, useState } from "react";
import { PeerAuthorization } from "../lib/webrtc-authorization";
import { VerifyDevice } from "./VerifyDevice";
import { StorageReadiness } from "./StorageReadiness";
import { DurableReceiveQueue } from "../lib/webrtc-receive-queue";
import { sendBoundedControl, sendResumeState } from "../lib/webrtc-control-flow";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FolderCheck,
  Link2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { formatBytes } from "../lib/format";
import { readLargeTreeManifest, type LargeTreeManifest, type RandomAccessReader } from "../lib/large-transfer";
import { writeLargeTreeToDirectory, type LargeDestinationProgress, type LargeDestinationReport } from "../lib/large-destination";
import {
  decodeOfflineControl,
  encodeOfflineControl,
  hexToBytes,
  type OfflineTransferManifest,
} from "../lib/webrtc-protocol";
import { OfflineDestinationReceiver, type OfflineTransferProgress } from "../lib/webrtc-transfer";
import { supportsDurableBlockStore, BlockStoreError } from "../lib/block-store";
import {
  assertLocalSignalCandidates,
  limitSdpToLocalCandidates,
  waitForIceGatheringComplete,
} from "../lib/webrtc-signaling";
import {
  isValidPairingCode,
  checkRendezvousReadiness,
  joinRendezvousRoom,
  normalizePairingCode,
  publishRendezvousAnswer,
} from "../lib/webrtc-rendezvous";

type Phase = "pairing" | "preparing" | "verify-device" | "waiting" | "receiving" | "verifying" | "complete" | "saving" | "saved" | "failed" | "discarding";

export function WebRtcReceiver({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const [capabilityError] = useState(() => offlineReceiverCapabilityError());
  const readiness = usePairingReadiness(!capabilityError);
  const [phase, setPhase] = useState<Phase>(() => capabilityError ? "failed" : "pairing");
  const [pairingCode, setPairingCode] = useState("");
  const [senderAddress, setSenderAddress] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectionInterrupted, setConnectionInterrupted] = useState(false);
  const [verificationCode, setVerificationCode] = useState<string | null>(null);
  const [localConfirmed, setLocalConfirmed] = useState(false);
  const [manifest, setManifest] = useState<OfflineTransferManifest | null>(null);
  const [progress, setProgress] = useState<OfflineTransferProgress | null>(null);
  const [verifyBytes, setVerifyBytes] = useState(0);
  const [tree, setTree] = useState<LargeTreeManifest | null>(null);
  const [destinationProgress, setDestinationProgress] = useState<LargeDestinationProgress | null>(null);
  const [report, setReport] = useState<LargeDestinationReport | null>(null);
  const [cacheReclaimed, setCacheReclaimed] = useState(false);
  const [error, setError] = useState<string | null>(capabilityError);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [corruptManifest, setCorruptManifest] = useState<OfflineTransferManifest | null>(null);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const receiverRef = useRef<OfflineDestinationReceiver | null>(null);
  const readerRef = useRef<RandomAccessReader | null>(null);
  const manifestRef = useRef<OfflineTransferManifest | null>(null);
  const authorizationRef = useRef<PeerAuthorization | null>(null);
  const lifecycleRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const receiveQueueRef = useRef<DurableReceiveQueue | null>(null);
  const receiveTaskRef = useRef<Promise<void>>(Promise.resolve());
  const manifestStartedRef = useRef(false);
  const receiveReadyRef = useRef(false);
  const taskAbortRef = useRef<AbortController | null>(null);
  const destinationTaskRef = useRef<Promise<void>>(Promise.resolve());
  const peerHealthCleanupRef = useRef<(() => void) | null>(null);
  const verificationStartedRef = useRef(false);
  const lastProgressAtRef = useRef(0);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const terminateConnection = useCallback((reason?: Error) => {
    lifecycleRef.current += 1;
    if (receiveQueueRef.current) {
      receiveTaskRef.current = receiveQueueRef.current.stop();
      receiveQueueRef.current = null;
    }
    authorizationRef.current?.close();
    authorizationRef.current = null;
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
    await Promise.allSettled([queueRef.current, receiveTaskRef.current, destinationTaskRef.current]);
    await receiverRef.current?.store.close().catch(() => undefined);
    receiverRef.current = null;
  }, [terminateConnection]);

  useEffect(() => () => { void closeConnection(); }, [closeConnection]);

  const fail = useCallback((caught: unknown) => {
    if (caught instanceof DOMException && caught.name === "AbortError") return;
    const message = toMessage(caught);
    const problem = describeTransferProblem(caught, { role: "receiver", phase: phaseRef.current });
    setError(problem.message);
    setErrorDetails(problem.details);
    setConnected(false); setConnectionInterrupted(false);
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
      void Promise.allSettled([queueRef.current, receiveTaskRef.current]).then(async () => {
        await receiver.store.close().catch(() => undefined);
        if (receiverRef.current === receiver) receiverRef.current = null;
      });
    }
  }, [terminateConnection]);

  const watchPeerHealth = useCallback((peer: RTCPeerConnection, generation: number) => {
    peerHealthCleanupRef.current = watchWebRtcPeerHealth(peer, () => generation === lifecycleRef.current, fail, (state) => setConnectionInterrupted(state === "disconnected"));
  }, [fail]);

  const busy = !["pairing", "complete", "saved", "failed"].includes(phase);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const acceptManifest = useCallback(async (nextManifest: OfflineTransferManifest, generation: number) => {
    if (!authorizationRef.current?.authorized) throw new Error("A manifest arrived before both peers confirmed the device code.");
    if (receiverRef.current) throw new Error("A second transfer manifest was received.");
    let receiver: OfflineDestinationReceiver;
    try {
      receiver = await OfflineDestinationReceiver.open(nextManifest);
    } catch (caught) {
      if (generation === lifecycleRef.current && caught instanceof BlockStoreError && caught.code === "CORRUPT_STORE") {
        setCorruptManifest(nextManifest);
      }
      throw caught;
    }
    if (generation !== lifecycleRef.current) {
      await receiver.store.close();
      return;
    }
    receiverRef.current = receiver;
    manifestRef.current = nextManifest;
    setManifest(nextManifest);
    const resumedBytes = receiver.store.progress().receivedBytes;
    setProgress(receiver.progress(resumedBytes));
    const channel = channelRef.current;
    if (channel?.readyState !== "open") throw new Error("The local connection closed.");
    receiveQueueRef.current = new DurableReceiveQueue(receiver, {
      onCommitted: (indices) => {
        if (generation !== lifecycleRef.current) return;
        if (channel.readyState !== "open") throw new Error("The local connection closed before acknowledging durable data.");
        sendBoundedControl(channel, { type: "ack", indices });
        const now = Date.now();
        if (receiver.store.progress().complete || now - lastProgressAtRef.current >= 100) {
          lastProgressAtRef.current = now;
          setProgress((current) => receiver.progress(current?.resumedBytes ?? 0));
        }
        if (!verificationStartedRef.current) setPhase("receiving");
      },
      onError: (caught) => { if (generation === lifecycleRef.current) fail(caught); },
    });
    await sendResumeState(channel, receiver.resumeRangePages(), taskAbortRef.current?.signal);
    if (generation !== lifecycleRef.current) return;
    receiveReadyRef.current = true;
    setPhase("waiting");
  }, [fail]);

  const verifyTransfer = useCallback(async (generation: number) => {
    const receiver = receiverRef.current;
    const channel = channelRef.current;
    const receiveQueue = receiveQueueRef.current;
    if (!receiver || !receiveQueue) throw new Error("No received transfer is available to verify.");
    await receiveQueue.finish();
    if (generation !== lifecycleRef.current) return;
    const controller = new AbortController();
    taskAbortRef.current = controller;
    setPhase("verifying");
    const reader = await receiver.verify(controller.signal, (completed) => {
      if (generation === lifecycleRef.current) setVerifyBytes(completed);
    });
    const parsedTree = await readLargeTreeManifest(reader, controller.signal);
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
    setConnected(false); setConnectionInterrupted(false);
  }, []);

  const confirmPairing = useCallback(() => {
    const channel = channelRef.current;
    const authorization = authorizationRef.current;
    if (!authorization || authorization.locallyConfirmed || channel?.readyState !== "open") return;
    try {
      channel.send(encodeOfflineControl(authorization.confirmLocal()));
      setLocalConfirmed(true);
      if (authorization.authorized) setPhase("waiting");
    } catch (caught) { fail(caught); }
  }, [fail]);

  const installChannel = useCallback((channel: RTCDataChannel, generation: number) => {
    channel.binaryType = "arraybuffer";
    channelRef.current = channel;
    channel.addEventListener("open", () => {
      if (generation !== lifecycleRef.current) return;
      setConnected(true);
    });
    channel.addEventListener("close", () => {
      if (generation !== lifecycleRef.current) return;
      setConnected(false); setConnectionInterrupted(false);
      if (["preparing", "verify-device", "waiting", "receiving", "verifying"].includes(phaseRef.current)) {
        fail(new Error("The local connection closed. Reconnect and resend the same folder to resume."));
      }
    });
    channel.addEventListener("message", (event) => {
      // The verified receive is independent of the completed connection. A
      // callback queued before channel close must not invalidate saving/retry.
      if (generation !== lifecycleRef.current || ["complete", "saving", "saved"].includes(phaseRef.current)) return;
      // Check authorization at arrival, not after asynchronous storage work:
      // a queued premature payload must never become authorized retroactively.
      let message;
      try {
        message = typeof event.data === "string" ? decodeOfflineControl(event.data) : null;
        if (message?.type === "peer-confirmed") {
          if (!authorizationRef.current) throw new Error("Device verification is not ready.");
          const wasAuthorized = authorizationRef.current.authorized;
          authorizationRef.current.acceptConfirmation(message);
          if (!wasAuthorized && authorizationRef.current.authorized) setPhase("waiting");
          return;
        }
        if (message?.type === "cancel") throw new Error(message.reason ?? "The sender cancelled the transfer.");
        if (message?.type === "error") throw new Error(message.message);
        if (!authorizationRef.current) throw new Error("Device verification is not ready.");
        authorizationRef.current.requireAuthorized();
        if (!message) {
          if (!(event.data instanceof ArrayBuffer)) throw new Error("Unexpected WebRTC data message.");
          if (verificationStartedRef.current) throw new Error("File data arrived after the sender's completion marker.");
          if (!receiveQueueRef.current || !receiveReadyRef.current) throw new Error("File data arrived before the transfer manifest was ready.");
          receiveQueueRef.current.enqueue(event.data);
          return;
        }
        switch (message.type) {
          case "manifest":
            if (manifestStartedRef.current) throw new Error("A second transfer manifest was received.");
            manifestStartedRef.current = true;
            queueRef.current = acceptManifest(message.manifest, generation).catch((caught) => {
              if (generation === lifecycleRef.current) fail(caught);
            });
            break;
          case "sender-complete":
            if (verificationStartedRef.current) return;
            if (!receiveQueueRef.current || !receiveReadyRef.current) throw new Error("Completion arrived before the transfer manifest was ready.");
            verificationStartedRef.current = true;
            queueRef.current = verifyTransfer(generation).catch((caught) => {
              if (generation === lifecycleRef.current) fail(caught);
            });
            break;
          default:
            throw new Error("Unexpected control message from the sender.");
        }
      } catch (caught) { fail(caught); }
    });
  }, [acceptManifest, fail, verifyTransfer]);

  const connect = useCallback(async () => {
    if (phaseRef.current !== "pairing" || !readiness.ready) return;
    if (!isValidPairingCode(pairingCode)) {
      setError("Enter the six-digit pairing code shown on the sender.");
      setErrorDetails(null);
      return;
    }
    const generation = lifecycleRef.current;
    phaseRef.current = "preparing";
    const controller = new AbortController();
    taskAbortRef.current = controller;
    setError(null); setErrorDetails(null);
    setVerificationCode(null);
    setLocalConfirmed(false);
    setPhase("preparing");
    try {
      await checkRendezvousReadiness(controller.signal);
      if (generation !== lifecycleRef.current) return;
      const join = await joinRendezvousRoom(pairingCode, controller.signal, senderAddress);
      const bundle = join.bundle;
      if (generation !== lifecycleRef.current) return;
      assertLocalSignalCandidates(bundle.sdp);
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
      const authorization = await PeerAuthorization.create(bundle.sessionId, bundle.sdp, sdp);
      if (generation !== lifecycleRef.current) return;
      authorizationRef.current = authorization;
      setVerificationCode(authorization.code);
      setPhase("verify-device");
      await publishRendezvousAnswer(join.joinId, { v: 1, kind: "answer", sessionId: bundle.sessionId, sdp }, controller.signal);
      if (generation !== lifecycleRef.current) return;
    } catch (caught) {
      if (generation === lifecycleRef.current) fail(caught);
    }
  }, [fail, installChannel, pairingCode, senderAddress, watchPeerHealth, readiness.ready]);

  const save = useCallback(() => {
    if (phaseRef.current !== "complete") return;
    phaseRef.current = "saving";
    const generation = lifecycleRef.current;
    const task = (async () => {
    const nextTree = tree;
    const reader = readerRef.current;
    const nextManifest = manifestRef.current;
    const receiver = receiverRef.current;
    if (!nextTree || !reader || !nextManifest || !receiver || !window.showDirectoryPicker) {
      fail(new Error("This browser cannot choose a destination folder."));
      return;
    }
    setError(null); setErrorDetails(null);
    setPhase("saving");
    const controller = new AbortController();
    taskAbortRef.current = controller;
    try {
      const destination = await window.showDirectoryPicker({ id: "airgap-webrtc-destination", mode: "readwrite" });
      if (generation !== lifecycleRef.current) return;
      const result = await writeLargeTreeToDirectory(
        nextTree,
        reader,
        { transferId: shortHexToBytes(nextManifest.transferId), streamSha256: hexToBytes(nextManifest.streamSha256) },
        destination,
        { signal: controller.signal, onProgress: (next) => {
          if (generation === lifecycleRef.current) setDestinationProgress(next);
        } },
      );
      if (generation !== lifecycleRef.current) return;
      let reclaimed = false;
      try {
        await receiver.store.delete();
        receiverRef.current = null;
        readerRef.current = null;
        reclaimed = true;
      } catch (cleanupError) {
        setError("Files are saved and verified. Retry temporary storage cleanup to remove this app’s transfer copy.");
        setErrorDetails(describeTransferProblem(cleanupError, { role: "receiver", phase: "saved" }).details);
      }
      setCacheReclaimed(reclaimed);
      setReport(result);
      setPhase("saved");
    } catch (caught) {
      if (generation !== lifecycleRef.current) return;
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setPhase("complete");
        return;
      }
      // Saving is independent of the now-verified receive. Keep its reader
      // and durable cache so a quota/permission/destination error can retry.
      const problem = describeTransferProblem(caught, { role: "receiver", phase: "saving" });
      setError(`Files remain verified in temporary storage. ${problem.message}`);
      setErrorDetails(problem.details);
      setPhase("complete");
    }
    })();
    destinationTaskRef.current = task;
    return task;
  }, [fail, tree]);

  const reset = useCallback(async () => {
    const generation = lifecycleRef.current + 1;
    await closeConnection();
    if (generation !== lifecycleRef.current) return;
    queueRef.current = Promise.resolve();
    receiveTaskRef.current = Promise.resolve();
    manifestStartedRef.current = false;
    receiveReadyRef.current = false;
    manifestRef.current = null;
    setCorruptManifest(null);
    readerRef.current = null;
    setVerificationCode(null);
    setLocalConfirmed(false);
    verificationStartedRef.current = false;
    const nextCapabilityError = offlineReceiverCapabilityError();
    setPhase(nextCapabilityError ? "failed" : "pairing");
    setPairingCode("");
    setConnected(false); setConnectionInterrupted(false);
    setManifest(null);
    setProgress(null);
    setVerifyBytes(0);
    setTree(null);
    setDestinationProgress(null);
    setReport(null);
    setCacheReclaimed(false);
    lastProgressAtRef.current = 0;
    setError(nextCapabilityError); setErrorDetails(null);
    readiness.retry();
  }, [closeConnection, readiness.retry]);

  const discardCorruptCopy = useCallback(async () => {
    if (phaseRef.current !== "failed" || !corruptManifest) return;
    phaseRef.current = "discarding";
    setPhase("discarding");
    setError(null); setErrorDetails(null);
    const generation = lifecycleRef.current + 1;
    await closeConnection();
    if (generation !== lifecycleRef.current) return;
    try {
      await OfflineDestinationReceiver.discardStoredCopy(corruptManifest);
      if (generation === lifecycleRef.current) await reset();
    } catch (caught) {
      if (generation !== lifecycleRef.current) return;
      const problem = describeTransferProblem(caught, { role: "receiver", phase: "discarding" });
      setError(problem.message); setErrorDetails(problem.details);
      phaseRef.current = "failed"; setPhase("failed");
    }
  }, [closeConnection, corruptManifest, reset]);

  const cleanupCache = useCallback(async () => {
    const receiver = receiverRef.current;
    if (!receiver) return;
    setError(null); setErrorDetails(null);
    try {
      await receiver.store.delete();
      if (receiverRef.current === receiver) receiverRef.current = null;
      readerRef.current = null;
      setCacheReclaimed(true);
    } catch (caught) {
      setError("Files are saved and verified. Retry temporary storage cleanup to remove this app’s transfer copy.");
      setErrorDetails(describeTransferProblem(caught, { role: "receiver", phase: "saved" }).details);
    }
  }, []);

  const percentage = progress ? (progress.completedBytes / progress.totalBytes) * 100 : 0;
  const { currentRate, smoothedRate: rate } = useTransferRates(progress, phase === "receiving");
  const elapsed = useTransferElapsed(progress !== null, ["waiting", "receiving", "verifying"].includes(phase));

  return (
    <section className="workspace network-workspace">
      <div className="page-heading"><h1>Receive files from another laptop.</h1><p>Enter the sender’s six-digit code, then compare the device code on both laptops.</p></div>
      <div className="transfer-card receiver-layout">
        <div className="panel">
          {phase === "pairing" && <PairingReadiness readiness={readiness} />}
          {phase === "pairing" ? <div className="pairing-entry"><span className="pairing-icon"><Link2 size={28} /></span><h2>Enter pairing code</h2><p>Use the six digits shown on the sending device.</p><input className="pairing-input" value={pairingCode} onChange={(event) => setPairingCode(normalizePairingCode(event.target.value))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" aria-label="Six-digit pairing code" /><details><summary>Troubleshoot connection</summary><p>If automatic discovery fails, copy an address from the sender. Leave blank for automatic discovery.</p><label>Sender address<input value={senderAddress} onChange={(event) => setSenderAddress(event.target.value)} maxLength={64} placeholder="192.168.1.20:4174" autoComplete="off" spellCheck={false} /></label></details><button className="button button-primary button-wide" onClick={() => void connect()} disabled={!isValidPairingCode(pairingCode) || !readiness.ready}><Link2 size={16} />Connect to sender</button></div> : phase === "preparing" ? <div className="qr-placeholder"><div className="qr-placeholder-inner"><span className="spinner dark-spinner" /><strong>Finding sender and creating connection</strong><span>Keep the sending laptop open and connected to the same network.</span></div></div> : <div className="qr-placeholder"><div className="qr-placeholder-inner">{phase === "saved" ? <FolderCheck size={48} /> : phase === "failed" ? <AlertTriangle size={48} /> : <Database size={48} />}<strong>{phase === "discarding" ? "Removing unusable copy" : phase === "saved" ? "Files saved" : phase === "failed" ? "Unable to receive" : connectionInterrupted ? "Connection interrupted" : connected ? "Devices connected" : "Waiting for the other laptop"}</strong><span>{phase === "failed" ? "Follow the recovery advice to reconnect safely." : "Received files stay here until you choose where to save them."}</span></div></div>}
        </div>
        <div className={progress ? "panel receiver-status transfer-status-panel" : "panel receiver-status"}>
          <div className="panel-kicker"><Database size={15} /> Destination</div><h2>Your files</h2><p className="panel-description">If the transfer stops, reconnect with the same files to continue from saved progress.</p>
          {error && <TransferProblem message={error} details={errorDetails} />}
          {phase === "failed" && (corruptManifest ? <><p>This removes the unusable copy on this laptop. Keep the source files on the sending laptop.</p><button className="button button-danger button-wide confirm-button" onClick={() => void discardCorruptCopy()}>Discard unusable transfer copy</button></> : <button className="button button-primary button-wide confirm-button" onClick={() => void reset()}><RefreshCw size={16} />Reconnect and resume</button>)}
          {phase === "discarding" && <div role="status" className="status-box compact-status"><span className="spinner" />Removing the unusable transfer copy…</div>}
          {phase === "pairing" && <StorageReadiness />}
          {phase === "preparing" && <div className="status-box compact-status"><span className="spinner" />Discovering the sender for code {pairingCode}…</div>}
          {peerRef.current && <ConnectionDiagnostics peer={peerRef.current} />}
          {phase === "verify-device" && verificationCode && <VerifyDevice code={verificationCode} connected={connected && !connectionInterrupted} confirmed={localConfirmed} onConfirm={confirmPairing} onReject={() => fail(new Error("Device codes did not match. No files were accepted. Reconnect and verify the intended laptop."))} />}
          {phase === "waiting" && !manifest && <div className="status-box success compact-status"><ShieldCheck size={16} />Connected. Waiting for the sender’s file list.</div>}
          {progress && (phase === "waiting" || phase === "receiving" || phase === "verifying" || phase === "complete" || phase === "failed") && <div className="transfer-progress-card"><div className="selection-header"><strong>{phase === "failed" ? "Transfer stopped" : phase === "verifying" ? "Checking received files" : phase === "complete" ? "Ready to save" : "Receiving to disk"}</strong><span>{phase === "verifying" && manifest ? `${((verifyBytes / manifest.totalBytes) * 100).toFixed(1)}%` : `${percentage.toFixed(1)}%`}</span></div><div className="progress-track"><div className="progress-fill" style={{ width: `${phase === "verifying" && manifest ? (verifyBytes / manifest.totalBytes) * 100 : percentage}%` }} /></div><TransferMetrics progress={progress} rate={rate} currentRate={currentRate} elapsed={elapsed} direction="receive" interrupted={phase === "failed"} /></div>}
          {phase === "complete" && tree && <><div className="status-box success compact-status"><CheckCircle2 size={17} />Transfer checked and ready to save. Choose a destination folder for “{tree.rootName}”.</div><button className="button button-primary button-wide confirm-button" onClick={save}><FolderCheck size={16} />Choose destination and save</button></>}
          {phase === "saving" && <div className="status-box compact-status destination-save-status" role="status"><span className="spinner" /><div>{destinationProgress ? <><strong>{destinationProgress.phase === "resume-check" ? "Checking saved files" : destinationProgress.phase === "write" ? "Writing destination files" : "Verifying destination files"}</strong><div>{destinationProgress.filesComplete} / {destinationProgress.filesTotal} files · {formatBytes(Number(destinationProgress.bytesComplete))} / {formatBytes(Number(destinationProgress.bytesTotal))}</div>{destinationProgress.path && <div>{destinationProgress.path}</div>}</> : "Saving and checking your files…"}</div></div>}
          {phase === "saved" && report && <div className="completion"><span className="completion-icon"><CheckCircle2 size={35} /></span><h3>Transfer complete</h3><p>{report.filesWritten + report.filesReused} files verified in {report.rootName}. {cacheReclaimed ? "Temporary browser storage was reclaimed." : "The verified destination is safe, but temporary browser storage still needs cleanup."}</p></div>}
          {phase === "saved" && !cacheReclaimed && <button className="button button-secondary button-wide confirm-button" onClick={() => void cleanupCache()}><Database size={16} />Retry temporary storage cleanup</button>}
          {busy && phase !== "discarding" && <button className="button button-danger button-wide confirm-button" onClick={() => void reset()}>Stop and reconnect</button>}
          {phase === "saved" && <button className="button button-secondary button-wide confirm-button" onClick={() => void reset()}><RefreshCw size={16} />Receive more files</button>}
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
    return "This browser cannot make a direct connection. Open this app in a current Edge or Chrome window.";
  }
  if (!supportsDurableBlockStore()) {
    return "This browser cannot store transfer data safely. Open this app in a current Edge or Chrome window.";
  }
  if (!window.showDirectoryPicker) {
    return "This browser cannot choose a destination folder. Open this app in a current Edge or Chrome window.";
  }
  return null;
}
