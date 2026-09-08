import { describe, expect, it } from "vitest";
import {
  RoomRegistry,
  createDiscoveryProof,
  createPairingCode,
} from "../scripts/rendezvous.mjs";

const sessionId = "0123456789abcdef0123456789abcdef";
const offerSdp = "v=0\r\na=candidate:1 1 UDP 1 192.168.1.2 5000 typ host\r\n";
const answerSdp = "v=0\r\na=candidate:2 1 UDP 1 192.168.1.3 5001 typ host\r\n";

describe("LAN rendezvous room registry", () => {
  it("creates zero-padded six-digit pairing codes", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(createPairingCode()).toMatch(/^\d{6}$/);
    }
  });

  it("claims a room once and accepts only its bound answer", () => {
    const registry = new RoomRegistry();
    const room = registry.create({ sessionId, sdp: offerSdp });
    const nonce = "a".repeat(64);
    const requestId = "b".repeat(32);
    const proof = createDiscoveryProof(room.code, nonce);
    const discovered = registry.discover({ requestId, nonce, proof, address: "192.168.1.3" });

    expect(discovered?.sessionId).toBe(sessionId);
    expect(registry.discover({
      requestId: "c".repeat(32),
      nonce,
      proof,
      address: "192.168.1.4",
    })).toBeNull();
    expect(registry.acceptAnswer({
      roomId: discovered.roomId,
      joinToken: "0".repeat(64),
      sessionId,
      sdp: answerSdp,
      address: "192.168.1.3",
    })).toBe(false);
    expect(registry.acceptAnswer({
      roomId: discovered.roomId,
      joinToken: discovered.joinToken,
      sessionId,
      sdp: answerSdp,
      address: "192.168.1.3",
    })).toBe(true);
    expect(registry.wait(room.roomId, room.ownerToken)).toEqual({
      status: "answered",
      sessionId,
      sdp: answerSdp,
    });
  });

  it("expires rooms by TTL", () => {
    let now = 1_000;
    const registry = new RoomRegistry({ ttlMs: 500, now: () => now });
    const room = registry.create({ sessionId, sdp: offerSdp });
    expect(registry.wait(room.roomId, room.ownerToken)?.status).toBe("waiting");
    now = 1_501;
    expect(registry.wait(room.roomId, room.ownerToken)).toBeNull();
  });
});
