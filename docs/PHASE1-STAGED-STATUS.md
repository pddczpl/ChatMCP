# Phase 1 — staged implementation status (2026-10-13)

This branch is a **work-in-progress implementation**, not Phase 1 security/release acceptance.

## Code areas added

- PR3-shaped: immutable private snapshots, Windows Sandbox CLI guest driver (untrusted export) and Windows Sandbox Backend lifecycle interface; default provider remains unavailable until real publisher authentication.
- PR4-shaped: check IDs, content-bound grant reservations, stale-definition rejection, execution facts distinct from test outcome.
- PR5-shaped: bounded Test → Diagnose → Repair → Retest workflow, 2 repair cycles/3 test attempts/20 minutes safety bound; refuses unverified success.
- PR6-shaped: capability attenuation and dynamic dependency-aware workers with bounded concurrent processes/depth, without ChatMCP token or spending budgets.
- PR7-shaped: React inspector shows recorded verification history separately from model self-reports.
- Registry wiring installs the production-shaped backend with an honest unavailable capability by default.

## Verification requirements before Phase 1 can be called complete

1. PR #12 commit 6f22d58 (token/Win32/HMAC prototype hardening) is already integrated. **Revalidate that OS security boundary against final PR #13 built binaries and current source SHA**; earlier guest test reports on PR #12 are not release acceptance for PR #13.
2. Integrate a trusted Windows CLI supervisor publication mechanism with the backend driver, verify OS token and filesystem permission boundary, implement durable cancellation reconciliation.
3. Join the coding worker's check ID/grant broker to model tool catalog **without enabling host shell or role escalation**.
4. Prove an actual disposable coding-worker cycle changes a failed test into a passing test through the Windows isolated broker.
5. Verify that final code hash matches independently recognized test evidence, and rejected test-definition changes cannot masquerade as success.
6. Real Windows supported-machine install/upgrade/uninstall, WebView2 E2E, malicious project and cancellation/restart evidence.
7. Run all GitHub-hosted CI jobs and dedicated real Windows gate on exact final SHA; review and sign off before merge/tag.

All unverified capabilities must be reported as blocked. No release, no merge, no live model API spending is authorized by this source change.

## Standalone desktop / API usage policy

The owner chooses Base URL, model and API key. ChatMCP has no artificial token/request/spend cap or shared monetary budget. Provider-side usage/billing is the owner's responsibility. Workers still obey host process concurrency, OS isolation, bounded test grants and explicit Full Access permission confirmation where selected. No integration with external IDEs (including VS Code) is required. User-selected Full Access is an existing host execution policy, not a way to silently bypass required OS isolation for automated worker checks.

- PR6 dynamic read-only subagents now have an explicit owner-approved Local Hub API and standalone desktop UI, use the configured model gateway, and maintain a durable interrupted state. Dynamic scheduling has no model token/monetary quota; concurrency is bounded for host stability.

### Native Windows acceptance task

The complete branch-specific [Antigravity acceptance task](agent-handoffs/ANTIGRAVITY_NEXT_TASK.md) covers actual integrated Windows guest verification, credential-safe BYO model settings, Full Access opt-in, clean-machine installer validation and test evidence. Source/mock or GitHub-hosted CI green alone is not OS isolation proof.


## Independent review after Antigravity report (2026-10-13)

Antigravity reported Windows 11 Pro build 26300, 25 prototype Windows Sandbox checkpoints, 62 Hub suites, 46 UI unit tests, 7 Playwright E2E tests, 42 installer payload checks, and successful build and WebView2 smoke at PR #13 SHA 310e9fe5. GitHub-hosted CI independently confirmed 9/9 push and 9/9 PR jobs on that old SHA. **The 25 checkpoints are not 25 unique negative security tests; the report alone is not independently captured low-level OS evidence.**

| Gate | Independent review status | Why |
| --- | --- | --- |
| G1 — Host readiness | PASS reported by Antigravity | Windows hardware preflight, no direct independent workstation access |
| G2 — Owned guest lifecycle | Prototype PASS reported; full stack NOT VERIFIED | Real guest fixture directly invokes wsb; worker E2E uses fake backend |
| G3 — Restricted child / Job Object | Prototype PASS reported; final integrated gate NOT VERIFIED | Need final-SHA token/ACL and supervisor key visibility probes |
| G4 — Authenticated publication | **FAIL: key disclosure confirmed** | HMAC secret remains in SYSTEM process argv; host fixture modifies receipt/recomputes SHA256; hostAttested:false correctly locks production |
| G5 — OS negative probes | Reported PASS for specified canary/network checks | Actual malicious restricted-child receipt forgery and key visibility still unverified |
| G6 — Tests and distribution | Source CI pass on OLD SHA; clean install NOT VERIFIED | Installer build, payload regression, WebView2 smoke != install/upgrade/uninstall |

PR #13 adds descriptor-bounded receipt reads and correct labels distinguishing HOST tampering from GUEST key isolation; final-SHA GitHub CI and real Windows OS tests are still required. **Do not merge or release.** Next actions: [ANTIGRAVITY_NEXT_TASK.md](agent-handoffs/ANTIGRAVITY_NEXT_TASK.md).


### Confirmed security failure at commit cc22baa (2026-10-13)

Antigravity's restricted child still used SYSTEM User SID S-1-5-18 after CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN). Its actual Windows Sandbox WMI probe read the supervisor's parent CommandLine, containing the 256-bit HMAC bearer key sent through wsb exec -c. **G4 is now FAIL, not merely unverified.** This is a **P0 Phase 1 defect** tracked at [Issue #14](https://github.com/pddczpl/ChatMCP/issues/14). It must be addressed before Phase 1 merges/releases; do not defer to Phase 2.

The script real-coding-e2e.mjs reports a genuine guest FAIL then scripted source repair then guest PASS using a test-scoped injected publisher. Because the key is exposed, that is evidence of **full-stack functional wiring**, not trustworthy production publisher authenticity. The script's prior cleanup attempted to stop every Sandbox returned by wsb list; GitHub corrected it to stop only positively owned UUIDs, with unknown instances left untouched and reported BLOCKED.

The real-guest hardware suite now treats Boolean WMI visibility of the bearer key as G4 FAIL with a nonzero acceptance exit and no key output, even when its remaining functional OS probes pass. This is an intentionally failing security gate until the token identity/key-channel defect is genuinely corrected. New Windows acceptance tasks: [Round 3 handoff](agent-handoffs/ANTIGRAVITY_NEXT_TASK.md). Production hostAttested:false remains mandatory.
