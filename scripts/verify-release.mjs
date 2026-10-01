import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function inventory(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await inventory(root, `${path}/`));
    else if (entry.isFile()) {
      if (path === "CHECKSUMS.json") continue;
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(resolve(root, path))) { hash.update(chunk); bytes += chunk.length; }
      files.push({ path, bytes, sha256: hash.digest("hex") });
    } else throw new Error(`Unsupported release entry: ${path}`);
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function verifyRelease(root) {
  const manifest = JSON.parse(await readFile(resolve(root, "CHECKSUMS.json"), "utf8"));
  if (manifest.schema !== "qrft-offline-release-v1" || !Array.isArray(manifest.files)) throw new Error("Invalid release manifest.");
  const actual = await inventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("Release contents do not match CHECKSUMS.json (missing, extra, or changed files).");
  return actual.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../", import.meta.url));
    console.log(`Verified ${await verifyRelease(root)} release files. This checks copy integrity, not publisher authenticity.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
