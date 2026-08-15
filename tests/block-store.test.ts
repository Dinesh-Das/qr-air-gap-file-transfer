import { describe, expect, it } from "vitest";

import {
  BlockStoreError,
  MAX_BLOCK_STORE_BLOCKS,
  MemoryBlockStoreRepository,
  deleteAllBlockStores,
  estimateBlockStorage,
  openBlockStore,
  requiredAdditionalBlockStorageBytes,
  requiredBlockStorageBytes,
  supportsDurableBlockStore,
} from "../src/lib/block-store";

describe("block store", () => {
  it("writes random offsets and streams the completed payload with bounded chunks", async () => {
    const repository = new MemoryBlockStoreRepository();
    const store = await openBlockStore(
      { storeId: "random-order", totalBytes: 10, blockSize: 4 },
      { backend: "memory", memoryRepository: repository },
    );

    await expect(store.createReadStream()).rejects.toMatchObject({ code: "INCOMPLETE" });
    await store.writeBlock(2, Uint8Array.of(8, 9));
    await store.writeBlocks([
      { index: 0, bytes: Uint8Array.of(0, 1, 2, 3) },
      { index: 1, bytes: Uint8Array.of(4, 5, 6, 7) },
    ]);

    const checkpoint = store.checkpoint();
    expect(checkpoint).toMatchObject({
      totalBlocks: 3,
      receivedBlocks: 3,
      receivedBytes: 10,
      complete: true,
    });
    expect(await store.readBlock(1)).toEqual(Uint8Array.of(4, 5, 6, 7));
    expect(await store.readRange(2, 6)).toEqual(Uint8Array.of(2, 3, 4, 5, 6, 7));

    const stream = await store.createReadStream({ chunkBytes: 3 });
    const { bytes, chunkLengths } = await consumeStream(stream);
    expect(bytes).toEqual(Uint8Array.from({ length: 10 }, (_, index) => index));
    expect(chunkLengths).toEqual([3, 3, 3, 1]);
  });

  it("reopens durable receipt state without retaining a second archive copy", async () => {
    const repository = new MemoryBlockStoreRepository();
    const config = { storeId: "resume-me", totalBytes: 9, blockSize: 4 };
    const first = await repository.open(config);
    await first.writeBlocks([
      { index: 2, bytes: Uint8Array.of(9) },
      { index: 0, bytes: Uint8Array.of(1, 2, 3, 4) },
    ]);
    const firstGeneration = first.checkpoint().generation;
    await first.close();

    const resumed = await repository.open(config);
    expect(resumed.hasBlock(0)).toBe(true);
    expect(resumed.hasBlock(1)).toBe(false);
    expect(resumed.hasBlock(2)).toBe(true);
    expect(resumed.checkpoint()).toMatchObject({
      receivedBlocks: 2,
      receivedBytes: 5,
      generation: firstGeneration,
    });

    const duplicate = await resumed.writeBlock(0, Uint8Array.of(8, 8, 8, 8));
    expect(duplicate).toMatchObject({ writtenBlocks: 0, duplicateBlocks: 1 });
    expect(await resumed.readBlock(0)).toEqual(Uint8Array.of(1, 2, 3, 4));
    await resumed.writeBlock(1, Uint8Array.of(5, 6, 7, 8));
    expect((await consumeStream(await resumed.createReadStream())).bytes).toEqual(
      Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
    );
  });

  it("serializes concurrent handles without losing either handle's receipts", async () => {
    const repository = new MemoryBlockStoreRepository();
    const config = { storeId: "shared-handles", totalBytes: 8, blockSize: 4 };
    const first = await repository.open(config);
    const second = await repository.open(config);

    await Promise.all([
      first.writeBlock(0, Uint8Array.of(1, 2, 3, 4)),
      second.writeBlock(1, Uint8Array.of(5, 6, 7, 8)),
    ]);
    await Promise.all([first.close(), second.close()]);

    const resumed = await repository.open(config);
    expect(resumed.progress()).toMatchObject({
      receivedBlocks: 2,
      receivedBytes: 8,
      complete: true,
    });
    expect(await resumed.readBlock(0)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(await resumed.readBlock(1)).toEqual(Uint8Array.of(5, 6, 7, 8));
  });

  it("defensively copies checkpoint bitsets and rejects incompatible reuse", async () => {
    const repository = new MemoryBlockStoreRepository();
    const config = { storeId: "identity", totalBytes: 8, blockSize: 4 };
    const store = await repository.open(config);
    await store.writeBlock(0, Uint8Array.of(1, 2, 3, 4));

    const exposed = store.checkpoint().receivedBlockBits;
    exposed.fill(0xff);
    expect(store.hasBlock(0)).toBe(true);
    expect(store.hasBlock(1)).toBe(false);
    await expect(
      repository.open({ ...config, totalBytes: 12 }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("validates block sizes and rolls back the current uncommitted sub-batch", async () => {
    const store = await openBlockStore(
      { storeId: "validation", totalBytes: 6, blockSize: 4 },
      { backend: "memory" },
    );

    await expect(
      store.writeBlocks([
        { index: 0, bytes: Uint8Array.of(1, 2, 3, 4) },
        { index: 1, bytes: Uint8Array.of(5, 6, 7) },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_BLOCK" });
    expect(store.checkpoint()).toMatchObject({ receivedBlocks: 0, receivedBytes: 0 });
    await expect(store.readBlock(0)).rejects.toMatchObject({ code: "MISSING_BLOCK" });
    await expect(store.readRange(0, 5)).rejects.toMatchObject({ code: "MISSING_BLOCK" });
    await expect(store.readRange(0, 16 * 1024 * 1024 + 1)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
    await expect(store.writeBlock(2, new Uint8Array())).rejects.toBeInstanceOf(BlockStoreError);
  });

  it("commits very long iterables in bounded resumable sub-batches", async () => {
    const blockCount = 4_097;
    const store = await openBlockStore(
      { storeId: "bounded-batches", totalBytes: blockCount, blockSize: 1 },
      { backend: "memory" },
    );

    async function* blocks() {
      for (let index = blockCount - 1; index >= 0; index -= 1) {
        yield { index, bytes: Uint8Array.of(index & 0xff) };
      }
    }

    const result = await store.writeBlocks(blocks());
    expect(result).toMatchObject({ writtenBlocks: blockCount, duplicateBlocks: 0 });
    expect(result.progress).toMatchObject({
      receivedBlocks: blockCount,
      receivedBytes: blockCount,
      complete: true,
    });
    expect(result.progress).not.toHaveProperty("receivedBlockBits");
    expect(Object.getOwnPropertyDescriptor(result, "checkpoint")?.get).toBeTypeOf("function");
    // Initial snapshot is generation 1, followed by 4096 and 1-block commits.
    expect(result.checkpoint.generation).toBe(3);
    expect(await store.readBlock(0)).toEqual(Uint8Array.of(0));
    expect(await store.readBlock(blockCount - 1)).toEqual(
      Uint8Array.of((blockCount - 1) & 0xff),
    );
  });

  it("supports multi-gigabyte sparse layouts without allocating totalBytes", async () => {
    const gibibytes = 5 * 1024 * 1024 * 1024;
    const blockSize = 1024 * 1024;
    const config = {
      storeId: "five-gib-layout",
      totalBytes: gibibytes + 3,
      blockSize,
    };
    const store = await openBlockStore(config, { backend: "memory" });
    expect(store.totalBlocks).toBe(5_121);
    await store.writeBlock(store.totalBlocks - 1, Uint8Array.of(1, 2, 3));
    expect(store.checkpoint()).toMatchObject({ receivedBlocks: 1, receivedBytes: 3 });
    expect(requiredBlockStorageBytes(config)).toBeGreaterThan(config.totalBytes);
  });

  it("reports unavailable browser quota APIs in the Node test environment", async () => {
    const estimate = await estimateBlockStorage(1234);
    expect(estimate).toMatchObject({
      storageApiSupported: false,
      opfsSupported: false,
      requiredBytes: 1234,
    });
    expect(estimate.hasEnoughSpace).toBeUndefined();
    expect(supportsDurableBlockStore()).toBe(false);
    await expect(deleteAllBlockStores()).resolves.toBeUndefined();
  });

  it("accounts only for remaining payload and unmet peak metadata on resume", () => {
    const config = { storeId: "quota-resume", totalBytes: 10_000, blockSize: 700 };
    const full = requiredBlockStorageBytes(config);

    expect(requiredAdditionalBlockStorageBytes(config)).toBe(full);
    expect(requiredAdditionalBlockStorageBytes(config, 4_200, 1_000)).toBe(
      full - 5_200,
    );
    expect(() => requiredAdditionalBlockStorageBytes(config, 10_001)).toThrowError(
      BlockStoreError,
    );
  });

  it("exports and enforces the receipt-bitset block cap", () => {
    expect(
      requiredBlockStorageBytes({
        storeId: "at-cap",
        totalBytes: MAX_BLOCK_STORE_BLOCKS * 700,
        blockSize: 700,
      }),
    ).toBeGreaterThan(MAX_BLOCK_STORE_BLOCKS * 700);
    expect(() =>
      requiredBlockStorageBytes({
        storeId: "over-cap",
        totalBytes: MAX_BLOCK_STORE_BLOCKS * 700 + 1,
        blockSize: 700,
      }),
    ).toThrowError(BlockStoreError);
  });

  it("deletes all stored blocks so the same ID reopens empty", async () => {
    const repository = new MemoryBlockStoreRepository();
    const config = { storeId: "delete-me", totalBytes: 4, blockSize: 4 };
    const store = await repository.open(config);
    await store.writeBlock(0, Uint8Array.of(1, 2, 3, 4));
    await store.delete();
    await expect(store.readBlock(0)).rejects.toMatchObject({ code: "CLOSED" });

    const empty = await repository.open(config);
    expect(empty.checkpoint()).toMatchObject({ receivedBlocks: 0, complete: false });
  });
});

async function consumeStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ bytes: Uint8Array; chunkLengths: number[] }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    totalBytes += result.value.byteLength;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, chunkLengths: chunks.map((chunk) => chunk.byteLength) };
}
