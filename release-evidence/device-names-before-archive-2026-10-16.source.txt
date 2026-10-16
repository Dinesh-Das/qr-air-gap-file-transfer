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

/** Direct reconstruction uses a per-file crash journal; larger trees use ZIP fallback. */
export const MAX_DIRECT_WRITE_ENTRIES = 4_000;

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

interface DestinationCheckpoint {
  schema: "airgap-qr-destination-checkpoint";
  version: 2;
  rootName: string;
  fingerprint: string;
  /** Hex bitsets over the plan's sorted file list form a two-phase journal. */
  claimedFileBits: string;
  createdFileBits: string;
}

interface DestinationJournal {
  claimedPaths: Set<string>;
  createdPaths: Set<string>;
}

interface DestinationPlan {
  markerName: string;
  rootName: string;
  fingerprint: string;
  fileHashes: Map<string, string>;
  fileIndexes: Map<string, number>;
  filesByIndex: string[];
  totalFileBytes: number;
}

const EMPTY_BYTES = new Uint8Array(0);
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 25_000;
// fflate's streaming inflater emits after each compressed input push. Keeping
// pushes small bounds the allocation and CPU work that can occur before our
// declared-size/output-limit callback can stop a forged high-ratio stream.
const ZIP_INPUT_CHUNK_BYTES = 1_024;
const MAX_PATH_DEPTH = 64;
const MAX_PATH_BYTES = 4_096;
const MAX_SEGMENT_BYTES = 255;
const WINDOWS_RESERVED_NAME =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const OBJECT_MAGIC_NAME = /^(?:__proto__|constructor|prototype)$/;
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);
const DESTINATION_CHECKPOINT_PREFIX = ".airgap-qr-transfer-";
const DESTINATION_CHECKPOINT_SUFFIX = ".partial.json";
const MAX_DESTINATION_CHECKPOINT_BYTES = 16 * 1024;
const DESTINATION_WRITE_LOCK = "airgap-qr-destination-write";

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
  maxEntries = MAX_ARCHIVE_ENTRIES,
): Promise<SelectedEntry[]> {
  assertCollectionLimit(maxTotalBytes);
  assertCollectionEntryLimit(maxEntries);
  const collected: SelectedEntry[] = [];
  let totalBytes = 0;
  let discoveredEntries = 0;

  async function walk(
    directoryHandle: FileSystemDirectoryHandle,
    parentPath: string,
    parentDepth: number,
    parentPathBytes: number,
  ): Promise<void> {
    const children: Array<
      [string, FileSystemFileHandle | FileSystemDirectoryHandle]
    > = [];
    for await (const child of directoryHandle.entries()) {
      if (discoveredEntries >= maxEntries) {
        throw new Error(
          `Selected folder exceeds the ${maxEntries}-entry safety limit.`,
        );
      }
      discoveredEntries += 1;
      children.push(child);
    }
    children.sort(([left], [right]) => comparePaths(left, right));

    for (const [name, childHandle] of children) {
      if (collected.length >= maxEntries) {
        throw new Error(
          `Selected folder exceeds the ${maxEntries}-entry safety limit.`,
        );
      }
      const depth = parentDepth + 1;
      if (depth > MAX_PATH_DEPTH) {
        throw new Error(
          `Path exceeds the ${MAX_PATH_DEPTH}-level nesting limit before collection: ${name}`,
        );
      }
      validatePortableSegment(name);
      const segmentBytes = new TextEncoder().encode(name).length;
      const pathBytes =
        parentPathBytes + (parentDepth === 0 ? 0 : 1) + segmentBytes;
      if (pathBytes > MAX_PATH_BYTES) {
        throw new Error(
          `Path exceeds the ${MAX_PATH_BYTES}-byte portability limit before collection: ${name}`,
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
        await walk(childHandle, path, depth, pathBytes);
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

  await walk(handle, "", 0, 0);
  const tree = normalizeEntries(collected, maxEntries);
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
      if (
        (file.size !== undefined &&
          file.size !== centralEntry.compressedSize) ||
        (file.originalSize !== undefined &&
          file.originalSize !== centralEntry.uncompressedSize)
      ) {
        throw new Error(`ZIP local and central sizes disagree: ${file.name}`);
      }
      if (extractedByArchivePath.has(file.name)) {
        throw new Error(`ZIP contains a duplicate entry: ${file.name}`);
      }

      const bytes = new Uint8Array(centralEntry.uncompressedSize);
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
          bytes.set(chunk, byteLength);
          byteLength += chunk.length;
        }
        if (!final) {
          return;
        }

        if (byteLength !== centralEntry.uncompressedSize) {
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
    // Security invariant: never hand the complete compressed archive to the
    // synchronous inflater. A forged central size must be noticed between
    // bounded pushes, before an unbounded output chunk can be allocated.
    for (
      let offset = 0;
      offset < archiveBytes.length && !extractionError;
      offset += ZIP_INPUT_CHUNK_BYTES
    ) {
      const end = Math.min(
        archiveBytes.length,
        offset + ZIP_INPUT_CHUNK_BYTES,
      );
      unzipper.push(
        archiveBytes.subarray(offset, end),
        end === archiveBytes.length,
      );
    }
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
 * directory picker is opened. An unrelated non-empty root is never modified;
 * only targets journaled by a matching app-owned checkpoint may be repaired.
 */
export async function writeAndVerifyArchive(
  extractedEntries: readonly SelectedEntry[],
  rootName: string,
  destinationParent?: FileSystemDirectoryHandle,
): Promise<VerificationReport> {
  validatePortableRootName(rootName);

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

  // Keep the picker as the first awaited operation after the user's click.
  // Browser user activation can expire while hashing a large transfer plan.
  return withDestinationWriteLock(async () => {
  const expected = normalizeEntries(extractedEntries);
  if (
    expected.files.length + expected.directories.length >
    MAX_DIRECT_WRITE_ENTRIES
  ) {
    throw new Error(
      `Direct destination writing supports at most ${MAX_DIRECT_WRITE_ENTRIES.toLocaleString()} files and folders so resumable journaling stays bounded. Download the verified ZIP instead.`,
    );
  }
  const destinationPlan = await createDestinationPlan(expected, rootName);

  const root = await parent.getDirectoryHandle(rootName, { create: true });
  if (root.name !== rootName) {
    throw new Error(
      `Destination normalized the root name from ${JSON.stringify(rootName)} to ${JSON.stringify(root.name)}.`,
    );
  }

  const rootWasEmpty = await isDirectoryEmpty(root);
  let existingEntries: SelectedEntry[] = [];
  let journal: DestinationJournal = {
    claimedPaths: new Set<string>(),
    createdPaths: new Set<string>(),
  };
  if (rootWasEmpty) {
    await writeCheckpointMarker(root, destinationPlan, journal, true);
    try {
      existingEntries = await collectPartialDestination(root, destinationPlan);
      assertPartialTreeBelongsToTransfer(expected, existingEntries, rootName);
    } catch (error) {
      try {
        await root.removeEntry(destinationPlan.markerName);
      } catch {
        // Preserve the conflict/error that stopped the write.
      }
      throw error;
    }
  } else {
    try {
      journal = await assertMatchingCheckpoint(
        root,
        destinationPlan,
        rootName,
      );
    } catch (checkpointError) {
      if (await hasOnlyRecoverableCheckpointMarker(root, destinationPlan)) {
        await root.removeEntry(destinationPlan.markerName);
        await writeCheckpointMarker(root, destinationPlan, journal, true);
        existingEntries = await collectPartialDestination(root, destinationPlan);
        assertPartialTreeBelongsToTransfer(expected, existingEntries, rootName);
      } else {
      // A crash immediately after successful marker removal can leave a fully
      // verified tree without ownership metadata. Accept it only when a fresh,
      // read-only comparison proves every expected path and byte already match.
        try {
          const completeExisting = await collectDirectoryHandle(
            root,
            destinationPlan.totalFileBytes,
          );
          const existingReport = await verifyEntryCollections(
            [...expected.directories, ...expected.files],
            completeExisting,
            rootName,
          );
          if (existingReport.ok) return existingReport;
        } catch {
          // Preserve the safer checkpoint refusal below.
        }
        throw checkpointError;
      }
    }
    if (existingEntries.length === 0) {
      existingEntries = await collectPartialDestination(root, destinationPlan);
      assertPartialTreeBelongsToTransfer(expected, existingEntries, rootName);
    }
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
    const expectedHash = destinationPlan.fileHashes.get(file.path)!;
    const wasClaimed = journal.claimedPaths.has(file.path);
    const wasCreated = journal.createdPaths.has(file.path);
    let fileHandle = await tryGetFileHandle(parentDirectory, filename);
    if (fileHandle) {
      const existingBytes = new Uint8Array(
        await (await fileHandle.getFile()).arrayBuffer(),
      );
      if ((await sha256Hex(existingBytes)) === expectedHash) continue;
      if (!wasCreated) {
        if (wasClaimed && existingBytes.length === 0) {
          const nextJournal = cloneDestinationJournal(journal);
          nextJournal.createdPaths.add(file.path);
          await writeCheckpointMarker(root, destinationPlan, nextJournal);
          journal = nextJournal;
        } else {
          throw new Error(
            `Refusing to overwrite a destination file not journaled as safely created by this transfer: ${file.path}`,
          );
        }
      }
    } else {
      let journalBeforeClaim: DestinationJournal | undefined;
      if (!wasClaimed) {
        journalBeforeClaim = cloneDestinationJournal(journal);
        const nextJournal = cloneDestinationJournal(journal);
        nextJournal.claimedPaths.add(file.path);
        await writeCheckpointMarker(root, destinationPlan, nextJournal);
        journal = nextJournal;

        // The journal write and file creation are separate browser operations.
        // Recheck after the journal commit to catch same-origin/external changes
        // that occurred in between. The Web Lock serializes this app's tabs;
        // the browser API has no portable atomic create-if-absent primitive for
        // processes outside the browser.
        fileHandle = await tryGetFileHandle(parentDirectory, filename);
        if (fileHandle) {
          const racedBytes = new Uint8Array(
            await (await fileHandle.getFile()).arrayBuffer(),
          );
          await writeCheckpointMarker(
            root,
            destinationPlan,
            journalBeforeClaim,
          );
          journal = journalBeforeClaim;
          if ((await sha256Hex(racedBytes)) === expectedHash) continue;
          throw new Error(
            `Refusing to overwrite a file created concurrently at: ${file.path}`,
          );
        }
      }

      fileHandle = await parentDirectory.getFileHandle(filename, {
        create: true,
      });
      if (fileHandle.name !== filename) {
        throw new Error(
          `Destination normalized a filename from ${JSON.stringify(filename)} to ${JSON.stringify(fileHandle.name)}.`,
        );
      }

      if (!wasCreated) {
        const createdBytes = new Uint8Array(
          await (await fileHandle.getFile()).arrayBuffer(),
        );
        if (createdBytes.length !== 0) {
          if (journalBeforeClaim) {
            await writeCheckpointMarker(
              root,
              destinationPlan,
              journalBeforeClaim,
            );
            journal = journalBeforeClaim;
          }
          throw new Error(
            `Refusing to overwrite a non-empty file that appeared while creating: ${file.path}`,
          );
        }

        const nextJournal = cloneDestinationJournal(journal);
        nextJournal.createdPaths.add(file.path);
        await writeCheckpointMarker(root, destinationPlan, nextJournal);
        journal = nextJournal;
      }
    }

    if (fileHandle.name !== filename) {
      throw new Error(
        `Destination normalized a filename from ${JSON.stringify(filename)} to ${JSON.stringify(fileHandle.name)}.`,
      );
    }
    await writeFileSafely(fileHandle, file.bytes);
  }

  // This is intentionally a fresh traversal and fresh File.arrayBuffer() read
  // for every destination file; verification does not trust the write buffers.
  const actualWithMarker = await collectPartialDestination(root, destinationPlan);
  const preFinalizeReport = await verifyEntryCollections(
    [...expected.directories, ...expected.files],
    actualWithMarker,
    rootName,
  );
  if (!preFinalizeReport.ok) {
    return preFinalizeReport;
  }

  await root.removeEntry(destinationPlan.markerName);
  try {
    const finalized = await collectDirectoryHandle(
      root,
      destinationPlan.totalFileBytes,
    );
    const finalReport = await verifyEntryCollections(
      [...expected.directories, ...expected.files],
      finalized,
      rootName,
    );
    if (!finalReport.ok) {
      await restoreCheckpointBestEffort(root, destinationPlan, journal);
    }
    return finalReport;
  } catch (error) {
    // Read/permission/quota failures after marker deletion must not strand a
    // non-empty tree that the next attempt is forbidden to resume.
    await restoreCheckpointBestEffort(root, destinationPlan, journal);
    throw error;
  }
  });
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

function normalizeEntries(
  entries: readonly SelectedEntry[],
  maxLogicalEntries = MAX_ARCHIVE_ENTRIES,
): NormalizedTree {
  assertCollectionEntryLimit(maxLogicalEntries);
  if (entries.length > maxLogicalEntries) {
    throw new Error(
      `Folder exceeds the ${maxLogicalEntries}-entry safety limit.`,
    );
  }
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

  // Reject oversized/deep input paths before expanding their implicit parent
  // directories. Otherwise a compact list of adversarial paths can allocate a
  // much larger intermediate tree before the logical entry cap is evaluated.
  validatePortablePathSet(new Set(byPath.keys()));

  const fileCount = Array.from(byPath.values()).reduce(
    (count, entry) => count + (entry.directory ? 0 : 1),
    0,
  );
  const directoryPaths = new Set<string>();
  const addDirectoryPath = (path: string) => {
    if (directoryPaths.has(path)) return;
    directoryPaths.add(path);
    if (directoryPaths.size + fileCount > maxLogicalEntries) {
      throw new Error(
        `Folder exceeds the ${maxLogicalEntries}-entry safety limit after parent directories are included.`,
      );
    }
  };
  for (const [path, entry] of byPath) {
    if (entry.directory) {
      addDirectoryPath(path);
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
      addDirectoryPath(parentPath);
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

  if (files.length + directories.length > maxLogicalEntries) {
    throw new Error(
      `Folder exceeds the ${maxLogicalEntries}-entry safety limit after parent directories are included.`,
    );
  }

  return { files, directories };
}

function compressionLevelForPath(path: string): ZipOptions["level"] {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return ALREADY_COMPRESSED_EXTENSIONS.has(extension) ? 0 : 6;
}

async function createDestinationPlan(
  expected: NormalizedTree,
  rootName: string,
): Promise<DestinationPlan> {
  const hashes = await Promise.all(
    expected.files.map(async (file) => [file.path, await sha256Hex(file.bytes)] as const),
  );
  const fileHashes = new Map(hashes);
  const fingerprintPayload = new TextEncoder().encode(
    JSON.stringify({
      schema: "airgap-qr-destination-fingerprint",
      version: 1,
      rootName,
      directories: expected.directories.map(({ path }) => path),
      files: hashes,
    }),
  );
  const fingerprint = await sha256Hex(fingerprintPayload);
  const occupiedPaths = new Set([
    ...expected.directories.map(({ path }) => path),
    ...expected.files.map(({ path }) => path),
  ]);
  const occupiedAliases = new Set(
    Array.from(occupiedPaths, (path) => path.normalize("NFC").toLowerCase()),
  );
  let suffix = 0;
  let markerName: string;
  do {
    const disambiguator = suffix === 0 ? "" : `-${suffix}`;
    markerName = `${DESTINATION_CHECKPOINT_PREFIX}${fingerprint.slice(0, 20)}${disambiguator}${DESTINATION_CHECKPOINT_SUFFIX}`;
    suffix += 1;
  } while (
    occupiedPaths.has(markerName) ||
    occupiedAliases.has(markerName.normalize("NFC").toLowerCase())
  );

  const filesByIndex = expected.files.map(({ path }) => path);
  return {
    markerName,
    rootName,
    fingerprint,
    fileHashes,
    fileIndexes: new Map(filesByIndex.map((path, index) => [path, index])),
    filesByIndex,
    totalFileBytes: expected.files.reduce(
      (total, file) => total + file.bytes.length,
      0,
    ),
  };
}

async function assertMatchingCheckpoint(
  root: FileSystemDirectoryHandle,
  plan: DestinationPlan,
  rootName: string,
): Promise<DestinationJournal> {
  let markerHandle: FileSystemFileHandle;
  try {
    markerHandle = await root.getFileHandle(plan.markerName);
  } catch {
    throw new Error(
      `Refusing to overwrite non-empty destination folder without a matching AirGap QR checkpoint: ${rootName}`,
    );
  }

  const markerFile = await markerHandle.getFile();
  if (markerFile.size > MAX_DESTINATION_CHECKPOINT_BYTES) {
    throw new Error(`Destination checkpoint is invalid for: ${rootName}`);
  }

  let checkpoint: unknown;
  try {
    const bytes = new Uint8Array(await markerFile.arrayBuffer());
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    checkpoint = JSON.parse(json);
  } catch {
    throw new Error(`Destination checkpoint is invalid for: ${rootName}`);
  }

  const parsed = checkpoint as Partial<DestinationCheckpoint>;
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    parsed.schema !== "airgap-qr-destination-checkpoint" ||
    parsed.version !== 2 ||
    parsed.rootName !== rootName ||
    parsed.fingerprint !== plan.fingerprint ||
    typeof parsed.claimedFileBits !== "string" ||
    typeof parsed.createdFileBits !== "string"
  ) {
    throw new Error(
      `Destination checkpoint belongs to a different transfer: ${rootName}`,
    );
  }
  const claimedPaths = decodeFileBits(parsed.claimedFileBits, plan);
  const createdPaths = decodeFileBits(parsed.createdFileBits, plan);
  for (const path of createdPaths) {
    if (!claimedPaths.has(path)) {
      throw new Error(`Destination checkpoint is invalid for: ${rootName}`);
    }
  }
  return { claimedPaths, createdPaths };
}

async function collectPartialDestination(
  root: FileSystemDirectoryHandle,
  plan: DestinationPlan,
): Promise<SelectedEntry[]> {
  const entries = await collectDirectoryHandle(
    root,
    plan.totalFileBytes + MAX_DESTINATION_CHECKPOINT_BYTES,
    MAX_ARCHIVE_ENTRIES + 1,
  );
  const payloadEntries = entries.filter(({ path }) => path !== plan.markerName);
  if (payloadEntries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `Partial destination exceeds the ${MAX_ARCHIVE_ENTRIES}-entry safety limit.`,
    );
  }
  return payloadEntries;
}

async function hasOnlyRecoverableCheckpointMarker(
  root: FileSystemDirectoryHandle,
  plan: DestinationPlan,
): Promise<boolean> {
  let marker: FileSystemFileHandle | undefined;
  let count = 0;
  for await (const [name, handle] of root.entries()) {
    count += 1;
    if (count > 1) return false;
    if (name !== plan.markerName || handle.kind !== "file") return false;
    marker = handle;
  }
  if (count !== 1 || !marker) return false;
  const markerFile = await marker.getFile();
  if (markerFile.size > MAX_DESTINATION_CHECKPOINT_BYTES) return false;
  const persisted = new Uint8Array(await markerFile.arrayBuffer());
  const initial = encodeDestinationCheckpoint(plan, {
    claimedPaths: new Set<string>(),
    createdPaths: new Set<string>(),
  });
  return (
    persisted.length < initial.length &&
    bytesEqual(persisted, initial.subarray(0, persisted.length))
  );
}

function assertPartialTreeBelongsToTransfer(
  expected: NormalizedTree,
  existingEntries: readonly SelectedEntry[],
  rootName: string,
): void {
  const expectedKinds = new Map<string, "file" | "directory">([
    ...expected.directories.map(
      ({ path }) => [path, "directory"] as const,
    ),
    ...expected.files.map(({ path }) => [path, "file"] as const),
  ]);
  for (const entry of existingEntries) {
    const actualKind = entry.directory ? "directory" : "file";
    if (expectedKinds.get(entry.path) !== actualKind) {
      throw new Error(
        `Refusing to resume ${rootName}: the partial destination contains an unrelated or conflicting path: ${entry.path}`,
      );
    }
  }
}

function encodeDestinationCheckpoint(
  plan: DestinationPlan,
  journal: DestinationJournal,
): Uint8Array {
  const claimedFileBits = encodeFileBits(journal.claimedPaths, plan);
  const createdFileBits = encodeFileBits(journal.createdPaths, plan);
  for (const path of journal.createdPaths) {
    if (!journal.claimedPaths.has(path)) {
      throw new Error(
        `Destination checkpoint marks an unclaimed file as created: ${path}`,
      );
    }
  }
  const checkpoint: DestinationCheckpoint = {
    schema: "airgap-qr-destination-checkpoint",
    version: 2,
    rootName: plan.rootName,
    fingerprint: plan.fingerprint,
    claimedFileBits,
    createdFileBits,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(checkpoint));
  if (encoded.length > MAX_DESTINATION_CHECKPOINT_BYTES) {
    throw new Error("Destination checkpoint exceeds its safety limit.");
  }
  return encoded;
}

function encodeFileBits(
  paths: ReadonlySet<string>,
  plan: DestinationPlan,
): string {
  const bits = new Uint8Array(Math.ceil(plan.filesByIndex.length / 8));
  for (const path of paths) {
    const index = plan.fileIndexes.get(path);
    if (index === undefined) {
      throw new Error(`Destination checkpoint contains an unknown file path: ${path}`);
    }
    bits[index >>> 3] |= 1 << (index & 7);
  }
  return Array.from(bits, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function decodeFileBits(
  encoded: string,
  plan: DestinationPlan,
): Set<string> {
  const expectedHexLength = Math.ceil(plan.filesByIndex.length / 8) * 2;
  if (
    encoded.length !== expectedHexLength ||
    !/^[0-9a-f]*$/.test(encoded)
  ) {
    throw new Error(`Destination checkpoint is invalid for: ${plan.rootName}`);
  }
  const paths = new Set<string>();
  for (let byteIndex = 0; byteIndex < encoded.length / 2; byteIndex += 1) {
    const value = Number.parseInt(encoded.slice(byteIndex * 2, byteIndex * 2 + 2), 16);
    for (let bit = 0; bit < 8; bit += 1) {
      if ((value & (1 << bit)) === 0) continue;
      const fileIndex = byteIndex * 8 + bit;
      const path = plan.filesByIndex[fileIndex];
      if (path === undefined) {
        throw new Error(`Destination checkpoint is invalid for: ${plan.rootName}`);
      }
      paths.add(path);
    }
  }
  return paths;
}

function cloneDestinationJournal(
  journal: DestinationJournal,
): DestinationJournal {
  return {
    claimedPaths: new Set(journal.claimedPaths),
    createdPaths: new Set(journal.createdPaths),
  };
}

async function writeCheckpointMarker(
  root: FileSystemDirectoryHandle,
  plan: DestinationPlan,
  journal: DestinationJournal,
  removeOnFailure = false,
): Promise<void> {
  let marker = await tryGetFileHandle(root, plan.markerName);
  const markerExisted = marker !== undefined;
  marker ??= await root.getFileHandle(plan.markerName, { create: true });
  if (marker.name !== plan.markerName) {
    throw new Error("Destination normalized the transfer checkpoint filename.");
  }
  let previousBytes: Uint8Array | undefined;
  if (markerExisted && !removeOnFailure) {
    previousBytes = new Uint8Array(
      await (await marker.getFile()).arrayBuffer(),
    );
  }
  try {
    const expectedBytes = encodeDestinationCheckpoint(plan, journal);
    await writeFileSafely(marker, expectedBytes);
    const persistedBytes = new Uint8Array(
      await (await marker.getFile()).arrayBuffer(),
    );
    if (!bytesEqual(expectedBytes, persistedBytes)) {
      throw new Error("Destination checkpoint did not persist byte-exactly.");
    }
  } catch (error) {
    if (previousBytes) {
      // Updating a journal must not turn a previously valid checkpoint into a
      // half-written one when the platform surfaces the write failure.
      try {
        await writeFileSafely(marker, previousBytes);
        const restoredBytes = new Uint8Array(
          await (await marker.getFile()).arrayBuffer(),
        );
        if (!bytesEqual(previousBytes, restoredBytes)) {
          throw new Error("The previous checkpoint did not restore byte-exactly.");
        }
      } catch (restorationError) {
        throw new Error(
          `Destination checkpoint update failed and its previous valid state could not be restored. Original error: ${toError(error).message}. Restore error: ${toError(restorationError).message}`,
        );
      }
    } else if (removeOnFailure || !markerExisted) {
      // A half-written initial ownership marker must never make an otherwise
      // untouched folder look resumable.
      try {
        await root.removeEntry(plan.markerName);
      } catch {
        // Preserve the original marker-write error.
      }
    }
    throw error;
  }
}

async function restoreCheckpointBestEffort(
  root: FileSystemDirectoryHandle,
  plan: DestinationPlan,
  journal: DestinationJournal,
): Promise<void> {
  try {
    await writeCheckpointMarker(root, plan, journal);
  } catch {
    // The verification/read error that triggered restoration remains primary.
    // A later retry can still accept a byte-exact complete tree read-only.
  }
}

async function writeFileSafely(
  file: FileSystemFileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let writable: FileSystemWritableFileStream;
  try {
    // Exclusive mode prevents another writable stream from silently winning a
    // last-close race where the browser implements the current API option.
    writable = await file.createWritable({ mode: "exclusive" });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // Older File System Access implementations reject unknown options. Final
    // re-read/SHA verification still protects correctness on those browsers.
    writable = await file.createWritable();
  }
  try {
    await writable.write(Uint8Array.from(bytes));
    await writable.close();
  } catch (error) {
    try {
      await writable.abort(error);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
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
    if ((flags & 0x8) !== 0) {
      throw new Error(
        "Streaming ZIP data descriptors are not supported by this bounded extractor.",
      );
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
    const localCrc32 = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localFilenameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localHeaderEnd =
      localOffset + 30 + localFilenameLength + localExtraLength;
    if (
      localHeaderEnd > centralOffset ||
      localHeaderEnd + compressedSize > centralOffset
    ) {
      throw new Error("Invalid ZIP local-file header bounds.");
    }
    const localPath = strFromU8(
      bytes.subarray(localOffset + 30, localOffset + 30 + localFilenameLength),
      (localFlags & 0x800) === 0,
    );
    if (
      localPath !== archivePath ||
      localCompression !== compression ||
      localFlags !== flags ||
      localCrc32 !== expectedCrc32 ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize
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

async function withDestinationWriteLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      DESTINATION_WRITE_LOCK,
      { mode: "exclusive" },
      operation,
    );
  }
  return operation();
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

async function tryGetFileHandle(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | undefined> {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return undefined;
    }
    throw error;
  }
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
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

function assertCollectionEntryLimit(maxEntries: number): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new Error("Collection entry limit must be a non-negative safe integer.");
  }
}

function formatLimit(bytes: number): string {
  if (!Number.isFinite(bytes)) return "configured";
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}
