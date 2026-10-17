# Native Windows destination reconstruction supplement

Status: **NOT READY**. No application, package, source inventory or requirement-ledger changes.

Two diagnostic tests passed, each containing six checks on a separate Windows drive
(C: and D:). They invoke the current production `writeLargeTreeToDirectory` through
a Node filesystem-handle adapter. Each small tree has 14 files, four directories,
and 354 payload bytes. The six legal Unicode name pairs from the earlier native
probe remain distinct, together with CJK/emoji names, an empty file and an empty
directory.

The checks cover fresh reconstruction; a completed retry with zero additional
writes; interruption after the first durable journal bit; repair of a same-size
changed journalled payload; refusal to change an unrelated non-empty folder; and
refusal to accept a native uppercase root alias. Interruption occurs between files,
not by killing a process during a filesystem commit.

The adapter uses actual filesystem reads, enumeration and staged rename-on-close
writes inside newly owned temporary roots. It is diagnostic code, not Chromium's
File System Access implementation. The existing-root case control independently
demonstrates native case aliasing; final independent readback compares exact names,
bytes and inventories. It verified 56 final payload files (1,416 bytes) across the
fresh and recovered trees on both drives. The fixtures remain available at the
absolute roots recorded in the report.

Both original and fresh-stage inventories remain unchanged: 173 inputs and five
built assets. All 737 prior canonical evidence entries were reverified. The prior
520-unit-test and 92-per-browser gates retain their recorded scope and were not
rerun for this diagnostic. The canonical pairing-recovery checkpoint and its hash
indexes remain unchanged; this report is a supplement.

This does not prove browser/native picker permissions, Web Locks, crash or
power-loss durability, large-file resource limits, LAN performance or two-laptop
acceptance. All 42 physical cases remain not run. No new production defect was
reproduced by these checks.

Evidence: `native-destination-2026-10-16.json`, its test log and source snapshots,
`native-destination-2026-10-16-independent-verification.json`, and the final
`native-destination-final-hashes-2026-10-16.json` index in this directory.
