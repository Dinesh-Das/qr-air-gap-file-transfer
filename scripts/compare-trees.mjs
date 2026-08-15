import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const [sourceArgument, destinationArgument] = process.argv.slice(2);

if (!sourceArgument || !destinationArgument) {
  console.error(
    "Usage: node scripts/compare-trees.mjs <source-folder> <destination-folder>",
  );
  process.exit(2);
}

const sourceRoot = resolve(sourceArgument);
const destinationRoot = resolve(destinationArgument);

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
        const info = await stat(absolutePath);
        result.set(path, {
          type: "file",
          bytes: info.size,
          sha256: await hashFile(absolutePath),
        });
      }
    }
  }

  await walk(root);
  return result;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const [source, destination] = await Promise.all([
  inventory(sourceRoot),
  inventory(destinationRoot),
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
    source.get(path).sha256 !== destination.get(path).sha256,
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
