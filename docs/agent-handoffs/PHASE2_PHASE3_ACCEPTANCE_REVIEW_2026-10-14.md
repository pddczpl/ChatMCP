# Phase 2 / Phase 3 acceptance evidence review — 2026-10-14

## Sources and provenance

- [Antigravity Windows acceptance report](PHASE2_PHASE3_ACCEPTANCE_REPORT.md) was provided by the project owner and preserved without altering its historical verdict. It claims execution on Windows 11 Pro build 26300, Node 24.19.0, Git 2.55.0.windows.1 and .NET SDK 10.0.103.
- **Tested source:** Phase 3 commit `8be970e888cf1e5a3eaa99c349b1b9ba4af8176a`. Phase 2 upstream commit `b54c0ee12f127bea367acc38c9b2d970069648d1`.
- The independent GitHub review verified both PR #15 and PR #16 at those SHAs had successful PR workflow matrices (9/9 each) and successful source-only workflows. **CI is not equivalent to executing the Windows Sandbox hardware acceptance matrix.**
- The Windows report states 72/72 Hub suites, 46/46 UI unit tests, 42/42 installer-payload regressions and targeted Phase 2/3 regressions all exited 0. These are **owner-supplied results**, not independently observed workstation logs. The original shell output, exit-code transcripts, raw JSON benchmark reports and Windows environment fingerprints were not provided in this attachment.
- The transcript preceding the final report included a transient Antigravity API 503 during a worktree test; the final report records exit 0. Without original terminal logs, this review cannot independently establish the retry/continuation sequence.

## Scope clarification: Phase 1 G4 and G6

- [PR #13](https://github.com/pddczpl/ChatMCP/pull/13) records **G4 PASS only for the approved `node-json-blackbox` native public-case grader** using `system-sealed-exit-v1`. The independently reviewed [scoped G4 decision](G4-BLACKBOX-REVIEW-2026-10-13.md) documents 24 checks on 17 owned Windows guests.
- The [G4/G6 execution record](G4-G6-EXECUTION-2026-10-13.md) records **G6 PASS for the exact identified installer built from `acc2f840dfd7c1b279d2c58c2bc5d1294ffcfc43`**, on its specified clean Windows 11 guest. Those binaries have their own SHA-256 identities.
- The original Antigravity report's blanket phrasing *"G4 BLOCKED"* therefore describes an older gate state, **not the final scoped Phase 1 acceptance**. Conversely, it is not evidence for arbitrary legacy `node --test` outcome attestation, the old HMAC publisher, other platforms, or a newly packaged Phase 3 installer.
- The shipping `WindowsSandboxPublisher({hostAttested:false, attestedCheckKinds:[BLACKBOX_KIND]})` is intentional. Do not broaden it to `hostAttested:true`. Issue #14 documents historical HMAC leakage and remains distinct from the scoped native-grader approval.
- Phase 2's SHA-256 recovery journal is a local consistency/tamper-detection aid **without authenticated integrity against a party able to rewrite the local files**. It does not attest test results or justify automatic replay.

## Acceptance interpretation

**Phase 2:** Functional/contract PASS *as reported* for recovery journal, corruption quarantine, restart acknowledgement, constrained context preview and offline benchmarks. Independent PR CI: PASS at the tested Phase 2 SHA.

**Phase 3:** Functional/contract PASS *as reported* for declared DAG scheduling, pinned Git inheritance (including A -> no-op B -> C), parallelism/cancellation, conflicts and checkout preservation. Independent PR CI: PASS at the tested Phase 3 SHA.

**Production release:** NOT AUTHORIZED BY THIS REVIEW. The native Windows report and existing scoped Phase 1 evidence establish meaningful progress, but release additionally needs explicit scope and artifact-specific approval.

## Remaining evidence and decisions before release

1. Preserve original Windows commands, stdout/stderr, process exit codes, raw JSON benchmark and crash/restart evidence, and a host/toolchain identity inventory. Remove secrets and personal identifiers. The uploaded narrative is not a substitute for those logs.
2. Decide whether Phase 3's documented manual conflict resolution, independent worker/subtree rollback, persisted DAG receipts and real-model quality benchmarks are required for this release. If required, implement and independently test them; otherwise explicitly defer with rationale rather than silently calling them complete.
3. Review the exact integrated Windows installer/Sandbox artifact identity when built from the final release candidate; do not claim that Phase 1's `acc2f840` installer tests automatically certify a different packaged binary.
4. Complete independent PR review, maintain restricted security scope, obtain owner approval, integrate PR #12 -> #13 -> #15 -> #16 in order, verify final merged-main CI and artifact identity, and only then consider tag/release.
5. Recheck CI after the documentation commits that preserve this evidence. **The code tested by Antigravity remains anchored to `8be970e`; a new docs-only HEAD is not itself the Windows-tested SHA.**

**Current decision:** Keep PRs Draft; no merge into `main`, no tag, no release, and no blanket security enablement.
