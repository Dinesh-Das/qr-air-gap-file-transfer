Both current-code workloads passed: a 100 MiB tree with 2,000 files, including 200 empty files and 20 directories, was transferred over local WebRTC, verified and saved to an injected OPFS destination in separate Chrome and Edge trials. Every reported native process sample was complete and all sampled disk reserves exceeded 2 GiB.

| Observation | Chrome | Edge |
|---|---|---|
| Payload interval MB/s | 11.00 | 34.24 |
| Synthetic scan / prepare (s) | 0.03 / 5.97 | 0.03 / 3.39 |
| Payload interval (s) | 9.56 | 3.07 |
| Received stream verification (s) | 2.50 | 1.32 |
| Destination write + verification (s) | 20.85 | 15.66 |
| Diagnostic audit (s) | 2.63 | 3.69 |
| Complete native process samples | 40 | 28 |
| Durable payload flushes / ACK messages | 93 / 93 | 38 / 38 |

Independent Node checks read every received source-file byte, verify each file digest and the complete stream SHA-256, and uniquely match all 1,800 nonempty physical destination data files by expected content, size and SHA. Profile files were hashed twice after browser shutdown. The native browser API audit checks the actual logical path/type set and 200 empty files. Node does not decode Chrome’s obfuscated logical-name database; its content associations alone are not independent logical-path proof. Both browsers produced the same deterministic stream digest.

Source-read/copy/encode, receive/decode/write/flush/journal, final stream, destination verification and CPU counters remain in the raw and joint JSON reports. CPU sums omit processes that exit between endpoint snapshots. Summed asynchronous timings can overlap and should not be added as elapsed time. The diagnostic byte audit uses its existing slice/arrayBuffer loop; its allocations are separate from production verification/save. Periodic native observations do not establish continuous memory peaks.

These are single trials of instrumented production source on one host with synthetic File-like snapshots, direct SDP and an injected destination. They bypass application pairing, native source disks and OS pickers. The timing difference does not establish a causal diagnosis or general browser speed advantage. No Wi-Fi/LAN speed, full resource/scale, native filesystem, UI usability or 50–100 GB acceptance is claimed. The fixture repeats every 256 bytes within each file, so it cannot distinguish every wrong source offset.

The earlier current-code 1 GiB diagnostic remains failed because one process observation was incomplete, despite independent integrity success. No process was excluded, no missing sample was waived, and no test/resource threshold changed. Source, assets, canonical checkpoint and the previous 2264 indexed paths remain unchanged. All 42 physical cases remain not run. Release remains **NOT READY**.
