# The run sandbox and the clean-room scoring checkout

Plan task P7 pod-36. `tools/run-sandbox.mjs` runs one agent on one task in a folder of its own and hands back the agent's diff;
`tools/score-checkout.mjs` scores a diff in a fresh checkout that never sees the agent's tree. They share `tools/sandbox-core.mjs` (the
run folder, the base, the profile, the process trees) and `tools/tar.mjs` (the archive reader). **What exists today:** both tools, their
command lines and their tests with scripted agents. **What does not exist yet:** the adapters that start a vendor's CLI (pod-37) and the
report (pod-39); the scoring of the runs and the metrics (pod-38) are in [SCORING.md](SCORING.md). No real agent and no model has been
run through them.

**This is not an OS sandbox.** The agent runs as the same user as the tools, with the same rights: it can read the real profile by its
absolute path, reach the Windows Credential Manager, DPAPI-protected stores, an SSH or GPG agent and the network, see and signal other
processes, and write anywhere that user can, the run's own private store included. What the sandbox does is keep the *default* paths
clean (the agent's HOME and config folders are fresh and empty) and keep the *score* independent of the agent's tree. The plan's risk
stands: real runs must happen on a dedicated machine or VM that holds nothing the agents must not see.

- [The run folder](#the-run-folder)
- [A run, step by step](#a-run-step-by-step)
- [The agent's diff](#the-agents-diff)
- [The profile: no copied credentials](#the-profile-no-copied-credentials)
- [Process trees](#process-trees)
- [Cleanup](#cleanup)
- [Scoring](#scoring)
- [Archives](#archives)
- [Refusals](#refusals)
- [Command lines](#command-lines)
- [Tests](#tests)
- [Limits and what is not verified](#limits-and-what-is-not-verified)

## The run folder

Every run and every scoring takes a folder `<root>/<8 hex>` (the name is reserved with an exclusive `mkdir`) with four short folders:

```text
<root>/<8 hex>/
  w/    the work tree: the agent's current folder, a Git repository with one baseline commit
  b/    the private base store: a bare repository with the base tree, outside the work tree
  h/    the profile: home, appdata, local, config, data, cache, state, codex, claude, tmp
  s/    scratch: the indexes the diff is read with, an empty Git configuration, an empty hooks folder, the shell's script files
```

**The root.** The default is `C:\cmr` on the system drive on Windows (`%SystemDrive%\cmr`) and `/tmp/cmr` elsewhere; the variable
`DATGOLD_CORPUS_SANDBOX_ROOT` or the `root` option replaces it, and it must be an absolute path. The tools only create and delete their
own `<8 hex>` folders; the root itself is never removed. A short root matters on Windows: a repository checked out under a worktree of
this repository (`F:\...\.claude\worktrees\<name>\...`, about 100 characters) runs past MAX_PATH, and the worktree probes of the plan
failed there (MAX_PATH, "$GIT_DIR too big"). Under `C:\cmr` the work tree is `C:\cmr\1a2b3c4d\w`, 17 characters.

**The path budget.** Before anything is checked out, the longest path of the base (and, when scoring, of the hidden tests) is added to
the work tree's path. Above the budget the run is refused with `path_too_long`, naming the path and its length: 259 characters on Windows
(MAX_PATH less its NUL, what many Windows programs and older npm versions can open), 4095 elsewhere, or the `maxPath` option. Git itself
runs with `core.longpaths=true`, so the budget is about the agent's tools, not about Git.

## A run, step by step

`runSandbox({task, gitSource, root, agent, wallSeconds, setup, extraEnv, env, signal})`:

1. The arguments are checked before anything is written (`bad_argument`, `bad_agent_env`, `bad_seed_path`), and Git must be 2.42 or newer
   (`git_too_old`), for `GIT_ATTR_SOURCE`.
2. The run folder is made. The base is read: for a Git task, `gitSource` is a **local** repository that holds the task's commit (a bare
   repository or a work tree); the tools never fetch, clone or contact a network, so getting the commit there, from the pinned URL, is the
   owner's step before the runs (`git_source_required`, `base_missing`). For a tarball task, the tarball beside `task.yml`, whose sha256
   is checked again (`tarball_mismatch`) and which is read by the strict reader (`tarball_invalid`).
3. The path budget (`path_too_long`).
4. **The baseline commit.** The base tree goes into the private store `b/`: for a Git source the objects of that one tree, packed from the
   source (`pack-objects` over the tree, never the history); for a tarball, through `git fast-import`. One parent-less commit is made of
   it, with the message `baseline`, the author and committer `DatGold Corpus <baseline@corpus.datgold.invalid>` and the date
   946684800 (2000-01-01): the same commit id for the same tree, in every run and from either source. `w/` becomes a repository of its own
   (`git init`, an empty template, branch `main`), the commit's objects are copied into it as one pack, and every file is checked out
   as its blob (see the next section). The agent gets no upstream history.
5. **The profile** (see below) is made and the seed files are written.
6. **Setup**: the task's `setup` commands (or the `setup` option), in turn, in `w/`, through the shell the Hub's checks use
   (`ShellRunner`: Git Bash or bash, else Windows PowerShell), with the setup environment and a time limit per command (900 s by default).
   A failing command stops the run (`setup_failed`). Then the tree is read: setup may write paths Git ignores (`node_modules/`, a virtual
   environment) but nothing else, because the agent's diff must be the agent's alone (`setup_changed_tree`, with the paths). A task whose
   setup rewrites a tracked file (`npm install` rewriting `package-lock.json`) must use the command that does not (`npm ci`).
7. **The agent**: `agent.command` with `agent.args`, without a shell, in `w/`, with the agent environment, its standard input closed (or
   `agent.input`), its output kept up to 8 MiB (the head and the tail). At `wallSeconds` (default: the task's `limits.wall_seconds`) or
   on `signal`, its whole process tree is killed (`timedOut`, `cancelled`). A program that cannot start is `agent_failed_to_start`.
8. What the processes of the run left behind is killed (see "Process trees"), then the final tree is read and the diff written.
9. The run folder is removed, also when any step above failed.

The result: `{format: "datgold.corpus-run/1", runId, taskId, root, baseTree, baseCommit, finalTree, patch (bytes), patchSha256,
patchBytes, agent: {exitCode, signal, timedOut, cancelled, stuck, wallMs, stdout, stderr, truncated, outputBytes}, setup: [...],
profile: {variables, inherited, credentials, seeded}, cleanup: {removed, leftovers}}`. Reading the final-line marker from `agent.stdout`
(`tools/marker.mjs`) is the adapter's job: a vendor CLI's output format decides where the final message is.

## The agent's diff

The diff is read from the private store, never from the agent's own `.git`, which the agent can rewrite: a fresh index in `s/` is read
from the base tree (so file modes a Windows file system cannot hold, an executable bit or a link, are kept), `git add --all` runs with
`GIT_DIR=b`, `GIT_WORK_TREE=w`, then `git write-tree` gives the final tree and `git diff --binary --full-index --no-renames` between the
two trees gives the patch. It is checked: applied with `git apply --cached` to the base tree in another index, it must give the final tree
(`patch_not_reproducible` otherwise). So a diff written by a run always applies to the base.

- **Ignored paths.** Only the work tree's own `.gitignore` files count, as they stand at the end of the run: `core.excludesFile` is an
  empty file and the private store has no `info/exclude`. A file in an ignored path is not in the diff and so never reaches the score.
  An agent that edits a `.gitignore` puts that edit in its diff, where the reader sees it.
- **Raw bytes.** Every Git process of the tools runs with `GIT_ATTR_SOURCE` set to the empty tree, so the work tree's `.gitattributes`
  is not read: no line-end conversion, no filter, no `text=auto`; and with `core.autocrlf=false`, `core.fsmonitor=false`, hooks pointed at
  an empty folder, no system or global configuration and none of the person's `GIT_*` variables (`pinnedEnv`/`pinnedArgs` of
  `DATGOLD-HUB/lib/proof/git-plumbing.mjs`). A checked-out file is its blob byte for byte, and the diff records the bytes on disk. A
  repository whose tests rely on CRLF checkouts gets LF files here, on every system alike.
- On Windows `core.fileMode` and `core.symlinks` are off: the modes of the base (an executable bit, a link) are kept from the base
  tree, and an agent cannot change them. Elsewhere both are on, and an agent's `chmod` is part of its diff.

## The profile: no copied credentials

"No copied credentials" means: **no file of the real profile is copied or read, no variable is inherited unless it is on a short
allow-list, and the only credentials the agent gets are the ones the caller names in `agent.credentials`.** The profile folders start
empty but for two files the tools write.

**Set by the sandbox** (every run, every platform):

| Variable | Value |
|---|---|
| `HOME`, `USERPROFILE` | `h/home` |
| `APPDATA` | `h/appdata` |
| `LOCALAPPDATA` | `h/local` |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | `h/config`, `h/data`, `h/cache`, `h/state` |
| `CODEX_HOME` | `h/codex` |
| `CLAUDE_CONFIG_DIR` | `h/claude` |
| `TEMP`, `TMP`, `TMPDIR` | `h/tmp` |
| `GIT_CONFIG_GLOBAL` | `h/home/.gitconfig`, written by the tools: the identity `DatGold Corpus Agent <agent@corpus.datgold.invalid>`, `core.autocrlf = false`, `init.defaultBranch = main` and an empty `credential.helper` (no helper) |
| `GIT_CONFIG_NOSYSTEM` | `1`: the system Git configuration, where Git for Windows names the Git Credential Manager, is not read |
| `GIT_TERMINAL_PROMPT` | `0` |
| `GCM_INTERACTIVE` | `never` |
| `GIT_CEILING_DIRECTORIES` | the run folder: Git never finds a repository above the run (a root inside a repository stays out of reach of a bare `git` call in `w/`) |

**Inherited** from the environment the tools were started in (`env` option, default `process.env`), after `scrubEnv` dropped every
credential-looking name and every value holding a URL with a password. On Windows (names compared without case): `PATH`, `PATHEXT`,
`SYSTEMROOT`, `SYSTEMDRIVE`, `WINDIR`, `COMSPEC`, `OS`, `PROCESSOR_ARCHITECTURE`, `PROCESSOR_IDENTIFIER`, `PROCESSOR_LEVEL`,
`PROCESSOR_REVISION`, `NUMBER_OF_PROCESSORS`, `PROGRAMFILES`, `PROGRAMFILES(X86)`, `PROGRAMW6432`, `COMMONPROGRAMFILES`,
`COMMONPROGRAMFILES(X86)`, `COMMONPROGRAMW6432`, `USERNAME`, `LANG`, `TZ`, `TERM`. Elsewhere: `PATH`, `LANG`, `LANGUAGE`, `LC_ALL`,
`LC_CTYPE`, `LC_MESSAGES`, `TZ`, `TERM`, `USER`, `LOGNAME`, `SHELL`.

**Left out**: everything else. In particular every API key and token (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`,
`NPM_TOKEN`, cloud keys), `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, `GIT_ASKPASS`, `SSH_ASKPASS` (which the Hub's own shell keeps), every `GIT_*`
variable (`GIT_CONFIG_COUNT` and its pairs carry `http.extraheader` credentials in CI), `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`
(the desktop keyring), `HOMEDRIVE` and `HOMEPATH` (they name the real profile; programs fall back to `USERPROFILE`), `PROGRAMDATA`
(machine-wide configuration, Git's `C:\ProgramData\Git\config` among it), `PSModulePath`, `NODE_OPTIONS`, proxies, `KUBECONFIG`,
`DOCKER_CONFIG`, `GOOGLE_APPLICATION_CREDENTIALS`, `AWS_*`, and the real `HOME`, `APPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and XDG
folders. A tool that needs one of them for a task gets it through `extraEnv`, named in the run.

**Given by the caller**, never found by the tools:

- `agent.credentials` (`{NAME: value}`): the agent's own credential, for instance the API key of its vendor. It reaches the agent's
  environment only, never setup or the checks; the run records its name, never its value.
- `agent.env`: other variables of the agent (a vendor CLI's settings). Agent only.
- `extraEnv`: variables for setup, the checks and the agent, for instance a pinned package cache (`npm_config_cache`, `PIP_CACHE_DIR`).
- `agent.seed` (`{"claude/settings.json": text}`): files written into the profile, relative to `h/`, for a vendor CLI's non-secret
  settings.

None of these may name a variable of the table above (`bad_agent_env`), and a seed path must stay inside the profile (`bad_seed_path`).
The Windows Credential Manager, DPAPI, the macOS keychain and an SSH agent are reached by a program through system calls, not through
the environment: a process of the same user can still reach them, which is why the runs belong on a dedicated machine.

## Process trees

On POSIX the agent leads its own process group; on Windows it is an ordinary child. At the wall limit or on cancel its tree is
killed with `killTree` (`DATGOLD-HUB/lib/shell-runner.mjs`: `taskkill /T /F` on Windows, `SIGKILL` to the process group on POSIX). After
the agent exits, and after every setup command and check, what they left behind is reaped before the tree is read or the folder removed:

- POSIX: the process group of each started process is sent `SIGKILL`.
- Windows: the process table is read (`Get-CimInstance Win32_Process`) and every process whose parent chain leads to a process the tools
  started is killed with its tree, a few rounds; a pid is only trusted together with its creation time (`processTreeLeft` of
  `DATGOLD-HUB/lib/studio-terminal.mjs`), because Windows keeps the parent pid of an orphan and pids are reused. (A child that a Node
  program starts without `detached` is in Node's job object and dies with Node on its own; the sweep is for the rest: a detached child,
  or one started by a program that is not Node.)

`cleanup.leftovers` lists the pids still alive after the last round (`null` when the process table could not be read). Not reached: on
POSIX, a process that left the group (`setsid`); on Windows, a process whose parent **and** grandparent exited before the table was read
(the chain is broken), and one that a service or the task scheduler started for the agent. None of this is an operating-system
container; a Windows job object or a POSIX subreaper is not used.

## Cleanup

The run folder is removed in a `finally` after every run and every scoring, also after a refusal or an exception: `fs.rm` with retries,
for the read-only pack files of Git and for a folder a dying process still held. `cleanup: {removed, error?, leftovers}` says what
happened; a thrown `SandboxError` carries the same `cleanup`. If the tools themselves are killed, their run folder stays: delete the
`<8 hex>` folders under the root by hand when no run is active.

## Scoring

`scoreCheckout({task, gitSource, root, patch, hiddenArchive, runs, setup, extraEnv, env, signal})` never reads the run's folder (it is gone),
anything the agent wrote outside its diff, or the part of its diff outside the task's `allowed_paths`:

1. The hidden test archive is read from `hiddenArchive` (a private folder, never the corpus) and must have the sha256 the task registered
   (`hidden_archive_missing`, `hidden_archive_mismatch`); it is read by the strict reader (`hidden_archive_invalid`).
2. A new run folder, the base from the task's own source and its baseline commit, checked out into `w/`: the same steps as a run.
3. **The agent's diff** is applied with `git apply --index --binary`. A diff that does not apply is the **outcome
   `patch_does_not_apply`**: `hidden_pass` is false and nothing is installed or run. A diff written by `run-sandbox.mjs` was checked to
   apply to the base tree, so this outcome means the diff was changed after the run, made on another base, or is not a diff at all (`git
   apply` also refuses a path into `.git` and a path through a link). The scoring ([SCORING.md](SCORING.md)) reports it as a scoring error,
   apart from the agent's failures, and never as a pass.
4. **Only the part of the diff inside `allowed_paths` is scored.** Every path the diff added, modified or deleted that no entry of the
   task's `allowed_paths` matches is put back to the base (an added file removed, a modified or deleted one restored, index and file)
   before anything runs, and listed in `outOfScope` as `{path, change: added | modified | deleted}` in code-unit order, for the
   `out_of_scope` metric ([SCORING.md](SCORING.md)). The entries are matched as the Hub matches `protected` globs (`globMatches` of
   `DATGOLD-HUB/lib/glob-match.mjs` in path mode: `src/**` is everything under `src/`, a plain `src` is that one path). Without this, a
   diff could change the harness that judges it: the setup script, a package script a check runs (`npm test`), a public test, a
   `conftest.py`, a Makefile; the clean install could then write an ignored file, which reopens the hole the clean room closes. A diff
   whose every change is out of scope scores like the null diff. `patchSha256` stays the hash of the whole diff as given. **A task that
   lists a package manifest, a lockfile, a build file or a test folder in `allowed_paths` accepts that setup and the checks run the
   agent's version of it**; the task's author decides that per task.
5. **The clean install**: the task's setup commands in the fresh checkout, with the setup environment (no credential). A failing command is
   the outcome `setup_failed`, `hidden_pass` false; the agent's diff may have broken the lockfile.
6. **The hidden tests are copied in**, file by file, at their archive paths. Whatever the diff put at one of those paths, or where one
   needs a folder (a file, a link), is removed first and listed in `overwritten`: the hidden tests always win, and nothing is written
   through a link. (Outside `allowed_paths` such a file was already put back in step 4; this step matters for a task whose
   `allowed_paths` cover the tests.)
7. **The checks**: every check of the task's acceptance file, read from the corpus copy loaded by `loadTask` (never from the checkout),
   with its `cwd`, `timeout`, `expect.exit` and `repeat`, `runs` times (default: the protocol's `hidden_test_runs`, 3), in the same
   checkout. The hidden archive must put its tests where those commands find them (`node --test` finds `test/hidden/*.test.mjs`); a task
   without a runnable check is refused (`no_checks`).

The outcome: `pass` when every run passes (then `hidden_pass` is true), `fail` when none does, `flaky` when some do (not a pass; the
protocol reports it as flaky), `patch_does_not_apply`, `setup_failed`. The score: `{format: "datgold.corpus-score/1", taskId, baseTree,
baseCommit, patchSha256, patchBytes, hiddenSha256, outcome, hiddenPass, passes, requiredRuns, runs: [{run, pass, checks: [...]}],
setup, applyError, outOfScope, overwritten, cleanup}`.

**Offline.** The tools never fetch. A real task's setup (`npm ci`, `pip install -r`) needs its packages: the plan's answer to network
and drift is pinned caches, passed through `extraEnv` (`npm_config_cache` with `npm ci --offline`, a wheel folder with `pip install
--no-index --find-links`), filled once on the dedicated machine. The tests use a fixture task with no dependency whose "install" copies a
lockfile into `node_modules/`.

## Archives

`tools/tar.mjs` reads the repository tarball of a task and the hidden test archive in memory: ustar with the POSIX or GNU magic, the
prefix field, GNU long names (`L`) and pax `path` records, gzip when the bytes start with its magic. Regular files and folders only; the
executable bit is kept (`100755`), every other mode bit is not. Refusals, each a `TarError` with a code: `bad_gzip`, `truncated` (also an
archive without its end blocks), `bad_checksum`, `not_ustar`, `unsupported_entry` (a link, device, FIFO or other special entry),
`bad_pax`, `unsafe_path` (empty, absolute, a `.`, `..` or empty part, a backslash, a drive or any `:`, a character Windows refuses, a
`.git` or `git~1` part, a Windows device name, a part ending with a dot or a space, a control or hidden character, a name that is not
UTF-8), `duplicate_path` (compared without case, as on Windows), `path_conflict` (a file under a file), `empty_archive`, `too_large`
(20,000 entries, 512 MiB). A root folder entry `./` is skipped.

## Refusals

A refusal is a `SandboxError` with a code and, after the run folder exists, the `cleanup` record:

| Code | When |
|---|---|
| `bad_argument` | not a loaded task, a relative root, a wall limit outside 1 to 14400 seconds, a bad agent, setup list, patch or run count |
| `bad_agent_env` | a variable of `agent.credentials`, `agent.env` or `extraEnv` with a bad name, a value that is not text, or a profile variable's name |
| `bad_seed_path` | a seed path outside the profile, or content that is not text or bytes |
| `git_too_old` | Git older than 2.42 |
| `git_failed` | a Git command of the tools failed |
| `git_source_required` | a Git task without a local source |
| `base_missing` | the local source does not hold the task's commit |
| `tarball_mismatch` | the tarball's sha256 is not the one in `task.yml` (it changed after the task was loaded) |
| `tarball_invalid` | the tarball was refused by the reader (`tarCode` names why) |
| `path_too_long` | the path budget |
| `setup_failed` | a setup command failed before the agent (a run; in scoring this is the outcome `setup_failed`) |
| `setup_changed_tree` | setup changed a path Git does not ignore |
| `agent_failed_to_start` | the agent's program could not be started |
| `patch_not_reproducible` | the agent's diff does not turn the base tree into the final tree |
| `cancelled` | the signal was aborted before the agent started, or during scoring |
| `hidden_archive_missing`, `hidden_archive_mismatch`, `hidden_archive_invalid` | the hidden test archive |
| `no_checks` | the acceptance file has no runnable check |

## Command lines

```bash
node corpus/tools/run-sandbox.mjs --task <task dir> --git-source <local repo> --patch-out <file> [--root <dir>] [--wall-seconds <n>] [--credential <NAME>]... -- <program> [arguments...]
node corpus/tools/score-checkout.mjs --task <task dir> --git-source <local repo> --hidden <archive> --patch <file> [--root <dir>] [--runs <n>]
```

`run-sandbox.mjs` writes the diff to `--patch-out` and prints the run as JSON without it; `--credential NAME` passes the variable `NAME` of
its own environment to the agent as a credential. Exit 0 when the run finished (whatever the agent did), 2 for a usage error, 3 for a
refusal. `score-checkout.mjs` prints the score; exit 0 for `pass`, 1 for any other outcome, 2 and 3 as above. The oracle control of a task
is `score-checkout.mjs --patch <task dir>/oracle.patch`, the null agent's is an empty patch file.

## Tests

`DATGOLD-HUB/tests/verify-corpus-sandbox.mjs` (run by `tests/run-all.mjs` and CI on Windows and Linux) builds a fixture task in a temporary
folder (a Git source and a tarball twin, a hidden archive, a lockfile "install") and runs scripted agents, no model: the null agent fails
and the oracle passes 3 of 3 through the whole checkout path; an agent that solves the task in a Git-ignored path passes the public tests
in its own tree and still scores like the null agent; a diff that changes the setup script, a public test, package.json or the
lockfile outside `allowed_paths` has those changes put back and listed (a diff with nothing else scores like the null agent); a diff
that writes a hidden test's path is overwritten; a real profile full of fake
credentials (files and variables) reaches neither the agent nor setup; the wall limit, a cancel and a child left behind after the agent
exits are killed; every refusal leaves the root empty; diffs that do not apply; the path budget with a 152-character path; the tar
reader's refusals; the command lines; this page. `DATGOLD-HUB/tests/mutation/corpus-sandbox.json` breaks the tools one change at a time
(`node tests/mutation/run-mutations.mjs tests/mutation/corpus-sandbox.json` from `DATGOLD-HUB`).

## Limits and what is not verified

- No vendor CLI (Claude Code, Codex, ...) has been run through the sandbox, and no model: pod-37 writes the adapters, and live runs are the
  owner's call. Whether a vendor CLI accepts a fresh `CLAUDE_CONFIG_DIR` or `CODEX_HOME` with a key in its environment is not checked here.
- No real dependency install has run in a scoring checkout; the pinned-cache recipes above are not tested.
- macOS has not run the suite.
- The baseline commit gives the agent no upstream history; an agent that reads `git log` sees one commit.
