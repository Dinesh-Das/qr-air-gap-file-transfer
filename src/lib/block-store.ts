/**
 * Random-access, resumable storage for transfers that are too large to retain
 * in JavaScript memory. Browser stores use the Origin Private File System
 * (OPFS); the memory repository exists for Node tests and small fixtures.
 *
 * Data is committed before its receipt journal entry. A crash can therefore
 * cause an unrecorded block to be sent again, but can never mark unwritten data
 * as received. The journal is periodically folded into one of two checksummed
 * bitset snapshots, leaving the other snapshot as a recovery point.
 */

import type {
  BlockStoreWorkerRequest,
  BlockStoreWorkerResponse,
} from "./block-store-worker-protocol";

const SCHEMA_VERSION = 1 as const;
const STORE_ROOT_DIRECTORY = "qr-air-gap-block-store-v1";
const DATA_FILE_NAME = "payload.bin";
const JOURNAL_FILE_NAME = "receipt.journal";
const CHECKPOINT_FILE_NAMES = ["checkpoint-0.qbs", "checkpoint-1.qbs"] as const;
const CHECKPOINT_MAGIC = Uint8Array.of(0x51, 0x42, 0x53, 0x31); // QBS1
const JOURNAL_MAGIC = Uint8Array.of(0x51, 0x42, 0x4a, 0x31); // QBJ1
const CHECKPOINT_FIXED_BYTES = 60;
const JOURNAL_FIXED_BYTES = 20;
const CHECKSUM_BYTES = 4;
const DEFAULT_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_READ_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_BLOCK_BYTES = 64 * 1024 * 1024;
const MAX_BLOCKS_PER_COMMIT = 4096;
// This bounds the in-memory receipt bitset to about 31 MiB while still
// supporting roughly 167 GiB at the protocol's current 700-byte QR payload.
export const MAX_BLOCK_STORE_BLOCKS = 256_000_000;
const MAX_STORE_ID_BYTES = 4096;
const MIN_JOURNAL_COMPACTION_BYTES = 256 * 1024;
const MAX_JOURNAL_RECORD_BYTES =
  JOURNAL_FIXED_BYTES + MAX_BLOCKS_PER_COMMIT * Uint32Array.BYTES_PER_ELEMENT + CHECKSUM_BYTES;
const STORE_ROOT_LOCK = "airgap-qr-block-store-root-v1";
const STORE_LOCK_PREFIX = "airgap-qr-block-store-v1:";

export type BlockStoreBackend = "opfs" | "memory";

export interface BlockStoreConfig {
  /** Stable transfer identity. It is hashed before being used as a directory name. */
  storeId: string;
  /** Exact final byte length of the reconstructed archive. */
  totalBytes: number;
  /** Payload bytes in every block except, possibly, the last block. */
  blockSize: number;
}

export interface BlockWrite {
  index: number;
  bytes: Uint8Array;
}

export interface BlockStoreCheckpoint {
  schemaVersion: typeof SCHEMA_VERSION;
  storeId: string;
  totalBytes: number;
  blockSize: number;
  totalBlocks: number;
  receivedBlocks: number;
  receivedBytes: number;
  complete: boolean;
  generation: number;
  updatedAt: number;
  /** Defensive copy; bit N records receipt of block N. */
  receivedBlockBits: Uint8Array;
}

/** Scalar receipt state suitable for per-frame UI updates. */
export interface BlockStoreProgress {
  schemaVersion: typeof SCHEMA_VERSION;
  storeId: string;
  totalBytes: number;
  blockSize: number;
  totalBlocks: number;
  receivedBlocks: number;
  receivedBytes: number;
  complete: boolean;
  generation: number;
  updatedAt: number;
}

export interface BlockWriteResult {
  writtenBlocks: number;
  duplicateBlocks: number;
  /** Does not copy the receipt bitset and is intended for frequent updates. */
  progress: BlockStoreProgress;
  /** @deprecated Prefer progress for per-block updates and checkpoint() for an explicit snapshot. */
  checkpoint: BlockStoreCheckpoint;
}

export interface BlockReadStreamOptions {
  /** Upper bound for each chunk allocated by the reader. Defaults to 1 MiB. */
  chunkBytes?: number;
}

export interface BlockStorageEstimate {
  storageApiSupported: boolean;
  opfsSupported: boolean;
  usage?: number;
  quota?: number;
  available?: number;
  requiredBytes: number;
  hasEnoughSpace?: boolean;
  persisted?: boolean;
}

export interface OpenBlockStoreOptions {
  /** Auto uses OPFS in browsers and memory only when navigator is absent (Node). */
  backend?: "auto" | BlockStoreBackend;
  /** Shared repository for deterministic reopen/resume tests. */
  memoryRepository?: MemoryBlockStoreRepository;
  /** Ask the browser to make origin storage eviction-resistant. */
  requestPersistence?: boolean;
  /** Reject a new OPFS store when the browser reports insufficient quota. */
  checkQuota?: boolean;
}

export interface BlockStore {
  readonly backend: BlockStoreBackend;
  readonly config: Readonly<BlockStoreConfig>;
  readonly totalBlocks: number;

  progress(): BlockStoreProgress;
  checkpoint(): BlockStoreCheckpoint;
  hasBlock(index: number): boolean;
  writeBlock(index: number, bytes: Uint8Array): Promise<BlockWriteResult>;
  /**
   * Writes in bounded sub-batches. If iteration fails, earlier sub-batches can
   * remain committed and are accurately reflected by checkpoint().
   */
  writeBlocks(
    blocks: Iterable<BlockWrite> | AsyncIterable<BlockWrite>,
  ): Promise<BlockWriteResult>;
  readBlock(index: number): Promise<Uint8Array>;
  /**
   * Reads at most 16 MiB without requiring unrelated blocks. Every block that
   * overlaps the requested range must already be present.
   */
  readRange(offset: number, length: number): Promise<Uint8Array>;
  /** Requires every block and never allocates the complete archive. */
  createReadStream(
    options?: BlockReadStreamOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  /** Flushes queued work. Every successful write is already durable. */
  close(): Promise<void>;
  /** Permanently removes this live store. A handle cannot delete after close. */
  delete(): Promise<void>;
}

interface StoreState {
  config: Readonly<BlockStoreConfig>;
  totalBlocks: number;
  receivedBlocks: number;
  receivedBytes: number;
  bits: Uint8Array;
  generation: number;
  updatedAt: number;
}

interface BatchWriter {
  write(index: number, bytes: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

interface MemoryRecord {
  state: StoreState;
  blocks: Map<number, Uint8Array>;
  operationQueue: OperationQueue;
  deleted: boolean;
}

interface OperationQueue {
  tail: Promise<void>;
}

export class BlockStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_BLOCK"
      | "MISSING_BLOCK"
      | "INCOMPLETE"
      | "UNSUPPORTED"
      | "QUOTA_EXCEEDED"
      | "CORRUPT_STORE"
      | "BUSY"
      | "CLOSED"
      | "REOPEN_REQUIRED",
  ) {
    super(message);
    this.name = "BlockStoreError";
  }
}

/** The receipt is durable, but this open session must not perform more I/O. */
class DurableCommitTerminalError extends BlockStoreError {
  constructor(error: unknown) {
    super(
      `The latest blocks are durable, but receipt compaction failed; close and reopen this store before continuing. (${toError(error).message})`,
      "REOPEN_REQUIRED",
    );
    this.name = "DurableCommitTerminalError";
  }
}

/** A persistent-in-process backend used by Node tests and explicit callers. */
export class MemoryBlockStoreRepository {
  private readonly records = new Map<string, MemoryRecord>();

  async open(config: BlockStoreConfig): Promise<BlockStore> {
    const normalized = normalizeConfig(config);
    const existing = this.records.get(normalized.storeId);
    if (existing) {
      assertMatchingConfig(existing.state.config, normalized);
      return new MemoryBlockStore(this, existing);
    }

    const record: MemoryRecord = {
      state: createInitialState(normalized),
      blocks: new Map(),
      operationQueue: { tail: Promise.resolve() },
      deleted: false,
    };
    this.records.set(normalized.storeId, record);
    return new MemoryBlockStore(this, record);
  }

  remove(storeId: string, expected: MemoryRecord): void {
    if (this.records.get(storeId) === expected) this.records.delete(storeId);
  }
}

const defaultMemoryRepository = new MemoryBlockStoreRepository();

export function supportsDurableBlockStore(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof navigator.locks?.request === "function" &&
    typeof Worker !== "undefined"
  );
}

/** Backward-compatible name for the complete durable-backend capability gate. */
export function supportsOpfsBlockStore(): boolean {
  return supportsDurableBlockStore();
}

/** Includes payload bytes and peak metadata space during checkpoint replacement. */
export function requiredBlockStorageBytes(config: BlockStoreConfig): number {
  const normalized = normalizeConfig(config);
  return normalized.totalBytes + peakBlockStoreMetadataBytes(normalized);
}

/**
 * Additional quota needed to finish an existing store. Existing received
 * payload and metadata are already included in StorageManager.estimate().usage.
 */
export function requiredAdditionalBlockStorageBytes(
  config: BlockStoreConfig,
  receivedBytes = 0,
  currentMetadataBytes = 0,
): number {
  const normalized = normalizeConfig(config);
  assertSafeNonNegativeInteger(receivedBytes, "receivedBytes");
  assertSafeNonNegativeInteger(currentMetadataBytes, "currentMetadataBytes");
  if (receivedBytes > normalized.totalBytes) {
    throw new BlockStoreError("receivedBytes exceeds the store size.", "INVALID_CONFIG");
  }
  return (
    normalized.totalBytes - receivedBytes +
    Math.max(0, peakBlockStoreMetadataBytes(normalized) - currentMetadataBytes)
  );
}

function peakBlockStoreMetadataBytes(config: Readonly<BlockStoreConfig>): number {
  const receiptBytes = Math.ceil(blockCount(config) / 8);
  const storeIdBytes = new TextEncoder().encode(config.storeId).byteLength;
  const checkpointBytes =
    CHECKPOINT_FIXED_BYTES + storeIdBytes + receiptBytes + CHECKSUM_BYTES;
  const journalPeakBytes =
    Math.max(MIN_JOURNAL_COMPACTION_BYTES, receiptBytes * 2) +
    MAX_JOURNAL_RECORD_BYTES;

  // Both checkpoint slots remain live while a third temporary file is written.
  return checkpointBytes * 3 + journalPeakBytes;
}

export async function estimateBlockStorage(
  requiredBytes = 0,
): Promise<BlockStorageEstimate> {
  assertSafeNonNegativeInteger(requiredBytes, "requiredBytes");
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage || typeof storage.estimate !== "function") {
    return {
      storageApiSupported: false,
      opfsSupported: false,
      requiredBytes,
    };
  }

  const estimate = await storage.estimate();
  const usage = finiteNonNegative(estimate.usage);
  const quota = finiteNonNegative(estimate.quota);
  const available = usage === undefined || quota === undefined
    ? undefined
    : Math.max(0, quota - usage);
  let persisted: boolean | undefined;
  try {
    persisted = typeof storage.persisted === "function"
      ? await storage.persisted()
      : undefined;
  } catch {
    // Quota information remains useful if the persistence query is blocked.
  }

  return {
    storageApiSupported: true,
    opfsSupported: supportsOpfsBlockStore(),
    usage,
    quota,
    available,
    requiredBytes,
    hasEnoughSpace: available === undefined ? undefined : available >= requiredBytes,
    persisted,
  };
}

export async function requestPersistentBlockStorage(): Promise<boolean> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage || typeof storage.persist !== "function") return false;
  try {
    return await storage.persist();
  } catch {
    // Persistence is an eviction-resistance hint, not a prerequisite for OPFS.
    return false;
  }
}

export async function openBlockStore(
  config: BlockStoreConfig,
  options: OpenBlockStoreOptions = {},
): Promise<BlockStore> {
  const normalized = normalizeConfig(config);
  const backend = options.backend ?? "auto";
  if (backend === "memory" || (backend === "auto" && typeof navigator === "undefined")) {
    return (options.memoryRepository ?? defaultMemoryRepository).open(normalized);
  }
  if (!supportsDurableBlockStore()) {
    throw new BlockStoreError(
      "Durable OPFS storage requires Origin Private File System, Web Locks, and dedicated Worker support. Large transfers cannot safely fall back to RAM.",
      "UNSUPPORTED",
    );
  }

  if (options.requestPersistence) await requestPersistentBlockStorage();
  return OpfsBlockStore.open(normalized, { checkQuota: options.checkQuota === true });
}

abstract class BaseBlockStore implements BlockStore {
  abstract readonly backend: BlockStoreBackend;
  readonly config: Readonly<BlockStoreConfig>;
  readonly totalBlocks: number;
  protected state: StoreState;
  private readonly operationQueue: OperationQueue;
  private closed = false;
  private deleted = false;

  protected constructor(
    state: StoreState,
    options: { shareState?: boolean; operationQueue?: OperationQueue } = {},
  ) {
    this.state = options.shareState ? state : cloneState(state);
    this.operationQueue = options.operationQueue ?? { tail: Promise.resolve() };
    this.config = this.state.config;
    this.totalBlocks = this.state.totalBlocks;
  }

  progress(): BlockStoreProgress {
    return progressFromState(this.state);
  }

  checkpoint(): BlockStoreCheckpoint {
    return checkpointFromState(this.state);
  }

  hasBlock(index: number): boolean {
    assertBlockIndex(index, this.totalBlocks);
    return bitIsSet(this.state.bits, index);
  }

  writeBlock(index: number, bytes: Uint8Array): Promise<BlockWriteResult> {
    return this.writeBlocks([{ index, bytes }]);
  }

  writeBlocks(
    blocks: Iterable<BlockWrite> | AsyncIterable<BlockWrite>,
  ): Promise<BlockWriteResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      let writtenBlocks = 0;
      let duplicateBlocks = 0;
      let writer: BatchWriter | undefined;
      let pendingIndices: number[] = [];
      let pendingBytes = 0;
      let pendingSet = new Set<number>();

      const commitPending = async (): Promise<void> => {
        if (!writer || pendingIndices.length === 0) return;
        const committingWriter = writer;
        const committingIndices = pendingIndices;
        const committingBytes = pendingBytes;
        writer = undefined;
        pendingIndices = [];
        pendingBytes = 0;
        pendingSet = new Set<number>();
        try {
          await committingWriter.commit();
        } catch (error) {
          await safelyAbort(committingWriter);
          throw error;
        }

        const previousGeneration = this.state.generation;
        const previousUpdatedAt = this.state.updatedAt;
        for (const index of committingIndices) setBit(this.state.bits, index);
        this.state.receivedBlocks += committingIndices.length;
        this.state.receivedBytes += committingBytes;
        this.state.generation = previousGeneration + 1;
        this.state.updatedAt = Date.now();
        try {
          await this.persistState(this.state, committingIndices);
          writtenBlocks += committingIndices.length;
        } catch (error) {
          if (error instanceof DurableCommitTerminalError) {
            // persistState only raises this after the receipt record itself is
            // durable. Keep the matching in-memory bits and force the caller
            // to reopen rather than pretending these blocks were rolled back.
            writtenBlocks += committingIndices.length;
            throw error;
          }
          for (const index of committingIndices) clearBit(this.state.bits, index);
          this.state.receivedBlocks -= committingIndices.length;
          this.state.receivedBytes -= committingBytes;
          this.state.generation = previousGeneration;
          this.state.updatedAt = previousUpdatedAt;
          throw error;
        }
      };

      try {
        for await (const block of asAsyncIterable(blocks)) {
          validateBlockWrite(block, this.config, this.totalBlocks);
          if (bitIsSet(this.state.bits, block.index) || pendingSet.has(block.index)) {
            duplicateBlocks += 1;
            continue;
          }

          writer ??= await this.createBatchWriter();
          // Copy before awaiting the backend: camera/decoder buffers are often reused.
          const stableBytes = Uint8Array.from(block.bytes);
          const stableLength = stableBytes.byteLength;
          await writer.write(block.index, stableBytes);
          pendingIndices.push(block.index);
          // OPFS transfers stableBytes to its worker, detaching its ArrayBuffer.
          pendingBytes += stableLength;
          pendingSet.add(block.index);

          if (pendingIndices.length >= MAX_BLOCKS_PER_COMMIT) {
            await commitPending();
          }
        }
        await commitPending();
      } catch (error) {
        if (writer) await safelyAbort(writer);
        throw error;
      }

      const result = {
        writtenBlocks,
        duplicateBlocks,
        progress: this.progress(),
      } as BlockWriteResult;
      Object.defineProperty(result, "checkpoint", {
        configurable: false,
        enumerable: true,
        get: () => this.checkpoint(),
      });
      return result;
    });
  }

  readBlock(index: number): Promise<Uint8Array> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertBlockIndex(index, this.totalBlocks);
      if (!bitIsSet(this.state.bits, index)) {
        throw new BlockStoreError(`Block ${index} has not been received.`, "MISSING_BLOCK");
      }
      return this.readBackendRange(index * this.config.blockSize, expectedBlockLength(
        index,
        this.config,
        this.totalBlocks,
      ));
    });
  }

  readRange(offset: number, length: number): Promise<Uint8Array> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_READ_CHUNK_BYTES ||
        offset + length > this.config.totalBytes
      ) {
        throw new BlockStoreError(
          `Read ranges must be within the archive and no longer than ${MAX_READ_CHUNK_BYTES} bytes.`,
          "INVALID_CONFIG",
        );
      }
      if (length === 0) return new Uint8Array();
      const firstBlock = Math.floor(offset / this.config.blockSize);
      const lastBlock = Math.floor((offset + length - 1) / this.config.blockSize);
      for (let index = firstBlock; index <= lastBlock; index += 1) {
        if (!bitIsSet(this.state.bits, index)) {
          throw new BlockStoreError(`Block ${index} has not been received.`, "MISSING_BLOCK");
        }
      }
      return this.readBackendRange(offset, length);
    });
  }

  createReadStream(
    options: BlockReadStreamOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (this.state.receivedBlocks !== this.totalBlocks) {
        throw new BlockStoreError(
          `The store is incomplete (${this.state.receivedBlocks}/${this.totalBlocks} blocks).`,
          "INCOMPLETE",
        );
      }
      const chunkBytes = options.chunkBytes ?? DEFAULT_READ_CHUNK_BYTES;
      if (
        !Number.isSafeInteger(chunkBytes) ||
        chunkBytes <= 0 ||
        chunkBytes > MAX_READ_CHUNK_BYTES
      ) {
        throw new BlockStoreError(
          `Read chunk size must be between 1 and ${MAX_READ_CHUNK_BYTES} bytes.`,
          "INVALID_CONFIG",
        );
      }
      return this.openReadStream(chunkBytes);
    });
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.deleted) return;
      try {
        await this.closeBackend();
      } finally {
        this.closed = true;
      }
    }, true);
  }

  async delete(): Promise<void> {
    await this.enqueue(async () => {
      if (this.deleted) return;
      if (this.closed) {
        throw new BlockStoreError(
          "A closed block-store handle cannot delete a store that may have been reopened elsewhere.",
          "CLOSED",
        );
      }
      await this.deleteBackend();
      this.deleted = true;
      this.closed = true;
    }, true);
  }

  protected abstract createBatchWriter(): Promise<BatchWriter>;
  protected abstract persistState(
    state: StoreState,
    newlyReceivedIndices: readonly number[],
  ): Promise<void>;
  protected abstract readBackendRange(offset: number, length: number): Promise<Uint8Array>;
  protected abstract openReadStream(chunkBytes: number): Promise<ReadableStream<Uint8Array>>;
  protected abstract closeBackend(): Promise<void>;
  protected abstract deleteBackend(): Promise<void>;

  private assertOpen(): void {
    if (this.closed || this.deleted) {
      throw new BlockStoreError("The block store is closed.", "CLOSED");
    }
    this.assertBackendOpen();
  }

  protected assertBackendOpen(): void {}

  private enqueue<T>(operation: () => Promise<T>, allowClosed = false): Promise<T> {
    const run = this.operationQueue.tail.then(async () => {
      if (!allowClosed) this.assertOpen();
      return operation();
    });
    this.operationQueue.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

class MemoryBlockStore extends BaseBlockStore {
  readonly backend = "memory" as const;

  constructor(
    private readonly repository: MemoryBlockStoreRepository,
    private readonly record: MemoryRecord,
  ) {
    super(record.state, { shareState: true, operationQueue: record.operationQueue });
  }

  protected assertBackendOpen(): void {
    if (this.record.deleted) {
      throw new BlockStoreError("The block store is closed.", "CLOSED");
    }
  }

  protected async createBatchWriter(): Promise<BatchWriter> {
    const staged = new Map<number, Uint8Array>();
    return {
      write: async (index, bytes) => {
        staged.set(index, Uint8Array.from(bytes));
      },
      commit: async () => {
        for (const [index, bytes] of staged) this.record.blocks.set(index, bytes);
        staged.clear();
      },
      abort: async () => {
        staged.clear();
      },
    };
  }

  protected async persistState(state: StoreState): Promise<void> {
    // All handles for this in-process repository share this live state and
    // operation queue, matching the lifetime-exclusive browser semantics.
    if (state !== this.record.state) {
      throw new BlockStoreError("The memory block store state was replaced.", "CORRUPT_STORE");
    }
  }

  protected async readBackendRange(offset: number, length: number): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let outputOffset = 0;
    let sourceOffset = offset;
    while (outputOffset < length) {
      const blockIndex = Math.floor(sourceOffset / this.config.blockSize);
      const withinBlock = sourceOffset % this.config.blockSize;
      const block = this.record.blocks.get(blockIndex);
      if (!block) {
        throw new BlockStoreError(`Stored block ${blockIndex} is missing.`, "CORRUPT_STORE");
      }
      const copyLength = Math.min(length - outputOffset, block.byteLength - withinBlock);
      if (copyLength <= 0) {
        throw new BlockStoreError(`Stored block ${blockIndex} has an invalid length.`, "CORRUPT_STORE");
      }
      output.set(block.subarray(withinBlock, withinBlock + copyLength), outputOffset);
      outputOffset += copyLength;
      sourceOffset += copyLength;
    }
    return output;
  }

  protected async openReadStream(chunkBytes: number): Promise<ReadableStream<Uint8Array>> {
    let offset = 0;
    const totalBytes = this.config.totalBytes;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (offset >= totalBytes) {
          controller.close();
          return;
        }
        const length = Math.min(chunkBytes, totalBytes - offset);
        const chunk = await this.readBackendRange(offset, length);
        offset += length;
        controller.enqueue(chunk);
      },
    });
  }

  protected async closeBackend(): Promise<void> {
    // The memory repository has no external handles.
  }

  protected async deleteBackend(): Promise<void> {
    this.record.deleted = true;
    this.record.blocks.clear();
    this.repository.remove(this.config.storeId, this.record);
  }
}

class OpfsBlockStore extends BaseBlockStore {
  readonly backend = "opfs" as const;
  private resourcesReleased = false;
  private terminalError?: DurableCommitTerminalError;

  private constructor(
    state: StoreState,
    private readonly parentDirectory: FileSystemDirectoryHandle,
    private readonly storeDirectory: FileSystemDirectoryHandle,
    private readonly directoryName: string,
    private readonly worker: OpfsSyncWorkerClient,
    private readonly lease: StoreLockLease,
    private journalBytes: number,
  ) {
    super(state);
  }

  protected assertBackendOpen(): void {
    if (this.terminalError) throw this.terminalError;
    if (this.resourcesReleased || this.worker.unavailable) {
      throw new BlockStoreError("The durable block-store session is closed.", "CLOSED");
    }
  }

  static async open(
    config: Readonly<BlockStoreConfig>,
    options: { checkQuota: boolean },
  ): Promise<OpfsBlockStore> {
    const directoryName = await storeDirectoryName(config.storeId);
    const lease = await acquireStoreLock(directoryName);
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      const parent = await opfsRoot.getDirectoryHandle(STORE_ROOT_DIRECTORY, { create: true });
      const directory = await parent.getDirectoryHandle(directoryName, { create: true });
      const loaded = await loadOpfsState(directory, config);
      if (options.checkQuota) {
        const required = requiredAdditionalBlockStorageBytes(
          config,
          loaded.state.receivedBytes,
          loaded.metadataBytes,
        );
        const estimate = await estimateBlockStorage(required);
        if (estimate.hasEnoughSpace === false) {
          throw new BlockStoreError(
            `Finishing this transfer needs about ${required.toLocaleString()} additional bytes, but only ${estimate.available?.toLocaleString()} bytes are available.`,
            "QUOTA_EXCEEDED",
          );
        }
      }

      const worker = await OpfsSyncWorkerClient.open(
        directory,
        loaded.journalBytes,
        () => {
          void lease.release().catch(() => undefined);
        },
      );
      return new OpfsBlockStore(
        loaded.state,
        parent,
        directory,
        directoryName,
        worker,
        lease,
        loaded.journalBytes,
      );
    } catch (error) {
      await lease.release();
      if (error instanceof BlockStoreError) throw error;
      throw new BlockStoreError(
        `The durable OPFS store could not be opened. (${toError(error).message})`,
        "UNSUPPORTED",
      );
    }
  }

  protected async createBatchWriter(): Promise<BatchWriter> {
    // Reopen can inherit a journal that reached the compaction boundary just
    // before a prior session failed. Compact that durable state before writing
    // any new payload, otherwise reopen+one-write loops can grow the journal
    // beyond the quota model's threshold-plus-one-record bound.
    if (this.journalBytes >= this.journalCompactionThreshold()) {
      try {
        await this.compactJournal();
      } catch (error) {
        this.terminalError = new DurableCommitTerminalError(error);
        throw this.terminalError;
      }
    }
    let settled = false;
    return {
      write: async (index, bytes) => {
        await this.worker.writePayload(index * this.config.blockSize, bytes);
      },
      commit: async () => {
        if (settled) return;
        settled = true;
        // Receipt metadata is not written until these payload bytes are flushed.
        await this.worker.flushPayload();
      },
      abort: async () => {
        if (settled) return;
        settled = true;
        // In-place bytes are deliberately left unreceipted and will be overwritten
        // when their integrity-checked QR blocks are shown again.
      },
    };
  }

  protected async persistState(
    state: StoreState,
    newlyReceivedIndices: readonly number[],
  ): Promise<void> {
    const record = encodeJournalRecord(state.generation, newlyReceivedIndices);
    const recordLength = record.byteLength;
    await this.worker.appendJournal(this.journalBytes, record);
    // appendJournal transfers and detaches record.buffer.
    this.journalBytes += recordLength;

    const compactAt = this.journalCompactionThreshold();
    if (this.journalBytes < compactAt) return;

    // Journal durability has already succeeded. A compaction failure cannot be
    // reported as an ordinary rollback, because replay would still contain
    // these blocks. Make this session terminal so no second record is appended
    // until reopen has validated/truncated the durable journal.
    try {
      await this.compactJournal();
    } catch (error) {
      this.terminalError = new DurableCommitTerminalError(error);
      throw this.terminalError;
    }
  }

  protected async readBackendRange(offset: number, length: number): Promise<Uint8Array> {
    return this.worker.readPayload(offset, length);
  }

  protected async openReadStream(chunkBytes: number): Promise<ReadableStream<Uint8Array>> {
    let offset = 0;
    const totalBytes = this.config.totalBytes;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (offset >= totalBytes) {
          controller.close();
          return;
        }
        const end = Math.min(totalBytes, offset + chunkBytes);
        const chunk = await this.worker.readPayload(offset, end - offset);
        offset = end;
        controller.enqueue(chunk);
      },
    });
  }

  protected async closeBackend(): Promise<void> {
    await this.releaseResources();
  }

  protected async deleteBackend(): Promise<void> {
    if (this.resourcesReleased || this.worker.fatal) {
      throw new BlockStoreError(
        "This block-store handle lost its lifetime lock and cannot delete a store that may have been reopened elsewhere.",
        "CLOSED",
      );
    }
    let closeError: unknown;
    try {
      await this.worker.close();
    } catch (error) {
      closeError = error;
    }
    if (this.worker.fatal) {
      this.resourcesReleased = true;
      await this.lease.release();
      throw closeError ?? new BlockStoreError(
        "The block-store worker failed before deletion could retain its lifetime lock.",
        "CLOSED",
      );
    }
    try {
      await this.parentDirectory.removeEntry(this.directoryName, { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    // Removal is the authoritative outcome. A non-fatal close-protocol error
    // cannot make an already removed directory reappear.
    this.resourcesReleased = true;
    await this.lease.release().catch(() => undefined);
  }

  private async releaseResources(): Promise<void> {
    if (this.resourcesReleased) return;
    this.resourcesReleased = true;
    try {
      await this.worker.close();
    } finally {
      await this.lease.release();
    }
  }

  private journalCompactionThreshold(): number {
    return Math.max(
      MIN_JOURNAL_COMPACTION_BYTES,
      this.state.bits.byteLength * 2,
    );
  }

  private async compactJournal(): Promise<void> {
    await writeCheckpoint(this.storeDirectory, this.state);
    await this.worker.truncateJournal(0);
    this.journalBytes = 0;
  }
}

interface StoreLockLease {
  release(): Promise<void>;
}

class OpfsSyncWorkerClient {
  private readonly pending = new Map<
    number,
    {
      resolve: (response: BlockStoreWorkerResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private nextId = 1;
  private closed = false;
  private failed = false;

  get fatal(): boolean {
    return this.failed;
  }

  get unavailable(): boolean {
    return this.closed;
  }

  private constructor(
    private readonly worker: Worker,
    private readonly onFatal: () => void,
  ) {
    worker.onmessage = (event: MessageEvent<BlockStoreWorkerResponse>) => {
      this.handleMessage(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(event.message || "The OPFS worker stopped unexpectedly."));
    };
    worker.onmessageerror = () => {
      this.fail(new Error("The OPFS worker returned an unreadable message."));
    };
  }

  static async open(
    directory: FileSystemDirectoryHandle,
    journalBytes: number,
    onFatal: () => void,
  ): Promise<OpfsSyncWorkerClient> {
    const worker = new Worker(new URL("./block-store.worker.ts", import.meta.url), {
      type: "module",
      name: "qrf3-block-store",
    });
    const client = new OpfsSyncWorkerClient(worker, onFatal);
    try {
      const response = await client.request((id) => ({
        id,
        type: "open",
        directory,
        journalBytes,
      }));
      if (response.type !== "ready") {
        throw new Error("The OPFS worker returned an invalid open response.");
      }
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async writePayload(offset: number, bytes: Uint8Array): Promise<void> {
    const buffer = bytes.buffer as ArrayBuffer;
    const response = await this.request(
      (id) => ({ id, type: "write-payload", offset, bytes: buffer }),
      [buffer],
    );
    assertDoneResponse(response);
  }

  async flushPayload(): Promise<void> {
    assertDoneResponse(await this.request((id) => ({ id, type: "flush-payload" })));
  }

  async appendJournal(offset: number, bytes: Uint8Array): Promise<void> {
    const buffer = bytes.buffer as ArrayBuffer;
    const response = await this.request(
      (id) => ({ id, type: "append-journal", offset, bytes: buffer }),
      [buffer],
    );
    assertDoneResponse(response);
  }

  async truncateJournal(size: number): Promise<void> {
    assertDoneResponse(
      await this.request((id) => ({ id, type: "truncate-journal", size })),
    );
  }

  async readPayload(offset: number, length: number): Promise<Uint8Array> {
    const response = await this.request((id) => ({
      id,
      type: "read-payload",
      offset,
      length,
    }));
    if (response.type !== "read") {
      throw new Error("The OPFS worker returned an invalid read response.");
    }
    return new Uint8Array(response.bytes);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      const response = await this.request((id) => ({ id, type: "close" }));
      assertDoneResponse(response);
    } finally {
      this.closed = true;
      this.worker.terminate();
      for (const pending of this.pending.values()) {
        pending.reject(new BlockStoreError("The block store is closed.", "CLOSED"));
      }
      this.pending.clear();
    }
  }

  private request(
    createRequest: (id: number) => BlockStoreWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<BlockStoreWorkerResponse & { ok: true }> {
    if (this.closed) {
      return Promise.reject(new BlockStoreError("The block store is closed.", "CLOSED"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: BlockStoreWorkerResponse) => void, reject });
      try {
        this.worker.postMessage(createRequest(id), transfer);
      } catch (error) {
        this.pending.delete(id);
        const normalized = toError(error);
        reject(normalized);
        this.fail(normalized);
      }
    });
  }

  private handleMessage(response: BlockStoreWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (!response.ok) {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      pending.reject(error);
      this.fail(error);
      return;
    }
    pending.resolve(response);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.failed = true;
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.onFatal();
  }
}

function assertDoneResponse(response: BlockStoreWorkerResponse & { ok: true }): void {
  if (response.type !== "done") {
    throw new Error("The OPFS worker returned an invalid acknowledgement.");
  }
}

async function acquireStoreLock(directoryName: string): Promise<StoreLockLease> {
  const root = await acquireNamedLock(STORE_ROOT_LOCK, "shared");
  try {
    const store = await acquireNamedLock(`${STORE_LOCK_PREFIX}${directoryName}`, "exclusive");
    let released: Promise<void> | undefined;
    return {
      release: () => (released ??= (async () => {
        try {
          await store.release();
        } finally {
          await root.release();
        }
      })()),
    };
  } catch (error) {
    await root.release();
    throw error;
  }
}

async function acquireNamedLock(
  name: string,
  mode: "shared" | "exclusive",
): Promise<StoreLockLease> {
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let acquiredResolve!: () => void;
  let acquiredReject!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  const request = navigator.locks.request(
    name,
    { mode, ifAvailable: true },
    async (lock) => {
      if (!lock) {
        acquiredReject(
          new BlockStoreError(
            "This transfer store is already open in another tab or receiver.",
            "BUSY",
          ),
        );
        return;
      }
      acquiredResolve();
      await hold;
    },
  );
  void request.catch(acquiredReject);
  await acquired;
  let released: Promise<void> | undefined;
  return {
    release: () => (released ??= (async () => {
      releaseHold();
      await request;
    })()),
  };
}

/** Removes only AirGap QR's app-owned OPFS block-store directory. */
export async function deleteAllBlockStores(): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.storage?.getDirectory !== "function"
  ) return;
  if (typeof navigator.locks?.request !== "function") {
    throw new BlockStoreError(
      "Deleting durable block stores safely requires Web Locks support.",
      "UNSUPPORTED",
    );
  }

  const lease = await acquireNamedLock(STORE_ROOT_LOCK, "exclusive");
  try {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(STORE_ROOT_DIRECTORY, { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  } finally {
    await lease.release();
  }
}

interface LoadedOpfsState {
  state: StoreState;
  journalBytes: number;
  metadataBytes: number;
}

async function loadOpfsState(
  directory: FileSystemDirectoryHandle,
  config: Readonly<BlockStoreConfig>,
): Promise<LoadedOpfsState> {
  const checkpointResults = await Promise.all(
    CHECKPOINT_FILE_NAMES.map((name) => readFileIfPresent(directory, name)),
  );
  const existingCheckpointFiles = checkpointResults.filter((result) => result.exists).length;
  const candidates = checkpointResults.flatMap((result) => {
    if (!result.bytes) return [];
    try {
      return [decodeCheckpoint(result.bytes)];
    } catch {
      return [];
    }
  });

  if (existingCheckpointFiles > 0 && candidates.length === 0) {
    throw new BlockStoreError(
      "Both OPFS receipt checkpoints are corrupt; the stored transfer cannot be trusted.",
      "CORRUPT_STORE",
    );
  }

  const dataFile = await directory.getFileHandle(DATA_FILE_NAME, { create: true });
  const journalFile = await directory.getFileHandle(JOURNAL_FILE_NAME, { create: true });
  if (candidates.length === 0) {
    const initial = createInitialState(config);
    await replaceFile(dataFile, new Uint8Array());
    await replaceFile(journalFile, new Uint8Array());
    await writeCheckpoint(directory, initial);
    return {
      state: initial,
      journalBytes: 0,
      metadataBytes: await storedMetadataBytes(directory),
    };
  }

  candidates.sort((left, right) => right.generation - left.generation);
  let state = candidates[0];
  assertMatchingConfig(state.config, config);

  const journalBytes = new Uint8Array(await (await journalFile.getFile()).arrayBuffer());
  const replayed = replayJournal(state, journalBytes);
  state = replayed.state;

  const dataSize = (await dataFile.getFile()).size;
  const highestBlock = highestSetBit(state.bits, state.totalBlocks);
  if (highestBlock >= 0) {
    const requiredLength =
      highestBlock * state.config.blockSize +
      expectedBlockLength(highestBlock, state.config, state.totalBlocks);
    if (dataSize < requiredLength) {
      throw new BlockStoreError(
        "The OPFS payload file is shorter than its durable receipt checkpoint.",
        "CORRUPT_STORE",
      );
    }
  }

  return {
    state,
    journalBytes: replayed.validBytes,
    metadataBytes: checkpointResults.reduce(
      (total, result) => total + (result.bytes?.byteLength ?? 0),
      journalBytes.byteLength,
    ),
  };
}

async function storedMetadataBytes(directory: FileSystemDirectoryHandle): Promise<number> {
  const names = [...CHECKPOINT_FILE_NAMES, JOURNAL_FILE_NAME];
  let total = 0;
  for (const name of names) {
    const result = await readFileIfPresent(directory, name);
    total += result.bytes?.byteLength ?? 0;
  }
  return total;
}

async function writeCheckpoint(
  directory: FileSystemDirectoryHandle,
  state: StoreState,
): Promise<void> {
  const slot = state.generation % CHECKPOINT_FILE_NAMES.length;
  const handle = await directory.getFileHandle(CHECKPOINT_FILE_NAMES[slot], { create: true });
  await replaceFile(handle, encodeCheckpoint(state));
}

async function replaceFile(
  handle: FileSystemFileHandle,
  bytes: Uint8Array,
): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(copyToArrayBuffer(bytes));
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function readFileIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<{ exists: boolean; bytes?: Uint8Array }> {
  try {
    const handle = await directory.getFileHandle(name);
    return {
      exists: true,
      bytes: new Uint8Array(await (await handle.getFile()).arrayBuffer()),
    };
  } catch (error) {
    if (isNotFoundError(error)) return { exists: false };
    throw error;
  }
}

function encodeCheckpoint(state: StoreState): Uint8Array {
  const idBytes = new TextEncoder().encode(state.config.storeId);
  const output = new Uint8Array(
    CHECKPOINT_FIXED_BYTES + idBytes.byteLength + state.bits.byteLength + CHECKSUM_BYTES,
  );
  output.set(CHECKPOINT_MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint16(4, SCHEMA_VERSION, true);
  view.setBigUint64(8, BigInt(state.generation), true);
  view.setBigUint64(16, BigInt(state.config.totalBytes), true);
  view.setUint32(24, state.config.blockSize, true);
  view.setUint32(28, state.totalBlocks, true);
  view.setUint32(32, state.receivedBlocks, true);
  view.setBigUint64(36, BigInt(state.receivedBytes), true);
  view.setBigUint64(44, BigInt(state.updatedAt), true);
  view.setUint32(52, idBytes.byteLength, true);
  view.setUint32(56, state.bits.byteLength, true);
  output.set(idBytes, CHECKPOINT_FIXED_BYTES);
  output.set(state.bits, CHECKPOINT_FIXED_BYTES + idBytes.byteLength);
  view.setUint32(output.byteLength - CHECKSUM_BYTES, crc32(output.subarray(0, -CHECKSUM_BYTES)), true);
  return output;
}

function decodeCheckpoint(bytes: Uint8Array): StoreState {
  if (bytes.byteLength < CHECKPOINT_FIXED_BYTES + CHECKSUM_BYTES) {
    throw new Error("Checkpoint is truncated.");
  }
  assertMagic(bytes, CHECKPOINT_MAGIC);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== SCHEMA_VERSION) throw new Error("Unknown checkpoint version.");
  const expectedCrc = view.getUint32(bytes.byteLength - CHECKSUM_BYTES, true);
  if (crc32(bytes.subarray(0, -CHECKSUM_BYTES)) !== expectedCrc) {
    throw new Error("Checkpoint checksum differs.");
  }

  const generation = safeBigUint(view.getBigUint64(8, true), "generation");
  const totalBytes = safeBigUint(view.getBigUint64(16, true), "total bytes");
  const blockSize = view.getUint32(24, true);
  const totalBlocks = view.getUint32(28, true);
  const receivedBlocks = view.getUint32(32, true);
  const receivedBytes = safeBigUint(view.getBigUint64(36, true), "received bytes");
  const updatedAt = safeBigUint(view.getBigUint64(44, true), "updated time");
  const idLength = view.getUint32(52, true);
  const bitsLength = view.getUint32(56, true);
  const expectedLength = CHECKPOINT_FIXED_BYTES + idLength + bitsLength + CHECKSUM_BYTES;
  if (bytes.byteLength !== expectedLength || idLength === 0 || idLength > MAX_STORE_ID_BYTES) {
    throw new Error("Checkpoint lengths are invalid.");
  }
  const storeId = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(CHECKPOINT_FIXED_BYTES, CHECKPOINT_FIXED_BYTES + idLength),
  );
  const config = normalizeConfig({ storeId, totalBytes, blockSize });
  if (totalBlocks !== blockCount(config) || bitsLength !== Math.ceil(totalBlocks / 8)) {
    throw new Error("Checkpoint layout is invalid.");
  }
  const bits = bytes.slice(
    CHECKPOINT_FIXED_BYTES + idLength,
    CHECKPOINT_FIXED_BYTES + idLength + bitsLength,
  );
  clearUnusedBits(bits, totalBlocks);
  const computed = receiptCounts(bits, config, totalBlocks);
  if (computed.blocks !== receivedBlocks || computed.bytes !== receivedBytes) {
    throw new Error("Checkpoint counters do not match its bitset.");
  }
  return {
    config,
    totalBlocks,
    receivedBlocks,
    receivedBytes,
    bits,
    generation,
    updatedAt,
  };
}

function encodeJournalRecord(
  generation: number,
  indices: readonly number[],
): Uint8Array {
  const output = new Uint8Array(
    JOURNAL_FIXED_BYTES + indices.length * Uint32Array.BYTES_PER_ELEMENT + CHECKSUM_BYTES,
  );
  output.set(JOURNAL_MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint16(4, SCHEMA_VERSION, true);
  view.setBigUint64(8, BigInt(generation), true);
  view.setUint32(16, indices.length, true);
  indices.forEach((index, offset) => view.setUint32(20 + offset * 4, index, true));
  view.setUint32(output.byteLength - CHECKSUM_BYTES, crc32(output.subarray(0, -CHECKSUM_BYTES)), true);
  return output;
}

function replayJournal(
  checkpoint: StoreState,
  bytes: Uint8Array,
): { state: StoreState; validBytes: number } {
  const state = cloneState(checkpoint);
  let offset = 0;
  while (offset + JOURNAL_FIXED_BYTES + CHECKSUM_BYTES <= bytes.byteLength) {
    if (!magicMatches(bytes.subarray(offset), JOURNAL_MAGIC)) break;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    if (view.getUint16(4, true) !== SCHEMA_VERSION) break;
    const count = view.getUint32(16, true);
    const recordLength = JOURNAL_FIXED_BYTES + count * 4 + CHECKSUM_BYTES;
    if (count === 0 || count > MAX_BLOCKS_PER_COMMIT || offset + recordLength > bytes.byteLength) break;
    const record = bytes.subarray(offset, offset + recordLength);
    if (
      view.getUint32(recordLength - CHECKSUM_BYTES, true) !==
      crc32(record.subarray(0, -CHECKSUM_BYTES))
    ) break;
    const generation = safeBigUint(view.getBigUint64(8, true), "journal generation");

    if (generation > state.generation) {
      if (generation !== state.generation + 1) break;
      const indices: number[] = [];
      const seen = new Set<number>();
      let valid = true;
      for (let position = 0; position < count; position += 1) {
        const index = view.getUint32(JOURNAL_FIXED_BYTES + position * 4, true);
        if (
          index >= state.totalBlocks ||
          bitIsSet(state.bits, index) ||
          seen.has(index)
        ) {
          valid = false;
          break;
        }
        seen.add(index);
        indices.push(index);
      }
      if (!valid) break;
      for (const index of indices) {
        setBit(state.bits, index);
        state.receivedBlocks += 1;
        state.receivedBytes += expectedBlockLength(index, state.config, state.totalBlocks);
      }
      state.generation = generation;
    }
    offset += recordLength;
  }
  return { state, validBytes: offset };
}

function createInitialState(config: Readonly<BlockStoreConfig>): StoreState {
  const totalBlocks = blockCount(config);
  return {
    config,
    totalBlocks,
    receivedBlocks: 0,
    receivedBytes: 0,
    bits: new Uint8Array(Math.ceil(totalBlocks / 8)),
    generation: 1,
    updatedAt: Date.now(),
  };
}

function checkpointFromState(state: StoreState): BlockStoreCheckpoint {
  return {
    ...progressFromState(state),
    receivedBlockBits: state.bits.slice(),
  };
}

function progressFromState(state: StoreState): BlockStoreProgress {
  return {
    schemaVersion: SCHEMA_VERSION,
    ...state.config,
    totalBlocks: state.totalBlocks,
    receivedBlocks: state.receivedBlocks,
    receivedBytes: state.receivedBytes,
    complete: state.receivedBlocks === state.totalBlocks,
    generation: state.generation,
    updatedAt: state.updatedAt,
  };
}

function cloneState(state: StoreState): StoreState {
  return {
    ...state,
    config: state.config,
    bits: state.bits.slice(),
  };
}

function normalizeConfig(config: BlockStoreConfig): Readonly<BlockStoreConfig> {
  const storeId = typeof config.storeId === "string" ? config.storeId.trim() : "";
  const idLength = new TextEncoder().encode(storeId).byteLength;
  if (!storeId || idLength > MAX_STORE_ID_BYTES) {
    throw new BlockStoreError(
      `storeId must contain between 1 and ${MAX_STORE_ID_BYTES} UTF-8 bytes.`,
      "INVALID_CONFIG",
    );
  }
  assertSafeNonNegativeInteger(config.totalBytes, "totalBytes");
  if (
    !Number.isSafeInteger(config.blockSize) ||
    config.blockSize <= 0 ||
    config.blockSize > MAX_BLOCK_BYTES
  ) {
    throw new BlockStoreError(
      `blockSize must be an integer between 1 and ${MAX_BLOCK_BYTES}.`,
      "INVALID_CONFIG",
    );
  }
  const normalized = Object.freeze({
    storeId,
    totalBytes: config.totalBytes,
    blockSize: config.blockSize,
  });
  const blocks = blockCount(normalized);
  if (blocks > MAX_BLOCK_STORE_BLOCKS) {
    throw new BlockStoreError(
      `This transfer needs ${blocks.toLocaleString()} blocks; the safe limit is ${MAX_BLOCK_STORE_BLOCKS.toLocaleString()}.`,
      "INVALID_CONFIG",
    );
  }
  return normalized;
}

function blockCount(config: Readonly<BlockStoreConfig>): number {
  return config.totalBytes === 0 ? 0 : Math.ceil(config.totalBytes / config.blockSize);
}

function validateBlockWrite(
  block: BlockWrite,
  config: Readonly<BlockStoreConfig>,
  totalBlocks: number,
): void {
  if (!block || !(block.bytes instanceof Uint8Array)) {
    throw new BlockStoreError("A block write must contain Uint8Array bytes.", "INVALID_BLOCK");
  }
  assertBlockIndex(block.index, totalBlocks);
  const expected = expectedBlockLength(block.index, config, totalBlocks);
  if (block.bytes.byteLength !== expected) {
    throw new BlockStoreError(
      `Block ${block.index} has ${block.bytes.byteLength} bytes; expected ${expected}.`,
      "INVALID_BLOCK",
    );
  }
}

function expectedBlockLength(
  index: number,
  config: Readonly<BlockStoreConfig>,
  totalBlocks: number,
): number {
  if (index === totalBlocks - 1) {
    return config.totalBytes - index * config.blockSize;
  }
  return config.blockSize;
}

function assertBlockIndex(index: number, totalBlocks: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= totalBlocks) {
    throw new BlockStoreError(
      `Block index ${String(index)} is outside 0..${Math.max(0, totalBlocks - 1)}.`,
      "INVALID_BLOCK",
    );
  }
}

function assertMatchingConfig(
  stored: Readonly<BlockStoreConfig>,
  requested: Readonly<BlockStoreConfig>,
): void {
  if (
    stored.storeId !== requested.storeId ||
    stored.totalBytes !== requested.totalBytes ||
    stored.blockSize !== requested.blockSize
  ) {
    throw new BlockStoreError(
      "A store with this ID already exists with a different byte length or block size.",
      "INVALID_CONFIG",
    );
  }
}

function bitIsSet(bits: Uint8Array, index: number): boolean {
  return (bits[index >>> 3] & (1 << (index & 7))) !== 0;
}

function setBit(bits: Uint8Array, index: number): void {
  bits[index >>> 3] |= 1 << (index & 7);
}

function clearBit(bits: Uint8Array, index: number): void {
  bits[index >>> 3] &= ~(1 << (index & 7));
}

function clearUnusedBits(bits: Uint8Array, totalBlocks: number): void {
  if (bits.length === 0 || totalBlocks % 8 === 0) return;
  const mask = (1 << (totalBlocks % 8)) - 1;
  if ((bits[bits.length - 1] & ~mask) !== 0) throw new Error("Bitset has out-of-range blocks.");
}

function highestSetBit(bits: Uint8Array, totalBlocks: number): number {
  for (let index = totalBlocks - 1; index >= 0; index -= 1) {
    if (bitIsSet(bits, index)) return index;
  }
  return -1;
}

function receiptCounts(
  bits: Uint8Array,
  config: Readonly<BlockStoreConfig>,
  totalBlocks: number,
): { blocks: number; bytes: number } {
  let blocks = 0;
  for (const byte of bits) blocks += POPCOUNT[byte];
  let bytes = blocks * config.blockSize;
  if (totalBlocks > 0 && bitIsSet(bits, totalBlocks - 1)) {
    bytes -= config.blockSize - expectedBlockLength(totalBlocks - 1, config, totalBlocks);
  }
  return { blocks, bytes };
}

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, value) => {
  let count = 0;
  for (let current = value; current !== 0; current >>>= 1) count += current & 1;
  return count;
});

async function* asAsyncIterable<T>(
  source: Iterable<T> | AsyncIterable<T>,
): AsyncGenerator<T> {
  if (Symbol.asyncIterator in Object(source)) {
    for await (const value of source as AsyncIterable<T>) yield value;
    return;
  }
  for (const value of source as Iterable<T>) yield value;
}

async function safelyAbort(writer: BatchWriter): Promise<void> {
  try {
    await writer.abort();
  } catch {
    // Preserve the original write/commit failure.
  }
}

async function storeDirectoryName(storeId: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(storeId)),
  );
  return `s-${Array.from(digest.subarray(0, 20), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function safeBigUint(value: bigint, field: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new Error(`${field} exceeds JavaScript's safe range.`);
  return converted;
}

function assertSafeNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BlockStoreError(`${field} must be a non-negative safe integer.`, "INVALID_CONFIG");
  }
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function assertMagic(bytes: Uint8Array, magic: Uint8Array): void {
  if (!magicMatches(bytes, magic)) throw new Error("Metadata magic differs.");
}

function magicMatches(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.byteLength < magic.byteLength) return false;
  return magic.every((value, index) => bytes[index] === value);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "NotFoundError";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
