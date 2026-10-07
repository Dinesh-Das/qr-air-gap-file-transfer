# Recover a bounded trusted journal prefix

Oversized receipt journals must not require manual file repair. Read a Blob
slice capped at the current writer's compaction threshold plus one maximum
record; never allocate an arbitrarily large whole-journal ArrayBuffer.
Healthy journals fit entirely within this prefix.

Replay only whole records with valid magic, version, checksum, generation order
and unique in-range indices. An unrepresentable generation ends the trusted
prefix just as an invalid checksum does. The existing worker open operation
truncates the rest after payload-length validation while the store lease is held.
Do not delete payload, publish receipts for an invalid record, or claim payload
integrity from journal metadata alone. Full stream and tree verification remain
required before save.

If the prefix has valid receipts, reconnect skips that reusable data. If no
receipt is trustworthy, keep payload but request fresh blocks; checksum-valid
source blocks overwrite unreceipted bytes. Do not fabricate receipt bits from
existing payload size.

Model tests cover reported 1 GiB size with small body, oversized junk after valid
receipts, partial records, checksum-valid unsafe generation, invalid whole
journal, lease/append/reopen, and durable data preservation. Native browser tests
write actual 300 KB journals with and without a valid prefix, reconnect without
test-only metadata repair, assert bounded slice reads and expected wire bytes,
then independently hash the saved 120 KB file.

This establishes the tested journal-tail recovery cases. Both corrupt
checkpoints, payload truncation, every legacy/outlier file and multi-GB physical
resource/network/power-loss behavior are separate acceptance obligations.
An oversized journal whose suffix contains valid records beyond the healthy
writer limit can lose those suffix receipts and require retransmission; do not
claim arbitrary oversized legacy journals are fully salvaged.
