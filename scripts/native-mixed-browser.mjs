import { installNativeMixedReadGuard } from "./native-mixed-read-guard.mjs";

export async function installNativeMixedCounters(context, onManifest) {
  await context.addInitScript(installNativeMixedReadGuard);
  await context.exposeFunction("__mixedManifest", onManifest);
  await context.addInitScript(() => {
    const s = window.__nativeMixed = { controls: {}, workerRequests: {}, ackIndices: new Set(), binaryBytes: 0,
      binaryFrames: 0, manifest: null, nativeReadBytes: 0, maxNativeRead: 0, snapshots: {}, pickerCalls: 0, preserve: false, preservationAttempts: 0 };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
      if (typeof data === "string") {
        const message = JSON.parse(data); s.controls[message.type] = (s.controls[message.type] ?? 0) + 1;
        if (message.type === "ack") for (const index of message.indices) s.ackIndices.add(index);
        if (message.type === "manifest") { s.manifest = message.manifest; void window.__mixedManifest(); }
      } else { s.binaryBytes += data instanceof Blob ? data.size : data.byteLength; s.binaryFrames++; }
      return Reflect.apply(send, this, [data]);
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...args) {
      const type = args[0]?.type;
      if (typeof type === "string") s.workerRequests[type] = (s.workerRequests[type] ?? 0) + 1;
      return Reflect.apply(post, this, args);
    };
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = function (name, options) {
      if (s.preserve && this.name === "qr-air-gap-block-store-v1" && options?.recursive) {
        s.preservationAttempts++; throw new DOMException("Diagnostic receive-copy preservation", "NotAllowedError");
      }
      return Reflect.apply(remove, this, [name, options]);
    };
  });
}

export async function bindNativeMixedSource(page, fixture) {
  await page.evaluate(() => { const i = document.createElement("input"); i.type = "file"; i.webkitdirectory = true; i.id = "native-mixed-input"; i.hidden = true; document.body.appendChild(i); });
  const begin = Date.now();
  await page.locator("#native-mixed-input").setInputFiles(fixture.sourceDirectory);
  const nativeInputLoadMs = Date.now() - begin;
  await page.evaluate(f => {
    const selected = [...document.querySelector("#native-mixed-input").files], expected = new Map(f.files.map(x => [x.path, x]));
    if (selected.length !== f.files.length) throw Error("Native mixed file count mismatch");
    const directories = new Map([["", { kind: "directory", name: f.rootName, children: new Map() }]]);
    for (const path of f.directories) {
      const segments = path.split("/"), name = segments.pop(), parent = segments.join("/");
      const handle = { kind: "directory", name, children: new Map() };
      if (!directories.has(parent)) throw Error("Mixed directory parent missing");
      directories.get(parent).children.set(name, handle); directories.set(path, handle);
    }
    const seen = new Set(), s = window.__nativeMixed;
    globalThis.__guardNativeMixedFiles(selected, s);
    for (const file of selected) {
      const prefix = f.rootName + "/", relative = file.webkitRelativePath;
      if (!relative.startsWith(prefix)) throw Error("Unexpected native source root");
      const path = relative.slice(prefix.length), record = expected.get(path);
      if (!record || seen.has(path) || file.size !== record.bytes || file.lastModified !== record.lastModified) throw Error("Native file identity mismatch: " + path);
      seen.add(path);
      const segments = path.split("/"), name = segments.pop();
      directories.get(segments.join("/")).children.set(name, { kind: "file", name, getFile: async () => {
        s.snapshots[path] = (s.snapshots[path] ?? 0) + 1; return file;
      } });
    }
    for (const directory of directories.values()) directory.entries = async function* () { yield* this.children.entries(); };
    window.showDirectoryPicker = async () => { s.pickerCalls++; return directories.get(""); };
  }, fixture);
  return { nativeInputLoadMs, scope: "Native browser FileList via directory input; directory handles/empty-directory enumeration injected from independently checked native layout. Includes adapter setup/cache effects, not actual OS picker time." };
}

export const mixedBrowserSnapshot = page => page.evaluate(() => {
  const s = window.__nativeMixed;
  return { controls: s.controls, workerRequests: s.workerRequests, ackIndices: [...s.ackIndices], binaryBytes: s.binaryBytes,
    binaryFrames: s.binaryFrames, manifest: s.manifest, nativeReadBytes: s.nativeReadBytes, maxNativeRead: s.maxNativeRead,
    snapshots: s.snapshots, pickerCalls: s.pickerCalls, preservationAttempts: s.preservationAttempts };
});

/** Runs in a fresh receiver-profile context without importing application code. */
export async function auditSavedMixedBrowser(page, fixture) {
  return page.evaluate(async f => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("native-destination"),
      saved = await root.getDirectoryHandle(f.rootName), actualDirectories = [], files = new Map();
    async function walk(dir, prefix = "") {
      for await (const [name, handle] of dir.entries()) {
        const path = prefix + name;
        if (handle.kind === "directory") { actualDirectories.push(path); await walk(handle, path + "/"); }
        else if (handle.kind === "file") files.set(path, await handle.getFile());
        else throw Error("Unknown saved entry type");
      }
    }
    await walk(saved);
    if (JSON.stringify(actualDirectories.sort()) !== JSON.stringify(f.directories) ||
        JSON.stringify([...files.keys()].sort()) !== JSON.stringify(f.files.map(x => x.path))) throw Error("Saved exact path/type mismatch");
    let everyByteCompared = 0;
    for (const entry of f.files) {
      const file = files.get(entry.path);
      if (file.size !== entry.bytes) throw Error("Saved file size mismatch");
      for (let offset = 0; offset < file.size || offset === 0; offset += 1048576) {
        const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 1048576)).arrayBuffer());
        const parts = [];
        for (let start = 0; start < bytes.length; start += 32768) parts.push(String.fromCharCode(...bytes.subarray(start, start + 32768)));
        await window.__compareNativeMixed({ path: entry.path, offset, data: btoa(parts.join("")), end: offset + bytes.length === file.size });
        everyByteCompared += bytes.length;
        if (file.size === 0) break;
      }
    }
    return { files: files.size, directories: actualDirectories.length, everyByteCompared, freshProfileReopened: true };
  }, fixture);
}
