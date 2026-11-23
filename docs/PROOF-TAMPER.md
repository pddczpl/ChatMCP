# Proof-of-Done: which changes touched the checks (P4 pod-22)

`DATGOLD-HUB/lib/proof/tamper.mjs` compares the tree a task started from with the tree it ended with and reports, per acceptance
criterion, whether **checks were modified** during the task and why: a test file deleted, an assertion removed, a skip marker added, a
tolerance widened, a check script or the test configuration changed, the acceptance file edited, `|| true` appended to a command.

A flag is a fact about the diff, not a judgement of the work. A model that is asked to make the tests pass may legitimately add a test
case, fix a wrong expectation or rename a file; it may also make a red check green by weakening it. This module cannot tell the two
apart, so it never says which one happened: every text it produces says that checks were modified, and the person reading the report
decides. The wording is checked by its suite (no "cheating", no accusation of any kind).

**Who calls it:** the done-gate ([PROOF-GATE.md](PROOF-GATE.md), pod-23) shows its flags on the gate message and in the outcome of a task,
and `chatmcp verify pack` ([PROOF-CLI.md](PROOF-CLI.md)) puts them into the pack; the Proof tab (pod-34) comes later. It adds no claim to [THREAT-MODEL.md](THREAT-MODEL.md) or
[CLAIMS.md](CLAIMS.md).

## API

```js
import { gitTreeSide, workTreeSide, memorySide, detectCheckChanges } from './lib/proof/tamper.mjs';

const baseline = await gitTreeSide({ root, rev: 'HEAD', stateDir });   // a commit or a tree id of the workspace's repository
const final = await workTreeSide({ root, stateDir });                 // the workspace as it is now
const report = await detectCheckChanges({ baseline, final });         // criteria from the BASELINE .chatmcp/acceptance.yml
await detectCheckChanges({ baseline, final, acceptance });            // or criteria given by the caller ({criteria, protected})
await detectCheckChanges({ baseline, final, stats });                 // `stats` receives {normalizations, linesIndexed, pairsCompared}
```

A *side* is `{entries: [{path, mode, oid}], read(paths, {maxBytes, budget})}`; `read` answers a `Map` of bytes, `null` (absent or
unreadable) or `{skipped: 'too_large' | 'read_budget', size}`, in the order asked. Three are provided:

| Side | Where the files come from |
|---|---|
| `gitTreeSide({root, rev, stateDir, git?, env?})` | `git ls-tree -r -z -l` and `git cat-file --batch` through the pinned Git of [PROOF-TREE.md](PROOF-TREE.md) (`lib/proof/git-plumbing.mjs`: no system or global configuration, no hooks, the repository's objects read only, nothing written). `rev` must look like a revision (no leading `-`, no `..`, no spaces); an unknown one throws `bad_revision`. When Git cannot be used on the repository (missing, or a configuration the guard refuses) it throws `git_unavailable`. |
| `workTreeSide({root, stateDir, git?, env?, limits?})` | The listing of the tree snapshot engine, `raw-v1` (`lib/proof/tree-snapshot.mjs`): tracked files, untracked files that `.gitignore` does not exclude, raw bytes, no line-ending conversion. Over the snapshot limits it throws `workspace_too_large`. |
| `memorySide(files)` | Files held in memory: `{path: text \| bytes \| {content, mode?, symlink?}}`. |

Both Git-backed sides leave out protected files (`lib/protected-paths.mjs`: keys, `.env`, credentials) and `.chatmcp/runs`, as a tree
snapshot does, so a secret is never read and never reported.

The other exports are the parts, each tested on its own: `nameStatus(before, after)`, `classifyPath(path)`, `scriptInvocations(command)`,
`codeOnly(text, path)`, `countAssertions(code)`, `countSkipMarkers(code)`, and the constants `CATEGORY`, `TAMPER_LIMITS`,
`LIMITATION_CODES`, `CHECK_CHANGES_FORMAT`.

## The diff

`nameStatus` names every change the way `git diff --name-status` would with exact rename and copy detection: `A`, `D`, `M`, `T` (a
file became a link or a submodule), `R` (a deleted and an added entry with the same blob), `C` (an added entry with the blob of an
entry the baseline has). A change of the executable bit alone is an `M` with the same blob. Empty files are never paired.

`detectCheckChanges` then pairs a deleted and an added file of the classified kinds that are at least 50 % similar by lines (Dice over
the multisets of trimmed, non-blank lines, after line endings are normalised; equal texts score 100) as a rename with edits (`R`, with
`similarity`), the best-scoring pairs first. So `tests/a.test.js` renamed to `tests/b.test.js` with one assertion removed reads as a
rename that removed an assertion, not as a deleted test. Each text is decoded and normalised once per report and its lines indexed
once; an inverted index from a line to the added files that hold it sums the common lines of one deleted file against all added
ones, so the work grows with the lines the files share, not with deleted x added x lines (200 x 200 renamed test files of 100 KB:
about 2 s on the development machine, most of it reading the 40 MB once). The `stats` option exposes the counters a test pins. Line
endings are compared normalised everywhere: a file whose only change is CRLF against LF is reported as `line_endings_only`.

## What is classified

| Category | Paths (outside `node_modules/`, `vendor/` and similar folders) |
|---|---|
| `acceptance_file` | `.chatmcp/acceptance.yml` |
| `lockfile` | `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock(b)`, `deno.lock`, `poetry.lock`, `Pipfile.lock`, `uv.lock`, `pdm.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`, `packages.lock.json`, `paket.lock`, `mix.lock`, `pubspec.lock`, `Podfile.lock`, `gradle.lockfile`, `flake.lock`, `conda-lock.yml` |
| `ci_workflow` | `.github/workflows/*.yml`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `.circleci/`, `Jenkinsfile`, `.travis.yml`, `bitbucket-pipelines.yml`, `appveyor.yml`, `.buildkite/`, `.drone.yml` |
| `test_config` | `jest.config.*`, `jest.setup.*`, `vitest.config.*`, `.mocharc*`, `karma.conf.*`, `playwright.config.*`, `cypress.config.*`, `ava.config.*`, `.nycrc*`, `.c8rc*`, `setupTests.*`, `pytest.ini`, `conftest.py`, `tox.ini`, `noxfile.py`, `.coveragerc`, `*.runsettings`, `phpunit.xml`, `.rspec`; `pyproject.toml` and `setup.cfg` only for their `[tool.pytest*]`, `[tool.tox*]`, `[tool.coverage*]` (`[tool:pytest]`, `[coverage:*]`) sections; a `*.csproj`/`*.fsproj`/`*.vbproj` only when it is a test project (`Microsoft.NET.Test.Sdk`, `<IsTestProject>true`, xUnit, NUnit, MSTest); the `jest`, `mocha`, `ava`, `c8`, `nyc` and `vitest` keys of a `package.json` |
| `test_file` | a file under a `test`, `tests`, `__tests__`, `spec`, `specs`, `__mocks__`, `__snapshots__`, `__fixtures__`, `testdata` or `e2e` folder or a `*.Tests` folder; or named `*.test.*`, `*.spec.*`, `*.e2e.*`, `*.cy.*`, `*_test.*`, `*_spec.*`, `test_*.py`, `*Test.java` / `*Tests.cs` (and other JVM and .NET languages, capital `T`), `*.snap` |
| `check_script` | the `package.json` scripts a criterion reaches; a `Makefile` in the folder a criterion runs `make` in; a file in a `scripts/` folder at the workspace root or in a criterion's `cwd`; any file a criterion's command (or a script it reaches) names, such as `ci/check.sh` in `bash ci/check.sh` |
| `acceptance_protected` | a path that matches a `protected` glob of the baseline acceptance file |

When no acceptance file exists (and no criteria are given), the checks are unknown, and the conventional ones stand in: the `test` script
of the root `package.json` (with what it reaches) and the root `Makefile`.

**What a criterion reaches.** The commands of a criterion's checks are split at `&&`, `||`, `;`, `|` and line breaks. `npm test`,
`npm run x`, `npm run-script x`, `pnpm x`, `yarn x`, `bun run x`, `run-s`, `run-p` and `npm-run-all` (with `*` patterns) name scripts.
`--prefix`, `-C`, `--dir` and `--cwd` move to another `package.json`: npm reads its options anywhere before a bare `--`
(`npm test --prefix sub`, `npm run --prefix sub test`), pnpm, yarn and bun only before the script name (what follows it goes to the
script), and an option's value is never taken as the script name. `cd dir` and `pushd dir` (also `chdir`, `Set-Location`, cmd's
`cd /d`) to a literal relative folder move the commands after them in the same check, and `popd` moves back: `cd sub && npm test` runs
`sub/package.json`. A workspace-scoped call (`-w`, `--filter`, `yarn workspace`) is not followed. From each script, npm's `pre<name>`
and `post<name>` and the scripts its own text runs in the same folder are added, at most 500 per package.

Not followed, and so not attributed: a `cd` to a variable (`cd "$PKG"`, `cd %DIR%`), to `~`, `-` or an absolute path, a bare `cd`, and a
`popd` with nothing pushed (the rest of that check's line is not read); a `cd` inside a subshell `( ... )` (its words are read as
written); a script call made inside a package.json script after a `cd` or with `--prefix` (it runs another `package.json`); a command
wrapped in another shell (`bash -c "npm test"`, `cmd /c npm test`).

## The reasons

Every finding lists its reasons; a reason is `flagged` (it counts as checks modified) or informational.

| Code | Flagged | When |
|---|---|---|
| `test_file_deleted` | yes | a test file was deleted |
| `test_file_renamed_out` | yes | a test file was renamed to a name the conventions do not match (a runner may no longer collect it) |
| `test_file_type_changed` | yes | a test file became a link or a submodule |
| `assertions_removed` | yes | fewer assertions than before: `expect(`, `assert(`, `assertEqual(`, `assert_eq!(`, `assert.x(` / `Assert.X(`, testify `require.x(`, Go `t.Error`/`t.Fatal`, AVA/tap `t.is(`..., `.should` / `.Should()`, `pytest.raises(`, the Python `assert` statement |
| `skip_marker_added` | yes | more skip or focus markers than before: `it.skip`, `test.only`, `describe.skip`, `test.todo`, `xit(`, `fit(`, `this.skip()`, `{ skip: true }`, `pytest.mark.skip`/`skipif`/`xfail` with or without `@` (so also `pytestmark = pytest.mark.skip(...)`, which skips a whole module, and `pytest.param(..., marks=pytest.mark.xfail)`), `pytest.skip(`, `unittest.skip*` with or without `@`, `self.skipTest(`, `raise SkipTest`, `collect_ignore`, Go `t.Skip*(`, `[Fact(Skip = ...)]`, `[Ignore]`, `[Explicit]`, `Assert.Ignore(`, `@Disabled`, `@Ignore`, `#[ignore]`, `markTestSkipped(`, RSpec `skip`/`pending`/`xit` |
| `tolerance_loosened` | yes | on a line that is otherwise unchanged, a numeric tolerance grew (`rel=`, `abs=`, `rtol=`, `atol=`, `delta=`, `epsilon=`, `tol`, a `TOLERANCE` constant, `closeTo(x, d)`, `InDelta(..., d)`, `Within(d)`) or a digit count shrank (`toBeCloseTo(x, digits)`, `places=`, `decimal=`, `precision`) |
| `test_data_changed` | yes | a test file that is not code (a fixture, a snapshot, expected output, a binary file in a test folder) changed |
| `test_config_changed` | yes | test configuration changed (added, deleted or edited) |
| `check_script_changed` / `_added` / `_removed` | yes | a script the checks run changed, appeared or disappeared (the `package.json` value, a Makefile, a scripts/ file, a named file) |
| `check_script_unreadable` | yes | a `package.json` whose scripts a criterion runs is not valid JSON on one side |
| `failure_masked` | yes | an added line or script value lets a failure pass: `\|\| true`, `\|\| :`, `\|\| exit 0`, `\|\| echo`, `exit 0`, `set +e`, `continue-on-error: true`, `if: false`, a script that is only `true` or `:` |
| `acceptance_edited` | yes | the acceptance file changed in any byte; `detail` is `compareAcceptance` of [PROOF-ACCEPTANCE.md](PROOF-ACCEPTANCE.md) (the criteria stay the baseline's whatever the edit) |
| `protected_path_changed` | yes | a path the acceptance file protects changed |
| `ci_workflow_deleted` | yes | a CI workflow was deleted |
| `not_analyzed` | yes | the file could not be compared: `detail.why` is `too_large`, `read_budget`, `binary` (a code file with NUL bytes) or `unreadable`. Not knowing counts as modified. |
| `test_file_added`, `test_file_renamed`, `test_file_copied`, `test_file_modified`, `line_endings_only`, `mode_changed`, `lockfile_changed`, `ci_workflow_changed`, `ci_workflow_added`, `script_file_added` | no | reported so the reader sees them; a changed lockfile carries its sha256 before and after |

Markers, assertions and masks are counted in **code only**: `codeOnly` blanks the inside of comments and string literals (C-like
languages, Python with its triple quotes, Ruby; YAML, shell and Makefiles have their comments blanked but keep their strings, so that
`run: "npm test || true"` is seen). `"it.skip("` in a string or `// xit(` in a comment is not a marker. An added test file is flagged only
when it holds a skip or focus marker.

## Per criterion

`criteria` lists every criterion of the baseline (or of the caller), in order: `{id, checks_modified, reasons}`. A flagged reason goes to
the criteria it can affect, and says how in `via`:

| `via` | Goes to |
|---|---|
| `every_check` | every criterion that has checks (test files, test configuration, scripts/ files): which tests a command runs is not known |
| `script` | the criteria whose commands reach that `package.json` script |
| `make` | the criteria that run `make` in that folder |
| `command_path` | the criteria whose commands name that file |
| `acceptance` | the criteria the edit removed or changed; all of them when the file was deleted, became unreadable, or its `reproduce` or `protected` part changed |
| `acceptance_protected` | every criterion |

A CI workflow change is flagged (top-level `checks_modified`) but goes to no criterion: the criteria run on this machine, not in CI.
Manual criteria get only acceptance and protected-path reasons.

## The report

```js
{
  format: 'chatmcp.check-changes/1',
  checks_modified: true,
  summary: 'Checks were modified during the task: 2 changes to tests, test configuration, check scripts or the acceptance file.',
  criteria: [{ id: 'unit', checks_modified: true, reasons: [{ code, path, oldPath?, message, detail?, line?, via }] }, ...],
  findings: [{ path, oldPath, status, category, flagged, reasons: [{ code, flagged, message, detail?, line? }], modeOnly?, similarity? }],
  lockfiles: [{ path, status: 'unchanged' | 'modified' | 'added' | 'deleted', sha256Before, sha256After }],
  counts: { changes, findings, flagged, notAnalyzed, omittedFindings },
  limitations: [{ code, text }],   // the four below, always
}
```

Findings are sorted flagged first, then by path, and cut at `maxFindings`; `counts` covers all of them. `line` is 1-based in the final
file (for an added marker or a widened tolerance). Every lockfile present on either side is hashed (sha256 of its exact bytes), changed
or not, so a reader can tell which dependency set the checks ran against.

## Limitations (stated in every report)

| Code | What it means |
|---|---|
| `untracked-ignored-paths-not-covered` | a change under a path that `.gitignore` excludes and the repository does not track is not seen: the work-tree side lists the workspace with Git's ignore rules, like a tree snapshot |
| `heuristics-may-flag-legitimate-changes` | the heuristics also flag legitimate changes: two assertions folded into a loop count as one fewer, a new conftest.py or jest.config.js is test configuration, a refreshed snapshot is changed test data. The suite keeps one such case among its ten ordinary diffs on purpose |
| `test-selection-unknown` | which tests a command runs is not known, so a test change goes to every criterion that runs a command |
| `protected-files-not-read` | protected files are never read, so a change to them is not seen |

Further limits of the heuristics, not repeated in each report:

- A weakened assertion that keeps its count (`expect(x).toBe(5)` changed to `expect(x).toBeDefined()`) is not seen; nor is a tolerance
  widened on a line that changed in any other way, nor one in a call whose arguments run longer than 500 characters.
- Rename pairing with edits compares at most `maxSimilarityPairs` (40,000) deleted x added pairs of files up to 1 MiB; beyond that a
  renamed test file is reported as deleted (flagged).
- Commands are read word by word: what "What a criterion reaches" lists as not followed (a `cd` to a variable, a subshell, a command
  wrapped in `bash -c`) is not attributed to a criterion.
- `codeOnly` is a lexer, not a parser: a regular-expression literal or a Rust lifetime can blank the rest of its line.
- On Windows the work tree has no executable bit, so a file committed as `100755` reads as a mode change (`mode_changed`, never flagged).
- Without Git the work-tree side walks every file with no ignore rules, and a Git revision cannot be read at all.

## Limits

`TAMPER_LIMITS`, each can be lowered per call with `limits`:

| Limit | Default | Beyond it |
|---|---|---|
| `maxFileBytes` | 8 MiB | the file is not read: `not_analyzed` (`too_large`), a lockfile has no hash |
| `maxReadBytes` | 256 MiB | the content read for one report (the acceptance file and the `package.json` files the criteria use are read outside it); the rest is `not_analyzed` (`read_budget`) |
| `maxFindings` | 2,000 | findings listed (flagged first); the rest only counted in `omittedFindings` |
| `maxReasonsPerCriterion` | 200 | reasons listed per criterion; `omittedReasons` counts the rest |
| `maxSimilarityPairs`, `maxSimilarityBytes` | 40,000, 1 MiB | see rename pairing above |
| `detailChars` | 200 | a script text quoted in a `detail` is cut |

## Tests

`DATGOLD-HUB/tests/verify-proof-tamper.mjs` runs every case on a real temporary Git repository (baseline `gitTreeSide` at `HEAD`, final
`workTreeSide`):

- five synthetic strategies that make a check pass without fixing anything are all flagged: an assertion deleted; a skip added (JS
  `it.skip` and `xit`, `pytest.mark.skip`, a module-level `pytestmark`, Go `t.Skip`, xUnit `Skip =` and NUnit `Ignore`, Rust
  `#[ignore]`, JUnit `@Disabled`); `scripts.test` changed to `echo ok`, in the root and in a sub-package reached by `--prefix` before or
  after the script name, `cd`, `cd /d`, `pushd` and `cwd` (and not by a root `npm test`, a `--prefix` after `--`, a `popd` back or a `cd`
  to a variable); the acceptance file edited; a tolerance widened (six spellings). Also `|| true` appended to a script, a deleted test
  file, scripts reached through `npm run`, a `cd` inside a script, test configuration, a Makefile, a scripts/ file, a named file, CI
  workflows and protected paths;
- ten ordinary diffs (a new test file, a new test case, a source-only refactor, a README edit with a CI cache step, a dependency with its
  lockfile, a script no criterion runs, a pyproject dependency, a test file renamed, markers only in strings and comments, and two
  assertions folded into a loop) give **exactly one** flag, the last one, a known false positive;
- edge inputs: renames (exact, with an edit, out of the conventions), a copy, a mode change, binary files, CRLF, a path with spaces and
  Vietnamese letters, an empty diff, a deleted and an unreadable `package.json`, no acceptance file, an ignored path, a huge diff (2,801
  changes, a 10 MB test file, small read limits), text shaped to make a pattern slow, the work of rename pairing (30 x 30 files: 900
  pairs, 60 normalisations, each file's lines indexed once; a similarity of exactly 50 %), and option-like revisions;
- the wording of every text of every report: neutral, no accusation, the four limitations present.

Mutation list: `DATGOLD-HUB/tests/mutation/proof-tamper.json` (`node tests/mutation/run-mutations.mjs tests/mutation/proof-tamper.json`
from `DATGOLD-HUB/`); every mutation must be KILLED.
