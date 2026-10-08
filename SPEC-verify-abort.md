# Cancel tree verification without starting more reads

Tree metadata parsing accepts an optional AbortSignal. Existing callers without
a signal retain their behavior. Check cancellation before the footer read,
after it settles and before allocating metadata, and before/after each bounded
metadata read. A cancelled parser must not start further reads or parsing work.
Already-started I/O still drains before the receiver releases its lifetime lock.

Both WebRTC and optical QRF3 receivers pass their verification controller signal.
Generation checks still prevent stale completion. Cancellation retains good
durable receipts, sends no receiver-complete, and permits reconnecting the same
source without payload retransmission. The eventual destination must still pass
independent size/SHA-256 verification.

Cover pre-aborted parsing, cancellation while the footer is pending and during a
multi-chunk metadata read. Add real one-host WebRTC/OPFS regressions stopping a
held worker payload read during stream verification and footer parsing, measuring
that no further reads start before reconnect. These tests do not cancel hung OS
I/O or prove native/physical interruption behavior.
