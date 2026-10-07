# Native UDP discovery rejection evidence

`tests/discovery-adversarial.test.mjs` sends packets through actual Node UDP
loopback sockets to the production rendezvous listener. A read-only socket
observer confirms every test packet arrived; send completion alone is insufficient.
The production handler and packet bytes are not replaced. Registry observations
prove rejected packets did not claim the room or supply an answer.

One test sends 24 malformed/unaccepted packets: empty, invalid encoding outside
JSON, truncated JSON, primitive/array objects, wrong protocol/type, invalid
request IDs/nonces/proofs, unsolicited malformed advertisements, and an authentic
1,201-byte discovery request. An authentic 1,200-byte request then pairs, retries
with the same credentials, retains its claim against another request ID, and
exchanges offer/answer through real TCP signaling.

A second test observes 120 real wrong-proof discovery packets reaching the
registry, a valid 121st packet being rate-limited without claiming the room,
and a valid request succeeding after a controlled 60-second clock advance.
The clock advance is not proof of real-time expiry under sleep/restart.

The third test cancels a live HTTP join during UDP discovery, observes pending
state drain, sends a late old advertisement, starts a fresh attempt, replays the
old advertisement, then sends the current request advertisement. Old replies
never start TCP signaling; the current reply starts exactly one real TCP offer
request and creates one local join. Request IDs come from the real runtime;
cancellation uses a real HTTP disconnect.

The initial negative control removes only the UDP input-length guard in an isolated
source copy. The authentic oversized request must then fail the no-claim
assertion; original bytes are restored and hash-verified afterward.
A second negative control resolves the first pending discovery regardless of
the advertisement request ID. The stale-reply test must fail with this weakened
binding; original bytes are restored and hash-verified afterward.

This is targeted evidence for L870/L937. It is not randomized or exhaustive
fuzzing, adapter broadcast routing, hostile packet-flood resource bounds,
firewall/Wi-Fi/two-laptop acceptance, all invalid UTF-8 positions, pending
discovery reply spoofing, or packet loss/reordering proof. No production defect
was reproduced in these cases. No-response observations cover the test window.
