import {
  verifyQrf3ConnectionTest,
  type Qrf3FilesBinding,
} from "./large-connection";
import {
  encodeQrf3Manifest,
  type Qrf3Manifest,
} from "./stream-protocol";

const DATABASE_NAME = "qr-air-gap-qrf3-receiver-resume";
const DATABASE_VERSION = 1;
const CONNECTION_STORE = "verified-connections";
const ACTIVE_KEY = "active";
const RECORD_VERSION = 1 as const;

export interface Qrf3ReceiverResumeRecord {
  key: typeof ACTIVE_KEY;
  version: typeof RECORD_VERSION;
  probeBytes: Uint8Array;
  probeManifest: Qrf3Manifest;
  updatedAt: number;
}

/** Injectable so the exact structured-clone reload path can be tested. */
export interface Qrf3ReceiverResumeRepository {
  get(): Promise<unknown>;
  put(record: Qrf3ReceiverResumeRecord): Promise<void>;
  delete(): Promise<void>;
}

export interface RestoredQrf3Connection {
  receiptCode: string;
  filesBinding: Qrf3FilesBinding;
}

let databasePromise: Promise<IDBDatabase> | undefined;

export function supportsQrf3ReceiverResume(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * Saves the complete verified probe, rather than trusting a loose collection
 * of binding fields after reload. Loading rechecks its stream hash and decodes
 * the binding from those exact bytes again.
 */
export async function saveQrf3ReceiverConnection(
  probeBytes: Uint8Array,
  probeManifest: Qrf3Manifest,
  repository?: Qrf3ReceiverResumeRepository,
): Promise<RestoredQrf3Connection> {
  const restored = verifyStoredConnection(probeBytes, probeManifest);
  const record: Qrf3ReceiverResumeRecord = {
    key: ACTIVE_KEY,
    version: RECORD_VERSION,
    probeBytes: Uint8Array.from(probeBytes),
    probeManifest: cloneManifest(probeManifest),
    updatedAt: Date.now(),
  };
  if (repository) await repository.put(record);
  else await putStoredConnection(record);
  return restored;
}

export async function loadQrf3ReceiverConnection(
  repository?: Qrf3ReceiverResumeRepository,
): Promise<RestoredQrf3Connection | null> {
  if (!repository && !supportsQrf3ReceiverResume()) return null;
  const value = repository ? await repository.get() : await getStoredConnection();
  if (value === undefined || value === null) return null;
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version !== RECORD_VERSION
  ) {
    throw new Error("The saved QRF3 receiver session uses an unsupported version.");
  }
  const record = parseStoredConnection(value);
  return verifyStoredConnection(record.probeBytes, record.probeManifest);
}

export async function clearQrf3ReceiverConnection(
  repository?: Qrf3ReceiverResumeRepository,
): Promise<void> {
  if (repository) {
    await repository.delete();
    return;
  }
  if (!supportsQrf3ReceiverResume()) return;
  await deleteStoredConnection();
}

async function putStoredConnection(record: Qrf3ReceiverResumeRecord): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(CONNECTION_STORE, "readwrite");
  const completed = transactionComplete(transaction);
  transaction.objectStore(CONNECTION_STORE).put(record);
  await completed;
}

async function getStoredConnection(): Promise<unknown> {
  const database = await openDatabase();
  const transaction = database.transaction(CONNECTION_STORE, "readonly");
  const completed = transactionComplete(transaction);
  const [value] = await Promise.all([
    requestResult<unknown>(transaction.objectStore(CONNECTION_STORE).get(ACTIVE_KEY)),
    completed,
  ]);
  return value;
}

async function deleteStoredConnection(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(CONNECTION_STORE, "readwrite");
  const completed = transactionComplete(transaction);
  transaction.objectStore(CONNECTION_STORE).delete(ACTIVE_KEY);
  await completed;
}

function verifyStoredConnection(
  probeBytes: Uint8Array,
  probeManifest: Qrf3Manifest,
): RestoredQrf3Connection {
  if (!(probeBytes instanceof Uint8Array)) {
    throw new Error("The saved QRF3 probe bytes are missing.");
  }
  // Canonical encoding validates every manifest field before it is trusted.
  encodeQrf3Manifest(probeManifest);
  return verifyQrf3ConnectionTest(probeBytes, probeManifest);
}

function parseStoredConnection(value: unknown): Qrf3ReceiverResumeRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("key" in value) ||
    value.key !== ACTIVE_KEY ||
    !("version" in value) ||
    value.version !== RECORD_VERSION ||
    !("probeBytes" in value) ||
    !(value.probeBytes instanceof Uint8Array) ||
    !("probeManifest" in value) ||
    typeof value.probeManifest !== "object" ||
    value.probeManifest === null ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt)
  ) {
    throw new Error("The saved QRF3 receiver session record is invalid.");
  }
  return value as Qrf3ReceiverResumeRecord;
}

function cloneManifest(manifest: Qrf3Manifest): Qrf3Manifest {
  return {
    ...manifest,
    transferId: Uint8Array.from(manifest.transferId),
    archiveSha256: Uint8Array.from(manifest.archiveSha256),
    connectionId: Uint8Array.from(manifest.connectionId),
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (!supportsQrf3ReceiverResume()) {
    return Promise.reject(
      new Error("This browser does not support durable QRF3 receiver resume."),
    );
  }
  if (databasePromise) return databasePromise;
  let blocked = false;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CONNECTION_STORE)) {
        request.result.createObjectStore(CONNECTION_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => {
        database.close();
        if (databasePromise === pending) databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      if (databasePromise === pending) databasePromise = undefined;
      reject(request.error ?? new Error("QRF3 receiver resume storage could not be opened."));
    };
    request.onblocked = () => {
      blocked = true;
      if (databasePromise === pending) databasePromise = undefined;
      reject(new Error("QRF3 receiver resume storage is blocked by another tab."));
    };
  });
  databasePromise = pending;
  return pending;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("QRF3 receiver resume request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("QRF3 receiver resume transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("QRF3 receiver resume transaction aborted."));
  });
}
