import { freeSignalPort } from "./free-signal-port.mjs";
import { createServer } from "node:http";
import dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import { createDiscoveryProof, createRendezvousRuntime, readJsonBody, parseManualEndpoint } from "../scripts/rendezvous.mjs";
import { exchangeLanSignal } from "../scripts/lan-signaling.mjs";

const sessionId = "a".repeat(32);
const largeSdp = "v=0\r\n" + "a=x:" + "x".repeat(47 * 1024) + "\r\n";

async function withRuntime(run, options = {}) {
  const port = await freeSignalPort();
  const runtime = createRendezvousRuntime({ signalPort: port, ...options });
  try { await runtime.start(); await run(runtime, port); }
  finally { await runtime.stop(); }
}

function rpc(port, message, extra = {}) {
  return exchangeLanSignal({ address: "127.0.0.1", port, message, readBody: readJsonBody, ...extra });
}

describe("reliable LAN signaling", () => {
  it("shutdown cancels a stalled peer response and its waiting browser request", async () => {
    const awaitedPort = await freeSignalPort();
    const peer = createServer(() => { /* Deliberately withhold signaling response. */ });
    await new Promise((resolve) => peer.listen(awaitedPort, "127.0.0.1", resolve));
    const port = peer.address().port;
    const discovery = dgram.createSocket("udp4");
    await new Promise((resolve) => discovery.bind(port, "127.0.0.1", resolve));
    discovery.on("message", (bytes, source) => {
      const message = JSON.parse(bytes.toString());
      discovery.send(JSON.stringify({ v: 2, t: "o", requestId: message.requestId,
        roomId: "d".repeat(32), joinToken: "e".repeat(64), sessionId }), source.port, source.address);
    });
    try {
      await withRuntime(async (receiver) => {
        const browserServer = createServer((request, response) => { void receiver.handleHttp(request, response); });
        await new Promise((resolve) => browserServer.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${browserServer.address().port}`;
        const controller = new AbortController();
        const pending = fetch(`${origin}/api/rendezvous/join`, { method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ code: "123456" }),
        }).then(() => "unexpected response", () => "disconnected");
        try {
          await expect.poll(() => receiver.stats().pendingSignals).toBe(1);
          await receiver.stop();
          expect(await pending).toBe("disconnected");
          await expect.poll(() => receiver.stats().activeHttp).toBe(0);
          expect(receiver.stats()).toMatchObject({ pendingSignals: 0, pendingDiscoveries: 0, localJoins: 0 });
        } finally {
          controller.abort();
          browserServer.closeAllConnections();
          await new Promise((resolve) => browserServer.close(resolve));
        }
      }, { getDiscoveryTargets: () => [{ address: "127.0.0.1", port }] });
    } finally {
      peer.closeAllConnections();
      await new Promise((resolve) => peer.close(resolve));
      await new Promise((resolve) => discovery.close(resolve));
    }
  });

  it("allows concurrent stop calls and rejects reuse of a stopped runtime", async () => {
    await withRuntime(async (runtime, port) => {
      await Promise.all([runtime.stop(), runtime.stop(), runtime.stop()]);
      await expect(runtime.start()).rejects.toThrow(/stopped/);
      // A replacement instance must be able to reclaim both transport ports.
      const replacement = createRendezvousRuntime({ signalPort: port });
      try { await replacement.start(); }
      finally { await replacement.stop(); }
    });
  });

  it.each([false, true])("pairs two runtimes through TCP (manual address: %s)", async (manual) => {
    await withRuntime(async (sender, senderPort) => {
      const room = sender.registry.create({ sessionId, sdp: largeSdp });
      await withRuntime(async (receiver) => {
        const server = createServer((request, response) => { void receiver.handleHttp(request, response); });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const post = async (path, body, expectedStatus = 200) => {
          const response = await fetch(`${origin}/api/rendezvous/${path}`, {
            method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
          });
          expect(response.status).toBe(expectedStatus);
          return response.json();
        };
        try {
          if (manual) {
            const rejected = await post("join", { code: room.code === "000000" ? "111111" : "000000", address: `127.0.0.1:${senderPort}` }, 404);
            expect(rejected.error).toContain("pairing code");
            expect(receiver.stats().localJoins).toBe(0);
          }
          const joined = await post("join", { code: room.code, ...(manual ? { address: `127.0.0.1:${senderPort}` } : {}) });
          expect(joined.sdp).toBe(largeSdp);
          expect(await post(`joins/${joined.joinId}/answer`, { sessionId, sdp: largeSdp })).toEqual({ ok: true });
          expect(sender.registry.wait(room.roomId, room.ownerToken)).toEqual({ status: "answered", sessionId, sdp: largeSdp });
          expect(receiver.stats()).toMatchObject({ pendingDiscoveries: 0, pendingSignals: 0, localJoins: 0 });
        } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
      }, { getDiscoveryTargets: () => manual ? [] : [{ address: "127.0.0.1", port: senderPort }] });
    });
  });

  it("accepts only explicit local IPv4 endpoints for manual pairing", () => {
    expect(parseManualEndpoint(" 192.168.1.20:5000 ")).toEqual({ remoteAddress: "192.168.1.20", remotePort: 5000 });
    expect(parseManualEndpoint("172.31.2.5", 4179).remotePort).toBe(4179);
    for (const value of ["https://192.168.1.20", "localhost", "8.8.8.8", "172.32.0.1", "192.168.01.2", "192.168.1.2:0", "192.168.1.2:65536", "[::1]", "127.0.0.1/path", "192.168.1.2@evil", {}, null]) {
      expect(() => parseManualEndpoint(value)).toThrow();
    }
  });

  it("reports TCP conflicts and releases TCP if UDP startup fails", async () => {
    await withRuntime(async (_, port) => {
      const other = createRendezvousRuntime({ signalPort: port });
      await expect(other.start()).rejects.toThrow(/TCP port.*already in use/);
      await other.stop();
    });
    const awaitedPort = await freeSignalPort();
    const socket = dgram.createSocket("udp4");
    await new Promise((resolve) => socket.bind(awaitedPort, "0.0.0.0", resolve));
    const port = socket.address().port;
    const runtime = createRendezvousRuntime({ signalPort: port });
    const probe = createServer();
    try {
      await expect(runtime.start()).rejects.toThrow(/UDP port.*already in use/);
      await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "0.0.0.0", resolve); });
    } finally {
      if (probe.listening) await new Promise((resolve) => probe.close(resolve));
      await runtime.stop();
      await new Promise((resolve) => socket.close(resolve));
    }
  });

  it("keeps discovery below one datagram and exchanges large SDP over TCP", async () => {
    await withRuntime(async (runtime, port) => {
      const room = runtime.registry.create({ sessionId, sdp: largeSdp });
      const socket = dgram.createSocket("udp4");
      try {
        const nonce = "b".repeat(64);
        const discovery = { v: 2, t: "d", requestId: "c".repeat(32), nonce, proof: createDiscoveryProof(room.code, nonce) };
        const received = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Discovery reply timed out")), 2000);
          socket.once("message", (bytes) => { clearTimeout(timer); resolve(bytes); });
        });
        socket.send(JSON.stringify(discovery), port, "127.0.0.1");
        const bytes = await received;
        expect(bytes.length).toBeLessThanOrEqual(1200);
        const advertisement = JSON.parse(bytes.toString());
        expect(advertisement.sdp).toBeUndefined();
        const credentials = { v: 2, roomId: advertisement.roomId, joinToken: advertisement.joinToken, sessionId };
        expect(await rpc(port, { ...credentials, t: "offer" })).toEqual({ sessionId, sdp: largeSdp });
        const answer = largeSdp.replace("a=x:", "a=y:");
        expect(await rpc(port, { ...credentials, t: "answer", sdp: answer })).toEqual({ ok: true, sessionId });
        // A lost response can be retried without changing the accepted answer.
        expect(await rpc(port, { ...credentials, t: "answer", sdp: answer })).toEqual({ ok: true, sessionId });
        await expect(rpc(port, { ...credentials, t: "answer", sdp: largeSdp })).rejects.toThrow(/rejected/);
        expect(runtime.registry.wait(room.roomId, room.ownerToken)).toEqual({ status: "answered", sessionId, sdp: answer });
      } finally { await new Promise((resolve) => socket.close(resolve)); }
    });
  });

  it("rejects wrong credentials, browser requests, expired rooms and legacy messages", async () => {
    await withRuntime(async (runtime, port) => {
      const room = runtime.registry.create({ sessionId, sdp: largeSdp });
      const nonce = "b".repeat(64);
      const claim = runtime.registry.discover({ requestId: "c".repeat(32), nonce,
        proof: createDiscoveryProof(room.code, nonce), address: "127.0.0.1" });
      const credentials = { v: 2, t: "offer", roomId: claim.roomId, joinToken: claim.joinToken, sessionId };
      for (const change of [{ joinToken: "0".repeat(64) }, { sessionId: "0".repeat(32) }, { v: 1 }, { roomId: "0".repeat(32) }]) {
        await expect(rpc(port, { ...credentials, ...change })).rejects.toThrow(/rejected/);
      }
      const response = await fetch(`http://127.0.0.1:${port}/signal/v2`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "http://attacker.example" },
        body: JSON.stringify(credentials),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      // Escaping can expand a valid raw byte budget beyond the wire budget.
      runtime.registry.rooms.get(room.roomId).sdp = "v=0" + "\u0000".repeat(47 * 1024);
      const oversized = await fetch(`http://127.0.0.1:${port}/signal/v2`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials),
      });
      expect(oversized.status).toBe(413);
      expect((await oversized.text()).length).toBeLessThan(100);
      runtime.registry.rooms.get(room.roomId).expiresAt = 0;
      await expect(rpc(port, credentials)).rejects.toThrow(/rejected/);
    });
  });

  it("bounds peer response size, duration, and supports cancellation", async () => {
    const server = createServer((request, response) => {
      if (request.headers["content-length"] === "2") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("x".repeat(65537));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      await expect(rpc(port, {})).rejects.toThrow(/too large/);
      await expect(rpc(port, { wait: true }, { timeoutMs: 30 })).rejects.toThrow(/timed out/);
      const controller = new AbortController();
      const pending = rpc(port, { wait: true }, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  });
});
