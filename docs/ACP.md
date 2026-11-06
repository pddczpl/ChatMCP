# DatGold as an Agent Client Protocol agent

An editor that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) can start DatGold and drive the Hub through it: you write the request in the editor, the Hub does the work with its own tools, its permission mode and its protections. This page says what the agent does in this version, what it does not do yet, how it behaves as a process, and which test pins each statement. A statement that no test covers says **not tested**.

> **Status: the core (plan task ux-19).** Sessions, prompts, cancel, the end of a turn, the lifecycle of the process and the Hub. What is *not* here yet is listed under [Not in this version](#not-in-this-version): tool calls, diffs and plans as they happen, approvals answered in the editor, `session/load`, editor set-up guides. No editor has been run against it (the evidence kit for that is a later change); the client used by the tests is the official TypeScript SDK.

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

**Which routes it may call** is a list in the code (`ROUTES` in `lib/acp/hub-client.mjs`): `GET /api/health`, `/api/state`, `/api/tasks/<id>`; `POST /api/workspaces/add`, `/api/tasks/start`, `/api/tasks/continue`, `/api/tasks/cancel`; and, for a Hub it started itself and for no other, `POST /api/hub/shutdown`. It never calls `/api/workspace/select` (that switches the workspace of the desktop app for everybody), `/api/studio/permissions/config` (the permission mode, Full Access included), or any route that changes settings, files or history. Test: `tests/verify-acp-logic.mjs` (every route of `FORBIDDEN_ROUTES`, which lists these two and the rest, is refused even for a Hub the agent started).

## The protocol

Protocol version **1**. `initialize` answers the version it speaks to a client that asks for the same, a higher or a lower one (the client decides whether to go on). It does not wait for the Hub. Anything other than an integer from 0 to 65535 is `Invalid params`. A second `initialize` is refused. Every other request before `initialize` is `Invalid Request` (-32600). Tests: `tests/verify-acp-logic.mjs`, `tests/verify-e2e-acp.mjs`.

### Capabilities

```json
{
  "loadSession": false,
  "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
  "mcpCapabilities": { "http": false, "sse": false },
  "sessionCapabilities": {}
}
```

`agentInfo` is `{ "name": "datgold", "title": "DatGold", "version": <the version of the Hub> }` and `authMethods` is empty. This block is checked against the code by `tests/verify-acp-logic.mjs`. Nothing is advertised that is not done: an image or audio block is refused with `Invalid params`, and so is an embedded resource if the capability were off.

### `session/new`

`cwd` must be the absolute path of an existing folder; `mcpServers` may be missing or `null`, and is **not used** (see below). The folder is put in the Hub's list of workspaces (`POST /api/workspaces/add`, idempotent) and is **not selected**: the workspace the Hub has selected, which is the desktop app's, is left where it was. The answer is a session id of the agent's own; no task is started until the first prompt. Tests: `tests/verify-acp-logic.mjs`, `tests/verify-e2e-acp.mjs` (a Hub with project A selected, a session in project B: B is in the list, A is still selected after a whole turn, and the task, its edits and its Git checkpoint are B's).

Two things the person may notice in the desktop app: the folder of every session appears in its list of workspaces, and **a Hub that had no workspace at all takes the folder of the first session as its workspace** (the same as adding a folder there). Test: `tests/verify-e2e-acp-lifecycle.mjs`.

### `session/prompt`

The first prompt of a session starts a task in the folder of the session (`workspacePath`), the next ones continue the same task (one conversation). The turn ends when the Hub says the task is at rest *and* has let go of the workspace; the Hub is asked about the task every 500 ms (`CHATMCP_ACP_POLL_MS`), and about a task that is at rest but still held every 50 ms, because the Hub turns a task "completed" a moment before it lets go. The agent does not use the Hub's stream of events (`GET /api/tasks/events`): in this build it sends nothing (the object the Hub keeps for it has no `subscribe`), which was found with a real Hub and a raw client open before the task. The same stream of one task (`GET /api/tasks/<id>/stream`) opens with a snapshot of the task and carries nothing after it; the desktop app's page opens the first of the two (`useTaskStream`) and lives on its own polling every 2 to 4 seconds, without the streamed text (a defect of the Hub that this change does not touch). `tests/verify-e2e-acp.mjs` pins this as a fact about the Hub: if it fails one day, the Hub got a stream that works. Tasks that the editor did not start (the owner works in the desktop app on the same Hub) are never read. One turn at a time in a session: a prompt while one is running is `Invalid Request` and does not disturb it, **also when the two arrive in the same chunk of the pipe** (the turn is taken before the first thing the agent waits for), and a `session/cancel` right behind its prompt stops that turn. Tests: `tests/verify-acp-logic.mjs`, `tests/verify-e2e-acp.mjs`.

What the content blocks become (`lib/acp/content.mjs`):

| Block | Becomes |
| --- | --- |
| `text` | The prompt, in order, one blank line apart. Never cut: over 100,000 characters (the Hub's limit) is `Invalid params` with the limit in the message. |
| `resource_link` to a file inside the project folder | A line `File in the project: <path from the folder>`. The agent never reads the file for the prompt: the model reads it with the Hub's tools, which have the workspace boundary and the protected files. |
| `resource_link` to a file outside the folder, or to anything else | `File outside the project folder …` / `Link (not fetched): <uri>`. A URL is never fetched because a prompt carries one. |
| `resource` with text | The text between two marks that say it is data and not instructions, while the whole prompt fits in 100,000 characters. One that does not fit is left out whole and named. |
| `resource` with a blob | A line that says it was not sent. |
| a protected file (`.env`, keys, credentials, `.git`, `.ssh`, `lib/protected-paths.mjs`), as a link or as embedded text | `Protected file, not sent: <name>`. Its text is **never** in the prompt. |
| `image`, `audio`, an unknown type | `Invalid params` (not advertised / unknown). |

The person is told what was left out and why (a notice if the client advertised notices, otherwise an ordinary message). Tests: `tests/verify-acp-logic.mjs` (every row, both ways), `tests/verify-e2e-acp.mjs` (a real prompt with a link, a protected file and an ordinary file: the model's requests are scanned, the text of the ordinary file is found there, the text of `.env` is not). A secret in an *ordinary* file that the person attaches is sent: the protection is by name, as everywhere in the Hub.

### Stop reasons

The state of the Hub's task (`lib/task-state.mjs`) decides. The names are those of `StopReason` in the schema of the protocol, version 1.29.1.

| State of the task | Result of `session/prompt` | And |
| --- | --- | --- |
| `completed` | `end_turn` | the answer, as one message of the agent, before the response |
| `cancelled` | `cancelled` | |
| `paused` (a limit of steps, time, context or output, or the Hub was restarted) | `max_turn_requests` | a notice that says which limit and that another message continues the task |
| `uncertain` | `end_turn` | a warning: an action may or may not have taken effect, check the changes; the Hub never repeats it by itself |
| `failed` | a JSON-RPC error (-32603) | the reason the Hub gave |
| any other state | an error | the agent never decides that a turn is over without the Hub saying so |

When the client has sent `session/cancel`, the answer is `cancelled` **whatever the task did in the race** (the protocol says it must be). A client that did not advertise `session.notices` gets the same words as an ordinary message, because the protocol forbids a notice to such a client. This table is checked against the code by `tests/verify-acp-logic.mjs`, and the five names against the schema by the same suite and `tests/verify-e2e-acp.mjs` (which also validates every message that was written).

### `session/cancel`

Stops the Hub task (once, however many cancels come), and the prompt answers `cancelled`. A cancel that arrives before the Hub has answered the start, or the continue of an earlier task, waits for the id of the **new run** and then stops it (a cancel is never spent on the run that had ended). The same holds for a connection that closes, and for the end of the agent by a signal, while the Hub is still making the task: the task is stopped the moment it exists. A cancel for no turn, before `initialize`, with parameters that do not fit, or for a session nobody made, does nothing (it is logged). A task that is waiting for an approval in the Hub is denied and stopped; nothing is written. Tests: `tests/verify-acp-logic.mjs`, `tests/verify-e2e-acp.mjs` (a real Hub, a real pending approval, nothing on disk).

### Methods the agent does not offer

`authenticate`, `logout`, `session/load`, `session/list`, `session/resume`, `session/close`, `session/delete`, `session/set_mode`, `session/set_config_option` and every other method answer `Method not found` (-32601). `$/cancel_request` is ignored (the protocol lets an agent ignore it; `session/cancel` is the cancel of ACP).

## What the Hub decides, not the agent

The agent adds no authority. A task started from the editor runs under the permission mode of the Hub: Review asks, Autonomous does not, Read Only refuses writes, Full Access is Full Access. The agent never changes the mode. In this version an ACP client **cannot answer an approval** (see below), so a task that needs one waits in the Hub, visible in the desktop window, until it is answered there, expires (10 minutes) or is cancelled from the editor.

Things about the Hub that matter to an editor user (all read from the Hub's code; the first is exercised by `tests/verify-e2e-acp.mjs`, the rest are **not tested**):

- A conversation that runs in a folder other than the Hub's selected one has the permission mode that the Hub had when that conversation **started**; changing the mode later does not reach it.
- A second task in a folder that already has one running does not share it: it runs in its own Git worktree (`chatmcp/chat/<id>` under the Hub's state folder), which needs a Git repository with at least one commit (otherwise `git_required`), and in Review mode creating that worktree is itself an approval. Its edits are in the worktree, not in the editor's folder.
- A task for the folder the Hub has selected runs in that folder when the Hub is idle.

## What leaves the agent

Everything that is sent to the editor — a message, a response, an error, a notice — and every line of the log goes through **one** function that masks the *decoded* values (`lib/acp/mask.mjs`: the Hub's `maskSecrets` on every string, never on JSON text, where a double-quoted secret is not seen). It also masks the two credentials the agent holds itself, the bearer of the Hub and its CSRF token, by value. Keys of objects, ids, paths, URIs and the other words an editor acts on pass through unchanged (tested with names that say token and password). `safePreview`, which stringifies before it masks, is not used. Tests: `tests/verify-acp-logic.mjs` (the function, and a scan of the agent's source for the one place a message can leave), `tests/verify-e2e-acp.mjs` (the bearer and the CSRF token of a real Hub are in neither stdout nor stderr; the text of a protected file is in neither). The mask is a pattern mask: a secret in a spelling nobody listed is not hidden ([APPROVAL-PREVIEW.md](APPROVAL-PREVIEW.md) lists what it covers and what it does not).

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

## Not in this version

- **Tool calls, diffs and plans as they happen** (`tool_call`, `tool_call_update`, `plan`, `usage_update`, thinking): the answer arrives as one message at the end of the turn. The next change maps what the Hub records of a task to these updates; because the Hub's streams of events send nothing in this build (see `session/prompt`), it reads the task's record by polling, unless the Hub is given a working stream first.
- **Approvals in the editor** (`session/request_permission`): see above. The next change answers the Hub's approval request from the editor, with the planned diff ([APPROVAL-PREVIEW.md](APPROVAL-PREVIEW.md)).
- **`session/load`** (`loadSession` is `false`), session lists, modes, config options.
- **MCP servers** passed in `session/new` are ignored without a word to the person (the Hub has no MCP client yet; a later change says so with a notice).
- **Images and audio** in a prompt.
- **A guide for each editor** (Zed, JetBrains, Neovim, Emacs, VS Code through a community extension) and the evidence from running them. The configuration an editor needs is the command above.
- Sessions live in the agent's memory: when the editor starts the agent again, `session/new` is a new conversation (the Hub keeps the old tasks, which the desktop app shows).

## Verified, and not

| | |
| --- | --- |
| Protocol | ACP version 1, schema **v1.29.1** (`schema/v1/schema.json` of the `agent-client-protocol` repository, tag `schema-v1.29.1`, 256,258 bytes, sha256 `0d0b1ca83c4872e5473f68926a894c7a8203b59b118e2a79bfe43dd76fbcbc1a`, the same bytes as the file inside the SDK below). The tests validate every message the agent wrote against it, by the method each message belongs to (the root of the schema accepts nearly anything). |
| Client in the tests | `@agentclientprotocol/sdk` **2.4.0** (Apache-2.0), exact version, installed from `DATGOLD-HUB/tests/acp-tools` (`npm ci --ignore-scripts --prefix DATGOLD-HUB/tests/acp-tools`; its own lock file, and ajv 8.20.0 with zod 4.6.7). It is a test tool: the installer ships nothing from `tests/` and the agent has **no runtime dependency**. `ClientSideConnection` of the 1.x line was removed in 2.0; the tests use `client()`. |
| Not verified | Any real editor (Zed, JetBrains AI Assistant, Neovim, Emacs, VS Code). Protocol version 2 (a draft; the agent answers 1). Behaviour with a client that sends requests faster than the Hub answers (**not tested**). The POSIX branches of the process rules (the polite end of an agent killed alone, `SIGTERM`, the handler of a broken pipe to a Hub that died, the exit handler on Linux) were written for Linux and macOS and run on Windows only before the first run of the CI, which runs them on Ubuntu. |

## Tests and mutation lists

`tests/verify-acp-rpc.mjs` (the wire), `tests/verify-acp-logic.mjs` (masking, stop reasons, content, parameters, the Hub client's routes and sentences, the agent on a scripted Hub), `tests/verify-e2e-acp.mjs` (a real Hub with a scripted model and the official SDK), `tests/verify-e2e-acp-lifecycle.mjs` (the agent as a process: how it ends, and what that does to its Hub) and `tests/verify-e2e-acp-connection.mjs` (how it finds, starts and loses a Hub: launchOwned, the refusals, the program, a Hub that is a script). The suites that need the SDK print `CHATMCP_TEST_SKIP` when it is not installed, which the CI runs (`--no-skip all`) count as a failure. Mutation lists (`node tests/mutation/run-mutations.mjs tests/mutation/<list>.json`): `acp-rpc.json`, `acp-mask.json`, `acp-stop-reason.json`, `acp-content.json`, `acp-validate.json`, `acp-hub-client.json`, `acp-agent.json`, `acp-lifecycle.json`, `acp-connection.json`, `acp-e2e.json`.
