# Bound receipt-file allocations before reading corrupt metadata

Historical checkpoint: the journal rejection policy below was superseded by
`SPEC-journal-prefix-recovery.md`, which recovers a bounded validated prefix.
The checkpoint-size guard and size-only metadata accounting remain current.

OPFS opening must check snapshot size before reading a checkpoint or receipt
journal into an ArrayBuffer. Content decoding alone is too late to bound memory.

The maximum checkpoint size is derived from the existing format header,
4096-byte store ID limit, 256-million-block bitset limit and checksum. An
oversized slot is an invalid recovery candidate; a valid alternate still works.
If neither existing checkpoint is trustworthy, opening fails closed.

A healthy journal compacts at max(256 KiB, twice the receipt bitset length).
Its largest possible final record contains 4096 indices. Reject a snapshot
larger than that threshold plus one maximum record before reading its body.
Use the same threshold calculation for writing, quota estimates and reopening.
This does not reset or delete payload, silently assert completion, or change the
wire/receipt format. Initial metadata accounting reads file sizes only.

Three unit regressions use a reported 1 GiB snapshot size with small fixture
bodies, so they prove allocation prevention without allocating 1 GiB. They
cover failed opening with lease release, a valid alternate checkpoint, and
preserved durable payload after test-only journal repair.

A browser regression writes an actual 300 KB OPFS journal and observes zero
main-page journal ArrayBuffer reads, zero ACK/completion, and no save action.
Test-only repair then resumes with no payload retransmission and saves a file
whose hash is independently checked. This repair is fixture control, not
nontechnical recovery UX or native two-laptop/resource acceptance.

Existing compaction-failure and resume tests must remain green. Preserve all
release requirements: large-transfer peak memory, corrupt-metadata user recovery,
physical laptops and remaining chaos/adversarial proof are still separate gaps.
