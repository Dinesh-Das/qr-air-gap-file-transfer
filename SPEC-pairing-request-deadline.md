# Pairing HTTP request deadline

The local preflight already has a five-second deadline. Subsequent pairing HTTP
requests must also settle if headers or JSON bodies stall, including HTTP error
bodies. A healthy runtime can spend 12 seconds discovering a peer and six seconds
fetching its offer, so use 30 seconds for one complete HTTP exchange. This is not
a deadline for the user to enter a code or compare device codes. Healthy answer
polls continue under the existing room expiry policy.

Apply the deadline to room creation, joining, each answer poll, answer publication
and room deletion. Forward caller cancellation to the fetch and preserve its exact
reason through transport and body-error handling. Clear the timer and forwarding
listener when the operation settles. An already aborted caller starts no request.
Timeouts use the trusted RendezvousError/503 recovery path. Keep existing HTTP
status handling and JSON validation; do not automatically retry ambiguous writes.

Deletion retains keepalive and accepts 404 without parsing a body. Cancel an unread
successful deletion body. A page's timer does not promise execution after its
realm is destroyed; server TTL/caps/shutdown remain separate safeguards.

Tests must include stalled headers for all five operations, stalled success/error
bodies, custom abort reasons in all three phases, already-aborted calls, timer and
listener cleanup, a healthy 29-second response, and deletion's existing semantics.
Built UI tests should use native fetch against controlled loopback stalls, prove
the request aborts and recovery remains usable, then retain normal browser gates.
None of these checks substitutes for physical two-laptop timeout acceptance.

Once a native data-channel open event establishes a connection generation, a late
answer-publication HTTP failure must not terminate that receive or invalidate its
verified/saving/saved state. Reset clears that generation marker; data-channel,
authorization, storage and verification errors remain authoritative. Four browser
regressions hold publication after the answer is applied, then reject it during
receiving, complete, saving and saved, and independently audit destination bytes.

