import { collectLargeDirectory, prepareLargeSource, type PreparedLargeSource, type LargeTransferProgress } from "./large-transfer";
import { createOfflineTransferManifest, decodeOfflineControl, type OfflineTransferManifest } from "./webrtc-protocol";
import { collectSelectedFiles, selectedFileHandles, collectSelectedItems, selectedItemHandles, type SelectedHandle } from "./selected-files";

const DATABASE = "airgap-webrtc-sender";
const STORE = "sources";
const MAX_RECORDS = 16;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export class SourceChangedError extends Error {
  constructor() {
    super("The saved source changed. Select it as a new transfer; the old transfer was not resumed.");
    this.name = "SourceChangedError";
  }
}

export interface SavedWebRtcSource {
  key: string;
  version: 1;
  updatedAt: number;
  handle?: FileSystemDirectoryHandle;
  fileHandles?: FileSystemFileHandle[];
  itemHandles?: SelectedHandle[];
  manifest: OfflineTransferManifest;
}

export function createSavedWebRtcSource(source: PreparedLargeSource, manifest: OfflineTransferManifest): SavedWebRtcSource {
  const fileHandles = selectedFileHandles(source.rootHandle);
  const itemHandles = selectedItemHandles(source.rootHandle);
  return { key: crypto.randomUUID(), version: 1, updatedAt: Date.now(),
    ...(itemHandles ? { itemHandles } : fileHandles ? { fileHandles } : { handle: source.rootHandle }), manifest: { ...manifest } };
}

/** Handles and identities only; never persist source bytes or peer authorization. */
export async function saveWebRtcSource(record: SavedWebRtcSource): Promise<void> {
  const database = await open();
  try {
    const transaction = database.transaction(STORE, "readwrite");
    const completed = complete(transaction);
    const store = transaction.objectStore(STORE);
    const records = await result<SavedWebRtcSource[]>(store.getAll());
    let retained = 0;
    for (const previous of records) {
      if (Date.now() - previous.updatedAt >= MAX_AGE) store.delete(previous.key);
      else retained += 1;
    }
    if (retained >= MAX_RECORDS && !records.some((previous) => previous.key === record.key)) {
      transaction.abort();
      await completed.catch(() => undefined);
      throw new Error("Saved sender sources are full. Discard an older saved source first.");
    }
    store.add(record);
    await completed;
  } finally { database.close(); }
}

export async function loadWebRtcSource(): Promise<SavedWebRtcSource | null> {
  const database = await open();
  try {
    const transaction = database.transaction(STORE, "readonly");
    const completed = complete(transaction);
    const records = await result<SavedWebRtcSource[]>(transaction.objectStore(STORE).getAll());
    await completed;
    return records.filter((record) => {
      try {
        if (!record || record.version !== 1 || typeof record.key !== "string" || !validHandles(record)
          || !Number.isFinite(record.updatedAt) || record.updatedAt > Date.now()
          || Date.now() - record.updatedAt >= MAX_AGE) return false;
        decodeOfflineControl(JSON.stringify({ type: "manifest", manifest: record.manifest }));
        return true;
      } catch { return false; }
    })
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  } finally { database.close(); }
}

export async function deleteWebRtcSource(key: string): Promise<void> {
  const database = await open();
  try {
    const transaction = database.transaction(STORE, "readwrite");
    const completed = complete(transaction);
    transaction.objectStore(STORE).delete(key);
    await completed;
  } finally { database.close(); }
}

/** Must be called from a user action: restored handles can need permission. */
export async function restoreWebRtcSource(record: SavedWebRtcSource, onProgress?: (progress: LargeTransferProgress) => void, signal?: AbortSignal, beforeRead?: () => Promise<void>) {
  if (record.version !== 1 || !validHandles(record)) throw new Error("Invalid saved sender source.");
  decodeOfflineControl(JSON.stringify({ type: "manifest", manifest: record.manifest }));
  signal?.throwIfAborted();
  for (const handle of record.itemHandles ?? record.fileHandles ?? [record.handle!]) {
    signal?.throwIfAborted();
    if ((await handle.queryPermission?.({ mode: "read" }) ?? "granted") !== "granted"
      && await handle.requestPermission?.({ mode: "read" }) !== "granted") {
      throw new DOMException("Allow read access to the saved source to resume.", "NotAllowedError");
    }
  }
  // Request permission while the user action is fresh. A connection preflight
  // may then wait, but must finish before enumeration or source-byte reads.
  await beforeRead?.();
  signal?.throwIfAborted();
  const selection = record.itemHandles ? await collectSelectedItems(record.itemHandles, onProgress, signal) : record.fileHandles
    ? await collectSelectedFiles(record.fileHandles, onProgress, signal)
    : await collectLargeDirectory(record.handle!, onProgress, signal);
  const source = await prepareLargeSource(selection, onProgress, signal);
  const manifest = await createOfflineTransferManifest(source);
  signal?.throwIfAborted();
  if (manifest.manifestId !== record.manifest.manifestId || manifest.transferId !== record.manifest.transferId
    || manifest.streamSha256 !== record.manifest.streamSha256 || manifest.totalBytes !== record.manifest.totalBytes
    || manifest.rootName !== record.manifest.rootName || manifest.blockSize !== record.manifest.blockSize) {
    throw new SourceChangedError();
  }
  return { selection, source, manifest };
}

function validHandles(record: SavedWebRtcSource): boolean {
  if ([record.handle, record.fileHandles, record.itemHandles].filter((value) => value !== undefined).length !== 1) return false;
  if (record.handle) return record.handle.kind === "directory";
  const handles = record.fileHandles ?? record.itemHandles;
  return Array.isArray(handles) && handles.length > 0 && handles.length <= 100_000
    && handles.every((handle) => handle?.kind === "file" || record.itemHandles !== undefined && handle?.kind === "directory");
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function complete(transaction: IDBTransaction): Promise<void> {
  const promise = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Sender checkpoint was not committed."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Sender checkpoint transaction failed."));
  });
  // A request can reject before its transaction does. Its caller may exit before
  // awaiting completion, so observe the rejection immediately while preserving
  // it for callers that do await the original promise.
  void promise.catch(() => undefined);
  return promise;
}
