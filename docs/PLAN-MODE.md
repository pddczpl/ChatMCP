# Plan mode (P9 ac-9, ac-10, ac-11)

A task the owner starts in **plan mode** reads the workspace and writes a plan, and nothing else, until the owner approves the plan.
This document describes the per-task policy of `PermissionGate`, the `exit_plan_mode` tool, how plan mode is kept across follow-ups and
restarts (ac-9); the plan model v2, its revision and the edit and decision routes, and the execution choice of an approval (ac-10); the page:
the composer's Plan entry, the approval card and the editable Plan tab (ac-11); and what is not covered.

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
record (`task.json`) keeps `planMode` and `planApproval` (`{status, at, revision, editedByUser, execution}`, or null); a task that is
not started yet (a second chat waiting for its worktree) keeps `planMode` in its record in `sessions.json`. The public task carries
`planMode`, `planApproval` and `planOnly`. `planApproval.revision` is the revision of the task's plan (see "The plan and its
revision"): ac-9 counted the calls of `exit_plan_mode` in a `planRevision` field of its own, and ac-10 dropped it, so a plan has one
revision number. A `task.json` of ac-9 that still has `planRevision` is read as it is; the field is no longer read or written.

## The gate

`PermissionGate.setTaskPolicy(taskId, {planOnly: true})` holds a task; `{mode: 'review' | 'autonomous'}` gives it the mode the owner chose
for the execution of its approved plan (see "Review or Autonomous"); any other policy lets it go. The runner sets the hold when a plan-mode
run starts and when a Hub loads a plan-mode task (before any run of it); `askPlanApproval` replaces it with the chosen mode, or clears it,
when the owner approves the plan. The policy is per task: it never changes `PermissionGate.mode`, which every chat of the gate shares, and a
second chat runs on a gate of its own anyway.

`authorize()` reads the policy right after the two refusals that need no rule (a protected file, `isolationRequired`) and **before every rule
that can let a call run or ask about it**: the owner's rules for external MCP tools, Full Access, the mode, and a hook's `forceAsk`. For a
held task a call runs only if it is one of the Hub's own tools (a tool that `LocalTools` has, or a `studio.*` tool) whose category is `read`
or `checkpoint` (reads, searches, `get_plan`, `update_plan`, `studio.plan_get`, `studio.plan_set`, `studio.checkpoint`). Everything else is
refused without a question and recorded as a policy refusal; the reason the model sees names `exit_plan_mode`:

- every command tool (`run_command`, `tasks_run`, and any tool named like a shell), a command that only reads included;
- every tool of an external MCP server, one its server marks `readOnlyHint: true` and the owner allowed and trusts included;
- every write, edit, Git change, deletion, execution and unclassified call, whatever the mode; plan mode with Full Access on still refuses them.
  This includes the web tools of category `execute` (`web_fetch`, `web_search`, `web_extract`, `docs_search`): in v1 a plan cannot read the web.

## exit_plan_mode

A plan-mode run is offered the host function `exit_plan_mode({plan, expected_revision?})` (a plan of at most 40,000 characters) and plan-mode
instructions in its system prompt. The plan is first written as the next revision of the task's plan (its text; the checklist is kept), by
the model, under the rules of "The plan and its revision": when the owner edited the plan after the model last read it, nothing is proposed,
no request is raised, and the model is told to call `get_plan` and propose again with `expected_revision`. Then the call puts a request of
category `plan` on the approval stack (`PermissionGate.askPlanApproval`): `toolName` is `chatmcp.exit_plan_mode` and `detail` is
`{kind: 'plan', plan, revision}`, where `revision` is the plan file's. It has the expiry, the stop and the history of every other request,
so the task shows `waiting_approval` while it waits (no new task state). The answer is `POST /api/studio/permissions/decide` with:

- `approved` (boolean, as before);
- `feedback`: optional, a string of at most 4,000 characters (blank is none);
- `plan`: optional, the edited plan, a non-empty string of at most 40,000 characters, only with `approved: true`;
- `execution`: optional, `review` or `autonomous`, only with `approved: true` (see "Review or Autonomous");
- `revision`: optional, the revision of the plan the answer is about (by default the one the request names).

The extra fields answer a plan request only; on any other request, or with the wrong type or length, the route answers HTTP 400 and the
request stays pending. An approval through this route is held to the plan file as the plan decision route holds it ("Answering a plan"): a
plan the owner edited after the request was raised is a 409 `plan_conflict` unless the answer names the current revision. What happens then:

- **approved**: the gate ends the hold (the task keeps the chosen mode as its policy, if one was chosen), the runner records
  `planApproval = {status: 'approved', at, revision, editedByUser, execution}` (`revision` is the one approved; `editedByUser` is true
  when that is a later revision than the proposal: the owner edited the plan, its text or only its checklist, before approving it), marks the
  plan file (`approvedAt`, `approvedRevision`), persists the task, and gives the model the approved plan (the owner's edit when there is one)
  as a user message that names the revision; the next calls follow the ordinary rules of the mode, or of the mode chosen;
- **denied**: the tool result carries the owner's feedback, `planApproval.status` is `denied`, and the task stays read-only;
- **expired** (no answer within the approval timeout): a denial, status `expired`;
- **cancelled** (the task stopped) or **unanswerable** (a context where nobody can be asked): the task stays read-only.

Nothing the model writes can approve a plan: no tool result, file or web page text is read by the gate, and the policy is cleared only on
the gate's decide path.

## The plan and its revision (ac-10)

Each task has one plan, `plans/<taskId>.json` in the folder of the studio that runs it (`StudioWorkspace.plan()` in
`lib/studio-workspace.mjs`; a chat that runs beside the first keeps it in its own state folder, and the Hub's plan routes read it there). The
plan is a checklist (`title`, `items`: what `update_plan` writes and the Plan tab shows) and a `text` (what `exit_plan_mode` proposed, or
the owner's edit of it), under **one revision number**:

| Field | Meaning |
|---|---|
| `version` | `2` |
| `revision` | 0 before the first write; every write (checklist, text, or both) raises it by one |
| `updatedBy` | who wrote last: `agent` (the model, the Hub on its behalf) or `user` (the owner, through a route); null before the first write |
| `updatedAt` | when |
| `approvedAt`, `approvedRevision` | when the owner last approved a plan of this task, and which revision; recording it is not a write (no new revision) |

**Optimistic concurrency.** A write may name the revision it is based on: the owner's `baseRevision`, the model's `expected_revision`. Any
other revision is a `409 plan_conflict` that carries the revision the plan is at (and who wrote it), and nothing is written. A write of the
model that names no revision is a conflict as well when the owner wrote last: **a model rewrite never replaces an edit of the owner it has not
read**. A model that names none after its own write goes on, as before ac-10. A write of the owner that names none is the owner's word and
goes on. The read, the check and the write are one step per task in the Hub process, so two writes from one base save one.

**The model's side.** `get_plan` and `update_plan` say the revision (and `get_plan` the text); `update_plan` and `studio.plan_set` take an
optional `expected_revision`. A conflict comes back as a tool result `plan_conflict` (with `revision` and `updatedBy`) that says nothing was
saved and tells the model to call `get_plan`, keep the owner's changes and write again with that revision; the file is left byte for byte.
`exit_plan_mode` follows the same rule.

**Old plan files.** A plan file of the old shape (no `revision`, no `updatedBy`) is read as revision 0, written by nobody, with no text and no
approval. It is not rewritten by a read; its next write stores the v2 shape as revision 1 (lazy migration). A stored revision or writer that
is not one (a string, an unknown name) is read as none.

## Answering a plan: the routes (ac-10)

All three are behind the bearer, the page's Origin, the `local-dashboard` marker and the CSRF token, like every dashboard POST (they are in
`POST_ROUTES`, and the page sends its `X-ChatMCP-UI-Build` with them; `ui/src/lib/api.ts` has a client function for each).

- `GET /api/studio/plan?taskId=` reads the plan (the v2 shape above).
- `POST /api/studio/plan/set {taskId, title, items, text?, baseRevision?}` is the owner's edit, always as `user` (a `by` in the body is
  ignored). With `baseRevision` (a whole number; anything else is 400 `bad_revision`) the edit must be from the current revision: another one
  is 409 `plan_conflict` with `revision` and `updatedBy`, and nothing is written. Without it the edit is unconditional. `text` replaces the
  text of the plan; without it the text stays.
- `POST /api/studio/plan/decide {taskId, revision, decision, feedback?, execution?}` answers the plan request that task waits with.
  `decision` is `approve` or `request_changes`; `revision` is the revision the owner looked at and must be the plan's current one (409
  `plan_conflict` with the current revision, the request stays pending); `request_changes` needs a non-blank `feedback` (400
  `feedback_required`) and takes no `execution` (400 `bad_execution`); a task with no plan waiting is 404 `no_plan_request`. The feedback
  goes through `PermissionGate.decide` to the model, in the result of its `exit_plan_mode` call, as with the decide route.

To approve an edited plan, the page saves the edit (`plan/set` with `baseRevision`) and approves the revision that answered; or it answers
the request through `/api/studio/permissions/decide` with `plan` and the `revision` it showed, and the Hub saves the edit as the owner's
next revision before it approves that one. Either way the model is given the text the plan file holds under the revision `planApproval`
records. The route matching of the Hub is by the whole path (a `switch`), so no other route can take `/api/studio/plan/decide`.

## Review or Autonomous: the execution choice (ac-10)

An approval may say how the plan is carried out: `execution: 'review'` or `'autonomous'`. It is **the mode of that task's calls from the
approval on**, for that task only, on whichever gate runs it:

| Gate | No choice | `review` chosen | `autonomous` chosen |
|---|---|---|---|
| Review | Review | Review | Autonomous: edits inside the workspace run unasked |
| Autonomous | Autonomous | Review: every edit and command is asked | Autonomous |
| Full Access | Full Access | Review (Full Access does not apply to the task) | Autonomous (Full Access does not apply to the task) |
| Read Only | Read Only | Read Only | Read Only |

So the chosen mode replaces the gate's mode and Full Access for the task, in both directions, and Read Only, the strictest setting, still
wins (its refusals come first). The execution policy `sandbox-only` and every rule that does not depend on the mode (protected files,
`isolationRequired`, a hook's `forceAsk`, the operations that are always asked, an owner's `deny` of an MCP tool) apply as before. Other
tasks of the gate, and `PermissionGate.mode`, are not touched. Without a choice the task follows the gate, as in ac-9.

The choice is `planApproval.execution`, persisted with the task; the gate holds it as the task's policy (`setTaskPolicy(id, {mode})`), a
Hub that loads the task puts it back before any run, and every later run of the task puts it back on the gate that runs it. A new plan
(`planMode: true` on a follow-up) replaces it with the plan-mode hold; the next approval sets a new choice, or none.

## The page (ac-11)

The logic is in two pure modules, `ui/src/lib/plan-draft.ts` (the owner's draft) and `ui/src/lib/plan-view.ts` (the card, the composer, the
banner); the components (`ui/src/components/plan/`, `approval/PlanApprovalCard.tsx`, `inspector/PlanTab.tsx`) draw them. The page uses the routes
above and nothing else of the Hub.

**The composer.** The mode menu has an entry *Plan* under "This conversation only". It is a flag of the conversation's next message (`planMode: true` on
start or continue) and changes no permission mode; the chip then reads "Plan · Review". It is never sent as `false`. A conversation that is held
shows it checked and locked (only an approval ends plan mode); while a run goes on outside plan mode it is off, because the Hub refuses the message
(`plan_mode_running`). With the Browser Companion as the transport of the next message the entry is not there and nothing is sent. The flag goes back to
off after a message and when another conversation is opened.

**The approval card.** A pending request of category `plan` has a card of its own (a request that is not shaped like one, and an answered one, keep the
ordinary card; an answered one shows the owner's feedback). It shows the **plan file** (`GET /api/studio/plan`), which is what the Hub gives the model on an
approval, and not the request's masked copy; that copy is shown, and cannot be edited, until the file is read. The text is drawn as Markdown (no raw HTML) or
as its source; a text with characters that cannot be seen is shown as its source, with those marked. Its answers:

- *Approve and run in Review* / *Approve and run in Autonomous* send `plan/decide` with the revision on the card and the execution. Unsaved edits are
  saved first (`plan/set` with `baseRevision`) and the revision that answered is approved; when the approval after the save is refused, the edit stays
  saved and is no draft any more. Nothing is sent while the draft is in conflict, has a step with no words, or the plan has no text (the card says why).
- *Request changes* opens a text box (non-blank, at most 4,000 characters, trimmed) and sends `plan/decide` with `request_changes`. Unsaved edits are not
  sent with it, and the card says so.
- A 409 `plan_conflict` answers nothing: the page reads the plan again and says that it changed. Any other refusal is the Hub's own sentence.

The card says when the choice does not decide alone: Read Only still wins, and Full Access does not apply to the task after the approval (both read from
the mode of the Hub's gate; a chat that runs beside another keeps the mode it was started with). After an answer the focus goes to the message box.

**The draft.** What the owner types is a draft per task in a store of the page (`usePlanDrafts`), apart from the plan that is fetched every 2.5 s: a
refetch, another tab and another conversation take nothing away (a reload of the page does: nothing is saved to disk). The Plan tab and the card of the same
plan edit and show the same draft. Against a plan that moved on (`reconcile`):

| The plan's new revision | The draft |
|---|---|
| has the same words (title, text, steps, order): the agent marked its steps | goes on, on the new revision, with the new marks; no question |
| has other words, and the draft has no edits | becomes the new plan |
| has other words, and the draft has edits | is a **conflict**: it stays as it is, the banner says who wrote which revision, and nothing can be saved or approved |

A conflict is settled by the owner: *use the new revision* drops the draft; *keep my edits* puts the parts the owner changed (the title, the text, the
whole list of steps) on the new revision and takes the parts they did not touch from it. Nothing is saved by the choice itself.

**Evidence stays the agent's.** The status and the evidence of a step are shown and are no field. A step that is only moved keeps them; a step whose words the
owner changes loses the evidence, and "done" (they were for the old words, and the editor says so); a step the owner adds has neither. So no edit of the owner can
show evidence, or a check mark, on words the agent recorded none for.

**The Plan tab** shows the revision, who wrote last, whether the approved revision is the current one, the text, the steps and the evidence, and *Edit plan*
for a task of the Model API: add, delete, move and reword steps, the title and the text. The plan of a Companion task is only read. Dropping edits
asks first.

**The banner.** A held conversation has a line in every state (writing a plan, waiting for an answer, changes asked for, expired, nobody to ask), also while
it runs and after it answered; an approved one has a line, with the execution, where there is a banner anyway.

**Keyboard and screen reader.** Every control has a name and works with the keyboard. Enter in a step adds one under it; the focus goes to an added step,
to the step in the place of a deleted one, and stays with a step that moves; what happened is said in a status region. Escape in the feedback box closes it
and keeps the words. Closing an editor gives the focus back to the button that opened it.

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
  keeps it read-only. An editor that answers a plan request through ACP sends `approved` alone (`lib/acp/hub-client.mjs`): when the owner
  edited the plan after the request was raised, that approval is refused (409 `plan_conflict`), the ACP agent logs it, and the request stays
  pending for the owner in DatGold.

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

ac-10 adds to the same suite: the plan model on a real `StudioWorkspace` (revision 0, an old plan file read without a rewrite and migrated by
its first write, every write and its writer, a stale base, the model over the owner, one revision for the checklist and the text, the
approval record, bad values, two writes from one base); the model's tools on a real `LocalTools` and `StudioTools` (the conflict result and
the file byte for byte); the execution choice on a real gate (a table of four calls of three tasks under the four settings) and in the runner
(a proposal refused after an owner's edit, Autonomous under a gate in Review, a restart and a later run); and the test plan through a **real
Hub process** (`hub.mjs` on a free port, never 3007, with the strict Chat Completions mock of `tests/e2e/mock-model-server.mjs`): an edit
raises the revision, a stale `baseRevision` and a stale decision are 409, `request_changes` needs feedback and the feedback is in the next
provider request, the model's `update_plan` with a stale `expected_revision` gets the conflict and the plan file is byte for byte unchanged,
Autonomous runs a write unasked under a gate in Review, the decide route refuses a stale approval, an edit with the approval is the next
revision and Review asks a write under a gate in Autonomous. `tests/verify-studio-http.mjs` checks the refusals of the two routes;
`ui/tests/api.test.mjs` the page's client. Mutation lists: `tests/mutation/plan-model.json` (`verify-plan-mode`),
`tests/mutation/plan-routes.json` (`verify-studio-http`), `tests/mutation/plan-ui.json` (`tests/ui-plan-api-for-mutation.mjs`).

ac-11 adds `ui/tests/plan-draft.test.mjs` and `plan-view.test.mjs` (the pure modules; mutation list `tests/mutation/plan-view.json`, suite
`tests/ui-plan-view-for-mutation.mjs`), `ui/tests/plan-components.test.mjs` (the real components, for requests of the real `PermissionGate`, in both languages,
and what each button sends), two cases in `ui/tests/api.test.mjs` (`planMode`; `plan-ui.json`), and `ui/e2e/plan-mode.spec.mjs`: the production page, a
real Hub and the scripted model (start in plan mode, edit a step and the text in the card, approve for Autonomous and the write runs; request changes, the
feedback is in the model's next turn and a plan approved for Review asks before it writes; a draft that outlives the refetch and a tab, a conflict with another
window, the keyboard; a plan that moved on behind the card: the Hub's 409; the Companion and a held follow-up; the English screen). The plan asked for browser scenarios in `tests/verify-react-ui.py`,
which the repository no longer has (its successor is `ui/e2e`).

Not verified: two Hub processes that share a state folder are not serialized (the plan lock is per process). No real model was run. The page was not
tried in the WebView2 shell or with a screen reader (names, focus and status regions are asserted in Chromium).
