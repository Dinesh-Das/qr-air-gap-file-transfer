All four current-code single-file transfers and destination saves passed independent byte and SHA-256 checks. Three raw diagnostics passed their requested-process and disk checks. The 100 MiB Chrome diagnostic remains failed because one native process observation was missing.

| Browser / file | Payload MB/s | Integrity | Requested PID samples | Exact receiver states sampled |
|---|---|---|---|---|
| chrome / 10 MiB | 3.72 | pass | complete | receive (1), destination (1) |
| edge / 10 MiB | 40.90 | pass | complete |  |
| edge / 100 MiB | 29.78 | pass | complete | receive (2), destination (1) |
| chrome / 100 MiB | 45.71 | pass | **FAILED: one missing** | receive (1), verify (1), destination (1) |

Each trial preserved both the received and saved file. Independent Node checks decoded footer/metadata, read all fixture bytes, checked the complete stream and file digests, and hashed every profile file twice. Matching-size Chrome/Edge trials produced identical file and stream digests. The missing 100 MiB Chrome process was the sender’s CDP-reported chrome.mojom.ProcessorMetrics PID 27480. Its absence from the Windows response is retained; no exit or access-failure cause is assumed. The earlier current-code 1 GiB diagnostic also stays failed.

Complete requested PID samples are not complete phase coverage. For example, the very short 10 MiB Edge trial only sampled receiver setup. Exact per-state counts, transition labels, CPU and operation counters remain in the JSON/raw reports. Unobserved phase peaks are unproven. Periodic data cannot establish continuous native memory peaks. Diagnostic byte-audit allocation remains separate from production save verification.

These are one-trial-per-cell, same-host, headless-browser measurements of instrumented production source with synthetic File-like snapshots, direct SDP and an injected OPFS destination. They bypass application pairing, native source disks and OS pickers. The fixture repeats every 256 bytes. No physical Wi-Fi/LAN speed, general browser ranking, throughput/resource acceptance, native filesystem or 50–100 GB claim follows from them. Timing differences and missing observations need diagnosis; no protocol, browser-feature, memory gate or deadline was changed to obtain a pass.

All previous 2292 sealed paths, current 176 inputs, five assets, canonical checkpoint and ledger remain unchanged. No owned test worker remains. All 42 physical cases remain not run. Release remains **NOT READY**.
