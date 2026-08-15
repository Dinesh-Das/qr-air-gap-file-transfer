import { sha256 } from "@noble/hashes/sha2.js";
import {
  QRF3_MAX_BLOCK_SIZE,
  QRF3_MAX_ROOT_NAME_BYTES,
  Qrf3BlobSource,
  Qrf3TransferPurpose,
  createQrf3Transfer,
  encodeQrf3Manifest,
  type Qrf3Manifest,
  type Qrf3TransferPlan,
} from "./stream-protocol";

export const QRF3_CONNECTION_TEST_BYTES = 4 * 1024;
export const QRF3_CONNECTION_TEST_ROOT_NAME = "QRF3 Connection Test";

const PROBE_MAGIC = new TextEncoder().encode("QRF3PRB1");
const RECEIPT_DOMAIN = new TextEncoder().encode("QRF3-CONNECTION-RECEIPT\0");
const RECEIPT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX_BYTES = 118;

export interface Qrf3FilesBinding {
  transferId: Uint8Array;
  manifestId: Uint8Array;
  streamSha256: Uint8Array;
  connectionId: Uint8Array;
  transferLength: number;
  blockSize: number;
  rootName: string;
}

export interface PreparedQrf3ConnectionTest {
  bytes: Uint8Array;
  transfer: Qrf3TransferPlan;
  filesBinding: Qrf3FilesBinding;
  receiptCode: string;
}

export function createQrf3FilesBinding(
  plan: Qrf3TransferPlan,
): Qrf3FilesBinding {
  const manifest = plan.manifest;
  if (manifest.purpose !== Qrf3TransferPurpose.Files) {
    throw new Error("Only a QRF3 Files plan can be bound to a connection test.");
  }
  return {
    transferId: manifest.transferId.slice(),
    manifestId: plan.manifestId.slice(),
    streamSha256: manifest.archiveSha256.slice(),
    connectionId: manifest.connectionId.slice(),
    transferLength: manifest.transferLength,
    blockSize: manifest.blockSize,
    rootName: manifest.rootName,
  };
}

export async function prepareQrf3ConnectionTest(
  filesPlan: Qrf3TransferPlan,
): Promise<PreparedQrf3ConnectionTest> {
  const binding = createQrf3FilesBinding(filesPlan);
  const bytes = encodeProbe(binding);
  const transfer = await createQrf3Transfer(new Qrf3BlobSource(new Blob([Uint8Array.from(bytes)])), {
    rootName: QRF3_CONNECTION_TEST_ROOT_NAME,
    blockSize: binding.blockSize,
    purpose: Qrf3TransferPurpose.ConnectionTest,
    connectionId: binding.connectionId,
  });
  return {
    bytes,
    transfer,
    filesBinding: cloneBinding(binding),
    receiptCode: deriveQrf3ReceiptCode(bytes, transfer.manifest),
  };
}

export function verifyQrf3ConnectionTest(
  bytes: Uint8Array,
  probeManifest: Qrf3Manifest,
): { filesBinding: Qrf3FilesBinding; receiptCode: string } {
  encodeQrf3Manifest(probeManifest);
  assertCanonicalQrf3ConnectionTestManifest(probeManifest);
  if (!(bytes instanceof Uint8Array) || bytes.length !== QRF3_CONNECTION_TEST_BYTES) {
    throw new Error("This is not a complete QRF3 connection-test stream.");
  }
  const binding = decodeProbe(bytes);
  if (!bytesEqual(binding.connectionId, probeManifest.connectionId)) {
    throw new Error("The connection test is bound to a different session.");
  }
  if (binding.blockSize !== probeManifest.blockSize) {
    throw new Error("The connection test does not use the bound Files block size.");
  }
  if (!bytesEqual(sha256(bytes), probeManifest.archiveSha256)) {
    throw new Error("The QRF3 connection-test stream failed its SHA-256 check.");
  }
  return {
    filesBinding: binding,
    receiptCode: deriveQrf3ReceiptCode(bytes, probeManifest),
  };
}

/**
 * Checks the fixed probe envelope without touching durable block storage. The
 * receiver calls this as soon as a manifest is validated so an arbitrary
 * connection-test allocation cannot be created first.
 */
export function assertCanonicalQrf3ConnectionTestManifest(
  manifest: Qrf3Manifest,
): void {
  if (
    manifest.purpose !== Qrf3TransferPurpose.ConnectionTest ||
    manifest.transferLength !== QRF3_CONNECTION_TEST_BYTES ||
    manifest.rootName !== QRF3_CONNECTION_TEST_ROOT_NAME
  ) {
    throw new Error(
      "A QRF3 connection test must use the fixed 4 KiB probe and canonical root name.",
    );
  }
}

export function matchesQrf3FilesBinding(
  binding: Qrf3FilesBinding,
  planOrManifest: Qrf3TransferPlan | Qrf3Manifest,
  manifestId?: Uint8Array,
): boolean {
  const isPlan = "manifestId" in planOrManifest;
  const manifest = isPlan ? planOrManifest.manifest : planOrManifest;
  const identity = isPlan ? planOrManifest.manifestId : manifestId;
  return (
    manifest.purpose === Qrf3TransferPurpose.Files &&
    identity instanceof Uint8Array &&
    bytesEqual(binding.transferId, manifest.transferId) &&
    bytesEqual(binding.manifestId, identity) &&
    bytesEqual(binding.streamSha256, manifest.archiveSha256) &&
    bytesEqual(binding.connectionId, manifest.connectionId) &&
    binding.transferLength === manifest.transferLength &&
    binding.blockSize === manifest.blockSize &&
    binding.rootName === manifest.rootName
  );
}

export function formatQrf3ReceiptCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^0-9A-Z]/g, "");
  return normalized.length <= 5
    ? normalized
    : `${normalized.slice(0, 5)}-${normalized.slice(5, 10)}`;
}

export function validateQrf3ReceiptCode(
  input: string,
  expected: string,
): boolean {
  const left = formatQrf3ReceiptCode(input).replace("-", "");
  const right = formatQrf3ReceiptCode(expected).replace("-", "");
  if (left.length !== 10 || right.length !== 10) return false;
  let difference = 0;
  for (let index = 0; index < 10; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function encodeProbe(binding: Qrf3FilesBinding): Uint8Array {
  assertBinding(binding);
  const rootName = new TextEncoder().encode(binding.rootName);
  if (rootName.length > 255) {
    throw new Error("The root name is too long for the QRF3 probe.");
  }
  const bytes = new Uint8Array(QRF3_CONNECTION_TEST_BYTES);
  crypto.getRandomValues(bytes);
  bytes.set(PROBE_MAGIC, 0);
  bytes.set(binding.connectionId, 8);
  bytes.set(binding.transferId, 24);
  bytes.set(binding.manifestId, 40);
  bytes.set(binding.streamSha256, 72);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(104, BigInt(binding.transferLength), true);
  view.setUint32(112, binding.blockSize, true);
  view.setUint16(116, rootName.length, true);
  bytes.set(rootName, PREFIX_BYTES);
  return bytes;
}

function decodeProbe(bytes: Uint8Array): Qrf3FilesBinding {
  if (!(bytes instanceof Uint8Array) || bytes.length !== QRF3_CONNECTION_TEST_BYTES) {
    throw new Error("The QRF3 probe has the wrong length.");
  }
  if (!bytesEqual(bytes.subarray(0, 8), PROBE_MAGIC)) {
    throw new Error("The QRF3 probe marker is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const transferLength = view.getBigUint64(104, true);
  if (transferLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The QRF3 probe length exceeds the browser integer range.");
  }
  const rootNameLength = view.getUint16(116, true);
  if (rootNameLength > 255 || PREFIX_BYTES + rootNameLength > bytes.length) {
    throw new Error("The QRF3 probe root name is invalid.");
  }
  let rootName: string;
  try {
    rootName = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + rootNameLength),
    );
  } catch {
    throw new Error("The QRF3 probe root name is not valid UTF-8.");
  }
  const binding: Qrf3FilesBinding = {
    connectionId: bytes.slice(8, 24),
    transferId: bytes.slice(24, 40),
    manifestId: bytes.slice(40, 72),
    streamSha256: bytes.slice(72, 104),
    transferLength: Number(transferLength),
    blockSize: view.getUint32(112, true),
    rootName,
  };
  assertBinding(binding);
  return binding;
}

function deriveQrf3ReceiptCode(
  bytes: Uint8Array,
  manifest: Qrf3Manifest,
): string {
  const input = new Uint8Array(
    RECEIPT_DOMAIN.length + bytes.length + manifest.transferId.length,
  );
  input.set(RECEIPT_DOMAIN, 0);
  input.set(bytes, RECEIPT_DOMAIN.length);
  input.set(manifest.transferId, RECEIPT_DOMAIN.length + bytes.length);
  const digest = sha256(input);
  let bits = 0n;
  for (let index = 0; index < 7; index += 1) {
    bits = (bits << 8n) | BigInt(digest[index]);
  }
  const characters: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    characters.push(RECEIPT_ALPHABET[Number((bits >> BigInt(50 - index * 5)) & 31n)]);
  }
  return `${characters.slice(0, 5).join("")}-${characters.slice(5).join("")}`;
}

function assertBinding(binding: Qrf3FilesBinding): void {
  assertBytes(binding.connectionId, 16, "connection ID");
  assertBytes(binding.transferId, 16, "transfer ID");
  assertBytes(binding.manifestId, 32, "manifest identity");
  assertBytes(binding.streamSha256, 32, "stream SHA-256");
  if (!Number.isSafeInteger(binding.transferLength) || binding.transferLength < 0) {
    throw new Error("The bound transfer length is invalid.");
  }
  if (
    !Number.isSafeInteger(binding.blockSize) ||
    binding.blockSize < 1 ||
    binding.blockSize > QRF3_MAX_BLOCK_SIZE
  ) {
    throw new Error("The bound block size is invalid.");
  }
  if (
    typeof binding.rootName !== "string" ||
    binding.rootName.length === 0 ||
    binding.rootName !== binding.rootName.normalize("NFC") ||
    binding.rootName === "." ||
    binding.rootName === ".." ||
    binding.rootName.includes("/") ||
    binding.rootName.includes("\\") ||
    binding.rootName.includes("\0") ||
    new TextEncoder().encode(binding.rootName).length > QRF3_MAX_ROOT_NAME_BYTES
  ) {
    throw new Error("The bound root name is invalid.");
  }
}

function assertBytes(bytes: Uint8Array, length: number, field: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error(`The ${field} must contain exactly ${length} bytes.`);
  }
}

function cloneBinding(binding: Qrf3FilesBinding): Qrf3FilesBinding {
  return {
    ...binding,
    transferId: binding.transferId.slice(),
    manifestId: binding.manifestId.slice(),
    streamSha256: binding.streamSha256.slice(),
    connectionId: binding.connectionId.slice(),
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
