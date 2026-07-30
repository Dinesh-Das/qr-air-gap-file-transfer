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

1. On the sender, choose a folder and review its size and time estimate.
2. Start the QR stream and maximize the QR on the source screen.
3. On the receiver, allow camera access and align the QR inside the guide.
4. Leave both devices still while unique-chunk progress increases.
5. When the complete archive hash passes, choose an empty destination parent.
6. The receiver creates the original root folder, writes every file, enumerates
   the result, and re-hashes every file before reporting success.
7. Stop the sender manually after the receiver reports verified completion.

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
therefore caps v1 transfers at 25 MB of source data.

## Protocol v1

Each QR contains an RFC 9285 Base45 string. Decoding it yields a 23-byte header
followed by a payload:

| Field | Bytes |
| --- | ---: |
| `QRFT` magic | 4 |
| frame type | 1 |
| transfer ID, little-endian | 4 |
| chunk index, little-endian | 4 |
| total chunks, little-endian | 4 |
| payload length, little-endian | 2 |
| payload CRC-32, little-endian | 4 |

The manifest carries the ZIP byte length, ZIP SHA-256, chunk size, creation time,
and UTF-8 root folder name. It appears at the beginning and after each ten data
frames. Data frames may arrive out of order and repeats are deduplicated.

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
v1’s scope. Unsupported or ambiguous destination names are rejected rather than
silently renamed.

SHA-256 and CRC checks prove that a received transfer is internally consistent;
they do not authenticate who displayed it. Version 1 is not encrypted or
sender-authenticated, so keep the receiver’s camera and sender’s screen under
your control for the duration of the transfer.
