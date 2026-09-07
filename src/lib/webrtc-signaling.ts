import { decode as decodeBase45, encode as encodeBase45 } from "@digitalbazaar/base45";
import { sha256 } from "@noble/hashes/sha2.js";
import { compressSync, Decompress } from "fflate";
import { qrf3Crc32 } from "./stream-protocol";

const SIGNAL_PREFIX = "WRS1";
const SIGNAL_PAYLOAD_CHARS = 750;
const MAX_SIGNAL_FRAMES = 256;
const MAX_SDP_CHARS = 128 * 1024;
const MAX_SIGNAL_JSON_BYTES = MAX_SDP_CHARS + 1024;
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;

export type OfflineSignalKind = "offer" | "answer";

export interface OfflineSignalBundle {
  v: 1;
  kind: OfflineSignalKind;
  sessionId: string;
  sdp: string;
}

export interface OfflineSignalProgress {
  complete: boolean;
  duplicate: boolean;
  received: number;
  total: number;
  bundle?: OfflineSignalBundle;
}

interface ParsedSignalFrame {
  kind: OfflineSignalKind;
  sessionId: string;
  index: number;
  total: number;
  checksum: number;
  payload: string;
}

export function createOfflineSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Compresses an SDP offer/answer and splits it into QR-sized, order-independent frames. */
export function encodeOfflineSignal(bundle: OfflineSignalBundle): string[] {
  validateBundle(bundle);
  const encoded = new TextEncoder().encode(JSON.stringify(bundle));
  const compressed = compressSync(encoded, { level: 9 });
  const payload = encodeBase45(compressed);
  const total = Math.ceil(payload.length / SIGNAL_PAYLOAD_CHARS);
  if (total < 1 || total > MAX_SIGNAL_FRAMES) {
    throw new Error("The WebRTC handshake is too large to display as QR frames.");
  }

  const kind = bundle.kind === "offer" ? "O" : "A";
  const checksum = qrf3Crc32(compressed).toString(16).padStart(8, "0");
  return Array.from({ length: total }, (_, index) => {
    const chunk = payload.slice(
      index * SIGNAL_PAYLOAD_CHARS,
      (index + 1) * SIGNAL_PAYLOAD_CHARS,
    );
    return [
      SIGNAL_PREFIX,
      kind,
      bundle.sessionId,
      String(index),
      String(total),
      checksum,
      chunk,
    ].join("|");
  });
}

export class OfflineSignalAccumulator {
  private identity?: string;
  private chunks = new Map<number, string>();

  reset(): void {
    this.identity = undefined;
    this.chunks.clear();
  }

  accept(value: string): OfflineSignalProgress {
    const frame = parseFrame(value);
    const identity = [
      frame.kind,
      frame.sessionId,
      frame.total,
      frame.checksum,
    ].join(":");
    if (this.identity !== undefined && this.identity !== identity) {
      throw new Error("This QR belongs to a different WebRTC handshake.");
    }
    this.identity = identity;

    const duplicate = this.chunks.has(frame.index);
    const existing = this.chunks.get(frame.index);
    if (existing !== undefined && existing !== frame.payload) {
      throw new Error("Conflicting WebRTC handshake frame detected.");
    }
    this.chunks.set(frame.index, frame.payload);

    if (this.chunks.size !== frame.total) {
      return {
        complete: false,
        duplicate,
        received: this.chunks.size,
        total: frame.total,
      };
    }

    const payload = Array.from({ length: frame.total }, (_, index) => {
      const chunk = this.chunks.get(index);
      if (chunk === undefined) throw new Error("A handshake frame is missing.");
      return chunk;
    }).join("");
    const compressed = decodeBase45(payload);
    if (qrf3Crc32(compressed) !== frame.checksum) {
      throw new Error("The WebRTC handshake QR checksum does not match.");
    }

    let parsed: unknown;
    try {
      const json = new TextDecoder("utf-8", { fatal: true }).decode(
        decompressSignal(compressed),
      );
      parsed = JSON.parse(json);
    } catch {
      throw new Error("The WebRTC handshake QR is corrupt.");
    }
    const bundle = validateBundle(parsed);
    if (bundle.kind !== frame.kind || bundle.sessionId !== frame.sessionId) {
      throw new Error("The WebRTC handshake envelope does not match its frames.");
    }
    return {
      complete: true,
      duplicate,
      received: frame.total,
      total: frame.total,
      bundle,
    };
  }
}

export async function createAuthenticationCode(
  sessionId: string,
  offerSdp: string,
  answerSdp: string,
): Promise<string> {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Invalid session ID.");
  const digest = sha256(
    new TextEncoder().encode(`airgap-webrtc-sas-v1\n${sessionId}\n${offerSdp}\n${answerSdp}`),
  );
  const number =
    (((digest[0] << 24) >>> 0) |
      (digest[1] << 16) |
      (digest[2] << 8) |
      digest[3]) >>>
    0;
  return String(number % 1_000_000).padStart(6, "0");
}

/** Removes non-host and globally routable candidates before SDP leaves the screen. */
export function limitSdpToLocalCandidates(sdp: string): string {
  if (sdp.length < 1 || sdp.length > MAX_SDP_CHARS) throw new Error("Invalid WebRTC SDP.");
  const endedWithNewline = /\r?\n$/.test(sdp);
  let candidatesSeen = 0;
  let candidatesKept = 0;
  const lines = sdp.split(/\r?\n/).filter((line) => {
    if (!line.startsWith("a=candidate:")) return true;
    candidatesSeen += 1;
    const parts = line.trim().split(/\s+/);
    const address = parts[4];
    const type = parts[7]?.toLowerCase();
    if (type !== "host" || !address || !isLocalCandidateAddress(address)) return false;
    candidatesKept += 1;
    return true;
  });
  if (candidatesSeen === 0 || candidatesKept === 0) {
    throw new Error("The browser did not expose a usable private-network connection candidate.");
  }
  const result = lines.join("\r\n");
  return endedWithNewline && !result.endsWith("\r\n") ? `${result}\r\n` : result;
}

export async function waitForIceGatheringComplete(
  peer: RTCPeerConnection,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      finish(new Error("Timed out while gathering local-network connection details."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const onAbort = () => {
      finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    peer.addEventListener("icegatheringstatechange", onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Close the narrow race between the initial state check and listener setup.
    onChange();
  });
}

function parseFrame(value: string): ParsedSignalFrame {
  const match = /^WRS1\|([OA])\|([0-9a-f]{32})\|(\d+)\|(\d+)\|([0-9a-f]{8})\|([\s\S]+)$/.exec(
    value,
  );
  if (!match) throw new Error("This is not a WebRTC handshake QR.");
  const index = Number(match[3]);
  const total = Number(match[4]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    total > MAX_SIGNAL_FRAMES ||
    index < 0 ||
    index >= total ||
    match[6].length > SIGNAL_PAYLOAD_CHARS
  ) {
    throw new Error("The WebRTC handshake frame number is invalid.");
  }
  return {
    kind: match[1] === "O" ? "offer" : "answer",
    sessionId: match[2],
    index,
    total,
    checksum: Number.parseInt(match[5], 16) >>> 0,
    payload: match[6],
  };
}

function validateBundle(value: unknown): OfflineSignalBundle {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid WebRTC handshake.");
  }
  const candidate = value as Partial<OfflineSignalBundle>;
  if (
    candidate.v !== 1 ||
    (candidate.kind !== "offer" && candidate.kind !== "answer") ||
    typeof candidate.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(candidate.sessionId) ||
    typeof candidate.sdp !== "string" ||
    candidate.sdp.length < 1 ||
    candidate.sdp.length > MAX_SDP_CHARS
  ) {
    throw new Error("Invalid WebRTC handshake.");
  }
  return candidate as OfflineSignalBundle;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isLocalCandidateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value.endsWith(".local") || value.endsWith(".local.")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  return value === "::1" || /^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value);
}

function decompressSignal(compressed: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;
  const stream = new Decompress((chunk) => {
    total += chunk.byteLength;
    if (total > MAX_SIGNAL_JSON_BYTES) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  // Small input slices put a practical bound on any one inflate callback from
  // a malicious compression bomb scanned from an untrusted QR display.
  for (let offset = 0; offset < compressed.byteLength && !tooLarge; offset += 512) {
    const end = Math.min(compressed.byteLength, offset + 512);
    stream.push(compressed.subarray(offset, end), end === compressed.byteLength);
  }
  if (tooLarge) throw new Error("The WebRTC handshake expands beyond its safe limit.");
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
