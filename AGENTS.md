# AGENTS.md: working on DatGold

DatGold (formerly ChatMCP) is a local Windows desktop AI coding agent: a Node.js Hub (`DATGOLD-HUB/`) that runs the model, the tools and the permissions on 127.0.0.1,
a React page (`DATGOLD-HUB/ui/`, built into `DATGOLD-HUB/web/dist/`), a WinForms + WebView2 shell (`desktop-shell/`), an installer (`installer/`) and a browser Companion
(`DATGOLD-HUB/extension/`). Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full picture.

## Commands

Hub, from `DATGOLD-HUB/` (Node.js 22.12 or newer; no build step):

```bash
node tests/run-all.mjs --no-skip all --retry-failed-once   # every suite, as CI runs them; a SKIP counts as a failure
node tests/verify-docs.mjs                                 # one suite: node tests/verify-<name>.mjs
node tests/mutation/run-mutations.mjs tests/mutation/scrub.json   # a mutation list: every mutation must be KILLED
```

UI, from `DATGOLD-HUB/ui/`:

```bash
npm ci
npm run test:unit
npx tsc --noEmit
node scripts/lint-i18n.mjs
npm run build          # writes ../web/dist: commit it together with the source change that alters it
npm run test:e2e:built # Playwright against that build and a real Hub
```

From the repository root, before a pull request:

```bash
node scripts/check-dco.mjs --base origin/main --head HEAD
```

## Conventions

- English for code, comments, commit messages and pull request text. Documents follow the language rule in CONTRIBUTING.md ("Documentation languages").
- The product is called DatGold. The old name stays only where something depends on it; [docs/NAMING.md](docs/NAMING.md) lists those places, and
  `tests/verify-display-name.mjs` fails on the old name, in either spelling, anywhere else.
- A bug fix comes with a test that failed before the fix. Say in the commit what you ran and what you did not verify.
- Commit subjects are `type(area): what` (CONTRIBUTING.md, "Commit conventions"). Every commit ends with ONE final paragraph that holds both trailers,
  `Signed-off-by: ...` and `Co-Authored-By: ...`, with no blank line between them.
- Tests start their own Hub on a random free port and never touch a Hub on port 3007, which may be the owner's.
- Pull requests are opened as drafts. Merges, releases, tags and version bumps happen only on the owner's word.

## Do not

- Edit `DATGOLD-HUB/web/dist` by hand; rebuild it.
- Rewrite past release notes (`RELEASE-NOTES-v*.md`), dated reports (`docs/PHASE*`) or `docs/archive/`; add a dated note instead.
- Change a pinned number, a ratchet or a gate so that a check passes; fix the code or the document it checks.
- Commit secrets: `.env` files, keys, tokens, `*.dpapi`, or anything a protected path names (`DATGOLD-HUB/lib/protected-paths.mjs`).
