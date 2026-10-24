// Serialized into the diagnostic browser before application code runs.
export function installNativeMixedReadGuard() {
  const tracked = new WeakMap(), restore = [];
  const replace = (prototype, name, wrapper) => {
    const original = prototype?.[name];
    if (typeof original !== "function") return;
    prototype[name] = wrapper(original);
    restore.push(() => { prototype[name] = original; });
  };
  replace(Blob.prototype, "slice", original => function (...args) {
    const blob = Reflect.apply(original, this, args), state = tracked.get(this);
    if (state) tracked.set(blob, state);
    return blob;
  });
  replace(Blob.prototype, "arrayBuffer", original => async function (...args) {
    const state = tracked.get(this);
    if (state && this.size > 4194304) throw Error("Unbounded native source read");
    const bytes = await Reflect.apply(original, this, args);
    if (state) { state.nativeReadBytes += bytes.byteLength; state.maxNativeRead = Math.max(state.maxNativeRead, bytes.byteLength); }
    return bytes;
  });
  for (const name of ["text", "stream", "bytes"]) replace(Blob.prototype, name, original => function (...args) {
    if (tracked.has(this)) throw Error("Unsupported native source read API: " + name);
    return Reflect.apply(original, this, args);
  });
  for (const name of ["readAsArrayBuffer", "readAsBinaryString", "readAsDataURL", "readAsText"])
    replace(globalThis.FileReader?.prototype, name, original => function (blob, ...args) {
      if (tracked.has(blob)) throw Error("Unsupported native source FileReader API");
      return Reflect.apply(original, this, [blob, ...args]);
    });
  globalThis.__guardNativeMixedFiles = (files, state) => { for (const file of files) tracked.set(file, state); };
  return () => { for (const undo of restore) undo(); delete globalThis.__guardNativeMixedFiles; };
}
