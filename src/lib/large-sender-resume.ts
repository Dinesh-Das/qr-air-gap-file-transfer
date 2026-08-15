import {
  collectLargeDirectory,
  createQrf3LargeSource,
  prepareLargeSource,
  type LargeSourceSelection,
  type LargeTransferProgress,
  type PreparedLargeSource,
} from "./large-transfer";
import {
  QRF3_CONNECTION_TEST_ROOT_NAME,
  matchesQrf3FilesBinding,
  verifyQrf3ConnectionTest,
  type PreparedQrf3ConnectionTest,
} from "./large-connection";
import {
  Qrf3BlobSource,
  Qrf3TransferPurpose,
  createQrf3Transfer,
  type Qrf3TransferPlan,
} from "./stream-protocol";

const DATABASE_NAME = "qr-air-gap-large-sender-resume";
const DATABASE_VERSION = 1;
const SESSION_STORE = "sessions";
const UPDATED_AT_INDEX = "by-updated-at";

export type StoredLargeSenderPhase = "testing" | "verified";

/**
 * File-system handles are structured-cloneable IndexedDB values. Persisting the
 * root handle lets reload recovery re-enumerate and re-hash the source without
 * copying a very large tree into browser storage.
 */
export interface StoredLargeSenderSession {
  key: string;
  version: 1;
  revision: string;
  phase: StoredLargeSenderPhase;
  rootName: string;
  rootHandle: FileSystemDirectoryHandle;
  fileCount: number;
  directoryCount: number;
  totalFileBytes: string;
  framesPerSecond: number;
  blockSize: number;
  connectionId: Uint8Array;
  filesTransferId: Uint8Array;
  filesCreatedAtMs: number;
  filesManifestId: Uint8Array;
  filesStreamSha256: Uint8Array;
  filesTransferLength: number;
  probeBytes: Uint8Array;
  probeTransferId: Uint8Array;
  probeCreatedAtMs: number;
  probeManifestId: Uint8Array;
  updatedAt: number;
}

export interface RestoredLargeSenderSession {
  selection: LargeSourceSelection;
  preparedSource: PreparedLargeSource;
  filesPlan: Qrf3TransferPlan;
  probe: PreparedQrf3ConnectionTest;
}

let databasePromise: Promise<IDBDatabase> | undefined;
let mutationQueue: Promise<void> = Promise.resolve();

export function supportsLargeSenderResume(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function saveLargeSenderSession(
  session: Omit<
    StoredLargeSenderSession,
    "key" | "version" | "revision" | "updatedAt"
  >,
  previous?: StoredLargeSenderSession,
): Promise<StoredLargeSenderSession> {
  const record: StoredLargeSenderSession = {
    ...session,
    key: previous?.key ?? randomToken(),
    version: 1,
    revision: randomToken(),
    connectionId: Uint8Array.from(session.connectionId),
    filesTransferId: Uint8Array.from(session.filesTransferId),
    filesManifestId: Uint8Array.from(session.filesManifestId),
    filesStreamSha256: Uint8Array.from(session.filesStreamSha256),
    probeBytes: Uint8Array.from(session.probeBytes),
    probeTransferId: Uint8Array.from(session.probeTransferId),
    probeManifestId: Uint8Array.from(session.probeManifestId),
    updatedAt: Date.now(),
  };
  return enqueueMutation(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(SESSION_STORE, "readwrite");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(SESSION_STORE);
    if (previous) {
      const current = await requestResult<StoredLargeSenderSession | undefined>(
        store.get(previous.key),
      );
      if (
        !current ||
        current.version !== previous.version ||
        current.revision !== previous.revision
      ) {
        transaction.abort();
        await completed.catch(() => undefined);
        throw new Error(
          "This large sender session changed in another tab; the stale tab was not allowed to overwrite it.",
        );
      }
    }
    store.put(record);
    await completed;
    return record;
  });
}

export async function loadLargeSenderSession(
  preferredKey?: string | null,
): Promise<StoredLargeSenderSession | null> {
  if (!supportsLargeSenderResume()) return null;
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readonly");
  const completed = transactionComplete(transaction);
  const store = transaction.objectStore(SESSION_STORE);
  const record = preferredKey
    ? await requestResult<StoredLargeSenderSession | undefined>(
        store.get(preferredKey),
      )
    : (
        await requestResult<IDBCursorWithValue | null>(
          store.index(UPDATED_AT_INDEX).openCursor(null, "prev"),
        )
      )?.value as StoredLargeSenderSession | undefined;
  await completed;
  return record ?? null;
}

export async function deleteLargeSenderSession(
  expected: Pick<StoredLargeSenderSession, "key" | "version" | "revision">,
): Promise<boolean> {
  if (!supportsLargeSenderResume()) return true;
  return enqueueMutation(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(SESSION_STORE, "readwrite");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(SESSION_STORE);
    const current = await requestResult<StoredLargeSenderSession | undefined>(
      store.get(expected.key),
    );
    if (!current) {
      await completed;
      return true;
    }
    if (
      current.version !== expected.version ||
      current.revision !== expected.revision
    ) {
      await completed;
      return false;
    }
    store.delete(expected.key);
    await completed;
    return true;
  });
}

/** Re-enumerates and re-hashes a persisted source before rebuilding exact plans. */
export async function restoreLargeSenderSession(
  session: StoredLargeSenderSession,
  onProgress?: (progress: LargeTransferProgress) => void,
  signal?: AbortSignal,
): Promise<RestoredLargeSenderSession> {
  assertStoredSession(session);
  await requireReadPermission(session.rootHandle);
  const selection = await collectLargeDirectory(
    session.rootHandle,
    onProgress,
    signal,
  );
  if (
    selection.rootName !== session.rootName ||
    selection.files.length !== session.fileCount ||
    selection.directories.length !== session.directoryCount ||
    selection.totalFileBytes !== BigInt(session.totalFileBytes)
  ) {
    throw new Error(
      "The selected source tree changed after this QRF3 sender session was saved.",
    );
  }
  const preparedSource = await prepareLargeSource(selection, onProgress, signal);
  if (
    preparedSource.totalStreamBytes !== BigInt(session.filesTransferLength) ||
    !bytesEqual(preparedSource.streamSha256, session.filesStreamSha256)
  ) {
    throw new Error(
      "The source bytes or metadata changed after this QRF3 sender session was saved.",
    );
  }

  const filesPlan = await createQrf3Transfer(createQrf3LargeSource(preparedSource), {
    rootName: session.rootName,
    blockSize: session.blockSize,
    transferId: session.filesTransferId,
    createdAtMs: session.filesCreatedAtMs,
    purpose: Qrf3TransferPurpose.Files,
    connectionId: session.connectionId,
    archiveSha256: session.filesStreamSha256,
  });
  if (!bytesEqual(filesPlan.manifestId, session.filesManifestId)) {
    throw new Error("The saved QRF3 Files identity could not be reproduced.");
  }

  const probeTransfer = await createQrf3Transfer(
    new Qrf3BlobSource(new Blob([Uint8Array.from(session.probeBytes)])),
    {
      rootName: QRF3_CONNECTION_TEST_ROOT_NAME,
      blockSize: session.blockSize,
      transferId: session.probeTransferId,
      createdAtMs: session.probeCreatedAtMs,
      purpose: Qrf3TransferPurpose.ConnectionTest,
      connectionId: session.connectionId,
    },
  );
  if (!bytesEqual(probeTransfer.manifestId, session.probeManifestId)) {
    throw new Error("The saved QRF3 connection-test identity could not be reproduced.");
  }
  const verifiedProbe = verifyQrf3ConnectionTest(
    session.probeBytes,
    probeTransfer.manifest,
  );
  if (!matchesQrf3FilesBinding(verifiedProbe.filesBinding, filesPlan)) {
    throw new Error("The saved QRF3 probe is not bound to the restored Files stream.");
  }

  return {
    selection,
    preparedSource,
    filesPlan,
    probe: {
      bytes: Uint8Array.from(session.probeBytes),
      transfer: probeTransfer,
      filesBinding: verifiedProbe.filesBinding,
      receiptCode: verifiedProbe.receiptCode,
    },
  };
}

async function requireReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  if (!handle || handle.kind !== "directory") {
    throw new Error("The saved source directory handle is invalid.");
  }
  const descriptor = { mode: "read" as const };
  const current = handle.queryPermission
    ? await handle.queryPermission(descriptor)
    : "granted";
  if (current === "granted") return;
  const requested = handle.requestPermission
    ? await handle.requestPermission(descriptor)
    : current;
  if (requested !== "granted") {
    throw new Error("Read permission for the saved source directory was not granted.");
  }
}

function assertStoredSession(session: StoredLargeSenderSession): void {
  if (!session || session.version !== 1) {
    throw new Error("The saved large sender session has an unsupported version.");
  }
  if (session.phase !== "testing" && session.phase !== "verified") {
    throw new Error("The saved large sender phase is invalid.");
  }
  if (!Number.isSafeInteger(session.filesTransferLength) || session.filesTransferLength < 0) {
    throw new Error("The saved QRF3 transfer length is invalid.");
  }
  if (!Number.isSafeInteger(session.blockSize) || session.blockSize < 1) {
    throw new Error("The saved QRF3 block size is invalid.");
  }
  for (const [bytes, length, field] of [
    [session.connectionId, 16, "connection ID"],
    [session.filesTransferId, 16, "Files transfer ID"],
    [session.filesManifestId, 32, "Files manifest identity"],
    [session.filesStreamSha256, 32, "Files stream hash"],
    [session.probeTransferId, 16, "probe transfer ID"],
    [session.probeManifestId, 32, "probe manifest identity"],
  ] as const) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
      throw new Error(`The saved ${field} is invalid.`);
    }
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function openDatabase(): Promise<IDBDatabase> {
  if (!supportsLargeSenderResume()) {
    return Promise.reject(
      new Error("This browser does not support durable large-sender resume."),
    );
  }
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(SESSION_STORE)
        ? request.transaction!.objectStore(SESSION_STORE)
        : database.createObjectStore(SESSION_STORE, { keyPath: "key" });
      if (!store.indexNames.contains(UPDATED_AT_INDEX)) {
        store.createIndex(UPDATED_AT_INDEX, "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(
        request.error ?? new Error("Large sender resume storage could not be opened."),
      );
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error("Large sender resume storage is blocked by another tab."));
    };
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Large sender resume storage request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Large sender resume transaction failed."),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("Large sender resume transaction aborted."),
      );
  });
}
