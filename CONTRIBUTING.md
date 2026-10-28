# Contributing to DatGold

Thank you for helping with DatGold, a local-first AI coding agent for Windows 10/11 x64. This page explains how contributions are licensed, how to build and test, and what a pull request has to contain.

- [License of contributions](#license-of-contributions)
- [Developer Certificate of Origin (DCO)](#developer-certificate-of-origin-dco)
- [Build and test](#build-and-test)
- [Commit conventions](#commit-conventions)
- [Pull requests](#pull-requests)
- [AI-assisted contributions](#ai-assisted-contributions)
- [Security reports](#security-reports)
- [ChatGPT Web Companion](#chatgpt-web-companion)

## License of contributions

DatGold is licensed under the [Apache License, Version 2.0](LICENSE); see also [NOTICE](NOTICE). There is **no Contributor License Agreement (CLA)**. Instead, contributions are accepted on an *inbound = outbound* basis: as provided by section 5 of the Apache License 2.0, unless you explicitly state otherwise in the pull request, any contribution you intentionally submit for inclusion in DatGold is licensed under the Apache License 2.0, without any additional terms or conditions. You keep the copyright in your contribution.

Only submit code, text and assets you have the right to license this way. If you copy or adapt third-party material:

- It must be under a license compatible with Apache-2.0 (for example MIT, BSD, ISC, Apache-2.0). Do not add code or bundled components under GPL, AGPL, LGPL, SSPL or proprietary terms.
- Keep its copyright and license notices, say where it came from in the pull request, and update [docs/LICENSE-SCAN.md](docs/LICENSE-SCAN.md) when you add, remove or upgrade a dependency that is redistributed with the app.

## Developer Certificate of Origin (DCO)

Every commit in a pull request must be signed off. The sign-off is a `Signed-off-by: Your Name <you@example.com>` line at the end of the commit message. It states that you agree to the Developer Certificate of Origin, version 1.1:

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Sign off with Git's `-s` flag, using the name and e-mail address that are configured in Git:

```bash
git commit -s -m "fix: describe the change"
```

If you forgot, fix the last commit, or every commit of your branch, and push again:

```bash
git commit --amend --signoff --no-edit
```

```bash
git rebase --signoff origin/main
```

The **DCO** workflow ([.github/workflows/dco.yml](.github/workflows/dco.yml)) fails a pull request when a commit has no valid `Signed-off-by` trailer. Merge commits and commits authored by `github-actions[bot]`, `dependabot[bot]` and `semantic-release-bot` are exempt. You can run the same check locally:

```bash
node scripts/check-dco.mjs --base origin/main --head HEAD
```

The sign-off is recorded in the public history forever (point (d)); use a name you are willing to have recorded.

## Build and test

You need Node.js 22.12 or newer and Git. A Windows machine is needed for the installer, the native desktop shell (.NET SDK 10, WebView2 Runtime) and the PowerShell scripts, which must stay Windows PowerShell 5.1 compatible and ASCII-only. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has the complete list of prerequisites and test suites.

Hub (no build step):

```bash
cd DATGOLD-HUB
node tests/run-all.mjs
```

`run-all.mjs` runs every `tests/verify-*.mjs` suite in its own process and exits non-zero if one fails. Useful options: `--list`, `--filter <text>`, `--verbose`, and `--no-skip all` (CI uses it: a skipped suite counts as a failure). Some suites report SKIP when their prerequisites are missing; install the pinned Python packages to run them:

```bash
python -m pip install -r DATGOLD-HUB/tests/requirements-e2e.txt
```

React user interface (TypeScript, Vite):

```bash
cd DATGOLD-HUB/ui
npm ci --no-audit --no-fund
npm run build
npm run test:unit
npx playwright install chromium
npm run test:e2e
```

Windows installer payload and native pieces (see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)):

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/Test-InstallerPayload.ps1
```

A model's statement that tests pass is not evidence. Run the commands above and report what you actually ran, including what you could not run.

## Commit conventions

The history uses short, one-purpose commits with a lower-case type prefix and no scope:

```text
feat: add explicit cost rate validation and incomplete-usage ledger
fix: continue completed conversations after workspace lock cleanup
test: exercise actual CRLF injection in custom header validation
docs: document Responses protocol and preserve historic preset counts
chore: align React, native lifecycle and changelog with v3.9.0
```

- Types: `feat`, `fix`, `test`, `docs`, `chore`; `release` is reserved for maintainers' release commits.
- Write the subject in the imperative mood, lower case, without a trailing period.
- Use the body to say the cause, the evidence (which tests you ran) and what is *not* verified.
- Keep a commit to one purpose, and end it with your `Signed-off-by` line (see above).

## Pull requests

- Open the pull request against `main` and fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
- Keep it focused. Tell us which behavior changes and how you verified it.
- Documentation is tested: `verify-docs` checks links, anchors, version numbers and the suite counts quoted in the documents. A new `tests/verify-*.mjs` suite changes the count stated in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
- Pin new GitHub Actions to a full commit SHA, as the existing workflows do.

## AI-assisted contributions

DatGold itself is developed with AI coding agents, and AI-assisted pull requests are welcome under these rules:

- **You are responsible for what you submit.** Read and understand every line, and run the tests yourself. "The agent said it works" is not a review.
- **Disclose it.** Say in the pull request that an AI tool helped, which one, and roughly what it did (the template has a field for it).
- **Keep the `Co-Authored-By:` trailer** that your tool adds to commits. Do not strip it.
- **The sign-off is yours.** A tool cannot certify the DCO for you; add `Signed-off-by` (`git commit -s`) only after you reviewed the change, and only if you can truthfully make the statements (a) to (d) above, including that you are entitled to submit any code the tool reproduced from another project.
- Do not put secrets, credentials or private code into prompts, and do not commit tool transcripts that contain them.

## Security reports

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## ChatGPT Web Companion

DatGold has two modes. *Model API* mode talks to a model endpoint with your own credentials. The *ChatGPT Web Companion* drives a consumer web page (chatgpt.com) through a browser extension. That kind of automation can conflict with the website's Terms of Use, may be restricted or blocked by the provider at any time, and can break whenever the page changes. This risk belongs to the Web Companion only. Take it into account before you rely on, extend or recommend it; see the [README](README.md) for the user-facing description.
