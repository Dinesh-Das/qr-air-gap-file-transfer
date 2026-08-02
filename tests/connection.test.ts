import { describe, expect, it } from 'vitest'

import { createArchive } from '../src/lib/archive'
import {
  CONNECTION_TEST_FILE_NAME,
  createFilesTransferBinding,
  deriveConnectionReceiptCode,
  formatConnectionReceiptCode,
  prepareConnectionTest,
  validateConnectionReceiptCode,
  verifyConnectionTest,
} from '../src/lib/connection'
import {
  TransferAccumulator,
  TransferPurpose,
  prepareTransfer,
} from '../src/lib/protocol'

const CONNECTION_ID = Uint8Array.from({ length: 16 }, (_, index) => index * 7)

describe('dummy connection transfer', () => {
  it('proves the full randomized dummy and binds the exact prepared files transfer', async () => {
    const filesArchive = createArchive([
      { path: 'payload.txt', bytes: new TextEncoder().encode('bound payload') },
    ])
    const filesTransfer = await prepareTransfer(filesArchive, {
      rootName: 'Bound Files',
      chunkSize: 200,
      transferId: 0xf0debc9a,
      createdAtMs: 1_000,
      purpose: TransferPurpose.Files,
      connectionId: CONNECTION_ID,
    })
    const binding = await createFilesTransferBinding(filesTransfer)
    const preparedProbe = await prepareConnectionTest(binding, {
      dummySize: 512,
      chunkSize: 160,
      transferId: 0x78563412,
      createdAtMs: 1_001,
    })

    expect(preparedProbe.transfer.manifest.purpose).toBe(TransferPurpose.ConnectionTest)
    expect(preparedProbe.transfer.connectionId).toEqual(CONNECTION_ID)
    expect(preparedProbe.filesBinding.transferId).toBe(filesTransfer.transferId)
    expect(preparedProbe.filesBinding.archiveSha256).toEqual(
      filesTransfer.manifest.archiveSha256,
    )
    expect(preparedProbe.filesBinding.manifestSha256).toHaveLength(32)

    const probeReceiver = new TransferAccumulator({
      maxArchiveBytes: 32 * 1024,
      expectedPurpose: TransferPurpose.ConnectionTest,
      expectedConnectionId: CONNECTION_ID,
    })
    await probeReceiver.ingest(preparedProbe.transfer.manifestFrame)
    let probeCompleted
    for (const frame of preparedProbe.transfer.dataFrames) {
      probeCompleted = await probeReceiver.ingest(frame)
    }
    expect(probeCompleted?.status).toBe('complete')
    expect(probeCompleted?.archiveBytes).toBeDefined()

    const verified = await verifyConnectionTest(
      probeCompleted!.archiveBytes!,
      probeCompleted!.connectionId!,
      probeCompleted!.transferId!,
    )
    expect(verified.dummyBytes).toEqual(preparedProbe.dummyBytes)
    expect(verified.filesBinding).toEqual(binding)
    expect(verified.receiptCode).toBe(preparedProbe.receiptCode)

    const typed = preparedProbe.receiptCode.toLowerCase().replace('-', ' ')
    expect(formatConnectionReceiptCode(typed)).toBe(preparedProbe.receiptCode)
    await expect(
      validateConnectionReceiptCode(
        typed,
        preparedProbe.connectionId,
        preparedProbe.archiveBytes,
      ),
    ).resolves.toBe(true)
    await expect(
      validateConnectionReceiptCode(
        '00000-00000',
        preparedProbe.connectionId,
        preparedProbe.archiveBytes,
      ),
    ).resolves.toBe(false)

    const filesReceiver = new TransferAccumulator({
      expectedPurpose: TransferPurpose.Files,
      expectedConnectionId: verified.filesBinding.connectionId,
      expectedTransferId: verified.filesBinding.transferId,
      expectedArchiveSha256: verified.filesBinding.archiveSha256,
      expectedManifestSha256: verified.filesBinding.manifestSha256,
    })
    const forgedManifest = await prepareTransfer(filesArchive, {
      rootName: 'Altered Root',
      chunkSize: 200,
      transferId: filesTransfer.transferId,
      createdAtMs: 1_000,
      purpose: TransferPurpose.Files,
      connectionId: CONNECTION_ID,
    })
    const rejectedManifest = await filesReceiver.ingest(
      forgedManifest.manifestFrame,
    )
    expect(rejectedManifest.accepted).toBe(false)
    expect(rejectedManifest.error).toMatch(/prepared transfer/i)

    await filesReceiver.ingest(filesTransfer.manifestFrame)
    let filesCompleted
    for (const frame of filesTransfer.dataFrames) {
      filesCompleted = await filesReceiver.ingest(frame)
    }
    expect(filesCompleted?.archiveBytes).toEqual(filesArchive)
  })

  it('rejects an altered dummy, wrong session, wrong probe ID, and ambiguous receipt text', async () => {
    const filesTransfer = await prepareTransfer(Uint8Array.of(1, 2, 3), {
      rootName: 'Files',
      chunkSize: 2,
      transferId: 101,
      createdAtMs: 2_000,
      purpose: TransferPurpose.Files,
      connectionId: CONNECTION_ID,
    })
    const probe = await prepareConnectionTest(await createFilesTransferBinding(filesTransfer), {
      dummySize: 256,
      chunkSize: 128,
      transferId: 102,
      createdAtMs: 2_001,
    })
    const wrongConnection = Uint8Array.from(CONNECTION_ID, (byte) => byte ^ 0xff)

    await expect(
      verifyConnectionTest(probe.archiveBytes, wrongConnection, probe.transfer.transferId),
    ).rejects.toThrow(/different connection/i)
    await expect(
      verifyConnectionTest(probe.archiveBytes, CONNECTION_ID, probe.transfer.transferId + 1),
    ).rejects.toThrow(/probe transfer ID/i)

    const corruptedArchive = probe.archiveBytes.slice()
    corruptedArchive[Math.floor(corruptedArchive.length / 2)] ^= 0x01
    await expect(
      deriveConnectionReceiptCode(CONNECTION_ID, corruptedArchive),
    ).rejects.toThrow()

    expect(() => formatConnectionReceiptCode('OOOOO-IIIII')).toThrow()
    expect(() => formatConnectionReceiptCode('１２３４５-67890')).toThrow()
  })

  it('requires the exact one-file dummy archive contract', async () => {
    const invalidArchive = createArchive([
      {
        path: CONNECTION_TEST_FILE_NAME,
        bytes: new Uint8Array(256),
      },
      { path: 'extra.txt', bytes: Uint8Array.of(1) },
    ])
    await expect(
      verifyConnectionTest(invalidArchive, CONNECTION_ID, 1),
    ).rejects.toThrow(/exactly/i)
  })
})
