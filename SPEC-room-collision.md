# Bounded local room-code collision allocation

Force duplicate six-digit code draws in a unit test without changing production
entropy generation. A retry must choose a different unused code without replacing
the existing room. Thirty-two exhausted candidate draws must fail explicitly,
allocate no new room, and preserve the existing room. A later unused draw must
allow retry. Cancelling a room can release its short code, but its old room/owner
capability must not authorize or locate the replacement room.

Mock only the test module's randomInt code draw. Keep actual cryptographic
randomBytes for room and capability tokens. This proves one registry's bounded
allocation behavior, not globally unique codes across independent runtimes.
Cross-device accidental connection safety still depends on fresh transcript-
bound authorization and correct human code comparison; physical validation is
required separately.
