# Proof-of-Done: the proof ledger and receipt v2 (P4 pod-16)

`DATGOLD-HUB/lib/proof/ledger.mjs` keeps, per task, an **append-only, hash-chained JSONL file** of what happened: the task's start and
end, tree snapshots, tool calls, checks (commands run as evidence), permission decisions, outbound transfers and the moments the Hub
could not be sure of something. It also builds the **check receipt** of a command run through `ShellRunner`.

**Status: a module and its API.** Nothing in the agent writes a ledger yet; the wiring into the task lifecycle is pod-17's, the receipts
that bind to a pack are pod-18's, the verify CLI is pod-24's. What changed for every task today is smaller: `run_command`,
`tasks_run`/`tasks_status`, `test_run`/`test_results` and `build_run` report the hash of the command and of its output (below). The
ledger makes no claim to users yet, so it adds nothing to [THREAT-MODEL.md](THREAT-MODEL.md) or [CLAIMS.md](CLAIMS.md).

## The file

`ledgerPath(hubDir, taskId)` is `<hubDir>/proof/<taskId>.jsonl` (the folder of [PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md)'s trust store).
A task id is 1 to 128 of `A-Z a-z 0-9 . _ -`, starting with a letter or digit, and not a Windows device name (`con`, `nul`, `com1` ...);
anything else is refused with `ledger_bad_task`.

One line per record, UTF-8, LF only:

```text
{"v":2,"seq":1,"prev":"000…000","ts":"2026-11-21T10:00:01.000Z","type":"task_start","record":{"taskId":"…"},"hash":"<64 hex>"}
```

- The **body** is `JSON.stringify({v, seq, prev, ts, type, record})`, keys in that order. The line is the body with
  `,"hash":"<sha256 of the body's UTF-8 bytes>"` put in front of its closing brace, then `\n`.
- `v` is 2 (receipt v2). `seq` counts from 1 and equals the line number. `prev` is the `hash` of the line before; the first line's is
  `GENESIS`, 64 zeros. `ts` is an ISO time in UTC with milliseconds.
- A verifier works on the **bytes** of a line, never on a re-serialisation: it strips the hash suffix, hashes what is left plus `}`, and
  compares.
- A line is at most 64 KiB (`MAX_LINE_BYTES`); a larger record is refused with `ledger_record_too_large` and nothing is written.

### Record types

`task_start`, `tree`, `call`, `check`, `permission`, `outbound`, `uncertain`, `task_end`. Any other type is refused on append
(`ledger_bad_record`) and reported as `unknown_type` by `verifyChain`: a reader that cannot interpret a record cannot vouch for it, and a
new type comes with a new `v`. A record is a JSON object (a value that is not JSON, such as a BigInt, is refused). Only `check` has a
schema of its own here (below); the fields of the seven others belong to the pods that write them (pod-17, pod-18). `uncertain` is also
written by the ledger itself, after a torn last line (below).

### Masking

Before a record is written, every string in it is masked by `maskSecrets` of `lib/permissions.mjs` (the masker of the approval card,
`tests/mutation/mask-secrets.json`) with the registered secrets the ledger was given (`secrets: () => string[]`). `scrubEnv`
(`tests/mutation/scrub.json`) is the other redactor of the project, but it removes environment variables, not text. The check receipt is
masked when it is built and again when it is appended, so a receipt built without the registered secrets still does not carry them into
the file.

## The check receipt

`checkReceipt({command, result, toolchain, treeBefore, treeAfter, secrets})` takes the result of `ShellRunner.run()` and returns exactly
these fields (the ledger refuses a `check` record with any other field, so output text cannot be stored through it):

| Field | What it is |
|---|---|
| `command` | the command, masked, at most 4,096 characters (`commandTruncated` says whether it was cut) |
| `commandSha256` | sha256 of the UTF-8 bytes of the **exact** command that ran, not of its masked form |
| `argsSha256` | sha256 of `JSON.stringify({command, cwd, shell})`, keys in that order, `cwd` as the run reports it (`.` for the root) |
| `cwd`, `shell` | where and with which shell it ran (`bash`, `sh`, `powershell`) |
| `exit`, `signal`, `timedOut`, `cancelled`, `lingering` | how it ended, as `ShellRunner` reports it |
| `stdout`, `stderr` | `{sha256, bytes, truncated, preview, previewTruncated}`, below |
| `toolchain` | `{node, python, dotnet, git}` versions, or null |
| `treeBefore`, `treeAfter` | the tree reference of a pod-15 snapshot ([PROOF-TREE.md](PROOF-TREE.md)), or null |
| `durationMs` | the run's duration |

**Output is never stored.** For each stream: `sha256` and `bytes` cover **every byte the command wrote** to it, the middle that the
capture dropped included (`BoundedCapture` hashes as the bytes arrive); `truncated` says whether the capture dropped a middle;
`preview` is the captured text, masked whole and then cut to at most **2,048 bytes** (`PREVIEW_BYTES`) on a character boundary, and
`previewTruncated` says whether it was cut. Bytes that are not UTF-8 make the preview lossy (U+FFFD), never the hash.

A tree reference keeps `status`, `treeAlgorithm`, `objectFormat`, `tree`, `rawTree`, `full`, `engineReason`, `files`, `bytes`,
`limitations`, `takenAt` and `unbounded` of the snapshot. A snapshot that threw is `{status: 'failed', engineReason: <code>}` with the
other fields null.

### The hashes the tools report

`ShellRunner.run()` reports `outputSha256: {stdout, stderr}` next to `outputBytes`. In their `structuredContent`:

- `run_command`: `commandSha256`, `outputSha256`, `outputBytes` (and the `truncated` it had);
- `tasks_run`: `commandSha256`; `tasks_status`: `commandSha256`, `outputSha256`, `outputBytes`, `truncated` (while the task runs, of
  the bytes so far);
- `test_run` and `test_results`: `commandSha256` (of the fixed command, e.g. `node --test`), `outputSha256`, `outputBytes`;
- `build_run`: `commandSha256` (e.g. `npm run build`), `outputSha256`, `outputBytes`, `truncated`.

## verifyChain

`verifyChain(bytesOrText)` reads a ledger from its first line and returns:

```js
{ ok, records, lastSeq, lastHash, brokenAt, reason, detail, verifiedBytes, torn }
```

`records`, `lastSeq`, `lastHash` and `verifiedBytes` describe the good prefix. `brokenAt` is the seq of the **first line that is not what
was written**: the line that holds a changed byte (a flip of any single byte is reported at its own line), or the line after one that was
rewritten with its own hash recomputed (`prev_mismatch`). `reason` is one of:

| reason | the line at `brokenAt` |
|---|---|
| `line_too_long` | is over 64 KiB |
| `not_utf8` | is not UTF-8 |
| `bad_envelope` | does not end with its hash, has other fields than the envelope, or a `ts` that is not an ISO time in UTC (also an empty line or a CR before the line end) |
| `hash_mismatch` | is not the text its hash was made of |
| `not_json` | is not JSON |
| `bad_version` | has another `v` |
| `seq_mismatch` | has another seq than its line number (a deleted or swapped line) |
| `prev_mismatch` | does not name the hash of the line before |
| `unknown_type` | has a record type this reader does not know |
| `bad_record` | has a record that is not an object, or a `check` record outside its schema (`detail` says what) |
| `torn_tail` | has no line end |

**A crash that tore the last line.** A line is committed only with its line end. Bytes after the last line end are reported as
`torn_tail`: `ok: false`, `brokenAt` = the seq the torn line would have had, the lines before it verified, and `torn: {bytes, sha256}` of
the torn bytes (also when they happen to hold a complete line). The next `append` drops exactly those bytes (`truncate` to
`verifiedBytes`), appends `{type: 'uncertain', record: {reason: 'torn_tail', bytes, sha256}}`, then the new record; after that the
ledger verifies again, and the loss is in it. Any other break makes the ledger refuse every append (`ledger_broken`); nothing is ever
appended to a broken ledger.

## Appends

`ProofLedger.forTask(hubDir, taskId, {secrets, now})`, then `append(type, record)` resolves with `{seq, prev, hash, ts}`. The line is
written with one append-mode write and `fsync`. Appends to one file are serialised for the whole process, across ledger objects (40
concurrent appends from two objects give seq 1 to 40 once each). The ledger keeps the size and modification time it left; when either
differs at the next append it reads and verifies the file again. `verify()` is `verifyChain` of the file as it is.

## Toolchain versions

`new ToolchainProbe({env}).versions(root)` runs `node --version`, `python --version` (`python` then `python3` on Windows, the other way
round elsewhere), `dotnet --version` and `git --version`, in parallel, with a 10-second limit each, in the workspace folder (so a
`global.json` there chooses the .NET SDK), with a scrubbed environment and `DOTNET_NOLOGO=1`. A program is taken only from an
**absolute** entry of `PATH`: a relative entry (`.` included) would let the workspace supply the program, and Windows would otherwise
look in the working folder first. A version that cannot be read is null. The answer is kept per workspace for the life of the probe
(`clear()` drops it).

## recordCheck

`recordCheck({ledger, runner, snapshotter, toolchain, command, cwd, shell, timeoutMs, maxOutputBytes, signal, secrets})` takes a snapshot
(`snapshotter.snapshot()`, the cached kind), runs the command through `runner` (a `ShellRunner`), takes a snapshot again, reads the
toolchain of the workspace, builds the receipt and appends it as one `check` line. It resolves with `{result, receipt, entry}`.

## Limits and risks

- **The chain is not a seal.** The agent runs as the same Windows user as the Hub and can rewrite the whole file, hashes included. The
  chain detects only edits that leave the later lines alone (and corruption), so the integrity level of a proof pack built on it stays
  **"unconfined"**. Lines removed from the end leave a valid, shorter ledger: only an anchor outside the file (pod-17's `task_end`, the
  pack of pod-18) can tell.
- An edit by someone else that keeps the size is noticed at the next append only through the modification time, which Windows moves in
  steps of about 15.6 ms; such an edit can then be appended after, and `verifyChain` still reports it.
- Another **process** that appends to the same file is not coordinated with (the Hub holds a lock on its data folder); a write of the
  other process could be taken for a torn line.
- A command hash of a command that holds a weak secret (a short password) can be found by guessing; a strong token cannot.
- A secret that the capture's dropped middle cut in two can leave a piece in the preview that no rule recognises (the model saw the same
  text).
- PowerShell output is hashed as the bytes the process wrote (CLIXML when PowerShell serialised its streams), while the text is decoded.
  After a lingering exit the streams are cut after 1.5 s; bytes after that are neither captured nor hashed.

## Decisions

- No agent wiring: the plan gives it to pod-17; this pod's narrow option is the module, the hashes in the tool results and
  `recordCheck` for pod-17 to call.
- `build_run` lives in `lib/workflow-extensions.mjs`, so that file got the three fields too.
- A torn tail is repaired by the next append rather than refused: the dropped bytes were never a committed record, and the `uncertain`
  record keeps their size and hash.

## Tests

`tests/verify-proof-ledger.mjs` (15 checks): real commands through `ShellRunner` (text, empty, binary and not UTF-8, 50,000 bytes over a
1,000-byte capture, multibyte, a timeout) and the four tools; the receipt and its schema; secrets in the command line and the output;
every-byte flips; rewritten, deleted, swapped, unknown-type and malformed lines; the torn tail and its repair; concurrent appends;
refusals; the toolchain probe with a fake `PATH` and on the real machine; `recordCheck` with the pod-15 engine on a real repository.
Mutation list: `tests/mutation/proof-ledger.json`.
