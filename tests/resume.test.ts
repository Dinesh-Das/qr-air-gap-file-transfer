import { describe, expect, it } from "vitest";

import { createArchive } from "../src/lib/archive";
import {
  createFilesTransferBinding,
  prepareConnectionTest,
} from "../src/lib/connection";
import { TransferPurpose, prepareTransfer } from "../src/lib/protocol";
import {
  resumeCheckpointKey,
  verifyResumeCheckpointProof,
  type ResumeCheckpoint,
} from "../src/lib/resume";

const CONNECTION_ID = Uint8Array.from(
  { length: 16 },
  (_, index) => index * 11,
);

describe("receiver resume proof", () => {
  it("re-verifies a zero-frame dummy proof and its exact Files binding", async () => {
    const checkpoint = await createProofCheckpoint();

    const verified = await verifyResumeCheckpointProof(checkpoint);

    expect(verified.probeTransferId).toBe(checkpoint.probeTransferId);
    expect(verified.filesBinding.transferId).toBe(checkpoint.transferId);
    expect(toHex(verified.filesBinding.archiveSha256)).toBe(
      checkpoint.expectedArchiveSha256,
    );
    expect(verified.receiptCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  });

  it("rejects altered dummy bytes, binding metadata, and legacy frame-only records", async () => {
    const checkpoint = await createProofCheckpoint();
    const alteredProof = {
      ...checkpoint,
      probeArchiveBytes: checkpoint.probeArchiveBytes.slice(),
    };
    alteredProof.probeArchiveBytes[
      Math.floor(alteredProof.probeArchiveBytes.length / 2)
    ] ^= 0x01;
    await expect(
      verifyResumeCheckpointProof(alteredProof),
    ).rejects.toThrow();

    await expect(
      verifyResumeCheckpointProof({
        ...checkpoint,
        expectedArchiveSha256: "00".repeat(32),
      }),
    ).rejects.toThrow(/exactly match/i);

    await expect(
      verifyResumeCheckpointProof({
        ...checkpoint,
        version: 1,
      } as unknown as ResumeCheckpoint),
    ).rejects.toThrow(/predates|repeat the connection test/i);
  });
});

async function createProofCheckpoint(): Promise<ResumeCheckpoint> {
  const filesArchive = createArchive([
    { path: "payload.txt", bytes: new TextEncoder().encode("resume proof") },
  ]);
  const filesTransfer = await prepareTransfer(filesArchive, {
    rootName: "Resume Proof",
    chunkSize: 128,
    transferId: 0x11223344,
    createdAtMs: 10_000,
    purpose: TransferPurpose.Files,
    connectionId: CONNECTION_ID,
  });
  const probe = await prepareConnectionTest(
    await createFilesTransferBinding(filesTransfer),
    {
      dummySize: 512,
      chunkSize: 128,
      transferId: 0x55667788,
      createdAtMs: 10_001,
    },
  );
  const connectionId = toHex(probe.connectionId);
  return {
    version: 2,
    key: resumeCheckpointKey(connectionId, filesTransfer.transferId),
    connectionId,
    probeTransferId: probe.transfer.transferId,
    probeArchiveBytes: probe.archiveBytes.slice(),
    transferId: filesTransfer.transferId,
    receivedChunks: 0,
    totalChunks: 0,
    receivedBytes: 0,
    expectedArchiveSha256: toHex(filesTransfer.manifest.archiveSha256),
    expectedManifestSha256: toHex(probe.filesBinding.manifestSha256),
    updatedAt: 10_002,
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("").toUpperCase();
}
