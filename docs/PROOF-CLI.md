# Proof-of-Done: the `chatmcp verify` command line (P4 pod-24)

`chatmcp verify` is the command line of Proof-of-Done: it takes a baseline of a workspace, records check receipts in a proof ledger, and
builds the proof pack of the change (an in-toto statement, [spec/agent-change-v0.1.md](spec/agent-change-v0.1.md)). It is the first
place a person can run the P4 modules without the Hub: every command wires a module that already does the work.

| Command | Module it wires |
|---|---|
| `init` | `proposeAcceptance` of [PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md) (pod-20) |
| `trust` | the trust store of [PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md) (pod-20) |
| `snapshot` | `snapshotBaseline` of [PROOF-BASELINE.md](PROOF-BASELINE.md) (pod-25) and the ledger of [PROOF-LEDGER.md](PROOF-LEDGER.md) (pod-16) |
| `run` | `recordCheck` of the ledger (pod-16) with the Hub's `ShellRunner` and the tree snapshots of [PROOF-TREE.md](PROOF-TREE.md) (pod-15) |
| `exec` | not built yet: plan task pod-26, the exec wrapper for any external agent |
| `check` | not built yet: plan task pod-32, verifying and reproducing a pack |
| `show` | `loadBaseline` (pod-25) and `verifyChain` (pod-16) |
| `pack` | `diffBaseline` (pod-25), `detectCheckChanges` of [PROOF-TAMPER.md](PROOF-TAMPER.md) (pod-22) and `buildAgentChangeStatement` of the spec (pod-29) |

**Status: a skeleton.** The grammar, the exit codes, the JSON answers and both languages are fixed here; `exec` and `check` answer
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
- `--` ends the options. Only `run` takes words after it; `exec` and `check` take anything (their grammar is not fixed yet).

## Exit codes

| Exit | Outcome | Meaning |
|---|---|---|
| 0 | `pass` | the command did what was asked, and what it checked holds |
| 1 | `unverified` | not verified, or not done: a check that failed, a criterion without evidence, a file that is not trusted, `init` finding a file there |
| 2 | `usage` | the command line is wrong, or the commands came in the wrong order (`run` before `snapshot`) |
| 3 | `integrity` | recorded evidence does not verify (the ledger, the baseline, the session's copy of the acceptance file, the baseline store), or bytes are not the ones named |
| 4 | `environment` | this machine, this folder or this version of the CLI cannot do it: no Git repository for a pack, no shell, the state folder inside the workspace, a command not built yet |

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

Not built yet: plan task pod-26 (the exec wrapper for any external agent: snapshot, run the agent, pack). `chatmcp verify exec ...`
answers `not_built` (exit 4, `detail.plannedIn` `pod-26`) whatever follows it, and does nothing: no file is read or written.

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

`paths` names the files of the session: `session`, `ledger`, `baseline`, `acceptanceCopy`.

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
| `proof/cli/<key>/tree-state/`, `shell/` | the snapshot engine's private index and objects, ShellRunner's script files |

`<key>` is the workspace key of the baseline store (the sha256 of the workspace path). **The CLI never writes into the workspace**, but for
`init` writing `.chatmcp/acceptance.yml`: snapshots, receipts and packs are all in the state folder, and the repository's `.git` is only
read (the suite compares every byte of the workspace, `.git` included, around every other command). A state folder inside the workspace,
or a workspace inside the state folder, is refused with `state_inside_workspace` (exit 4) before anything is written: the snapshot would
hold the state itself.

## No network

The CLI makes no network calls: no socket, no name lookup, no HTTP, no `fetch`. Its own files import no network module; of the modules it
loads, only `lib/runtime.mjs` does (a local port probe of the Hub that the CLI never calls). The suite runs every CLI process under a
guard that refuses and records any such use. The commands `run` runs are the person's own and may use the network.

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
| `acceptance_exists` | 1 | `init`: the file is there; nothing was written |
| `acceptance_missing` | 1 | `trust`: no acceptance file, or not a regular file |
| `acceptance_invalid` | 1 | the acceptance file does not read (`detail.line`, `detail.reason`) |
| `not_trusted` | 1 | `trust`: the file is not trusted (`data.trustCommand`) |
| `check_failed` | 1 | `run`: the command failed, timed out or was stopped; the receipt is recorded |
| `pack_unverified` | 1 | `pack`: a criterion is not evidenced, or there is none |
| `no_command` | 2 | no command |
| `unknown_command` | 2 | not `verify`, or not a command of it |
| `unknown_option` | 2 | an option the command does not take |
| `unexpected_argument` | 2 | a word the command does not take, or `--` for a command other than `run` |
| `missing_value` | 2 | an option without its value |
| `bad_value` | 2 | a value that is not valid (`detail.expected`) |
| `repeated_option` | 2 | an option given twice |
| `missing_command_text` | 2 | `run` without words after `--` |
| `bad_workspace` | 2 | `--workspace` is not a folder |
| `bad_cwd` | 2 | `run --cwd` is not a folder inside the workspace |
| `no_session` | 2 | `run`, `show` or `pack` before `snapshot` |
| `unsafe_argument` | 2 | `run --shell powershell`: a word PowerShell 5.1 would change |
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
| `not_built` | 4 | `exec` (pod-26) and `check` (pod-32) |
| `state_inside_workspace` | 4 | the state folder and the workspace lie inside one another |
| `acceptance_outside` | 4 | `.chatmcp/acceptance.yml` leads out of the workspace through a link |
| `not_a_repository` | 4 | `pack` of a plain folder: no patch |
| `repository_unreadable` | 4 | `pack`: `.git` names no folder |
| `git_missing` | 4 | `pack` without Git |
| `object_format_changed` | 4 | `pack`: the repository moved between SHA-1 and SHA-256 |
| `patch_too_large` | 4 | `pack`: the patch is over 128 MiB |
| `baseline_busy` | 4 | another baseline or diff of the workspace holds its lock |
| `workspace_too_large` | 4 | over the snapshot limits |
| `workspace_changed` | 4 | a file changed while the snapshot was taken |
| `shell_unavailable` | 4 | `run`: no such shell on this machine |
| `io_error` | 4 | the file system refused |
| `internal_error` | 4 | anything else (a bug: the message says what) |

## What it does not do yet

- `exec` (pod-26) and `check` (pod-32), as above; no owner acceptance of a manual criterion (pod-34); the pack is not signed (the spec).
- The integrity level is the spec's `unconfined`: the CLI runs as the person, and anything that runs as the same user can rewrite the
  state folder. What it records is tamper-evident, it is not tamper-proof (see [PROOF-LEDGER.md](PROOF-LEDGER.md)).
- A session is per workspace folder; one session at a time is current. Old ledgers, copies and statements are not pruned.
- The npm shim `chatmcp.cmd` that `npm link` writes on Windows was not exercised: the suite runs `node bin/chatmcp.mjs`.

## Tests

`DATGOLD-HUB/tests/verify-proof-cli.mjs` spawns the real CLI as a subprocess in temporary Git repositories and plain folders, with the
state folder in a temporary folder: the package (`bin`, `files`, every module the CLI loads inside `files`), this page and its tables,
every usage error, help and `--version`, every `--json` answer against the schemas (the statement also against
`agent-change-v0.1.schema.json` and `validateStatement`), English and Vietnamese, `exec` and `check`, a plain folder and a repository
end to end (evidenced, stale, untrusted, checks modified), integrity failures, the state folder inside the workspace, the words after
`--` (typed into cmd.exe and powershell.exe on Windows, sh elsewhere), and no network use under a guard. Its mutation list is
`tests/mutation/proof-cli.json`.
