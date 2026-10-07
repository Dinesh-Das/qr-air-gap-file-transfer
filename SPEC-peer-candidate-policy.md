# Incoming peer candidate validation

Both roles validate received SDP before native remote-description processing.
Receiver validation precedes peer creation; sender validation precedes transcript
derivation and answer application. Accepted SDP is never rewritten, preserving
the exact transcript used for device authentication.

Match the existing outgoing policy: require at least one private/loopback/
link-local/ULA/mDNS host candidate and reject any explicit globally routable
host or relay/reflexive candidate. Missing/oversized/malformed candidate details
fail with a local typed error. Only that trusted error selects policy recovery
advice; a peer-controlled error name/text cannot select it.

This extends the current local-host-only design. Internet independence in the
original requirements is not treated as a promise that zero internet packets
can ever occur. This guard does not validate the whole SDP grammar, resolve
mDNS destinations, prove every routing directive harmless, or establish an
exploitable leak in the prior build. Browser parsing remains authoritative for
accepted SDP syntax. Other routing attributes need separate scrutiny.

Tests cover allowed addresses, public/private mixed candidates, non-host types,
input limits and transcript preservation. Native regressions intercept the
remote-description method so no public candidate reaches native processing even
when testing the older vulnerable handoff. They cover both offer and answer
roles, with browser-generated templates and injected signaling/pickers.

Normal pairing and the current full browser gates must still pass. Physical
networks, OS pickers, private-window quotas, large-transfer resources and hosted
CI remain separate release obligations. A guard pass is not release readiness.
