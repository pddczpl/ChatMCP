# Proof-of-Done: the `chatmcp verify` command line (P4 pod-24, P5 pod-26)

`chatmcp verify` is the command line of Proof-of-Done: it takes a baseline of a workspace, records check receipts in a proof ledger, and
builds the proof pack of the change (an in-toto statement, [spec/agent-change-v0.1.md](spec/agent-change-v0.1.md)). It is the first
place a person can run the P4 modules without the Hub: every command wires a module that already does the work.

| Command | Module it wires |
|---|---|
| `init` | `proposeAcceptance` of [PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md) (pod-20) |
| `trust` | the trust store of [PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md) (pod-20) |
| `snapshot` | `snapshotBaseline` of [PROOF-BASELINE.md](PROOF-BASELINE.md) (pod-25) and the ledger of [PROOF-LEDGER.md](PROOF-LEDGER.md) (pod-16) |
| `run` | `recordCheck` of the ledger (pod-16) with the Hub's `ShellRunner` and the tree snapshots of [PROOF-TREE.md](PROOF-TREE.md) (pod-15) |
| `exec` | the exec wrapper for any external agent (pod-26): `snapshot`, the agent, the marker reader of `lib/proof/marker.mjs` and the output adapters, `recordCheck` for each trusted check, `pack` |
| `check` | not built yet: plan task pod-32, verifying and reproducing a pack |
| `show` | `loadBaseline` (pod-25) and `verifyChain` (pod-16) |
| `pack` | `diffBaseline` (pod-25), `detectCheckChanges` of [PROOF-TAMPER.md](PROOF-TAMPER.md) (pod-22) and `buildAgentChangeStatement` of the spec (pod-29) |

**Status: a command line of its own.** The grammar, the exit codes, the JSON answers and both languages are fixed here; `check` answers
`not_built`. Nothing in the agent or the app calls the CLI. The name keeps the old spelling, like `.chatmcp/` ([NAMING.md](NAMING.md)):
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

## Grammar

```text
chatmcp verify <command> [options] [-- <words of the command>]
chatmcp verify --help        chatmcp verify <command> --help        chatmcp --version
```

- The first word is `verify`, the second the command. `chatmcp init` is `unknown_command`.
- Options can stand anywhere before `--`, before `verify` too: `--name value` or `--name=value`. A value that starts with `--` must be
  written `--name=value`. An option given twice is `repeated_option`; a flag given a value (`--json=1`) is `bad_value`.
- Options of every command: `--json` (one JSON answer on stdout), `--lang en|vi` (the language of the messages, English by default),
  `--workspace <folder>` (the workspace; the current folder by default; it is used as given, the CLI does not look for a repository root
  above it), `--help` / `-h`.
- `--` ends the options. `run` and `exec` take words after it (the command to run, the agent's command); `check` takes anything (its
  grammar is not fixed yet).

## Exit codes

| Exit | Outcome | Meaning |
|---|---|---|
| 0 | `pass` | the command did what was asked, and what it checked holds |
| 1 | `unverified` | not verified, or not done: a check that failed, a criterion without evidence, a file that is not trusted, `init` finding a file there |
| 2 | `usage` | the command line is wrong, or the commands came in the wrong order (`run` before `snapshot`) |
| 3 | `integrity` | recorded evidence does not verify (the ledger, the baseline, the session's copy of the acceptance file, the baseline store), or bytes are not the ones named |
| 4 | `environment` | this machine, this folder or this version of the CLI cannot do it: no Git repository for a pack (or for exec), no shell, the state folder inside the workspace, a command not built yet |

Every answer has one code, and a code always has the same exit code (the table at the end).

## The commands

### `init`

`chatmcp verify init [--print]` builds a proposed `.chatmcp/acceptance.yml` from what the project's own files name (`package.json`
scripts, TypeScript, Playwright, pytest, `dotnet test`, Cargo, Go, make; one manual criterion when nothing is found) and writes it. It runs
nothing. It never overwrites: when the file is there, in any form, the answer is `acceptance_exists` (exit 1) and nothing changes.
`--print` writes nothing and prints the file itself (without `--json`, stdout is exactly the file, ready to redirect). A `.chatmcp` that
leads out of the workspace through a link is `acceptance_outside` (exit 4). This is **the only place the CLI writes into a workspace**.

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
`acceptance_missing` (exit 1). The approval is recorded as made by `chatmcp verify trust`: no user name is written.

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

Not built yet: plan task pod-32 (verifying a pack and reproducing its checks). `chatmcp verify check ...` answers `not_built` (exit 4,
`detail.plannedIn` `pod-32`) whatever follows it, and does nothing.

### `show`

`chatmcp verify show` reads the current session and checks it: the ledger (`verifyChain`), its `task_start`, the session's copy of the
acceptance file against the sha256 the ledger holds, and the baseline against the anchor (`loadBaseline`). `session_intact` (exit 0)
lists the baseline, the ledger, the last 50 receipts, and whether the acceptance file of the baseline and the one on disk now are trusted.
It writes nothing and takes no snapshot.

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
`data.statement` with `--json`. `pack_evidenced` (exit 0) when there is at least one criterion and every one is `evidenced` or
`owner_accepted`; `pack_unverified` (exit 1) otherwise: stale evidence, an untrusted file, changed checks, a failed check, a manual
criterion (owner acceptances come with the Proof tab, pod-34; the CLI passes none). A plain folder has no patch, so its pack is
`not_a_repository` (exit 4); the other reasons a patch cannot be made are in the table below.

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
| `detail` | the facts of a refusal (`option`, `value`, `line`, `brokenAt`, `plannedIn`, ...), or `null` |

The schemas are code: `CLI_OUTPUT_SCHEMA` and `CLI_DATA_SCHEMAS` of `DATGOLD-HUB/lib/proof/cli/schema.mjs`, written with the keywords of the
pack's own validator (`lib/proof/schema-validate.mjs`). `data` per command:

| Command | `data` |
|---|---|
| `help` | `{topic, usage}` |
| `version` | `{version}` |
| `init` | `{file, written, sha256, criteria, checks, skipped, text}` |
| `trust` | `{file, sha256, trusted, approvedBy, at, checks: [{criterion, run, cwd}], manual, trustCommand}` |
| `snapshot` | `{taskId, baselineId, baselineSha256, createdAt, treeAlgorithm, objectFormat, tree, files, bytes, repository, patchAvailable, patchReason, acceptance: {present, sha256, trusted}, paths}` |
| `run` | `{taskId, command, shell, cwd, receipt: {seq, hash, commandSha256, argsSha256, exit, signal, timedOut, cancelled, durationMs, passed, stdout, stderr, treeBefore, treeAfter}}` |
| `show` | `{taskId, baseline, ledger, acceptance: {baseline, current}, receipts, receiptsOmitted, paths}` |
| `pack` | `{taskId, file, digest, statement, criteria: [{id, status}], changes, receipts}`; `statement` validates against [agent-change-v0.1.schema.json](spec/agent-change-v0.1.schema.json) |
| `exec` | `{taskId, baselineId, command, commandTruncated, shell, agent: {name, version, exit, signal, timedOut, interrupted, lingering, treeLeft, durationMs, timeoutMs, stdout, stderr}, claim: {marker, reason, from, rule, pattern, line, markerTimedOut}, adapter, cost, costSource, record: {seq, hash}, checks: [{criterion, index, run, cwd, attempt, seq, exit, timedOut, passed, error}], criteria, checksModified, pack: {file, digest, receipts, changes}, statement, paths}`; `pack` and `statement` are null after a Ctrl-C |

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
| `proof/cli/<key>/<taskId>.exec/` | exec's evidence folder: `stdout.log` and `stderr.log`, up to 16 MiB each |
| `proof/cli/<key>/tree-state/`, `shell/` | the snapshot engine's private index and objects, ShellRunner's script files |

`<key>` is the workspace key of the baseline store (the sha256 of the workspace path). **The CLI never writes into the workspace**, but for
`init` writing `.chatmcp/acceptance.yml` (the agent that `exec` runs writes where it likes; that is what is being verified): snapshots, receipts and packs are all in the state folder, and the repository's `.git` is only
read (the suite compares every byte of the workspace, `.git` included, around every other command). A state folder inside the workspace,
or a workspace inside the state folder, is refused with `state_inside_workspace` (exit 4) before anything is written: the snapshot would
hold the state itself.

## No network

The CLI makes no network calls: no socket, no name lookup, no HTTP, no `fetch`. Its own files import no network module; of the modules it
loads, only `lib/runtime.mjs` does (a local port probe of the Hub that the CLI never calls). The suite runs every CLI process under a
guard that refuses and records any such use. The commands `run` runs and the agent `exec` runs are the person's own and may use the
network; the adapters only parse the text they are given.

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
| `pack_evidenced` | 0 | `pack`: every criterion is evidenced or owner-accepted |
| `exec_evidenced` | 0 | `exec`: the agent claimed DONE, exited 0, and every criterion is evidenced or owner-accepted |
| `acceptance_exists` | 1 | `init`: the file is there; nothing was written |
| `acceptance_missing` | 1 | `trust`: no acceptance file, or not a regular file |
| `acceptance_invalid` | 1 | the acceptance file does not read (`detail.line`, `detail.reason`) |
| `not_trusted` | 1 | `trust`: the file is not trusted (`data.trustCommand`) |
| `check_failed` | 1 | `run`: the command failed, timed out or was stopped; the receipt is recorded |
| `pack_unverified` | 1 | `pack`: a criterion is not evidenced, or there is none |
| `claim_refuted` | 1 | `exec`: the agent claimed DONE, and a criterion failed or its checks were modified |
| `claim_unverified` | 1 | `exec`: the agent claimed DONE, but not every criterion is evidenced (nothing against it) |
| `agent_blocked` | 1 | `exec`: the agent said BLOCKED (`data.claim.reason`) |
| `no_claim` | 1 | `exec`: the agent's final message ends with no marker |
| `agent_failed` | 1 | `exec`: the agent exited with a code other than 0 or was ended by a signal |
| `agent_timed_out` | 1 | `exec`: the agent ran past `--timeout` and was killed with its process tree |
| `exec_interrupted` | 1 | `exec`: Ctrl-C (SIGTERM, Ctrl-Break) while the agent or a check ran; no pack |
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
| `patch_does_not_reproduce` | 3 | the patch applied to the baseline tree does not give the final tree |
| `store_object_mismatch` | 3 | a blob of the baseline store does not hash to its id |
| `not_built` | 4 | `check` (pod-32) |
| `state_inside_workspace` | 4 | the state folder and the workspace lie inside one another |
| `acceptance_outside` | 4 | `.chatmcp/acceptance.yml` leads out of the workspace through a link |
| `not_a_repository` | 4 | `pack` or `exec` in a plain folder: no patch |
| `repository_unreadable` | 4 | `pack`: `.git` names no folder |
| `git_missing` | 4 | `pack` without Git |
| `object_format_changed` | 4 | `pack`: the repository moved between SHA-1 and SHA-256 |
| `patch_too_large` | 4 | `pack`: the patch is over 128 MiB |
| `baseline_busy` | 4 | another baseline or diff of the workspace holds its lock |
| `workspace_too_large` | 4 | over the snapshot limits |
| `workspace_changed` | 4 | a file changed while the snapshot was taken |
| `shell_unavailable` | 4 | `run` or `exec`: no such shell on this machine |
| `io_error` | 4 | the file system refused |
| `internal_error` | 4 | anything else (a bug: the message says what) |

## What it does not do yet

- `check` (pod-32), as above; no owner acceptance of a manual criterion (pod-34); the pack is not signed (the spec).
- `exec`'s limits are in its own section ("What exec does not do").
- The integrity level is the spec's `unconfined`: the CLI runs as the person, and anything that runs as the same user can rewrite the
  state folder. What it records is tamper-evident, it is not tamper-proof (see [PROOF-LEDGER.md](PROOF-LEDGER.md)).
- A session is per workspace folder; one session at a time is current. Old ledgers, copies and statements are not pruned.
- The npm shim `chatmcp.cmd` that `npm link` writes on Windows was not exercised: the suite runs `node bin/chatmcp.mjs`.

## Tests

`DATGOLD-HUB/tests/verify-proof-cli.mjs` spawns the real CLI as a subprocess in temporary Git repositories and plain folders, with the
state folder in a temporary folder: the package (`bin`, `files`, every module the CLI loads inside `files`), this page and its tables,
every usage error, help and `--version`, every `--json` answer against the schemas (the statement also against
`agent-change-v0.1.schema.json` and `validateStatement`), English and Vietnamese, `check` (and `exec` refusing a folder without an
acceptance file), a plain folder and a repository
end to end (evidenced, stale, untrusted, checks modified, a rewritten acceptance file, no acceptance file), integrity failures (an
edited, deleted or torn ledger, an edited or re-hashed baseline, an edited session copy, a broken or swapped session), `.chatmcp` linked
out of the workspace, the state folder inside the workspace, the baseline store side directly (limits, a forged blob), the words after
`--` (typed into cmd.exe and powershell.exe on Windows, sh elsewhere), and no network use under a guard. CI runs it on windows-latest and
ubuntu-latest (Node 22 and 24) and on macos-latest (Node 24). Its mutation list is `tests/mutation/proof-cli.json` (85 mutations).

`DATGOLD-HUB/tests/verify-proof-cli-exec.mjs` is exec's suite (its name holds `proof-cli`, so the macOS job's `--filter proof-cli` runs
it too): small Node agents through the real CLI in temporary Git repositories (one that edits, one that tampers with the test, one that
claims DONE falsely, one that crashes, one that hangs and is killed with its child at `--timeout`, BLOCKED, no marker, the Claude Code
and Codex adapters on their documented output, a custom marker, `--cost-usd`, 17 MiB of output, the human output), each answer against
the schemas and each pack against the published schema; the claim window rules; the adapters on documented samples; every wrong exec
command line; the refusals before the agent runs; Ctrl-C (injected on every platform, a real SIGINT on Linux and macOS); no network.
Its mutation list is `tests/mutation/proof-cli-exec.json`.

A `store_object_mismatch` cannot be reached through the CLI as it is: before a pack reads a baseline blob, `diffBaseline` has already
hashed every old blob it uses again ([PROOF-BASELINE.md](PROOF-BASELINE.md)). The store side checks again in case that order changes; the
suite reaches the check directly. The `workspace_changed` of `snapshot` (the acceptance file changing during the snapshot) is a race the
suite does not provoke.
