# Proof-of-Done: the `chatmcp verify` command line (P4 pod-24, P5 pod-26, pod-30, pod-32)

`chatmcp verify` is the command line of Proof-of-Done: it takes a baseline of a workspace, records check receipts in a proof ledger,
builds the proof pack of the change (an in-toto statement, [spec/agent-change-v0.1.md](spec/agent-change-v0.1.md), and the pack file that
carries it), and lets someone else check that pack and reproduce its checks. It is the first place a person can run the P4 modules
without the Hub: every command wires a module that already does the work.

| Command | Module it wires |
|---|---|
| `init` | `proposeAcceptance` of [PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md) (pod-20) |
| `trust` | the trust store of [PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md) (pod-20) |
| `snapshot` | `snapshotBaseline` of [PROOF-BASELINE.md](PROOF-BASELINE.md) (pod-25) and the ledger of [PROOF-LEDGER.md](PROOF-LEDGER.md) (pod-16) |
| `run` | `recordCheck` of the ledger (pod-16) with the Hub's `ShellRunner` and the tree snapshots of [PROOF-TREE.md](PROOF-TREE.md) (pod-15) |
| `exec` | the exec wrapper for any external agent (pod-26): `snapshot`, the agent, the marker reader of `lib/proof/marker.mjs` and the output adapters, `recordCheck` for each trusted check, `pack` |
| `check` | the pack file (pod-32, `lib/proof/cli/check.mjs`): `validateStatement` and `statementDigest` of the spec (pod-29), `verifyChain` (pod-16), and with `--tree` the tree snapshots (pod-15) |
| `reproduce` | the pack file, the trust store (pod-20), `git clone --shared` or a copy of a folder, `git apply`, and the check runner of [PROOF-CHECKS.md](PROOF-CHECKS.md) (pod-21, `runAcceptanceChecks`) |
| `show` | `loadBaseline` (pod-25) and `verifyChain` (pod-16); with `--pack` the pack file (pod-32) and the renderers of [PROOF-RENDER.md](PROOF-RENDER.md) (pod-30, `lib/proof/render/`) |
| `pack` | `diffBaseline` (pod-25), `detectCheckChanges` of [PROOF-TAMPER.md](PROOF-TAMPER.md) (pod-22) and `buildAgentChangeStatement` of the spec (pod-29) |

**Status: a command line of its own.** The grammar, the exit codes, the JSON answers and both languages are fixed here; every command
of the plan is built. Nothing in the agent or the app calls the CLI; the Hub builds its own packs with the builder of `pack`
(`lib/proof/pack-build.mjs`, [PROOF-HUB-API.md](PROOF-HUB-API.md)), and `check` reads them. The name keeps the old spelling, like `.chatmcp/` ([NAMING.md](NAMING.md)):
the command is `chatmcp`, its file `DATGOLD-HUB/bin/chatmcp.mjs`, its code `DATGOLD-HUB/lib/proof/cli/`.

## Running it

From a checkout: `node DATGOLD-HUB/bin/chatmcp.mjs verify <command>`. `DATGOLD-HUB/package.json` names it in `bin` (`chatmcp`) and lists
`bin/` and `lib/` in `files`, so `npm link` (or an install of a packed Hub) puts `chatmcp` on the PATH. It needs Node.js 22.12 or newer
and, for `pack`, Git.

A session, from the root of a Git repository:

```text
chatmcp verify init                        # writes .chatmcp/acceptance.yml from the project's files; review and edit it
chatmcp verify trust                       # shows the checks and the sha256 of the file: exit 1, not trusted yet
chatmcp verify trust --sha256 <sha256>     # trusts exactly those bytes
chatmcp verify snapshot                    # the baseline: starts a proof session
  ... the agent (or a person) changes the workspace ...
chatmcp verify run -- npm test             # runs a check and records its receipt
chatmcp verify pack                        # exit 0 when every criterion is evidenced
```

Or, in one command around any agent: `chatmcp verify exec -- <agent command>` ("`exec`" below).

`pack` also writes the **pack file** (`<taskId>.pack.json`, "The pack file" below): the statement with the patch, the ledger and the
acceptance file it names. Someone else checks it and reproduces its checks:

```text
chatmcp verify check change.pack.json                         # the schema, the digest, the files, the ledger: exit 0 when evidenced
chatmcp verify trust --pack change.pack.json                  # shows the setup and the checks it would run: exit 1, not trusted yet
chatmcp verify trust --pack change.pack.json --sha256 <sha256>
chatmcp verify reproduce change.pack.json --base <commit>     # from the repository the change was made in, or --base <folder>
```

And a report of it for people, in Markdown or HTML ("`show`" below):

```text
chatmcp verify show --pack change.pack.json > comment.md                     # Markdown, at most 65,000 characters
chatmcp verify show --pack change.pack.json --format html --lang vi --out report.html
```

## Grammar

```text
chatmcp verify <command> [options] [-- <words of the command>]
chatmcp verify check <pack> [options]        chatmcp verify reproduce <pack> --base <commit|folder> [options]
chatmcp verify --help        chatmcp verify <command> --help        chatmcp --version
```

- The first word is `verify`, the second the command. `chatmcp init` is `unknown_command`.
- Options can stand anywhere before `--`, before `verify` too: `--name value` or `--name=value`. A value that starts with `--` must be
  written `--name=value`. An option given twice is `repeated_option`; a flag given a value (`--json=1`) is `bad_value`.
- Options of every command: `--json` (one JSON answer on stdout), `--lang en|vi` (the language of the messages, English by default),
  `--workspace <folder>` (the workspace; the current folder by default; it is used as given, the CLI does not look for a repository root
  above it), `--help` / `-h`.
- `--` ends the options. `run` and `exec` take words after it (the command to run, the agent's command); no other command does.
- `check` and `reproduce` take the pack file as the one word after the command (relative to the current folder); without it the answer
  is `missing_argument`, and so it is for `reproduce` without `--base`.

## Exit codes

| Exit | Outcome | Meaning |
|---|---|---|
| 0 | `pass` | the command did what was asked, and what it checked holds |
| 1 | `unverified` | not verified, or not done: a check that failed, a criterion without evidence, a file that is not trusted, `init` finding a file there, a receipt that does not reproduce |
| 2 | `usage` | the command line is wrong, or the commands came in the wrong order (`run` before `snapshot`) |
| 3 | `integrity` | recorded evidence does not verify (the ledger, the baseline, the session's copy of the acceptance file, the baseline store, a pack file), or bytes are not the ones named |
| 4 | `environment` | this machine, this folder or this version of the CLI cannot do it: no Git repository for a pack (or for exec), no shell, the state folder inside the workspace |

Every answer has one code, and a code always has the same exit code (the table at the end).

## The commands

### `init`

`chatmcp verify init [--print]` builds a proposed `.chatmcp/acceptance.yml` from what the project's own files name (`package.json`
scripts, TypeScript, Playwright, pytest, `dotnet test`, Cargo, Go, make; one manual criterion when nothing is found) and writes it. It runs
nothing. It never overwrites: when the file is there, in any form, the answer is `acceptance_exists` (exit 1) and nothing changes.
`--print` writes nothing and prints the file itself (without `--json`, stdout is exactly the file, ready to redirect). A `.chatmcp` that
leads out of the workspace through a link is `acceptance_outside` (exit 4). This is **the only place the CLI writes into a workspace** on its
own (`show --pack --out` writes the report to the file the person names).

### `trust`

`chatmcp verify trust [--sha256 <hex>] [--revoke]` works on the raw bytes of `.chatmcp/acceptance.yml` on disk, the bytes the trust store
hashes ([PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md), "The bytes must come from one source"):

- without options it shows the sha256 of the file and every check it would let run: `not_trusted` (exit 1) with `trustCommand`, the
  exact command that trusts these bytes, or `trusted` (exit 0) when the store already holds the digest;
- `--sha256 <hex>` trusts the file only when its sha256 is that digest (any case): `trusted` (exit 0), else `sha256_mismatch` (exit 3)
  and nothing is trusted. So an approval names the bytes that were reviewed: a file changed between the preview and the approval is not
  trusted;
- `--revoke` removes the approval of the file's sha256 (or of `--sha256`, which needs no file): `revoked` or `already_untrusted` (both
  exit 0).

A file that does not read is `acceptance_invalid` (exit 1, with its line and reason); no file (or not a regular file) is
`acceptance_missing` (exit 1). The approval is recorded as made by `chatmcp verify trust`: no user name is written. The preview lists
the commands of `reproduce.setup` too (`data.setup`, lines `setup: <command>`): trusting the file lets them run in `reproduce`.

`--pack <file>` works on the acceptance file inside a pack file instead (pod-32, "`reproduce`"): the pack is checked whole first, as
`check` checks it (a pack that does not verify trusts nothing: its exit 3 code), then preview, `--sha256` and `--revoke` work as above on
those bytes, `data.pack` names the pack, and the preview's `trustCommand` is `chatmcp verify trust --sha256 <sha256> --pack <file>`. A
pack without an acceptance file is `acceptance_missing`. It is the same trust store and the same rule: a digest trusted once is trusted
for a workspace's file and for a pack's alike. With `--pack` no workspace is read, so the state folder may lie inside the current folder
(a home folder holds the per-user data folder).

### `snapshot`

`chatmcp verify snapshot` takes a baseline of the workspace (`snapshotBaseline`, the private store for a Git repository, the manifest
only for a plain folder) and starts a **proof session**: the task id is `cli-<baseline id>`, its ledger's first record is a `task_start`
that holds the baseline's sha256 (the anchor the baseline doc asks the caller to keep outside the baseline folder), and the raw bytes of
the acceptance file are copied into the state folder with their sha256 in that record. The acceptance file is read before and after the
snapshot; when it changed in between the answer is `workspace_changed` (exit 4) and no session starts. A new snapshot starts a new
session; the old one's files stay (the baselines are pruned by their own retention, 14 days and 10 per workspace).

### `run`

`chatmcp verify run [--shell bash|sh|powershell] [--cwd <folder>] [--timeout <seconds>] -- <command>` runs one command in the workspace
through the Hub's `ShellRunner` (over a StudioWorkspace shim whose manager is only `{workspace, secrets}`: the same containment and link
rules as the Hub) and appends its check receipt to the session's ledger with `recordCheck`: tree snapshots before and after, the
toolchain versions, the sha256 and byte count of each output stream and a 2 KiB masked preview. `check_passed` (exit 0) when the command
exits 0 within its time, `check_failed` (exit 1) otherwise; the receipt is recorded either way. `--cwd` is relative to the workspace
(`bad_cwd`, exit 2, outside it); `--timeout` is 1 to 900 seconds (120 by default); the shell is ShellRunner's default (bash when there is
one, Git Bash on Windows, else Windows PowerShell on Windows and sh elsewhere). Without `--json` the command's output is printed when it
ends (up to ShellRunner's 200,000 bytes, the middle dropped), then the receipt line.

`run` before `snapshot` is `no_session` (exit 2). On a ledger that does not verify it refuses with `ledger_broken` (exit 3) **before the
command runs**; a torn last line alone (a write cut by a crash) is repaired by the ledger's own rule (the next append records
`uncertain`).

#### The words after `--`

The plan names the risk: cmd.exe, PowerShell and bash quote and split differently. The rule:

- **One word** after `--` is the command text, unchanged: `run -- "npm test"` records exactly `npm test`. The person's own shell has
  already removed its quoting.
- **Several words** are joined with one space, each word quoted for the shell that runs it when it holds anything but the characters that
  need no quoting there. bash and sh: a word outside `A-Z a-z 0-9 _ @ % + = : , . / -` is put in single quotes (`'` written `'\''`).
  PowerShell: a word outside `A-Z a-z 0-9 _ + = : . / \ -` is put in single quotes, each single quote doubled (the curly ones PowerShell
  also reads as quotes too). So `run -- node test.mjs` and `run -- "node test.mjs"` record the same command.
- **Windows PowerShell 5.1** changes some words on their way to a program, quoted or not (measured on Windows 11 with the PowerShell the
  Hub runs): it drops an empty word and the word `--%` (its stop-parsing token), does not escape a double quote inside a word, and puts a
  word that holds white space in double quotes without doubling the backslashes before the closing one, so `C:\Program Files\` swallows
  the words after it. With `--shell powershell` such a word (empty, `--%`, holding `"`, or holding white space and ending with `\`) is
  refused (`unsafe_argument`, exit 2, `detail.why` `empty`, `stop_parsing`, `double_quote` or `trailing_backslash`) instead of running
  something else. bash and sh take every word, these included.

The receipt binds the command text (its sha256), and a pack matches a receipt to a check by that text: write the command in
`.chatmcp/acceptance.yml` as `run --json` reports it in `command` (or pass it as one word). Typed into each shell:

| Typed into | Works | Note |
|---|---|---|
| bash, sh, zsh | `chatmcp verify run -- node -e 'console.log(1)' 'a b'` | the shell's own quoting, as usual |
| cmd.exe | `chatmcp verify run -- node -e "console.log('a b')"` | cmd.exe passes the line as it is; double quotes group a word, `\"` is a quote inside one |
| Windows PowerShell 5.1 | `chatmcp verify run -- "node -e 'console.log(1+1)'"` | one word in double quotes, single quotes inside: PowerShell 5.1 removes the double quotes inside a word it passes to a program (`chatmcp` included) |

The suite types such lines into cmd.exe and powershell.exe on Windows, and into sh elsewhere, and checks what the program received.

### `exec`

```text
chatmcp verify exec [--timeout <seconds>] [--claim-marker <regex>] [--cost-usd <n>] [--adapter claude|codex|opencode]
                    [--shell bash|sh|powershell] [--agent <name>] [--agent-version <version>] -- <agent command>
```

`exec` (plan task pod-26) wraps any external agent: it takes a snapshot, runs the agent, reads its claim, runs the trusted checks and
builds the pack, in that order, in one command. Its code is `DATGOLD-HUB/lib/proof/cli/exec.mjs`; the adapters are
`DATGOLD-HUB/lib/proof/adapters/index.mjs`. A session, from the root of a Git repository whose acceptance file is trusted:

```text
chatmcp verify exec --adapter claude -- claude -p "Fix the failing test. <the marker contract>" --output-format json
```

exec's own options come before `--`; every word after it belongs to the agent's command. The prompt should end with the marker contract
(below), so that the agent ends its answer with `DONE` or `BLOCKED: <reason>`.

1. **Before anything runs.** The acceptance file must be there, read, and be trusted: `acceptance_missing`, `acceptance_invalid` and
   `not_trusted` (exit 1; `not_trusted` with `detail.trustCommand`) refuse before anything is written, so no agent runs without checks
   that count. The state folder must lie outside the workspace (`state_inside_workspace`, exit 4). The words after `--` are joined as for
   `run` ("The words after `--`": one word as it is, several quoted for the shell, the words Windows PowerShell 5.1 would change refused).
2. **The snapshot** starts a new session, as `snapshot` does (its `task_start` names `chatmcp verify exec`). The workspace must be a Git
   repository: without a patch there is no pack, so a plain folder is `not_a_repository` (exit 4, also `repository_unreadable` and
   `git_missing`) before the agent starts. The session that snapshot started stays current, as after `snapshot`.
3. **The agent** runs in the workspace through the shell: `--shell`, else ShellRunner's default (as for `run`).
   - Its **standard input** is closed (an empty input): an agent that waits for input gets the end of it at once and never hangs on a
     question. exec is for agents that run without a terminal of their own (`claude -p`, `codex exec`, `opencode run`); to hand one a
     prompt file, redirect inside its command, as one word: `chatmcp verify exec -- "codex exec - < prompt.txt"`.
   - Its **stdout and stderr** are read by exec. Without `--json` they are passed on to exec's own stdout and stderr as they come, then the
     answer follows; with `--json` nothing of them is printed (the JSON line stays the only output). Each stream is hashed (sha256) and
     counted whole and kept in the evidence folder (below). They are the bytes the shell hands on: with `--shell powershell`, Windows
     PowerShell 5.1 reads a program's output and writes it again (UTF-8, CRLF line ends, its own errors as CLIXML on stderr), so the
     hash is of those bytes, not of what the program wrote; bash and sh pass the program's own bytes. The claim reading counts CRLF as LF.
   - Its **environment** is the person's own, not scrubbed: an agent needs its credentials (the checks run scrubbed, as `run`'s do). On
     Windows Git Bash also gets `MSYS_NO_PATHCONV=1`, `MSYS2_ARG_CONV_EXCL=*` and `CHERE_INVOKING=1`, so the words reach the agent
     unchanged, and no child gets PowerShell 7's `PSModulePath` (as ShellRunner gives its shells).
   - `--timeout`: 1 to 86,400 seconds (a day), 3,600 by default. At the limit its whole process tree is killed with `killTree` of
     `lib/shell-runner.mjs` (taskkill `/T /F` on Windows, SIGKILL to the agent's process group elsewhere): `agent_timed_out`.
   - When its root process exits, what is left of its tree is killed too, so that nothing of the agent keeps changing the workspace while
     the checks run: on Linux and macOS its process group, which it leads (a process that left the group with `setsid` escapes); on
     Windows the processes the process table links to the root by parent id and creation time, **through living parents only**. A
     process whose parent has already ended is not found there and keeps running beside the checks: a background job of Git Bash
     (`cmd &`, which Git Bash starts from a short-lived copy of itself) or a detached child of a program that exited. A process the shell
     itself left (PowerShell's `Start-Process`) is found. A child that a Node program starts without `detached` ends with that program on
     Windows anyway (Node puts it in a job closed with its parent). `agent.treeLeft` says whether anything was left (null when Windows
     could not list its processes); while exec still waits for the output pipes, the streams are let go 1.5 s after the root exited
     (`agent.lingering`). Left means still there 2 s after the root exited: a killed process not yet reaped is not counted.
4. **The run is recorded** as one `call` record of the session's ledger, in exec's own closed shape of `call` (`kind` `agent_exec`,
   `format` `chatmcp.verify-exec/1`, beside the guard seam's tool calls of [PROOF-SERVICE.md](PROOF-SERVICE.md); the fields and their
   bounds are in [PROOF-LEDGER.md](PROOF-LEDGER.md), "Record types"): the
   command (cut to 4,096 characters; `commandSha256` is of the whole command), the shell, the agent's name and version, the exit code,
   the signal, `timedOut`, `interrupted`, the duration, the time limit, `stdout` and `stderr` as `{sha256, bytes, logged, truncated}`,
   the claim, the adapter's reading and the cost. The ledger masks every string of it (the digests are hex and stay as they are); the
   answer gives the same masked values. Output text is never in the ledger: only the logs hold it.
5. **The claim** is read from the end of the agent's final message ("The claim", below).
6. **The criteria**: every check of the baseline's acceptance file (the criteria are always the baseline's, as for `pack`) runs `repeat`
   times, or until its first run that does not pass, and each run is recorded with `recordCheck` as `run` records one: the default
   shell, the check's own `cwd` and `timeout`, the scrubbed environment, tree snapshots before and after. A check whose folder is gone has
   no receipt (`data.checks[].error`). The step is one function, `runCriteria` of `exec.mjs`, so that a later change can hand it to the
   check runner of pod-21 (`lib/proof/check-runner.mjs`) without touching the rest.
7. **The pack** is built as `pack` builds it, with the agent (`--agent`, else the adapter's name, else `unknown`; `--agent-version`, else
   the version the output names, else `unknown`), the model the output names (`model.id`), and the cost. It is in `data.statement` and in
   the state folder, as for `pack`.

The checks and the pack also follow an agent that failed, timed out, said BLOCKED or made no claim: the statement records what it left.

#### The claim

The marker contract is the corpus's, version 1 ([corpus/README.md](../corpus/README.md), "The marker contract"): the last line of the
final message is exactly `DONE` or `BLOCKED: <reason>`; CRLF counts as LF, white space at the very end is dropped, anything else (`done`,
`**DONE**`, `DONE.`, a marker followed by text) is no claim. Its one reader, `parseFinalMarker`, lives in `lib/proof/marker.mjs`, and
`corpus/tools/marker.mjs` is a third bridge from the corpus into DatGold that passes it on: the CLI is packaged from `bin/` and `lib/`
only and nothing in `lib/` imports `corpus/`, the bridges are the corpus's one way into DatGold (`verify-corpus-tools` checks both
directions), and one copy means that the scoring and exec cannot read a claim differently. When the corpus is split out, the file is
vendored with the other bridged files.

- **Where the final message is.** With an adapter that recognised the output, the final message it found there. Otherwise stdout, read
  as text, of which only the last 64 KiB count: when stdout is longer, only the lines that lie wholly inside that window are read (what
  follows its first line break). A final line that began before the window, or white space after the marker longer than the window, is
  then no claim, never a marker the stream does not end with.
- **`--claim-marker <regex>`** names a DONE marker of your own, for an agent that cannot be told to write `DONE`: a JavaScript regular
  expression (`u` flag), 1 to 200 characters, that must match the **whole** final line: it is wrapped as `^(?:<pattern>)$`. A pattern
  that does not compile on its own (so also one that closes the wrapper's group, such as `DONE)|(READY`, which would otherwise escape
  the anchors), or that matches an empty line, is `bad_value` (exit 2). With it, a final line it matches is the claim DONE and the plain `DONE` no
  longer counts; `BLOCKED: <reason>` stays the contract's, so a custom marker never turns BLOCKED into DONE. The final line is tested up to
  1,000 characters; a pattern that runs longer than 1 second on it is stopped and the claim is none (`claim.markerTimedOut`).
- The final line is recorded as `claim.line`, up to 1,000 characters; `claim.from` is `stdout` or `adapter`, `claim.rule` `contract` or
  `claim-marker`.

#### Adapters

`--adapter <name>` reads the machine-readable output an agent CLI documents, to find its final message and, when the output states
them, its cost, its model and its version. Adapters are **optional** (without one, the claim comes from stdout as text) and
**version-stamped**: each has its own `version` (raised whenever what it reads changes) and `checked`, the day its documentation was read;
both are in the ledger record and in `data.adapter`. An adapter only parses the text it is handed: it imports nothing, reads no file,
starts no process and makes no network call. Output it does not recognise (`empty`, `not_json`, `no_result`, `no_events`,
`format_not_documented`, or `output_too_large` when stdout was over the 16 MiB log limit) is `recognized: false`, nothing of it is used,
and the claim is read from stdout as text.

| Adapter | Reads | Documentation (checked 2026-11-23) |
|---|---|---|
| `claude` | `claude -p` with `--output-format json` (one result object) or `stream-json` (JSON Lines): the last `result` event's `result` (the final text), `is_error` and `total_cost_usd`; the `system` `init` event's `model` and `claude_code_version` | https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/agent-sdk/typescript |
| `codex` | `codex exec --json` (JSON Lines of events): the text of the last `item.completed` `agent_message`; `turn.failed` and `error` events; no cost is documented | https://learn.chatgpt.com/docs/non-interactive-mode, https://github.com/openai/codex/blob/main/docs/exec.md |
| `opencode` | nothing: opencode documents no machine-readable output of `opencode run`, so this adapter reads nothing and the claim comes from its plain text output | https://opencode.ai/docs/cli/ |

Agent CLIs change quickly. When a vendor changes its output, the adapter answers `recognized: false` rather than guessing, and its
`version` moves when it is updated. Only the documented shapes are read: one result object, or JSON Lines. What `claude -p
--output-format json --verbose` prints is not documented (the pages above pair `--verbose` with `stream-json` only); an array of
messages is `no_result` and is not read, so use `--output-format json` without `--verbose`, or `stream-json`.

#### Cost

A cost nobody states stays `unknown`, in the answer and in the pack. `--cost-usd <n>` records the cost **you** state for this run (from
the bill or the vendor's console), in US dollars with at most six decimals, as `{currency: "USD", knownSubtotal: n, complete: true}`:
complete, because you state the whole cost of the run; exec does not check it. It wins over an adapter's. The `claude` adapter's
`total_cost_usd` is recorded as `{currency: "USD", knownSubtotal, complete: false}`: Claude Code's docs call it an estimate made on the
client. Codex and opencode state no cost, so it stays unknown. `data.costSource` (and the ledger record) says `option`, `adapter` or null.

#### The evidence folder

`<state>/proof/cli/<key>/<taskId>.exec/` holds `stdout.log` and `stderr.log`: the raw bytes of each stream, up to **16 MiB** each (so at
most 32 MiB per exec). What comes after the limit is hashed and counted but not kept: `logged` is what the log holds, `truncated` says
whether it is shorter than the stream. The folder is in the state folder, never in the workspace, and is not pruned.

#### Exit codes of exec

The answer after the agent ran, first match wins:

| When | Code | Exit |
|---|---|---|
| a Ctrl-C (or SIGTERM, Ctrl-Break) came while the agent or a check ran | `exec_interrupted` | 1 |
| the agent ran past `--timeout` | `agent_timed_out` | 1 |
| the agent exited with a code other than 0, or was ended by a signal (it crashed) | `agent_failed` | 1 |
| the agent said `BLOCKED: <reason>` (the reason is in the message and `data.claim.reason`) | `agent_blocked` | 1 |
| the final message ends with no marker | `no_claim` | 1 |
| it said DONE, and a criterion failed or its checks were modified: the claim is refuted (a false DONE) | `claim_refuted` | 1 |
| it said DONE, nothing is against it, but not every criterion is evidenced (stale, untrusted by now, manual, none at all) | `claim_unverified` | 1 |
| it said DONE, exited 0, and every criterion is evidenced or owner-accepted | `exec_evidenced` | 0 |

Before the agent runs: `acceptance_missing`, `acceptance_invalid`, `not_trusted` (1), a wrong command line (2), `not_a_repository`,
`state_inside_workspace`, `shell_unavailable` (4). A refusal after the agent ran (a pack whose patch cannot be made, a ledger that cannot
be written) keeps its own code and exit; the agent's run and the receipts so far are in the ledger.

#### Ctrl-C

exec listens for Ctrl-C (SIGINT), SIGTERM and Ctrl-Break while the agent and the checks run:

- On the first one, Linux and macOS pass SIGINT on to the agent's process group (the agent leads its own group, so the terminal's
  Ctrl-C does not reach it otherwise); on Windows the console has already given every process of the agent's tree its own Ctrl-C. The
  agent then has **5 seconds** to stop by itself; after that its tree is killed with `killTree`. A second Ctrl-C kills it at once.
- A Ctrl-C while a check runs cancels the check (ShellRunner kills its tree); a check stopped that way leaves no receipt.
- Then the agent's run is recorded (`interrupted: true`), no further check runs and no pack is built: `exec_interrupted` (exit 1). The
  session stays current, so `run` and `pack` can finish it by hand.
- During the snapshot, before the agent starts, and during the pack, after the checks, Ctrl-C ends the CLI at once, as for any other
  command: nothing of the agent runs then.

The suite fires the interrupt through `main()`'s `signals` on every platform and sends a real SIGINT on Linux and macOS. Windows has no
way to send one process a Ctrl-C, so a real console Ctrl-C on Windows is not tested.

#### What exec does not do

- The claim is not a field of the agent-change predicate v0.1, whose schema is closed: it is in the ledger's `call` record, which the
  pack binds through `ledger.lastHash`, and in exec's answer.
- The agent runs as you, so it can read and rewrite the state folder: the integrity level stays the spec's `unconfined`. What exec records
  is tamper-evident, it is not tamper-proof.
- On Windows, a process of the agent whose parent ended before it (see step 3) survives the agent and can still change the workspace
  while the checks run; their receipts then show a tree that moved (`treeBefore` and `treeAfter` differ). Node gives no Job Object for a
  tree on Windows; it would need native code.
- No vendor CLI runs in the suite: its agents are small Node scripts, and the adapters were written from the vendors' documentation. A
  run with `claude -p`, `codex exec` and `opencode run` is the owner's (paid or live) and is not recorded here.

### `check`

`chatmcp verify check <pack> [--tree]` (plan task pod-32, `lib/proof/cli/check.mjs`) verifies a pack file ("The pack file" below), made
here or anywhere else. It needs no state folder, no session and no repository, runs nothing and writes nothing. In this order, the first
failure wins (every one is exit 3):

1. **The bytes**: at most 256 MiB, UTF-8, JSON, and **canonical**: the text must be exactly `canonicalJson` of what it holds (and one line
   end, LF or CRLF, or none). So white space, key order, number and string spellings and duplicate keys are all refused
   (`pack_unreadable`, `detail.why` `too_large`, `not_utf8`, `not_json`, `not_canonical`; a statement given alone, such as the
   `.statement.json` beside the pack file, is `statement_only`).
2. **The pack's schema**: the format `chatmcp.proof-pack/1`, the four fields, the three files and nothing else (`pack_invalid`,
   `detail.part` `pack`, the first errors in `detail.errors`).
3. **The digest**: `statementDigest` of the statement is the `statementDigest` the pack records (`pack_digest_mismatch`).
4. **The files**: each one's base64 is the one form Node writes, and its bytes have the recorded size and sha256 (`pack_file_mismatch`,
   `detail.why` `base64`, `bytes`, `sha256`).
5. **The statement**: `validateStatement` of the spec, its schema and every rule beyond it (`pack_invalid`, `detail.part` `statement`).
6. **The files against the statement**: the patch is the `change.diff` subject; an acceptance file is there exactly when the statement
   names one, and has its `baselineSha256` (`pack_file_mismatch`, `detail.why` `subject`, `presence`, `statement`).
7. **The ledger**: its whole hash chain verifies (`verifyChain`); the statement's ledger summary is the chain's (records, last hash, no
   break, the number of check records, the receipts left out); every receipt of the statement is the ledger's `check` record of its seq:
   the hash of its line, its time, the sha256 of its command and arguments, its exit code, timeout, cancel and signal, its duration, the
   sha256, size and cut of each output stream, its trees (`pack_ledger_broken`, `detail.why` `chain`, `summary` or `receipt`, with
   `brokenAt`, `field`, `seq`). The texts of a receipt are not compared: the statement holds them masked and cut.
8. **The criteria, rolled up again**: the spec's rules hold a statement to the receipts it lists, so a run it leaves out (a failure on
   the final tree, say) is beyond them. check re-derives the criteria with the spec's own `rollUpCriteria` from what the pack carries:
   the whole ledger, the final tree (`workspace-tree-after` and `trees.after`) and the acceptance file. A pack does not record the limits
   its builder used and a statement built with lower ones must still verify, so what no limit changes is compared exactly: the criteria's
   ids and order, each one's kind and status, each check's command (`commandSha256`), folder, expected exit, repeat, result and number of
   passes, and the reasons other than `checks_modified`, in order (no limit cuts them in a statement the spec's rules accept). A check's
   listed receipts must be among the ones the roll-up lists (all of them under the default limits; fewer under a lowered
   `maxReceiptsPerCheck`) and must hold the run its reason names (the latest failure on the final tree of a `failed` check, the run of a
   `stale` one), which the spec lists whatever the limit. The first difference is `pack_invalid` with `detail.part` `rollup` and
   `detail.criterion`, `detail.check`, `detail.field`. A folder masked with a registered secret the checker does not know would differ;
   the CLI registers none. Three
   inputs of the roll-up are in a pack only as facts of the statement itself, and are taken from it: whether the acceptance file was
   trusted (`acceptance.trusted`), the check-changes report (`checkChanges.reported` and, per criterion, its `check_changes_unknown` and
   `checks_modified` reasons; findings beyond the 64 listed only as their count) and the owner acceptances (their `owner_accepted`
   reasons; the tree of one made for another tree is not recorded). An acceptance file that does not read is `field` `acceptance`.

The cheap steps come first, so a changed byte is found before the spec's rules run; the suite changes every byte of a pack, one at a
time, and each one is refused with exit 3. Then:

- With **`--tree`**, the workspace (`--workspace`, or the current folder) is snapshotted (pod-15, with the pack's tree algorithm when it is
  `raw-v1`) and compared with the pack's final tree, `workspace-tree-after`: the same algorithm, object format and id. When it differs the
  answer is `tree_mismatch` (exit 1; `data.tree`): the pack is intact, but it is not about this workspace. The snapshot's private index
  is kept in the state folder, as for `run`.
- `pack_verified` (exit 0) when there is at least one criterion and every one is `evidenced` or `owner_accepted`, as for `pack`;
  `pack_not_evidenced` (exit 1) otherwise.

**What check proves, and what it does not.** A pack is not signed (the spec's v0.1). check proves that the pack is whole and holds
together: nothing in it was changed on its own, its receipts are the records of a ledger whose chain verifies, its statement obeys the
spec, and its patch and acceptance file are the ones the statement names. **The check results, the passes and the statuses are
re-derived from the ledger the pack carries** (step 8): a failure on the final tree that the statement leaves out of its receipts is
found. **`checks_modified`, `check_changes_unknown` and the owner acceptances are taken from the statement as written**, as is whether the
acceptance file was trusted: the pack holds no independent source for them. And check **does not prove who made the pack**: a pack made
again from start to end, every hash and the digest recomputed, verifies (the suite shows one). That needs signing (a later version of the
spec), or `reproduce`.

### `reproduce`

`chatmcp verify reproduce <pack> --base <commit|folder>` (plan task pod-32, `lib/proof/cli/reproduce.mjs`) runs the checks of a pack
again, on this machine, and says of each receipt whether it reproduced.

**Nothing runs without trust.** A pack can come from someone else, so its checks and its `reproduce.setup` are commands someone else
wrote. reproduce runs none of them unless the person trusted the exact bytes of the pack's acceptance file in the trust store of `run`
and `exec` (`chatmcp verify trust --pack <file> --sha256 <sha256>`, above). An untrusted file answers `not_trusted` (exit 1) with
`detail.trustCommand` and the commands it would run (`detail.setup`, `detail.checks`; the human answer lists them), and nothing is made:
no temporary folder, no process. Before that, the pack is checked whole as `check` checks it (exit 3 when it does not verify), and a pack
with nothing to compare (no acceptance file, or no receipt on its final tree) is `nothing_to_reproduce` (exit 1).

Then, in a temporary folder (`chatmcp-reproduce-<random>` in TEMP or TMP on Windows, TMPDIR, TMP or TEMP elsewhere) that is **removed at
the end, also after a failure and after Ctrl-C**:

1. **The base.** `--base` names an existing folder, else a commit of the workspace's repository (`--workspace` or the current folder,
   which must hold `.git`: `bad_base`, `detail.why` `no_repository`; a name Git does not resolve to a commit is `unknown_commit`, a value
   that starts with `-` is `bad_value`). A folder is copied (without its own `.git`) into a new repository; a commit is checked out in a
   clone that shares the repository's objects (`git clone --shared --no-checkout`, then `git checkout --detach`), which writes nothing
   into the repository. Git runs pinned, as the tree engine runs it: no system or global configuration, no line-end conversion
   (`core.autocrlf=false`), hooks pointed at an empty folder. The base is snapshotted (pod-15) and must be the pack's
   `workspace-tree-before`, its algorithm, object format and id, else `base_mismatch` (exit 1, `detail.expected`, `detail.actual`) and
   nothing runs.
2. **The patch**, applied with `git apply --binary` to the files (not to the index), must give the pack's `workspace-tree-after`:
   `patch_does_not_reproduce` (exit 3) with `detail.why` `apply_failed` or `tree_differs` otherwise. A pack whose own patch does not lead
   from its before tree to its after tree is not whole; reproduce is where that shows, since check has no base.
3. **The setup**: each command of `reproduce.setup`, in order, through ShellRunner in the temporary worktree (the scrubbed environment of
   the checks, up to an hour each). The first that does not exit 0 stops everything: no check runs and every compared receipt is
   `divergent` with the reason `setup_failed`; `data.setup` has its outcome and the last 2,000 characters of its output, masked.
4. **The checks**, through the check runner of [PROOF-CHECKS.md](PROOF-CHECKS.md) (pod-21, `runAcceptanceChecks`): the same trust gate
   again, each check's own `cwd`, `timeout`, `expect` and `repeat`, a failure never run again, a check that changed the tree run again,
   tree snapshots before and after, and what a check leaves running reaped (on Windows too, where a Git Bash background job has no living
   parent: the runner watches the process table while the check runs). Its receipts go to a ledger in the temporary folder, which is
   removed with it. When a compared receipt diverges for any reason but the setup or a check that did not start, **the checks run once
   more** (`data.passes` is 2), so that an outcome that changes between runs here is told from one that is stable.
5. **The comparison.** A receipt of the pack is compared when it is a run of a check of the pack's acceptance file (its command's sha256
   and its folder, the spec's rule), was not cancelled, and started on the pack's final tree; the others are listed in `data.notCompared`
   with `other_tree` (a run on an earlier tree, which the pack does not hold), `not_a_check` (a command of no check: it is not trusted)
   or `cancelled`. A compared receipt is **`reproduced`** when every run of its check here had its outcome: the same exit code, or the
   same timeout or signal (`exit 0`, `exit 3`, `timed out`, `signal SIGKILL`). A failure that fails again is reproduced too: reproduce
   checks the evidence, not the criteria (check says whether they are evidenced). Otherwise it is **`divergent`** with the first reason
   that holds:

| Reason | When |
|---|---|
| `setup_failed` | a command of `reproduce.setup` did not exit 0; no check ran |
| `not_run` | the check did not start here (its folder is gone after the patch, ...: the check runner's error) |
| `flaky` | the runs here had more than one outcome, or the pack itself has the outcome found here for another run of this check on its final tree |
| `timed_out` | the run here, or the pack's, timed out |
| `missing_environment` | the command names a variable (`$NAME`, `${NAME}`, `$env:NAME`) that the checks here do not get: not set, empty, or removed as a credential by ShellRunner's scrub; a missing secret shows here |
| `shell_differs` | the pack's run used another shell than the checks here (`bash`, `sh`, `powershell`) |
| `toolchain_mismatch` | a tool whose version the pack's receipt recorded (`node`, `python`, `dotnet`, `git`) has another version here, or none |
| `exit_differs` | any other outcome: `exit 0 in the pack, exit 1 here` |

`detail` says what was seen. Output hashes are **not** compared: a run's output names its folder, its times and its versions, so its
sha256 rarely matches on another machine even when the check behaves the same; only the outcome is, and the reasons explain the rest.

The answer is `reproduced` (exit 0) when every compared receipt reproduced, `reproduce_divergent` (exit 1) otherwise, both with the share
of reproduced receipts (`data.share`, from 0 to 1, and in the message: `Reproduced 3 of 4 receipts (75%)`). `data.trees.checks` is the
tree the checks started on, and `checksOnPackTree` whether it is the pack's final tree (a setup that writes files `.gitignore` does not
hide moves it). A temporary folder that could not be removed is named in `data.leftover` (or `detail.leftover`).

**Where it writes.** Only in the temporary folder, which must lie outside the base folder, and outside the repository a base commit is
cloned from (`state_inside_workspace`, exit 4, before anything is made). The person's repository, its `.git` and the base folder are
never written (the suite compares every byte of them, `.git` included); a check reproduce runs writes where it likes inside the temporary
worktree. reproduce keeps no state of the workspace and reads only the trust store of the state folder, so the state folder may lie
inside the current folder.

**Ctrl-C** (SIGINT, SIGTERM, Ctrl-Break) while the base is built, the patch applied, the setup or a check runs stops what runs (the check
runner kills the check's tree), removes the temporary folder and answers `reproduce_interrupted` (exit 1, `detail.step`). Before the
pack is read and after the answer, Ctrl-C ends the CLI at once, as for any other command. The suite fires it through `main()`'s `signals`
on every platform and sends a real SIGINT on Linux and macOS.

**Across systems.** A pack made on one system reproduces on another when its checks behave the same there: the trees are the pod-15
engine's, which hashes the bytes as Git would store them, so a base checked out with LF or CRLF line ends by `.gitattributes` gives the
same id. A base whose working files differ (a Windows checkout with `core.autocrlf=true` and no `.gitattributes`) is another tree:
`base_mismatch` says so. `tests/fixtures/proof-reproduce/` holds a pack made on Windows by a real session of this CLI
(`win32.pack.json`; `fixture.mjs --write` makes the pack of the system it runs on); the suite checks it and reproduces it from a folder
and from a commit on every CI system (Linux, macOS, Windows).

**What reproduce does not do.** It compares outcomes, not outputs. A folder base is its files: Git's index is not read, so a file the
repository tracks under an ignore rule is left out of the tree and the trees differ (`base_mismatch`; use `--base <commit>`); a nested
repository is copied with its `.git`. Symbolic links are copied as links (Windows needs the privilege to make one). Git LFS and other
filters do not run (the pinned configuration has none): a pack of a repository that uses them does not reproduce from a commit. The
checks run as the person, not in a sandbox: trust only a file you have read.

### `show`

`chatmcp verify show` reads the current session and checks it: the ledger (`verifyChain`), its `task_start`, the session's copy of the
acceptance file against the sha256 the ledger holds, and the baseline against the anchor (`loadBaseline`). `session_intact` (exit 0)
lists the baseline, the ledger, the last 50 receipts, and whether the acceptance file of the baseline and the one on disk now are trusted.
It writes nothing and takes no snapshot.

```text
chatmcp verify show --pack <file> [--format md|html] [--lang en|vi] [--out <file>]
                    [--vnd-rate <n> --vnd-rate-date <YYYY-MM-DD> --vnd-rate-source <text>]
```

`show --pack <file>` (plan task pod-30, `lib/proof/cli/report.mjs`) shows a **pack file** instead, as a report people read: what it says,
and how it keeps the texts of a pack from being markup, is in [PROOF-RENDER.md](PROOF-RENDER.md). It needs no session, no state folder and
no repository, and runs nothing.

- The pack is checked whole first, as `check` checks it: a pack that does not verify renders **nothing** (its exit 3 code, stdout empty).
- `--format` is `md` (the default: Markdown for a pull request comment, at most 65,000 characters) or `html` (one file). The language is
  that of `--lang`.
- Without `--out` (and without `--json`), stdout is exactly the report: `report_printed`. With `--json` it is `data.text`.
- `--out <file>` (relative to the current folder) writes it there instead, never over anything that is there: `report_written`, else
  `report_exists` (exit 1) and nothing changes. It is the one file of this command, in a folder that exists.
- `--vnd-rate` with `--vnd-rate-date` and `--vnd-rate-source` adds the cost in Vietnamese dong at that rate, shown with its date and source;
  one without the others is `missing_argument`. There is no built-in rate and none is fetched.
- **Exit 0 says that the pack verifies and the report was made, not that its criteria are evidenced**: a report is wanted most when they are
  not. `data.verdict` names the verdict; gate on `check`.
- `--format`, `--out` and the rate without `--pack` are `missing_argument`: the session has no report (build a pack first).

### `pack`

`chatmcp verify pack [--agent <name>] [--agent-version <version>]` builds the proof pack of the session:

- the trees: the baseline's and the final one of `diffBaseline`, which also makes the patch (the `change.diff` subject is its sha256);
- the acceptance file: the session's copy of the raw bytes taken at the snapshot (the criteria are always the baseline's), resolved with
  the trust store; the file on disk now only says whether it was edited;
- the check-changes report: `detectCheckChanges` between the baseline (read from the baseline's private store, every blob hashed against
  its id) and the workspace now;
- the ledger: its bytes as they are; `baseCommit` is the commit the baseline was taken on; the agent is `unknown` unless `--agent` and
  `--agent-version` name it (the CLI observes a change, it does not know who made it).

The statement is written as canonical JSON to the state folder (`<taskId>.statement.json`, its digest in `data.digest`) and is in
`data.statement` with `--json`; beside it, the pack file (`<taskId>.pack.json`, `data.packFile`, "The pack file" below) carries the
statement with the patch, the ledger and the acceptance file, for `check` and `reproduce` elsewhere. `pack_evidenced` (exit 0) when there is at least one criterion and every one is `evidenced` or
`owner_accepted`; `pack_unverified` (exit 1) otherwise: stale evidence, an untrusted file, changed checks, a failed check, a manual
criterion (owner acceptances come with the Proof tab, pod-34; the CLI passes none). A plain folder has no patch, so its pack is
`not_a_repository` (exit 4); the other reasons a patch cannot be made are in the table below.

## The pack file

`pack` (and `exec`) write it beside the statement, `<state>/proof/cli/<key>/<taskId>.pack.json` (`data.packFile`); `check` and
`reproduce` read it. It is for someone who does not have this state folder: the statement names the patch, the ledger and the acceptance
file only by their hashes, so the pack file carries their bytes. One line of canonical JSON (RFC 8785, the spec's `canonicalJson`) and a
line end, at most **256 MiB** (`pack_too_large`, exit 4, and neither file is written):

```json
{"files":{"acceptance.yml":{"base64":"...","bytes":412,"sha256":"..."},"change.diff":{"base64":"...","bytes":933,"sha256":"..."},
 "ledger.jsonl":{"base64":"...","bytes":5120,"sha256":"..."}},"format":"chatmcp.proof-pack/1","statement":{...},"statementDigest":"..."}
```

| Field | What |
|---|---|
| `format` | `chatmcp.proof-pack/1` |
| `statement` | the in-toto statement of the spec, as in `<taskId>.statement.json` |
| `statementDigest` | `statementDigest(statement)`: the sha256 of its canonical JSON (the spec's digest, covering its subjects and its predicate) |
| `files` | the bytes the statement names, each `{sha256, bytes, base64}`: `change.diff` (the patch, the `change.diff` subject), `ledger.jsonl` (the session's ledger as it was when the pack was built), and `acceptance.yml` (the acceptance file of the baseline, only when the statement names one) |

The pack file is a CLI container around the predicate, not a part of it: the statement inside it is exactly the spec's.

## JSON answers

With `--json` the CLI writes exactly one line on stdout, one JSON object, and nothing on stderr (without `--json`, a pass or a "no" goes
to stdout and a refusal to stderr). The envelope, `chatmcp.verify-cli/1`:

| Field | What |
|---|---|
| `format` | `chatmcp.verify-cli/1` |
| `command` | the command, `help` or `version`; `null` when the command line did not read |
| `exitCode`, `outcome` | the exit code and its name (the table above) |
| `code` | the answer code (the table below) |
| `message` | what happened, in the language of `lang` |
| `lang` | `en` or `vi` |
| `workspace` | the workspace folder, when the command got that far, else `null` |
| `data` | the command's result for exit 0 and 1 (`null` when there is none, and always `null` for exit 2, 3 and 4) |
| `detail` | the facts of a refusal (`option`, `value`, `line`, `brokenAt`, `why`, ...), or `null` |

The schemas are code: `CLI_OUTPUT_SCHEMA` and `CLI_DATA_SCHEMAS` of `DATGOLD-HUB/lib/proof/cli/schema.mjs`, written with the keywords of the
pack's own validator (`lib/proof/schema-validate.mjs`). `data` per command:

| Command | `data` |
|---|---|
| `help` | `{topic, usage}` |
| `version` | `{version}` |
| `init` | `{file, written, sha256, criteria, checks, skipped, text}` |
| `trust` | `{file, pack, sha256, trusted, approvedBy, at, checks: [{criterion, run, cwd}], manual, setup, trustCommand}`; `pack` is the pack file of `--pack`, else null |
| `snapshot` | `{taskId, baselineId, baselineSha256, createdAt, treeAlgorithm, objectFormat, tree, files, bytes, repository, patchAvailable, patchReason, acceptance: {present, sha256, trusted}, paths}` |
| `run` | `{taskId, command, shell, cwd, receipt: {seq, hash, commandSha256, argsSha256, exit, signal, timedOut, cancelled, durationMs, passed, stdout, stderr, treeBefore, treeAfter}}` |
| `show` | `{taskId, baseline, ledger, acceptance: {baseline, current}, receipts, receiptsOmitted, paths}`; with `--pack` `{pack: {file, digest}, format, verdict, truncated, out, bytes, sha256, text}`: `bytes` and `sha256` are of the report, `truncated` whether the Markdown was shortened, `text` the report (null with `--out`) |
| `pack` | `{taskId, file, packFile, digest, statement, criteria: [{id, status}], changes, receipts}`; `statement` validates against [agent-change-v0.1.schema.json](spec/agent-change-v0.1.schema.json) |
| `check` | `{file, format, digest, subjects: {before, after, diff, commit}, treeAlgorithm, objectFormat, baseCommit, agent, acceptance: {sha256, trusted, edited}, criteria: [{id, status}], receipts, ledger: {records, lastHash}, files: [{name, sha256, bytes}], tree}`; `tree` is null without `--tree`, else `{treeAlgorithm, objectFormat, tree, matches}`; `acceptance.trusted` is the maker's trust, as the pack records it |
| `reproduce` | `{pack: {file, digest}, base: {kind, value, folder, commit}, trees: {before, after, checks, checksOnPackTree}, treeAlgorithm, objectFormat, shell, setup: [{command, outcome, passed, durationMs, output}], passes, receipts: [{seq, criterion, index, command, cwd, status, reason, detail, pack, here}], notCompared: [{seq, why}], compared, reproduced, divergent, share, leftover}`; `pack` and `here` are outcomes (`exit 0`, `timed out`, `signal SIGKILL`), `share` is null when nothing was compared |
| `exec` | `{taskId, baselineId, command, commandTruncated, shell, agent: {name, version, exit, signal, timedOut, interrupted, lingering, treeLeft, durationMs, timeoutMs, stdout, stderr}, claim: {marker, reason, from, rule, pattern, line, markerTimedOut}, adapter, cost, costSource, record: {seq, hash}, checks: [{criterion, index, run, cwd, attempt, seq, exit, timedOut, passed, error}], criteria, checksModified, pack: {file, packFile, digest, receipts, changes}, statement, paths}`; `pack` and `statement` are null after a Ctrl-C |

`paths` names the files of the session: `session`, `ledger`, `baseline`, `acceptanceCopy` (and for exec `evidence`, `stdoutLog`,
`stderrLog`).

## Languages

`--lang en` (the default) or `--lang vi`. Only `message`, the help text and the human output change: the codes, the fields and the exit
code are the same in both. An unreadable `--lang` answers `bad_value` in English.

## State

The state folder is `defaultDataDirectory` of `lib/manager.mjs`: `CHATMCP_STATE_DIR` when it is set, else the Hub's per-user data folder
(`%LOCALAPPDATA%\ChatMCP\hub` on Windows, `~/Library/Application Support/ChatMCP/hub` on macOS, `$XDG_STATE_HOME/chatmcp` elsewhere).
The CLI shares it with the Hub:

| Path | What |
|---|---|
| `proof/baselines/<key>/` | the baselines ([PROOF-BASELINE.md](PROOF-BASELINE.md)) |
| `proof/<taskId>.jsonl` | the ledger of a session ([PROOF-LEDGER.md](PROOF-LEDGER.md)) |
| `proof/trusted-acceptance.json` | the trust store ([PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md)) |
| `proof/cli/<key>/session.json` | which session of the workspace is current |
| `proof/cli/<key>/<taskId>.acceptance.yml` | the raw bytes of the acceptance file at the snapshot |
| `proof/cli/<key>/<taskId>.statement.json` | the last statement `pack` built for the session |
| `proof/cli/<key>/<taskId>.pack.json` | the pack file beside it ("The pack file") |
| `proof/cli/<key>/<taskId>.exec/` | exec's evidence folder: `stdout.log` and `stderr.log`, up to 16 MiB each |
| `proof/cli/<key>/tree-state/`, `shell/` | the snapshot engine's private index and objects, ShellRunner's script files |

`<key>` is the workspace key of the baseline store (the sha256 of the workspace path). **The CLI never writes into the workspace**, but for
`init` writing `.chatmcp/acceptance.yml` and `show --pack --out` writing the report where the person says (the agent that `exec` runs writes
where it likes; that is what is being verified): snapshots, receipts and packs are all in the state folder, and the repository's `.git` is only
read (the suite compares every byte of the workspace, `.git` included, around every other command). A state folder inside the workspace,
or a workspace inside the state folder, is refused with `state_inside_workspace` (exit 4) before anything is written: the snapshot would
hold the state itself. `check` writes nothing (with `--tree`, only the snapshot's private index in `tree-state/`); `reproduce` writes
only in its temporary folder outside the state folder ("`reproduce`"), which it removes.

## No network

The CLI makes no network calls: no socket, no name lookup, no HTTP, no `fetch`. Its own files import no network module; of the modules it
loads, only `lib/runtime.mjs` does (a local port probe of the Hub that the CLI never calls). The suite runs every CLI process under a
guard that refuses and records any such use. The commands `run` runs and the agent `exec` runs are the person's own and may use the
network, as may the setup and the checks `reproduce` runs once the person trusted them; the adapters only parse the text they are given.
`reproduce --base <commit>` clones the local repository by its path (`git clone --shared`), which opens no connection.

## Answer codes

| Code | Exit | When |
|---|---|---|
| `help` | 0 | `--help`, `-h` |
| `version` | 0 | `--version` |
| `acceptance_written` | 0 | `init` wrote `.chatmcp/acceptance.yml` |
| `acceptance_printed` | 0 | `init --print` |
| `trusted` | 0 | `trust` trusted the file, or found it trusted |
| `revoked` | 0 | `trust --revoke` removed an approval |
| `already_untrusted` | 0 | `trust --revoke` found no approval |
| `snapshot_taken` | 0 | `snapshot` started a session |
| `check_passed` | 0 | `run`: the command exited 0 in time |
| `session_intact` | 0 | `show`: the ledger and the baseline verify |
| `report_printed` | 0 | `show --pack`: the pack verifies, and the report is on stdout (`data.text`) |
| `report_written` | 0 | `show --pack --out`: the pack verifies, and the report is in the file (`data.out`) |
| `pack_evidenced` | 0 | `pack`: every criterion is evidenced or owner-accepted |
| `exec_evidenced` | 0 | `exec`: the agent claimed DONE, exited 0, and every criterion is evidenced or owner-accepted |
| `pack_verified` | 0 | `check`: the pack verifies, and every criterion is evidenced or owner-accepted |
| `reproduced` | 0 | `reproduce`: every compared receipt reproduced |
| `acceptance_exists` | 1 | `init`: the file is there; nothing was written |
| `report_exists` | 1 | `show --pack --out`: something is there already; nothing was written |
| `acceptance_missing` | 1 | `trust`: no acceptance file, or not a regular file (with `--pack`: the pack has none) |
| `acceptance_invalid` | 1 | the acceptance file does not read (`detail.line`, `detail.reason`) |
| `not_trusted` | 1 | `trust`: the file is not trusted (`data.trustCommand`); `exec` and `reproduce`: nothing runs (`detail.trustCommand`; for reproduce also `detail.setup` and `detail.checks`) |
| `check_failed` | 1 | `run`: the command failed, timed out or was stopped; the receipt is recorded |
| `pack_unverified` | 1 | `pack`: a criterion is not evidenced, or there is none |
| `claim_refuted` | 1 | `exec`: the agent claimed DONE, and a criterion failed or its checks were modified |
| `claim_unverified` | 1 | `exec`: the agent claimed DONE, but not every criterion is evidenced (nothing against it) |
| `agent_blocked` | 1 | `exec`: the agent said BLOCKED (`data.claim.reason`) |
| `no_claim` | 1 | `exec`: the agent's final message ends with no marker |
| `agent_failed` | 1 | `exec`: the agent exited with a code other than 0 or was ended by a signal |
| `agent_timed_out` | 1 | `exec`: the agent ran past `--timeout` and was killed with its process tree |
| `exec_interrupted` | 1 | `exec`: Ctrl-C (SIGTERM, Ctrl-Break) while the agent or a check ran; no pack |
| `pack_not_evidenced` | 1 | `check`: the pack verifies, but a criterion is not evidenced, or there is none |
| `tree_mismatch` | 1 | `check --tree`: the pack verifies, but the workspace is not its final tree (`data.tree`) |
| `reproduce_divergent` | 1 | `reproduce`: a compared receipt is divergent (`data.receipts[].reason`) |
| `nothing_to_reproduce` | 1 | `reproduce`: no acceptance file in the pack, or no receipt of a check on its final tree; nothing ran |
| `base_mismatch` | 1 | `reproduce`: the base is not the pack's before tree; nothing ran |
| `reproduce_interrupted` | 1 | `reproduce`: Ctrl-C (SIGTERM, Ctrl-Break); the temporary folder was removed |
| `no_command` | 2 | no command |
| `unknown_command` | 2 | not `verify`, or not a command of it |
| `unknown_option` | 2 | an option the command does not take |
| `unexpected_argument` | 2 | a word the command does not take, or `--` for a command other than `run` and `exec` |
| `missing_value` | 2 | an option without its value |
| `bad_value` | 2 | a value that is not valid (`detail.expected`) |
| `repeated_option` | 2 | an option given twice |
| `missing_command_text` | 2 | `run` or `exec` without words after `--` |
| `bad_workspace` | 2 | `--workspace` is not a folder |
| `bad_cwd` | 2 | `run --cwd` is not a folder inside the workspace |
| `no_session` | 2 | `run`, `show` or `pack` before `snapshot` |
| `unsafe_argument` | 2 | `run` or `exec` with `--shell powershell`: a word PowerShell 5.1 would change |
| `bad_command` | 2 | the command text is too long for ShellRunner |
| `missing_argument` | 2 | `check` or `reproduce` without a pack file, `reproduce` without `--base`, `show` with an option of a report but without `--pack`, or with a part of a rate |
| `bad_pack` | 2 | the pack file is not a file |
| `bad_base` | 2 | `reproduce --base` is neither a folder nor a commit of the workspace's repository (`detail.why`) |
| `sha256_mismatch` | 3 | `trust --sha256`: the file has another sha256 |
| `ledger_broken` | 3 | the session's ledger does not verify (`detail.brokenAt`, `detail.reason`) |
| `session_broken` | 3 | session.json or the ledger's `task_start` is missing or is not this session's |
| `session_edited` | 3 | the session's copy of the acceptance file changed |
| `baseline_missing` | 3 | the baseline is gone (pruned or deleted) |
| `baseline_edited` | 3 | the baseline record fails its own sha256 |
| `baseline_mismatch` | 3 | the baseline record is not the one the ledger's anchor names |
| `baseline_bad_record` | 3 | the baseline record is not valid |
| `baseline_wrong_workspace` | 3 | the baseline belongs to another workspace |
| `baseline_objects_missing` | 3 | the baseline's private store lacks objects |
| `baseline_objects_mismatch` | 3 | the baseline's private store does not hold the baseline's trees |
| `baseline_objects_unreadable` | 3 | Git could not read the baseline's private store |
| `patch_does_not_reproduce` | 3 | the patch applied to the baseline tree does not give the final tree (`reproduce`: does not apply, or gives another tree than the pack's; `detail.why`) |
| `store_object_mismatch` | 3 | a blob of the baseline store does not hash to its id |
| `pack_unreadable` | 3 | the pack file is not canonical JSON of at most 256 MiB, or is a statement alone (`detail.why`) |
| `pack_invalid` | 3 | the pack, or its statement, fails its schema or the spec's rules, or its criteria are not the roll-up of the ledger it carries (`detail.part`, `detail.errors`) |
| `pack_digest_mismatch` | 3 | the statement does not have the digest the pack records |
| `pack_file_mismatch` | 3 | a file of the pack does not have its recorded size and sha256, or is not the one the statement names (`detail.file`, `detail.why`) |
| `pack_ledger_broken` | 3 | the pack's ledger does not verify, or does not hold the statement's summary and receipts (`detail.why`) |
| `state_inside_workspace` | 4 | the state folder and the workspace lie inside one another (`reproduce`: its temporary folder is inside the workspace or the base folder) |
| `acceptance_outside` | 4 | `.chatmcp/acceptance.yml` leads out of the workspace through a link |
| `not_a_repository` | 4 | `pack` or `exec` in a plain folder: no patch |
| `repository_unreadable` | 4 | `pack`: `.git` names no folder |
| `git_missing` | 4 | `pack` or `reproduce` without Git |
| `object_format_changed` | 4 | `pack`: the repository moved between SHA-1 and SHA-256 |
| `patch_too_large` | 4 | `pack`: the patch is over 128 MiB |
| `pack_too_large` | 4 | `pack` or `exec`: the pack file would be over 256 MiB; neither it nor the statement is written |
| `baseline_busy` | 4 | another baseline or diff of the workspace holds its lock |
| `workspace_too_large` | 4 | over the snapshot limits |
| `workspace_changed` | 4 | a file changed while the snapshot was taken |
| `shell_unavailable` | 4 | `run`, `exec` or `reproduce`: no such shell on this machine |
| `io_error` | 4 | the file system refused (`reproduce`: also a Git step that failed while the base was built) |
| `internal_error` | 4 | anything else (a bug: the message says what) |

## What it does not do yet

- No owner acceptance of a manual criterion (pod-34); the pack is not signed (the spec), so `check` proves a pack whole, not who made it.
- `exec`'s limits are in its own section ("What exec does not do"), `reproduce`'s in its own ("What reproduce does not do").
- The integrity level is the spec's `unconfined`: the CLI runs as the person, and anything that runs as the same user can rewrite the
  state folder. What it records is tamper-evident, it is not tamper-proof (see [PROOF-LEDGER.md](PROOF-LEDGER.md)).
- A session is per workspace folder; one session at a time is current. Old ledgers, copies and statements are not pruned.
- The npm shim `chatmcp.cmd` that `npm link` writes on Windows was not exercised: the suite runs `node bin/chatmcp.mjs`.

## Tests

`DATGOLD-HUB/tests/verify-proof-cli.mjs` spawns the real CLI as a subprocess in temporary Git repositories and plain folders, with the
state folder in a temporary folder: the package (`bin`, `files`, every module the CLI loads inside `files`), this page and its tables,
every usage error, help and `--version`, every `--json` answer against the schemas (the statement also against
`agent-change-v0.1.schema.json` and `validateStatement`), English and Vietnamese, `check` and `reproduce` without a pack (and `exec`
refusing a folder without an acceptance file), a plain folder and a repository
end to end (evidenced, stale, untrusted, checks modified, a rewritten acceptance file, no acceptance file), integrity failures (an
edited, deleted or torn ledger, an edited or re-hashed baseline, an edited session copy, a broken or swapped session), `.chatmcp` linked
out of the workspace, the state folder inside the workspace, the baseline store side directly (limits, a forged blob), the words after
`--` (typed into cmd.exe and powershell.exe on Windows, sh elsewhere), and no network use under a guard. CI runs it on windows-latest and
ubuntu-latest (Node 22 and 24) and on macos-latest (Node 24). Its mutation list is `tests/mutation/proof-cli.json` (81 mutations; the
four that changed the answer of a command still to be built went when pod-32 built the last one).

`DATGOLD-HUB/tests/verify-proof-cli-exec.mjs` is exec's suite (its name holds `proof-cli`, so the macOS job's `--filter proof-cli` runs
it too): small Node agents through the real CLI in temporary Git repositories (one that edits, one that tampers with the test, one that
claims DONE falsely, one that crashes, one that hangs and is killed with its child at `--timeout`, BLOCKED, no marker, the Claude Code
and Codex adapters on their documented output, a custom marker, `--cost-usd`, 17 MiB of output, the human output), each answer against
the schemas and each pack against the published schema; the claim window rules; the adapters on documented samples; every wrong exec
command line; the refusals before the agent runs; Ctrl-C (injected on every platform, a real SIGINT on Linux and macOS); no network.
Its mutation list is `tests/mutation/proof-cli-exec.json`.

`DATGOLD-HUB/tests/verify-proof-reproduce.mjs` is the suite of `check`, `reproduce`, `trust --pack` and the pack file (pod-32): real
sessions of the CLI in temporary Git repositories make packs, and a second state folder plays the third party who trusts nothing yet.
It covers the pack file (canonical, the statement and its digest, the three files), check (exit 0, `--tree`, a workspace that moved on,
a pack not evidenced), **every byte of a pack changed one at a time** (each refused with exit 3, in process) and a dozen changed packs
through the CLI, packs re-made with their digest recomputed (the ledger, the files and the spec's rules still refuse them; a consistent
one verifies, as an unsigned pack does), every wrong command line, `trust --pack`, reproduce refusing to run anything untrusted, from a
folder and from a commit (100%, nothing of the person written, the temporary worktree removed), a base that is not the pack's, a patch
that does not apply or gives another tree, a failing setup, a variable missing here, a flaky check seen by the second pass, a pack with
nothing to reproduce, each divergence reason in process, Ctrl-C (injected on every platform, a real SIGINT on Linux and macOS), the
cross-system fixture (`tests/fixtures/proof-reproduce/`, a pack made on Windows, checked and reproduced from a folder and from a commit
on every CI system), and no network. Its name does not hold `proof-cli`, so the macOS job runs it in a step of its own. Its mutation
list is `tests/mutation/proof-reproduce.json`.

`DATGOLD-HUB/tests/verify-proof-render.mjs` is the suite of `show --pack` and of the renderers (pod-30, [PROOF-RENDER.md](PROOF-RENDER.md),
"Tests"). Its mutation list is `tests/mutation/proof-render.json`.

A `store_object_mismatch` cannot be reached through the CLI as it is: before a pack reads a baseline blob, `diffBaseline` has already
hashed every old blob it uses again ([PROOF-BASELINE.md](PROOF-BASELINE.md)). The store side checks again in case that order changes; the
suite reaches the check directly. The `workspace_changed` of `snapshot` (the acceptance file changing during the snapshot) is a race the
suite does not provoke.
