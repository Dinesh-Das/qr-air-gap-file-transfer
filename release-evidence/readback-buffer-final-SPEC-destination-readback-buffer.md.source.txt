# Reuse large destination verification buffers

The October 16 production save-only diagnostic and matched native-File experiment
reproduce large transient allocations in repeated slice/arrayBuffer readback.
The matched 5 GiB prototype retained exact hashes while reducing reported page
memory from 610,601,765 to 13,711,754 bytes. See
release-evidence/readback-memory-review-2026-10-16.md for evidence and limits.

For destination files above the existing 64 KiB small-file threshold, verify
through a byte-stream reader with a recycled backing buffer no larger than the
configured chunk size (maximum 4 MiB). Read minimums may coalesce native chunks;
returned views transfer ownership and must provide the next reusable buffer.
Count actual bytes, reject premature EOF or malformed oversized results, and
preserve SHA-256 verification. Current Chromium is the supported runtime.
Do not fall back to the demonstrated high-allocation path for large files.

Cancellation must cancel a pending stream read, preserve the operation's error,
remove its abort listener, and release the reader lock on every outcome. Reader
cleanup must not mask read, integrity or cancellation failures. Final verification
failure retains the journal for retry; successful completion still removes it.
Small files retain existing bounded concurrency and read behavior.

Before the patch, add failing regressions for successful bounded byte-stream
verification, corrupt data, truncated data, stream failure and cancellation while
a read is pending. Each failure must leave recovery usable. Preserve all old
tests. Run focused and complete gates and typecheck/build, then qualify rebuilt
packages in Chrome and Edge. Separately exercise production 5 GiB readback in
both browsers using the retained payload read-only, with exact hashes and memory
observation. No new 5 GiB copy fits the current disk reserve.

Do not add forced garbage collection to production or timed trials. The earlier
failed observer trial remains failed. This change does not prove full-transfer
memory bounds, native picker permissions, crash durability, 50–100 GiB behavior,
all causes of the historical peak, or physical two-laptop acceptance.
