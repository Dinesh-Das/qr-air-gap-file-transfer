import { beforeAll, afterAll, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, open, rm, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { writeNativeMixedTree } from "../scripts/native-mixed-tree.mjs";
import { auditNativeMixedSource } from "../scripts/native-mixed-contract.mjs";
import { createNativeMixedComparator, auditNativeMixedPayload } from "../scripts/native-mixed-audit.mjs";

let parent, fixture, sourceAudit;
beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "qrft-mixed-payload-test-"));
  fixture = await writeNativeMixedTree(join(parent, "fixture"), "smoke");
  sourceAudit = await auditNativeMixedSource(fixture, "smoke");
});
afterAll(async () => {
  if (!parent) return;
  expect(dirname(resolve(parent))).toBe(resolve(tmpdir()));
  expect(basename(parent).startsWith("qrft-mixed-payload-test-")).toBe(true);
  expect((await lstat(parent)).isSymbolicLink()).toBe(false);
  await rm(parent, { recursive: true });
});

async function profilePayload() {
  const profile = join(parent, randomUUID()), directory = join(profile, "Default/File System/000");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "retained-payload");
  const chunks = [];
  for (const f of fixture.files) chunks.push(await readFile(join(fixture.sourceDirectory, f.path)));
  chunks.push(Buffer.from(sourceAudit.metadataHex + sourceAudit.footerHex, "hex"));
  await writeFile(path, Buffer.concat(chunks));
  return { profile, path };
}

it("independently compares every saved file byte including empty files", async () => {
  const compare = createNativeMixedComparator(fixture);
  try {
    for (const f of fixture.files) {
      let offset = 0;
      for await (const bytes of createReadStream(join(fixture.sourceDirectory, f.path), { highWaterMark: 1048576 })) {
        await compare.compare({ path: f.path, offset, data: bytes.toString("base64"), end: offset + bytes.length === f.bytes }); offset += bytes.length;
      }
      if (f.bytes === 0) await compare.compare({ path: f.path, offset: 0, data: "", end: true });
    }
    expect(compare.finish()).toEqual({ files: 21, everyByteCompared: 8388673 });
  } finally { await compare.close(); }
});

it("fails closed after an incorrect path and refuses a later completion", async () => {
  const compare = createNativeMixedComparator(fixture);
  try {
    await expect(compare.compare({ path: "../outside", offset: 0, data: "", end: true })).rejects.toThrow();
    await expect(compare.compare({ path: fixture.files[0].path, offset: 0, data: "", end: true })).rejects.toThrow("failed");
    expect(() => compare.finish()).toThrow("failed");
  } finally { await compare.close(); }
});

it("refuses oversized audit messages", async () => {
  const compare = createNativeMixedComparator(fixture);
  try {
    await expect(compare.compare({ path: fixture.files[0].path, offset: 0, data: Buffer.alloc(1048577).toString("base64"), end: false })).rejects.toThrow("Unbounded");
    expect(() => compare.finish()).toThrow();
  } finally { await compare.close(); }
});

it("audits the physical retained stream, canonical metadata and footer", async () => {
  const { profile } = await profilePayload();
  const result = await auditNativeMixedPayload(profile, fixture, sourceAudit);
  expect(result).toMatchObject({ everyFileByteCompared: 8388673, everyStreamByteCompared: sourceAudit.streamBytes, streamSha256: sourceAudit.streamSha256, metadataFooterMatched: true });
});

it.each(["payload", "footer"])("rejects corrupt physical %s bytes", async part => {
  const { profile, path } = await profilePayload(), file = await open(path, "r+");
  try { const position = part === "payload" ? 0 : sourceAudit.streamBytes - 1, byte = Buffer.alloc(1);
    await file.read(byte, 0, 1, position); byte[0] ^= 1; await file.write(byte, 0, 1, position); await file.sync(); }
  finally { await file.close(); }
  await expect(auditNativeMixedPayload(profile, fixture, sourceAudit)).rejects.toThrow("mismatch");
});
