import { Unzip, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_DIRECT_WRITE_ENTRIES,
  collectDirectoryHandle,
  collectInputFiles,
  createArchive,
  extractArchive,
  sha256Hex,
  validateArchivePath,
  verifyEntryCollections,
  writeAndVerifyArchive,
  type SelectedEntry,
} from "../src/lib/archive";

const encoder = new TextEncoder();

describe("archive byte and tree fidelity", () => {
  it("round-trips Unicode, binary data, deep nesting, empty files and directories, duplicate contents, and 100+ files", () => {
    const duplicate = encoder.encode("same bytes, distinct paths");
    const entries: SelectedEntry[] = [
      {
        path: "Unicode/नमस्ते 世界.txt",
        bytes: encoder.encode("Grüße 🌍\nதமிழ்\n日本語"),
      },
      {
        path: "Binary/all-byte-values.bin",
        bytes: Uint8Array.from({ length: 256 }, (_, index) => index),
      },
      {
        path: "one/two/three/four/five/deep file.dat",
        bytes: Uint8Array.of(0, 255, 17, 128, 42),
      },
      { path: "empty.txt", bytes: new Uint8Array() },
      { path: "duplicate A.txt", bytes: duplicate },
      { path: "duplicate B.txt", bytes: duplicate },
      {
        path: "Empty Folder/子目录",
        bytes: new Uint8Array(),
        directory: true,
      },
      ...Array.from({ length: 125 }, (_, index): SelectedEntry => ({
        path: `many/file ${String(index).padStart(3, "0")}.txt`,
        bytes: encoder.encode(`small file ${index}`),
      })),
    ];

    const archive = createArchive(entries);
    const extracted = extractArchive(archive);
    const sourceFiles = fileMap(entries);
    const extractedFiles = fileMap(extracted);

    expect([...extractedFiles.keys()].sort()).toEqual(
      [...sourceFiles.keys()].sort(),
    );
    for (const [path, bytes] of sourceFiles) {
      expect(extractedFiles.get(path), path).toEqual(bytes);
    }
    expect(
      extracted.some(
        (entry) => entry.directory && entry.path === "Empty Folder/子目录",
      ),
    ).toBe(true);
    expect(extractedFiles.get("duplicate A.txt")).toEqual(
      extractedFiles.get("duplicate B.txt"),
    );
  });

  it("produces a verification failure for any path-set or byte difference", async () => {
    const expected: SelectedEntry[] = [
      { path: "a.bin", bytes: Uint8Array.of(1, 2, 3) },
      { path: "folder/b.txt", bytes: encoder.encode("correct") },
    ];
    const actual: SelectedEntry[] = [
      { path: "a.bin", bytes: Uint8Array.of(1, 2, 4) },
      { path: "extra.txt", bytes: encoder.encode("extra") },
    ];

    const report = await verifyEntryCollections(expected, actual, "received");

    expect(report.ok).toBe(false);
    expect(report.missingPaths).toEqual(["folder/b.txt"]);
    expect(report.extraPaths).toEqual(["extra.txt"]);
    expect(report.hashMismatches.map(({ path }) => path)).toEqual(["a.bin"]);
  });

  it("uses SHA-256 over exact bytes", async () => {
    expect(await sha256Hex(encoder.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("safe paths", () => {
  it("accepts safe relative Unicode paths without normalizing their text", () => {
    expect(validateArchivePath("Folder/ßeta/नमस्ते.txt")).toBe(
      "Folder/ßeta/नमस्ते.txt",
    );
    expect(validateArchivePath("empty/directory/")).toBe("empty/directory");
  });

  it.each([
    "",
    "/absolute.txt",
    "\\\\server\\share",
    "C:/Windows/file",
    "C:drive-relative",
    "../escape.txt",
    "safe/../../escape.txt",
    "./file.txt",
    "folder/./file.txt",
    "folder//file.txt",
    "folder\\file.txt",
    "nul\0byte.txt",
    "/",
  ])("rejects unsafe archive path %j", (path) => {
    expect(() => validateArchivePath(path)).toThrow();
  });

  it("rejects unsafe paths before creating or extracting an archive", () => {
    expect(() =>
      createArchive([
        { path: "../outside.txt", bytes: encoder.encode("no") },
      ]),
    ).toThrow(/unsafe|relative/i);

    const hostile = zipSync({
      "../outside.txt": encoder.encode("no"),
    });
    expect(() => extractArchive(hostile)).toThrow(/unsafe|relative/i);
  });

  it("rejects duplicate and file-as-directory conflicts", () => {
    expect(() =>
      createArchive([
        { path: "same.txt", bytes: Uint8Array.of(1) },
        { path: "same.txt", bytes: Uint8Array.of(2) },
      ]),
    ).toThrow(/duplicate|conflicting/i);

    expect(() =>
      createArchive([
        { path: "parent", bytes: Uint8Array.of(1) },
        { path: "parent/child", bytes: Uint8Array.of(2) },
      ]),
    ).toThrow(/parent directory/i);
  });

  it("rejects names that cannot round-trip or may alias on common destinations", () => {
    expect(() =>
      createArchive([
        { path: "bad\uD800name.txt", bytes: Uint8Array.of(1) },
      ]),
    ).toThrow(/Unicode/i);
    expect(() =>
      createArchive([
        { path: "Folder/Result.txt", bytes: Uint8Array.of(1) },
        { path: "folder/result.txt", bytes: Uint8Array.of(2) },
      ]),
    ).toThrow(/collide/i);
    expect(() =>
      createArchive([{ path: "CON.txt", bytes: Uint8Array.of(1) }]),
    ).toThrow(/representable/i);
  });

  it("rejects implicit parent expansion at the logical entry limit", () => {
    const entries = Array.from({ length: 400 }, (_, fileIndex) => ({
      path: `${Array.from(
        { length: 63 },
        (_, depth) => `f${fileIndex}d${depth}`,
      ).join("/")}/payload.bin`,
      bytes: new Uint8Array(),
    }));

    expect(() => createArchive(entries)).toThrow(/entry safety limit/i);
  });
});

describe("bounded ZIP extraction", () => {
  it("rejects a forged high-ratio entry between bounded inflater pushes", () => {
    const expanded = new Uint8Array(4 * 1024 * 1024);
    const forged = Uint8Array.from(
      zipSync({ "compression-bomb.bin": expanded }, { level: 9 }),
    );
    const view = new DataView(
      forged.buffer,
      forged.byteOffset,
      forged.byteLength,
    );
    const localOffset = findZipSignature(forged, 0x04034b50);
    const centralOffset = findZipSignature(forged, 0x02014b50);
    expect(view.getUint32(centralOffset + 20, true)).toBeGreaterThan(2_048);

    // Lie consistently in both headers so metadata preflight sees one byte.
    // The bounded stream must stop after its first oversized output callback,
    // without ever handing the complete compressed archive to fflate at once.
    view.setUint32(localOffset + 22, 1, true);
    view.setUint32(centralOffset + 24, 1, true);

    const pushSpy = vi.spyOn(Unzip.prototype, "push");
    try {
      expect(() => extractArchive(forged)).toThrow(
        /expanded beyond its declared size/i,
      );
      const pushedLengths = pushSpy.mock.calls.map(([chunk]) => chunk.length);
      expect(pushedLengths.length).toBeGreaterThan(0);
      expect(Math.max(...pushedLengths)).toBeLessThanOrEqual(1_024);
      expect(pushedLengths).not.toContain(forged.length);
      expect(
        pushedLengths.reduce((total, length) => total + length, 0),
      ).toBeLessThan(forged.length);
    } finally {
      pushSpy.mockRestore();
    }
  });

  it("rejects local and central size disagreement before inflation", () => {
    const forged = Uint8Array.from(
      zipSync({ "payload.bin": new Uint8Array(4_096) }, { level: 9 }),
    );
    const centralOffset = findZipSignature(forged, 0x02014b50);
    const view = new DataView(
      forged.buffer,
      forged.byteOffset,
      forged.byteLength,
    );
    view.setUint32(centralOffset + 24, 1, true);

    expect(() => extractArchive(forged)).toThrow(
      /local and central metadata disagree/i,
    );
  });
});

describe("browser collection and destination writing", () => {
  it("bounds direct-write journal work for very large file sets", async () => {
    const destination = new MemoryDirectory("destination");
    const entries = Array.from(
      { length: MAX_DIRECT_WRITE_ENTRIES + 1 },
      (_, index): SelectedEntry => ({
        path: `file-${index}.txt`,
        bytes: new Uint8Array(),
      }),
    );

    await expect(
      writeAndVerifyArchive(
        entries,
        "received",
        destination as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/direct destination writing/i);
  });

  it("collects FileList picker paths as unmodified raw bytes", async () => {
    const files = [
      fakeInputFile(
        "résumé.txt",
        "Picked Root/docs/résumé.txt",
        Uint8Array.of(0, 1, 2, 255),
      ),
      fakeInputFile(
        "zero.bin",
        "Picked Root/deep/zero.bin",
        new Uint8Array(),
      ),
    ];

    const collected = await collectInputFiles(files as unknown as FileList);

    expect(collected.map(({ path }) => path)).toEqual([
      "deep/zero.bin",
      "docs/résumé.txt",
    ]);
    expect(collected[0].bytes).toHaveLength(0);
    expect(collected[1].bytes).toEqual(Uint8Array.of(0, 1, 2, 255));
  });

  it("rejects a declared oversized FileList before reading file bytes", async () => {
    let bytesRead = false;
    const file = {
      name: "large.bin",
      webkitRelativePath: "root/large.bin",
      size: 10,
      arrayBuffer: async () => {
        bytesRead = true;
        return new Uint8Array(10).buffer;
      },
    } as File;

    await expect(
      collectInputFiles([file] as unknown as FileList, 5),
    ).rejects.toThrow(/safety limit/i);
    expect(bytesRead).toBe(false);
  });

  it("collects directory handles including an empty directory", async () => {
    const root = new MemoryDirectory("source");
    const deep = await root.getDirectoryHandle("深い", { create: true });
    await deep.getDirectoryHandle("empty", { create: true });
    const file = await deep.getFileHandle("raw.bin", { create: true });
    await writeMemoryFile(file, Uint8Array.of(255, 0, 128, 64));

    const collected = await collectDirectoryHandle(
      root as unknown as FileSystemDirectoryHandle,
    );

    expect(
      collected.some(
        ({ path, directory }) => path === "深い/empty" && directory,
      ),
    ).toBe(true);
    expect(
      collected.find(({ path }) => path === "深い/raw.bin")?.bytes,
    ).toEqual(Uint8Array.of(255, 0, 128, 64));
  });

  it("writes into an empty root, then re-reads and verifies every path and hash", async () => {
    const destination = new MemoryDirectory("destination");
    const extracted = extractArchive(
      createArchive([
        { path: "a/b/c/d/e.bin", bytes: Uint8Array.of(7, 0, 255) },
        { path: "zero.txt", bytes: new Uint8Array() },
        {
          path: "empty/subfolder",
          bytes: new Uint8Array(),
          directory: true,
        },
      ]),
    );

    const report = await writeAndVerifyArchive(
      extracted,
      "received",
      destination as unknown as FileSystemDirectoryHandle,
    );

    expect(report.ok).toBe(true);
    expect(report.expectedPaths).toEqual(["a/b/c/d/e.bin", "zero.txt"]);
    expect(report.actualPaths).toEqual(report.expectedPaths);
    expect(report.hashes.every(({ matches }) => matches)).toBe(true);
    expect(report.actualDirectoryPaths).toContain("empty/subfolder");

    // A retry after the final marker was removed is read-only and succeeds only
    // because the complete destination still matches every expected byte.
    const repeated = await writeAndVerifyArchive(
      extracted,
      "received",
      destination as unknown as FileSystemDirectoryHandle,
    );
    expect(repeated.ok).toBe(true);
  });

  it("resumes an interrupted app-owned destination and removes its checkpoint", async () => {
    const faults: MemoryWriteFaults = {
      writes: 0,
      aborts: 0,
      failOnWrite: 3,
    };
    const destination = new MemoryDirectory("destination", false, faults);
    const entries: SelectedEntry[] = [
      { path: "a.bin", bytes: Uint8Array.of(1, 2, 3) },
      { path: "nested/b.bin", bytes: Uint8Array.of(4, 5, 6, 7) },
    ];

    await expect(
      writeAndVerifyArchive(
        entries,
        "received",
        destination as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/injected destination write failure/i);
    expect(faults.aborts).toBe(1);

    faults.failOnWrite = undefined;
    const report = await writeAndVerifyArchive(
      entries,
      "received",
      destination as unknown as FileSystemDirectoryHandle,
    );

    expect(report.ok).toBe(true);
    const root = await destination.getDirectoryHandle("received");
    const rootNames: string[] = [];
    for await (const [name] of root.entries()) rootNames.push(name);
    expect(rootNames.some((name) => name.endsWith(".partial.json"))).toBe(false);
  });

  it("resumes safely after every marker or payload write in a two-file plan", async () => {
    const entries: SelectedEntry[] = [
      { path: "first.bin", bytes: Uint8Array.of(1, 2, 3) },
      { path: "second.bin", bytes: Uint8Array.of(4, 5, 6) },
    ];
    for (const failedWrite of [1, 2, 3, 4, 5, 6, 7]) {
      const faults: MemoryWriteFaults = {
        writes: 0,
        aborts: 0,
        failOnWrite: failedWrite,
      };
      const destination = new MemoryDirectory("destination", false, faults);

      await expect(
        writeAndVerifyArchive(
          entries,
          "received",
          destination as unknown as FileSystemDirectoryHandle,
        ),
        `write ${failedWrite}`,
      ).rejects.toThrow(/injected/i);

      faults.failOnWrite = undefined;
      const report = await writeAndVerifyArchive(
        entries,
        "received",
        destination as unknown as FileSystemDirectoryHandle,
      );
      expect(report.ok, `write ${failedWrite}`).toBe(true);
      const root = await destination.getDirectoryHandle("received");
      expect(await readMemoryFile(await root.getFileHandle("first.bin"))).toEqual(
        entries[0].bytes,
      );
      expect(await readMemoryFile(await root.getFileHandle("second.bin"))).toEqual(
        entries[1].bytes,
      );
    }
  });

  it("recovers a crash-truncated initial checkpoint when no payload exists", async () => {
    const faults: MemoryWriteFaults = {
      writes: 0,
      aborts: 0,
      failOnWrite: 2,
    };
    const destination = new MemoryDirectory("destination", false, faults);
    const entries = [{ path: "payload.bin", bytes: Uint8Array.of(7, 8, 9) }];

    await expect(
      writeAndVerifyArchive(
        entries,
        "received",
        destination as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/injected/i);
    faults.failOnWrite = undefined;
    const root = await destination.getDirectoryHandle("received");
    const markerEntry = Array.from(await collectMemoryEntries(root)).find(
      ([name]) => name.endsWith(".partial.json"),
    );
    expect(markerEntry?.[1]).toBeInstanceOf(MemoryFile);
    const marker = markerEntry![1] as MemoryFile;
    const validMarker = await readMemoryFile(marker);
    await writeMemoryFile(
      marker,
      validMarker.subarray(0, Math.floor(validMarker.length / 2)),
    );

    const report = await writeAndVerifyArchive(
      entries,
      "received",
      destination as unknown as FileSystemDirectoryHandle,
    );
    expect(report.ok).toBe(true);
  });

  it("removes a half-written checkpoint so an empty destination can be retried", async () => {
    const faults: MemoryWriteFaults = {
      writes: 0,
      aborts: 0,
      failOnWrite: 1,
    };
    const destination = new MemoryDirectory("destination", false, faults);
    const entries = [{ path: "payload.bin", bytes: Uint8Array.of(9, 8, 7) }];

    await expect(
      writeAndVerifyArchive(
        entries,
        "received",
        destination as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/injected/i);
    const root = await destination.getDirectoryHandle("received");
    const remaining: string[] = [];
    for await (const [name] of root.entries()) remaining.push(name);
    expect(remaining).toEqual([]);

    faults.failOnWrite = undefined;
    const report = await writeAndVerifyArchive(
      entries,
      "received",
      destination as unknown as FileSystemDirectoryHandle,
    );
    expect(report.ok).toBe(true);
  });

  it("rejects a partial root checkpoint from a different transfer without overwriting it", async () => {
    const faults: MemoryWriteFaults = {
      writes: 0,
      aborts: 0,
      failOnWrite: 3,
    };
    const destination = new MemoryDirectory("destination", false, faults);
    const original = [{ path: "payload.bin", bytes: encoder.encode("original") }];

    await expect(
      writeAndVerifyArchive(
        original,
        "received",
        destination as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/injected/i);
    faults.failOnWrite = undefined;
    const root = await destination.getDirectoryHandle("received");
    const partial = await root.getFileHandle("payload.bin");
    const before = await readMemoryFile(partial);

    await expect(
      writeAndVerifyArchive(
        [{ path: "payload.bin", bytes: encoder.encode("different") }],
        "received",
        destination as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/checkpoint|different transfer/i);
    expect(await readMemoryFile(partial)).toEqual(before);

    const resumed = await writeAndVerifyArchive(
      original,
      "received",
      destination as unknown as FileSystemDirectoryHandle,
    );
    expect(resumed.ok).toBe(true);
  });

  it("never overwrites an expected-path file that the checkpoint did not journal", async () => {
    const faults: MemoryWriteFaults = {
      writes: 0,
      aborts: 0,
      failOnWrite: 3,
    };
    const destination = new MemoryDirectory("destination", false, faults);
    const entries = [
      { path: "a.bin", bytes: encoder.encode("owned") },
      { path: "b.bin", bytes: encoder.encode("expected") },
    ];
    await expect(
      writeAndVerifyArchive(
        entries,
        "received",
        destination as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/injected/i);

    faults.failOnWrite = undefined;
    const root = await destination.getDirectoryHandle("received");
    const external = await root.getFileHandle("b.bin", { create: true });
    await writeMemoryFile(external, encoder.encode("external data"));

    await expect(
      writeAndVerifyArchive(
        entries,
        "received",
        destination as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/not journaled/i);
    expect(await readMemoryFile(external)).toEqual(encoder.encode("external data"));
  });

  it("refuses to touch an existing non-empty destination root", async () => {
    const destination = new MemoryDirectory("destination");
    const existing = await destination.getDirectoryHandle("received", {
      create: true,
    });
    const sentinel = await existing.getFileHandle("keep.txt", { create: true });
    await writeMemoryFile(sentinel, encoder.encode("do not overwrite"));

    await expect(
      writeAndVerifyArchive(
        [{ path: "new.txt", bytes: encoder.encode("new") }],
        "received",
        destination as unknown as FileSystemDirectoryHandle,
      ),
    ).rejects.toThrow(/non-empty/i);

    expect(await readMemoryFile(sentinel)).toEqual(
      encoder.encode("do not overwrite"),
    );
  });

  it("does not report success if destination storage changes a byte", async () => {
    const faults: MemoryWriteFaults = {
      writes: 0,
      aborts: 0,
      corruptFileName: "payload.bin",
    };
    const destination = new MemoryDirectory("destination", false, faults);

    const report = await writeAndVerifyArchive(
      [{ path: "payload.bin", bytes: Uint8Array.of(10, 20, 30) }],
      "received",
      destination as unknown as FileSystemDirectoryHandle,
    );

    expect(report.ok).toBe(false);
    expect(report.hashMismatches.map(({ path }) => path)).toEqual([
      "payload.bin",
    ]);

    faults.corruptFileName = undefined;
    const repaired = await writeAndVerifyArchive(
      [{ path: "payload.bin", bytes: Uint8Array.of(10, 20, 30) }],
      "received",
      destination as unknown as FileSystemDirectoryHandle,
    );
    expect(repaired.ok).toBe(true);
  });
});

function fileMap(entries: readonly SelectedEntry[]): Map<string, Uint8Array> {
  return new Map(
    entries
      .filter((entry) => !entry.directory)
      .map((entry) => [entry.path, entry.bytes]),
  );
}

function findZipSignature(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  throw new Error(`ZIP signature ${signature.toString(16)} was not found.`);
}

function fakeInputFile(
  name: string,
  webkitRelativePath: string,
  bytes: Uint8Array,
): File {
  return {
    name,
    webkitRelativePath,
    size: bytes.length,
    arrayBuffer: async () =>
      Uint8Array.from(bytes).buffer as ArrayBuffer,
  } as File;
}

type MemoryHandle = MemoryDirectory | MemoryFile;

interface MemoryWriteFaults {
  writes: number;
  aborts: number;
  failOnWrite?: number;
  corruptFileName?: string;
}

class MemoryDirectory {
  readonly kind = "directory" as const;
  private readonly children = new Map<string, MemoryHandle>();
  private readonly faults: MemoryWriteFaults;

  constructor(
    readonly name: string,
    private readonly corruptWrites = false,
    faults?: MemoryWriteFaults,
  ) {
    this.faults = faults ?? { writes: 0, aborts: 0 };
  }

  async *entries(): AsyncIterableIterator<[string, MemoryHandle]> {
    for (const entry of [...this.children.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      yield entry;
    }
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryDirectory> {
    const existing = this.children.get(name);
    if (existing instanceof MemoryDirectory) {
      return existing;
    }
    if (existing || !options?.create) {
      throw new Error(`Directory unavailable: ${name}`);
    }
    const created = new MemoryDirectory(name, this.corruptWrites, this.faults);
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryFile> {
    const existing = this.children.get(name);
    if (existing instanceof MemoryFile) {
      return existing;
    }
    if (existing || !options?.create) {
      throw new DOMException(`File unavailable: ${name}`, "NotFoundError");
    }
    const created = new MemoryFile(
      name,
      this.corruptWrites,
      this.faults,
    );
    this.children.set(name, created);
    return created;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) {
      throw new Error(`Entry unavailable: ${name}`);
    }
  }
}

class MemoryFile {
  readonly kind = "file" as const;
  bytes = new Uint8Array();

  constructor(
    readonly name: string,
    private readonly corruptWrites: boolean,
    private readonly faults: MemoryWriteFaults,
  ) {}

  async getFile(): Promise<File> {
    const snapshot = Uint8Array.from(this.bytes);
    return {
      name: this.name,
      size: snapshot.length,
      arrayBuffer: async () => snapshot.buffer as ArrayBuffer,
    } as File;
  }

  async createWritable(): Promise<{
    write: (data: BufferSource | Blob | string) => Promise<void>;
    close: () => Promise<void>;
    abort: () => Promise<void>;
  }> {
    return {
      write: async (data) => {
        if (!(data instanceof Uint8Array)) {
          throw new Error("Memory test filesystem only accepts Uint8Array.");
        }
        this.faults.writes += 1;
        if (this.faults.failOnWrite === this.faults.writes) {
          this.bytes = Uint8Array.from(data.subarray(0, Math.floor(data.length / 2)));
          throw new Error("Injected destination write failure.");
        }
        this.bytes = Uint8Array.from(data);
        if (
          (this.corruptWrites || this.faults.corruptFileName === this.name) &&
          this.bytes.length > 0
        ) {
          this.bytes[0] ^= 0xff;
        }
      },
      close: async () => undefined,
      abort: async () => {
        this.faults.aborts += 1;
      },
    };
  }
}

async function writeMemoryFile(
  file: MemoryFile,
  bytes: Uint8Array,
): Promise<void> {
  const writable = await file.createWritable();
  await writable.write(Uint8Array.from(bytes));
  await writable.close();
}

async function readMemoryFile(file: MemoryFile): Promise<Uint8Array> {
  return new Uint8Array(await (await file.getFile()).arrayBuffer());
}

async function collectMemoryEntries(
  directory: MemoryDirectory,
): Promise<Array<[string, MemoryHandle]>> {
  const entries: Array<[string, MemoryHandle]> = [];
  for await (const entry of directory.entries()) entries.push(entry);
  return entries;
}
