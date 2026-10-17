import { sha256 } from "@noble/hashes/sha2.js";
import {
  LARGE_TREE_READ_BYTES,
  parseLargeTreeMetadata,
  type LargeTreeFile,
  type LargeTreeManifest,
  type RandomAccessReader,
} from "./large-transfer";

export const LARGE_DESTINATION_CHUNK_BYTES = 4 * 1024 * 1024;
export const LARGE_DESTINATION_MARKER = ".airgap-qr-v3.partial.json";

// Overlap small-file filesystem round trips without multiplying the 4 MiB
// large-file read buffer. Every check still resolves its current path anew.
const SMALL_DESTINATION_FILE_BYTES = 64 * 1024;
const SMALL_DESTINATION_FILE_CONCURRENCY = 4;

// TypeScript's DOM declarations omit the standard optional minimum read size:
// https://streams.spec.whatwg.org/#byob-reader-read
interface MinimumByteReader extends ReadableStreamBYOBReader {
  read<T extends ArrayBufferView>(view: T, options?: { min: number }): Promise<ReadableStreamReadResult<T>>;
}

const JOURNAL_SCHEMA = "airgap-qr-destination-journal" as const;
const JOURNAL_VERSION = 1 as const;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const TRANSFER_ID_BYTES = 16;
const SHA256_BYTES = 32;
// File System handles do not expose a stable cross-tab string identity that can
// safely name a Web Lock. Serialize all destination mutations for this origin;
// optical transfer time dwarfs destination-write time, and correctness matters
// more than parallel reconstruction of unrelated trees.
const DESTINATION_WRITE_LOCK = "airgap-qr-large-destination-write-v1";

export interface LargeDestinationBinding {
  /** The exact QRF3 transfer id. */
  transferId: Uint8Array;
  /** SHA-256 of the complete QRF3 virtual stream. */
  streamSha256: Uint8Array;
}

export interface LargeDestinationProgress {
  phase: "resume-check" | "write" | "verify";
  path?: string;
  filesComplete: number;
  filesTotal: number;
  bytesComplete: bigint;
  bytesTotal: bigint;
}

export interface LargeDestinationOptions {
  /** May be lowered for constrained devices, but never raised above 4 MiB. */
  chunkBytes?: number;
  signal?: AbortSignal;
  onProgress?: (progress: LargeDestinationProgress) => void;
}

export interface LargeDestinationReport {
  rootName: string;
  filesWritten: number;
  filesReused: number;
  directoriesVerified: number;
  totalBytes: bigint;
  resumed: boolean;
}

interface DestinationPlan {
  manifest: LargeTreeManifest;
  expectedKinds: Map<string, "file" | "directory">;
  directories: string[];
  transferIdHex: string;
  streamSha256Hex: string;
  metadataSha256Hex: string;
}

interface DestinationJournal {
  schema: typeof JOURNAL_SCHEMA;
  version: typeof JOURNAL_VERSION;
  transferId: string;
  streamSha256: string;
  metadataSha256: string;
  rootName: string;
  totalFileBytes: string;
  fileCount: number;
  completed: string;
}

/**
 * Reconstructs a validated v3 virtual tree beneath its manifest root.
 *
 * The received stream and every destination file are read incrementally. A
 * marker in the app-owned root binds partial files to one exact transfer and
 * stores one completion bit per file, making a closed file resumable without
 * putting its contents in IndexedDB or memory.
 */
export async function writeLargeTreeToDirectory(
  manifest: LargeTreeManifest,
  reader: RandomAccessReader,
  binding: LargeDestinationBinding,
  destinationParent: FileSystemDirectoryHandle,
  options: LargeDestinationOptions = {},
): Promise<LargeDestinationReport> {
  const chunkBytes = validateChunkBytes(options.chunkBytes);
  const plan = createDestinationPlan(manifest, reader, binding);

  return withDestinationLock(DESTINATION_WRITE_LOCK, async () => {
    throwIfAborted(options.signal);
    const existingRoot = await tryGetDirectoryHandle(
      destinationParent,
      plan.manifest.rootName,
    );
    const root =
      existingRoot ??
      (await destinationParent.getDirectoryHandle(plan.manifest.rootName, {
        create: true,
      }));
    assertExactHandleName(root, plan.manifest.rootName, "folder");

    const marker = await tryGetFileHandle(root, LARGE_DESTINATION_MARKER);
    let completed: Uint8Array;
    let resumed = false;

    if (marker) {
      completed = await readMatchingJournal(marker, plan);
      resumed = true;
      await assertPartialDestination(root, plan, options.signal);
    } else if (await isDirectoryEmpty(root)) {
      completed = new Uint8Array(bitsetLength(plan.manifest.files.length));
      try {
        await writeJournal(root, plan, completed);
      } catch (error) {
        // A newly-created file handle can exist even if its first safe-write
        // never commits. Since this branch proved the root was empty, removing
        // that failed claim cannot affect user data and keeps retries usable.
        try {
          await root.removeEntry(LARGE_DESTINATION_MARKER);
        } catch {
          // Preserve the journal failure that prevented a durable claim.
        }
        throw error;
      }
    } else {
      // A marker-free exact tree is a safe idempotent retry. Anything else is
      // unrelated user data and must remain completely untouched.
      try {
        await verifyCompleteDestination(root, plan, chunkBytes, options);
      } catch (error) {
        throwIfAborted(options.signal);
        throw new Error(
          `The destination folder ${JSON.stringify(plan.manifest.rootName)} is non-empty and is not an exact completed copy of this transfer. Choose another folder; no files were changed. (${toError(error).message})`,
        );
      }
      return {
        rootName: plan.manifest.rootName,
        filesWritten: 0,
        filesReused: plan.manifest.files.length,
        directoriesVerified: plan.directories.length,
        totalBytes: plan.manifest.totalFileBytes,
        resumed: false,
      };
    }

    await ensureDirectories(root, plan.directories, options.signal);

    let filesWritten = 0;
    let filesReused = 0;
    let bytesComplete = 0n;
    let savedCheckStart = -1;
    let savedChecks: PromiseSettledResult<boolean>[] = [];

    for (let index = 0; index < plan.manifest.files.length;) {
      throwIfAborted(options.signal);
      const file = plan.manifest.files[index];
      if (getBit(completed, index)) {
        options.onProgress?.({
          phase: "resume-check",
          path: file.path,
          filesComplete: index,
          filesTotal: plan.manifest.files.length,
          bytesComplete,
          bytesTotal: plan.manifest.totalFileBytes,
        });
        throwIfAborted(options.signal);
        if (index < savedCheckStart || index >= savedCheckStart + savedChecks.length) {
          let end = smallFileBatchEnd(plan.manifest.files, index);
          for (let next = index + 1; next < end; next++) {
            if (!getBit(completed, next)) { end = next; break; }
          }
          savedCheckStart = index;
          // Keep only a bounded group of results, never handles from writing.
          // Final verification resolves all paths again after any repairs.
          savedChecks = await Promise.allSettled(plan.manifest.files.slice(index, end).map(
            (entry) => destinationFileMatches(root, entry, chunkBytes, options.signal),
          ));
          throwIfAborted(options.signal);
        }
        const savedCheck = savedChecks[index - savedCheckStart];
        if (savedCheck.status === "rejected") throw savedCheck.reason;
        if (savedCheck.value) {
          filesReused += 1;
          bytesComplete += file.size;
          index++;
          continue;
        }
        // The user or another process changed a previously committed file.
        // Clear the durable bit before repairing it so interruption stays safe.
        setBit(completed, index, false);
        await writeJournal(root, plan, completed);
      }

      let end = smallFileBatchEnd(plan.manifest.files, index);
      for (let next = index + 1; next < end; next++) {
        if (getBit(completed, next)) { end = next; break; }
      }
      const progressBase = {
        filesComplete: index, filesTotal: plan.manifest.files.length,
        bytesComplete, bytesTotal: plan.manifest.totalFileBytes,
      };
      const writes = await Promise.allSettled(plan.manifest.files.slice(index, end).map(
        (entry) => writeOneFile(root, entry, reader, chunkBytes, options, progressBase),
      ));
      throwIfAborted(options.signal);
      // Payloads may close concurrently, but journal mutations stay ordered:
      // one durable completion bit per successfully closed and hashed file.
      // Unjournalled closed files are safely rewritten after an interruption.
      for (const result of writes) {
        if (result.status === "rejected") throw result.reason;
        const written = plan.manifest.files[index];
        setBit(completed, index, true);
        await writeJournal(root, plan, completed);
        filesWritten += 1;
        bytesComplete += written.size;
        index++;
        options.onProgress?.({
          phase: "write", path: written.path,
          filesComplete: index, filesTotal: plan.manifest.files.length,
          bytesComplete, bytesTotal: plan.manifest.totalFileBytes,
        });
        throwIfAborted(options.signal);
      }
    }

    // Do not remove the ownership marker until both the exact path/type set and
    // every destination file hash have been re-read and verified.
    await verifyCompleteDestination(root, plan, chunkBytes, options);
    await root.removeEntry(LARGE_DESTINATION_MARKER);

    return {
      rootName: plan.manifest.rootName,
      filesWritten,
      filesReused,
      directoriesVerified: plan.directories.length,
      totalBytes: plan.manifest.totalFileBytes,
      resumed,
    };
  }, options.signal);
}

function createDestinationPlan(
  suppliedManifest: LargeTreeManifest,
  reader: RandomAccessReader,
  binding: LargeDestinationBinding,
): DestinationPlan {
  if (binding.transferId.length !== TRANSFER_ID_BYTES) {
    throw new Error(`Transfer id must be exactly ${TRANSFER_ID_BYTES} bytes.`);
  }
  if (binding.streamSha256.length !== SHA256_BYTES) {
    throw new Error(`Stream SHA-256 must be exactly ${SHA256_BYTES} bytes.`);
  }

  // Reparse the signed/canonical bytes instead of trusting an object assembled
  // by UI code. This reapplies traversal, alias, reserved-name and tree-conflict
  // validation from the v3 manifest boundary.
  const manifest = parseLargeTreeMetadata(suppliedManifest.metadataBytes);
  if (!bytesEqual(manifest.metadataSha256, suppliedManifest.metadataSha256)) {
    throw new Error("Tree metadata does not match its supplied SHA-256.");
  }
  if (reader.size < manifest.totalFileBytes) {
    throw new Error("The received stream is shorter than its file layout.");
  }

  const markerAlias = pathAlias(LARGE_DESTINATION_MARKER);
  for (const path of [
    ...manifest.directories,
    ...manifest.files.map((file) => file.path),
  ]) {
    if (pathAlias(path.split("/", 1)[0]) === markerAlias) {
      throw new Error(
        `The received tree conflicts with the reserved recovery marker: ${path}`,
      );
    }
  }

  const expectedKinds = new Map<string, "file" | "directory">();
  const directorySet = new Set<string>();
  for (const directory of manifest.directories) {
    addParentDirectories(directory, directorySet);
    directorySet.add(directory);
  }
  for (const file of manifest.files) {
    addParentDirectories(file.path, directorySet);
  }
  const directories = Array.from(directorySet).sort(compareDirectories);
  for (const directory of directories) expectedKinds.set(directory, "directory");
  for (const file of manifest.files) expectedKinds.set(file.path, "file");

  return {
    manifest,
    expectedKinds,
    directories,
    transferIdHex: bytesToHex(binding.transferId),
    streamSha256Hex: bytesToHex(binding.streamSha256),
    metadataSha256Hex: bytesToHex(manifest.metadataSha256),
  };
}

async function writeOneFile(
  root: FileSystemDirectoryHandle,
  file: LargeTreeFile,
  reader: RandomAccessReader,
  chunkBytes: number,
  options: LargeDestinationOptions,
  progressBase: {
    filesComplete: number;
    filesTotal: number;
    bytesComplete: bigint;
    bytesTotal: bigint;
  },
): Promise<void> {
  const segments = file.path.split("/");
  const name = segments.pop();
  if (!name) throw new Error(`Invalid empty destination file name: ${file.path}`);
  const parent = await descendDirectory(root, segments, false, options.signal);
  const handle = await parent.getFileHandle(name, { create: true });
  throwIfAborted(options.signal);
  assertExactHandleName(handle, name, "file");
  const writable = await handle.createWritable({ keepExistingData: false });
  const hasher = sha256.create();
  let relativeOffset = 0n;

  try {
    while (relativeOffset < file.size) {
      throwIfAborted(options.signal);
      const remaining = file.size - relativeOffset;
      const length = Number(
        remaining < BigInt(chunkBytes) ? remaining : BigInt(chunkBytes),
      );
      const chunk = await reader.read(file.offset + relativeOffset, length);
      throwIfAborted(options.signal);
      if (chunk.length !== length) {
        throw new Error(`The received stream returned a truncated range for ${file.path}.`);
      }
      hasher.update(chunk);
      // Some readers may expose a SharedArrayBuffer-backed view. Copying this
      // one bounded chunk gives File System Access an ordinary BufferSource.
      await writable.write(Uint8Array.from(chunk));
      relativeOffset += BigInt(length);
      options.onProgress?.({
        phase: "write",
        path: file.path,
        filesComplete: progressBase.filesComplete,
        filesTotal: progressBase.filesTotal,
        bytesComplete: progressBase.bytesComplete + relativeOffset,
        bytesTotal: progressBase.bytesTotal,
      });
    }
    throwIfAborted(options.signal);
    const actualHash = bytesToHex(hasher.digest());
    if (actualHash !== file.sha256Hex) {
      throw new Error(
        `SHA-256 mismatch in received bytes for ${file.path}: expected ${file.sha256Hex}, got ${actualHash}.`,
      );
    }
    await writable.close();
  } catch (error) {
    try {
      await writable.abort(error);
    } catch {
      // Preserve the source/hash/write failure that made the file unsafe.
    }
    throw error;
  }
}

async function verifyCompleteDestination(
  root: FileSystemDirectoryHandle,
  plan: DestinationPlan,
  chunkBytes: number,
  options: LargeDestinationOptions,
): Promise<void> {
  const actual = await scanDestination(root, plan.expectedKinds.size, options.signal);
  for (const [path, expectedKind] of plan.expectedKinds) {
    const actualKind = actual.get(path);
    if (actualKind !== expectedKind) {
      throw new Error(
        actualKind === undefined
          ? `Destination is missing ${expectedKind} ${path}.`
          : `Destination path ${path} is a ${actualKind}, not a ${expectedKind}.`,
      );
    }
  }
  for (const path of actual.keys()) {
    if (!plan.expectedKinds.has(path)) {
      throw new Error(`Destination contains unrelated path ${path}.`);
    }
  }

  let bytesComplete = 0n;
  for (let index = 0; index < plan.manifest.files.length;) {
    throwIfAborted(options.signal);
    const file = plan.manifest.files[index];
    options.onProgress?.({
      phase: "verify",
      path: file.path,
      filesComplete: index,
      filesTotal: plan.manifest.files.length,
      bytesComplete,
      bytesTotal: plan.manifest.totalFileBytes,
    });
    throwIfAborted(options.signal);
    const end = smallFileBatchEnd(plan.manifest.files, index);
    // Drain every read before throwing, so cancellation or one failed check
    // cannot release the destination lock while another check is still running.
    const results = await Promise.allSettled(plan.manifest.files.slice(index, end).map(
      (entry) => destinationFileMatches(root, entry, chunkBytes, options.signal),
    ));
    throwIfAborted(options.signal);
    for (const result of results) {
      const checked = plan.manifest.files[index];
      if (result.status === "rejected") throw result.reason;
      if (!result.value) throw new Error(`Destination SHA-256 or size mismatch for ${checked.path}.`);
      bytesComplete += checked.size;
      index++;
      options.onProgress?.({
        phase: "verify",
        path: checked.path,
        filesComplete: index,
        filesTotal: plan.manifest.files.length,
        bytesComplete,
        bytesTotal: plan.manifest.totalFileBytes,
      });
      throwIfAborted(options.signal);
    }
  }
  options.onProgress?.({
    phase: "verify",
    filesComplete: plan.manifest.files.length,
    filesTotal: plan.manifest.files.length,
    bytesComplete,
    bytesTotal: plan.manifest.totalFileBytes,
  });
  throwIfAborted(options.signal);
}

function smallFileBatchEnd(files: readonly LargeTreeFile[], start: number): number {
  let end = start + 1;
  if (files[start].size <= BigInt(SMALL_DESTINATION_FILE_BYTES)) {
    while (
      end < files.length &&
      end - start < SMALL_DESTINATION_FILE_CONCURRENCY &&
      files[end].size <= BigInt(SMALL_DESTINATION_FILE_BYTES)
    ) end++;
  }
  return end;
}

async function destinationFileMatches(
  root: FileSystemDirectoryHandle,
  expected: LargeTreeFile,
  chunkBytes: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const segments = expected.path.split("/");
  const name = segments.pop();
  if (!name) return false;
  let directory: FileSystemDirectoryHandle;
  let handle: FileSystemFileHandle;
  try {
    directory = await descendDirectory(root, segments, false, signal);
    handle = await directory.getFileHandle(name);
  } catch (error) {
    if (isNotFoundOrTypeMismatch(error)) return false;
    throw error;
  }
  assertExactHandleName(handle, name, "file");
  const file = await handle.getFile();
  if (!Number.isSafeInteger(file.size) || BigInt(file.size) !== expected.size) {
    return false;
  }
  const hasher = sha256.create();
  if (file.size > SMALL_DESTINATION_FILE_BYTES) {
    // Repeated slice().arrayBuffer() leaves large external allocations waiting
    // for collection. A BYOB read transfers this backing store and returns it
    // for reuse, keeping large-file readback at one configured chunk.
    const reader: MinimumByteReader = file.stream().getReader({ mode: "byob" });
    const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    let buffer = new Uint8Array(chunkBytes);
    let completed = 0;
    try {
      while (completed < file.size) {
        throwIfAborted(signal);
        const { value, done } = await reader.read(buffer, { min: Math.min(chunkBytes, file.size - completed) });
        throwIfAborted(signal);
        if (!value?.byteLength || value.byteLength > file.size - completed) return false;
        hasher.update(value);
        completed += value.byteLength;
        buffer = new Uint8Array(value.buffer);
        if (done && completed < file.size) return false;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      // Cancellation also drains a pending read. Preserve its original error
      // if closing an already errored stream rejects.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      throwIfAborted(signal);
      const end = Math.min(file.size, offset + chunkBytes);
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      if (chunk.length !== end - offset) return false;
      hasher.update(chunk);
    }
  }
  return bytesToHex(hasher.digest()) === expected.sha256Hex;
}

async function assertPartialDestination(
  root: FileSystemDirectoryHandle,
  plan: DestinationPlan,
  signal?: AbortSignal,
): Promise<void> {
  const actual = await scanDestination(root, plan.expectedKinds.size, signal);
  for (const [path, kind] of actual) {
    const expectedKind = plan.expectedKinds.get(path);
    if (expectedKind === undefined) {
      throw new Error(
        `The app-owned partial destination contains unrelated path ${path}.`,
      );
    }
    if (expectedKind !== kind) {
      throw new Error(
        `The partial destination path ${path} is a ${kind}, not a ${expectedKind}.`,
      );
    }
  }
}

async function scanDestination(
  root: FileSystemDirectoryHandle,
  maximumPaths: number,
  signal?: AbortSignal,
): Promise<Map<string, "file" | "directory">> {
  const paths = new Map<string, "file" | "directory">();

  async function walk(directory: FileSystemDirectoryHandle, prefix: string) {
    throwIfAborted(signal);
    for await (const [name, handle] of directory.entries()) {
      throwIfAborted(signal);
      if (!prefix && name === LARGE_DESTINATION_MARKER) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (paths.has(path)) {
        throw new Error(`Destination enumerated duplicate path ${path}.`);
      }
      paths.set(path, handle.kind);
      if (paths.size > maximumPaths) {
        throw new Error("Destination contains more paths than this transfer.");
      }
      if (handle.kind === "directory") await walk(handle, path);
    }
  }

  await walk(root, "");
  return paths;
}

async function ensureDirectories(
  root: FileSystemDirectoryHandle,
  directories: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  for (const path of directories) {
    await descendDirectory(root, path.split("/"), true, signal);
  }
}

async function descendDirectory(
  root: FileSystemDirectoryHandle,
  segments: readonly string[],
  create: boolean,
  signal?: AbortSignal,
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of segments) {
    throwIfAborted(signal);
    const next = await current.getDirectoryHandle(segment, { create });
    throwIfAborted(signal);
    assertExactHandleName(next, segment, "folder");
    current = next;
  }
  return current;
}

async function readMatchingJournal(
  marker: FileSystemFileHandle,
  plan: DestinationPlan,
): Promise<Uint8Array> {
  const file = await marker.getFile();
  if (file.size > MAX_JOURNAL_BYTES) {
    throw new Error("The destination recovery marker exceeds its safety limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error("The destination recovery marker is invalid.");
  }
  if (!isRecord(value)) throw new Error("The destination recovery marker is invalid.");
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "completed",
    "fileCount",
    "metadataSha256",
    "rootName",
    "schema",
    "streamSha256",
    "totalFileBytes",
    "transferId",
    "version",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.schema !== JOURNAL_SCHEMA ||
    value.version !== JOURNAL_VERSION ||
    value.transferId !== plan.transferIdHex ||
    value.streamSha256 !== plan.streamSha256Hex ||
    value.metadataSha256 !== plan.metadataSha256Hex ||
    value.rootName !== plan.manifest.rootName ||
    value.totalFileBytes !== String(plan.manifest.totalFileBytes) ||
    value.fileCount !== plan.manifest.files.length ||
    typeof value.completed !== "string"
  ) {
    throw new Error(
      "The destination recovery marker belongs to a different or unsupported transfer.",
    );
  }
  const completed = base64ToBytes(value.completed);
  if (completed.length !== bitsetLength(plan.manifest.files.length)) {
    throw new Error("The destination recovery marker has an invalid completion bitset.");
  }
  const unusedBits = completed.length * 8 - plan.manifest.files.length;
  if (unusedBits > 0 && (completed.at(-1)! >>> (8 - unusedBits)) !== 0) {
    throw new Error("The destination recovery marker sets unknown completion bits.");
  }
  return completed;
}

async function writeJournal(
  root: FileSystemDirectoryHandle,
  plan: DestinationPlan,
  completed: Uint8Array,
): Promise<void> {
  const journal: DestinationJournal = {
    schema: JOURNAL_SCHEMA,
    version: JOURNAL_VERSION,
    transferId: plan.transferIdHex,
    streamSha256: plan.streamSha256Hex,
    metadataSha256: plan.metadataSha256Hex,
    rootName: plan.manifest.rootName,
    totalFileBytes: String(plan.manifest.totalFileBytes),
    fileCount: plan.manifest.files.length,
    completed: bytesToBase64(completed),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(journal));
  if (encoded.length > MAX_JOURNAL_BYTES) {
    throw new Error("The destination recovery marker exceeds its safety limit.");
  }
  const marker = await root.getFileHandle(LARGE_DESTINATION_MARKER, {
    create: true,
  });
  assertExactHandleName(marker, LARGE_DESTINATION_MARKER, "file");
  const writable = await marker.createWritable({ keepExistingData: false });
  try {
    await writable.write(encoded);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort(error);
    } catch {
      // Preserve the journal write failure.
    }
    throw error;
  }
}

function addParentDirectories(path: string, output: Set<string>): void {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    output.add(segments.slice(0, index).join("/"));
  }
}

function compareDirectories(left: string, right: string): number {
  const depth = left.split("/").length - right.split("/").length;
  return depth !== 0 ? depth : left < right ? -1 : left > right ? 1 : 0;
}

function validateChunkBytes(value = LARGE_DESTINATION_CHUNK_BYTES): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > LARGE_DESTINATION_CHUNK_BYTES ||
    value > LARGE_TREE_READ_BYTES
  ) {
    throw new Error(
      `Destination chunks must be between 1 and ${LARGE_DESTINATION_CHUNK_BYTES.toLocaleString()} bytes.`,
    );
  }
  return value;
}

function bitsetLength(fileCount: number): number {
  return Math.ceil(fileCount / 8);
}

function getBit(bits: Uint8Array, index: number): boolean {
  return (bits[index >>> 3] & (1 << (index & 7))) !== 0;
}

function setBit(bits: Uint8Array, index: number, value: boolean): void {
  const mask = 1 << (index & 7);
  if (value) bits[index >>> 3] |= mask;
  else bits[index >>> 3] &= ~mask;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 32_768;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("The destination recovery marker has invalid base64.");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("The destination recovery marker has invalid base64.");
  }
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  if (bytesToBase64(output) !== value) {
    throw new Error("The destination recovery marker is not canonical base64.");
  }
  return output;
}

async function tryGetDirectoryHandle(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function tryGetFileHandle(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | undefined> {
  try {
    return await parent.getFileHandle(name);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function isDirectoryEmpty(directory: FileSystemDirectoryHandle) {
  for await (const _entry of directory.entries()) return false;
  return true;
}

function assertExactHandleName(
  handle: FileSystemHandle,
  expected: string,
  kind: string,
): void {
  if (handle.name !== expected) {
    throw new Error(
      `Destination normalized a ${kind} name from ${JSON.stringify(expected)} to ${JSON.stringify(handle.name)}.`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function isNotFoundOrTypeMismatch(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotFoundError" || error.name === "TypeMismatchError")
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was cancelled.", "AbortError");
  }
}

async function withDestinationLock<T>(
  name: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(name, { mode: "exclusive", signal }, operation);
  }
  return operation();
}

function pathAlias(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
