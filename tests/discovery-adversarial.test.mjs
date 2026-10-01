import dgram from "node:dgram";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { freeSignalPort } from "./free-signal-port.mjs";
import { createDiscoveryProof, createRendezvousRuntime, readJsonBody } from "../scripts/rendezvous.mjs";
import { exchangeLanSignal } from "../scripts/lan-signaling.mjs";

const sessionId = "a".repeat(32);
const sdp = "v=0\r\na=candidate:1 1 UDP 1 192.168.1.2 5000 typ host\r\n";

async function withObservedRuntime(run, options = {}) {
  const port = await freeSignalPort();
  const runtime = createRendezvousRuntime({ signalPort: port, ...options });
  const nativeCreate = dgram.createSocket.bind(dgram);
  let observation;
  // Attach only a read-only arrival observer; the socket, OS delivery and
  // production handler remain real. Sending alone would not prove arrival.
  const factory = vi.spyOn(dgram, "createSocket").mockImplementation((...args) => {
    const socket = nativeCreate(...args);
    socket.on("message", bytes => observation?.(bytes));
    return socket;
  });
  const client = nativeCreate("udp4");
  let clientBound = false;
  const replies = [];
  let replyObserver;
  client.on("message", bytes => { replies.push(bytes); replyObserver?.(bytes); });
  try {
    await runtime.start();
    factory.mockRestore();
    await new Promise((resolve, reject) => { client.once("error", reject); client.bind(0, "127.0.0.1", resolve); });
    clientBound = true;
    const sendFrom = async (source, bytes) => {
      const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes));
      let timer;
      try {
        const arrived = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Native UDP arrival not observed")), 2000);
          observation = actual => { if (actual.equals(payload)) resolve(); };
        });
        await Promise.all([arrived, new Promise((resolve, reject) => source.send(payload, port, "127.0.0.1", error => error ? reject(error) : resolve()))]);
      } finally { clearTimeout(timer); observation = undefined; }
    };
    const send = bytes => sendFrom(client, bytes);
    const discover = async bytes => {
      let timer;
      try {
        const received = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Discovery response not observed")), 2000);
          replyObserver = bytes => resolve(JSON.parse(bytes.toString()));
        });
        await send(bytes);
        return await received;
      } finally { clearTimeout(timer); replyObserver = undefined; }
    };
    await run({ runtime, port, send, sendFrom, discover, replies });
  } finally {
    factory.mockRestore();
    if (clientBound) await new Promise(resolve => client.close(resolve));
    await runtime.stop();
  }
}

function discovery(room, requestId = "b".repeat(32)) {
  const nonce = "c".repeat(64);
  return { v: 2, t: "d", requestId, nonce, proof: createDiscoveryProof(room.code, nonce) };
}

describe("native UDP discovery hostile input", () => {
  it("ignores a canceled request advertisement during a new attempt and accepts only the current request", async () => {
    const peerPort = await freeSignalPort();
    let tcpRequests = 0;
    const peer = createServer((_request, response) => {
      tcpRequests++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sessionId, sdp }));
    });
    const peerUdp = dgram.createSocket("udp4");
    const requests = [];
    peerUdp.on("message", bytes => requests.push(JSON.parse(bytes.toString())));
    await new Promise(resolve => peer.listen(peerPort, "127.0.0.1", resolve));
    await new Promise(resolve => peerUdp.bind(peerPort, "127.0.0.1", resolve));
    try {
      await withObservedRuntime(async ({ runtime, sendFrom }) => {
        const browserServer = createServer((request, response) => { void runtime.handleHttp(request, response); });
        await new Promise(resolve => browserServer.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${browserServer.address().port}`;
        const firstController = new AbortController();
        const retryController = new AbortController();
        const join = signal => fetch(`${origin}/api/rendezvous/join`, { method: "POST", signal,
          headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ code: "123456" }) });
        const advertise = requestId => ({ v: 2, t: "o", requestId, roomId: "d".repeat(32), joinToken: "e".repeat(64), sessionId });
        try {
          const first = join(firstController.signal).then(() => "unexpected", () => "aborted");
          await expect.poll(() => requests.length).toBeGreaterThan(0);
          const oldId = requests[0].requestId;
          expect(runtime.stats().pendingDiscoveries).toBe(1);
          firstController.abort();
          expect(await first).toBe("aborted");
          await expect.poll(() => runtime.stats().activeHttp).toBe(0);
          expect(runtime.stats()).toMatchObject({ pendingDiscoveries: 0, pendingSignals: 0, localJoins: 0 });
          await sendFrom(peerUdp, advertise(oldId));
          expect(tcpRequests).toBe(0);
          const retry = join(retryController.signal);
          // Keep cleanup aborts observed even if an earlier assertion fails.
          void retry.catch(() => {});
          await expect.poll(() => requests.some(request => request.requestId !== oldId)).toBe(true);
          const currentId = requests.find(request => request.requestId !== oldId).requestId;
          await sendFrom(peerUdp, advertise(oldId));
          expect(runtime.stats()).toMatchObject({ pendingDiscoveries: 1, pendingSignals: 0, localJoins: 0 });
          expect(tcpRequests).toBe(0);
          await sendFrom(peerUdp, advertise(currentId));
          const response = await retry;
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ sessionId, sdp });
          expect(tcpRequests).toBe(1);
          expect(runtime.stats()).toMatchObject({ pendingDiscoveries: 0, pendingSignals: 0, localJoins: 1 });
        } finally {
          firstController.abort(); retryController.abort();
          browserServer.closeAllConnections();
          await new Promise(resolve => browserServer.close(resolve));
        }
      }, { getDiscoveryTargets: () => [{ address: "127.0.0.1", port: peerPort }] });
    } finally {
      await new Promise(resolve => peerUdp.close(resolve));
      peer.closeAllConnections();
      await new Promise(resolve => peer.close(resolve));
    }
  });

  it("ignores malformed packets and oversized authentic discovery, then pairs at exactly1200 bytes", async () => {
    await withObservedRuntime(async ({ runtime, port, send, discover, replies }) => {
      const room = runtime.registry.create({ sessionId, sdp });
      const valid = discovery(room);
      const malformed = [
        Buffer.alloc(0), Buffer.from([0xff, 0xfe]), Buffer.from('{"v":2,'),
        null, true, 42, "discovery", [], {},
        { ...valid, v: 1 }, { ...valid, v: "2" }, { ...valid, t: "unknown" },
        { ...valid, t: null }, { ...valid, requestId: null }, { ...valid, requestId: {} },
        { ...valid, requestId: "B".repeat(32) }, { ...valid, requestId: "b".repeat(31) },
        { ...valid, nonce: [] }, { ...valid, nonce: "c".repeat(63) },
        { ...valid, proof: {} }, { ...valid, proof: "d".repeat(63) },
        { ...valid, proof: "0".repeat(64) },
        { ...valid, t: "o", roomId: [], joinToken: null, sessionId },
        Buffer.from(JSON.stringify(valid).padEnd(1201, " ")),
      ];
      for (const packet of malformed) {
        await send(packet);
        expect(runtime.registry.rooms.get(room.roomId).claim).toBeNull();
        expect(runtime.registry.wait(room.roomId, room.ownerToken).status).toBe("waiting");
      }
      const maximum = Buffer.from(JSON.stringify(valid).padEnd(1200, " "));
      expect(maximum.length).toBe(1200);
      const advertisement = await discover(maximum);
      expect(advertisement).toMatchObject({ v: 2, t: "o", requestId: valid.requestId, roomId: room.roomId, sessionId });
      expect(replies).toHaveLength(1);
      expect(replies[0].length).toBeLessThanOrEqual(1200);
      const duplicate = await discover(maximum);
      expect(duplicate).toEqual(advertisement);
      expect(replies).toHaveLength(2);
      await send(discovery(room, "e".repeat(32)));
      expect(runtime.registry.rooms.get(room.roomId).claim.requestId).toBe(valid.requestId);
      const credentials = { v: 2, roomId: room.roomId, joinToken: advertisement.joinToken, sessionId };
      const rpc = message => exchangeLanSignal({ address: "127.0.0.1", port, message, readBody: readJsonBody });
      expect(await rpc({ ...credentials, t: "offer" })).toEqual({ sessionId, sdp });
      expect(await rpc({ ...credentials, t: "answer", sdp })).toEqual({ ok: true, sessionId });
      expect(runtime.registry.wait(room.roomId, room.ownerToken)).toEqual({ status: "answered", sessionId, sdp });
      expect(runtime.stats()).toMatchObject({ pendingDiscoveries: 0, pendingSignals: 0, localJoins: 0 });
    });
  });

  it("rate-limits after120 real packets and permits a valid claim after controlled window expiry", async () => {
    let time = 1000;
    await withObservedRuntime(async ({ runtime, send, discover, replies }) => {
      const room = runtime.registry.create({ sessionId, sdp });
      const valid = discovery(room);
      const spy = vi.spyOn(runtime.registry, "discover");
      try {
        for (let n = 0; n < 120; n++) await send({ ...valid, requestId: n.toString(16).padStart(32, "0"), proof: "0".repeat(64) });
        expect(spy).toHaveBeenCalledTimes(120);
        await send(valid);
        expect(spy).toHaveBeenCalledTimes(120);
        expect(runtime.registry.rooms.get(room.roomId).claim).toBeNull();
        expect(replies).toHaveLength(0);
        time += 60_000;
        expect(await discover(valid)).toMatchObject({ roomId: room.roomId, sessionId });
        expect(spy).toHaveBeenCalledTimes(121);
        expect(replies).toHaveLength(1);
      } finally { spy.mockRestore(); }
    }, { now: () => time });
  });
});
