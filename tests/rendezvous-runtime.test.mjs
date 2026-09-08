import { createServer } from "node:http";
import dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import {
  RoomRegistry,
  createDiscoveryProof,
  createPairingCode,
  createRendezvousRuntime,
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


  it("pairs through the same local runtime without relying on LAN broadcast", async () => {
    const signalPort = await freeUdpPort();
    const runtime = createRendezvousRuntime({ signalPort, discoveryTimeoutMs: 100 });
    const server = createServer(async (request, response) => {
      if (await runtime.handleHttp(request, response)) return;
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP server did not start.");
    const baseUrl = `http://127.0.0.1:${address.port}/api/rendezvous`;

    try {
      const created = await postJson(`${baseUrl}/rooms`, { sessionId, sdp: offerSdp });
      const joined = await postJson(`${baseUrl}/join`, { code: created.code });
      expect(joined.sessionId).toBe(sessionId);
      expect(joined.sdp).toBe(offerSdp);

      await postJson(`${baseUrl}/joins/${joined.joinId}/answer`, { sessionId, sdp: answerSdp });
      const status = await postJson(`${baseUrl}/rooms/${created.roomId}`, { ownerToken: created.ownerToken });
      expect(status).toEqual({ status: "answered", sessionId, sdp: answerSdp });
    } finally {
      await runtime.stop();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function freeUdpPort() {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  const port = address.port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
