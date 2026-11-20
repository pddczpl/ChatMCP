# MCP client (roadmap P2, slice A)

**External MCP tools are NOT offered to the model yet.** This slice adds the runtime and the connection manager only: no agent, no tool
catalog the model sees, no permission gate, no route and no screen uses them. The Hub reads the owner's server list and reports its state;
it connects to a server only when code calls `connect()`, and in this slice only the tests do. The later slices of P2 put the tools behind
the permission gate (ext-12), connect them to the agent, the spawned agents and the web transport (ext-11), harden them (ext-13), add the
API and the screen (ext-14) and test the whole path with real servers (ext-15).

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

- An id is 1 to 32 characters of `a-z`, `0-9`, `_` and `-`, starting with a letter; `local`, `studio`, `mcp`, `hub`, `datgold` and `chatmcp`
  are reserved. An unknown setting is an error, so a misspelt one is not ignored.
- `transport`: `stdio` (command, args, cwd, env) or `http` (Streamable HTTP: url, headers, env). `sse`, the legacy HTTP+SSE transport, is
  refused. A url is `https://`, or `http://` to `127.0.0.1`, `[::1]` or `localhost`; a user name or password in the url is refused.
- `enabled` (default `true`), `timeouts.connectMs` (1,000 to 120,000, default 30,000) and `timeouts.callMs` (1,000 to 900,000, default 120,000).
- `policy` is stored as given (a JSON object of at most 16 KiB) and **not enforced** in this slice.
- Secrets. A value is a string or `{"secret": "<blob>"}`, the blob made by `createProtector` (Windows DPAPI; AES-256-GCM elsewhere). An env
  name that looks like a credential (the `SECRET_ENV_NAME` rule of `lib/shell-runner.mjs`) and a credential header (`Authorization`,
  `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `Api-Key`, `X-Auth-Token`, `X-Access-Token`) are always stored protected, except a value that
  is only a reference (`"${NAME}"`, `"Bearer ${NAME}"`). Through `McpServerStore.save()` a value is a string, `{value, secret}` or
  `{keep: true}` (keep the stored secret). `list()`, `get()` and `status()` never return a secret, in plain or protected form: `{secret: true}`
  says only that one is set. When a connection is made every secret value is registered with `HubManager.registerSecret`, so the masker of
  the log hides it.
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
  refuse the whole list (`mcp_list_cursor_repeated`, `mcp_list_cursor_invalid`, `mcp_list_too_many_pages`), as do an empty, too long (over 128
  characters), control-character or duplicate name (`mcp_list_invalid_name`, `mcp_list_duplicate_name`). Each server's tools get a
  fingerprint (`fingerprint()` of `lib/catalog.mjs`).
- **Calls are never repeated.** `timeoutMs` (else `timeouts.callMs`) covers the whole call; when it passes, the SDK sends
  `notifications/cancelled` and the call ends with `mcp_call_timeout`. A lost answer (the process died, the HTTP response was cut off) ends
  with `mcp_connection_lost`. Both carry `executed: 'unknown'`: the server may have run the call. Nothing sends it again: the HTTP transport
  does not resume a broken stream (`reconnectionOptions.maxRetries = 0`), and the next call is a new call on a new connection.
- **HTTP**: `StreamableHTTPClientTransport` with the configured headers, `redirectPolicy: 'same-origin'`; a 2025 session is ended with
  DELETE when the connection is closed (not exercised: the HTTP servers of the suites are stateless or 2026-07-28). No OAuth in this slice: a
  server that answers 401 is not connected.

## Tests

| Suite | What it runs |
|---|---|
| `tests/verify-mcp-runtime.mjs` | Pins and closure, the loader, a real Hub with and without the runtime, stage + verify + tampering, `Verify-McpRuntime.mjs`, the compiled-in packages |
| `tests/verify-mcp-client-stdio.mjs` | The config rules; the real server-everything 2.3.1 and server-filesystem 2.4.0, the v2 fixture and a plain JSON-RPC server: tool counts against an independent `tools/list`, echo, negotiation, the `.cmd` (or shell) wrapper and its tree, the environment, pagination and its guards, the hung and the lost call, unknown result types, secrets in status and log, no process left after `close()` and `HubManager.shutdown()` |
| `tests/verify-mcp-client-http.mjs` | server-everything in its Streamable HTTP mode and the fixture on `createMcpHandler`: counts, negotiation in both eras, a secret header, the hung and the lost call, no SSE fallback, an absent server |

The servers come from `DATGOLD-HUB/tests/fixtures/mcp-reference` (package.json and lock file; `npm ci --ignore-scripts --prefix
DATGOLD-HUB/tests/fixtures/mcp-reference`), the SDK from `scripts/mcp-runtime`; CI installs both before `run-all --no-skip all`. Mutation lists:
`tests/mutation/mcp-runtime.json`, `mcp-client-stdio.json`, `mcp-client-http.json`. Child processes are counted by parent pid (and by the pids
the servers report), never by process name.

## Not verified

- A real installer build loading the SDK from the installed layout on a user's machine: `Build-Installer.ps1` runs the stage and
  `Verify-McpRuntime.mjs` (CI's windows-installer job does), but an installed DatGold has not been started against a real server.
- Servers beyond the two reference servers and the fixtures (servers built on other SDKs, Python servers, npx downloads on a slow network).
- OAuth for HTTP servers, `listChanged` notifications, resources subscriptions, the 2026-07-28 tasks extension.
- The mutation runner copies only `DATGOLD-HUB`: `scripts/mcp-runtime/stage.mjs` and `verify.mjs` are checked by the tampering cases of
  `verify-mcp-runtime.mjs` and the seeded defects of `verify-notices.mjs`, not by mutants.
