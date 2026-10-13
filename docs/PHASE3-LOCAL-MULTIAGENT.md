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
