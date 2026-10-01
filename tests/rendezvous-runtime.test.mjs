import { freeSignalPort } from "./free-signal-port.mjs";
import { createServer } from "node:http";
import dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import {
  RoomRegistry,
  createDiscoveryProof,
  createPairingCode,
  createRendezvousRuntime,
  allowDiscovery,
  broadcastAddressesFromInterfaces,
  calculateBroadcastAddress,
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



  it("computes broadcasts for synthetic adapter subnet records without enumerating hosts", () => {
    const adapter = (address, netmask) => ({ family: "IPv4", internal: false, address, netmask });
    expect(broadcastAddressesFromInterfaces({
      "Wi-Fi": [adapter("192.168.5.10", "255.255.252.0")],
      Ethernet: [adapter("10.20.3.5", "255.255.0.0")],
      "vEthernet (hotspot)": [adapter("192.168.137.1", "255.255.255.0")],
      Duplicate: [adapter("192.168.137.2", "255.255.255.0")],
      LinkLocal: [adapter("169.254.12.3", "255.255.0.0")],
      Loopback: [{ ...adapter("127.0.0.1", "255.0.0.0"), internal: true }],
      Ipv6: [{ family: "IPv6", address: "::1", internal: false }],
    })).toEqual(["192.168.7.255", "10.20.255.255", "192.168.137.255", "169.254.255.255"]);
  });

  it("rejects malformed masks and addresses and non-broadcast routes", () => {
    for (const mask of [undefined, "bad", "255.0.255.0", "0.0.0.0", "255.255.255.254", "255.255.255.255"]) {
      expect(calculateBroadcastAddress("192.168.1.2", mask)).toBeNull();
    }
    for (const address of [undefined, "bad", "192.168.001.2", "256.1.1.1", "0.1.1.1", "127.0.0.1", "224.1.1.1", "255.255.255.255", "192.168.1.0", "192.168.1.255"]) {
      expect(calculateBroadcastAddress(address, "255.255.255.0")).toBeNull();
    }
    expect(calculateBroadcastAddress("10.0.0.1", "255.255.255.252")).toBe("10.0.0.3");
    expect(broadcastAddressesFromInterfaces(undefined)).toEqual([]);
  });

  it("bounds broadcasts even with excessive adapter aliases", () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      family: "IPv4", internal: false, address: `10.0.${index}.1`, netmask: "255.255.255.0",
    }));
    expect(broadcastAddressesFromInterfaces({ Ethernet: entries })).toHaveLength(32);
  });

  it.each(["TCP", "UDP"])("retries LAN startup after an occupied %s port is released", async (transport) => {
    const signalPort = await freeSignalPort();
    const occupied = transport === "TCP" ? createServer() : dgram.createSocket("udp4");
    await new Promise((resolve, reject) => {
      occupied.once("error", reject);
      if (transport === "TCP") occupied.listen(signalPort, "0.0.0.0", resolve);
      else occupied.bind(signalPort, "0.0.0.0", resolve);
    });
    let released = false;
    const runtime = createRendezvousRuntime({ signalPort });
    const server = createServer((request, response) => { void runtime.handleHttp(request, response); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const healthUrl = `http://127.0.0.1:${server.address().port}/api/rendezvous/health`;
    try {
      await expect(runtime.start()).rejects.toThrow(`LAN pairing ${transport} port ${signalPort} is already in use`);
      await expect(postJson(healthUrl, {})).rejects.toThrow(`LAN pairing ${transport} port ${signalPort} is already in use`);
      await new Promise((resolve) => occupied.close(resolve));
      released = true;
      expect(await postJson(healthUrl, {})).toEqual({ ready: true, protocol: 2 });
      expect(runtime.stats()).toMatchObject({ rooms: 0, localJoins: 0 });
      // A second start must be idempotent after recovery, not bind again.
      await runtime.start();
    } finally {
      await runtime.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (!released) await new Promise((resolve) => occupied.close(resolve));
    }
  });

  it("allows only same-origin JSON connection checks and returns no interface or room data", async () => {
    const runtime = createRendezvousRuntime({ signalPort: await freeSignalPort() });
    const server = createServer((request, response) => { void runtime.handleHttp(request, response); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = `${origin}/api/rendezvous/health`;
    try {
      expect((await fetch(url)).status).toBe(405);
      expect((await fetch(url, { method: "POST", headers: { Origin: "https://example.test", "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
      for (const value of [true, 42, [], { ready: true }]) {
        await expect(postJson(url, value)).rejects.toThrow();
      }
      expect(await postJson(url, {})).toEqual({ ready: true, protocol: 2 });
      expect(runtime.stats()).toMatchObject({ rooms: 0, localJoins: 0, pendingDiscoveries: 0, pendingSignals: 0 });
    } finally {
      await runtime.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("pairs through the same local runtime without relying on LAN broadcast", async () => {
    const signalPort = await freeSignalPort();
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

  it("returns 404 when no sender can be discovered", async () => {
    const signalPort = await freeSignalPort();
    const runtime = createRendezvousRuntime({ signalPort, discoveryTimeoutMs: 20 });
    const server = createServer(async (request, response) => {
      if (await runtime.handleHttp(request, response)) return;
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP server did not start.");

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/rendezvous/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${address.port}` },
        body: JSON.stringify({ code: "123456" }),
      });
      const body = await response.json();
      expect(response.status).toBe(404);
      expect(body.error).toContain("No sender was found for that code");
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

  it("bounds discovery rate entries and does not allocate for malformed messages", () => {
    const rates = new Map();
    for (let index = 0; index < 2000; index += 1) {
      expect(allowDiscovery(`bad-${index}`, "bad", rates, 0)).toBe(false);
    }
    expect(rates.size).toBe(0);
    for (let index = 0; index < 2000; index += 1) allowDiscovery(`host-${index}`, "a".repeat(32), rates, 0);
    expect(rates.size).toBe(1024);
    expect(allowDiscovery("new-host", "a".repeat(32), rates, 0)).toBe(false);
  });

  it("cleans expired joins, rooms and UDP rate entries without another client request", async () => {
    let time = 1000;
    const signalPort = await freeSignalPort();
    const runtime = createRendezvousRuntime({ signalPort, now: () => time, cleanupIntervalMs: 5 });
    const server = createServer((request, response) => { void runtime.handleHttp(request, response); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/rendezvous`;
    const socket = dgram.createSocket("udp4");
    try {
      const created = await postJson(`${baseUrl}/rooms`, { sessionId, sdp: offerSdp });
      await postJson(`${baseUrl}/join`, { code: created.code });
      expect(runtime.stats().localJoins).toBe(1);
      socket.send(JSON.stringify({ v: 2, t: "d", requestId: "d".repeat(32) }), signalPort, "127.0.0.1");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runtime.stats().discoveryRates).toBe(1);
      time = 200_000;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runtime.stats()).toMatchObject({ localJoins: 0, rooms: 0, discoveryRates: 0 });
    } finally {
      await new Promise((resolve) => socket.close(resolve));
      await runtime.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(url).origin },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}
