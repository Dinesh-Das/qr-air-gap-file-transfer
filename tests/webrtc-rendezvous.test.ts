import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatPairingCode,
  isValidPairingCode,
  normalizePairingCode,
  checkRendezvousReadiness,
  joinRendezvousRoom,
} from "../src/lib/webrtc-rendezvous";

describe("WebRTC pairing code helpers", () => {
  it("normalizes pasted pairing codes to six digits", () => {
    expect(normalizePairingCode("12 3-456 extra")).toBe("123456");
    expect(normalizePairingCode("abc00123456")).toBe("001234");
  });

  it("requires exactly six digits", () => {
    expect(isValidPairingCode("000001")).toBe(true);
    expect(isValidPairingCode("12345")).toBe(false);
    expect(isValidPairingCode("12345a")).toBe(false);
  });

  it("formats a valid code for display without changing its value", () => {
    expect(formatPairingCode("007042")).toBe("007 042");
  });
});

describe("local connection preflight", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it.each([404, 410, 503])("preserves HTTP %i for recovery advice independently of server wording", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Opaque server detail" }), { status })));
    await expect(joinRendezvousRoom("123456")).rejects.toMatchObject({ name: "RendezvousError", status, message: "Opaque server detail" });
  });
  it("requires an explicit current-protocol ready response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ready: true, protocol: 2 })));
    vi.stubGlobal("fetch", fetchMock);
    await checkRendezvousReadiness();
    expect(fetchMock).toHaveBeenCalledWith("/api/rendezvous/health", expect.objectContaining({ method: "POST", body: "{}", cache: "no-store" }));
    for (const value of [{ ready: false, protocol: 2 }, { ready: true, protocol: 1 }, {}, null]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value)));
      await expect(checkRendezvousReadiness()).rejects.toThrow("local connection service is unavailable");
    }
  });
  it("times out stalled checks and preserves caller cancellation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const timeout = expect(checkRendezvousReadiness()).rejects.toThrow("check timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await timeout;
    const controller = new AbortController();
    const stopped = expect(checkRendezvousReadiness(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
    const calls = fetchMock.mock.calls.length;
    await expect(checkRendezvousReadiness(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
});
