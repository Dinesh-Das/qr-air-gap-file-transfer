# Deterministic WebRTC control and packet mutation corpus

Use a fixed nonzero seed to select 1,000 known-invalid required-field mutations
across ACK, resume range, peer confirmation, error and manifest controls. This is
a small grammar mutation pool with repeated selections, not 1,000 distinct
arbitrary messages or a complete security fuzz audit. Include numeric-looking
strings to guard strict numeric field types.

Check ACK/range entry limits at the maximum and one over, error/cancel text at
2,000 and 2,001 characters, and control wire strings at 256 Ki UTF-16 code units
and one over. These wire-length checks use JavaScript string length, not an
assertion about arbitrary Unicode UTF-8 byte length.

For a valid 141-byte binary packet, flip every bit individually (1,128 variants).
Both synchronous and asynchronous decoders must reject all variants; require
native Web Crypto availability for the async entrypoint. Check four truncations
and an added trailing byte through both decoders. Preserve valid round trips.

These are bounded parser/wire tests. They do not prove receiver authorization,
state-machine recovery, UDP/SDP/path parser security, native transport behavior,
absence of all vulnerabilities, or physical release acceptance.
