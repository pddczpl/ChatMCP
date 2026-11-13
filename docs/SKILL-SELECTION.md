# Skill selection: how it works and how well

How the Hub decides which skills a request gets, measured over 347 labelled requests. The numbers are a **baseline**: what the selector does today, before any change to it.

- Corpus: `DATGOLD-HUB/tests/fixtures/skill-selection-corpus.json` (the requests and the skills a person would expect), `skill-selection-third-party.json` (30 stand-in third-party skills)
- Report: `node tests/tools/measure-skill-selection.mjs [--json file] [--markdown] [--failures n]` (run from `DATGOLD-HUB`)
- Ratchet: `tests/verify-skill-selection-baseline.mjs` against `tests/fixtures/skill-selection-baseline.json`. No number may get worse.

## How selection works today

No model and no embedding take part. It is word overlap, in four files:

1. **The scorer**, `PluginManager.selectSkillsForTask` in `DATGOLD-HUB/lib/plugins.mjs`. The request is lowercased and cut into ASCII words of 3 characters or more (`/\b[a-z0-9_-]{3,}\b/`). A fixed list of function words ("the", "with", "this" ...) counts for nothing. Each ENABLED skill gets:
   - +5 for each word of the request that is a part of its id (split on `-` and `_`);
   - +4 for each word that is a word of its name (split on spaces);
   - +1 for each word that appears in its description, which is split on spaces only, so `hints.` and `"deck",` keep their punctuation; filler such as "use", "skill", "user" is not counted;
   - +8 to +10 for an explicit trigger, from a table of 9 rows: git, commit, branch, pytest, docker, react, security, secret, sqlite. A trigger is tested with `skill.id.includes(part)`, a substring of the id;
   - +2 when the workspace is a project of the kind the skill is called (below), only if the score is already above 0.

   A skill passes at 3 points (`SKILL_THRESHOLD`, `lib/skill-selection-record.mjs`). The best ones are taken, at most 4 (`SKILL_LIMIT`, `lib/agent.mjs`).
2. **Vietnamese**, `lib/skill-vocabulary.mjs`: a table of 18 phrases ("nhánh", "bảo mật", "cơ sở dữ liệu" ...). Each counts as the English words of its translation. Every other Vietnamese word is invisible: "viết", "sửa", "kiểm tra" have no ASCII part of 3 letters, and "mật khẩu" (password) is not a row.
3. **Project kinds**, `lib/project-signals.mjs`: the file names at the root of the workspace and the dependency names in `package.json` / `pyproject.toml` / requirements files give docker, github-actions, python, fastapi, react and sqlite.
4. **The conversation**, `selectConversationSkills` in `lib/agent.mjs`, called once per run. It scores the run's own prompt first, then up to 20 earlier prompts, newest first, each on its own. The skills of the earlier prompts fill what is left of the 4.

Skills that are enabled and not selected are not lost: the skill index (`lib/skill-index.mjs`, at most 4,096 bytes) lists them after the selected ones, as a **catalog**. It shows id, name and the first 110 bytes of the description when all of them fit, and the ids only when they do not. The model can read any of them with the `skill_load` tool. A first start enables 3 of the 9 built-in skills of `MARKETPLACE_CATALOG`. Third-party skills come from a GitHub registry of 5 sources (`lib/skill-registry.mjs`) and are off until the owner turns them on.

## The corpus

347 requests: 172 English, 113 Vietnamese with diacritics, 40 without, 22 mixed. Each row is judged against one set of enabled skills:

| set | skills enabled | rows |
| --- | ---: | ---: |
| fresh | the 3 a first start enables | 83 |
| shipped | the 9 of `MARKETPLACE_CATALOG` | 122 |
| large | those 9 and 30 stand-in third-party skills | 142 |

Categories: one skill clearly helps (125); two help (33); none should be selected (88: general coding, chit-chat, questions about the product); follow-up turns given with their earlier prompts (36); a technology or a skill's word is named and the skill is not wanted (33); the request does not name the technology and the project kind shows it (32). In all, 132 rows expect nothing.

Each row has `must` (a list entry means "any one of these"), `acceptable` and `mustNot`, plus a reason. The labelling rules are written at the top of the corpus. The ones that decide most:
- A **question** about a technology ("explain what git rebase does") expects nothing, and that technology's skill is acceptable. Skills are guidance for doing work.
- A skill's word **in another sense** ("branch coverage", "worker pool", "commits the transaction") puts that skill in `mustNot`.
- **Tests or code with no sign of the language** expect nothing; the Python skill is acceptable where it is the likely one.
- **A follow-up** expects the skills of the work it continues.

The labels were written from the skills' names and descriptions before the selector was run. The corpus has a commit of its own that is older than the script and its results. **No label was changed after the first run.**

The 30 third-party skills are **stand-ins**, written for the fixture and modelled on publicly known skill kinds. They were not fetched, and their ids (`<source>-<folder>`) were not checked against the repositories.

## Baseline

The skill index is built with the default allowance (4,096 bytes, the room a run with a large context window has).

**Columns:**
- **exact**: every expected skill selected, and nothing that is neither expected nor acceptable.
- **recall**: expected skills selected / expected.
- **precision**: selected skills that are expected or acceptable / selected.
- **over**: rows that expect nothing where something unacceptable was selected.
- **silent**: rows that expect a skill where nothing was selected.
- **missed -> catalog**: for each expected skill not selected, how the catalog still names it to the model.

| set | rows | exact | recall | precision | over | silent | missed -> catalog: described / id only / absent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fresh | 83 | 67.5% (56/83) | 50.9% (27/53) | 93.9% (31/33) | 5.4% (2/37) | 43.5% (20/46) | 26: 26 / 0 / 0 |
| shipped | 122 | 56.6% (69/122) | 48.9% (44/90) | 79.4% (54/68) | 4.4% (2/45) | 45.5% (35/77) | 46: 46 / 0 / 0 |
| large | 142 | 54.2% (77/142) | 59.8% (64/107) | 66.2% (88/133) | 16.0% (8/50) | 33.7% (31/92) | 43: 0 / 43 / 0 |
| **all** | 347 | 58.2% (202/347) | 54.0% (135/250) | 73.9% (173/234) | 9.1% (12/132) | 40.0% (86/215) | 115: 72 / 43 / 0 |

| language | rows | exact | recall | precision | over | silent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| en | 172 | 57.6% | 61.0% (75/123) | 66.9% (95/142) | 15.2% (10/66) | 31.1% (33/106) |
| vi | 113 | 56.6% | 42.5% (34/80) | 81.4% (48/59) | 4.5% (2/44) | 53.6% (37/69) |
| vi-plain | 40 | 65.0% | 53.6% (15/28) | 94.4% (17/18) | 0.0% (0/15) | 48.0% (12/25) |
| mixed | 22 | 59.1% | 57.9% (11/19) | 86.7% (13/15) | 0.0% (0/7) | 26.7% (4/15) |

| category | rows | exact | recall | precision | over | silent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| one | 125 | 41.6% | 54.4% (68/125) | 73.1% (79/108) | n/a | 40.8% (51/125) |
| two | 33 | 33.3% | 63.6% (42/66) | 88.2% (45/51) | n/a | 12.1% (4/33) |
| none | 88 | 96.6% | n/a | 0.0% (0/5) | 3.4% (3/88) | n/a |
| followup | 36 | 47.2% | 50.0% (16/32) | 76.9% (20/26) | 0.0% (0/6) | 43.3% (13/30) |
| mention | 33 | 75.8% | 100.0% (1/1) | 65.6% (21/32) | 25.0% (8/32) | 0.0% (0/1) |
| project | 32 | 37.5% | 30.8% (8/26) | 66.7% (8/12) | 16.7% (1/6) | 69.2% (18/26) |

In the 30 rows that have a `mustNot`, a mustNot skill was selected in 14.

**The catalog, when nothing is selected**, at four sizes:

| skills enabled | what the catalog shows | named |
| ---: | --- | ---: |
| 3 | id, name, description | 3 of 3 |
| 9 | id, name, description | 9 of 9 |
| 39 | ids only | 39 of 39 |
| 150 | ids only (3,926 of 4,096 bytes) | 150 of 150 |

From about 20 skills on, the model sees the ids alone. A skill whose id does not say what it is for (`anthropic-theme-factory`, `openai-gh-address-comments`) is then a name the model has to guess about.

**What the numbers say in short:**
- The selector almost never selects something when a request needs nothing (96.6% of the "none" rows are exact).
- It misses about half of what is needed, and more in Vietnamese and when only the project shows the technology.
- With many skills enabled, precision falls: words such as "fix", "deploy", "design", "web", "review", and the registry source in the id ("vercel", "github", "anthropic"), select skills they are not about.

## Ten failures that explain most of the rest

1. **S-083** "the docker build already works, I just need you to fix the typo in the README": Docker selected with 20 points. The id, name, description and trigger all match "docker". The scorer has no notion that a word is mentioned only to be set aside.
2. **S-015** "write the commit message for this diff": the GitHub Actions skill is selected. The `commit` trigger gives +8 to every skill whose id CONTAINS "git", and `github-actions-ci-cd` contains it. The same substring makes "nhánh" (branch) select it in S-039.
3. **S-010** "add a test matrix for node 18, 20 and 22 to the CI workflow": the Git skill is selected and the CI skill is not. "workflow" is a word of the id `git-workflow-pro` (+5) and of its name (+4). The CI skill's description says "workflows", which is not the same word.
4. **S-035** "dockerize the FastAPI app": Docker gets 0. There is no stemming: "dockerize", "dockerise" and "Dockerfile" are not "docker". In the same way "keys" is not "key", so **F-006** "there's an AWS access key hardcoded in settings.py" selects nothing.
5. **F-004** "add type hints to utils/dates.py": Python gets 1 point. The description ends with "type hints.", and the period stays on the word. `dates.py` is not "python".
6. **L-005** "make a 10-slide deck about our Q3 results": the slides skill gets 0. Its description has `"deck",` with the quotes and comma attached, and "10-slide" is one token because `-` counts as a letter of a word.
7. **F-014** "kiểm tra xem có lộ mật khẩu hay token nào trong mã nguồn không" (are any passwords or tokens leaked in the source?): 0 points. "mật khẩu" is not in the 18-row table, and "token" is not a word of the guard's description. Vietnamese recall is 42.5% against 61.0% in English.
8. **S-096** "add an endpoint that returns the current user", in a FastAPI project: nothing. The project kind adds 2 only to a skill that already scored. A request in the project's own terms that names no word of a description gets no help from the project. Project rows have the lowest recall, 30.8%.
9. **F-048** "now add tests", after "add type hints to utils/dates.py": nothing. A follow-up can only inherit what an earlier prompt selected, and that earlier prompt selected nothing (point 5).
10. **L-019** "deploy this site to Vercel and give me the preview link": `vercel-react-best-practices` and `vercel-web-design-guidelines` are selected. The registry source "vercel" is part of every id from that source and is worth +5 to each. The same happens with "github" and "anthropic" (L-042 selects the PDF and Word skills for "Anthropic's brand colours").

`node tests/tools/measure-skill-selection.mjs` prints the 20 lowest-scoring misses and the 20 surest over-selections, each with the scorer's own reasons. `--json` writes all of them: 115 misses and 61 over-selections.

## What this measurement cannot see

- **The model's own use of `skill_load`.** Every missed skill is still named in the catalog: 72 with a description, 43 by id only, none left out. Whether a model reads the right one is a question for a real model, and no model is called here. The numbers above are what the keywords give before the model starts.
- **A smaller context window.** The catalog is measured with the default allowance (4,096 bytes). A run with less room gets a smaller index and names fewer skills.
- **Real third-party descriptions.** The 30 are stand-ins of realistic length and style, not the published texts. The real texts, and how many skills a user really enables, may score differently.
- **Label judgement.** One author wrote the labels from the descriptions. Rows near a rule ("tests" with no language, a question that names a technology) are judgement calls. The reason on each row says which way it was decided.
- **The cost of a wrong pick.** A selected skill costs room in the index; its text is read on demand. That cost is not weighed here.
