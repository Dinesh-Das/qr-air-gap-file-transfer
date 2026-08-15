/// <reference lib="webworker" />

import type {
  BlockStoreWorkerRequest,
  BlockStoreWorkerResponse,
} from "./block-store-worker-protocol";

const DATA_FILE_NAME = "payload.bin";
const JOURNAL_FILE_NAME = "receipt.journal";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let dataAccess: FileSystemSyncAccessHandle | undefined;
let journalAccess: FileSystemSyncAccessHandle | undefined;
let operationTail = Promise.resolve();
let failed = false;

workerScope.onmessage = (event: MessageEvent<BlockStoreWorkerRequest>) => {
  const request = event.data;
  operationTail = operationTail.then(async () => {
    if (failed && request.type !== "close") {
      respondError(request.id, new Error("The OPFS worker session is unavailable."));
      return;
    }
    try {
      await dispatch(request);
    } catch (error) {
      if (request.type !== "open" && request.type !== "close") failed = true;
      respondError(request.id, error);
    }
  });
};

async function dispatch(request: BlockStoreWorkerRequest): Promise<void> {
  switch (request.type) {
    case "open": {
      if (dataAccess || journalAccess) throw new Error("The OPFS worker is already open.");
      try {
        const dataFile = await request.directory.getFileHandle(DATA_FILE_NAME, { create: true });
        const journalFile = await request.directory.getFileHandle(JOURNAL_FILE_NAME, { create: true });
        dataAccess = await dataFile.createSyncAccessHandle();
        journalAccess = await journalFile.createSyncAccessHandle();
        if (journalAccess.getSize() < request.journalBytes) {
          throw new Error("The OPFS journal is shorter than its validated prefix.");
        }
        if (journalAccess.getSize() !== request.journalBytes) {
          journalAccess.truncate(request.journalBytes);
          journalAccess.flush();
        }
        respond({
          id: request.id,
          ok: true,
          type: "ready",
          dataSize: dataAccess.getSize(),
          journalSize: journalAccess.getSize(),
        });
      } catch (error) {
        closeHandles();
        throw error;
      }
      return;
    }
    case "write-payload": {
      writeAll(requireData(), new Uint8Array(request.bytes), request.offset);
      respondDone(request.id);
      return;
    }
    case "flush-payload": {
      requireData().flush();
      respondDone(request.id);
      return;
    }
    case "append-journal": {
      const journal = requireJournal();
      if (journal.getSize() !== request.offset) {
        throw new Error("The OPFS journal position changed unexpectedly.");
      }
      const bytes = new Uint8Array(request.bytes);
      writeAll(journal, bytes, request.offset);
      journal.truncate(request.offset + bytes.byteLength);
      journal.flush();
      respondDone(request.id);
      return;
    }
    case "truncate-journal": {
      const journal = requireJournal();
      journal.truncate(request.size);
      journal.flush();
      respondDone(request.id);
      return;
    }
    case "read-payload": {
      const output = new Uint8Array(request.length);
      const read = requireData().read(output, { at: request.offset });
      if (read !== request.length) {
        throw new Error(`The OPFS payload returned ${read} bytes; expected ${request.length}.`);
      }
      respond(
        { id: request.id, ok: true, type: "read", bytes: output.buffer },
        [output.buffer],
      );
      return;
    }
    case "close": {
      closeHandles();
      respondDone(request.id);
      workerScope.close();
      return;
    }
  }
}

function writeAll(
  access: FileSystemSyncAccessHandle,
  bytes: Uint8Array,
  offset: number,
): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = access.write(bytes.subarray(written), { at: offset + written });
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("The OPFS synchronous write made no forward progress.");
    }
    written += count;
  }
}

function requireData(): FileSystemSyncAccessHandle {
  if (!dataAccess) throw new Error("The OPFS payload is not open.");
  return dataAccess;
}

function requireJournal(): FileSystemSyncAccessHandle {
  if (!journalAccess) throw new Error("The OPFS journal is not open.");
  return journalAccess;
}

function closeHandles(): void {
  try {
    journalAccess?.close();
  } finally {
    journalAccess = undefined;
    dataAccess?.close();
    dataAccess = undefined;
  }
}

function respond(
  response: BlockStoreWorkerResponse,
  transfer: Transferable[] = [],
): void {
  workerScope.postMessage(response, transfer);
}

function respondDone(id: number): void {
  respond({ id, ok: true, type: "done" });
}

function respondError(id: number, error: unknown): void {
  const normalized = normalizeError(error);
  respond({ id, ok: false, error: normalized });
}

function normalizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error || error instanceof DOMException) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}
