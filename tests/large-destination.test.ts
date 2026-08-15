import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  LARGE_DESTINATION_CHUNK_BYTES,
  LARGE_DESTINATION_MARKER,
  writeLargeTreeToDirectory,
  type LargeDestinationBinding,
} from "../src/lib/large-destination";
import {
  encodeLargeTreeMetadata,
  parseLargeTreeMetadata,
  type LargeTreeManifest,
  type RandomAccessReader,
} from "../src/lib/large-transfer";

interface WriteFaults {
  failFile?: string;
  failOnce?: boolean;
  failed?: boolean;
}

class MemoryFileHandle {
  readonly kind = "file" as const;
  data = new Uint8Array();

  constructor(
    readonly name: string,
    private readonly faults?: WriteFaults,
  ) {}

  async getFile(): Promise<File> {
    const blob = new Blob([new Uint8Array(this.data)]);
    Object.defineProperties(blob, {
      name: { value: this.name },
      lastModified: { value: 1 },
    });
    return blob as File;
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    const staged: Uint8Array[] = [];
    let aborted = false;
    const handle = this;
    return {
      async write(value: BufferSource | Blob | string) {
        if (
          handle.faults?.failFile === handle.name &&
          handle.faults.failOnce &&
          !handle.faults.failed
        ) {
          handle.faults.failed = true;
          throw new Error("injected destination interruption");
        }
        staged.push(await toBytes(value));
      },
      async close() {
        if (aborted) throw new Error("cannot close aborted writer");
        const length = staged.reduce((total, chunk) => total + chunk.length, 0);
        const output = new Uint8Array(length);
        let offset = 0;
        for (const chunk of staged) {
          output.set(chunk, offset);
          offset += chunk.length;
        }
        handle.data = output;
      },
      async abort() {
        aborted = true;
      },
    } as unknown as FileSystemWritableFileStream;
  }
}

class MemoryDirectoryHandle {
  readonly kind = "directory" as const;
  readonly children = new Map<
    string,
    MemoryDirectoryHandle | MemoryFileHandle
  >();

  constructor(
    readonly name: string,
    private readonly faults?: WriteFaults,
  ) {}

  async *entries(): AsyncIterableIterator<
    [string, FileSystemFileHandle | FileSystemDirectoryHandle]
  > {
    for (const [name, handle] of Array.from(this.children).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      yield [name, handle as unknown as FileSystemFileHandle];
    }
  }

  async *values(): AsyncIterableIterator<
    FileSystemFileHandle | FileSystemDirectoryHandle
  > {
    for await (const [, handle] of this.entries()) yield handle;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== "directory") throw domError("TypeMismatchError");
      return existing as unknown as FileSystemDirectoryHandle;
    }
    if (!options?.create) throw domError("NotFoundError");
    const created = new MemoryDirectoryHandle(name, this.faults);
    this.children.set(name, created);
    return created as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== "file") throw domError("TypeMismatchError");
      return existing as unknown as FileSystemFileHandle;
    }
    if (!options?.create) throw domError("NotFoundError");
    const created = new MemoryFileHandle(name, this.faults);
    this.children.set(name, created);
    return created as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw domError("NotFoundError");
  }
}

interface Fixture {
  manifest: LargeTreeManifest;
  reader: RandomAccessReader;
  binding: LargeDestinationBinding;
  maximumRead: () => number;
}

function createFixture(
  files: Array<{ path: string; bytes: Uint8Array }>,
  directories: string[] = [],
  corruptReader = false,
): Fixture {
  const ordered = files.slice().sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const metadata = encodeLargeTreeMetadata({
    rootName: "received",
    directories: directories.slice().sort(),
    files: ordered.map(({ path, bytes }) => ({
      path,
      size: bytes.length,
      lastModified: 1,
      sha256Hex: hex(sha256(bytes)),
    })),
  });
  const manifest = parseLargeTreeMetadata(metadata);
  const total = ordered.reduce((sum, file) => sum + file.bytes.length, 0);
  const stream = new Uint8Array(total);
  let writeOffset = 0;
  for (const file of ordered) {
    stream.set(file.bytes, writeOffset);
    writeOffset += file.bytes.length;
  }
  if (corruptReader && stream.length > 0) stream[stream.length - 1] ^= 0xff;
  let largestRead = 0;
  const reader: RandomAccessReader = {
    size: BigInt(stream.length),
    async read(offset, length) {
      largestRead = Math.max(largestRead, length);
      const start = Number(offset);
      return stream.slice(start, start + length);
    },
  };
  return {
    manifest,
    reader,
    binding: {
      transferId: Uint8Array.from({ length: 16 }, (_, index) => index),
      streamSha256: sha256(stream),
    },
    maximumRead: () => largestRead,
  };
}

describe("large destination reconstruction", () => {
  it("writes files and explicit empty directories, then removes its marker", async () => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture(
      [
        { path: "a.bin", bytes: Uint8Array.of(0, 1, 255) },
        { path: "deep/b.txt", bytes: new TextEncoder().encode("hello") },
        { path: "zero.dat", bytes: new Uint8Array() },
      ],
      ["deep", "empty", "empty/nested"],
    );

    const report = await writeLargeTreeToDirectory(
      fixture.manifest,
      fixture.reader,
      fixture.binding,
      parent as unknown as FileSystemDirectoryHandle,
      { chunkBytes: 2 },
    );

    expect(report.filesWritten).toBe(3);
    expect(report.totalBytes).toBe(8n);
    const root = childDirectory(parent, "received");
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(false);
    expect(childDirectory(childDirectory(root, "empty"), "nested").children.size).toBe(0);
    expect(childFile(root, "a.bin").data).toEqual(Uint8Array.of(0, 1, 255));
    expect(childFile(childDirectory(root, "deep"), "b.txt").data).toEqual(
      new TextEncoder().encode("hello"),
    );
  });

  it("keeps a bound recovery marker and refuses to commit a source hash mismatch", async () => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture(
      [{ path: "payload.bin", bytes: Uint8Array.of(1, 2, 3, 4) }],
      [],
      true,
    );

    await expect(
      writeLargeTreeToDirectory(
        fixture.manifest,
        fixture.reader,
        fixture.binding,
        parent as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/SHA-256 mismatch/i);

    const root = childDirectory(parent, "received");
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(true);
    expect(childFile(root, "payload.bin").data).toHaveLength(0);
  });

  it("resumes after interruption and reuses a journaled completed file", async () => {
    const faults: WriteFaults = {
      failFile: "second.bin",
      failOnce: true,
    };
    const parent = new MemoryDirectoryHandle("parent", faults);
    const fixture = createFixture([
      { path: "first.bin", bytes: Uint8Array.of(1, 2, 3) },
      { path: "second.bin", bytes: Uint8Array.of(4, 5, 6) },
    ]);

    await expect(
      writeLargeTreeToDirectory(
        fixture.manifest,
        fixture.reader,
        fixture.binding,
        parent as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/injected destination interruption/i);

    const root = childDirectory(parent, "received");
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(true);
    const result = await writeLargeTreeToDirectory(
      fixture.manifest,
      fixture.reader,
      fixture.binding,
      parent as unknown as FileSystemDirectoryHandle,
    );

    expect(result.resumed).toBe(true);
    expect(result.filesReused).toBe(1);
    expect(result.filesWritten).toBe(1);
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(false);
    expect(childFile(root, "second.bin").data).toEqual(Uint8Array.of(4, 5, 6));
  });

  it("refuses an unrelated non-empty destination without claiming or changing it", async () => {
    const parent = new MemoryDirectoryHandle("parent");
    const root = (await parent.getDirectoryHandle("received", {
      create: true,
    })) as unknown as MemoryDirectoryHandle;
    const unrelated = (await root.getFileHandle("private.txt", {
      create: true,
    })) as unknown as MemoryFileHandle;
    unrelated.data = new TextEncoder().encode("keep me");
    const fixture = createFixture([
      { path: "expected.bin", bytes: Uint8Array.of(9, 8, 7) },
    ]);

    await expect(
      writeLargeTreeToDirectory(
        fixture.manifest,
        fixture.reader,
        fixture.binding,
        parent as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/non-empty.*no files were changed/i);

    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(false);
    expect(childFile(root, "private.txt").data).toEqual(
      new TextEncoder().encode("keep me"),
    );
  });

  it("never asks the received store for more than four MiB", async () => {
    const parent = new MemoryDirectoryHandle("parent");
    const bytes = new Uint8Array(LARGE_DESTINATION_CHUNK_BYTES * 2 + 17);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index & 0xff;
    const fixture = createFixture([{ path: "large.bin", bytes }]);

    await writeLargeTreeToDirectory(
      fixture.manifest,
      fixture.reader,
      fixture.binding,
      parent as unknown as FileSystemDirectoryHandle,
    );

    expect(fixture.maximumRead()).toBe(LARGE_DESTINATION_CHUNK_BYTES);
    expect(fixture.maximumRead()).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("serializes different transfers through one destination lock", async () => {
    const requestedLocks: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: async <T>(
          name: string,
          _options: LockOptions,
          operation: () => Promise<T>,
        ): Promise<T> => {
          requestedLocks.push(name);
          return operation();
        },
      },
    });

    try {
      const first = createFixture([{ path: "first.bin", bytes: Uint8Array.of(1) }]);
      const second = createFixture([{ path: "second.bin", bytes: Uint8Array.of(2) }]);
      second.binding.transferId = Uint8Array.from(
        { length: 16 },
        (_, index) => 0xff - index,
      );

      await writeLargeTreeToDirectory(
        first.manifest,
        first.reader,
        first.binding,
        new MemoryDirectoryHandle("first-parent") as unknown as FileSystemDirectoryHandle,
      );
      await writeLargeTreeToDirectory(
        second.manifest,
        second.reader,
        second.binding,
        new MemoryDirectoryHandle("second-parent") as unknown as FileSystemDirectoryHandle,
      );

      expect(requestedLocks).toHaveLength(2);
      expect(new Set(requestedLocks).size).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

async function toBytes(value: BufferSource | Blob | string): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );
}

function childDirectory(
  parent: MemoryDirectoryHandle,
  name: string,
): MemoryDirectoryHandle {
  const child = parent.children.get(name);
  if (!child || child.kind !== "directory") throw new Error(`Missing directory ${name}`);
  return child;
}

function childFile(parent: MemoryDirectoryHandle, name: string): MemoryFileHandle {
  const child = parent.children.get(name);
  if (!child || child.kind !== "file") throw new Error(`Missing file ${name}`);
  return child;
}

function domError(name: string): DOMException {
  return new DOMException(name, name);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
