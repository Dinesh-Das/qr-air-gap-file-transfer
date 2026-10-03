import { describe, expect, it } from "vitest";
import { collectLargeDirectory, prepareLargeSource } from "../src/lib/large-transfer";
import { createOfflineTransferManifest } from "../src/lib/webrtc-protocol";
import { createSavedWebRtcSource, restoreWebRtcSource } from "../src/lib/webrtc-sender-resume";

describe("Wi-Fi sender recovery", () => {
  it("rechecks source bytes and identities, including same-size same-time changes", async () => {
    let file = new File(["alpha"], "file.txt", { lastModified: 7 });
    let reads = 0;
    let permission: PermissionState = "granted";
    const root = { kind: "directory", name: "fixture",
      queryPermission: async () => permission, requestPermission: async () => permission,
      async *entries() { yield ["file.txt", { kind: "file", name: "file.txt", getFile: async () => { reads++; return file; } }]; },
    } as unknown as FileSystemDirectoryHandle;
    const source = await prepareLargeSource(await collectLargeDirectory(root));
    const manifest = await createOfflineTransferManifest(source);
    const saved = createSavedWebRtcSource(source, manifest);
    const before = reads;
    const restored = await restoreWebRtcSource(saved);
    expect(reads).toBeGreaterThan(before);
    expect(restored.manifest).toEqual(manifest);
    expect(Object.keys(saved).sort()).toEqual(["handle", "key", "manifest", "updatedAt", "version"]);
    file = new File(["bravo"], "file.txt", { lastModified: 7 });
    await expect(restoreWebRtcSource(saved)).rejects.toThrow(/source changed/);
    permission = "denied";
    await expect(restoreWebRtcSource(saved)).rejects.toThrow(/Allow read access/);
    permission = "granted";
    const abort = new AbortController(); abort.abort();
    const readCount = reads;
    await expect(restoreWebRtcSource(saved, undefined, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(readCount);
  });

  it("checks permission before preflight and stops before source reads when preflight fails", async () => {
    let reads = 0;
    const order: string[] = [];
    const file = new File(["source"], "file.txt", { lastModified: 7 });
    const root = { kind: "directory", name: "fixture",
      queryPermission: async () => "prompt",
      requestPermission: async () => { order.push("permission"); return "granted"; },
      async *entries() { yield ["file.txt", { kind: "file", name: file.name, getFile: async () => { reads++; return file; } }]; },
    } as unknown as FileSystemDirectoryHandle;
    const source = await prepareLargeSource(await collectLargeDirectory(root));
    const saved = createSavedWebRtcSource(source, await createOfflineTransferManifest(source));
    const before = reads;
    await expect(restoreWebRtcSource(saved, undefined, undefined, async () => {
      order.push("preflight"); throw new Error("service unavailable");
    })).rejects.toThrow("service unavailable");
    expect(order).toEqual(["permission", "preflight"]);
    expect(reads).toBe(before);
    expect((await restoreWebRtcSource(saved, undefined, undefined, async () => {})).manifest).toEqual(saved.manifest);
  });
});
