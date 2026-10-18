# Stop before starting another source read

The sender must reject an already-aborted run before reporting progress or
touching the source. After an asynchronous writable-window wait, recheck both
the abort signal and sender failure/disposal before starting the next source
read. Resolving a waiter does not authorize future work after cancellation.

Preserve the original cancellation/failure error. Do not send a payload or a
completion marker after stopping. A source read that has already started may
settle; its result must not be sent. This change cannot cancel an in-flight
File System Access promise and must not claim otherwise.

Add regressions before implementation: already aborted, immediate abort after
run starts, immediate sender failure, immediate disposal, and a held native-File
snapshot read that begins before cancellation. The first four require zero
new source reads; the last permits exactly the already-started read and requires
zero sends. Keep existing pause/backpressure/resume and integrity tests intact.

Verify the corrected behavior with actual browser File objects, run type/unit/
build and both full browser suites, then qualify new packages. No wire format,
hashing, sender window, resume algorithm or authentication change is intended.
Real two-laptop and broader resource acceptance remain required before READY.
