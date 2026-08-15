import { describe, expect, it } from "vitest";
import {
  matchesQrf3FilesBinding,
  prepareQrf3ConnectionTest,
  validateQrf3ReceiptCode,
  verifyQrf3ConnectionTest,
} from "../src/lib/large-connection";
import {
  Qrf3BlobSource,
  Qrf3TransferPurpose,
  createQrf3Transfer,
} from "../src/lib/stream-protocol";

describe("QRF3 connection test", () => {
  it("binds a complete optical probe to one exact Files manifest", async () => {
    const files = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([new Uint8Array([1, 2, 3])])),
      { rootName: "fixture", blockSize: 2 },
    );
    const probe = await prepareQrf3ConnectionTest(files);
    const verified = verifyQrf3ConnectionTest(probe.bytes, probe.transfer.manifest);
    expect(matchesQrf3FilesBinding(verified.filesBinding, files)).toBe(true);
    expect(verified.receiptCode).toBe(probe.receiptCode);
    expect(validateQrf3ReceiptCode(probe.receiptCode.toLowerCase(), probe.receiptCode)).toBe(true);
  });

  it("rejects a different Files stream and corrupted probe", async () => {
    const files = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([new Uint8Array([1, 2, 3])])),
      { rootName: "fixture", blockSize: 2 },
    );
    const other = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([new Uint8Array([1, 2, 3])])),
      { rootName: "fixture", blockSize: 2 },
    );
    const probe = await prepareQrf3ConnectionTest(files);
    const verified = verifyQrf3ConnectionTest(probe.bytes, probe.transfer.manifest);
    expect(matchesQrf3FilesBinding(verified.filesBinding, other)).toBe(false);

    const corrupted = probe.bytes.slice();
    corrupted[0] ^= 1;
    expect(() =>
      verifyQrf3ConnectionTest(corrupted, probe.transfer.manifest),
    ).toThrow(/marker/);

    const corruptedPadding = probe.bytes.slice();
    corruptedPadding[corruptedPadding.length - 1] ^= 1;
    expect(() =>
      verifyQrf3ConnectionTest(corruptedPadding, probe.transfer.manifest),
    ).toThrow(/SHA-256/);
  });

  it("requires the fixed probe envelope and its exact stream hash", async () => {
    const files = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([Uint8Array.of(1, 2, 3)])),
      { rootName: "fixture", blockSize: 2 },
    );
    const probe = await prepareQrf3ConnectionTest(files);

    expect(() =>
      verifyQrf3ConnectionTest(probe.bytes, {
        ...probe.transfer.manifest,
        transferLength: probe.transfer.manifest.transferLength - 1,
      }),
    ).toThrow(/fixed 4 KiB/);
    expect(() =>
      verifyQrf3ConnectionTest(probe.bytes, {
        ...probe.transfer.manifest,
        rootName: "QRF3 connection test",
      }),
    ).toThrow(/canonical root name/);
    expect(() =>
      verifyQrf3ConnectionTest(probe.bytes, {
        ...probe.transfer.manifest,
        archiveSha256: new Uint8Array(32),
      }),
    ).toThrow(/SHA-256/);
    expect(() =>
      verifyQrf3ConnectionTest(probe.bytes, {
        ...probe.transfer.manifest,
        blockSize: probe.transfer.manifest.blockSize + 1,
      }),
    ).toThrow(/bound Files block size/);
  });

  it("rejects a Files manifest used as a probe manifest", async () => {
    const files = await createQrf3Transfer(
      new Qrf3BlobSource(new Blob([new Uint8Array([1])])),
      { rootName: "fixture", purpose: Qrf3TransferPurpose.Files },
    );
    const probe = await prepareQrf3ConnectionTest(files);
    expect(() => verifyQrf3ConnectionTest(probe.bytes, files.manifest)).toThrow(
      /fixed 4 KiB/,
    );
  });
});
