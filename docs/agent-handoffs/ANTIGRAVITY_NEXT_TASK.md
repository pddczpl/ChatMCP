# ChatMCP — ANTIGRAVITY_NEXT_TASK (Security Review Round 2)

> **Owner:** ChatGPT (GitHub independent reviewer)  
> **Executor:** Antigravity (Windows native code, real Windows Sandbox testing, integration)  
> **Issued:** 2026-10-13  
> **Status:** ACTION REQUIRED — PR #12 security NO-GO  
> **Task source of truth:** This file; read it end-to-end and implement, rather than merely drafting a plan.

## 0. Current verified facts

- Repository: https://github.com/pddczpl/ChatMCP
- Windows workspace: `F:\Personal_Project\Vin\ChatMCP`
- PR: https://github.com/pddczpl/ChatMCP/pull/12
- PR branch: `feat/phase1-integrate-windows-sandbox-experimental`, base `main`.
- PR HEAD **at review time**: `9807da021c1c25264fd7590d7e407543242e66cc`. Check HEAD again before modifying anything.
- Blocking independent review round 2: https://github.com/pddczpl/ChatMCP/pull/12#issuecomment-6132228188
- Previous review: https://github.com/pddczpl/ChatMCP/pull/12#issuecomment-6131872111
- Current PR job run: https://github.com/pddczpl/ChatMCP/actions/runs/38304488892 (9/9 GitHub-hosted jobs successful, NOT a real-guest security gate).
- Current Antigravity report: 24 real Windows Sandbox checkpoints **reported** on its machine; cannot be independently replayed by GitHub-hosted CI.
- Earlier ChatGPT code changes `54b32e2` and `bfed033` are **already integrated into PR #12**. Do not cherry-pick these commits again.
- Latest source `docs/WINDOWS-SANDBOX-REAL-FEASIBILITY.md` STILL contains an old 20-check GO report; it was not updated with this round's changes.

### Exact objective

Close the still-open P0 security gaps **with evidence**: fail-closed guest identity, real restricted-child token verification, authenticated receipt publication and malicious-child spoof rejection. Harden native process error paths. Make the reports and CI/guest acceptance honest. If a gate is impossible with the current architecture, document the blocker and keep production dispatch disabled.

Windows Sandbox remains the chosen OS isolation backend. No Docker/WSL/native-only alternative. ChatMCP remains local-only, single-user, with optional Internet for model APIs/GitHub. No silent host execution fallback.

**DO NOT** merge PR #12, create a release/tag, force-push/reset, auto-elevate, enable Windows features, restart, stop an unmanaged Sandbox, or grant coding-worker host shell.

## 1. Read-only preparation and Git safety

In PowerShell:

~~~powershell
Set-Location "F:\Personal_Project\Vin\ChatMCP"
git status --short
git branch -vv
git remote -v
git rev-parse HEAD
git fetch origin
gh pr view 12 --json state,isDraft,baseRefName,headRefName,headRefOid
gh pr checks 12
~~~

If local work is dirty, preserve and inspect it before switching or applying changes. Work on the actual PR #12 branch only after checking ownership and confirming it is safe. Never overwrite unrelated changes. Read README, SECURITY, ARCHITECTURE, DEVELOPMENT, PHASE1 plan, AGENTS/RULES if present, Program.cs, sandbox transport, real-guest tests, smoke tests, and CI. Read the entire linked review comment and its line-based evidence.

## 2. P0-A remains open: unknown privileged identity permits guest CreateProcessW

**File:** `CHATMCP-HUB/windows/sandbox/GuestSupervisor/Program.cs`  
**Lines:** 453–465 and 524–558 at HEAD 9807da0.

Existing code swallows exceptions from `WindowsIdentity.GetCurrent()` / `WindowsPrincipal.IsInRole()` using `catch { }`. On failure, both flags remain false. For `--guest-fixture` the code can then enter `CreateProcessW` without a restricted token, including after a SYSTEM bootstrap.

**Required change:**

1. Fail closed if identity inspection fails or produces insufficient information. No empty catch.
2. Since the trusted supervisor starts via `wsb exec -r System`, define/enforce the expected bootstrap identity. Under `--guest-fixture`, **no untrusted child starts without a separately validated restricted token**, regardless of parent-role heuristics. Do not allow a 'non-admin parent' shortcut to arbitrary `CreateProcessW`.
3. If `OpenProcessToken`, `CreateRestrictedToken`, token verification or `CreateProcessAsUserW` fails, produce an error and ensure zero untrusted privileged spawns. Reject contradictory fixture flags.
4. Prove effective child identity/SID, group membership, administrative SID enablement, privileges/elevation/integrity and guest protected-path access, independently of JSON `restrictedChild`. A token with disabled privileges is not necessarily sufficient evidence of no access via its SIDs or filesystem ACL.
5. Add **deterministic fault injection** for identity retrieval, OpenProcessToken, CreateRestrictedToken, CreateProcessAsUserW and any denied-token validation. Assert the actual child process did not execute, plus correct error/cleanup.

Use Microsoft documentation on `CreateRestrictedToken` and distinguish privilege reduction from SID and ACL restrictions:
https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken

## 3. P0-C remains open: default rejection is NOT authenticated publication

**Files:**
- `CHATMCP-HUB/lib/windows-sandbox-transport.mjs`
- `CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs`
- `CHATMCP-HUB/windows/sandbox/GuestSupervisor/Program.cs`
- Any new dedicated broker/transport code that is demonstrably necessary.

Current behavior: `readAndVerifyExecutionReceipt` rejects any exported receipt with `unverified_guest_origin` unless the caller explicitly passes `allowUntrustedHostFixture: true`. That is a **correct temporary fail-closed gate**, but it provides **no authentic production guest result**. Real-guest tests pass the fixture bypass, and nonce + SHA-256 can be recomputed by any writer.

**Required solution / proof:**

1. Write an explicit trust model for the host broker, trusted supervisor, child process, writable mapped export and snapshot/request metadata.
2. Establish a *separate trusted publication boundary* which the untrusted child provably cannot write/replace, including after trying file rename/reparse/symlink/hardlink and directory manipulation as permitted by the fixture.
3. Independently verify effective ACLs and permissions **from the actual child identity**, not solely from configured ACL strings or supervisor claims.
4. Bind publisher / owned Sandbox instance ID / durable launch generation / run ID / immutable snapshot/check/toolchain/supervisor hash to the published evidence. No model-controlled bypass or secret handed to the child. Prevent stale/replay and replacement races.
5. Create an **in-guest malicious-child test** that reads any visible run nonce, attempts to write or replace BOTH `receipt.json` and `receipt.sha256`, fully recomputes a matching SHA-256 for fake `status:"completed", exitCode:0`, and tries stale replay. The host must not accept it as publisher-authenticated evidence.
6. Separate `rawObservation`, `schemaConsistent`, `publisherAuthenticated`, and `testOutcomeVerified`. A zero exit code is not proof that the tests actually ran correctly.
7. Ensure result collection has bounded bytes, no unauthorized host write scope and an OS-validated publication pathway. If the current writable host mapping cannot be safely protected, propose a small prerequisite transport redesign PR and **leave Gate 4 BLOCKED**.

Do not 'solve' this by adding more nonces, merely changing `allowUntrustedHostFixture` or renaming the bypass. Preserve fixture mode for clearly labeled host/guest *prototype* diagnostics only, unreachable from production/model-issued worker calls.

Microsoft explicitly cautions that writable mapped folders may permit guest content to modify host data:
https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file

## 4. P0/P1 — Fix false-positive child-token verification

**File:** `CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs`, lines 181–243.

The current regex `/Se(Debug|Tcb|LoadDriver|Backup|Restore|TakeOwnership|AssignPrimaryToken)Privilege\s+Enabled/i` fails against a standard `whoami /priv` line containing a middle DESCRIPTION column, e.g.:

~~~text
SeDebugPrivilege       Debug programs       Enabled
~~~

The regex returns false on that dangerous Enabled example, so the suite can falsely pass.

**Required:**

- Regression test first: above deliberately dangerous fixture MUST fail validation.
- Prefer native Windows token inspection of TokenUser, TokenGroups, TokenPrivileges, TokenIntegrityLevel and TokenElevation. If parsing `whoami`, parse all columns carefully and fail closed for missing/unparseable output.
- Validate expected SID, deny-only/admin groups, privileges, integrity and actual filesystem access, not just the absence of a regex match.
- Retest with child launched via the supervisor; do not use a SYSTEM `wsb exec` shell as proof of reduced child privilege.

## 5. P0-B completion: native API fault-injection and handle robustness

**File:** `CHATMCP-HUB/windows/sandbox/GuestSupervisor/Program.cs` (P0-B changes at lines 436–445 and 579–689).

Recognize the existing improvements to ResumeThread, WAIT_FAILED, WAIT_TIMEOUT, WAIT_OBJECT_0, STILL_ACTIVE and GetExitCodeProcess, but verify/fix these gaps:

- `Marshal.GetLastWin32Error()` for `WaitForSingleObject` is invoked **after an awaited Task.Run**. Capture the error on the *same thread immediately after the native call* and return it together with the wait outcome.
- `CreatePipe` can partially succeed before the second creation fails: release all already-created handles, including when no main try/finally has begun.
- Check `SetHandleInformation` calls; if either fails, block execution and clean up.
- Verify `TerminateProcess`, the follow-up wait, child-process-tree termination and all `CloseHandle` ownership/error paths (never false success or resource leak).
- Test fault injections (native wrapper or test hooks) for CreateProcessAsUser, AssignJob, ResumeThread, WAIT_FAILED, WAIT_TIMEOUT, unexpected wait, GetExitCodeProcess error and output drain error.
- State clearly what is unit fault-injection, Windows host fixture, and actual guest evidence.

Do not mark all native negative error paths verified merely because one happy-path command and timeout passed.

## 6. Sandbox test harness correctness: cleanup and network gate

**File:** `CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs`.

- Current watchdog still calls `process.exit(2)` after a best-effort `wsb stop`, bypassing normal finally cleanup; it does not have a durable owned instance record before parsing `wsb start` output. Refactor with bounded cooperative abort, ownership journal/reconciliation, and explicit quarantine on uncertainty. Never stop an unowned Sandbox. Ensure an unexpected crash or stop error is reported as BLOCKED/UNKNOWN, not PASS.
- Current positive host network control logs NOTICE when host `8.8.8.8:53` fails, but still lets a failed guest connection count as verified network isolation. Positive control must be **valid** or security gate BLOCKED/INCONCLUSIVE. Prefer a controlled reachable endpoint; do not change Sandbox network policy to make the test pass.
- Guest file canary tests currently execute as raw `wsb exec -r System`. Keep them as OS boundary probes, but **also** test malicious actions from the restricted child using GuestSupervisor: unauthorized read AND write, supervisor/request replacement, output receipt forgery and child descendants after cancellation.
- Separate fixture setup, staging, CLI exit, canaries, real negative tests, timeout, and cleanup in the count/report. Do not call all 24 checkpoints '24 negative security tests'.
- On Windows unsupported hardware or occupied Sandbox, print BLOCKED and fail the dedicated gate. Do not call this job a green optional skip.

## 7. Correct docs and PR claims on the FINAL SHA

**Files:** `docs/WINDOWS-SANDBOX-REAL-FEASIBILITY.md`, PR #12 description/comment as needed.

The feasibility doc still says 20 checks and 'PR 2 GO' at 9807da0. PR body claims **all P0 resolved** and trusted receipt provenance while its code still denies all non-fixture receipts. Update truthful current claims, keep historical results dated and labeled as historical, and write separate gates:

- G1 host readiness / CLI.
- G2 owned guest creation/execution and cleanup.
- G3 restricted child identity + native containment.
- G4 publisher-authenticated receipts and spoof resistance.
- G5 negative OS isolation probes (counts separate).
- G6 regression + hosted CI + same-SHA dedicated real guest evidence.

A gate can be PASS, FAIL, BLOCKED or NOT VERIFIED with precise evidence and hash. **Overall SECURITY GO only if ALL required gates genuinely pass.** Otherwise state: 'REAL GUEST EXECUTION REPORTED — PRODUCTION SECURITY GATE BLOCKED.' Production provider must stay unavailable until PR3 backend and all prerequisite gates are satisfied.

## 8. Required real local tests

First probe read-only (do not install/reboot/elevate):

~~~powershell
Get-CimInstance Win32_OperatingSystem | Select Caption,Version,BuildNumber,OSArchitecture
Get-CimInstance Win32_ComputerSystem | Select HypervisorPresent,TotalPhysicalMemory
Get-CimInstance Win32_Processor | Select Name,VirtualizationFirmwareEnabled
Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM
Get-Command wsb -All -ErrorAction SilentlyContinue
dotnet --version
node --version
~~~

Verify no unmanaged Windows Sandbox is active. Use only owned disposable synthetic instances and fixtures. Do not run concurrent tests using the single Sandbox.

~~~powershell
dotnet build CHATMCP-HUB/windows/sandbox/GuestSupervisor/GuestSupervisor.csproj -c Release
dotnet publish CHATMCP-HUB/windows/sandbox/GuestSupervisor/GuestSupervisor.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
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
~~~

Verify relevant scripts in repository before invoking; adapt working directory as needed. Record each command's real exit code, whether it ran as a source/mock/host/guest test, and final SHA. Standard GitHub CI green is not the hardware gate.

## 9. Git integration and deliverables

1. After fixes, inspect `git diff` and `git status`; ensure no unrelated user data/keys/build artifacts committed. Use logically scoped commits on PR #12 branch.
2. Push without force. Inspect GH PR HEAD and Actions from the actual new SHA, diagnose/redesign if failed, and rerun affected real guest tests after security-impacting edits.
3. Update docs and PR body to **truthful** current verdict. Do not merge PR #12 or tag/release.
4. If an architectural blocker requires a separate prerequisite PR, explain why and the smallest viable boundary change, leave production disabled, and request ChatGPT review of that proposal.

### Final Vietnamese handoff report MUST contain

- Initial and final commit SHA, exact PR branch, changed files/commits.
- P0-A: proof unknown identity fails closed and no fallback path.
- P0-B: deterministic faults, real token/Job/process lifecycle evidence, cleanup.
- P0-C: publication design, restricted child effective ACL/paths, fully rehashed malicious receipt test, authenticated verifier result.
- Real guest tests grouped by setup/functional/negative security/cleanup; actual counts only.
- CI job runs and status for **final SHA**; local tests with exit codes.
- Doc changes, remaining blockers, G1–G6 matrix with PASS/FAIL/BLOCKED/NOT VERIFIED.
- Exact next steps required from ChatGPT independent reviewer.

**Start executing now in the workspace after reading this complete file.**