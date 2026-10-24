import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertSupportedNode, launchOfflineApplication, openDefaultBrowser, runLauncher } from "../scripts/launch.mjs";
import { inventory } from "../scripts/verify-release.mjs";
import { freeSignalPort } from "./free-signal-port.mjs";

const roots = [];
const applications = [];
afterEach(async () => {
  for (const application of applications.splice(0)) await application.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(serverCode) {
  const root = await mkdtemp(join(tmpdir(), "qrft-launcher with spaces-"));
  roots.push(root);
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "dist"));
  for (const name of ["serve.mjs", "runtime-policy.mjs", "rendezvous.mjs", "lan-signaling.mjs", "local-http-security.mjs"]) {
    await copyFile(resolve("scripts", name), join(root, "scripts", name));
  }
  if (serverCode) await writeFile(join(root, "scripts/serve.mjs"), serverCode);
  await writeFile(join(root, "dist/index.html"), "launcher fixture");
  await writeFile(join(root, "CHECKSUMS.json"), JSON.stringify({ schema: "qrft-offline-release-v1", files: await inventory(root) }));
  const port = await freeSignalPort();
  let signalPort = await freeSignalPort();
  while (signalPort === port) signalPort = await freeSignalPort();
  return { directory: root, env: { ...process.env, QRFT_PORT: String(port), QRFT_SIGNAL_PORT: String(signalPort) }, port, signalPort };
}

async function expectPortReleased(port) {
  const server = createServer();
  try { await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveListen); }); }
  finally { if (server.listening) await new Promise((resolveClose) => server.close(resolveClose)); }
}

it("opens only a verified, listening bundle and stops HTTP plus active pairing sockets", async () => {
  const options = await fixture();
  const opened = [];
  const application = await launchOfflineApplication({ ...options, openBrowser: async (url) => {
    expect(await (await fetch(url)).text()).toBe("launcher fixture");
    opened.push(url);
  } });
  applications.push(application);
  expect(opened).toEqual([`http://127.0.0.1:${options.port}`]);
  // Even an invalid offer starts the real pairing service before validation.
  const response = await fetch(`${application.url}/api/rendezvous/rooms`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: application.url }, body: "{}",
  });
  expect(response.status).toBe(400);
  expect((await application.stop()).code).toBe(0);
  expect((await application.stop()).code).toBe(0);
  await expectPortReleased(options.port);
  await expectPortReleased(options.signalPort);
});

it("refuses a changed bundle without opening a browser or starting a server", async () => {
  const options = await fixture();
  await writeFile(join(options.directory, "dist/index.html"), "corrupt");
  let opened = false;
  await expect(launchOfflineApplication({ ...options, openBrowser: async () => { opened = true; } })).rejects.toThrow("copy is incomplete or has changed");
  expect(opened).toBe(false);
  await expectPortReleased(options.port);
});

it("reports an occupied application address and leaves the existing listener intact", async () => {
  const options = await fixture();
  const existing = createServer((_request, response) => response.end("existing listener"));
  await new Promise((resolveListen) => existing.listen(options.port, "127.0.0.1", resolveListen));
  let opened = false;
  try {
    await expect(launchOfflineApplication({ ...options, openBrowser: async () => { opened = true; } })).rejects.toThrow("already open, or its local address is in use");
    expect(opened).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${options.port}`)).text()).toBe("existing listener");
  } finally { await new Promise((resolveClose) => existing.close(resolveClose)); }
});

it("stops its own runtime if opening the browser fails", async () => {
  const options = await fixture();
  await expect(launchOfflineApplication({ ...options, openBrowser: async () => { throw new Error("browser unavailable"); } })).rejects.toThrow("browser unavailable");
  await expectPortReleased(options.port);
});

it("cancels an active launcher and releases its runtime", async () => {
  const options = await fixture();
  const controller = new AbortController();
  const application = await launchOfflineApplication({ ...options, signal: controller.signal, openBrowser: async () => {} });
  applications.push(application);
  controller.abort();
  expect((await application.closed).code).toBe(0);
  await expectPortReleased(options.port);
});

it("Enter stops the console launcher cleanly without sending a Windows interrupt", async () => {
  const options = await fixture();
  const input = new PassThrough();
  let output = "";
  let errors = "";
  let ready;
  const shown = new Promise((resolveShown) => { ready = resolveShown; });
  const finished = runLauncher({ ...options, input, openBrowser: async () => {},
    output: new Writable({ write(chunk, _encoding, done) {
      output += chunk.toString();
      if (output.includes("Press Enter here to close it.")) ready();
      done();
    } }),
    errorOutput: new Writable({ write(chunk, _encoding, done) { errors += chunk.toString(); done(); } }),
  });
  try {
    await Promise.race([shown, finished.then(() => { throw new Error(`Launcher stopped before the prompt: ${errors}`); })]);
    expect(await (await fetch(`http://127.0.0.1:${options.port}`)).text()).toBe("launcher fixture");
    input.write("\r\n");
    expect(await finished).toBe(0);
    expect(errors).toBe("");
    await expectPortReleased(options.port);
  } finally { input.end(); await finished; }
});

it("closes the runtime when its launcher IPC connection disappears", async () => {
  const options = await fixture();
  const child = spawn(process.execPath, [join(options.directory, "scripts/serve.mjs")], {
    cwd: options.directory, env: options.env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // On this Windows Node build a parent-initiated IPC disconnect can omit the
  // ChildProcess close event even after exit. Observe actual process exit.
  const exited = once(child, "exit");
  try {
    const [ready] = await once(child, "message");
    expect(ready).toEqual({ type: "qrft-runtime-ready", url: `http://127.0.0.1:${options.port}` });
    child.disconnect();
    expect((await exited)[0]).toBe(0);
    expect(stderr).toBe("");
    await expectPortReleased(options.port);
  } finally { if (child.exitCode === null) { child.kill(); await exited; } }
});

it("times out a stalled startup and waits for that child to stop", async () => {
  const options = await fixture("process.on('message', () => process.disconnect());");
  let opened = false;
  await expect(launchOfflineApplication({ ...options, startupTimeoutMs: 150, openBrowser: async () => { opened = true; } })).rejects.toThrow("too long to start");
  expect(opened).toBe(false);
  await expectPortReleased(options.port);
});

it("never opens non-loopback or shell-bearing addresses", async () => {
  for (const url of ["https://example.test", "http://localhost:4173", "http://127.0.0.1:65536", "http://127.0.0.1:4173&echo unexpected", "http://127.0.0.1:4173/path"]) {
    await expect(openDefaultBrowser(url)).rejects.toThrow("invalid local address");
  }
  const options = await fixture("process.send({type:'qrft-runtime-ready',url:'https://example.test'}); process.on('message', () => process.disconnect());");
  let opened = false;
  await expect(launchOfflineApplication({ ...options, openBrowser: async () => { opened = true; } })).rejects.toThrow("invalid local address");
  expect(opened).toBe(false);
});

it("rejects unsupported runtime versions before launch", () => {
  for (const version of ["18.20.0", "20.18.3", "21.7.0", "22.11.0", "23.9.0"]) expect(() => assertSupportedNode(version)).toThrow("newer runtime");
  for (const version of ["22.23.4", "24.22.1", "26.12.1"]) expect(() => assertSupportedNode(version)).not.toThrow();
});
