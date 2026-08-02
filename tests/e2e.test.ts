import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import {
  createArchive,
  extractArchive,
  verifyEntryCollections,
  type SelectedEntry,
} from "../src/lib/archive";
import {
  FrameType,
  TransferAccumulator,
  TransferPurpose,
  parseEncodedFrame,
  prepareTransfer,
} from "../src/lib/protocol";

const encoder = new TextEncoder();
const connectionId = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index);

describe("complete optical transfer pipeline", () => {
  it("recovers a byte-exact tree across missed, repeated, and out-of-order frames", async () => {
    const entries: SelectedEntry[] = [
      {
        path: "docs/नमस्ते world.txt",
        bytes: encoder.encode("line one\r\nline two\0with a NUL"),
      },
      {
        path: "images/raw pixels.bin",
        bytes: Uint8Array.from({ length: 32_771 }, (_, index) => index & 0xff),
      },
      {
        path: "one/two/three/four/five/final.dat",
        bytes: Uint8Array.of(0, 255, 1, 254, 2, 253),
      },
      { path: "zero bytes.bin", bytes: new Uint8Array() },
      { path: "same/a.txt", bytes: encoder.encode("identical") },
      { path: "same/b.txt", bytes: encoder.encode("identical") },
      {
        path: "empty directory/child",
        bytes: new Uint8Array(),
        directory: true,
      },
      ...Array.from({ length: 105 }, (_, index): SelectedEntry => ({
        path: `many/file ${index.toString().padStart(3, "0")}.txt`,
        bytes: encoder.encode(`entry ${index}\n`),
      })),
    ];

    const sourceArchive = createArchive(entries);
    const transfer = await prepareTransfer(sourceArchive, {
      rootName: "QR fixture 資料",
      chunkSize: 300,
      transferId: 0x12345678,
      createdAtMs: 1_725_000_000_000,
      purpose: TransferPurpose.Files,
      connectionId,
    });
    const receiver = new TransferAccumulator({
      maxArchiveBytes: 32 * 1024 * 1024,
      maxTotalChunks: 200_000,
      expectedPurpose: TransferPurpose.Files,
      expectedConnectionId: connectionId,
      expectedTransferId: transfer.transferId,
      expectedArchiveSha256: transfer.manifest.archiveSha256,
    });

    // Start partway through a pass, miss every fifth data QR, and include
    // duplicates. The next reversed pass supplies whatever was missed.
    const firstPass = transfer.dataFrames
      .filter((_, index) => index % 5 !== 0)
      .slice()
      .reverse();
    for (const frame of firstPass) {
      await receiver.ingest(frame);
      if (parseEncodedFrame(frame).chunkIndex % 7 === 0) {
        await receiver.ingest(frame);
      }
    }
    await receiver.ingest(transfer.manifestFrame);

    let completed;
    for (const frame of transfer.dataFrames.slice().reverse()) {
      const result = await receiver.ingest(frame);
      if (result.status === "complete") {
        completed = result;
        break;
      }
    }

    expect(completed?.archiveBytes).toEqual(sourceArchive);
    const reconstructed = extractArchive(completed!.archiveBytes!);
    const report = await verifyEntryCollections(
      extractArchive(sourceArchive),
      reconstructed,
      transfer.manifest.rootName,
    );
    expect(report.ok).toBe(true);
    expect(report.missingPaths).toEqual([]);
    expect(report.extraPaths).toEqual([]);
    expect(report.hashes.every(({ matches }) => matches)).toBe(true);
  });

  it("keeps default payload frames within QR capacity at ECC-M", async () => {
    const archive = Uint8Array.from(
      { length: 2_000 },
      (_, index) => (index * 47) & 0xff,
    );
    const transfer = await prepareTransfer(archive, {
      rootName: "capacity-check",
      chunkSize: 700,
      transferId: 9,
      createdAtMs: 10,
    });
    const dataFrame = parseEncodedFrame(transfer.dataFrames[0]);
    expect(dataFrame.type).toBe(FrameType.Data);
    expect(dataFrame.payloadLength).toBe(700);

    const symbol = QRCode.create(transfer.dataFrames[0], {
      errorCorrectionLevel: "M",
    });
    expect(symbol.version).toBeGreaterThan(0);
    expect(symbol.version).toBeLessThanOrEqual(40);
  });
});
