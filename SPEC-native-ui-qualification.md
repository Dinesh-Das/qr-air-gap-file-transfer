# Native compiled-UI qualification

The optional `native_ui` dispatch input on Release checks runs one 5 GiB case
only after the unchanged complete Windows release gate passes. Pushes do not
run the large case. The case has no smaller fallback and no automatic retry.
Standard Windows runners are used; no paid larger runner is requested. The
available temporary volumes are measured, and the output uses the larger one.

The source is a fully written disk file, generated in bounded 4 MiB chunks by
Node's AES-256-CTR with public deterministic test parameters. The known 5 GiB
SHA-256 is `059c8416a6df00a6b4bc391b82a8f2962888e083fb4ab4fec261a96954a06b90`.
A 16 MiB local smoke exists only for testing the diagnostic itself; it is labelled
`smokeOnly` and cannot satisfy the hosted 5 GiB assertion.

The three new source/received/saved copies require 18,673,041,408 bytes free,
including the unchanged 2 GiB reserve and 400 MiB margin. The system C: drive
also needs reserve plus margin at preflight. Both output and C: free space are
sampled every second. Only the owned child PID tree can be stopped on a reserve
or deadline failure. The existing 5 GiB diagnostic budget is 30 minutes total;
no existing unit/browser deadline is changed. The workflow's 40-minute job
budget includes installation and evidence upload.

Two separate browser profiles load the exact compiled assets from the real
production HTTP/rendezvous service. The native source File enters through a
picker adapter. The real UI prepares, pairs, compares both verification codes,
transfers over same-host WebRTC, durably verifies, reconstructs and verifies the
saved tree in OPFS. The destination picker is injected; these are not actual
Windows permission dialogs or native user-selected destination directories.

Source reads, frames, ACK indices, manifests and final metadata/footer are
checked. Post-save receive-store deletion is deliberately denied so that both
copies remain for independent full source/received/saved byte comparisons and
separate file/stream SHA-256 checks. Cleanup success is therefore not tested.

Every PID selected by CDP must have valid Windows private/working-set readings.
Missing PIDs, duplicate/extra readings, invalid counters or observer errors make
the measurement invalid even if the after-list shows the process has exited.
Before/query/after data and the observer stage diagnostics are retained; no PIDs
are filtered. Later successful samples never erase an incomplete row; the
functional transfer may still finish to preserve independent byte evidence.
Samples are periodic, include observer and diagnostic overhead,
and can miss peaks. A single size cannot prove memory is bounded independently
of total size or establish a throughput acceptance baseline.

Artifacts contain raw metadata, streamed native sample records, parent resource
logs, screenshots and the served compiled assets. Source and profile payloads
are excluded from upload, remain on the job VM until teardown, and are unavailable
for later payload rechecks. The public source fixture is reproducible; the full
independent byte/hash audits happen before teardown. Partial/failing metadata
is uploaded too. No failure is converted into success or retried to get green.

This is one hosted/same-host Windows case, not physical LAN/Wi-Fi, actual OS
picker/permission/clean-OS/ordinary-user launch, 10/50/100 GB+ resource scaling,
or the final adversarial release pass. READY and general performance/resource
acceptance remain false. Real two-laptop validation remains mandatory.
