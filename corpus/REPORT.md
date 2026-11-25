# The report of the benchmark corpus

Plan task P7 pod-39. `tools/report.mjs` turns the corpus, the folder of **run packs** and `results.jsonl` ([SCORING.md](SCORING.md)) into one
Markdown report and one static HTML site, each in English and in Vietnamese. **What exists today:** the tool, its command line, its words
(`corpus/templates/`) and its tests on synthetic run packs. **What does not exist yet:** real runs (pod-37, pod-42), so no real report: no agent,
no model and no paid call has been scored, and every number in the tests and in the golden report is made up.

- [What goes in](#what-goes-in)
- [What comes out](#what-comes-out)
- [The recompute](#the-recompute)
- [The registration and the banner](#the-registration-and-the-banner)
- [What the pages say](#what-the-pages-say)
- [Wording](#wording)
- [A text of the data is never markup](#a-text-of-the-data-is-never-markup)
- [The same inputs give the same bytes](#the-same-inputs-give-the-same-bytes)
- [Refusals](#refusals)
- [Command line](#command-line)
- [Tests](#tests)
- [Not verified](#not-verified)

## What goes in

| Input | What | Needed |
|---|---|---|
| `--corpus` | the folder that holds `tasks/`; every task must load | yes |
| `--packs` | the folder of run packs, as `score.mjs` reads it | yes |
| `--results` | `results.jsonl`, the bytes `score.mjs` wrote for these packs | yes |
| `--out` | the new folder the report is written to | yes |
| `--preregistration` | the `preregistration.json` that `freeze.mjs` wrote | no |
| `--tag` | the name of the freeze tag, read from the repository that holds the corpus | no, and only with `--preregistration` |
| `--responses` | a folder of vendor responses, `agent-<id>.txt`, plain UTF-8 text of at most 64 KiB each | no |
| `--date` | a day, `YYYY-MM-DD`, shown as given by the maker of the report | no |

## What comes out

```text
<out>/
  report.en.md, report.vi.md           the whole report as Markdown
  en/, vi/                             the site
    index.html                         the rates, the costs, what is counted apart, the kill rule, the controls, every run
    agent-<id>.html                    one agent
    task-<id>.html                     one task, its runs, the link to every run's pack and the pack's sha256
    methods.html                       protocol, definitions, interval, marker contract, readings, limitations, how to make it again
    responses.html                     the vendors' responses
  packs/<task>_agent-<id>_<n>.json     a copy of every run pack, byte for byte (control-oracle and control-null for the controls)
  results.jsonl, preregistration.json  copies, byte for byte
  responses/agent-<id>.txt             copies, byte for byte
```

The folder holds everything the report is made of but the corpus, and it makes itself again: run on its own `packs/`, `results.jsonl`,
`preregistration.json` and `responses/`, the tool writes the same folder byte for byte. Every link is relative; nothing is loaded; the pages work
from `file://`. The tool writes to a **new** folder only. Everything is written to a folder beside it (`.report-partial-<hex>`) that is renamed when it
is complete, so a run that fails leaves nothing half-written and nothing that was there is written over. A run that is killed (Ctrl+C, a power cut) can
leave that folder; nothing reads it, and it can be deleted.

File names and anchors are made of ids that their own rules allow (`a-z`, `0-9`, `-`) and of words of the tool, so no id can leave the folder
(`bad_id`), name a Windows device (an agent may be called `con`: its page is `agent-con.html`) or take the name of another (an agent called
`oracle` is `agent-oracle`, the control is `control-oracle`).

A site of 200 tasks and 10 agents (6,400 packs) is 428 files; its Markdown report is about 2.3 MB, more than some sites show.

## The recompute

`results.jsonl` is not trusted. The packs are scored again (`scoreFolder` of `score.mjs`) and the file must be those bytes; a byte that differs is
`results_differ`, with the line. The metrics are `computeMetrics` of `metrics.mjs` on those results and nothing else: the report computes no rate
and no interval. What it counts itself is what is **missing**: the repeats of a task of the corpus that have no pack, the registered agents and the
tasks of the corpus without any run. `metrics.mjs` knows the results only, so a task that nobody ran is not among its tasks.

A pack whose bytes change between the scoring and the copy is `packs_changed`; a corpus that changes meanwhile is `corpus_changed`.

## The registration and the banner

**A registered run set** is: a `preregistration.json` that is, byte for byte, what `freeze.mjs` writes for this corpus, this protocol, these metric
definitions, this threshold, this kill rule, this marker contract and this task schema (`preregistration_mismatch` names the part that differs); whose
agents include every agent with a run (`agent_not_registered`); and whose **tag** is the one `freeze.mjs` makes of it: an annotated tag of that name,
on the commit the file names, whose message holds the file itself (`tag_mismatch`, `tag_missing`). Replacement objects are not followed. A signature
after the message is said ("its signature was not checked here") and not checked. The tag's time is the tagger's, by the clock of that machine. The
corpus must be in the repository that has the tag.

Everything else has a **banner on every page** and at the head of every part of the Markdown report, "Synthetic data, not a measurement", with why: no
preregistration file, no tag checked, or example tasks (an id that starts with `example-`, or the tag `example`). A report of a registered run
set names the tag, its object and time, the commit, and the sha256 of the preregistration file and of the corpus. The commit of the scoring code is
named as registered; it is not compared with the code that made the report.

## What the pages say

- **Rates** stand as `k/n = value (95%: low – high)`: the counts, the value, the Wilson interval. Percentages have one decimal; only an exact 0 or 1 is
  `0%` or `100%`, anything else that rounds to them is `<0.1%` or `>99.9%`. **n = 0 is "no rate"**, never 0%.
- **What is not known** is counted: re-verifications and check-change reports that are not there ("not known for 2"), costs that are not complete or
  not in US dollars (with how many of each kind). A cost is never estimated.
- **What is counted apart** is in a table of its own: scoring errors, flaky runs, flaky false DONE claims, runs stopped at the time limit, BLOCKED, no
  marker, missing repeats (listed by task on the agent's page).
- **The kill rule** is applied as `protocol.mjs` words it, and its consequence is stated **only** for the registered run set, complete: registered (no
  banner), every registered agent and every task of the corpus with every repeat, the controls in order, no scoring error. Otherwise the page says
  that it is not applied, with every reason, and what the rates are. With no DONE claim at all there is nothing to decide. A rate exactly at 10 percent
  is not above it.
- **Controls** have a section: the oracle and the null agent of every task, and what is wrong with one.
- **No comparison.** The protocol defines none, so the report makes no comparison between agents and says so. Agents and tasks stand in id order
  everywhere.
- **A run** is shown as it is: its claim, the outcome of its hidden tests, the answers of its result line, its cost and time, the last line of its final
  message, the paths out of scope (20 at most; the pack has the rest), and the link to its pack with the pack's sha256.
- **Vendor responses** are what the maker of the report supplied, shown line by line as text with the file's sha256, or "No response was recorded". The
  page does not say whether a vendor was asked.

## Wording

The words are `corpus/templates/en.json` and `corpus/templates/vi.json`: the same keys, the same placeholders, NFC, no markup. A lint in the suite
refuses, in both dictionaries and in the words of every golden page, wording that no measurement of this kind supports ("proven", "safe",
"guarantee", "best", "better", "winner", "outperforms", "ranking", "significant", and the Vietnamese), also in a denial.

## A text of the data is never markup

Titles, prompts, commands, paths, final messages, the agents' registered words, responses: all of it can come from someone who wants the reader's
page. The report is written with the pieces of the proof pack's renderers ([docs/PROOF-RENDER.md](../docs/PROOF-RENDER.md)), through the bridge
`tools/render.mjs`:

- the dictionary and the data are different things: what stands in a placeholder is a whole number or a node, and a text of the data is a `code` or
  `word` node; `translate` refuses a plain string;
- what is hidden is shown as its code point, `⟦U+202E⟧`: control characters, bidi controls, zero-width characters, spaces that are not the space;
- **HTML**: `& < > " '` are escaped, every text of the data is a `<code>` element, no attribute holds one, a link is one of the report's own paths.
  The page has a `Content-Security-Policy` that forbids scripts and every load and names its one style by hash;
- **Markdown**: every text of the data is a code span, or, when it has many lines (a prompt, a response, the marker contract), a fence longer than any
  run of backticks in it. No raw HTML is written. Links lead to files of the report; a page of the site is a part of the Markdown report, so its name
  alone stands there.

A text a run left is cut at 500 characters, with its length; the pack has the rest. Prompts and responses are whole. **Nothing is masked**: the packs
and the responses are published as they are, and the report shows parts of them. Whoever publishes a report has to look through both for secrets.

## The same inputs give the same bytes

The report depends on the bytes of its inputs only: no clock (without `--date` it holds no date of its own), no time zone, no locale, no file name of
a pack, no order of packs, tasks or keys. LF line ends, UTF-8. Which characters count as hidden follows the Unicode version of the Node.js that runs it.

## Refusals

A refusal is a `ReportError` with a code, or the `ScoreError` or `MetricsError` of the tool below it ([SCORING.md](SCORING.md), "Refusals"). Nothing is
written. The command line prints `refused: <code>: <message>` and exits 3.

| Code | When |
|---|---|
| `bad_argument`, `bad_date` | an option that is missing, unknown or no path; a tag without its preregistration file; a date that is no day |
| `results_missing`, `results_differ` | no results file; a results file that is not what the packs give |
| `preregistration_missing`, `preregistration_invalid`, `preregistration_mismatch` | no file; not the shape `freeze.mjs` writes; of another corpus or protocol, or written another way |
| `agent_not_registered` | a run of an agent the preregistration file does not list |
| `tag_missing`, `tag_mismatch` | no such tag (or no repository, or no Git); a tag that is not the one made of this file |
| `responses_missing`, `unexpected_file`, `response_unknown_agent`, `response_empty`, `response_not_text`, `response_too_large` | the responses folder |
| `out_exists`, `out_parent_missing`, `out_inside_input` | the output folder: it exists, its parent does not, or it is inside the corpus, the packs or the responses |
| `input_unreadable`, `write_failed` | an input that is there and cannot be read; a file that cannot be written |
| `packs_changed`, `corpus_changed` | an input changed while the report was made |
| `bad_id` | an id that its rule does not allow (the loaders refuse one before; this is the last line) |

## Command line

```bash
node corpus/tools/report.mjs --corpus <dir> --packs <dir> --results <results.jsonl> --out <new folder> [--preregistration <file> [--tag <name>]] [--responses <dir>] [--date YYYY-MM-DD]
```

Exit 0 when the report is written, 2 for a usage error, 3 for a refusal. The tool contacts no network; with `--tag` it runs `git rev-parse` and
`git cat-file` in the corpus folder.

## Tests

`DATGOLD-HUB/tests/verify-corpus-report.mjs` (run by `tests/run-all.mjs` and CI): the dictionaries and the wording lint; numbers; a golden report of 19
synthetic run packs in both languages and both formats, byte for byte (`node tests/fixtures/corpus-report/fixture.mjs --write` from `DATGOLD-HUB`
makes it again after an intended change); every rate of `metrics.mjs` as k/n with its interval and no other percentage on any page; a changed byte of
`results.jsonl` and about a hundred other refusals that leave nothing behind; every link of every page followed, with its anchor, and every pack's sha256
compared with the file its link leads to; the banner on every page of what is not registered and on none of a corpus that the real `freeze.mjs` froze
and tagged in a temporary repository; tags that are not its own; every verdict of the kill rule and every reason it is not applied; edge sets; 25 hostile
texts in 20 places, read back with an HTML tokenizer and a Markdown reader written in the suite; determinism in another process, folder, time zone and
locale and with the clock broken; a set of 6,400 packs; failing writes; the command line. `DATGOLD-HUB/tests/mutation/corpus-report.json` breaks the
tools one change at a time (`node tests/mutation/run-mutations.mjs tests/mutation/corpus-report.json --timeout 240` from `DATGOLD-HUB`).

## Not verified

- No real run, no vendor CLI and no model: every report made so far is of synthetic packs. Packs of the real pipeline (pod-37, pod-42) may hold texts
  nobody thought of here.
- How GitHub or another site renders the Markdown, and whether it shows a file of some megabytes; other Markdown readers than the two whose table rules
  the suite applies.
- A signature of a tag is not checked: that is for `git tag -v` and the owner's key.
- Screen readers and printing on paper. macOS has not run the suite.
- The Vietnamese words were not read by a second person.
