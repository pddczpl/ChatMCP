# Claims map

A claim in the documentation is only as good as the test behind it. In v3.9.0 several tests stayed green while the product was broken (installed skills never reached the model, language-server answers were discarded, an injected Tree-sitter adapter was dropped), each time because the test used a hand-written double of the object that held the defect. The claims map makes the binding between a claim and its test explicit, and `DATGOLD-HUB/tests/verify-claims-map.mjs` fails when the binding rots.

- `docs/CLAIMS.json` lists the headline claims of `README.md` and `RELEASE-NOTES-v3.9.0.md`, and a few from `SECURITY.md` and the user guide.
- `docs/claims-ratchet.json` holds the number of **unmapped claims**. It may be lowered, never raised.

## One entry

| Field | Meaning |
|---|---|
| `id` | lower-case words with hyphens; it is also the marker text |
| `claim` | the claim in a sentence |
| `source` | `file`, `line` and a verbatim `quote` of at least 12 characters from that line |
| `kind` | `claim`, or `disclaimer` for a statement that only denies something (its quote must contain "not", "no", "never", "without" ...); a disclaimer promises nothing, so it needs no test and is not part of the ratchet. A sentence that also affirms something ("X does Y, not Z") is a claim |
| `seam` | `real`: a test exercises the claim on the production code path; `unmapped`: none does |
| `test` | for `real`: `DATGOLD-HUB/tests/verify-<name>.mjs`; for `unmapped`: `null` |
| `seamNote` | for `real`: what is real and what is scripted in that test (the model, an HTTP transport, a child process ...) |
| `forbiddenDoubles` | optional list of regular expressions that must not match the test's code, for example a workspace faked as `{ path: ... }` |
| `reason`, `phase`, `candidateTest` | for `unmapped`: why, the roadmap phase that will close it (`P4`) or `null`, and the suite that comes closest |

## What the suite checks

For every `real` entry: the quote is on the stated line; the test exists; `node tests/run-all.mjs --list` (the real runner) lists it, so a run would execute it; the file contains the line `// CLAIM: <id>` on its own; no `forbiddenDoubles` pattern matches its code (comments are removed first). Every `// CLAIM:` marker in any suite must name an existing `real` entry that points at that suite. Every sentence of `README.md` and `RELEASE-NOTES-v3.9.0.md` that contains one of the trust words (`TRIGGER` in the suite: verified, guarantee, secure, and the word for an isolated execution environment) must be covered by an entry; the run prints how many are covered by a mapped claim, an unmapped claim and a disclaimer, and the UNMAPPED COUNT. The unmapped count must equal the ratchet: more is a regression, fewer means the ratchet has to be lowered in the same change.

With `--base <ref>` (CI passes `origin/<base branch>`) the ratchet is also compared with the one on that ref: raising it fails, and a base without a ratchet is the first introduction. After editing a document, `node tests/verify-claims-map.mjs --update-lines` rewrites the line numbers of quotes that moved (a quote that was reworded or that occurs twice must be fixed by hand).

The suite proves itself on temporary copies of the files: a deleted marker, a renamed test (also out of the `verify-*.mjs` pattern, and a runner that no longer lists it), an added forbidden double, a grown unmapped count, an uncovered sentence, a moved or reworded quote, an orphan marker and a raised ratchet are each reported.

## Adding a claim

1. Add the entry (unmapped first if no test exists), run `node tests/verify-claims-map.mjs --update-lines`, then the suite.
2. To map it, put `// CLAIM: <id>` at the top of the test, set `seam: "real"`, `test` and `seamNote`, choose `forbiddenDoubles` for the objects whose fakes caused defects before (try the pattern on the test: it must not match), and lower the ratchet.

## Limits

A marker and a pattern do not prove that a test is good; they make it expensive to leave a claim without evidence and to replace a real path by a double without anyone noticing. `forbiddenDoubles` is a text match, not a program analysis. `real` means the production objects are used; the note says what is still scripted. Disclaimers are judged by a negation in the quote; the suite cannot see whether the same sentence also carries a positive clause, so a reviewer must read each one (two sentences that looked like disclaimers were reclassified as claims for that reason). Entries whose seam is `unmapped` are the unmapped claims plus the disclaimers; the ratchet counts the claims only, and the run prints both numbers.
