# Native mixed-tree qualification

This adds an explicit missing benchmark case from the original requirements:
native disk source bytes, thousands of tiny files and a mixed folder tree.
It does not replace any 5 GiB, 10/50/100 GB, physical LAN or user acceptance gate.
Product code, protocols, dependencies and existing diagnostic thresholds stay intact.

## Fixed fixture and safety contract

- Qualification: exactly 100 MiB of file content, 4,000 tiny 1,024-byte files,
  128 empty files, one remaining large file, 64 populated group directories,
  a three-level nested path and one empty directory (4,129 files, 68 directories).
- Smoke: 8 MiB + 65 bytes, 16 tiny files, four empty files, one large file,
  four populated groups and the same nested/empty directories. It is always
  `smokeOnly` and cannot satisfy the qualification case.
- Every byte is written to disk and each file synced/closed. Public deterministic
  AES-256-CTR over zeros uses SHA-256 of `qrft-native-mixed-v1` as the key and
  the first 16 bytes of SHA-256 of the relative path as its IV. This is reproducible
  test data, not random data, a user file, or an application encryption scheme.
- File content generation uses at most 4 MiB per buffer. Record sizes, every
  file SHA-256, mtimes, sorted exact paths and directories, and the fixture version.
- Require a new absolute output path. Never overwrite/reuse an existing output.
  Windows inputs must include an explicit drive or UNC share. Preserve partial
  failures and label the fixture incomplete until generation ends. Write the
  completed manifest to an exclusive temporary file, sync/close it and rename
  it over the incomplete marker; a failed final write must leave that marker intact.
  Publish the initial incomplete marker before the owner record or payload. If
  initial marker bootstrap fails, retain the partial directory/temp metadata and
  create no payload. Missing or invalid manifests always mean unusable/incomplete;
  a parseable marker cannot be promised when its very first I/O operation fails.
- Preserve the 2 GiB disk reserve and 400 MiB margin. Budget all three logical
  copies before generation; continuously guard output and C: during the later run.

## Implementation slices

1. Deterministic native fixture/plan and independent byte tests.
2. Production compiled-UI runner and strict parent resource guard, reusing the
   existing Windows PID observer without dropping missing PID rows. The existing
   single-file diagnostic is not changed into a smaller substitute.
3. Independent exact path/type/size/every-byte audit of source, received stream
   and reconstructed tree, plus separate file/stream/metadata/footer hashes.
4. Retain source/input/runtime/browser binding, ACK and durability counters,
   source-read bounds, phase timings, native private/working-set samples and
   raw CPU profiles where enabled. Report missing/overlapping timing scopes.
5. Execute the fixed qualification once with a 30-minute total deadline, no
   retry or size fallback. Retain all failures. Review and document results.

The UI uses native browser Files selected through a picker adapter; directory
handles and the OPFS destination picker are injected. It does not qualify real
Windows folder permissions, native destination saving or ordinary-user launch.
Same-host WebRTC is not physical Wi-Fi. One case cannot prove general memory
scaling, statistical performance improvement or release readiness.

## Commands and status

Fixture/helper checks: `npm test -- tests/native-mixed-tree.test.mjs`.
Source gate: `npm run check`. Existing full gate: `npm run check:release`.
Runner commands will be documented when slice 2 exists; no runnable UI benchmark
is claimed by slice 1. READY and general performance/resource acceptance stay false.
