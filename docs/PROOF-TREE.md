# Proof-of-Done: the tree snapshot engine (P4 pod-15)

`DATGOLD-HUB/lib/proof/tree-snapshot.mjs` and `DATGOLD-HUB/lib/proof/git-plumbing.mjs` compute a **content identity of the workspace
tree**: a Git tree id of the files the workspace holds at one moment. Later Proof-of-Done pieces bind to such an id (the receipts of
pod-18, the ledger of pod-16, the agent wiring of pod-17, the verify CLI of pod-24).

**Status: an engine and its API only. Nothing in the Hub or the agent calls it yet**, so it makes no claim to users and adds none to
[THREAT-MODEL.md](THREAT-MODEL.md) or [CLAIMS.md](CLAIMS.md). Today's receipts (`lib/verification-receipt.mjs`) are unchanged.

## API

```js
import { TreeSnapshotter, snapshotTree, TREE_ALGORITHM, LIMITS } from './lib/proof/tree-snapshot.mjs';

const snapshots = new TreeSnapshotter({
  root,               // the workspace folder
  stateDir,           // a private folder of the Hub: temporary index, private object store, exclude file, empty config
  git,                // optional: path of Git, or null for "no Git"; PATH when left out
  env,                // optional: the environment Git would inherit (default process.env; every GIT_* variable is dropped)
  engine,             // optional: 'auto' (default) | 'git-pinned-v1' | 'raw-v1' (forces raw-v1; 'git-pinned-v1' is only a preference)
  limits,             // optional: overrides of LIMITS
});
await snapshots.snapshot({ full: true });  // task start, final, pack: no cache, also computes rawTree
await snapshots.snapshot();                // between those: reuses the stat information of the last snapshot
await snapshotTree({ root, stateDir });    // one full snapshot
```

Calls on one `TreeSnapshotter` are serialised. A property of the workspace never throws: the engine falls back to `raw-v1` and says
why. It throws only for bad arguments, a missing workspace folder (`root_unreadable`) and cancellation (`signal`).

Other exports, for the later pods and the tests: `blobId`, `treeId`, `buildTree`, `gitlinkCommit`, `MODE` (git-plumbing),
`exclusionOf`, `excludeLines`, `privateFileGlobs`, `caseless`, `LIMITATION`, `SNAPSHOT_FORMAT` (tree-snapshot).

## The snapshot

```js
{
  format: 'chatmcp.tree-snapshot/1',
  status: 'ok' | 'unbounded',          // unbounded: more than LIMITS.maxFiles (200,000) files or LIMITS.maxBytes (2 GiB); no tree then
  treeAlgorithm: 'git-pinned-v1' | 'raw-v1' | null,
  tree: '<hex tree id>' | null,
  rawTree: '<hex tree id>' | null,     // full snapshots only: the raw-v1 tree of the same moment
  objectFormat: 'sha1' | 'sha256',
  full: true | false,
  engineReason: null | '<code>',       // why not git-pinned-v1, see below
  ignoreRules: 'git' | 'none',         // whether .gitignore was applied
  files, bytes,                        // counts of what is in the tree
  excluded: { protected, runs, gitlinks },
  limits: { maxFiles, maxBytes },
  limitations: ['untracked-ignored-paths-not-covered' | 'ignore-rules-not-applied', 'counts-from-last-full-snapshot'?],
  unbounded?: 'files' | 'bytes',
  takenAt: '<ISO time>', durationMs,
}
```

A cached snapshot of the git engine does not walk the files itself: `files`, `bytes` and `excluded` are those of the last full snapshot,
and `limitations` says so. Two ids can be compared only when their `treeAlgorithm` (and `objectFormat`) are equal.

## The two engines

**`git-pinned-v1`** is Git itself, pinned:

- a temporary index in `stateDir` (`GIT_INDEX_FILE`) and a private object store (`GIT_OBJECT_DIRECTORY`); `GIT_DIR` and
  `GIT_WORK_TREE` name the repository and the workspace exactly;
- `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL` = an empty file, `GIT_ATTR_NOSYSTEM=1`, and `core.excludesFile` / `core.attributesFile`
  always named (left unset, Git reads the person's `~/.config/git/ignore` and `attributes` whatever the variables say);
- `-c core.autocrlf=false -c core.safecrlf=false -c core.fsmonitor=false -c core.longpaths=true`, no sparse view, no untracked cache, no
  split index, hooks pointed at an empty folder, no automatic gc, and `core.fscache=true` (Git for Windows sets it in the system
  configuration, which is not read; without it a scan of 8,000 files is five times slower);
- every `GIT_*` variable of the inherited environment is dropped, credentials are scrubbed (`scrubEnv`).

A full snapshot seeds a fresh index from the raw rows (`update-index --index-info`), lets Git check them against the files
(`update-index --refresh` hashes and writes no object), runs `add -A`, and builds the tree from `ls-files -s` in Node. A cached snapshot
runs `add -A` on the kept index (only changed files are hashed; only blobs of changed files are written, to the private store), adds with
`add -f` the tracked files that are on disk but not in that index (force-added since, or written again after a deletion), drops the
entries that changed ignore rules now exclude and the repository does not track, and builds the tree the same way. The id equals what
`git add -A`, then `git add -f` of the repository's tracked paths that are on disk, then `git write-tree` give in a fresh index with no
system or global configuration: `.gitattributes` conversions (`text`, `eol`, `ident`, `working-tree-encoding`) apply, the person's and
the repository's line-ending settings do not.

**The repository's own index and object store are never written, not even their file times.** That is why there is no
`GIT_ALTERNATE_OBJECT_DIRECTORIES`: when Git finds an object it is about to write in an alternate store, it "freshens" it by rewriting
the modification time of the loose object or of the whole pack file. With the repository's objects as an alternate, a snapshot changed
the times of objects below `.git/objects` (measured: `tests/verify-proof-tree.mjs` compares every file of `.git` by size, time and
hash). Without it the private store starts empty, the full snapshot writes no blob, and `write-tree` (which would write every tree
object, about 9.9 s for 1,600 loose trees on Windows) is replaced by `buildTree` over `ls-files -s`.

**`raw-v1`** is pure Node over the raw bytes: every blob is `git hash-object --no-filters`, the tree is `git write-tree --missing-ok`
over them (Git's entry order, modes `100644`/`100755`/`120000`/`160000`, empty folders absent). It keeps its own stat cache (size,
mtime, ctime, inode, mode); an entry whose mtime lies within `LIMITS.racyWindowMs` (2 s, the FAT clock) of the moment it was cached is
hashed again (the racy-window rule). A full snapshot ignores the cache.

### When raw-v1 is used (`engineReason`)

| Reason | When | Ignore rules |
|---|---|---|
| `not_a_repository` | no `.git` in the workspace folder | none |
| `repository_unreadable` | `.git` is a file that names no folder | none |
| `repository_config_refused:<keys>` | `refusalsForRunner(inspectGitSafety(root))` is not empty (a clean/smudge/process filter, a textconv or diff/merge driver, `include.path`, gpg, ...): **Git is not started at all** | none |
| `git_missing` | Git is not found, or `git --version` fails | none |
| `repository_programs:<keys>` | any `filter.*.clean/smudge/process` in the repository's config (Git LFS included, which git-trust otherwise allows), a `core.fsmonitor` program, a textconv: Git only lists the files (`ls-files` reads no content and runs no filter; fsmonitor is off) | git |
| `engine_forced` | `engine: 'raw-v1'` | git |
| `too_many_new_blobs:<n>` | a full snapshot would have to write more than `LIMITS.maxNewBlobs` (3,000) blobs: the files `.gitattributes` converts | git |
| `git_failed:<code>` | a Git step failed; the full snapshot gives the raw tree it already computed | git |

When Git cannot list the files the walk applies no ignore rule (`ignoreRules: 'none'`, limitation `ignore-rules-not-applied`): a
`node_modules` folder is then part of the tree, and may make the workspace `unbounded`.

## What is left out

- **Protected files** (`isProtectedPath`, `lib/protected-paths.mjs`) and the top-level **`.chatmcp/runs`** folder, counted in
  `excluded.protected` and `excluded.runs`. raw-v1 calls `exclusionOf()` directly. Git gets `excludeLines()` as `core.excludesFile`:
  the name globs of `privateFileGlobs()` (exactly the names `PRIVATE_FILE` matches, case folded with bracket classes so that
  `core.ignorecase` does not matter), one `!glob/` per name glob so that a folder with such a name is not hidden, the protected folders
  and locations, `.chatmcp/hooks.json` and `/.chatmcp/runs`. A `.gitignore` of the workspace outranks that file and can re-include a
  protected file with `!`; the tree is therefore always filtered with `exclusionOf()` again, and a re-included file is dropped from the
  index and its blob deleted from the private store. The secret is then hashed once by Git, never part of an id.
  `PRIVATE_FILE` says "one or more digits" in `.tfstate.<digits>`, which a glob cannot: up to nine digits are written out and ten or
  more are matched by a prefix (an over-match: such a name is left out although `PRIVATE_FILE` would keep it).
- **Untracked ignored paths** (limitation `untracked-ignored-paths-not-covered`): what `.gitignore` and `.git/info/exclude` exclude is
  not in the tree **unless the repository tracks it**. Ignore rules apply to untracked files only, as in Git: every path of the
  repository's own index (read with `ls-files --cached`, never written; the tree of `HEAD` when there is no index yet) that is a file
  on disk is in the tree, so a force-added build output or a committed lock file under a broad ignore pattern is covered, and an edit
  of it changes the id. A tracked file deleted from the working tree drops out. A change to an untracked ignored file does not change
  the id. When Git cannot be used (`ignoreRules: 'none'`) nothing is ignored at all. (Found by the audit of PR #132, finding F1.)
- **Nested repositories** are a gitlink to their checked-out commit (a submodule, or any folder with `.git`), as `git add` records them;
  one without a commit cannot be added and is left out (`excluded.gitlinks`). Their content is not covered.
- What a sparse checkout did not put on disk is not in the tree.

Not handled specially (documented, not tested): Windows junctions (Git for Windows follows them, the Node walk does not), file names
that differ only in Unicode normalisation (macOS), and names of the hooks file with a trailing dot, space or `:stream` on Linux
(`isProtectedPath` folds them on every system; the Git exclude file does not, so a cached git snapshot would hash such a file once and
then drop it as above).

## Tests

`DATGOLD-HUB/tests/verify-proof-tree.mjs` compares every id with an independent reference: plain `git add -A`, `git add -f` of the paths the
repository's own index tracks that are still on disk, and `git write-tree`, in a throw-away bare repository (its own index and objects,
the workspace's objects as an alternate, the workspace's `.git/info/exclude`), without system or global configuration. Fixtures:
tracked files that an ignore rule matches (edited, force-added later, un-tracked, deleted), worktree (`.git` file), submodule, sparse checkout, LFS pointer (with and without a repository LFS filter), a
clean filter whose program writes a canary (the canary must stay absent; a control shows plain `git add` does write it), fsmonitor and
textconv, a path over 260 characters, a symlink (where the system allows creating one), an executable bit (not on Windows), CRLF files
with `core.autocrlf=true` in the person's and the repository's configuration plus the person's own ignore and attributes files and a filter of their global configuration (whose canary must stay absent), a
same-size edit with the modification time put back (the full snapshot must catch it), protected files and `.chatmcp/runs`, no Git, a
plain folder, the limits, an empty nested repository, the repository's `.git` byte for byte unchanged, and the parity of the exclude
lines with `PRIVATE_FILE` and `exclusionOf()` judged by Git itself. Then budgets on an 8,002-file repository, printed as one line
`PROOF_TREE_BUDGET {...}` (gate G4 criterion 1): warm p95 <= max(300 ms, 3x `git status --porcelain` p95), cold full snapshot <=
max(4 s, 6x the first `git status`), raw-v1 warm p95 <= 1.5 s. `tests/verify-proof-tree-property.mjs` runs the property test: 200
random create/edit/same-size-edit/delete/rename steps (and `.gitignore` changes) on a 663-file and an 8,002-file repository, the cached
snapshot compared with the reference after every step, full snapshots, `rawTree` and raw-v1 at fixed steps.

Mutation list: `DATGOLD-HUB/tests/mutation/proof-tree.json`.
