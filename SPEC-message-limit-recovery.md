# Recovery for insufficient SCTP message capacity

The sender checks the locally observed SCTP maximum message size after both
human code confirmations and before sending a manifest. If a finite nonzero
limit is below the payload block plus its protocol header, transfer must stop.
The user should see a connection capacity explanation and advice to open both
laptops in current Edge or Chrome and reconnect. Technical capacity details
remain available in diagnostics.

Only a locally constructed `TransferMessageSizeError` selects that advice.
Peer supplied text or an error name alone must not select it. The existing
size predicate, zero/unavailable handling, block size, authorization and wire
protocol remain unchanged.

Regression evidence uses real local WebRTC pairing with the sender's JavaScript
SCTP capacity property overridden to 1024 bytes. It verifies the advice and that
no manifest or binary payload is sent. This does not establish a naturally
negotiated low-capacity connection, physical two-laptop behavior or that a
browser upgrade resolves every capacity limitation. Formatter tests cover
trusted identity, diagnostic details and an untrusted lookalike error.
