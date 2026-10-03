import { collectLargeDirectory, MAX_LARGE_TREE_ENTRIES, type LargeTransferProgress } from "./large-transfer";

const selections = new WeakMap<FileSystemDirectoryHandle, FileSystemFileHandle[]>();
export type SelectedHandle = FileSystemFileHandle | FileSystemDirectoryHandle;
const itemSelections = new WeakMap<FileSystemDirectoryHandle, SelectedHandle[]>();

export async function collectSelectedItems(handles: SelectedHandle[], onProgress?: (progress: LargeTransferProgress) => void, signal?: AbortSignal) {
  if (!handles.length || handles.length > MAX_LARGE_TREE_ENTRIES || handles.some((handle) => !handle || !["file", "directory"].includes(handle.kind))) {
    throw new Error("Drop files or folders within the supported entry limit.");
  }
  if (handles.length === 1 && handles[0].kind === "directory") return collectLargeDirectory(handles[0], onProgress, signal);
  if (handles.every((handle) => handle.kind === "file")) return collectSelectedFiles(handles as FileSystemFileHandle[], onProgress, signal);
  const items = [...handles];
  const root = { kind: "directory", name: "Selected items",
    async *entries() { for (const handle of items) yield [handle.name, handle]; },
  } as unknown as FileSystemDirectoryHandle;
  itemSelections.set(root, items);
  return collectLargeDirectory(root, onProgress, signal);
}

export function selectedItemHandles(root: FileSystemDirectoryHandle): SelectedHandle[] | undefined {
  const items = itemSelections.get(root);
  return items ? [...items] : undefined;
}

/** Invoke every handle getter synchronously within the browser's drop event. */
export function captureDroppedItems(items: Iterable<DataTransferItem>): Promise<SelectedHandle[]> {
  const files = Array.from(items).filter((item) => item.kind === "file");
  if (!files.length || files.length > MAX_LARGE_TREE_ENTRIES) return Promise.reject(new Error("Drop files or folders within the supported entry limit."));
  if (files.some((item) => !item.getAsFileSystemHandle)) return Promise.reject(new Error("This browser cannot open dropped handles. Use Choose files or Choose folder."));
  const requests = files.map((item) => {
    try { return item.getAsFileSystemHandle!(); }
    catch (error) { return Promise.reject(error); }
  });
  return Promise.all(requests).then((handles) => {
    if (handles.some((handle) => !handle)) throw new Error("A dropped item could not be opened. Select the source again.");
    return handles as SelectedHandle[];
  });
}

/** A virtual root preserves each selected basename without guessing parent paths. */
export async function collectSelectedFiles(handles: FileSystemFileHandle[], onProgress?: (progress: LargeTransferProgress) => void, signal?: AbortSignal) {
  if (!handles.length || handles.length > MAX_LARGE_TREE_ENTRIES || handles.some((handle) => handle.kind !== "file")) {
    throw new Error("Select one or more files within the supported entry limit.");
  }
  const files = [...handles];
  const root = { kind: "directory", name: "Selected files",
    async *entries() { for (const handle of files) yield [handle.name, handle]; },
  } as unknown as FileSystemDirectoryHandle;
  selections.set(root, files);
  // Reuse all portable-name, duplicate, alias and metadata validation.
  return collectLargeDirectory(root, onProgress, signal);
}

export function selectedFileHandles(root: FileSystemDirectoryHandle): FileSystemFileHandle[] | undefined {
  const files = selections.get(root);
  return files ? [...files] : undefined;
}
