# MCP client (roadmap P2)

The owner's external MCP servers (`mcp-servers.json` in the Hub's data folder) are offered to the agent behind the permission gate, **once the
owner approved them**: a stdio server is started only after its launch record was approved, and a server's tools reach the catalog only while
its lists match the pin the owner approved ([MCP-HARDENING.md](MCP-HARDENING.md)). The owner adds servers and gives both approvals on the **MCP
servers** tab of the work panel (slice D, ext-14; [The screen and its routes](#the-screen-and-its-routes)); besides the routes behind it, only
code (the tests, `scripts/Verify-McpRuntime.mjs`) calls `approveLaunch` and `approveTools`. Slices: A (ext-9 runtime, ext-10 client manager, this page's first part), B (ext-12 the
gate's `external` category), C1 and C2 (ext-13 hardening, ext-11 the seam below), D (ext-14 API and screen), E (ext-15 real servers end to end).

## What exists after this slice

| Part | Where | What it does |
|---|---|---|
| SDK runtime | `scripts/mcp-runtime/` (package.json, package-lock.json, stage.mjs, verify.mjs, licenses/) | Pins `@modelcontextprotocol/client` 2.4.0 and its closure; the installer stages it into `DATGOLD-HUB/runtimes/mcp` |
| Installer step | `scripts/Build-Installer.ps1` (after the Playwright step) | `npm ci --ignore-scripts`, `stage.mjs`, `verify.mjs`, copy to `DATGOLD-HUB/runtimes/mcp`, then `scripts/Verify-McpRuntime.mjs` with the bundled Node.js |
| Build-time check | `scripts/Verify-McpRuntime.mjs <hub> [<runtime>]` | Checks the staged copy against its manifest, then the Hub's own `lib/mcp/client-manager.mjs` connects through it to a small stdio server, lists, calls and closes |
| Loader | `DATGOLD-HUB/lib/mcp/sdk.mjs` | Finds the SDK and imports it on first use (`import()`); refuses another version (`mcp_runtime_invalid`) and says `mcp_runtime_missing` when there is none |
| Server list | `DATGOLD-HUB/lib/mcp/server-config.mjs` | `<hubDirectory>/mcp-servers.json`: validation, secrets through `createProtector`, `${NAME}` expansion |
| Connections | `DATGOLD-HUB/lib/mcp/client-manager.mjs` | `McpClientManager`: connect, list, call, status, close |
| Hub wiring | `lib/assemble.mjs`, `lib/manager.mjs` | The manager of the Hub's data folder gets one `McpClientManager` (`manager.mcp`), which reads the list at start; `state()` carries `mcp: status()`; `shutdown()` closes it |
| Routes (slice D) | `DATGOLD-HUB/lib/mcp/http-api.mjs`, `hub.mjs` | `GET /api/mcp/servers` and nine POST routes for the owner's screen ([below](#the-screen-and-its-routes)) |
| Screen (slice D) | `DATGOLD-HUB/ui/src/components/inspector/McpTab.tsx`, `ui/src/lib/mcp-servers.ts` | The MCP servers tab of the work panel (under "More") |

### Choice of versions (2026-11-20)

- **`@modelcontextprotocol/client` 2.4.0** (published 2026-10-23, Apache-2.0), the newest release. The plan of 2026-10-19 probed 2.3.1; 2.4.0
  came out since. The client is the only direct dependency: **`@modelcontextprotocol/node` (2.1.2) is not shipped** because it is the
  Node.js HTTP adapter of the *server* SDK (hono, `@hono/node-server`, a peer dependency on `@modelcontextprotocol/server`), and the client
  needs neither it nor the server package at run time. Both are pinned in `DATGOLD-HUB/tests/fixtures/mcp-reference` for the test servers.
- The closure, measured: **13 packages, 1,146 files, 15,398,294 bytes (14.7 MiB)** as staged, licences Apache-2.0 2, MIT 9, ISC 2.
- The client's `dist` files compile in seven more packages (ajv 8.18.0, ajv-formats 3.0.1, `@cfworker/json-schema` 4.1.1, content-type 1.0.5,
  fast-deep-equal 3.1.3, fast-uri 3.1.8, json-schema-traverse 1.0.0) without their licence texts. The texts are vendored in
  `scripts/mcp-runtime/licenses/` and staged to `runtimes/mcp/licenses/bundled/`; `tests/verify-mcp-runtime.mjs` fails when the `dist` files
  name a package or version that is not vendored.
- The LICENSE of the two SDK packages is Apache-2.0 and also carries the MIT License, for contributions not yet relicensed.

The notices are generated: `node scripts/generate-licenses.mjs` writes the list into THIRD-PARTY-NOTICES.md, DATGOLD-HUB/THIRD-PARTY-NOTICES.txt
and docs/LICENSE-SCAN.md; `tests/verify-notices.mjs` fails when one of them differs from the lockfile and the vendored manifest.

### Where the SDK is looked for

First match wins: `CHATMCP_MCP_RUNTIME_DIR` when it is set (and then only there; the tests use it), else `DATGOLD-HUB/runtimes/mcp` (the
installed layout), else `scripts/mcp-runtime` beside `DATGOLD-HUB` (a checkout, after `npm ci --ignore-scripts --prefix scripts/mcp-runtime`).
Nothing imports the SDK when the Hub starts: without it the Hub starts, serves `/api/health`, and `/api/state` says
`mcp.runtime = {state: "missing", code: "mcp_runtime_missing"}`.

## `mcp-servers.json`

```json
{
  "version": 1,
  "servers": {
    "github": {
      "transport": "stdio",
      "command": "npx.cmd",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": { "secret": "<protected>" } },
      "timeouts": { "connectMs": 30000, "callMs": 120000 },
      "policy": {}
    },
    "docs": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "env": { "DOCS_TOKEN": { "secret": "<protected>" } }
    }
  }
}
```

- An id is 1 to 32 characters of `a-z`, `0-9`, `_` and `-`, starting with a letter, with no `__` and no `_` at the end, so that the hook
  alias `mcp__<server>__<tool>` names one server only (`a__b` + `c` and `a` + `b__c` would both be `mcp__a__b__c`); `local`, `studio`, `mcp`,
  `hub`, `datgold` and `chatmcp` are reserved. An unknown setting is an error, so a misspelt one is not ignored.
- `transport`: `stdio` (command, args, cwd, env) or `http` (Streamable HTTP: url, headers, env). `sse`, the legacy HTTP+SSE transport, is
  refused. A url is `https://`, or `http://` to `127.0.0.1`, `[::1]` or `localhost`; a user name or password in the url is refused.
- `enabled` (default `true`), `timeouts.connectMs` (1,000 to 120,000, default 30,000) and `timeouts.callMs` (1,000 to 900,000, default 120,000).
- `policy` is the owner's word to the permission gate: `{"default": "ask" | "allow" | "deny", "tools": {"<tool>": "ask" | "allow" | "deny"}}`,
  where `<tool>` is the server's own name of the tool (without `<server>.`). A tool's rule wins over the default; nothing set is `ask`. An
  unknown key or word is refused when the file is read (the whole file, like every other fault). What the gate then does is in
  [THREAT-MODEL.md](THREAT-MODEL.md) Surface 10: `deny` refuses everywhere, Full Access runs, `destructiveHint: true` still asks.
- **A secret belongs in `env` (or `headers`), referenced as `${NAME}`**, never typed into `command` or `args`. The approval card and the launch
  record show the command and the args as stored (the card with the `${NAME}` references, the record with the values of secret entries replaced by
  `[secret]`); a token typed straight into an argument is not a registered secret, so only the pattern masker of the gate may hide it.
- `trust: {"annotations": true}` lets the gate believe the server's `readOnlyHint` (Read Only runs an `allow`ed tool only then); default false.
- `touchesWorkspace: true` makes the Hub take a workspace checkpoint before every call of that server (an external tool is not checkpointed
  otherwise; RR-42); default false.
- Secrets. A value is a string or `{"secret": "<blob>"}`, the blob made by `createProtector` (Windows DPAPI; AES-256-GCM elsewhere). Always
  stored protected, whatever the caller asked:
  - an env name that looks like a credential (the `SECRET_ENV_NAME` rule of `lib/shell-runner.mjs`: `GITHUB_TOKEN`, `DB_PASSWORD` ...);
  - a header named like one: `Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `Api-Key`, `X-Auth-Token`, `X-Access-Token`, and
    any name in which `SECRET_ENV_NAME` finds a credential word once `-` is read as `_` (`PRIVATE-TOKEN`, `X-Goog-Api-Key`, `X-API-Token`,
    `X-Figma-Token`, `Ocp-Apim-Subscription-Key`, `X-Auth-Key`, `Api-Token`, `X-Secret` ...);
  - any env or header value that is a URL with a password (`URL_WITH_PASSWORD` of `lib/shell-runner.mjs`: `postgres://u:pw@db/x`,
    `redis://:pw@host:6379`). A URL whose password is a reference (`postgres://u:${DB_PASS}@db/x`) stays as typed.

  The exception is a value that is only a reference (`"${NAME}"`, `"Bearer ${NAME}"`): it holds no credential itself. Read from the file, any of
  the above in plain text is refused. Through `McpServerStore.save()` a value is a string, `{value, secret}` or `{keep: true}` (keep the stored
  secret). `list()`, `get()` and `status()` never return a secret, in plain or protected form: `{secret: true}` says only that one is set.
  When a connection is made, every secret value is registered with `HubManager.registerSecret`, so the masker of the log hides it: the stored
  secrets, a credential header or a URL with a password as it is once its references are expanded, and the password of such a URL on its own.
- `${NAME}` in the command, args, cwd, env values, url and header values is replaced by the value of the env entry `NAME` of the **same**
  server; a name that the env map does not declare is a configuration error. The only way to pass on a variable of the Hub's environment is
  to declare it as its own value: `"GITHUB_TOKEN": "${GITHUB_TOKEN}"` (an error when the Hub does not have it). Cycles are errors.

## `McpClientManager`

```js
const mcp = new McpClientManager({ hubDirectory, bundleRoot, protector, registerSecret, secrets, log });
await mcp.reload();                                    // read mcp-servers.json (assembleStudio does it at start)
await mcp.connect(id, { signal });                     // -> summary (state, protocolVersion, era, server, tools, fingerprint ...)
await mcp.listTools(id, { signal, refresh });          // tools of the connection (a copy)
await mcp.listPrompts(id) / mcp.listResources(id);
await mcp.callTool(id, name, args, { signal, timeoutMs });
mcp.status();                                          // {runtime, configLoaded, closed, servers: [...]}; no secret, no command line, no url, no header
await mcp.disconnect(id); await mcp.close();
```

- **Lazy, pooled, shared.** `connect()` spawns or opens the connection, negotiates, and lists the tools, within `timeouts.connectMs`
  (`mcp_connect_timeout`). Callers that come while it runs share the attempt; a caller's `signal` stops only its own wait. One connection per
  server per manager; a call on a server that is not connected connects it first. The later seam will call `connect()` at task preflight.
- **stdio.** The Hub's own transport (`ManagedStdioTransport`) on the SDK's wire format: cross-spawn from the runtime (so `npx.cmd` and
  other `.cmd` shims start), `shell: false`, no window, a process group of its own on POSIX. Environment: the SDK's allow-list
  (`DEFAULT_INHERITED_ENV_VARS`: PATH, SYSTEMROOT, APPDATA, TEMP ... on Windows; HOME, PATH, SHELL, TERM, USER, LOGNAME elsewhere), scrubbed again
  by `scrubEnv`, plus the server's env map. A parent `OPENAI_API_KEY` never reaches the server. The server's stderr goes to the Hub log,
  masked, 200 lines per connection at most.
- **Closing.** stdin is ended, the server has 2 s to leave, then its whole tree is stopped like every child the Hub owns (`stopOwned`:
  `taskkill /T /F` on Windows, the process group on POSIX), and `close()` resolves only once the child has exited (Node.js aborts on a libuv
  assertion when the process exits right after killing a child). `HubManager.shutdown()` awaits it.
- **Protocol posture.** The SDK negotiates the version (`versionNegotiation: 'auto'`: a `server/discover` probe, falling back to the 2025
  `initialize`); the SDK's default would be the 2025 handshake only. The probe runs in place on the one child, so no extra process is
  started; a server that dies on the probe (servers built on SDKs that stop on any request before `initialize`) is started again once with
  the 2025 handshake. Measured: the reference servers 2.3.1 / 2.4.0 and the v2 fixture negotiate `2026-07-28` on both transports; a 2025 server
  `2025-11-25`. The client declares **no** capability (no roots, sampling, elicitation or logging) and registers no handler; an
  `input_required` result is an error (`autoFulfill: false`), so a call is never re-sent with answers. There is no HTTP+SSE fallback. A
  result whose `resultType` the SDK does not know is treated as complete (the SDK 2.4.0 itself refuses one on a 2026-07-28 connection).
- **Lists** are walked page by page by the manager, not by the SDK: a repeated cursor (also A, B, A), an empty cursor or more than 1,000 pages
  refuse the whole list (`mcp_list_cursor_repeated`, `mcp_list_cursor_invalid`, `mcp_list_too_many_pages`), as does a listing past 10,000 items or
  16 MiB in all (`mcp_list_too_large`, `MAX_LIST_ITEMS`, `MAX_LIST_BYTES`). Every item then goes through
  `sanitizeList` (lib/mcp/sanitize.mjs), the **one name rule** of the Hub: 1 to 128 characters of `[A-Za-z0-9_.-]` (the MCP tool-name rule),
  checked per item. A bad name, and the second of two items with one name, are refused alone and counted in `status().servers[].refused`; the
  rest of the list stays. (Slice A refused the whole list for a bad or duplicate name, at 128 characters, while the sanitizer allowed 256 per
  item: C2 made it one rule.) The tools and prompts are pin-checked (`review` in the status).
- **Calls are never repeated.** `timeoutMs` (else `timeouts.callMs`) covers the whole call; when it passes, the SDK sends
  `notifications/cancelled` and the call ends with `mcp_call_timeout`. A lost answer (the process died, the HTTP response was cut off) ends
  with `mcp_connection_lost`. Both carry `executed: 'unknown'`: the server may have run the call. Nothing sends it again: the HTTP transport
  does not resume a broken stream (`reconnectionOptions.maxRetries = 0`), and the next call is a new call on a new connection.
- **HTTP**: `StreamableHTTPClientTransport` with the configured headers, `redirectPolicy: 'same-origin'`; a 2025 session is ended with
  DELETE when the connection is closed (not exercised: the HTTP servers of the suites are stateless or 2026-07-28). No OAuth in this slice: a
  server that answers 401 is not connected.

## The seam (slice C2, plan task ext-11)

- **Catalog.** `HubManager.internalCatalog()` adds, to the Hub's own tools, the tools of every server in `mcp.catalogGroups()`: connected,
  launch-approved, and its lists match the pin. A tool is `<server>.<tool>` with `server` and `originalName` (the gate's name rule), carries the
  server's sanitized description, schema and annotations, and `catalog.servers[<id>]` has the server's real `serverInfo` and capabilities. Its
  prompts (`<server>.<prompt>`, `server`) and resources (`uri`, `name`, `mimeType`, `server`) are in `catalog.prompts` / `catalog.resources`.
- **Preflight.** `createAgentSession` (every run of the agent, a spawned agent and the web transport) first awaits `mcp.prepare()`: every
  enabled server that may start is connected (once; then pooled) and a connected one is listed again, so a change since the last task is caught
  by the pin before the catalog is built. It waits 3 s in all (`PREPARE_WAIT_MS`): a connect or a listing still running goes on, and what it
  brings is offered from the next task. A server whose connect failed is not tried again by the preflight for 1, 2, 5, then 15 minutes
  (`RETRY_BACKOFF_MS`, `retryAt` in the status); `reload()`, a successful connect and a new launch approval clear that, and an explicit
  `connect()` is not held back. It never fails the task: a server that cannot be reached is not in the catalog.
- **Calls.** A call to `<server>.<tool>` passes the same guard as the Hub's own (`#guardCalls`: the gate with the owner's policy, the
  PreToolUse hooks under the name and the alias `mcp__<server>__<tool>`, the workflow, a checkpoint only for a `touchesWorkspace` server), then
  `mcp.callTool`. What the server never received (quarantined lists, an unknown tool) and a JSON-RPC error answer are `isError` results the model
  reads; a timeout, a lost connection or an abort after the request went out throws, and the agent stops the task as `tool_transport_failed`
  without replaying it. `mcp_capabilities` gets a prompt and reads a resource through the same session (`getPrompt`, `readResource`).
- **The same servers everywhere.** A `spawn_agent` child, an access manager of ConcurrentApiAgent, a coding worker and a web session on another
  workspace are each handed the Hub's `McpClientManager` before they are assembled (`mcpOwned` false: they never close it), so they offer the
  same servers under the same approvals and policy (`assembleStudio` attaches the policy to every gate). The auto tool selection keeps
  external tools in the run's catalog (they are never offered as direct functions).
- **Instructions.** The agent's instructions name at most 40 tools that are not offered directly (the Hub's own first, then the servers from
  the smallest to the largest) and summarise the rest as `server X: N tools, use mcp_catalog filter=X`. With a 308-tool server and an 8-tool one
  connected the instruction text is 7,535 bytes (measured 2026-11-20; listing every name would be about 12 KB).
- **Never read**: a workspace `.mcp.json`. Only `mcp-servers.json` in the Hub's data folder is a source of servers.

## Approvals

```js
await mcp.launchRecord(id);   // {required, approved, fingerprint, record: {command, args, cwd, envKeys, executable, sha256}}; HTTP: required false
await mcp.approveLaunch(id, { expectedFingerprint });   // mcp_fingerprint_required (400), mcp_launch_changed (409)
mcp.toolReview(id);           // {state: unpinned | pinned | needs_review | not_connected, fingerprint, diff?, tools, prompts, refused}
await mcp.approveTools(id, { expectedFingerprint });    // mcp_fingerprint_required (400), mcp_fingerprint_mismatch (409), mcp_not_connected (409)
mcp.status().servers[i];      // state: idle | connecting | connected | needs_review | needs_launch_approval | failed | lost; launch, review, refused, stderr
```

`expectedFingerprint` is always the fingerprint the owner was shown; `{fingerprint}` is not read. The records are kept beside
`mcp-servers.json`: `mcp-approvals.json` (launch records, no secret) and `mcp-pins.json` (hashes of the lists).

## The screen and its routes

The **MCP servers** tab of the work panel (under "More"; `McpTab.tsx`) is the owner's way to add a server and to approve it. It shows what the Hub
reports and sends the owner's decisions to the routes below (`lib/mcp/http-api.mjs`, answered by `hub.mjs`); nothing is decided in the page.

| Route | Body | What it does |
|---|---|---|
| `GET /api/mcp/servers` | | Every configured server as `publicServer` shows it (no secret, in plain or protected form: `{secret: true}` says one is set), its connection state (`status()`, with `lastError` and the preflight's `retryAt`), its tools with the owner's `rule` and the word that applies (`policy`), descriptions cut to 600 characters, and the review state of its lists; `runtime`, and `configError` when `mcp-servers.json` could not be read (the list is then the one read before) |
| `POST /api/mcp/server/upsert` | `{id, server}` | Adds or replaces one server (`McpServerStore.save`: a value is a string, `{value, secret: true}` or `{keep: true}`). A `policy` left out keeps the stored one. The server's open connection is closed and the file read again, so the next connect uses what was saved and its back-off is cleared |
| `POST /api/mcp/server/delete` | `{id}` | Removes it and closes its connection. Its records in `mcp-approvals.json` and `mcp-pins.json` stay, bound to their fingerprints |
| `POST /api/mcp/server/test` | `{id}` | `connect` (an explicit connect is not held back by the back-off), or for a connected server `listTools({refresh: true})`, which checks the lists against the pin again; answers `{ok, error, status}`. No tool is called |
| `POST /api/mcp/server/launch-record` | `{id}` | `launchRecord`: the command, args and cwd (secret values as `[secret]`), the env NAMES, the executable and its sha256, the fingerprint |
| `POST /api/mcp/server/approve-launch` | `{id, expectedFingerprint}` | `approveLaunch`; a record that changed since it was shown is 409 `mcp_launch_changed` |
| `POST /api/mcp/server/tool-review` | `{id}` | `toolReview`: the sanitized tools and prompts, and the diff against the pin when they changed |
| `POST /api/mcp/server/approve-tools` | `{id, expectedFingerprint}` | `approveTools`; lists that changed since they were shown are 409 `mcp_fingerprint_mismatch` |
| `POST /api/mcp/server/tool-policy` | `{id, default?, tools?}` | The owner's word to the gate, `ask`, `allow` or `deny`, for the server (`default`) or per tool (`tools: {<tool>: word}`); `null` clears one; at most 256 rules per body. The rest of the server is saved as it is (each secret kept); the gate reads the policy at each call, so the connection stays |
| `POST /api/mcp/reload` | `{}` | Reads `mcp-servers.json` again (a file edited by hand) and closes the open connections, which reopen at the next task or test; a file that breaks a rule is 400 and stays in `configError` until a reload works |

- The POST routes are in `POST_ROUTES` and need what every dashboard POST needs: the bearer, the page's Origin, the `local-dashboard` marker and the
  CSRF token. A body with a key the route does not know is refused (`mcp_request_invalid`), so `{fingerprint}` in place of `expectedFingerprint` is a 400.
- Every route that changes the servers, their approvals or their connections (all but the GET, `launch-record` and `tool-review`) answers **409
  `mcp_task_active`** while a task, a coding or dynamic worker or a delegate runs, like the other settings of a run. The writes run one at a time.
- `status()` alone says a stdio server without a connection is approved when any record of it was approved, even one that changed since; the list
  computes the launch record of such a server (once per change: an upsert, an approval, a reload) and shows whether that record is the approved one.
- The page: the form takes the id, stdio (command, one argument per line, cwd) or HTTP (url, headers), env rows with a "secret" box, and the trust
  and `touchesWorkspace` switches; a stored secret comes back as an empty field marked "set", sent as `{keep: true}` when left empty. A card shows the
  state, the last error and the back-off, "Test connection", the launch record with "Approve this launch" (which sends the fingerprint shown and then
  tests the server), the lists to review with their diff and "Approve this list", and each tool with its rule (`As the default`, ask, allow, deny).

## Tests

| Suite | What it runs |
|---|---|
| `tests/verify-mcp-runtime.mjs` | Pins and closure, the loader, a real Hub with and without the runtime, stage + verify + tampering, `Verify-McpRuntime.mjs`, the compiled-in packages |
| `tests/verify-mcp-client-stdio.mjs` | The config rules; the real server-everything 2.3.1 and server-filesystem 2.4.0, the v2 fixture and a plain JSON-RPC server: tool counts against an independent `tools/list`, echo, negotiation, the `.cmd` (or shell) wrapper and its tree, the environment, pagination and its guards, the hung and the lost call, unknown result types, secrets in status and log, no process left after `close()` and `HubManager.shutdown()` |
| `tests/verify-mcp-client-http.mjs` | server-everything in its Streamable HTTP mode and the fixture on `createMcpHandler`: counts, negotiation in both eras, a secret header, the hung and the lost call, no SSE fallback, an absent server |
| `tests/verify-mcp-hardening.mjs` | launch approval, pins and quarantine, sanitized lists, result ceiling, read limit, aborted and hung calls, no Authorization across origins, `.mcp.json`, no process left (MCP-HARDENING.md) |
| `tests/verify-mcp-agent-seam.mjs` | the seam above with the real `AgentRunner`, a scripted model, `tests/fixtures/mcp-seam-server.mjs`, a `ConcurrentApiAgent` child and the web transport |
| `tests/verify-mcp-http.mjs` | the routes of the screen against a real Hub: their layers, upsert and list, secrets planted in env and a header that never come back (GET, state, launch record, errors, the data folder, the log), approvals by the fingerprint shown and stale ones refused, a deny set by the route refusing the tool in a real task, 409 while a task waits, five writes at once, reload of a file edited by hand or broken, delete |
| `ui/tests/mcp-tab.test.mjs`, `ui/e2e/mcp-servers.spec.mjs` | the tab's form and what it renders for each state; in the production build against a real Hub, the owner adds the seam fixture, approves its launch and its tools (the page sends the fingerprints it showed), sees the tools and sets one to deny |

The two transport suites of slice A approve as they go (`autoApprove` in `tests/support/mcp-tools.mjs`, test code only); the approvals
themselves are tested in `verify-mcp-hardening.mjs`.

The servers come from `DATGOLD-HUB/tests/fixtures/mcp-reference` (package.json and lock file; `npm ci --ignore-scripts --prefix
DATGOLD-HUB/tests/fixtures/mcp-reference`), the SDK from `scripts/mcp-runtime`; CI installs both before `run-all --no-skip all`. Mutation lists:
`tests/mutation/mcp-runtime.json`, `mcp-client-stdio.json`, `mcp-client-http.json`, `mcp-http.json` (the routes of the screen). Child processes are counted by parent pid (and by the pids
the servers report), never by process name.

## Not verified

- A real installer build loading the SDK from the installed layout on a user's machine: `Build-Installer.ps1` runs the stage and
  `Verify-McpRuntime.mjs` (CI's windows-installer job does), but an installed DatGold has not been started against a real server.
- Servers beyond the two reference servers and the fixtures (servers built on other SDKs, Python servers, npx downloads on a slow network).
- OAuth for HTTP servers, `listChanged` notifications, resources subscriptions, the 2026-07-28 tasks extension.
- A coding worker and an access manager of ConcurrentApiAgent calling an external tool: they are handed the client manager like a child, but no
  test drives one. A real model choosing an MCP tool (the seam suite scripts the model).
- The screen with a real server other than the fixtures, an HTTP server that needs a header to connect, and the routes while a coding or dynamic worker
  or a delegate runs (`busy()` counts them; the suite drives only the main task). A secret typed into `command` or `args` is shown as typed.
- The mutation runner copies only `DATGOLD-HUB`: `scripts/mcp-runtime/stage.mjs` and `verify.mjs` are checked by the tampering cases of
  `verify-mcp-runtime.mjs` and the seeded defects of `verify-notices.mjs`, not by mutants.
