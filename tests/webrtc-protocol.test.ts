import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { MAX_BLOCK_STORE_BLOCKS } from "../src/lib/block-store";
import {
  applyReceiptRanges,
  decodeOfflineControl,
  decodeOfflineDataBlock,
  encodeOfflineControl,
  encodeOfflineDataBlock,
  receiptBitsToRanges,
  OFFLINE_BLOCK_BYTES,
  OFFLINE_MAX_ACK_INDICES,
  OFFLINE_MAX_RESUME_RANGES,
  decodeOfflineDataBlockAsync,
} from "../src/lib/webrtc-protocol";

function manifestAtSize(totalBytes: number) {
  const identity = { v: 1 as const, transferId: "1".repeat(32), rootName: "boundary-fixture",
    totalBytes, blockSize: OFFLINE_BLOCK_BYTES, streamSha256: "2".repeat(64) };
  return { ...identity, type: "manifest" as const,
    manifestId: createHash("sha256").update(JSON.stringify(identity)).digest("hex") };
}

describe("WebRTC transfer protocol", () => {
  it("rejects seeded malformed required control fields without accepting a partial message", () => {
    let seed = 0x6a09e667;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const invalid = [null, true, false, {}, [], "", "0", "1", -1, 0.5, Number.MAX_SAFE_INTEGER + 1];
    for (let iteration = 0; iteration < 1000; iteration++) {
      const value = invalid[random() % invalid.length];
      const kind = random() % 5;
      const message = kind === 0 ? { type: "ack", indices: [value] }
        : kind === 1 ? { type: "resume-ranges", ranges: [[value, 1]] }
        : kind === 2 ? { type: "peer-confirmed", sessionId: value, transcriptHash: "a".repeat(64) }
        : kind === 3 ? { type: "error", message: value }
        : { type: "manifest", manifest: { ...manifestAtSize(1), totalBytes: value } };
      // Empty strings are valid human error text; select a known invalid field.
      if (kind === 3 && typeof value === "string") message.message = {};
      expect(() => decodeOfflineControl(JSON.stringify(message))).toThrow();
    }
  });

  it("enforces exact ACK, resume, human-text and JSON wire limits", () => {
    const ack = { type: "ack" as const, indices: Array.from({ length: OFFLINE_MAX_ACK_INDICES }, (_, index) => index) };
    expect(decodeOfflineControl(encodeOfflineControl(ack))).toEqual(ack);
    expect(() => decodeOfflineControl(JSON.stringify({ ...ack, indices: [...ack.indices, 512] }))).toThrow();
    const resume = { type: "resume-ranges" as const, ranges: Array.from({ length: OFFLINE_MAX_RESUME_RANGES }, (_, index) => [index * 2, index * 2 + 1] as [number, number]) };
    expect(decodeOfflineControl(encodeOfflineControl(resume))).toEqual(resume);
    expect(() => decodeOfflineControl(JSON.stringify({ ...resume, ranges: [...resume.ranges, [1024, 1025]] }))).toThrow();
    for (const type of ["error", "cancel"] as const) {
      const field = type === "error" ? "message" : "reason";
      expect(decodeOfflineControl(JSON.stringify({ type, [field]: "x".repeat(2000) }))).toHaveProperty(field);
      expect(() => decodeOfflineControl(JSON.stringify({ type, [field]: "x".repeat(2001) }))).toThrow();
    }
    const wire = '{"type":"sender-complete"}';
    expect(decodeOfflineControl(wire.padEnd(256 * 1024, " "))).toHaveProperty("type", "sender-complete");
    expect(() => decodeOfflineControl(wire.padEnd(256 * 1024 + 1, " "))).toThrow(/too large/);
  });

  it("rejects every single-bit mutation in a complete wire packet with both hash paths", async () => {
    expect(globalThis.crypto?.subtle).toBeDefined();
    const original = encodeOfflineDataBlock(37, Uint8Array.from({ length: 97 }, (_, index) => index * 13 & 255));
    expect(await decodeOfflineDataBlockAsync(original)).toEqual(decodeOfflineDataBlock(original));
    for (let position = 0; position < original.length; position++) for (let bit = 0; bit < 8; bit++) {
      const changed = original.slice(); changed[position] ^= 1 << bit;
      expect(() => decodeOfflineDataBlock(changed)).toThrow();
      await expect(decodeOfflineDataBlockAsync(changed)).rejects.toThrow();
    }
    for (const length of [0, 1, 43, original.length - 1]) {
      expect(() => decodeOfflineDataBlock(original.slice(0, length))).toThrow();
      await expect(decodeOfflineDataBlockAsync(original.slice(0, length))).rejects.toThrow();
    }
    const trailing = new Uint8Array(original.length + 1); trailing.set(original);
    expect(() => decodeOfflineDataBlock(trailing)).toThrow();
    await expect(decodeOfflineDataBlockAsync(trailing)).rejects.toThrow();
  });

  it.each([MAX_BLOCK_STORE_BLOCKS * OFFLINE_BLOCK_BYTES + 1, Number.MAX_SAFE_INTEGER])(
    "rejects an identity-valid %i-byte manifest above the durable block-map limit at the wire boundary",
    (totalBytes) => {
      const manifest = manifestAtSize(totalBytes);
      expect(() => decodeOfflineControl(JSON.stringify({ type: "manifest", manifest }))).toThrow(/manifest/);
      expect(() => encodeOfflineControl({ type: "manifest", manifest })).toThrow(/manifest/);
    },
  );

  it.each([1, 100 * 1024 ** 3, MAX_BLOCK_STORE_BLOCKS * OFFLINE_BLOCK_BYTES])(
    "accepts an identity-valid supported %i-byte manifest without allocating a transfer",
    (totalBytes) => {
      const message = { type: "manifest" as const, manifest: manifestAtSize(totalBytes) };
      expect(decodeOfflineControl(encodeOfflineControl(message))).toEqual(message);
    },
  );

  it("encodes and verifies binary blocks", () => {
    const payload = Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff);
    const encoded = encodeOfflineDataBlock(9, payload);
    expect(decodeOfflineDataBlock(encoded)).toEqual({ index: 9, payload });
    encoded[encoded.length - 1] ^= 1;
    expect(() => decodeOfflineDataBlock(encoded)).toThrow(/SHA-256/);
  });

  it("binds the routing index into each block digest", () => {
    const encoded = encodeOfflineDataBlock(9, Uint8Array.of(1, 2, 3));
    new DataView(encoded.buffer).setUint32(4, 10, true);
    expect(() => decodeOfflineDataBlock(encoded)).toThrow(/SHA-256/);
  });

  it("round-trips control messages", () => {
    const message = { type: "ack" as const, indices: [1, 4, 9] };
    expect(decodeOfflineControl(encodeOfflineControl(message))).toEqual(message);
  });

  it("compacts and reapplies receipt ranges", () => {
    const bits = Uint8Array.of(0b1101_1011, 0b0000_0011);
    const ranges = receiptBitsToRanges(bits, 10);
    expect(ranges).toEqual([[0, 2], [3, 5], [6, 10]]);
    const restored = new Uint8Array(2);
    applyReceiptRanges(restored, ranges, 10);
    expect(restored).toEqual(bits);
  });
});
