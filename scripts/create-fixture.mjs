import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const fixtureStagingDirectory = resolve(projectDirectory, ".tmp");
const fixtureRoot = resolve(
  projectDirectory,
  process.argv[2] ?? ".tmp/qrft-fixture-source",
);
const pathFromStaging = relative(fixtureStagingDirectory, fixtureRoot);

if (
  fixtureRoot === fixtureStagingDirectory ||
  pathFromStaging === ".." ||
  pathFromStaging.startsWith(`..${sep}`) ||
  isAbsolute(pathFromStaging) ||
  !basename(fixtureRoot).startsWith("qrft-fixture")
) {
  throw new Error(
    'For safety, the generated fixture must be a "qrft-fixture*" folder directly beneath this project’s .tmp directory.',
  );
}

await rm(fixtureRoot, { recursive: true, force: true });
await mkdir(fixtureRoot, { recursive: true });

const files = new Map([
  ["README.txt", Buffer.from("AirGap QR fixture\nनमस्ते • こんにちは • café\n", "utf8")],
  ["empty file.txt", Buffer.alloc(0)],
  ["duplicates/first.bin", Buffer.from([0, 1, 2, 3, 254, 255])],
  ["duplicates/second.bin", Buffer.from([0, 1, 2, 3, 254, 255])],
  ["Mixed Case/Config.JSON", Buffer.from('{"exact":true,"value":42}\n', "utf8")],
  [
    "four/levels/deep/inside/five/notes.md",
    Buffer.from("# Deep file\nEvery byte matters.\n", "utf8"),
  ],
  [
    "images/pixel.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xmy2WQAAAABJRU5ErkJggg==",
      "base64",
    ),
  ],
  [
    "images/photo.jpg",
    Buffer.from(
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
      "base64",
    ),
  ],
]);

for (let index = 0; index < 120; index += 1) {
  files.set(
    `many-small/entry ${index.toString().padStart(3, "0")}.txt`,
    Buffer.from(`small file ${index}\n`, "utf8"),
  );
}

for (const [relativePath, data] of files) {
  const absolutePath = resolve(fixtureRoot, relativePath);
  await mkdir(resolve(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, data);
}

await mkdir(resolve(fixtureRoot, "an empty directory"), { recursive: true });

console.log(`Created ${files.size} files at ${fixtureRoot}`);
