import { sha256 } from "@noble/hashes/sha2.js";
import { validatePortableRootName } from "./archive";
import type { PreparedLargeSource } from "./large-transfer";
import { MAX_BLOCK_STORE_BLOCKS } from "./block-store";

// Leave room for the authenticated header beneath common 64 KiB SCTP limits.
export const OFFLINE_BLOCK_BYTES = 60 * 1024;
export const OFFLINE_DATA_HEADER_BYTES = 44;
export const OFFLINE_MAX_ACK_INDICES = 512;
export const OFFLINE_MAX_RESUME_RANGES = 512;
const DATA_MAGIC = Uint8Array.of(0x57, 0x46, 0x44, 0x31); // WFD1
const DATA_DIGEST_DOMAIN = new TextEncoder().encode("airgap-webrtc-data-v1\0");
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export interface OfflineTransferManifest {
  v: 1;
  type: "manifest";
  transferId: string;
  manifestId: string;
  rootName: string;
  totalBytes: number;
  blockSize: number;
  streamSha256: string;
}

export type OfflineControlMessage =
  | { type: "peer-confirmed" }
  | { type: "manifest"; manifest: OfflineTransferManifest }
  | { type: "resume-ranges"; ranges: Array<[number, number]> }
  | { type: "resume-complete" }
  | { type: "ack"; indices: number[] }
  | { type: "sender-complete" }
  | { type: "receiver-complete" }
  | { type: "cancel"; reason?: string }
  | { type: "error"; message: string };

export interface OfflineDataBlock {
  index: number;
  payload: Uint8Array;
}

export async function createOfflineTransferManifest(
  source: PreparedLargeSource,
): Promise<OfflineTransferManifest> {
  const rootName = validatePortableRootName(source.rootName);
  const totalBytes = Number(source.totalStreamBytes);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
    throw new Error("The source is too large for exact browser file addressing.");
  }
  if (Math.ceil(totalBytes / OFFLINE_BLOCK_BYTES) > MAX_BLOCK_STORE_BLOCKS) {
    throw new Error("The source exceeds the durable receiver block-map limit.");
  }
  const streamSha256 = bytesToHex(source.streamSha256);
  const fingerprint = sha256(
    new TextEncoder().encode(
      `airgap-webrtc-transfer-v1\n${rootName}\n${totalBytes}\n${streamSha256}`,
    ),
  );
  const transferId = bytesToHex(fingerprint.subarray(0, 16));
  const manifestId = bytesToHex(
    sha256(
      new TextEncoder().encode(
        canonicalManifest({
          transferId,
          rootName,
          totalBytes,
          blockSize: OFFLINE_BLOCK_BYTES,
          streamSha256,
        }),
      ),
    ),
  );
  return {
    v: 1,
    type: "manifest",
    transferId,
    manifestId,
    rootName,
    totalBytes,
    blockSize: OFFLINE_BLOCK_BYTES,
    streamSha256,
  };
}

export function encodeOfflineControl(message: OfflineControlMessage): string {
  validateOfflineControl(message);
  return JSON.stringify(message);
}

export function decodeOfflineControl(value: string): OfflineControlMessage {
  if (value.length > 256 * 1024) throw new Error("Control message is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid transfer control message.");
  }
  return validateOfflineControl(parsed);
}

export function encodeOfflineDataBlock(index: number, payload: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error("Invalid data block index.");
  }
  if (payload.byteLength < 1 || payload.byteLength > OFFLINE_BLOCK_BYTES) {
    throw new Error("Invalid data block length.");
  }
  const output = new Uint8Array(OFFLINE_DATA_HEADER_BYTES + payload.byteLength);
  output.set(DATA_MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint32(4, index, true);
  view.setUint32(8, payload.byteLength, true);
  output.set(payload, OFFLINE_DATA_HEADER_BYTES);
  output.set(hashDataBlock(output.subarray(0, 12), payload), 12);
  return output;
}

export function decodeOfflineDataBlock(value: ArrayBuffer | Uint8Array): OfflineDataBlock {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength < OFFLINE_DATA_HEADER_BYTES) {
    throw new Error("Truncated data block.");
  }
  if (DATA_MAGIC.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("Invalid data block marker.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const index = view.getUint32(4, true);
  const length = view.getUint32(8, true);
  if (
    length < 1 ||
    length > OFFLINE_BLOCK_BYTES ||
    bytes.byteLength !== OFFLINE_DATA_HEADER_BYTES + length
  ) {
    throw new Error("Invalid data block length.");
  }
  const payload = bytes.slice(OFFLINE_DATA_HEADER_BYTES);
  const actual = hashDataBlock(bytes.subarray(0, 12), payload);
  for (let offset = 0; offset < actual.length; offset += 1) {
    if (actual[offset] !== bytes[12 + offset]) {
      throw new Error("Data block failed its SHA-256 integrity check.");
    }
  }
  return { index, payload };
}

/** Converts a durable receipt bitset to compact half-open block ranges. */
export function receiptBitsToRanges(bits: Uint8Array, totalBlocks: number): Array<[number, number]> {
  if (!Number.isSafeInteger(totalBlocks) || totalBlocks < 0) {
    throw new Error("Invalid total block count.");
  }
  const ranges: Array<[number, number]> = [];
  let index = 0;
  while (index < totalBlocks) {
    if (!isReceiptBitSet(bits, index)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < totalBlocks && isReceiptBitSet(bits, index)) index += 1;
    ranges.push([start, index]);
  }
  return ranges;
}

export function applyReceiptRanges(
  bits: Uint8Array,
  ranges: ReadonlyArray<readonly [number, number]>,
  totalBlocks: number,
): void {
  for (const [start, end] of ranges) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > totalBlocks
    ) {
      throw new Error("Invalid resume range.");
    }
    for (let index = start; index < end; index += 1) {
      bits[index >>> 3] |= 1 << (index & 7);
    }
  }
}

export function isReceiptBitSet(bits: Uint8Array, index: number): boolean {
  return index >= 0 && index >>> 3 < bits.length && (bits[index >>> 3] & (1 << (index & 7))) !== 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (!HEX_64.test(hex)) throw new Error("Invalid SHA-256 value.");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function validateOfflineControl(value: unknown): OfflineControlMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new Error("Invalid transfer control message.");
  }
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "peer-confirmed":
    case "resume-complete":
    case "sender-complete":
    case "receiver-complete":
      return message as unknown as OfflineControlMessage;
    case "manifest":
      return { type: "manifest", manifest: validateManifest(message.manifest) };
    case "resume-ranges": {
      if (!Array.isArray(message.ranges) || message.ranges.length > OFFLINE_MAX_RESUME_RANGES) {
        throw new Error("Invalid resume ranges.");
      }
      const ranges = message.ranges.map((range) => {
        if (!Array.isArray(range) || range.length !== 2) throw new Error("Invalid resume range.");
        const [start, end] = range;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(end) <= Number(start)) {
          throw new Error("Invalid resume range.");
        }
        return [Number(start), Number(end)] as [number, number];
      });
      return { type: "resume-ranges", ranges };
    }
    case "ack": {
      if (!Array.isArray(message.indices) || message.indices.length > OFFLINE_MAX_ACK_INDICES) {
        throw new Error("Invalid block acknowledgement.");
      }
      const indices = message.indices.map((index) => {
        if (!Number.isSafeInteger(index) || Number(index) < 0) throw new Error("Invalid block acknowledgement.");
        return Number(index);
      });
      return { type: "ack", indices };
    }
    case "cancel":
      if (
        message.reason !== undefined &&
        (typeof message.reason !== "string" || message.reason.length > 2_000)
      ) throw new Error("Invalid cancel message.");
      return { type: "cancel", reason: message.reason as string | undefined };
    case "error":
      if (typeof message.message !== "string" || message.message.length > 2_000) throw new Error("Invalid error message.");
      return { type: "error", message: message.message };
    default:
      throw new Error("Unknown transfer control message.");
  }
}

function validateManifest(value: unknown): OfflineTransferManifest {
  if (typeof value !== "object" || value === null) throw new Error("Invalid transfer manifest.");
  const manifest = value as Partial<OfflineTransferManifest>;
  if (
    manifest.v !== 1 ||
    manifest.type !== "manifest" ||
    typeof manifest.transferId !== "string" ||
    !HEX_32.test(manifest.transferId) ||
    typeof manifest.manifestId !== "string" ||
    !HEX_64.test(manifest.manifestId) ||
    typeof manifest.rootName !== "string" ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    Number(manifest.totalBytes) < 1 ||
    manifest.blockSize !== OFFLINE_BLOCK_BYTES ||
    typeof manifest.streamSha256 !== "string" ||
    !HEX_64.test(manifest.streamSha256)
  ) {
    throw new Error("Invalid transfer manifest.");
  }
  validatePortableRootName(manifest.rootName);
  const expected = bytesToHex(
    sha256(
      new TextEncoder().encode(
        canonicalManifest({
          transferId: manifest.transferId,
          rootName: manifest.rootName,
          totalBytes: Number(manifest.totalBytes),
          blockSize: manifest.blockSize,
          streamSha256: manifest.streamSha256,
        }),
      ),
    ),
  );
  if (expected !== manifest.manifestId) throw new Error("Transfer manifest identity does not match.");
  return manifest as OfflineTransferManifest;
}

function canonicalManifest(value: {
  transferId: string;
  rootName: string;
  totalBytes: number;
  blockSize: number;
  streamSha256: string;
}): string {
  return JSON.stringify({
    v: 1,
    transferId: value.transferId,
    rootName: value.rootName,
    totalBytes: value.totalBytes,
    blockSize: value.blockSize,
    streamSha256: value.streamSha256,
  });
}

function hashDataBlock(routingHeader: Uint8Array, payload: Uint8Array): Uint8Array {
  return sha256.create()
    .update(DATA_DIGEST_DOMAIN)
    .update(routingHeader)
    .update(payload)
    .digest();
}
