import { encode as encodeBase45 } from "@digitalbazaar/base45";
import { compressSync } from "fflate";
import { describe, expect, it } from "vitest";
import { qrf3Crc32 } from "../src/lib/stream-protocol";
import { encodeOfflineSignal, OfflineSignalAccumulator, type OfflineSignalBundle } from "../src/lib/webrtc-signaling";

const bundle: OfflineSignalBundle = {
  v: 1, kind: "offer", sessionId: "a".repeat(32),
  sdp: "v=0\r\na=candidate:1 1 UDP 1 192.168.1.2 5000 typ host\r\n",
};

// Construct envelopes independently of the production encoder, including invalid
// bodies it rightly refuses to emit. CRC covers the exact compressed bytes.
function rawFrames(bytes: Uint8Array, kind = "O", sessionId = bundle.sessionId): string[] {
  const compressed = compressSync(bytes);
  const payload = encodeBase45(compressed);
  const total = Math.ceil(payload.length / 750);
  const crc = qrf3Crc32(compressed).toString(16).padStart(8, "0");
  return Array.from({ length: total }, (_, index) =>
    `WRS1|${kind}|${sessionId}|${index}|${total}|${crc}|${payload.slice(index * 750, (index + 1) * 750)}`);
}

function readAll(frames: string[], accumulator = new OfflineSignalAccumulator()) {
  let result;
  for (const frame of frames) result = accumulator.accept(frame);
  return result;
}

describe("adversarial optical WebRTC signaling", () => {
  it("rejects 512 distinct invalid total counts before retaining a handshake", () => {
    const accumulator = new OfflineSignalAccumulator();
    for (let total = 257; total < 769; total++) {
      expect(() => accumulator.accept(`WRS1|O|${"b".repeat(32)}|0|${total}|00000000|AA`)).toThrow(/frame number/);
    }
    expect(readAll(encodeOfflineSignal(bundle), accumulator)?.bundle).toEqual(bundle);
  });

  it.each(["-1", "1", "9007199254740992", "1".repeat(512)])("rejects invalid index %s", (index) => {
    expect(() => new OfflineSignalAccumulator().accept(`WRS1|O|${bundle.sessionId}|${index}|1|00000000|AA`)).toThrow();
  });

  it("rejects conflicting duplicates and accepts the original sequence afterward", () => {
    const frames = encodeOfflineSignal({ ...bundle, sdp: Array.from({ length: 200 }, (_, n) => `a=x:${n}:${n * 997}\r\n`).join("") });
    expect(frames.length).toBeGreaterThan(1);
    const accumulator = new OfflineSignalAccumulator();
    accumulator.accept(frames[0]);
    expect(accumulator.accept(frames[0]).duplicate).toBe(true);
    const split = frames[0].lastIndexOf("|");
    const replacement = frames[0][split + 1] === "A" ? "B" : "A";
    const conflicting = frames[0].slice(0, split + 1) + replacement + frames[0].slice(split + 2);
    expect(() => accumulator.accept(conflicting)).toThrow(/Conflicting/);
    expect(readAll(frames.slice(1), accumulator)?.complete).toBe(true);
  });

  it("rejects every single-bit change in the checksum then resets for a valid scan", () => {
    const frames = encodeOfflineSignal(bundle);
    expect(frames).toHaveLength(1);
    const fields = frames[0].split("|");
    const crc = Number.parseInt(fields[5], 16);
    const accumulator = new OfflineSignalAccumulator();
    for (let bit = 0; bit < 32; bit++) {
      accumulator.reset();
      fields[5] = ((crc ^ (1 << bit)) >>> 0).toString(16).padStart(8, "0");
      expect(() => accumulator.accept(fields.join("|"))).toThrow(/checksum/);
    }
    accumulator.reset();
    expect(readAll(frames, accumulator)?.bundle).toEqual(bundle);
  });

  it.each([
    ["invalid UTF-8", Uint8Array.of(0xc3, 0x28)],
    ["invalid JSON", new TextEncoder().encode('{"v":')],
    ["oversized inflated JSON", new TextEncoder().encode(JSON.stringify({ ...bundle, sdp: "x".repeat(2 * 1024 * 1024) }))],
  ])("rejects CRC-valid compressed %s and recovers after reset", (_name, bytes) => {
    const accumulator = new OfflineSignalAccumulator();
    expect(() => readAll(rawFrames(bytes as Uint8Array), accumulator)).toThrow(/corrupt/);
    accumulator.reset();
    expect(readAll(encodeOfflineSignal(bundle), accumulator)?.bundle).toEqual(bundle);
  });

  it.each([null, [], {}, { ...bundle, v: 2 }, { ...bundle, sdp: "" }, { ...bundle, sessionId: "A".repeat(32) }])("rejects an invalid decoded bundle %#", (value) => {
    expect(() => readAll(rawFrames(new TextEncoder().encode(JSON.stringify(value))))).toThrow(/Invalid WebRTC handshake/);
  });

  it.each([
    ["A", bundle.sessionId],
    ["O", "b".repeat(32)],
  ])("rejects a valid body whose frame envelope has kind %s and mismatched identity", (kind, sessionId) => {
    expect(() => readAll(rawFrames(new TextEncoder().encode(JSON.stringify(bundle)), kind, sessionId))).toThrow(/envelope/);
  });

  it("round-trips the maximum accepted ASCII SDP length", () => {
    const maximum = { ...bundle, sdp: "x".repeat(128 * 1024) };
    expect(readAll(encodeOfflineSignal(maximum))?.bundle).toEqual(maximum);
    expect(() => encodeOfflineSignal({ ...maximum, sdp: maximum.sdp + "x" })).toThrow(/Invalid WebRTC handshake/);
  });
});
