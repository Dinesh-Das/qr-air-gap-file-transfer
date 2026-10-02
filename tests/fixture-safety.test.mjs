import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixtureProject() {
  const root = await mkdtemp(join(tmpdir(), "qrft-fixture-safety-"));
  roots.push(root);
  const app = join(root, "app");
  await mkdir(join(app, "scripts"), { recursive: true });
  const script = join(app, "scripts/create-fixture.mjs");
  await copyFile(new URL("../scripts/create-fixture.mjs", import.meta.url), script);
  return { root, app, run: (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }) };
}

it("creates a new fixture and refuses to overwrite existing user contents", async () => {
  const { app, run } = await fixtureProject();
  expect(run().status).toBe(0);
  const sentinel = join(app, ".tmp/qrft-fixture-source/keep.txt");
  await writeFile(sentinel, "keep me");
  expect(run().status).not.toBe(0);
  expect(await readFile(sentinel, "utf8")).toBe("keep me");
  expect(run(".tmp/nested/qrft-fixture-source").status).not.toBe(0);
  expect(run("../qrft-fixture-outside").status).not.toBe(0);
});

it("refuses a redirected staging directory without touching its target", async () => {
  const { root, app, run } = await fixtureProject();
  const outside = join(root, "outside");
  await mkdir(join(outside, "qrft-fixture-source"), { recursive: true });
  const sentinel = join(outside, "qrft-fixture-source/keep.txt");
  await writeFile(sentinel, "keep me");
  const link = join(app, ".tmp");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  try {
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must not redirect");
    expect(await readFile(sentinel, "utf8")).toBe("keep me");
  } finally { await rm(link); }
});

it("refuses an existing fixture-root junction without following it", async () => {
  const { root, app, run } = await fixtureProject();
  const outside = join(root, "outside");
  await mkdir(outside);
  const sentinel = join(outside, "keep.txt");
  await writeFile(sentinel, "keep me");
  await mkdir(join(app, ".tmp"));
  const link = join(app, ".tmp/qrft-fixture-source");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  try {
    expect(run().status).not.toBe(0);
    expect(await readFile(sentinel, "utf8")).toBe("keep me");
  } finally { await rm(link); }
});
