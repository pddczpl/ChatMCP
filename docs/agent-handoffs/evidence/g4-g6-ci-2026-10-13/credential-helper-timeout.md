# Read-only CI diagnosis: acc2f840

The failed push job is `Hub tests (windows-latest, Node 22)`, job
115398818823 in run 38426980802. Its only failed suite was
`verify-e2e-isolation.mjs`: 40,054 ms, HTTP 400 while persisting the fixture API
key, message `Windows chưa thể bảo vệ API key.` The runner completed with
65/66 suites passing, zero suite timeouts and zero skips.

This exact message is generated only by `lib/secret-box.mjs:29`, when its
30,000 ms PowerShell DPAPI helper deadline expires. Spawn failure, DPAPI script
failure and oversized output have different errors. This is therefore an
observed helper timeout, not evidence of a cryptographic mismatch or an
assertion being bypassed. `GatewayProvider.configure` waits for encryption
before persisting configuration/key data and propagates the error.

Comparison evidence on the same commit:

- Equivalent PR Windows Node 22.23.3 job 115398856226 passed isolation in
  12.7 s and all 66 suites.
- Push Windows Node 24.21.0 passed isolation in 12.1 s and all 66 suites.
- The failed Windows Node 22 job subsequently passed
  `verify-model-adapters.mjs` in 2.624 s. On Windows that suite performs real
  DPAPI protect/unprotect, provider persistence and provider reload. These are
  four helper invocations, not a mock DPAPI adapter.
- No changes to `secret-box.mjs`, `Protect-ApiKey.ps1`, or the isolation suite
  exist between the earlier DPAPI change 9b52569 and acc2f840. That earlier
  change added ExecutionPolicy Bypass and changed the deadline from 20 to 30 s.

Assessment: the evidence supports an intermittent helper/runner stall and
does not demonstrate a reproducible deterministic defect from G4/G6 changes.
It does not identify the exact source of the stall: the helper intentionally
drains stderr, and the suite runner records only its failure tail rather than
PowerShell startup/DPAPI operation timing. Do not assert that antivirus, DPAPI,
or host scheduling has specifically been proved responsible.

Recommendation: one rerun of only the failed job on the unchanged commit is
justified. Preserve the first failure, retain the full assertions and 30 s
deadline, and record both attempts. If it repeats, investigate secret-safe
helper stage timing instead of repeatedly rerunning or weakening the suite.
No rerun, Sandbox execution, or source modification was performed by this
diagnosis.

Local evidence:

- `.tmp/g4-g6-acc2-ci-windows-node22-full.log`
- `.tmp/g4-g6-acc2-ci-pr-node22-full.log`
- `.tmp/g4-g6-acc2-ci-push-node24-full.log`
- `.tmp/g4-g6-acc2-push-node22-artifact/summary.json`
- `.tmp/g4-g6-acc2-ci-push.json`
- `.tmp/g4-g6-acc2-ci-pr.json`

## Authorized single rerun

After the diagnosis, root explicitly authorized one rerun of only job
115398818823 on unchanged acc2f840. The resulting attempt 2 completed
successfully: 9/9 jobs are successful, and rerun Windows Node 22 job
115403996945 reported 66 pass, zero fail, zero timeout, zero skip. Isolation
passed in 20.6 s; the real DPAPI model-adapter suite passed in 2.3 s. The
watcher exited normally, and no further rerun was requested.

The initial failed JSON and log remain intact. Separate rerun evidence:

- `.tmp/g4-g6-acc2-ci-push-rerun.json`
- `.tmp/g4-g6-acc2-ci-push-rerun-node22-full.log`

This supports the intermittent-helper-timeout assessment; it does not identify
the low-level cause of the original stall or erase the observed first failure.
