# Hooks

A hook is a program that **you** configured and the Hub starts around a tool call: before it (`PreToolUse`), after it (`PostToolUse`, `PostToolUseFailure`) and, once the agent loop is wired to them, when a task stops (`Stop`, `TaskCompleted`, `SubagentStop`). A `PreToolUse` hook can veto a call or ask you to confirm it; a `PostToolUse` hook can hand the model a note about what just happened. A hook never grants anything: it is a second pair of eyes on top of the permission gate, not a way around it.

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

* **Events.** `PreToolUse`, `PostToolUse`, `PostToolUseFailure` fire for every tool call. `Stop`, `TaskCompleted`, `SubagentStop` are accepted and the runner executes them (exit 2 blocks, a retry counter caps the loop), but the agent loop does not call them yet. Any other Claude Code event name is accepted and ignored with a warning, so a settings file can be pasted in; a name that is not a Claude Code event (a typo) is an error.
* **`matcher`** (tool events only). Empty, `*` or absent: every tool. Only letters, digits, `_ - , |` and spaces: an exact name or a list (`Edit|Write`). Anything else: an unanchored JavaScript regular expression. A tool answers to its ChatMCP name (`local.run_command`) **and** to its Claude Code name:

  | Claude Code | ChatMCP tools |
  |---|---|
  | `Bash` | `local.run_command` |
  | `Edit` | `local.edit_file`, `local.files_apply_patch` |
  | `Write` | `local.write_file`, `local.files_write_batch` |
  | `Read` | `local.read_file` |
  | `Glob` / `Grep` | `local.find_files` / `local.search_files` |
  | `mcp__server__tool` | the tool `tool` of an external server `server` |

  A ChatMCP tool with no row (`local.move_path`, `local.delete_path`, `local.git_*`, `local.tasks_run`, `studio.*` ...) is matched by its ChatMCP name only: a matcher of `Edit|Write` does **not** see them.
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
| `tool_name` | the **ChatMCP** name, e.g. `local.run_command` (the Claude Code name is in `tool_aliases`) |
| `tool_input` | the arguments of the call; for `local.write_file`, `local.edit_file`, `local.read_file` also `file_path`, absolute, as Claude Code scripts expect |
| `tool_use_id` | one id for the `Pre` and the `Post` hook of a call |
| `tool_response` | (`PostToolUse`) the result of the tool; `error` (`PostToolUseFailure`) its message |
| `tool_aliases`, `chatmcp_permission_mode`, `chatmcp_execution_policy` | ChatMCP additions |

Not sent: `transcript_path`, `prompt_id`, `effort`, `agent_id`, `agent_type`. The JSON is cut to about 1 MiB (long strings are shortened and `chatmcp_truncated` is `true`). The environment is the Hub's **after `scrubEnv`**: variables whose name says key, token, secret, password or credential, URLs with a password and values equal to a registered secret are gone (the Hub's own `OPENAI_API_KEY` is not visible to a hook), and `CLAUDE_PROJECT_DIR` and `CHATMCP_PROJECT_DIR` are added. The stdin JSON is **not** masked: a hook sees exactly what the tool receives.

## What a hook returns

| Exit code | `PreToolUse` | `PostToolUse`, `PostToolUseFailure` | `Stop`, `TaskCompleted`, `SubagentStop` |
|---|---|---|---|
| 0 | stdout is read if it is one JSON object | same | same |
| 2 | **deny**; stderr is the reason (stdout JSON cannot override it) | the tool already ran: stderr becomes feedback to the model | **block**; stderr is the reason |
| anything else, a timeout, a program that cannot be started | nothing, unless `onFailure` is `"block"`: then deny | nothing, unless `onFailure` is `"block"`: feedback that the hook failed | nothing, unless `onFailure` is `"block"`: block |

JSON on exit 0 (everything else in it is ignored and listed by name in the record):

* `PreToolUse`: `hookSpecificOutput` with `hookEventName: "PreToolUse"`, `permissionDecision` (`allow`, `deny`, `ask`; `defer` is read as `ask`) and `permissionDecisionReason`; or the older top-level `decision: "block"` (deny) / `"approve"` (allow) with `reason`; `continue: false` is a deny.
* `PostToolUse`, `PostToolUseFailure`: `hookSpecificOutput.additionalContext` (cut at 10,000 characters) and top-level `decision: "block"` with `reason` (feedback).
* Stop family: `decision: "block"` with `reason`.
* Output that is not one JSON object (text before or after it, an array, text only) is ignored. **Stdout is cut at 64 KB and a cut stdout is never read**: to veto a call from a script that prints a lot, exit 2.
* Everything a hook prints is cleaned before it goes anywhere: escape sequences, control and bidirectional characters are removed, registered secrets and token-shaped strings are masked, reasons are cut at 4,000 characters.

Hooks of one event run in parallel; among `PreToolUse` decisions **deny beats ask beats allow**. The model sees the added text as a separate part of the tool result, labelled `[Hook context · PostToolUse]` or `[Hook feedback · PostToolUse]`; `isError` and `structuredContent` of the result are not touched.

## What a hook can and cannot do

The permission gate decides first. The hooks are asked next, **for every call that passed argument validation, including a call the gate refused**, and only then are the caller told, the timeline written and a checkpoint made:

* A hook **can** refuse a call the gate allowed (`hook_denied`, `executed: false`, the same shape as a gate refusal) and **can** make the gate ask you about a call it would have let through (`PermissionGate.authorize({ forceAsk })`: the question shows the hook's reason). The question is asked at most once per call: when the gate already asked you, the hook's `ask` is satisfied by your answer.
* A hook **cannot** turn a refusal of the gate into an approval, and its `allow` skips nothing: in Read Only an edit is refused whatever the hook says; in Review you are still asked. Where nobody can answer (a spawned agent in Autonomous or Full Access, a coding worker) a forced question is refused at once instead of waiting for the approval timeout.
* A hook **cannot** change the arguments of a call or the result of a tool (`updatedInput`, `updatedToolOutput`: not implemented, ignored), and nothing in its output touches a permission setting: the output is read through a fixed list of fields.
* If the hooks runner itself fails before the tool runs, the call is refused (`hook_denied`); after the tool ran, the result is returned as it is.

Covered: every call that goes through the guarded session, that is the dashboard agent, a spawned agent (`spawn_agent`) and its own tools, a coding worker and the ChatGPT Web Companion, on the primary workspace and on a second one. With the Companion the hook's context is part of the tool result that goes to chatgpt.com, so it passes the same outbound filter as any other result. **Not covered**: the `spawn_agent` / `spawn_workflow` calls themselves (the agent loop runs them outside the guard), what the Hub runs on its own account (checkpoints, the verification run of a worker's checks).

## Project hooks and their approval

A repository can ship `.chatmcp/hooks.json`, but cloning a repository must not make the Hub run its programs. The file is **ignored** until you approve it:

```
POST /api/hooks/approve-project     (behind the Hub bearer, like every /api route)
{ "sha256": "<the sha256 of the file you reviewed>" }
```

The approval is for the project the Hub has open (a caller cannot name another folder), for exactly the bytes whose sha256 you give: if the file is no longer that file the answer is `409 hooks_project_changed` and names the sha256 it has now. A file that does not validate, is over 256 KB or is a symbolic link cannot be approved. The approval is stored in `<Hub data folder>/hooks/state.json`; it belongs to one folder and one content, so **one changed byte switches the file off until you approve the new sha256**, and the same file in another folder is not approved there. A spawned agent in a managed worktree gets the hooks of the project it was spawned from, read from the project, not from the worktree. `.chatmcp/hooks.json` is a protected path: the file tools refuse to read or write it. (A dashboard panel for this comes later; until then compute the hash yourself, for example `Get-FileHash .chatmcp\hooks.json`.)

What the approval pins is **the hooks file, not what it starts**. A project hook that runs `./scripts/guard.sh` is approved while `guard.sh` is whatever the repository contains now; read the scripts too.

## What is recorded

Per task, in `<Hub data folder>/hooks/tasks/<task id>.json` (read it with `HookRunner.taskRecord`): the sha256 of the owner file and of the project file at the first call and again at every change during the task, each hook that fired (event, tool, hook id, decision, exit code, duration, the reason, **no tool input**), and counts. The same module keeps a durable counter of consecutive blocks per task and event (`HookRunner.retryState`, cap 8 as in Claude Code), written before a run returns, so a Hub that is killed and restarted continues from the same number. The task timeline gets a `hook_denied` step for a refused call.

## Differences from Claude Code

| | Claude Code | ChatMCP |
|---|---|---|
| Order | the hook is asked before the permission prompt | permission gate first, then the hook (a hook asks you after the gate has) |
| `allow` from a hook | skips the permission prompt | no objection; skips nothing |
| Events | 33 | 3 fired, 3 accepted and run when the agent loop calls them, the rest ignored with a warning |
| Handler types | command, http, mcp_tool, prompt, agent | command |
| `updatedInput`, `updatedToolOutput` | applied | not implemented |
| `async` | background | runs synchronously |
| `tool_name` in the payload | `Bash`, `Edit` ... | the ChatMCP name, with `tool_aliases` |
| `continue: false` | stops the run | on `PreToolUse` a deny |
| `defer` | pauses the call for a later resume | read as `ask` |
| Project hooks | after the workspace trust dialog | after you approve the sha256 of the file |
| Invalid owner file | not described in the reference | refuses the calls a `PreToolUse` hook could have vetoed |

## What is not verified

* How Claude Code itself behaves with these files: the hooks reference was read, no Claude Code was run. Not confirmed from the reference: the `tool_response` of `Edit`, whether an unknown field in a hook's JSON fails validation, whether Claude Code kills the process tree on a timeout, and the exact tool names `Read`, `Glob`, `Grep` and `Task` in a matcher (`Read` is the task's own list; `Glob` and `Grep` are the usual names).
* The POSIX process-group kill (`stopOwned(child, { group: true })`) and the POSIX shell forms were not run on this machine; the Ubuntu CI job is their first run. Windows: exec form, `bash` (Git Bash), `powershell` and `cmd` were run.
* A hook that detaches itself from the process tree (`setsid`, a Windows breakaway process) is not killed by a timeout.
