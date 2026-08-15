import { describe, expect, it } from "vitest";
import { prepareQrf3ConnectionTest } from "../src/lib/large-connection";
import {
  clearQrf3ReceiverConnection,
  loadQrf3ReceiverConnection,
  saveQrf3ReceiverConnection,
  type Qrf3ReceiverResumeRecord,
  type Qrf3ReceiverResumeRepository,
} from "../src/lib/large-receiver-resume";
import {
  Qrf3BlobSource,
  createQrf3Transfer,
} from "../src/lib/stream-protocol";

class ReloadingResumeRepository implements Qrf3ReceiverResumeRepository {
  private record?: Qrf3ReceiverResumeRecord;

  async get(): Promise<unknown> {
    return this.record ? structuredClone(this.record) : undefined;
  }

  async put(record: Qrf3ReceiverResumeRecord): Promise<void> {
    this.record = structuredClone(record);
  }

  async delete(): Promise<void> {
    this.record = undefined;
  }

  corruptProbePadding(): void {
    if (!this.record) throw new Error("No resume record exists.");
    this.record.probeBytes[this.record.probeBytes.length - 1] ^= 1;
  }

  probeBytes(): Uint8Array | undefined {
    return this.record?.probeBytes.slice();
  }
}

describe("QRF3 receiver connection resume", () => {
  it("restores the exact verified probe through a structured-clone reload", async () => {
    const files = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([Uint8Array.of(1, 2, 3, 4)])),
      { rootName: "resume-fixture", blockSize: 2 },
    );
    const probe = await prepareQrf3ConnectionTest(files);
    const exactProbeBytes = probe.bytes.slice();
    const repository = new ReloadingResumeRepository();

    const saved = await saveQrf3ReceiverConnection(
      probe.bytes,
      probe.transfer.manifest,
      repository,
    );
    expect(repository.probeBytes()).toEqual(exactProbeBytes);
    probe.bytes[probe.bytes.length - 1] ^= 1;
    probe.transfer.manifest.archiveSha256[0] ^= 1;

    const restored = await loadQrf3ReceiverConnection(repository);
    expect(restored).toEqual(saved);
    expect(restored?.receiptCode).toBe(probe.receiptCode);
  });

  it("rejects a mutated saved probe and clears the active binding", async () => {
    const files = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([Uint8Array.of(9, 8, 7)])),
      { rootName: "resume-corruption", blockSize: 2 },
    );
    const probe = await prepareQrf3ConnectionTest(files);
    const repository = new ReloadingResumeRepository();
    await saveQrf3ReceiverConnection(
      probe.bytes,
      probe.transfer.manifest,
      repository,
    );

    repository.corruptProbePadding();
    await expect(loadQrf3ReceiverConnection(repository)).rejects.toThrow(/SHA-256/);
    await clearQrf3ReceiverConnection(repository);
    await expect(loadQrf3ReceiverConnection(repository)).resolves.toBeNull();
  });
});
