import { describe, expect, it, vi } from "vitest";
import {
  encodeLargeTreeMetadata,
  MAX_LARGE_TREE_ENTRIES,
  MAX_LARGE_TREE_METADATA_BYTES,
  parseLargeTreeMetadata,
} from "../src/lib/large-transfer";

describe("untrusted large-tree metadata limits", () => {
  it.each(["file", "directory", "root"] as const)("rejects oversized %s names before UTF-8 allocation", (kind) => {
    const oversized = kind === "root" ? "a".repeat(256) : "a/".repeat(4096) + "file";
    const bytes = new TextEncoder().encode(JSON.stringify({
      schema: "airgap-qr-tree", version: 3, rootName: kind === "root" ? oversized : "limit",
      directories: kind === "directory" ? [oversized] : [],
      files: kind === "file" ? [{ path: oversized, size: "0", sha256: "0".repeat(64), lastModified: 1 }] : [],
    }));
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      expect(() => parseLargeTreeMetadata(bytes)).toThrow();
      expect(encode).not.toHaveBeenCalledWith(oversized);
    } finally {
      encode.mockRestore();
    }
  });

  it.each(["ascii", "multibyte"] as const)("keeps exact path/root byte boundaries for %s names", (kind) => {
    const fullSegment = kind === "ascii" ? "a".repeat(255) : "é".repeat(127) + "a";
    const partialSegment = kind === "ascii" ? "b".repeat(254) : "é".repeat(127);
    const segments = [...Array<string>(15).fill(fullSegment), partialSegment, "f"];
    const path = segments.join("/");
    const directories = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
    const file = { path, size: 0, sha256Hex: "0".repeat(64), lastModified: 1 };
    const input = { rootName: fullSegment, directories, files: [file] };
    expect(new TextEncoder().encode(path)).toHaveLength(4096);
    expect(new TextEncoder().encode(fullSegment)).toHaveLength(255);
    const bytes = encodeLargeTreeMetadata(input);
    const decoded = parseLargeTreeMetadata(bytes);
    expect(decoded.rootName).toBe(fullSegment);
    expect(decoded.files[0].path).toBe(path);
    expect(decoded.metadataBytes).toEqual(bytes);
    expect(() => encodeLargeTreeMetadata({ ...input, files: [{ ...file, path: path + "f" }] })).toThrow(/4096/);
    expect(() => encodeLargeTreeMetadata({ ...input, rootName: fullSegment + "a" })).toThrow(/255/);
  });

  it.each(["9007199254740992", "9".repeat(1024)])("rejects unsupported file-size strings before BigInt conversion %#", (size) => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      schema: "airgap-qr-tree", version: 3, rootName: "limit", directories: [],
      files: [{ path: "file.bin", size, sha256: "0".repeat(64), lastModified: 1 }],
    }));
    const convert = vi.spyOn(globalThis, "BigInt");
    try {
      expect(() => parseLargeTreeMetadata(bytes)).toThrow();
      expect(convert).not.toHaveBeenCalled();
    } finally {
      convert.mockRestore();
    }
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("keeps the supported file-size boundary %i exact", (size) => {
    const bytes = encodeLargeTreeMetadata({ rootName: "limit", directories: [],
      files: [{ path: "file.bin", size, sha256Hex: "0".repeat(64), lastModified: 1 }],
    });
    const decoded = parseLargeTreeMetadata(bytes);
    expect(decoded.files[0].size).toBe(BigInt(size));
    expect(decoded.totalFileBytes).toBe(BigInt(size));
    expect(decoded.metadataBytes).toEqual(bytes);
  });

  it("accepts exactly 100,000 combined file and directory records", () => {
    expect(MAX_LARGE_TREE_ENTRIES).toBe(100_000);
    const directories = Array.from(
      { length: MAX_LARGE_TREE_ENTRIES - 1 },
      (_, index) => `directory-${String(index).padStart(6, "0")}`,
    );
    const files = [{ path: "empty.bin", size: 0, lastModified: 1, sha256Hex: "0".repeat(64) }];
    const encoded = encodeLargeTreeMetadata({ rootName: "limit", directories, files });
    const decoded = parseLargeTreeMetadata(encoded);
    expect(decoded.directories).toEqual(directories);
    expect(decoded.files).toHaveLength(1);
    expect(decoded.totalFileBytes).toBe(0n);

    expect(() => encodeLargeTreeMetadata({
      rootName: "limit", directories: [...directories, "one-too-many"], files,
    })).toThrow(/entry limit/i);

    // The receiving boundary must enforce the cap independently of our encoder.
    const hostile = JSON.parse(new TextDecoder().decode(encoded));
    // An invalid extra file also proves the entry cap runs before per-file
    // validation, rather than relying on the encoder's later canonical check.
    hostile.files.push({});
    expect(() => parseLargeTreeMetadata(
      new TextEncoder().encode(JSON.stringify(hostile)),
    )).toThrow(/entry limit/i);
  }, 30_000);

  it("rejects a 32 MiB plus one byte input before decoding or parsing JSON", () => {
    expect(MAX_LARGE_TREE_METADATA_BYTES).toBe(32 * 1024 * 1024);
    const oversized = new Uint8Array(MAX_LARGE_TREE_METADATA_BYTES + 1);
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(() => parseLargeTreeMetadata(oversized)).toThrow(/safety limit/i);
      expect(decode).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
      parse.mockRestore();
    }
  });

  it("admits exactly 32 MiB to validation without accepting noncanonical padding", () => {
    const canonical = encodeLargeTreeMetadata({ rootName: "limit", directories: [], files: [] });
    const padded = new Uint8Array(MAX_LARGE_TREE_METADATA_BYTES).fill(0x20);
    padded.set(canonical);
    // Valid JSON with trailing spaces reaches canonical validation, rather than
    // incorrectly rejecting the inclusive byte boundary or accepting padding.
    expect(() => parseLargeTreeMetadata(padded)).toThrow(/canonical order or encoding/i);
  });
});
