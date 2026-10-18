# Receiver cancellation across a storage commit

The unchanged production queue, receiver and sender passed six additional model
checks for Stop and reconnect. This supplement adds evidence; it does not change
the application, release candidate, canonical gate, requirement ledger or the
qualified unit-test total of 530. The release remains **NOT READY**.

| Cancellation boundary | Committed blocks on reopen | Blocks retransmitted |
|---|---:|---|
| Before queued drain starts | 0 | 0–4 |
| During an active write, before it commits | 1 after the write settles | 1–4 |
| After commit, before its reply | 1 | 1–4 |
| Active write rejects before committing | 0 | 0–4 |
| Reply is lost after commit | 1 | 1–4 |
| Two blocks acknowledged, one short tail queued | 2 | 2–4 |

Each case uses a new memory repository and a five-block virtual tree. The probe
holds the production store's `writeBlocks` boundary, requests Stop, then releases
or rejects that operation. It checks that Stop drains already-started work,
queued work does not start, retained queue bytes reach zero, no ACK is sent after
Stop, and the primary write/reply failure is preserved. Reopening the repository
must advertise exactly its committed receipts. The production sender then sends
exactly the missing indices. Whole-stream verification, tree parsing, a full byte
comparison and independent Node SHA-256 comparison must succeed.

Two transient Vite transforms provide negative controls. Removing the queue's
late-ACK guard fails the two successful held-write cases at the explicit late-ACK
assertion. Making Stop return without awaiting its active operation fails all
four held-operation cases at the drain assertion. The other cases pass. Neither
transform writes to application source files.

The first run retained four passes and two fixture failures: the fixture expected
a generic closed-queue error when an injected operation had already failed. The
production queue correctly preserves its original error. The corrected run
requires that exact error object and passes all six cases. Initial source,
configuration and logs remain preserved alongside the successful run and both
negative controls.

Review found no application defect in these boundaries. The queue's stopped
state suppresses late ACKs, its returned active promise protects storage lifetime,
and reopening derives resume state from the store rather than missing replies.
There are no new production branches, dependencies, buffers or public interfaces.
All 175 current inputs, five compiled assets, 949 canonical evidence files and
the previous 133-file final index were checked unchanged before and after each
run and by the independent verifier.

These are deterministic in-process storage-model checks. The held methods and
injected failures do not simulate native OPFS flush, an OS disk failure, power
loss, a real network disconnect, indefinite I/O or cancellation latency. They do
not qualify large-file scaling or physical receiver cancellation. Requirement
L857 remains review-pending in the canonical ledger, and physical cancel/resume
L1085 remains unproved. All 42 physical cases are still not run. The previous
Chrome run's disk-reserve qualification remains failed; these small Node probes
do not replace it.

The structured results and scope are in
`receiver-cancel-durable-boundary-independent-verification-2026-10-16.json`.
The supplement's final hash index includes the source, logs, controls and process
closure without changing the canonical application checkpoint.
