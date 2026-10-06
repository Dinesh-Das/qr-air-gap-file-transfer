# Bounded destination readback

The fresh-stage Edge release gate reproduced two 1,200-file recovery timeouts
at the existing 30-second destination-completion check. The same unchanged
cases passed in the main checkout. A diagnostic copy measured sequential
filesystem lookups and reads in the final verification pass; the receiver was
visible. The underlying difference between stages is not established.

Overlap final verification and resume checks of up to four consecutive files of at most 64 KiB
each. Larger files remain sequential with the existing maximum 4 MiB chunk.
Small-file read buffers total at most 256 KiB. Resolve each current path anew;
do not retain file or directory handles from writing or across checks. Preserve
exact-tree scanning, every file's SHA-256/size check and per-file durable journal
semantics. A mismatch or cancellation must retain the recovery marker. Drain all
started reads before returning or releasing the destination lock, including
when one read rejects. Report completed verification only after successful reads.
Resume checks only prefetch consecutive journal-marked files, retaining at most
four results. Up to four unmarked small-file payloads may write concurrently;
each must hash and close before its completion bit is journalled. Journal
mutations remain sequential, one commit per file, with no batching of receipts.
Closed payloads without committed bits are rewritten after interruption. Drain
started writes on failure/cancellation before releasing the destination lock.
Small writes use at most 256 KiB of source chunks plus at most 256 KiB of ordinary
buffer copies; large writes remain sequential with the existing chunk bounds.
Final verification resolves all paths again after repairs and writing.

Verify with held-read concurrency, bounded small/large groups, rejection and
cancellation draining, existing path-replacement and recovery tests, matched
before/after diagnostic observations, and the original unchanged browser gate.
Do not raise the completion deadline or infer physical/native performance from
one-host synthetic/OPFS results. Retain failed trials as well as passing trials.
