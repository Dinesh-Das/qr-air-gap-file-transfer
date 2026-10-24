import { expect, it, vi } from "vitest";
import type { TestInfo } from "@playwright/test";
import { attachHostNetworkFailure, parseTcpCounters } from "../e2e/host-network-diagnostics";

it("does no work for passing tests or unrelated failures", async () => {
  const sample = vi.fn(), attach = vi.fn();
  for (const errors of [[], [{ message: "assertion failed" }]]) await attachHostNetworkFailure({ errors, attach }, sample);
  expect(sample).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled();
});

it("captures one labelled post-test snapshot without retaining the error text", async () => {
  const errors = [{ message: "net::ERR_NO_BUFFER_SPACE secret-url?token=do-not-retain" }, { message: "net::ERR_NO_BUFFER_SPACE" }];
  const sample = vi.fn(async () => ({ freeBytes: 1024, totalBytes: 2048, nodeRssBytes: 512, tcpIpv4: null, tcpStatus: "unavailable" as const }));
  const attach = vi.fn<TestInfo["attach"]>(async () => {});
  await attachHostNetworkFailure({ errors, attach }, sample);
  expect(sample).toHaveBeenCalledTimes(1); expect(attach).toHaveBeenCalledTimes(1);
  const record = JSON.parse(String(attach.mock.calls[0][1]?.body));
  expect(record).toMatchObject({ errorCode: "ERR_NO_BUFFER_SPACE", scope: "Host snapshot after failed test; not a measurement at the failed navigation or a root-cause conclusion.", snapshot: { freeBytes: 1024, tcpStatus: "unavailable" } });
  expect(JSON.stringify(record)).not.toContain("do-not-retain");
  expect(errors[0].message).toContain("do-not-retain");
});

it("preserves the original failure when sampling is unavailable", async () => {
  const errors = [{ message: "net::ERR_NO_BUFFER_SPACE" }], attach = vi.fn<TestInfo["attach"]>(async () => {});
  await attachHostNetworkFailure({ errors, attach }, async () => { throw new Error("secret native failure"); });
  const record = JSON.parse(String(attach.mock.calls[0][1]?.body));
  expect(record).toMatchObject({ diagnosticsUnavailable: true });
  expect(JSON.stringify(record)).not.toContain("secret"); expect(errors).toEqual([{ message: "net::ERR_NO_BUFFER_SPACE" }]);
});

it("does not replace the original failure if attachment writing fails", async () => {
  const errors = [{ message: "net::ERR_NO_BUFFER_SPACE" }];
  await expect(attachHostNetworkFailure({ errors, attach: async () => { throw Error("attachment failed"); } }, async () => { throw Error("sampling failed"); })).resolves.toBeUndefined();
  expect(errors).toEqual([{ message: "net::ERR_NO_BUFFER_SPACE" }]);
});

const counters = { currentConnections: 1, connectionsInitiated: 2, connectionsAccepted: 3, failedConnectionAttempts: 4, resetConnections: 5, segmentsResent: 6 };
it("accepts only the finite nonnegative TCP counters and drops unrelated fields", () => {
  expect(parseTcpCounters(JSON.stringify({ ...counters, hostname: "private-host" }))).toEqual(counters);
  for (const value of [-1, null, "1", Number.MAX_SAFE_INTEGER + 1]) expect(() => parseTcpCounters(JSON.stringify({ ...counters, currentConnections: value }))).toThrow();
});

it("rejects incomplete or malformed native counter output", () => {
  for (const value of ["", "not-json", "null", "[]", "{}", JSON.stringify({ ...counters, segmentsResent: undefined })]) expect(() => parseTcpCounters(value)).toThrow();
});
