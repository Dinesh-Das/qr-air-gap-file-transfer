import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import dgram from "node:dgram";
import { networkInterfaces } from "node:os";

const PROTOCOL_VERSION = 1;
const DEFAULT_ROOM_TTL_MS = 2 * 60_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 12_000;
const DISCOVERY_INTERVAL_MS = 500;
const MAX_ACTIVE_ROOMS = 64;
const MAX_HTTP_BODY_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 48 * 1024;
const MAX_UDP_BYTES = 60 * 1024;
const DISCOVERY_RATE_WINDOW_MS = 60_000;
const DISCOVERY_RATE_LIMIT = 120;

export function isValidPairingCode(value) {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

export function isValidSessionId(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function isValidSdp(value) {
  return typeof value === "string"
    && value.startsWith("v=0")
    && Buffer.byteLength(value, "utf8") > 0
    && Buffer.byteLength(value, "utf8") <= MAX_SDP_BYTES;
}

export function createPairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function createDiscoveryProof(code, nonce) {
  if (!isValidPairingCode(code) || !isHexToken(nonce, 32)) {
    throw new Error("Invalid pairing proof input.");
  }
  return createHash("sha256")
    .update(`airgap-rendezvous-v1\n${nonce}\n${code}`, "utf8")
    .digest("hex");
}

export class RoomRegistry {
  constructor({ ttlMs = DEFAULT_ROOM_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.rooms = new Map();
  }

  create({ sessionId, sdp }) {
    this.cleanup();
    if (!isValidSessionId(sessionId) || !isValidSdp(sdp)) {
      throw new Error("Invalid WebRTC offer.");
    }
    if (this.rooms.size >= MAX_ACTIVE_ROOMS) {
      throw new Error("Too many active pairing rooms. Stop an older transfer and retry.");
    }

    const usedCodes = new Set([...this.rooms.values()].map((room) => room.code));
    let code = "";
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = createPairingCode();
      if (!usedCodes.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error("Unable to allocate a pairing code. Retry the transfer.");

    const room = {
      roomId: token(16),
      ownerToken: token(32),
      code,
      sessionId,
      sdp,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      claim: null,
      answerSdp: null,
    };
    this.rooms.set(room.roomId, room);
    return publicRoom(room);
  }

  discover({ requestId, nonce, proof, address }) {
    this.cleanup();
    if (!isHexToken(requestId, 16) || !isHexToken(nonce, 32) || !isHexToken(proof, 32)) return null;

    for (const room of this.rooms.values()) {
      if (room.answerSdp) continue;
      const expected = createDiscoveryProof(room.code, nonce);
      if (!safeHexEqual(proof, expected)) continue;

      if (room.claim) {
        if (room.claim.requestId !== requestId || room.claim.address !== address) return null;
      } else {
        room.claim = { requestId, address, joinToken: token(32) };
      }
      return {
        roomId: room.roomId,
        joinToken: room.claim.joinToken,
        sessionId: room.sessionId,
        sdp: room.sdp,
      };
    }
    return null;
  }

  acceptAnswer({ roomId, joinToken, sessionId, sdp, address }) {
    this.cleanup();
    const room = this.rooms.get(roomId);
    if (!room || !room.claim) return false;
    if (room.claim.address !== address || room.claim.joinToken !== joinToken) return false;
    if (room.sessionId !== sessionId || !isValidSdp(sdp)) return false;
    if (room.answerSdp && room.answerSdp !== sdp) return false;
    room.answerSdp = sdp;
    return true;
  }

  wait(roomId, ownerToken) {
    this.cleanup();
    const room = this.rooms.get(roomId);
    if (!room || room.ownerToken !== ownerToken) return null;
    return room.answerSdp
      ? { status: "answered", sessionId: room.sessionId, sdp: room.answerSdp }
      : { status: "waiting", expiresAt: room.expiresAt };
  }

  cancel(roomId, ownerToken) {
    const room = this.rooms.get(roomId);
    if (!room || room.ownerToken !== ownerToken) return false;
    this.rooms.delete(roomId);
    return true;
  }

  cleanup() {
    const now = this.now();
    for (const [roomId, room] of this.rooms) {
      if (room.expiresAt <= now) this.rooms.delete(roomId);
    }
  }
}

export function createRendezvousRuntime({
  signalPort = Number(process.env.QRFT_SIGNAL_PORT ?? "4174"),
  roomTtlMs = DEFAULT_ROOM_TTL_MS,
  discoveryTimeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(signalPort) || signalPort < 1 || signalPort > 65_535) {
    throw new Error("QRFT_SIGNAL_PORT must be an integer from 1 to 65535.");
  }

  const registry = new RoomRegistry({ ttlMs: roomTtlMs });
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
  const pendingDiscoveries = new Map();
  const pendingAnswers = new Map();
  const localJoins = new Map();
  const discoveryRates = new Map();
  let startPromise = null;
  let started = false;

  socket.on("message", (buffer, rinfo) => {
    if (buffer.byteLength > MAX_UDP_BYTES) return;
    let message;
    try {
      message = JSON.parse(buffer.toString("utf8"));
    } catch {
      return;
    }
    if (!message || message.v !== PROTOCOL_VERSION || typeof message.t !== "string") return;

    if (message.t === "d") {
      if (!allowDiscovery(rinfo.address, message.requestId, discoveryRates)) return;
      const offer = registry.discover({
        requestId: message.requestId,
        nonce: message.nonce,
        proof: message.proof,
        address: rinfo.address,
      });
      if (!offer) return;
      sendUdp(socket, rinfo.address, rinfo.port, {
        v: PROTOCOL_VERSION,
        t: "o",
        requestId: message.requestId,
        ...offer,
      });
      return;
    }

    if (message.t === "o") {
      const pending = pendingDiscoveries.get(message.requestId);
      if (!pending || !isHexToken(message.roomId, 16) || !isHexToken(message.joinToken, 32)
        || !isValidSessionId(message.sessionId) || !isValidSdp(message.sdp)) return;
      pending.resolve({
        remoteAddress: rinfo.address,
        remotePort: rinfo.port,
        roomId: message.roomId,
        joinToken: message.joinToken,
        sessionId: message.sessionId,
        sdp: message.sdp,
      });
      return;
    }

    if (message.t === "a") {
      if (!isHexToken(message.answerId, 16)) return;
      const accepted = registry.acceptAnswer({
        roomId: message.roomId,
        joinToken: message.joinToken,
        sessionId: message.sessionId,
        sdp: message.sdp,
        address: rinfo.address,
      });
      if (!accepted) return;
      sendUdp(socket, rinfo.address, rinfo.port, {
        v: PROTOCOL_VERSION,
        t: "k",
        answerId: message.answerId,
      });
      return;
    }

    if (message.t === "k") {
      pendingAnswers.get(message.answerId)?.resolve();
    }
  });

  socket.on("error", (error) => {
    if (!started && startPromise) return;
    for (const pending of pendingDiscoveries.values()) pending.reject(error);
    for (const pending of pendingAnswers.values()) pending.reject(error);
  });

  async function start() {
    if (started) return;
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        socket.off("listening", onListening);
        startPromise = null;
        reject(error?.code === "EADDRINUSE"
          ? new Error(`LAN pairing UDP port ${signalPort} is already in use. Close the other AirGap runtime or set QRFT_SIGNAL_PORT to the same free port on both devices.`)
          : error);
      };
      const onListening = () => {
        socket.off("error", onError);
        socket.setBroadcast(true);
        started = true;
        resolve();
      };
      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind(signalPort, "0.0.0.0");
    });
    return startPromise;
  }

  async function stop() {
    for (const pending of pendingDiscoveries.values()) pending.reject(new Error("Pairing service stopped."));
    for (const pending of pendingAnswers.values()) pending.reject(new Error("Pairing service stopped."));
    pendingDiscoveries.clear();
    pendingAnswers.clear();
    localJoins.clear();
    if (!started) return;
    await new Promise((resolve) => socket.close(resolve));
    started = false;
    startPromise = null;
  }

  async function handleHttp(request, response) {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = requestUrl.pathname;
    if (!path.startsWith("/api/rendezvous/")) return false;

    try {
      await start();
      if (request.method === "POST" && path === "/api/rendezvous/rooms") {
        const body = await readJsonBody(request);
        const room = registry.create({ sessionId: body.sessionId, sdp: body.sdp });
        json(response, 201, room);
        return true;
      }

      const roomMatch = path.match(/^\/api\/rendezvous\/rooms\/([0-9a-f]{32})$/);
      if (roomMatch && request.method === "POST") {
        const body = await readJsonBody(request);
        const result = registry.wait(roomMatch[1], body.ownerToken);
        if (!result) json(response, 404, { error: "Pairing room not found or expired." });
        else json(response, 200, result);
        return true;
      }
      if (roomMatch && request.method === "DELETE") {
        const body = await readJsonBody(request);
        const deleted = registry.cancel(roomMatch[1], body.ownerToken);
        json(response, deleted ? 200 : 404, deleted ? { ok: true } : { error: "Pairing room not found." });
        return true;
      }

      if (request.method === "POST" && path === "/api/rendezvous/join") {
        const body = await readJsonBody(request);
        if (!isValidPairingCode(body.code)) {
          json(response, 400, { error: "Enter the six-digit pairing code shown on the sender." });
          return true;
        }
        const remote = await discoverRemoteRoom(body.code);
        const joinId = token(16);
        localJoins.set(joinId, { ...remote, expiresAt: Date.now() + 30_000 });
        json(response, 200, { joinId, sessionId: remote.sessionId, sdp: remote.sdp });
        return true;
      }

      const joinMatch = path.match(/^\/api\/rendezvous\/joins\/([0-9a-f]{32})\/answer$/);
      if (joinMatch && request.method === "POST") {
        const join = localJoins.get(joinMatch[1]);
        if (!join || join.expiresAt <= Date.now()) {
          localJoins.delete(joinMatch[1]);
          json(response, 404, { error: "The pairing attempt expired. Enter the code again." });
          return true;
        }
        const body = await readJsonBody(request);
        if (body.sessionId !== join.sessionId || !isValidSdp(body.sdp)) {
          json(response, 400, { error: "Invalid WebRTC answer." });
          return true;
        }
        await publishRemoteAnswer(join, body.sdp);
        localJoins.delete(joinMatch[1]);
        json(response, 200, { ok: true });
        return true;
      }

      json(response, 404, { error: "Pairing endpoint not found." });
      return true;
    } catch (error) {
      json(response, statusForError(error), { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  function discoverRemoteRoom(code) {
    const requestId = token(16);
    const nonce = token(32);
    const proof = createDiscoveryProof(code, nonce);
    return new Promise((resolve, reject) => {
      let settled = false;
      let interval;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        clearTimeout(timeout);
        pendingDiscoveries.delete(requestId);
        callback(value);
      };
      const pending = {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      };
      pendingDiscoveries.set(requestId, pending);
      const announce = () => broadcast(socket, signalPort, {
        v: PROTOCOL_VERSION,
        t: "d",
        requestId,
        nonce,
        proof,
      });
      interval = setInterval(announce, DISCOVERY_INTERVAL_MS);
      const timeout = setTimeout(() => {
        finish(reject, new Error("No sender was found for that code. Check the code, Wi-Fi, and firewall, then retry."));
      }, discoveryTimeoutMs);
      announce();
    });
  }

  function publishRemoteAnswer(join, sdp) {
    const answerId = token(16);
    return new Promise((resolve, reject) => {
      let settled = false;
      let interval;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        clearTimeout(timeout);
        pendingAnswers.delete(answerId);
        callback(value);
      };
      pendingAnswers.set(answerId, {
        resolve: () => finish(resolve),
        reject: (error) => finish(reject, error),
      });
      const send = () => sendUdp(socket, join.remoteAddress, join.remotePort, {
        v: PROTOCOL_VERSION,
        t: "a",
        answerId,
        roomId: join.roomId,
        joinToken: join.joinToken,
        sessionId: join.sessionId,
        sdp,
      });
      interval = setInterval(send, DISCOVERY_INTERVAL_MS);
      const timeout = setTimeout(() => {
        finish(reject, new Error("The sender did not acknowledge the connection answer. Check the local network and retry."));
      }, 6_000);
      send();
    });
  }

  return { start, stop, handleHttp, registry };
}

function publicRoom(room) {
  return {
    roomId: room.roomId,
    ownerToken: room.ownerToken,
    code: room.code,
    expiresAt: room.expiresAt,
  };
}

function token(bytes) {
  return randomBytes(bytes).toString("hex");
}

function isHexToken(value, bytes) {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);
}

function safeHexEqual(left, right) {
  if (!isHexToken(left, 32) || !isHexToken(right, 32)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function allowDiscovery(address, requestId, rates) {
  const now = Date.now();
  let entry = rates.get(address);
  if (!entry || now - entry.startedAt >= DISCOVERY_RATE_WINDOW_MS) {
    entry = { startedAt: now, count: 0 };
    rates.set(address, entry);
  }
  if (!isHexToken(requestId, 16)) return false;
  entry.count += 1;
  return entry.count <= DISCOVERY_RATE_LIMIT;
}

function broadcast(socket, port, message) {
  for (const address of broadcastAddresses()) sendUdp(socket, address, port, message);
}

function broadcastAddresses() {
  const addresses = new Set(["255.255.255.255"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const info of entries ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      const broadcast = calculateBroadcastAddress(info.address, info.netmask);
      if (broadcast) addresses.add(broadcast);
    }
  }
  return addresses;
}

function calculateBroadcastAddress(address, netmask) {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  if (ip === null || mask === null) return null;
  return intToIpv4(((ip & mask) | (~mask >>> 0)) >>> 0);
}

function ipv4ToInt(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

function intToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function sendUdp(socket, address, port, message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > MAX_UDP_BYTES) return;
  socket.send(payload, port, address, () => undefined);
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_HTTP_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(chunk);
  }
  if (length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new BadRequestError("Request body must be a JSON object.");
  }
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function statusForError(error) {
  if (error instanceof BadRequestError) return 400;
  if (error instanceof PayloadTooLargeError) return 413;
  return 500;
}

class BadRequestError extends Error {}
class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
  }
}
