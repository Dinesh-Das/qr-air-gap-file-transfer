# Explicit recovery for an unusable receive copy

When opening a human-authorized WebRTC transfer fails with the trusted local
CORRUPT_STORE error, offer "Discard unusable transfer copy". Explain that this
removes the copy on the receiving laptop and that the sender's source is needed.
Do not offer deletion based on peer error text or an error name alone.

Discard only the directory derived from that transfer identity in app-owned
OPFS. Acquire the same shared root/exclusive store locks as opening; reject a
busy target, keep unrelated stores usable, tolerate an already-missing copy,
and release leases if removal fails. Never use the global clear-all operation.

While discarding, block navigation and duplicate actions. On failure retain the
action for retry. Invalidate stale async work and return to pairing after success.
No save/success state is allowed for unreadable checkpoints or a payload shorter
than its trusted receipts. Fresh receiving must still verify stream/tree bytes
and independently checked destination bytes.

Regression evidence covers storage isolation, a busy target, removal failure/
retry, corrupt checkpoints and truncated payload in native local OPFS, an
unrelated sentinel, double click and blocked navigation during held removal,
fresh wire retransmission and saved-file hashes. Real two-laptop disk/network/
permission/power-loss validation remains required.
