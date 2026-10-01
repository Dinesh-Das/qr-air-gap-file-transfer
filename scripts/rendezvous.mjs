import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createLanSignalingServer, exchangeLanSignal } from "./lan-signaling.mjs";
import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { assertLocalRequest, LocalHttpError } from "./local-http-security.mjs";

const PROTOCOL_VERSION = 2;
const DEFAULT_ROOM_TTL_MS = 2 * 60_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 12_000;
const DISCOVERY_INTERVAL_MS = 500;
const MAX_ACTIVE_ROOMS = 64;
const MAX_HTTP_BODY_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 48 * 1024;
const MAX_UDP_BYTES = 1200;
const DISCOVERY_RATE_WINDOW_MS = 60_000;
const DISCOVERY_RATE_LIMIT = 120;
const MAX_DISCOVERY_BROADCASTS = 32;
export const DEFAULT_SIGNAL_PORTS = Object.freeze([4174, 4175, 4176, 4177]);
const LOCAL_JOIN_ADDRESS = "127.0.0.1";
const MAX_PENDING_REQUESTS = 32;
const MAX_LOCAL_JOINS = 64;
const MAX_RATE_ENTRIES = 1024;

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

export function parseManualEndpoint(value, defaultPort = 4174) {
  if (typeof value !== "string" || value.length > 64) throw new BadRequestError("Enter the sender's local IPv4 address and optional port.");
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::([1-9]\d{0,4}))?$/.exec(value.trim());
  const ip = match ? ipv4ToInt(match[1]) : null;
  const port = match?.[2] ? Number(match[2]) : defaultPort;
  const local = ip !== null && ((ip >>> 24) === 10 || (ip >>> 20) === 0xac1
    || (ip >>> 16) === 0xc0a8 || (ip >>> 16) === 0xa9fe || ip === 0x7f000001);
  if (!local || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BadRequestError("Use the sender's local IPv4 address, for example 192.168.1.20:4174. URLs and public addresses are not supported.");
  }
  return { remoteAddress: match[1], remotePort: port };
}

function manualAddresses(port) {
  const addresses = new Set();
  for (const entries of Object.values(networkInterfaces())) {
    for (const info of entries ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      try { parseManualEndpoint(info.address, port); }
      catch { continue; }
      if (addresses.size < 32) addresses.add(`${info.address}:${port}`);
    }
  }
  return [...addresses];
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

  getOffer({ roomId, joinToken, sessionId, address }) {
    this.cleanup();
    const room = this.rooms.get(roomId);
    if (!room?.claim || room.claim.address !== address || room.sessionId !== sessionId
      || !safeHexEqual(room.claim.joinToken, joinToken)) return null;
    return { sessionId: room.sessionId, sdp: room.sdp };
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
  signalPort,
  signalPorts,
  roomTtlMs = DEFAULT_ROOM_TTL_MS,
  discoveryTimeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  now = () => Date.now(),
  cleanupIntervalMs = 5_000,
  getDiscoveryTargets,
} = {}) {
  if (signalPort !== undefined && signalPorts !== undefined) throw new Error("Choose either one pairing port or a bounded port list.");
  const configured = signalPorts !== undefined ? signalPorts : (signalPort !== undefined ? [signalPort]
    : process.env.QRFT_SIGNAL_PORT === undefined ? DEFAULT_SIGNAL_PORTS : [Number(process.env.QRFT_SIGNAL_PORT)]);
  const ports = validateSignalPorts(configured);
  getDiscoveryTargets ??= () => discoveryTargetsFromInterfaces(networkInterfaces(), ports);

  if (!Number.isFinite(cleanupIntervalMs) || cleanupIntervalMs < 1 || cleanupIntervalMs > 60_000) {
    throw new Error("Invalid pairing cleanup interval.");
  }
  const registry = new RoomRegistry({ ttlMs: roomTtlMs, now });
  let socket = null;
  let boundPort = null;
  const pendingDiscoveries = new Map();
  const pendingSignals = new Map();
  const localJoins = new Map();
  const discoveryRates = new Map();
  let startPromise = null;
  let stopPromise = null;
  const httpRequests = new Set();
  let started = false;
  let activeHttp = 0;
  let cleanupTimer;

  function cleanup() {
    registry.cleanup();
    const time = now();
    for (const [id, join] of localJoins) if (join.expiresAt <= time) localJoins.delete(id);
    for (const [address, rate] of discoveryRates) {
      if (time - rate.startedAt >= DISCOVERY_RATE_WINDOW_MS) discoveryRates.delete(address);
    }
  }

  const lanServer = createLanSignalingServer({ readBody: readJsonBody, handleMessage: (message, address) => {
    if (message.v !== PROTOCOL_VERSION) return null;
    if (message.t === "discover") {
      if (!allowDiscovery(address, message.requestId, discoveryRates, now())) return null;
      return registry.discover({ ...message, address });
    }
    if (message.t === "offer") return registry.getOffer({ ...message, address });
    if (message.t === "answer" && registry.acceptAnswer({ ...message, address })) {
      return { ok: true, sessionId: message.sessionId };
    }
    return null;
  } });

  function createSocket() {
    const current = dgram.createSocket({ type: "udp4", reuseAddr: false });
    current.on("message", (buffer, rinfo) => {
      if (!started || stopPromise || current !== socket || buffer.byteLength > MAX_UDP_BYTES) return;
      let message;
      try {
        message = JSON.parse(buffer.toString("utf8"));
      } catch {
        return;
      }
      if (!message || message.v !== PROTOCOL_VERSION || typeof message.t !== "string") return;

      if (message.t === "d") {
        if (!allowDiscovery(rinfo.address, message.requestId, discoveryRates, now())) return;
        const offer = registry.discover({
          requestId: message.requestId,
          nonce: message.nonce,
          proof: message.proof,
          address: rinfo.address,
        });
        if (!offer) return;
        sendUdp(current, rinfo.address, rinfo.port, {
          v: PROTOCOL_VERSION,
          t: "o",
          requestId: message.requestId,
          roomId: offer.roomId, joinToken: offer.joinToken, sessionId: offer.sessionId,
        });
        return;
      }

      if (message.t === "o") {
        const pending = pendingDiscoveries.get(message.requestId);
        if (!pending || !isHexToken(message.roomId, 16) || !isHexToken(message.joinToken, 32)
          || !isValidSessionId(message.sessionId)) return;
        pending.resolve({
          remoteAddress: rinfo.address,
          remotePort: rinfo.port,
          roomId: message.roomId,
          joinToken: message.joinToken,
          sessionId: message.sessionId,
        });
        return;
      }

    });

    current.on("error", (error) => {
      if (current !== socket || (!started && startPromise)) return;
      for (const pending of pendingDiscoveries.values()) pending.reject(error);
      for (const pending of pendingSignals.values()) pending.reject(error);
    });
    return current;
  }

  async function closeTransports() {
    // Close the listener before dropping accepted connections, so a failed
    // attempt cannot keep a port alive through a stalled incoming request.
    const closing = [];
    if (lanServer.listening) {
      closing.push(new Promise((resolve) => lanServer.close(resolve)));
      lanServer.closeAllConnections();
    }
    const current = socket;
    socket = null;
    if (current) closing.push(new Promise((resolve, reject) => {
      try { current.close(resolve); }
      catch (error) { if (error.code === "ERR_SOCKET_DGRAM_NOT_RUNNING") resolve(); else reject(error); }
    }));
    await Promise.all(closing);
  }

  async function start() {
    if (stopPromise) throw new Error("Pairing service has stopped. Start a new runtime.");
    if (started) return boundPort;
    if (startPromise) return startPromise;
    startPromise = (async () => {
      let lastError;
      for (const port of ports) {
        if (stopPromise) throw new Error("Pairing service has stopped. Start a new runtime.");
        let transport = "TCP";
        try {
          await new Promise((resolve, reject) => {
            const failed = (error) => { lanServer.off("listening", listening); reject(error); };
            const listening = () => { lanServer.off("error", failed); resolve(); };
            lanServer.once("error", failed);
            lanServer.once("listening", listening);
            lanServer.listen(port, "0.0.0.0");
          });
          transport = "UDP";
          socket = createSocket();
          await new Promise((resolve, reject) => {
            const current = socket;
            const failed = (error) => { current.off("listening", listening); reject(error); };
            const listening = () => { current.off("error", failed); resolve(); };
            current.once("error", failed);
            current.once("listening", listening);
            current.bind(port, "0.0.0.0");
          });
          socket.setBroadcast(true);
          if (stopPromise) throw new Error("Pairing service has stopped. Start a new runtime.");
          boundPort = port;
          started = true;
          cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
          cleanupTimer.unref();
          return boundPort;
        } catch (error) {
          await closeTransports();
          if (stopPromise) throw new Error("Pairing service has stopped. Start a new runtime.");
          if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
          lastError = new Error(`LAN pairing ${transport} port ${port} is ${error.code === "EADDRINUSE" ? "already in use" : "not available"}. Close other copies of the app and retry.`, { cause: error });
        }
      }
      if (ports.length === 1) throw lastError;
      throw new Error("The local connection service could not find an available port. Close other copies of the app and retry. If it still fails, reopen the app using its launcher.", { cause: lastError });
    })().catch((error) => { startPromise = null; throw error; });
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    // Set the terminal state synchronously, before any awaited startup/close.
    stopPromise = Promise.resolve().then(async () => {
      if (startPromise && !started) await startPromise.catch(() => undefined);
      clearInterval(cleanupTimer);
      const error = new Error("Pairing service stopped.");
      for (const pending of httpRequests) {
        pending.abort.abort(error);
        pending.request.destroy();
        pending.response.destroy();
      }
      for (const pending of pendingDiscoveries.values()) pending.reject(error);
      for (const pending of pendingSignals.values()) pending.reject(error);
      pendingDiscoveries.clear();
      pendingSignals.clear();
      localJoins.clear();
      discoveryRates.clear();
      registry.rooms.clear();
      await closeTransports();
      started = false;
      boundPort = null;
      startPromise = null;
    });
    return stopPromise;
  }

  async function handleHttp(request, response) {
    const path = (request.url ?? "/").split("?", 1)[0];
    if (!path.startsWith("/api/rendezvous/")) return false;

    if (activeHttp >= 32) {
      json(response, 503, { error: "The local pairing service is busy. Retry shortly." });
      return true;
    }
    activeHttp += 1;
    const abort = new AbortController();
    const activeRequest = { abort, request, response };
    httpRequests.add(activeRequest);
    const readRequestBody = async () => {
      const body = await readJsonBody(request);
      abort.signal.throwIfAborted();
      if (stopPromise) throw new Error("Pairing service stopped.");
      return body;
    };
    const disconnected = () => { if (!response.writableEnded) abort.abort(new Error("Pairing request disconnected.")); };
    response.once("close", disconnected);
    try {
      assertLocalRequest(request);
      if (request.method !== "POST" && request.method !== "DELETE") {
        throw new LocalHttpError("Pairing endpoint does not accept this method.", 405);
      }
      assertLocalRequest(request, { mutation: true });
      if (request.method === "POST" && path === "/api/rendezvous/health") {
        const body = await readRequestBody();
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) throw new BadRequestError("Invalid connection check.");
        await start();
        abort.signal.throwIfAborted();
        if (stopPromise) throw new Error("Pairing service stopped.");
        // Binding both transports is required. Do not return interface addresses,
        // room credentials, or a claim about firewall/remote-device reachability.
        json(response, 200, { ready: true, protocol: 2 });
        return true;
      }
      cleanup();
      await start();
      abort.signal.throwIfAborted();
      if (stopPromise) throw new Error("Pairing service stopped.");
      if (request.method === "POST" && path === "/api/rendezvous/rooms") {
        const body = await readRequestBody();
        if (!isValidSessionId(body.sessionId) || !isValidSdp(body.sdp)) throw new BadRequestError("Invalid WebRTC offer.");
        const room = registry.create({ sessionId: body.sessionId, sdp: body.sdp });
        json(response, 201, { ...room, addresses: manualAddresses(boundPort) });
        return true;
      }

      const roomMatch = path.match(/^\/api\/rendezvous\/rooms\/([0-9a-f]{32})$/);
      if (roomMatch && request.method === "POST") {
        const body = await readRequestBody();
        const result = registry.wait(roomMatch[1], body.ownerToken);
        if (!result) json(response, 404, { error: "Pairing room not found or expired." });
        else json(response, 200, result);
        return true;
      }
      if (roomMatch && request.method === "DELETE") {
        const body = await readRequestBody();
        const deleted = registry.cancel(roomMatch[1], body.ownerToken);
        json(response, deleted ? 200 : 404, deleted ? { ok: true } : { error: "Pairing room not found." });
        return true;
      }

      if (request.method === "POST" && path === "/api/rendezvous/join") {
        if (localJoins.size >= MAX_LOCAL_JOINS) throw new ServiceBusyError();
        const body = await readRequestBody();
        if (!isValidPairingCode(body.code)) {
          json(response, 400, { error: "Enter the six-digit pairing code shown on the sender." });
          return true;
        }
        let remote;
        if (body.address !== undefined && body.address !== "") {
          const endpoint = parseManualEndpoint(body.address, ports[0]);
          const nonce = token(32);
          const offer = await remoteSignal(endpoint, { t: "discover", requestId: token(16), nonce,
            proof: createDiscoveryProof(body.code, nonce) }, abort.signal);
          if (!isHexToken(offer.roomId, 16) || !isHexToken(offer.joinToken, 32)
            || !isValidSessionId(offer.sessionId) || !isValidSdp(offer.sdp)) throw new BadRequestError("Invalid peer offer.");
          remote = { ...endpoint, roomId: offer.roomId, joinToken: offer.joinToken, sessionId: offer.sessionId, sdp: offer.sdp };
        } else { remote = discoverLocalRoom(body.code); }
        if (!remote) {
          remote = await discoverRemoteRoom(body.code, abort.signal);
          const offer = await remoteSignal(remote, { t: "offer" }, abort.signal);
          if (offer.sessionId !== remote.sessionId || !isValidSdp(offer.sdp)) throw new BadRequestError("Invalid peer offer.");
          remote = { ...remote, sdp: offer.sdp };
        }
        if (localJoins.size >= MAX_LOCAL_JOINS) throw new ServiceBusyError();
        const joinId = token(16);
        localJoins.set(joinId, { ...remote, expiresAt: now() + 30_000 });
        json(response, 200, { joinId, sessionId: remote.sessionId, sdp: remote.sdp });
        return true;
      }

      const joinMatch = path.match(/^\/api\/rendezvous\/joins\/([0-9a-f]{32})\/answer$/);
      if (joinMatch && request.method === "POST") {
        const join = localJoins.get(joinMatch[1]);
        if (!join || join.expiresAt <= now()) {
          localJoins.delete(joinMatch[1]);
          json(response, 404, { error: "The pairing attempt expired. Enter the code again." });
          return true;
        }
        const body = await readRequestBody();
        if (body.sessionId !== join.sessionId || !isValidSdp(body.sdp)) {
          json(response, 400, { error: "Invalid WebRTC answer." });
          return true;
        }
        await publishRemoteAnswer(join, body.sdp, abort.signal);
        localJoins.delete(joinMatch[1]);
        json(response, 200, { ok: true });
        return true;
      }

      json(response, 404, { error: "Pairing endpoint not found." });
      return true;
    } catch (error) {
      if (response.destroyed) return true;
      response.setHeader("Connection", "close");
      json(response, statusForError(error), { error: error instanceof Error ? error.message : String(error) });
      return true;
    } finally {
      response.off("close", disconnected);
      httpRequests.delete(activeRequest);
      activeHttp -= 1;
    }
  }

  function discoverLocalRoom(code) {
    const requestId = token(16);
    const nonce = token(32);
    const offer = registry.discover({
      requestId,
      nonce,
      proof: createDiscoveryProof(code, nonce),
      address: LOCAL_JOIN_ADDRESS,
    });
    return offer ? { ...offer, local: true } : null;
  }

  function discoverRemoteRoom(code, signal) {
    signal.throwIfAborted();
    if (pendingDiscoveries.size >= MAX_PENDING_REQUESTS) throw new ServiceBusyError();
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
        signal.removeEventListener("abort", onAbort);
        pendingDiscoveries.delete(requestId);
        callback(value);
      };
      const onAbort = () => finish(reject, signal.reason);
      const pending = {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      };
      pendingDiscoveries.set(requestId, pending);
      const discoveryMessage = {
        v: PROTOCOL_VERSION,
        t: "d",
        requestId,
        nonce,
        proof,
      };
      const announce = () => {
        for (const target of getDiscoveryTargets()) sendUdp(socket, target.address, target.port, discoveryMessage);
      };
      interval = setInterval(announce, DISCOVERY_INTERVAL_MS);
      const timeout = setTimeout(() => {
        finish(reject, new PairingNotFoundError("No sender was found for that code. Check the code and confirm both devices are on the same Wi-Fi or hotspot, then retry."));
      }, discoveryTimeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      announce();
    });
  }

  function publishRemoteAnswer(join, sdp, signal) {
    signal.throwIfAborted();
    if (join.local) {
      const accepted = registry.acceptAnswer({
        roomId: join.roomId,
        joinToken: join.joinToken,
        sessionId: join.sessionId,
        sdp,
        address: LOCAL_JOIN_ADDRESS,
      });
      if (!accepted) return Promise.reject(new Error("The sender did not accept the connection answer."));
      return Promise.resolve();
    }

    return remoteSignal(join, { t: "answer", sdp }, signal).then((answer) => {
      if (answer.ok !== true || answer.sessionId !== join.sessionId) throw new Error("Invalid LAN signaling acknowledgment.");
    });
  }

  async function remoteSignal(join, message, signal) {
    signal.throwIfAborted();
    if (pendingSignals.size >= MAX_PENDING_REQUESTS) throw new ServiceBusyError();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    const id = token(16);
    pendingSignals.set(id, { reject: (error) => controller.abort(error) });
    try {
      return await exchangeLanSignal({ address: join.remoteAddress, port: join.remotePort,
        signal: controller.signal, readBody: readJsonBody,
        message: { v: PROTOCOL_VERSION, ...message, roomId: join.roomId,
          joinToken: join.joinToken, sessionId: join.sessionId } });
    } finally {
      signal.removeEventListener("abort", cancel);
      pendingSignals.delete(id);
    }
  }

  // Counts only: useful for tests/preflight without exposing interfaces or keys.
  const stats = () => ({ rooms: registry.rooms.size, localJoins: localJoins.size,
    discoveryRates: discoveryRates.size, pendingDiscoveries: pendingDiscoveries.size,
    pendingSignals: pendingSignals.size, activeHttp });
  return { start, stop, handleHttp, registry, stats };
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

export function allowDiscovery(address, requestId, rates, now = Date.now()) {
  if (!isHexToken(requestId, 16)) return false;
  let entry = rates.get(address);
  if (!entry || now - entry.startedAt >= DISCOVERY_RATE_WINDOW_MS) {
    if (!entry && rates.size >= MAX_RATE_ENTRIES) return false;
    entry = { startedAt: now, count: 0 };
    rates.set(address, entry);
  }
  entry.count += 1;
  return entry.count <= DISCOVERY_RATE_LIMIT;
}

// Use the actual subnets of every adapter, including hotspot/virtual adapters.
// Never enumerate hosts or assume a /24 from an interface's address.
export function broadcastAddressesFromInterfaces(interfaces) {
  const addresses = new Set();
  for (const entries of Object.values(interfaces ?? {})) {
    for (const info of entries ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      const address = calculateBroadcastAddress(info.address, info.netmask);
      if (address && addresses.size < MAX_DISCOVERY_BROADCASTS) addresses.add(address);
    }
  }
  return [...addresses];
}

function validateSignalPorts(values) {
  const message = "Pairing ports must be one to four unique integers from 1 to 65535. QRFT_SIGNAL_PORT pins one port when configured.";
  if (!Array.isArray(values) || values.length < 1 || values.length > DEFAULT_SIGNAL_PORTS.length) throw new Error(message);
  // Copy before validation; spread also turns sparse entries into undefined.
  const ports = [...values];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
    || new Set(ports).size !== ports.length) {
    throw new Error(message);
  }
  return Object.freeze(ports);
}

export function discoveryTargetsFromInterfaces(interfaces, values = DEFAULT_SIGNAL_PORTS) {
  const ports = validateSignalPorts(values);
  // At most four service ports on loopback and 32 actual subnet broadcasts.
  // This does not enumerate the hosts on any subnet.
  return [LOCAL_JOIN_ADDRESS, ...broadcastAddressesFromInterfaces(interfaces)]
    .flatMap((address) => ports.map((port) => ({ address, port })));
}

export function calculateBroadcastAddress(address, netmask) {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  if (ip === null || mask === null) return null;
  // Reject unspecified, loopback, multicast and reserved address ranges.
  const firstOctet = ip >>> 24;
  if (firstOctet === 0 || firstOctet === 127 || firstOctet >= 224) return null;
  const hostMask = (~mask) >>> 0;
  // Only contiguous masks with at least two host bits support this discovery.
  // /31 and /32 are point-to-point/host routes, not broadcast networks.
  if (mask === 0 || hostMask < 3 || (hostMask & (hostMask + 1)) !== 0) return null;
  const host = (ip & hostMask) >>> 0;
  if (host === 0 || host === hostMask) return null;
  return intToIpv4(((ip & mask) | hostMask) >>> 0);
}

function ipv4ToInt(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
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

export async function readJsonBody(request, { timeoutMs = 10_000 } = {}) {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined && Number(declaredLength) > MAX_HTTP_BODY_BYTES) throw new PayloadTooLargeError();
  const bytes = await new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(MAX_HTTP_BODY_BYTES);
    let length = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", failed);
      request.off("aborted", aborted);
    };
    const failed = (error) => { cleanup(); request.pause(); reject(error); };
    const aborted = () => failed(new BadRequestError("The request body was interrupted."));
    const data = (chunk) => {
      if (length + chunk.length > MAX_HTTP_BODY_BYTES) { failed(new PayloadTooLargeError()); return; }
      chunk.copy(buffer, length);
      length += chunk.length;
    };
    const end = () => { cleanup(); resolve(buffer.subarray(0, length)); };
    const timer = setTimeout(() => failed(new LocalHttpError("The request body timed out. Retry the request.", 408)), timeoutMs);
    timer.unref();
    request.on("data", data);
    request.once("end", end);
    request.once("error", failed);
    request.once("aborted", aborted);
    if (request.destroyed) aborted();
  });
  const length = bytes.length;
  if (length === 0) return {};
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
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
  if (error instanceof ServiceBusyError) return 503;
  if (error instanceof LocalHttpError) return error.status;
  if (error instanceof BadRequestError) return 400;
  if (error instanceof PairingNotFoundError) return 404;
  if (error instanceof PayloadTooLargeError) return 413;
  return 500;
}

class BadRequestError extends Error {}
class ServiceBusyError extends Error {
  constructor() { super("The local pairing service is busy. Wait briefly and retry."); }
}
class PairingNotFoundError extends Error {}
class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
  }
}
