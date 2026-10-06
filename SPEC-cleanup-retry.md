# Temporary transfer-storage cleanup after saving

A cleanup failure must preserve the independently verified destination and offer
an explicit retry. Delaying that retry must not allow Receive more files to open
another transfer before deletion and store closure finish. Retry success must
remove only the app's transfer directory; retry failure must retain it. Once
reset completes, old cleanup errors must not pollute the pairing screen.

Cover retry success/failure both while staying on the saved screen and while
choosing Receive more files. Use real WebRTC and OPFS with synthetic removal
failure/delay, verify saved size and SHA-256 independently, and enumerate the
temporary transfer directories.
While removal is delayed, a contending exclusive Web Lock must not acquire the
transfer store. Success or completed reset must release its lease; a failed retry
on the saved screen must retain that lease for further cleanup.

After Receive more files, transfer the identical source again: retained receipts
must require zero payload resend after cleanup
failure; successful cleanup must require a new payload. Save and independently
verify that second destination, and require successful storage reclamation.

These tests exercise API-level timing and errors on one host. They do not prove
native permissions, physical power-loss durability or OS interruption behavior.
