import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { LARGE_TREE_READ_BYTES, prepareLargeSource, type LargeSourceSelection } from "../src/lib/large-transfer";

const work = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("@noble/hashes/sha2.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noble/hashes/sha2.js")>();
  const observe = (hash: ReturnType<typeof actual.sha256.create>): ReturnType<typeof actual.sha256.create> => {
    const update = hash.update.bind(hash), clone = hash.clone.bind(hash);
    Object.defineProperty(hash, "update", { value: (chunk: Uint8Array) => { work.bytes += chunk.byteLength; return update(chunk); } });
    Object.defineProperty(hash, "clone", { value: () => observe(clone()) });
    return hash;
  };
  return { ...actual, sha256: Object.assign((...args: Parameters<typeof actual.sha256>) => actual.sha256(...args),
    { ...actual.sha256, create: () => observe(actual.sha256.create()) }) };
});

it.each([
  ["empty tree", []],
  ["empty files", [0, 0]],
  ["partial SHA block", [63, 13]],
  ["exact SHA block", [64, 13]],
  ["next SHA block", [65, 13]],
  ["one file", [129]],
  ["empty prefix and suffix files", [0, 65, 17, 0]],
  ["source read boundary", [LARGE_TREE_READ_BYTES + 65, 127]],
] as const)("preserves independent hashes with one compression pass for the shared prefix: %s", async (_name, sizes) => {
  const bytes = sizes.map((size, file) => Uint8Array.from({ length: size }, (_, i) => (i * 17 + file * 31) % 251));
  const files = bytes.map((content, i) => {
    const path = `file-${i}.bin`, snapshot = new File([content], path, { lastModified: 1 });
    return { path, size: snapshot.size, lastModified: 1,
      handle: { kind: "file", name: path, getFile: async () => snapshot } as FileSystemFileHandle };
  });
  const selection: LargeSourceSelection = { rootName: "fixture", rootHandle: {} as FileSystemDirectoryHandle,
    files, directories: [], totalFileBytes: BigInt(sizes.reduce((sum, n) => sum + n, 0)) };
  // Count actual bytes fed into incremental SHA, including cloned states. This
  // guards redundant compression work; it does not require a particular clone API.
  work.bytes = 0;
  const prepared = await prepareLargeSource(selection);

  const digests = bytes.map(b => createHash("sha256").update(b).digest("hex"));
  expect(prepared.files.map(f => f.sha256Hex)).toEqual(digests);
  const metadata = Buffer.from(JSON.stringify({ schema: "airgap-qr-tree", version: 3, rootName: "fixture", directories: [],
    files: files.map((f, i) => ({ path: f.path, size: String(f.size), sha256: digests[i], lastModified: 1 })) }));
  const footer = Buffer.alloc(16);
  footer.writeBigUInt64LE(BigInt(metadata.length)); footer.write("QRF3END1", 8);
  expect(Buffer.from(prepared.metadataBytes)).toEqual(metadata);
  expect(Buffer.from(prepared.trailerBytes)).toEqual(Buffer.concat([metadata, footer]));
  const streamHash = createHash("sha256");
  for (const b of bytes) streamHash.update(b);
  streamHash.update(metadata); streamHash.update(footer);
  expect(Buffer.from(prepared.streamSha256).toString("hex")).toBe(streamHash.digest("hex"));
  const sharedPrefixBytes = sizes.find(size => size > 0) ?? 0;
  expect(work.bytes).toBeLessThanOrEqual(2 * Number(selection.totalFileBytes) - sharedPrefixBytes + prepared.trailerBytes.length);
});
