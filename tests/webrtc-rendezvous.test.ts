import { describe, expect, it } from "vitest";
import {
  formatPairingCode,
  isValidPairingCode,
  normalizePairingCode,
} from "../src/lib/webrtc-rendezvous";

describe("WebRTC pairing code helpers", () => {
  it("normalizes pasted pairing codes to six digits", () => {
    expect(normalizePairingCode("12 3-456 extra")).toBe("123456");
    expect(normalizePairingCode("abc00123456")).toBe("001234");
  });

  it("requires exactly six digits", () => {
    expect(isValidPairingCode("000001")).toBe(true);
    expect(isValidPairingCode("12345")).toBe(false);
    expect(isValidPairingCode("12345a")).toBe(false);
  });

  it("formats a valid code for display without changing its value", () => {
    expect(formatPairingCode("007042")).toBe("007 042");
  });
});
