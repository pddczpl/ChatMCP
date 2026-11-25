# Proof-of-Done: proof packs in the Hub and their API (P5 pod-33)

At the end of a run that the done-gate judged ([PROOF-GATE.md](PROOF-GATE.md)) the Hub builds the **proof pack** of the conversation
([PROOF-CLI.md](PROOF-CLI.md), "The pack file"; the statement in it: [spec/agent-change-v0.1.md](spec/agent-change-v0.1.md)), keeps the latest one
per task under its own data folder and answers it over HTTP. The owner can trust an acceptance file over HTTP too. The page that uses all of
it, the Proof tab, is pod-34 and is not built: **nothing in the app shows any of this yet.**

| File (`DATGOLD-HUB/`) | What |
|---|---|
| `lib/proof/pack-build.mjs` | `buildPackBytes()`: the one builder, for `chatmcp verify pack`, `exec` and the Hub |
| `lib/proof/hub-pack.mjs` | `HubPacks` (when, the reasons, the build behind a run), `PackStore` (the files), what a task says of its pack |
| `lib/proof/http-api.mjs` | `ProofHttpApi`: the routes |
| `lib/proof/accept-receipt.mjs` | the ledger behind an owner's acceptance of an objective |

`AgentRunner` (`lib/agent.mjs`) calls `HubPacks` at the end of a run; `DoneGate.packInputs()` (`lib/proof/gate.mjs`) says what the run was held to.

## When a run leaves a pack

When it ended with a final answer, the gate judged that answer (`passed`, `failed`, `unproven` or `stale`) and the conversation has a baseline.
Today that means: the project has a `.chatmcp/acceptance.yml` with at least one check, and its owner trusts it. **Without an acceptance file there
is no pack in this version.** A failed gate leaves a pack too: it says `failed`.

Anything else leaves none, never a part of one, and the task says why, with one reason of this closed list (`PACK_REASONS`):

| Reason | Meaning |
|---|---|
| `run_in_progress` | a run of the task goes on |
| `run_not_completed` | the run failed, was stopped or reached a limit: there was no final answer |
| `unsupported` | a runner without the parts a pack needs (not the local backend) |
| `subagent` | an agent another agent started: it is not gated |
| `no_acceptance` | no `.chatmcp/acceptance.yml` |
| `acceptance_untrusted`, `acceptance_invalid`, `acceptance_lost` | the file is not trusted; does not read; its bytes of the start are gone |
| `no_checks` | it has only manual criteria, so no baseline is taken |
| `readonly`, `plan_mode`, `sandbox_only`, `no_shell` | the gate ran nothing |
| `proof_unavailable`, `state_inside_workspace` | the proof service records nothing here; the Hub's data folder is in the workspace |
| `gate_error` | the gate could not begin |
| `no_baseline` | the baseline failed or took too long |
| `baseline_unreadable`, `baseline_busy` | it is gone or edited; its lock was held too long |
| `not_a_repository`, `repository_unreadable`, `git_missing` | a plain folder (or one Git cannot be used on): the baseline has no old bytes, so there is no patch |
| `old_bytes_unreadable`, `object_format_changed` | the baseline's private store is damaged; the repository changed its hash |
| `final_tree_unknown` | the final tree could not be taken |
| `final_tree_changed` | the workspace was not the tree the run ended on any more when the pack was built |
| `ledger_broken` | the task's ledger is missing or does not verify |
| `patch_too_large`, `pack_too_large` | over 32 MiB of patch, over 64 MiB of pack (the format allows 128 and 256: use `chatmcp verify pack`) |
| `pack_not_verified` | the check of `chatmcp verify check` refuses what was built (below), so it is not written |
| `write_failed`, `build_failed` | it could not be written; anything else (the code is in the Hub's log) |
| `timeout`, `superseded`, `hub_stopped`, `task_deleted` | the build was given up: 120 s, a run that needs the folder or a later run of the task, the Hub stops, the task is deleted |
| `interrupted` | the Hub died while the run went on or the pack was built |
| `building`, `pack_missing`, `not_recorded`, `companion` | only in the route's answer: it is being built; the file is gone; a task of an older Hub; a task of the ChatGPT Web Companion |

## What is in it

The pack is the one `chatmcp verify pack` would make of the same ledger, baseline and workspace, with these inputs:

- **Trees.** Before: the conversation's baseline. After: the workspace, snapshotted again by the builder, and it must be the tree
  `ProofService.end()` recorded for this run (same algorithm, object format and id), else `final_tree_changed`. The report on the changes to the
  checks is made **before** that snapshot, so a file that changes between the end of the run and the pack shows in it.
- **Acceptance file.** The bytes the run was held to (docs of the gate, "What a task is held to"). Whether the workspace's differs is
  `acceptance.edited`; other line ends (`core.autocrlf`) are no edit, as for the gate.
- **Changes to the checks.** The gate's own report, with what the conversation remembers of changes before a baseline that was taken again: what was
  modified stays modified, what is unknown stays unknown. A pack never says `evidenced` where the gate would not.
- **Ledger.** The whole ledger of the task up to the `task_end` of this run, read while the task still holds the workspace.
- **Agent, model, cost.** `DatGold` and the Hub's version; the provider, model and profile revision of the last run; the cost of the task's own model
  calls when all of it is priced at the owner's rates (a price from the model catalog is an estimate, so it is `unknown`), `complete` only when every
  call was priced and no other agent was started. A pack that does not cover the whole task has no cost.
- **Secrets.** The builder gets the Hub's registered secrets and masks them in every text of the statement.

`coverage` says whether the baseline is the tree the task's first run started on (`task`) or a later one (`baseline`: the file was trusted later, or
the baseline was removed and taken again). A pack covers the **conversation** since its baseline, not the last run alone.

**The Hub checks what it writes.** `readPackFile`, the function behind `chatmcp verify check`, reads the bytes before they are written. One case it
refuses: a registered secret that is part of a check's folder name, because the masked folder cannot be compared with the ledger.

## It does not slow or fail a run

- The run ends, its ledger is closed, its workspace is released; then the pack is built in the background. While the task still holds the workspace
  only the ledger and the acceptance file are read. Errors are a reason, a log line and one `proof_pack` event (`pack`: `ready` or `none`, `reason`,
  `run`, `verdict`); the task's status and answer are never touched.
- A build takes at most 120 s. A stop of the Hub, a delete and a later run of the task give it up at once and do not wait for it.
- Building a pack holds the lock of the workspace's baselines. A run that needs to take a baseline waits at most 5 s for it, then the build is given
  up (`superseded`) (`giveWay`).
- Building and checking a pack are plain JavaScript on the Hub's one thread. Measured here (Node 24, Windows): a ledger of 10,000 receipts (22 MiB, a
  pack of 31 MiB) about 0.3 s to build and 0.6 s to check; 300 receipts 35 ms and 40 ms. The Hub answers nothing else during one of these halves.

## Where it is kept

`<data folder>/proof/packs/<task id>/<first 16 hex digits of the digest>.pack.json`, written to a temporary file and renamed, mode 0600 in a 0700 folder,
never in the workspace. Second chats use the same folder (found through the owner's trust list they are handed), so their paths are short and the
route finds them. **Only the latest pack of a task is kept.** A later run that ends without a pack keeps the earlier one, which is then `earlier`.
Deleting the task removes the folder. Scratch files are in `packs/scratch/` and removed at the end (or after 24 h when a Hub died).

Git on Windows refuses paths that are too long: building a pack failed with a Hub data folder over about 109 characters (the gate's part of it over
120; the baseline itself goes a little further). The reason is then `build_failed`.

The pack file holds the patch, the ledger and the acceptance file **as they are**: only the statement is masked. It is not served over HTTP.

## What a task says: `proof`

`GET /api/tasks/:id` (and every public task) has

```json
{"status": "ready", "reason": null, "run": 2, "at": "2026-11-25T08:00:00.000Z", "digest": "<sha256 of the statement>", "verdict": "evidenced",
 "counts": {"evidenced": 1, "owner_accepted": 0, "unverified": 0, "failed": 0, "stale": 0, "checks_modified": 0},
 "checksModified": false, "coverage": "task", "earlier": null}
```

`status` is `ready`, `building` or `none`; `run` counts the runs of the conversation from 1; `verdict` is one of
[PROOF-RENDER.md](PROOF-RENDER.md) ("The verdict"); `checksModified` is `null` when it is not known. Without a pack of the last run everything from
`digest` to `coverage` is null, and `earlier` is `{run, at, digest, verdict}` of the stored pack of an earlier run, if there is one. A list entry
(`/api/state`) has `{status, reason, run, verdict}`. A task of an older Hub, a task that has not run and a task of the Companion have `null`. What a task
file says is checked when it is loaded; an edited summary is no summary.

## `GET /api/tasks/:id/proof`

Behind the bearer, the Host and the Origin check like every route ([HUB-AUTH.md](HUB-AUTH.md)). Query:

| Key | Values | Default |
|---|---|---|
| `format` | `json`, `md`, `html` | `json` |
| `lang` | `vi`, `en` (the report's language) | `vi` |
| `from`, `limit` | a page of the receipts, json only: the index of the first (a whole number, at most nine digits) and how many (1 to 200) | 0 and 50 |
| `run` | the run whose pack is asked for (the last one, or the `earlier` one) | the last |

Any other key, a key given twice, another value: **400** `bad_query` (with `key`). An unknown task: **404** `task_not_found`. No pack: **404** `no_pack`
with `reason`, `run` and `earlierRun`. An earlier run's pack is never answered as the last one's.

**The stored file is checked whole on every request** (`readPackFile`), its digest must be the one the task names and its ledger must start this task.
Otherwise: **409** `pack_not_verified` with `problem`, in every format, and nothing of the file is shown. (The statement of the last pack that was checked
is kept for 60 s for its next pages, by the sha256 of the file's bytes: an edited file is checked again.)

**json**: `{format: "chatmcp.hub-proof/1", taskId, run, at, digest, proof, statement, receipts, files, masked}`.

- `statement` is the in-toto statement **without** `predicate.receipts`; `receipts` is `{total, omitted, from, limit, next, items}` (`next`: the next `from`, or null;
  `omitted`: receipts the pack itself leaves out). With all pages put back as `predicate.receipts` it is the statement `digest` is taken of.
- `files` is the name, size and sha256 of the pack's files, not their bytes.
- `masked` is true when a registered secret was taken out of a text of the answer (one the builder did not know): the texts then differ from the pack's,
  so the digest cannot be computed from this answer.

**md** and **html** are the reports of [PROOF-RENDER.md](PROOF-RENDER.md), with `packChecked` (the file was checked just now) and the registered secrets out of every
text they take from the pack. Both are downloads (`Content-Disposition: attachment`), `nosniff`, `no-store`, `no-referrer`, with
`Content-Security-Policy: sandbox; <the page's own policy>` and `Cross-Origin-Resource-Policy: same-origin`: a text of a pack is data of an agent's, served from
the Hub's own origin.

## The acceptance file: `GET /api/proof/acceptance`

The file of the **open project** as it is on disk now; it takes no query. `{format: "chatmcp.hub-acceptance/1", file, state, sha256, bytes, trusted, approvedBy, at, criteria,
protected, setup, problem, masked}`. `state`: `present`, `missing` (none, or not a regular file), `outside` (the path leads out of the workspace), `too_large`
(over 64 KiB), `invalid` (`problem` has the line and the reason). A criterion is `{id, text, checks: [{run, cwd, timeout, expectExit, repeat}], manual}`. The sha256 is
of the exact bytes. A registered secret in a text is masked and `masked` says so.

## Trusting it: `POST /api/proof/trust-acceptance`, `POST /api/proof/revoke-acceptance`

The body is `{"sha256": "<64 lower-case hex digits>"}` and nothing else (**400** `bad_request`): never a path, never "latest". **The Hub reads the file again**; what was shown
is trusted, or nothing:

| Answer | When |
|---|---|
| 200 `{trusted, sha256, approvedBy, at}` | the file's bytes have this sha256 now and it reads |
| 404 `acceptance_missing` | no file |
| 409 `acceptance_changed` (`expected`, `actual`) | other bytes, line ends included |
| 409 `workspace_missing` | no project is open |
| 422 `acceptance_invalid` (`line`, `reason`), `acceptance_outside` | it does not read, or is over its limit; it leads out of the workspace |

Revoking needs no file: 200 `{revoked, sha256, trusted: false}`. It is the one trust list of the Hub, which `chatmcp verify trust` writes too. Trusting again renews
the time (the done-gate's rule of adopting a newer version). Both are the owner's acts: behind the bearer, Origin, the page's marker and the CSRF
token. No tool of the model, no MCP client, not the ACP agent (both routes are in its `FORBIDDEN_ROUTES`) and not the Companion reaches them; a
program that runs as the same user and reads the session file can, as it can write the list itself ([THREAT-MODEL.md](THREAT-MODEL.md), H10).

## Accepting an objective: `POST /api/tasks/accept-criterion`

What was refused before still is, with the same codes. The receipt is now also **held to the task's ledger** (`receiptProblem`):

| 409 code | When |
|---|---|
| `acceptance_ledger_unreadable` | no ledger, or one that does not verify |
| `acceptance_tree_unknown` | the ledger's last tree has no id (the final snapshot failed) |
| `stale_acceptance_receipt` | the receipt's tree is not the ledger's last tree, whatever the task file says |
| `acceptance_receipt_not_in_ledger` | no record of the ledger shows what the receipt says |

A check shows as a `check` record whose line hash starts with the receipt's id (the done-gate's), or a `run_command` call that returned without an error, overlapped no
other call and left the tree as it found it; an edit as such a call whose tree after is the receipt's; a read and a diff review (which are not scanned) as any
record with that tree. The receipt does not name its call, so one such call on the tree is enough: the ledger shows that the work happened on
this tree, not that this very call was it. The Hub's own matching of checks (the owner's option) happens while the run goes on and is not asked again.

## Limits

- **Tamper-evident, not tamper-proof.** An agent with an approved shell runs as the same user and can rewrite the ledger, the task file and the pack together.
- The digest a task names is in its task file. Public answers are masked as text, so a registered secret of a few hex digits that occurs in a digest by chance
  breaks that digest in the summary (the route then finds no pack); registered secrets are keys and tokens, not short numbers.
- A pack is of the workspace of the Hub's task. What an MCP client or the Companion did is in no pack.
- A criterion the owner must look at (`manual`) stays `unverified`: no owner acceptance of a criterion of the file is recorded yet (pod-34).
- The answer about the acceptance file is of the open project. A second chat's worktree can hold another version; it is held to its own file.

## Not verified

- No page uses the routes; nothing was looked at in the installed app or in WebView2.
- No real model and no large repository: the build was timed on small projects (about a second) and the checks of a pack on synthetic ledgers. What the 120 s
  mean for a workspace of 100,000 files was not measured.
- Linux and macOS were not run by hand (CI runs Linux). The file modes are checked there only; on Windows the packs inherit the folder's ACL.
- A symbolic link in the place of the acceptance **file** was not tried on the Windows machine this was written on (no privilege); a junction in the place
  of its folder was. CI on Linux tries both.
- Two Hubs on one data folder cannot run ([HUB-AUTH.md](HUB-AUTH.md)), so nothing was tried there.

## Tests

`tests/verify-proof-hub-pack.mjs` (what a pack holds, the background build, second chats, the files, the summary, the ledger behind an acceptance, what the route answers of a pack),
`tests/verify-proof-hub-pack-none.mjs` (every reason a run can meet, and what interrupts a build), both on the real agent loop with a scripted model;
`tests/verify-proof-http.mjs` and `tests/verify-proof-trust-http.mjs` (a real Hub process, the real command line). `tests/verify-hub-auth.mjs` asks every route without
the secret. Mutation lists: `proof-hub-pack.json`, `proof-hub-pack-none.json`, `proof-http.json`, `proof-trust-http.json`.
