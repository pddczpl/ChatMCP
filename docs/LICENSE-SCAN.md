# License and dependency scan

> **Not legal advice.** This document is an engineering inventory prepared to support the project's decision to license its own code under the Apache License 2.0 (see [LICENSE](../LICENSE) and [NOTICE](../NOTICE)). It records what the repository's lockfiles, installed packages and build scripts say. It has not been reviewed by a lawyer, and a package's declared SPDX identifier is metadata, not a legal opinion. Have the owner's counsel confirm anything that matters, in particular the items under [Findings](#findings).

- Scanned: 2026-10-19, source commit `7f25517` (release v3.9.0), Windows 11, Node 24.19.0.
- Inputs: [CHATMCP-HUB/ui/package-lock.json](../DATGOLD-HUB/ui/package-lock.json), [scripts/intelligence-runtime/package-lock.json](../scripts/intelligence-runtime/package-lock.json), the installed `node_modules` of both (every installed package has exactly the lockfile version), the staging scripts [Build-Installer.ps1](../scripts/Build-Installer.ps1), [InstallerPayload.ps1](../scripts/InstallerPayload.ps1), [stage.mjs](../scripts/intelligence-runtime/stage.mjs) and [stage-python.ps1](../scripts/intelligence-runtime/stage-python.ps1), the `.csproj` files, and the NuGet cache copy of `Microsoft.Web.WebView2` 1.0.4258.31.
- Not done: nothing was downloaded. The CPython embeddable archive and a release `node.exe` were not available offline, so statements about their contents come from upstream documentation and are marked *(upstream, not verified here)*. No installer was built for this scan.

## Findings

**No GPL, AGPL, LGPL, SSPL or unknown-licence component is redistributed.** All 317 npm packages in the UI lockfile and all 6 entries of the intelligence-runtime lockfile declare a licence, so no licence file had to be read to fill a gap. The items that need attention are:

| # | Severity | Finding |
|---|---|---|
| 1 | Obligation not met | **`node.exe` is shipped without Node.js's LICENSE.** [Build-Installer.ps1](../scripts/Build-Installer.ps1) copies only the build machine's `node.exe` (and its `.sha256`) into `runtimes/node`. Node.js is MIT, but the binary contains V8 (BSD-3-Clause), OpenSSL (Apache-2.0), ICU (Unicode licence), zlib, c-ares, nghttp2, undici and others, whose notices Node collects in its `LICENSE` file (it is in the nodejs.org ZIP archive of each release). Ship that file next to `node.exe`. The Node version is whatever is on the build machine's PATH (the release workflow uses Node 24); it is not pinned. |
| 2 | Obligation not met | **The installer ships no notice for Microsoft.Web.WebView2.** `ChatMCP.exe` bundles `Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll` and `WebView2Loader.dll` (package 1.0.4258.31, a Microsoft BSD-3-Clause-style licence whose `LICENSE.txt` requires reproducing the copyright notice and disclaimer for binary redistribution). The package `NOTICE.txt` additionally lists Antlr3.Runtime 3.5.2-rc1 and StringTemplate4 4.0.9-rc1 (BSD-3-Clause). None of this text is in the payload. |
| 3 | Obligation not met | **The OFL-1.1 fonts ship without their licence text.** `web/dist/assets` contains Inter (variable, `@fontsource-variable/inter` 5.3.0) and JetBrains Mono (400, `@fontsource/jetbrains-mono` 5.3.0) as `.woff2`/`.woff` files. The SIL Open Font License 1.1 requires the copyright notice and licence text to accompany the font files; the `LICENSE` files of the two packages are not copied into the build output or the payload. |
| 4 | Obligation not met | **MIT/ISC/BSD/0BSD notices of the bundled UI libraries are not shipped.** The Vite bundle compiles in up to 167 production packages (161 MIT, 2 ISC, 1 BSD-3-Clause, 1 0BSD, 2 OFL-1.1). In the built bundle only React and lucide-react keep a licence comment (`@license` banners; none in the vendor chunk), and `node_modules` is not shipped, so recipients get no copyright and permission notice for the others. The only notice file installed is the archived [CHATMCP-HUB/THIRD-PARTY-NOTICES.txt](../DATGOLD-HUB/THIRD-PARTY-NOTICES.txt) (see [Notice files that need an update](#notice-files)). `react-remove-scroll-bar` declares MIT but its package contains no LICENSE file. |
| 5 | Obligation not met | **The Tree-sitter grammars' own MIT notices are not shipped.** `stage.mjs` copies four compiled grammars (`javascript`, `typescript`, `tsx`, `python`) out of `tree-sitter-wasms` 0.1.13 and only that package's LICENSE (Unlicense, which covers the packaging, not the grammars) into `licenses/tree-sitter-wasms/`. The grammars are compiled from the upstream tree-sitter-javascript, tree-sitter-typescript and tree-sitter-python projects, which are MIT-licensed *(upstream, not verified here)* and require their copyright notice to be kept. |
| 6 | To verify at build | **Embedded CPython 3.11.9 (PSF-2.0) and the Microsoft Visual C++ runtime.** The embeddable archive carries `LICENSE.txt` *(upstream, not verified here)* and also contains `vcruntime140.dll` / `vcruntime140_1.dll`, Microsoft's redistributable C++ runtime, which is proprietary (not OSI-approved) and may be redistributed only under Microsoft's redistribution terms. It also contains OpenSSL 3.x (Apache-2.0), SQLite (public domain), libffi (MIT), expat (MIT), zlib, bzip2, liblzma and mpdecimal *(upstream, not verified here)*. [stage-python.ps1](../scripts/intelligence-runtime/stage-python.ps1) extracts every file of the pinned archive (SHA-256 checked) but does not assert that `LICENSE.txt` is present; add that assertion and list the Microsoft runtime terms in the notices. |
| 7 | Check | **Brand assets.** `assets/icons/*`, `web/chatmcp-logo.png` and `web/favicon.ico` are drawn by [scripts/generate-brand-icon.py](../scripts/generate-brand-icon.py) (Pillow, original geometry), so they fall under the repository licence. The owner should confirm that nothing in them is third-party artwork. Apache-2.0 section 6 grants no trademark rights: the DatGold name and logo are not licensed for use as a brand. |
| 8 | Info | **Not redistributed, so no obligations, but never bundle:** Git for Windows (GPL-2.0; a prerequisite the user installs), Microsoft Edge / Chromium and the WebView2 Runtime (Microsoft terms), and `node-pty` (MIT, installed by the user from npm on request by [Install-OptionalConPTY.ps1](../DATGOLD-HUB/windows/Install-OptionalConPTY.ps1)). If a later release bundles Git or any GPL/LGPL component this scan must be redone first. |
| 9 | Info | **Build-only copyleft and data licences.** 12 `lightningcss*` packages (MPL-2.0, file-level copyleft; a dependency of the Tailwind CSS 4 build) and `caniuse-lite` (CC-BY-4.0 data) are devDependencies of the UI build. They are not in the production closure and not in the payload. Shipping `node_modules` would add MPL source-availability and CC-BY attribution duties. |

Other points: the DCO and the Apache-2.0 `NOTICE` are explained in [CONTRIBUTING.md](../CONTRIBUTING.md). The installer payload now carries `LICENSE` and `NOTICE` at the install root. The Browser Companion archive `DatGold-Browser-Companion.zip` (also published as a copy under its old name `ChatMCP-Browser-Companion.zip`; built by [Build-BrowserCompanion.ps1](../scripts/Build-BrowserCompanion.ps1)) is a separate download that contains the extension sources only and **does not yet include `LICENSE` or `NOTICE`**; its exact-contents check has to be changed together with the file list.

## Compatibility rules used

The DatGold code is Apache-2.0. A component is marked compatible when it may be redistributed together with Apache-2.0 code without relicensing either side.

| Licence | Verdict | Duty that travels with a redistribution |
|---|---|---|
| MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Zlib | Compatible | Keep the copyright and licence text (0BSD and Zlib need none in binary form). |
| Apache-2.0 | Compatible | Give recipients the licence and keep the NOTICE text (section 4). |
| Unlicense, CC0-1.0, public domain | Compatible | None. |
| PSF-2.0 (CPython) | Compatible | Keep the PSF licence text and copyright notice. |
| OFL-1.1 (fonts) | Compatible for bundling with software; the fonts stay under OFL | Copyright notice and licence text with the font files; the fonts may not be sold on their own; no Reserved Font Name for modified fonts. |
| MPL-2.0 | Compatible; file-level copyleft | Only if MPL files are distributed or modified: keep those files under MPL and offer their source. |
| CC-BY-4.0 (data) | Not a software licence | Attribution. |
| GPL-2.0-only, GPL-3.0, AGPL, LGPL, SSPL, proprietary, no licence | **Flagged** (GPL-2.0-only is incompatible with Apache-2.0; GPL-3.0 may include Apache-2.0 code but not the reverse) | Must not be bundled without a decision by the owner. |

## Redistributed components

"Redistributed" means present in the `DatGoldSetup.exe` payload (`ChatMCPSetup.exe` up to v3.10.2) (see [InstallerPayload.ps1](../scripts/InstallerPayload.ps1) and [Build-Installer.ps1](../scripts/Build-Installer.ps1)) or in a separate release download.

| Component | Version | Licence | Apache-2.0 compatible | Notes |
|---|---|---|---|---|
| DatGold (Hub, UI sources, scripts, Browser Companion, desktop shell, installer) | 3.9.0 | Apache-2.0 | - | Own code; contributions under the DCO, no CLA. |
| Portable Node.js (`runtimes/node/node.exe`) | the build machine's (release workflow: 24.x; scan machine 24.19.0) | MIT, with bundled V8 (BSD-3-Clause), OpenSSL (Apache-2.0), ICU and others | Yes | Finding 1: LICENSE file missing. |
| Embedded CPython (`runtimes/python`) | 3.11.9 (embeddable amd64, SHA-256 pinned in stage-python.ps1) | PSF-2.0 plus bundled libraries *(upstream, not verified here)* | Yes; the Microsoft VC++ runtime DLLs are proprietary redistributables | Finding 6; the terms of the runtime DLLs are summarised in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md). |
| ripgrep (`CHATMCP-HUB/runtimes/ripgrep/rg.exe`) | 15.2.0 (x86_64-pc-windows-msvc, SHA-256 pinned in stage-ripgrep.ps1) | MIT OR Unlicense *(upstream, not verified here)*; the binary also contains PCRE2 (BSD-3-Clause) and Rust crates | Yes | Its LICENSE-MIT and UNLICENSE are staged from the archive and required by the build. The texts of PCRE2 10.46, of the Rust standard library of the toolchain that built `rg.exe` (1.99.0-nightly (da80ed070 2026-07-14), derived from the release record) and of the Rust crates linked into it (30 of ripgrep's lock file, 2 more of the standard library), which the archive does not carry, are vendored in `scripts/intelligence-runtime/licenses/ripgrep/` (inventory: `MANIFEST.json`), staged as `licenses/ripgrep/` and required by `stage.mjs`, `verify.mjs` and the installer build; the installer build also looks in the bytes of `rg.exe` for the PCRE2 version string of the notice (`10.46 2025-08-27`) and for the source paths of the Rust toolchain, and checks that its import table names no C runtime DLL. The static Microsoft C runtime inside `rg.exe` and the runtime DLLs of the CPython archive are named in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) with a summary of the terms that Microsoft publishes (the text is not reproduced). |
| `pyright` (bundled intelligence runtime) | 1.1.407 | MIT | Yes | Contains the typeshed stubs (Apache-2.0 and MIT; its licence file `dist/typeshed-fallback/LICENSE` ships inside the package). No aggregated third-party notice of its own. |
| `tree-sitter-wasms` (bundled intelligence runtime) | 0.1.13 | Unlicense | Yes | Only 4 of its grammars are staged; finding 5. |
| `typescript` (bundled intelligence runtime) | 5.9.3 | Apache-2.0 | Yes | Ships LICENSE.txt and ThirdPartyNoticeText.txt inside the package. |
| `typescript-language-server` (bundled intelligence runtime) | 4.3.4 | Apache-2.0 | Yes | Apache-2.0 with portions copied from VS Code (MIT); both texts are in its LICENSE file, which ships. |
| `web-tree-sitter` (bundled intelligence runtime) | 0.25.10 | MIT | Yes | WASM runtime used for syntax parsing. |
| `playwright`, `playwright-core` (staged to `runtimes/browser/node_modules`) | 1.64.0 | Apache-2.0 | Yes | Whole package folders are copied, including LICENSE and NOTICE (and `ThirdPartyNotices.txt` in playwright-core). Browser executables are not bundled. They are devDependencies in the UI lockfile but are redistributed. |
| Microsoft.Web.WebView2 (managed DLLs and `WebView2Loader.dll`) | 1.0.4258.31 | Microsoft BSD-3-Clause-style licence; NOTICE adds Antlr3.Runtime and StringTemplate4 (BSD-3-Clause) | Yes | Finding 2. The WebView2 *Runtime* itself is a separate Microsoft installation and is not bundled. |
| .NET 10 runtime and base libraries inside `ChatMCP.exe`, `DatGoldSetup.exe` / `Uninstall.exe` (self-contained single files) and `GuestSupervisor.exe` (Native AOT) | 10.0.x | MIT | Yes | The runtime's own third-party notice file is not shipped. |
| UI bundle (`CHATMCP-HUB/web/dist/assets/*.js`, `*.css`) | see [UI production packages](#ui-production-packages-compiled-into-webdist) | MIT (161), OFL-1.1 (2), ISC (2), BSD-3-Clause (1), 0BSD (1) | Yes | Finding 4. The Tailwind CSS banner and the `@license` comments of React and lucide-react survive the build. |
| Inter variable and JetBrains Mono 400 web fonts (`web/dist/assets/*.woff2`, `*.woff`) | 5.3.0 and 5.3.0 (Fontsource packages) | OFL-1.1 | Yes, as separate font files | Finding 3. Inter: Copyright 2016 The Inter Project Authors. JetBrains Mono: Copyright 2020 The JetBrains Mono Project Authors. |
| React 16.0.0 and ReactDOM 16.0.1 UMD (`web/vendor/*.production.min.js`, legacy pages; ReactDOM includes Modernizr) | 16.0.x | MIT | Yes | Upstream headers are intact and the MIT text is in the archived notice file. Old releases: remove them together with the legacy dashboards. |
| Icons and logo (`assets/icons`, `web/chatmcp-logo.png`, `web/favicon.ico`) | - | Apache-2.0 (own work) | - | Finding 7. |

## Not redistributed

| Component | Why it is not redistributed | Licence |
|---|---|---|
| UI devDependencies (150 packages: Vite, Tailwind CSS, TypeScript for the UI, `@types/*`, test runner and their dependencies) | Build and test only; `node_modules` is excluded from the payload. The exceptions are `playwright` and `playwright-core`, listed above. | MIT (124), MPL-2.0 (12), Apache-2.0 (6), ISC (6), CC-BY-4.0 (1), BSD-3-Clause (1) |
| `node-pty` | Optional; downloaded from npm into the user's Hub folder at the user's request ([Install-OptionalConPTY.ps1](../DATGOLD-HUB/windows/Install-OptionalConPTY.ps1)); only declared as `optionalDependencies` in [CHATMCP-HUB/package.json](../DATGOLD-HUB/package.json). | MIT *(upstream, not verified here)* |
| Python test dependencies in [requirements-e2e.txt](../DATGOLD-HUB/tests/requirements-e2e.txt) and [requirements-ui.txt](../DATGOLD-HUB/tests/requirements-ui.txt): fastapi 0.115.0, uvicorn 0.30.0, httpx 0.28.1, pytest 8.4.2, playwright 1.63.0 | Test only | MIT, BSD-3-Clause, BSD-3-Clause, MIT, Apache-2.0 *(upstream, not verified here)* |
| .NET SDK, the test projects ([NativeLifecycle.Tests.csproj](../scripts/tests/native-lifecycle/NativeLifecycle.Tests.csproj), [Smoke.csproj](../DATGOLD-HUB/ui/e2e/windows-webview2/Smoke.csproj)), GitHub Actions | Build and CI only | MIT and various |
| Git for Windows, Microsoft Edge or Chromium, Microsoft Edge WebView2 Runtime, Ollama / LM Studio, model-provider services | Separate installations, required or optional for use | GPL-2.0 (Git for Windows) and vendor terms |
| Imported Agent Skills | Content the user imports at run time from third-party repositories | Their own licences, shown as evidence in the Skills UI and never assumed to be redistributable |

## Status of the findings after the notice work

Findings 1, 5 and 6 were addressed in the build scripts; the rest are open. `DATGOLD-HUB/tests/verify-notices.mjs` checks the items marked "tested".

| # | State | What changed, what is left |
|---|---|---|
| 1 | Fixed in the build, not run end to end | [InstallerPayload.ps1](../scripts/InstallerPayload.ps1) `Copy-InstallerNodeLicense` copies the `LICENSE` that sits beside `node.exe` (or the file named by `CHATMCP_NODE_LICENSE_FILE`) to `runtimes/node/LICENSE` and refuses a build without a genuine Node.js text; [Build-Installer.ps1](../scripts/Build-Installer.ps1) calls it. Tested in [Test-InstallerPayload.ps1](../scripts/tests/Test-InstallerPayload.ps1) (tested). A Node.js installed by the MSI has no `LICENSE` beside `node.exe`, so such a machine needs `CHATMCP_NODE_LICENSE_FILE`; the Node.js ZIP distribution (what `setup-node` uses) carries it. `Build-Installer.ps1` itself was not run here (it cannot finish on this machine). The Node.js version is still not pinned. |
| 2 | Open | WebView2 `LICENSE` and `NOTICE` are still not shipped. The entry exists in the notice files as "pending" (tested). |
| 3 | Open | OFL texts of the two fonts still not shipped; entry marked "pending" (tested). |
| 4 | Open | The MIT, ISC, BSD and 0BSD notices of the UI libraries are still not shipped. [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) now lists all 167 production packages with version and license, generated from the lockfile by [generate-licenses.mjs](../scripts/generate-licenses.mjs) (tested against the lockfile). |
| 5 | Fixed in the build | [notices.mjs](../scripts/intelligence-runtime/notices.mjs), [stage.mjs](../scripts/intelligence-runtime/stage.mjs) and [verify.mjs](../scripts/intelligence-runtime/verify.mjs) stage `licenses/<upstream>/LICENSE` for tree-sitter-javascript, tree-sitter-typescript (also behind `tsx`) and tree-sitter-python from `scripts/intelligence-runtime/licenses/`, refuse a staging without them and refuse a staged runtime without them (tested on fixtures). The three upstream MIT texts have been in that folder since commit `106f649` (2026-10-19): they were copied unchanged from the default branch of each upstream repository, not written from memory. The grammar versions inside `tree-sitter-wasms` are not recorded in its package, so they are the texts of the upstream default branch and not of the exact versions compiled into the grammars. `ci.yml` no longer sets `CHATMCP_ALLOW_PENDING_NOTICES`, so the installer jobs run the real `stage.mjs` and `verify.mjs` with the notices required, and the suite fails if a workflow sets the variable again. The option stays in `notices.mjs` and `stage.mjs` for builds that are not releases (it stages `licenses/PENDING-NOTICES.txt` and records `pendingNotices` in the manifest); no workflow uses it. |
| 6 | Partly fixed | [stage-python.ps1](../scripts/intelligence-runtime/stage-python.ps1) now requires `LICENSE.txt` in the archive and that it is the PSF text; `stage.mjs` and `verify.mjs` assert it again in the staged runtime (tested on fixtures; the PowerShell assertion itself was only parse-checked here because the archive was not available offline). The check string was taken from the `LICENSE.txt` of a local CPython 3.11.9 installation, not from the embeddable archive. The notice files list CPython and the Microsoft Visual C++ runtime; the Microsoft redistribution terms are named, not reproduced. |

## Notice files

| File | State |
|---|---|
| [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | The canonical inventory: the Apache-2.0 statement, one row per redistributed component with version, license, the place of its license text and a status, the pending notices, and the generated list of UI packages. It is shipped at the root of the installation next to `LICENSE` and `NOTICE`. |
| `THIRD_PARTY_NOTICES.md` (underscores) | Removed. It listed the 31 direct dependencies of the UI (development tools included) as if they were bundled and called all dependencies permissive. Nothing but `generate-licenses.mjs` and this document referred to it. |
| [CHATMCP-HUB/THIRD-PARTY-NOTICES.txt](../DATGOLD-HUB/THIRD-PARTY-NOTICES.txt) | Replaced by a current plain-text companion with the same component list. It stays a separate file because installed copies, [NOTICE](../NOTICE) and the installer payload rule name it; it keeps the MIT permission text of the React 16 files that the legacy dashboards ship. The archived 1.x text is in Git history. |

## Recommended follow-up

1. Ship the texts of findings 2 to 4 (WebView2, the OFL fonts, the notices of the UI libraries) and the .NET runtime notice, and pin the Node.js version.
2. Add `LICENSE` and `NOTICE` to `DatGold-Browser-Companion.zip` ([Build-BrowserCompanion.ps1](../scripts/Build-BrowserCompanion.ps1) allow-list and its exact-contents check).
3. Re-run this scan when a dependency is added or upgraded, and make CI fail on a license that is not in the tables below (the generated list in `THIRD-PARTY-NOTICES.md` already fails the suite when the UI lockfile changes).

## UI production packages (compiled into web/dist)

167 packages from the production dependency closure of [CHATMCP-HUB/ui/package.json](../DATGOLD-HUB/ui/package.json) (`"dev": false` in the lockfile). Tree shaking means the bundle contains only the parts that are imported, so this is an upper bound. Licence = the `license` field of the lockfile entry; the installed package.json agrees in every case.

| Package | Version | Licence | Apache-2.0 compatible |
|---|---|---|---|
| `@floating-ui/core` | 1.8.0 | MIT | Yes |
| `@floating-ui/dom` | 1.8.0 | MIT | Yes |
| `@floating-ui/react-dom` | 2.1.9 | MIT | Yes |
| `@floating-ui/utils` | 0.2.12 | MIT | Yes |
| `@fontsource-variable/inter` | 5.3.0 | OFL-1.1 | Yes - font notice and license text must accompany the font files |
| `@fontsource/jetbrains-mono` | 5.3.0 | OFL-1.1 | Yes - font notice and license text must accompany the font files |
| `@radix-ui/number` | 1.1.3 | MIT | Yes |
| `@radix-ui/primitive` | 1.1.7 | MIT | Yes |
| `@radix-ui/react-alert-dialog` | 1.1.24 | MIT | Yes |
| `@radix-ui/react-arrow` | 1.1.16 | MIT | Yes |
| `@radix-ui/react-collection` | 1.1.16 | MIT | Yes |
| `@radix-ui/react-compose-refs` | 1.1.5 | MIT | Yes |
| `@radix-ui/react-context` | 1.2.2 | MIT | Yes |
| `@radix-ui/react-dialog` | 1.2.0 | MIT | Yes |
| `@radix-ui/react-direction` | 1.1.5 | MIT | Yes |
| `@radix-ui/react-dismissable-layer` | 1.1.20 | MIT | Yes |
| `@radix-ui/react-dropdown-menu` | 2.1.25 | MIT | Yes |
| `@radix-ui/react-focus-guards` | 1.1.6 | MIT | Yes |
| `@radix-ui/react-focus-scope` | 1.2.0 | MIT | Yes |
| `@radix-ui/react-id` | 1.1.4 | MIT | Yes |
| `@radix-ui/react-menu` | 2.1.25 | MIT | Yes |
| `@radix-ui/react-popover` | 1.2.0 | MIT | Yes |
| `@radix-ui/react-popper` | 1.3.8 | MIT | Yes |
| `@radix-ui/react-portal` | 1.1.18 | MIT | Yes |
| `@radix-ui/react-presence` | 1.1.11 | MIT | Yes |
| `@radix-ui/react-primitive` | 2.1.11 | MIT | Yes |
| `@radix-ui/react-roving-focus` | 1.1.20 | MIT | Yes |
| `@radix-ui/react-scroll-area` | 1.3.0 | MIT | Yes |
| `@radix-ui/react-slot` | 1.4.0 | MIT | Yes |
| `@radix-ui/react-tabs` | 1.1.22 | MIT | Yes |
| `@radix-ui/react-tooltip` | 1.3.0 | MIT | Yes |
| `@radix-ui/react-use-callback-ref` | 1.1.4 | MIT | Yes |
| `@radix-ui/react-use-controllable-state` | 1.2.6 | MIT | Yes |
| `@radix-ui/react-use-effect-event` | 0.0.5 | MIT | Yes |
| `@radix-ui/react-use-is-hydrated` | 0.1.3 | MIT | Yes |
| `@radix-ui/react-use-layout-effect` | 1.1.4 | MIT | Yes |
| `@radix-ui/react-use-rect` | 1.1.4 | MIT | Yes |
| `@radix-ui/react-use-size` | 1.1.5 | MIT | Yes |
| `@radix-ui/react-visually-hidden` | 1.2.12 | MIT | Yes |
| `@radix-ui/rect` | 1.1.3 | MIT | Yes |
| `@tanstack/query-core` | 5.104.1 | MIT | Yes |
| `@tanstack/react-query` | 5.104.1 | MIT | Yes |
| `@tanstack/react-virtual` | 3.14.15 | MIT | Yes |
| `@tanstack/virtual-core` | 3.19.0 | MIT | Yes |
| `@types/debug` | 4.1.13 | MIT | Yes |
| `@types/estree` | 1.0.9 | MIT | Yes |
| `@types/estree-jsx` | 1.0.5 | MIT | Yes |
| `@types/hast` | 3.0.5 | MIT | Yes |
| `@types/mdast` | 4.0.4 | MIT | Yes |
| `@types/ms` | 2.1.0 | MIT | Yes |
| `@types/react` | 19.3.0 | MIT | Yes |
| `@types/react-dom` | 19.3.0 | MIT | Yes |
| `@types/unist` | 3.0.3 | MIT | Yes |
| `@types/unist` | 2.0.11 | MIT | Yes |
| `@ungap/structured-clone` | 1.4.0 | ISC | Yes |
| `aria-hidden` | 1.2.6 | MIT | Yes |
| `bail` | 2.0.2 | MIT | Yes |
| `ccount` | 2.0.1 | MIT | Yes |
| `character-entities` | 2.0.2 | MIT | Yes |
| `character-entities-html4` | 2.1.0 | MIT | Yes |
| `character-entities-legacy` | 3.0.0 | MIT | Yes |
| `character-reference-invalid` | 2.0.1 | MIT | Yes |
| `clsx` | 2.1.1 | MIT | Yes |
| `cmdk` | 1.1.1 | MIT | Yes |
| `comma-separated-tokens` | 2.0.3 | MIT | Yes |
| `csstype` | 3.2.3 | MIT | Yes |
| `debug` | 4.4.3 | MIT | Yes |
| `decode-named-character-reference` | 1.3.0 | MIT | Yes |
| `dequal` | 2.0.3 | MIT | Yes |
| `detect-node-es` | 1.1.0 | MIT | Yes |
| `devlop` | 1.1.0 | MIT | Yes |
| `diff` | 7.0.0 | BSD-3-Clause | Yes |
| `escape-string-regexp` | 5.0.0 | MIT | Yes |
| `estree-util-is-identifier-name` | 3.0.0 | MIT | Yes |
| `extend` | 3.0.2 | MIT | Yes |
| `get-nonce` | 1.0.1 | MIT | Yes |
| `hast-util-to-jsx-runtime` | 2.3.6 | MIT | Yes |
| `hast-util-whitespace` | 3.0.0 | MIT | Yes |
| `html-url-attributes` | 3.0.1 | MIT | Yes |
| `inline-style-parser` | 0.2.7 | MIT | Yes |
| `is-alphabetical` | 2.0.1 | MIT | Yes |
| `is-alphanumerical` | 2.0.1 | MIT | Yes |
| `is-decimal` | 2.0.1 | MIT | Yes |
| `is-hexadecimal` | 2.0.1 | MIT | Yes |
| `is-plain-obj` | 4.1.0 | MIT | Yes |
| `longest-streak` | 3.1.0 | MIT | Yes |
| `lucide-react` | 0.468.0 | ISC | Yes |
| `markdown-table` | 3.0.4 | MIT | Yes |
| `mdast-util-find-and-replace` | 3.0.3 | MIT | Yes |
| `mdast-util-from-markdown` | 2.1.0 | MIT | Yes |
| `mdast-util-gfm` | 3.1.0 | MIT | Yes |
| `mdast-util-gfm-autolink-literal` | 2.0.1 | MIT | Yes |
| `mdast-util-gfm-footnote` | 2.1.0 | MIT | Yes |
| `mdast-util-gfm-strikethrough` | 2.0.1 | MIT | Yes |
| `mdast-util-gfm-table` | 2.0.0 | MIT | Yes |
| `mdast-util-gfm-task-list-item` | 2.0.0 | MIT | Yes |
| `mdast-util-mdx-expression` | 2.0.1 | MIT | Yes |
| `mdast-util-mdx-jsx` | 3.2.0 | MIT | Yes |
| `mdast-util-mdxjs-esm` | 2.0.1 | MIT | Yes |
| `mdast-util-phrasing` | 4.1.0 | MIT | Yes |
| `mdast-util-to-hast` | 13.2.1 | MIT | Yes |
| `mdast-util-to-markdown` | 2.2.0 | MIT | Yes |
| `mdast-util-to-string` | 4.0.0 | MIT | Yes |
| `micromark` | 4.0.3 | MIT | Yes |
| `micromark-core-commonmark` | 2.0.4 | MIT | Yes |
| `micromark-extension-gfm` | 3.0.0 | MIT | Yes |
| `micromark-extension-gfm-autolink-literal` | 2.1.0 | MIT | Yes |
| `micromark-extension-gfm-footnote` | 2.1.0 | MIT | Yes |
| `micromark-extension-gfm-strikethrough` | 2.1.0 | MIT | Yes |
| `micromark-extension-gfm-table` | 2.1.2 | MIT | Yes |
| `micromark-extension-gfm-tagfilter` | 2.0.0 | MIT | Yes |
| `micromark-extension-gfm-task-list-item` | 2.1.0 | MIT | Yes |
| `micromark-factory-destination` | 2.0.1 | MIT | Yes |
| `micromark-factory-label` | 2.0.1 | MIT | Yes |
| `micromark-factory-space` | 2.1.0 | MIT | Yes |
| `micromark-factory-title` | 2.0.1 | MIT | Yes |
| `micromark-factory-whitespace` | 2.0.1 | MIT | Yes |
| `micromark-util-character` | 2.1.1 | MIT | Yes |
| `micromark-util-chunked` | 2.0.1 | MIT | Yes |
| `micromark-util-classify-character` | 2.0.1 | MIT | Yes |
| `micromark-util-combine-extensions` | 2.0.1 | MIT | Yes |
| `micromark-util-decode-numeric-character-reference` | 2.0.2 | MIT | Yes |
| `micromark-util-decode-string` | 2.0.1 | MIT | Yes |
| `micromark-util-edit-map` | 1.0.0 | MIT | Yes |
| `micromark-util-encode` | 2.0.1 | MIT | Yes |
| `micromark-util-html-tag-name` | 2.0.1 | MIT | Yes |
| `micromark-util-normalize-identifier` | 2.0.1 | MIT | Yes |
| `micromark-util-resolve-all` | 2.0.1 | MIT | Yes |
| `micromark-util-sanitize-uri` | 2.0.1 | MIT | Yes |
| `micromark-util-subtokenize` | 2.1.0 | MIT | Yes |
| `micromark-util-symbol` | 2.0.1 | MIT | Yes |
| `micromark-util-types` | 2.0.3 | MIT | Yes |
| `ms` | 2.1.3 | MIT | Yes |
| `parse-entities` | 4.0.2 | MIT | Yes |
| `property-information` | 7.2.0 | MIT | Yes |
| `react` | 19.3.0 | MIT | Yes |
| `react-dom` | 19.3.0 | MIT | Yes |
| `react-markdown` | 9.1.0 | MIT | Yes |
| `react-remove-scroll` | 2.7.2 | MIT | Yes |
| `react-remove-scroll-bar` | 2.3.8 | MIT | Yes |
| `react-resizable-panels` | 2.1.9 | MIT | Yes |
| `react-style-singleton` | 2.2.3 | MIT | Yes |
| `remark-gfm` | 4.0.1 | MIT | Yes |
| `remark-parse` | 11.0.0 | MIT | Yes |
| `remark-rehype` | 11.1.2 | MIT | Yes |
| `remark-stringify` | 11.0.0 | MIT | Yes |
| `scheduler` | 0.28.0 | MIT | Yes |
| `space-separated-tokens` | 2.0.2 | MIT | Yes |
| `stringify-entities` | 4.0.4 | MIT | Yes |
| `style-to-js` | 1.1.21 | MIT | Yes |
| `style-to-object` | 1.0.14 | MIT | Yes |
| `tailwind-merge` | 2.6.1 | MIT | Yes |
| `trim-lines` | 3.0.1 | MIT | Yes |
| `trough` | 2.2.0 | MIT | Yes |
| `tslib` | 2.8.1 | 0BSD | Yes |
| `unified` | 11.0.5 | MIT | Yes |
| `unist-util-is` | 6.0.1 | MIT | Yes |
| `unist-util-position` | 5.0.0 | MIT | Yes |
| `unist-util-stringify-position` | 4.0.0 | MIT | Yes |
| `unist-util-visit` | 5.1.0 | MIT | Yes |
| `unist-util-visit-parents` | 6.0.2 | MIT | Yes |
| `use-callback-ref` | 1.3.3 | MIT | Yes |
| `use-sidecar` | 1.1.3 | MIT | Yes |
| `vfile` | 6.0.3 | MIT | Yes |
| `vfile-message` | 4.0.3 | MIT | Yes |
| `zustand` | 5.0.15 | MIT | Yes |
| `zwitch` | 2.0.4 | MIT | Yes |

## Bundled intelligence runtime (every lockfile entry is staged)

[stage.mjs](../scripts/intelligence-runtime/stage.mjs) copies every package of [scripts/intelligence-runtime/package-lock.json](../scripts/intelligence-runtime/package-lock.json), transitive packages included (there are none beyond the five direct ones). `fsevents` is an optional macOS-only entry and is skipped on Windows.

| Package | Version | Licence | Apache-2.0 compatible | Licence file in package |
|---|---|---|---|---|
| `fsevents` | 2.3.3 | MIT | Yes | not staged |
| `pyright` | 1.1.407 | MIT | Yes | LICENSE.txt |
| `tree-sitter-wasms` | 0.1.13 | Unlicense | Yes | LICENSE |
| `typescript` | 5.9.3 | Apache-2.0 | Yes | LICENSE.txt |
| `typescript-language-server` | 4.3.4 | Apache-2.0 | Yes | LICENSE |
| `web-tree-sitter` | 0.25.10 | MIT | Yes | LICENSE |

## UI build-only packages (not redistributed)

<details><summary>150 devDependency packages by licence</summary>

**MIT** (124): @babel/code-frame 7.29.7, @babel/compat-data 7.29.7, @babel/core 7.29.7, @babel/generator 7.29.8, @babel/helper-compilation-targets 7.29.7, @babel/helper-globals 7.29.7, @babel/helper-module-imports 7.29.7, @babel/helper-module-transforms 7.29.7, @babel/helper-plugin-utils 7.29.7, @babel/helper-string-parser 7.29.7, @babel/helper-validator-identifier 7.29.7, @babel/helper-validator-option 7.29.7, @babel/helpers 7.29.10, @babel/parser 7.29.9, @babel/plugin-transform-react-jsx-self 7.29.7, @babel/plugin-transform-react-jsx-source 7.29.7, @babel/template 7.29.7, @babel/traverse 7.29.10, @babel/types 7.29.8, @esbuild/aix-ppc64 0.25.12, @esbuild/android-arm 0.25.12, @esbuild/android-arm64 0.25.12, @esbuild/android-x64 0.25.12, @esbuild/darwin-arm64 0.25.12, @esbuild/darwin-x64 0.25.12, @esbuild/freebsd-arm64 0.25.12, @esbuild/freebsd-x64 0.25.12, @esbuild/linux-arm 0.25.12, @esbuild/linux-arm64 0.25.12, @esbuild/linux-ia32 0.25.12, @esbuild/linux-loong64 0.25.12, @esbuild/linux-mips64el 0.25.12, @esbuild/linux-ppc64 0.25.12, @esbuild/linux-riscv64 0.25.12, @esbuild/linux-s390x 0.25.12, @esbuild/linux-x64 0.25.12, @esbuild/netbsd-arm64 0.25.12, @esbuild/netbsd-x64 0.25.12, @esbuild/openbsd-arm64 0.25.12, @esbuild/openbsd-x64 0.25.12, @esbuild/openharmony-arm64 0.25.12, @esbuild/sunos-x64 0.25.12, @esbuild/win32-arm64 0.25.12, @esbuild/win32-ia32 0.25.12, @esbuild/win32-x64 0.25.12, @jridgewell/gen-mapping 0.3.13, @jridgewell/remapping 2.3.5, @jridgewell/resolve-uri 3.1.2, @jridgewell/sourcemap-codec 1.6.0, @jridgewell/trace-mapping 0.3.31, @napi-rs/lzma-linux-x64-gnu 1.5.1, @rolldown/pluginutils 1.0.0-beta.27, @rollup/rollup-android-arm-eabi 4.64.5, @rollup/rollup-android-arm64 4.64.5, @rollup/rollup-darwin-arm64 4.64.5, @rollup/rollup-darwin-x64 4.64.5, @rollup/rollup-freebsd-arm64 4.64.5, @rollup/rollup-freebsd-x64 4.64.5, @rollup/rollup-linux-arm-gnueabihf 4.64.5, @rollup/rollup-linux-arm-musleabihf 4.64.5, @rollup/rollup-linux-arm64-gnu 4.64.5, @rollup/rollup-linux-arm64-musl 4.64.5, @rollup/rollup-linux-loong64-gnu 4.64.5, @rollup/rollup-linux-loong64-musl 4.64.5, @rollup/rollup-linux-ppc64-gnu 4.64.5, @rollup/rollup-linux-ppc64-musl 4.64.5, @rollup/rollup-linux-riscv64-gnu 4.64.5, @rollup/rollup-linux-riscv64-musl 4.64.5, @rollup/rollup-linux-s390x-gnu 4.64.5, @rollup/rollup-linux-x64-gnu 4.64.5, @rollup/rollup-linux-x64-musl 4.64.5, @rollup/rollup-openbsd-x64 4.64.5, @rollup/rollup-openharmony-arm64 4.64.5, @rollup/rollup-win32-arm64-msvc 4.64.5, @rollup/rollup-win32-ia32-msvc 4.64.5, @rollup/rollup-win32-x64-gnu 4.64.5, @rollup/rollup-win32-x64-msvc 4.64.5, @tailwindcss/node 4.3.3, @tailwindcss/oxide 4.3.3, @tailwindcss/oxide-android-arm64 4.3.3, @tailwindcss/oxide-darwin-arm64 4.3.3, @tailwindcss/oxide-darwin-x64 4.3.3, @tailwindcss/oxide-freebsd-x64 4.3.3, @tailwindcss/oxide-linux-arm-gnueabihf 4.3.3, @tailwindcss/oxide-linux-arm64-gnu 4.3.3, @tailwindcss/oxide-linux-arm64-musl 4.3.3, @tailwindcss/oxide-linux-x64-gnu 4.3.3, @tailwindcss/oxide-linux-x64-musl 4.3.3, @tailwindcss/oxide-wasm32-wasi 4.3.3, @tailwindcss/oxide-win32-arm64-msvc 4.3.3, @tailwindcss/oxide-win32-x64-msvc 4.3.3, @tailwindcss/vite 4.3.3, @types/babel__core 7.20.5, @types/babel__generator 7.27.0, @types/babel__template 7.4.4, @types/babel__traverse 7.28.0, @types/diff 7.0.2, @types/node 22.20.5, @vitejs/plugin-react 4.7.0, browserslist 4.29.3, convert-source-map 2.0.0, enhanced-resolve 5.26.0, esbuild 0.25.12, escalade 3.2.0, fdir 6.5.0, fsevents 2.3.3, gensync 1.0.0-beta.2, jiti 2.7.0, js-tokens 4.0.0, jsesc 3.1.0, json5 2.2.3, magic-string 0.30.21, nanoid 3.3.20, node-releases 2.0.58, picomatch 4.0.7, postcss 8.5.29, react-refresh 0.17.0, rollup 4.64.5, tailwindcss 4.3.3, tapable 2.3.3, tinyglobby 0.2.17, undici-types 6.21.0, update-browserslist-db 1.3.4, vite 6.4.4

**MPL-2.0** (12): lightningcss 1.32.0, lightningcss-android-arm64 1.32.0, lightningcss-darwin-arm64 1.32.0, lightningcss-darwin-x64 1.32.0, lightningcss-freebsd-x64 1.32.0, lightningcss-linux-arm-gnueabihf 1.32.0, lightningcss-linux-arm64-gnu 1.32.0, lightningcss-linux-arm64-musl 1.32.0, lightningcss-linux-x64-gnu 1.32.0, lightningcss-linux-x64-musl 1.32.0, lightningcss-win32-arm64-msvc 1.32.0, lightningcss-win32-x64-msvc 1.32.0

**Apache-2.0** (6): @playwright/test 1.64.0, baseline-browser-mapping 2.11.28, detect-libc 2.1.2, playwright 1.64.0, playwright-core 1.64.0, typescript 5.9.3

**ISC** (6): electron-to-chromium 1.5.452, graceful-fs 4.2.11, lru-cache 5.1.1, picocolors 1.1.1, semver 6.3.1, yallist 3.1.1

**CC-BY-4.0** (1): caniuse-lite 1.0.30001815

**BSD-3-Clause** (1): source-map-js 1.2.2

</details>

## Method and how to refresh

1. The `license` of every entry of the two lockfiles (npm lockfile version 3 records it); none was empty.
2. The installed `node_modules` of both projects were compared with the lockfile (same version for every installed package; 71 UI entries are platform-specific optional packages that are not installed on Windows) and checked for a LICENSE, COPYING or NOTICE file.
3. The payload content was derived from the allow-lists in the scripts named above, not from a built installer. An old `installer/payload.zip` in a developer checkout is v3.0.2 and was ignored.
4. Runtime components (Node.js, CPython, .NET, WebView2 SDK) were taken from the staging scripts, the project files and, for WebView2, the package in the NuGet cache; upstream licence descriptions are marked where they were not verified.
5. To refresh: repeat the lockfile analysis after `npm ci` in `DATGOLD-HUB/ui` and `scripts/intelligence-runtime`, inspect the staged payload (`runtime-manifest.json` lists every staged file), and update this file and the notice files in the same change.
