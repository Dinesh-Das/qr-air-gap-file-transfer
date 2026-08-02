import {
  verifyConnectionTest,
  type VerifiedConnectionTest,
} from "./connection";
import { CONNECTION_ID_SIZE } from "./protocol";

const DATABASE_NAME = "qr-air-gap-resume";
const DATABASE_VERSION = 1;
const CHECKPOINT_STORE = "checkpoints";
const FRAME_STORE = "frames";
const FRAME_CHECKPOINT_INDEX = "by-checkpoint";
const CHECKPOINT_SCHEMA_VERSION = 2;
const MAX_STORED_PROBE_ARCHIVE_BYTES = 64 * 1024;

export interface ResumeCheckpoint {
  version: typeof CHECKPOINT_SCHEMA_VERSION;
  key: string;
  connectionId: string;
  /** The verified ConnectionTest transfer whose payload commits to Files. */
  probeTransferId: number;
  /** Replayed through verifyConnectionTest before any saved Files frame is trusted. */
  probeArchiveBytes: Uint8Array;
  transferId: number;
  rootName?: string;
  receivedChunks: number;
  totalChunks: number;
  receivedBytes: number;
  expectedArchiveBytes?: number;
  expectedArchiveSha256?: string;
  expectedManifestSha256?: string;
  updatedAt: number;
  /** Changes on every durable metadata write for race-safe conditional cleanup. */
  storageRevision?: string;
}

export interface StoredResumeFrame {
  id: string;
  checkpointKey: string;
  /** Manifest is -1; data frames use their zero-based chunk index. */
  position: number;
  encoded: string;
}

let databasePromise: Promise<IDBDatabase> | undefined;

export function supportsDurableResume(): boolean {
  return typeof indexedDB !== "undefined";
}

export function resumeCheckpointKey(
  connectionId: string,
  transferId: number,
): string {
  return `${connectionId.toUpperCase()}:${transferId.toString(16).padStart(8, "0")}`;
}

/**
 * Persists a verified dummy proof without Files frames. Existing frames under
 * the same key are cleared atomically, which is also used after a failed Files
 * archive verification to retain the proof while restarting frame capture.
 */
export async function saveResumeCheckpoint(
  checkpoint: ResumeCheckpoint,
): Promise<ResumeCheckpoint> {
  const record = createStoredCheckpoint(checkpoint);
  const database = await openDatabase();
  const transaction = database.transaction(
    [CHECKPOINT_STORE, FRAME_STORE],
    "readwrite",
  );
  const completed = transactionComplete(transaction);
  transaction.objectStore(CHECKPOINT_STORE).put(record);
  await deleteFrameRecords(transaction, checkpoint.key);
  await completed;
  return record;
}

export async function saveResumeFrame(
  checkpoint: ResumeCheckpoint,
  position: number,
  encoded: string,
): Promise<void> {
  if (!Number.isSafeInteger(position) || position < -1) {
    throw new Error("Resume frame position is invalid.");
  }
  if (!encoded) throw new Error("Resume frame is empty.");
  const database = await openDatabase();
  const transaction = database.transaction(
    [CHECKPOINT_STORE, FRAME_STORE],
    "readwrite",
  );
  const completed = transactionComplete(transaction);
  transaction
    .objectStore(CHECKPOINT_STORE)
    .put(createStoredCheckpoint(checkpoint));
  transaction.objectStore(FRAME_STORE).put({
    id: `${checkpoint.key}:${position}`,
    checkpointKey: checkpoint.key,
    position,
    encoded,
  } satisfies StoredResumeFrame);
  await completed;
}

export async function listResumeCheckpoints(): Promise<ResumeCheckpoint[]> {
  if (!supportsDurableResume()) return [];
  const database = await openDatabase();
  const transaction = database.transaction(CHECKPOINT_STORE, "readonly");
  const completed = transactionComplete(transaction);
  const records = await requestResult<ResumeCheckpoint[]>(
    transaction.objectStore(CHECKPOINT_STORE).getAll(),
  );
  await completed;
  return records.sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function loadResumeFrames(
  key: string,
): Promise<StoredResumeFrame[]> {
  return loadResumeFrameRecords(key);
}

export async function deleteResumeCheckpoint(key: string): Promise<void> {
  if (!supportsDurableResume()) return;
  const database = await openDatabase();
  const transaction = database.transaction(
    [CHECKPOINT_STORE, FRAME_STORE],
    "readwrite",
  );
  const completed = transactionComplete(transaction);
  transaction.objectStore(CHECKPOINT_STORE).delete(key);
  await deleteFrameRecords(transaction, key);
  await completed;
}

/**
 * Deletes only the exact checkpoint revision supplied by the caller. This is
 * used when a reset wins the race with an awaited metadata-only proof write;
 * a newer frame/checkpoint write from another context is never removed.
 */
export async function deleteResumeCheckpointIfUnchanged(
  checkpoint: ResumeCheckpoint,
): Promise<boolean> {
  if (!supportsDurableResume() || !checkpoint.storageRevision) return false;
  const database = await openDatabase();
  const transaction = database.transaction(
    [CHECKPOINT_STORE, FRAME_STORE],
    "readwrite",
  );
  const completed = transactionComplete(transaction);
  const existing = await requestResult<ResumeCheckpoint | undefined>(
    transaction.objectStore(CHECKPOINT_STORE).get(checkpoint.key),
  );
  if (existing?.storageRevision !== checkpoint.storageRevision) {
    await completed;
    return false;
  }
  transaction.objectStore(CHECKPOINT_STORE).delete(checkpoint.key);
  await deleteFrameRecords(transaction, checkpoint.key);
  await completed;
  return true;
}

/**
 * Re-verifies the complete stored dummy and proves that every saved Files
 * binding field is exactly the one committed inside that dummy.
 */
export async function verifyResumeCheckpointProof(
  checkpoint: ResumeCheckpoint,
): Promise<VerifiedConnectionTest> {
  if (!checkpoint || checkpoint.version !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(
      "The saved checkpoint predates reload-safe dummy proof storage; discard it and repeat the connection test.",
    );
  }
  assertUint32(checkpoint.transferId, "saved Files transfer ID");
  assertUint32(checkpoint.probeTransferId, "saved ConnectionTest transfer ID");
  const connectionId = decodeHex(
    checkpoint.connectionId,
    CONNECTION_ID_SIZE,
    "saved connection ID",
  );
  const normalizedConnectionId = encodeHex(connectionId);
  if (
    checkpoint.key !==
    resumeCheckpointKey(normalizedConnectionId, checkpoint.transferId)
  ) {
    throw new Error("The saved checkpoint key does not match its protected binding.");
  }
  if (
    !(checkpoint.probeArchiveBytes instanceof Uint8Array) ||
    checkpoint.probeArchiveBytes.length === 0 ||
    checkpoint.probeArchiveBytes.length > MAX_STORED_PROBE_ARCHIVE_BYTES
  ) {
    throw new Error("The saved checkpoint dummy proof is missing or invalid.");
  }
  const expectedArchiveSha256 = decodeHex(
    checkpoint.expectedArchiveSha256,
    32,
    "saved archive SHA-256",
  );
  const expectedManifestSha256 = decodeHex(
    checkpoint.expectedManifestSha256,
    32,
    "saved manifest SHA-256",
  );

  const verified = await verifyConnectionTest(
    Uint8Array.from(checkpoint.probeArchiveBytes),
    connectionId,
    checkpoint.probeTransferId,
  );
  if (
    verified.filesBinding.transferId !== checkpoint.transferId ||
    encodeHex(verified.filesBinding.connectionId) !== normalizedConnectionId ||
    !bytesEqual(verified.filesBinding.archiveSha256, expectedArchiveSha256) ||
    !bytesEqual(verified.filesBinding.manifestSha256, expectedManifestSha256)
  ) {
    throw new Error(
      "The saved checkpoint does not exactly match the Files transfer committed by its verified dummy proof.",
    );
  }
  return verified;
}

export async function deleteResumeFrame(
  checkpointKey: string,
  position: number,
): Promise<void> {
  if (!supportsDurableResume()) return;
  if (!Number.isSafeInteger(position) || position < -1) {
    throw new Error("Resume frame position is invalid.");
  }
  const database = await openDatabase();
  const transaction = database.transaction(FRAME_STORE, "readwrite");
  const completed = transactionComplete(transaction);
  transaction
    .objectStore(FRAME_STORE)
    .delete(`${checkpointKey}:${position}`);
  await completed;
}

export async function clearResumeCheckpoints(): Promise<void> {
  if (!supportsDurableResume()) return;
  const database = await openDatabase();
  const transaction = database.transaction(
    [CHECKPOINT_STORE, FRAME_STORE],
    "readwrite",
  );
  const completed = transactionComplete(transaction);
  transaction.objectStore(CHECKPOINT_STORE).clear();
  transaction.objectStore(FRAME_STORE).clear();
  await completed;
}

async function loadResumeFrameRecords(
  key: string,
): Promise<StoredResumeFrame[]> {
  if (!supportsDurableResume()) return [];
  const database = await openDatabase();
  const transaction = database.transaction(FRAME_STORE, "readonly");
  const completed = transactionComplete(transaction);
  const records = await requestResult<StoredResumeFrame[]>(
    transaction
      .objectStore(FRAME_STORE)
      .index(FRAME_CHECKPOINT_INDEX)
      .getAll(key),
  );
  await completed;
  return records.sort((left, right) => left.position - right.position);
}

function createStoredCheckpoint(
  checkpoint: ResumeCheckpoint,
): ResumeCheckpoint {
  if (checkpoint.version !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error("Resume checkpoint schema version is invalid.");
  }
  if (!(checkpoint.probeArchiveBytes instanceof Uint8Array)) {
    throw new Error("Resume checkpoint dummy proof must be bytes.");
  }
  return {
    ...checkpoint,
    probeArchiveBytes: Uint8Array.from(checkpoint.probeArchiveBytes),
    updatedAt: Date.now(),
    storageRevision: createStorageRevision(),
  };
}

async function deleteFrameRecords(
  transaction: IDBTransaction,
  checkpointKey: string,
): Promise<void> {
  const frameStore = transaction.objectStore(FRAME_STORE);
  const frameKeys = await requestResult<IDBValidKey[]>(
    frameStore.index(FRAME_CHECKPOINT_INDEX).getAllKeys(checkpointKey),
  );
  for (const frameKey of frameKeys) frameStore.delete(frameKey);
}

function createStorageRevision(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return encodeHex(bytes);
}

function decodeHex(
  value: string | undefined,
  expectedLength: number,
  field: string,
): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length !== expectedLength * 2 ||
    !/^[0-9a-f]+$/i.test(value)
  ) {
    throw new Error(`${field} is invalid.`);
  }
  const bytes = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("").toUpperCase();
}

function assertUint32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${field} is invalid.`);
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

function openDatabase(): Promise<IDBDatabase> {
  if (!supportsDurableResume()) {
    return Promise.reject(
      new Error("This browser does not support durable transfer resume."),
    );
  }
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHECKPOINT_STORE)) {
        database.createObjectStore(CHECKPOINT_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(FRAME_STORE)) {
        const frameStore = database.createObjectStore(FRAME_STORE, {
          keyPath: "id",
        });
        frameStore.createIndex(
          FRAME_CHECKPOINT_INDEX,
          "checkpointKey",
          { unique: false },
        );
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
      reject(request.error ?? new Error("Resume storage could not be opened."));
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error("Resume storage upgrade is blocked by another tab."));
    };
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Resume storage request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Resume storage transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Resume storage transaction aborted."));
  });
}
