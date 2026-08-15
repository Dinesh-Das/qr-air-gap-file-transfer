# AirGap QR

AirGap QR is a local-only web application that moves a folder between two
computers through an animated sequence of QR codes. Large QRF3 mode streams
file slices directly from the sender's disk and received blocks directly into
the receiver's private browser filesystem; Classic QRF2 remains available for
small, ZIP-compatible transfers.

The app never treats “all frames seen” as success. Completion requires:

- an exact match between the expected and written relative-file path sets;
- a SHA-256 match for every written file; and
- a SHA-256 match for the complete QRF3 virtual stream or QRF2 ZIP.

Use this only for data you are authorized to move. A QR channel is still a data
transfer channel and may be restricted by an employer’s data-handling policy.

## Run locally

Node.js `^20.19`, `^22.12`, or `>=24` is required.

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

Then stage the same `dist/` directory and `scripts/serve.mjs` file on each
computer, keeping those paths as siblings, and run:

```sh
node scripts/serve.mjs
```

The runtime needs Node.js but does not need `node_modules` or registry access.
All browser assets are included in `dist`; after loading from loopback, the app
makes no external network requests. Open `http://127.0.0.1:4173`, choose
**Sender** on the source computer, and **Receiver** on the destination computer.

## Transfer workflow

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
