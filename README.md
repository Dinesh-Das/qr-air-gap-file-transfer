# AirGap QR

AirGap QR is a local-only web application that moves a small folder between two
computers through an animated sequence of QR codes. The sender displays the
sequence; the receiver watches it with a camera, reconstructs the ZIP, verifies
its SHA-256, writes the original tree, and then re-reads every destination file.

The app never treats “all frames seen” as success. Completion requires:

- an exact match between the expected and written relative-file path sets;
- a SHA-256 match for every written file; and
- a SHA-256 match for the complete transferred ZIP.

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

1. On the sender, choose a folder. The app packages and hashes it locally, but
   keeps every real file frame locked.
2. Start the connection test. The sender first loops a randomized 4 KB dummy
   file that is cryptographically bound to that exact prepared folder transfer.
3. On the receiver, allow camera access and align the QR inside the guide. The
   receiver reconstructs the dummy ZIP and verifies its complete SHA-256.
4. Enter the receiver's ten-character receipt on the sender. Only a receipt
   derived from the fully received dummy unlocks the already-prepared file
   frames; a stale or mistyped receipt does not start the transfer.
5. Leave both devices still while unique-chunk progress increases. The sender
   shows its optical payload rate and current-pass time remaining; the receiver
   shows rolling unique-byte speed and an estimated completion time.
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

Chromium browsers can write and verify the folder directly. Browsers without the
File System Access API receive a verified ZIP download, but the app cannot verify
files after the user manually extracts that ZIP.

The sender’s compatibility file-input picker preserves every exposed file path
and byte, but browsers do not expose empty directories through that API. The
Chromium directory picker is required when empty-directory fidelity matters.

## Practical limits

The default is a 700-byte payload at 6 frames per second. Real throughput is
typically about 2.5–3.5 KB/s after missed frames and repeated manifests. A 1 MB
folder can take 5–7 minutes. This is intended for documents, code, configuration,
and small images—not large media or multi-gigabyte folders.

The browser holds source files, the ZIP, and received chunks in memory. The UI
therefore caps v2 transfers at 25 MB of source data.

Receiver checkpoints are stored locally in IndexedDB so a camera pause, mode
switch, or page reload can resume integrity-checked frames. The verified dummy
proof is checkpointed before its receipt is shown, so reloading before the first
real file frame does not lose the connection binding. The sender also stores the
exact source ZIP, dummy, connection IDs, and prepared-transfer metadata locally,
allowing the identical stream to be rebuilt after a reload. Sender records use
per-stream identities and conditional updates so a stale tab cannot overwrite
or delete another tab's newer state. These records can consume roughly the
transfer size in browser storage and may contain sensitive source data; discard
them from the corresponding UI when no longer needed.

Crash-safe direct folder reconstruction is capped at 4,000 logical files and
folders so the per-file ownership journal remains bounded. Larger verified
trees use the ZIP-download fallback. Same-origin destination writes are
serialized with a browser Web Lock; programs outside the browser cannot be
atomically locked by the File System Access API, so avoid editing the chosen
destination concurrently.

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

SHA-256, HMAC-based connection receipts, and CRC checks prove that a received
transfer is internally consistent and bound to the tested optical session; they
do not authenticate who displayed it. Version 2 is not encrypted or
sender-authenticated, so keep the receiver’s camera and sender’s screen under
your control for the duration of the transfer.
