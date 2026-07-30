import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
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
});

describe("browser collection and destination writing", () => {
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
    const destination = new MemoryDirectory("destination", true);

    const report = await writeAndVerifyArchive(
      [{ path: "payload.bin", bytes: Uint8Array.of(10, 20, 30) }],
      "received",
      destination as unknown as FileSystemDirectoryHandle,
    );

    expect(report.ok).toBe(false);
    expect(report.hashMismatches.map(({ path }) => path)).toEqual([
      "payload.bin",
    ]);
  });
});

function fileMap(entries: readonly SelectedEntry[]): Map<string, Uint8Array> {
  return new Map(
    entries
      .filter((entry) => !entry.directory)
      .map((entry) => [entry.path, entry.bytes]),
  );
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

class MemoryDirectory {
  readonly kind = "directory" as const;
  private readonly children = new Map<string, MemoryHandle>();

  constructor(
    readonly name: string,
    private readonly corruptWrites = false,
  ) {}

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
    const created = new MemoryDirectory(name, this.corruptWrites);
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
      throw new Error(`File unavailable: ${name}`);
    }
    const created = new MemoryFile(name, this.corruptWrites);
    this.children.set(name, created);
    return created;
  }
}

class MemoryFile {
  readonly kind = "file" as const;
  bytes = new Uint8Array();

  constructor(
    readonly name: string,
    private readonly corruptWrites: boolean,
  ) {}

  async getFile(): Promise<File> {
    const snapshot = Uint8Array.from(this.bytes);
    return {
      name: this.name,
      arrayBuffer: async () => snapshot.buffer as ArrayBuffer,
    } as File;
  }

  async createWritable(): Promise<{
    write: (data: BufferSource | Blob | string) => Promise<void>;
    close: () => Promise<void>;
  }> {
    return {
      write: async (data) => {
        if (!(data instanceof Uint8Array)) {
          throw new Error("Memory test filesystem only accepts Uint8Array.");
        }
        this.bytes = Uint8Array.from(data);
        if (this.corruptWrites && this.bytes.length > 0) {
          this.bytes[0] ^= 0xff;
        }
      },
      close: async () => undefined,
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
