# G4 / G6 acceptance — 13 October 2026

The user approved adding a separate native grader. G4 is **PASS for
`node-json-blackbox` only**, with independent review of the exact installer
payload. G6 is **PASS for the identified installer on the tested clean Windows
11 guest**. PR #13 remains
Draft; no merge, tag, release or host installation was performed.

## Identified implementation and deliverable

The implementation and both final hardware harnesses are from clean commit
`acc2f840dfd7c1b279d2c58c2bc5d1294ffcfc43`. Later changes to this record and
retained evidence are documentation only; they do not rebuild or replace the
tested installer.

| Artifact | SHA-256 |
| --- | --- |
| `dist/ChatMCPSetup.exe` | `037cea6f5794da6cd19f67e284cc84f05e4c88f006a96de60b0f26c5b1931fe7` |
| `installer/payload.zip` | `132a16c6fc3d9e18e75e47795a97ba270f72fb08365febd9697695709eba324f` |
| Packaged `GuestSupervisor.exe` | `e4c5ee3c2cd8b79e6d1cc088af52ce0a04cc0e4b0f10a79c37bc4e55bd495fb1` |
| Packaged `node.exe` | `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237` |

Installer size: 200,706,208 bytes; product version:
`2.6.0+acc2f840dfd7c1b279d2c58c2bc5d1294ffcfc43`. The final native matrix used
the helper extracted from this payload, verified against its bundled checksum.
Independent review also matched the bundled Node bytes with the executing Node.

## G4 — native public-case grading: PASS

**24 acceptance checks, 17 fresh owned guests, 153 independently reconstructed
digest words, exit 0, all owned guest cleanup confirmed.** A failing implementation
was repaired without changing the approved cases and then passed. Altering
expected values or revoking the grant prevented execution.

The SYSTEM Native AOT supervisor compares bounded inert JSON values itself.
The implementation runs as a fresh nonadministrator account with medium
integrity; its token owner/group are SYSTEM. Actual attempts to read, modify,
change ownership or DACLs of the seal and supervisor were denied. Access to
the elevated Windows desktop process was denied before token opening. Calling
the digest reader from the child failed. Sealed state was observed as a
SYSTEM-owned 72-byte record after publication. Loaded modules were the pinned
helper and trusted Windows modules; no extracted CoreCLR was loaded.

Thirteen hostile-output cases covered forged grading/counts, empty/early exits,
Node success markers, wrong types, reordered/missing cases, duplicate keys,
oversize, nonzero exit, malformed UTF-8, nonfinite numbers and trailing JSON.
Two additional real runs verified bounded timeout for a non-reading child with
60 KiB of input and termination of a SYSTEM-observed live descendant before
publication and guest teardown.

See the [independent decision](G4-BLACKBOX-REVIEW-2026-10-13.md),
[raw final matrix](evidence/g4-blackbox-final-2026-10-13/native-blackbox-final-payload.json)
and [user-facing check format](../PHASE1-BLACKBOX-CHECKS.md).
Raw matrix SHA-256:
`fbf4e226caf29532118aad5d1e729d9bd7ef0673c67fc998dc9af29dc5ba506c`.

Production assembly retains `hostAttested:false`, allows only the reviewed
check kind, and uses `system-sealed-exit-v1`. Legacy `node --test` outcomes remain
unverified and cannot enter this path. Approved cases are public; PASS proves
the returned values for those cases, not universal correctness or coverage.
The Windows kernel, trusted fresh base image, host Hub and OS package manager
are the trust boundary; this does not claim protection from a malicious
administrator. The pinned Microsoft Store CLI and strict owned-instance
inventory checks are part of that boundary.

## G6 — final clean Windows lifecycle

**55/55 checks, host and guest exit 0, owned cleanup confirmed.** The fresh
Windows 11 guest had no existing ChatMCP installation and no Node, .NET SDK,
Git or npm on PATH. Microsoft-signed offline WebView2 was installed in the
guest only. The real setup wizard installed the baseline, the native
WinForms/WebView2/React/Hub application launched, and the distinct candidate
installer upgraded it in place. User model settings were retained byte for byte.

The candidate desktop then launched with its bundled Node. An explicitly
labelled maintenance fixture verified unchanged obsolete-file removal,
modified-file preservation and safe replacement of a hard-linked uninstaller.
The real uninstall wizard removed all 157 manifest-owned payload files, the
151-file legacy baseline inventory, owned shortcuts and Installed Apps entry,
while preserving user settings, WebView2 preferences and unrelated files.

Run `f3e5de81-3628-4358-a458-9e3d7f1d004e`, 23:12:53–23:14:56 Asia/Bangkok,
13 October 2026. Host build 26300; guest build 26100. The host metadata records
clean implementation commit `acc2f840`. Candidate SHA matches the installer
above. The baseline was version `2.6.0+cb97f190...`, SHA-256
`155d2f1b8777deb47e963fb362618bc2d864b5b9378de00982bb158ac4f1575a`.
This is a real same-version upgrade between different installer artifacts.

See [the lifecycle handoff](G6-CLEAN-INSTALL-2026-10-13.md),
[final lifecycle results](evidence/g6-clean-install-final-2026-10-13/lifecycle-report.json),
[host cleanup](evidence/g6-clean-install-final-2026-10-13/host-run.json),
[baseline desktop](evidence/g6-clean-install-final-2026-10-13/baseline-desktop.png)
and [upgraded desktop](evidence/g6-clean-install-final-2026-10-13/upgrade-desktop.png).
Earlier lifecycle evidence is historical and does not substitute for this run.
Windows 10, ARM64 and every historical installer version were not tested.

## Regression and hosted checks

- Local Hub: 66/66 suites, no failure, timeout or skip.
- React unit checks: 46/46.
- Installer payload checks: 42/42.
- Native grader host self-test: 35/35, including the exact published AOT during
  packaging. This is a parser/comparison diagnostic, not OS isolation proof.
- Clean required Debug Windows host fixture: 20 checks. Its unavailable symlink
  probe is explicitly reported; directory-junction denial is independently
  exercised by the CLI identity suite.
- PR CI on the implementation commit: [9/9 success](https://github.com/pddczpl/ChatMCP/actions/runs/38426992374).
- Push CI on the same commit: [9/9 success after one failed-job rerun](https://github.com/pddczpl/ChatMCP/actions/runs/38426980802).
  The initial Windows Node 22 job had one 30-second credential-helper timeout;
  the equivalent PR job and later real DPAPI checks in the same original job
  passed. One rerun on unchanged source passed all 66 suites, including that
  isolation check in 20.6 seconds. No assertions or timeouts were weakened.
  [Initial failure](evidence/g4-g6-ci-2026-10-13/push-ci-first-attempt.json),
  [rerun result](evidence/g4-g6-ci-2026-10-13/push-ci-rerun.json),
  [PR result](evidence/g4-g6-ci-2026-10-13/pr-ci.json) and
  [diagnosis](evidence/g4-g6-ci-2026-10-13/credential-helper-timeout.md) are retained.

Retained evidence preserves its original bytes, including Windows line endings
where captured. Git attributes prevent newline conversion from invalidating
the recorded hashes; original historical raw bytes were restored as part of
this documentation change. Report data and results were not rewritten.

The first hardware attempts remain failures in the local diagnostic history:
an absent desktop in the headless guest and a missing check rediscovery after
restoring a tampered manifest. Both harness issues were corrected before full
acceptance. An additional successful run accidentally used the preactivation
helper; it is excluded from final installer evidence. The final matrix above
explicitly matches the installer payload hash. The earlier CI artifact-path
failure was corrected by requiring the fresh Debug RID build, with no stale
binary fallback.
