export type BlockStoreWorkerRequest =
  | {
      id: number;
      type: "open";
      directory: FileSystemDirectoryHandle;
      journalBytes: number;
    }
  | { id: number; type: "write-payload"; offset: number; bytes: ArrayBuffer }
  | { id: number; type: "flush-payload" }
  | { id: number; type: "append-journal"; offset: number; bytes: ArrayBuffer }
  | { id: number; type: "truncate-journal"; size: number }
  | { id: number; type: "read-payload"; offset: number; length: number }
  | { id: number; type: "close" };

export type BlockStoreWorkerResponse =
  | { id: number; ok: true; type: "ready"; dataSize: number; journalSize: number }
  | { id: number; ok: true; type: "done" }
  | { id: number; ok: true; type: "read"; bytes: ArrayBuffer }
  | {
      id: number;
      ok: false;
      error: { name: string; message: string };
    };

