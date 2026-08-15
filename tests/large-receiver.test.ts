import { describe, expect, it, vi } from "vitest";
import {
  BlockStoreError,
  MemoryBlockStoreRepository,
  type BlockStore,
  type BlockStoreConfig,
} from "../src/lib/block-store";
import {
  LargeQrf3Receiver,
  LargeReceiverPoisonCleanupError,
  isLargeReceiverTerminalStorageError,
} from "../src/lib/large-receiver";
import {
  Qrf3BlobSource,
  Qrf3TransferPurpose,
  createQrf3Transfer,
} from "../src/lib/stream-protocol";

describe("large QRF3 receiver", () => {
  it("classifies only a durable receipt-compaction stop as reopenable", () => {
    expect(
      isLargeReceiverTerminalStorageError(
        new BlockStoreError("reopen required", "REOPEN_REQUIRED"),
      ),
    ).toBe(true);
    expect(
      isLargeReceiverTerminalStorageError(
        new BlockStoreError("worker failed", "CLOSED"),
      ),
    ).toBe(false);
    expect(
      isLargeReceiverTerminalStorageError(
        new BlockStoreError("bad frame payload", "INVALID_BLOCK"),
      ),
    ).toBe(false);
    expect(isLargeReceiverTerminalStorageError(new Error("malformed frame"))).toBe(false);
  });

  it("persists out-of-order blocks, deduplicates, and verifies incrementally", async () => {
    const bytes = Uint8Array.from({ length: 5_003 }, (_, index) => index % 251);
    const transfer = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([bytes])),
      { rootName: "fixture", blockSize: 700 },
    );
    const receiver = new LargeQrf3Receiver({
      backend: "memory",
      expectedPurpose: Qrf3TransferPurpose.Files,
      expectedConnectionId: transfer.manifest.connectionId,
    });

    expect((await receiver.accept(await transfer.dataFrame(0))).state).toBe(
      "awaiting-manifest",
    );
    await receiver.accept(await transfer.manifestFrame());
    for (let index = transfer.blockCount - 1; index >= 0; index -= 1) {
      await receiver.accept(await transfer.dataFrame(index));
    }
    const duplicate = await receiver.accept(await transfer.dataFrame(0));
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.state).toBe("complete");
    expect(duplicate.progress).not.toHaveProperty("receivedBlockBits");

    const firstVerification = receiver.verifyComplete();
    expect(receiver.verifyComplete()).toBe(firstVerification);
    const reader = await firstVerification;
    expect(await reader.read(697n, 10)).toEqual(bytes.slice(697, 707));
    await receiver.delete();
  });

  it("rejects a stream outside the verified connection", async () => {
    const transfer = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([Uint8Array.of(1, 2, 3)])),
      { rootName: "fixture" },
    );
    const receiver = new LargeQrf3Receiver({
      backend: "memory",
      expectedConnectionId: new Uint8Array(16),
    });
    await expect(receiver.accept(await transfer.manifestFrame())).rejects.toThrow(
      /connection/,
    );
  });

  it("rejects a non-canonical connection test before opening storage", async () => {
    const wrongLength = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([new Uint8Array(4_095)])),
      {
        rootName: "QRF3 Connection Test",
        purpose: Qrf3TransferPurpose.ConnectionTest,
      },
    );
    const wrongRoot = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([new Uint8Array(4_096)])),
      {
        rootName: "not-the-connection-root",
        purpose: Qrf3TransferPurpose.ConnectionTest,
      },
    );
    const repository = new MemoryBlockStoreRepository();
    const open = vi.spyOn(repository, "open");

    for (const transfer of [wrongLength, wrongRoot]) {
      const receiver = new LargeQrf3Receiver({
        backend: "memory",
        memoryRepository: repository,
        expectedPurpose: Qrf3TransferPurpose.ConnectionTest,
      });
      await expect(receiver.accept(await transfer.manifestFrame())).rejects.toThrow(
        /fixed 4 KiB probe/i,
      );
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("allows verification to be retried after an incomplete check", async () => {
    const bytes = Uint8Array.from({ length: 1_401 }, (_, index) => index % 251);
    const transfer = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([bytes])),
      { rootName: "retry", blockSize: 700 },
    );
    const receiver = new LargeQrf3Receiver({ backend: "memory" });
    await receiver.accept(await transfer.manifestFrame());
    await receiver.accept(await transfer.dataFrame(0));
    await expect(receiver.verifyComplete()).rejects.toThrow(/incomplete/);
    for (let index = 1; index < transfer.blockCount; index += 1) {
      await receiver.accept(await transfer.dataFrame(index));
    }
    const reader = await receiver.verifyComplete();
    expect(await reader.read(0n, bytes.length)).toEqual(bytes);
    await receiver.delete();
  });

  it("reopens a Files transfer by manifest identity and resumes its receipt map", async () => {
    const bytes = Uint8Array.from({ length: 2_103 }, (_, index) => index % 251);
    const transfer = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([bytes])),
      { rootName: "manifest-resume", blockSize: 700 },
    );
    const repository = new MemoryBlockStoreRepository();
    const options = {
      backend: "memory" as const,
      memoryRepository: repository,
      expectedPurpose: Qrf3TransferPurpose.Files,
      expectedConnectionId: transfer.manifest.connectionId,
      expectedTransferId: transfer.manifest.transferId,
      expectedManifestId: transfer.manifestId,
    };
    const first = new LargeQrf3Receiver(options);
    await first.accept(await transfer.manifestFrame());
    await first.accept(await transfer.dataFrame(0));
    await first.accept(await transfer.dataFrame(2));
    const closing = first.close();
    expect(first.close()).toBe(closing);
    await closing;

    const resumed = new LargeQrf3Receiver(options);
    const reopened = await resumed.accept(await transfer.manifestFrame());
    expect(reopened.progress?.receivedBlocks).toBe(2);
    for (let index = 0; index < transfer.blockCount; index += 1) {
      await resumed.accept(await transfer.dataFrame(index));
    }
    const reader = await resumed.verifyComplete();
    expect(await reader.read(0n, bytes.length)).toEqual(bytes);
    await resumed.delete();
  });

  it("deletes a poisoned complete store so its blocks can be reacquired", async () => {
    const bytes = Uint8Array.from({ length: 1_401 }, (_, index) => index % 251);
    const transfer = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([bytes])),
      {
        rootName: "poisoned",
        blockSize: 700,
        archiveSha256: new Uint8Array(32),
      },
    );
    const repository = new MemoryBlockStoreRepository();
    const receiver = new LargeQrf3Receiver({
      backend: "memory",
      memoryRepository: repository,
    });
    await receiver.accept(await transfer.manifestFrame());
    for (let index = 0; index < transfer.blockCount; index += 1) {
      await receiver.accept(await transfer.dataFrame(index));
    }

    await expect(receiver.verifyComplete()).rejects.toThrow(/SHA-256/);

    const retry = new LargeQrf3Receiver({
      backend: "memory",
      memoryRepository: repository,
    });
    const reopened = await retry.accept(await transfer.manifestFrame());
    expect(reopened.progress?.receivedBlocks).toBe(0);
    await retry.delete();
  });

  it("closes permanently after a poisoned-store delete failure instead of rehashing", async () => {
    const bytes = Uint8Array.from({ length: 701 }, (_, index) => index % 251);
    const transfer = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([bytes])),
      {
        rootName: "poison-delete-failure",
        blockSize: 700,
        archiveSha256: new Uint8Array(32),
      },
    );
    const repository = new OneShotDeleteFailureRepository();
    const receiver = new LargeQrf3Receiver({
      backend: "memory",
      memoryRepository: repository,
    });
    await receiver.accept(await transfer.manifestFrame());
    for (let index = 0; index < transfer.blockCount; index += 1) {
      await receiver.accept(await transfer.dataFrame(index));
    }

    await expect(receiver.verifyComplete()).rejects.toBeInstanceOf(
      LargeReceiverPoisonCleanupError,
    );
    expect(() => receiver.verifyComplete()).toThrow(/closed/);
    expect(repository.readStreams).toBe(1);
    await receiver.delete();
  });
});

class OneShotDeleteFailureRepository extends MemoryBlockStoreRepository {
  readStreams = 0;
  private failNextDelete = true;

  override async open(config: BlockStoreConfig): Promise<BlockStore> {
    const store = await super.open(config);
    return new Proxy(store, {
      get: (target, property) => {
        if (property === "createReadStream") {
          return (...args: Parameters<BlockStore["createReadStream"]>) => {
            this.readStreams += 1;
            return target.createReadStream(...args);
          };
        }
        if (property === "delete") {
          return async () => {
            if (this.failNextDelete) {
              this.failNextDelete = false;
              throw new Error("simulated delete failure");
            }
            await target.delete();
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
