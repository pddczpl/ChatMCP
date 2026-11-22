# Plan mode (P9 ac-9)

A task the owner starts in **plan mode** reads the workspace and writes a plan, and nothing else, until the owner approves the plan.
This document describes the backend: the per-task policy of `PermissionGate`, the `exit_plan_mode` tool, how plan mode is kept across
follow-ups and restarts, and what is not covered. The plan-mode UI (the composer toggle and the approval card) is ac-11; the plan model v2
and its edit API are ac-10.

## Starting it and keeping it

`planMode` is a field of `POST /api/tasks/start` and `POST /api/tasks/continue` (and of `ConcurrentApiAgent.start` / `continue` and
`AgentRunner.start` / `continue`). It is `true`, `false` or absent (`null`); anything else is refused with HTTP 400 `invalid_plan_mode`.

| Request | Task not in plan mode | Task held read-only by plan mode |
|---|---|---|
| start, `planMode: true` | a new task in plan mode | — |
| continue, no `planMode` | stays as it is | stays read-only |
| continue, `planMode: true` | enters plan mode: a new plan, `planApproval` back to null | stays read-only |
| continue, `planMode: false` | stays as it is | **refused**, HTTP 409 `plan_mode_pending` |
| a message to a running run, `planMode: true` | **refused**, HTTP 409 `plan_mode_running` (stop the run first) | delivered |

A task is held read-only when `planMode` is true and `planApproval.status` is not `approved` (`planOnly(task)` in `lib/agent.mjs`). The task
record (`task.json`) keeps `planMode`, `planApproval` (`{status, at, revision, editedByUser}`, or null) and `planRevision`; a task that is
not started yet (a second chat waiting for its worktree) keeps `planMode` in its record in `sessions.json`. The public task carries
`planMode`, `planApproval` and `planOnly`.

## The gate

`PermissionGate.setTaskPolicy(taskId, {planOnly: true})` holds a task; any other policy lets it go. The runner sets it when a plan-mode run
starts and when a Hub loads a plan-mode task (before any run of it); `askPlanApproval` clears it when the owner approves the plan. The policy
is per task: it never changes `PermissionGate.mode`, which every chat of the gate shares, and a second chat runs on a gate of its own anyway.

`authorize()` reads the policy right after the two refusals that need no rule (a protected file, `isolationRequired`) and **before every rule
that can let a call run or ask about it**: the owner's rules for external MCP tools, Full Access, the mode, and a hook's `forceAsk`. For a
held task a call runs only if it is one of the Hub's own tools (a tool that `LocalTools` has, or a `studio.*` tool) whose category is `read`
or `checkpoint` (reads, searches, `get_plan`, `update_plan`, `studio.plan_get`, `studio.plan_set`, `studio.checkpoint`). Everything else is
refused without a question and recorded as a policy refusal; the reason the model sees names `exit_plan_mode`:

- every command tool (`run_command`, `tasks_run`, and any tool named like a shell), a command that only reads included;
- every tool of an external MCP server, one its server marks `readOnlyHint: true` and the owner allowed and trusts included;
- every write, edit, Git change, deletion, execution and unclassified call, whatever the mode; plan mode with Full Access on still refuses them.

## exit_plan_mode

A plan-mode run is offered the host function `exit_plan_mode({plan})` (at most 40,000 characters) and plan-mode instructions in its system
prompt. The call puts a request of category `plan` on the approval stack (`PermissionGate.askPlanApproval`): `toolName` is
`chatmcp.exit_plan_mode` and `detail` is `{kind: 'plan', plan, revision}`. It has the expiry, the stop and the history of every other request,
so the task shows `waiting_approval` while it waits (no new task state). The answer is `POST /api/studio/permissions/decide` with:

- `approved` (boolean, as before);
- `feedback`: optional, a string of at most 4,000 characters (blank is none);
- `plan`: optional, the edited plan, a non-empty string of at most 40,000 characters, only with `approved: true`.

Both extra fields answer a plan request only; on any other request, or with the wrong type or length, the route answers HTTP 400 and the
request stays pending. What happens then:

- **approved**: the gate clears the policy, the runner records `planApproval = {status: 'approved', at, revision, editedByUser}`, persists
  it, and gives the model the approved plan (the owner's edit when there is one) as a user message; the next calls follow the ordinary rules
  of the mode;
- **denied**: the tool result carries the owner's feedback, `planApproval.status` is `denied`, and the task stays read-only;
- **expired** (no answer within the approval timeout): a denial, status `expired`;
- **cancelled** (the task stopped) or **unanswerable** (a context where nobody can be asked): the task stays read-only.

Nothing the model writes can approve a plan: no tool result, file or web page text is read by the gate, and the policy is cleared only on
the gate's decide path.

## Restarts and resume

A Hub that dies while a plan waits loses the request (it lived in that process). The next Hub loads the task as `paused` /
`process_interrupted`, with `planMode` and no approval, and holds it read-only on its gate at once; a continue (by the owner or the automatic
resume) is a plan-mode run again. ac-18 builds the resume semantics on this.

## Paths that do not go through the gate

| Path | In plan mode |
|---|---|
| `spawn_agent`, `spawn_workflow` (host functions of `lib/agent.mjs`; they start agents outside the gate) | not offered, and refused by `#dispatch` if called |
| `mcp_capabilities` `get_prompt` / `read_resource` (answered by the external server's own code) | refused; `list` (the Hub's catalog in memory) runs |
| `agent_results`, `skill_load`, `mcp_catalog`, `mcp_describe` (read the Hub's own memory) | run |
| `mcp_call` | goes through the gate like a direct call |
| `ConcurrentApiAgent` worktree creation for a second chat | goes through the gate of the workspace's owner, as before (see Decisions) |
| `lib/execution-contract.mjs` (`local.run_command` of a registry run) | goes through the gate: a command, refused |
| delegates, dynamic delegates, the coding orchestrator, the terminal | started only by the owner's HTTP routes; no tool of the model reaches them |

## Transports

- The **Browser Companion** (`lib/browser-runner.mjs`) has no plan mode: `planMode` sent there is refused with HTTP 400
  `plan_mode_unsupported`, and `DualAgent` refuses to carry a held plan-mode API task to the Companion.
- **ACP** (`lib/acp/*`) and the **MCP host** (`lib/mcp/host.mjs`) do not expose plan mode: the ACP client sends only `prompt` and
  `workspacePath` (start) or `id` and `prompt` (continue), and the MCP host starts no agent task. An ACP session that continues a plan-mode task
  keeps it read-only.

## Decisions (v1)

- All command tools are refused, a command that only reads too, so plan mode does not depend on the command classifier.
- External MCP tools are refused even when annotated read-only: annotations are the server's own words. For the same reason MCP prompts and
  resources are not read in plan mode.
- `planMode: false` cannot leave plan mode: only an approval of the plan does. A UI that wants a "leave plan mode" button answers the plan.
- A plan-mode chat that runs beside another chat still gets its Git worktree made first, asked through the owner's gate as before: that is
  the Hub's isolation for parallel chats, not a call of the model, and the plan policy holds the chat from its first model step.

## Tests

`tests/verify-plan-mode.mjs` drives the real `PermissionGate`, `HubManager` (`LocalTools`, `StudioWorkspace`), `AgentRunner`,
`ConcurrentApiAgent` and Hub routes with a scripted model: twelve adversarial attempts in Review and with Full Access on (the workspace tree id
of `lib/proof/tree-snapshot.mjs`, HEAD and the refs unchanged), approval with an edit, denial with feedback, expiry, a fake approval in a
tool result, a second chat in Review that edits meanwhile, continue, restart, the HTTP routes and the transports.
`tests/mutation/plan-mode.json` lists the mutations of the gate's plan policy, the dispatch refusal and the wiring.

Not verified: the current UI only shows a plan request as a generic approval card (category `plan`, the detail as JSON); the card of ac-11
is not built.
