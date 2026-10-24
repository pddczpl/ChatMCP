# Third-party notices — DatGold

DatGold's own code is licensed under the [Apache License, Version 2.0](LICENSE) (see [NOTICE](NOTICE)); contributions are accepted under the Developer Certificate of Origin ([CONTRIBUTING.md](CONTRIBUTING.md)). This file covers the **third-party components that DatGold redistributes**. They are not covered by Apache-2.0 and stay under their own licenses and copyright notices.

It is an inventory kept by the maintainers, **not legal advice**, and it does not replace the license texts: the column "License text in the installed copy" says where each text is. "Pending" means the text is not shipped yet and the build says so (see [Pending notices](#pending-notices)). The audit behind this file, with the findings it answers, is [docs/LICENSE-SCAN.md](docs/LICENSE-SCAN.md). `tests/verify-notices.mjs` fails when a component below loses its entry here or in `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt`, when this list stops matching the lockfiles, or when a staging script stops copying or asserting a license file.

Paths are relative to the installation folder, the folder that holds `LICENSE` and `NOTICE`. The installation carries this file next to them and a plain-text companion, `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt`.

## Runtime components in the installer

| Component | Version | License | License text in the installed copy | Status |
|---|---|---|---|---|
| Node.js (`runtimes/node/node.exe`) | the build machine's Node.js (the release workflow uses 24.x) | MIT, with bundled V8 (BSD-3-Clause), OpenSSL (Apache-2.0), ICU (Unicode license), zlib, c-ares, nghttp2, undici and others | `runtimes/node/LICENSE` (the LICENSE file of the Node.js archive, which collects those notices) | Copied by `Copy-InstallerNodeLicense` in `scripts/InstallerPayload.ps1`; the build fails without it |
| CPython embeddable (`CHATMCP-HUB/runtimes/python`) | 3.11.9 (amd64, SHA-256 pinned in `stage-python.ps1`) | PSF-2.0, plus the libraries the archive bundles (OpenSSL, SQLite, libffi, expat, zlib, bzip2, liblzma, mpdecimal), named in its own license file | `CHATMCP-HUB/runtimes/python/LICENSE.txt` | Extracted from the archive; `stage-python.ps1`, `stage.mjs` and `verify.mjs` fail when it is missing or is not the PSF text |
| Microsoft Visual C++ runtime (`vcruntime140.dll`, `vcruntime140_1.dll` inside the CPython archive) | as in the CPython archive | Microsoft proprietary redistributable terms; not OSI-approved and not Apache-2.0 | none | Pending: the terms are the "Redistributing Visual C++ Files" terms of Microsoft (learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files); their text is not reproduced here because it was not available offline |
| `pyright` | 1.1.407 | MIT | `CHATMCP-HUB/runtimes/lsp/node_modules/pyright/LICENSE.txt`; the bundled typeshed stubs carry `dist/typeshed-fallback/LICENSE` | Shipped inside the package folder |
| `typescript` | 5.9.3 | Apache-2.0 | `CHATMCP-HUB/runtimes/lsp/node_modules/typescript/LICENSE.txt`, `ThirdPartyNoticeText.txt` | Shipped inside the package folder |
| `typescript-language-server` | 4.3.4 | Apache-2.0, with portions from VS Code (MIT) | `CHATMCP-HUB/runtimes/lsp/node_modules/typescript-language-server/LICENSE` (both texts) | Shipped inside the package folder |
| `web-tree-sitter` | 0.25.10 | MIT | `CHATMCP-HUB/runtimes/lsp/node_modules/web-tree-sitter/LICENSE` | Shipped inside the package folder |
| `tree-sitter-wasms` (the four compiled grammars in `CHATMCP-HUB/grammars/`) | 0.1.13 | Unlicense (covers the packaging only) | `CHATMCP-HUB/licenses/tree-sitter-wasms/LICENSE` | Copied by `stage.mjs`, which refuses to stage the grammars without it |
| Tree-sitter grammar `tree-sitter-javascript` (`CHATMCP-HUB/grammars/tree-sitter-javascript.wasm`) | built from the `^0.20.3` range that `tree-sitter-wasms` 0.1.13 declares | MIT | `CHATMCP-HUB/licenses/tree-sitter-javascript/LICENSE` | Pending: the upstream text is not in the repository yet; `stage.mjs` refuses a release build without it |
| Tree-sitter grammar `tree-sitter-typescript` (`CHATMCP-HUB/grammars/tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`) | built from the `^0.20.5` range | MIT | `CHATMCP-HUB/licenses/tree-sitter-typescript/LICENSE` | Pending, as above |
| Tree-sitter grammar `tree-sitter-python` (`CHATMCP-HUB/grammars/tree-sitter-python.wasm`) | built from the `^0.21.0` range | MIT | `CHATMCP-HUB/licenses/tree-sitter-python/LICENSE` | Pending, as above |
| `playwright`, `playwright-core` (JavaScript only, `CHATMCP-HUB/runtimes/browser/node_modules`) | 1.64.0 | Apache-2.0 | each package folder: `LICENSE`, `NOTICE`, and `ThirdPartyNotices.txt` in `playwright-core` | Whole package folders are copied; the browser executable is not bundled |
| `Microsoft.Web.WebView2` (managed assemblies and `WebView2Loader.dll` beside `ChatMCP.exe`) | 1.0.4258.31 | Microsoft BSD-3-Clause-style license; its NOTICE adds Antlr3.Runtime and StringTemplate4 (BSD-3-Clause) | none | Pending (finding 2 of the license scan) |
| .NET 10 runtime inside `ChatMCP.exe`, `ChatMCPSetup.exe`, `Uninstall.exe` and `GuestSupervisor.exe` | 10.0.x | MIT | none | Pending: the runtime's own third-party notice file is not shipped |
| Inter variable and JetBrains Mono 400 web fonts (`@fontsource-variable/inter`, `@fontsource/jetbrains-mono` 5.3.0) | 5.3.0 | SIL Open Font License 1.1 | none | Pending (finding 3) |
| React 16.0.0 and ReactDOM 16.0.1 UMD files (`CHATMCP-HUB/web/vendor`, legacy dashboards; ReactDOM includes Modernizr) | 16.0.x | MIT | the permission text in `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt`; the files keep their upstream headers | Shipped |
| Model catalog data from models.dev (`CHATMCP-HUB/lib/model-catalog.data.json`: a compact extract of https://models.dev/api.json, which names the model limits, prices and thinking options of about 9,000 models) | the snapshot is dated inside the file (`generatedAt`); `scripts/update-model-catalog.mjs` rebuilds it | MIT (Copyright (c) 2025 models.dev) | the permission text in `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt` | Shipped; data only, nothing is downloaded when the Hub runs |
| UI libraries compiled into `CHATMCP-HUB/web/dist` | see [the generated list](#ui-libraries-compiled-into-the-dashboard) | MIT, ISC, BSD-3-Clause, 0BSD (and the two font packages above) | none | Pending (finding 4): the Vite bundle keeps the license comments of React and lucide-react only |

## Pending notices

These are the gaps that remain after this change. None of them is hidden by the build.

1. **Tree-sitter grammar notices.** The three upstream projects are MIT-licensed *(per their upstream repositories; the texts were not available offline when this file was written)*. `scripts/intelligence-runtime/licenses/` is where their `LICENSE` files go (its README names the files). Until they are there, `stage.mjs` fails; a CI build may set `CHATMCP_ALLOW_PENDING_NOTICES=1`, which stages `CHATMCP-HUB/licenses/PENDING-NOTICES.txt` and records the missing projects in `runtime-manifest.json` (`pendingNotices`). No release workflow sets it, and `verify-notices` checks that.
2. **Microsoft Visual C++ runtime terms**, see the table.
3. **WebView2, .NET runtime, OFL font texts and the MIT/ISC/BSD notices of the UI libraries** (findings 2 to 4 of the license scan) are outside this change and still open. The Browser Companion archive `ChatMCP-Browser-Companion.zip` also does not contain `LICENSE` or `NOTICE` yet.

## UI libraries compiled into the dashboard

<!-- BEGIN GENERATED: ui-production-packages (scripts/generate-licenses.mjs) -->
167 packages of the production dependency closure of CHATMCP-HUB/ui/package-lock.json (MIT 161, ISC 2, OFL-1.1 2, 0BSD 1, BSD-3-Clause 1). Tree shaking means web/dist contains only the parts that are imported, so this list is an upper bound. The license is the `license` field of the lockfile entry.

| Package | Version | License |
|---|---|---|
| `@floating-ui/core` | 1.8.0 | MIT |
| `@floating-ui/dom` | 1.8.0 | MIT |
| `@floating-ui/react-dom` | 2.1.9 | MIT |
| `@floating-ui/utils` | 0.2.12 | MIT |
| `@fontsource-variable/inter` | 5.3.0 | OFL-1.1 |
| `@fontsource/jetbrains-mono` | 5.3.0 | OFL-1.1 |
| `@radix-ui/number` | 1.1.3 | MIT |
| `@radix-ui/primitive` | 1.1.7 | MIT |
| `@radix-ui/react-alert-dialog` | 1.1.24 | MIT |
| `@radix-ui/react-arrow` | 1.1.16 | MIT |
| `@radix-ui/react-collection` | 1.1.16 | MIT |
| `@radix-ui/react-compose-refs` | 1.1.5 | MIT |
| `@radix-ui/react-context` | 1.2.2 | MIT |
| `@radix-ui/react-dialog` | 1.2.0 | MIT |
| `@radix-ui/react-direction` | 1.1.5 | MIT |
| `@radix-ui/react-dismissable-layer` | 1.1.20 | MIT |
| `@radix-ui/react-dropdown-menu` | 2.1.25 | MIT |
| `@radix-ui/react-focus-guards` | 1.1.6 | MIT |
| `@radix-ui/react-focus-scope` | 1.2.0 | MIT |
| `@radix-ui/react-id` | 1.1.4 | MIT |
| `@radix-ui/react-menu` | 2.1.25 | MIT |
| `@radix-ui/react-popover` | 1.2.0 | MIT |
| `@radix-ui/react-popper` | 1.3.8 | MIT |
| `@radix-ui/react-portal` | 1.1.18 | MIT |
| `@radix-ui/react-presence` | 1.1.11 | MIT |
| `@radix-ui/react-primitive` | 2.1.11 | MIT |
| `@radix-ui/react-roving-focus` | 1.1.20 | MIT |
| `@radix-ui/react-scroll-area` | 1.3.0 | MIT |
| `@radix-ui/react-slot` | 1.4.0 | MIT |
| `@radix-ui/react-tabs` | 1.1.22 | MIT |
| `@radix-ui/react-tooltip` | 1.3.0 | MIT |
| `@radix-ui/react-use-callback-ref` | 1.1.4 | MIT |
| `@radix-ui/react-use-controllable-state` | 1.2.6 | MIT |
| `@radix-ui/react-use-effect-event` | 0.0.5 | MIT |
| `@radix-ui/react-use-is-hydrated` | 0.1.3 | MIT |
| `@radix-ui/react-use-layout-effect` | 1.1.4 | MIT |
| `@radix-ui/react-use-rect` | 1.1.4 | MIT |
| `@radix-ui/react-use-size` | 1.1.5 | MIT |
| `@radix-ui/react-visually-hidden` | 1.2.12 | MIT |
| `@radix-ui/rect` | 1.1.3 | MIT |
| `@tanstack/query-core` | 5.104.1 | MIT |
| `@tanstack/react-query` | 5.104.1 | MIT |
| `@tanstack/react-virtual` | 3.14.15 | MIT |
| `@tanstack/virtual-core` | 3.19.0 | MIT |
| `@types/debug` | 4.1.13 | MIT |
| `@types/estree` | 1.0.9 | MIT |
| `@types/estree-jsx` | 1.0.5 | MIT |
| `@types/hast` | 3.0.5 | MIT |
| `@types/mdast` | 4.0.4 | MIT |
| `@types/ms` | 2.1.0 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `@types/unist` | 2.0.11 | MIT |
| `@types/unist` | 3.0.3 | MIT |
| `@ungap/structured-clone` | 1.4.0 | ISC |
| `aria-hidden` | 1.2.6 | MIT |
| `bail` | 2.0.2 | MIT |
| `ccount` | 2.0.1 | MIT |
| `character-entities` | 2.0.2 | MIT |
| `character-entities-html4` | 2.1.0 | MIT |
| `character-entities-legacy` | 3.0.0 | MIT |
| `character-reference-invalid` | 2.0.1 | MIT |
| `clsx` | 2.1.1 | MIT |
| `cmdk` | 1.1.1 | MIT |
| `comma-separated-tokens` | 2.0.3 | MIT |
| `csstype` | 3.2.3 | MIT |
| `debug` | 4.4.3 | MIT |
| `decode-named-character-reference` | 1.3.0 | MIT |
| `dequal` | 2.0.3 | MIT |
| `detect-node-es` | 1.1.0 | MIT |
| `devlop` | 1.1.0 | MIT |
| `diff` | 7.0.0 | BSD-3-Clause |
| `escape-string-regexp` | 5.0.0 | MIT |
| `estree-util-is-identifier-name` | 3.0.0 | MIT |
| `extend` | 3.0.2 | MIT |
| `get-nonce` | 1.0.1 | MIT |
| `hast-util-to-jsx-runtime` | 2.3.6 | MIT |
| `hast-util-whitespace` | 3.0.0 | MIT |
| `html-url-attributes` | 3.0.1 | MIT |
| `inline-style-parser` | 0.2.7 | MIT |
| `is-alphabetical` | 2.0.1 | MIT |
| `is-alphanumerical` | 2.0.1 | MIT |
| `is-decimal` | 2.0.1 | MIT |
| `is-hexadecimal` | 2.0.1 | MIT |
| `is-plain-obj` | 4.1.0 | MIT |
| `longest-streak` | 3.1.0 | MIT |
| `lucide-react` | 0.468.0 | ISC |
| `markdown-table` | 3.0.4 | MIT |
| `mdast-util-find-and-replace` | 3.0.3 | MIT |
| `mdast-util-from-markdown` | 2.1.0 | MIT |
| `mdast-util-gfm` | 3.1.0 | MIT |
| `mdast-util-gfm-autolink-literal` | 2.0.1 | MIT |
| `mdast-util-gfm-footnote` | 2.1.0 | MIT |
| `mdast-util-gfm-strikethrough` | 2.0.1 | MIT |
| `mdast-util-gfm-table` | 2.0.0 | MIT |
| `mdast-util-gfm-task-list-item` | 2.0.0 | MIT |
| `mdast-util-mdx-expression` | 2.0.1 | MIT |
| `mdast-util-mdx-jsx` | 3.2.0 | MIT |
| `mdast-util-mdxjs-esm` | 2.0.1 | MIT |
| `mdast-util-phrasing` | 4.1.0 | MIT |
| `mdast-util-to-hast` | 13.2.1 | MIT |
| `mdast-util-to-markdown` | 2.2.0 | MIT |
| `mdast-util-to-string` | 4.0.0 | MIT |
| `micromark` | 4.0.3 | MIT |
| `micromark-core-commonmark` | 2.0.4 | MIT |
| `micromark-extension-gfm` | 3.0.0 | MIT |
| `micromark-extension-gfm-autolink-literal` | 2.1.0 | MIT |
| `micromark-extension-gfm-footnote` | 2.1.0 | MIT |
| `micromark-extension-gfm-strikethrough` | 2.1.0 | MIT |
| `micromark-extension-gfm-table` | 2.1.2 | MIT |
| `micromark-extension-gfm-tagfilter` | 2.0.0 | MIT |
| `micromark-extension-gfm-task-list-item` | 2.1.0 | MIT |
| `micromark-factory-destination` | 2.0.1 | MIT |
| `micromark-factory-label` | 2.0.1 | MIT |
| `micromark-factory-space` | 2.1.0 | MIT |
| `micromark-factory-title` | 2.0.1 | MIT |
| `micromark-factory-whitespace` | 2.0.1 | MIT |
| `micromark-util-character` | 2.1.1 | MIT |
| `micromark-util-chunked` | 2.0.1 | MIT |
| `micromark-util-classify-character` | 2.0.1 | MIT |
| `micromark-util-combine-extensions` | 2.0.1 | MIT |
| `micromark-util-decode-numeric-character-reference` | 2.0.2 | MIT |
| `micromark-util-decode-string` | 2.0.1 | MIT |
| `micromark-util-edit-map` | 1.0.0 | MIT |
| `micromark-util-encode` | 2.0.1 | MIT |
| `micromark-util-html-tag-name` | 2.0.1 | MIT |
| `micromark-util-normalize-identifier` | 2.0.1 | MIT |
| `micromark-util-resolve-all` | 2.0.1 | MIT |
| `micromark-util-sanitize-uri` | 2.0.1 | MIT |
| `micromark-util-subtokenize` | 2.1.0 | MIT |
| `micromark-util-symbol` | 2.0.1 | MIT |
| `micromark-util-types` | 2.0.3 | MIT |
| `ms` | 2.1.3 | MIT |
| `parse-entities` | 4.0.2 | MIT |
| `property-information` | 7.2.0 | MIT |
| `react` | 19.3.0 | MIT |
| `react-dom` | 19.3.0 | MIT |
| `react-markdown` | 9.1.0 | MIT |
| `react-remove-scroll` | 2.7.2 | MIT |
| `react-remove-scroll-bar` | 2.3.8 | MIT |
| `react-resizable-panels` | 2.1.9 | MIT |
| `react-style-singleton` | 2.2.3 | MIT |
| `remark-gfm` | 4.0.1 | MIT |
| `remark-parse` | 11.0.0 | MIT |
| `remark-rehype` | 11.1.2 | MIT |
| `remark-stringify` | 11.0.0 | MIT |
| `scheduler` | 0.28.0 | MIT |
| `space-separated-tokens` | 2.0.2 | MIT |
| `stringify-entities` | 4.0.4 | MIT |
| `style-to-js` | 1.1.21 | MIT |
| `style-to-object` | 1.0.14 | MIT |
| `tailwind-merge` | 2.6.1 | MIT |
| `trim-lines` | 3.0.1 | MIT |
| `trough` | 2.2.0 | MIT |
| `tslib` | 2.8.1 | 0BSD |
| `unified` | 11.0.5 | MIT |
| `unist-util-is` | 6.0.1 | MIT |
| `unist-util-position` | 5.0.0 | MIT |
| `unist-util-stringify-position` | 4.0.0 | MIT |
| `unist-util-visit` | 5.1.0 | MIT |
| `unist-util-visit-parents` | 6.0.2 | MIT |
| `use-callback-ref` | 1.3.3 | MIT |
| `use-sidecar` | 1.1.3 | MIT |
| `vfile` | 6.0.3 | MIT |
| `vfile-message` | 4.0.3 | MIT |
| `zustand` | 5.0.15 | MIT |
| `zwitch` | 2.0.4 | MIT |
<!-- END GENERATED: ui-production-packages -->

## Not redistributed

- Git for Windows (GPL-2.0), Microsoft Edge or Chromium, the Microsoft Edge WebView2 Runtime, Ollama, LM Studio and the model providers' services are separate installations that the user provides; DatGold does not bundle them. If a release ever bundles Git or another GPL or LGPL component, the license scan has to be redone first.
- `node-pty` (MIT) is optional and installed by the user from npm on request.
- Build-time and test-only dependencies stay out of the installer, among them Vite, Tailwind CSS, the UI type packages, the Playwright test runner, `lightningcss` (MPL-2.0, file-level copyleft) and `caniuse-lite` (CC-BY-4.0 data). Shipping `node_modules` would add duties for those two.

## Agent Skills and external tools

The GitHub Skills Hub imports content pinned to a repository revision with integrity evidence. A public GitHub repository and heuristic detection of a LICENSE text **do not automatically grant redistribution permission**. Review each upstream license and imported asset before reusing, publishing or repackaging it. Imported scripts are not automatically executed.

## Earlier releases

The Cloud Harness server, the Desktop Commander runtime and the MCP SuperAssistant proxy of the 1.x and 2.x releases are not installed, started or included by the current local-only Hub. Their notes remain in Git history and must not be read as current runtime requirements.
