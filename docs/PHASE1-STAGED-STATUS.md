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

1. Resolve the remaining PR #12 P0 privileged-token, native lifecycle and authenticated guest receipt-publication findings.
2. Integrate a trusted Windows CLI supervisor publication mechanism with the backend driver, verify OS token and filesystem permission boundary, implement durable cancellation reconciliation.
3. Join the coding worker's check ID/grant broker to model tool catalog **without enabling host shell or role escalation**.
4. Prove an actual disposable coding-worker cycle changes a failed test into a passing test through the Windows isolated broker.
5. Verify that final code hash matches independently recognized test evidence, and rejected test-definition changes cannot masquerade as success.
6. Real Windows supported-machine install/upgrade/uninstall, WebView2 E2E, malicious project and cancellation/restart evidence.
7. Run all GitHub-hosted CI jobs and dedicated real Windows gate on exact final SHA; review and sign off before merge/tag.

All unverified capabilities must be reported as blocked. No release, no merge, no live model API spending is authorized by this source change.
