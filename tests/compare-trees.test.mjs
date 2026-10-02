import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots = [];
const script = fileURLToPath(new URL("../scripts/compare-trees.mjs", import.meta.url));
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qrft-tree-check-")); roots.push(root);
  const source = join(root, "source"); const destination = join(root, "destination");
  await mkdir(join(source, "empty/nested"), { recursive: true });
  await writeFile(join(source, "data.bin"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(source, "zero.bin"), "");
  await cp(source, destination, { recursive: true });
  return { root, source, destination, run: (target = destination) => spawnSync(process.execPath, [script, source, target], { encoding: "utf8" }) };
}

it("accepts exact copies with empty files and nested empty directories", async () => {
  const { run } = await fixture(); const result = run();
  expect(result.status).toBe(0); expect(result.stdout).toContain("2 files, 2 directories");
});

for (const kind of ["changed", "missing", "extra", "empty-directory", "wrong-type"]) {
  it(`rejects a ${kind} destination`, async () => {
    const { destination, run } = await fixture();
    if (kind === "changed") await writeFile(join(destination, "data.bin"), Buffer.from([0, 1, 3, 255]));
    if (kind === "missing") await rm(join(destination, "zero.bin"));
    if (kind === "extra") await writeFile(join(destination, "extra.bin"), "");
    if (kind === "empty-directory") await rm(join(destination, "empty/nested"), { recursive: true });
    if (kind === "wrong-type") { await rm(join(destination, "zero.bin")); await mkdir(join(destination, "zero.bin")); }
    const result = run(); expect(result.status).toBe(1); expect(result.stderr).toContain("Verification failed");
  });
}

it("rejects self-comparison and junction roots", async () => {
  const { root, source, run } = await fixture();
  expect(run(source).stderr).toContain("same directory");
  expect(run(source).status).not.toBe(0);
  const link = join(root, "alias");
  await symlink(source, link, process.platform === "win32" ? "junction" : "dir");
  try { const result = run(link); expect(result.status).not.toBe(0); expect(result.stderr).toContain("real directories"); }
  finally { await rm(link); }
});

it("records outside the source and verifies the destination without the source present", async () => {
  const { root, source, destination } = await fixture();
  const manifest = join(root, "source.json");
  const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  expect(invoke("--record", source, join(source, "manifest.json")).status).not.toBe(0);
  const recorded = invoke("--record", source, manifest);
  expect(recorded.status).toBe(0);
  const original = await readFile(manifest, "utf8");
  expect(invoke("--record", source, manifest).status).not.toBe(0);
  expect(await readFile(manifest, "utf8")).toBe(original);
  await rm(source, { recursive: true });
  const verified = invoke("--manifest", manifest, destination);
  expect(verified.status).toBe(0);
  expect(verified.stdout).toContain(recorded.stdout.match(/Manifest SHA-256: ([a-f0-9]+)/)[1]);
  await writeFile(join(destination, "data.bin"), Buffer.from([0, 1, 3, 255]));
  expect(invoke("--manifest", manifest, destination).status).toBe(1);
});

it("rejects malformed and duplicate manifest entries", async () => {
  const { root, destination } = await fixture();
  const manifest = join(root, "invalid.json");
  for (const entries of [
    [["../escape", { type: "directory" }]],
    [["empty", { type: "directory" }], ["empty", { type: "directory" }]],
    [["file", { type: "file", bytes: -1, sha256: "0".repeat(64) }]],
    [["file", { type: "file", bytes: 0, sha256: "invalid" }]],
  ]) {
    await writeFile(manifest, JSON.stringify({ schema: "qrft-tree-inventory-v1", entries }));
    expect(spawnSync(process.execPath, [script, "--manifest", manifest, destination]).status).not.toBe(0);
  }
});

for (const mutation of ["growth", "same-size rewrite"]) it(`refuses to record ${mutation} during a file hash read`, async () => {
  const { root, source } = await fixture();
  const output = join(root, "unstable.json");
  // Install a deterministic filesystem mutation at the real read boundary.
  // No timing race or production test hook is needed.
  const hook = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original = fs.createReadStream;
    fs.createReadStream = function(path, ...args) {
      const stream = original.call(this, path, ...args);
      if (String(path).endsWith('data.bin')) stream.once('data', () => {
        ${mutation === "growth" ? "fs.appendFileSync(path, 'changed');" : "fs.writeFileSync(path, Buffer.from([4, 3, 2, 1])); const time = new Date(Date.now() + 2000); fs.utimesSync(path, time, time);"}
      });
      return stream;
    }; syncBuiltinESMExports();`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, script, "--record", source, output], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("File changed while hashing");
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
});
