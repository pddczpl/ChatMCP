# ChatMCP — Antigravity Next Task

> **Handoff owner:** ChatGPT (GitHub engineering/review)
>
> **Assigned executor:** Antigravity (local Windows implementation and real Windows Sandbox acceptance)
>
> **Handoff date:** 2026-10-13
>
> **Status:** READY FOR LOCAL EXECUTION; PR #12 SECURITY **NO-GO**
>
> **This document is the complete task prompt.** Read it and execute it in the selected local workspace. Do not stop after drafting another plan.

## 0. Repository, branch, and authoritative links

- Repository: https://github.com/pddczpl/ChatMCP
- Windows workspace: `F:\Personal_Project\Vin\ChatMCP`
- Integration PR: https://github.com/pddczpl/ChatMCP/pull/12
- Integration branch: `feat/phase1-integrate-windows-sandbox-experimental` (base: `main`)
- Reference PR #12 HEAD at handoff: `6d4a434ca00c144c574222a21f3342986af77884`. Check again; do not assume it remains current.
- Blocking GitHub security review: https://github.com/pddczpl/ChatMCP/pull/12#issuecomment-6131872111
- ChatGPT code-fix branch: `fix/phase1-pr12-github-hardening`
- ChatGPT code-fix commits (in order):
  1. `54b32e26639e40b5dc5a44d7648df3ce89fbcef3` — only literal boolean `true` opts into the intentionally untrusted fixture receipt parser.
  2. `bfed033e612103c342b51e59e6020bf972171f88` — regression tests for truthy non-boolean fixture bypass values.
- Roadmap: `docs/PHASE1-IMPLEMENTATION-PLAN.md`.
- Current experimental report: `docs/WINDOWS-SANDBOX-REAL-FEASIBILITY.md`.

**Division of labor:** Antigravity owns edits and real-world checks involving `GuestSupervisor/Program.cs`, `real-guest.mjs`, Windows PowerShell/.NET/Windows Sandbox. ChatGPT has produced separate JavaScript-only hardening on its own branch. Do not concurrently overwrite other GitHub edits.

## 1. Mission / definition of done

Complete the **Phase 1 PR 2 security gate** before considering PR 3:

1. Remove all privileged guest-child fallback paths.
2. Make native create / Job Object / resume / wait / exit / termination failures fail closed.
3. Prove trustworthy result publication or explicitly keep execution verification unavailable.
4. Run targeted real Windows Sandbox negative tests on **the exact final SHA**.
5. Preserve separate raw observation, validated schema, authenticated provenance, and verified test outcome.
6. Keep PR #12 Draft, do not merge, do not publish a release.

**Important:** A past report saying `REAL ISOLATION VERIFIED — PR 2 GO` is historical and not the current security verdict. The latest independent review identified blocking flaws. Green GitHub CI does not prove real guest isolation.

## 2. Safe initial commands and preparation

Open PowerShell within the authorized workspace.

```powershell
Set-Location "F:\Personal_Project\Vin\ChatMCP"
git status --short
git branch -vv
git remote -v
git rev-parse HEAD
git log -5 --oneline
git fetch origin
gh pr view 12 --json state,isDraft,headRefName,baseRefName,headRefOid
gh pr checks 12
```

Read `README.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/PHASE1-IMPLEMENTATION-PLAN.md`, the feasibility report, and any repository `AGENTS.md`/local instructions. Inspect the actual source and test files before editing.

Preserve all preexisting user work. If the worktree is dirty, document the changes and use an ownership-safe workflow; do not overwrite them or perform destructive reset/clean. Do not force-push. Verify remote PR HEAD immediately before integrating changes.

Once the integration branch is ready and safe to change, review the two code-fix commits in the preceding section and **cherry-pick them in order**, resolving any conflicts carefully:

```powershell
git show --stat 54b32e26639e40b5dc5a44d7648df3ce89fbcef3
git show --stat bfed033e612103c342b51e59e6020bf972171f88
# On a clean and correctly selected PR #12 integration branch only:
git cherry-pick 54b32e26639e40b5dc5a44d7648df3ce89fbcef3
git cherry-pick bfed033e612103c342b51e59e6020bf972171f88
```

Do not blindly cherry-pick a commit already present or patch-equivalent. Compare the diffs first. If cherry-pick conflicts with local work, resolve without discarding either side. These changes are fixture hardening only: they do **not** authenticate the Sandbox output publisher.

## 3. P0-A — Guest restricted-token fail-open

**Main file:** `CHATMCP-HUB/windows/sandbox/GuestSupervisor/Program.cs`.

Review `WindowsIdentity.GetCurrent`, `OpenProcessToken`, `CreateRestrictedToken`, `CreateProcessAsUserW` and `CreateProcessW`. For untrusted `--guest-fixture` execution started with `wsb exec -r System`, a token failure must NOT lead to a privileged `CreateProcessW` fallback. Reject a request when identity is unknown or a restricted/non-admin child cannot be established. A `CreateProcessAsUserW` failure must not prompt any elevated fallback. Also reject contradictory fixture flags.

Add deterministic negative/fault-injection tests for token open, restricted-token creation, and restricted-process creation failure. Acceptance is **zero privileged untrusted child launches** under all such failures. Independently capture the child user's SID, groups, privileges, elevation, effective integrity level, and a protected guest supervisor-only canary. `restrictedChild: true` in JSON is self-report, not proof.

## 4. P0-B — Native process lifecycle fail-closed

**Main file:** `CHATMCP-HUB/windows/sandbox/GuestSupervisor/Program.cs`.

Validate each native API return value and failure route:

- Create process suspended; assign to kill-on-close Job Object *before* resuming user code.
- Job creation/configuration/assignment failure: no user code execution; terminate and safely reap process.
- `ResumeThread == 0xFFFFFFFF`: fail closed, terminate, and avoid a successful receipt.
- `WaitForSingleObject == WAIT_OBJECT_0` is the only wait state eligible for normal completion.
- `WAIT_TIMEOUT`, `WAIT_FAILED`, unexpected statuses: report accurate timeout/failure or unknown result; never completed.
- `GetExitCodeProcess == false`, unknown exit, or `STILL_ACTIVE`: never coerce to exit code 0.
- Check `SetHandleInformation`, termination verification, process tree containment, and all owned handle cleanup paths.

Test failure injection and a real guest timeout/cancellation with child processes. Avoid orphan processes and incorrect success receipts.

## 5. P0-C — Receipt publisher authenticity (do not create a cosmetic fix)

**Files:** `CHATMCP-HUB/lib/windows-sandbox-transport.mjs`, `CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs`, guest supervisor and any genuinely needed transport/broker files.

Current real guest harness passes `allowUntrustedHostFixture: true`. Current nonce plus SHA-256 validates consistency, **not authorship**. Do not rename the bypass to claim production security. Define a concrete trust boundary where the untrusted child cannot modify the authoritative result, and show how the host binds owned instance, generation, run, snapshot, check, toolchain and supervisor identity.

If proposing supervisor-only publication, actually test effective filesystem ACL/permissions and the child's inability to write the privileged publication destination; protect the trusted process and immutable requests. The host must reject a malicious child that attempts to publish a forged `completed/exitCode:0` receipt together with a *recomputed matching checksum*. Add tests for stale/replay, mismatched identities, oversized/symlinked entries and malicious output. Keep all guest-exported data untrusted until publication provenance is proven. No model-supplied option may authorize fixture bypass.

If source-origin authenticity or a bounded writable host export cannot be demonstrated with the current design, report an explicit **BLOCKED prerequisite**, do not silently switch to host shell, and do not enable coding-worker execution.

## 6. P1 — Improve real guest evidence and cleanup

**Main file:** `CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs`.

- Real negative tests should run the intended restricted child through the actual supervisor when testing child privileges, not count a raw `wsb exec -r System` test as evidence of restricted-child identity.
- Assert the restricted-child state and verify the **actual OS token** independently. Check Job Object containment beyond its self-reported flag.
- Host synthetic canary: attempt both reading and modifying unauthorized material and confirm final hashes/content.
- Read-only input: attempt modification of supervisor/request/test config; verify denied results.
- Networking: use a suitable reachable positive control from host and a negative guest probe; a timeout to a possibly-unavailable Internet address alone proves little.
- Distinguish policy-XML checks from runtime clipboard/device isolation evidence.
- Replace the global `process.exit(2)` watchdog with bounded cancellation/cleanup logic. Stop **only** a positively owned Sandbox UUID and verify termination. Never kill another user's guest.
- Count actual negative security assertions separately from setup, staging, and cleanup steps.
- Use disposable fixtures; do not mount user profile or real workspace writable.

## 7. Windows host and guest verification

Probe read-only:

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture
Get-CimInstance Win32_ComputerSystem | Select-Object HypervisorPresent,TotalPhysicalMemory
Get-CimInstance Win32_Processor | Select-Object Name,VirtualizationFirmwareEnabled
Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM
Get-Command wsb -All -ErrorAction SilentlyContinue
Test-Path "$env:LOCALAPPDATA\Microsoft\WindowsApps\wsb.exe"
dotnet --version
node --version
```

If preflight is inconclusive or another unmanaged Sandbox is running, report **BLOCKED**, not PASS. Do not install Windows features, elevate, edit BIOS, restart, or stop someone else's instance.

Run the required checks, adapting syntax to actual repository scripts:

```powershell
dotnet build "CHATMCP-HUB\windows\sandbox\GuestSupervisor\GuestSupervisor.csproj" -c Release
dotnet publish "CHATMCP-HUB\windows\sandbox\GuestSupervisor\GuestSupervisor.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
node CHATMCP-HUB/tests/verify-execution-contract.mjs
node CHATMCP-HUB/tests/verify-windows-sandbox-config.mjs
node CHATMCP-HUB/tests/verify-windows-sandbox-smoke.mjs
node CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs
node CHATMCP-HUB/tests/run-all.mjs --no-skip all
npm --prefix CHATMCP-HUB/ui run test:unit
npm --prefix CHATMCP-HUB/ui run build
npm --prefix CHATMCP-HUB/ui run test:e2e
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tests\Test-InstallerPayload.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Build-Installer.ps1
node CHATMCP-HUB/ui/e2e/webview2-smoke.mjs
git diff --check
```

Never run multiple tests concurrently if they share the single Windows Sandbox instance. Log real exit codes and output, distinguish platform-skip/BLOCKED from PASS, and report the final checked SHA.

## 8. Docs, PR, and handoff back to ChatGPT

Update `docs/WINDOWS-SANDBOX-REAL-FEASIBILITY.md` without rewriting historical evidence; correct the *current* verdict. Include OS build, CLI/.NET versions, published binary hash, final test commit SHA, privileged token proof, Job Object evidence, receipt threat model, spoof-rejection results, and individually counted real negative tests.

Commit logically scoped changes, push only to `feat/phase1-integrate-windows-sandbox-experimental`, and inspect GitHub Actions **for that exact final SHA**; fix red checks and rerun necessary real Windows tests for any security-relevant changes. Leave PR #12 **Draft/Open**. No merge to `main`, no tags/releases, no PR3 production dispatch.

### Required final report (Vietnamese)

1. Initial and final Git SHA, branch, PR URL.
2. Changed files and commits.
3. P0-A / P0-B / P0-C: before, after, actual evidence.
4. Real guest restricted identity and effective ACL evidence.
5. Native process fault handling and Job Object/cleanup evidence.
6. Malicious fully-rehashed receipt spoof result and provenance verdict.
7. Real guest negative tests counted separately from preflight/setup/cleanup.
8. All local test commands, exit codes, CI run links and exact tested SHA.
9. Gates 1–6 as PASS/FAIL/BLOCKED/NOT VERIFIED.
10. Remaining blockers and precise asks for ChatGPT review.

**Only report `PR 2 SECURITY GO` if all blocking tests are proven on the final code. Otherwise report `REAL GUEST EXECUTION REPORTED — PRODUCTION SECURITY GATE BLOCKED`.**

When finished, return your report to the user so ChatGPT can perform independent review of PR #12.
