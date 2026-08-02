const DATABASE_NAME = "qr-air-gap-sender-resume";
const DATABASE_VERSION = 2;
const SESSION_STORE = "sessions";
const UPDATED_AT_INDEX = "by-updated-at";

export type StoredSenderPhase = "testing" | "verified";

export interface StoredSenderSession {
  /** A random per-stream key. Older builds used the unsafe global key `active`. */
  key: string;
  version: 2;
  /** Changes on every successful update so stale tabs cannot mutate this record. */
  revision: string;
  phase: StoredSenderPhase;
  rootName: string;
  capturesEmptyDirectories: boolean;
  archiveBytes: Uint8Array;
  probeArchiveBytes: Uint8Array;
  probeManifestSha256: Uint8Array;
  connectionId: Uint8Array;
  chunkSize: number;
  framesPerSecond: number;
  errorCorrectionLevel: "L" | "M" | "Q";
  filesTransferId: number;
  filesCreatedAtMs: number;
  probeTransferId: number;
  probeCreatedAtMs: number;
  updatedAt: number;
}

let databasePromise: Promise<IDBDatabase> | undefined;
let mutationQueue: Promise<void> = Promise.resolve();

export function supportsSenderResume(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function saveSenderSession(
  session: Omit<
    StoredSenderSession,
    "key" | "version" | "revision" | "updatedAt"
  >,
  previous?: StoredSenderSession,
): Promise<StoredSenderSession> {
  const record: StoredSenderSession = {
    ...session,
    key: previous?.key ?? randomToken(),
    version: 2,
    revision: randomToken(),
    archiveBytes: Uint8Array.from(session.archiveBytes),
    probeArchiveBytes: Uint8Array.from(session.probeArchiveBytes),
    probeManifestSha256: Uint8Array.from(session.probeManifestSha256),
    connectionId: Uint8Array.from(session.connectionId),
    updatedAt: Date.now(),
  };
  return enqueueMutation(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(SESSION_STORE, "readwrite");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(SESSION_STORE);
    if (previous) {
      const current = await requestResult<StoredSenderSession | undefined>(
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
          "This sender session changed in another tab; the stale tab was not allowed to overwrite it.",
        );
      }
    }
    store.put(record);
    await completed;
    return record;
  });
}

export async function loadSenderSession(
  preferredKey?: string | null,
): Promise<StoredSenderSession | null> {
  if (!supportsSenderResume()) return null;
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readonly");
  const completed = transactionComplete(transaction);
  const store = transaction.objectStore(SESSION_STORE);
  const record = preferredKey
    ? await requestResult<StoredSenderSession | undefined>(
        store.get(preferredKey),
      )
    : (
        await requestResult<IDBCursorWithValue | null>(
          store.index(UPDATED_AT_INDEX).openCursor(null, "prev"),
        )
      )?.value as StoredSenderSession | undefined;
  await completed;
  return record ?? null;
}

export async function deleteSenderSession(
  expected: Pick<StoredSenderSession, "key" | "version" | "revision">,
): Promise<boolean> {
  if (!supportsSenderResume()) return true;
  return enqueueMutation(async () => {
    const database = await openDatabase();
    const transaction = database.transaction(SESSION_STORE, "readwrite");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(SESSION_STORE);
    const current = await requestResult<StoredSenderSession | undefined>(
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
  if (!supportsSenderResume()) {
    return Promise.reject(
      new Error("This browser does not support durable sender resume."),
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
        request.error ?? new Error("Sender resume storage could not be opened."),
      );
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error("Sender resume storage is blocked by another tab."));
    };
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Sender resume storage request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Sender resume transaction failed."),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("Sender resume transaction aborted."),
      );
  });
}
