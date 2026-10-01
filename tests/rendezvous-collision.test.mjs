import { describe, expect, it, vi } from "vitest";
vi.mock("node:crypto", async (original) => ({ ...await original(), randomInt: vi.fn() }));
import { randomInt } from "node:crypto";
import { RoomRegistry, createDiscoveryProof } from "../scripts/rendezvous.mjs";

const sessionId = "0123456789abcdef0123456789abcdef";
const sdp = "v=0\r\na=fingerprint:sha-256 COLLISION-FIXTURE\r\n";

function discover(registry, code, requestId = "1".repeat(32)) {
  const nonce = "2".repeat(64);
  return registry.discover({ requestId, nonce, proof: createDiscoveryProof(code, nonce), address: "192.168.1.3" });
}

describe("bounded room-code collision handling", () => {
  it("retries a duplicate draw without replacing the existing room", () => {
    randomInt.mockReset().mockReturnValueOnce(7).mockReturnValueOnce(7).mockReturnValueOnce(8);
    const registry = new RoomRegistry();
    const first = registry.create({ sessionId, sdp });
    const second = registry.create({ sessionId: "3".repeat(32), sdp });
    expect([first.code, second.code]).toEqual(["000007", "000008"]);
    expect(randomInt).toHaveBeenCalledTimes(3);
    expect(registry.rooms.size).toBe(2);
    expect(discover(registry, first.code).roomId).toBe(first.roomId);
    expect(discover(registry, second.code, "4".repeat(32)).roomId).toBe(second.roomId);
  });

  it("bounds collision exhaustion and allows a subsequent successful retry", () => {
    randomInt.mockReset().mockReturnValue(0);
    const registry = new RoomRegistry();
    const first = registry.create({ sessionId, sdp });
    expect(() => registry.create({ sessionId: "3".repeat(32), sdp })).toThrow(/Unable to allocate a pairing code/);
    expect(randomInt).toHaveBeenCalledTimes(33);
    expect(registry.rooms.size).toBe(1);
    expect(discover(registry, first.code).roomId).toBe(first.roomId);
    randomInt.mockReturnValue(1);
    const retry = registry.create({ sessionId: "3".repeat(32), sdp });
    expect(retry.code).toBe("000001");
    expect(registry.rooms.size).toBe(2);
  });

  it("releases a cancelled code without reusing its expired room capability", () => {
    randomInt.mockReset().mockReturnValue(23);
    const registry = new RoomRegistry();
    const first = registry.create({ sessionId, sdp });
    expect(registry.cancel(first.roomId, first.ownerToken)).toBe(true);
    const next = registry.create({ sessionId: "3".repeat(32), sdp });
    expect(next.code).toBe(first.code);
    expect(next.roomId).not.toBe(first.roomId);
    expect(next.ownerToken).not.toBe(first.ownerToken);
    expect(registry.wait(first.roomId, first.ownerToken)).toBeNull();
    expect(registry.wait(next.roomId, first.ownerToken)).toBeNull();
    expect(registry.cancel(next.roomId, first.ownerToken)).toBe(false);
    expect(discover(registry, next.code).roomId).toBe(next.roomId);
  });
});
