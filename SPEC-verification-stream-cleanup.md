# Verification stream cleanup

Whole-stream receiver verification must cancel its reader before releasing the
reader lock on success, abort, or failure. Releasing the lock alone leaves
prefetched data queued on an interrupted stream. Already-aborted verification
must stop before creating a read stream. Cleanup failure must not replace the
verification/Stop error. Canceling this read stream does not delete durable
receipt or payload data.

Four additional model checks cover an already-canceled complete store (stream
factory never called) and abort, progress-callback, and read failures combined
with an injected reader-cancellation rejection. The original error object must
survive, the reader lock must be released, durable data must remain complete,
and normal verification must still succeed afterward. The pre-canceled case
checks the no-open precondition; the other three cases separately retry normal
verification.

In an isolated source copy, removing the early abort check fails one assertion;
removing cancellation-error suppression fails three primary-error assertions.
Original source bytes are restored before the full gate. These injections prove
the selected error/lifetime contract, not real native cancellation failures or
OS/disk fault behavior.

An isolated regression using the production 4 MiB verification chunk size and
an 8 MiB memory-store fixture reproduced an unlocked stream returning a queued
4 MiB chunk after Stop. The regression requires that stream to return EOF after
Stop, while durable progress remains complete. Existing tests also require
retrying verification without retransmission after an abort.

The native pairing regression uses an 8 MiB transfer and real OPFS/RTC in a
browser context. It holds the first 4 MiB reader result after its native read,
allows prefetch, clicks Stop, releases the held result, and requires the
captured stream to return EOF after the receiver drains and resets. The
unchanged previous bundle instead returned 4 MiB. The fixed bundle passed in
Edge and Chrome, retained durable blocks, resumed with zero retransmitted
bytes, and saved a file whose hash matches the independent Node expectation.
The test restores the reader hook and cancels its observation reader in finally.

This proves queued-stream cleanup in these Node and native browser scenarios.
Holding the read result changes timing, and retaining a stream reference is
necessary to observe the queue; it does not prove indefinite leakage or GC
reachability. It does not prove all in-flight I/O timing, permission/power
failures, peak-memory acceptance, the cause of the historical 728 MB save/audit
observation, or 50–100 GB+ behavior. The browser test uses injected pickers and
local signaling routes; physical networks and native OS pickers remain untested.

The fixed production snapshot passed the earlier full 85-case Edge/Chrome
gates. This additional native case then passed separately in each browser.
That is full prior-suite evidence plus focused coverage, not a full 86-case
suite run after adding the test. Production/package assets are unchanged.

The retained pending-worker-read regression is strengthened separately: its
stream branch now transfers 8 MiB, holds the first read-payload RPC before native
dispatch, requests Stop, then releases it. The current Edge run keeps the RPC
count at one after reset in Edge and Chrome; the unchanged pre-cleanup bundle
reaches two and fails that assertion. A controlled isolated build removing only
reader cancellation also reaches two; its source/build are restored afterward.
The footer branch still uses 120 KB. Both branches reconnect
without retransmission and verify the saved file hash. The larger stream phase
has a 15-second readiness wait within the unchanged 45-second total deadline;
the initial five-second waits that failed before the held read are retained as
setup failures, not negative-control proof. Counts measure app RPCs under this
injected schedule, not every possible kernel-I/O or physical-device timing.
These focused cases strengthen an existing fixture after the full 88-case
browser gates. They do not constitute another full-suite run or a new production
fix; application and package assets are unchanged.
