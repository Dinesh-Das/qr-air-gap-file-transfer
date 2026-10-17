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
  it.each([1, 2, 3, 4].flatMap(receipt => ["before close", "after close"].map(boundary => ({ receipt, boundary }))))(
    "recovers exact journal receipts when commit $receipt fails $boundary after out-of-order payload closes",
    async ({ receipt, boundary }) => {
      const parent = new MemoryDirectoryHandle("parent");
      const fixture = createFixture(Array.from({ length: 4 }, (_, index) => ({
        path: `file-${index}.bin`, bytes: new Uint8Array(1024).fill(index),
      })));
      const destination = parent as unknown as FileSystemDirectoryHandle;
      const reason = new Error("journal close interrupted");
      const closed: string[] = [];
      const original = MemoryFileHandle.prototype.createWritable;
      const failedMask = (1 << receipt) - 1;
      const spy = vi.spyOn(MemoryFileHandle.prototype, "createWritable").mockImplementation(async function(this: MemoryFileHandle) {
        const writer = await original.call(this);
        const name = this.name;
        let markerMask = -1;
        return {
          ...writer,
          async write(value: BufferSource | Blob | string) {
            if (name === LARGE_DESTINATION_MARKER) {
              const marker = JSON.parse(new TextDecoder().decode(await toBytes(value)));
              markerMask = atob(marker.completed).charCodeAt(0);
            }
            await writer.write(value);
          },
          async close() {
            if (name === "file-0.bin") await vi.waitFor(() => expect(closed).toContain("file-3.bin"), { timeout: 200 });
            const fail = name === LARGE_DESTINATION_MARKER && markerMask === failedMask;
            if (fail && boundary === "before close") throw reason;
            await writer.close();
            if (name !== LARGE_DESTINATION_MARKER) closed.push(name);
            if (fail) throw reason;
          },
        } as unknown as FileSystemWritableFileStream;
      });
      try {
        await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination)).rejects.toBe(reason);
      } finally { spy.mockRestore(); }
      expect(closed).toHaveLength(4);
      expect(closed.indexOf("file-3.bin")).toBeLessThan(closed.indexOf("file-0.bin"));
      const root = childDirectory(parent, "received");
      const marker = JSON.parse(new TextDecoder().decode(childFile(root, LARGE_DESTINATION_MARKER).data));
      const committed = boundary === "before close" ? receipt - 1 : receipt;
      expect(atob(marker.completed).charCodeAt(0)).toBe((1 << committed) - 1);
      for (let index = 0; index < 4; index++) expect(childFile(root, `file-${index}.bin`).data).toEqual(new Uint8Array(1024).fill(index));
      const retried = await writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination);
      expect(retried).toMatchObject({ filesReused: committed, filesWritten: 4 - committed, resumed: true });
      expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(false);
      for (let index = 0; index < 4; index++) expect(childFile(root, `file-${index}.bin`).data).toEqual(new Uint8Array(1024).fill(index));
    },
  );

  it.each(["file", "directory"])("rechecks a prefetched saved path after its %s is replaced during repair", async (replacement) => {
    const parent = new MemoryDirectoryHandle("parent", { failFile: "file-4.bin", failOnce: true });
    const fixture = createFixture(Array.from({ length: 5 }, (_, index) => ({
      path: `nested/file-${index}.bin`, bytes: Uint8Array.of(index),
    })));
    const destination = parent as unknown as FileSystemDirectoryHandle;
    await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination)).rejects.toThrow("injected destination interruption");
    const root = childDirectory(parent, "received");
    const nested = childDirectory(root, "nested");
    childFile(nested, "file-0.bin").data = Uint8Array.of(255);
    const oldValidHandle = childFile(nested, "file-2.bin");
    let replaced = false;
    await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination, {
      onProgress: progress => {
        if (replaced || progress.phase !== "write" || progress.filesComplete !== 1) return;
        replaced = true;
        const changed = new MemoryFileHandle("file-2.bin");
        changed.data = Uint8Array.of(254);
        if (replacement === "file") nested.children.set(changed.name, changed);
        else {
          const changedDirectory = new MemoryDirectoryHandle("nested");
          for (const [name, handle] of nested.children) changedDirectory.children.set(name, handle);
          changedDirectory.children.set(changed.name, changed);
          root.children.set("nested", changedDirectory);
        }
      },
    })).rejects.toThrow(/Destination SHA-256 or size mismatch for nested\/file-2.bin/);
    expect(replaced).toBe(true);
    expect(oldValidHandle.data).toEqual(Uint8Array.of(2));
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(true);
    await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination))
      .resolves.toMatchObject({ filesReused: 4, filesWritten: 1, resumed: true });
    for (let index = 0; index < 5; index++) expect(childFile(childDirectory(root, "nested"), `file-${index}.bin`).data).toEqual(Uint8Array.of(index));
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(false);
  });

  it.each(["success", "read failure", "cancellation"])("overlaps independent small-file writes and drains started writes on %s", async (failure) => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture(Array.from({ length: 5 }, (_, index) => ({
      path: `file-${index}.bin`, bytes: new Uint8Array(1024).fill(index),
    })));
    const controller = new AbortController();
    const reason = new Error("payload writing interrupted");
    let secondRead = false;
    let settled = false;
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reader: RandomAccessReader = {
      size: fixture.reader.size,
      async read(offset, length) {
        active++;
        peak = Math.max(peak, active);
        try {
          if (offset === 0n) await gate;
          if (offset === 1024n) {
            secondRead = true;
            if (failure === "cancellation") controller.abort(reason);
            if (failure === "read failure") throw reason;
          }
          return await fixture.reader.read(offset, length);
        } finally { active--; }
      },
    };
    const saving = writeLargeTreeToDirectory(fixture.manifest, reader, fixture.binding,
      parent as unknown as FileSystemDirectoryHandle, { signal: controller.signal });
    const outcome = saving.then(report => { settled = true; return report; }, (error: unknown) => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(secondRead).toBe(true), { timeout: 200 });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(peak).toBeLessThanOrEqual(4);
    } finally { release(); await outcome; }
    if (failure === "success") {
      expect(await outcome).toMatchObject({ filesWritten: 5 });
      const root = childDirectory(parent, "received");
      expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(false);
      for (let index = 0; index < 5; index++) expect(childFile(root, `file-${index}.bin`).data).toEqual(new Uint8Array(1024).fill(index));
    } else {
      expect(await outcome).toBe(reason);
      const root = childDirectory(parent, "received");
      expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(true);
      const marker = JSON.parse(new TextDecoder().decode(childFile(root, LARGE_DESTINATION_MARKER).data));
      // A closed payload is reusable only after its own journal commit. No
      // started write can keep mutating files after the save returns.
      expect(marker.fileCount).toBe(5);
      expect(atob(marker.completed).charCodeAt(0)).toBe(failure === "read failure" ? 1 : 0);
      await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding,
        parent as unknown as FileSystemDirectoryHandle)).resolves.toMatchObject({ resumed: true });
    }
  });

  it("writes larger files alone between bounded small-file groups", async () => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture(Array.from({ length: 9 }, (_, index) => ({
      path: `file-${index}.bin`, bytes: new Uint8Array(index === 4 ? 65537 : 65536).fill(index),
    })));
    const largeOffset = fixture.manifest.files[4].offset;
    let largeActive = false;
    let active = 0;
    let activeBytes = 0;
    let peakBytes = 0;
    let largeOverlap = false;
    const reader: RandomAccessReader = {
      size: fixture.reader.size,
      async read(offset, length) {
        const large = offset === largeOffset;
        active++;
        activeBytes += length;
        if (large) largeActive = true;
        if (largeActive && active > 1) largeOverlap = true;
        peakBytes = Math.max(peakBytes, activeBytes);
        try { await new Promise<void>((resolve) => setTimeout(resolve, 0)); return await fixture.reader.read(offset, length); }
        finally { active--; activeBytes -= length; if (large) largeActive = false; }
      },
    };
    await writeLargeTreeToDirectory(fixture.manifest, reader, fixture.binding, parent as unknown as FileSystemDirectoryHandle);
    expect(largeOverlap).toBe(false);
    expect(peakBytes).toBeLessThanOrEqual(256 * 1024);
  });

  it("checks independent small destination files while another read is stalled, with bounded concurrency", async () => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture(Array.from({ length: 9 }, (_, index) => ({
      path: `file-${index}.bin`, bytes: new Uint8Array(1024).fill(index),
    })));
    let verifying = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Set<string>();
    let active = 0;
    let peak = 0;
    const original = MemoryFileHandle.prototype.getFile;
    const spy = vi.spyOn(MemoryFileHandle.prototype, "getFile").mockImplementation(async function(this: MemoryFileHandle) {
      if (!verifying) return original.call(this);
      started.add(this.name);
      active++;
      peak = Math.max(peak, active);
      try { await gate; return await original.call(this); }
      finally { active--; }
    });
    const saving = writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding,
      parent as unknown as FileSystemDirectoryHandle, {
        onProgress: (progress) => { if (progress.phase === "verify") verifying = true; },
      });
    try {
      await vi.waitFor(() => expect(started.size).toBeGreaterThan(1), { timeout: 200 });
      expect(peak).toBeLessThanOrEqual(4);
    } finally {
      release();
      await saving;
      spy.mockRestore();
    }
    expect(started.size).toBe(9);
    expect(childDirectory(parent, "received").children.has(LARGE_DESTINATION_MARKER)).toBe(false);
  });

  it.each(["read failure", "cancellation"])("drains pending verification reads before returning after %s", async (failure) => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture(Array.from({ length: 5 }, (_, index) => ({
      path: `file-${index}.bin`, bytes: Uint8Array.of(index),
    })));
    const controller = new AbortController();
    const reason = new Error("verification interrupted");
    let verifying = false;
    let secondRead = false;
    let settled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = MemoryFileHandle.prototype.getFile;
    const spy = vi.spyOn(MemoryFileHandle.prototype, "getFile").mockImplementation(async function(this: MemoryFileHandle) {
      if (verifying && this.name === "file-0.bin") await gate;
      if (verifying && this.name === "file-1.bin") {
        secondRead = true;
        if (failure === "cancellation") controller.abort(reason);
        else throw reason;
      }
      return original.call(this);
    });
    const saving = writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding,
      parent as unknown as FileSystemDirectoryHandle, {
        signal: controller.signal,
        onProgress: (progress) => { if (progress.phase === "verify") verifying = true; },
      });
    const outcome = saving.then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(secondRead).toBe(true), { timeout: 200 });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
    } finally {
      release();
      await outcome;
      spy.mockRestore();
    }
    expect(await outcome).toBe(reason);
    const root = childDirectory(parent, "received");
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(true);
    expect(childFile(root, "file-0.bin").data).toEqual(Uint8Array.of(0));
  });

  it("checks larger destination files alone between bounded small-file groups", async () => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture(Array.from({ length: 9 }, (_, index) => ({
      path: `file-${index}.bin`, bytes: new Uint8Array(index === 4 ? 65537 : 65536).fill(index),
    })));
    let verifying = false;
    const active = new Set<string>();
    let peakBytes = 0;
    let largeOverlap = false;
    const original = MemoryFileHandle.prototype.getFile;
    const spy = vi.spyOn(MemoryFileHandle.prototype, "getFile").mockImplementation(async function(this: MemoryFileHandle) {
      if (!verifying) return original.call(this);
      active.add(this.name);
      if (active.has("file-4.bin") && active.size > 1) largeOverlap = true;
      peakBytes = Math.max(peakBytes, Array.from(active).reduce((sum, name) => sum + (name === "file-4.bin" ? 65537 : 65536), 0));
      try { await new Promise<void>((resolve) => setTimeout(resolve, 0)); return await original.call(this); }
      finally { active.delete(this.name); }
    });
    try {
      await writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding,
        parent as unknown as FileSystemDirectoryHandle, {
          onProgress: (progress) => { if (progress.phase === "verify") verifying = true; },
        });
    } finally { spy.mockRestore(); }
    expect(largeOverlap).toBe(false);
    expect(peakBytes).toBeLessThanOrEqual(256 * 1024);
  });

  it.each(["success", "read failure", "cancellation"])("checks saved small files concurrently and drains reads on %s", async (failure) => {
    const parent = new MemoryDirectoryHandle("parent", { failFile: "file-4.bin", failOnce: true });
    const fixture = createFixture(Array.from({ length: 5 }, (_, index) => ({
      path: `file-${index}.bin`, bytes: Uint8Array.of(index),
    })));
    const destination = parent as unknown as FileSystemDirectoryHandle;
    await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination))
      .rejects.toThrow("injected destination interruption");
    const controller = new AbortController();
    const reason = new Error("resume checking interrupted");
    let checking = false;
    let secondRead = false;
    let settled = false;
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = MemoryFileHandle.prototype.getFile;
    const spy = vi.spyOn(MemoryFileHandle.prototype, "getFile").mockImplementation(async function(this: MemoryFileHandle) {
      if (!checking || !this.name.startsWith("file-")) return original.call(this);
      active++;
      peak = Math.max(peak, active);
      try {
        if (this.name === "file-0.bin") await gate;
        if (this.name === "file-1.bin") {
          secondRead = true;
          if (failure === "cancellation") controller.abort(reason);
          if (failure === "read failure") throw reason;
        }
        return await original.call(this);
      } finally { active--; }
    });
    const saving = writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination, {
      signal: controller.signal,
      onProgress: (progress) => { checking = progress.phase === "resume-check"; },
    });
    const outcome = saving.then(report => { settled = true; return report; }, (error: unknown) => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(secondRead).toBe(true), { timeout: 200 });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(peak).toBeLessThanOrEqual(4);
    } finally { release(); await outcome; spy.mockRestore(); }
    if (failure === "success") expect(await outcome).toMatchObject({ filesReused: 4, filesWritten: 1 });
    else expect(await outcome).toBe(reason);
    const root = childDirectory(parent, "received");
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(failure !== "success");
    expect(childFile(root, "file-0.bin").data).toEqual(Uint8Array.of(0));
  });

  it("stops enumerating a completed destination when cancellation arrives during its scan", async () => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture([], ["one", "two"]);
    const destination = parent as unknown as FileSystemDirectoryHandle;
    await writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination);
    const controller = new AbortController(); const reason = new Error("Cancelled scan");
    const original = MemoryDirectoryHandle.prototype.entries;
    const enumerated: string[] = [];
    let rootScans = 0;
    const spy = vi.spyOn(MemoryDirectoryHandle.prototype, "entries").mockImplementation(async function*(this: MemoryDirectoryHandle) {
      const auditing = this.name === "received" && ++rootScans === 2; // After the initial emptiness check.
      for await (const entry of original.call(this)) {
        if (auditing) { enumerated.push(entry[0]); controller.abort(reason); }
        yield entry;
      }
    });
    try {
      await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination, { signal: controller.signal })).rejects.toBe(reason);
      expect(enumerated).toEqual(["one"]);
    } finally { spy.mockRestore(); }
    const retried = await writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination);
    expect(retried.directoriesVerified).toBe(2);
    expect(retried.filesWritten).toBe(0);
  });

  it("stops creating remaining directories after cancellation and resumes the partial tree", async () => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture([], ["one", "two"]);
    const controller = new AbortController();
    const reason = new Error("Cancelled folder creation");
    const original = MemoryDirectoryHandle.prototype.getDirectoryHandle;
    const spy = vi.spyOn(MemoryDirectoryHandle.prototype, "getDirectoryHandle").mockImplementation(async function(this: MemoryDirectoryHandle, name, options) {
      const result = await original.call(this, name, options);
      if (name === "one" && options?.create) controller.abort(reason);
      return result;
    });
    try {
      await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding,
        parent as unknown as FileSystemDirectoryHandle, { signal: controller.signal })).rejects.toBe(reason);
      const root = childDirectory(parent, "received");
      expect(root.children.has("one")).toBe(true);
      expect(root.children.has("two")).toBe(false);
      expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(true);
    } finally { spy.mockRestore(); }
    const report = await writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, parent as unknown as FileSystemDirectoryHandle);
    expect(report.directoriesVerified).toBe(2);
    expect(childDirectory(parent, "received").children.has(LARGE_DESTINATION_MARKER)).toBe(false);
  });

  it("does not create a file after cancellation during its parent lookup", async () => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture([{ path: "nested/a.bin", bytes: Uint8Array.of(1) }], ["nested"]);
    const controller = new AbortController();
    const reason = new Error("Cancelled parent lookup");
    const original = MemoryDirectoryHandle.prototype.getDirectoryHandle;
    const spy = vi.spyOn(MemoryDirectoryHandle.prototype, "getDirectoryHandle").mockImplementation(async function(this: MemoryDirectoryHandle, name, options) {
      const result = await original.call(this, name, options);
      if (name === "nested" && !options?.create) controller.abort(reason);
      return result;
    });
    try {
      await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding,
        parent as unknown as FileSystemDirectoryHandle, { signal: controller.signal })).rejects.toBe(reason);
      expect(childDirectory(childDirectory(parent, "received"), "nested").children.has("a.bin")).toBe(false);
    } finally { spy.mockRestore(); }
    const retry = await writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, parent as unknown as FileSystemDirectoryHandle);
    expect(retry.filesWritten).toBe(1);
    expect(childDirectory(parent, "received").children.has(LARGE_DESTINATION_MARKER)).toBe(false);
  });

  it.each(["file", "directory"])("reopens destination paths during final verification after %s replacement", async (replacement) => {
    const parent = new MemoryDirectoryHandle("parent");
    const expected = Uint8Array.of(1, 2, 3);
    const fixture = createFixture([{ path: "nested/a.bin", bytes: expected }], ["nested"]);
    const destination = parent as unknown as FileSystemDirectoryHandle;
    let originalFile: MemoryFileHandle | undefined;
    await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination, {
      onProgress: (progress) => {
        if (progress.phase !== "write" || progress.filesComplete !== 1) return;
        const root = childDirectory(parent, "received");
        const nested = childDirectory(root, "nested");
        originalFile = childFile(nested, "a.bin");
        const changed = new MemoryFileHandle("a.bin");
        changed.data = Uint8Array.of(9, 9, 9);
        if (replacement === "file") nested.children.set("a.bin", changed);
        else {
          const changedDirectory = new MemoryDirectoryHandle("nested");
          changedDirectory.children.set("a.bin", changed);
          root.children.set("nested", changedDirectory);
        }
      },
    })).rejects.toThrow("Destination SHA-256 or size mismatch for nested/a.bin.");
    // The old handle still reads valid bytes. Verification must resolve the path again.
    expect(originalFile?.data).toEqual(expected);
    const root = childDirectory(parent, "received");
    expect(childFile(childDirectory(root, "nested"), "a.bin").data).toEqual(Uint8Array.of(9, 9, 9));
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(true);
    const retry = await writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination);
    expect(retry.filesWritten).toBe(1);
    expect(retry.filesReused).toBe(0);
    expect(childFile(childDirectory(root, "nested"), "a.bin").data).toEqual(expected);
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(false);
  });

  it.each([false, true])("honors cancellation at final verification (existing completed tree: %s)", async (existing) => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture([{ path: "a.bin", bytes: Uint8Array.of(1, 2, 3) }], []);
    const destination = parent as unknown as FileSystemDirectoryHandle;
    if (existing) await writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination);
    const controller = new AbortController();
    const reason = new Error("Cancelled final verification");
    await expect(writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination, {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === "verify" && progress.filesComplete === 1) controller.abort(reason);
      },
    })).rejects.toBe(reason);
    const root = childDirectory(parent, "received");
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(!existing);
    expect(childFile(root, "a.bin").data).toEqual(Uint8Array.of(1, 2, 3));
    const retried = await writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, destination);
    expect(retried.filesWritten).toBe(0);
    expect(retried.filesReused).toBe(1);
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(false);
  });

  it.each(["read", "last-progress"])("aborts the uncommitted file when cancelled at %s and safely retries", async (boundary) => {
    const parent = new MemoryDirectoryHandle("parent");
    const fixture = createFixture([{ path: "a.bin", bytes: Uint8Array.of(1, 2, 3, 4) }], []);
    const controller = new AbortController();
    const reason = new Error("User cancelled save");
    const reader: RandomAccessReader = {
      size: fixture.reader.size,
      async read(offset, length) {
        const bytes = await fixture.reader.read(offset, length);
        if (boundary === "read") controller.abort(reason);
        return bytes;
      },
    };
    await expect(writeLargeTreeToDirectory(fixture.manifest, reader, fixture.binding,
      parent as unknown as FileSystemDirectoryHandle, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (boundary === "last-progress" && progress.phase === "write" && progress.bytesComplete === 4n) controller.abort(reason);
        },
      })).rejects.toBe(reason);
    const root = childDirectory(parent, "received");
    expect(childFile(root, "a.bin").data).toHaveLength(0);
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(true);
    const report = await writeLargeTreeToDirectory(fixture.manifest, fixture.reader, fixture.binding, parent as unknown as FileSystemDirectoryHandle);
    expect(report.filesWritten).toBe(1);
    expect(report.filesReused).toBe(0);
    expect(childFile(root, "a.bin").data).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(root.children.has(LARGE_DESTINATION_MARKER)).toBe(false);
  });

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
