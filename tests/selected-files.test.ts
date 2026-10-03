import { describe, expect, it } from "vitest";
import { collectSelectedFiles, collectSelectedItems, captureDroppedItems } from "../src/lib/selected-files";
import { prepareLargeSource } from "../src/lib/large-transfer";
import { createOfflineTransferManifest } from "../src/lib/webrtc-protocol";
import { createSavedWebRtcSource, restoreWebRtcSource } from "../src/lib/webrtc-sender-resume";

function handle(name: string, bytes = "alpha") {
  return { kind: "file", name, getFile: async () => new File([bytes], name, { lastModified: 7 }) } as FileSystemFileHandle;
}

describe("selected file sources", () => {
  it("preserves mixed top-level items and their checkpoint identity", async () => {
    const folder = { kind: "directory", name: "folder", async *entries() { yield ["inner.txt", handle("inner.txt")]; } } as unknown as FileSystemDirectoryHandle;
    const source = await prepareLargeSource(await collectSelectedItems([folder, handle("loose.txt")]));
    expect(source.rootName).toBe("Selected items");
    expect(source.directories).toEqual(["folder"]);
    expect(source.files.map(({ path }) => path)).toEqual(["folder/inner.txt", "loose.txt"]);
    const manifest = await createOfflineTransferManifest(source);
    const record = createSavedWebRtcSource(source, manifest);
    expect(record.itemHandles).toHaveLength(2);
    expect((await restoreWebRtcSource(record)).manifest).toEqual(manifest);
    expect((await collectSelectedItems([folder])).rootName).toBe("folder");
  });

  it("captures all drop promises immediately and fails closed on missing handles", async () => {
    let calls = 0;
    let resolveFirst!: (value: FileSystemFileHandle) => void;
    const items = [
      { kind: "file", getAsFileSystemHandle: () => { calls++; return new Promise<FileSystemFileHandle>((resolve) => { resolveFirst = resolve; }); } },
      { kind: "file", getAsFileSystemHandle: () => { calls++; return Promise.resolve(handle("second.txt")); } },
    ] as unknown as DataTransferItem[];
    const pending = captureDroppedItems(items);
    expect(calls).toBe(2);
    resolveFirst(handle("first.txt"));
    expect(await pending).toHaveLength(2);
    await expect(captureDroppedItems([{ kind: "file" } as DataTransferItem])).rejects.toThrow(/Use Choose files/);
    await expect(captureDroppedItems([{ kind: "file", getAsFileSystemHandle: async () => null } as DataTransferItem])).rejects.toThrow(/could not be opened/);
  });

  it("preserves names and empty files with an order-independent transfer identity", async () => {
    const files = [handle("z.txt"), handle("empty.bin", ""), handle("a.txt", "beta")];
    const source = await prepareLargeSource(await collectSelectedFiles(files));
    const manifest = await createOfflineTransferManifest(source);
    const reversed = await prepareLargeSource(await collectSelectedFiles([...files].reverse()));
    expect(await createOfflineTransferManifest(reversed)).toEqual(manifest);
    expect(source.rootName).toBe("Selected files");
    expect(source.files.map((file) => file.path)).toEqual(["a.txt", "empty.bin", "z.txt"]);
    const record = createSavedWebRtcSource(source, manifest);
    expect(record.handle).toBeUndefined();
    expect(record.fileHandles).toEqual(files);
    expect((await restoreWebRtcSource(record)).manifest).toEqual(manifest);
  });

  it("rejects duplicate and aliased basenames instead of renaming files", async () => {
    await expect(collectSelectedFiles([handle("same.txt"), handle("same.txt", "other")])).rejects.toThrow();
    await expect(collectSelectedFiles([handle("Same.txt"), handle("same.txt")])).rejects.toThrow();
    await expect(collectSelectedFiles([handle("CON.txt")])).rejects.toThrow();
    await expect(collectSelectedFiles([])).rejects.toThrow();
  });
});
