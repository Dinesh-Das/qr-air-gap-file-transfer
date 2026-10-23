# Transfer benchmark evidence

Status: performance acceptance is incomplete. Evidence below includes both
synthetic diagnostics and real disk-backed files on one host. These are not
Wi-Fi/LAN throughput claims.

## Windows observer diagnosis, 2026-10-23

The earlier hosted process-observer timeout remains unexplained. Seven isolated
local observations (three serial, four concurrent) completed in310–466ms and
preserved both the live PID and the deliberately missing PID; three startup
controls also passed. This does not reproduce or fix the earlier timeout.

Development helper `a13dad9` adds four fixed-name stderr stages and bounded
stage/elapsed metadata on results and native errors. No marker means
"unobserved", not proof the process never started. The10s deadline, missing-PID
handling, original child error and script-free bounded summary remain. Two new
assertions failed before implementation; final focused8 checks pass. Hosted
run39980670284 at that exact commit passed575 units/59files, typecheck/build,
101 bundled Chromium cases and external package module smoke on Node24.22.1.
The product bundle remains byte-identical.

One local100MiB raw/verified pair with real isolated Chromium processes passed
strict native-memory validity:4/9 paired periodic samples, zero missing selected
PIDs, unchanged byte/ACK/destination audits, and all post-run snapshots retaining
the four stages. The guard's42 readings stayed above3,924,205,568 bytes free.
Observer overhead was included; these rates are not a throughput baseline. See
release-evidence/observer-stage-diagnostic-2026-10-23.json for raw/provenance
references and the25-file double-hashed closure.

C: was freshly observed above4GB, allowing these small diagnostics with the
unchanged2GiB reserve (guarded source-check minimum4,145,958,912 bytes free).
This does not meet the5GiB two-copy budget. No general native browser-memory matrix,
multi-gigabyte transfer or physical LAN acceptance is established; earlier missing-utility
PID and hosted timeout causes remain open.

## Hosted 64/96-block study, 2026-10-23

Source `d879aa6`, hosted Windows run39851735983, passed the complete release
gate (572 units/59 files, typecheck/build, 101 bundled Chromium cases and external
package module smoke) before running 16 balanced diagnostic cases. Four
repetitions per window/mode used fresh servers and Chromium pairs, 100 MiB
synthetic data, unchanged 60 KiB payloads, 8/2 MiB buffering thresholds and
64-block/75-ms receive batching. Hashing, durable ACKs, stream/destination audits
and native channel byte accounting passed. Profiling and native memory observers
were off. The override was in-memory only, with original/transformed hashes;
production source and its 96-block default remain unchanged.

| Window | Mode | Median MB/s | Range MB/s | Sender socket-send discards, case order |
| --- | --- | ---: | --- | --- |
| 64 | Raw | 29.36 | 28.40–30.87 | 3833,37,2349,6296 |
| 96 | Raw | 27.34 | 27.00–33.67 | 0,2636,4609,0 |
| 64 | Verified | 18.38 | 18.18–18.52 | 0,0,0,0 |
| 96 | Verified | 18.61 | 18.43–18.77 | 0,0,0,0 |

Receiver socket-send discards were zero in all16 cases. Reducing the window did
not demonstrate a verified-flow benefit or eliminate raw send discards. These
counters do not establish a universal buffer-sizing cause. Keep96; no throughput
threshold or performance acceptance is claimed. Hosted minimum free space was
157,023,911,936 bytes across208 guard samples, above the unchanged2 GiB reserve.
Both artifact archives were downloaded and matched GitHub SHA-256 digests; raw
records were independently checked and sealed. See
release-evidence/hosted-window-study-2026-10-23.json for hashes and provenance.

The initial eight helper tests failed assertions as intended before implementation;
all nine final helper tests passed. A workflow parse failure was corrected. An
intermediate standalone gate failed three existing observer/fixture tests before
any benchmark; original logs/deadlines remain, cause unresolved. The final study
requires the existing full release gate rather than duplicating a partial gate.
Later success does not diagnose the earlier failures.

This is one hosted same-host Chromium/synthetic-file study, not physical Wi-Fi,
native disk/picker or general memory evidence. The user reports no additional
local space; local transfer trials remain held. Two-laptop and multi-gigabyte
resource/throughput acceptance remain open.

## Phase and socket-counter diagnostic, 2026-10-23

Code `932c394` adds bounded epoch/monotonic phase markers and allowlisted
transport/candidate-pair/data-channel counters, using the existing post-result
stats request. Unsupported counters remain absent, not fabricated zero;
addresses, credentials and channel labels are omitted. Product code/assets and
packaged runtime are unchanged. Typecheck and 563 units in 58 files pass.

All 3,582 prior logged UDP warnings occurred before browser close markers.
Older records lack exact payload epochs, so they cannot attribute every warning
to payload work. One new 100 MiB raw/verified pair passed the unchanged integrity
and accounting checks, validating the new markers and native counter totals:

| Mode | MB/s, single case | Sender socket-send discards | Logged warnings during payload |
| --- | ---: | ---: | ---: |
| Raw | 25.68 | 334 | 321 |
| Verified transfer | 51.10 | 0 | 0 |

Counter and log counts are distinct. The [W3C counter definition](https://www.w3.org/TR/2025/CRD-webrtc-stats-20250925/#dom-rtcicecandidatepairstats-packetsdiscardedonsend)
identifies socket errors, not a particular buffer/memory cause. This pair supports
a controlled backpressure experiment; it does not establish the cause of all
earlier variance, a speedup, or performance acceptance. No product tuning was
made. The parent guard held the 2 GiB reserve; native memory sampling was off.

The [evidence pointer](release-evidence/benchmark-transport-diagnostics-2026-10-23.json)
retains the old-log correlation, fresh raw records, phase/counter checks, RED/GREEN
and full-unit logs, reviewer corrections and 31-file double-hashed closure.
Synthetic/direct-SDP/OPFS/headless scope remains; physical/native-picker/large-file
acceptance and READY remain open. No requirement completion was added.

## Matched overhead diagnostic, 2026-10-23

Development-only fix `d54a487` disables workspace watching in the immutable
benchmark server. Installed Vite 8.2.0 selects a noop watcher for `watch: null`;
the transfer implementation, integrity policies, product assets and shipped
runtime files are unchanged. The first attempt failed before valid measurement
because its required browser was absent. Its partial output remains retained.
Playwright 1.64.0 then installed the required HeadlessChrome 156.0.8078.4 into a
separate owned directory using `--no-remove`, preserving existing browsers.

Two blocks each ran three planned 100 MiB raw/transfer comparisons, alternating
mode order. All 12 trials passed byte/frame/ACK accounting; all six transfer
trials passed stream verification, save and independent destination byte audits.
The transfer rates below exclude preparation, final verification, save and audit,
which remain separately recorded. Raw mode checks a constant payload without
hashing or durability; transfer uses a periodic fixture with those checks enabled.

| Stage timers | Raw MB/s median (range) | Verified transfer MB/s median (range) |
| --- | --- | --- |
| On | 12.56 (11.94–12.95) | 13.76 (13.10–16.55) |
| Off | 21.44 (14.60–25.57) | 48.82 (14.22–51.13) |

Large variation within the unchanged timer-off block prevents attributing the
difference to profiling, claiming a speedup, or establishing a comparable
production-regression baseline. Native stderr contains UDP error10035 messages;
their causal contribution is unproven. A stable overhead-acceptance result is
**not established**. No fake target speed was substituted.

The profiled transfer trials used 1,707 blocks with 74/69/75 grouped flushes,
journal appends and ACK messages. Stage wall timers can overlap and are not
additive CPU costs. Native memory sampling was disabled. Both complete runs kept
the 2 GiB reserve. This is same-host synthetic/direct-SDP/OPFS evidence, without
production UI, native source disk/pickers/destination, physical LAN or multi-GB
acceptance. Disposable trial profiles were removed after verification; prior
fixtures and evidence were preserved.

The [evidence pointer](release-evidence/matched-overhead-2026-10-23.json) indexes
the failed attempt, both complete runs, dependency hashes, browser runtime and
341-file double-hashed closure. L988 verifies harness creation only; the related
performance requirements remain partial. READY remains false.

## Current path-guard bundle: native 1 GiB UI trial, 2026-10-23

At source `8911cd6` (application fix `47e34b5`, main asset
`index-BBeDJSZZ.js`), one real disk-backed 1 GiB file passed production UI
pairing, same-host WebRTC receive, verification, and save. Receive and save
milestones were 64.242 and 91.774 seconds from pairing. These instrumented
single-case timings do not establish a speed improvement or physical throughput.

Both the trial and a separate verifier compared every original byte with the
retained incoming and saved copies. File/stream hashes, actual metadata/footer,
and all 17,477 unique acknowledged block indices passed. All 94 native memory
samples covered every reported browser PID, with no missing IDs. Peak summed
private bytes were 482,496,512 for sender and 532,410,368 for receiver; peak summed
working sets were 810,815,488 and 880,660,480. Working sets can double-count shared
pages, and periodic sampling can miss peaks. No general memory bound is proved.

The parent guard's 104 disk readings stayed above the unchanged 2 GiB reserve;
minimum free C: was 4,603,949,056 bytes. Installed headless Chrome 155.0.8059.85
and pinned Node 24.22.0 were used. Picker adapters were injected and destination
save used OPFS. Receive-store deletion was deliberately denied to retain both
copies; the expected cleanup-required UI appeared. This is not an actual OS
picker/native destination, Edge, clean-OS, physical Wi-Fi, incompressible-data,
or multi-size resource qualification. Earlier observer failures stay unresolved.

The [evidence pointer](release-evidence/current-native-1gib-path-guards-2026-10-23.json)
records review/raw/closure hashes and scopes. All 477 closure files were hashed
twice after writers stopped. The first harness launch failed before browser
startup on an incorrect prior-plan path; its logs remain retained separately.

## Storage context lifecycle diagnostic, 2026-10-14

A repeatable storage diagnostic writes 128 MiB in 2,185 OPFS blocks using
the real block store, then reopens the page and cleanly restarts the browser.
Four trials passed in installed Edge 154.0.4258.53 and Chrome 154.0.8037.99:
persistent profiles retain all receipts and SHA-256-verified bytes after restart;
nonpersistent automation contexts retain them across page reopen, but a fresh
context after browser close has zero receipts. All four report persisted=false,
so that permission flag alone cannot distinguish these observed lifetimes.

The final run captures 144 input hashes and the exact origin at startup. Each
trial enforces a 2 GiB free-space reserve plus twice the payload size on C: and D:.
The two final persistent profiles and their payloads are retained for reinspection.
An earlier four-trial successful run has two separate retained profiles; earlier
Vite-host startup failures are preserved and do not count as storage trials.
The diagnostic now uses a minimal page and isolated Vite configuration. No
production code, existing test, config, lockfile or built asset changed.

This checkpoint ran the storage diagnostic, not the unit/browser suites. Prior
344-test check, full 71-case Edge/Chrome gates and later focused cleanup/cancel
cases retain their recorded scopes. The 19-file terminal-control candidate
remains checksum-verified. See release-evidence/storage-context-review-2026-10-14.json
and scripts/diagnose-storage-context.mjs for raw data, input binding and reproduction.

This is backend storage evidence on one host. It does not validate native Chrome
Incognito or Edge InPrivate user workflows, private-mode large-file quota behavior,
Wi-Fi, native destination folders, OS crashes/power loss or whole-process memory.
128 MiB is not evidence of 5 GiB full saving or 50–100 GB+ resource acceptance.
All 42 physical cases, target-hardware performance/resources, hosted CI and broader
acceptance remain open. Three evidence documents changed after the diagnostic;
the other 141 inputs and five runtime assets remain unchanged. Release is NOT READY.

## Matched 10,000-file trials, 2026-10-13

The preserved old and current sources ran alternately, three trials each, with
identical instrumentation in installed Edge 154.0.4258.53. Each fresh
persistent profile saved 10 MiB across 10,000 files (1,000 empty) and 100
directories. Before every run, C: had over the 2 GiB reserve; raw preflights,
profiles, inputs and logs are retained. Only src/lib/large-destination.ts differs
in their runtime source inputs; the lockfile and harness are identical.

| Pair | Baseline save (s) | Current save (s) | Reduction |
| --- | ---: | ---: | ---: |
| 1 | 288.763 | 260.174 | 9.90% |
| 2 | 287.700 | 255.712 | 11.12% |
| 3 | 284.275 | 257.806 | 9.31% |

Mean saving time fell from 286.913 s to 257.897 s (10.11%).
The sample ranges do not overlap. All six whole-stream verifications and
independent exact-path/type/size/every-byte audits passed: 10,000 files,
100 directories and 10,485,760 destination bytes per trial. This supports a
local improvement; per-file journaling still dominates much of the time.
Destination saving includes manifest reading, reconstruction and final checking;
preparation, receive and independent audit timings are separate in the raw data.

This does not establish physical Wi-Fi, native chosen-folder or stable target
hardware performance. The original harness deletes synthetic destinations and
transfer copies after successful audit; profiles are preserved without those
files for later reinspection. API timings overlap under concurrency, so summed
timings are not elapsed time/CPU time. Heap samples occur after preparation and
at receive batches, excluding continuous save/audit memory peaks. Historical
78.753–142.543 s observations used different conditions and are not a matched
comparison. The stage-dependent/historical timing variation remains unexplained.

Source/harness binding and all six trial records:
`release-evidence/many-file-matched-review-2026-10-13.json`. Adversarial fault
checks and reused full-browser gate scope:
`release-evidence/adversarial-many-file-review-2026-10-13.json`. Physical matrix,
50–100 GB+ resources and the historical 5 GiB full-save memory concern remain
open; performance acceptance is incomplete.

## Bounded small-file I/O, 2026-10-13

An intermediate readback-only experiment rechecked an already completed
1,200-file persistent OPFS tree (257 bytes/file) in installed Edge. Each version
had a separate fresh profile, one unmeasured warm-up and three measured runs.
Sequential checks took 6.152 / 6.006 / 6.564 s; bounded four-way checks took
5.547 / 4.572 / 5.169 s. Both versions passed independent exact-path, exact-byte
and Web Crypto SHA-256 audits of all 1,200 files. No writes, recovery, app progress
rendering or network transfer were timed in these samples. The benchmark binds
the original and intermediate source hashes, not the later complete patch.

The final candidate also overlaps resume checks and up to four small payload
writes while keeping every journal commit sequential and separate. The original
1,200-file destination recovery tests passed in a fresh Edge full gate and Chrome
full browser gate, followed by three additional Edge process-recovery trials.
The Edge non-crash case took 34.0 s total versus 47.7 s in the original failed
full gate; Chrome took 20.8 s. These include preparation/fault/retry/audit work
and are single observations in different stages, not stable throughput results.
The original 30-second destination-completion assertion remains unchanged.

Raw intermediate benchmark: `release-evidence/destination-readback-benchmark-2026-10-13.json`.
Full chronology and final source/test binding:
`release-evidence/destination-small-file-review-2026-10-13.json`. Original and
intermediate failures remain retained; the stage-dependent variation is not
established. The earlier 10,000-file observations are historical. Repeat matched
10,000+ file trials, native folders and target hardware before performance
acceptance; the physical matrix and large-file memory concern remain open.

## WebRTC flow and receiver hashing, 2026-09-19

`scripts/benchmark-webrtc.mjs` now runs the production sender, bounded receive
queue, receiver block validation, OPFS store, final stream SHA and optional
destination reconstruction between **two separate Chromium processes**. Each
uses a fresh temporary normal profile. The source generates bounded slices with
a file-index/offset pattern. A separate destination walk checks exact paths,
sizes and every byte against that pattern after the application's SHA checks.
The harness exchanges SDP directly; it does not exercise application pairing,
human authorization, physical source disks, native destination pickers or a LAN.

```powershell
$env:QRFT_WEBRTC_MIB = '10,100'
$env:QRFT_WEBRTC_MODES = 'raw,transfer'
$env:QRFT_WEBRTC_REPEATS = '3'
$env:QRFT_WEBRTC_SAVE_TREE = '1'
$env:QRFT_WEBRTC_OUTPUT = '.tmp/webrtc-benchmark.json'
npm run benchmark:webrtc
```

Sizes are MiB, limited to 1–10,240; repetitions are 1–5. Use
`QRFT_WEBRTC_FILES=10000` for grouped files including 10% empty files, and
`QRFT_WEBRTC_MIB=1024,5120` for larger streams. `QRFT_WEBRTC_PROFILE=0` disables
stage wrappers and worker profiling, retaining basic counters and the synthetic
source instrumentation. `QRFT_WEBRTC_CORRUPT_BLOCK=0` is a deliberate negative
test: it must fail verification and exit nonzero. Keep separate output names
for failures and rechecks. Profiles are removed only after their browsers close;
data failure, browser errors, changed inputs or cleanup failure prevent a pass.
`QRFT_WEBRTC_NATIVE_HASHES=0` exercises the synchronous codec control by hiding
SubtleCrypto on the receiver after store initialization and restoring it before
cleanup. OPFS store naming independently requires WebCrypto; this control does
not establish whole-app support for a browser lacking that API. An initial
control incorrectly hid it before store creation and failed three setup attempts;
those records remain in `webrtc-matched-fallback-100MiB.json`.

The raw mode uses the same 60-KiB payload/44-byte overhead, ordered data channel,
96-block window and production 64-block/75-ms queue. It checks a byte pattern
and returns batched receipts without hashing or OPFS. Its producer has different
burst behavior from the actual source. Observed raw throughput was variable and
lower than the full flow, even after matching the window. Its cause is not
isolated; these values are **not a measured transport ceiling**.

Transfer rate is stream bytes divided by sender time through receipt of every
durable ACK; preparation, final SHA and destination saving are separate. Raw
rate additionally waits for its final content/count confirmation. Stage timers
wrap the development modules without changing their files. Source scan/hash,
virtual reads, encode/hash/copy, receive validation, worker write/flush/journal
round trips, final stream verification, destination reconstruction and final
destination checking are reported. Worker times include IPC and scheduling,
not just disk IO. `destinationSaveMs` includes its final verification; subtract
the `verifyCompleteDestination` timer to separate reconstruction. Concurrent
native decode latencies **overlap**; their sum is not elapsed time or CPU.
`receive.acceptBatch - receive.storeWriteBlocks` measures the batch's validation
and other overhead on its critical path.

CPU comes from CDP main-thread counters and observed browser-process CPU totals;
exited processes between snapshots cannot be included. Heap is sampled every
100 ms and at progress boundaries; it excludes native/RSS memory and may miss
short peaks. Metrics remain bounded counters, not a history per block.

The initial worker observer was registered after the storage client's listener
and included consumer microtasks in response latency. `capture:true` did not
correct that ordering. The final observer is installed in the Worker constructor
before the client can register; a calibration worker asserts that its timing
record exists before the consumer runs. Earlier `webrtc-harness-smoke*`,
`webrtc-harness-corrected-smoke*` and `webrtc-baseline-10-100MiB` results remain
retained, but their worker timing fields do not isolate RPC latency. Calibrated
records use the corrected observer. Corruption rechecks report SHA rejection,
zero success and exit 1; they are negative-test evidence, not successful transfers.

Three repetitions per size, with complete destination verification:

| Variant | 10 MiB median MB/s | 100 MiB median MB/s | Decision |
| --- | ---: | ---: | --- |
| Original synchronous block hashes | 28.02 | 33.65 | Baseline |
| Native sender and receiver hashes, original buffering | 3.89 | 28.61 | Rejected regression |
| Native sender and receiver hashes, 512/128 KiB buffering | 3.70 | 23.17 | Rejected regression |
| Native receiver hashes, original sender and buffering | 31.25 | 40.08 | Selected for further validation |

In that original-fixture comparison, the selected 100-MiB range was
39.11–40.38 MB/s, versus 32.63–33.69 before;
the median improved 19.1%. The 10-MiB median improved 11.5%, with a wider
25.20–31.48 range. Receiver main-thread task time for the whole measured workflow
fell from a 5.54-second median to 4.31 seconds at 100 MiB. Sampled receiver heap
rose from 104.5 MB to 116.1 MB (about 11%): asynchronous digest inputs and stable
payload snapshots add bounded working buffers; GC also affects observed peaks.
These observations do not establish a general throughput improvement; later
measurements with the revised fixture, below, did not reproduce it.

Native hashing on the sender reduced measured encode time but made overall
throughput worse by more than 10%. The lower-buffer trial did not fix it.
Those changes were reverted; no network-level root cause or speedup is claimed
for them. Their source/test snapshot is retained in
`release-evidence/native-hashing-experiment`, with raw timings and fingerprints
in `webrtc-native-10-100MiB.json` and `webrtc-native-buffer-512KiB.json`.
The selected receiver path preserves the exact wire digest and copies all
authenticated fields before awaiting native SHA-256. It validates the entire
bounded batch before writing; one failed digest prevents any write of that batch.
The existing SHA implementation remains the fallback when the native API is absent.

The cleaned receiver implementation subsequently passed a 1-GiB and a 5-GiB
transfer, full stream SHA, destination SHA and independent destination byte audit,
with exit 0, no cleanup failures and unchanged inputs. See
`release-evidence/webrtc-native-receiver-large.json`:

| Payload | MB/s | Prepare s | Transfer s | Stream verify s | Save including verify s | Independent audit s | ACK/commit groups |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 GiB | 39.74 | 27.13 | 27.02 | 12.21 | 26.86 | 2.25 | 334 |
| 5 GiB | 32.44 | 157.86 | 165.49 | 58.83 | 130.26 | 12.70 | 2,068 |

The exact streams were 1,073,742,076 and 5,368,709,372 bytes, with all 17,477
and 87,382 blocks acknowledged. Both directions' frame bytes agree, including
44 bytes per block. The larger run is 18.4% slower per byte. Its measured
synthetic-slice generation cost rose from 5.44 to 12.99 ms/MiB; encoding and
storage did not slow. That identifies a fixture bottleneck without establishing
a browser-vendor cause. The fixture now expands its repeating 256-byte pattern
with bounded copies. Six tests compare against the independent byte formula,
including offsets above 2^31 and 2^32; the destination audit retains that formula.

The large runs' sampled receiver peaks were 284 MB and 728 MB. A later 1-GiB
run with phase measurements recorded 87 MB during receipt, 225 MB during stream
verification, 200 MB during destination saving and 300 MB in the independent
benchmark audit. Diagnostic garbage collection, **after** timing and CPU
measurement, reduced retained buffer storage from 223 MB to 4.6 MB. This is
evidence about retained memory after that run, not a production GC fix, a bound
on all browser/native memory, or a resolution of the 5-GiB peak. See
`release-evidence/webrtc-phase-memory-1GiB.json`.

Fresh 100-MiB trials using the revised fixture were variable. The synchronous
codec control measured 19.81–27.72 MB/s (median 20.36); native receiving measured
18.22–31.71 MB/s (median 18.44, 9.4% lower). Median receiver main-thread task time
fell from 6.60 to 5.43 seconds. Both runs used the same source/harness fingerprints
and passed complete destination checks. The earlier throughput improvement was
not reproduced. Sender read/encoding times and queued data also varied; their
cause remains unisolated. The native receiver reduces measured receiver work,
but throughput acceptance stays open. These later observations must accompany
the earlier 19.1% result, not be omitted from a release claim.

A 1,000-file/10-MiB transfer including 100 empty files in ten directories passed
the exact destination audit. Preparation took 0.65 seconds and saving 10.67
seconds. Native browser corruption injection failed its SHA check before any
payload write or ACK and exited 1 as required. See `webrtc-native-1000-files.json`
and `webrtc-native-corruption-final.json` in release-evidence.

See `release-evidence/webrtc-performance-comparison.json` for all variants and
their scopes. Overall throughput/resource acceptance, tiny-file optimization,
real source/destination disks and physical-network results remain open.

## Reproduce the storage-only receiver harness

Install development dependencies and Playwright Chromium, then run:

```powershell
npm ci
npx playwright install chromium
$env:QRFT_BENCH_MIB = '10,100'
$env:QRFT_BENCH_BATCHES = '1,16,32,64,128'
$env:QRFT_BENCH_OUTPUT = '.tmp/receiver-benchmark.json'
npm run benchmark:receiver
```

For a large normal-browser-profile run:

```powershell
$env:QRFT_BENCH_MIB = '1024,5120'
$env:QRFT_BENCH_BATCHES = '64'
$env:QRFT_BENCH_PERSISTENT = '1'
$env:QRFT_BENCH_OUTPUT = '.tmp/receiver-large.json'
npm run benchmark:receiver
```

`QRFT_BENCH_STORAGE_PROBE=1` runs an OPFS-only write probe without hashing or
verification; its results explicitly do not claim a verified transfer. Variables
are per-shell: remove this variable before a full benchmark. Each persistent
profile is created in the OS temp directory and removed after the run. The
harness deletes only its own stores/profiles. Run with sufficient free space.

## What is measured

Chromium 153 on Windows; real OPFS worker writes, payload flushes and journal
commits. A bounded synthetic source produces zero-filled slices on request;
the actual preparation and virtual-tree code hashes those slices. The actual
binary block encoder, receiver validation, storage and final SHA verifier run.
No whole fixture is retained in JS memory. Receipt group counts correspond to
the groups that an ACK could safely acknowledge; this harness bypasses WebRTC
and the timer queue. Browser E2E separately exercises those paths.

Reported stages: preparation, synthetic source reads, block encoding, receiver
validation plus durable storage, and final stream verification. CDP main-thread
task/script time is available in newer results, not total process/worker CPU.
`performance.memory` samples measure JS heap, not browser native/RSS memory;
short-lived peaks between samples may be missed. Actual source disk, destination
reconstruction, final destination reads and network performance are not measured
by this harness. Development modules are used; HMR is now disabled.

## Batch comparison

MiB denotes fixture size; MB/s is decimal bytes per second. All rows below used
isolated private browser contexts. Source hashing and final verification are
excluded from the transfer-rate column and included separately in raw JSON.

| Fixture | Blocks per batch | MB/s | Payload flushes | Journal commits |
| --- | ---: | ---: | ---: | ---: |
| 10 MiB | 1 | 17.23 | 171 | 171 |
| 10 MiB | 16 | 28.04 | 11 | 11 |
| 10 MiB | 32 | 26.05 | 6 | 6 |
| 10 MiB | 64 | 26.91 | 3 | 3 |
| 10 MiB | 128 | 26.69 | 2 | 2 |
| 100 MiB | 1 | 17.30 | 1,707 | 1,707 |
| 100 MiB | 16 | 22.11 | 107 | 107 |
| 100 MiB | 32 | 24.47 | 54 | 54 |
| 100 MiB | 64 | 26.46 | 27 | 27 |
| 100 MiB | 128 | 24.12 | 14 | 14 |
| 1 GiB | 64 | 21.48 | 274 | 274 |

The 100 MiB sample improved by approximately 53%, with 98.4% fewer commits.
64 blocks is the selected production default (3.75 MiB payload per group), with
a 75 ms deadline for short groups. The sender window remains 96 blocks. 128 did
not improve the measured rate and would require the deadline to avoid waiting
for more blocks than that sender window allows.

The 1 GiB fixture verified successfully. Preparation took 34.46 s, the receive
path 49.99 s, final verification 15.52 s. Peak sampled JS heap was 97.2 MB,
similar to the 100 MiB sample's 95.3 MB. Main-thread task time was 87.27 s;
hashing/protocol CPU remains material, so the desired network/disk-limited
performance is not established.

1 GiB rate is about 19% below the 100 MiB sample. Normalized source-read,
encode and accept times all increased; the commit count remains proportional.
These are single samples under variable host load, not repeated controlled
trials. The cause is not fully isolated; no thermal or whole-process CPU data
was collected. Treat long-run speed as unresolved, not a proven regression-free
performance claim.

## Private-context storage failure

The initial 5 GiB private-context run failed around 2 GiB. A storage-only probe
reproduced a journal length mismatch near 1.8 GB: expected 129,640 bytes, observed
129,360 (one 280-byte receipt record short), despite a reported 6 GiB quota.
The same 2,112 MiB probe completed in a temporary normal browser profile.
This implicates the browser/context storage behavior, but does not establish
a browser-vendor root cause. The store failed closed; no verified success was
reported. The harness now preserves original errors rather than masking them
with its cleanup error. Worker errors include expected/actual journal sizes.

The production worker additionally checks journal length after flush before
acknowledging a commit. An injected post-flush truncation is covered by a browser
test. This check does not prove a browser cannot later lose persisted data;
final stream/destination hashes and resume replay remain authoritative.

The full 5 GiB normal-profile fixture passed final SHA-256 verification:

| Phase/metric | Result |
| --- | ---: |
| Preparation | 159.41 s |
| Receive path (including source reads/encoding) | 216.90 s |
| Final stream verification | 76.20 s |
| Receive rate | 24.75 MB/s |
| Payload writes | 87,382 |
| Payload flushes / journal commits / ACK groups | 1,366 each |
| Peak sampled JS heap | 97.04 MB |
| Main-thread task time | 423.80 s |

The 5 GiB run used a normal profile, so its rate is not directly comparable to
the private-context batch sweep. It demonstrates bounded sampled JS heap and
verified multi-gigabyte storage in this environment, not network throughput or
resilience to physical power loss. CPU overhead is still significant.

## Raw records

See `release-evidence/receiver-before.json`, `receiver-batches.json`,
`receiver-large.json`, `receiver-large-persistent.json`, and the
`receiver-quota-probe*.json` files. These retain
unrounded timings and failure evidence. Physical multi-file trees,
mixed folders, actual WebRTC throughput, repeated trials, physical disk
destinations and two-laptop network tests are still required.

## Synthetic small-file tree (2026-09-13)

`QRFT_BENCH_FILES=10000` distributes the configured source bytes across 9,000
nonempty files and 1,000 empty files in 100 directories. File contents are
generated zero bytes; this does not measure native directory enumeration or
physical disk reads. Both runs below used 10 MiB of file data, batch size 64,
and a temporary normal Chromium profile. Final stream SHA-256 passed in both.

| Metric | One file | 10,000 files |
| --- | ---: | ---: |
| Metadata bytes | 225 | 1,448,388 |
| Preparation | 0.277 s | 2.271 s |
| Source range reads | 0.079 s | 1.911 s |
| Receive path | 0.379 s | 2.298 s |
| Final stream verification | 0.132 s | 0.173 s |
| Stream receive rate | 27.64 MB/s | 5.19 MB/s |
| Journal commits | 3 | 4 |
| Peak sampled JS heap | 63.62 MB | 74.46 MB |

These single trials identify source range reads as the largest measured part
of the small-file receive path. Rates include metadata and exclude preparation
and final verification. They do not establish network throughput, per-file
destination reconstruction, or a repeatable performance regression.
Raw records: `release-evidence/receiver-many-files.json` and
`release-evidence/receiver-single-file-persistent.json`.

### Destination reconstruction and independent audit

Set `QRFT_BENCH_SAVE_TREE=1` with `QRFT_BENCH_FILES=10000`,
`QRFT_BENCH_MIB=10`, `QRFT_BENCH_BATCHES=64`, and
`QRFT_BENCH_PERSISTENT=1` to exercise the production destination writer into
an isolated OPFS directory. This mode uses file-index and byte-offset patterns
instead of zero data. After the writer performs its own hash verification,
the harness independently enumerates the destination, rejects extra/missing
paths, checks lengths, and checks every byte against the fixture specification.
The expected tree comes from the input fixture, not the received metadata.

The 2026-09-13 run passed all 10,000 files, 100 directories and 10,485,760 file
bytes, including 1,000 empty files. Stream receipt took 2.513 s; destination
save (including production verification) took **102.712 s** and the separate
audit took 11.337 s. This exposes substantial small-file destination overhead.
The current writer journals after each file; these phase timings do not isolate
journaling from other file operations or establish the cause of the slowdown.

Raw evidence: `release-evidence/receiver-many-files-destination.json`.
Heap sampling covers preparation/receipt, not destination-save peak usage.
This is one synthetic OPFS run, not a native Windows destination picker, a
physical source folder, a network transfer, or a power-loss test. Nested empty
directories and interrupted many-file reconstruction still need broader browser
coverage. The harness file limit now includes its generated directories so a
fixture cannot exceed the production 100,000-entry limit through file count alone.

### Destination operation profile

A second 10,000-file patterned run passed the same independent audit. The
harness timed the production writer's asynchronous create/write/close calls,
separating the recovery marker from destination files. Instrumentation restores
the browser prototype in a finally block and is confined to the benchmark.

| Operation group | Calls | Summed elapsed time |
| --- | ---: | ---: |
| Journal createWritable | 10,001 | 7.679 s |
| Journal write | 10,001 | 7.213 s |
| Journal close | 10,001 | 9.991 s |
| File createWritable | 10,000 | 9.073 s |
| File write | 9,000 | 6.501 s |
| File close | 10,000 | 9.764 s |

Overall save took 78.753 s, including 11.283 s from the first final-verification
progress callback through return. The latter excludes the preceding exact-tree
scan, so it is not the entire verification phase. The independent audit took
11.164 s. Journal calls consumed 24.883 s (31.6% of save time); file calls
consumed 25.337 s. These are sequential API wall times, not CPU or physical
flush measurements. Directory traversal, source reads, hashing, enumeration,
and other work account for the remaining time.

The 78.753 s and earlier 102.712 s observations demonstrate substantial run
variation; no production optimization occurred between them. Reducing recovery
marker writes is a possible optimization, but must retain safe interrupted-save
recovery and needs targeted failure tests before changing production behavior.
Raw evidence: `release-evidence/receiver-many-files-destination-profile.json`.

### Handle lookup profile (2026-09-14)

An additional instrumented 10 MiB / 10,000-file persistent-profile run passed
whole-stream verification and the independent exact-tree/byte-pattern audit:
10,000 files, including 1,000 empty files, and 100 directories. Save time was
142.543 s; independent audit took 14.614 s. No production code changed.

| Operation | Calls | Summed elapsed time |
| --- | ---: | ---: |
| Directory getDirectoryHandle | 20,102 | 7.523 s |
| File getFileHandle | 20,000 | 17.161 s |
| Journal getFileHandle | 10,002 | 5.771 s |
| File getFile | 10,000 | 3.942 s |
| Journal create/write/close combined | 30,003 | 44.781 s |

The three handle lookup groups total 30.454 s (21.4% of save time). Directory
lookup alone is 5.3%, so caching directories alone has a limited upper bound
for this fixture. File-handle lookup includes writing and final verification;
reusing a stale handle across those phases could miss path replacement. Any
cache experiment must preserve fresh exact-path verification and cancellation
behavior. Journal create/write/close is 31.4% of this run, but batching would
change recovery semantics and is not justified solely by this measurement.

Instrumentation wraps lookup/getFile methods only during production saving and
restores every wrapped prototype in finally before the independent audit.
These API wall times include instrumentation overhead; they are not CPU time
or physical flush latency. The larger save time compared with 78.753/102.712 s
observations is not a controlled regression result. Repeat matched trials before
claiming improvement. Raw evidence:
`release-evidence/receiver-many-files-handle-profile.json`.

### Path replacement guard for future caching

Two memory-filesystem tests replace either a completed file handle or its parent
directory after writing and journaling, while the old file handle retains the
correct bytes. Final verification must reject the changed current path with a
SHA-256/size mismatch, retain the recovery marker, and repair the file on retry.
Both passed. This guards against cross-phase stale-handle caching; it does not
measure Windows filesystem race behavior or eliminate all concurrent mutations.
No production cache or speedup is introduced.

## Synthetic 10 GB receive result (recorded 2026-09-15)

The existing run completed whole-stream verification on 2026-09-14. Its fixture
is a single synthetic zero-filled file of 9,537 MiB (10,000,269,312 bytes); the
virtual stream is 10,000,269,556 bytes including metadata/framing. A temporary
persistent Chromium 153 profile used OPFS and 64-block commits.

| Measurement | Result |
| --- | ---: |
| Preparation | 421.420 s |
| Receive/encode/commit loop | 723.129 s |
| Whole-stream verification | 120.475 s |
| Receive loop throughput | 13.829 MB/s (decimal) |
| Peak sampled JavaScript heap | 101,179,383 bytes |
| Payload writes | 162,765 |
| Durable commits / ACK groups | 2,544 / 2,544 |
| Initial reported quota | 10,737,418,240 bytes |

`verified: true` is retained in `release-evidence/receiver-10GB-persistent.json`.
The full command exited **1** afterward: removing the temporary Chromium profile
failed with EBUSY on chrome_debug.log. The log and exit-code file preserve this
cleanup failure. Therefore the data verification passed, but the overall command
did not finish cleanly. No live benchmark process remained on inspection.

The harness now allows five bounded cleanup retries at 200 ms base delay for
transient Windows locks. A separate 10 MiB persistent-profile smoke run verified
data and exited 0 (`receiver-cleanup-smoke.json`). It does not demonstrate that
the specific original lock was reproduced or cured; persistent cleanup failure
still surfaces as an error. The original result was not overwritten or rerun.

This is one local synthetic receive/storage/hash run, not network throughput,
whole-browser/OS memory, a native source-file test, destination reconstruction,
or two-laptop acceptance. Heap sampling can miss transient peaks. CPU and local
load affect timings; do not infer target-device performance or a regression from
comparison with the earlier 5 GiB run. The physical 10 GB matrix remains unrun.

### Benchmark exit-status semantics (2026-09-15)

The harness now sets exit status 1 when a recorded result contains a data or
cleanup error, receive verification fails, or a destination audit fails. It
continues saving result JSON, including later cases, without resetting that
failure status. A storage-only quota probe is intentionally unverified; it
succeeds only if all requested bytes were written with no recorded error.
Previously, a caught verification error could leave a zero process exit code.
Historical evidence still must be judged from its JSON and log.

Three result-classification tests pass, covering missing/failed verification,
destination audit, cleanup errors and partial storage probes. Separate 1 MiB
real-browser receive and storage-only probe smoke runs both exited 0 with their
respective verification/write criteria satisfied. This is harness behavior, not
new production-transfer or physical acceptance evidence.


## Repeated 10,000-file baseline (reviewed 2026-09-18)

The existing harness completed three sequential identical trials, each in a
fresh persistent Chromium 153.0.8010.12 profile. Each fixture contained 10 MiB
of patterned payload across 10,000 files (1,000 empty) and 100 directories.
All three whole-stream checks and independent exact-tree/byte audits passed;
the saved command exit code is 0. The raw run timestamp is
2026-09-15T20:19:42.684Z; these results were reviewed later.

| Trial | Save s | Final verify callback to return s | Independent audit s | Journal create/write/close s | Journal share |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 85.278 | 13.082 | 10.561 | 26.319 | 30.86% |
| 2 | 85.599 | 12.584 | 10.342 | 26.929 | 31.46% |
| 3 | 105.335 | 16.125 | 11.071 | 33.187 | 31.51% |

Save median was 85.599 s, mean 92.071 s, and sample standard deviation 11.488 s.
The range (85.278–105.335 s) shows that a single faster observation would be
weak evidence of an optimization. Journal create/write/close remained
30.86–31.51% of save time. Final-verification timing starts at the first
verification progress callback and excludes the preceding exact-tree scan.

This is an unchanged-code baseline with instrumented API wall times. It
supports the journal-overhead finding, not a speedup, physical disk guarantee,
LAN rate, or performance acceptance threshold. Batching recovery markers would
require a separately justified change and interrupted-save validation.

Reproduction: set QRFT_BENCH_MIB=10,10,10, QRFT_BENCH_BATCHES=64,
QRFT_BENCH_FILES=10000, QRFT_BENCH_PERSISTENT=1, QRFT_BENCH_SAVE_TREE=1,
QRFT_BENCH_STORAGE_PROBE=0, and run npm run benchmark:receiver.
Raw results, log, explicit exit code, input fingerprints and calculated summary
are in release-evidence/receiver-many-files-repeated-baseline*.
Inputs were captured during the first trial and still matched at review.

## Process memory observations (recorded October 12, reviewed October 13)

The benchmark now has an opt-in Windows process observer:
`QRFT_WEBRTC_PROCESS_MEMORY=1`. It queries only process IDs returned by each
of the two isolated Chromium browsers. It retains bounded phase counters,
labels transitions during a query, reports missing processes and errors, and
stops further probes on a sampling failure. Failed/incomplete observation makes
a requested memory benchmark fail rather than inventing successful evidence.

Private bytes use [Process.PrivateMemorySize64](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.privatememorysize64).
They include JavaScript and native private allocation. Working sets include
[shared and private resident pages](https://learn.microsoft.com/en-us/windows/win32/procthread/process-working-set),
so summing process working sets can count shared pages more than once. These
are browser-process observations, not unique physical RAM or total machine
memory. Main-page CDP and periodic JavaScript heap observations remain separate.

Single trials used bundled HeadlessChrome 153.0.8010.12 on one Windows host.
All completed with exit 0, whole-stream verification, exact ACK/frame
accounting, no browser errors and no cleanup errors. The 100 MiB and 1 GiB
cases additionally saved to OPFS and independently audited every destination
byte. The 5 GiB case received and verified 5,368,709,372 stream bytes; it did
not reconstruct or audit a destination. Its free-space preflight allowed
5 GiB plus a 2 GiB reserve and 64 MiB profile allowance, based on a
point-in-time 8,215,392,256-byte available-space observation.

Receiver process-family observations, **decimal MB**:

| Payload | Work covered | Peak private MB | Peak working-set sum MB | Private MB after diagnostic collection | Completed sample cycles |
| --- | --- | ---: | ---: | ---: | ---: |
| 100 MiB | Receive, verify, save, audit | 227.64 | 544.56 | 176.44 | 8 |
| 1 GiB | Receive, verify, save, audit | 348.25 | 668.61 | 127.57 | 79 |
| 5 GiB | Receive and verify | 398.58 | 718.88 | 128.16 | 262 |

Private-byte peaks by phase were:

| Phase | 1 GiB MB | 5 GiB MB |
| --- | ---: | ---: |
| Receive | 270.28 | 273.08 |
| Whole-stream verify | 284.62 | 398.58 |
| Destination save | 288.00 | Not run |
| Independent destination audit | 348.25 | Not run |

For 5 GiB, main-page backing storage was 67,003,334 bytes before diagnostic
collection and 4,076,024 afterward; process-family private bytes fell from
192,704,512 to 128,163,840 at the post-run snapshots. Main-page collection
does not collect every worker or release every native allocation. It is not
a production memory strategy and does not remove the observed peaks.

The close 1 GiB / 5 GiB receive readings are consistent with bounded live
buffers over these tested sizes. Verification peaks varied. Single trials
and these sizes cannot prove bounded memory at 50–100 GB+, on physical target
devices, or during large destination saves. The historical 728 MB full 5 GiB
save/audit heap observation is retained and was not reproduced or resolved
by this receive-only 5 GiB run.

The observer waits two seconds after a sample finishes, so actual sampling
intervals include its query time. Maximum observer cycles were 0.526, 0.594
and 0.751 seconds respectively. Sampling can miss peaks or newly created
processes. Recorded transfer rates were 16.42 / 18.93 / 20.98 MB/s, but
observer overhead and single trials prevent treating these as speed acceptance
or a matched optimization result. No production transfer optimization was made.

The new observer tests first exposed an incorrect Windows PowerShell array
wrapper around ConvertFrom-Json; corrected parsing passed live/missing/duplicate
process-ID checks and malformed-input rejection. npm run check passed typecheck,
318 tests in 43 files and build. An observer-disabled 10 MiB raw/transfer smoke
also passed, including destination audit for the transfer case. All five shipped
assets and 113 existing runtime/browser-test inputs match the prior installed
Chrome/Edge checkpoint. The full browser gate was not replayed for these
benchmark-only changes.

Evidence: `release-evidence/process-memory-review-2026-10-13.json`,
`webrtc-process-memory-100MiB-1GiB-2026-10-12.*`,
`webrtc-process-memory-5GiB-2026-10-12.*`,
`webrtc-process-memory-disabled-2026-10-13.*` and
`process-memory-check-2026-10-13.*`. The stage/process records and input hashes
identify each run. The two earlier observer setup failures remain retained.
