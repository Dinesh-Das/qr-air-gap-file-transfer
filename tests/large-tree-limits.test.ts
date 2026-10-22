import { describe, expect, it, vi } from "vitest";
import {
  encodeLargeTreeMetadata,
  MAX_LARGE_TREE_ENTRIES,
  MAX_LARGE_TREE_METADATA_BYTES,
  parseLargeTreeMetadata,
} from "../src/lib/large-transfer";

describe("untrusted large-tree metadata limits", () => {
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
