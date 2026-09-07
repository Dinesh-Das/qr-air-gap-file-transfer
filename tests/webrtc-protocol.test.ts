import { describe, expect, it } from "vitest";
import {
  applyReceiptRanges,
  decodeOfflineControl,
  decodeOfflineDataBlock,
  encodeOfflineControl,
  encodeOfflineDataBlock,
  receiptBitsToRanges,
} from "../src/lib/webrtc-protocol";

describe("WebRTC transfer protocol", () => {
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
