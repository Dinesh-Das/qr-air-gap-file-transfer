The current source/receiver code completed a 1 GiB transfer plus destination save. Independent checks read every received and saved fixture byte, decoded the footer/metadata and verified file and complete stream SHA-256. The raw diagnostic exit code is 1; complete measurement status is **FAILED / INCOMPLETE**. Data integrity, memory-observer completeness and disk reserves are evaluated separately.

| Observation | Result |
|---|---|
| Payload interval | 19.18 MB/s over 55.98 s |
| Synthetic source preparation | 52.45 s |
| Received stream verification | 27.33 s |
| Destination write and verification | 58.49 s |
| Independent diagnostic audit | 6.63 s |
| Complete timed native samples | 177 |
| Sender sampled private-memory maximum | 518201344 bytes |
| Receiver sampled private-memory maximum (incomplete observation) | 547622912 bytes |

One Windows sample missed the receiver on-device-model service reported by CDP. The memory measurement stays failed; sampled maxima are incomplete observations. No process was excluded to obtain a pass. A single current run is not a matched before/after performance comparison. Private-memory totals aggregate the native processes owned by each role; phase details and missing observations are retained in the JSON report. The diagnostic audit still uses its existing slice/arrayBuffer byte loop, so its peak must not be attributed wholesale to production save verification. Periodic observations can miss inter-sample peaks. Both datasets and profiles remain outside Temp. No owned measurement worker remains.

This measurement uses the current 176-input production source under development-server timing/preservation transforms, separate headless Chrome processes, a synthetic source and injected OPFS destination. It bypasses application pairing and OS pickers. Its repeating 256-byte fixture does not prove arbitrary high-address source offsets. It is not a physical Wi-Fi/LAN speed result, a 50–100 GB test or broad resource/throughput acceptance. No timed forced collection or threshold relaxation was introduced.

The canonical release checkpoint, source, assets and previous 2238 sealed paths remain unchanged. The small workspace native dependency package was preserved on C: with hashes and a directory junction at its old path; no protected payload/profile/evidence was moved or deleted.

All 42 physical cases are still not run. Release remains **NOT READY**.
