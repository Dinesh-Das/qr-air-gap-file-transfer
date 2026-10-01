import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inventory, verifyRelease } from "../scripts/verify-release.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("verifies a copied tree and rejects altered, missing, and unexpected files", async () => {
  const root = await mkdtemp(join(tmpdir(), "qrft-release-test-"));
  roots.push(root);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/index.html"), "fixture");
  await writeFile(join(root, "CHECKSUMS.json"), JSON.stringify({ schema: "qrft-offline-release-v1", files: await inventory(root) }));
  expect(await verifyRelease(root)).toBe(1);
  await writeFile(join(root, "dist/index.html"), "changed");
  await expect(verifyRelease(root)).rejects.toThrow("do not match");
  await rm(join(root, "dist/index.html"));
  await expect(verifyRelease(root)).rejects.toThrow("do not match");
  await writeFile(join(root, "dist/index.html"), "fixture");
  await writeFile(join(root, "extra.txt"), "unexpected");
  await expect(verifyRelease(root)).rejects.toThrow("do not match");
});
