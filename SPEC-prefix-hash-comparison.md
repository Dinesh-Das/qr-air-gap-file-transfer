# Shared-prefix hashing experiment

CPU profiles of the current DON1UPCZ5GiB native-file UI case identify substantial
SHA-256 compression in preparation and sender block encoding. This candidate
changes only preparation: while the stream has no file bytes, its incremental
state also hashes the current file. Clone that state before finalizing the file
digest, then extend the independent stream state with later files and metadata.
Leading empty files remain valid. Hash values, protocol, source/abort checks,
4MiB reads and bounded memory remain unchanged. No sender encoding change.

Eight independent Node SHA vectors cover empty trees/files,63/64/65-byte SHA
boundaries, leading/trailing empty files and a4MiB read boundary. The regression
budget counts actual source bytes fed to incremental SHA: at most twice total
source bytes minus the first nonempty file, plus the trailer. All file hashes
and canonical full-stream hashes must still match independent Node crypto.

The explicit `prefix_comparison` dispatch input runs after the full candidate
release gate. It excludes the ordinary single native job and runs exactly one
baseline203c64d case followed by one candidate case on the same standard Windows
runner. Both use identical locked dependencies, Node binary and Chromium runtime,
fresh deterministic fully written5GiB source files, fresh browser profiles, real
production UI/rendezvous/RTC and injected OPFS destination pickers. Both retain
10ms main-page CPU profiling and all existing integrity/ACK/native-PID guards.

Each case keeps its30-minute guard,18,673,041,408-byte three-copy preflight,
2GiB reserve and400MiB margin. The new70-minute *paired job* accommodates two
existing cases plus installation/upload; no individual case deadline increases.
There is no smaller fallback or retry. Baseline failure stops the pair. Both
payload sets stay on the runner until teardown; each independent byte/hash audit
must finish before then. Only metadata, profiles and compiled assets are uploaded.

Candidate expected asset hashes are labelled pending qualification and old DON
qualification is retained separately. Exact asset checks remain mandatory. A
comparable pair requires matching source bytes, Node binary, browser versions,
full size, valid CPU capture, every selected PID, original plans and disk reserve.
Raw metadata is preserved on failure too. Source mtime/stream metadata hashes can
differ between fresh fixtures; the file byte hash and size must be identical.

Compare absolute sampled preparation weights per5GiB, with idle/program/GC
retained and inclusive overlap explained. One baseline-first pair has order and
runtime variance limitations. It cannot establish statistical speed acceptance,
physical Wi-Fi throughput,10/50/100GB resource bounds, native OS picker/permission
behavior or READY. Full release requirements and real two-laptop validation stay.
