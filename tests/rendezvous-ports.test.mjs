import { createServer, Server } from "node:http";
import { createConnection } from "node:net";
import dgram from "node:dgram";
import { afterEach, expect, it, vi } from "vitest";
import { createRendezvousRuntime, DEFAULT_SIGNAL_PORTS, discoveryTargetsFromInterfaces } from "../scripts/rendezvous.mjs";
import { freeSignalPort } from "./free-signal-port.mjs";

afterEach(() => vi.unstubAllEnvs());

async function occupy(transport, port) {
  const listener = transport === "TCP" ? createServer() : dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    if (transport === "TCP") listener.listen(port, "0.0.0.0", resolve);
    else listener.bind(port, "0.0.0.0", resolve);
  });
  return listener;
}

async function freePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await freeSignalPort());
  return [...ports];
}

const close = (listener) => new Promise((resolve) => listener.close(resolve));

async function browserApi(runtime, run) {
  const server = createServer((request, response) => { void runtime.handleHttp(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body = {}) => {
    const response = await fetch(`${origin}/api/rendezvous/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try { return await run(post); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

it.each(["TCP", "UDP"])("automatically starts with the default %s port occupied", async (transport) => {
  vi.stubEnv("QRFT_SIGNAL_PORT", undefined);
  const occupied = await occupy(transport, 4174);
  const runtime = createRendezvousRuntime();
  try {
    await browserApi(runtime, async (post) => {
      expect(await post("health")).toEqual({ status: 200, body: { ready: true, protocol: 2 } });
    });
    expect(DEFAULT_SIGNAL_PORTS.slice(1)).toContain(await runtime.start());
    expect(occupied.address().port).toBe(4174);
  } finally {
    await runtime.stop();
    await new Promise((resolve) => occupied.close(resolve));
  }
});

it.each(["discovery", "explicit address", "bare address"])("pairs across different selected ports using %s", async (method) => {
  const ports = await freePorts(3);
  const occupied = method === "bare address" ? null : await occupy("UDP", ports[0]);
  const options = { signalPorts: ports, getDiscoveryTargets: () => discoveryTargetsFromInterfaces({}, ports) };
  const sender = createRendezvousRuntime(options);
  const receiver = createRendezvousRuntime(options);
  const sessionId = "a".repeat(32);
  const sdp = "v=0\r\na=x:" + "x".repeat(47 * 1024) + "\r\n";
  try {
    const senderPort = await sender.start();
    const receiverPort = await receiver.start();
    expect(senderPort).toBe(ports[occupied ? 1 : 0]);
    expect(receiverPort).toBe(ports[occupied ? 2 : 1]);
    await browserApi(sender, async (send) => {
      const created = await send("rooms", { sessionId, sdp });
      expect(created.status).toBe(201);
      // Every address shown to a user must include the actual selected port.
      for (const address of created.body.addresses) expect(address.endsWith(`:${senderPort}`)).toBe(true);
      await browserApi(receiver, async (receive) => {
        const address = method === "bare address" ? "127.0.0.1" : `127.0.0.1:${senderPort}`;
        const joined = await receive("join", { code: created.body.code, ...(method === "discovery" ? {} : { address }) });
        expect(joined.status).toBe(200);
        expect(joined.body.sdp).toBe(sdp);
        expect(await receive(`joins/${joined.body.joinId}/answer`, { sessionId, sdp })).toEqual({ status: 200, body: { ok: true } });
        expect(await send(`rooms/${created.body.roomId}`, { ownerToken: created.body.ownerToken })).toEqual({ status: 200, body: { status: "answered", sessionId, sdp } });
        expect(receiver.stats()).toMatchObject({ pendingDiscoveries: 0, pendingSignals: 0, localJoins: 0 });
      });
    });
  } finally {
    await Promise.all([sender.stop(), receiver.stop()]);
    if (occupied) await close(occupied);
  }
});

it("releases partial binds when all ports are occupied, then retries after release", async () => {
  const ports = await freePorts(2);
  const tcp = await occupy("TCP", ports[0]);
  const udp = await occupy("UDP", ports[1]);
  let released = false;
  const runtime = createRendezvousRuntime({ signalPorts: ports });
  try {
    await browserApi(runtime, async (post) => {
      const failed = await post("health");
      expect(failed.status).toBe(500);
      expect(failed.body.error).toContain("could not find an available port");
      expect(failed.body.error).not.toContain("QRFT_SIGNAL_PORT");
      const probe = await occupy("TCP", ports[1]);
      await close(probe);
      await close(tcp); released = true;
      expect(await post("health")).toEqual({ status: 200, body: { ready: true, protocol: 2 } });
      expect(await runtime.start()).toBe(ports[0]);
    });
  } finally { await runtime.stop(); if (!released) await close(tcp); await close(udp); }
});

it("drops a stalled TCP request before falling back from a UDP conflict", async () => {
  const ports = await freePorts(2);
  const occupied = await occupy("UDP", ports[0]);
  const originalBind = dgram.Socket.prototype.bind;
  const originalEmit = Server.prototype.emit;
  let client;
  let deferredBind;
  let sawRequest = false;
  let clientClosed = false;
  const bind = vi.spyOn(dgram.Socket.prototype, "bind").mockImplementation(function (...args) {
    if (args[0] !== ports[0]) return Reflect.apply(originalBind, this, args);
    deferredBind = () => Reflect.apply(originalBind, this, args);
    client = createConnection({ host: "127.0.0.1", port: ports[0] });
    client.on("error", () => {});
    client.on("data", () => {});
    client.once("close", () => { clientClosed = true; });
    client.once("connect", () => client.write("POST /signal/v2 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"));
    return this;
  });
  const emit = vi.spyOn(Server.prototype, "emit").mockImplementation(function (event, ...args) {
    const result = Reflect.apply(originalEmit, this, [event, ...args]);
    if (event === "request" && this.address()?.port === ports[0] && deferredBind) {
      sawRequest = true;
      const attempt = deferredBind; deferredBind = undefined;
      queueMicrotask(attempt);
    }
    return result;
  });
  const runtime = createRendezvousRuntime({ signalPorts: ports });
  let timer;
  try {
    const selected = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("A stalled request blocked port fallback")), 2000);
      runtime.start().then(resolve, reject).finally(() => clearTimeout(timer));
    });
    expect(selected).toBe(ports[1]);
    expect(sawRequest).toBe(true);
    await expect.poll(() => clientClosed).toBe(true);
  } finally {
    clearTimeout(timer);
    bind.mockRestore(); emit.mockRestore();
    client?.destroy();
    const finishBind = deferredBind; deferredBind = undefined;
    finishBind?.();
    await runtime.stop();
    await close(occupied);
  }
});

it("shares concurrent startup and releases the fallback port on concurrent shutdown", async () => {
  const ports = await freePorts(2);
  const occupied = await occupy("UDP", ports[0]);
  const runtime = createRendezvousRuntime({ signalPorts: ports });
  try {
    expect(await Promise.all([runtime.start(), runtime.start(), runtime.start()])).toEqual([ports[1], ports[1], ports[1]]);
    await Promise.all([runtime.stop(), runtime.stop(), runtime.stop()]);
    await expect(runtime.start()).rejects.toThrow(/stopped/);
    const replacement = createRendezvousRuntime({ signalPort: ports[1] });
    try { expect(await replacement.start()).toBe(ports[1]); }
    finally { await replacement.stop(); }
  } finally { await runtime.stop(); await close(occupied); }
});

it("shutdown during startup leaves both ports available to a new runtime", async () => {
  const ports = await freePorts(2);
  const runtime = createRendezvousRuntime({ signalPorts: ports });
  const starting = runtime.start();
  const stopping = runtime.stop();
  await expect(starting).rejects.toThrow(/stopped/);
  await stopping;
  for (const port of ports) {
    const replacement = createRendezvousRuntime({ signalPort: port });
    try { expect(await replacement.start()).toBe(port); }
    finally { await replacement.stop(); }
  }
});

it("validates and snapshots a bounded configuration", async () => {
  for (const signalPorts of [[], [1, 2, 3, 4, 5], [4174, 4174], [0], [65536], [NaN], [1.5], ["4174"], null, new Array(1)]) {
    expect(() => createRendezvousRuntime({ signalPorts })).toThrow();
  }
  expect(() => createRendezvousRuntime({ signalPort: 4174, signalPorts: [4175] })).toThrow();
  const ports = await freePorts(1);
  const original = ports[0];
  const runtime = createRendezvousRuntime({ signalPorts: ports });
  ports[0] = 0;
  try { expect(await runtime.start()).toBe(original); }
  finally { await runtime.stop(); }
});

it("keeps an explicitly configured environment port pinned", async () => {
  const port = await freeSignalPort();
  vi.stubEnv("QRFT_SIGNAL_PORT", String(port));
  const occupied = await occupy("TCP", port);
  const runtime = createRendezvousRuntime();
  try { await expect(runtime.start()).rejects.toThrow(`TCP port ${port} is already in use`); }
  finally { await runtime.stop(); await close(occupied); }
});

it("bounds discovery to four ports on loopback and actual adapter broadcasts", () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({ family: "IPv4", internal: false, address: `10.0.${index}.1`, netmask: "255.255.255.0" }));
  const targets = discoveryTargetsFromInterfaces({ Ethernet: entries });
  expect(targets).toHaveLength(33 * 4);
  expect(targets.slice(0, 4)).toEqual(DEFAULT_SIGNAL_PORTS.map((port) => ({ address: "127.0.0.1", port })));
  expect(new Set(targets.slice(4).map(({ address }) => address))).toEqual(new Set(Array.from({ length: 32 }, (_, index) => `10.0.${index}.255`)));
  expect(targets.every(({ port }) => DEFAULT_SIGNAL_PORTS.includes(port))).toBe(true);
});
