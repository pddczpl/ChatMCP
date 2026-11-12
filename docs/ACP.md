# DatGold as an Agent Client Protocol agent

An editor that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) can start DatGold and drive the Hub through it: you write the request in the editor, the Hub does the work with its own tools, its permission mode and its protections. This page says what the agent does in this version, what it does not do yet, how it behaves as a process, and which test pins each statement. A statement that no test covers says **not tested**.

> **Status: the core, the events and session/load (plan tasks ux-19, ux-20 and ux-21).** Sessions, prompts, cancel, the end of a turn, the lifecycle of the process and the Hub, and what the editor is told while a task runs: tool calls, the plan, the use of the context, and the approvals the Hub asks, answered in the editor with the change the Hub worked out. Also `session/load` (a session of an earlier connection goes on with the same task) and [guides for each editor](#set-it-up-in-an-editor), read from the vendors' own pages. **No editor has been run against it**: the evidence kit is empty, "not run yet" ([evidence/acp-zed](evidence/acp-zed/README.md), [evidence/acp-jetbrains](evidence/acp-jetbrains/README.md)); the client used by the tests is the official TypeScript SDK. What is *not* here is listed under [Not in this version](#not-in-this-version).

## Start it

```
DATGOLD-HUB\windows\chatmcp-acp.cmd [--port 3007] [--state-dir DIR] [--no-start]
node DATGOLD-HUB/lib/acp/agent.mjs   [--port 3007] [--state-dir DIR] [--no-start]
```

The first form is the command an editor launches on Windows (it uses the Node.js that is installed beside the Hub, `runtimes\node\node.exe`, and falls back to `node` from `PATH`); the second is the same program for any system with Node.js 22 or later. It speaks ACP on standard input and standard output and writes its log to standard error. Nothing else is ever written to standard output.

| Option | Meaning |
| --- | --- |
| `--port N` | The port of the Hub (default 3007; the Hub's own range, never 3006). |
| `--state-dir DIR` | The state folder of that Hub (default: the Hub's own, `%LOCALAPPDATA%\ChatMCP\hub` on Windows, or `CHATMCP_STATE_DIR`). |
| `--no-start` | Never start a Hub: use the one that is running, or say that none is. |

Two settings of the wait for the Hub, in milliseconds, for a slow machine or a test: `CHATMCP_ACP_POLL_MS` (how often the task is asked about; 20 to 60000, default 500) and `CHATMCP_ACP_LOST_CONTACT_MS` (how long a Hub that does not answer is waited for before the turn fails; 500 to 600000, default 30000). A value outside the range (or one that is not a whole number) stops the agent with exit code 2 and a sentence; the ends of the ranges are accepted, and an empty value means the default. Tests: `tests/verify-acp-logic.mjs` (the command line), `tests/verify-e2e-acp-connection.mjs` (the refusals and the ends of the ranges, over a real process), `tests/verify-e2e-acp.mjs` (both settings in use).

## How it finds the Hub

| | Attached | Owned |
| --- | --- | --- |
| When | A Hub already answers on the port (the desktop app's, as a rule). | None does, and `--no-start` was not given. |
| What the agent does | Presents itself to it as one more local client. | Starts a Hub as its **child** (`lib/launch.mjs` `launchOwned`, entry `lib/acp/owned-hub.mjs`), output to `hub.log` in the state folder. |
| When the agent ends | The Hub is **never** stopped. The tasks the editor started on it are stopped. | The Hub is stopped, the polite way. |

A port that something else holds (it answers, but not as a DatGold Hub; or it answers nothing) is an error that says so: the agent does not start a Hub there and does not touch the other program. A Hub of a version before the per-launch secret (3.9.0 and older) is never used. Tests: `tests/verify-e2e-acp-lifecycle.mjs` and `tests/verify-e2e-acp-connection.mjs` (every row of this section).

**Authentication** is the one of every local client of the Hub ([HUB-AUTH.md](HUB-AUTH.md), "Clients"): the secret is read from `run/hub-session.json` of the state folder, and it is presented only to the process that owns the listening socket of the port **and** is the one the file names. A program that answers on the port like a Hub while the file names another process (what a crash leaves behind) gets the health probe and nothing else: it never sees the secret. A POST carries the Origin, the request marker and the CSRF token that the Hub asks of the page, exactly as `attachToRunningHub` sends them. Nothing is added to the Hub for this and no rule of it is relaxed. Tests: `tests/verify-e2e-acp-lifecycle.mjs` (a real squatter process, with a stale session file, sees one request and no secret), `tests/verify-e2e-acp-connection.mjs` (a secret the Hub does not take, a session file of another port, a Hub that is still loading, one whose error repeats its secret: the editor gets `[REDACTED]`).

**Which routes it may call** is a list in the code (`ROUTES` in `lib/acp/hub-client.mjs`): `GET /api/health`, `/api/state`, `/api/tasks/<id>`; `POST /api/workspaces/add`, `/api/tasks/start`, `/api/tasks/continue`, `/api/tasks/cancel`, `/api/studio/permissions/decide` (the answer of the editor to an approval request of the task of its own turn, never another task's); and, for a Hub it started itself and for no other, `POST /api/hub/shutdown`. It never calls `/api/workspace/select` (that switches the workspace of the desktop app for everybody), `/api/studio/permissions/config` (the permission mode, Full Access included), or any route that changes settings, files or history. Test: `tests/verify-acp-logic.mjs` (every route of `FORBIDDEN_ROUTES`, which lists these two and the rest, is refused even for a Hub the agent started).

## The protocol

Protocol version **1**. `initialize` answers the version it speaks to a client that asks for the same, a higher or a lower one (the client decides whether to go on). It does not wait for the Hub. Anything other than an integer from 0 to 65535 is `Invalid params`. A second `initialize` is refused. Every other request before `initialize` is `Invalid Request` (-32600). Tests: `tests/verify-acp-logic.mjs`, `tests/verify-e2e-acp.mjs`.

### Capabilities

```json
{
  "loadSession": true,
  "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
  "mcpCapabilities": { "http": false, "sse": false },
  "sessionCapabilities": {}
}
```

`agentInfo` is `{ "name": "datgold", "title": "DatGold", "version": <the version of the Hub> }` and `authMethods` is empty. This block is checked against the code by `tests/verify-acp-logic.mjs`. Nothing is advertised that is not done: an image or audio block is refused with `Invalid params`, and so is an embedded resource if the capability were off.

### `session/new`

`cwd` must be the absolute path of an existing folder; `mcpServers` may be missing or `null`; the servers are **not started** (the Hub has no MCP client yet), and when the editor passed any, the person is told how many, by name. The folder is put in the Hub's list of workspaces (`POST /api/workspaces/add`, idempotent) and is **not selected**: the workspace the Hub has selected, which is the desktop app's, is left where it was. The answer is a session id of the agent's own; no task is started until the first prompt. Tests: `tests/verify-acp-logic.mjs`, `tests/verify-e2e-acp.mjs` (a Hub with project A selected, a session in project B: B is in the list, A is still selected after a whole turn, and the task, its edits and its Git checkpoint are B's).

Two things the person may notice in the desktop app: the folder of every session appears in its list of workspaces, and **a Hub that had no workspace at all takes the folder of the first session as its workspace** (the same as adding a folder there). Test: `tests/verify-e2e-acp-lifecycle.mjs`.

### `session/prompt`

The first prompt of a session starts a task in the folder of the session (`workspacePath`), the next ones continue the same task (one conversation). The turn ends when the Hub says the task is at rest *and* has let go of the workspace; the Hub is asked about the task every 500 ms (`CHATMCP_ACP_POLL_MS`), and about a task that is at rest but still held every 50 ms, because the Hub turns a task "completed" a moment before it lets go. The agent does not use the Hub's stream of events (`GET /api/tasks/events`): in this build it sends nothing (the object the Hub keeps for it has no `subscribe`), which was found with a real Hub and a raw client open before the task. The same stream of one task (`GET /api/tasks/<id>/stream`) opens with a snapshot of the task and carries nothing after it; the desktop app's page opens the first of the two (`useTaskStream`) and lives on its own polling every 2 to 4 seconds, without the streamed text (a defect of the Hub that this change does not touch). `tests/verify-e2e-acp.mjs` pins this as a fact about the Hub: if it fails one day, the Hub got a stream that works. Tasks that the editor did not start (the owner works in the desktop app on the same Hub) are never read. One turn at a time in a session: a prompt while one is running is `Invalid Request` and does not disturb it, **also when the two arrive in the same chunk of the pipe** (the turn is taken before the first thing the agent waits for), and a `session/cancel` right behind its prompt stops that turn. Tests: `tests/verify-acp-logic.mjs`, `tests/verify-e2e-acp.mjs`.

What the content blocks become (`lib/acp/content.mjs`):

| Block | Becomes |
| --- | --- |
| `text` | The prompt, in order, one blank line apart. Never cut: over 100,000 characters (the Hub's limit) is `Invalid params` with the limit in the message. |
| `resource_link` to a file inside the project folder | A line `File in the project: <path from the folder>`. The agent never reads the file for the prompt: the model reads it with the Hub's tools, which have the workspace boundary and the protected files. |
| `resource_link` to a file outside the folder, or to anything else | `File outside the project folder …` / `Link (not fetched): <uri>`. A URL is never fetched because a prompt carries one. |
| `resource` with text | The text between a BEGIN and an END line that say it is data and not instructions, while the whole prompt fits in 100,000 characters. One that does not fit is left out whole and named. The two lines carry a code of 16 hexadecimal digits that is drawn for each prompt (again if the text or its name holds it), and a sentence before the first text says that only an END line with this code ends it: a text that holds an END line of its own, or one with another code, cannot close the fence. The fence tells the model what is data; it is not a guarantee that a model never follows text it reads (RR-8). |
| `resource` with a blob | A line that says it was not sent. |
| a protected file (`.env`, keys, credentials, `.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`: `lib/protected-paths.mjs`), as a link or as embedded text | `Protected file, not sent: <name>`. Its text is **never** in the prompt. A file inside the project is judged by its path from the project folder (the project may itself sit in a folder with a protected name); one outside it by its whole path, every folder of it, and by its name (so `~/.ssh/config` and another repository's `.git/config` are protected); any other URI by its decoded path (a remote `.ssh/config`, a separator sent as `%2F` or `%5C`). What the Hub's rule does not name (for example `.docker/config.json`) is not protected here either. |
| `image`, `audio`, an unknown type | `Invalid params` (not advertised / unknown). |

Every label that goes into the prompt or a note — a title, a name, a URI, a file name, a type — is **one line**: a line break or any other control character (also U+0085, U+2028, U+2029, and `%0A` once a URI is decoded) is shown as an escape such as `
`, and a label is cut after 300 characters, so nothing an editor names can start a line of the prompt. The words of the person are not touched.

The person is told what was left out and why (a notice if the client advertised notices, otherwise an ordinary message). Tests: `tests/verify-acp-logic.mjs` (every row, both ways), `tests/verify-e2e-acp.mjs` (a real prompt with a link, a protected file and an ordinary file: the model's requests are scanned, the text of the ordinary file is found there, the text of `.env` is not). A secret in an *ordinary* file that the person attaches is sent: the protection is by name, as everywhere in the Hub.

### Stop reasons

The state of the Hub's task (`lib/task-state.mjs`) decides. The names are those of `StopReason` in the schema of the protocol, version 1.29.1.

| State of the task | Result of `session/prompt` | And |
| --- | --- | --- |
| `completed` | `end_turn` | what the model said was told as messages while the task ran; the answer is told at the end only for what was not already said (see [What the editor is told while a task runs](#what-the-editor-is-told-while-a-task-runs)), before the response |
| `cancelled` | `cancelled` | |
| `paused` (a limit of steps, time, context or output, or the Hub was restarted) | `max_turn_requests` | a notice that says which limit and that another message continues the task |
| `uncertain` | `end_turn` | a warning: an action may or may not have taken effect, check the changes; the Hub never repeats it by itself |
| `failed` | a JSON-RPC error (-32603) | the reason the Hub gave |
| any other state | an error | the agent never decides that a turn is over without the Hub saying so |

When the client has sent `session/cancel`, the answer is `cancelled` **whatever the task did in the race** (the protocol says it must be). A client that did not advertise `session.notices` gets the same words as an ordinary message, because the protocol forbids a notice to such a client. This table is checked against the code by `tests/verify-acp-logic.mjs`, and the five names against the schema by the same suite and `tests/verify-e2e-acp.mjs` (which also validates every message that was written).

### `session/cancel`

Stops the Hub task (once, however many cancels come), and the prompt answers `cancelled`. A cancel that arrives before the Hub has answered the start, or the continue of an earlier task, waits for the id of the **new run** and then stops it (a cancel is never spent on the run that had ended). The same holds for a connection that closes, and for the end of the agent by a signal, while the Hub is still making the task: the task is stopped the moment it exists. A cancel for no turn, before `initialize`, with parameters that do not fit, or for a session nobody made, does nothing (it is logged). A task that is waiting for an approval is stopped by the Hub, which drops its requests; nothing is written; the question the editor was asked about it is closed when the turn ends and answered to the Hub as a refusal (see [Approvals](#approvals)). Tests: `tests/verify-acp-logic.mjs`, `tests/verify-acp-turn.mjs`, `tests/verify-e2e-acp.mjs` and `tests/verify-e2e-acp-events.mjs` (a real Hub, a real pending approval, nothing on disk).

### `session/load`

A session of an earlier connection (the editor was closed, or started the agent again) goes on where it was. When the first prompt of a session has started its task, the agent keeps
the pair "session, task" in a file of its own, `acp-sessions.json` in the state folder of the Hub (ids and folders only, never what was said; written whole, readable by the owner
only, the 256 most recent). `session/load` with that id and the same folder:

- puts the folder in the Hub's list of workspaces again (never selects it), reads the task from the Hub, and **replays the conversation before it answers**: the messages of the
  person (`user_message_chunk`), the calls with their results and the messages of the model as they happened (the same mapping as a live turn), an answer only for what no message
  said, then the plan. The use of the context is not replayed (it was the size at a moment that has passed);
- answers `{}`; the next prompt continues the same task and tells only what is new.

Refused with a sentence: an id the agent does not know (`Not found`), another folder (`Invalid params`), a folder that does not exist, a session that is open on this connection
(`Invalid Request`), a task the Hub no longer has (`Not found`: start a new session). A file of sessions that cannot be read is taken as empty and logged. Tests:
`tests/verify-acp-load.mjs` (the store, the replay, the agent on a Hub that is a script), `tests/verify-e2e-acp-load.mjs` (a real Hub, the official SDK, two processes of the agent).

### Methods the agent does not offer

`authenticate`, `logout`, `session/list`, `session/resume`, `session/close`, `session/delete`, `session/set_mode`, `session/set_config_option` and every other method answer `Method not found` (-32601). `$/cancel_request` is ignored (the protocol lets an agent ignore it; `session/cancel` is the cancel of ACP).

## What the editor is told while a task runs

The Hub's own streams of events send nothing in this build (see `session/prompt`), so the agent reads the record of the task (`GET /api/tasks/<id>`: its `events`, `usage`, `goalPlan`, `pendingCall`) every 500 ms and says what is new in it. The mapping is a pure function of the record (`createTurnMapper` in `lib/acp/event-map.mjs`), and the record is read in one place, the option `readTask` of `createAcpAgent` (polling by default): once the Hub's stream of events works, that is the one function to replace. Test: `tests/verify-acp-turn.mjs`. A turn that continues a task starts after the events the earlier turn read. If the Hub has dropped events from the record before they were read, the ones it kept are told.

| In the record | The editor is told | Tests |
| --- | --- | --- |
| `tool_start` | `tool_call`: `toolCallId` (the Hub's `callId`), a `title` in plain English ("Read calc.js", "Write 3 files", "Run npm test"; at most 200 characters), a `kind` (below), `status` `in_progress` (`pending` while the Hub waits for an approval of that call), `locations` (the files of the call that are inside the folder of the session, absolute, at most 50) and `rawInput` (the *public input* the Hub records for the call: `path`, `paths`, `source`, `destination`, `command`, and for a push the remote and the branch; never the text of a file, an edit or a patch). | `verify-acp-events`, `verify-acp-turn`, `verify-e2e-acp-events` |
| `tool_result` | `tool_call_update` `completed`, with the words of the result as content (several text blocks one blank line apart; at most 4,000 characters, then "… N characters not shown"; an image in a result is not sent). A result the Hub marks as an error, or that has a status of failure, is `failed`. | the same |
| `tool_error` (a call the owner refused, the permission gate blocked — a protected path, say — or that failed) | `tool_call_update` `failed` with the Hub's words, whatever its status field says. | the same |
| a result whose start was not seen (the Hub dropped it) | the whole call as `tool_call`, already completed or failed. | the same |
| a call that waited for an approval and now executes | `tool_call_update` `in_progress`. | the same |
| `assistant` (a message of the model) | `agent_message_chunk`, as it appears. The record is read every 500 ms, so the grain is one response of the model, not a token. | the same |
| `goalPlan.phases` of the task | `plan`: one entry per phase (`content` the title, `priority` medium, `status` `in_progress` for a phase in work, `completed` for one with evidence, `pending` for the rest), said when it first exists and each time it changes. The `update_plan` tool of the model writes the plan of the workspace's Studio, which is neither in the record of the task nor in the public input of the call: it is **not mapped**. | `verify-acp-events`, `verify-acp-turn` |
| `usage` and `contextPolicy` | `usage_update`: `used` (the input plus the output tokens of the single response added since the last look: the context it filled) and `size` (the window the Hub plans against). Only from numbers the provider reported (no response with missing usage); only when exactly one response was added since the last look (the Hub keeps sums, and the sum of several responses is not the size of the context); only against a window that is neither the Hub's conservative fallback nor an estimate; never a `used` of 0 or above the window. Anything else: nothing — unknown stays unknown. | the same |
| the end of the task | The answer as `agent_message_chunk`, **only for what was not already said** as messages of the model: the sentences of the Hub that follow it (a verification or a hook notice), or the whole answer when no message carried it. | the same |

What is not said: the Hub's own preparation and bookkeeping (`preflight`, `repo_map_*`, `context_budget`, `goal_evidence`, … — its words, not the model's), the arguments of a call beyond the public input, a checkpoint id, and the structured part of a result. The thinking of the model is not told.

**The kind of a call** is by tool name (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`). Every tool of the Hub's catalogs has one: the test reads the catalogs and fails for a tool that nobody gave a kind. A tool of another program (through MCP) is `other`. A tool that only reads is never shown as a change.

**Diffs.** The editor sees a change as a `diff` in the approval request (below). The update of a finished call carries the words of its result, **not** a diff: the Hub's review routes serve only the workspace that the desktop app has selected, which this agent never changes, so for a session in another folder there is no diff to read after the fact. In Autonomous and Full Access mode, where nothing is asked, no diff is shown at all. (Listed under [Not in this version](#not-in-this-version).)

### Approvals

In Review mode the Hub asks the person before a call that changes files runs. A task started from the editor now asks the editor: `session/request_permission` with the call (the id the editor was told, a title, a kind, `status` `pending`, locations, `rawInput`) and **the change the Hub worked out from the files as they are at that moment** ([APPROVAL-PREVIEW.md](APPROVAL-PREVIEW.md)): a `diff` per file (`path` absolute, `oldText` absent for a new file, `newText`; the hunks of a file are joined by a line of dots; at most 20 files and 200,000 characters a side) and, in words, what the Hub left out (rows, files), a file whose old content is not text, a call that the Hub would refuse when it runs, a change of line endings only, and private key material (what the model wrote of it is not shown). Two options: **Allow** (`allow_once`) and **Reject** (`reject_once`).

- Only `allow_once` allows. A rejection, a cancellation, an option nobody offered and an answer that cannot be read **refuse**, and so does an editor that cannot be asked at all (the person is told: "The editor could not be asked").
- Each request is asked once, and only the requests of the task of the turn: another task of the same Hub is never asked about or answered. The answer reaches the Hub by `POST /api/studio/permissions/decide`. If the person answered in the desktop app first, the Hub no longer has the request: the late answer of the editor finds nothing to decide and is logged.
- The editor has until the request expires (the Hub gives 10 minutes), at least a second and at most 15 minutes (`answerWindowMs`). A question that is still open when the turn ends — after a cancel, for instance — is closed at once and answered to the Hub as a refusal; the answer of the editor to it (the protocol makes it answer "cancelled") then harms nothing.
- The request passes the same masking as everything else that leaves: a key in the planned change is `[REDACTED]`, the name of the setting stays. A protected file is refused by the Hub before anyone is asked: there is no approval for it.

Tests: `tests/verify-acp-permissions.mjs` (the request in all its shapes, the answer, the time), `tests/verify-acp-turn.mjs` (the agent on a Hub that is a script: asked once, allow, reject, cancelled, unreadable, an editor that cannot be asked, answered elsewhere, another task's, a cancel, a failing Hub, masking), `tests/verify-e2e-acp-events.mjs` (a real Hub in Review mode with a scripted model and the official SDK: the write and the edit ask, "allow" writes the file, "reject" and "cancelled" write nothing, a command with a password, a key in a file the model writes, private key material, a protected `.env`, a cancel while the editor is asked, the same approval answered in the desktop app first, a second turn that tells only what is new). The permission modes stay the Hub's: Autonomous asks nothing, Read Only refuses writes, Full Access is Full Access; the agent never changes the mode.

## What the Hub decides, not the agent

The agent adds no authority. A task started from the editor runs under the permission mode of the Hub: Review asks, Autonomous does not, Read Only refuses writes, Full Access is Full Access. The agent never changes the mode. When a task needs an approval (Review mode), the editor is asked and its answer is the answer ([Approvals](#approvals)); the request is also visible in the desktop window, and whichever answers first decides.

Things about the Hub that matter to an editor user (all read from the Hub's code; the first is exercised by `tests/verify-e2e-acp.mjs`, the rest are **not tested**):

- A conversation that runs in a folder other than the Hub's selected one has the permission mode that the Hub had when that conversation **started**; changing the mode later does not reach it.
- A second task in a folder that already has one running does not share it: it runs in its own Git worktree (`chatmcp/chat/<id>` under the Hub's state folder), which needs a Git repository with at least one commit (otherwise `git_required`), and in Review mode creating that worktree is itself an approval. Its edits are in the worktree, not in the editor's folder.
- A task for the folder the Hub has selected runs in that folder when the Hub is idle.

## What leaves the agent

Everything that is sent to the editor — a message, a response, an error, a notice, an update and the question of an approval — and every line of the log goes through **one** function that masks the *decoded* values (`lib/acp/mask.mjs`: the Hub's `maskSecrets` on every string, never on JSON text, where a double-quoted secret is not seen). It also masks the two credentials the agent holds itself, the bearer of the Hub and its CSRF token, by value. Keys of objects, ids, paths, URIs and the other words an editor acts on pass through unchanged (tested with names that say token and password). `safePreview`, which stringifies before it masks, is not used. Tests: `tests/verify-acp-logic.mjs` (the function, and a scan of the agent's source for the one place a message can leave), `tests/verify-e2e-acp.mjs` (the bearer and the CSRF token of a real Hub are in neither stdout nor stderr; the text of a protected file is in neither). The mask is a pattern mask: a secret in a spelling nobody listed is not hidden ([APPROVAL-PREVIEW.md](APPROVAL-PREVIEW.md) lists what it covers and what it does not).

## The process

| What happens to the agent | What happens to a Hub it started | Test |
| --- | --- | --- |
| The editor closes its end (stdin ends) | Stopped the polite way: the process is gone, the port is closed, the session file is removed. The agent exits with code 0. | `verify-e2e-acp-lifecycle` |
| The agent is killed alone (no tree) | **Gone with it.** On Windows the system ends a child that Node started when the Node parent ends, whatever ends it (a job object that Node makes): at once, with no handler run, so the session file is left, as after a crash. Elsewhere the pipe the agent held breaks and the Hub stops the polite way. | `verify-e2e-acp-lifecycle` (observed on Windows; the polite path of the pipe is tested directly on every system) |
| The whole process tree is killed (what an editor does) | Gone with it. | `verify-e2e-acp-lifecycle` |
| The Hub the agent started is killed on its own | The agent goes on; at its end it asks the Hub to stop, finds nothing, and exits with code 0 with nothing uncaught. A Hub that obeys neither the shutdown route nor the end of its pipe is killed after ten seconds; one that does not come up in time, or exits, is stopped again; a process that ends with an uncaught error takes its Hub with it (the exit handler). | `verify-e2e-acp-connection` |
| `SIGTERM` (not Windows) | Stopped the polite way; exit code 0. | `verify-e2e-acp-lifecycle` |
| The Hub dies in the middle of a turn | The prompt ends with an error that says contact was lost (after `CHATMCP_ACP_LOST_CONTACT_MS`, or at once if the Hub was started by the agent and its process ended); the agent stays up, stdout stays protocol, the next request gets an error of its own. | `verify-e2e-acp` |
| An attached Hub, however the agent ends | **Never stopped.** | `verify-e2e-acp`, `verify-e2e-acp-lifecycle` |

The mechanism for a Hub the agent started is `launchOwned` in `lib/launch.mjs` and `lib/acp/owned-hub.mjs`: the Hub is a child with a pipe on its standard input that the agent holds and never writes to; when the agent ends the pipe breaks, and the Hub — which watches that pipe and then takes the way of `SIGTERM` — shuts down. Port 3007 is the default of the *product*; no test uses it (every Hub and every agent of the tests has a random port and a state folder of its own).

### What an editor, or a broken one, can send

Each of these has a defined answer and the next request is served ([lib/acp/rpc.mjs](../DATGOLD-HUB/lib/acp/rpc.mjs), `tests/verify-acp-rpc.mjs`, and over a real process `tests/verify-e2e-acp.mjs`): invalid JSON or invalid UTF-8 (`Parse error` -32700, id `null`); a batch, a number, a wrong envelope, a bad id (`Invalid Request`, id `null` unless the id is a string or a safe integer); a line over **32 MiB** (`Invalid Request` "Message too large" the moment the limit is passed; the rest of the line is dropped as it arrives, never kept — so the agent holds at most the limit plus one chunk of input); an id that is already in flight (refused with id `null`, so it cannot be taken for the answer of the first); an unknown method (`Method not found`); an unknown notification (ignored in silence on stdout, logged). A byte order mark at the start of the stream, CRLF and blank lines are tolerated. Whatever the Hub or a library prints can never reach standard output: from the start, every other write to it is sent to standard error. Requests that arrive in one chunk of the pipe are served in order and nothing runs between them: 300 `session/new` in one chunk make 256 sessions (the limit counts the ones still being made) and 44 refusals. Beyond that, the number of concurrent requests is **not limited and not tested at scale**.

## Set it up in an editor

**None of this has been run in a real editor yet** (the evidence kit is in [evidence/acp-zed](evidence/acp-zed/README.md) and [evidence/acp-jetbrains](evidence/acp-jetbrains/README.md), both "not run yet"). Each fact below was read on the vendor's own page or in the project's own repository on 2026-11-07, unless it is marked **derived** (a reading of the vendor's source code or release tags, not a vendor statement) or **not verified**.

Every editor below starts the agent as a program with arguments. The guides use the Node.js that the installation ships, `<install>\runtimes\node\node.exe`, and the script `<install>\DATGOLD-HUB\lib\acp\agent.mjs`; `<install>` is written `C:\Program Files\DatGold`: replace it with the real folder. Plain `node` works where Node.js 22 or later is on `PATH`. Write literal absolute paths: no source shows `~`, `%LOCALAPPDATA%` or `${...}` being expanded in these files (**not verified**). Launching `windows\chatmcp-acp.cmd` as the command is shown by no vendor page (**not verified**). Options (`--port`, `--no-start`, `--state-dir`) go into the same list of arguments.

### Zed

Entries under `agent_servers` in `settings.json` (command palette: `zed: open settings file`), each with `"type": "custom"`, `command`, `args` and `env` ([zed.dev/docs/ai/external-agents](https://zed.dev/docs/ai/external-agents)). Pick the agent in the Agent Panel (the agent selector or the New Thread menu); `dev: open acp logs` shows the messages. Windows is supported, ACP agents included ([zed.dev/blog/zed-for-windows-is-here](https://zed.dev/blog/zed-for-windows-is-here)). The vendor states no minimum version; the `"type": "custom"` form needs a build from December 2025 or later (**derived** from release tags: v0.215.3).

```json
{
  "agent_servers": {
    "DatGold": {
      "type": "custom",
      "command": "C:\\Program Files\\DatGold\\runtimes\\node\\node.exe",
      "args": ["C:\\Program Files\\DatGold\\DATGOLD-HUB\\lib\\acp\\agent.mjs"],
      "env": {}
    }
  }
}
```

### JetBrains IDEs (AI Assistant)

The file `~/.jetbrains/acp.json` (on Windows `C:\Users\<username>\.jetbrains\acp.json`), created by "Add Custom Agent" in the menu of the AI Chat tool window; a top-level `agent_servers` object, each value with `command` (a full path), `args`, `env`, and **no** `type` key ([jetbrains.com/help/ai-assistant/acp.html](https://www.jetbrains.com/help/ai-assistant/acp.html)). ACP agents are in AI Assistant since 2025.3 (the registry since 2025.3.2), not only from 2026.2. No JetBrains AI subscription is needed for ACP agents. ACP agents are **not supported in WSL** in AI Assistant (the separate "Air" surface documents a WSL option: not covered here). Whether a free JetBrains Account sign-in is still needed: **not verified**.

```json
{
  "agent_servers": {
    "DatGold": {
      "command": "C:\\Program Files\\DatGold\\runtimes\\node\\node.exe",
      "args": ["C:\\Program Files\\DatGold\\DATGOLD-HUB\\lib\\acp\\agent.mjs"]
    }
  }
}
```

### Neovim

Three plugins document a custom command ([agentclientprotocol.com/get-started/clients](https://agentclientprotocol.com/get-started/clients.md)); none shows a Windows example, so the paths are ours.

- **avante.nvim**: `acp_providers` maps a name to `command`, `args`, `env`; choose it with `:AvanteSwitchProvider` ([github.com/yetone/avante.nvim](https://github.com/yetone/avante.nvim)).
- **agentic.nvim**: `acp_providers` with `name`, `command` (on `PATH` or absolute), `args`, `env`; `provider = "<key>"` ([github.com/carlos-algms/agentic.nvim](https://github.com/carlos-algms/agentic.nvim)).
- **CodeCompanion**: a custom adapter under `adapters.acp` returning `commands.default` (the program, then its arguments) ([codecompanion.olimorris.dev](https://codecompanion.olimorris.dev/configuration/adapters-acp.md)). It sends `authenticate` only when the agent lists a method, so the empty list of DatGold is fine.

```lua
-- avante.nvim
acp_providers = {
  ["datgold"] = {
    command = "C:/Program Files/DatGold/runtimes/node/node.exe",
    args = { "C:/Program Files/DatGold/DATGOLD-HUB/lib/acp/agent.mjs" },
  },
},
```

### Emacs

**agent-shell** (on MELPA, built on acp.el, which calls itself "in the very early stages") is the client the ACP site lists ([github.com/xenodium/agent-shell](https://github.com/xenodium/agent-shell)). Its README has no recipe for an agent it does not bundle. The form below follows the package's own source and is **derived and untested**; it uses an internal function (two dashes) that may change.

```elisp
(defun my/agent-shell-datgold-config ()
  (agent-shell-make-agent-config
   :identifier 'datgold :mode-line-name "DatGold" :buffer-name "DatGold"
   :shell-prompt "DatGold> " :shell-prompt-regexp "DatGold> "
   :client-maker (lambda (buffer)
                   (agent-shell--make-acp-client
                    :command "C:/Program Files/DatGold/runtimes/node/node.exe"
                    :command-params '("C:/Program Files/DatGold/DATGOLD-HUB/lib/acp/agent.mjs")
                    :environment-variables (agent-shell-make-environment-variables :inherit-env t)
                    :context-buffer buffer))))
(add-to-list 'agent-shell-agent-configs #'my/agent-shell-datgold-config)
```

### VS Code

VS Code has **no built-in ACP client** (the request microsoft/vscode#265496 is open; VS Code's own "Agent Host Protocol" is a different protocol). The community extension **ACP Client** (formulahendry, MIT, last updated 2026-05-16) reads the user setting `acp.agents` (each value with `command`, `args`, `env`); "ACP: Add Agent Configuration" writes it ([github.com/formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp)). Whether that setting replaces or adds to the extension's default agents: **not verified**.

```json
{
  "acp.agents": {
    "DatGold": {
      "command": "C:\\Program Files\\DatGold\\runtimes\\node\\node.exe",
      "args": ["C:\\Program Files\\DatGold\\DATGOLD-HUB\\lib\\acp\\agent.mjs"],
      "env": {}
    }
  }
}
```

### The ACP Registry

DatGold is **not** in the registry and nothing was submitted. Its CI refuses an agent whose `initialize` answers an empty `authMethods`, and asks for an npm, PyPI or binary distribution that starts without an installed Hub, a 16x16 monochrome `icon.svg` and a reachable `license_url` ([github.com/agentclientprotocol/registry](https://github.com/agentclientprotocol/registry), CONTRIBUTING.md). What would have to change, and the text prepared for the day it does, are in [ACP-REGISTRY.md](ACP-REGISTRY.md).

## Not in this version

- **Diffs after a write**, and a diff at all where nothing is asked (Autonomous, Full Access): the update of a finished call carries the words of its result. The Hub's review routes serve only the workspace the desktop app has selected; reading them for the folder of a session would mean selecting it, which this agent never does.
- **The plan the model writes with `update_plan`** (the Studio plan of the workspace) and **the thinking of the model**: the editor is told the plan of the task (`goalPlan`) only.
- **A word-by-word stream**: the record is read every 500 ms, so what the model says arrives one response at a time, until the Hub's own stream works (see `session/prompt`).
- Session lists, modes, config options.
- **MCP servers** passed in `session/new` or `session/load` are not started (the Hub has no MCP client yet); the person is told.
- **Images and audio** in a prompt.
- **A run in a real editor**: the guides above are read from the vendors' pages, and the evidence kit is empty (not run yet).
- **The connection to the Hub is made again when it can no longer be used**: an attached Hub that no longer takes the session of the agent (the desktop app was restarted: a new secret) ends the running turn at once with a sentence, and the next request reads the session file again and checks the listener again; so does an attached Hub that cannot be reached. A Hub that the agent started and that has ended is started again by the next request. A Hub that answers with a refusal of its own (a limit, a busy Hub) is kept. Tests: `tests/verify-acp-logic.mjs`.
- **256 sessions on one connection**: when it is full, the oldest session without a running turn is closed (and logged) to make room; when every session has a turn, `session/new` is refused with the number. Test: `tests/verify-acp-logic.mjs`.

## Verified, and not

| | |
| --- | --- |
| Protocol | ACP version 1, schema **v1.29.1** (`schema/v1/schema.json` of the `agent-client-protocol` repository, tag `schema-v1.29.1`, 256,258 bytes, sha256 `0d0b1ca83c4872e5473f68926a894c7a8203b59b118e2a79bfe43dd76fbcbc1a`, the same bytes as the file inside the SDK below). The tests validate every message the agent wrote against the pinned copy in `DATGOLD-HUB/lib/acp/schema/` (Apache-2.0; `SOURCE.json` records the package, the version, the integrity, the tag of the protocol repository and the sha256; `tests/verify-acp-schema.mjs` checks the copy against that record, the installed SDK and the lock file, and the notices that say it is redistributed), by the method each message belongs to (the root of the schema accepts nearly anything). |
| Client in the tests | `@agentclientprotocol/sdk` **2.4.0** (Apache-2.0), exact version, installed from `DATGOLD-HUB/tests/acp-tools` (`npm ci --ignore-scripts --prefix DATGOLD-HUB/tests/acp-tools`; its own lock file, and ajv 8.20.0 with zod 4.6.7). It is a test tool: the installer ships nothing from `tests/` and the agent has **no runtime dependency**. `ClientSideConnection` of the 1.x line was removed in 2.0; the tests use `client()`. |
| Not verified | Any real editor (Zed, JetBrains AI Assistant, Neovim, Emacs, VS Code). Protocol version 2 (a draft; the agent answers 1). Behaviour with a client that sends requests faster than the Hub answers (**not tested**). The POSIX branches of the process rules (the polite end of an agent killed alone, `SIGTERM`, the handler of a broken pipe to a Hub that died, the exit handler on Linux) were written for Linux and macOS and run on Windows only before the first run of the CI, which runs them on Ubuntu. |

## Tests and mutation lists

`tests/verify-acp-rpc.mjs` (the wire), `tests/verify-acp-logic.mjs` (masking, stop reasons, content, parameters, the Hub client's routes and sentences, the agent on a scripted Hub), `tests/verify-e2e-acp.mjs` (a real Hub with a scripted model and the official SDK), `tests/verify-e2e-acp-lifecycle.mjs` (the agent as a process: how it ends, and what that does to its Hub) and `tests/verify-e2e-acp-connection.mjs` (how it finds, starts and loses a Hub: launchOwned, the refusals, the program, a Hub that is a script, the two methods that read and answer the approvals). The events: `tests/verify-acp-events.mjs` (the mapping of a record to updates, with a real record), `tests/verify-acp-permissions.mjs` (the approval request, the answer, the time), `tests/verify-acp-turn.mjs` (updates and approvals on a Hub that is a script) and `tests/verify-e2e-acp-events.mjs` (a real Hub in Review mode); the pinned schema: `tests/verify-acp-schema.mjs`; and session/load: `tests/verify-acp-load.mjs` and `tests/verify-e2e-acp-load.mjs`. The suites that need the SDK print `CHATMCP_TEST_SKIP` when it is not installed, which the CI runs (`--no-skip all`) count as a failure. Mutation lists (`node tests/mutation/run-mutations.mjs tests/mutation/<list>.json`): `acp-rpc.json`, `acp-mask.json`, `acp-stop-reason.json`, `acp-content.json`, `acp-validate.json`, `acp-hub-client.json`, `acp-agent.json`, `acp-lifecycle.json`, `acp-connection.json`, `acp-e2e.json`, and for the events `acp-events.json`, `acp-permissions.json`, `acp-turn.json`, `acp-hub-client-approvals.json` and `acp-schema.json`, and for session/load `acp-load.json` and `acp-e2e-load.json`.
