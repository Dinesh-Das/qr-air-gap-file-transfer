# Stop while destination payload operations are pending

Stop and reconnect must invalidate the save generation, abort further work,
and drain already-started destination operations before releasing the destination
and transfer-store locks or allowing another receive to start. A cancelled save
must not report success or mark an unacknowledged file complete.

Cover a delayed payload file open, delayed write, and a successfully closed file
whose close promise has not yet returned to the caller. While held, a contending
destination lock must not acquire and the pairing screen must remain unavailable.
After settling the operation, require the pairing screen without stale errors,
no held destination/store leases, and a retained partial marker with zero file
completion bits. Aborted open/write leaves an empty file; the closed file retains
its bytes but remains unjournalled.

Reconnect with the identical source. Durable receive receipts must permit zero
payload bytes to be resent. Saving again must repair/rewrite the unmarked file,
remove the marker only after verification, and produce the expected filename,
size and independently checked SHA-256.

Use real one-host WebRTC, OPFS writers and Web Locks, with deterministic API
delays. These tests do not prove native filesystem, OS or physical power-loss
behavior, nor cancellation of a hung operating-system I/O request.
