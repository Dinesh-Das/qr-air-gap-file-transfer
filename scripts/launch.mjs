import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyRelease } from "./verify-release.mjs";
import { assertSupportedNode } from "./runtime-policy.mjs";
export { assertSupportedNode } from "./runtime-policy.mjs";

const defaultDirectory = fileURLToPath(new URL("../", import.meta.url));

function assertLocalUrl(url) {
  const match = typeof url === "string" && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(url);
  if (!match || Number(match[1]) > 65535) throw new Error("The application returned an invalid local address.");
}

export async function openDefaultBrowser(url) {
  assertLocalUrl(url);
  if (process.platform !== "win32") throw new Error("This launcher requires Windows.");
  const windowsDirectory = process.env.SystemRoot;
  if (!windowsDirectory || !isAbsolute(windowsDirectory)) {
    throw new Error("The Windows system directory is unavailable. Reopen the app from a normal Windows session and try again.");
  }
  // Pin the system executable so an unrelated cmd.exe in cwd or PATH cannot
  // block browser opening or run in place of the Windows shell.
  const commandInterpreter = resolve(windowsDirectory, "System32", "cmd.exe");
  // Only the validated numeric loopback URL reaches cmd's built-in start.
  // No path, argument, or environment text is interpolated into shell code.
  await new Promise((resolveOpen, reject) => {
    // cmd does not understand the backslash-escaped quotes used by the normal
    // Windows argv serializer. Pass only this fixed, validated command verbatim.
    const opener = spawn(commandInterpreter, ["/d", "/s", "/c", `start "" "${url}"`], {
      windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore",
    });
    const timer = setTimeout(() => {
      opener.kill();
      reject(new Error("Windows took too long to open the browser. Check your default browser setting and try again."));
    }, 10_000);
    opener.once("error", (error) => { clearTimeout(timer); reject(error); });
    opener.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolveOpen() : reject(new Error("Windows could not open the default browser. Check your default browser setting and try again."));
    });
  });
}

/** Start an intact offline bundle. The child owns all runtime sockets. */
export async function launchOfflineApplication({
  directory = defaultDirectory,
  env = process.env,
  signal,
  openBrowser = openDefaultBrowser,
  startupTimeoutMs = 15_000,
} = {}) {
  assertSupportedNode();
  signal?.throwIfAborted();
  try { await verifyRelease(directory); }
  catch (error) {
    throw new Error("This copy is incomplete or has changed. Copy the complete offline bundle again before opening it.", { cause: error });
  }
  signal?.throwIfAborted();

  const child = spawn(process.execPath, [resolve(directory, "scripts/serve.mjs")], {
    cwd: directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let details = "";
  let exited = false;
  let spawnError;
  const collect = (chunk) => { details = (details + chunk.toString()).slice(-8192); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.once("error", (error) => { spawnError = error; });
  const closed = new Promise((resolveClosed) => child.once("close", (code, exitSignal) => {
    exited = true;
    resolveClosed({ code, signal: exitSignal, details, error: spawnError });
  }));
  let stopping;
  function stop() {
    return stopping ??= (async () => {
      if (exited) return closed;
      const forceStop = setTimeout(() => child.kill(), 5000);
      forceStop.unref();
      try {
        if (child.connected) child.send({ type: "qrft-runtime-stop" }, (error) => { if (error && !exited) child.kill(); });
        else child.kill();
        return await closed;
      } finally { clearTimeout(forceStop); }
    })();
  }

  let readyMessage;
  let abort;
  let timer;
  const ready = new Promise((resolveReady, reject) => {
    readyMessage = (message) => {
      if (message?.type !== "qrft-runtime-ready") return;
      try { assertLocalUrl(message.url); resolveReady(message.url); }
      catch (error) { reject(error); }
    };
    child.on("message", readyMessage);
    closed.then((result) => reject(new Error(result.error?.message || result.details.trim() || "The application stopped before it could open. Try opening it again.")));
    timer = setTimeout(() => reject(new Error("The application took too long to start. Close other copies and try again.")), startupTimeoutMs);
    abort = () => { reject(signal.reason); void stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  // Keep cancellation active after startup, so Ctrl+C always stops the child.
  void closed.then(() => signal?.removeEventListener("abort", abort));
  try {
    const url = await ready;
    clearTimeout(timer);
    signal?.throwIfAborted();
    await openBrowser(url);
    signal?.throwIfAborted();
    if (exited) throw new Error(details.trim() || "The application stopped while opening the browser.");
    return { url, stop, closed };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    child.off("message", readyMessage);
  }
}

export async function runLauncher({ input = process.stdin, output = process.stdout, errorOutput = process.stderr, ...options } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const keyboard = createInterface({ input, terminal: false });
  keyboard.once("line", stop);
  keyboard.once("close", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    output.write("Checking this copy of AirGap QR...\n");
    const application = await launchOfflineApplication({ ...options, signal: controller.signal });
    output.write(`AirGap QR is open at ${application.url}\n`);
    output.write("Keep this window open while using the app. Press Enter here to close it.\n");
    const result = await application.closed;
    if (!controller.signal.aborted && result.code !== 0) throw new Error(result.details.trim() || "The application stopped unexpectedly. Open it again to reconnect.");
    return 0;
  } catch (error) {
    if (!controller.signal.aborted) { errorOutput.write(`${error.message}\n`); return 1; }
    return 0;
  } finally {
    keyboard.off("line", stop);
    keyboard.off("close", stop);
    keyboard.close();
    input.pause();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runLauncher();
}
