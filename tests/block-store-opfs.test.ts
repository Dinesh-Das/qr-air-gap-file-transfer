import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteAllBlockStores,
  openBlockStore,
  type BlockStore,
} from "../src/lib/block-store";
import type {
  BlockStoreWorkerRequest,
  BlockStoreWorkerResponse,
} from "../src/lib/block-store-worker-protocol";

const STORE_ROOT_DIRECTORY = "qr-air-gap-block-store-v1";
const JOURNAL_FILE_NAME = "receipt.journal";
const CHECKPOINT_ONE = "checkpoint-1.qbs";

describe.sequential("OPFS block-store lifecycle", () => {
  let environment: FakeOpfsEnvironment;

  beforeEach(() => {
    environment = new FakeOpfsEnvironment();
    environment.install();
  });

  afterEach(() => {
    environment.restore();
  });

  it("does not let a closed handle delete a same-ID store reopened elsewhere", async () => {
    const config = { storeId: "stale-close", totalBytes: 4, blockSize: 4 };
    const stale = await openOpfs(config);
    await stale.writeBlock(0, Uint8Array.of(1, 2, 3, 4));
    await stale.close();

    const current = await openOpfs(config);
    await expect(stale.delete()).rejects.toMatchObject({ code: "CLOSED" });
    await expect(stale.delete()).rejects.toMatchObject({ code: "CLOSED" });
    expect(await current.readBlock(0)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(environment.storeParent().removeCalls).toBe(0);
    await current.close();
  });

  it("does not let a worker-fatal handle delete a same-ID store reopened elsewhere", async () => {
    const config = { storeId: "stale-fatal", totalBytes: 4, blockSize: 4 };
    const stale = await openOpfs(config);
    await stale.writeBlock(0, Uint8Array.of(5, 6, 7, 8));
    environment.workers[0].crash("synthetic worker failure");
    await environment.locks.waitForIdle();

    const current = await openOpfs(config);
    await expect(stale.delete()).rejects.toMatchObject({ code: "CLOSED" });
    await expect(stale.delete()).rejects.toMatchObject({ code: "CLOSED" });
    expect(await current.readBlock(0)).toEqual(Uint8Array.of(5, 6, 7, 8));
    expect(environment.storeParent().removeCalls).toBe(0);
    await current.close();
  });

  it("retains its lifetime lock when removal fails so the same handle can retry", async () => {
    const config = { storeId: "retry-delete", totalBytes: 4, blockSize: 4 };
    const store = await openOpfs(config);
    await store.writeBlock(0, Uint8Array.of(9, 8, 7, 6));
    const parent = environment.storeParent();
    parent.failNextRemove = true;

    await expect(store.delete()).rejects.toThrow(/synthetic remove failure/);
    await expect(openOpfs(config)).rejects.toMatchObject({ code: "BUSY" });
    await expect(store.delete()).resolves.toBeUndefined();

    const empty = await openOpfs(config);
    expect(empty.progress()).toMatchObject({ receivedBlocks: 0, complete: false });
    await empty.close();
  });

  it("keeps global cleanup out while a store lease is live, then deletes after close", async () => {
    const config = { storeId: "global-cleanup", totalBytes: 4, blockSize: 4 };
    const store = await openOpfs(config);
    await store.writeBlock(0, Uint8Array.of(4, 3, 2, 1));

    await expect(deleteAllBlockStores()).rejects.toMatchObject({ code: "BUSY" });
    expect(await store.readBlock(0)).toEqual(Uint8Array.of(4, 3, 2, 1));
    await store.close();
    await expect(deleteAllBlockStores()).resolves.toBeUndefined();

    const empty = await openOpfs(config);
    expect(empty.progress()).toMatchObject({ receivedBlocks: 0, complete: false });
    await empty.close();
  });

  it(
    "makes checkpoint failure terminal without losing or growing the durable journal",
    async () => {
      const receivedBeforeFailure = 65_536;
      const config = {
        storeId: "terminal-compaction",
        totalBytes: receivedBeforeFailure + 1,
        blockSize: 1,
      };
      const store = await openOpfs(config);
      environment.storeDirectory().file(CHECKPOINT_ONE).failNextClose = true;

      async function* blocks() {
        for (let index = 0; index < receivedBeforeFailure; index += 1) {
          yield { index, bytes: Uint8Array.of(index & 0xff) };
        }
      }

      await expect(store.writeBlocks(blocks())).rejects.toMatchObject({
        code: "REOPEN_REQUIRED",
      });
      expect(store.progress()).toMatchObject({
        receivedBlocks: receivedBeforeFailure,
        receivedBytes: receivedBeforeFailure,
        complete: false,
      });
      const journalBytes = environment.storeDirectory().file(JOURNAL_FILE_NAME).size;
      expect(journalBytes).toBeGreaterThanOrEqual(256 * 1024);

      await expect(
        store.writeBlock(receivedBeforeFailure, Uint8Array.of(1)),
      ).rejects.toMatchObject({ code: "REOPEN_REQUIRED" });
      expect(environment.storeDirectory().file(JOURNAL_FILE_NAME).size).toBe(
        journalBytes,
      );
      await store.close();

      const resumed = await openOpfs(config);
      expect(resumed.progress()).toMatchObject({
        receivedBlocks: receivedBeforeFailure,
        receivedBytes: receivedBeforeFailure,
      });
      environment.storeDirectory().file(CHECKPOINT_ONE).failNextClose = true;
      await expect(
        resumed.writeBlock(receivedBeforeFailure, Uint8Array.of(1)),
      ).rejects.toMatchObject({ code: "REOPEN_REQUIRED" });
      expect(resumed.progress().receivedBlocks).toBe(receivedBeforeFailure);
      expect(environment.storeDirectory().file(JOURNAL_FILE_NAME).size).toBe(
        journalBytes,
      );
      await resumed.close();

      const recovered = await openOpfs(config);
      await recovered.writeBlock(receivedBeforeFailure, Uint8Array.of(1));
      expect(recovered.progress().complete).toBe(true);
      expect(environment.storeDirectory().file(JOURNAL_FILE_NAME).size).toBeLessThan(
        journalBytes,
      );
      await recovered.close();

      const complete = await openOpfs(config);
      expect(complete.progress().complete).toBe(true);
      await complete.close();
    },
    30_000,
  );
});

async function openOpfs(config: {
  storeId: string;
  totalBytes: number;
  blockSize: number;
}): Promise<BlockStore> {
  return openBlockStore(config, { backend: "opfs" });
}

class FakeOpfsEnvironment {
  readonly root = new FakeDirectoryHandle("root");
  readonly locks = new FakeLockManager();
  readonly workers: FakeWorker[] = [];
  private readonly navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  private readonly workerDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Worker",
  );

  install(): void {
    const workers = this.workers;
    class InstalledWorker extends FakeWorker {
      constructor() {
        super();
        workers.push(this);
      }
    }
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        storage: {
          getDirectory: async () => this.root,
          estimate: async () => ({ usage: 0, quota: Number.MAX_SAFE_INTEGER }),
          persist: async () => true,
          persisted: async () => true,
        },
        locks: this.locks,
      },
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: InstalledWorker,
    });
  }

  restore(): void {
    restoreProperty("navigator", this.navigatorDescriptor);
    restoreProperty("Worker", this.workerDescriptor);
  }

  storeParent(): FakeDirectoryHandle {
    return this.root.directory(STORE_ROOT_DIRECTORY);
  }

  storeDirectory(): FakeDirectoryHandle {
    const directories = this.storeParent().directories();
    if (directories.length !== 1) {
      throw new Error(`Expected one store directory, found ${directories.length}.`);
    }
    return directories[0];
  }
}

class FakeLockManager {
  private readonly active = new Map<
    string,
    { shared: number; exclusive: boolean }
  >();

  request<T>(
    name: string,
    options: { mode?: "shared" | "exclusive"; ifAvailable?: boolean },
    callback: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T> {
    const mode = options.mode ?? "exclusive";
    const state = this.active.get(name) ?? { shared: 0, exclusive: false };
    const available = mode === "shared"
      ? !state.exclusive
      : !state.exclusive && state.shared === 0;
    if (!available) return Promise.resolve(callback(null));

    if (mode === "shared") state.shared += 1;
    else state.exclusive = true;
    this.active.set(name, state);
    return Promise.resolve(
      callback({ name, mode } as Lock),
    ).finally(() => {
      const current = this.active.get(name);
      if (!current) return;
      if (mode === "shared") current.shared -= 1;
      else current.exclusive = false;
      if (current.shared === 0 && !current.exclusive) this.active.delete(name);
    });
  }

  async waitForIdle(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.active.size === 0) return;
      await Promise.resolve();
    }
    throw new Error("Fake Web Locks did not become idle.");
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory" as const;
  readonly entriesByName = new Map<string, FakeDirectoryHandle | FakeFileHandle>();
  removeCalls = 0;
  failNextRemove = false;

  constructor(readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FileSystemDirectoryHandle> {
    const existing = this.entriesByName.get(name);
    if (existing instanceof FakeDirectoryHandle) return existing as unknown as FileSystemDirectoryHandle;
    if (existing || !options.create) throw domError("NotFoundError");
    const created = new FakeDirectoryHandle(name);
    this.entriesByName.set(name, created);
    return created as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FileSystemFileHandle> {
    const existing = this.entriesByName.get(name);
    if (existing instanceof FakeFileHandle) return existing as unknown as FileSystemFileHandle;
    if (existing || !options.create) throw domError("NotFoundError");
    const created = new FakeFileHandle(name);
    this.entriesByName.set(name, created);
    return created as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string): Promise<void> {
    this.removeCalls += 1;
    if (this.failNextRemove) {
      this.failNextRemove = false;
      throw new Error("synthetic remove failure");
    }
    if (!this.entriesByName.delete(name)) throw domError("NotFoundError");
  }

  directory(name: string): FakeDirectoryHandle {
    const value = this.entriesByName.get(name);
    if (!(value instanceof FakeDirectoryHandle)) {
      throw new Error(`Missing fake directory ${name}.`);
    }
    return value;
  }

  directories(): FakeDirectoryHandle[] {
    return [...this.entriesByName.values()].filter(
      (value): value is FakeDirectoryHandle => value instanceof FakeDirectoryHandle,
    );
  }

  file(name: string): FakeFileHandle {
    const value = this.entriesByName.get(name);
    if (!(value instanceof FakeFileHandle)) {
      throw new Error(`Missing fake file ${name}.`);
    }
    return value;
  }
}

class FakeFileHandle {
  readonly kind = "file" as const;
  private storage = new Uint8Array();
  size = 0;
  failNextClose = false;

  constructor(readonly name: string) {}

  async getFile(): Promise<File> {
    const bytes = this.bytes();
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return new File([buffer], this.name);
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    let staged = new Uint8Array();
    return {
      write: async (value: unknown) => {
        if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
          throw new Error("The fake writable only accepts buffer data.");
        }
        const bytes = value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        staged = Uint8Array.from(bytes);
      },
      close: async () => {
        if (this.failNextClose) {
          this.failNextClose = false;
          throw new Error("synthetic checkpoint replacement failure");
        }
        this.replace(staged);
      },
      abort: async () => undefined,
    } as unknown as FileSystemWritableFileStream;
  }

  bytes(): Uint8Array {
    return this.storage.slice(0, this.size);
  }

  writeAt(offset: number, bytes: Uint8Array): void {
    const required = offset + bytes.byteLength;
    this.ensureCapacity(required);
    this.storage.set(bytes, offset);
    this.size = Math.max(this.size, required);
  }

  replace(bytes: Uint8Array): void {
    this.storage = Uint8Array.from(bytes);
    this.size = bytes.byteLength;
  }

  truncate(size: number): void {
    this.ensureCapacity(size);
    if (size > this.size) this.storage.fill(0, this.size, size);
    this.size = size;
  }

  read(offset: number, length: number): Uint8Array {
    return this.storage.slice(offset, Math.min(this.size, offset + length));
  }

  private ensureCapacity(required: number): void {
    if (required <= this.storage.byteLength) return;
    let capacity = Math.max(1, this.storage.byteLength);
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.storage.subarray(0, this.size));
    this.storage = grown;
  }
}

class FakeWorker {
  onmessage: ((event: MessageEvent<BlockStoreWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private tail = Promise.resolve();
  private terminated = false;
  private data?: FakeFileHandle;
  private journal?: FakeFileHandle;

  postMessage(request: BlockStoreWorkerRequest): void {
    if (this.terminated) throw new Error("The fake worker is terminated.");
    this.tail = this.tail.then(async () => {
      try {
        this.respond(await this.dispatch(request));
      } catch (caught) {
        this.respond({
          id: request.id,
          ok: false,
          error: {
            name: caught instanceof Error ? caught.name : "Error",
            message: caught instanceof Error ? caught.message : String(caught),
          },
        });
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  crash(message: string): void {
    this.terminated = true;
    this.onerror?.({
      message,
      preventDefault() {},
    } as ErrorEvent);
  }

  private async dispatch(
    request: BlockStoreWorkerRequest,
  ): Promise<BlockStoreWorkerResponse> {
    switch (request.type) {
      case "open": {
        const directory = request.directory as unknown as FakeDirectoryHandle;
        this.data = await directory.getFileHandle(
          "payload.bin",
          { create: true },
        ) as unknown as FakeFileHandle;
        this.journal = await directory.getFileHandle(
          JOURNAL_FILE_NAME,
          { create: true },
        ) as unknown as FakeFileHandle;
        if (this.journal.size < request.journalBytes) {
          throw new Error("journal shorter than validated prefix");
        }
        this.journal.truncate(request.journalBytes);
        return {
          id: request.id,
          ok: true,
          type: "ready",
          dataSize: this.data.size,
          journalSize: this.journal.size,
        };
      }
      case "write-payload":
        this.requireData().writeAt(request.offset, new Uint8Array(request.bytes));
        return done(request.id);
      case "flush-payload":
        return done(request.id);
      case "append-journal": {
        const journal = this.requireJournal();
        if (journal.size !== request.offset) throw new Error("journal offset changed");
        journal.writeAt(request.offset, new Uint8Array(request.bytes));
        journal.truncate(request.offset + request.bytes.byteLength);
        return done(request.id);
      }
      case "truncate-journal":
        this.requireJournal().truncate(request.size);
        return done(request.id);
      case "read-payload": {
        const bytes = this.requireData().read(request.offset, request.length);
        if (bytes.byteLength !== request.length) throw new Error("short payload read");
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return { id: request.id, ok: true, type: "read", bytes: buffer };
      }
      case "close":
        return done(request.id);
    }
  }

  private respond(response: BlockStoreWorkerResponse): void {
    if (!this.terminated) this.onmessage?.({ data: response } as MessageEvent<BlockStoreWorkerResponse>);
  }

  private requireData(): FakeFileHandle {
    if (!this.data) throw new Error("payload is not open");
    return this.data;
  }

  private requireJournal(): FakeFileHandle {
    if (!this.journal) throw new Error("journal is not open");
    return this.journal;
  }
}

function done(id: number): BlockStoreWorkerResponse {
  return { id, ok: true, type: "done" };
}

function domError(name: string): DOMException {
  return new DOMException(name, name);
}

function restoreProperty(
  name: "navigator" | "Worker",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
