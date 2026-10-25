# Vendored licence notices

Two groups: the notices of the bundled Tree-sitter grammars (the `*.LICENSE` files here) and the notices of what is compiled into `rg.exe` (the `ripgrep/` folder, described at the end).

## Tree-sitter grammars

`stage.mjs` copies the files below to `licenses/<project>/LICENSE` in the staged runtime, which `Build-Installer.ps1` ships as `CHATMCP-HUB/licenses/`. `notices.mjs` lists them (`GRAMMAR_NOTICES`).

| Vendored file | Upstream project | Compiled into |
|---|---|---|
| `tree-sitter-javascript.LICENSE` | <https://github.com/tree-sitter/tree-sitter-javascript> | `grammars/tree-sitter-javascript.wasm` |
| `tree-sitter-typescript.LICENSE` | <https://github.com/tree-sitter/tree-sitter-typescript> | `grammars/tree-sitter-typescript.wasm`, `grammars/tree-sitter-tsx.wasm` |
| `tree-sitter-python.LICENSE` | <https://github.com/tree-sitter/tree-sitter-python> | `grammars/tree-sitter-python.wasm` |

Each file is the project's own `LICENSE` file, copied unchanged from the upstream repository (`tree-sitter-wasms` 0.1.13 declares `^0.20.3`, `^0.20.5` and `^0.21.0` as the development dependencies it built the grammars from; the exact versions are not recorded in the package). A file is accepted only when it has a copyright line with a year and the MIT permission paragraph; anything else counts as missing.

These three files were copied unchanged from the default branch of each upstream repository on 2026-10-19 (`gh api repos/tree-sitter/<project>/contents/LICENSE`): tree-sitter-javascript (Copyright (c) 2014 Max Brunsfeld), tree-sitter-typescript (2017 Max Brunsfeld), tree-sitter-python (2016 Max Brunsfeld). The upstream default branch may be newer than the grammar builds inside `tree-sitter-wasms` 0.1.13; the copyright lines of these projects have not changed, but the grammar versions are not recorded in the package.

If one of them is missing or unusable:

- `stage.mjs` stops, so `Build-Installer.ps1` and the release workflow fail with a message that names the missing files.
- A build that is not a release may set `CHATMCP_ALLOW_PENDING_NOTICES=1` (no workflow does). It stages `licenses/PENDING-NOTICES.txt`, records `pendingNotices` in `runtime-manifest.json` and prints a warning.
- `tests/verify-notices.mjs` prints which notices are pending (none when all three files are present) and fails if a release workflow sets the variable, and if any workflow does while all three files are present.

## What is compiled into rg.exe (`ripgrep/`)

`rg.exe` is staged from the official ripgrep archive by `stage-ripgrep.ps1`. The archive carries the texts of ripgrep itself (`LICENSE-MIT`, `UNLICENSE`, `COPYING`) and nothing else, but the binary is statically linked with PCRE2 (BSD-3-Clause, which asks for its notice in binary redistributions) and with Rust crates. Their texts are vendored in `ripgrep/`, and `stage.mjs` copies them, with the inventory, to `licenses/ripgrep/` in the staged runtime, which `Build-Installer.ps1` ships as `CHATMCP-HUB/licenses/ripgrep/`.

- `ripgrep/MANIFEST.json` is the inventory. `subject` names the release and the SHA-256 of the archive it was derived for. `basis` says how it was derived. `workspaceCrates` are ripgrep's own crates, covered by the archive's texts. `notLinked` are the packages of ripgrep's `Cargo.lock` that are not part of `rg.exe`, each with the reason. `components` are PCRE2 and the crates that are, each with its license expression and its texts: path, kind, size, SHA-256 and where the text came from (repository, tag, commit, path and the git blob id, which anyone can compare with `github.com/<repository>/blob/<commit>/<path>`).
- `ripgrep/<component>/<file>` are the texts, copied unchanged from the upstream repository. `.gitattributes` marks the folder `-text`, so no checkout changes a byte (on a Windows runner `core.autocrlf` would break every hash).
- A text is accepted only when it is non-empty, has the SHA-256 and git blob id of the inventory and says what its `kind` says (`mit`, `apache-2.0`, `unlicense`, `bsd-3-clause`, `unicode`, `pcre2`, plus `pointer` for a short COPYING file that names the licenses and `notice` for a COPYRIGHT file). The judge reads words, not line breaks, and asks for no copyright line: several upstream MIT texts (anyhow, serde, zmij) have none. A component's license expression decides which kinds it needs (`MIT OR Apache-2.0` needs both texts; an identifier that `notices.mjs` does not know is an error).
- There is no pending option here: `stage.mjs` stops when the inventory or a text is missing or changed, and when `stage-ripgrep.ps1` pins another release or archive than `subject` (a new ripgrep means deriving the inventory again). `verify.mjs` requires every text and the inventory in the staged runtime and the installed payload, each with its vendored hash. `Build-Installer.ps1` calls `Assert-InstallerRipgrepNotices` on the payload, and `test-runtime.mjs` checks the inventory against the real `rg.exe` of the installer build: the version string that the PCRE2 library carries (`compiledVersionString`, `10.46 2025-08-27`) must be in the bytes of the file, and `rg --pcre2-version` must print what `rgReports` records. `tests/verify-notices.mjs` and `scripts/tests/Test-InstallerPayload.ps1` check all of this, and `tests/verify-notices.mjs` also checks the rows in `THIRD-PARTY-NOTICES.md` and `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt`.

### How the inventory was derived (2026-10-25, ripgrep 15.2.0)

Nothing was downloaded from crates.io except JSON metadata, and no binary or installer was downloaded or run.

1. **The build.** `.github/workflows/release.yml` at tag 15.2.0 builds the Windows binary with `cargo build --profile release-lto --features pcre2 --target x86_64-pc-windows-msvc` and `PCRE2_SYS_STATIC=1`; `.cargo/config.toml` adds `-C target-feature=+crt-static`.
2. **The crates.** ripgrep's `Cargo.lock` at the tag has 59 packages (`basis.lockfile`: commit, blob id, SHA-256). The checksum of every registry package equals the one in the crates.io index. The dependencies of each package (kind, `cfg(...)` target, optional, features) come from that index and from ripgrep's workspace manifests; the normal dependencies of the `ripgrep` package, with the `pcre2` feature, for x86_64-pc-windows-msvc (`windows`, `target_env = "msvc"`, `crt-static`, release profile), were followed with Cargo's feature rules. Result: 10 workspace crates, 30 registry crates and 19 packages that are not linked (development and build dependencies such as `regex` and `cc`, optional crates no feature reaches, `tikv-jemallocator` for musl only).
3. **PCRE2.** `pcre2-sys` 0.2.10 bundles the sources and its `update-pcre2` fetches PCRE2 10.46; `include/pcre2.h` in the crate says `PCRE2_MAJOR 10`, `PCRE2_MINOR 46`. The crate does not bundle PCRE2's license, so the text is `LICENCE.md` of PCRE2Project/pcre2 at tag `pcre2-10.46` (the same bytes as at `pcre2-10.45`). Note that `rg --pcre2-version` prints `PCRE2 10.45`, not 10.46: `pcre2::version()` returns the `PCRE2_MAJOR` and `PCRE2_MINOR` constants of `pcre2-sys/src/bindings.rs`, which were generated for 10.45 and not regenerated when the bundled sources went to 10.46. The installer build of the first version of this inventory (derived from the sources alone) stopped on exactly that, which is why the inventory records both numbers (`rgReports`: what rg prints; `compiledVersionString`: what the compiled library carries, `pcre2_config.c` builds it from `pcre2.h`) and why the check that ties the notice to the binary is the search for the second one in the bytes of `rg.exe`. The number it prints also says which `pcre2-sys` built the binary: the bindings and the bundled sources agree in 0.2.8 (42) and 0.2.9 (43) and only 0.2.10 has 45 against 46, so a binary that prints 10.45 was built with 0.2.10, the version in the lock. The technique of the byte search was tried first on another MSVC build of ripgrep with PCRE2 (a copy bundled with an editor): its `.rdata` carries the same literal, once.
4. **The texts.** For each crate, the license files of the upstream repository named on crates.io, at the commit of the tag of that version (`windows-sys` and `windows-link` have no tag: the windows-rs commit "Release 71" that set these versions), read through the git objects with the GitHub API; the git blob id was recomputed from the bytes. Beyond the files at the top of a crate's folder: the Unicode license of `bstr`, `regex-syntax` and `regex-automata`, and the license of the C++ project that `zmij` ports.

### What this does not cover

- The Rust standard library and the static Microsoft C runtime inside `rg.exe`: the release workflow builds with the `nightly` toolchain of the day, which is not pinned. They are named as open items in `THIRD-PARTY-NOTICES.md`.
- The list comes from the sources of the release. `rg.exe` was not opened when it was derived; what the installer build checks against it is the PCRE2 version string and what `rg --pcre2-version` prints, nothing about the crates. A crate that the build links but that the rules above miss would be missing here.
- These are inventories kept by the maintainers, not legal advice.

### Deriving it again for a new ripgrep release

1. Change the pin in `stage-ripgrep.ps1` (version, URL, SHA-256). Staging and `tests/verify-notices.mjs` fail until the inventory belongs to it.
2. Repeat steps 1 to 4 above for the new tag, rewrite `ripgrep/` (texts and `MANIFEST.json`), and update the rows in `THIRD-PARTY-NOTICES.md` and `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt` and the paths of `guest-lifecycle.ps1`. `node CHATMCP-HUB/tests/verify-notices.mjs` names what is left. The scripts used on 2026-10-25 are not part of the repository.
