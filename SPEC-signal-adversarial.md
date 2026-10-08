# Optical signaling parser evidence

Tests in `tests/webrtc-signal-adversarial.test.ts` exercise the existing WRS1
parser with independently constructed compressed envelopes. Production code is
unchanged. This is targeted parser evidence for requirement L937, not exhaustive
fuzzing or a claim of physical QR-scanning acceptance.

The corpus includes 512 distinct invalid total counts (257–768), negative,
out-of-range, unsafe and long numeric indexes, duplicate/conflicting fragments,
all 32 checksum-bit changes, CRC-valid invalid UTF-8 and JSON, and a compressed
JSON body expanding to 2 MiB. It also covers invalid decoded fields, envelope
kind/session mismatch, reset recovery, and the 128 KiB ASCII SDP boundary.

The inflated-size case proves rejection by the public API. It does not measure
peak memory, CPU, decompressor callback allocations, arbitrary compression
formats, camera input, or browser resource bounds. Checksum changes are not
authentication tests. The total-count corpus is deterministic enumeration,
not random or coverage-guided fuzzing.

A negative control removes only the total-count upper guard in a disposable
source copy, runs this file, then restores and verifies the original bytes.
Its expected failure establishes that the count test detects that weakened
guard. The normal focused/full suites must pass with the guard restored.
