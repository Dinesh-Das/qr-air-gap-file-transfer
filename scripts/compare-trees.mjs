import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const record = args[0] === "--record";
const fromManifest = args[0] === "--manifest";
const [sourceArgument, destinationArgument] = record || fromManifest ? args.slice(1) : args;

if (!sourceArgument || !destinationArgument || args.length !== (record || fromManifest ? 3 : 2)) {
  console.error(
    "Usage: node scripts/compare-trees.mjs <source-folder> <destination-folder>\n       node scripts/compare-trees.mjs --record <source-folder> <new-manifest.json>\n       node scripts/compare-trees.mjs --manifest <manifest.json> <destination-folder>",
  );
  process.exit(2);
}

const sourceRoot = resolve(sourceArgument);
const destinationRoot = resolve(destinationArgument);
for (const root of record ? [sourceRoot] : fromManifest ? [destinationRoot] : [sourceRoot, destinationRoot]) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Comparison roots must be real directories: ${root}`);
}
if (!record && !fromManifest && await realpath(sourceRoot) === await realpath(destinationRoot)) {
  throw new Error("Source and destination resolve to the same directory; this cannot verify a transfer.");
}

async function inventory(root) {
  const result = new Map();

  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolutePath = resolve(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are outside the supported scope: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        const path = relative(root, absolutePath).split(sep).join("/");
        result.set(path, { type: "directory" });
        await walk(absolutePath);
      } else if (entry.isFile()) {
        const path = relative(root, absolutePath).split(sep).join("/");
        const info = await lstat(absolutePath, { bigint: true });
        if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid file size or type: ${absolutePath}`);
        result.set(path, {
          type: "file",
          bytes: Number(info.size),
          sha256: await hashFile(absolutePath, info),
        });
      } else throw new Error(`Unsupported filesystem entry: ${absolutePath}`);
    }
  }

  await walk(root);
  return result;
}

async function hashFile(path, before) {
  const hash = createHash("sha256");
  let bytes = 0n;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += BigInt(chunk.length); }
  const after = await lstat(path, { bigint: true });
  if (!after.isFile() || bytes !== before.size ||
      ["size", "dev", "ino", "mtimeNs", "ctimeNs"].some((field) => before[field] !== after[field])) {
    throw new Error(`File changed while hashing: ${path}`);
  }
  return hash.digest("hex");
}

if (record) {
  const output = resolve(await realpath(dirname(destinationRoot)), basename(destinationRoot));
  const path = relative(await realpath(sourceRoot), output);
  if (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) throw new Error("Store the manifest outside the source tree.");
  const entries = [...await inventory(sourceRoot)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length > 100_000) throw new Error("Tree manifest exceeds 100,000 entries.");
  const encoded = JSON.stringify({ schema: "qrft-tree-inventory-v1", entries }, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new Error("Tree manifest exceeds 32 MiB.");
  await writeFile(output, encoded, { flag: "wx" });
  console.log(`Recorded ${entries.length} paths. Manifest SHA-256: ${createHash("sha256").update(encoded).digest("hex")}`);
  process.exit(0);
}

async function readManifest(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Invalid or oversized tree manifest.");
  const encoded = await readFile(path);
  if (encoded.length > 32 * 1024 * 1024) throw new Error("Oversized tree manifest.");
  const parsed = JSON.parse(encoded.toString("utf8"));
  if (parsed?.schema !== "qrft-tree-inventory-v1" || !Array.isArray(parsed.entries) || parsed.entries.length > 100_000) throw new Error("Invalid tree manifest.");
  const result = new Map();
  for (const entry of parsed.entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid manifest entry.");
    const [name, value] = entry;
    if (typeof name !== "string" || name.includes("\\") || name.includes(":" ) || name.split("/").some((part) => !part || part === "." || part === "..") || result.has(name)) throw new Error("Invalid or duplicate manifest path.");
    if (!value || !["file", "directory"].includes(value.type)) throw new Error("Invalid manifest entry type.");
    if (value.type === "file" && (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || !/^[a-f0-9]{64}$/.test(value.sha256))) throw new Error("Invalid manifest file metadata.");
    result.set(name, value);
  }
  console.log(`Manifest SHA-256: ${createHash("sha256").update(encoded).digest("hex")}`);
  return result;
}

const [source, destination] = await Promise.all([
  fromManifest ? readManifest(sourceRoot) : inventory(sourceRoot), inventory(destinationRoot),
]);

const sourcePaths = [...source.keys()].sort();
const destinationPaths = [...destination.keys()].sort();
const missing = sourcePaths.filter((path) => !destination.has(path));
const extra = destinationPaths.filter((path) => !source.has(path));
const typeMismatches = sourcePaths.filter(
  (path) =>
    destination.has(path) &&
    source.get(path).type !== destination.get(path).type,
);
const mismatched = sourcePaths.filter(
  (path) =>
    destination.has(path) &&
    source.get(path).type === "file" &&
    destination.get(path).type === "file" &&
    (source.get(path).sha256 !== destination.get(path).sha256 || source.get(path).bytes !== destination.get(path).bytes),
);

if (missing.length || extra.length || typeMismatches.length || mismatched.length) {
  console.error("Verification failed.");
  if (missing.length) console.error("Missing:", missing);
  if (extra.length) console.error("Extra:", extra);
  if (typeMismatches.length) console.error("File/directory type mismatch:", typeMismatches);
  if (mismatched.length) console.error("SHA-256 mismatch:", mismatched);
  process.exit(1);
}

const sourceFileCount = [...source.values()].filter(({ type }) => type === "file").length;
const sourceDirectoryCount = source.size - sourceFileCount;
console.log(
  `Verification passed: ${sourceFileCount} files, ${sourceDirectoryCount} directories; exact path set and every file SHA-256 match.`,
);
