import { expect, it } from "vitest";
import { installNativeMixedReadGuard } from "../scripts/native-mixed-read-guard.mjs";

it("rejects whole-file and alternative native reads, including prototype calls", async () => {
  const undo = installNativeMixedReadGuard();
  try {
    const file = new File([new Uint8Array(8388673)], "large.bin"), state = { nativeReadBytes: 0, maxNativeRead: 0 };
    globalThis.__guardNativeMixedFiles([file], state);
    await expect(file.arrayBuffer()).rejects.toThrow("Unbounded");
    await expect(Blob.prototype.arrayBuffer.call(file)).rejects.toThrow("Unbounded");
    expect(() => file.stream()).toThrow("Unsupported");
    expect(() => file.text()).toThrow("Unsupported");
    expect(() => file.slice(0, 1).stream()).toThrow("Unsupported");
    expect(state.nativeReadBytes).toBe(0);
    const slice = Blob.prototype.slice.call(file, 0, 4194304);
    expect((await Blob.prototype.arrayBuffer.call(slice)).byteLength).toBe(4194304);
    expect(state).toEqual({ nativeReadBytes: 4194304, maxNativeRead: 4194304 });
    expect((await new Blob(["untracked"]).text())).toBe("untracked");
  } finally { undo(); }
});
