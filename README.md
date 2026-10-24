# AirGap QR

AirGap QR is a local-only web application with two transfer paths. QR transfer
moves the complete folder through animated QR codes. Offline WebRTC pairs the
devices with a short-lived six-digit code, exchanges connection details between
the two local Node runtimes on the LAN, then moves encrypted blocks directly over
an existing local Wi-Fi network or hotspot without STUN, TURN, cloud upload, or
internet service. Large QRF3 streams file slices directly
from the sender's disk and received blocks directly into the receiver's private
browser filesystem; Classic QRF2 remains available for small, ZIP-compatible
transfers.

The app never treats “all frames seen” as success. Completion requires:

- an exact match between the expected and written relative-file path sets;
- a SHA-256 match for every written file; and
- a SHA-256 match for the complete QRF3 virtual stream or QRF2 ZIP.

Use this only for data you are authorized to move. A QR channel is still a data
transfer channel and may be restricted by an employer’s data-handling policy.

## Run locally

Patched Node.js `^22.23.4`, `^24.22.1`, or `^26.12.1` is required.
These floors include the 21 October 2026 security fixes. Other release lines
require review before use. The app never downloads a runtime automatically.

```sh
npm install
npm run dev
```

Open the printed `http://127.0.0.1` address. `localhost` is important: browser
camera and directory APIs are unavailable when the built files are opened
directly with `file://`.

Build the fully bundled production copy on a connected development machine:

```sh
npm ci
npm run build
```

For a complete offline test bundle, run `npm run package:offline`. It builds and
stages a new folder under `artifacts/` with the app, runtime modules, instructions,
and SHA-256 inventory. Copy that entire folder to each laptop. From that folder,
double-click **Start AirGap QR.cmd**. The launcher checks the runtime and bundle
contents, starts the local app and opens the default browser. Keep its window
open; press Enter there to stop. Use a supported Chromium browser for transfers.
For command-line use, run `node scripts/verify-release.mjs`, then
`node scripts/serve.mjs`.
The verifier rejects missing, extra, or changed files. Checksums detect copy
errors; they do not authenticate the publisher. Node and a supported browser
must already be installed. Packaging does not declare the release READY.

An optional Windows x64 bundle can include Node.js 24.22.1 or a newer 24.x patch. On the Windows build
machine, obtain the official versioned `node.exe` and complete matching `LICENSE`
in a trusted directory. Independently verify the binary SHA-256 against Node's
official release checksums, then run after building:

```powershell
node scripts/package-offline.mjs "artifacts/portable bundle" --runtime-dir "D:\trusted-node-runtime" --runtime-sha256 <verified-lowercase-sha256>
```

This option copies the runtime, full license notices and recorded hashes into the
package. The launcher prefers the bundled executable; recipients need a supported
Chromium browser but do not need to install Node. The default package still uses
Node on PATH. Packaging never downloads or installs software. A supplied hash is
not publisher authentication. Qualify the chosen runtime and complete the physical
release tests before distribution; a packaging pass does not establish READY.

Then stage the same `dist/` directory and `scripts/` directory on each computer,
keeping those paths as siblings, and run:

```sh
node scripts/serve.mjs
```

The runtime needs Node.js but does not need `node_modules` or registry access.
During Wi-Fi sending, an unpaused wait for acknowledgments or channel buffer
drainage fails after two minutes without a wake-up. Reconnect to resume from
the receiver's durable receipts. Explicit pause suspends this timer. This is
not a time limit on hashing, destination saving, or final verification.
Duplicate or empty acknowledgments do not restart the wait deadline.
Keep the complete `scripts/` directory: the server imports the rendezvous and
HTTP security modules. The application server accepts loopback clients with matching
Host and Origin values; signaling mutations require same-origin JSON requests.
Request size, duration, concurrency, and temporary signaling state are bounded.
LAN discovery uses each IPv4 adapter's actual subnet broadcast address, with
duplicate targets removed and at most 32 targets per announcement. It does not
scan individual hosts. Networks that block broadcasts may prevent automatic
pairing. In that case, open **Troubleshoot connection** on the sender and **Use sender
address** on the receiver. Copy one displayed address (including its port) and
enter the six-digit code. This uses TCP directly without UDP discovery. With
multiple adapters, try the address on the network shared by both laptops.
All browser assets are included in `dist`; after loading from loopback, the app
makes no internet requests. The local runtime automatically tries ports
`4174`–`4177` until both UDP discovery and TCP signaling can bind to one port.
Discovery checks these four service ports on loopback and actual adapter subnet
broadcasts; it does not enumerate hosts. Peers can select different ports. The
separate LAN endpoint requires a claimed room token bound to the peer address
and session; it serves no application assets and rejects browser-origin requests.
Signaling itself is not encrypted. Both users must still compare and confirm the
device verification code before file data can flow. Allow both UDP and TCP on the
selected LAN pairing port through the firewall. The sender’s **Troubleshoot
connection** panel shows its actual address and selected port. If all four ports
are unavailable, close other copies of the app and retry the device check.
Open `http://127.0.0.1:4173` on each device, then choose **Send** on the source
computer and **Receive** on the destination computer. The app URL stays stable
so browser recovery data remains accessible.

For advanced testing, `QRFT_SIGNAL_PORT` explicitly pins a single port and disables
automatic fallback. Both devices need the same override for automatic discovery;
a copied sender address with its port can connect directly instead.

## Offline WebRTC workflow

**Current speed** uses a one-second window of safely received bytes;
**Recent speed** smooths that progress over five seconds. Both exclude blocks
reused from a previous attempt. **Transfer ETA** uses the smoother rate and
covers payload transfer only; verification and destination saving take additional
time. Pausing clears both speeds and ETA, and a stalled connection's readings
decay instead of retaining an old rate.
If sampling stops for longer than a speed window, that estimate restarts from
the next observation; speed and ETA wait for fresh samples instead of averaging
across the unobserved gap. Both screens show transferred / total
bytes, remaining bytes and resumed bytes. **Elapsed this attempt** starts when
transfer progress becomes available, includes pauses and received-data checks,
and stops after transfer verification or failure. It resets on a new connection
attempt and does not include file preparation, earlier attempts or destination saving.

When an attempt stops, its last byte counts and elapsed time remain visible and
are explicitly marked **not verified**. Reconnect to discover which stored data
can actually be reused. A filled progress bar alone is not successful verification.
Pause and retry controls sit above the detailed metrics; on narrow screens the
transfer status appears before source information. The pairing code is hidden
once pairing is finished.

Recovery messages describe the next action. **Error details** retains the original
diagnostic, collapsed by default, without using peer-supplied error text as
instructions. Pairing-code failures, unavailable local service, permission errors,
changed sources, storage quotas and duplicate tabs have specific advice. Saving
and temporary-storage cleanup failures remain distinct from transfer verification.

Preflight requires the browser's SHA-256 cryptography API before enabling source
selection or connection. The large optical receiver uses the same storage
capability check before camera enumeration or access. Missing support produces
an actionable browser message before storage opens; it never starts a large
in-memory fallback.

Before pairing, the receiver displays estimated temporary browser space and
whether storage is persistent. **Refresh storage check** updates the estimate.
Unknown or failed queries are shown explicitly. The estimate is not a reservation
and does not describe the final destination disk; the receiver checks the actual
transfer's remaining payload and receipt metadata requirements after pairing.

Use **Choose folder** for a directory tree or **Choose files** for one or more
individual files. Individual selections retain their basenames inside a
**Selected files** destination folder. Duplicate or case-conflicting basenames
are rejected rather than renamed. Both selection types support handle-based
reload recovery with a full source recheck.
You can also drop files or folders into the idle Wi-Fi sender. A single folder
keeps its root name; files use **Selected files**; mixed items or multiple folders
use **Selected items** and retain their top-level names. Drops are ignored once
a source is selected or work is active. Browsers without dropped-handle support
show guidance to use the pickers instead.

Offline WebRTC is the practical path for large folders when both authorized
devices may join the same offline local network. It is not an air gap. The app
uses `RTCPeerConnection({ iceServers: [] })`, so candidates are limited to the
local environment; globally routable and non-host candidates are removed before
they are shared. Each device's loopback Node runtime performs a short-lived,
LAN-only rendezvous for signaling. File data never passes through that runtime;
the reliable ordered data channel is encrypted by WebRTC.

Before file selection, the app checks its required browser APIs and asks the
local service to bind both signaling transports. It repeats the service check
before hashing or recovering a saved source and before connecting. A failed
check does not read source bytes or discard the selected/prepared source; use
**Retry connection check**, **Retry connection**, or **Retry source recovery**
as shown. Permission prompts still run from a user action. A successful local
check does not prove firewall permissions or reachability of the other laptop.
The receiver also reports estimated temporary storage and persistence status;
that estimate neither reserves space nor measures the final destination disk.

1. Connect both devices to the same authorized Wi-Fi network or to a hotspot.
   Internet access is not required. Local peer isolation must be disabled.
2. Open the app locally on both devices. Choose **Send** on the sending laptop
   and **Receive** on the receiving laptop. Optical modes remain available under
   **Other transfer methods → Offline QR / Air-gap mode**.
3. Wait for the device check, then **Choose files** or **Choose folder** and
   **Get pairing code**. The app displays a random six-digit code, then checks
   the files in the background using the same bounded-memory virtual tree as
   QRF3. You can connect and compare device codes while checking continues.
   The manifest and file bytes wait for completed checking and both confirmations.
4. On the receiver, enter that six-digit code and choose **Connect to sender**.
   The local runtimes discover each other on the LAN and exchange only the
   WebRTC offer and answer. The room expires quickly and is single-use.
5. Compare the **device verification code** on both laptops, then choose
   **Codes match** on each. This separate value has four groups of letters and
   numbers and binds the exact connection descriptions and session. If any
   group differs, choose **Codes do not match** and reconnect. No file manifest
   or payload is accepted before both confirmations. Both laptops must use the
   same current application build; legacy automatic confirmations are rejected.
6. The receiver opens durable OPFS storage and reports already received block
   ranges. The sender transmits only missing 60 KiB blocks, applies data-channel
   backpressure, and counts a block only after the receiver durably writes and
   acknowledges it. The receiver groups up to 64 blocks per durable commit,
   with a 75 ms deadline for a smaller group, and acknowledges committed groups.
7. If the connection is interrupted, choose **Retry connection** on the sender
   and **Reconnect and resume** on the receiver. While the sender tab remains
   open, pending file checking continues and prepared source snapshots are
   retained without reselection or another hash pass. **Stop and reconnect**
   also keeps this work; **New transfer** discards it. Confirm the new device
   verification code again. Its deterministic
   manifest identity reopens the partial receive and resumes missing blocks.
   A checkpoint is saved after checking finishes. If you reload during initial
   checking, select the source again. After a sender reload, choose
   **Recover saved source** to reopen the saved
   folder handle. Allow read access if prompted. Recovery re-enumerates and
   rehashes every file and rejects changed bytes or metadata; then pair again.
   Only handles and transfer identities are saved, never source bytes or device
   authorization. Up to 16 checkpoints are retained for seven days. Use
   **Discard saved source** to remove one. If saving is unavailable, the sender
   displays that limitation and you can reselect the folder after reload.
8. Completion requires a SHA-256 match for the complete virtual stream. The
   receiver then reconstructs the folder, verifies each destination file, and
   reclaims its temporary browser payload after a successful save.
   A destination error retains the verified temporary copy for another save
   attempt. A corrupt complete receive is discarded and must be retransmitted.

### Automated release checks

On the development/CI machine, run `npm ci`, then
`npx playwright install chromium`, then `npm run check:release`. This first audits
the full dependency lockfile (including development tools), then checks
TypeScript, the unit/integration suites, the production build, and browser
workflows. Browser tests use real WebRTC and OPFS with controlled local signaling
and synthetic source selection. They also reconstruct a destination inside OPFS
and independently hash its final file. They do not prove two-laptop LAN discovery,
physical destination-picker behavior, or large-file throughput. See
`RELEASE-HARDENING.md` for the outstanding release evidence.

Use a regular browser window for multi-gigabyte work. A private Chromium test
context lost a receipt-journal record near 1.8 GB despite reporting sufficient
quota; the application detected the mismatch and failed closed. A 5 GiB normal
profile fixture passed verification. This does not establish production release
readiness; benchmark commands, raw results and limitations are in `BENCHMARKS.md`.
Use a regular window for sender reload recovery too. The normal-profile handle
round-trip test passed; a private-context test closed unexpectedly while loading
the saved OPFS handle. Private-window recovery is not validated.

While a handshake or transfer is active, the app locks its method and
sender/receiver switches to prevent an accidental click from closing the peer.
Use the explicit stop button if you need to end or reconnect a transfer. During
active Wi-Fi work, the app requests a screen wake lock and displays whether it
was granted. It releases the lock on stop/completion and requests it again when
the tab becomes visible. If unavailable, keep the laptop awake manually; the
notice offers a retry. Keep both tabs open. A screen wake lock does not prevent
lid-close or forced operating-system sleep.

Browser or operating-system firewalls can block local peer traffic. WebRTC will
not work across client-isolated guest Wi-Fi, unrelated subnets without local
routing, policies that block the local UDP or TCP pairing port, or policies that disable
host candidates. In those cases, use the
existing QR transfer path or an organization-approved transfer method.

## QR transfer workflow

Large QRF3 is the default. Use a current Chromium browser on both sides, because
large mode requires the directory picker and Origin Private File System. The
sender never creates an in-memory ZIP: it hashes files in 4 MiB slices, records
a canonical tree manifest, and encodes 700-byte blocks only when displayed.
The receiver writes integrity-checked blocks at their final offsets, checkpoints a
compact receipt bitset, verifies the complete virtual stream, then reconstructs
and re-hashes every destination file in bounded chunks.

1. On the sender, choose a folder. The app scans and hashes it locally, but
   keeps every real file frame locked.
2. Start the connection test. The sender first loops a randomized 4 KB dummy
   file that is cryptographically bound to that exact prepared folder transfer.
3. On the receiver, allow camera access and align the QR inside the guide. The
   receiver reconstructs the fixed probe stream and verifies its complete SHA-256.
4. Enter the receiver's ten-character receipt on the sender. Only a receipt
   derived from the fully received dummy unlocks the already-prepared file
   frames; a stale or mistyped receipt does not start the transfer.
5. Leave both devices still while unique-block progress increases. The sender
   shows ideal-pass and active elapsed-time estimates; the receiver shows
   rolling unique-byte speed and an estimated completion time.
6. When the complete archive hash passes, choose a destination parent. A
   matching interrupted AirGap QR write can resume; unrelated non-empty folders
   are refused, and only paths journaled as app-created can be repaired.
7. The receiver writes every file, enumerates the result, and re-hashes every
   destination file before reporting success.
8. Stop the sender only after the receiver reports verified completion.

The receipt is the return path for this otherwise one-way optical channel. It
proves that the dummy reached a receiver and binds both sides to one fresh
128-bit session, transfer ID, archive hash, and canonical Files manifest. It
does not authenticate the person operating the other computer.

Large QRF3 requires Chromium's directory picker, OPFS, dedicated workers, Web
Locks, and IndexedDB. Classic QRF2 can instead offer a verified ZIP download in
browsers without the File System Access API, but the app cannot verify files
after the user manually extracts that ZIP.

Classic QRF2's compatibility file-input picker preserves every exposed file
path and byte, but browsers do not expose empty directories through that API.
Large QRF3 always uses the Chromium directory picker.

## Practical limits

WebRTC throughput depends on the devices, browser, storage, and local network.
Its 60 KiB binary blocks and bounded 96-block acknowledgement window are meant
for gigabyte-scale transfer without retaining the source or destination in
JavaScript memory. The receiver's OPFS quota must cover the virtual stream until
the verified destination write completes.

Large QRF3 is bounded-memory but the optical channel is still slow. At the
default 700-byte payload and 6 frames per second, one GiB needs roughly 71 hours
even at the ideal 4.2 KB/s payload rate, and longer after camera misses and
manifest repeats. The large-transfer work makes multi-gigabyte transfers
durable and recoverable; it cannot make a QR camera channel physically fast.

Large QRF3 caps the disk receipt map at 256 million blocks, about 167 GiB with
700-byte blocks. Browser quota must cover the not-yet-received stream bytes plus
bounded checkpoint metadata. The app accounts for an existing partial store on
resume and asks for persistent origin storage where supported.

Every QRF3 pass is a deterministic full permutation. Later passes traverse
blocks differently, so periodic camera misses do not repeatedly erase the same
positions. Frames and source ranges are generated lazily; neither side builds
an array proportional to transfer size.

The default is a 700-byte payload at 6 frames per second. Real throughput is
typically about 2.5–3.5 KB/s after missed frames and repeated manifests. A 1 MB
folder can take 5–7 minutes. Multi-gigabyte transfers are storage-safe and
resumable, but their QR-only transmission time is measured in days or weeks.

Classic QRF2 holds its ZIP and received chunks in memory and therefore caps v2
source data at 25 MB. QRF3 retains file handles and bounded read buffers on the
sender; the receiver keeps payload in OPFS and only its receipt map in memory.

QRF3 receipt bits and payload are durable in OPFS. Its receiver stores the exact
verified 4 KiB probe in IndexedDB before showing the receipt, so a reload can
restore the Files binding and reopen the same block store. Its sender stores a
directory handle plus exact transfer identities, then re-enumerates and
re-hashes the source before rebuilding the byte-identical probe and Files plans.
It does not duplicate the source tree into browser storage. Discard controls on
both sides remove these records and partial payloads.

Classic QRF2 checkpoints encoded frames and the verified dummy proof in
IndexedDB. Its sender resume record includes the prepared source ZIP, so Classic
records can consume roughly the transfer size in browser storage.

QRF3 canonical tree metadata is capped at 100,000 entries and 32 MiB, and is
read in bounded chunks. Classic QRF2 crash-safe direct reconstruction is capped
at 4,000 logical entries; larger Classic trees use its ZIP-download fallback.
All same-origin destination writes are serialized by one browser Web Lock,
because File System handles expose no stable cross-tab lock identity. Programs
outside the browser cannot be locked, so avoid editing the destination while it
is being reconstructed.

## Protocol v2

Each QR contains an RFC 9285 Base45 string. Decoding it yields a 23-byte header
followed by a payload:

| Field | Bytes |
| --- | ---: |
| `QRF2` magic | 4 |
| frame type | 1 |
| transfer ID, little-endian | 4 |
| chunk index, little-endian | 4 |
| total chunks, little-endian | 4 |
| payload length, little-endian | 2 |
| complete-frame CRC-32, little-endian | 4 |

The CRC is calculated over the complete header and payload with the CRC field
temporarily zeroed, so a damaged transfer ID, chunk index, count, type, or
payload is rejected before accumulation. The final ZIP SHA-256 remains the
authoritative integrity gate.

The manifest carries the ZIP byte length, ZIP SHA-256, chunk size, creation time,
transfer purpose (connection test or files), 128-bit connection ID, and UTF-8
root folder name. The dummy binds the SHA-256 of the canonical prepared Files
manifest frame, so metadata substitutions are rejected too. The manifest
appears at the beginning and after each ten data frames. Data frames may arrive
out of order and repeats are deduplicated. Conflicting payloads for one index
cause only that slot to be discarded and reacquired.

Version 2 is intentionally distinct from the old unversioned `QRFT` stream.
Legacy v1 frames cannot satisfy the connection gate and are rejected.

## Protocol v3

QRF3 uses a distinct integrity-checked frame format with 64-bit transfer lengths
and offsets, 128-bit transfer and connection IDs, a SHA-256 manifest identity,
a per-block SHA-256 commitment over routing metadata and payload, and CRC-32 for
fast rejection. The whole virtual stream SHA-256 remains the completion gate.

The virtual stream contains canonical-order raw file bytes followed by a
canonical JSON tree manifest and fixed footer. The manifest records safe
relative paths, sizes, per-file SHA-256 values, and directories including empty
ones. Destination completion still requires exact path/type sets and a second
incremental SHA-256 readback of every file.

## Verification

Run the automated suite:

```sh
npm test
npm run typecheck
npm run build
```

Create the specification fixture and compare any reconstructed tree:

```sh
node scripts/create-fixture.mjs
node scripts/compare-trees.mjs .tmp/qrft-fixture-source <received-folder>
```

Fixture creation requires a new folder directly under `.tmp` whose name starts
with `qrft-fixture`. It refuses existing folders and redirected staging paths.
For another run, supply a new name, for example
`node scripts/create-fixture.mjs .tmp/qrft-fixture-second`.

Compare distinct source and received directories while neither is being edited.
The comparator includes empty files and directories, rejects link/junction roots
and self-comparison, and fails on unsupported entries instead of ignoring them.
It reads files incrementally and rejects observed changes in byte count, size,
file identity or modification/change times during hashing. It does not create
a filesystem snapshot or detect every possible concurrent edit.

For separate laptops, record an independent inventory on the sender before
transferring (keep the manifest outside the selected source folder):

```sh
node scripts/compare-trees.mjs --record <source-folder> <new-source-manifest.json>
```

Preserve the printed manifest SHA-256 in your test record. Copy that manifest to
the receiving laptop, then run:

```sh
node scripts/compare-trees.mjs --manifest <source-manifest.json> <received-folder>
```

Check that the printed manifest SHA-256 matches the sender's test record. The
manifest is not signed; replacing both it and the expected fingerprint defeats
this check. Verification compares the exact file/directory paths, file lengths,
and every SHA-256, including empty files and directories. It does not require
the sender's source directory to be accessible from the receiving laptop.

The comparator exits non-zero for a missing or extra file/directory path, a
file/directory type mismatch, or any file SHA-256 mismatch.

## Scope

File paths, empty directories available through the Chromium directory picker,
and file bytes are preserved. Timestamps, permissions, ACLs, extended
attributes, alternate data streams, symlinks, and hard-link identity are outside
v2’s scope. Unsupported or ambiguous destination names are rejected rather than
silently renamed.

SHA-256, CRC checks, the QRF2 HMAC receipt, and the domain-separated QRF3 digest
receipt prove that a received transfer is internally consistent and bound to
the tested optical session; they do not authenticate who displayed it. Neither
protocol is encrypted or sender-authenticated, so keep the receiver’s camera
and sender’s screen under your control for the duration of the transfer.
