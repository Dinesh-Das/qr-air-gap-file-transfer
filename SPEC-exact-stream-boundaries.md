# Exact WebRTC transfer-size boundaries

The file payload and complete virtual tree stream have different byte lengths.
Tree metadata and the footer must count when testing an exact transport block.
`tests/webrtc-transfer.test.ts` now transfers six explicit cases through the
production sender, durable receive queue, memory store and whole-stream verifier:

- Empty file and one-byte file.
- File payload exactly 61,440 bytes and payload 61,441 bytes.
- Complete encoded stream exactly 61,440 bytes and stream 61,441 bytes.

For encoded-stream cases the test reparses actual preparation results, adjusting
file length until the encoded total equals the requested boundary. It does not
assume metadata length stays constant across decimal size widths.

Each case checks packet indexes and payload lengths, absence of an empty tail
packet, exact durable byte/block counts, sender completion, full-stream hash,
decoded file size/path and empty directory, and every reconstructed file byte
against an independent offset-times-37 pattern.

This is a model with a fake data channel and in-process storage. It does not
establish native OPFS/RTC or physical network behavior at these exact sizes,
empty-root-only trees, large-file resource bounds, or exhaustive metadata widths.
No production defect was reproduced and no production code changed.
