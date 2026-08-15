import { sha256 } from "@noble/hashes/sha2.js";
import {
  BlockStoreError,
  openBlockStore,
  type BlockStorageEstimate,
  type BlockStore,
  type BlockStoreProgress,
  type MemoryBlockStoreRepository,
} from "./block-store";
import {
  Qrf3FrameType,
  Qrf3TransferPurpose,
  parseQrf3EncodedFrame,
  validateQrf3DataFrame,
  type Qrf3Manifest,
} from "./stream-protocol";
import type { RandomAccessReader } from "./large-transfer";
import {
  assertCanonicalQrf3ConnectionTestManifest,
} from "./large-connection";

export interface LargeReceiverStatus {
  state: "awaiting-manifest" | "receiving" | "complete";
  manifest?: Qrf3Manifest;
  manifestId?: Uint8Array;
  progress?: BlockStoreProgress;
  duplicate?: boolean;
}

export interface LargeReceiverOptions {
  expectedPurpose?: Qrf3TransferPurpose;
  expectedConnectionId?: Uint8Array;
  expectedTransferId?: Uint8Array;
  expectedManifestId?: Uint8Array;
  checkQuota?: boolean;
  requestPersistence?: boolean;
  backend?: "auto" | "opfs" | "memory";
  /** Shared only by deterministic memory-backend tests and explicit callers. */
  memoryRepository?: MemoryBlockStoreRepository;
}

export class LargeReceiverPoisonCleanupError extends Error {
  readonly name = "LargeReceiverPoisonCleanupError";

  constructor(public readonly cleanupCause: unknown) {
    super("The completed QRF3 stream failed its SHA-256 check, and its poisoned store could not be deleted.");
  }
}

export function isLargeReceiverTerminalStorageError(
  error: unknown,
): error is BlockStoreError {
  return error instanceof BlockStoreError && error.code === "REOPEN_REQUIRED";
}

/**
 * Stateful QRF3 receiver. It parses one QR at a time, then writes integrity-checked
 * payload bytes straight to disk. No data-frame strings or payload arrays are
 * retained after accept() resolves.
 */
export class LargeQrf3Receiver {
  private readonly options: LargeReceiverOptions;
  private manifest?: Qrf3Manifest;
  private manifestId?: Uint8Array;
  private store?: BlockStore;
  private openingStore?: Promise<BlockStore>;
  private writeTail: Promise<void> = Promise.resolve();
  private verification?: Promise<RandomAccessReader>;
  private closing?: Promise<void>;
  private closed = false;

  constructor(options: LargeReceiverOptions = {}) {
    this.options = {
      ...options,
      expectedConnectionId: options.expectedConnectionId?.slice(),
      expectedTransferId: options.expectedTransferId?.slice(),
      expectedManifestId: options.expectedManifestId?.slice(),
    };
  }

  async accept(encoded: string): Promise<LargeReceiverStatus> {
    this.assertOpen();
    const frame = await parseQrf3EncodedFrame(encoded);
    this.assertOpen();
    if (frame.type === Qrf3FrameType.Manifest) {
      if (!frame.manifest) throw new Error("QRF3 manifest frame was not parsed.");
      this.acceptManifest(frame.manifest, frame.manifestId);
      await this.ensureStore();
      this.assertOpen();
      return this.status();
    }
    if (!this.manifest || !this.manifestId) {
      return { state: "awaiting-manifest" };
    }
    const blockIndex = validateQrf3DataFrame(
      frame,
      this.manifest,
      this.manifestId,
    );
    const store = await this.ensureStore();
    this.assertOpen();
    let result: Awaited<ReturnType<BlockStore["writeBlock"]>> | undefined;
    const run = this.writeTail.then(async () => {
      result = await store.writeBlock(blockIndex, frame.payload);
    });
    this.writeTail = run.then(() => undefined, () => undefined);
    await run;
    const progress = result!.progress;
    return {
      ...this.status(progress),
      duplicate: result!.duplicateBlocks > 0,
    };
  }

  status(progress = this.store?.progress()): LargeReceiverStatus {
    if (!this.manifest || !this.manifestId) {
      return { state: "awaiting-manifest" };
    }
    const complete = progress?.complete === true;
    return {
      state: complete ? "complete" : "receiving",
      manifest: cloneManifest(this.manifest),
      manifestId: this.manifestId.slice(),
      progress,
    };
  }

  verifyComplete(signal?: AbortSignal): Promise<RandomAccessReader> {
    this.assertOpen();
    if (!this.verification) {
      const verification = this.verifyCompleteOnce(signal);
      this.verification = verification.catch((error) => {
        // Incomplete/cancelled verification can be retried after more blocks
        // arrive. An integrity failure deletes the store and closes this
        // receiver, so its rejected single-flight result remains final.
        if (!this.closed) this.verification = undefined;
        throw error;
      });
    }
    return this.verification;
  }

  private async verifyCompleteOnce(signal?: AbortSignal): Promise<RandomAccessReader> {
    throwIfAborted(signal);
    const store = await this.ensureStore();
    this.assertOpen();
    await this.writeTail;
    this.assertOpen();
    const progress = store.progress();
    if (!progress.complete || !this.manifest) {
      throw new Error(
        `The QRF3 transfer is incomplete (${progress.receivedBlocks}/${progress.totalBlocks} blocks).`,
      );
    }
    const hasher = sha256.create();
    const stream = await store.createReadStream();
    const reader = stream.getReader();
    try {
      while (true) {
        throwIfAborted(signal);
        const { value, done } = await reader.read();
        if (done) break;
        hasher.update(value);
      }
    } finally {
      if (signal?.aborted) await reader.cancel(signal.reason).catch(() => undefined);
      reader.releaseLock();
    }
    if (!bytesEqual(hasher.digest(), this.manifest.archiveSha256)) {
      // Per-frame commitments reject optical corruption, but the final stream
      // hash is the authority for a malicious/self-consistent frame. Keeping
      // its receipt bit would make the correct block a permanent duplicate.
      // Remove the poisoned store so a fresh receiver can reacquire it.
      this.closed = true;
      try {
        await store.delete();
      } catch (error) {
        throw new LargeReceiverPoisonCleanupError(error);
      }
      throw new Error("The completed QRF3 stream failed its SHA-256 check.");
    }
    return {
      size: BigInt(this.manifest.transferLength),
      read: (offset, length) => store.readRange(safeNumber(offset), length),
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.closing = (async () => {
      await this.writeTail;
      const store = this.store ?? (this.openingStore ? await this.openingStore : undefined);
      await store?.close();
    })();
    return this.closing;
  }

  async delete(): Promise<void> {
    if (this.closed && !this.store && !this.openingStore) return;
    this.closed = true;
    await this.writeTail;
    const store = this.store ?? (this.manifest ? await this.ensureStore() : undefined);
    await store?.delete();
  }

  private acceptManifest(manifest: Qrf3Manifest, manifestId: Uint8Array): void {
    this.assertExpected(manifest, manifestId);
    if (this.manifest && this.manifestId) {
      if (
        !bytesEqual(this.manifestId, manifestId) ||
        !bytesEqual(this.manifest.transferId, manifest.transferId)
      ) {
        throw new Error("A different QRF3 manifest was shown during this transfer.");
      }
      return;
    }
    this.manifest = cloneManifest(manifest);
    this.manifestId = manifestId.slice();
  }

  private assertExpected(manifest: Qrf3Manifest, manifestId: Uint8Array): void {
    if (manifest.purpose === Qrf3TransferPurpose.ConnectionTest) {
      assertCanonicalQrf3ConnectionTestManifest(manifest);
    }
    if (
      this.options.expectedPurpose !== undefined &&
      manifest.purpose !== this.options.expectedPurpose
    ) {
      throw new Error("The QRF3 stream has the wrong transfer purpose.");
    }
    for (const [expected, actual, field] of [
      [this.options.expectedConnectionId, manifest.connectionId, "connection ID"],
      [this.options.expectedTransferId, manifest.transferId, "transfer ID"],
      [this.options.expectedManifestId, manifestId, "manifest identity"],
    ] as const) {
      if (expected && !bytesEqual(expected, actual)) {
        throw new Error(`The QRF3 ${field} does not match the verified connection.`);
      }
    }
  }

  private ensureStore(): Promise<BlockStore> {
    if (!this.manifest || !this.manifestId) {
      return Promise.reject(new Error("A QRF3 manifest is required first."));
    }
    return (this.openingStore ??= openBlockStore(
      {
        storeId: storeId(this.manifest, this.manifestId),
        totalBytes: this.manifest.transferLength,
        blockSize: this.manifest.blockSize,
      },
      {
        backend: this.options.backend,
        memoryRepository: this.options.memoryRepository,
        checkQuota: this.options.checkQuota ?? true,
        requestPersistence: this.options.requestPersistence ?? true,
      },
    ).then((store) => {
      this.store = store;
      return store;
    }).catch((error) => {
      this.openingStore = undefined;
      throw error;
    }));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The QRF3 receiver is closed.");
  }
}

export type { BlockStorageEstimate };

function storeId(manifest: Qrf3Manifest, manifestId: Uint8Array): string {
  return [
    "qrf3",
    bytesToHex(manifest.connectionId),
    bytesToHex(manifest.transferId),
    bytesToHex(manifestId),
  ].join(":");
}

function safeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The requested offset exceeds the browser integer range.");
  }
  return Number(value);
}

function cloneManifest(manifest: Qrf3Manifest): Qrf3Manifest {
  return {
    ...manifest,
    transferId: manifest.transferId.slice(),
    archiveSha256: manifest.archiveSha256.slice(),
    connectionId: manifest.connectionId.slice(),
  };
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was cancelled.", "AbortError");
  }
}
