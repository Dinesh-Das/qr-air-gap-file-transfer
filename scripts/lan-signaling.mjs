import { createServer, request as httpRequest } from "node:http";
import { isIPv4 } from "node:net";
import { configureLocalHttpServer, LocalHttpError } from "./local-http-security.mjs";

// Separate from the loopback application server: no assets, room creation or
// browser API are exposed here. Every operation must carry a claimed room token.
export function createLanSignalingServer({ readBody, handleMessage }) {
  let active = 0;
  return configureLocalHttpServer(createServer(async (request, response) => {
    const reply = (status, value) => {
      if (response.destroyed) return;
      let body = JSON.stringify(value);
      if (Buffer.byteLength(body) > 64 * 1024) {
        status = 413;
        body = JSON.stringify({ error: "Signaling response is too large." });
      }
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store",
        "Connection": "close", "X-Content-Type-Options": "nosniff" });
      response.end(body);
    };
    if (active >= 32) { reply(503, { error: "Pairing service is busy." }); return; }
    active += 1;
    try {
      if (request.method !== "POST" || request.url !== "/signal/v2") throw new LocalHttpError("Unknown signaling endpoint.", 404);
      if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined) {
        throw new LocalHttpError("Browser requests are not accepted by the LAN endpoint.");
      }
      if (request.headers["content-type"] !== "application/json" || request.headers["content-encoding"] !== undefined) {
        throw new LocalHttpError("Expected unencoded JSON.", 415);
      }
      const body = await readBody(request);
      if (response.destroyed) return;
      const result = handleMessage(body, request.socket.remoteAddress);
      if (!result) throw new LocalHttpError("Pairing credentials are invalid or expired.");
      reply(200, result);
    } catch (error) {
      reply(error instanceof LocalHttpError ? error.status : 400, { error: "LAN signaling request rejected." });
    } finally { active -= 1; }
  }));
}

export function exchangeLanSignal({ address, port, message, signal, readBody, timeoutMs = 6_000 }) {
  if (!isIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new Error("Invalid LAN signaling destination."));
  }
  const body = JSON.stringify(message);
  if (Buffer.byteLength(body) > 64 * 1024) return Promise.reject(new Error("Signaling message is too large."));
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: address, port, path: "/signal/v2", method: "POST", signal,
      agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, async (response) => {
      try {
        if (response.statusCode !== 200 || response.headers["content-type"] !== "application/json") {
          if (response.statusCode === 403) throw new LocalHttpError("The peer rejected the pairing code or credentials. Check the sender code and retry.", 404);
          throw new Error("The peer rejected LAN signaling. Restart pairing on both devices.");
        }
        resolve(await readBody(response, { timeoutMs }));
      } catch (error) { response.destroy(); reject(error); }
      finally { clearTimeout(timer); }
    });
    const timer = setTimeout(() => request.destroy(new Error("LAN signaling timed out. Check the firewall and retry.")), timeoutMs);
    timer.unref();
    request.on("error", (error) => { clearTimeout(timer); reject(error); });
    request.end(body);
  });
}
