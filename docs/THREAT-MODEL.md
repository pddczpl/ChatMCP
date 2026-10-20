# Threat model: Hub credential, Companion outbound filter, Read Only classifier

Scope: ChatMCP 3.9.0 plus the phase-P0 changes. It covers the three attack surfaces that phase P0 added or rebuilt: the per-launch credential of the local Hub, the outbound filter and review hold of the ChatGPT Web Companion, and the Read Only command classifier. It builds on [SECURITY.md](../SECURITY.md) (the policy), [HUB-AUTH.md](HUB-AUTH.md), [COMPANION-PRIVACY.md](COMPANION-PRIVACY.md) and [ARCHITECTURE.md](ARCHITECTURE.md), and does not repeat them. It is written for one trusted owner on one Windows account; public or multi-tenant deployment is out of scope.

Every statement about code names a file and a symbol in the [code reference table](#code-references), written `[C7]`. `tests/verify-threat-model.mjs` checks that each file exists, that each symbol is in it, that each reference is used, and that this document and `SECURITY.md` state the same limits. A claim that no test exercises is marked **not tested**.

## The limit that decides everything else: same OS user

The Hub's per-launch secret is stored in `<data folder>/run/hub-session.json` [C3] [C4]. **Any process that runs as the same Windows user can read that file.** The desktop app, the launcher scripts and the installer read it, so nothing in the design can stop another program with the owner's rights from doing the same. The bearer therefore protects against:

- other Windows accounts on the same computer (the folder carries an ACL that grants only the owner's SID);
- sandboxed processes that cannot read the owner's files (low-privilege or restricted tokens);
- web pages and other browser origins (they cannot read the file, cannot set an `Authorization` header across origins without a CORS grant, and the Hub grants none to web origins).

It does **not** protect against malware or any other program running as the owner. Such a program can also read the workspace, the key store and the owner's browser profile directly; the Hub secret adds nothing for it. This is a stated boundary of the product, not a defect to be closed by more checks. Two exceptions inside the first bullet are listed below as risks RR-2 and RR-3.

## Assets

| ID | Asset | Where it lives |
|---|---|---|
| A1 | The Hub secret of the current launch | memory of the Hub; `run/hub-session.json` [C4]; `sessionStorage` of the dashboard tab |
| A2 | Workspace files, including credentials that happen to be in them | the project folder |
| A3 | Provider credentials and task transcripts | the per-user data folder (key store, `transcript.jsonl`) |
| A4 | The owner's ChatGPT account and chat history | chatgpt.com, reached through the Companion |
| A5 | The owner's approval decisions (Review, review before send) | Hub memory and the dashboard |

## Actors

| ID | Actor | Can do | Trusted? |
|---|---|---|---|
| X1 | The owner | everything | yes |
| X2 | A program running as the owner | read A1 to A3 directly | **no defence; accepted** |
| X3 | Another Windows account on the same computer | connect to 127.0.0.1, bind free ports, send any HTTP header | no |
| X4 | A process that cannot read the owner's files (low privilege, restricted token) | connect to 127.0.0.1 | no |
| X5 | A web page in the owner's browser | cross-origin requests, DNS rebinding, a Preview iframe on another loopback port | no |
| X6 | Another browser extension with host permission for 127.0.0.1 | requests that carry its own `chrome-extension://` Origin | no |
| X7 | Content the agent reads (repository text, skills, search results, tool output, model replies) | prompt injection that steers the model toward tools | no |
| X8 | The model provider and chatgpt.com | receive everything the Hub sends | partly; outside the Hub's control |

## Surface 1: the per-launch Hub credential

Flow in one paragraph. `main` makes a fresh 32-byte secret, removes `CHATMCP_HUB_SECRET` from its environment so that no child process inherits it, registers it with the log redactor and binds `127.0.0.1` only [C1] [C2]. It writes the session file after fixing the folder ACL [C3] [C4]. `createHubServer` then applies, in order, the Host check, the Origin check, one default-deny bearer gate for every `/api/*` and `/auth/*` request, and CSRF checks on mutations [C5]. A native or Node client, or a PowerShell helper script, that finds a Hub already running reads the session file and presents the secret only after the process that listens on the port is the one the file names [C12] [C13] [C26] [C27]. A dashboard receives the secret through a 60 second, single-use ticket in a URL fragment [C9] [C11].

| ID | Threat | Mitigation | Test | Limit |
|---|---|---|---|---|
| H1 | X3 or X4 calls the API | bearer required on every route except the named ones [C5] [C6] [C7] [C8]; session folder limited to the owner's SID, and the Hub refuses to start if the ACL cannot be applied or, read back, still lists another principal (an elevated process starts with SYSTEM and Administrators entries) [C3] | `verify-hub-auth.mjs` requests every route found in the source without the secret and reads the ACL of the session file | tested with one account; a second Windows account was never used. Exceptions: RR-2, RR-3 |
| H2 | X5 forges requests or rebinds DNS | Host allow-list, Origin allow-list, CSRF token in the state reply (only a bearer holder ever sees it), bearer in a header, never a cookie [C5] | `verify-hub-auth.mjs`, `verify-e2e-isolation.mjs` (inner layers, with a valid bearer) | none known |
| H3 | Guessing or timing the secret | 256-bit random value, constant-time comparison [C10] | comparison is exercised by `verify-hub-auth.mjs`; no timing measurement | none known |
| H4 | The secret leaks through a URL, a command line, the environment, logs or a child process | fragment ticket instead of the secret in the URL [C9] [C11]; environment variable deleted and secret registered with the redactor [C2]; terminal children get a clean environment | `verify-hub-auth.mjs` (terminal child does not inherit the secret) | the secret is in `sessionStorage` of the dashboard tab (a script in the dashboard origin could read it; CSP `script-src 'self'` limits scripts, **not tested** against a stored-XSS case) |
| H5 | A ticket is stolen or replayed | 60 s lifetime, single use, at most 16 outstanding, redeemed only with the dashboard's Origin and request marker [C11] [C5] | `verify-hub-auth.mjs` | a program that already reads the page's fragment (X2) wins the race |
| H6 | A stale session file or a recycled process id is trusted | the file is removed on clean exit only while pid and nonce are its own [C4]; the native shell, the installer, the Node launcher and the PowerShell helper scripts present the secret only to the process that listens on the port [C13] [C12] [C26] [C27]; the Node side and the scripts refuse, before any request, when another process listens, when nobody does and when the listener cannot be determined | `verify-hub-auth.mjs` (file removed on shutdown), `verify-hub-listener.mjs` (a real squatter process and a stale session file, through `attachToRunningHub`, `launch` and a second `hub.mjs`; a real Hub attached to), `verify-hub-listener-powershell.mjs` (the same attack on the three PowerShell scripts: no Authorization header reaches the squatter; a real Hub passes); the native check is C# code that no Node suite runs and this review did not run | a recycled process id is not detected (the check agrees when the stale file names the squatter's own pid; observed in `verify-hub-listener.mjs` and `verify-hub-listener-powershell.mjs`), and the check and the request are two steps: RR-4. The Node lookup exists for Windows and Linux; elsewhere the launcher refuses. The Linux branch was run here only on rows captured from a real kernel and on a made-up `/proc` (no Linux system with Node was available), so its first full run is the CI Linux job |
| H7 | A Hub from v3.9.0 or older (same version number, no secret) is attached to | health reports `auth: "bearer"`; clients refuse a Hub without it | `verify-hub-auth.mjs`; `scripts/tests/legacy-hub-upgrade/run.mjs` | none known |
| H8 | The WebView2 window follows an attacker link | new windows are cancelled and `http`/`https` links are sent to the page as a JSON message | `verify-native-hardening.mjs`, `ui/e2e/webview2-smoke.mjs` (real WebView2) | a link the owner opens in the browser is the browser's business |
| H9 | A Companion pairs with the wrong party | 8-digit code, valid 5 minutes, 10 attempts, consumed on success; later calls need the Companion's own 256-bit token and its Origin [C14] | `verify-hub-auth.mjs` (a wrong code is refused by the pairing check, pairing still works), `verify-outbound-hub.mjs` (a Companion played over HTTP); the 10-attempt limit and the 5-minute expiry are **not tested** | RR-3 |

## Surface 2: outbound filter and review before send

Everything the agent reads for a task and sends through the Companion goes into the owner's ChatGPT chat (A4, X8). The Hub scrubs and, optionally, holds that traffic before the extension can fetch it.

- **Scanner.** Text that has the shape of a credential is replaced by `[REDACTED:<label>]` [C15]. It runs on the tool result object before it is turned into text and paged, on prompts, handoff and continuation text, and again when a message is built or shown, so `poll()` and `claim()` never hand out a credential shape [C15] [C17].
- **Protected files.** A call or result that names `.env*`, `*.pem`, `*.key`, `id_rsa*` or another protected path is replaced as a whole by a short notice; the tool itself still ran [C16] [C23].
- **Review before send** (off by default, global or per workspace). A result is created in status `held`; `poll()` does not offer it, `claim()` refuses it, no timer sends it, and the owner chooses Approve, Redact more or Withhold. Ten minutes without a decision, or cancelling the task, ends the task with nothing sent and marks the delivery unverified so the resumer does not continue on its own [C17].
- **Ledger.** The task record keeps labels, counts and withheld file names, never a matched string [C18].

| ID | Threat | Mitigation | Test | Limit |
|---|---|---|---|---|
| O1 | A secret-shaped string reaches chatgpt.com | scanner on every outbound text path [C15] | `verify-outbound-redaction.mjs` (every credential format of its corpus, and the benign corpus must stay unchanged), `verify-outbound-runner.mjs` (real runner, what `poll()`/`claim()` return) | pattern-based: a secret with no recognisable shape, anything in an image or binary, and anything that is confidential only for a client are not caught |
| O2 | A protected file is read by a tool and sent | whole-result withholding [C16] | `verify-outbound-runner.mjs`, `verify-outbound-redaction.mjs` | applies when the call or the result names the file; a different file that contains the same secret is not recognised |
| O3 | The owner wants to see what leaves the machine | hold, preview and decision [C17] | `verify-outbound-review.mjs`, `verify-outbound-hub.mjs` (real Hub over HTTP), `ui/e2e/companion-privacy.spec.mjs` | only tool results are held; prompts and handoff text are scrubbed but not held; review is off by default |
| O4 | The held preview leaks to another party | preview served in `/api/state` behind the bearer; not in `/api/extension-state`, not in `poll()` | `verify-outbound-hub.mjs` | RR-1 applies |
| O5 | The ledger itself leaks a secret | labels and counts only; file names pass the scanner and are cut to 80 characters [C18] | `verify-outbound-runner.mjs` | none known |

## Surface 3: the Read Only classifier

In Read Only mode `PermissionGate` refuses every call whose category is not `read` or `checkpoint`, without asking [C24]. For `run_command` the category comes from the command text: `analyzeCommand` splits it into segments and gives each a kind (`read`, `verify`, `edit`, `exec`, `dangerous`) [C19] [C25]. A program counts as `read` only when `analyzeReadProgram` finds **every** option on that program's allowlist [C20]; `sed` additionally needs a script the strict grammar accepts [C21]. Anything unknown is `exec` and is refused in Read Only. A command the text analysis would let through then gets a second look at the file system: arguments that resolve outside the project, to a protected file, or through a junction raise it to `exec` [C22] [C23]. Tool descriptions and a provider's `readOnlyHint` are never trusted [C24].

| ID | Threat | Mitigation | Test | Limit |
|---|---|---|---|---|
| R1 | A "read" program writes or runs code through an option (`sed e/w/r`, `sort -o`, `uniq IN OUT`, `file -C`, `rg --pre`, `find -fprint`, `tree -o`, `less +cmd`, `date -s`) | per-program option allowlist, strict `sed` grammar [C20] [C21] | `verify-readonly-corpus.mjs` (attack corpus through the real classifier, gate and tools, with a positive control) | the corpus is written by the same author as the classifier; it shows the listed bypasses are closed, not that none exists |
| R2 | Redirection, command substitution, chaining or PowerShell aliases hide a write | tokenizer and per-segment analysis, alias table [C19] [C20] | `verify-command-analysis.mjs`, `verify-readonly-corpus.mjs` | shell grammar is re-implemented, not delegated to a shell |
| R3 | A wildcard expands to an option or to a secret; a junction leads out of the project | file-system pass after the text analysis [C22] [C23] | `verify-readonly-corpus.mjs` (needs-file-system cases) | the expansion is evaluated at check time; a change between the check and the run (race) is **not tested** |
| R4 | Reading a protected file or a file outside the project | protected-path rules in the read tools and the command pass [C23] [C22] | `verify-readonly-corpus.mjs` (protected file below a searched directory, outside the project) | Read Only still lets the model read project files and send them to the provider (X8) |
| R5 | A tool claims it is read-only | name-based classification, hints ignored [C24] | `verify-permissions-modes.mjs` (modes); the rule that a provider hint never lowers a category is **not tested** | none known |

The classifier reads command text. It is not an operating-system boundary: whether an allowlisted program can be made to write through the environment or through a configuration file that another process set is not established by the corpus (**not tested**).

## Residual risks

| ID | Risk | Who | Impact | Status |
|---|---|---|---|---|
| RR-1 | Same-user malware reads the session file and everything else | X2 | complete control of the Hub and workspace | accepted by design; stated in `SECURITY.md` and the README |
| RR-2 | `GET /api/extension-state` and `GET /api/instructions` answer without the secret to any request whose `Origin` header looks like `chrome-extension://` followed by 32 letters a to p [C7]. The check is a pattern, so a non-browser process on the machine (even another Windows account) or another browser extension can send that header. A web page cannot, because browsers do not let a page set `Origin`. | X3, X4, X6 | reads Hub version, workspace path, ready flag, generation and instance id; `proxyUrl` is always `null` and `/api/instructions` answers HTTP 410 in this build | open; fix: give the Companion a pairing token for these two reads and drop `EXTENSION_READ_ROUTES` |
| RR-3 | The Companion routes `/api/browser/clients/*` skip the Hub bearer [C8]; `pair` needs only the 8-digit code, and a request without an `Origin` header is accepted. Someone who sees the code (screen, shoulder) and pairs first becomes the Companion: it then receives tool results and supplies the model's replies. Guessing succeeds with probability about 10 in 90 million per code [C14]. | X3 (with the code) | impersonation of the model channel | open; mitigated by the 5 minute and 10 attempt limits |
| RR-4 | The session file outlives a crash and a health reply can be imitated, so a client must not present the secret to whatever answers on the port. The native shell and the installer [C13] do compare the process id that listens on the port with the session's. The Node launcher and the second-start path of `hub.mjs` (`attachToRunningHub`) did not: after a crash a program that bound port 3007 first could receive the stale secret and the project path, and the browser was opened on its page. They now compare it before any request carries the secret [C12] [C26]. The PowerShell helper scripts `Stop-ChatMcpHub.ps1` (behind STOP-CHATMCP-HUB.cmd), `windows/Run-StudioSmoke.ps1` and `windows/Test-Gateway-ViaHub.ps1` read the same file and sent its secret after a health check, to whatever answered it (the stop script also a shutdown request). They now ask `Get-NetTCPConnection` who owns the listening socket and stop with an explanation, before any request carries the secret, when that is not the process the file names, when nobody listens and when it cannot be told [C27]. Given `http://localhost:port`, the two development scripts connect to `127.0.0.1`: the name can resolve to `::1` first, where a squatter could listen while the check looks at `127.0.0.1`. A Hub from before the secret existed has no session secret, so the stop script stops it with the older flow and sends none. For every client that checks, a stale file that names the process id the squatter happens to have (a recycled id) and the gap between the check and the request are not detected, and on a platform other than Windows and Linux the Node launcher refuses instead of attaching. | X3 | the stale secret of a Hub that no longer runs (a later Hub makes a new one) and the project path, sent to a program of another account; before this change also a browser opened on its page; no live secret is exposed because the real Hub would hold the port | Node launcher and PowerShell helpers: closed, each tested with a real squatter (`verify-hub-listener.mjs`, `verify-hub-listener-powershell.mjs`). Recycled id and gap: accepted, they need a crashed Hub, a free port and a matching process id |
| RR-5 | The dashboard keeps the secret in `sessionStorage` | script in the dashboard origin | secret read | accepted; CSP restricts scripts; **not tested** against an injection case |
| RR-6 | `transcript.jsonl` and task files keep raw tool results; only exact registered secrets are masked there | X2 | local disclosure | accepted; the outbound filter protects what goes to chatgpt.com, not what is stored |
| RR-7 | A Companion waiting on a held message: the extension has no deadline for the Hub's next message and `waiting_approval` is not a terminal state for it, but this was only read in the code and exercised by scripted pages | owner | a stuck task, not a leak | **not verified** with a real chatgpt.com tab |
| RR-8 | Prompt injection through repository text, skills and tool output (X7) steers the model; the controls are the permission gate, the Read Only classifier and approvals, none of which is an operating-system boundary | X7 | actions the owner approves or Full Access allows | accepted; see `SECURITY.md` |
| RR-9 | The outbound scanner and the Read Only corpus are evidence of the rules doing what they were written to do, not measurements on unseen input | n/a | false assurance | stated here and in `COMPANION-PRIVACY.md` |

## Code references

| ID | File | Symbol | Role |
|---|---|---|---|
| C1 | `CHATMCP-HUB/lib/hub-session.mjs` | `createSecret` | 32 random bytes per launch; an override must match `SECRET_PATTERN` |
| C2 | `CHATMCP-HUB/hub.mjs` | `main` | takes the secret, deletes `CHATMCP_HUB_SECRET` from the environment, registers it with the redactor, listens on 127.0.0.1 only |
| C3 | `CHATMCP-HUB/lib/hub-session.mjs` | `protectDirectory` | `icacls` removes inheritance and grants the owner's SID only; failure is fatal |
| C4 | `CHATMCP-HUB/lib/hub-session.mjs` | `writeSession` | writes `run/hub-session.json` atomically; `remove()` deletes it only while pid and nonce are its own |
| C5 | `CHATMCP-HUB/hub.mjs` | `createHubServer` | Host check, Origin check, `hasBearer` default-deny gate, CSRF, ticket redeem |
| C6 | `CHATMCP-HUB/hub.mjs` | `PUBLIC_API_ROUTES` | the two unauthenticated probes |
| C7 | `CHATMCP-HUB/hub.mjs` | `EXTENSION_READ_ROUTES` | the two routes readable from a `chrome-extension://` Origin without the secret |
| C8 | `CHATMCP-HUB/hub.mjs` | `EXTENSION_PAIRED_ROUTE` | Companion routes with their own token |
| C9 | `CHATMCP-HUB/hub.mjs` | `SESSION_ROUTES` | ticket and redeem routes |
| C10 | `CHATMCP-HUB/hub.mjs` | `equalToken` | constant-time comparison |
| C11 | `CHATMCP-HUB/lib/hub-session.mjs` | `createTicketBook` | single-use tickets, `TICKET_TTL_MS` and `TICKET_LIMIT` |
| C12 | `CHATMCP-HUB/lib/hub-session.mjs` | `attachToRunningHub` | Node-side attach: `assertSessionListener` compares the listener's process id with the session's before any request carries the bearer (`lib/launch.mjs` runs the same check before it asks a Hub it just started for a ticket) |
| C13 | `native-shared/HubSession.cs` | `ReadForListener` | native clients: the secret is presented only to the process that listens on the port |
| C14 | `CHATMCP-HUB/lib/browser-runner.mjs` | `createPairCode` | pairing code, `pair`, `authenticate` (Origin and token checks) |
| C15 | `CHATMCP-HUB/lib/outbound-redaction.mjs` | `redactDeep` | secret-shape scanner over objects and text (`redactText`) |
| C16 | `CHATMCP-HUB/lib/outbound-redaction.mjs` | `withholdProtected` | whole-result withholding for protected files (`isDeniedOutboundPath`) |
| C17 | `CHATMCP-HUB/lib/browser-runner.mjs` | `openReview` | the held message; `decideOutbound`, `reviewEnabledFor` |
| C18 | `CHATMCP-HUB/lib/browser-runner.mjs` | `ledger` | labels and counts of what was removed |
| C19 | `CHATMCP-HUB/lib/command-analysis.mjs` | `analyzeCommand` | text analysis, kinds `read` to `dangerous` |
| C20 | `CHATMCP-HUB/lib/read-programs.mjs` | `analyzeReadProgram` | per-program option allowlists |
| C21 | `CHATMCP-HUB/lib/sed-script.mjs` | `checkSedScript` | strict `sed` grammar |
| C22 | `CHATMCP-HUB/lib/command-paths.mjs` | `pathProblems` | file-system pass: outside the project, protected files, junctions |
| C23 | `CHATMCP-HUB/lib/protected-paths.mjs` | `isProtectedPath` | protected-file rules (`mayExpandToProtected` for wildcards) |
| C24 | `CHATMCP-HUB/lib/permissions.mjs` | `PermissionGate` | Read Only refuses what is not `read` or `checkpoint`; hints are ignored |
| C25 | `CHATMCP-HUB/lib/local-tools.mjs` | `#assessCommand` | joins the text analysis and the file-system pass for `run_command` |
| C26 | `CHATMCP-HUB/lib/port-listener.mjs` | `listenerPid` | the process id that listens on a port: `parseNetstat` on the text of `netstat -ano` (Windows), `linuxOwners` over `/proc/net/tcp` and `/proc/<pid>/fd` (Linux), an error on other platforms; several owners or an owner that cannot be inspected is an error, never a guess |
| C27 | `CHATMCP-HUB/Stop-ChatMcpHub.ps1` | `Assert-HubSessionListener` | the PowerShell helper scripts (the stop script, `windows/Run-StudioSmoke.ps1`, `windows/Test-Gateway-ViaHub.ps1`) carry one identical copy: `Get-HubListenerPid` asks `Get-NetTCPConnection` for the listening sockets of the port (127.0.0.1 outranks the wildcards; several owners, an unknown owner or an unreadable table is a refusal) and the call precedes the first request that carries the secret |

## Evidence and what it does not show

| Test | What it exercises |
|---|---|
| `CHATMCP-HUB/tests/verify-hub-auth.mjs` | a real Hub process: every declared route without the secret, the named exceptions, the session file ACL |
| `CHATMCP-HUB/tests/verify-e2e-isolation.mjs` | Host, Origin, marker and CSRF layers |
| `CHATMCP-HUB/tests/verify-outbound-redaction.mjs` | scanner formats and benign corpus |
| `CHATMCP-HUB/tests/verify-outbound-runner.mjs` | the real `BrowserRunner` path, what `poll()` and `claim()` return |
| `CHATMCP-HUB/tests/verify-outbound-review.mjs` | the hold, its decisions and its timeout |
| `CHATMCP-HUB/tests/verify-outbound-hub.mjs` | review before send against a real Hub over HTTP |
| `CHATMCP-HUB/tests/verify-readonly-corpus.mjs` | bypass attempts through the real classifier, gate and tools |
| `CHATMCP-HUB/tests/verify-command-analysis.mjs` | the command analysis on its own |
| `CHATMCP-HUB/tests/verify-permissions-modes.mjs` | the modes of the gate |
| `CHATMCP-HUB/tests/verify-native-hardening.mjs` | the WebView2 new-window handling |
| `CHATMCP-HUB/tests/verify-hub-listener.mjs` | the listener check: both parsers on sample text and on rows of a real kernel, the decision, the real lookup, a real squatter process (it also records every byte it receives) refused through `attachToRunningHub`, `launch` and a second `hub.mjs`, a real Hub attached to, and the recycled-process-id limit |
| `CHATMCP-HUB/tests/verify-hub-listener-powershell.mjs` | the same check in the three PowerShell helper scripts: one identical block in each, its decision run in strict mode against a stand-in for `Get-NetTCPConnection`, a real squatter process refused by each script with no Authorization header, no secret and no `Bearer` among the bytes it received, a Hub that predates the secret, `localhost` connected to as `127.0.0.1` while a squatter listens on `::1`, the recycled-process-id limit, and a real Hub that the scripts get through (the stop script stops it) |
| `CHATMCP-HUB/tests/verify-threat-model.mjs` | this document against the code and against `SECURITY.md`; RR-2 and RR-3 observed on a real Hub, the listener check of RR-4 observed in the source and on that Hub, and in the source of the PowerShell helper scripts, so a regression forces a change of the documents |

Not covered by this model: the model provider's own security, the correctness of tool results, Full Access (it executes with the owner's rights by design), the optional Windows Sandbox driver, and supply-chain risks of the bundled runtimes ([LICENSE-SCAN.md](LICENSE-SCAN.md) covers their licenses only).
