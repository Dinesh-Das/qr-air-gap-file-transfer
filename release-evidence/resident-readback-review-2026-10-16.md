# Additional Chrome readback measurement

Status: **NOT READY**. No application inputs, builds, packages, requirement
statuses or canonical release-checkpoint files changed.

The earlier Chrome readback trial remains failed overall because one requested
Windows utility process disappeared during measurement. The observer launches
PowerShell after obtaining Chrome's PID list. A native probe measured 304–428 ms
per spawned observation, compared with 105 ms for a resident observer's first
query and 6–8 ms for its next two queries. That delay provides a plausible window
for process retirement; it does not establish the exact cause of every gap.

A diagnostic-only resident helper reuses the existing Windows counter script
inside a private JSON-line protocol. It retains the same integer PID limits,
counter fields and strict missing-PID check. Its native probe reports a missing
PID, rejects four invalid requests, remains healthy afterward, and closes with
exit code zero. It does not omit utility processes or redefine an incomplete
sample as complete.

One additional trial used a fresh Chrome 155 profile and the unchanged production
destination API to verify the retained 5 GiB native File through read-only modeled
directory handles. There was no deliberate idle warmup, new large copy or forced
collection during the timed operation. OS filesystem-cache state was uncontrolled.

- Exact 5 GiB SHA-256 verification succeeded; no source bytes were requested and
  no destination files were written.
- All 63 process samples accounted for every PID requested from Chrome, with no
  missing IDs or observer errors. The resident observer closed normally.
- Reported page-memory peak: **11,626,577 bytes**.
- Sampled combined browser private-memory peak: **288,759,808 bytes**.
- Sampled main-page backing-storage peak: **5,455,950 bytes**.
- Median native request latency during hashing: **46.54 ms**; maximum: **160.75 ms**.

No UtilWin process appeared in this trial's observed process list. Consequently,
this successful measurement does **not** prove that the resident sampler alone
prevented the earlier loss, or that it is immune to future process churn. The
original exit-one report, its incomplete observer flag, and its hash index remain
unchanged. The new report adds a complete measurement of this separate trial.

One-second process sampling and 50 ms page sampling can miss transients. These
metrics cover different memory domains. This remains one readback trial with an
actual native File and modeled directory handles, not native destination-picker,
full-transfer, size-independent, 50–100 GiB or two-laptop resource acceptance.
The previous Edge readback measurement and application gates retain their scopes.

Independent verification confirms the original payload hash, all 174 inputs and
five assets in the root and dependency stage, all 840 canonical evidence rows and
the 114-file readback-fix index remain unchanged. The new browser profile was
preserved and hashed twice. All 42 physical cases are still not run.

The raw report is `resident-readback-5gib-2026-10-16.json`; independent checks and
the closed-profile inventory are in
`resident-readback-independent-verification-2026-10-16.json`. The supplemental
authority is `resident-readback-final-hashes-2026-10-16.json` in this directory.
The canonical application release checkpoint remains the readback-buffer fix.
