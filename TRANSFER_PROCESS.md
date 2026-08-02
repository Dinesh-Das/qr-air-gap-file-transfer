# AirGap QR Transfer Process

## Purpose

AirGap QR transfers a folder from one computer to another using only:

- the sender computer's screen;
- the receiver computer's camera; and
- a locally running web browser on each computer.

It does not use a network connection between the two computers, cloud storage,
email, USB storage, or a shared filesystem during the transfer.

Use this application only for files you are authorized to move. A QR stream is
still a data-transfer channel and may be restricted by an organization's
security or data-handling policy.

## What is preserved

AirGap QR reads files as raw bytes. It does not decode, convert, resize, or
re-encode their contents.

The following are preserved:

- the root folder name;
- relative folder and file paths;
- nested folders;
- filenames with spaces and supported Unicode characters;
- filename capitalization;
- zero-byte files;
- files with identical contents but different names;
- text encodings and line endings;
- binary file contents;
- images such as PNG, JPEG, GIF, and WebP;
- PDFs, office documents, archives, executables, and other file types.

If an image passes verification, its encoded file bytes are identical to the
source. Therefore, its pixels and embedded data are unchanged.

## Verification guarantee

The application does not assume that a transfer succeeded merely because all QR
frames were observed.

The sender verifies that:

1. Every selected file was read as raw bytes.
2. The source tree was packaged into a ZIP archive.
3. The ZIP could be extracted safely.
4. The extracted path set matched the selected source path set.
5. Every extracted file SHA-256 matched the selected source bytes.

The receiver verifies that:

1. Every accepted QR frame passed its CRC-32 check.
2. Every expected chunk was received.
3. The reconstructed ZIP length matched the sender manifest.
4. The complete reconstructed ZIP SHA-256 matched the sender manifest.
5. The archive contained only safe, supported paths.
6. The destination path set exactly matched the expected path set.
7. Every destination file was reopened from disk.
8. Every reopened destination file SHA-256 matched the expected file bytes.

The receiver reports **Transfer complete** only after all final checks pass.

## Requirements

### Recommended browsers

Use a current Chromium-based browser:

- Google Chrome
- Microsoft Edge
- Opera

Chromium is recommended because its File System Access API allows the receiver
to write and verify the reconstructed folder directly.

Firefox and Safari can receive a verified ZIP download, but the application
cannot verify files after the user manually extracts that ZIP.

### Software

- Node.js `^20.19`, `^22.12`, or `>=24`
- The AirGap QR project on both computers
- A camera connected to the receiver
- A display on the sender

### Practical transfer limits

- Maximum source size: 25 MB
- Maximum reconstructed archive size: 32 MB
- Default QR payload: 700 bytes per frame
- Default transmission rate: 6 frames per second
- Typical effective speed: approximately 2.5–3.5 KB/s

Approximate transfer times:

| Folder size | Typical duration |
| ---: | ---: |
| 100 KB | 30–60 seconds |
| 500 KB | 2–4 minutes |
| 1 MB | 5–7 minutes |
| 5 MB | 25–35 minutes |
| 10 MB | 50–70 minutes |

Actual speed depends on the camera, display, lighting, distance, and frame rate.

## Install the application

The application must already be available on both computers before starting the
optical transfer.

Clone the repository on each computer:

```powershell
git clone https://github.com/Dinesh-Das/qr-air-gap-file-transfer.git
cd qr-air-gap-file-transfer
```

Install and build:

```powershell
npm install
npm run build
```

Start the local production server:

```powershell
npm run serve
```

Open this address in Chrome or Edge:

```text
http://127.0.0.1:4173
```

Do not open `dist/index.html` directly with `file://`. Camera and directory
permissions require the application to run through localhost or HTTPS.

After the production build is prepared, the browser application uses only
loopback and locally bundled assets. It does not upload transfer data.

## Sender process

Perform these steps on the computer containing the source folder.

### 1. Open Sender mode

1. Open `http://127.0.0.1:4173`.
2. Select **Sender** at the top of the page.

### 2. Select the source folder

1. Click **Browse folder**.
2. Select the complete folder to transfer.
3. Wait while the browser reads the folder.
4. Review the displayed information:

   - root folder name;
   - number of files;
   - number of detected folders;
   - total source size; and
   - estimated transfer time.

The primary Chromium directory picker includes empty directories. A
compatibility file-input picker preserves exposed files and their paths but
cannot detect empty directories.

### 3. Review transfer settings

Use the defaults for the first attempt:

| Setting | Default | Purpose |
| --- | ---: | --- |
| Chunk size | 700 bytes | Raw payload carried by each data frame |
| Frame rate | 6 FPS | Number of QR frames displayed each second |
| QR recovery | Medium | QR error-correction level |

If the receiver struggles to decode frames, reduce the frame rate before
changing the chunk size.

### 4. Prepare the transfer and test the connection

1. Start the transfer setup.
2. Wait while the application creates and verifies the real ZIP locally.
3. Confirm that the sender says it is broadcasting the connection test, not the
   selected folder.
4. Maximize the browser window and increase the display brightness.

The sender first loops a randomized 4 KB dummy file. Its manifest uses the same
version 2 framing, full-frame CRC, archive SHA-256, and chunk reconstruction as a
real transfer. The dummy also commits to the already-prepared real transfer's
fresh 128-bit connection ID, transfer ID, archive SHA-256, and canonical
manifest-frame SHA-256.

No real file QR is displayed during this phase.

### 5. Confirm the receiver receipt

After the receiver verifies the complete dummy file, it displays a grouped
ten-character receipt such as:

```text
7K3PM-82QHY
```

Enter that receipt on the sender. The receipt is derived from every dummy byte
and the exact real transfer binding. A stale, changed, incomplete, or mistyped
receipt does not unlock the real frames.

When the receipt passes, the sender switches to the same prepared real transfer;
it does not rebuild or change its transfer ID. The QR sequence then repeats
continuously until the receiver finishes.

The sender displays:

- connection state;
- current frame and broadcast pass;
- optical payload speed;
- current-pass time remaining; and
- elapsed active time.

The sender cannot know the receiver's live capture progress after the initial
manual receipt because the main channel remains one-way. Its remaining-time
value is therefore explicitly the current broadcast pass, not receiver ETA.

Pause and resume reuse the same prepared frames and transfer ID. When IndexedDB
is available, the sender saves the source ZIP, dummy, IDs, and exact preparation
metadata locally; after a page reload it rebuilds the byte-identical stream in
a stopped state. Saved streams have separate identities and revision-checked
updates, preventing a stale sender tab from overwriting or deleting another
tab's newer stream. Discard the sender session after verified completion to
remove that locally stored source data.

## Receiver process

Perform these steps on the destination computer.

### 1. Open Receiver mode

1. Open `http://127.0.0.1:4173`.
2. Select **Receiver** at the top of the page.

### 2. Start the camera and receive the dummy

1. Click **Start camera**.
2. Allow camera access when prompted.
3. Point the camera at the sender's display.
4. Place the entire QR code inside the visible scan guide.
5. Ensure the QR code's white border is visible.
6. Keep both devices steady.

Camera frames are processed locally in the receiver's browser. Before pairing,
the receiver accepts only connection-test manifests. Real file manifests cannot
pin or start the receiver at this stage.

When every dummy chunk and the dummy archive SHA-256 pass, the receiver validates
the exact dummy-file name, size, internal content hash, connection ID, probe ID,
bound real transfer ID, and bound real archive hash. It then displays the manual
receipt for the sender. The bound manifest hash also protects the root name,
chunk layout, creation time, purpose, and every other prepared manifest field.

### 3. Start and monitor the bound file transfer

After the sender accepts the receipt, keep the camera on the sender's real QR
stream. The receiver now accepts only a Files manifest whose connection ID,
transfer ID, and archive SHA-256 exactly match the verified dummy binding.
The complete canonical manifest frame must match as well.

The receiver displays:

- unique chunks received;
- expected chunk count;
- completion percentage;
- valid payload bytes;
- rolling unique-byte capture speed;
- remaining valid payload bytes;
- estimated time remaining;
- elapsed time;
- durable-checkpoint status; and
- source folder name after receiving a manifest.

Repeated frames are ignored. Out-of-order frames are accepted. Unreadable,
unrelated, malformed, or corrupted QR codes are discarded.

If the receiver begins scanning partway through a sender loop, it waits for the
next repeated manifest and then continues normally.

Accepted version 2 manifest and data frames are stored locally in IndexedDB.
The complete verified dummy proof is stored before its receipt is displayed, so
a reload between receipt entry and the first Files frame can restore the exact
connection. Pause, a Sender/Receiver mode switch, or a receiver page reload can
offer a saved transfer to resume. The dummy proof and any restored frames are
re-verified through the version 2 integrity and session gates, and the complete
ZIP SHA-256 is still required before any output is released. Use **Discard
checkpoint** to remove saved QR payloads when they are no longer needed.

### 4. Wait for archive verification

When all chunks have been captured, the receiver reconstructs the ZIP and
calculates its SHA-256.

If the SHA-256 does not match, the receiver clears the invalid pass and
continues scanning later loop repetitions. It does not release corrupted files.

When the complete ZIP passes, the receiver displays:

```text
Archive hash verified
```

This confirms optical transmission integrity. The final destination write and
on-disk verification still remain.

### 5. Choose the destination

1. Click **Choose destination & verify**.
2. Select the parent directory where the root folder should be created.

For example, if the source root is:

```text
Project Data
```

and the selected destination parent is:

```text
D:\Received
```

the receiver creates:

```text
D:\Received\Project Data
```

The destination root folder must either:

- not exist; or
- exist and be completely empty; or
- contain a matching AirGap QR partial-write checkpoint for this exact transfer.

For a matching interrupted write, the receiver re-reads and hashes every
existing file, skips exact matches, and repairs missing or mismatching
app-owned targets. A versioned marker binds the partial folder to the root name,
canonical path set, and per-file hashes. Unrelated or mismatched non-empty
folders are refused without modification.

Direct crash-safe reconstruction is limited to 4,000 logical files and folders
so checkpoint journal I/O remains bounded. Larger verified trees use the ZIP
fallback. A browser Web Lock serializes destination writes from this app's tabs,
but the File System Access API cannot lock external programs; do not edit the
chosen destination concurrently.

### 6. Wait for final verification

After writing, the receiver:

1. Enumerates the destination again.
2. Reopens every file from disk.
3. Recalculates every file SHA-256.
4. Compares the complete expected and actual path sets.
5. Checks explicitly captured directories.
6. Reports any missing, extra, changed, or normalized path.
7. Removes the partial-write marker only after verification, then enumerates and
   verifies the finalized tree once more.

Success is shown as:

```text
Transfer complete
Verification passed
```

Only after seeing this message should the user stop the sender's QR stream.

## Independent verification

For an additional command-line check, compare the original and received trees:

```powershell
node scripts/compare-trees.mjs `
  "C:\Path\To\Original Folder" `
  "D:\Received\Original Folder"
```

A successful result resembles:

```text
Verification passed: 128 files, 10 directories; exact path set and every file SHA-256 match.
```

The command exits with a failure if it finds:

- a missing file or directory;
- an extra file or directory;
- a file/directory type mismatch; or
- any file SHA-256 mismatch.

## Troubleshooting

### Camera permission denied

1. Open the browser's site-permission settings.
2. Allow camera access for `http://127.0.0.1:4173`.
3. Reload the page.
4. Select **Receiver** and click **Start camera** again.

### No camera detected

- Confirm the camera is connected.
- Close applications currently using the camera.
- Check the operating system's camera privacy settings.
- Restart the browser.

### Progress is not increasing

- Move the receiver closer to the sender.
- Ensure the entire QR code is visible.
- Increase sender screen brightness.
- Avoid glare and reflections.
- Clean the camera lens.
- Keep both devices still.
- Reduce the sender frame rate from 6 FPS to 4 FPS or 3 FPS.
- Pause and resume the camera if necessary.

Received chunks remain in memory when the receiver camera is paused and, when
IndexedDB is available, accepted encoded frames are checkpointed for reload
recovery. If storage quota or private-browsing policy disables persistence, the
UI reports that resume is memory-only.

### Transfer is extremely slow

- Use a stable camera mount or stand.
- Keep the QR code large on the sender's display.
- Reduce movement and changing ambient light.
- Use the default 700-byte chunk size.
- Do not use this method for large media folders.

### Destination folder is rejected

The requested root folder contains unrelated files, a damaged checkpoint, or a
checkpoint from a different transfer. Choose a different empty parent directory
unless the UI identifies it as the matching interrupted AirGap QR write.

The application refuses unrelated non-empty destination trees. A matching
app-owned partial tree is repaired and fully reverified.

### ZIP fallback appears

The receiver browser does not support direct folder writing, or the verified
tree exceeds the 4,000-entry crash-safe reconstruction limit.

The downloaded ZIP has passed complete-transfer SHA-256 verification, but the
application cannot verify the manually extracted destination tree. For complete
on-disk verification, use Chrome or Edge and select **Choose destination &
verify**.

## Supported content

File extensions do not affect correctness because files are handled as raw
bytes. Examples include:

- `.txt`, `.md`, `.json`, `.xml`, `.csv`
- source code and configuration files
- `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`
- `.pdf`
- `.docx`, `.xlsx`, `.pptx`
- `.zip`, `.7z`, `.gz`
- `.exe`, `.dll`, `.bin`
- audio and video files within the practical size limit
- files with no extension

Already compressed formats are stored in the ZIP without unnecessary
recompression where possible.

## Out of scope

Version 2 does not preserve:

- filesystem timestamps;
- file permissions;
- ownership;
- ACLs;
- symbolic links;
- hard-link identity;
- extended attributes;
- alternate data streams; or
- operating-system-specific metadata.

Version 2 is also not encrypted or sender-authenticated. CRC-32 and SHA-256 prove
integrity and internal consistency, not the identity of the person displaying
the QR stream. Keep the sender's display and receiver's camera under physical
control throughout the transfer.
