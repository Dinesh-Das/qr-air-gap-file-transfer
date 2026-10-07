# Preserve traced renderer-crash validation

The release suite deliberately crashes a renderer while saving and receiving
to check recovery from durable data. Keep those cases, their assertions and
trace recording enabled.

Playwright 1.63 can assert when a successful CDP command reply arrives after a
renderer crash has cleared its pending callback. The upstream fix is included
in 1.64, so upgrade the development dependency and its lockfile. Do not patch
installed dependency files or suppress assertion failures in the test harness.

Sources inspected on 2026-10-14:

- [Playwright issue 42949](https://github.com/microsoft/playwright/issues/42949)
- [Merged fix 42936](https://github.com/microsoft/playwright/pull/42936)
- [Published release 1.64.0](https://github.com/microsoft/playwright/releases/tag/v1.64.0)

Validation must distinguish these scopes:

1. A controlled call of the exact installed CRSession response handler proves
   the dependency branch before/after: a reply after crash is accepted in 1.64;
   an unexpected reply on an active session still asserts, and a known callback
   resolves normally. This is not a browser transport reproduction.
2. App-free static and animated crash diagnostics, including screenshot traces
   and concurrent crashes, exercise the real browser. Passing runs do not
   diagnose the first app-suite assertion.
3. Full unchanged Edge and Chrome suites check compatibility and retain the
   real WebRTC, OPFS and recovery assertions. No test is skipped or weakened.
4. The original first Chrome failure has no stack or protocol log to prove its
   precise cause. The upstream race is a plausible explanation, not a proven
   diagnosis of that event. Preserve its failure trace and this qualification.

Application code, protocol, built assets and standalone bundle files should be
unchanged by this development dependency upgrade. Physical acceptance, final
clean-install/hosted CI proof, large-transfer resources and the earlier Edge
asset buffer error remain separate obligations.
