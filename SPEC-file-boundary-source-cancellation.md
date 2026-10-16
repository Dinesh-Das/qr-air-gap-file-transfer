# Stop between native reads inside a virtual range

A single transfer block can span several cached source File snapshots. Stopping
while its first read is pending must let that read settle without opening any
later snapshot. The sender's abort, failure and disposal state must therefore be
checked inside the virtual-range reader, not only around its outer promise.

`readPreparedLargeRange` accepts an optional caller-owned `assertActive` guard.
Check it before allocating/reading a range, immediately before each snapshot
read, and after that read settles. If the read rejects, check the caller state
before propagating the I/O error so an earlier Stop or connection failure keeps
its original reason. Callers without the guard keep their existing behavior.
This adds no AbortSignal API/version requirement or event-listener lifetime.

Six regressions hold the first of two real File snapshot reads. Abort, sender
failure and disposal must each prevent the second read and all sends, whether
the held read resolves or rejects late. The already-issued native promise may
settle; this does not cancel kernel I/O or prove physical interruption behavior.
Keep the previous 37 transfer tests and all existing resume/integrity checks.

No wire framing, SHA-256, window limit, source preparation, authentication or
resume algorithm changes are intended. The fresh-install/browser/5 GiB and
matched 1 GiB measurements collected immediately before this fix retain their
exact predecessor-revision scope until explicitly requalified. Physical,
native-picker, full resource/performance and hosted-CI acceptance remain open.
