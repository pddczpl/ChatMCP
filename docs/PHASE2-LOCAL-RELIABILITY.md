# Phase 2 — Reliable Autonomous Development (new local-only roadmap)

**Status:** SOURCE IMPLEMENTATION IN PROGRESS. Draft, not independently accepted; depends on Phase 1 trusted guest G4 and clean-machine release gates.

This is a NEW 2026 local Windows desktop phase. The historical docs/PHASE2-DESIGN.md and PHASE2-REPORT.md describe obsolete Render/Docker self-hosting and are NOT this work.

## Scope and boundaries

Phase 2 improves reliability of existing coding workers rather than reimplementing them:

- Durable run checkpoints with ordered event sequence and hash chain.
- Crash, stale lock and partial-write diagnosis with explicit human review before recovery; NEVER replay host tools, guest tests, Git operations or model actions automatically.
- Fresh verification evidence must remain bound to the actual immutable source and test definition; a model completion narrative never certifies a passing test.
- Honest interruption/progress history, bounded stored metadata, no prompt/API-key/tool-output logging in recovery checkpoints.
- Reproducible offline reliability regression and benchmarks to distinguish infrastructure failure, stale source, flaky checks and actual repair progress.

**Out of scope:** Changing Phase 1 Windows Sandbox publisher policy, bypassing host permissions, backend execution fallback, installing Windows features, merging without user confirmation, cloud hosting, IDE integration, and an app-side token/request/spending quota.

## Implemented code (first slice)

- CHATMCP-HUB/lib/coding-recovery-journal.mjs: per-run append-only, bounded, fail-closed journal (SHA-256 hash chaining for local consistency, NOT a cryptographic trust boundary), exclusive lock, bounded file payload and no token/prompt persistence.
- CHATMCP-HUB/lib/coding-orchestrator.mjs: real coding worktree checkpoints recorded before replacing jobs.json, plus recoveryStatus() read-only API. No automatic resume.
- CHATMCP-HUB/tests/verify-phase2-recovery.mjs: corruption, partial/stale lock, invalid/repeated worker identities, secret filtering, symlink escape, bounded capacity, and no automatic replay.

These features remain local to CodingWorktreeOrchestrator and intentionally do NOT authorize sandbox execution. Runtime permissions, worker cancellation and G4 remain unchanged.

## Acceptance requirements

1. Hub regression and native UI tests pass on the exact final source SHA, Linux and Windows Node 22/24. A new verify-* suite must not skip.
2. Crash at every checkpoint boundary leaves either a valid replay-forbidden journal or an explicit quarantined state. No tool/write/test is automatically replayed after restart.
3. A malformed/tampered/stale checkpoint cannot claim verified success. Recovery is observability and planning only, not authority or proof of test outcome.
4. A legitimate managed coding run creates ordered journal entries; runtime reload marks in-flight jobs interrupted; human owner reviews real Git files and fresh test receipts before any continuation.
5. No secrets, prompt injection, model responses or arbitrary raw tool results enter journal files. Existing workspace and unrelated user files remain untouched.
6. The release cannot proceed without Phase 1 G4 PASS, supported Windows installer lifecycle and final merged-main CI.

## Additional planned Phase 2 follow-up

- Explicit review-token- and content-hash-bound manual resumption for interrupted worktrees, without auto-repeat of uncertain Git operations.
- Bounded context acquisition via the existing CodeIntelligence index and targeted file citations, not app-imposed model call/token budgets.
- Reproducible project benchmarks for flaky/no-test/infrastructure failure and human override policy.
- User-visible recovery inspector and reason codes wired through the Hub API/UI.

**Current truthful verdict:** Phase 2 code is not complete/released solely by the presence of this draft module; a full integration and acceptance run is required. Do not merge this PR or bypass Phase 1 dependencies.

## Independent review — restart quarantine and persistence regressions (2026-10-13)

- Startup validates saved jobs.json shape/version; unreadable or corrupt jobs.json is not treated as empty history. The desktop can still open while recoveryFault prevents a NEW coding run until owner reconciliation.
- On restart, run-level preparing/running and worker-level queued/running/testing/awaiting_test_grant/committing states become interrupted. No model, OS test, shell, Git merge or publish is automatically replayed.
- A transient jobs.json rename failure fails its current run and stops queued workers, but does not poison the persistence queue for a new separately confirmed run. The pre-existing Phase4 concurrent persistence/failure contract remains mandatory.
- Phase2 source regressions now cover corrupt JSON, malformed worker metadata, interrupted worker normalization and blocking new coding work with unreadable saved history.

**Not yet complete:** Explicit owner-approved reconciliation/resumption with fresh hashes/test grants; comprehensive crash matrix; bounded code-context acquisition and reproducible offline reliability benchmarks remain. The SHA-256 local journal detects corruption, never OS trusted-test attestation. Phase1 G4 stays a prerequisite.

## Owner-confirmed recovery acknowledgement (second reliability slice)

- The Hub now exposes a protected POST /api/studio/coding/recovery/acknowledge endpoint that requires the exact confirmation REVIEW INTERRUPTED RUN, the interrupted run ID in the current workspace, and the latest journal integrityDigest returned by GET /api/studio/coding/recovery.
- A restarted interrupted coding run blocks any NEW coding run until the owner inspects that checkpoint. A stale digest, missing journal, wrong workspace, or active worker is refused. Acknowledgement marks the old run needs_attention; it NEVER replays code, model calls, sandbox checks, Git merges or publication.
- The Orchestrator inspector shows recovery faults and offers a manual acknowledgement button only after inspecting a real journal. It displays the truthful needs_attention status and still requires fresh revision-specific diff review plus new test grants before any later integration.
- verify-phase2-recovery.mjs covers explicit confirmation, stale digest, no auto-resume, duplicate acknowledgement denial and persisted needs_attention state.

**Recovery acknowledgement is not safe automatic resumption:** Owner-directed continuation must be treated as a NEW managed coding task with fresh source/test evidence, not a replay of an uncertain previous action.

## Crash consistency: jobs.json versus recovery journal

On startup, CodingWorktreeOrchestrator now cross-checks the latest durable recovery journal metadata with jobs.json for any run with an existing journal. If a crash left those files out of sync, all worker statuses for that run are marked interrupted and prior verification outcomes are invalidated; a new coding run requires an explicit owner review. Corrupt or locked journals fail closed with a visible recoveryFault. Legacy archived jobs with no journal are still handled through the existing migration path. A deterministic regression covers a stale ready_for_review job against a durable running/testing checkpoint. This recovery decision never replays any model, Git or sandbox action and is not a security signature.
