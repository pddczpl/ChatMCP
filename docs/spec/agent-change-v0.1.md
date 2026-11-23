# The agent-change predicate, version 0.1

<!-- SPDX-License-Identifier: Apache-2.0 -->

This document specifies **version 0.1 of the agent-change predicate**: what a DatGold proof pack says about a change an AI coding agent
made to a workspace, and what is known about each acceptance criterion of the task. A proof pack is an
[in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) whose predicate is this one.

| | |
|---|---|
| `predicateType` | `https://github.com/pddczpl/ChatMCP/blob/main/docs/spec/agent-change-v0.1.md` (this file) |
| JSON Schema | [agent-change-v0.1.schema.json](agent-change-v0.1.schema.json) (draft 2020-12), `$id` `https://github.com/pddczpl/ChatMCP/blob/main/docs/spec/agent-change-v0.1.schema.json` |
| Code | `DATGOLD-HUB/lib/proof/pack.mjs` (builder, canonical JSON, validation), `DATGOLD-HUB/lib/proof/schema-validate.mjs` (the schema validator) |
| License | Apache-2.0, like the rest of the DatGold repository |

**Version 0.1 is a first draft.** The predicate is versioned by its `predicateType`; its fields will change after outside feedback, and a
changed predicate gets a new version and a new type URL. Nothing here is final.

**Not wired yet.** Nothing in the agent or the Hub calls the builder today. Later plan tasks build on it: pod-30 renders a pack as
Markdown and HTML, pod-31 adds cost per criterion, pod-32 verifies a pack (check and reproduce; the pack file that carries a statement
with the patch, the ledger and the acceptance file it names is described in [PROOF-CLI.md](../PROOF-CLI.md), "The pack file"), and pod-33 stores packs in the Hub and
calls the builder at the end of a task. Until pod-33 lands, a pack exists only when code builds one.

**Unsigned.** A v0.1 statement is not signed and not wrapped in a DSSE envelope; signing (DSSE) comes in a later version. Its canonical
digest (below) names a statement, it does not say who made it.

**Integrity level `unconfined`.** The agent runs as the same Windows user as the Hub. It can rewrite the workspace, the proof ledger and
the trust store, hashes included (see [PROOF-LEDGER.md](../PROOF-LEDGER.md) and [PROOF-ACCEPTANCE.md](../PROOF-ACCEPTANCE.md)), so a pack
records what the Hub observed; it is not a seal against the agent. A confined level needs the separated execution account, which a later
version will name.

## The statement

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    { "name": "workspace-tree-before", "digest": { "gitTree": "4b825dc642cb6eb9a060e54bf8d69288fbee4904" } },
    { "name": "workspace-tree-after", "digest": { "gitTree": "9c2f0b7a3d5e4f6a8b1c2d3e4f5a6b7c8d9e0f1a" } },
    { "name": "change.diff", "digest": { "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" } }
  ],
  "predicateType": "https://github.com/pddczpl/ChatMCP/blob/main/docs/spec/agent-change-v0.1.md",
  "predicate": { "agent": { "name": "DatGold", "version": "3.11.2" }, "criteria": [ ... ], "...": "..." }
}
```

### Subjects

| `name` | Digest | What it is |
|---|---|---|
| `workspace-tree-before` | `gitTree` | the workspace when the task started: the tree id of a pod-15 snapshot ([PROOF-TREE.md](../PROOF-TREE.md)) |
| `workspace-tree-after` | `gitTree` | the workspace when the pack was built (the "final tree" below) |
| `change.diff` | `sha256` | the exact bytes of the diff of the change, as the caller gives them (pod-33 will make it) |
| `git-commit` | `gitCommit` | optional: a Git commit of the change, when the caller gives one |

Each name occurs once; the first three always. The in-toto digest set defines `gitTree` as the id of a Git tree object; a workspace tree
is a tree object computed by the pod-15 engine over files that need not be in any repository, which the digest set allows. A tree id is
40 hex digits for the object format `sha1` and 64 for `sha256` (`predicate.trees.<side>.objectFormat`), lowercase. Two tree ids can be
compared only when their `treeAlgorithm` (`git-pinned-v1` or `raw-v1`) and object format are equal.

### Unknown fields and empty values

The in-toto parsing rules let a consumer ignore fields it does not know. **This predicate is closed**: the validator of this repository
refuses a field it does not know, at every level of the statement, the top level included (`additionalProperties`). A field it cannot
interpret is a field it cannot vouch for; a new field comes with a new version. Another consumer may still ignore unknown fields as
in-toto allows.

The in-toto rules also say that an unset, a null and an empty value mean the same. The predicate never gives them different meanings:
`null` is used only where "no value" is meant (no base commit, no model revision, a receipt without a tree), and an unknown cost is the
text `"unknown"`, never `null`.

## The predicate

| Field | Type | Meaning |
|---|---|---|
| `agent` | `{name, version}` | the agent that made the change, e.g. `DatGold` and its version |
| `model` | `{provider, id, profileRevision}` | the model and the revision of the agent profile it ran with; each text or `null` |
| `baseCommit` | Git id or `null` | the commit the task started from, when the workspace is a repository |
| `trees` | `{before, after}` | per tree: `treeAlgorithm`, `objectFormat`, `engineReason` (why the engine fell back to `raw-v1`, or `null`), `ignoreRules` (`git` or `none`), `files`, `bytes`, `limitations` (the pod-15 codes) |
| `excludedPaths` | `{classes, protected, runs, gitlinks}` | what the tree ids leave out: the classes `protected-files` (every path `lib/protected-paths.mjs` protects: keys, `.env`, credentials), `runs-folder` (`.chatmcp/runs`), `untracked-ignored-paths` (untracked paths `.gitignore` excludes, when `ignoreRules` is `git`), `nested-repository-content` (a nested repository is its commit only), and the counts the final snapshot reports |
| `lockfiles` | list | from the pod-22 report: `{path, status, sha256Before, sha256After}` for every lockfile on either side (status `unchanged`, `modified`, `added`, `deleted`); empty when there is no report |
| `acceptance` | `{baselineSha256, trusted, edited}` | the acceptance file of pod-20: the sha256 of its baseline bytes, whether the owner trusted that hash, whether it was edited during the task |
| `checkChanges` | `{reported, checksModified}` | whether a pod-22 report was given, and its top-level `checks_modified` |
| `criteria` | list | one per criterion of the **baseline** acceptance file, in its order (below) |
| `receipts` | list | check receipts of the ledger (below), in ledger order |
| `ledger` | object | `present`, `verified` (the whole chain verified), `records` and `lastHash` of the verified prefix, `brokenAt` and `reason` as `verifyChain` reports them, `checks` (check records in the prefix), `omittedReceipts`, `omittedUncertain` |
| `permissions` | counts | the `permission` records of the ledger: `records`, then one count per `decision` of the PermissionGate history (`approved`, `denied`, `expired`, `cancelled`, `blocked`, `policy`) and `other` |
| `uncertain` | list | the `uncertain` records of the ledger: `{seq, reason}`; a reason that is not a code (`[a-z0-9_]{1,64}`) reads `unspecified` |
| `cost` | `"unknown"` or `{currency, knownSubtotal, complete}` | the known cost: an ISO 4217 currency, a finite subtotal from 0 to 1e9, and whether it covers every call; `"unknown"` when nothing is known (pod-31 fills it per criterion later) |
| `integrity` | `{level, signed}` | always `{"level": "unconfined", "signed": false}` in v0.1 |
| `limitations` | list | `unsigned`, `integrity-unconfined`, `ledger-end-not-anchored`, and with a pod-22 report its four limitation codes |

### A criterion

| Field | Meaning |
|---|---|
| `id` | the criterion id of the acceptance file |
| `kind` | `checks` (proved by commands) or `manual` (a person looks) |
| `status` | `evidenced`, `owner_accepted`, `unverified`, `failed`, `stale` or `checks_modified` (below) |
| `checks` | per check of the criterion: `index`, `run` (the command, masked), `cwd`, `commandSha256` (sha256 of the UTF-8 bytes of the exact command), `expectExit`, `repeat`, `result`, `passes` (runs that passed on the final tree), `receipts` (ledger seqs) |
| `reasons` | `{code, check, detail}`: why the criterion has its status; `check` is the index of the check a reason is about, or `null` |
| `omittedReasons` | how many `checks_modified` reasons were left out (at most 64 reasons are listed) |

The criterion text of the acceptance file is not copied: a reader finds it in the file by `acceptance.baselineSha256`.

### A receipt

The fields of a pod-16 `check` record, reduced: `seq`, `hash` (the hash of its ledger line), `ts`, `command` (masked, at most 8,192
characters, `commandTruncated`), `commandSha256`, `argsSha256`, `cwd`, `shell`, `exit`, `signal`, `timedOut`, `cancelled`, `stdout` and
`stderr` as `{sha256, bytes, truncated}`, `treeBefore` and `treeAfter` as `{treeAlgorithm, objectFormat, tree}` or `null`, `toolchain`,
`durationMs`. **No output is included**, not even the 2 KiB preview the ledger keeps: the hashes and sizes only.

## Where each status comes from

The builder reads the outputs of the merged Proof-of-Done pieces and nothing else:

| Input | From | Used for |
|---|---|---|
| tree snapshots, before and after | pod-15, `TreeSnapshotter.snapshot()` | the tree subjects, `trees`, `excludedPaths`, the final tree every receipt is compared with |
| the ledger's bytes | pod-16, checked with `verifyChain` | `check` records (receipts), `permission` and `uncertain` records, the `ledger` summary; only the **verified prefix** is read |
| the acceptance result | pod-20, `resolveAcceptance` | the criteria and their checks (from the baseline file), `trusted`, `baselineSha256`, `edited` |
| the check-changes report | pod-22, `detectCheckChanges` | `checks_modified` per criterion and its reasons, `lockfiles`, the limitations |
| owner acceptances | the caller: `[{criterionId, treeAlgorithm, tree, by, at}]` | `owner_accepted`; the Proof tab (pod-34) will record them, today only code passes them |

### A check against the receipts

- A receipt **matches** a check when its `commandSha256` is the sha256 of the check's `run` and its `cwd` is the check's `cwd`, both
  written with `/`, without a leading `./` or a trailing `/`, the root being `.`.
- A matching receipt **started on the final tree** when its `treeBefore` has the final tree's `treeAlgorithm`, object format and id:
  the command ran on exactly the content the pack names. It **ended on the final tree** when its `treeAfter` has them too.
- A failure counts when its run started on the final tree, whatever the run did afterwards: it failed on exactly that content.
- A pass counts only when its run started **and** ended on the final tree. A command that changed the tree is no evidence that the
  tree passes, because what it checked is not what it left. Two cases show why counting it for the tree it started from was wrong:
  - a check that toggles a file runs T1→T0, T0→T1, T1→T0, ... When the final tree is T1, a run that started on T1 exited 0, yet the
    check never leaves T1 as it found it;
  - a formatter run as a check (`prettier --write`) fixes what it checks and exits 0. When a later check or step puts the unformatted
    file back, the final tree is the tree the formatter started from, and its exit 0 would claim a formatted tree that is not there.

  The check runner ([PROOF-CHECKS.md](../PROOF-CHECKS.md)) runs a check that changed the tree again on the new tree, so such a check
  can still be evidenced by a later run that leaves the tree unchanged.

> **Change, 2026-11-23, before any release:** a passing run must leave the final tree unchanged. Until then a passing run counted for
> the tree it started from even when it changed the tree. The fields and the schema are unchanged; `validateStatement` checks the new
> rule (`passed_receipt`, `stale_receipt` below).
- A run **passed** when `exit` equals the check's expected exit code, and it neither timed out, nor was cancelled, nor ended by a signal.

The `result` of a check, first match wins:

| `result` | When | Reason added |
|---|---|---|
| `failed` | a run that started on the final tree did not pass (also when another run passed: a check that fails on the same content is not evidence) | `check_failed`, detail `exit 1, expected 0`, `timed out`, `cancelled` or `ended by signal ...` |
| `passed` | at least `repeat` runs passed that started and ended on the final tree | none |
| `repeats_short` | some, fewer than `repeat`, such runs | `check_repeats_short`, detail `1 of 2 runs passed on the final tree` |
| `stale` | no run that counts, and a run on a tree of the final tree's algorithm and object format: another tree, or the final tree it changed | `check_stale`, detail `ran on tree ..., not the final tree` or `ran on the final tree but did not leave it as it found it` |
| `tree_unknown` | runs that cannot be compared with the final tree (no snapshot, another algorithm or object format) | `check_tree_unknown` |
| `not_run` | no matching receipt | `check_not_run` |

A check lists the seqs of the runs its result rests on, the latest ones (at most 10): the passes that count of a `passed` or
`repeats_short` check, the runs that started on the final tree of a `failed` check, the matching runs of any other. The run its reason
names is always listed, whatever the limit: the latest failing run of a `failed` check; for a `stale` check the latest run that started
on the final tree (and changed it), else the latest run on another tree of the same algorithm; when the limit left it out, it takes the
place of the oldest run listed. So the pack always holds the receipt a result
rests on, and the rules below can check it.

### The status of a criterion

The status follows from the listed facts, **first match wins**:

| Status | When |
|---|---|
| `owner_accepted` | the owner accepted the criterion for the final tree (same tree id and algorithm); the facts below stay in `reasons` |
| `failed` | a check's result is `failed` |
| `checks_modified` | the pod-22 report says checks were modified for this criterion (`checks_modified: true`); one `checks_modified` reason per finding, detail `<code> <path>` |
| `evidenced` | a criterion of kind `checks`, every check `passed`, and none of `acceptance_untrusted`, `check_changes_unknown`, `ledger_not_verified` |
| `stale` | a check is `stale`, or the owner accepted the criterion for another tree (`owner_accepted_other_tree`) |
| `unverified` | everything else |

**A missing input never gives `evidenced`.** Each one adds a reason to every criterion of kind `checks`, and that reason keeps it from
`evidenced`:

| Missing | Reason | Effect |
|---|---|---|
| the acceptance file is not trusted (`trusted` is false) | `acceptance_untrusted` | the owner has not approved what "done" means: at most `unverified` (a `failed` or `stale` check is still reported as such) |
| no pod-22 report, or no row for this criterion in it | `check_changes_unknown` | nobody looked at whether the checks were changed |
| no ledger, or a ledger whose chain does not verify (a changed byte, a torn last line ...) | `ledger_not_verified` | receipts of the verified prefix still count for `failed` and `stale`, never for `evidenced` |
| a manual criterion nobody accepted | `manual_not_accepted` | `unverified` |

With no acceptance file at all the pack has no criteria. Reasons are listed in this order: the owner's, the checks' (in check order),
`acceptance_untrusted`, `check_changes_unknown`, `ledger_not_verified`, `manual_not_accepted`, then the `checks_modified` ones; only
`checks_modified` reasons are ever left out (`omittedReasons`).

The reason codes, all of them: `owner_accepted`, `owner_accepted_other_tree`, `check_failed`, `check_repeats_short`, `check_stale`,
`check_tree_unknown`, `check_not_run`, `checks_modified`, `acceptance_untrusted`, `check_changes_unknown`, `ledger_not_verified`,
`manual_not_accepted`.

## Canonical JSON and the digest

`canonicalJson(statement)` is the text a digest is taken of, the JSON Canonicalization Scheme of **RFC 8785** for the values a
statement holds:

- **No white space** between tokens.
- **Object keys** sorted by their **UTF-16 code units** (what `Array.prototype.sort` does without a comparator), at every level; so
  `"\r"` < `"1"` < `"\u0080"` < `"ö"` < `"€"` < `"😀"` (U+D83D U+DE00) < `"דּ"` (U+FB33), although U+1F600 is above U+FB33 as a code point.
- **Numbers** as ECMAScript `Number.prototype.toString` writes them (RFC 8785 section 3.2.2.3): `4.50` is `4.5`, `2e-3` is `0.002`,
  `1E30` is `1e+30`, `-0` is `0`. Only finite numbers; integers in the predicate are safe integers (at most 2^53 - 1).
- **Strings** escaped as `JSON.stringify` escapes them: `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, every other character below U+0020 as
  `\u00xx` with lowercase hex, and nothing else (`/`, DEL and U+2028 stay as they are). **No Unicode normalisation**: `é` written as one
  code point and as `e` + U+0301 are two different texts with two digests. A lone surrogate has no UTF-8 form and is refused.
- **Refused**: `NaN`, `Infinity`, `undefined` (also as a field value), BigInt, functions, symbols, objects that are not plain (a `Date`, a
  `Map`, a `Buffer`), holes in a list, and values nested deeper than 32 levels.
- The text is encoded as **UTF-8**.

`statementDigest(statement)` is the sha256, in lowercase hex, of those UTF-8 bytes. The same statement gives the same digest whatever
the key order of the object it is held in, whether it was read back from indented JSON, and in another process.

A verifier that reads a pack from JSON text should refuse duplicate keys in an object (I-JSON); the validator of v0.1 works on a parsed
value and cannot see them.

## Validation

`validateStatement(statement)` returns `{valid, errors: [{path, keyword, message}]}`, `path` a JSON Pointer (RFC 6901) into the
statement. The schema is checked first; the rules beyond it only on a statement that passes it.

### The schema validator

`lib/proof/schema-validate.mjs` supports exactly the keywords the schema uses, with their draft 2020-12 meaning: `$schema`, `$id`,
`$comment`, `title`, `description`, `$defs`, `$ref` (only `#/$defs/<name>`), `type`, `enum`, `const`, `oneOf`, `properties`, `required`,
`additionalProperties` (only `false`), `minProperties`, `maxProperties`, `items` (one schema), `minItems`, `maxItems`, `uniqueItems`,
`minLength`, `maxLength`, `pattern`, `minimum`, `maximum`. A schema with any other keyword, or a supported keyword with a value it does not
understand (a pattern that does not compile, a reference to nothing, a loop of references), is refused when it is compiled: it is never
read half-way.

On values: a `number` is finite, an `integer` a safe integer, an `object` a plain object, string lengths count code points, a pattern
uses the `u` flag. Whatever the schema says, a string with a lone surrogate is refused (`wellFormed`) and an object with an own key
`__proto__`, `constructor` or `prototype` is refused at that key (`forbiddenKey`), before anything else in it is read. A missing required
field is reported at its own path (`/subject/0/digest`). When no branch of a `oneOf` passes, the errors of the branch that got deepest
into the value are reported (`/predicate/cost/knownSubtotal` for a `NaN` subtotal).

### Rules beyond the schema

Reported with the keyword `semantic:<rule>`:

| Rule | What |
|---|---|
| `duplicate_subject` | a subject name occurs twice |
| `missing_subject` | `workspace-tree-before`, `workspace-tree-after` or `change.diff` is missing |
| `digest_algorithm` | a subject's digest is not the one its name calls for (`gitTree`, `sha256`, `gitCommit`) |
| `digest_length` | a tree id is not as long as the object format of its tree says |
| `receipt_order` | receipts are not in increasing seq order |
| `duplicate_criterion` | a criterion id occurs twice |
| `manual_checks`, `no_checks` | a manual criterion with checks, a criterion of kind `checks` without |
| `check_index` | a check's `index` is not its position |
| `unknown_receipt` | a check lists a seq no receipt of the pack has |
| `no_receipt` | a check whose result is not `not_run` lists no receipt |
| `check_result` | `passes` and `repeat` do not give the `result` |
| `receipt_other_check` | a check lists a receipt of another command (`commandSha256`) or folder (`cwd`) |
| `passed_receipt` | a `passed` or `repeats_short` check lists a receipt that did not start and end on the final tree or did not pass, or more receipts than `passes` |
| `failed_receipt` | a `failed` check lists a receipt that did not start on the final tree, or no receipt that failed |
| `stale_receipt` | a `stale` or `tree_unknown` check lists a run that started on the final tree and failed or left the tree as it was; a `stale` one lists no run on a tree of the final tree's algorithm and object format; a `tree_unknown` one lists such a run |
| `not_run_receipt` | a `not_run` check lists a receipt |
| `reason_check` | a reason names a check the criterion does not have |
| `omitted_reasons` | reasons were left out but the last one listed is not `checks_modified` |
| `missing_reason` | the acceptance is untrusted, the report missing or the ledger unverified, and a criterion of kind `checks` does not say so |
| `status` | the status is not the one the listed facts give (the table above) |
| `too_large` | the canonical JSON is over 32 MiB |

**A check's result against its receipts.** A result is itself a listed fact, and the receipts a check lists must not contradict it: they
are of the check's command and folder, a run "started on the final tree" has a `treeBefore` of the final tree's algorithm and object
format whose id is the `workspace-tree-after` subject (and "ended on" it with such a `treeAfter`), and a run "passed" when `exit` is the check's `expectExit` and it neither timed out, nor was
cancelled, nor ended by a signal (the same tests the builder uses). Two things are not checked, because a statement the builder makes
can break them: that a check lists all of its passing runs (a caller may lower the limit, and the pack does not record the limit it
used), so only "no more receipts than `passes`" is required; and that `run` hashes to `commandSha256` (`run` is masked and cut, the hash
is of the exact command).

## Masking

Every text of a pack (the agent and model fields, commands, folders, details, lockfile paths, the engine's reason, the owner's name) is
masked with `maskSecrets` of `lib/permissions.mjs` and the registered secrets the caller gives, as the ledger masks its records; the
ledger has masked the records it holds already. A text that grew by masking is cut to its limit afterwards (a cut command sets
`commandTruncated`). Digests and Git ids are never masked: they are hex the Hub computed, and the schema holds them to hex. As in the
ledger, a registered secret shorter than 4 characters is not masked, and a secret made of hex digits could occur inside a digest by chance.

## Limits

| Limit | Value | Beyond it |
|---|---|---|
| receipts per check | 10 | its latest ones are listed |
| other receipts (no check lists them) | 1,000 | the latest are listed, the rest counted in `ledger.omittedReceipts` |
| uncertain events | 500 | the first are listed, the rest counted in `ledger.omittedUncertain` |
| reasons per criterion | 64 | `checks_modified` reasons left out, counted in `omittedReasons` |
| criteria, checks per criterion | 100, 20 | as the acceptance file allows; more is refused |
| lockfiles | 2,000 | the first, in the report's order |
| texts | command 8,192, folder 1,024, detail 600, model fields 200 characters ... | cut (the schema holds each one) |
| canonical JSON | 32 MiB | refused (`semantic:too_large`) |

A caller may lower the first four (`limits`), never raise them.

## Not verified, and what comes next

- **No third-party in-toto verifier has been run on a pack.** The structure is checked against the Statement v1 specification by this
  repository's own suite only; it stays unverified until such a tool is run.
- The ledger's end is not anchored: lines removed from its end leave a shorter ledger that still verifies (`ledger-end-not-anchored`).
- No part of the Hub writes `permission` records or owner acceptances yet (pod-17, pod-34): the summary reads the `decision` field
  they are expected to have.
- Later versions: a DSSE envelope and signing, cost per criterion (pod-31), and whatever outside feedback changes.

## Tests

`DATGOLD-HUB/tests/verify-proof-pack.mjs`: canonical JSON on the RFC 8785 examples; the validator keyword by keyword and its refusals;
this schema file equal to the code's schema byte for byte; every status and reason from real pod-16, pod-20 and pod-22 outputs; the
full chain on real Git repositories (snapshots, real commands through `recordCheck`, the pod-22 detector, `git diff`); a registered
secret absent from the pack; 74 malformed statements each refused at its own path. Mutation list:
`DATGOLD-HUB/tests/mutation/proof-pack.json`.
