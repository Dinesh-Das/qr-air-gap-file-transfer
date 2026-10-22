import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createRendezvousRuntime } from "../scripts/rendezvous.mjs";
import { freeSignalPort } from "./free-signal-port.mjs";

const SDP_LIMIT_BYTES = 48 * 1024;
const sessionId = "a".repeat(32);

it.each(["x", "é"])("enforces the inclusive SDP byte limit for HTTP offers and answers: %s", async (character) => {
  const prefix = "v=0\r\na=x:";
  const remaining = SDP_LIMIT_BYTES - Buffer.byteLength(prefix) - 2;
  const width = Buffer.byteLength(character);
  const sdp = prefix + character.repeat(Math.floor(remaining / width)) + "x".repeat(remaining % width) + "\r\n";
  expect(Buffer.byteLength(sdp)).toBe(SDP_LIMIT_BYTES);
  const oversized = sdp + "x";
  expect(Buffer.byteLength(oversized)).toBe(SDP_LIMIT_BYTES + 1);
  // Keep both requests below the independent HTTP body cap, including JSON
  // escaping, so a rejection must come from SDP validation.
  expect(Buffer.byteLength(JSON.stringify({ sessionId, sdp: oversized }))).toBeLessThan(64 * 1024);
  if (character === "é") expect(oversized.length).toBeLessThan(SDP_LIMIT_BYTES);

  const runtime = createRendezvousRuntime({ signalPort: await freeSignalPort() });
  const server = createServer((request, response) => { void runtime.handleHttp(request, response); });
  try {
    await runtime.start();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = async (path, body) => {
      const response = await fetch(`${origin}/api/rendezvous/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, Connection: "close" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };

    expect((await post("rooms", { sessionId, sdp: oversized })).status).toBe(400);
    expect(runtime.stats().rooms).toBe(0);
    const created = await post("rooms", { sessionId, sdp });
    expect(created.status).toBe(201);
    expect(runtime.stats().rooms).toBe(1);
    const joined = await post("join", { code: created.body.code });
    expect(joined.status).toBe(200);
    expect(joined.body.sdp).toBe(sdp);

    const answerPath = `joins/${joined.body.joinId}/answer`;
    expect((await post(answerPath, { sessionId, sdp: oversized })).status).toBe(400);
    expect(runtime.stats().localJoins).toBe(1);
    const poll = () => post(`rooms/${created.body.roomId}`, { ownerToken: created.body.ownerToken });
    expect((await poll()).body.status).toBe("waiting");
    expect((await post(answerPath, { sessionId, sdp })).status).toBe(200);
    expect(await poll()).toEqual({ status: 200, body: { status: "answered", sessionId, sdp } });
  } finally {
    await runtime.stop();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});
