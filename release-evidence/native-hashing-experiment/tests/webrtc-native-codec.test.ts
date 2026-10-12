import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeOfflineDataBlock, decodeOfflineDataBlockAsync,
  encodeOfflineDataBlock, encodeOfflineDataBlockAsync,
  OFFLINE_BLOCK_BYTES,
} from "../src/lib/webrtc-protocol";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("native asynchronous WebRTC block hashing", () => {
  it.each([1, 777, OFFLINE_BLOCK_BYTES])("preserves the authenticated wire format for %i payload bytes", async (length) => {
    const payload = Uint8Array.from({ length }, (_, n) => n * 37);
    const encoded = await encodeOfflineDataBlockAsync(0xffffffff, payload);
    const independent = createHash("sha256").update("airgap-webrtc-data-v1\0")
      .update(encoded.subarray(0, 12)).update(payload).digest();
    expect(encoded.subarray(12, 44)).toEqual(new Uint8Array(independent));
    expect(encoded).toEqual(encodeOfflineDataBlock(0xffffffff, payload));
    expect(decodeOfflineDataBlock(encoded)).toEqual({ index: 0xffffffff, payload });
    expect(await decodeOfflineDataBlockAsync(encoded)).toEqual({ index: 0xffffffff, payload });
  });

  it.each([4, 12, 44])("rejects corruption at wire offset %i", async (offset) => {
    const encoded = encodeOfflineDataBlock(7, Uint8Array.of(1, 2, 3));
    encoded[offset] ^= 1;
    await expect(decodeOfflineDataBlockAsync(encoded)).rejects.toThrow(/SHA-256/);
  });

  it("captures input bytes before awaiting the native digest", async () => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      await hold;
      return original(...args);
    });
    const source = Uint8Array.of(2, 5, 9);
    const encoded = encodeOfflineDataBlock(13, source);
    const encoding = encodeOfflineDataBlockAsync(13, source);
    const decoding = decodeOfflineDataBlockAsync(encoded);
    source.fill(99);
    encoded.fill(0);
    release();
    expect(await encoding).toEqual(encodeOfflineDataBlock(13, Uint8Array.of(2, 5, 9)));
    expect(await decoding).toEqual({ index: 13, payload: Uint8Array.of(2, 5, 9) });
  });

  it("propagates native digest failures instead of accepting or silently falling back", async () => {
    const encoded = encodeOfflineDataBlock(0, Uint8Array.of(1));
    const failure = new Error("Injected native digest failure");
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(failure);
    await expect(encodeOfflineDataBlockAsync(0, Uint8Array.of(1))).rejects.toBe(failure);
    await expect(decodeOfflineDataBlockAsync(encoded)).rejects.toBe(failure);
  });

  it("retains the verified synchronous codec if the native API is unavailable", async () => {
    const payload = Uint8Array.of(4, 8, 12);
    const encoded = encodeOfflineDataBlock(1, payload);
    vi.stubGlobal("crypto", undefined);
    expect(await encodeOfflineDataBlockAsync(1, payload)).toEqual(encoded);
    expect(await decodeOfflineDataBlockAsync(encoded)).toEqual({ index: 1, payload });
  });
});
