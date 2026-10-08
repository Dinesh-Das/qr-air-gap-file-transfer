# Physical test record — NOT RUN

No physical test has been performed. This record prepares evidence collection;
it does not replace the original release requirements or certify readiness.
The source template is `release-evidence/physical-test-record.json`; offline
bundles include it as `templates/physical-test-record.json`. Copy the template
to an evidence folder outside the bundle before recording results, preserving
the checksummed bundle files. The template contains 42 unrun cases:
14 scenarios for each of home Wi-Fi, hotspot and mixed Ethernet/Wi-Fi.

## Record the environment once per configuration

Record both laptop models, Windows builds, browser versions and normal/private
profile mode; source/destination filesystem and disk type; free space before and
after; Node version; the bundle CHECKSUMS.json SHA-256; source revision or file
fingerprint. Record network adapters, topology, signal conditions, relevant
firewall/peer-isolation settings and whether discovery or manual address was used.
Do not place passwords or Wi-Fi credentials in the record.

## Record each run

For each repetition, record actual bytes (state decimal MB/GB versus binary
MiB/GiB), file/directory/empty-file counts, start/end times, preparation time,
receive time, save/verification time, browser memory observations and their
measurement method. Keep the source unchanged. Save the exact error text,
recovery actions, observed reused/retransmitted progress and any required help.
Record failed attempts as failures; add a new repetition after fixes instead of
rewriting prior results. Use not-run, passed, failed or blocked for case status.

Baseline cases are single files of 1 MB, 100 MB, 1 GB and 10 GB, plus thousands
of files including empty files/directories, nesting and representative names.
Repeat representative trials to measure variability; record the number rather
than inferring performance from one run. No performance threshold is invented
here: compare observations with the original acceptance requirements.

Fault cases cover network loss/recovery, receiver refresh, sender restart,
sleep/wake, wrong and expired codes, nearly full destination, cancellation and
resume. Record the phase and progress at interruption. Run faults on designated
test data and test destinations. Wrong/expired-code cases must not authorize a
transfer. Recovery cases must finish with independently verified output; an
expected initial error alone is not a passing recovery result.

## Verify the actual destination independently

On the source laptop, from the bundle folder, substitute actual paths:

```powershell
node scripts/compare-trees.mjs --record "D:\TestSource\Tree" "D:\Evidence\source-inventory.json"
Get-FileHash -Algorithm SHA256 "D:\Evidence\source-inventory.json"
```

Store the inventory outside the source tree. Copy that inventory separately to
the receiver and compare its SHA-256 with the source record. Then verify the
actual received root folder, not its parent:

```powershell
node scripts/compare-trees.mjs --manifest "D:\Evidence\source-inventory.json" "D:\Received\Tree"
$comparisonExit = $LASTEXITCODE
```

Retain the command output and exit code for each run. A zero exit code with the
matching source inventory establishes that file hashes and the exact path/type
set matched at comparison time. The inventory is unsigned; its preserved hash
identifies which source inventory was used. It does not certify later changes.

## Observe a nontechnical user

Ask the tester to double-click Start AirGap QR.cmd in the copied bundle,
select files, pair, compare device
codes, save, and recover from one interruption using only the included guide.
Record task completion, time, mistakes, prompts requiring explanation and help
provided. Do not label an agent walkthrough as an independent usability test.

## Release decision

Attach logs/screenshots and independent comparison results to each completed
case. Leave unavailable cases not-run or blocked with a reason. Local browser
tests cannot fill these rows. Successful rows do not alone set releaseReady:
review every original requirement, all failures, final local/CI evidence and
physical results before declaring READY.
