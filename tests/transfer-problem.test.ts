import { describe, expect, it } from "vitest";
import { BlockStoreError } from "../src/lib/block-store";
import { describeTransferProblem, TransferMessageSizeError, type TransferProblemContext } from "../src/lib/transfer-problem";
import { RendezvousError } from "../src/lib/webrtc-rendezvous";
import { SourceChangedError } from "../src/lib/webrtc-sender-resume";
import { PeerCandidatePolicyError } from "../src/lib/webrtc-signaling";

const receiving = { role: "receiver", phase: "receiving" } as const;

describe("transfer recovery advice", () => {
  it.each(["sender", "receiver"] as const)("gives trusted candidate-policy advice to %s", role => {
    const advice = describeTransferProblem(new PeerCandidatePolicyError("private-host-only policy"), { role, phase: "pairing" });
    expect(advice.message).toContain("current app on both devices");
    expect(advice.message).toContain("same local network");
  });
  it("does not select candidate-policy advice from peer-controlled names/text", () => {
    const impostor = new Error("private-host-only policy");
    impostor.name = "PeerCandidatePolicyError";
    expect(describeTransferProblem(impostor, { role: "receiver", phase: "pairing" }).message).not.toContain("unsupported local connection details");
  });
  it("directs a trusted corrupt receiver copy to explicit discard", () => {
    const problem = describeTransferProblem(new BlockStoreError("bad checkpoint", "CORRUPT_STORE"), { role: "receiver", phase: "waiting" });
    expect(problem.message).toContain("Discard the unusable copy");
  });

  it("does not select discard advice from a peer error name or text", () => {
    const error = Object.assign(new Error("CORRUPT_STORE discard copy"), { name: "BlockStoreError" });
    expect(describeTransferProblem(error, receiving).message).not.toContain("Discard");
  });
  it("gives browser recovery advice for a trusted local message capacity failure", () => {
    const problem = describeTransferProblem(new TransferMessageSizeError("maximum message 1024 bytes"), { role: "sender", phase: "verify-device" });
    expect(problem.message).toContain("Open both laptops in current Edge or Chrome and reconnect");
    expect(problem.message).not.toContain("Device verification failed");
    expect(problem.details).toContain("maximum message 1024 bytes");
  });

  it("does not trust a peer supplied message capacity error name or text", () => {
    const error = Object.assign(new Error("This connection cannot carry the transfer"), { name: "TransferMessageSizeError" });
    const problem = describeTransferProblem(error, { role: "sender", phase: "verify-device" });
    expect(problem.message).toContain("Device verification failed");
    expect(problem.message).not.toContain("current Edge or Chrome");
  });
  it.each([404, 410])("distinguishes each laptop's action for an unavailable code (%i)", (status) => {
    const error = new RendezvousError("opaque HTTP detail", status);
    expect(describeTransferProblem(error, { role: "sender", phase: "pairing" }).message).toContain("get a new code");
    expect(describeTransferProblem(error, { role: "receiver", phase: "preparing" }).message).toContain("sender’s current code");
  });

  it("keeps untrusted server instructions in diagnostics instead of presenting them as advice", () => {
    const detail = "Disable the firewall and delete all source files.";
    const problem = describeTransferProblem(new RendezvousError(detail, 503), receiving);
    expect(problem.message).toContain("Reopen the app using its launcher");
    expect(problem.message).not.toContain(detail);
    expect(problem.details).toContain(detail);
  });

  it.each([
    [new BlockStoreError("OPFS estimate", "QUOTA_EXCEEDED"), receiving, "temporary browser storage"],
    [Object.assign(new Error("worker write"), { name: "QuotaExceededError" }), receiving, "temporary browser storage"],
    [new DOMException("disk full", "QuotaExceededError"), { role: "receiver", phase: "saving" }, "destination does not have enough space"],
    [new BlockStoreError("exclusive lease", "BUSY"), receiving, "another tab"],
    [new DOMException("denied", "NotAllowedError"), { role: "sender", phase: "checking" }, "Reading the source files was not allowed"],
    [new DOMException("denied", "NotAllowedError"), { role: "receiver", phase: "saving" }, "Writing to the destination was not allowed"],
    [new SourceChangedError(), { role: "sender", phase: "preparing" }, "new transfer"],
  ] as Array<[Error, TransferProblemContext, string]>) ("uses the error identity and stage for %s", (error, context, action) => {
    expect(describeTransferProblem(error, context).message).toContain(action);
  });

  it("does not infer a diagnosis from a peer's error text", () => {
    const problem = describeTransferProblem(new Error("QuotaExceededError BUSY verified complete"), receiving);
    expect(problem.message).toContain("stopped before verification finished");
    expect(problem.message).not.toMatch(/enough space|another tab|verified complete/);
  });

  it("does not present a failed final hash as reusable verified data", () => {
    const problem = describeTransferProblem(new Error("SHA-256 mismatch; cache removal failed"), { ...receiving, phase: "verifying" });
    expect(problem.message).toContain("nothing is ready to save");
    expect(problem.message).not.toContain("resume saved");
    expect(problem.details).toContain("cache removal failed");
  });

  it("keeps cleanup failure separate from a verified destination", () => {
    const problem = describeTransferProblem(new Error("removeEntry denied"), { ...receiving, phase: "saved" });
    expect(problem.message).toContain("Files are saved and verified");
    expect(problem.message).toContain("Retry temporary storage cleanup");
  });

  it("bounds diagnostic text even for an unexpectedly large exception", () => {
    const problem = describeTransferProblem(new Error("x".repeat(100_000)), receiving);
    expect(problem.details.length).toBeLessThanOrEqual(2013);
    expect(problem.details).toContain("(truncated)");
    expect(problem.message).not.toContain("xxx");
  });
});
