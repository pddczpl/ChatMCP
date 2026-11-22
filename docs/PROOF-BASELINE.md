# Proof-of-Done: the baseline store, the diff and the patch hash (P4 pod-25)

`DATGOLD-HUB/lib/proof/baseline.mjs` is **observe mode**: when a task starts it keeps a baseline of the workspace, and when the task ends
it compares the workspace with that baseline. The result is a change list for every workspace and, for a Git workspace, a patch between
the two trees whose **sha256 is the subject a proof pack binds to** (the pack builder is pod-29's; this module only exposes the hash).

**Status: a module and its API only. Nothing in the agent or the Hub calls it yet**: the wiring into the task lifecycle is pod-26's and
pod-32's. It makes no claim to users, so it adds nothing to [THREAT-MODEL.md](THREAT-MODEL.md) or [CLAIMS.md](CLAIMS.md).

It builds on the tree snapshot engine ([PROOF-TREE.md](PROOF-TREE.md)), the state folder of the proof ledger
([PROOF-LEDGER.md](PROOF-LEDGER.md)) and the acceptance file ([PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md)).

## API

```js
import { snapshotBaseline, diffBaseline, loadBaseline, listBaselines, pruneBaselines } from './lib/proof/baseline.mjs';

const base = await snapshotBaseline({ hubDir, root });        // under the workspace lock; prunes on write
// base = { id, sha256, file, record, timings }: keep base.id and base.sha256 OUTSIDE the baseline folder (the proof ledger)
const diff = await diffBaseline({ hubDir, root, id: base.id, expectSha256: base.sha256 });
// diff.patch = { status: 'ok', reason: null, sha256, bytes, reproduces: true, git } | { status: 'unavailable', reason }
// diff.patchBytes = the patch (a Buffer) | null
await loadBaseline({ hubDir, root, id, expectSha256 });       // { record, sha256, verifiedAgainst: 'anchor' | 'self', file, entries }
await listBaselines({ hubDir, root });                         // [{ id, createdAt, file, store }], oldest first
await pruneBaselines({ hubDir, root });                        // { removed, kept }
```

Options of `snapshotBaseline` and `diffBaseline`: `git` (as for `TreeSnapshotter`: PATH when left out, `null` for none), `env`, `signal`,
`lock` (overrides of `LOCK_RULES`); `snapshotBaseline` also takes `toolchain` (a `{versions(root)}` probe, `null` for none, a
`ToolchainProbe` of the ledger when left out), `now` (the clock of the id and of retention) and `retention` (overrides of `RETENTION`).

Building blocks, exported for pod-29 and the tests: `importTree`, `treePatch`, `patchReproduces`, `initStore`, `encodeManifest`,
`decodeManifest`, `manifestChanges`, `workspaceKey`, `baselineFolder`, `acquireWorkspaceLock`, and the constants `BASELINE_FORMAT`,
`BASELINE_DIFF_FORMAT`, `STORE_REF`, `DIFF_ARGS`, `RETENTION`, `LOCK_RULES`, `BASELINE_LIMITS`.

`lib/proof/tree-snapshot.mjs` got one option for this module: `snapshot({full, entries: true})` also returns `entries`, the rows
`{path, mode, oid}` the tree was built from (`null` when there is no tree). Without the option a snapshot is what it was.

## On disk

`<hubDir>/proof/baselines/<workspaceKey>/`, next to the proof ledgers (`<hubDir>/proof/<taskId>.jsonl`). `workspaceKey` is the first 32
hex digits of the sha256 of the resolved workspace path (lower case on Windows).

| Name | What |
|---|---|
| `<id>.json` | the record, one line of JSON that ends with its own sha256 |
| `<id>.git/` | Git workspaces only: the private store, a bare repository written by hand (no `git init`, so no template and no hook) holding the baseline commit on `refs/datgold/baseline` (`STORE_REF`) as **one pack** |
| `lock`, `lock.break` | the workspace lock (below) |
| `tmp-<uuid>/` | the snapshot's temporary index and objects, and the final store of a diff; removed when the call ends |

An id is the UTC time of the baseline and 32 random bits, `20261122T120000123Z-1a2b3c4d`; ids sort by time.

## The record

The record is `JSON.stringify(record)` with `,"recordSha256":"<sha256 of that text>"` put in front of its closing brace, then `\n`
(the envelope of the proof ledger). `sha256` returned by `snapshotBaseline` is that hash: **the anchor**.

| Field | What |
|---|---|
| `format` | `chatmcp.proof-baseline/1` |
| `id`, `createdAt` | the id (the file name) and its time |
| `workspace` | `{key, root}` |
| `treeAlgorithm`, `objectFormat`, `tree`, `rawTree` | of the full snapshot ([PROOF-TREE.md](PROOF-TREE.md)) |
| `snapshot` | `{engineReason, ignoreRules, files, bytes, excluded, limitations, takenAt, durationMs}` of that snapshot |
| `manifest` | `{encoding: 'gzip+base64', entries, sha256, data}`: gzip of the JSON text `[[path, mode, oid], ...]` in path order; `sha256` is of that text. Read back only when the sha256, the count, every row (three strings, a relative path without `.` or `..`, a known mode, a hex id), the order and the uniqueness hold, and when the rows build the record's `tree` |
| `acceptance` | `{path: '.chatmcp/acceptance.yml', present, bytes, sha256, content}`: the bytes of the file's blob in the baseline tree (the converted blob when `.gitattributes` converts it), `content` in base64 only up to 64 KiB (`ACCEPTANCE_MAX_BYTES`); a file the tree does not hold (ignored, missing) is `present: false` |
| `packageScripts` | `{present, scripts, problem}` of the root `package.json` in the tree: the string values of `scripts`; `problem` is `not_json`, `not_an_object` or `scripts_not_an_object` |
| `git` | `{repository, head, branch, dirty, dirtyReason}`: `head` is the checked-out commit read from the files of `.git`, `branch` from `HEAD`, `dirty` is `{clean, added, modified, deleted}` of the tree against the tree of `head` (read through the pinned Git, never written; protected files left out on both sides). An unborn `HEAD` counts every file as added. `dirtyReason` says why there is no summary |
| `toolchain` | `{node, python, dotnet, git}` versions of the ledger's `ToolchainProbe`, or null |
| `store` | `{kind: 'git', directory: '<id>.git', ref, commit, git}` or null |
| `patch` | `{available, reason}`: whether a diff can make a patch |

The store holds a copy of every file of the tree: what the workspace tracks and its untracked files that `.gitignore` does not exclude,
**never a protected file** (`lib/protected-paths.mjs`) and never `.chatmcp/runs`: the snapshot leaves them out and only the rows of its
tree are written. `package.json` scripts are kept as they are; they are in the store anyway.

## Git workspaces: the private store

`snapshotBaseline` writes every blob and tree of the baseline into `<id>.git` with **one `git fast-import`** (`--done`,
`fastimport.unpackLimit=0`, so always one pack): blobs inline (each read once and checked against its id: a file that changed between
the snapshot and the read throws `workspace_changed`, and nothing is committed), then one commit on `STORE_REF` whose tree must equal the
snapshot's. A blob that `.gitattributes` converted comes from the snapshot's own private objects; any other is the file as it is on disk.
Git runs with the store as `GIT_DIR`, no work tree, no index, no system or global configuration, no attributes file, hooks pointed at an
empty folder and the pinned settings of [PROOF-TREE.md](PROOF-TREE.md). **The user's repository and object store are never written or
relied on**: an agent that commits, creates or switches branches or worktrees, rewrites history, deletes branches, expires the reflog and
runs `git gc --prune=now` changes nothing the baseline needs (the suite does all of that).

`diffBaseline` writes the final tree into a temporary store (`tmp-<uuid>/final.git`) whose `objects/info/alternates` names the
baseline's objects, so only new blobs are written; runs

```text
git diff --no-color --no-ext-diff --no-textconv --binary --full-index --no-renames --diff-algorithm=myers
         --src-prefix=a/ --dst-prefix=b/ --no-relative --submodule=short --ignore-submodules=none <baselineTree> <finalTree>
```

(`DIFF_ARGS`; with `core.quotepath=false`, nothing of the person's or the repository's configuration is read, renames are not guessed: a
rename is a deletion and an addition), and checks the patch: `git read-tree <baselineTree>` into a temporary index,
`git apply --cached --binary`, `git write-tree` must give the final tree id. An empty patch (no change) is 0 bytes, sha256
`e3b0c442…b855`. **`patch.sha256` is the sha256 of exactly the bytes in `patchBytes`.** Another Git version may write a binary patch
with other bytes (zlib), so `patch.git` records the version that made it; the reproduction check is what holds across versions.

Before the patch is made, the store is checked against the verified manifest: `git ls-tree -r` of the baseline tree must list exactly
the manifest's rows (Git checks the hash of the root tree when it parses it, but not of the trees below it), and the old blob of every
modified or deleted path is read with `cat-file --batch` and hashed again (Git does not check that either).

### When the patch is unavailable

| `patch.reason` | When |
|---|---|
| `not_a_repository` | the workspace has no `.git`: manifest change list only (below) |
| `repository_unreadable` | `.git` is a file that names no folder |
| `git_missing` | no usable Git when the baseline was taken, or when the diff runs |
| `baseline_objects_missing` | the store folder, its baseline tree or a blob it must hold is gone |
| `baseline_objects_mismatch` | the store does not hold the manifest's trees, or an old blob does not hash to its id |
| `baseline_objects_unreadable` | Git could not read the old blobs |
| `object_format_changed` | the repository moved between SHA-1 and SHA-256 |
| `patch_too_large` | the patch is over `BASELINE_LIMITS.maxPatchBytes` (128 MiB) |
| `patch_does_not_reproduce` | the patch applied to the baseline tree does not give the final tree |

The change list is there in every case: it comes from the verified manifest and the final snapshot.

## Workspaces without Git

A plain folder gets a record without a store and, from `diffBaseline`, the **manifest-only change list** with `patch:
{status: 'unavailable', reason: 'not_a_repository'}`. No store is kept for it on purpose: without Git no ignore rule applies
([PROOF-TREE.md](PROOF-TREE.md), `ignore-rules-not-applied`), so a `node_modules` or build folder would be copied into the Hub folder at
every baseline.

The change list (`diff.changes`, counts in `diff.counts`): `added` and `deleted` rows `{path, mode, oid}`, `modified` rows
`{path, oldMode, newMode, oldOid, newOid}` (a change of mode alone is a modification), each sorted by path. `diff.sameTree` is true when
the algorithm and the tree id are the same. When the final snapshot used another tree algorithm than the baseline (Git installed or gone
in between, a filter added), a converted file shows as modified; the patch is still exact between the two trees.

## The lock

Every `snapshotBaseline`, `diffBaseline` and `pruneBaselines` of one workspace runs under `<folder>/lock`, created exclusively and holding
`{pid, host, token, since, purpose}`. **The rule: a second call waits, polling every 50 ms, up to `LOCK_RULES.waitMs` (60 s), then
refuses with `baseline_busy`.** In one process the same rule applies (its own held lock counts as held). The holder refreshes the lock's
modification time every 15 s (the heartbeat).

A lock is **stale**, and is broken at once, when:

- it names a process **on this host** that no longer runs (a crashed Hub, or a killed process);
- its heartbeat is older than `LOCK_RULES.staleMs` (120 s), whatever host or process it names (a hung or vanished holder, a reused id);
- it names this very process with a token it does not hold (a release that failed);
- its content is not a lock record and the file is older than `LOCK_RULES.breakGraceMs` (10 s): a lock still being written is younger.

A lock of another host is never judged by its process id. Breaking happens under `lock.break` (created exclusively; one left by a crashed
breaker is removed after 10 s) and only when the lock is still byte for byte, and to the millisecond, the one judged stale. A release
removes the lock only while it still holds this holder's token. Limits: two copies of the module loaded under different URLs in one
process do not know each other's tokens; a process that stops its heartbeat for over 120 s while working loses its lock.

## Retention

`RETENTION = {maxAgeMs: 14 days, maxPerWorkspace: 10}`. On every write, after the record is written: this workspace keeps its 10 newest
baselines (by the time in the id) and none older than 14 days; **the baseline just written is never removed by its own write**, even when
the clock went back. Every other workspace of the Hub loses its baselines older than 14 days (a workspace whose lock is held is skipped
until its own next write). A store without its record and the leftovers of a crash (`tmp-*`, half-written records) are removed.
`pruneBaselines` applies the same rule on demand. The record is removed before its store.

## Integrity: detected, never sealed

The agent runs as the same Windows user as the Hub and can read, delete and rewrite everything here. So:

- a record with one byte changed fails its own sha256: `baseline_edited`;
- a record rewritten with its own hash recomputed passes alone (`verifiedAgainst: 'self'`) but not against the anchor:
  `baseline_mismatch`. **The anchor must be kept outside this folder** (the proof ledger's `task_start` or `tree` record is the plan);
- a deleted record is `baseline_missing`; a deleted or forged store makes the patch unavailable with the reasons above;
- a record that names another workspace (`baseline_wrong_workspace`), another format, another store folder, or a manifest that does not
  build its tree (`baseline_bad_record`) is refused.

None of this is tamper-proof: an agent that also rewrites the anchor where it is kept can replace a baseline whole. A pack built on it
keeps the integrity level "unconfined" (as in [PROOF-LEDGER.md](PROOF-LEDGER.md)).

## Budgets and measured numbers

Each run of `tests/verify-proof-baseline.mjs` prints one line `PROOF_BASELINE_BUDGET {...}` and holds these budgets, set with room for
a CI runner two to three times slower than the machine below:

- storing the objects costs at most `max(3 s, 1 ms × blobs)` (the plan measured 5.6 ms per new loose blob);
- a baseline costs at most `max(5 s, 2.5 × its own full snapshot)` (storing reads every file the snapshot hashed once more);
- a diff costs at most `max(10 s, 4 × the full snapshot)`.

Measured on 2026-11-22 on the author's machine (Windows 11, Node 24.19.0, Git 2.55.0):

| Repository | Files | Full snapshot | Baseline | Storing the objects | Diff (20 files edited) | Store on disk | Record |
|---|---|---|---|---|---|---|---|
| 663 files, committed | 663 | 478 ms | 793 ms | 205 ms (0.31 ms per blob) | 958 ms | 217 KB | 27 KB |
| 8,002 files, all untracked | 8,002 | 2,858 ms | 4,473 ms | 1,647 ms (0.21 ms per blob) | 3,389 ms | 2.7 MB | 314 KB |

The plan measured about 5.6 ms per new blob for loose objects, about 45 s for 8,000 untracked files; one pack through `fast-import` is
roughly 25 times cheaper. The store time is mostly reading the files.

## Risks

- **Disk growth**: one store is the packed size of the tree (2.7 MB for the 8,002 files above); retention bounds a workspace to 10 of
  them and 14 days. A large repository with 10 baselines can still take 10 times its packed size until they age out.
- **A slow first baseline on a large untracked tree**: bounded by the snapshot's limits (200,000 files, 2 GiB, `workspace_too_large`
  beyond them); the objects are written as one pack, never as loose objects.
- **An agent deletes or edits a baseline**: detected and reported as above, never prevented.
- **A file that changes while the baseline is taken**: `workspace_changed`; the caller takes it again.

## Decisions

- One store per baseline rather than one per workspace: pruning is then deleting a folder, with no `git gc` of a shared store and no
  object kept alive by another baseline; the price is no sharing of blobs between baselines of one workspace.
- No store for a plain folder (see above), as the plan says; the change list carries the blob ids.
- The record is one line with its own hash, the envelope of the ledger, and the anchor is the caller's to keep.
- A dirty summary against `HEAD`'s tree from the snapshot's own rows, not `git status`: status would refresh the repository's index and,
  with a filter configured, run it.
- The acceptance file and `package.json` are read from the snapshot's tree, not again from disk.

## Tests

`DATGOLD-HUB/tests/verify-proof-baseline.mjs` (12 checks) on real temporary folders and Git repositories: the record of a Git workspace
(the tree equals `git add -A` without the protected `.env`, a `.gitattributes` conversion, an untracked file, an ignored file, the
repository's `.git` byte for byte unchanged); the agent edits (text, CRLF, binary), deletes, renames, adds a path with spaces and
Vietnamese letters, changes a mode (POSIX), commits on a new branch, switches branches, rewrites history into an orphan commit, deletes
the old branches, expires the reflog and runs `git gc --prune=now`, and the patch applied with `git apply --index --binary` to a fresh
clone of the baseline from the store gives the final tree id exactly; the store level on every system (a mode change, a symbolic link, a
submodule, an empty file, names fast-import must quote on POSIX, reproducible bytes, limits); an empty diff; no Git; a plain folder;
the manifest and its refusals; the lock in and across processes (a live holder, a crashed one, an old heartbeat, another host,
unreadable content, a crashed breaker, the heartbeat, a release that is no longer its own) and four concurrent baselines of one
workspace; retention by count, by age, across workspaces, leftovers; edited, re-hashed, moved and missing records; a missing store, a
forged blob, a forged tree below the root and a forged root; the snapshot's rows; the budgets.
Mutation list: `DATGOLD-HUB/tests/mutation/proof-baseline.json`.
