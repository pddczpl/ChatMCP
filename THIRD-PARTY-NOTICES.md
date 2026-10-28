# Third-party notices — DatGold

DatGold's own code is licensed under the [Apache License, Version 2.0](LICENSE) (see [NOTICE](NOTICE)); contributions are accepted under the Developer Certificate of Origin ([CONTRIBUTING.md](CONTRIBUTING.md)). This file covers the **third-party components that DatGold redistributes**. They are not covered by Apache-2.0 and stay under their own licenses and copyright notices.

It is an inventory kept by the maintainers, **not legal advice**, and it does not replace the license texts: the column "License text in the installed copy" says where each text is. "Pending" means the text is not shipped yet and the build says so (see [Pending notices](#pending-notices)). The audit behind this file, with the findings it answers, is [docs/LICENSE-SCAN.md](docs/LICENSE-SCAN.md). `tests/verify-notices.mjs` fails when a component below loses its entry here or in `DATGOLD-HUB/THIRD-PARTY-NOTICES.txt`, when this list stops matching the lockfiles, or when a staging script stops copying or asserting a license file.

Paths are relative to the installation folder, the folder that holds `LICENSE` and `NOTICE`. The installation carries this file next to them and a plain-text companion, `DATGOLD-HUB/THIRD-PARTY-NOTICES.txt`.

## Runtime components in the installer

| Component | Version | License | License text in the installed copy | Status |
|---|---|---|---|---|
| Node.js (`runtimes/node/node.exe`) | the build machine's Node.js (the release workflow uses 24.x) | MIT, with bundled V8 (BSD-3-Clause), OpenSSL (Apache-2.0), ICU (Unicode license), zlib, c-ares, nghttp2, undici and others | `runtimes/node/LICENSE` (the LICENSE file of the Node.js archive, which collects those notices) | Copied by `Copy-InstallerNodeLicense` in `scripts/InstallerPayload.ps1`; the build fails without it |
| CPython embeddable (`DATGOLD-HUB/runtimes/python`) | 3.11.9 (amd64, SHA-256 pinned in `stage-python.ps1`) | PSF-2.0, plus the libraries the archive bundles (OpenSSL, SQLite, libffi, expat, zlib, bzip2, liblzma, mpdecimal), named in its own license file | `DATGOLD-HUB/runtimes/python/LICENSE.txt` | Extracted from the archive; `stage-python.ps1`, `stage.mjs` and `verify.mjs` fail when it is missing or is not the PSF text |
| Microsoft Visual C++ runtime (`vcruntime140.dll`, `vcruntime140_1.dll` inside the CPython archive) | as in the CPython archive | Microsoft proprietary redistributable terms; not OSI-approved and not Apache-2.0 | none: the terms are summarised, not reproduced, in the section [Microsoft C/C++ runtime components](#microsoft-cc-runtime-components) | Documented on 2026-10-25: that section names what Microsoft publishes and the conditions it states, and says what it does not settle |
| ripgrep (`DATGOLD-HUB/runtimes/ripgrep/rg.exe`, the search of `search_files` and `find_files`) | 15.2.0 (x86_64-pc-windows-msvc, SHA-256 pinned in `stage-ripgrep.ps1`) | MIT OR Unlicense (dual-licensed: the licensee chooses); the binary also contains PCRE2 (BSD-3-Clause, with an exemption for binary library-like packages), the Rust standard library of the toolchain that built it, 30 Rust crates of ripgrep's own build and 2 more that the standard library links, all listed in the section "Compiled into rg.exe" below, and the static Microsoft C runtime (see "Microsoft C/C++ runtime components") | `DATGOLD-HUB/runtimes/ripgrep/LICENSE-MIT`, `DATGOLD-HUB/runtimes/ripgrep/UNLICENSE` and `COPYING` (ripgrep's own, all from the archive); the texts of PCRE2, of the Rust standard library and of the crates in `DATGOLD-HUB/licenses/ripgrep/` | Shipped. The archive's texts are extracted by `stage-ripgrep.ps1`; it, `stage.mjs` and `verify.mjs` fail when LICENSE-MIT or UNLICENSE is missing or is not the license text. The other texts are vendored in `scripts/intelligence-runtime/licenses/ripgrep/`, and `stage.mjs`, `verify.mjs` and the installer build fail without them. The static C runtime inside `rg.exe` is named, with the terms that Microsoft publishes for it, in the section "Microsoft C/C++ runtime components"; the text of those terms is not reproduced |
| `pyright` | 1.1.407 | MIT | `DATGOLD-HUB/runtimes/lsp/node_modules/pyright/LICENSE.txt`; the bundled typeshed stubs carry `dist/typeshed-fallback/LICENSE` | Shipped inside the package folder |
| `typescript` | 5.9.3 | Apache-2.0 | `DATGOLD-HUB/runtimes/lsp/node_modules/typescript/LICENSE.txt`, `ThirdPartyNoticeText.txt` | Shipped inside the package folder |
| `typescript-language-server` | 4.3.4 | Apache-2.0, with portions from VS Code (MIT) | `DATGOLD-HUB/runtimes/lsp/node_modules/typescript-language-server/LICENSE` (both texts) | Shipped inside the package folder |
| `web-tree-sitter` | 0.25.10 | MIT | `DATGOLD-HUB/runtimes/lsp/node_modules/web-tree-sitter/LICENSE` | Shipped inside the package folder |
| `tree-sitter-wasms` (the four compiled grammars in `DATGOLD-HUB/grammars/`) | 0.1.13 | Unlicense (covers the packaging only) | `DATGOLD-HUB/licenses/tree-sitter-wasms/LICENSE` | Copied by `stage.mjs`, which refuses to stage the grammars without it |
| Tree-sitter grammar `tree-sitter-javascript` (`DATGOLD-HUB/grammars/tree-sitter-javascript.wasm`) | built from the `^0.20.3` range that `tree-sitter-wasms` 0.1.13 declares | MIT | `DATGOLD-HUB/licenses/tree-sitter-javascript/LICENSE` | Shipped. `stage.mjs` copies the upstream text from `scripts/intelligence-runtime/licenses/tree-sitter-javascript.LICENSE` (copied unchanged from the default branch of the upstream repository on 2026-10-19; the versions of the grammars inside `tree-sitter-wasms` are not recorded in its package) and refuses to stage the grammars without it |
| Tree-sitter grammar `tree-sitter-typescript` (`DATGOLD-HUB/grammars/tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`) | built from the `^0.20.5` range | MIT | `DATGOLD-HUB/licenses/tree-sitter-typescript/LICENSE` | Shipped, as above |
| Tree-sitter grammar `tree-sitter-python` (`DATGOLD-HUB/grammars/tree-sitter-python.wasm`) | built from the `^0.21.0` range | MIT | `DATGOLD-HUB/licenses/tree-sitter-python/LICENSE` | Shipped, as above |
| `playwright`, `playwright-core` (JavaScript only, `DATGOLD-HUB/runtimes/browser/node_modules`) | 1.64.0 | Apache-2.0 | each package folder: `LICENSE`, `NOTICE`, and `ThirdPartyNotices.txt` in `playwright-core` | Whole package folders are copied; the browser executable is not bundled |
| `Microsoft.Web.WebView2` (managed assemblies and `WebView2Loader.dll` beside `ChatMCP.exe`) | 1.0.4258.31 | Microsoft BSD-3-Clause-style license; its NOTICE adds Antlr3.Runtime and StringTemplate4 (BSD-3-Clause) | none | Pending (finding 2 of the license scan) |
| .NET 10 runtime inside `ChatMCP.exe`, `DatGoldSetup.exe`, `Uninstall.exe` and `GuestSupervisor.exe` | 10.0.x | MIT | none | Pending: the runtime's own third-party notice file is not shipped |
| Inter variable and JetBrains Mono 400 web fonts (`@fontsource-variable/inter`, `@fontsource/jetbrains-mono` 5.3.0) | 5.3.0 | SIL Open Font License 1.1 | none | Pending (finding 3) |
| React 16.0.0 and ReactDOM 16.0.1 UMD files (`DATGOLD-HUB/web/vendor`, legacy dashboards; ReactDOM includes Modernizr) | 16.0.x | MIT | the permission text in `DATGOLD-HUB/THIRD-PARTY-NOTICES.txt`; the files keep their upstream headers | Shipped |
| Model catalog data from models.dev (`DATGOLD-HUB/lib/model-catalog.data.json`: a compact extract of https://models.dev/api.json, which names the model limits, prices and thinking options of about 9,000 models) | the snapshot is dated inside the file (`generatedAt`); `scripts/update-model-catalog.mjs` rebuilds it | MIT (Copyright (c) 2025 models.dev) | the permission text in `DATGOLD-HUB/THIRD-PARTY-NOTICES.txt` | Shipped; data only, nothing is downloaded when the Hub runs |
| UI libraries compiled into `DATGOLD-HUB/web/dist` | see [the generated list](#ui-libraries-compiled-into-the-dashboard) | MIT, ISC, BSD-3-Clause, 0BSD (and the two font packages above) | none | Pending (finding 4): the Vite bundle keeps the license comments of React and lucide-react only |

## Compiled into rg.exe

`DATGOLD-HUB/runtimes/ripgrep/rg.exe` is the official build of ripgrep 15.2.0 for x86_64-pc-windows-msvc (`cargo build --profile release-lto --features pcre2`, with `PCRE2_SYS_STATIC=1`). The ripgrep archive carries the license texts of ripgrep and of its own workspace crates (`ripgrep`, `grep`, `grep-cli`, `grep-matcher`, `grep-pcre2`, `grep-printer`, `grep-regex`, `grep-searcher`, `globset`, `ignore`: Unlicense OR MIT). It does not carry the texts of the components below: PCRE2, compiled from the sources that the `pcre2-sys` crate bundles; the 30 crates of ripgrep's `Cargo.lock` that Cargo links for this target; and the Rust standard library of the toolchain that built the binary, with the crates it links (`cfg-if`, which ripgrep uses too, `hashbrown` and `rustc-demangle`) and the parts of its source tree that carry notices of their own. Their texts are in `DATGOLD-HUB/licenses/ripgrep/<folder>/`, copied unchanged from the upstream repository at the commit of the version named here. `DATGOLD-HUB/licenses/ripgrep/MANIFEST.json` is the inventory: the repository, commit and path of every text, its SHA-256 and git blob id, the 19 packages of the lock file that are not linked, each with the reason, and, for the Rust standard library, the toolchain and the 27 packages of the Rust library lock file that are not linked, each with the reason. `scripts/intelligence-runtime/licenses/README.md` says how the list was derived. It comes from the sources and from the release record of ripgrep, not from opening the binary; the installer build (`test-runtime.mjs`) checks four facts against the real `rg.exe`: the version string that the PCRE2 library carries (`10.46 2025-08-27`) must be in its bytes, `rg --pcre2-version` must print what the inventory records, the source paths that the Rust standard library leaves in every binary (`/rustc/<commit>/library/...`) must name the commit of the toolchain below, and its import table must name no C runtime DLL. `tests/verify-notices.mjs` fails when a row below is missing, when a text differs from its hash, or when `stage-ripgrep.ps1` pins another release than the inventory was derived for.

**The Rust standard library.** ripgrep's release workflow builds with the `nightly` toolchain and does not pin it. The release record (run 29431117779 of BurntSushi/ripgrep: the Windows job started on 2026-07-15 at 16:07:59 UTC) and Rust's own nightly manifest (the nightly of 2026-07-15 was published at 01:29:39 UTC that day, the next one a day later) give the toolchain `1.99.0-nightly (da80ed070 2026-07-14)`, commit `da80ed0708a09dc096c184345d6eb42cbcd50a1e` of rust-lang/rust. That is derived from timestamps and not read from the binary: the installer build looks for the source paths `/rustc/<commit>` that `core` and `std` leave in every binary, and fails when that commit is not among them (it names the commits it does find). Rust's `COPYRIGHT` file says that its licenses are tracked with REUSE (`REUSE.toml`, `license-metadata.json`, `LICENSES/`) and with cargo, and points to a generated `COPYRIGHT-library.html` that ships only inside the `rustc` component of a toolchain and lists the crates of every target; that file was not downloaded. The inventory instead records the root texts of the commit (`COPYRIGHT`, `LICENSE-MIT`, `LICENSE-APACHE`), the parts of `library/` that carry notices of their own (the Unicode tables of `core`, `std::sync::mpmc`, `backtrace`, `compiler_builtins` with `libm`, `stdarch`, `portable-simd`) and the three registry crates that `std` links for x86_64-pc-windows-msvc, and it lists the 27 packages of the Rust library lock file that are not linked, each with the reason (`libc`, `miniz_oxide`, `addr2line`, `object`, `gimli` and `memchr` are not used for this target, where backtraces go through `dbghelp`; `foldhash` is reached only through a feature that `std` switches off).

| Component | Version | License | Texts in `DATGOLD-HUB/licenses/ripgrep/` |
|---|---|---|---|
| PCRE2 | 10.46 | BSD-3-Clause WITH PCRE2-exception | `libpcre2-10.46/` (`LICENCE.md`) |
| Rust standard library | 1.99.0-nightly (da80ed070 2026-07-14) | MIT OR Apache-2.0 | `rust-std-da80ed070/` (`COPYRIGHT`, `LICENSE-APACHE`, `LICENSE-MIT`) |
| Rust core::unicode tables | 1.99.0-nightly (da80ed070 2026-07-14) | Unicode-3.0 | `rust-core-unicode-da80ed070/` (`Unicode-3.0.txt`) |
| Rust std::sync::mpmc | 1.99.0-nightly (da80ed070 2026-07-14) | MIT OR Apache-2.0 | `rust-std-mpmc-da80ed070/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| Rust backtrace (backtrace-rs) | 1.99.0-nightly (da80ed070 2026-07-14) | MIT OR Apache-2.0 | `rust-backtrace-d902726a1/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| Rust compiler_builtins and libm | 1.99.0-nightly (da80ed070 2026-07-14) | MIT AND Apache-2.0 WITH LLVM-exception AND (MIT OR Apache-2.0) | `rust-compiler-builtins-da80ed070/` (`LICENSE.txt`, `libm-LICENSE.txt`) |
| Rust stdarch (core::arch, std_detect) | 1.99.0-nightly (da80ed070 2026-07-14) | MIT OR Apache-2.0 | `rust-stdarch-da80ed070/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| Rust portable-simd (core::simd) | 1.99.0-nightly (da80ed070 2026-07-14) | MIT OR Apache-2.0 | `rust-portable-simd-da80ed070/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `aho-corasick` | 1.1.4 | Unlicense OR MIT | `aho-corasick-1.1.4/` (`COPYING`, `LICENSE-MIT`, `UNLICENSE`) |
| `anyhow` | 1.0.103 | MIT OR Apache-2.0 | `anyhow-1.0.103/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `bstr` | 1.13.0 | MIT OR Apache-2.0 | `bstr-1.13.0/` (`COPYING`, `LICENSE-APACHE`, `LICENSE-MIT`, `LICENSE-UNICODE`) |
| `cfg-if` | 1.0.4 | MIT OR Apache-2.0 | `cfg-if-1.0.4/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `crossbeam-deque` | 0.8.7 | MIT OR Apache-2.0 | `crossbeam-deque-0.8.7/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `crossbeam-epoch` | 0.9.20 | MIT OR Apache-2.0 | `crossbeam-epoch-0.9.20/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `crossbeam-utils` | 0.8.22 | MIT OR Apache-2.0 | `crossbeam-utils-0.8.22/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `encoding_rs` | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause | `encoding_rs-0.8.35/` (`COPYRIGHT`, `LICENSE-APACHE`, `LICENSE-MIT`, `LICENSE-WHATWG`) |
| `encoding_rs_io` | 0.1.7 | MIT OR Apache-2.0 | `encoding_rs_io-0.1.7/` (`COPYING`, `LICENSE-APACHE`, `LICENSE-MIT`) |
| `hashbrown` | 0.17.1 | MIT OR Apache-2.0 | `hashbrown-0.17.1/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `itoa` | 1.0.18 | MIT OR Apache-2.0 | `itoa-1.0.18/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `lexopt` | 0.3.2 | MIT | `lexopt-0.3.2/` (`LICENSE`) |
| `libc` | 0.2.186 | MIT OR Apache-2.0 | `libc-0.2.186/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `log` | 0.4.33 | MIT OR Apache-2.0 | `log-0.4.33/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `memchr` | 2.8.3 | Unlicense OR MIT | `memchr-2.8.3/` (`COPYING`, `LICENSE-MIT`, `UNLICENSE`) |
| `memmap2` | 0.9.11 | MIT OR Apache-2.0 | `memmap2-0.9.11/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `pcre2` | 0.2.11 | Unlicense OR MIT | `pcre2-0.2.11/` (`COPYING`, `LICENSE-MIT`, `UNLICENSE`) |
| `pcre2-sys` | 0.2.10 | Unlicense OR MIT | `pcre2-sys-0.2.10/` (`COPYING`, `LICENSE-MIT`, `UNLICENSE`) |
| `regex-automata` | 0.4.15 | MIT OR Apache-2.0 | `regex-automata-0.4.15/` (`LICENSE-APACHE`, `LICENSE-MIT`, `LICENSE-UNICODE`) |
| `regex-syntax` | 0.8.11 | MIT OR Apache-2.0 | `regex-syntax-0.8.11/` (`LICENSE-APACHE`, `LICENSE-MIT`, `LICENSE-UNICODE`) |
| `rustc-demangle` | 0.1.28 | MIT OR Apache-2.0 | `rustc-demangle-0.1.28/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `same-file` | 1.0.6 | Unlicense/MIT | `same-file-1.0.6/` (`COPYING`, `LICENSE-MIT`, `UNLICENSE`) |
| `serde` | 1.0.228 | MIT OR Apache-2.0 | `serde-1.0.228/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `serde_core` | 1.0.228 | MIT OR Apache-2.0 | `serde_core-1.0.228/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `serde_json` | 1.0.150 | MIT OR Apache-2.0 | `serde_json-1.0.150/` (`LICENSE-APACHE`, `LICENSE-MIT`) |
| `termcolor` | 1.4.1 | Unlicense OR MIT | `termcolor-1.4.1/` (`COPYING`, `LICENSE-MIT`, `UNLICENSE`) |
| `textwrap` | 0.16.2 | MIT | `textwrap-0.16.2/` (`LICENSE`) |
| `walkdir` | 2.5.0 | Unlicense/MIT | `walkdir-2.5.0/` (`COPYING`, `LICENSE-MIT`, `UNLICENSE`) |
| `winapi-util` | 0.1.11 | Unlicense OR MIT | `winapi-util-0.1.11/` (`COPYING`, `LICENSE-MIT`, `UNLICENSE`) |
| `windows-link` | 0.2.1 | MIT OR Apache-2.0 | `windows-link-0.2.1/` (`license-apache-2.0`, `license-mit`) |
| `windows-sys` | 0.61.2 | MIT OR Apache-2.0 | `windows-sys-0.61.2/` (`license-apache-2.0`, `license-mit`) |
| `zmij` | 1.0.23 | MIT | `zmij-1.0.23/` (`LICENSE-MIT`, `LICENSE-vitaut-zmij`) |

- `bstr`, `regex-syntax` and `regex-automata` contain tables generated from the Unicode Character Database; the Unicode, Inc. license (`LICENSE-UNICODE`) is shipped with each of them.
- `encoding_rs` contains data derived from the WHATWG Encoding Standard (BSD-3-Clause, `LICENSE-WHATWG`); its `COPYRIGHT` file says so.
- `zmij` is a line-by-line port of Victor Zverovich's C++ project of the same name (MIT); that project's license is `LICENSE-vitaut-zmij`.
- `windows-sys` and `windows-link` have no release tag in their repository; their texts are those of the commit that set these versions ("Release 71"), under the lower-case file names the crates use.
- PCRE2's `LICENCE.md` (the same text in 10.45 and 10.46) is shipped whole, with its exemption for binary library-like packages. The version is 10.46: the sources that `pcre2-sys` 0.2.10 compiles, and the string `10.46 2025-08-27` that the library carries. `rg --pcre2-version` prints `PCRE2 10.45` all the same, because it prints constants of the Rust bindings (`pcre2-sys/src/bindings.rs`), which were generated for 10.45 and not regenerated; the installer build found this in the real 15.2.0 binary, and the inventory records it.
- The Rust components are parts of one release (`1.99.0-nightly (da80ed070 2026-07-14)`). `Rust standard library` is the root of the commit: Rust's `COPYRIGHT` (it names no third-party text), `LICENSE-MIT` and `LICENSE-APACHE`. `Rust core::unicode tables` is the Unicode License V3 of `library/core/src/unicode` (REUSE: "1991-2024 Unicode, Inc."), a different text from the older Unicode license of `bstr` and `regex-syntax`. `Rust std::sync::mpmc` carries the copyright of The Crossbeam Project Developers (`REUSE.toml` of rust-lang/rust) and its texts are crossbeam's own; `crossbeam-channel` also has a `LICENSE-THIRD-PARTY` that lists the work that crate was derived from, which is not vendored because rust-lang/rust records only the crossbeam copyright for this code. `Rust backtrace (backtrace-rs)` is the git submodule `library/backtrace` (commit `d902726a1dcdc1e1c66f73d1162181b5423c645b`, "2014 Alex Crichton"). `Rust compiler_builtins and libm` are two composite files: the MIT text, the Apache-2.0 text and the LLVM exception with the provenance of the compiler-rt work, and the MIT text of `libm` with the musl and other copyrights of its math code. `Rust stdarch` and `Rust portable-simd` are the license files of those subtrees.
- `cfg-if` 1.0.4 is a dependency of ripgrep and of the standard library (`backtrace` uses it): one entry covers both. `hashbrown` and `rustc-demangle` are linked by the standard library only. `std::sys::sync::mutex::fuchsia` (BSD-2-Clause) is not compiled for Windows and is not vendored.

## Microsoft C/C++ runtime components

Two places carry code of Microsoft's C and C++ runtime. Both are redistributed unmodified, and neither is DatGold's own work.

1. **Inside `rg.exe`, linked statically.** ripgrep's `.cargo/config.toml` sets `-C target-feature=+crt-static` for x86_64-pc-windows-msvc, so the executable contains the C runtime instead of importing it: `libcmt.lib` (startup), `libvcruntime.lib` (code specific to Visual C++) and `libucrt.lib` (the Universal C runtime). The first two come with the MSVC toolset of Visual Studio, `libucrt.lib` with the Windows SDK (Microsoft: [C runtime (CRT) and C++ standard library (STL) lib files](https://learn.microsoft.com/en-us/cpp/c-runtime-library/crt-library-features), ms.date 2021-03-05). They were linked on ripgrep's release machine, a GitHub-hosted `windows-latest` runner; which Visual Studio and Windows SDK it had is not recorded in the release, so the terms of Visual Studio 2022 and 2026 are both given. The installer build checks that the import table of `rg.exe` names no C runtime DLL (`VCRUNTIME140.dll`, `MSVCP140.dll`, `UCRTBASE.dll`, `api-ms-win-crt-*` and the like), so a build with a dynamic runtime is refused and these notices would no longer describe it.
2. **Inside the CPython archive, as DLLs.** `vcruntime140.dll` and `vcruntime140_1.dll`, the Visual C++ 2015-2022 runtime, as the Python Software Foundation ships them in its embeddable archive (see the component table). The package that installs the runtime (`vc_redist`) is not shipped.

What Microsoft publishes, read on 2026-10-25 (the dates are the pages' own; the texts are not reproduced here, and the file hashes are in `scripts/intelligence-runtime/licenses/README.md`):

- **Windows SDK** (for `libucrt.lib`). The license terms that ship with the SDK (`sdk_license.rtf`), section "Distributable Code", and the REDIST.TXT list that it refers to, <https://learn.microsoft.com/en-us/legal/windows-sdk/redist> (updated 2024-10-21). The list has a section "Static LIB files": the `.lib` files under `Lib\<version>\ucrt\<arch>` and `Lib\<version>\um\<arch>` may be distributed unmodified when built as part of your program.
- **Visual Studio** (for `libcmt.lib`, `libvcruntime.lib` and `vcruntime140.dll`). The license terms of Visual Studio 2022 Enterprise and Professional and of Visual Studio 2026 (last updated 2025-10-01), <https://visualstudio.microsoft.com/license-terms/>, section "Distributable Code", and the Distributable Lists, <https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution> and <https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution> (both dated 2025-11-11). For the Visual C++ runtime the lists name the merge modules and the files under `VC\redist` (where `vcruntime140.dll` is), to be distributed unmodified. They do not name `libcmt.lib` or `libvcruntime.lib`, and the pages say nothing about code that is linked statically from them.
- **The redistributable package.** [Redistribute Visual C++ Files](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files) (ms.date 2026-04-13): distribution of the runtime redistributable package, of the merge modules and of individual binaries is limited to licensed Visual Studio users and subject to the Microsoft Software License Terms; the page says nothing about statically linked code. The license of the package itself, "Microsoft Visual C++ 2015-2022 Runtime" (<https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/>), governs installing that package.

The conditions that the Windows SDK and Visual Studio terms attach to Distributable Code: the program must add significant primary functionality of its own; distributors and external end users must be required to agree to terms that protect the code at least as much as the license terms; the licensee indemnifies Microsoft against claims about the distribution or use of the program. The SDK terms also require that a `.lib` is distributed only as the result of linking it into a program, and that a valid copyright notice is displayed on the program. Restrictions: Microsoft's notices must not be changed, its trademarks must not be used in the program's name or to suggest endorsement, nothing marked preview or pre-release may be distributed (Visual Studio), the code must not be distributed to run on a platform other than Microsoft's (SDK), and its source must not be put under a license that requires source disclosure or lets others modify it.

What that means here, as facts and not as a conclusion:

- `rg.exe` is built and distributed by the release workflow of the ripgrep project, and the CPython runtime by the Python Software Foundation; DatGold redistributes both unmodified. The text of Microsoft's terms is not reproduced in this repository: they are agreements with Microsoft's licensees, which Microsoft publishes at the links above.
- `rg.exe` is a search tool with significant functionality of its own. DatGold's installer shows no end-user agreement, and DatGold gives Microsoft no indemnity: nothing in this repository meets the condition about terms for end users or the indemnity condition.
- Whether these conditions bind DatGold as a redistributor of binaries that others built and linked, whether code linked statically from `libcmt.lib` and `libvcruntime.lib` is Distributable Code at all, and whether the licenses of ripgrep (MIT or Unlicense) and of CPython (PSF-2.0) count as terms that protect Microsoft's code, are legal questions that this file does not answer. It is an inventory kept by the maintainers, not legal advice.

## Pending notices

These are the gaps that remain after this change. None of them is hidden by the build.

1. **WebView2, .NET runtime, OFL font texts and the MIT/ISC/BSD notices of the UI libraries** (findings 2 to 4 of the license scan) are outside this change and still open. The Browser Companion archive `DatGold-Browser-Companion.zip` (and its copy `ChatMCP-Browser-Companion.zip`) also does not contain `LICENSE` or `NOTICE` yet.

## UI libraries compiled into the dashboard

<!-- BEGIN GENERATED: ui-production-packages (scripts/generate-licenses.mjs) -->
167 packages of the production dependency closure of DATGOLD-HUB/ui/package-lock.json (MIT 161, ISC 2, OFL-1.1 2, 0BSD 1, BSD-3-Clause 1). Tree shaking means web/dist contains only the parts that are imported, so this list is an upper bound. The license is the `license` field of the lockfile entry.

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
