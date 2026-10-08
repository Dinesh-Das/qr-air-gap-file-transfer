# Completed connection callbacks

After successful receive verification, callbacks queued on that connection must
not replace the sender's completion state, invalidate the receiver's verified
cache, or disable destination saving/retry. Ignore those callbacks once the
sender is complete or the receiver has completed reception, is saving, or has
saved. A new connection continues to use the existing generation isolation.

Authorization and early completion checks remain active before verification.
The completed receiver state is reached only after whole-stream verification and
validated tree parsing; this change must not accept premature success or data.

Use a real local WebRTC/OPFS transfer, wait for verified receive and closed
channels, then deterministically dispatch a late callback on the retained real
listener. This models a callback queued before close, not a packet sent after
close. Duplicate completion, error and cancellation must preserve the completion
UI and permit a destination save with independent size/SHA-256 verification.
Retain the existing premature payload/success, privacy and retry browser gates.
