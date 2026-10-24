# AirGap QR Transfer Process

## Purpose

AirGap QR supports two transfer paths. Optical QR sends a folder through the
sender's screen and receiver's camera without networking between them. WebRTC
file transfer sends data over a shared local network without an internet service.
Both computers run the bundled app locally; neither mode uploads files to a
cloud service. Choose the mode allowed for the devices and data involved.

Use the application only for data you are authorized to move. A QR stream is a
data-transfer channel and may still be restricted by an organization's policy.

## Wi-Fi / WebRTC quick start

1. Before going offline, install the required Node.js version and a supported
   Chromium browser on each laptop. Copy the same complete app bundle to both.
2. On each laptop, double-click **Start AirGap QR.cmd** in the bundle folder.
   It checks the bundle and opens the local app in your default browser. Keep
   the launcher open; press Enter in that window to stop it after the transfer.
3. Connect both laptops to the same authorized local Wi-Fi network or hotspot,
   with peer-to-peer connections allowed. Internet access is not required.
4. Choose **Send** on the sending laptop and **Receive** on the other. Wait for
   the device check. On the sender, **Choose files** or **Choose folder**, then
   **Get pairing code**. On the receiver, enter that code and **Connect to sender**.
5. Compare the separate device verification code on both screens. Choose
   **Codes match** on each only if every group agrees; otherwise choose
   **Codes do not match** and reconnect. Repeat this comparison after reconnecting.
6. Leave the source unchanged during transfer. After the receiver verifies the
   stream, choose **Choose destination and save**. Wait for **Transfer complete**;
   received temporary data is not yet your saved destination copy.

The sender displays its pairing code before checking the file bytes. Connect
and compare device codes while checking continues; files wait for both completed
checking and confirmation on both laptops. A connection failure or **Stop and
reconnect** keeps pending checking and prepared snapshots. **New transfer**
discards that work. A reload during initial checking requires selecting the
source again because its recovery checkpoint is saved only after checking.

The local device check runs before selection and again before reading source
bytes for preparation or recovery. A failed check leaves the selection available
for retry. It checks this laptop’s service, not the remote laptop or firewall.

If launching says the application is already open or its local address is in
use, check for the terminal running your existing copy. Use that copy or stop it
with Ctrl+C before launching again. The failed launch does not stop the existing
runtime. Keep using the same local URL when resuming: browser storage belongs
to that origin.

If automatic pairing fails, open **Troubleshoot connection** on both screens. Enter the sender's displayed address
and port for the shared network, together with its six-digit code. Guest-network
peer isolation and firewall rules can prevent communication; manual addressing
does not bypass those restrictions. The displayed sender address includes its
automatically selected port. The app tries four signaling ports when one is busy;
normal use does not require setting an environment variable. If all are
unavailable, close other copies and retry the device check.

After interruption, use **Retry connection** on the sender and **Reconnect and
resume** on the receiver. After reloading the sender, **Recover saved source**
reopens and rehashes the source; allow read access if prompted. If unavailable,
select the same unchanged source again. Confirm the new device code on both.
After a save failure, keep the partial destination unchanged and retry saving
there: the app verifies reusable files before completing the tree. Do not clear
browser site data if you want to retain receive progress.

Choose **Other transfer methods → Offline QR / Air-gap mode** on the home
screen for the optical QR engines described below. See README.md for
storage limits, supported behavior and more detailed Wi-Fi recovery notes.

## Choose the transfer engine

Large QRF3 is the default and is the only suitable engine when a transfer must
stay bounded-memory at gigabyte scale. It requires a current Chromium browser
with:

- the File System Access directory picker;
- Origin Private File System (OPFS);
- dedicated workers and synchronous OPFS access handles;
- Web Locks; and
- IndexedDB.

Classic QRF2 is retained for small, ZIP-compatible transfers. It holds the ZIP
and received chunks in memory and caps source data at 25 MB. Its download
fallback cannot verify a folder after manual extraction.

## What QRF3 preserves

QRF3 preserves the root folder name, safe relative paths, nested and empty
directories, filename capitalization, supported Unicode names, zero-byte
files, and every file byte. It treats file contents as raw bytes, so text line
endings, image encodings, documents, archives, and executables are unchanged
when their hashes verify.

It does not preserve timestamps, permissions, ownership, ACLs, symlinks,
hard-link identity, extended attributes, alternate data streams, or other
platform-specific metadata. Unsafe, ambiguous, or silently normalized paths
are rejected.

## Install and run

Patched Node.js `^22.23.4`, `^24.22.1`, or `^26.12.1` is required on the connected development
machine that builds the app.

```powershell
npm ci
npm run build
```

Alternatively, run `npm run package:offline` to create a complete test bundle in
`artifacts/`. Copy the generated folder to each computer and run
`node scripts/verify-release.mjs` inside it before launching. This checks copy
integrity, not publisher authenticity or release readiness. Node and the browser
are not bundled. `npm run test:package` builds and smoke-tests a staged bundle
outside the repository; it does not replace the physical two-laptop tests.

For manual staging, copy the complete `dist/` and `scripts/` directories as sibling paths to each offline computer,
then run:

```powershell
node scripts/serve.mjs
```

Open `http://127.0.0.1:4173`. Do not open `dist/index.html` with `file://`;
camera, worker, storage, and directory APIs require loopback or HTTPS. The
production bundle needs Node.js to serve files but does not need `node_modules`
or registry access.

## QRF3 sender process

### 1. Select and prepare the source

1. Choose **Large QRF3** and **Send**.
2. Click **Browse folder** and select the source root.
3. Review the discovered file, directory, and byte counts.
4. Start preparation.

The sender enumerates the tree, validates portable paths, opens immutable file
snapshots, and hashes each file in 4 MiB slices. It builds a canonical virtual
stream made from file bytes, canonical tree metadata, and a fixed footer. It
does not create a whole-tree ZIP or load the tree into memory.

The sender refuses a plan whose block count exceeds the receiver's exact block
store limit. Source changes detected during preparation or reload restoration
also fail closed.

### 2. Complete the connection test

The sender first loops a randomized, fixed 4 KiB QRF3 connection-test stream.
The probe contains the exact Files transfer ID, manifest identity, stream
SHA-256, connection ID, length, block size, and root name. No real file block is
displayed before the receiver verifies this complete probe.

The receiver displays a grouped ten-character receipt such as:

```text
7K3PM-82QHY
```

Enter it on the sender. A stale, incomplete, changed, or mistyped receipt does
not unlock Files frames. If probe display was stopped, **Resume probe** restarts
the same prepared probe; it does not silently strand the handshake.

### 3. Broadcast Files

After the receipt passes, start the Files stream. The sender shows each block
lazily from the prepared snapshots. Manifest frames recur periodically, and
each pass uses a deterministic, pass-specific permutation so a periodic camera
miss is unlikely to erase the same block on every pass.

Pause and resume retain the same plan. Stopping display does not discard it.
The sender's frame counter distinguishes manifest frames from payload progress.

### 4. Sender reload recovery

The sender stores the selected directory handle and exact random transfer
identities in IndexedDB. On reload it asks for read permission, re-enumerates and
re-hashes the tree, and rebuilds the byte-identical probe and Files plans with
the original IDs and creation times. A changed source is rejected instead of
creating a different stream under a saved identity.

The source bytes are not copied into IndexedDB. Use the sender's discard control
after verified completion to remove its saved handle and metadata.

## QRF3 receiver process

### 1. Receive and verify the probe

1. Choose **Large QRF3** and **Receive**.
2. Select the intended camera.
3. Start the connection test and allow camera access.
4. Keep the complete QR and its white border inside the scan guide.

Before opening a block store, the receiver requires the canonical connection
test purpose, root name, and exact 4 KiB length. This prevents an arbitrary QR
from reserving a large OPFS transfer while the receiver is awaiting a probe.

Every accepted frame passes routing, CRC-32, payload length, and per-block
SHA-256 checks. After all probe blocks arrive, the camera is stopped before the
receiver reads and verifies the whole stream. The exact verified probe is saved
to IndexedDB before its receipt is shown.

### 2. Receive the bound Files stream

After entering the receipt on the sender, continue to Files capture. The
receiver accepts only the exact connection ID, transfer ID, manifest identity,
stream SHA-256, length, block size, and root name committed by the probe.

Each unique block is written directly at its final offset in OPFS by a dedicated
worker. Payload data is flushed before a checksummed receipt-journal record is
flushed, so a crash can require retransmission but cannot mark unwritten bytes
as received. The worker holds one exclusive Web Lock for that exact store until
close or deletion, preventing two tabs from corrupting its payload and journal.

Repeated and out-of-order blocks are safe. The in-memory progress update is a
small scalar summary; a large receipt bitset is not cloned for every camera
frame.

### 3. Pause, reload, and cleanup

Pausing, switching engines, hiding the receiver, or unmounting it stops and
destroys the scanner, drains pending writes, closes the store, and releases its
lock. On resume, the next repeated Files manifest reopens the same store and
continues from its durable receipt bits.

After a page reload, the receiver re-verifies the saved probe and restores the
exact Files binding. Already received OPFS blocks remain available. If the last
block arrived before reload, seeing the repeated manifest is sufficient to
detect the complete store and continue verification.

**Discard stored data** is available before, during, and after capture. It stops
active work, clears the verified binding, and deletes all app-owned QRF3 block
stores, including an orphan left before any manifest was retained by the UI.

### 4. Whole-stream and metadata verification

When all receipt bits are present, camera production stops before hashing. Only
one whole-stream verification can run for that completion event; queued
duplicate callbacks cannot trigger repeated multi-gigabyte reads.

The complete QRF3 virtual stream SHA-256 is authoritative. If it fails, the
receiver deletes the poisoned store so a self-consistent malicious or incorrect
block cannot remain permanently marked as a duplicate. Reacquisition starts
from a clean store.

Tree metadata can be up to 32 MiB and is read incrementally in chunks no larger
than the block store's range limit. Canonical parsing validates entry counts,
paths, sizes, offsets, per-file hashes, and the exact stream layout.

### 5. Reconstruct and verify the destination

1. Choose **Choose destination and verify**.
2. Select the parent beneath which the source root should be created.
3. Wait for the second on-disk verification to finish.

The root may be absent, empty, or contain a matching AirGap QR partial marker
for this exact transfer. An unrelated non-empty root is refused without
modification. A matching interrupted reconstruction re-hashes journaled files,
reuses exact matches, and repairs missing or mismatching app-owned targets.

All destination mutations from this origin use one exclusive Web Lock. File
System handles have no stable cross-tab string identity, so an origin-wide lock
is the safe boundary. External programs cannot participate in that lock; do not
edit the chosen destination concurrently.

Switching modes or unmounting while reconstruction runs aborts it. The partial
marker remains, making a later retry recoverable. Success requires:

1. the exact expected file and directory path/type sets;
2. every destination file reopened and SHA-256 checked;
3. no missing, extra, changed, or normalized path; and
4. removal of the partial marker followed by one final enumeration.

After destination verification, the receiver deletes the source block store and
saved connection binding.

## Practical limits

The default payload is 700 bytes at 6 frames per second. Ideal payload rate is
4.2 KB/s; real throughput is commonly 2.5–3.5 KB/s after missed and repeated
frames. One GiB therefore needs about 71 hours even at the ideal rate and often
several days in practice. QRF3 makes a very large optical transfer durable and
bounded-memory; it cannot make the physical QR channel fast.

QRF3 permits at most 256,000,000 blocks (about 167 GiB at 700 bytes), 100,000
tree entries, and 32 MiB of canonical tree metadata. Quota checks count only the
remaining payload allocation plus bounded metadata when reopening a partial
store, rather than requiring the full transfer's free space again.

## Independent verification

Compare the original and reconstructed trees without reading whole files into
memory:

```powershell
node scripts/compare-trees.mjs `
  "C:\Path\To\Original Folder" `
  "D:\Received\Original Folder"
```

The command exits non-zero for missing or extra paths, a file/directory type
mismatch, or any file SHA-256 mismatch.

## Troubleshooting

### Camera will not start

- Use `http://127.0.0.1` or HTTPS in a current Chromium browser.
- Allow camera access in site and operating-system settings.
- Close another program that owns the camera.
- Select a different physical camera in the receiver.

### Progress is not increasing

- Keep the entire QR and white border visible.
- Increase sender-screen brightness and avoid glare.
- Stabilize both devices and clean the camera lens.
- Reduce sender FPS to 4 or 3.
- Pause and resume; durable unique blocks are retained.

### Storage or busy-store error

- Free browser storage or choose a browser profile with sufficient quota.
- Close another tab receiving the same transfer, then resume.
- Avoid private-browsing modes that disable durable storage.
- Use **Discard stored data** if the saved transfer is no longer wanted.

### Destination is rejected

Choose a different empty parent unless the existing root contains the matching
AirGap QR partial marker. The app intentionally refuses unrelated non-empty
folders and markers from a different transfer.

## Security boundary

CRC-32 provides fast damage detection. Per-block SHA-256 commitments validate
each frame's routed contents, and whole-stream plus per-file SHA-256 checks are
the final integrity gates. The probe receipt binds the one-way Files stream to a
successfully observed camera path.

QRF2 and QRF3 do not encrypt the content or authenticate the human displaying
it. Keep the sender's display and receiver's camera under physical control for
the duration of the transfer.
