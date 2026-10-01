import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory, verifyRelease } from "./verify-release.mjs";
import { readPackagingOptions, prepareWindowsRuntime } from "./windows-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = ["launch.mjs", "serve.mjs", "rendezvous.mjs", "lan-signaling.mjs", "local-http-security.mjs", "verify-release.mjs", "create-fixture.mjs", "compare-trees.mjs"];
try {
  const options = readPackagingOptions(process.argv.slice(2));
  const output = resolve(options.output ?? resolve(root, "artifacts", `qrft-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  const windowsRuntime = options.runtimeDirectory ? await prepareWindowsRuntime(options.runtimeDirectory, options.runtimeSha256) : undefined;
  const assets = await inventory(resolve(root, "dist"));
  if (!assets.some((file) => file.path === "index.html")) throw new Error("Build the application before packaging.");
  // Refuse existing destinations. A failed staging directory is left for inspection.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const paths = [...assets.map((file) => `dist/${file.path}`), ...runtime.map((file) => `scripts/${file}`), "Start AirGap QR.cmd", "README.md", "TRANSFER_PROCESS.md", "PHYSICAL-TEST-RECORD.md"];
  for (const path of paths) {
    await mkdir(dirname(resolve(output, path)), { recursive: true });
    await copyFile(resolve(root, path), resolve(output, path));
  }
  await mkdir(resolve(output, "templates"));
  await copyFile(resolve(root, "release-evidence/physical-test-record.json"), resolve(output, "templates/physical-test-record.json"));
  const packageInfo = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (windowsRuntime) {
    await mkdir(resolve(output, "runtime"));
    await writeFile(resolve(output, "runtime/node.exe"), windowsRuntime.binary);
    await writeFile(resolve(output, "runtime/LICENSE"), windowsRuntime.license);
    await writeFile(resolve(output, "runtime/ORIGIN.json"), JSON.stringify({
      ...windowsRuntime.identity,
      provenance: "Builder-supplied runtime and pinned SHA-256. Verify the pin against an independent official source before building. A local checksum does not authenticate the publisher.",
    }, null, 2) + "\n");
  }
  const runtimeNotice = windowsRuntime
    ? `Includes Windows x64 Node.js ${windowsRuntime.identity.version} and its full license notices.\nNo Node installation or npm install is needed. A supported Chromium browser\nis required and is not included. This runtime bundle targets Windows x64 only.`
    : `Requires Node.js ${packageInfo.engines.node} and a supported Chromium browser.\nNode and the browser are not included. No npm install is needed here.`;
  await writeFile(resolve(output, "START-HERE.txt"), `QR/Wi-Fi File Transfer — offline test bundle\n\n${runtimeNotice}\n\n1. Copy this whole folder to each laptop. Keep its files unchanged.\n2. Double-click Start AirGap QR.cmd. It checks this copy and opens your\n   default browser. Use a supported Chromium browser for transfers.\n3. Keep the launcher window open while using the app.\n4. If startup reports a missing runtime, ask the person who supplied the\n   bundle to complete the Windows setup. No download happens automatically.\n5. For Wi-Fi: connect both laptops to the same local network, then choose\n   Send on the sending laptop and Receive on the other. Follow the quick start in\n   TRANSFER_PROCESS.md, including device-code comparison and final saving.\n   For optical QR: open Other transfer methods on the home screen.\n6. For release testing, follow PHYSICAL-TEST-RECORD.md. Copy the blank\n   templates/physical-test-record.json to an evidence folder outside this\n   bundle before filling it in. Keep bundled files unchanged.\n7. Press Enter in the launcher window to close the local app.\n\nChecksums detect copy errors; they do not authenticate the publisher.\nThis bundle is NOT a declaration of release readiness. Real two-laptop\nvalidation is required before READY.\n`, "utf8");
  await writeFile(resolve(output, "CHECKSUMS.json"), JSON.stringify({ schema: "qrft-offline-release-v1", version: packageInfo.version, createdAt: new Date().toISOString(), files: await inventory(output) }, null, 2) + "\n");
  console.log(`Packaged and verified ${await verifyRelease(output)} files at ${output}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
