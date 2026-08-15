import { describe, expect, it } from "vitest";
import {
  LARGE_TREE_FOOTER_BYTES,
  LARGE_TREE_READ_BYTES,
  createLargeTreeReader,
  createQrf3LargeSource,
  encodeLargeTreeMetadata,
  parseLargeTreeMetadata,
  prepareLargeSource,
  readLargeTreeManifest,
  readPreparedLargeRange,
  type LargeSourceSelection,
} from "../src/lib/large-transfer";

function createFile(path: string, content: string, lastModified = 1) {
  const snapshot = new File([content], path.split("/").at(-1) ?? "file", {
    lastModified,
  });
  return {
    path,
    handle: {
      kind: "file" as const,
      name: snapshot.name,
      async getFile() {
        return snapshot;
      },
    } as FileSystemFileHandle,
    size: snapshot.size,
    lastModified,
  };
}

function fakeSelection(): LargeSourceSelection {
  const files = [
    createFile("a.txt", "alpha"),
    createFile("nested/b.bin", "bravo-charlie"),
  ];
  return {
    rootName: "fixture",
    rootHandle: {
      kind: "directory",
      name: "fixture",
    } as FileSystemDirectoryHandle,
    files,
    directories: ["empty", "nested"],
    totalFileBytes: BigInt(files.reduce((total, file) => total + file.size, 0)),
  };
}

describe("large transfer virtual tree", () => {
  it("hashes and reads a multi-file source without concatenating it", async () => {
    const prepared = await prepareLargeSource(fakeSelection());
    expect(prepared.totalFileBytes).toBe(18n);
    expect(prepared.totalStreamBytes).toBe(
      18n + BigInt(prepared.metadataBytes.length + LARGE_TREE_FOOTER_BYTES),
    );

    const bytes = await readPreparedLargeRange(
      prepared,
      3n,
      Number(prepared.totalStreamBytes - 3n),
    );
    expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe(
      "habravo-charlie",
    );

    const manifest = await readLargeTreeManifest(
      createLargeTreeReader(prepared),
    );
    expect(manifest.rootName).toBe("fixture");
    expect(manifest.directories).toEqual(["empty", "nested"]);
    expect(manifest.files.map(({ path, offset, size }) => ({ path, offset, size }))).toEqual([
      { path: "a.txt", offset: 0n, size: 5n },
      { path: "nested/b.bin", offset: 5n, size: 13n },
    ]);
  });

  it("serves bounded ranges across a file boundary", async () => {
    const prepared = await prepareLargeSource(fakeSelection());
    expect(
      new TextDecoder().decode(await readPreparedLargeRange(prepared, 3n, 8)),
    ).toBe("habravo-");
    const qrf3Source = createQrf3LargeSource(prepared);
    expect(new TextDecoder().decode(await qrf3Source.read(3, 8))).toBe(
      "habravo-",
    );
  });

  it("rejects mutated source metadata between scan and hash", async () => {
    const selection = fakeSelection();
    selection.files[0].handle = {
      ...selection.files[0].handle,
      async getFile() {
        return new File(["changed"], "a.txt", { lastModified: 2 });
      },
    } as FileSystemFileHandle;
    await expect(prepareLargeSource(selection)).rejects.toThrow(
      /changed after selection/,
    );
  });

  it("rejects non-canonical and colliding path metadata", () => {
    expect(() =>
      encodeLargeTreeMetadata({
        rootName: "fixture",
        directories: ["A"],
        files: [
          {
            path: "a",
            size: 0,
            lastModified: 1,
            sha256Hex: "00".repeat(32),
          },
        ],
      }),
    ).toThrow(/collide/);
  });

  it("rejects alternate JSON spellings even when values are valid", () => {
    const canonical = encodeLargeTreeMetadata({
      rootName: "fixture",
      directories: [],
      files: [],
    });
    const parsed = JSON.parse(new TextDecoder().decode(canonical));
    const reordered = new TextEncoder().encode(
      JSON.stringify({
        version: parsed.version,
        schema: parsed.schema,
        rootName: parsed.rootName,
        files: parsed.files,
        directories: parsed.directories,
      }),
    );
    expect(() => parseLargeTreeMetadata(reordered)).toThrow(/canonical/);
  });

  it("models a 40 GiB tree with compact metadata", () => {
    const encoded = encodeLargeTreeMetadata({
      rootName: "large-fixture",
      directories: ["media"],
      files: Array.from({ length: 40 }, (_, index) => ({
        path: `media/part-${String(index).padStart(2, "0")}.bin`,
        size: 1024 ** 3,
        lastModified: index,
        sha256Hex: index.toString(16).padStart(64, "0"),
      })),
    });
    const parsed = parseLargeTreeMetadata(encoded);
    expect(parsed.totalFileBytes).toBe(40n * 1024n * 1024n * 1024n);
    expect(encoded.length).toBeLessThan(10_000);
  });

  it("reads valid metadata above 16 MiB in bounded chunks", async () => {
    const metadata = encodeLargeTreeMetadata({
      rootName: "large-metadata",
      directories: [],
      files: Array.from({ length: 55_000 }, (_, index) => ({
        path: `files/${String(index).padStart(5, "0")}-${"x".repeat(205)}`,
        size: 0,
        lastModified: index,
        sha256Hex: index.toString(16).padStart(64, "0"),
      })),
    });
    expect(metadata.length).toBeGreaterThan(16 * 1024 * 1024);
    const footer = new Uint8Array(LARGE_TREE_FOOTER_BYTES);
    new DataView(footer.buffer).setBigUint64(0, BigInt(metadata.length), true);
    footer.set(new TextEncoder().encode("QRF3END1"), 8);
    const stream = new Uint8Array(metadata.length + footer.length);
    stream.set(metadata);
    stream.set(footer, metadata.length);
    const readLengths: number[] = [];

    const parsed = await readLargeTreeManifest({
      size: BigInt(stream.length),
      async read(offset, length) {
        readLengths.push(length);
        if (length > LARGE_TREE_READ_BYTES) {
          throw new Error("read exceeded the random-access store limit");
        }
        const start = Number(offset);
        return stream.slice(start, start + length);
      },
    });

    expect(parsed.files).toHaveLength(55_000);
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(LARGE_TREE_READ_BYTES);
  });
});
