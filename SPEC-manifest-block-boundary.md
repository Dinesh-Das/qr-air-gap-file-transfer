# Incoming manifest block-map limit

Local transfer creation and the storage backend already reject transfers needing
more than MAX_BLOCK_STORE_BLOCKS fixed-size blocks. Incoming manifest decoding
must apply the same ceiling before accepting the manifest at the wire boundary.
Outgoing control encoding must enforce it too. Retain the existing positive safe
integer size, fixed block size, portable root name and canonical identity checks.

An identity-valid one-byte-over-limit and maximum-safe-integer manifest must
reject without opening storage or allocating a transfer-sized buffer. Identity-
valid sizes of one byte, 100 GiB and the exact supported ceiling must continue
to parse. These are grammar/boundary tests, not evidence of large file transfers.
The existing backend validation remains as defense in depth; no allocation
bypass or physical resource acceptance is claimed.
