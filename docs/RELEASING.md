# Releasing DatGold

Only the owner starts a release. Tags and GitHub Releases are never made by hand: they are made by one workflow,
[`.github/workflows/release.yml`](../.github/workflows/release.yml) ("Publish DatGold release"), which is started by hand
(`workflow_dispatch`) and does nothing on a push.

Up to v3.11.2 every release had its own `publish-vX.Y.Z.yml` that started when a commit whose message named that
release reached `main`. Those 24 files are gone: 18 of them started on **every** push to `main` and 6 on every completion of CI on
`main`, and each ended "skipped", and each one carried its version, Companion version, title and asset names typed in by hand. A commit message no longer
starts a release.

## What the workflow derives

[`scripts/Resolve-ReleaseInputs.ps1`](../scripts/Resolve-ReleaseInputs.ps1) reads every value from the commit that is built and stops the
run, listing every problem, when the files disagree:

| Value | Where it comes from | Cross-checked against |
|---|---|---|
| version `X.Y.Z` | the `version` input, or `DATGOLD-HUB/package.json` when the input is empty | `DATGOLD-HUB/package.json`, `DATGOLD-HUB/ui/package.json`, `DATGOLD-HUB/ui/package-lock.json` (top level and the root package entry), the one `<Version>` of `desktop-shell/ChatMCP.csproj` and of `installer/ChatMCP.Installer.csproj` |
| tag | `v` + version | an existing tag must point at the same commit (it is never moved) |
| Companion version | `DATGOLD-HUB/extension/manifest.json` | the `companion_version` input when given; the installed-Companion check in `scripts/tests/Test-NativeLifecycle.ps1` |
| release notes | `RELEASE-NOTES-v<version>.md` at the repository root | must exist |
| title (and tag message) | the first H1 of the notes, outside code blocks; an em or en dash becomes ` - ` | must start with `DatGold v<version> `; says `(test build)` exactly when `prerelease` is ticked |
| assets | `DatGoldSetup.exe`, `DatGold-Browser-Companion.zip`, their `.sha256` files, `RELEASE-MANIFEST.json` | the names `scripts/Build-Installer.ps1` and `scripts/Build-BrowserCompanion.ps1` write; no old-named `ChatMCP-Browser-Companion.zip` (owner's decision of 2026-10-28, from v3.11.1 on) |
| upgrade baseline | the published v3.9.0 `ChatMCPSetup.exe`, pinned by SHA-256 in the script (owner's decision) | the `digest` GitHub records for that asset, and the hash of the downloaded file |

The workflow file itself names no version; `tests/verify-ci-triggers.mjs` fails when one appears, when a `push` trigger comes back,
when `dry_run` stops defaulting to true, or when a second `publish-v*.yml` is added.

## The jobs

1. **resolve** (Linux): refuses a real release that was not started on `main`, runs the resolver, reads the baseline release record.
2. **browser** (Linux) and **windows** (Windows, about 75 minutes): the same gates as `publish-v3.11.2.yml` had: the Chromium MV3 Companion
   gate; the release-source and release-input regressions, the native unit tests and the installer payload test; the complete no-skip Hub
   suites; a fresh installer build; the real upgrade from the pinned v3.9.0 installer, the installed EXE lifecycle and uninstall; the
   WebView2 smoke and the Companion parity; then the checksums and `RELEASE-MANIFEST.json`, and the source provenance check.
3. **verify** (Linux, read-only): the regular CI (`ci.yml`) must have succeeded on this exact commit; the artifacts of this run are
   checked again by [`scripts/verify-release-assets.py`](../scripts/verify-release-assets.py) (commit, version, Companion version, the
   exact asset names, sizes, SHA-256 and `.sha256` files).
4. **publish** (Linux, the only job that may write; skipped in a dry run): checks the assets once more, refuses when `main` moved since
   the run started, creates the tag (or accepts an existing tag only when it points at this commit), creates the release as a draft with
   the notes file and the title, then publishes it as the latest release, or as a pre-release that is never the latest.

The CI gate counts the `push` run of `main` or a run of `ci.yml` started by hand on `main`; a dry run also counts the `pull_request`
run of that commit. When the commit at the top of `main` changed only documentation, `ci.yml` did not run on it: start it by hand first
(`gh workflow run ci.yml --repo pddczpl/ChatMCP --ref main`) and wait for it to pass.

## Steps for the owner

1. Prepare the release in a pull request like any other change: the version in the five files of the table, the Companion version if the
   Companion changed (then also the check in `scripts/tests/Test-NativeLifecycle.ps1`), and `RELEASE-NOTES-vX.Y.Z.md` whose first line is
   `# DatGold vX.Y.Z — what the release brings`. Check it locally:

   ~~~powershell
   powershell -NoProfile -File .\scripts\Resolve-ReleaseInputs.ps1
   ~~~

2. Merge it. Wait for `ci.yml` on that commit of `main` to pass.
3. Dry run (builds and tests everything, publishes nothing):

   ~~~powershell
   gh workflow run release.yml --repo pddczpl/ChatMCP --ref main -f dry_run=true
   ~~~

4. When the dry run is green and `main` has not moved, release (add `-f prerelease=true` for a test build):

   ~~~powershell
   gh workflow run release.yml --repo pddczpl/ChatMCP --ref main -f dry_run=false
   ~~~

   The same can be done from the Actions tab ("Publish DatGold release", "Run workflow"): leave "Dry run" ticked for step 3 and untick
   it only for step 4.
5. Sign the manifest by hand, offline, as before ([DESKTOP-APP.md](DESKTOP-APP.md#5-phát-hành-workflow-release-và-chữ-ký-của-manifest)):
   `node .\scripts\sign-release.mjs --tag vX.Y.Z --key <private key file> --installer <downloaded DatGoldSetup.exe>`, then run the
   `gh release upload` command it prints. The update-manifest signing key never goes to CI; the application offers only signed releases.

A failed or cancelled run leaves nothing behind except, at most, a tag on the right commit (the next run accepts it) or a draft release
(delete the draft before starting again: `gh release create` refuses an existing release).
