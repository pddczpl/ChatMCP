# Hub authentication: the per-launch bearer secret

The Hub listens on `127.0.0.1:3007`, which every local process, every other Windows account and (through DNS rebinding or forged
requests) every web page you open can reach. Since this change the API is not open to them: each launch of the Hub makes a random
secret and every `/api/*` and `/auth/*` request must carry it as `Authorization: Bearer <secret>`.

**What this protects:** other Windows accounts, sandboxed processes that cannot read your files, and web pages in your browser.
**What it does not protect:** malware, or any program, running as you. It can read the same file the desktop app reads. Host, Origin and
CSRF checks remain as defense in depth.

## How it works

| Piece | Behaviour |
| --- | --- |
| Secret | 32 random bytes (64 hex characters) made in `hub.mjs main`; `CHATMCP_HUB_SECRET` (32–256 characters of `A-Za-z0-9_-`) overrides it for tests and is removed from the environment so terminals and tools never inherit it. It is registered with the log redactor. |
| Session file | `<data folder>/run/hub-session.json` = `{version, app, pid, port, secret, nonce, startedAt}`. The `run` folder is limited to the current user (`icacls /inheritance:r` + a grant to your SID on Windows, which fails closed; `0700`/`0600` elsewhere). It is written after the Hub holds its instance lock and before `/api/health` reports `initialized`, and removed on a clean shutdown (only while pid and nonce are still its own). A crash leaves a stale file, so the desktop shell, the installer and the Node launcher (`launch`, and the second-start path of `hub.mjs`) present the secret only to the process that listens on the port (the file's `pid`): a health answer is not proof, because a program that bound the port first can imitate it. The Node side asks `netstat -ano` on Windows and `/proc` on Linux (`lib/port-listener.mjs`), and refuses, before any request, when another process listens, when nobody does, when the listener cannot be determined and on any other platform. A recycled process id and the gap between the check and the request are the remaining limits ([threat model](THREAT-MODEL.md), H6 and RR-4). |
| Gate | One default-deny check right after the Host/Origin checks. Public: `GET /api/health`, `GET /api/capabilities`. Companion pairing routes (`/api/browser/clients/*`) keep their own pairing bearer. `GET /api/extension-state` and `GET /api/instructions` stay readable from a `chrome-extension://` Origin because the Companion has no secret (**residual:** a local program can forge that Origin to read the workspace path and version). Everything else, including every `GET /api/studio/*` route and the event streams, needs the bearer. |
| Health | `/api/health` and `/api/capabilities` report `auth: "bearer"`. A Hub without that field is from v3.9.0 or older (same version number!): clients refuse to attach to it and tell the user to stop it. |
| State and CSRF | `csrfToken` is part of `/api/state` and POST replies, so only a caller with the bearer ever sees it. |

## Why the event streams use `fetch`, not `EventSource`

`EventSource` cannot send an `Authorization` header. The alternative, a cookie issued after a bearer-authenticated bootstrap, was
rejected: cookies belong to a host, not a port, so a second Hub on another port (or any `127.0.0.1:<port>` dev server, including a
Preview iframe: same-site) would share or overwrite it, and a stale cookie after a Hub restart is invisible to `EventSource` (it
just retries) while `fetch` sees the 401 and can show "reopen ChatMCP". The React UI streams through `ui/src/lib/sse.ts`; the two
older dashboards (`/classic`, `/legacy`) load `web/hub-session.js`, which gives them a fetch-based `EventSource` and the header.

## How a page gets the secret

The long-lived secret never appears in a URL, a command line or browser history.

1. A holder of the bearer (the Hub itself, `launch.mjs`, the desktop shell) calls `POST /api/session/ticket` and gets a 60 second,
   single-use ticket (at most 16 outstanding).
2. The dashboard is opened at `http://127.0.0.1:3007/#chatmcp-boot=<ticket>`. A fragment is never sent to a server.
3. `ui/src/lib/session.ts` runs when the module loads (not in a React effect, so StrictMode cannot spend the ticket twice), removes
   the fragment with `history.replaceState`, calls `POST /api/session/redeem` (same Origin and `X-ChatMCP-Request` as a dashboard
   POST) and keeps the answer in `sessionStorage`.
4. A tab with no ticket and no stored secret, or one the Hub rejects (Hub restarted: new secret), shows the "reopen ChatMCP" screen
   instead of failing request by request. Reloading cannot fix it.

## Clients

* Desktop shell (`native-shared/HubSession.cs`, `desktop-shell/MainWindow.cs`): reads the session file, checks that `pid` listens on
  3007, gets a ticket and navigates WebView2 to the fragment URL. It never injects the secret with a document-created script
  (Preview iframes would run that too). It notices a Hub restart (pid or secret changed) and says so.
* Node launcher (`lib/launch.mjs`) and a second `hub.mjs` on the same port (`attachToRunningHub` in `lib/hub-session.mjs`): the same
  rule. When the process that listens on the port is not the one the session file names, the error names both process ids and
  nothing carries the secret: no state request, no ticket, no browser. `tests/verify-hub-listener.mjs` runs a real squatter
  process against all three entry points.
* Installer / uninstaller preflight (`HubLifecycle.StopInstalledHub`): secret path first; a Hub that predates the secret (no `auth`
  in its health) is stopped with the older flow, which fetches the CSRF token unauthenticated. A current Hub whose session cannot
  be read is **not** stopped.
* `Stop-ChatMcpHub.ps1`, `windows/Run-StudioSmoke.ps1`, `windows/Test-Gateway-ViaHub.ps1`: same rule; pass `-StateDir` when the
  Hub was started with `--state-dir`.
* Tests: `tests/e2e/hub-process.mjs` starts a Hub with a known `CHATMCP_HUB_SECRET` and adds the header in one place;
  `tests/verify-hub-auth.mjs` scans `hub.mjs` for every route and requests each without the secret.

See `scripts/tests/legacy-hub-upgrade/run.mjs` for the upgrade path from a secretless Hub, and `tests/verify-native-hardening.mjs`
plus `ui/e2e/webview2-smoke.mjs` for the WebView2 new-window handler (http/https only, delivered as a JSON web message).
