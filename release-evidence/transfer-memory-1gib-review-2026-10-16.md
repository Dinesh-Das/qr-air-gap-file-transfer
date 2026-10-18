# Current transfer-path memory diagnostic

Status: **NOT READY**. No application inputs, builds, packages, requirement
statuses or canonical checkpoint files changed.

One diagnostic transferred a synthetic 1 GiB file between two isolated normal
Chrome processes on this Windows host. It exercised the current production
sender, durable receive queue, receiver and actual OPFS store over a native
ordered WebRTC channel, then ran production whole-stream verification. Direct
harness SDP exchange replaced application pairing and human authorization.
Final destination materialization was not performed. The generated source
avoided a stored source copy; both new profiles and the received payload remain
preserved.

The run passed. Independent Node checks decoded the closed payload's footer and
metadata, compared **all 1,073,741,824 file bytes** with the expected fixture
pattern, and verified the file and whole-stream SHA-256 values. The virtual
stream is 1,073,742,076 bytes; its SHA-256 is
`5f15350390d11755d282d54e8e8e38ecca7ee1c7f24fc516a81194a18989cabb`.
Sender and receiver agree on 17,477 binary messages, 1,074,511,064 wire bytes
(including 44-byte data headers), and 17,477 durable ACK indices.

| Measurement | Sender | Receiver |
|---|---:|---:|
| Complete process samples | 36 | 36 |
| Missing-PID samples | 0 | 0 |
| Sampled combined browser private peak | 461,873,152 B | 553,488,384 B |
| Phase assigned to private peak | Preparation | Verification |
| Reported page-memory peak | 87,411,457 B | 228,175,097 B |

Preparation took 26.291 s, the payload-transfer interval took 24.099 s, and
receiver whole-stream verification took 26.891 s. The sender's overall observed
elapsed interval was 78.824 s. The reported **44.56 MB/s** describes the payload
interval; it excludes preparation and final verification. It is not end-to-end
user throughput or physical Wi-Fi speed. Profiling and observer overhead affect
these timings; this trial has no matched raw baseline or repeated speed runs.

Receiver verification remains the highest recorded private-memory phase, at
about 528 MiB. A single 1 GiB observation does not establish a bound independent
of total transfer size, demonstrate acceptable 50–100 GiB memory behavior, or
prove another allocation defect. This is additional pipeline evidence, not a
general resource acceptance result. Periodic samples can miss peaks, and phase
labels come from the harness state. Native overall role peaks were independently
recomputed from the raw samples. Working-set sums may double-count shared pages
and are not used as private-memory totals.

The resident Windows samplers retained the existing strict missing-PID rule and
accounted for every requested Chrome process. Collection occurred only after
timed work. Diagnostic transforms add stage timers and expose the manifest for
independent verification; they also replace temporary-store deletion with close
so the new payload survives. They do not alter transfer or storage implementations.
Both profiles were independently hashed twice and have no remaining owned browser
processes.

All 174 canonical inputs and five assets match the root and dependency stage.
The 840 prior canonical evidence rows, the 114-file readback-fix index and the
16-file resident-readback index remain unchanged. Earlier 525-unit-test and
92-per-browser gates retain their scopes and were not rerun. Five-second resource
samples stayed above the 2 GiB disk reserve; their observed C: minimum was
3,486,662,656 bytes. Another large copy must be preflighted against the remaining
space. Existing datasets and the new 1 GiB payload were not deleted or compressed.

Physical LAN, native source-disk performance, application pairing/human use,
native final saving, 5 GiB whole transfers and 50–100 GiB/resource acceptance
remain open. All 42 physical cases are still not run.

Primary evidence: `transfer-memory-1gib-2026-10-16.json`, its log/resource record,
and `transfer-memory-1gib-independent-verification-2026-10-16.json` (including
closed-profile inventories). The supplemental authority is
`transfer-memory-1gib-final-hashes-2026-10-16.json` in this directory. The canonical
application checkpoint remains the readback-buffer fix.
