import { freeSignalPort } from "./free-signal-port.mjs";
import { createServer, request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { assertLocalRequest, configureLocalHttpServer } from "../scripts/local-http-security.mjs";
import { createRendezvousRuntime, readJsonBody } from "../scripts/rendezvous.mjs";

const offer = { sessionId: "a".repeat(32), sdp: "v=0\r\n" };

async function withServer(run) {
  const signalPort = await freeSignalPort();
  const runtime = createRendezvousRuntime({ signalPort });
  // Reserve both signaling transports before allocating the application port.
  await runtime.start();
  const server = configureLocalHttpServer(createServer(async (request, response) => {
    if (await runtime.handleHttp(request, response)) return;
    response.writeHead(404).end();
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const send = ({ headers = {}, method = "POST", body = JSON.stringify(offer), path = "/api/rendezvous/rooms" } = {}) => new Promise((resolve, reject) => {
    const allHeaders = { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, ...headers };
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method,
      headers: Object.fromEntries(Object.entries(allHeaders).filter(([, value]) => value !== undefined)),
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on("error", reject);
    request.end(body);
  });
  try { await run({ send, port, runtime, server }); }
  finally {
    await runtime.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("local HTTP security boundary", () => {
  it("rejects rebinding, cross-origin and form requests without creating pairing state", async () => {
    await withServer(async ({ send, port, runtime }) => {
      for (const headers of [
        { Origin: "https://attacker.example" },
        { Origin: "null" },
        { Origin: undefined },
        { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` },
        { Host: `127.0.0.1:${port + 1}` },
        { Origin: `http://127.0.0.1:${port}/` },
        { "Sec-Fetch-Site": "cross-site" },
        { "Sec-Fetch-Site": "same-site" },
      ]) {
        const response = await send({ headers });
        expect(response.status).toBe(403);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        expect(runtime.registry.rooms.size).toBe(0);
      }
      for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/json; charset=utf-16"]) {
        expect((await send({ headers: { "Content-Type": type } })).status).toBe(415);
      }
      expect((await send({ headers: { "Content-Encoding": "gzip" } })).status).toBe(415);
      expect(runtime.registry.rooms.size).toBe(0);
      const accepted = await send({ headers: { "Sec-Fetch-Site": "same-origin" } });
      expect(accepted.status, accepted.text).toBe(201);
      expect(runtime.registry.rooms.size).toBe(1);
    });
  });

  it("enforces methods, bounded bodies and JSON parsing", async () => {
    await withServer(async ({ send, runtime }) => {
      for (const method of ["GET", "OPTIONS", "PUT"]) expect((await send({ method, body: "" })).status).toBe(405);
      expect((await send({ body: "{" })).status).toBe(400);
      expect((await send({ body: "[]" })).status).toBe(400);
      expect((await send({ body: "x".repeat(65_537), headers: { "Content-Length": "65537" } })).status).toBe(413);
      expect((await send({ body: "x".repeat(65_537), headers: { "Transfer-Encoding": "chunked" } })).status).toBe(413);
      expect(runtime.registry.rooms.size).toBe(0);
    });
  });

  it("cancels discovery promptly when the HTTP client disconnects", async () => {
    await withServer(async ({ port, runtime, send }) => {
      const request = httpRequest({ hostname: "127.0.0.1", port,
        path: "/api/rendezvous/join", method: "POST",
        headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      });
      request.on("error", () => undefined);
      request.end(JSON.stringify({ code: "123456" }));
      try {
        await expect.poll(() => runtime.stats().pendingDiscoveries).toBe(1);
        request.destroy();
        await expect.poll(() => runtime.stats().pendingDiscoveries).toBe(0);
        await expect.poll(() => runtime.stats().activeHttp).toBe(0);
        expect(runtime.stats().localJoins).toBe(0);
        expect((await send()).status).toBe(201);
      } finally { request.destroy(); }
    });
  });

  it("rejects non-loopback sockets even with forged local headers", () => {
    expect(() => assertLocalRequest({ socket: { remoteAddress: "192.168.1.2", localPort: 4173 },
      headers: { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173" }, url: "/",
    })).toThrow(/local address/);
  });

  it("shutdown interrupts an incomplete body without creating a late room", async () => {
    await withServer(async ({ port, runtime }) => {
      const request = httpRequest({ hostname: "127.0.0.1", port,
        path: "/api/rendezvous/rooms", method: "POST",
        headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      });
      request.on("error", () => undefined);
      request.write("{");
      try {
        await expect.poll(() => runtime.stats().activeHttp).toBe(1);
        await runtime.stop();
        await expect.poll(() => runtime.stats().activeHttp).toBe(0);
        expect(runtime.stats().rooms).toBe(0);
      } finally { request.destroy(); }
    });
  });

  it("bounds HTTP connections, headers and timeouts", async () => {
    await withServer(async ({ server }) => {
      expect(server.maxConnections).toBe(64);
      expect(server.maxHeadersCount).toBe(32);
      expect(server.requestTimeout).toBe(15_000);
      expect(server.headersTimeout).toBe(10_000);
    });
  });

  it("times out an unfinished body and releases its listeners", async () => {
    const stream = new PassThrough();
    stream.headers = {};
    const pending = readJsonBody(stream, { timeoutMs: 5 });
    stream.write("{");
    await expect(pending).rejects.toMatchObject({ status: 408 });
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("end")).toBe(0);
    expect(stream.isPaused()).toBe(true);
    stream.destroy();
  });
});
