import {
  strFromU8,
  Unzip,
  UnzipInflate,
  zipSync,
  type Zippable,
  type ZipOptions,
} from "fflate";

/**
 * A path is always relative to the selected root and uses "/" separators.
 * Directory entries carry an empty byte array.
 */
export interface SelectedEntry {
  path: string;
  bytes: Uint8Array;
  directory?: boolean;
}

export interface FileHashVerification {
  path: string;
  expectedHash?: string;
  actualHash?: string;
  matches: boolean;
}

export interface HashMismatch {
  path: string;
  expectedHash: string;
  actualHash: string;
}

export interface VerificationReport {
  ok: boolean;
  rootName: string;
  filesWritten: number;
  directoriesCreated: number;
  totalBytes: number;
  expectedPaths: string[];
  actualPaths: string[];
  missingPaths: string[];
  extraPaths: string[];
  expectedDirectoryPaths: string[];
  actualDirectoryPaths: string[];
  missingDirectoryPaths: string[];
  extraDirectoryPaths: string[];
  hashes: FileHashVerification[];
  hashMismatches: HashMismatch[];
}

interface NormalizedTree {
  files: SelectedEntry[];
  directories: SelectedEntry[];
}

interface CentralDirectoryEntry {
  archivePath: string;
  canonicalPath: string;
  directory: boolean;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
}

const EMPTY_BYTES = new Uint8Array(0);
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 25_000;
const MAX_PATH_DEPTH = 64;
const MAX_PATH_BYTES = 4_096;
const MAX_SEGMENT_BYTES = 255;
const WINDOWS_RESERVED_NAME =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const OBJECT_MAGIC_NAME = /^(?:__proto__|constructor|prototype)$/;
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

const ALREADY_COMPRESSED_EXTENSIONS = new Set([
  "7z",
  "avi",
  "avif",
  "bz2",
  "flac",
  "gif",
  "gz",
  "heic",
  "heif",
  "jpeg",
  "jpg",
  "m4a",
  "m4v",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "ogg",
  "pdf",
  "png",
  "rar",
  "webm",
  "webp",
  "xz",
  "zip",
]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * Validates an archive-relative path and returns its canonical form.
 *
 * A single trailing slash is accepted for ZIP directory entries and removed
 * from the returned value. No other normalization is performed, so Unicode
 * filenames retain their original code points.
 */
export function validateArchivePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Archive path must be a non-empty string.");
  }
  if (path.includes("\0")) {
    throw new Error(`Archive path contains a NUL byte: ${JSON.stringify(path)}`);
  }
  if (path.includes("\\")) {
    throw new Error(
      `Archive path must use forward-slash separators: ${JSON.stringify(path)}`,
    );
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`Archive path must be relative: ${JSON.stringify(path)}`);
  }

  const hasDirectorySuffix = path.endsWith("/");
  const canonicalPath = hasDirectorySuffix ? path.slice(0, -1) : path;
  if (canonicalPath.length === 0) {
    throw new Error("Archive path cannot refer to the filesystem root.");
  }

  const segments = canonicalPath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `Archive path contains an unsafe path segment: ${JSON.stringify(path)}`,
    );
  }
  const utf8RoundTrip = new TextDecoder("utf-8", { fatal: true }).decode(
    new TextEncoder().encode(canonicalPath),
  );
  if (utf8RoundTrip !== canonicalPath) {
    throw new Error(
      `Archive path contains invalid Unicode text: ${JSON.stringify(path)}`,
    );
  }

  return canonicalPath;
}

/**
 * Validates a root folder name against the conservative cross-platform rules
 * used before destination writes. Unsupported names are rejected, never
 * silently normalized.
 */
export function validatePortableRootName(rootName: string): string {
  const canonical = validateArchivePath(rootName);
  if (canonical !== rootName || canonical.includes("/") || rootName.endsWith("/")) {
    throw new Error("Root name must be one safe folder-name segment.");
  }
  validatePortableSegment(rootName);
  return rootName;
}

/** Computes the unsigned ZIP-compatible CRC-32 of raw bytes. */
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Computes a lowercase hexadecimal SHA-256 digest using Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable in this environment.");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Recursively reads a File System Access API directory as raw bytes.
 * Explicit directory entries allow empty directories to survive ZIP creation.
 */
export async function collectDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  maxTotalBytes = Number.POSITIVE_INFINITY,
): Promise<SelectedEntry[]> {
  assertCollectionLimit(maxTotalBytes);
  const collected: SelectedEntry[] = [];
  let totalBytes = 0;

  async function walk(
    directoryHandle: FileSystemDirectoryHandle,
    parentPath: string,
  ): Promise<void> {
    const children: Array<
      [string, FileSystemFileHandle | FileSystemDirectoryHandle]
    > = [];
    for await (const child of directoryHandle.entries()) {
      children.push(child);
    }
    children.sort(([left], [right]) => comparePaths(left, right));

    for (const [name, childHandle] of children) {
      if (collected.length >= MAX_ARCHIVE_ENTRIES) {
        throw new Error(
          `Selected folder exceeds the ${MAX_ARCHIVE_ENTRIES}-entry safety limit.`,
        );
      }
      const path = parentPath ? `${parentPath}/${name}` : name;
      validateArchivePath(path);

      if (childHandle.kind === "directory") {
        collected.push({
          path,
          bytes: EMPTY_BYTES,
          directory: true,
        });
        await walk(childHandle, path);
      } else if (childHandle.kind === "file") {
        const file = await childHandle.getFile();
        if (totalBytes + file.size > maxTotalBytes) {
          throw new Error(
            `Selected folder exceeds the ${formatLimit(maxTotalBytes)} in-memory safety limit.`,
          );
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (totalBytes + bytes.length > maxTotalBytes) {
          throw new Error(
            `Selected folder exceeds the ${formatLimit(maxTotalBytes)} in-memory safety limit.`,
          );
        }
        totalBytes += bytes.length;
        collected.push({
          path,
          bytes,
        });
      } else {
        throw new Error(`Unsupported filesystem entry kind at ${path}.`);
      }
    }
  }

  await walk(handle, "");
  const tree = normalizeEntries(collected);
  return [...tree.directories, ...tree.files];
}

/**
 * Reads files from an <input type="file" webkitdirectory> FileList.
 * Browsers do not expose empty folders through FileList, but every file path
 * and byte is retained. The common picker root is removed from relative paths.
 */
export async function collectInputFiles(
  files: FileList | ArrayLike<File>,
  maxTotalBytes = Number.POSITIVE_INFINITY,
): Promise<SelectedEntry[]> {
  assertCollectionLimit(maxTotalBytes);
  const inputFiles = Array.from(files);
  if (inputFiles.length === 0) {
    return [];
  }
  if (inputFiles.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `Selected folder exceeds the ${MAX_ARCHIVE_ENTRIES}-entry safety limit.`,
    );
  }

  const hasPickerPaths = inputFiles.every(
    (file) => file.webkitRelativePath.length > 0,
  );
  let commonPickerRoot: string | undefined;

  if (hasPickerPaths) {
    const firstSegments = inputFiles.map(
      (file) => file.webkitRelativePath.split("/")[0],
    );
    if (
      firstSegments[0].length > 0 &&
      firstSegments.every((segment) => segment === firstSegments[0])
    ) {
      commonPickerRoot = firstSegments[0];
    }
  }

  const declaredTotalBytes = inputFiles.reduce(
    (total, file) =>
      total + (Number.isFinite(file.size) ? Math.max(0, file.size) : 0),
    0,
  );
  if (declaredTotalBytes > maxTotalBytes) {
    throw new Error(
      `Selected folder exceeds the ${formatLimit(maxTotalBytes)} in-memory safety limit.`,
    );
  }

  const collected: SelectedEntry[] = [];
  let totalBytes = 0;
  for (const file of inputFiles) {
    let path = hasPickerPaths ? file.webkitRelativePath : file.name;
    if (commonPickerRoot && path.startsWith(`${commonPickerRoot}/`)) {
      path = path.slice(commonPickerRoot.length + 1);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (totalBytes + bytes.length > maxTotalBytes) {
      throw new Error(
        `Selected folder exceeds the ${formatLimit(maxTotalBytes)} in-memory safety limit.`,
      );
    }
    totalBytes += bytes.length;
    collected.push({
      path: validateArchivePath(path),
      bytes,
    });
  }

  const tree = normalizeEntries(collected);
  return tree.files;
}

/**
 * Creates a deterministic ZIP payload. Parent directories are included
 * explicitly, so an entry collected as an empty directory remains present.
 */
export function createArchive(entries: readonly SelectedEntry[]): Uint8Array {
  const tree = normalizeEntries(entries);
  if (tree.files.length + tree.directories.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `Folder contains too many entries; the limit is ${MAX_ARCHIVE_ENTRIES}.`,
    );
  }
  const zippable = Object.create(null) as Zippable;

  for (const directory of tree.directories) {
    zippable[`${directory.path}/`] = [
      EMPTY_BYTES,
      {
        level: 0,
        mtime: ZIP_EPOCH,
        os: 3,
        attrs: ((0o40755 << 16) | 0x10) >>> 0,
      },
    ];
  }

  for (const file of tree.files) {
    zippable[file.path] = [
      Uint8Array.from(file.bytes),
      {
        level: compressionLevelForPath(file.path),
        mtime: ZIP_EPOCH,
        os: 3,
        attrs: (0o100644 << 16) >>> 0,
      },
    ];
  }

  return zipSync(zippable, { mtime: ZIP_EPOCH });
}

/**
 * Safely extracts a ZIP created by this application.
 *
 * Central-directory paths are validated before decompression, duplicate and
 * conflicting paths are rejected, and each extracted entry is checked against
 * its uncompressed size and ZIP CRC-32.
 */
export function extractArchive(archiveBytes: Uint8Array): SelectedEntry[] {
  const centralEntries = readCentralDirectory(archiveBytes);
  const centralByArchivePath = new Map(
    centralEntries.map((entry) => [entry.archivePath, entry]),
  );
  const extractedByArchivePath = new Map<string, SelectedEntry>();
  let extractionError: Error | undefined;

  const unzipper = new Unzip((file) => {
    if (extractionError) {
      return;
    }

    try {
      const directory = file.name.endsWith("/");
      const canonicalPath = validateArchivePath(file.name);
      const centralEntry = centralByArchivePath.get(file.name);
      if (!centralEntry) {
        throw new Error(
          `ZIP local entry is absent from the central directory: ${file.name}`,
        );
      }
      if (
        centralEntry.canonicalPath !== canonicalPath ||
        centralEntry.directory !== directory ||
        centralEntry.compression !== file.compression
      ) {
        throw new Error(`ZIP metadata disagrees for entry: ${file.name}`);
      }
      if (extractedByArchivePath.has(file.name)) {
        throw new Error(`ZIP contains a duplicate entry: ${file.name}`);
      }

      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      file.ondata = (error, chunk, final) => {
        if (error) {
          extractionError = error;
          return;
        }
        if (chunk.length > 0) {
          if (byteLength + chunk.length > centralEntry.uncompressedSize) {
            extractionError = new Error(
              `ZIP expanded beyond its declared size: ${file.name}`,
            );
            return;
          }
          const copiedChunk = Uint8Array.from(chunk);
          chunks.push(copiedChunk);
          byteLength += copiedChunk.length;
        }
        if (!final) {
          return;
        }

        const bytes = concatenateBytes(chunks, byteLength);
        if (bytes.length !== centralEntry.uncompressedSize) {
          extractionError = new Error(
            `ZIP size check failed for entry: ${file.name}`,
          );
          return;
        }
        if (crc32(bytes) !== centralEntry.crc32) {
          extractionError = new Error(
            `ZIP CRC-32 check failed for entry: ${file.name}`,
          );
          return;
        }
        if (directory && bytes.length !== 0) {
          extractionError = new Error(
            `ZIP directory contains unexpected data: ${file.name}`,
          );
          return;
        }

        extractedByArchivePath.set(file.name, {
          path: canonicalPath,
          bytes,
          directory: directory || undefined,
        });
      };
      file.start();
    } catch (error) {
      extractionError = toError(error);
    }
  });

  unzipper.register(UnzipInflate);
  try {
    unzipper.push(archiveBytes, true);
  } catch (error) {
    throw toError(error);
  }
  if (extractionError) {
    throw extractionError;
  }
  if (extractedByArchivePath.size !== centralEntries.length) {
    throw new Error(
      `ZIP extraction produced ${extractedByArchivePath.size} of ${centralEntries.length} entries.`,
    );
  }

  const extracted = centralEntries.map((entry) => {
    const value = extractedByArchivePath.get(entry.archivePath);
    if (!value) {
      throw new Error(`ZIP entry was not extracted: ${entry.archivePath}`);
    }
    return value;
  });
  const tree = normalizeEntries(extracted);
  return [...tree.directories, ...tree.files];
}

/**
 * Compares two in-memory trees with exact path-set equality and SHA-256 for
 * every file. It is also used after destination files have been re-read.
 */
export async function verifyEntryCollections(
  expectedEntries: readonly SelectedEntry[],
  actualEntries: readonly SelectedEntry[],
  rootName = "",
): Promise<VerificationReport> {
  const expected = normalizeEntries(expectedEntries);
  const actual = normalizeEntries(actualEntries);
  const expectedFiles = new Map(
    expected.files.map((entry) => [entry.path, entry]),
  );
  const actualFiles = new Map(actual.files.map((entry) => [entry.path, entry]));

  const expectedPaths = sortedPaths(expectedFiles.keys());
  const actualPaths = sortedPaths(actualFiles.keys());
  const missingPaths = difference(expectedPaths, new Set(actualPaths));
  const extraPaths = difference(actualPaths, new Set(expectedPaths));

  const expectedDirectoryPaths = expected.directories.map(
    (entry) => entry.path,
  );
  const actualDirectoryPaths = actual.directories.map((entry) => entry.path);
  const missingDirectoryPaths = difference(
    expectedDirectoryPaths,
    new Set(actualDirectoryPaths),
  );
  const extraDirectoryPaths = difference(
    actualDirectoryPaths,
    new Set(expectedDirectoryPaths),
  );

  const allPaths = sortedPaths(
    new Set([...expectedPaths, ...actualPaths]).values(),
  );
  const expectedHashes = new Map<string, string>();
  const actualHashes = new Map<string, string>();

  await Promise.all([
    ...expected.files.map(async (entry) => {
      expectedHashes.set(entry.path, await sha256Hex(entry.bytes));
    }),
    ...actual.files.map(async (entry) => {
      actualHashes.set(entry.path, await sha256Hex(entry.bytes));
    }),
  ]);

  const hashes = allPaths.map((path): FileHashVerification => {
    const expectedHash = expectedHashes.get(path);
    const actualHash = actualHashes.get(path);
    return {
      path,
      expectedHash,
      actualHash,
      matches:
        expectedHash !== undefined &&
        actualHash !== undefined &&
        expectedHash === actualHash,
    };
  });
  const hashMismatches = hashes.flatMap((hash) =>
    hash.expectedHash !== undefined &&
    hash.actualHash !== undefined &&
    hash.expectedHash !== hash.actualHash
      ? [
          {
            path: hash.path,
            expectedHash: hash.expectedHash,
            actualHash: hash.actualHash,
          },
        ]
      : [],
  );

  return {
    ok:
      missingPaths.length === 0 &&
      extraPaths.length === 0 &&
      missingDirectoryPaths.length === 0 &&
      extraDirectoryPaths.length === 0 &&
      hashMismatches.length === 0,
    rootName,
    filesWritten: actual.files.length,
    directoriesCreated: actual.directories.length,
    totalBytes: expected.files.reduce(
      (total, entry) => total + entry.bytes.length,
      0,
    ),
    expectedPaths,
    actualPaths,
    missingPaths,
    extraPaths,
    expectedDirectoryPaths,
    actualDirectoryPaths,
    missingDirectoryPaths,
    extraDirectoryPaths,
    hashes,
    hashMismatches,
  };
}

/**
 * Writes an extracted tree beneath `rootName`, then re-enumerates and re-reads
 * the destination before reporting success.
 *
 * `destinationParent` is injectable for tests. When omitted, the browser
 * directory picker is opened. An existing non-empty root is never modified.
 */
export async function writeAndVerifyArchive(
  extractedEntries: readonly SelectedEntry[],
  rootName: string,
  destinationParent?: FileSystemDirectoryHandle,
): Promise<VerificationReport> {
  validatePortableRootName(rootName);

  const expected = normalizeEntries(extractedEntries);
  let parent = destinationParent;
  if (!parent) {
    const picker =
      typeof window === "undefined" ? undefined : window.showDirectoryPicker;
    if (!picker) {
      throw new Error(
        "This browser does not support direct folder writing. Download the ZIP instead.",
      );
    }
    parent = await picker.call(window, {
      id: "qr-air-gap-receiver",
      mode: "readwrite",
    });
  }

  const root = await parent.getDirectoryHandle(rootName, { create: true });
  if (root.name !== rootName) {
    throw new Error(
      `Destination normalized the root name from ${JSON.stringify(rootName)} to ${JSON.stringify(root.name)}.`,
    );
  }
  if (!(await isDirectoryEmpty(root))) {
    throw new Error(
      `Refusing to overwrite non-empty destination folder: ${rootName}`,
    );
  }

  for (const directory of expected.directories) {
    await ensureDirectory(root, directory.path.split("/"));
  }

  for (const file of expected.files) {
    const segments = file.path.split("/");
    const filename = segments.pop();
    if (!filename) {
      throw new Error(`Invalid file path: ${file.path}`);
    }
    const parentDirectory = await ensureDirectory(root, segments);
    const fileHandle = await parentDirectory.getFileHandle(filename, {
      create: true,
    });
    if (fileHandle.name !== filename) {
      throw new Error(
        `Destination normalized a filename from ${JSON.stringify(filename)} to ${JSON.stringify(fileHandle.name)}.`,
      );
    }
    const writable = await fileHandle.createWritable();
    await writable.write(Uint8Array.from(file.bytes));
    await writable.close();
  }

  // This is intentionally a fresh traversal and fresh File.arrayBuffer() read
  // for every destination file; verification does not trust the write buffers.
  const actual = await collectDirectoryHandle(root);
  return verifyEntryCollections(
    [...expected.directories, ...expected.files],
    actual,
    rootName,
  );
}

/** Downloads a ZIP fallback for browsers without direct folder writing. */
export function downloadArchive(
  archiveBytes: Uint8Array,
  filename = "qr-air-gap-transfer.zip",
): void {
  if (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0")
  ) {
    throw new Error("Download filename must be a single safe filename.");
  }

  const blob = new Blob([Uint8Array.from(archiveBytes)], {
    type: "application/zip",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function normalizeEntries(entries: readonly SelectedEntry[]): NormalizedTree {
  const byPath = new Map<string, SelectedEntry>();

  for (const entry of entries) {
    if (!(entry.bytes instanceof Uint8Array)) {
      throw new Error(`Entry bytes must be a Uint8Array: ${entry.path}`);
    }

    const directory = entry.directory === true;
    const hadDirectorySuffix = entry.path.endsWith("/");
    if (hadDirectorySuffix && !directory) {
      throw new Error(
        `Only directory entries may end with a slash: ${entry.path}`,
      );
    }
    if (directory && entry.bytes.length !== 0) {
      throw new Error(`Directory entry must have zero bytes: ${entry.path}`);
    }

    const path = validateArchivePath(entry.path);
    if (byPath.has(path)) {
      throw new Error(`Duplicate or conflicting archive path: ${path}`);
    }
    byPath.set(path, {
      path,
      bytes: directory ? EMPTY_BYTES : Uint8Array.from(entry.bytes),
      directory: directory || undefined,
    });
  }

  const directoryPaths = new Set<string>();
  for (const [path, entry] of byPath) {
    if (entry.directory) {
      directoryPaths.add(path);
    }
    const segments = path.split("/");
    segments.pop();
    let parentPath = "";
    for (const segment of segments) {
      parentPath = parentPath ? `${parentPath}/${segment}` : segment;
      const parentEntry = byPath.get(parentPath);
      if (parentEntry && !parentEntry.directory) {
        throw new Error(
          `A file cannot also be a parent directory: ${parentPath}`,
        );
      }
      directoryPaths.add(parentPath);
    }
  }

  validatePortablePathSet(
    new Set([
      ...directoryPaths,
      ...Array.from(byPath.values(), (entry) => entry.path),
    ]),
  );

  const directories = sortedPaths(directoryPaths.values()).map((path) => ({
    path,
    bytes: EMPTY_BYTES,
    directory: true,
  }));
  const files = Array.from(byPath.values())
    .filter((entry) => !entry.directory)
    .sort((left, right) => comparePaths(left.path, right.path));

  return { files, directories };
}

function compressionLevelForPath(path: string): ZipOptions["level"] {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return ALREADY_COMPRESSED_EXTENSIONS.has(extension) ? 0 : 6;
}

function readCentralDirectory(bytes: Uint8Array): CentralDirectoryEntry[] {
  if (bytes.length < 22) {
    throw new Error("Invalid ZIP: end-of-central-directory record is missing.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;

  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("Invalid ZIP: end-of-central-directory record is missing.");
  }

  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);

  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount
  ) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("ZIP64 archives are outside this application's size limit.");
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `ZIP contains ${entryCount} entries; the safety limit is ${MAX_ARCHIVE_ENTRIES}.`,
    );
  }
  if (
    centralOffset + centralSize !== endOffset ||
    centralOffset + centralSize > bytes.length
  ) {
    throw new Error("Invalid ZIP central-directory bounds.");
  }

  const entries: CentralDirectoryEntry[] = [];
  const canonicalKinds = new Map<string, boolean>();
  const archivePaths = new Set<string>();
  let offset = centralOffset;
  let totalUncompressedSize = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > endOffset ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw new Error("Invalid ZIP central-directory entry.");
    }

    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const expectedCrc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const startDisk = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset =
      offset + 46 + filenameLength + extraLength + commentLength;

    if (nextOffset > endOffset) {
      throw new Error("Invalid ZIP central-directory entry bounds.");
    }
    if ((flags & 0x1) !== 0) {
      throw new Error("Encrypted ZIP entries are not supported.");
    }
    if (startDisk !== 0) {
      throw new Error("Multi-disk ZIP entries are not supported.");
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("ZIP64 entries are outside this application's size limit.");
    }
    totalUncompressedSize += uncompressedSize;
    if (
      !Number.isSafeInteger(totalUncompressedSize) ||
      totalUncompressedSize > MAX_EXTRACTED_BYTES
    ) {
      throw new Error(
        `ZIP expands beyond the ${MAX_EXTRACTED_BYTES / 1024 / 1024} MB safety limit.`,
      );
    }
    if (
      localOffset + 30 > centralOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50
    ) {
      throw new Error("Invalid ZIP local-file header.");
    }

    const archivePath = strFromU8(
      bytes.subarray(offset + 46, offset + 46 + filenameLength),
      (flags & 0x800) === 0,
    );
    const directory = archivePath.endsWith("/");
    const canonicalPath = validateArchivePath(archivePath);
    if (archivePaths.has(archivePath)) {
      throw new Error(`ZIP contains a duplicate entry: ${archivePath}`);
    }
    if (canonicalKinds.has(canonicalPath)) {
      throw new Error(
        `ZIP contains a conflicting file/directory path: ${canonicalPath}`,
      );
    }

    const localFlags = view.getUint16(localOffset + 6, true);
    const localCompression = view.getUint16(localOffset + 8, true);
    const localFilenameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localHeaderEnd =
      localOffset + 30 + localFilenameLength + localExtraLength;
    if (localHeaderEnd > centralOffset) {
      throw new Error("Invalid ZIP local-file header bounds.");
    }
    const localPath = strFromU8(
      bytes.subarray(localOffset + 30, localOffset + 30 + localFilenameLength),
      (localFlags & 0x800) === 0,
    );
    if (
      localPath !== archivePath ||
      localCompression !== compression ||
      (localFlags & 0x1) !== 0
    ) {
      throw new Error(`ZIP local and central metadata disagree: ${archivePath}`);
    }

    archivePaths.add(archivePath);
    canonicalKinds.set(canonicalPath, directory);
    entries.push({
      archivePath,
      canonicalPath,
      directory,
      compression,
      crc32: expectedCrc32,
      compressedSize,
      uncompressedSize,
    });
    offset = nextOffset;
  }

  if (offset !== endOffset) {
    throw new Error("ZIP central-directory size does not match its entries.");
  }

  // Reuse the same tree invariants applied to locally-created archives before
  // allocating decompression output.
  normalizeEntries(
    entries.map((entry) => ({
      path: entry.canonicalPath,
      bytes: EMPTY_BYTES,
      directory: entry.directory || undefined,
    })),
  );
  return entries;
}

function concatenateBytes(
  chunks: readonly Uint8Array[],
  byteLength: number,
): Uint8Array {
  if (chunks.length === 1 && chunks[0].length === byteLength) {
    return chunks[0];
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function isDirectoryEmpty(
  directory: FileSystemDirectoryHandle,
): Promise<boolean> {
  for await (const _entry of directory.entries()) {
    return false;
  }
  return true;
}

async function ensureDirectory(
  root: FileSystemDirectoryHandle,
  segments: readonly string[],
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of segments) {
    const next = await current.getDirectoryHandle(segment, { create: true });
    if (next.name !== segment) {
      throw new Error(
        `Destination normalized a folder name from ${JSON.stringify(segment)} to ${JSON.stringify(next.name)}.`,
      );
    }
    current = next;
  }
  return current;
}

function difference(paths: readonly string[], other: ReadonlySet<string>) {
  return paths.filter((path) => !other.has(path));
}

function sortedPaths(paths: Iterable<string>): string[] {
  return Array.from(paths).sort(comparePaths);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validatePortablePathSet(paths: ReadonlySet<string>): void {
  const aliases = new Map<string, string>();
  for (const path of paths) {
    const segments = path.split("/");
    if (segments.length > MAX_PATH_DEPTH) {
      throw new Error(
        `Path exceeds the ${MAX_PATH_DEPTH}-level nesting limit: ${path}`,
      );
    }
    if (new TextEncoder().encode(path).length > MAX_PATH_BYTES) {
      throw new Error(
        `Path exceeds the ${MAX_PATH_BYTES}-byte portability limit: ${path}`,
      );
    }
    for (const segment of segments) validatePortableSegment(segment);

    const alias = segments
      .map((segment) => segment.normalize("NFC").toLowerCase())
      .join("/");
    const existing = aliases.get(alias);
    if (existing !== undefined && existing !== path) {
      throw new Error(
        `Paths may collide on a case-insensitive or Unicode-normalizing destination: ${existing} and ${path}`,
      );
    }
    aliases.set(alias, path);
  }
}

function validatePortableSegment(segment: string): void {
  const encodedLength = new TextEncoder().encode(segment).length;
  if (encodedLength > MAX_SEGMENT_BYTES) {
    throw new Error(
      `Path segment exceeds the ${MAX_SEGMENT_BYTES}-byte portability limit: ${segment}`,
    );
  }
  if (
    /[<>:"|?*\u0000-\u001f]/.test(segment) ||
    /[ .]$/.test(segment) ||
    WINDOWS_RESERVED_NAME.test(segment) ||
    OBJECT_MAGIC_NAME.test(segment)
  ) {
    throw new Error(
      `Path segment is not safely representable across supported destinations: ${segment}`,
    );
  }
}

function assertCollectionLimit(maxTotalBytes: number): void {
  if (
    maxTotalBytes !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0)
  ) {
    throw new Error("Collection byte limit must be a non-negative safe integer.");
  }
}

function formatLimit(bytes: number): string {
  if (!Number.isFinite(bytes)) return "configured";
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}
