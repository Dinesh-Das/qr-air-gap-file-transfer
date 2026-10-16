# Refreshed dependency security evidence

Status: **NOT READY**. This supplement refreshes the retained September 19 audit
against the current October 16 lockfile. It changes no application inputs,
dependencies, packages or requirement statuses.

Node 24.22.0 and npm 11.6.2 ran `npm audit --package-lock-only --ignore-scripts
--json --no-fund --no-update-notifier --registry=https://registry.npmjs.org` at
the project root. Exit code: 0. The response reports zero vulnerabilities at every
severity, covering the lockfile's development and optional dependency records as
well as production dependencies. The lockfile SHA-256 is
`1941b668b0e20e0d3ac46b4ec10637626b65325bd97eb2ef2605635fa0ac8fa5`.

The same runtime and npm CLI ran `npm audit signatures --ignore-scripts --no-fund
--no-update-notifier --registry=https://registry.npmjs.org` in the existing fresh
installation. Exit code: 0. npm reports 145 verified registry signatures and 61
verified attestations. Every installed dependency's version, resolved URL and
integrity metadata match the current lockfile. The lockfile contains 169 package
records; all 24 absent records are optional packages. They are not represented by
the 145 signature checks. Missing optional packages and absent attestations are
not evidence of malicious dependencies.

The signature command verifies registry metadata for discovered packages. It does
not independently hash installed files or establish that a package is benign.
The advisory result is a dated registry observation, not proof that no unknown
vulnerability exists. No install, dependency script, upgrade or remediation ran.

All 173 current inputs and five built assets remain unchanged in both the root
and fresh stage. The earlier 520-unit-test and 92-per-browser gates retain their
recorded scope and were not rerun. The canonical pairing-recovery evidence and
native-destination supplement remain unchanged. Real two-laptop testing, native
GUI/picker behavior, large-file resource acceptance and the historical 5 GiB
memory peak remain open. All 42 physical cases are still not run.

Raw audit responses, logs, exit codes and command records use the `npm-audit-` and
`npm-signatures-` October 16 prefixes. The independent verification and final
index are `dependency-security-independent-verification-2026-10-16.json` and
`dependency-security-final-hashes-2026-10-16.json` in this directory.
