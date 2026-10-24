import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export function createNativeMixedComparator(fixture) {
  let index = 0, offset = 0, file, hash, compared = 0, failed = false, busy = false;
  return {
    async compare(message) {
      if (failed || busy) { failed = true; throw new Error("Saved audit is failed or concurrent"); }
      busy = true;
      try {
      const expected = fixture.files[index]; assert(expected, "Unexpected saved file");
      assert.equal(message.path, expected.path); assert.equal(message.offset, offset);
      assert.equal(typeof message.end, "boolean"); assert.equal(typeof message.data, "string");
      assert(message.data.length <= 1398104, "Unbounded saved audit chunk");
      const bytes = Buffer.from(message.data, "base64"); assert.equal(bytes.toString("base64"), message.data);
      assert(bytes.length <= 1048576, "Unbounded saved audit chunk"); assert(offset + bytes.length <= expected.bytes);
      assert(bytes.length > 0 || expected.bytes === 0); assert.equal(message.end, offset + bytes.length === expected.bytes);
      if (!file) { file = await open(join(fixture.sourceDirectory, expected.path), "r"); hash = createHash("sha256"); }
      const native = Buffer.alloc(bytes.length); let got = 0;
      while (got < native.length) { const r = await file.read(native, got, native.length - got, offset + got); assert(r.bytesRead > 0); got += r.bytesRead; }
      assert(native.equals(bytes), "Saved native byte mismatch: " + expected.path);
      hash.update(native); offset += bytes.length; compared += bytes.length;
      if (message.end) {
        await file.close(); file = undefined;
        assert.equal(hash.digest("hex"), expected.sha256); index++; offset = 0;
      }
      } catch (error) { failed = true; throw error; }
      finally { busy = false; }
    },
    finish() { assert(!failed && !busy, "Saved audit failed"); assert.equal(index, fixture.files.length); assert.equal(offset, 0); assert.equal(compared, fixture.fileBytes); return { files: index, everyByteCompared: compared }; },
    async close() { if (file) { await file.close(); file = undefined; } },
  };
}

/** Read the closed profile's actual payload file, not an application helper. */
export async function auditNativeMixedPayload(profile, fixture, sourceAudit) {
  const matches = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      assert(!e.isSymbolicLink()); const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.isFile() && path.replaceAll("\\", "/").includes("/Default/File System/")) {
        const info = await stat(path); if (info.size === sourceAudit.streamBytes) matches.push(path);
      }
    }
  }
  await walk(profile); assert.equal(matches.length, 1, "Expected one retained native payload backing file");
  const path = matches[0], payload = await open(path, "r"), hash = createHash("sha256"); let offset = 0;
  try {
    for (const f of fixture.files) {
      const fileHash = createHash("sha256"); let fileBytes = 0;
      for await (const bytes of createReadStream(join(fixture.sourceDirectory, f.path), { highWaterMark: 1048576 })) {
        const actual = Buffer.alloc(bytes.length); let got = 0;
        while (got < actual.length) { const r = await payload.read(actual, got, actual.length - got, offset + got); assert(r.bytesRead > 0); got += r.bytesRead; }
        assert(bytes.equals(actual), "Retained payload mismatch at " + offset);
        fileHash.update(actual); hash.update(actual); fileBytes += actual.length; offset += actual.length;
      }
      assert.equal(fileBytes, f.bytes); assert.equal(fileHash.digest("hex"), f.sha256);
    }
    const expected = Buffer.from(sourceAudit.metadataHex + sourceAudit.footerHex, "hex"), tail = Buffer.alloc(expected.length); let got = 0;
    while (got < tail.length) { const r = await payload.read(tail, got, tail.length - got, offset + got); assert(r.bytesRead > 0); got += r.bytesRead; }
    assert(tail.equals(expected), "Independent metadata/footer mismatch"); hash.update(tail); offset += tail.length;
    assert.equal(offset, sourceAudit.streamBytes); assert.equal(hash.digest("hex"), sourceAudit.streamSha256);
    return { path, everyFileByteCompared: fixture.fileBytes, everyStreamByteCompared: offset,
      streamSha256: sourceAudit.streamSha256, metadataFooterMatched: true };
  } finally { await payload.close(); }
}
