# Proof-of-Done: reports of a proof pack (P5 pod-30)

A proof pack ([spec/agent-change-v0.1.md](spec/agent-change-v0.1.md), [PROOF-CLI.md](PROOF-CLI.md), "The pack file") is canonical JSON. This page
describes the **report** made of one for people: Markdown for a pull request comment, or one HTML file, in English or in Vietnamese.

| File (`DATGOLD-HUB/lib/proof/render/`) | What |
|---|---|
| `model.mjs` | `buildReport(source, options)`: what the report says, in which order, as data. The only file that reads a pack |
| `md.mjs` | `renderMarkdown(report)`: Markdown, at most 65,000 characters |
| `html.mjs` | `renderHtml(report)`: one HTML file |
| `i18n.mjs` | the dictionary (`en`, `vi`) |
| `text.mjs` | how a text of a pack is made visible; numbers, durations and money without a locale; the rate |
| `diffstat.mjs` | the diff stat, counted from the patch |

From the command line: `chatmcp verify show --pack <file> [--format md|html] [--lang en|vi] [--out <file>]` ([PROOF-CLI.md](PROOF-CLI.md), "`show`").

**What exists today.** The renderers, the command, and the Hub's route ([PROOF-HUB-API.md](PROOF-HUB-API.md), pod-33: it also takes the Hub's registered secrets out of the texts of a
report). The Proof tab (pod-34) is to use them. The report of the benchmark ([corpus/REPORT.md](../corpus/REPORT.md), pod-39) is written with their nodes, escaping, numbers and style.

**A report is a reading aid, not evidence.** It is a text that anyone can edit. It names the statement digest of the pack it was made of and
ends with the commands that check and reproduce that pack.

## What a report is made of

`buildReport({statement, files, entries, packChecked}, {lang, packName, vnd})`:

- The **statement** must pass `validateStatement` of the spec, else `RenderError` (`render_bad_input`). A report of a statement that does not
  validate is never made. The digest shown is computed from it.
- **`packChecked: true`** is for the code that ran `readPackFile` (`lib/proof/cli/check.mjs`) and hands over what it resolved (the files and
  the ledger entries with it, else it is refused): the report then says that the pack file was checked, and what that covers. Without it the
  report says that it was made from a statement alone and that nothing was compared with a ledger or a patch, and its verdict is never shown
  as a pass. `chatmcp verify show --pack` always checks first and renders nothing of a pack that does not
  verify.
- **`files`** (`change.diff`, `acceptance.yml`) are compared with the sha256 the statement names, whoever gives them; another file is refused.
- **`packName`** is the file name shown in the commands; a name that is not `A-Z a-z 0-9 . _ -` (or starts with a dot or a dash) is shown as
  `<pack>`, so nothing of a name that a shell would read comes into a command to paste.
- **Masking.** The statement's texts are masked by its builder (the spec, "Masking"). The texts a report reads from the pack's files, the
  criteria of the acceptance file and the paths of the patch, go through the same `maskSecrets` (without registered secrets: a report knows
  none), because a report is posted where a pack is not.

## Sections

| Section | What it says | When the pack does not hold it |
|---|---|---|
| (the verdict) | one sentence and the number of criteria by status | `no_criteria` says so |
| What was changed, and by what | agent, model, commits, trees, patch, statement digest, acceptance file and whether its maker trusted it | "not recorded in this pack" |
| Criteria | a table with status chips (and the criterion's text from the acceptance file), the checks, what a person is asked to look at, the reasons | without the acceptance file: the texts are not shown, and it says why |
| Receipts | command, folder, shell, outcome, short tree id and what it is to the final tree, duration, time, the checks that list it | no ledger, or no check record; receipts the pack leaves out are counted |
| Diff stat | files, lines added and removed, counted from the patch | a statement alone has no patch; a patch outside the form below has no counts |
| Changes to the checks | the findings per criterion, whether the acceptance file was edited, the lockfiles that changed | no check-changes report: "nobody looked", never "nothing found" |
| Permission decisions | the counts by decision | no permission record: that does not say that nothing was asked |
| Uncertain events | the events, and how many the pack leaves out | no ledger; none recorded is what was written down, not a proof |
| Data sent out (Companion) | **not recorded in this pack**: a v0.1 statement has no field for it (pod-27). `outbound` records in the ledger of a pack are counted, not read | |
| Cost | the run's cost, or the known subtotal, or unknown; in dong at a rate the caller gives | **the cost per verified criterion is not recorded in this pack** (pod-31): a v0.1 statement holds one cost for the whole run, and it is not divided here |
| Integrity level and limitations | `unconfined`, unsigned, the ledger's chain, every limitation the pack names, what the tree ids leave out | |
| How to verify | the statement digest to compare, and the `chatmcp verify` commands | without a base commit or a plain file name it says what to fill in |

A section whose data is not there is a sentence, never an empty table: an empty table reads as "none happened".

### The verdict

The worst that holds, from the statuses of the criteria:

| Verdict | When | Shown as |
|---|---|---|
| `no_criteria` | there is no criterion | warn |
| `failed` | a criterion is `failed` | fail |
| `checks_modified` | a criterion is `checks_modified` | fail |
| `evidenced` | every criterion is `evidenced` | pass |
| `accepted` | every criterion is `evidenced` or `owner_accepted`, at least one the latter | pass |
| `not_evidenced` | anything else (`stale`, `unverified`) | warn |

### Cost and dong

The pack's cost stays what it is: `unknown`, a known subtotal that does not cover every call, or a cost that covers every call. Every digit of
it is shown; nothing is rounded or estimated. An amount in Vietnamese dong is shown only for a cost in US dollars and only from a rate the
caller gives: `vnd: {rate, date, source}`, or `--vnd-rate 25400 --vnd-rate-date 2026-11-20 --vnd-rate-source "..."`. All three or none; the
date and the source stand beside the amount with the note that nobody checked the rate. There is no built-in rate and none is ever fetched.
Without a rate the report says so. The amount is whole dong, rounded half up, computed exactly (decimal, not floating point); less than half a
dong is "less than 1 VND".

### Diff stat

The patch can come from anyone and a count that misses a file is worse than none. So the reader takes exactly the form `pack` writes (`git diff`
with `DIFF_ARGS` of `lib/proof/baseline.mjs`): no renames, `a/` and `b/`, full index lines, hunks whose headers account for every line,
binary patches. A line of a hunk that looks like a header stays a line of the hunk. A name must be the same in the head and on the `---` and
`+++` lines, `/dev/null` only where the head says added or deleted. A patch with anything else has no counts, and the report says so. At most
2,000 files are listed; the totals count all of them.

## A text of a pack is never markup

Commands, folders, paths, criterion texts, reasons, names: a pack can come from someone who wants the reader's page. Three layers:

1. **The report's words and the pack's texts are different things.** The dictionary holds no markup; what stands in a placeholder is a whole
   number or a node, and a text of the pack (or of the caller, as the source of a rate) is a `code` node. `translate` refuses a plain string.
2. **What is hidden is shown** (`visible`): control characters (a line end and a tab too, so a text is always one line), bidi controls,
   zero-width and other format characters, default-ignorable ones, spaces that are not the space, line and paragraph separators,
   noncharacters and lone surrogates are written as a marker, `⟦U+202E⟧`. The brackets `⟦` and `⟧` themselves are written as markers, so a
   marker in a report is always one of the report, and two texts never look the same because of it. Nothing else changes: no Unicode
   normalisation, because a command is evidence (its sha256 is of its exact bytes). Letters that only look like others (homoglyphs) are not
   marked, and letters of a right-to-left script are shown in their own order.
3. **Each format escapes for its place.**
   - **HTML**: `& < > " '` in text and attributes. Every text of the pack is a `<code>` element; no attribute holds one but the `title` of a
     whole tree id or digest (hex by the schema).
   - **Markdown**: every text of the pack is a **code span**, whose fence is longer than any run of backticks in it. In a code span there is no
     link, image, HTML, emphasis, autolink, mention, issue number or math, and a site that turns `@name` into a mention after it has rendered
     the Markdown leaves code alone (a backslash would not stop that). In a table cell a pipe has exactly one backslash before it; a backslash
     right before a pipe is written as `⟦U+005C⟧`, because cmark-gfm and markdown-it read two backslashes and a pipe differently. No raw HTML is
     written. The report's own words are escaped too.

**Normalisation.** If something between the report and its reader normalises the bytes to NFC, no markup appears: a combining mark at the start
of a text (it would join the tag before it) and U+1FEF and U+037E (whose NFC forms are a backtick and a semicolon) are markers. The dictionary
is NFC. A text of a pack comes out as it went in, composed or decomposed.

## Markdown

- At most **65,000 characters** (UTF-16 code units; a GitHub comment takes 65,536). A caller may lower it to 24,000, not raise it.
- A text longer than 300 characters is cut, and the report says how long it was. The HTML page shows it whole.
- A report that would be longer loses rows of its tables and lists, whole lines from the end of a block: at first no block takes more than half
  of the room that is left, then the rest is given out in order, so a thousand receipts do not push out everything after them. Every block that
  lost rows says how many, and a note at the top says that the report was shortened and by how many rows. The verdict (its counts are of the
  whole pack), every section's own sentences and how to verify always stay.

## HTML

One file: its style inline, no script, no link, no image, no font, nothing loaded. A `Content-Security-Policy` in the page (`default-src 'none'`,
`script-src 'none'`, ... and `style-src` with the sha256 of the one style element) forbids scripts, event handlers, inline `style` attributes and
every load, so markup that got in by a mistake could do nothing; the escaping is what keeps it out. Dark mode, a print style sheet, table heads
with a scope, chips that say their status in words. A text of the pack is isolated (`unicode-bidi: isolate`), so it does not reorder what stands
around it. The page has no length cap. A policy in a `<meta>` cannot forbid that another page frames this one.

## The same pack gives the same bytes

The report depends on the source and the options only: no clock, no time zone, no locale (numbers are grouped by the dictionary's language,
dates and times are in the pack's own form), no order of keys. LF line ends, UTF-8, one line end at the end. Which characters count as hidden follows the Unicode
version of the Node.js that runs it, so a character assigned lately may be a marker with one version and not with another.

## Tests

`DATGOLD-HUB/tests/verify-proof-render.mjs`, with two packs of `tests/fixtures/proof-render/` (`fixture.mjs` makes them with the real ledger,
statement builder and pack file code, and `chatmcp verify check` accepts both) and eight golden reports (2 packs x 2 languages x 2 formats,
byte for byte; `node tests/fixtures/proof-render/fixture.mjs --write` makes them again after an intended change). 25 hostile texts in 16 places
of a statement, both formats and both languages, are read back with an HTML tokenizer and a Markdown reader written in the suite (table cells
by the rules of cmark-gfm and of markdown-it). The dictionary (a text for every code of the predicate, the same placeholders, NFC), diacritics
composed and decomposed, the diff stat's refusals, the verdicts, every sentence for missing data, the cap and its edge, the clock and the locale
functions broken, and the command. Mutation list: `tests/mutation/proof-render.json`.

Not verified: how GitHub itself renders the Markdown (its own steps after the Markdown are closed), other Markdown readers than the two whose table rules
the suite applies, screen readers, and printing on paper.
