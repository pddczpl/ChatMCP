# Phase 3 — Advanced Multi-Agent Coding (new local-only roadmap)

**Status:** SOURCE IMPLEMENTATION IN PROGRESS. Draft stacked above Phase 2/Phase 1, not production certified.

Historical PHASE3-DESIGN.md and PHASE3-REPORT.md belong to the older architecture. Their multi-profile/Full Access/SandboxEngine features are not this new Phase 3 specification.

## Objectives and immutable safety rules

- Architect, researcher, coder, debugger, tester and reviewer roles cooperate without gaining rights by changing their model instructions.
- Explicit OWNER-defined coding DAG tasks, including dependency order and trust boundaries. Untrusted model text cannot declare stronger parent capabilities.
- Each coding worker owns a separate Git worktree. A downstream worker inherits only a previously committed predecessor revision through the TRUSTED GitRunner. It never writes the user's checkout, invokes host shell, changes branch outside its managed scope or publishes itself.
- Detect cross-worker overlap in edited paths (Windows case-equivalent) before a requested integration; require manual review instead of silently merging conflicting edits.
- A worker result with unknown, failed or blocked status cannot be promoted to "completed" by model narration. Dependent jobs stay blocked.
- Preserve current human confirmation and revision-specific diff review tokens for Git integration and draft PR publication.
- Reuse Phase 1 Windows Sandbox test broker and Phase 2 recovery checkpoints without weakening the OS G4 gate. Do NOT add app token/request/spending quotas or enable IDE/cloud hosting.

## Implemented first slice

- CHATMCP-HUB/lib/coding-task-dag.mjs: validate owner-declared task dependencies and reject cycles, self-references, unknown IDs, path escapes, case-equivalent file collisions.
- CHATMCP-HUB/lib/coding-orchestrator.mjs: topological bounded waves over real worktree workers; trusted, pinned dependency merges into disposable descendant worktrees; blocked descendants after upstream failures; exact reviewed revision tokens still required at integration; file-overlap preflight before any integration mutation.
- CHATMCP-HUB/lib/worker-capabilities.mjs: added attenuated architect/debugger roles (no shell, secrets, integration or publication).
- CHATMCP-HUB/lib/worker-scheduler.mjs: unverified/failed worker callback results do not become success; descendants are blocked.
- CHATMCP-HUB/tests/verify-phase3-coordination.mjs: cycles, unknown workers, blocked descendants, safe role rights, concurrency, status and path-conflict checks.
- CHATMCP-HUB/tests/verify-phase3-worktrees.mjs: actual disposable Git worktrees, A→B committed source inheritance, scripted workers, diff review tokens, Phase2 manual recovery journal and pre-integration same-file overlap rejection. This is a local Git regression, NOT Windows Sandbox publisher attestation.

These additions are additive on the Phase 2 and Phase 1 branches. They do not make the sandbox trust boundary safe.

## Acceptance criteria before calling Phase 3 complete

1. All existing Hub, React, Windows and installer tests continue to pass on the EXACT stacked SHA. No skipped required jobs.
2. Two coding tasks with no dependencies run in isolated worktrees with process concurrency <=2. Their integrations require explicit review tokens.
3. A DAG A→B starts B only after A's verified predecessor commit; B sees the correct pinned diff through the trusted GitRunner, not through fabricated model summary. A→B→C has no cycles and no escalation.
4. A failed, cancelled, interrupted or needs-attention predecessor blocks downstream tasks without running any model, shell, Git merge or test.
5. Concurrent branch edits of the same file result in an explicit conflict and no integration mutation. Any manual resolution must be reviewed in a separate approved integration path.
6. All existing read-only research DAGs and dynamic scheduler tests pass. Architect/debugger roles cannot exceed their owner's capabilities; worker completions need explicit truthful outcomes.
7. Run offline multiagent benchmarks with deterministic scripted agents for dependency graph, overlapping file edits, cancellation and interrupted/recovery cases. Prove final Git content/commit SHA and review-token freshness.
8. Release requires Phase 2 manual recovery and Phase 1 G4 trusted Windows publisher & clean install gates. Do not merge this stacked PR prematurely.

## Planned follow-up before complete acceptance

- Execute a real disposable multi-worktree E2E with A→B inheritance and an intentionally conflicting pair, using the fake/scripted provider (no paid API).
- Persist DAG worker dependency receipts and have the UI visualize blocked dependencies, forks and file conflicts.
- Controlled manual conflict resolution and subtree rollback without affecting other worktrees.
- Add benchmark reports for multi-worker speed, correctness, review acceptance and safe cancellation.

**Verdict:** This is a Phase 3 implementation branch, NOT a verified/released Phase 3. User must approve final release only after native OS and offline E2E evidence.

## Independent review — Git path inventory and conflict robustness (2026-10-13)

- Managed worktrees now request NUL-delimited raw Git diff filenames rather than newline-separated paths. Reject work that changes more than 250 files BEFORE any agent commit; silently clipping the list can hide conflicting paths.
- Before creating an agent commit, validate every changed path: reject NUL/controls, absolute paths, traversal, repeated separators, Windows alternate data streams, reserved device names and trailing dot/space aliases; normalize Unicode NFC and case for conflict comparison.
- Regression tests cover Unicode/case aliases, Windows device/ADS names, path ambiguity and a real Git-worktree scripted worker producing 251 files. The latter must fail with zero agent commits and must leave the user's checkout unchanged.

**Remaining Phase 3 acceptance:** A stronger real-world dependency/cancellation/interleaving matrix, explicit manual conflict-resolution workflow, independent model-worker quality benchmarks, and corresponding native Windows testing remain unfinished. G4 and clean-machine install remain release prerequisites, not bypasses.

## Phase 3 additional source evidence — cancellation and local benchmarks

New real disposable Git worktree regressions exercise a three-stage A→B→C chain, pinned inherited commits, a failed upstream blocking all downstream workers, cancellation during an active scripted worker, at-most-two concurrent independent workers and a manual Phase2 bounded source preview from a committed worker. The original checkout remains unchanged, no model provider is used, and no Windows Publisher G4 is unlocked.

An offline nine-case deterministic Phase3 benchmark now records dependency scheduling, parallel readiness, blocked descendants, Windows file-alias overlap, reviewer capability attenuation and concurrency. The JSON report identifies modelRequests=0, hostCommandExecutions=0 and windowsGuestAttested=false: coordination performance and correctness are distinct from real-model quality or native guest trust. These tests are run by the normal verify-* Hub suite.

## Deterministic coding task proposal

`POST /api/studio/coding/plan` accepts a user's goal and returns a read-only,
at-most-four-task worktree DAG proposal. Numbered/bulleted items map to distinct
tasks. Explicit `[after: 1]` dependencies are validated, including cycle and
unknown-task rejection. One unstructured goal stays one task rather than
speculatively multiplying workers. The user edits the proposed tasks in UI
and must still confirm `CREATE WORKTREES` with Autonomous permission.
Sandbox guest acceptance remains the owner's separate responsibility.

## Optional model-assisted coding plan

The preview route accepts `modelAssist: true` explicitly when the user opts
in through the coding agents panel. It makes a model request with zero tools,
parses one strict JSON task graph and validates slugs, dependencies and task
count. Invalid or incomplete replies fail safely; no tool execution, Git
worktree, permission approval or release occurs in the planning call. The
result is clearly marked untrusted and requires owner editing/approval before
any coding worker may begin. The deterministic no-model preview remains the
default so simple tasks need no extra API request.
