# ChatMCP upgrade implementation checkpoint

This is an auditable handoff for the owner's complete v3.9-class upgrade request, **not a statement of release readiness**. Confirm the latest `main` SHA, GitHub Actions jobs, and working tree before any more changes.

## Changes committed to main

- English top-level `README.md` reduced to exactly four sections: Introduction, Guide, License, Security; `SECURITY.md` rewritten in English.
- Detailed documentation links moved into `docs/INDEX.md` without disabling existing orphan/anchor checks; the tool-count reference was moved outside README.
- `agent-progress.mjs` now invalidates prior test, file-hash and Git-review evidence when a possibly effective file mutation occurs. Test cases cover stale checks, failed writes with uncertain effects, and a confirmed non-executed edit.
- `context-compaction.mjs` and the normal `AgentRunner` select a per-task context envelope from provider settings/metadata or an estimated 32,768-token fallback. Fixed prompt/tool overhead, response headroom, safe history compaction, and conservative context rejection are exposed in the task API, report and React UI. Unit/integration tests were added.

## Outstanding (do not mark verified)

- Complete objective-linked completion and fresh evidence model across normal agent, worker, orchestration and UI.
- Automated real-check discovery/adapters and independently observed failure-repair-retest paths for Node, TypeScript, Python, browser.
- Dependency-aware code handoff, isolated worktrees, merge/conflict/restart reconciliation and parent-worker reporting.
- Real per-task/per-role model profile isolation and immutable provider/credential routing.
- Full OpenAI Responses API adapter with multi-turn tool calls and streams; custom protected headers and origin security.
- Accurate retry/usage provenance, missing-usage reporting, cache and reasoning semantics, configurable costs.
- Reproducible deterministic and optional budgeted live model evaluations.
- All Windows native lifecycle/installer/Companion upgrade verification at the eventual release commit.
- Verified version bump, release workflow, signature status, exact-commit CI, release manifest/hashes, tag and publication.

## Validation handoff

The earlier Node 22/24 CI run for commit `66f2ce83` recorded 92/93 suites passing and an expected docs check failure after README was shortened. A docs index fix was committed; **inspect the newest exact-commit run**, because earlier runs may be cancelled or superseded. React and Windows installer builds in earlier runs do not certify the final version.

To resume: inspect `main` HEAD, the latest CI job statuses, current `README.md` headings, and changes in the files above; repair actual failures without skipping tests. Preserve unrelated work and never reuse an older SHA's CI for a release. The published baseline at start was `v3.8.3`; the requested upgrade has **not** been fully implemented or released. No signed-in live ChatGPT browser acceptance or Authenticode signature is claimed.
