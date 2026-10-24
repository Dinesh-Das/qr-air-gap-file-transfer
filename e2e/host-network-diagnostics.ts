import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import type { TestInfo } from "@playwright/test";

const counterNames = ["currentConnections", "connectionsInitiated", "connectionsAccepted", "failedConnectionAttempts", "resetConnections", "segmentsResent"] as const;
type TcpCounters = Record<typeof counterNames[number], number>;
type Snapshot = { freeBytes: number; totalBytes: number; nodeRssBytes: number; tcpIpv4: TcpCounters | null; tcpStatus: "sampled" | "unavailable" | "unsupported" };
const run = promisify(execFile);
// Static command; no URLs, addresses, hostnames, process lists or user input.
const tcpCommand = "$s=[System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetTcpIPv4Statistics(); @{currentConnections=$s.CurrentConnections;connectionsInitiated=$s.ConnectionsInitiated;connectionsAccepted=$s.ConnectionsAccepted;failedConnectionAttempts=$s.FailedConnectionAttempts;resetConnections=$s.ResetConnections;segmentsResent=$s.SegmentsResent}|ConvertTo-Json -Compress";

export function parseTcpCounters(text: string): TcpCounters {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid TCP snapshot.");
  const result = {} as TcpCounters;
  for (const name of counterNames) {
    const number = (value as Record<string, unknown>)[name];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) throw new Error("Invalid TCP counter.");
    result[name] = number;
  }
  return result;
}

export async function readHostNetworkSnapshot(): Promise<Snapshot> {
  const snapshot: Snapshot = { freeBytes: freemem(), totalBytes: totalmem(), nodeRssBytes: process.memoryUsage().rss, tcpIpv4: null, tcpStatus: "unsupported" };
  if (process.platform !== "win32") return snapshot;
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", tcpCommand], { encoding: "utf8", windowsHide: true, timeout: 2000, maxBuffer: 16 * 1024 });
    snapshot.tcpIpv4 = parseTcpCounters(stdout);
    snapshot.tcpStatus = "sampled";
  } catch { snapshot.tcpStatus = "unavailable"; }
  return snapshot;
}

/** Diagnostic only: never retry a request, mutate test errors or replace failure. */
export async function attachHostNetworkFailure(info: Pick<TestInfo, "errors" | "attach">, sample = readHostNetworkSnapshot): Promise<void> {
  if (!info.errors.some(error => error.message?.includes("net::ERR_NO_BUFFER_SPACE"))) return;
  const collectionStartedAt = Date.now();
  let details: object;
  try {
    const { freeBytes, totalBytes, nodeRssBytes, tcpIpv4, tcpStatus } = await sample();
    if (![freeBytes, totalBytes, nodeRssBytes].every(n => Number.isSafeInteger(n) && n >= 0) || !["sampled", "unavailable", "unsupported"].includes(tcpStatus)) throw new Error("Invalid host snapshot.");
    details = { snapshot: { freeBytes, totalBytes, nodeRssBytes, tcpStatus, tcpIpv4: tcpIpv4 === null ? null : parseTcpCounters(JSON.stringify(tcpIpv4)) } };
  } catch { details = { diagnosticsUnavailable: true }; }
  const record = { errorCode: "ERR_NO_BUFFER_SPACE", collectionStartedAt, collectionFinishedAt: Date.now(), ...details,
    scope: "Host snapshot after failed test; not a measurement at the failed navigation or a root-cause conclusion." };
  try { await info.attach("host-network-after-failure", { body: Buffer.from(JSON.stringify(record, null, 2)), contentType: "application/json" }); }
  catch { /* Attachment failure must not replace the original navigation failure. */ }
}
