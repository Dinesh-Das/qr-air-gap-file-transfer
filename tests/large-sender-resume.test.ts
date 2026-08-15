import { describe, expect, it } from "vitest";

import { prepareQrf3ConnectionTest } from "../src/lib/large-connection";
import {
  restoreLargeSenderSession,
  type StoredLargeSenderSession,
} from "../src/lib/large-sender-resume";
import {
  collectLargeDirectory,
  createQrf3LargeSource,
  prepareLargeSource,
} from "../src/lib/large-transfer";
import {
  Qrf3TransferPurpose,
  createQrf3Transfer,
} from "../src/lib/stream-protocol";

describe("large sender reload recovery", () => {
  it("re-hashes the handle and reconstructs the exact saved QRF3 identities", async () => {
    let currentFile = new File(["alpha"], "a.txt", { lastModified: 7 });
    const fileHandle = {
      kind: "file" as const,
      name: "a.txt",
      async getFile() {
        return currentFile;
      },
    } as FileSystemFileHandle;
    let permissionRequests = 0;
    const rootHandle = {
      kind: "directory" as const,
      name: "fixture",
      async *entries() {
        yield ["a.txt", fileHandle] as [string, FileSystemFileHandle];
      },
      async queryPermission() {
        return "prompt" as PermissionState;
      },
      async requestPermission() {
        permissionRequests += 1;
        return "granted" as PermissionState;
      },
    } as unknown as FileSystemDirectoryHandle;
    const selection = await collectLargeDirectory(rootHandle);
    const prepared = await prepareLargeSource(selection);
    const filesPlan = await createQrf3Transfer(createQrf3LargeSource(prepared), {
      rootName: prepared.rootName,
      blockSize: 700,
      transferId: Uint8Array.from({ length: 16 }, (_, index) => index),
      createdAtMs: 1234,
      purpose: Qrf3TransferPurpose.Files,
      connectionId: Uint8Array.from({ length: 16 }, (_, index) => 100 + index),
      archiveSha256: prepared.streamSha256,
    });
    const probe = await prepareQrf3ConnectionTest(filesPlan);
    const filesManifest = filesPlan.manifest;
    const probeManifest = probe.transfer.manifest;
    const session: StoredLargeSenderSession = {
      key: "session",
      version: 1,
      revision: "revision",
      phase: "testing",
      rootName: prepared.rootName,
      rootHandle,
      fileCount: prepared.files.length,
      directoryCount: prepared.directories.length,
      totalFileBytes: prepared.totalFileBytes.toString(),
      framesPerSecond: 6,
      blockSize: filesPlan.blockSize,
      connectionId: filesManifest.connectionId,
      filesTransferId: filesManifest.transferId,
      filesCreatedAtMs: filesManifest.createdAtMs,
      filesManifestId: filesPlan.manifestId,
      filesStreamSha256: filesManifest.archiveSha256,
      filesTransferLength: filesPlan.transferLength,
      probeBytes: probe.bytes,
      probeTransferId: probeManifest.transferId,
      probeCreatedAtMs: probeManifest.createdAtMs,
      probeManifestId: probe.transfer.manifestId,
      updatedAt: 10,
    };

    const restored = await restoreLargeSenderSession(session);
    expect(permissionRequests).toBe(1);
    expect(await restored.filesPlan.manifestFrame()).toBe(
      await filesPlan.manifestFrame(),
    );
    expect(await restored.probe.transfer.manifestFrame()).toBe(
      await probe.transfer.manifestFrame(),
    );
    expect(restored.probe.receiptCode).toBe(probe.receiptCode);

    currentFile = new File(["omega"], "a.txt", { lastModified: 7 });
    await expect(restoreLargeSenderSession(session)).rejects.toThrow(
      /source bytes or metadata changed/i,
    );
  });
});
