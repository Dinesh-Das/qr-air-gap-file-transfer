# Large-file readback allocation investigation

Status: **NOT READY**. A production patch is still pending. Application inputs,
builds, packages and requirement statuses are unchanged.

The new save-only diagnostic materialized a 5 GiB patterned file using the
production destination writer and real Chrome OPFS. A generated random-access
source avoided a second stored copy. Production readback, a separate page audit,
and independent Node/OpenSSL hashing of the closed on-disk file all produced
`3700ad81cc9460ac75c00b82fef2687fedd294df92b6c7ca7a724b89022acf3f`.

Data verification succeeded, but the diagnostic **failed overall**: one of 211
process samples was incomplete. PID 12884 disappeared from the CDP process list
between observations; its process type and final memory were not captured. All
five awaited work boundaries had complete observations. The failed run and exit
code remain unchanged. During production readback, complete samples reached
855,302,144 bytes of combined browser private memory. Page-reported memory reached
598,889,072 bytes in production readback and 645,040,087 bytes in the page audit.
Collection after the trial released most backing storage. This is evidence of
allocation pressure, not a production garbage-collection strategy or proof of an
unbounded retained-reference leak.

A matched experiment then read the same preserved 5 GiB file through a native
file-input path in two fresh Chrome 155 instances. It compared the existing
slice/arrayBuffer hashing loop with a prototype that recycles a 4 MiB buffer
through a BYOB byte-stream reader. Both performed 1,280 reads and returned the
exact expected SHA-256. Both process observers were complete; neither trial
forced collection while working.

| Measurement | Slice/arrayBuffer | Recycled BYOB prototype |
|---|---:|---:|
| Page-reported memory peak | 610,601,765 B | 13,711,754 B |
| Sampled combined browser private peak | 862,310,400 B | 291,770,368 B |
| Sampled main backing-storage peak | 608,305,097 B | 4,325,325 B |
| Hashing duration | 65.794 s | 62.086 s |
| Complete native process samples | 67 | 63 |

These metrics describe different memory domains and must not be combined.
One-second native sampling and 50 ms page sampling can miss transients. Two
single trials are diagnostic evidence, not a general speed or scaling claim.
The standards basis for transferred views, returned backing memory and minimum
read sizes is the [WHATWG Streams specification](https://streams.spec.whatwg.org/#byob-reader-read).

The matched experiment isolates avoidable pressure from per-slice ArrayBuffer
allocation. It supports a targeted production change; it does not prove every
cause of the older combined-transfer 5 GiB peak. The prototype uses an actual
native File with a modeled hashing loop, not the production destination API or
native destination picker. The original save-only trial does invoke production
destination code with a diagnostic wrapper that only adds phase boundaries.

The next implementation should recycle bounded backing storage for large-file
destination verification while preserving exact byte counts and hashes, early
EOF/error handling, cancellation during a pending read, reader cleanup, marker
retention on failure, completed retries and the existing small-file concurrency.
Add failing regressions before changing production. Then verify production
readback in both current Chromium browsers, run the complete local gates, and
rebuild candidates. Keep the original high-memory and failed-observer evidence.
Do not add forced collection or weaken the memory/evidence gates.

The original 5 GiB profile and both comparison profiles remain preserved. The
closed 5 GiB profile contains 228 files totaling 5,387,716,248 bytes; all were
independently rehashed. C: now has approximately 5.2 GB free. Keep the 2 GiB
reserve plus staging margin; another 5 GiB copy does not fit. The next production
readback probe can read the preserved payload without modifying its old profile.

All 173 source inputs and five built assets match the root and fresh stage.
The previous 520-unit-test and 92-per-browser gates retain their existing scope
and were not rerun. Physical two-laptop, native picker, 50–100 GB, full-transfer
resource and historical-root-cause acceptance remain open. All 42 physical cases
are still not run.

Primary reports are `save-only-5gib-chrome-2026-10-16.json` (overall failed),
`save-only-5gib-partial-independent-verification-2026-10-16.json`,
`readback-buffer-comparison-2026-10-16.json` and
`readback-buffer-independent-verification-2026-10-16.json`. The final supplemental
index is `readback-memory-final-hashes-2026-10-16.json` in this directory. The
canonical pairing-recovery checkpoint and its prior supplements remain unchanged.
