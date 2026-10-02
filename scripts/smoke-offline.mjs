import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { freeSignalPort } from "../tests/free-signal-port.mjs";
const staging = await mkdtemp(join(tmpdir(), "qrft-offline-smoke-"));
const bundle = join(staging, "bundle with spaces");
let child;
try {
  const packaged = spawnSync(process.execPath, [resolve("scripts/package-offline.mjs"), bundle], { encoding: "utf8" });
  if (packaged.status !== 0) throw new Error(packaged.stderr);
  const duplicate = spawnSync(process.execPath, [resolve("scripts/package-offline.mjs"), bundle], { encoding: "utf8" });
  if (duplicate.status === 0) throw new Error("Existing destination accepted");
  const port = await freeSignalPort();
  let signalPort = await freeSignalPort();
  while (signalPort === port) signalPort = await freeSignalPort();
  child = spawn(process.execPath, [join(bundle, "scripts/serve.mjs")], { cwd: staging, env: { ...process.env, QRFT_PORT: String(port), QRFT_SIGNAL_PORT: String(signalPort) }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "exit");
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Launch timeout: ${output}`)), 10000);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("AirGap QR is running")) { clearTimeout(timer); resolve(); } });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
  });
  const manifest = JSON.parse(await readFile(join(bundle, "CHECKSUMS.json"), "utf8"));
  let assets = 0;
  for (const file of manifest.files.filter((entry) => entry.path.startsWith("dist/"))) {
    const response = await fetch(`http://127.0.0.1:${port}/${file.path.slice(5)}`);
    const actual = Buffer.from(await response.arrayBuffer());
    if (!response.ok || !actual.equals(await readFile(join(bundle, file.path)))) throw new Error(`Bad asset ${file.path}`);
    assets++;
  }
  const physicalTemplate = JSON.parse(await readFile(join(bundle, "templates/physical-test-record.json"), "utf8"));
  if (physicalTemplate.releaseReady !== false || physicalTemplate.cases.length !== 42 ||
      physicalTemplate.cases.some((item) => item.status !== "not-run" || item.repetitions.length !== 0)) {
    throw new Error("Offline physical-test template is not a blank, unrun record.");
  }
  const verified = spawnSync(process.execPath, [join(bundle, "scripts/verify-release.mjs")], { cwd: staging, encoding: "utf8" });
  if (verified.status !== 0) throw new Error(verified.stderr);
  const result = { ranAt: new Date().toISOString(), node: process.version, packagedFiles: manifest.files.length, physicalTemplateCases: physicalTemplate.cases.length, fetchedAssets: assets, isolatedDirectoryOutsideRepository: true, pathWithSpaces: true, arbitraryWorkingDirectory: true, existingDestinationRefused: true, checksumVerification: verified.stdout.trim(), launch: output.trim() };
  child.kill(); await closed; child = undefined;
  if (!manifest.files.some((file) => file.path === "Start AirGap QR.cmd")) throw new Error("Windows launcher is missing.");
  const { launchOfflineApplication } = await import(pathToFileURL(join(bundle, "scripts/launch.mjs")));
  let browserHandoff = false;
  const application = await launchOfflineApplication({ directory: bundle,
    env: { ...process.env, QRFT_PORT: String(port), QRFT_SIGNAL_PORT: String(signalPort) },
    openBrowser: async (url) => {
      if (!Buffer.from(await (await fetch(url)).arrayBuffer()).equals(await readFile(join(bundle, "dist/index.html")))) throw new Error("Launcher opened the wrong app.");
      browserHandoff = true;
    },
  });
  try {
    if (!browserHandoff) throw new Error("Launcher did not request browser opening.");
  } finally {
    if ((await application.stop()).code !== 0) throw new Error("Launcher did not stop cleanly.");
  }
  Object.assign(result, { launcherStartedAndStopped: true, browserHandoff: "injected observer; native Windows browser opening not tested" });
  await writeFile(resolve("release-evidence/offline-package-smoke.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  if (child && child.exitCode === null) { const closed = once(child, "exit"); child.kill(); await closed; }
  await rm(staging, { recursive: true, force: true });
}
