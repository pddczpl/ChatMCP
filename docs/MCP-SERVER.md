# MCP server for local clients (roadmap P6, ext-17 and ext-18)

The Hub can serve the Model Context Protocol to MCP clients on the same computer (Claude Code, Codex, Claude Desktop). This document
describes **the listener's core**, plan task ext-17 (where it listens, how it is turned on, the gate every request passes, the token), and
**the host**, plan task ext-18: how a client's call goes through the Hub's own permission gate, with a manager and a task per client and
the approvals in the dashboard, without colliding with the primary agent's task. **Through the host the Hub serves one workspace tool,
`read_file`, in Read Only**, to prove the path; `hub_status` says that the server runs, which version it is and which tools the host serves,
and reads no workspace. The verify/read/write tool profiles (ext-19), the connection kit and the stdio bridge (ext-20) and conformance with
real clients (ext-21) come later.

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

## Tools: an injected provider

`createMcpServerFactory(sdk, { name, version, tools, call, listCacheHint })` builds the factory the SDK calls per request:

- `tools` is an array, or a function asked per request, of `{ name, title?, description?, inputSchema, outputSchema?, annotations? }`. A
  name is 1-128 characters of `A-Z a-z 0-9 _ . -`, unique; the schemas are JSON Schema objects of `type: "object"`. A list that breaks these
  rules is refused (an exception), never served half.
- Each tool is registered with `fromJsonSchema(inputSchema)`, so the SDK checks the arguments before `call(name, args, { signal, client })`
  runs; an argument that does not fit is an `isError` result and the provider is not called. `client` is the client as it names itself
  (`clientInfoOf`): `{ name, version }` from the `io.modelcontextprotocol/clientInfo` key of the request's `_meta` envelope (2026-07-28),
  strings only, at most 256 characters each, or `null` (a 2025 client: in stateless mode its `tools/call` carries no clientInfo). Title,
  description, schemas and annotations reach the client as given.
- The order is deterministic: by name, in code-unit order, whatever order the provider used.
- `tools/list` carries the cache hint of the 2026-07-28 revision: `ttlMs: 0`, `cacheScope: "private"` by default.

The Hub's provider is the host's (`mcpHostProvider`, below): `hub_status` (`hubMcpProvider`: `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`, `openWorldHint: false`), whose answer is
`{"product":"DatGold","version":"<version>","mcpServer":"ext-18 host","workspaceTools":["read_file"],"scope":"read"}` (no path, no
workspace, no secret), and the host's tools.

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

In ext-18 the Hub's host serves ONE tool, `read_file` (target `local.read_file`: the Hub's own read tool, protected files refused,
`readOnlyHint: true`), in the `read` scope (`HUB_HOST_TOOLS`). Which tools a client gets in which scope, and how the owner chooses the
scope, are the profiles of ext-19; the suite drives `edit_file` and `update_plan` in the `write` scope through a host it makes itself.

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
the token lists `hub_status` and the host's `read_file`, and a shutdown frees the port). `tests/verify-mcp-runtime.mjs` covers the pins, the closure and the
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
the Hub's busy rule; `close()`; a real `hub.mjs` with the switch on serves `read_file` of the workspace through the host and closes it in
its stop. `ui/tests/approval-mcp-client.test.mjs` renders the tag on the approval card. Mutation list: `tests/mutation/mcp-host.json`.

## Not verified here

- No real client (Claude Code, Codex, Claude Desktop) has connected: that is ext-20 (connection kit) and ext-21 (interop), with the owner.
  The names those clients give themselves, and so their tags, are not known yet.
- The host's single-writer check runs before the question and again after the answer; the milliseconds between that second check and the
  write are not covered: the primary agent does not ask the host, and the host writes no lock file into the workspace. An agent task in
  another worktree counts as busy too.
- The approval card with the tag was rendered by the unit test only, not seen in the desktop app.
- No timing measurement of the token comparison.
- The Linux and macOS protector of the token (AES-GCM) is exercised by the unit cases; the Windows DPAPI path only by the real `hub.mjs` runs
  on Windows.
