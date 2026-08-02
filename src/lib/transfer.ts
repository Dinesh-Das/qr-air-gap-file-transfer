import {
  prepareTransfer as prepareProtocolTransfer,
  type PreparedTransfer as ProtocolPreparedTransfer,
  type TransferPurpose,
} from "./protocol";

export interface PreparedLoopFrame {
  encoded: string;
  kind: "manifest" | "data";
  chunkIndex?: number;
  totalChunks: number;
}

export interface PreparedTransfer
  extends Omit<ProtocolPreparedTransfer, "loopFrames"> {
  archiveBytes: Uint8Array;
  loopFrames: PreparedLoopFrame[];
}

/**
 * UI-facing sender preparation. The wire protocol stays string-only, while
 * this adapter adds display metadata without parsing frames during animation.
 */
export async function prepareTransfer(
  archiveBytes: Uint8Array,
  options: {
    rootName: string;
    chunkSize: number;
    purpose?: TransferPurpose;
    connectionId?: Uint8Array;
    transferId?: number;
    createdAtMs?: number;
    manifestInterval?: number;
  },
): Promise<PreparedTransfer> {
  const stableArchive = Uint8Array.from(archiveBytes);
  const prepared = await prepareProtocolTransfer(stableArchive, options);
  return decorateStablePreparedTransfer(stableArchive, prepared);
}

/** Adds sender-animation metadata to an already prepared protocol transfer. */
export function decoratePreparedTransfer(
  archiveBytes: Uint8Array,
  prepared: ProtocolPreparedTransfer,
): PreparedTransfer {
  return decorateStablePreparedTransfer(Uint8Array.from(archiveBytes), prepared);
}

function decorateStablePreparedTransfer(
  stableArchive: Uint8Array,
  prepared: ProtocolPreparedTransfer,
): PreparedTransfer {
  const dataIndexByFrame = new Map(
    prepared.dataFrames.map((encoded, index) => [encoded, index]),
  );
  const loopFrames = prepared.loopFrames.map(
    (encoded): PreparedLoopFrame => {
      if (encoded === prepared.manifestFrame) {
        return {
          encoded,
          kind: "manifest",
          totalChunks: prepared.totalChunks,
        };
      }
      return {
        encoded,
        kind: "data",
        chunkIndex: dataIndexByFrame.get(encoded),
        totalChunks: prepared.totalChunks,
      };
    },
  );

  return {
    ...prepared,
    archiveBytes: stableArchive,
    loopFrames,
  };
}
