# MCP server for local clients (roadmap P6, ext-17, ext-18 and ext-19)

The Hub can serve the Model Context Protocol to MCP clients on the same computer (Claude Code, Codex, Claude Desktop). This document
describes **the listener's core**, plan task ext-17 (where it listens, how it is turned on, the gate every request passes, the token),
**the host**, plan task ext-18: how a client's call goes through the Hub's own permission gate, with a manager and a task per client and
the approvals in the dashboard, without colliding with the primary agent's task, and **the tool profiles**, plan task ext-19: the scope
of the token decides which tools a client may call. **A new token has the verify profile alone** (the project's checks and Git's view of
the work); read and write are opt-in. `hub_status` says that the server runs, which version it is, the token's scope and the tools it
allows, and reads no workspace. The connection kit and the stdio bridge (ext-20) and conformance with real clients (ext-21) come later.

Threat model: [Surface 11](THREAT-MODEL.md#surface-11-the-hubs-mcp-server-for-local-clients). The client side of MCP (the Hub calling other
servers) is [MCP-CLIENT.md](MCP-CLIENT.md).

## Where it listens

| | |
|---|---|
| Address | `http://127.0.0.1:<port>/mcp`, IPv4 loopback only. `localhost:<port>` reaches it too (the Host check accepts both) |
| Port | `3008` unless set. `0` means "any free port"; the Hub logs the one it got |
| Server | a **separate** `node:http` server, never the dashboard's (port 3007). The dashboard trusts only its own page and cannot tell local processes apart; this listener trusts only its token |
| Transport | Streamable HTTP through the v2 server SDK: `createMcpHandler(factory, { legacy: 'stateless' })` and `toNodeHandler` of `@modelcontextprotocol/node`. No sessions: every request gets a fresh `McpServer` from the factory. 2026-07-28 clients (`server/discover`) and 2025 clients (`initialize`) both work; GET and DELETE (2025 session streams) answer 405 |
| Start and stop | `hub.mjs` `main()` starts it after the dashboard listens and the Hub is initialised; `close()` closes it (every connection, then the socket) before the dashboard's server |

## Turning it on (off by default)

Three places, strongest first, like the switch of project instructions:

1. the environment of the Hub: `CHATMCP_MCP_SERVER=on` (`1`, `true`, `yes`, `enabled`) or `=off` (`0`, `false`, `no`, `disabled`); any other
   value decides nothing. `CHATMCP_MCP_SERVER_PORT=<port>` sets the port the same way;
2. the saved choice in `<data folder>/mcp-server.json`: `{"version": 1, "enabled": true, "port": 3008}` (`McpServerSettingStore.set`
   writes it; no page offers the switch yet, ext-20 adds it). A change takes effect at the next start of the Hub;
3. the default: off, port 3008.

A port must be `0` or `1024..65535`, not `3006` and not the dashboard's port. When the switch is off nothing listens and no token is made.
Every outcome is one line of the Hub's log, beginning `MCP server:`.

| Status (`startHubMcpServer().status().state`) | Code | Meaning |
|---|---|---|
| `off` | | the switch is off; nothing listens |
| `listening` | | `url` and `port` say where |
| `unavailable` | `mcp_runtime_missing`, `mcp_runtime_invalid` | the server SDK is not installed, or not the pinned version |
| `failed` | `mcp_server_port_invalid`, `mcp_server_port_in_use`, `mcp_server_listen_failed`, `mcp_server_token_failed` | the port cannot be used or is taken; the token cannot be made or read |
| `closed` | | the Hub stopped it |

None of these stops the Hub. The status is on `manager.mcpServer.status()`; no route reports it yet.

## The gate

Every request passes these steps in this order, before the SDK reads its body (`startMcpListener`, `lib/mcp/server.mjs`):

| Step | Refused with |
|---|---|
| `Host` is exactly `127.0.0.1:<port>` or `localhost:<port>` of this listener, and the SDK's `validateHostHeader` agrees (DNS-rebinding defence) | 403 |
| `Origin`, when there is one (browsers send it, MCP clients do not), is this listener's own origin, and the SDK's `validateOriginHeader` agrees. `null`, a web site and the dashboard's origin are refused. No CORS header is ever sent | 403 |
| `Sec-Fetch-Site`, when there is one, is `none`. Browsers send it on every request to 127.0.0.1 (`cross-site`, `same-site`, `same-origin` for what a page makes, `none` only for an address the owner typed), so an `<img src>` or a `no-cors` fetch of any page is refused here, before it is counted. `Sec-Fetch-Mode` alone decides nothing: Node's `fetch`, and so the SDK's client, sends `sec-fetch-mode: cors` and no `Sec-Fetch-Site` (measured on Node 24.19.0) | 403 |
| Rate limit, per client address, in two buckets: requests with the valid token at most 600 per 60 s; every other request (no token, a wrong token) at most 60 per 60 s in a bucket of its own, so token-less requests can never use up the allowance of the owner's client | 429 with `Retry-After` |
| The path is `/mcp` | 404 |
| `Authorization: Bearer <token>` (scheme case-insensitive, one space, nothing after the token), checked in constant time | 401 with `WWW-Authenticate: Bearer realm="DatGold MCP"` (and `error="invalid_token"` for a wrong token) |
| The SDK: body at most 1 MiB (`maxRequestBodySize`), JSON-RPC, protocol headers | 413 for a larger body; the SDK's own answers otherwise |
| The token's scope (ext-19, [Tool profiles](#tool-profiles-ext-19)): a `tools/call` of a tool of a profile outside it is answered by the SDK's scope challenge before any tool handler runs, in both protocol eras | 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<profile>"` |

The server also allows at most 64 connections, 10 s for the headers and 120 s for a request. Every refusal of the gate answers with
`Connection: close`, so a refused client holds no socket (a flood on keep-alive connections had filled the 64 places).

The request log has one line per request: `MCP server: <METHOD> /mcp|(other path) <status> (<ms> ms)`. It never carries a header, a query
string, a path other than `/mcp` or a body, and never the word that makes the Hub's redactor hide a whole line. A refusal of the gate (401,
403, 404, 429) is logged in full only the first time its status is seen in a 60 s window; the others are counted, and when the window ends
(or the listener closes) one line sums them up: `MCP server: <n> more refused requests in the last <s> s (403: <n>, ...)`. A flood of
refusals therefore adds at most one line per status and one summary per minute.

## The token

- 256 random bits, written `dgmcp_` + 43 base64url characters (`McpServerTokenStore`, `lib/mcp/server-token.mjs`). The prefix lets people
  and secret scanners recognise it.
- `<data folder>/mcp-server-token.json` keeps `{version: 1, sha256, sealed, createdAt}`: the SHA-256 of the token, and a copy sealed by the
  Hub's protector (`createProtector` of `lib/secret-box.mjs`: Windows DPAPI for the owner's account, else AES-256-GCM with the data folder's
  master key). The token is never written in clear and never logged; the Hub registers it with its log redactor.
- A presented token is hashed and the two 32-byte digests are compared with `timingSafeEqual`.
- The token is made the first time the server starts with the switch on. `reveal()` unseals it (and checks it against the digest) for the
  connection kit of ext-20; `rotate()` makes a new one and the old one is refused from the next request on. No page shows or rotates it yet.
- A damaged token file is no token: the next start makes a new one (every client then needs the new token).
- Like the session file of the dashboard, the token file is readable by any program of the owner's account (the threat model's same-user
  limit, RR-1). All clients share the one token and the one authorized bucket (RR-43): the host tells them apart by the name each gives
  itself, which authenticates nothing; a token per client is ext-20.
- The token has a **scope** (ext-19): the list of tool profiles it allows, kept in the same file (`"scope": ["verify"]`). A new token has
  `verify` alone; `McpServerTokenStore.setScope()` (and `startHubMcpServer().setScope()`) is the owner's choice and applies from the next
  request on; `rotate()` keeps it. A file of ext-17 has no scope and means `verify`; a scope in the file that is not a valid one is **no
  profile at all** (fail closed: only `hub_status` is listed) and the Hub logs it. No page sets the scope yet: the connection kit of ext-20
  offers it. The scope reaches the SDK as the request's `authInfo` (`{token: "(verified)", clientId: "datgold-mcp-token", scopes}`): never
  the token itself.

## Tools: an injected provider

`createMcpServerFactory(sdk, { name, version, tools, call, listCacheHint })` builds the factory the SDK calls per request:

- `tools` is an array, or a function asked per request with the SDK's request context (`{era, authInfo, requestInfo}`), of `{ name, title?,
  description?, inputSchema, outputSchema?, annotations? }`. A name is 1-128 characters of `A-Z a-z 0-9 _ . -`, unique; the schemas are JSON
  Schema objects of `type: "object"`. A list that breaks these rules is refused (an exception), never served half.
- `scopeChallenge(toolName, authInfo)`, when given, is asked for every `tools/call` before any handler runs; a `{scopes, errorDescription}`
  it returns makes the SDK answer 403 `insufficient_scope`. The factory wraps the server instance's `resolveScopeChallenge` (the SDK asks it
  in the 2026-07-28 path and in the 2025 stateless fallback alike); an SDK without it serves no request at all. `call` also gets `scopes`,
  the request's `authInfo.scopes`, and from `startHubMcpServer` `liveScopes()`, the token's scope now.
- Each tool is registered with `fromJsonSchema(inputSchema)`, so the SDK checks the arguments before `call(name, args, { signal, client })`
  runs; an argument that does not fit is an `isError` result and the provider is not called. `client` is the client as it names itself
  (`clientInfoOf`): `{ name, version }` from the `io.modelcontextprotocol/clientInfo` key of the request's `_meta` envelope (2026-07-28),
  strings only, at most 256 characters each, or `null` (a 2025 client: in stateless mode its `tools/call` carries no clientInfo). Title,
  description, schemas and annotations reach the client as given.
- The order is deterministic: by name, in code-unit order, whatever order the provider used.
- `tools/list` carries the cache hint of the 2026-07-28 revision: `ttlMs: 0`, `cacheScope: "private"` by default.

The Hub's provider is the profiles' (`mcpProfileProvider` of `lib/mcp/tool-profiles.mjs`, [below](#tool-profiles-ext-19)): `hub_status`
(`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`), whose answer is
`{"product":"DatGold","version":"<version>","mcpServer":"ext-19 profiles","scope":["verify"],"workspaceTools":[...],"defaultScope":["verify"]}`
(no path, no workspace, no secret), and the host's tools of the token's scope. ext-18's `mcpHostProvider` (every tool of the host to every
token) stays for the host's own suite.

## The host: a manager and a task per client (ext-18)

`McpHost` (`lib/mcp/host.mjs`) is what a client's `tools/call` goes through. `hub.mjs` makes it at start, with nothing in it until a client
calls, and hands its tools to the listener (`mcpHostProvider`).

| | |
|---|---|
| Client | the name the client gives itself (`client.name` above), lower case, only `a-z 0-9 . _ -`, at most 64 characters (`clientIdOf`); no name is the client `client`. It tells the clients apart for the owner; it authenticates nothing: every client has the same token, and a token holder can give any name (RR-43) |
| Manager | one `HubManager` per client, made with `assembleStudio` on the Hub's workspace at the client's first call (60 to 105 ms measured on Windows, a `tools/list` makes none), in a data folder of its own: `<data folder>/mcp-host/<16 hex of the workspace's SHA-256>/<task id>/`. Its checkpoints, its plan, its workflow file and its permission history are there; the primary agent's are never touched. It holds the owner's hooks (the Hub's own `HookRunner`) and, only when a tool of the host aims at an external server, the owner's `McpClientManager`; otherwise it offers no external server at all. At most 8 clients (`MAX_CLIENTS`); a ninth name gets `mcp_client_limit` |
| Task | one per client for the life of its manager: `hostTaskId(workspace, client)`, a UUID drawn from both, the same at every start of the Hub. The plan of P6 says `mcp:<clientId>`; a task id must be a UUID (the plan, the ownership of a checkpoint and the workflow need one, and a colon in a file name is an alternate data stream on NTFS), so `mcp:<client>` is the tag of the client's approvals instead |
| Calls | through the guarded session of `HubManager` (`#guardCalls`), like the calls of every agent: the arguments are checked, then the permission gate, the owner's PreToolUse hooks, a checkpoint before a change, the call, the PostToolUse hooks. A tool of the host names its target: a local tool of the Hub (`local.<tool>`, whose schema, description and annotations it takes) or `<server>.<tool>` of an external server, which then needs its own `inputSchema` and follows the owner's policy of `mcp-servers.json` |
| Gate | locked to the scope (`lockGate`): `verify` and `read` are Read Only and stay so, `write` is Review (Read Only allowed); autonomous and Full Access throw `mcp_host_mode_refused` (403), from `configure()` and from a plain assignment of `mode` or `executionPolicy`, and a refused `configure()` changes nothing. The policy is host-review (sandbox-only allowed). The approval timeout is 90 s (`DEFAULT_APPROVAL_TIMEOUT_MS`), fixed: a client must not hang for the gate's usual 10 minutes. The owner answers in the dashboard |
| Approvals | `pendingApprovals()` adds the clients' requests to `studio.permissions.pending` of `/api/state`: each is the gate's own item with `source: "mcp"`, `client` and `tag: "mcp:<client>"` (`tagPending`); POST `/api/studio/permissions/decide` reaches it (`decide()`). The approval card of the dashboard shows the tag and says that a local MCP client asked (`ApprovalStack`, `normalizeApproval` keeps a tag of that shape only) |
| No answer | when the 90 s run out, the call returns `isError` with `structuredContent.error.code: "approval_timeout"` and `executed: false`; nothing was changed. A denial is `permission_denied` |
| One writer | a call is a write when its tool is marked `write` or when the gate's category is anything but `read`, `checkpoint` (the client's own plan) and `blocked`. Before anyone is asked, a write is `workspace_busy` (`isError`, `executed: false`, `error.holder`) while another MCP write is under way, from its question to its end (`mcp_client`), while the Hub works in the workspace (`agent`: `hostPrimaryState` of `hub.mjs`, that is any task of the agents, the manager's own task or service operation, or a coding worker being merged; a state that cannot be read counts as busy), or while the workspace lock file `.chatmcp-workspace.lock` is held and not stale (`workspace_lock`). The same is checked again once the owner has answered, before the call runs. A read runs while the agent works |
| Workspace | when the owner selects another workspace, a client's next call gets a manager and a task on the new one; the old manager stops and a request it was waiting for is cancelled |
| Close | the Hub's stop closes the listener, then the host: every waiting request is answered no at once, the managers stop, and a later call is `mcp_host_closed` |

In ext-18 the Hub's host served ONE tool, `read_file`, in the `read` scope (`HUB_HOST_TOOLS`, kept for the host's suite, which drives
`edit_file` and `update_plan` in the `write` scope through a host it makes itself). Since ext-19 the Hub's host serves every tool of the
profiles (`PROFILE_HOST_TOOLS`) in the **`profiles` scope**: its gate is Review (Read Only allowed; autonomous and Full Access refused as in
every scope), so a read runs and anything else is asked in the dashboard; the token's scope decides which tools a client may call at all.
A host tool's target may also be a Studio tool the local backend offers beside its local tools (`LOCAL_BACKEND_STUDIO_TOOLS` of
`lib/manager.mjs`: `studio.checks`, `studio.diff_check`, `studio.review` and seven more); `studio.tree` and the others are in no session's
catalog and are refused. An `annotations` override that says something else than the definition about what the tool changes
(`readOnlyHint`, `destructiveHint`) is refused, and an `outputSchema` of the spec reaches `tools/list`. Three checks run before the gate:

| Refusal (`isError`, `executed: false`) | When |
|---|---|
| `mcp_annotations_mismatch` | the live definition of the target in the client's session no longer has the `readOnlyHint` / `destructiveHint` that `tools/list` gave the client |
| `mcp_profile_refused` | a tool offered as read-only (`readOnlyHint: true`) is assessed by the gate as anything but a read (a protected path stays the gate's own refusal) |
| `mcp_scope_refused` | the call's `stillAllowed()` (the profiles: the token's scope now) says no once the owner has answered: a write that waited for approval while the owner took `write` away does not run |

## Tool profiles (ext-19)

`lib/mcp/tool-profiles.mjs` maps each profile to the Hub's own tools; `lib/mcp/server-scope.mjs` checks a scope. Every tool keeps the name,
description, input schema and annotations of its definition in `local-tools.mjs` or `studio-tools.mjs` (`hubToolCatalog`); nothing in the
table restates what a tool does. Each tool is in exactly one profile.

| Profile | Tools | Count |
|---|---|---|
| `verify` (default) | `test_discover`, `tasks_run`, `tasks_status`, `tasks_cancel`, `test_run`, `test_results`, `studio_checks`, `studio_diff_check`, `studio_review`, `git_status`, `git_diff` | 11 |
| `read` | `read_file`, `list_directory`, `find_files`, `search_files`, `repo_map`, `code_symbols`, `find_definition`, `find_references`, `git_log` | 9 |
| `write` | `edit_file`, `write_file`, `files_apply_patch`, `files_write_batch`, `make_directory`, `move_path`, `delete_path`, `run_command`, `git_add`, `git_commit`, `git_branch`, `git_checkout`, `git_merge`, `update_plan`, `knowledge_create`, `rename_symbol`, `format_document`, `organize_imports` | 18 |

- **Names.** The plan's names that are no tool of the Hub are served as the real ones (`PLAN_NAME_MAP`): `checks_list` is `test_discover`,
  `checks_run` is `tasks_run` (the worker-only `checks_list` / `checks_run` of `lib/worker-tools.mjs` need a Windows Sandbox grant and are
  no tool of a session). A Studio tool is `studio_<tool>`: the MCP rule allows a dot in a name, the function names of model APIs do not.
  `verify_run`, `evidence_pack` and `receipt_get` (Proof-of-Done, P4) do not exist yet: `RESERVED_VERIFY_TOOLS` keeps their names out of
  every profile, and the place to add them is `PROFILE_TABLE.verify`.
- **Checks.** `tasks_run` in verify takes only the fixed check commands of `test_run` (`CHECK_COMMANDS`: `npm test`, `node --test`,
  `python -m pytest`, `dotnet test`, the ones `test_discover` finds): its `command` is an enum, so the SDK refuses any other text before
  anything is asked. It returns a handle at once (`{taskId, status: "running"}`; a tunnel call must not take more than 120 s); `tasks_status`
  follows it and `tasks_cancel` stops it. The gate asks the owner before a check runs (a test command may write caches: the gate calls
  it a workspace edit) and before `tasks_cancel`; a check is a write for the single-writer rule, so it waits while the agent works.
  Arbitrary commands are `run_command`, in write.
- **Receipts.** `test_run` and `tasks_status` (once the task has ended) carry an `outputSchema`, and their structured result a `receipt`
  (`mcpCheckReceipt` of `lib/verification-receipt.mjs`): `receiptId` `verify:<step>:<sha256>` (what `objectiveReceiptId` of
  `lib/objective-acceptance.mjs` accepts), the SHA-256 of what the Hub observed with the tool, the client and the time,
  `commandSucceeded`, `testOutcomeVerified: false` and `evidenceClassification: "execution_observed_tests_unverified"`: an exit code alone
  never says that a test suite passed. The receipt is returned, not kept; keeping and serving them is P4's `receipt_get` / `evidence_pack`.
- **The table's rules** (`buildToolProfiles`, an exception at load): the three profiles and no other; a name of `A-Z a-z 0-9 _ -`, never
  `hub_status` or a reserved name; a tool or a target once; a read-only tool (`readOnlyHint: true`) is never in write; a tool that is not
  read-only is never in read, and in verify only as a declared runner (`tasks_run`, `tasks_cancel`, `test_run`); an `annotations` override
  that differs from the definition is refused.
- **Scope names.** Case and spaces do not matter (`[" Write", "READ"]` is `["read", "write"]`), the order is always verify, read, write,
  repeats collapse; an unknown name (`mcp_scope_unknown`), an empty list (`mcp_scope_empty`) and anything but a list of text
  (`mcp_scope_invalid`) are refused with 400 and change nothing. Tool names stay exact: `EDIT_FILE` is no tool.
- **Where the scope is checked.** `tools/list` shows `hub_status` and the tools of the request's scope. A `tools/call` of a tool outside it
  is 403 `insufficient_scope` (`scope="<profile>"`) before any handler runs; the provider checks again with the token's scope now
  (`mcp_scope_refused`, the host is not called), and the host asks once more after the owner's answer. A call that has passed runs to its
  end, and a background check keeps running when the scope changes; its status is out of reach from a scope without verify.

## The SDK

The server SDK `@modelcontextprotocol/server` 2.4.0 and its Node HTTP adapter `@modelcontextprotocol/node` 2.1.2 (which brings `hono` 4.13.19
and `@hono/node-server` 2.1.11) are pinned in `scripts/mcp-runtime/package.json` beside the client, staged by the installer into
`DATGOLD-HUB/runtimes/mcp` and checked by `scripts/mcp-runtime/verify.mjs` (the pinned versions, their licence files) and
`scripts/Verify-McpRuntime.mjs` (the Hub's own `lib/mcp/server.mjs` serves through the staged copy, the staged client lists its tool, a
request without the token gets 401). The server's `dist` files compile in the same seven packages, at the same versions, as the client's;
their licence texts are the ones already vendored in `scripts/mcp-runtime/licenses/`. All four new packages are Apache-2.0 (the two SDK
packages) or MIT (hono, `@hono/node-server`); `THIRD-PARTY-NOTICES.*` and `docs/LICENSE-SCAN.md` are generated from the lockfile.

`lib/mcp/server-sdk.mjs` finds the packages in the client's folders (`CHATMCP_MCP_RUNTIME_DIR` alone when set, else
`DATGOLD-HUB/runtimes/mcp`, else `scripts/mcp-runtime`) and imports them only when the switch is on. `hub.mjs` imports `lib/mcp/server.mjs`
dynamically, so a Hub without the runtime starts as before.

The runtime grew from 13 packages (15.4 MB) to 17 packages, 1,880 files, 24,031,942 bytes (22.9 MiB) as staged on 2026-11-20.

What the installed pair negotiates, measured with the v2 client of the same runtime: `2026-07-28` (`server/discover` answers
`supportedVersions: ["2026-07-28"]`; a raw discover needs the headers `MCP-Protocol-Version: 2026-07-28` and `Mcp-Method: server/discover`,
or the SDK answers 400). A 2025 `initialize` is answered with the version the client asked for (`2025-06-18` in the suite) and no
`Mcp-Session-Id`.

## Tests

`tests/verify-mcp-server.mjs` (25 cases; ports 0 or a port `freePort()` just found, never 3007 or a fixed 3008): the setting and its store;
the token store; the pinned SDK; a v2 client listing the fixture provider's exact tools with annotations in name order, a call, an argument
the schema refuses; legacy `initialize` without a session, `server/discover` with the full `_meta` envelope, GET 405; the factory's refusals;
401 without and with a wrong token; 403 for `Host: evil.test`, another port, a foreign, opaque or dashboard Origin; 413; 404; 429 and a new
window in each of the two buckets; 650 token-less GETs (60 x 401, 590 x 429) leave an authorized initialize at 200; a `Sec-Fetch-Site` of a page
is 403 and counts nowhere, `none` and Node's `sec-fetch-mode: cors` pass; 2,000 refused POSTs add one line plus one summary, and every one is
answered; the log without the token; rotation; `close()` frees the port; `startHubMcpServer` off, SDK missing, bad and dashboard port, port in
use, on; three real `hub.mjs` runs (off; `CHATMCP_MCP_RUNTIME_DIR` empty: the Hub starts and logs `mcp_runtime_missing`; on: a client with
a new token lists `hub_status` and the verify profile, and a shutdown frees the port). `tests/verify-mcp-runtime.mjs` covers the pins, the closure and the
staged server. Mutation list: `tests/mutation/mcp-server.json`.

`tests/verify-mcp-server-approvals.mjs` (the host; a primary `HubManager` assembled as `hub.mjs` does, the dashboard's server of
`createHubServer` and the listener of `startHubMcpServer` on free ports, a real v2 client): the client id and the task id; the host's
refusals of a bad scope or tool; `tools/list` with the local tools' schemas and no manager made; in the write scope an `edit_file` is a
pending request in `/api/state` within 1 s (measured 52 to 64 ms), tagged, approved through the decide route (the file changes) or denied
(it does not); two clients, two tasks; 2 s injected and no answer: `approval_timeout`; `workspace_busy` while the primary agent holds its
task (nobody asked, a read still runs), while another task's lock file is held (a stale one does not block), after an approval given once
the agent started, and for a second write while one waits; the gate refuses autonomous and Full Access by `configure()` and by assignment
and a refused request changes nothing; the read and verify scopes stay Read Only; the primary agent's task, checkpoints, plan and
permission history are untouched and the host's checkpoint, plan and history are in its own folder; the owner's PreToolUse veto and the
external policy (`deny`, `allow`) apply; 8 clients and a ninth refused; no workspace; a workspace switch; a `primaryState` that throws;
the Hub's busy rule; `close()`; a real `hub.mjs` with the switch on and a token whose scope opts read in serves `read_file` of the
workspace through the host and closes it in its stop. `ui/tests/approval-mcp-client.test.mjs` renders the tag on the approval card.
Mutation list: `tests/mutation/mcp-host.json`.

`tests/verify-mcp-profiles.mjs` (the profiles): the exact tools of each profile (11, 9, 18), their annotations and schemas against the Hub's
definitions, the plan names and the reserved ones, `tasks_run`'s enum against what `test_discover` finds in four projects, the table's
refusals, scope names, the host's Studio catalog and annotation overrides, the provider with a fake host (both scopes before the host is
called, `stillAllowed`, receipts only for a finished check, a step per receipt), the check receipt, the token's scope; with the listener, a
real host and a v2 client: `tools/list` for five scopes (12, 10, 19, 21, 39 tools), an empty scope, every write tool with a verify token
answering 403 `insufficient_scope` in both eras with the workspace unchanged byte for byte and nobody asked, mixed-case names, read with
and without the read profile, a check's handle in under 5 s with the approval (54 to 67 ms measured) completed by `tasks_status` with a
receipt, commands that are no check, the scope changed while a check runs and while a write waits for the owner, an annotations mismatch
and a read-only tool the gate does not see as a read; two real `hub.mjs` runs (verify by default, a check asked in the dashboard and
denied; the token's scope changed to verify + read: `read_file` works, `write_file` is 403 and the file is unchanged). Mutation list:
`tests/mutation/mcp-profiles.json`.

## Not verified here

- No real client (Claude Code, Codex, Claude Desktop) has connected: that is ext-20 (connection kit) and ext-21 (interop), with the owner.
  The names those clients give themselves, and so their tags, are not known yet.
- The host's single-writer check runs before the question and again after the answer; the milliseconds between that second check and the
  write are not covered: the primary agent does not ask the host, and the host writes no lock file into the workspace. An agent task in
  another worktree counts as busy too.
- The approval card with the tag was rendered by the unit test only, not seen in the desktop app.
- No timing measurement of the token comparison.
- The profiles were tried with the SDK's own v2 client and raw requests only: how Claude Code, Codex and Claude Desktop show a 403
  `insufficient_scope` (a step-up prompt, an error) is not known (ext-21). The scope cannot be set from a page yet (ext-20).
- `test_run` runs in the foreground and may take up to 600 s, longer than a tunnel's 120 s: a client behind a tunnel should use
  `tasks_run`. `python -m pytest` and `dotnet test` through `tasks_run` were not run here (only `node --test`).
- The scope challenge relies on the SDK's `resolveScopeChallenge` of `McpServer` (2.4.0, pinned); a later SDK without it makes every
  request fail, which the suite would show.
- The Linux and macOS protector of the token (AES-GCM) is exercised by the unit cases; the Windows DPAPI path only by the real `hub.mjs` runs
  on Windows.
