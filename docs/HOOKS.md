# Hooks

A hook is a program that **you** configured and the Hub starts around a tool call: before it (`PreToolUse`), after it (`PostToolUse`, `PostToolUseFailure`) and when an agent run ends with a final answer (`Stop`, `SubagentStop`, `TaskCompleted`). A `PreToolUse` hook can veto a call or ask you to confirm it; a `PostToolUse` hook can hand the model a note about what just happened; a `Stop` or `TaskCompleted` hook can send the agent back to work ([below](#stop-subagentstop-and-taskcompleted)). A hook never grants anything: it is a second pair of eyes on top of the permission gate, not a way around it.

The format is the documented subset of the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), kept as close as the Hub allows so that a configuration and a hook script written for Claude Code need as few changes as possible. The differences are listed [below](#differences-from-claude-code); nothing here was tried against Claude Code itself. The schema file is [`CHATMCP-HUB/schemas/hooks.schema.json`](../CHATMCP-HUB/schemas/hooks.schema.json); the code is [`CHATMCP-HUB/lib/hooks.mjs`](../CHATMCP-HUB/lib/hooks.mjs); the threat model is [section "Surface 4"](THREAT-MODEL.md#surface-4-lifecycle-hooks).

## Where the configuration lives

| File | Trusted? | Read |
|---|---|---|
| `<Hub data folder>/hooks.json` (the folder that holds `hub-state.json`; `%LOCALAPPDATA%\ChatMCP\hub` by default) | yes, it is yours | on every call, so an edit takes effect on the next tool call without a restart |
| `<project>/.chatmcp/hooks.json` | **no** | only after you approved its sha256 (see [Project hooks](#project-hooks-and-their-approval)) |

If the owner file exists and is not valid (broken JSON, an unknown field, a wrong type), every call that a `PreToolUse` hook could have vetoed is **refused** with `hooks_config_invalid` until you fix or remove the file. The Hub does not run without guards you wrote down. A project file can add hooks and never removes yours.

## Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node", "args": ["C:/hooks/no-force-push.mjs"], "timeout": 10, "onFailure": "block", "if": "Bash(git *)" }
        ]
      }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [ { "type": "command", "shell": "bash", "command": "\"$CLAUDE_PROJECT_DIR/scripts/lint-changed.sh\"" } ] }
    ]
  }
}
```

* **Events.** `PreToolUse`, `PostToolUse`, `PostToolUseFailure` fire for every tool call. `Stop`, `SubagentStop` and `TaskCompleted` fire when an agent run ends with a final answer, before the task is completed ([below](#stop-subagentstop-and-taskcompleted); the ChatGPT Web transport has no such loop and fires none of them). Any other Claude Code event name is accepted and ignored with a warning, so a settings file can be pasted in; a name that is not a Claude Code event (a typo) is an error.
* **`matcher`** (tool events only). Empty, `*` or absent: every tool. Only letters, digits, `_ - , |` and spaces: an exact name or a list (`Edit|Write`). Anything else: an unanchored JavaScript regular expression. A tool answers to its DatGold name (`local.run_command`) **and** to its Claude Code name:

  | Claude Code | DatGold tools |
  |---|---|
  | `Bash` | `local.run_command` |
  | `Edit` | `local.edit_file`, `local.files_apply_patch` |
  | `Write` | `local.write_file`, `local.files_write_batch` |
  | `Read` | `local.read_file` |
  | `Glob` / `Grep` | `local.find_files` / `local.search_files` |
  | `mcp__server__tool` | the tool `tool` of an external server `server` |

  A DatGold tool with no row (`local.move_path`, `local.delete_path`, `local.git_*`, `local.tasks_run`, `studio.*` ...) is matched by its DatGold name only: a matcher of `Edit|Write` does **not** see them.
* **Handler** (`type: "command"`, the only type this build runs). With `args` the hook is started directly (exec form): `command` is the program, nothing interprets the arguments. Without `args`, `command` is a script for `shell` (`bash`, `powershell` or `cmd`; default: Git Bash if installed, else PowerShell on Windows, `bash` or `sh` elsewhere). `${CLAUDE_PROJECT_DIR}` is replaced in `command` and `args` of the exec form; in shell form the same name is an environment variable (a PowerShell script gets `${env:CLAUDE_PROJECT_DIR}`). In exec form the program `node` is the Node that runs the Hub, so such a hook works on a machine with no Node on `PATH`; in shell form `node` is whatever `PATH` finds, and where there is none the hook fails to start, which does not block the call unless `onFailure` is `"block"` (use exec form for a Node script, or an absolute path). A `.cmd` or `.bat` file cannot be started in exec form (Node refuses); use `"shell": "cmd"`.
* **`timeout`** is in seconds, 1 to 3600, default 600 (Claude Code's default). When it is up the program **and everything it started** are killed.
* **`onFailure`**: `"continue"` (default) or `"block"`. See the exit codes.
* **`if`**: one condition, `Tool` or `Tool(pattern)`, for the tool events. `Bash(git *)` matches `git status`, `npm test && git push` (every sub-command is looked at, also `$(...)` and backticks) but not `gitk`; `Edit(src/**)` and `Write(.env*)` match workspace-relative paths (`*` does not cross a `/`, `**` does; a pattern without `/` also matches the file name at any depth). What cannot be evaluated here (a malformed rule, a tool class this build has no counterpart for, an argument that is not text, a command with more than 64 sub-commands) **lets the hook run**: skipping would switch off a guard silently. Patterns are matched by a table walk whose cost is bounded by the length of the pattern times the length of the command, so a command the model chooses cannot stall the Hub. On an event that is not a tool event a hook with `if` never runs.
* Accepted for compatibility and without effect: `async` / `asyncRewake` (the hook runs synchronously; a warning says so), `once`, `statusMessage`. A handler of another `type` (`http`, `mcp_tool`, `prompt`, `agent`) is dropped with a warning. Unknown fields of a `command` handler are an error: a misspelt `onFailur` would otherwise quietly make the hook non-blocking.

## What a hook receives

JSON on stdin, one object:

| Field | Value |
|---|---|
| `session_id` | the task id |
| `cwd` | the workspace the tool works in (for a spawned agent: its worktree) |
| `permission_mode` | `default` (Review), `plan` (Read Only), `acceptEdits` (Autonomous), `bypassPermissions` (Full Access); Read Only wins over Full Access, as in the gate |
| `hook_event_name` | the event |
| `tool_name` | the **DatGold** name, e.g. `local.run_command` (the Claude Code name is in `tool_aliases`) |
| `tool_input` | the arguments of the call; for `local.write_file`, `local.edit_file`, `local.read_file` also `file_path`, absolute, as Claude Code scripts expect. `local.edit_file` carries either `old_string` + `new_string` or `edits`, a list of up to 50 of them for one file that are applied in order or not at all |
| `tool_use_id` | one id for the `Pre` and the `Post` hook of a call |
| `tool_response` | (`PostToolUse`) the result of the tool; `error` (`PostToolUseFailure`) its message |
| `tool_aliases`, `chatmcp_permission_mode`, `chatmcp_execution_policy` | DatGold additions |

The three lifecycle events send other fields ([below](#stop-subagentstop-and-taskcompleted)). Not sent: `transcript_path`, `prompt_id`, `effort`, and on the tool events `agent_id` and `agent_type`. The JSON is cut to about 1 MiB (long strings are shortened and `chatmcp_truncated` is `true`). The environment is the Hub's **after `scrubEnv`**: variables whose name says key, token, secret, password or credential, URLs with a password and values equal to a registered secret are gone (the Hub's own `OPENAI_API_KEY` is not visible to a hook), and `CLAUDE_PROJECT_DIR` and `CHATMCP_PROJECT_DIR` are added. On Windows a hook that runs through a shell (`bash`, `sh`, `powershell`) also gets no `PSModulePath`, so that a Windows PowerShell it starts finds its own commands even when the Hub was started from a `pwsh` session; a hook with `args` or `"shell": "cmd"` is given the environment as it is. The stdin JSON is **not** masked: a hook sees exactly what the tool receives.

## What a hook returns

| Exit code | `PreToolUse` | `PostToolUse`, `PostToolUseFailure` | `Stop`, `TaskCompleted`, `SubagentStop` |
|---|---|---|---|
| 0 | stdout is read if it is one JSON object | same | same |
| 2 | **deny**; stderr is the reason (stdout JSON cannot override it) | the tool already ran: stderr becomes feedback to the model | **block**; stderr is the reason |
| anything else, a timeout, a program that cannot be started | nothing, unless `onFailure` is `"block"`: then deny | nothing, unless `onFailure` is `"block"`: feedback that the hook failed | nothing: `onFailure` has no effect on these events ([why](#stop-subagentstop-and-taskcompleted)) |

JSON on exit 0 (everything else in it is ignored and listed by name in the record):

* `PreToolUse`: `hookSpecificOutput` with `hookEventName: "PreToolUse"`, `permissionDecision` (`allow`, `deny`, `ask`; `defer` is read as `ask`) and `permissionDecisionReason`; or the older top-level `decision: "block"` (deny) / `"approve"` (allow) with `reason`; `continue: false` is a deny.
* `PostToolUse`, `PostToolUseFailure`: `hookSpecificOutput.additionalContext` (cut at 10,000 characters) and top-level `decision: "block"` with `reason` (feedback).
* Stop family: `decision: "block"` with `reason`. `hookSpecificOutput.additionalContext` is read and recorded, not sent to the model (Claude Code continues the conversation with it).
* Output that is not one JSON object (text before or after it, an array, text only) is ignored. **Stdout is cut at 64 KB and a cut stdout is never read**: to veto a call from a script that prints a lot, exit 2.
* Everything a hook prints is cleaned before it goes anywhere: escape sequences, control and bidirectional characters are removed, registered secrets and token-shaped strings are masked, reasons are cut at 4,000 characters.

Hooks of one event run in parallel; among `PreToolUse` decisions **deny beats ask beats allow**. The model sees the added text as a separate part of the tool result, labelled `[Hook context · PostToolUse]` or `[Hook feedback · PostToolUse]`; `isError` and `structuredContent` of the result are not touched.

## What a hook can and cannot do

The permission gate decides first. The hooks are asked next, **for every call that passed argument validation, including a call the gate refused**, and only then are the caller told, the timeline written and a checkpoint made:

* A hook **can** refuse a call the gate allowed (`hook_denied`, `executed: false`, the same shape as a gate refusal) and **can** make the gate ask you about a call it would have let through (`PermissionGate.authorize({ forceAsk })`: the question shows the hook's reason). The question is asked at most once per call: when the gate already asked you, the hook's `ask` is satisfied by your answer.
* A hook **cannot** turn a refusal of the gate into an approval, and its `allow` skips nothing: in Read Only an edit is refused whatever the hook says; in Review you are still asked. Where nobody can answer (a spawned agent in Autonomous or Full Access, a coding worker) a forced question is refused at once instead of waiting for the approval timeout.
* A hook **cannot** change the arguments of a call or the result of a tool (`updatedInput`, `updatedToolOutput`: not implemented, ignored), and nothing in its output touches a permission setting: the output is read through a fixed list of fields.
* If the hooks runner itself fails before the tool runs, the call is refused (`hook_denied`); after the tool ran, the result is returned as it is.

Covered: every call that goes through the guarded session, that is the dashboard agent, a spawned agent (`spawn_agent`) and its own tools, a coding worker and the ChatGPT Web Companion, on the primary workspace and on a second one. With the Companion the hook's context is part of the tool result that goes to chatgpt.com, so it passes the same outbound filter as any other result. **Not covered**: the `spawn_agent`, `spawn_workflow`, `agent_results` and `skill_load` calls themselves (the agent loop runs them outside the guard), what the Hub runs on its own account (checkpoints, the verification run of a worker's checks).

## Stop, SubagentStop and TaskCompleted

These three events fire when an agent run **ends with a final answer**, before the Hub marks the task completed. They are the only way for a hook to say "not yet": a block sends the agent back to work.

| Event | Fires | For |
|---|---|---|
| `Stop` | the model gave a final answer | the agent of a conversation a person started: the dashboard agent, and a second conversation started while another one was running |
| `SubagentStop` | the same | an agent that another agent started (`spawn_agent`, a workflow worker) and every worker of the coding orchestrator |
| `TaskCompleted` | after `Stop` / `SubagentStop` let the answer through and the Hub computed its own assessment of the evidence, right before the task becomes `completed` | all of them: a spawned agent is asked `SubagentStop`, then `TaskCompleted` |

There is no tool, so a `matcher` is ignored and a handler with `if` never runs: every handler of the event runs. A block of either event sends the agent back; the next final answer is judged again, starting with `Stop` / `SubagentStop`.

Not asked: a run that fails, is cancelled or reaches a limit (nothing was finished), an empty "final answer", an answer that a message the person queued in the meantime replaces, the **ChatGPT Web transport** (the model lives in the chatgpt.com tab and the Hub has no loop of its own that could send it back to work: a web task finishes with none of the three events firing), and the helpers that call the model once and have no loop (`DynamicDelegates`, `StudioDelegates`, `planWithModel`).

**What a hook receives**, besides `session_id`, `cwd`, `permission_mode`, `hook_event_name`, `chatmcp_permission_mode` and `chatmcp_execution_policy`:

| Field | Meaning |
|---|---|
| `stop_hook_active` | `true` once a hook has already sent this run back (Claude Code's name; a script can stop objecting when it sees it) |
| `last_assistant_message` | the model's final answer, cut at 20,000 characters (`chatmcp_last_message_truncated` and `chatmcp_last_message_chars` say so). It is what the model **claims**, not a fact |
| `chatmcp_agent`, `chatmcp_conversation_id`, `chatmcp_run`, `chatmcp_steps` | `main` or `subagent`; the conversation; the number of this run in it; model turns so far |
| `chatmcp_blocks` | `{ used, limit, by_event }`: how often hooks have sent this run back, and the budget |
| `agent_id`, `agent_type` | for an agent that was started by another agent or by the orchestrator: its task id and its role (the role a workflow gave it, `coding_worker`, else `subagent`) |
| `chatmcp_parent_task_id`, `chatmcp_workflow_id`, `chatmcp_phase_id`, `chatmcp_worker_id`, `chatmcp_run_id` | where they apply |
| `task_id`, `task_subject` | (`TaskCompleted`) the task, and the first 200 characters of its goal: the part of the prompt of this run that states the task, not the Hub's own text around a worker's goal |
| `chatmcp_verification`, `chatmcp_completion` | (`TaskCompleted`) what the **Hub** concluded from its own evidence receipts: `ready`, `missing`, `requirements`, `verification` ... It stands next to `last_assistant_message` and is never the same thing: a model that says "all tests pass" has not made `ready` true. `ready: true` means that no evidence the host plan asked for is missing (a task with no plan asked for none, and says so in `reason`); it is not a certificate that the work is right, and `chatmcp_completion.requirements` is `verified` only when the owner accepted the objectives |

**What it can answer.**

| | `Stop`, `SubagentStop`, `TaskCompleted` |
|---|---|
| exit 2, or exit 0 with `{"decision":"block","reason":"..."}` | **block**: the agent goes back to work; stderr (or `reason`) is the message (exit 2 wins over any stdout) |
| exit 0 | the task goes on (stdout is read as JSON; `hookSpecificOutput.additionalContext` is read and **not** sent to the model) |
| exit 1 or any other code, a timeout, a program that cannot be started, a script that is missing, an owner file that is not valid, a runner that fails | **never a block**: the task goes on and the task log gets a `hook_error` event that says why |

`onFailure` has no effect on these three events: sending the agent back would not repair a hook that cannot run (the Claude Code reference says the same). Exit 2 with **nothing on stdout** and a stderr that says "No such file or directory" is what Python prints, and exits 2 for, when it cannot open its script: it is read as that error, not as a block.

**What a block does.** The message reaches the model as a **host message**, `[Hook feedback · Stop · block 1 of 8]`, followed by a line that says it is data from the owner's hook and not from the user (it changes no permission and does not replace the request) and by the hook's text (escape and control characters removed, registered secrets masked, at most 4,000 characters per hook). It is written through the model history ledger, which holds it until the model's turn is over: it lands right behind the answer it is about and in front of a message the person queued while the hook ran. It is never a prompt of the conversation: it selects no skill and no tool schema, and it is not in the dialogue the person reads. It survives the run only as recorded task data, the `hook_blocked` event (the first 300 characters of the reason) and the `[Hook notice]` in the result, which a resume checkpoint or a handoff carries as data about what happened and never as something the person asked. The refused answer is not the result of the task: while the agent works again, the task has no final text and no outcome.

**The loop guard.** At most **8** blocks are honored per **run** (one `start` or `continue` of the conversation), and the three events draw on the same budget (`HookRunner.retryLimit`, 8 like Claude Code's `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`; not a setting of the hooks file). The next objection is not honored: the hook is still asked, the task completes, its result ends with `[Hook notice] The Stop hook blocked 8 times; that is the limit for one run, so DatGold completed the task although a hook still objected (...)` and the task log has a `hook_limit` event. That note is the Hub's own words, not the model's. The runner records where the model's words end when it makes the final text (`finalParts` on the task, `lib/final-text.mjs`), and what shows the model's words alone leaves the note out: the summary of a coding worker (the note is the worker's `runnerHookNotice`, a line of its own on its card in the Agents tab, labelled as the Hub's) and the `claim` of `agent_results` (the note is `hookNotice` under `hubRecord`), the last answer in the handoff a conversation takes to the other transport (the note follows in a line of its own, labelled as the Hub's) and the preview of an agent on the card of a background workflow (the note is `resultNotice`, beside the preview). The main chat shows the text whole, on purpose. A task saved before that record keeps the note inside what it shows. A hook that gives way on the ninth answer leaves no note. The next run of the conversation has a budget of its own. Per run and in total, not "in a row": Claude Code's count resets when the model calls a tool, this one does not, so two hooks that block in turn cannot keep an agent going either.

**While a hook runs.** A cancel, a time limit or a Hub shutdown kills the hook and the process tree it started, and the task ends as cancelled, limit or failed: it does not complete. A hook that hangs is bounded by its `timeout` (default 600 s: give a Stop hook a short one, the task shows as running meanwhile). A message the person queues while a hook runs is delivered, and the task goes on instead of completing. A closed hooks runner (the Hub shutting down) ends the run as failed; any other failure of the runner is a `hook_error`.

**What is recorded.** The task log gets `hook_passed`, `hook_blocked`, `hook_error` and `hook_limit` events, only when a hook ran. The per-task hooks ledger (`HookRunner.taskRecord`) holds every hook that fired, with its decision and exit code.

**This is a quality gate, not a guard.** Unlike `PreToolUse`, these events fail open: a hook that crashes, hangs or is missing does not stop the task from completing (the task log says so), and nothing runs for a run that never reaches a final answer. A rule that must hold belongs in a `PreToolUse` hook or in the permission mode. A block cannot raise a permission either: whatever the model does after it passes the gate as before (in Read Only a write is still refused).

## Project hooks and their approval

A repository can ship `.chatmcp/hooks.json`, but cloning a repository must not make the Hub run its programs. The file is **ignored** until you approve it:

```
POST /api/hooks/approve-project     (behind the Hub bearer, like every /api route)
{ "sha256": "<the sha256 of the file you reviewed>" }
```

The approval is for the project the Hub has open (a caller cannot name another folder), for exactly the bytes whose sha256 you give: if the file is no longer that file the answer is `409 hooks_project_changed` and names the sha256 it has now. A file that does not validate, is over 256 KB or is a symbolic link cannot be approved. The approval is stored in `<Hub data folder>/hooks/state.json`; it belongs to one folder and one content, so **one changed byte switches the file off until you approve the new sha256**, and the same file in another folder is not approved there. A spawned agent in a managed worktree gets the hooks of the project it was spawned from, read from the project, not from the worktree. `.chatmcp/hooks.json` is a protected path: the file tools refuse to read or write it. (A dashboard panel for this comes later; until then compute the hash yourself, for example `Get-FileHash .chatmcp\hooks.json`.)

What the approval pins is **the hooks file, not what it starts**. A project hook that runs `./scripts/guard.sh` is approved while `guard.sh` is whatever the repository contains now; read the scripts too.

## What is recorded

Per task, in `<Hub data folder>/hooks/tasks/<task id>.json` (read it with `HookRunner.taskRecord`): the sha256 of the owner file and of the project file at the first call and again at every change during the task, each hook that fired (event, tool, hook id, decision, exit code, duration, the reason, **no tool input**), and counts. The same module keeps a durable counter of consecutive blocks per task and event (`HookRunner.retryState`), written before a run returns, so a Hub that is killed and restarted continues from the same number. For `Stop`, `SubagentStop` and `TaskCompleted` it is a record only: it belongs to the conversation, survives its next run and is reset by any pass, so the loop guard of the agent loop is a budget per run that the loop keeps itself (see above). The task timeline gets a `hook_denied` step for a refused call.

## Differences from Claude Code

| | Claude Code | DatGold |
|---|---|---|
| Order | the hook is asked before the permission prompt | permission gate first, then the hook (a hook asks you after the gate has) |
| `allow` from a hook | skips the permission prompt | no objection; skips nothing |
| Events | 33 | 6 fired (the three tool events, `Stop`, `SubagentStop`, `TaskCompleted`), the rest accepted and ignored with a warning |
| Handler types | command, http, mcp_tool, prompt, agent | command |
| `updatedInput`, `updatedToolOutput` | applied | not implemented |
| `async` | background | runs synchronously |
| `tool_name` in the payload | `Bash`, `Edit` ... | the DatGold name, with `tool_aliases` |
| `continue: false` | stops the run | on `PreToolUse` a deny |
| `defer` | pauses the call for a later resume | read as `ask` |
| Project hooks | after the workspace trust dialog | after you approve the sha256 of the file |
| Invalid owner file | not described in the reference | refuses the calls a `PreToolUse` hook could have vetoed |
| `onFailure` on `Stop`, `SubagentStop`, `TaskCompleted` | no effect | no effect (a failure never blocks; it is a `hook_error` in the task log) |
| Exit 2 and "No such file or directory" on stderr, nothing on stdout (these three events) | a non-blocking error | the same |
| Loop cap of a `Stop` hook | 8 continuations in a row; the count resets when the model calls a tool; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it | 8 blocks per run in total, shared by `Stop` / `SubagentStop` and `TaskCompleted`, never reset by a tool call; a constant (`HookRunner.retryLimit`); the ninth objection ends the run with a `[Hook notice]` |
| `hookSpecificOutput.additionalContext` of a `Stop` hook | non-error feedback: the conversation continues | read and recorded, not sent to the model |
| Text of a block | the reason is the agent's next instruction | a labelled host message that says it is data from the owner's hook; never a prompt, never in what selects tools and skills |
| `SubagentStop` matcher | filters on `agent_type` | none: every subagent |
| `TaskCompleted` | fires for an item of the task list (`TaskUpdate`, a teammate) | fires when the Hub marks a task completed, for every agent that has a loop; carries the Hub's own assessment (`chatmcp_verification`) beside the model's claim |
| Fields not sent | | `transcript_path`, `agent_transcript_path`, `background_tasks`, `session_crons`, `teammate_name`, `team_name`, `task_description` |

## What is not verified

* How Claude Code itself behaves with these files: the hooks reference was read, no Claude Code was run. Not confirmed from the reference: the `tool_response` of `Edit`, whether an unknown field in a hook's JSON fails validation, whether Claude Code kills the process tree on a timeout, and the exact tool names `Read`, `Glob`, `Grep` and `Task` in a matcher (`Read` is the task's own list; `Glob` and `Grep` are the usual names).
* The POSIX process-group kill (`stopOwned(child, { group: true })`) and the POSIX shell forms were not run on this machine; the Ubuntu CI job is their first run. Windows: exec form, `bash` (Git Bash), `powershell` and `cmd` were run.
* A hook that detaches itself from the process tree (`setsid`, a Windows breakaway process) is not killed by a timeout.
* The lifecycle events were written from the reference as read through a summarising tool, not from the page itself and not by running Claude Code: the field names `stop_hook_active`, `last_assistant_message`, `agent_id`, `agent_type`, `task_id`, `task_subject`, that `onFailure` has no effect on these events, the missing-script rule for exit 2, the 8-continuation cap that resets on a tool call, and what `additionalContext` does on a `Stop` hook. Where the reference may differ the table above says what the Hub does.
* The `Stop` / `TaskCompleted` hooks were exercised with a scripted model on Windows 11 and Node 24 (real hook processes, a real Hub process); no real model, not Linux or Node 22, and not the installed desktop app.
* Not covered, by design: the ChatGPT Web transport (the Hub has no loop to send the web model back into) and the helpers that call the model once (`DynamicDelegates`, `StudioDelegates`, `planWithModel`); a run that fails, is cancelled or reaches a limit does not fire `Stop` (`StopFailure`, `SessionEnd` and the rest of Claude Code's events are not implemented).
