import { sha256 } from "@noble/hashes/sha2.js";
import { validateArchivePath, validatePortableRootName } from "./archive";

export const LARGE_TREE_SCHEMA = "airgap-qr-tree" as const;
export const LARGE_TREE_VERSION = 3 as const;
export const LARGE_TREE_FOOTER_BYTES = 16;
export const LARGE_TREE_READ_BYTES = 4 * 1024 * 1024;
export const MAX_LARGE_TREE_ENTRIES = 100_000;
export const MAX_LARGE_TREE_METADATA_BYTES = 32 * 1024 * 1024;

const FOOTER_MAGIC = new TextEncoder().encode("QRF3END1");
const MAX_PATH_DEPTH = 64;
const MAX_PATH_BYTES = 4_096;
const MAX_SEGMENT_BYTES = 255;
const WINDOWS_RESERVED_NAME =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const OBJECT_MAGIC_NAME = /^(?:__proto__|constructor|prototype)$/;

export interface LargeSourceFile {
  path: string;
  handle: FileSystemFileHandle;
  size: number;
  lastModified: number;
}

export interface LargeSourceSelection {
  rootName: string;
  rootHandle: FileSystemDirectoryHandle;
  files: LargeSourceFile[];
  directories: string[];
  totalFileBytes: bigint;
}

export interface PreparedLargeSourceFile extends LargeSourceFile {
  offset: bigint;
  sha256Hex: string;
  /** An immutable, lazy browser snapshot; its bytes are not loaded eagerly. */
  snapshot: File;
}

export interface PreparedLargeSource {
  rootName: string;
  rootHandle: FileSystemDirectoryHandle;
  files: PreparedLargeSourceFile[];
  directories: string[];
  totalFileBytes: bigint;
  totalStreamBytes: bigint;
  metadataBytes: Uint8Array;
  trailerBytes: Uint8Array;
  metadataSha256: Uint8Array;
  streamSha256: Uint8Array;
}

export interface LargeTreeFile {
  path: string;
  offset: bigint;
  size: bigint;
  lastModified: number;
  sha256Hex: string;
}

export interface LargeTreeManifest {
  rootName: string;
  directories: string[];
  files: LargeTreeFile[];
  totalFileBytes: bigint;
  metadataBytes: Uint8Array;
  metadataSha256: Uint8Array;
}

export interface LargeTransferProgress {
  phase: "scan" | "hash";
  path?: string;
  filesComplete: number;
  filesTotal: number;
  bytesComplete: bigint;
  bytesTotal: bigint;
}

export interface RandomAccessReader {
  readonly size: bigint;
  read(offset: bigint, length: number): Promise<Uint8Array>;
}

/** Adapts the bigint virtual stream to QRF3's exact safe-integer source API. */
export function createQrf3LargeSource(source: PreparedLargeSource): {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
} {
  if (source.totalStreamBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      "The virtual source exceeds QRF3's exact browser integer range.",
    );
  }
  return {
    size: Number(source.totalStreamBytes),
    read(offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("QRF3 source offset must be a non-negative safe integer.");
      }
      return readPreparedLargeRange(source, BigInt(offset), length);
    },
  };
}

interface SerializedTreeManifest {
  schema: typeof LARGE_TREE_SCHEMA;
  version: typeof LARGE_TREE_VERSION;
  rootName: string;
  directories: string[];
  files: Array<{
    path: string;
    size: string;
    sha256: string;
    lastModified: number;
  }>;
}

/**
 * Enumerates a directory without loading file contents. The returned handles
 * can later serve small slices even when the selected tree is many gigabytes.
 */
export async function collectLargeDirectory(
  rootHandle: FileSystemDirectoryHandle,
  onProgress?: (progress: LargeTransferProgress) => void,
  signal?: AbortSignal,
): Promise<LargeSourceSelection> {
  const rootName = validatePortableRootName(rootHandle.name);
  const files: LargeSourceFile[] = [];
  const directories: string[] = [];
  const aliases = new Map<string, string>();
  let totalFileBytes = 0n;
  let discoveredEntries = 0;

  async function walk(
    directory: FileSystemDirectoryHandle,
    parentPath: string,
  ): Promise<void> {
    throwIfAborted(signal);
    const children: Array<
      [string, FileSystemFileHandle | FileSystemDirectoryHandle]
    > = [];
    for await (const child of directory.entries()) {
      throwIfAborted(signal);
      discoveredEntries += 1;
      if (discoveredEntries > MAX_LARGE_TREE_ENTRIES) {
        throw new Error(
          `The selected tree exceeds the ${MAX_LARGE_TREE_ENTRIES.toLocaleString()}-entry limit.`,
        );
      }
      children.push(child);
    }
    children.sort(([left], [right]) => comparePaths(left, right));

    for (const [name, handle] of children) {
      throwIfAborted(signal);
      const path = parentPath ? `${parentPath}/${name}` : name;
      validatePortablePath(path, aliases);
      if (handle.kind === "directory") {
        directories.push(path);
        await walk(handle, path);
      } else {
        const file = await handle.getFile();
        assertSafeFile(file, path);
        totalFileBytes += BigInt(file.size);
        files.push({
          path,
          handle,
          size: file.size,
          lastModified: file.lastModified,
        });
      }
      onProgress?.({
        phase: "scan",
        filesComplete: files.length,
        filesTotal: files.length,
        bytesComplete: totalFileBytes,
        bytesTotal: totalFileBytes,
      });
    }
  }

  await walk(rootHandle, "");
  files.sort((left, right) => comparePaths(left.path, right.path));
  directories.sort(comparePaths);
  assertTreeConflicts(files.map(({ path }) => path), directories);
  return { rootName, rootHandle, files, directories, totalFileBytes };
}

/**
 * Hashes the source a slice at a time and builds a deterministic virtual
 * stream: file bytes in canonical order, followed by compact tree metadata.
 */
export async function prepareLargeSource(
  selection: LargeSourceSelection,
  onProgress?: (progress: LargeTransferProgress) => void,
  signal?: AbortSignal,
): Promise<PreparedLargeSource> {
  validatePortableRootName(selection.rootName);
  const streamHasher = sha256.create();
  const preparedFiles: PreparedLargeSourceFile[] = [];
  let offset = 0n;
  let bytesComplete = 0n;

  for (let fileIndex = 0; fileIndex < selection.files.length; fileIndex += 1) {
    throwIfAborted(signal);
    const source = selection.files[fileIndex];
    const snapshot = await source.handle.getFile();
    assertUnchangedFile(source, snapshot);
    const fileHasher = sha256.create();

    for (let start = 0; start < snapshot.size; start += LARGE_TREE_READ_BYTES) {
      throwIfAborted(signal);
      const end = Math.min(snapshot.size, start + LARGE_TREE_READ_BYTES);
      const chunk = new Uint8Array(
        await snapshot.slice(start, end).arrayBuffer(),
      );
      fileHasher.update(chunk);
      streamHasher.update(chunk);
      bytesComplete += BigInt(chunk.length);
      onProgress?.({
        phase: "hash",
        path: source.path,
        filesComplete: fileIndex,
        filesTotal: selection.files.length,
        bytesComplete,
        bytesTotal: selection.totalFileBytes,
      });
      await yieldToBrowser();
    }

    preparedFiles.push({
      ...source,
      offset,
      sha256Hex: bytesToHex(fileHasher.digest()),
      snapshot,
    });
    offset += BigInt(snapshot.size);
    onProgress?.({
      phase: "hash",
      path: source.path,
      filesComplete: fileIndex + 1,
      filesTotal: selection.files.length,
      bytesComplete,
      bytesTotal: selection.totalFileBytes,
    });
  }

  if (offset !== selection.totalFileBytes) {
    throw new Error("The selected tree changed while it was being prepared.");
  }
  const metadataBytes = encodeLargeTreeMetadata({
    rootName: selection.rootName,
    directories: selection.directories,
    files: preparedFiles,
  });
  const trailerBytes = encodeTrailer(metadataBytes);
  streamHasher.update(trailerBytes);
  return {
    rootName: selection.rootName,
    rootHandle: selection.rootHandle,
    files: preparedFiles,
    directories: selection.directories.slice(),
    totalFileBytes: selection.totalFileBytes,
    totalStreamBytes: selection.totalFileBytes + BigInt(trailerBytes.length),
    metadataBytes,
    trailerBytes,
    metadataSha256: sha256(metadataBytes),
    streamSha256: streamHasher.digest(),
  };
}

/** Reads one bounded range from the virtual source without materializing it. */
export async function readPreparedLargeRange(
  source: PreparedLargeSource,
  offset: bigint,
  length: number,
): Promise<Uint8Array> {
  assertReadRange(source.totalStreamBytes, offset, length);
  const output = new Uint8Array(length);
  let outputOffset = 0;
  let cursor = offset;

  while (outputOffset < length && cursor < source.totalFileBytes) {
    const fileIndex = findFileAtOffset(source.files, cursor);
    const file = source.files[fileIndex];
    if (!file) {
      throw new Error("The virtual source file map is not contiguous.");
    }
    const relativeOffset = cursor - file.offset;
    const available = BigInt(file.size) - relativeOffset;
    const take = Number(
      available < BigInt(length - outputOffset)
        ? available
        : BigInt(length - outputOffset),
    );
    const chunk = new Uint8Array(
      await file.snapshot
        .slice(Number(relativeOffset), Number(relativeOffset) + take)
        .arrayBuffer(),
    );
    if (chunk.length !== take) {
      throw new Error(`The source file became unreadable: ${file.path}`);
    }
    output.set(chunk, outputOffset);
    outputOffset += chunk.length;
    cursor += BigInt(chunk.length);
  }

  if (outputOffset < length) {
    const trailerOffset = cursor - source.totalFileBytes;
    const take = Math.min(
      length - outputOffset,
      source.trailerBytes.length - Number(trailerOffset),
    );
    output.set(
      source.trailerBytes.subarray(
        Number(trailerOffset),
        Number(trailerOffset) + take,
      ),
      outputOffset,
    );
    outputOffset += take;
  }
  if (outputOffset !== length) {
    throw new Error("The virtual source returned a truncated range.");
  }
  return output;
}

/** Reads and validates the tree trailer from a completed random-access store. */
export async function readLargeTreeManifest(
  reader: RandomAccessReader,
): Promise<LargeTreeManifest> {
  if (reader.size < BigInt(LARGE_TREE_FOOTER_BYTES)) {
    throw new Error("The received stream is too short to contain tree metadata.");
  }
  const footer = await reader.read(
    reader.size - BigInt(LARGE_TREE_FOOTER_BYTES),
    LARGE_TREE_FOOTER_BYTES,
  );
  if (footer.length !== LARGE_TREE_FOOTER_BYTES) {
    throw new Error("The received tree footer is truncated.");
  }
  if (!bytesEqual(footer.subarray(8), FOOTER_MAGIC)) {
    throw new Error("The received tree footer has the wrong protocol marker.");
  }
  const metadataLength = readUint64(footer, 0, "tree metadata length");
  if (
    metadataLength > BigInt(MAX_LARGE_TREE_METADATA_BYTES) ||
    metadataLength + BigInt(LARGE_TREE_FOOTER_BYTES) > reader.size
  ) {
    throw new Error("The received tree metadata length is outside its limit.");
  }
  const metadataOffset =
    reader.size - BigInt(LARGE_TREE_FOOTER_BYTES) - metadataLength;
  const metadataBytes = new Uint8Array(Number(metadataLength));
  let metadataPosition = 0;
  while (metadataPosition < metadataBytes.length) {
    const length = Math.min(
      LARGE_TREE_READ_BYTES,
      metadataBytes.length - metadataPosition,
    );
    const chunk = await reader.read(
      metadataOffset + BigInt(metadataPosition),
      length,
    );
    if (chunk.length !== length) {
      throw new Error("The received tree metadata is truncated.");
    }
    metadataBytes.set(chunk, metadataPosition);
    metadataPosition += length;
  }
  const parsed = parseLargeTreeMetadata(metadataBytes);
  if (parsed.totalFileBytes !== metadataOffset) {
    throw new Error("The received file layout does not match the stream length.");
  }
  return parsed;
}

export function encodeLargeTreeMetadata(input: {
  rootName: string;
  directories: readonly string[];
  files: readonly Pick<
    PreparedLargeSourceFile,
    "path" | "size" | "lastModified" | "sha256Hex"
  >[];
}): Uint8Array {
  validatePortableRootName(input.rootName);
  const directories = Array.from(input.directories).sort(comparePaths);
  const files = Array.from(input.files).sort((left, right) =>
    comparePaths(left.path, right.path),
  );
  validateTreePaths(files.map(({ path }) => path), directories);
  if (files.length + directories.length > MAX_LARGE_TREE_ENTRIES) {
    throw new Error("The tree metadata exceeds its entry limit.");
  }
  const serialized: SerializedTreeManifest = {
    schema: LARGE_TREE_SCHEMA,
    version: LARGE_TREE_VERSION,
    rootName: input.rootName,
    directories,
    files: files.map((file) => {
      assertSafeInteger(file.size, "file size");
      if (!/^[0-9a-f]{64}$/.test(file.sha256Hex)) {
        throw new Error(`Invalid SHA-256 for ${file.path}.`);
      }
      assertSafeInteger(file.lastModified, "last modified time");
      return {
        path: file.path,
        size: String(file.size),
        sha256: file.sha256Hex,
        lastModified: file.lastModified,
      };
    }),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(serialized));
  if (encoded.length > MAX_LARGE_TREE_METADATA_BYTES) {
    throw new Error(
      `Tree metadata exceeds ${MAX_LARGE_TREE_METADATA_BYTES.toLocaleString()} bytes.`,
    );
  }
  return encoded;
}

export function parseLargeTreeMetadata(
  metadataBytes: Uint8Array,
): LargeTreeManifest {
  if (metadataBytes.length > MAX_LARGE_TREE_METADATA_BYTES) {
    throw new Error("Tree metadata exceeds its safety limit.");
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes);
    value = JSON.parse(text);
  } catch {
    throw new Error("Tree metadata is not valid canonical JSON.");
  }
  if (!isRecord(value)) {
    throw new Error("Tree metadata must be an object.");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["directories", "files", "rootName", "schema", "version"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Tree metadata contains unsupported fields.");
  }
  if (value.schema !== LARGE_TREE_SCHEMA || value.version !== LARGE_TREE_VERSION) {
    throw new Error("Tree metadata uses an unsupported protocol version.");
  }
  if (
    typeof value.rootName !== "string" ||
    !Array.isArray(value.directories) ||
    !Array.isArray(value.files)
  ) {
    throw new Error("Tree metadata has invalid field types.");
  }
  validatePortableRootName(value.rootName);
  if (value.directories.some((path) => typeof path !== "string")) {
    throw new Error("Tree metadata contains an invalid directory path.");
  }
  const directories = (value.directories as string[]).slice();
  const rawFiles = value.files;
  if (rawFiles.length + directories.length > MAX_LARGE_TREE_ENTRIES) {
    throw new Error("Tree metadata exceeds its entry limit.");
  }

  const files: LargeTreeFile[] = [];
  let offset = 0n;
  for (const rawFile of rawFiles) {
    if (!isRecord(rawFile)) {
      throw new Error("Tree metadata contains an invalid file record.");
    }
    const fileKeys = Object.keys(rawFile).sort();
    const expectedFileKeys = ["lastModified", "path", "sha256", "size"];
    if (
      fileKeys.length !== expectedFileKeys.length ||
      fileKeys.some((key, index) => key !== expectedFileKeys[index]) ||
      typeof rawFile.path !== "string" ||
      typeof rawFile.size !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(rawFile.size) ||
      typeof rawFile.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(rawFile.sha256) ||
      typeof rawFile.lastModified !== "number" ||
      !Number.isSafeInteger(rawFile.lastModified) ||
      rawFile.lastModified < 0
    ) {
      throw new Error("Tree metadata contains an invalid file record.");
    }
    const size = BigInt(rawFile.size);
    files.push({
      path: rawFile.path,
      offset,
      size,
      sha256Hex: rawFile.sha256,
      lastModified: rawFile.lastModified,
    });
    offset += size;
  }
  validateTreePaths(files.map(({ path }) => path), directories);

  // Reject alternate JSON spellings and non-canonical ordering. A single byte
  // representation makes the manifest digest an unambiguous transfer binding.
  const canonical = encodeLargeTreeMetadata({
    rootName: value.rootName,
    directories,
    files: files.map((file) => ({
      path: file.path,
      size: safeNumberFromBigInt(file.size, "file size"),
      sha256Hex: file.sha256Hex,
      lastModified: file.lastModified,
    })),
  });
  if (!bytesEqual(metadataBytes, canonical)) {
    throw new Error("Tree metadata is not in canonical order or encoding.");
  }
  return {
    rootName: value.rootName,
    directories,
    files,
    totalFileBytes: offset,
    metadataBytes: metadataBytes.slice(),
    metadataSha256: sha256(metadataBytes),
  };
}

export function createLargeTreeReader(
  source: PreparedLargeSource,
): RandomAccessReader {
  return {
    size: source.totalStreamBytes,
    read: (offset, length) => readPreparedLargeRange(source, offset, length),
  };
}

function encodeTrailer(metadataBytes: Uint8Array): Uint8Array {
  const trailer = new Uint8Array(
    metadataBytes.length + LARGE_TREE_FOOTER_BYTES,
  );
  trailer.set(metadataBytes, 0);
  const footerOffset = metadataBytes.length;
  new DataView(trailer.buffer).setBigUint64(
    footerOffset,
    BigInt(metadataBytes.length),
    true,
  );
  trailer.set(FOOTER_MAGIC, footerOffset + 8);
  return trailer;
}

function findFileAtOffset(
  files: readonly PreparedLargeSourceFile[],
  offset: bigint,
): number {
  let low = 0;
  let high = files.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const file = files[middle];
    if (offset < file.offset) {
      high = middle - 1;
    } else if (offset >= file.offset + BigInt(file.size)) {
      low = middle + 1;
    } else {
      return middle;
    }
  }
  return low;
}

function validateTreePaths(
  filePaths: readonly string[],
  directories: readonly string[],
): void {
  const aliases = new Map<string, string>();
  for (const path of [...directories, ...filePaths]) {
    validatePortablePath(path, aliases);
  }
  assertTreeConflicts(filePaths, directories);
  assertSortedUnique(filePaths, "file");
  assertSortedUnique(directories, "directory");
}

function validatePortablePath(
  path: string,
  aliases: Map<string, string>,
): void {
  const canonical = validateArchivePath(path);
  if (canonical !== path) {
    throw new Error(`Tree path is not canonical: ${path}`);
  }
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH) {
    throw new Error(`Path exceeds ${MAX_PATH_DEPTH} levels: ${path}`);
  }
  if (new TextEncoder().encode(path).length > MAX_PATH_BYTES) {
    throw new Error(`Path exceeds ${MAX_PATH_BYTES} UTF-8 bytes: ${path}`);
  }
  for (const segment of segments) {
    const encodedLength = new TextEncoder().encode(segment).length;
    if (
      encodedLength > MAX_SEGMENT_BYTES ||
      /[<>:"|?*\u0000-\u001f]/.test(segment) ||
      /[ .]$/.test(segment) ||
      WINDOWS_RESERVED_NAME.test(segment) ||
      OBJECT_MAGIC_NAME.test(segment)
    ) {
      throw new Error(`Path is not portable across destinations: ${path}`);
    }
  }
  const alias = segments
    .map((segment) => segment.normalize("NFC").toLowerCase())
    .join("/");
  const prior = aliases.get(alias);
  if (prior !== undefined && prior !== path) {
    throw new Error(`Paths may collide on the destination: ${prior} and ${path}`);
  }
  aliases.set(alias, path);
}

function assertTreeConflicts(
  filePaths: readonly string[],
  directories: readonly string[],
): void {
  const fileSet = new Set(filePaths);
  const directorySet = new Set(directories);
  if (fileSet.size !== filePaths.length || directorySet.size !== directories.length) {
    throw new Error("The selected tree contains a duplicate path.");
  }
  for (const path of fileSet) {
    if (directorySet.has(path)) {
      throw new Error(`A path is both a file and a directory: ${path}`);
    }
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (fileSet.has(parent)) {
        throw new Error(`A file is used as a parent directory: ${parent}`);
      }
    }
  }
}

function assertSortedUnique(paths: readonly string[], kind: string): void {
  for (let index = 1; index < paths.length; index += 1) {
    if (comparePaths(paths[index - 1], paths[index]) >= 0) {
      throw new Error(`Tree ${kind} paths are not strictly canonical.`);
    }
  }
}

function assertReadRange(size: bigint, offset: bigint, length: number): void {
  if (offset < 0n || !Number.isSafeInteger(length) || length < 0) {
    throw new Error("Read offset and length must be non-negative integers.");
  }
  if (length > LARGE_TREE_READ_BYTES) {
    throw new Error(
      `A virtual-source read cannot exceed ${LARGE_TREE_READ_BYTES.toLocaleString()} bytes.`,
    );
  }
  if (offset + BigInt(length) > size) {
    throw new Error("The requested range extends beyond the virtual source.");
  }
}

function assertSafeFile(file: File, path: string): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error(`The browser reported an unsupported size for ${path}.`);
  }
  assertSafeInteger(file.lastModified, `last modified time for ${path}`);
}

function assertUnchangedFile(source: LargeSourceFile, snapshot: File): void {
  assertSafeFile(snapshot, source.path);
  if (
    snapshot.size !== source.size ||
    snapshot.lastModified !== source.lastModified
  ) {
    throw new Error(`The source changed after selection: ${source.path}`);
  }
}

function assertSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
}

function safeNumberFromBigInt(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds this browser's exact integer range.`);
  }
  return Number(value);
}

function readUint64(bytes: Uint8Array, offset: number, field: string): bigint {
  if (offset < 0 || offset + 8 > bytes.length) {
    throw new Error(`${field} is truncated.`);
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigUint64(offset, true);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was cancelled.", "AbortError");
  }
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
