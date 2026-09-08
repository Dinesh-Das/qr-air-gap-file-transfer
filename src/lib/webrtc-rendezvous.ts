import type { OfflineSignalBundle } from "./webrtc-signaling";

const API_ROOT = "/api/rendezvous";
const POLL_INTERVAL_MS = 500;

export type RendezvousRoom = {
  roomId: string;
  ownerToken: string;
  code: string;
  expiresAt: number;
};

export type RendezvousJoin = {
  joinId: string;
  bundle: OfflineSignalBundle;
};

export function normalizePairingCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

export function isValidPairingCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

export function formatPairingCode(value: string): string {
  return isValidPairingCode(value) ? `${value.slice(0, 3)} ${value.slice(3)}` : value;
}

export async function createRendezvousRoom(
  bundle: OfflineSignalBundle,
  signal?: AbortSignal,
): Promise<RendezvousRoom> {
  if (bundle.kind !== "offer") throw new Error("A pairing room requires a WebRTC offer.");
  const value = await requestJson(`${API_ROOT}/rooms`, {
    method: "POST",
    body: JSON.stringify({ sessionId: bundle.sessionId, sdp: bundle.sdp }),
    signal,
  });
  if (!isRecord(value)
    || !isHex(value.roomId, 32)
    || !isHex(value.ownerToken, 64)
    || !isValidPairingCode(value.code)
    || typeof value.expiresAt !== "number") {
    throw new Error("The local pairing service returned an invalid room.");
  }
  return {
    roomId: value.roomId,
    ownerToken: value.ownerToken,
    code: value.code,
    expiresAt: value.expiresAt,
  };
}

export async function waitForRendezvousAnswer(
  room: RendezvousRoom,
  expectedSessionId: string,
  signal?: AbortSignal,
): Promise<OfflineSignalBundle> {
  for (;;) {
    throwIfAborted(signal);
    const value = await requestJson(`${API_ROOT}/rooms/${room.roomId}`, {
      method: "POST",
      body: JSON.stringify({ ownerToken: room.ownerToken }),
      signal,
    });
    if (!isRecord(value) || typeof value.status !== "string") {
      throw new Error("The local pairing service returned an invalid status.");
    }
    if (value.status === "answered") {
      if (value.sessionId !== expectedSessionId || typeof value.sdp !== "string") {
        throw new Error("The connection answer belongs to another pairing session.");
      }
      return { v: 1, kind: "answer", sessionId: expectedSessionId, sdp: value.sdp };
    }
    if (value.status !== "waiting") throw new Error("The local pairing service returned an unknown status.");
    if (Date.now() >= room.expiresAt) throw new Error("The pairing code expired. Prepare the transfer again for a new code.");
    await delay(POLL_INTERVAL_MS, signal);
  }
}

export async function cancelRendezvousRoom(room: RendezvousRoom): Promise<void> {
  const response = await fetch(`${API_ROOT}/rooms/${room.roomId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerToken: room.ownerToken }),
    cache: "no-store",
    keepalive: true,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(await responseError(response));
  }
}

export async function joinRendezvousRoom(code: string, signal?: AbortSignal): Promise<RendezvousJoin> {
  if (!isValidPairingCode(code)) throw new Error("Enter the six-digit pairing code shown on the sender.");
  const value = await requestJson(`${API_ROOT}/join`, {
    method: "POST",
    body: JSON.stringify({ code }),
    signal,
  });
  if (!isRecord(value)
    || !isHex(value.joinId, 32)
    || !isHex(value.sessionId, 32)
    || typeof value.sdp !== "string") {
    throw new Error("The local pairing service returned an invalid offer.");
  }
  return {
    joinId: value.joinId,
    bundle: { v: 1, kind: "offer", sessionId: value.sessionId, sdp: value.sdp },
  };
}

export async function publishRendezvousAnswer(
  joinId: string,
  bundle: OfflineSignalBundle,
  signal?: AbortSignal,
): Promise<void> {
  if (!isHex(joinId, 32) || bundle.kind !== "answer") throw new Error("Invalid pairing answer.");
  const value = await requestJson(`${API_ROOT}/joins/${joinId}/answer`, {
    method: "POST",
    body: JSON.stringify({ sessionId: bundle.sessionId, sdp: bundle.sdp }),
    signal,
  });
  if (!isRecord(value) || value.ok !== true) throw new Error("The sender did not accept the connection answer.");
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("The local pairing service is unavailable. Restart the local app runtime and retry.");
  }
  if (!response.ok) throw new Error(await responseError(response));
  try {
    return await response.json();
  } catch {
    throw new Error("The local pairing service returned an invalid response.");
  }
}

async function responseError(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (isRecord(value) && typeof value.error === "string") return value.error;
  } catch {
    // Fall through to the status text.
  }
  return response.statusText || `Pairing request failed (${response.status}).`;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Stopped", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Stopped", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex(value: unknown, characters: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${characters}}$`).test(value);
}
