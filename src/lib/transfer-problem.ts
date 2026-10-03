import { BlockStoreError } from "./block-store";
import { RendezvousError } from "./webrtc-rendezvous";
import { SourceChangedError } from "./webrtc-sender-resume";
import { PeerCandidatePolicyError } from "./webrtc-signaling";

/** A local SCTP capacity check; never constructed from peer error text. */
export class TransferMessageSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferMessageSizeError";
  }
}

export type TransferProblemContext = {
  role: "sender" | "receiver";
  phase: "idle" | "selected" | "scanning" | "checking" | "preparing" | "pairing" |
    "verify-device" | "waiting" | "transferring" | "receiving" | "verifying" |
    "saving" | "saved" | "complete" | "failed" | "discarding";
};

/** Recovery advice is selected from trusted types/state, never peer-supplied text. */
export function describeTransferProblem(value: unknown, context: TransferProblemContext): { message: string; details: string } {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  const details = raw.length > 2000 ? `${raw.slice(0, 2000)}… (truncated)` : raw;
  // Our storage worker preserves DOM error names across its RPC boundary.
  const errorName = value instanceof Error || value instanceof DOMException ? value.name : undefined;
  const { role, phase } = context;
  let message: string;
  if (value instanceof PeerCandidatePolicyError) {
    message = "The other device supplied unsupported local connection details. Open the current app on both devices, connect to the same local network, and retry pairing.";
  } else if (value instanceof TransferMessageSizeError) {
    message = "This connection cannot carry the transfer. Open both laptops in current Edge or Chrome and reconnect.";
  } else if (value instanceof RendezvousError) {
    if (value.status === 404 || value.status === 410) message = role === "receiver"
      ? "That pairing code is unavailable or expired. Get the sender’s current code and reconnect."
      : "The pairing code is no longer available. Retry connection to get a new code.";
    else if (value.status === 0 || value.status === 503) message = "The local connection service is unavailable. Reopen the app using its launcher, then retry.";
    else if (value.status === 403) message = "The local app refused this connection request. Reopen the app using its launcher, then retry.";
    else if (value.status === 400) message = "Check the pairing code and any sender address you entered, then retry connection.";
    else if (value.status === 409) message = "That pairing attempt is already in use. Get a new code from the sender and reconnect.";
    else if (value.status === 429) message = "Too many connection attempts are in progress. Wait a moment, then retry.";
    else message = "The other laptop could not be reached. Keep both laptops awake on the same network, then retry connection.";
  } else if (value instanceof SourceChangedError) {
    message = "The saved source changed. Choose the updated files as a new transfer.";
  } else if (value instanceof BlockStoreError && value.code === "BUSY") {
    message = "This transfer is open in another tab. Close that tab, then reconnect.";
  } else if (value instanceof BlockStoreError && value.code === "UNSUPPORTED") {
    message = "This browser cannot store transfer data safely. Open this app in a current Edge or Chrome window.";
  } else if (value instanceof BlockStoreError && value.code === "CORRUPT_STORE" && role === "receiver") {
    message = "This laptop’s transfer copy could not be trusted. Discard the unusable copy, then reconnect with the same source files.";
  } else if ((value instanceof BlockStoreError && value.code === "QUOTA_EXCEEDED") || errorName === "QuotaExceededError") {
    message = phase === "saving"
      ? "The destination does not have enough space. Free space or choose another destination, then retry saving."
      : "There is not enough temporary browser storage. Free space on this laptop, then reconnect with the same source files.";
  } else if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    message = phase === "saving"
      ? "Writing to the destination was not allowed. Choose the folder again and allow access, then retry saving."
      : role === "sender"
        ? "Reading the source files was not allowed. Choose them again and allow access."
        : "The browser denied access needed for this transfer. Reopen the app and allow access, then reconnect.";
  } else if (phase === "discarding") {
    message = "The unusable copy could not be removed. Close other tabs using this transfer, then retry removing it.";
  } else if (phase === "saving") {
    message = "Choose the same destination folder and retry saving. Reusable files will be checked before continuing.";
  } else if (phase === "saved") {
    message = "Files are saved and verified. Retry temporary storage cleanup to remove this app’s transfer copy.";
  } else if (phase === "verifying") {
    message = "Received files could not be verified. Keep the source files and reconnect; nothing is ready to save.";
  } else if (phase === "verify-device") {
    message = "Device verification failed. Reconnect and compare the codes on both laptops before transferring files.";
  } else if (["idle", "selected", "scanning"].includes(phase) || role === "sender" && phase === "preparing") {
    message = "These files could not be prepared. Check that they are still available and allow file access, then retry.";
  } else if (phase === "checking") {
    message = "The local connection service is unavailable. Reopen the app using its launcher, then retry.";
  } else if (phase === "pairing" || role === "receiver" && phase === "preparing") {
    message = "The laptops could not connect. Keep both awake on the same network and retry connection.";
  } else {
    message = "Transfer stopped before verification finished. Keep the same source files and reconnect both laptops to continue from reusable data.";
  }
  return { message, details };
}
