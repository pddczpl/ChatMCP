# ChatMCP upgrade implementation checkpoint

Release candidate source line: **v3.10.0** (a test build, published as a pre-release). All exact-commit CI and installed-upgrade release gates must pass before publication. Release status is not inferred from a prepared version number.

This checkpoint records partial work against the owner-authorized complete ChatMCP upgrade, not a release readiness certificate. Inspect current `main` and exact-SHA GitHub Actions before resuming or releasing.

## Committed changes

- Rewrite the root README in English with only Introduction, Guide, License and Security; rewrite SECURITY.md and move detailed links to docs/INDEX.md without suppressing documentation coverage.
- Invalidate stale testing and Git-review evidence following possible file mutations; retain a separate execution-completed versus requirements-accepted status and show unresolved objectives in task API/UI.
- Resolve context envelopes per configured model metadata/window with a conservative fallback, keep canonical evidence, and display context policy to users.
- Distinguish provider-reported token values from missing usage and avoid double-counting cache/read or reasoning subsets; expose partial usage in task history and React UI.
- Add a deterministic evaluation CLI, external-process regression fixtures, hashed reports and documentation (docs/EVALUATION.md). No live model parity measurement has been performed.
- Add selectable OpenAI Responses and compatible custom gateway protocols: stateless text/function tool messages, tool-result pairing, terminal-only SSE parsing, cancellation, protected credential endpoint binding and model function probes. Integrate provider selection into the main React AI configuration panel. These are implementation changes pending runtime confirmation, not proof of universal provider compatibility.

## Completed task/profile UI and regression wiring

- Main React conversation composer supports selecting a saved task model profile, explicitly selecting the global gateway, and optional role-specific profile IDs.
- React AI Settings supports creating, editing, deleting and setting a default model profile without returning decrypted keys. Stored credentials are cleared on origin changes; explicit key-clearing and environment references are supported. A profile also carries an optional custom API path and custom HTTP headers: header values are sealed with the same key store as the key, bound to the origin they were saved for, dropped with the key when the destination changes, and never returned (names only); a task forked from a profile keeps both, and keeps Anthropic prompt caching when the profile points at api.anthropic.com.
- Role keys are canonicalized for model-generated names such as Reviewer / Independent verifier; invalid or duplicate mappings are rejected.
- Deterministic tests cover parent-to-subagent model routing, immutable profile revisions on resume, credential-free persisted task metadata, and role mapping validation. Browser E2E now includes a loopback-model task using a profile created through React Settings.
- These are source and test changes; exact-commit CI and live provider acceptance remain mandatory before making a feature or release certification.

## Current validation boundaries

The latest known full green baseline before recent evaluation/Responses changes is commit `b431d8ccf888423c6a0103a2f03149e7fbc7ee99`, CI run 39035869979: 9/9 jobs passed. **That evidence is not transferrable to any newer commit.** Check the current main SHA's Hub Node 22/24 jobs on Linux and Windows, React/real-Hub E2E, installer build, Browser Companion regression and documentation checks.

Read-only/spec-only assertions are not the same as real file/process tests. Browser scripted pages are not signed-in live ChatGPT acceptance. Provider Responses fixtures are not proof that an arbitrary custom gateway implements Responses. Unknown usage/cost remain unknown. Live model evaluation is explicitly not run without an authorized provider and task-scoped budget.

## Remaining mandatory scope

- Acceptance-criterion-linked evidence with fresh revision snapshots across ordinary agent, coding workers, integration and parent summaries; extensible real Node/TypeScript/Python/browser verification adapters and repair/retest under the existing PermissionGate.
- Dependency-aware propagation of predecessor code, worktree review, conflict handling and restart reconciliation across chat-created and coding workflows.
- Immutable per-task/per-worker provider profile resolution, isolated credential origin binding and production UI workflow for role overrides.
- Protected user-configurable custom HTTP headers; comprehensive streaming error handling and provider-live verification; cost rate configuration, uncertainty and aggregation across workers/conversations.
- Incremental LSP/Tree-sitter/Python code-intelligence refresh/packaging acceptance, full native Windows lifecycle and installed-upgrade checks, Browser Companion source/ZIP parity, and security acceptance without fabricated attestation.
- Updated semantic version, exact-commit release workflow, complete mandatory CI gates, tested final installer/Companion assets, source manifest, SHA-256, signing status, GitHub tag/release.

## Resume and release rule

Never claim full completion based on tool counts or fixtures. Check status and tests on actual current `main`; repair failures without unconditional skips or weakening permissions. Continue unfinished production work, only then bump the version and execute the existing exact-commit release gates. Do not reuse old tags or publish unverified binaries. Latest published release when work started was `v3.8.3`. Any future release must be independently inspected after publication.
