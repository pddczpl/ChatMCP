# Phase 0 — current React / Local Hub contracts

Audit base: `b1160c6862c658d85c90fb1f157cc085d9cfc244` (`origin/main`, v2.6.0), 2026-10-12.
The checkout initially contained v2.5.0. The clean task branch was fast-forwarded to the remote v2.6.0 base before editing; local main was not edited.

This audit concerns `CHATMCP-HUB/ui/src`, the Vite bundle served by the local Hub, and the existing PermissionGate/AgentRunner. Historical legacy dashboard tests are not substitutes for the current React UI.

| Suspected issue | Initial classification | Evidence / correction |
| --- | --- | --- |
| A. Missing sessions | Confirmed | `/api/state` publishes `agent.tasks`; React read `tasks`. The API adapter now maps the actual wire summaries, and the selected conversation loads `/api/tasks/:id`. |
| B. Wrong running states | Confirmed | Components checked `working` / `in_progress`, absent from AgentRunner. The view contract uses canonical `state`, preserves runner status, and treats legacy `limit` as paused. |
| C. Missing conversation | Confirmed | React expected `messages` / tool arrays; Hub publishes `dialogue`, `prompts`, `runs`, `events`, `finalText` and a numeric tool counter. The task adapter reconstructs recorded text and tool receipts, without synthetic conversation content. |
| D. Invisible approval | Confirmed | Real pending/recent decisions live under `studio.permissions`; React read `task.pendingApprovals`. Review now uses the gate's IDs, command/content preview, category, expiry and decision history. Only explicit button actions decide. |
| E. Skills rendering | Already Fixed | `InspectorPanel` already mounts `SkillsTab` at the v2.6.0 base. Rendering/API calls are covered by regression tests. |
| F. New conversation spends tokens | Confirmed | Sidebar sent a sample prompt immediately. New conversation now selects an empty local draft; only Send creates the task. |
| G. Fake plan | Confirmed | PlanTab supplied made-up steps and completion. It now queries the persisted plan and renders an explicit empty/error/loading state. PhaseRibbon no longer certifies build/test stages merely from a model final answer. |
| H. Empty inspector tabs | Confirmed | Activity/files/terminal read nonexistent state fields. Tabs now read task events, actual Git changed-file status/diff and terminal sessions. The existing checkpoints, plan and terminal API envelopes were already correct. Full file explorer/editor work remains Phase 2. |
| I. SSE unused | Confirmed | Server had `/api/tasks/events`; React never subscribed. A mounted subscriber now scopes tokens to the selected task and reconciles queries on events/reconnection, with polling as fallback. Provider-level token generation remains a separate Phase 2 capability. |
| Onboarding | Confirmed | Workspace browse errors selected a hard-coded path; provider/permission selections were decorative. Workspace errors now stay visible, the real AI settings form is reused and permission choices are saved through the gate. |
| Hidden API failures | Confirmed | Successful HTTP responses containing invalid JSON became null state. The API client rejects these responses; inspector failures remain visible. |
| Credential carryover | Confirmed | The AI form retained typed API keys after Save and when selecting a different provider/origin. The form now clears them after successful persistence and before testing, and on destination changes. Browser regressions use dummy credentials and a local fixture only. |
| Unsupported Settings claims | Confirmed | Settings defaulted a missing user role to ADMIN and displayed static backend safety claims. It now describes the local single-user scope and reports actual Hub query status. |
| Research persistence race | Confirmed | The baseline Windows regression run failed renaming the shared DAG snapshot while concurrent workers saved it. Snapshot writes are serialized; failures await active workers before releasing the run. Deterministic regressions cover both cases. |
| Canonical AI configuration after Save | Confirmed during PR review | A named provider saved with a custom endpoint becomes a custom preset in the Hub. Keeping the old form preset caused a second save without a new key to fail. Successful save/test responses now reconcile the canonical preset while preserving newer user edits. |
| Checkout paths containing spaces | Confirmed during PR review | Component tests used a URL pathname as a filesystem path, retaining percent escapes. They now use `fileURLToPath`; the disposable checkout reproduction passed after this correction. |
| Coding worker persistence race | Confirmed during PR review | The strict Windows regression failed concurrent `jobs.json` renames while coding workers were active. This also exposed early release on a sibling save failure and a stuck active run when the initial save failed. The source follow-up serializes snapshots and settles workers/persistence before releasing the run. |
| Installer copied local state | Confirmed | Recursive source-directory copying included ignored files in the developer checkout. The packaging change restricts payloads to tracked runtime sources and freshly built UI assets, with path/reparse and cleanup checks. |
| Required CI suites skipped | Confirmed | CI installed no Python FastAPI dependencies and omitted `--no-skip all`; no current React/real-Hub browser gate existed. A separate E2E/CI change adds these gates. |

## Verification scope

Unit regressions exercise the real task/API adapters and stream event consumer. Inspector rendering tests load the actual TSX components. Playwright exercises the built React app and a real loopback Hub, isolated temporary Git workspace/state and scripted local model provider. The provider is deliberately fake: these tests do not establish live-model quality, provider streaming or API budget behavior.

Plan evidence is text recorded by the agent, not an independent verifier certificate. A step reported done without evidence does not increase evidence progress. Unresolved tool receipts from an earlier run remain unknown after Resume and are never paired with later-run results.

No permission mode is relaxed to make the tests pass. Test approval clicks are explicit simulated user actions against the actual gate. Test fixtures never use the user's workspace/state directory.

## Remaining gates

Record actual command outcomes in the session report. Do not treat this audit table as evidence that all tests have passed. Windows installer compilation, WebView2 runtime, clean-machine install/upgrade/uninstall, and live-provider validation are separate checks. Phase 1 is not declared ready by this document.

Worktree workers retain their restricted toolset. No Windows OS sandbox, unrestricted worker shell, public hosting, multi-tenant service, new release tag or license grant is introduced.
