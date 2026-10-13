# ANTIGRAVITY_NEXT_TASK — Round 7: WSB ExitCode Trust-Channel Feasibility

**Date:** 2026-10-13  
**Executor:** Antigravity on authorized Windows 11 workstation  
**Project root:** F:\Personal_Project\Vin\ChatMCP  
**Branch:** feat/phase1-complete-autonomous-coding  
**PR:** https://github.com/pddczpl/ChatMCP/pull/13  
**P0 issue:** https://github.com/pddczpl/ChatMCP/issues/14

**Decision:** PHASE 1 G4 BLOCKED — NO MERGE / NO RELEASE. Shipping WindowsSandboxPublisher({hostAttested:false}) remains locked.

## A. Read the NEW facts before coding

Your Round 6 report tested SHA c7a271ea353beaead1c259877da4f537592efc19 and reported 9/9 PR CI, 9/9 push CI, 62 Hub suites, 46 UI checks, 42 installer payload checks and real Windows Sandbox functional FAIL→repair→PASS. Those reported counts and GitHub CI were reviewed; no need to rerun *unchanged* component work gratuitously.

The decisive real hardware observation was:
- wsb.exe CLI version 0.8.107.0
- wsb exec --raw JSON has ONLY ["ExitCode"]; Stdout field absent
- fixed public echo marker NOT forwarded
- SYNTHETIC_KEY_READ_SUCCESS=True when WDAG child read a synthetic file in the writable host-mapped guest Output directory
- **G4 publisher BLOCKED**, clean-machine install/upgrade/uninstall NOT VERIFIED.

Microsoft independently documents that wsb exec returns the process exit code but **does not support process I/O**:
https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli

Therefore **do not attempt to implement trusted publication via wsb Stdout** in the tested environment. Any code that interprets missing Stdout as authenticated PASS is unsafe.

Read the revised architecture FIRST:
docs/PHASE1-G4-PUBLISHER-TRANSPORT-ADR.md

ChatGPT added a NEW non-attesting **nine-word positive ExitCode digest codec**:
- CHATMCP-HUB/lib/windows-sandbox-exitcode-channel.mjs
- CHATMCP-HUB/tests/verify-windows-driver.mjs
- optional REAL Windows probe in CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs

It encodes SHA-256 into NINE nonzero POSITIVE 31-bit process exit codes (top two bits 01, 30 data bits each, 14 zero padding bits). **It never marks publisherAuthenticated=true.** Matching 256-bit digest words from MOCK or arbitrary guest data does NOT establish identity of the pinned GuestSupervisor or integrity of guest-local state.

## B. Fetch and protect local work

From PowerShell:

~~~powershell
Set-Location 'F:\Personal_Project\Vin\ChatMCP'
git status --short
git branch -vv
git remote -v
git fetch origin
gh pr view 13 --json state,isDraft,headRefName,baseRefName,headRefOid
gh pr checks 13
git show origin/feat/phase1-complete-autonomous-coding:docs/agent-handoffs/ANTIGRAVITY_NEXT_TASK.md
git rev-parse HEAD
git diff --check
~~~

Confirm this file begins with **Round 7** and review AGENTS.md. Preserve unrelated changes. When clean, synchronize using fast-forward; otherwise use a new clean worktree, never destructive reset/clean or force push. Record initial/final SHA. Do not start/stop other users' Sandbox instances.

## C. Priority 1 — Native high ExitCode feasibility (hardware)

1. Read the new codec and its source-only regression. Run:
   node CHATMCP-HUB/tests/verify-windows-driver.mjs
2. Probe two framed positive process exits on the exact **owned** Sandbox using the optional real-guest diagnostic. In PowerShell only for this test:
   $env:CHATMCP_PROBE_FRAMED_EXITS='1'
   node CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs
   Remove-Item Env:CHATMCP_PROBE_FRAMED_EXITS
3. The real-guest script will still correctly exit NONZERO while G4 is BLOCKED. This is **not** a regression failure to suppress. Record the separate diagnostic string:
   CLI_FRAMED_EXIT_RANGE_OBSERVED or CLI_FRAMED_EXIT_RANGE_NOT_PROVEN.
4. Record whether both **1073741824 (0x40000000)** and **2147483647 (0x7fffffff)** survive the exact wsb exec --raw JSON round-trip, with bounded redacted schema, command outcome and time spent. These are PUBLIC status codes, not secrets.
5. If either high positive process ExitCode is corrupted/unsupported/ambiguous, mark option C infeasible on this CLI version and report native error. Do NOT continue implementing that protocol merely because mock tests pass.

## D. Priority 2 — Prove or reject trusted ExitCode publisher provenance

ONLY if section C proves framed ExitCode transport:

1. Design a SUPERVISOR-SEALED guest-local digest state with an OS-enforced SYSTEM-only DACL. It must be under guest-local private storage, NEVER the host-mapped Output folder or a world-writable temp path. The output receipt file can be untrusted, but the full SHA-256 digest of exactly its bytes plus a canonical run envelope must be protected from EVERY low-trust child and any pre-existing guest process.
2. Bind run ID, fresh host nonce, owned Sandbox UUID/generation, snapshot/check/test baseline hash, pinned GuestSupervisor and toolchain exe hashes, Node TAP assertion counts, status/exit code and cancellation. The host separately checks all these fields. Do not sign arbitrary client-supplied JSON without authenticating its source.
3. Introduce a strictly fixed native command such as GuestSupervisor.exe --digest-word <0..8> tied to a previously sealed run, returning ONLY the corresponding positive framed ExitCode through wsb exec -r System. Authenticate the exact launched binary/OS process and verify the protected digest state cannot be created/replaced/read by WDAGUtilityAccount or descendants. Reject wrong state/request/generation; never accept missing words, zero exit, malformed framing, nonzero final padding, replay or interruption as PASS.
4. Attempt malicious child receipt overwrite, forge completed exit0, alter original test assertions, replace guest-local digest, invoke the digest-word command as WDAG user, forged process launch, and concurrent/unknown guest ownership. If any attack can cause the host to accept an altered receipt, this option is UNSAFE and must not enable production.
5. Prefer a small diagnostic native proof-of-concept and raw Win32 deny/exit evidence before wiring into the actual WorkerTestBroker. The real hardware report must distinguish SOURCE/MOCK, FUNCTIONAL and SECURITY proofs. Any native helper changes must run on a freshly published exe SHA from final source SHA.

If source provenance or protected state cannot be proved, leave the product publisher locked and provide an honest architectural blocker. Alternative guest-local broker/IPC only if an actual supported host↔VM channel is verified. **Do not assume ordinary host named pipes cross a Windows Sandbox VM.**

## E. Functional regression and release readiness

- Preserve the existing full-stack diagnostic: WorkerTestBroker → ExecutionSnapshotStore → WindowsSandboxBackend → trusted owned guest. Show FAIL → implementation-only repair → PASS with unmodified baseline tests and real TAP counts; diagnostic test-scoped hostAttested true does NOT certify production G4.
- Preserve a genuine non-SYSTEM child SID, restricted tokens, WMI evidence from actual query (never hardcoded PASS), Job Object containment, process/windowstation/desktop DACL denials, network/canary denial, no host command fallback, cancellation and owner-only guest cleanup.
- Run full Hub regressions, React unit/E2E/build, Win-x64 .NET GuestSupervisor publish and installer tests on final SHA. Check 9/9 push and 9/9 PR CI. The user has NOT authorized paid model requests, OS feature installs/reboots, system account changes on host, or stopping unrelated VM.
- Distinguish **G6 CI/build PASS** from **clean-machine install→launch→upgrade→uninstall NOT VERIFIED** unless separately run in a user-approved disposable Windows test environment.

## F. Product and report invariants

Standalone local Windows desktop app; no external IDE/VS Code integration. User chooses model Base URL/API key; provider controls costs/rate limits and **ChatMCP imposes no token/request/spend budget**. Full Access is explicit user confirmation and never elevates Windows privileges or overrides automated test OS isolation.

Do not merge PR #12/#13, change main, tag/release, force-push, disclose signing/API keys, enable shipping hostAttested:true, or claim Phase 1 GO from 9/9 CI alone.

Final report in Vietnamese: exact initial/final SHA, changed files/commits, guest/host OS versions, .NET/Node/CLI versions, exe SHA-256, the actual two high ExitCode observations and CLI schema, process-origin/sealed guest-local state negative tests (if attempted), real fail→repair→PASS, cancellation/ownership, G1–G6 PASS/FAIL/BLOCKED/NOT VERIFIED and actual nonzero security gate exit codes. If the guest cannot establish an authentic publisher, report **G4 BLOCKED / NO RELEASE**.

---

## Earlier Round 6 and previous tasks (historical only; Round 7 takes precedence)

# ANTIGRAVITY_NEXT_TASK — Round 6: Trusted Publisher Channel Feasibility and Native G4 Fix

**Date:** 2026-10-13
**Owner:** Antigravity on the authorized Windows local workspace
**Repository:** https://github.com/pddczpl/ChatMCP
**Work branch:** feat/phase1-complete-autonomous-coding
**PR:** https://github.com/pddczpl/ChatMCP/pull/13
**P0 Issue:** https://github.com/pddczpl/ChatMCP/issues/14
**Mandatory security decision:** G4 BLOCKED — NO MERGE / NO RELEASE / NO SHIPPING hostAttested:true

## 0. What Round 5 actually established

Your submitted Round 5 Windows report used SHA 68099a5647660a35140651110b1352ec3ceb4ac6. GitHub independently confirmed full Push CI 9/9, PR CI 9/9 and portable component test PASS on that SHA. You reported actual WMI status EMPTY and parent process access denials 5, a real WDAG child SID distinct from SYSTEM, network/host-canary controls, and real Node test FAIL→scripted repair→PASS (17 diagnostic checks).

**The decisive native observation is SYNTHETIC_KEY_READ_SUCCESS=True** from the WDAG child for a synthetic file in the writable host-mapped Output directory. This is consistent with the mapped-folder guest principal boundary being unsuitable to hold a signing key. Your report correctly marked G4 BLOCKED. Do not repeat unchanged happy-path tests unless a security-sensitive source change requires them.

The current host HMAC key handoff via a guest-readable mapped file cannot authorize production, even if the supervisor deletes it before launching its OWN child: a hostile process may already be running in the guest.

## 1. New GitHub architecture and code to inspect

Read the new architecture decision BEFORE editing:
https://github.com/pddczpl/ChatMCP/blob/feat/phase1-complete-autonomous-coding/docs/PHASE1-G4-PUBLISHER-TRANSPORT-ADR.md

ChatGPT added a SOURCE-ONLY non-attesting feasibility helper:
- CHATMCP-HUB/lib/windows-sandbox-cli-channel-probe.mjs
- CHATMCP-HUB/tests/verify-windows-driver.mjs (portable regression)
- CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs (probe inside an already-owned Sandbox)

This probe sends one fresh PUBLIC echo marker using a fixed guest command in the exact owned guest, then checks the wsb exec --raw JSON keys and whether a Stdout property includes the marker. It always returns productionAuthenticated:false. **An arbitrary echo being forwarded by the CLI does NOT prove authenticated GuestSupervisor origin.** Neither the helper nor its tests enable the production backend.

The real guest code now records an owned-generation value for this diagnostic. It neither starts an unrelated Sandbox nor changes the host shell fallback policy.

## 2. Start with the latest HEAD, not cached Round 5

~~~powershell
Set-Location 'F:\Personal_Project\Vin\ChatMCP'
git status --short
git branch -vv
git remote -v
git fetch origin
gh pr view 13 --json state,isDraft,headRefName,baseRefName,headRefOid
gh pr checks 13
git show origin/feat/phase1-complete-autonomous-coding:docs/agent-handoffs/ANTIGRAVITY_NEXT_TASK.md
git rev-parse HEAD
git diff --check
~~~

Read AGENTS.md if present and preserve unrelated work. Never reset/clean/force-push or change main. Use a separate safe worktree if needed. Sync to the latest PR #13 HEAD, which may be newer than the above report.

## 3. Mandatory G4 feasibility experiment on real Windows

1. Inspect current windows-sandbox-cli-channel-probe.mjs and the exact installed wsb.exe version/help. Build/publish the current GuestSupervisor binary, record source commit + full SHA256. Verify no Sandbox instance other than your positively owned one is touched.
2. Run portable verify-windows-driver.mjs, then an actual serialized real-guest.mjs hardware diagnostic. **A nonzero security-suite exit caused by G4 BLOCKED is expected and must not be relabelled functional PASS.** Record raw exit code, stdout channel observation and the owner's sandbox ID/generation.
3. Return the EXACT observed wsb exec --raw JSON FIELD NAMES and the non-secret Boolean results: CLI_PROCESS_STDOUT_OBSERVED vs CLI_PROCESS_STDOUT_NOT_PROVEN, Stdout field present, bounded marker observed, ExitCode propagated. Do not print a parent command line, signing key or API token.
4. If and ONLY if direct process stdout is genuinely forwarded by this installed CLI, design a SUPERVISOR-owned bounded structured response without sending any signing key to guest-writable mapped storage. The HOST must authenticate the exact pinned supervisor process and instance; an arbitrary child could forge its own echo and must never be accepted. Prove child cannot inherit/write supervisor stdout handles, spoof CLI execution responses or alter the read-only pinned binary.
5. Explicitly attempt hostile earlier guest-process injection of a fake completed/exitCode 0 record, wrong run/nonce/generation/check/snapshot, truncated/oversized response, contradictory CLI exit, timeout, cancellation and instance ownership races. Keep all results BLOCKED if source authenticity remains uncertain. No model-controlled hostAttested toggle or host shell fallback.
6. If stdout is NOT available or its provenance cannot be proven, document the precise CLI/native error and evaluate a truly supported guest-local protected channel/broker design. **Never assume host named pipes automatically cross into Windows Sandbox VM.** Do not implement speculative IPC merely to turn a security gate green.

## 4. G3 and G6 follow-up evidence

- Rerun native child SID/privilege/integrity/Job Object and WindowStation/Desktop/process/token DACL/Win32 error checks AFTER any C#/driver security changes. Distinguish real WMI query result from unavailable/error; no fixed PARENT_AUTH_KEY_VISIBLE=False string as observation.
- Do not rotate host accounts or auto-install Windows features. Verify guest WDAGUtilityAccount password reset cannot persist on the host.
- Preserve original test baseline and rerun actual WorkerTestBroker→SnapshotStore→Backend→owned guest→publisher FAIL→repair→PASS using SCRIPTED model, separately reporting functional E2E vs G4 security status.
- Clean install→first launch→upgrade→uninstall with settings retention should be tested in an owner-approved disposable Windows environment, or clearly marked NOT VERIFIED. Installer build/payload/WebView2 smoke alone is not a clean-machine release gate.
- Run all relevant Hub/React/WebView2/installer and real Windows tests; compare full 9/9 push + 9/9 PR CI on your final SHA. If a source change occurs after security testing, repeat affected Windows checks on the final binary/SHA.
- Never terminate unowned Sandbox UUIDs, force-push, merge PR #12/#13, publish a release or enable shipping hostAttested:true without independent G4 review.

## 5. Product and report invariants

The ChatMCP app is a standalone Windows desktop coding agent, not an external IDE/VS Code integration. The user configures Base URL, model and API key and manages billing/quotas at the provider. **No ChatMCP-imposed token, request or spend limit.** Full Access remains user-selectable with explicit confirmation but is not Windows admin elevation and does not bypass required isolated worker execution.

No paid model API call, no leaked keys, no guest/host privilege escalation, no arbitrary user file deletion. Use synthetic data and script/model fixtures.

**Final Vietnamese report must include:** branch initial/final SHA, changed files/commits, OS/WSB/.NET versions, GuestSupervisor exe hash, exact owned ID/generation, CLI JSON field names/Boolean marker results, child token/process access denials and genuine malicious child output forgery attempts, true G4 status, fresh signed/attested receipts if proven, genuine FAIL→repair→PASS, clean-machine installer status and G1–G6 PASS/FAIL/BLOCKED/NOT VERIFIED with each real exit code. If the native publisher cannot be authenticated, the correct verdict is PHASE 1 BLOCKED — NO MERGE / NO RELEASE.

---

## Older Round 5 and earlier tasks (historical; Round 6 takes precedence)

# ANTIGRAVITY_NEXT_TASK — Round 5: Genuine WMI Evidence, Native Token Errors and Trusted Publisher Transport

Date: 2026-10-13
Assigned to: Antigravity, real Windows workspace F:\Personal_Project\Vin\ChatMCP
Repository: https://github.com/pddczpl/ChatMCP
Integration branch: feat/phase1-complete-autonomous-coding
PR: https://github.com/pddczpl/ChatMCP/pull/13
Issue: https://github.com/pddczpl/ChatMCP/issues/14
Decision: Phase 1 G4 BLOCKED. Do NOT merge PR #12/#13, tag or release.

## A. Why Round 5 supersedes Round 4

Antigravity's Round 4 report at commit 504168d246de03692671263efc627b5ed8ef50e2 reports G3 child token/security improvements, 9/9 push and 9/9 PR CI, 62/62 Hub tests, 46/46 UI tests, 42/42 installer payload checks and 17/17 actual Windows Sandbox coding functional checks. GitHub independently verified the hosted CI on that SHA. The reported G4 BLOCKED verdict is correct because the HMAC key still traverses a guest-writable mapped host output directory; host NTFS ACL behavior through the VM redirector cannot be assumed to isolate low-trust guest users.

Independent GitHub review found a critical error in the evidence: GuestSupervisor's RunChildProbe() had been printing PARENT_CMDLINE_EMPTY=True and PARENT_AUTH_KEY_VISIBLE=False as hard-coded constants rather than querying WMI. Those booleans cannot establish key confidentiality. GitHub has replaced them with a real Get-CimInstance Win32_Process query launched by the restricted child, with explicit PARENT_WMI_STATUS, and has made the acceptance test refuse missing/failed/unsupported queries. Source-only regressions guard against restoring the hardcoded PASS behavior.

Additional security patch: SecureSupervisorProcess() now fails closed if OpenProcessToken or SetKernelObjectSecurity fails rather than silently continuing without token hardening.

Do not revert these checks simply to make 28/28 green. The new changes MUST be compiled and tested on real Windows at the final PR HEAD. Read current remote HEAD first; older fixed hashes are only historical references.

## B. Initial steps

1. Open the actual authorized workspace. Inspect git status, branch, remote, uncommitted changes, AGENTS.md and instructions. Preserve unrelated changes; use a safe separate worktree if necessary.
2. Run git fetch origin and gh pr view 13; read the latest file directly using:
   git show origin/feat/phase1-complete-autonomous-coding:docs/agent-handoffs/ANTIGRAVITY_NEXT_TASK.md
3. Read the current source BEFORE editing:
   - CHATMCP-HUB/windows/sandbox/GuestSupervisor/Program.cs (ProbeParentWmi, RunChildProbe, SecureSupervisorProcess, WDAG token)
   - CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs (G3, WMI and mapped key G4)
   - CHATMCP-HUB/tests/verify-windows-driver.mjs
   - CHATMCP-HUB/lib/windows-sandbox-driver.mjs, windows-sandbox-publisher.mjs and windows-sandbox-backend.mjs
   - docs/PHASE1-STAGED-STATUS.md and Issue #14 comments

## C. Real G3 restricted-child evidence and native failure handling

1. Build/publish the self-contained GuestSupervisor.exe for win-x64 from current source, record exact SHA-256.
2. Execute the updated child probe inside an OWNED disposable Windows Sandbox. Confirm child User SID is separate from SYSTEM and the actual Get-CimInstance parent query returns a real PARENT_WMI_STATUS. If a limited WDAG account cannot use CIM/PowerShell, report the real failure (including native error) as NOT VERIFIED and implement a supported native COM/WMI read-only probe; do not restore synthetic constant booleans.
3. Check OpenProcess query/VM_READ/ALL_ACCESS errors, windowstation/desktop WRITE_DAC/WRITE_OWNER errors, TokenUser/groups/integrity, native Job Object process tree ownership and cancellation.
4. Verify supervisor process and token DACL hardening. New source intentionally rejects failed OpenProcessToken/SetKernelObjectSecurity. If Windows denies required operations, fix the object-access design while preserving fail-closed semantics; never ignore native ACL return values.
5. Check that rotating the system-managed WDAGUtilityAccount password, modifying Session 0 WindowStation/Desktop and spawned handles cannot mutate persistent host identities or other unowned guests.

## D. G4 publisher transport must be secured before production

A missing auth key in parent argv is not proof that mapped output file key material is inaccessible. Even a single synthetic file-read denial at one moment does not prove security against pre-existing guest child processes or redirector ACL races. The updated security suite keeps G4 BLOCKED instead of upgrading it from these observations.

1. Use a disposable synthetic key and an independently launched lower-trust guest process already running BEFORE the host creates the key. Probe read/open/reparse/replace/race while the HMAC key exists; record only access granted/denied and Win32 codes. Never print/hash/commit key material.
2. Investigate a supported supervisor-only publish/response channel that never exposes a bearer key through a guest-writable mapped folder. Probe the actual installed wsb exec --raw stdout/stderr and instance-bound result pathway; prove the untrusted child cannot forge supervisor-owned output. Consider any native pipe only after proving actual cross-VM transport works. If no mechanism is secure, leave G4 BLOCKED and shipping hostAttested:false.
3. Preserve owned instance UUID, launch generation, immutable snapshot/check hashes, pinned supervisor/toolchain and anti-replay binding. Test malicious guest-generated fake completed/exitCode 0 receipt plus matching SHA256 and attempted HMAC signature, with host reading the resulting files UNMODIFIED.
4. Verify output limits, junction/hardlink/reparse swaps, forged signals, WMI/argv/handle key reads, process restart, timeout, concurrent pre-existing guest and cleanup. Distinguish source/mock and diagnostic signed results from production security attestation.

## E. Integration, CI and installer

1. Repeat actual WorkerTestBroker → ExecutionSnapshotStore → WindowsSandboxBackend → owned CLI → GuestSupervisor → trusted publisher, with scripted model and disposable Node project: FAIL → change implementation (not assertions) → PASS. Test grant revocation and permission changes during asynchronous probe; no native host fallback.
2. Re-run actual real-guest.mjs and real-coding-e2e.mjs SERIALIZED, plus all relevant Hub regression suites, React unit/E2E/build, Native DLL publish and installer payload/build, after any security-affecting edit. Each PASS or FAIL must include actual exit code, binary and source SHA.
3. Do not stop other users' Sandbox instances. Stop only positively owned UUID+generation. Ambiguous launch/stop, stale lock and orphan process must quarantine, not blindly retry.
4. A packaged installer build plus WebView2 smoke is not a clean-machine install/upgrade/uninstall trial. Perform the latter only in an owner-approved disposable Windows environment, or report NOT VERIFIED.

## F. Product constraints, Git rules, final report

ChatMCP is a standalone local Windows desktop app, not an IDE or VS Code plugin. User chooses Base URL, API key and model; provider manages billing/usage. DO NOT reintroduce ChatMCP token, request or monetary budgets. Preserve explicit Full Access confirmation, which does not imply Windows administrator elevation and does not bypass isolated worker tests. No paid model calls in these diagnostics.

No destructive git reset/clean, force push, merging PR #12/PR #13, changing main, enabling OS features, reboot, stopping unowned Sandbox or release. Keep production publisher hostAttested:false until independent Windows security review passes.

Commit scoped changes only to feat/phase1-complete-autonomous-coding; verify all 9 PR + 9 push CI jobs on exact final SHA. Final Vietnamese report MUST contain initial/final SHA, changed files, native binary hash, real child SID/token DACL, genuine WMI status (not fabricated), separate key-read and guest forgery evidence, fail→repair→PASS receipts, OS build and CLI, owned instance/cleanup proof, clean-installer status and G1–G6 PASS/FAIL/BLOCKED/NOT VERIFIED with exact command exit codes. If WMI support or key transfer cannot be proven, report the blocker and leave production disabled.

Round 4 and earlier instructions follow as historical context. Round 5 above takes precedence.

---

# ANTIGRAVITY_NEXT_TASK — Round 4: Validate Windows ACL and HMAC-Key Handoff

**Date:** 2026-10-13. **Decision:** G3 non-SYSTEM child SID improved; **G4 production publisher attestation remains BLOCKED/NOT VERIFIED.** Keep PR #12/#13 Draft; no merge or release.

## Latest report and verified facts

- Your Round 3 commit `60ddaa7d64d30b75c0a9ddbc3a6b97adf7961915` is on PR #13. GitHub independently verified PR CI 9/9, push CI 9/9 and portable tests PASS on that SHA.
- You reported Windows 11 Pro build 26300, WDAGUtilityAccount child SID different from SYSTEM, parent WMI argv without HMAC key, real guest 28/28, genuine broker→guest fail/repair/PASS 17/17, 62/62 Hub, 46/46 UI, 42/42 installer payload tests. These functional results are valuable; do not run paid model APIs to repeat them.
- Independent source review found that `.auth_key` is still placed in a host output folder writable from Windows Sandbox with Node `mode:0o600`, which does not establish owner-only Windows ACLs. A negative WMI command-line check alone does not prove file/key confidentiality.
- The native descriptor `D:(A;;GA;;;WD)(A;;GA;;;BU)(A;;GA;;;SY)` grants `GENERIC_ALL` to Everyone and BUILTIN\Users for pipes, process/thread/token and WindowStation/Desktop access. This is not a proven least-privilege security boundary.
- GuestSupervisor resets the built-in WDAGUtilityAccount password via NetUserSetInfo for each run. Confirm this occurs solely inside the disposable guest and cannot change the host/system-managed account state.
- GitHub post-report commits changed the driver to exclusively create `.auth_key` (`flag:'wx'`) rather than overwrite a planted file; GuestSupervisor now rejects guest `--auth-key` argv, refuses missing keys, and fails closed before launching any child on failed secret consumption/erasure. Portable static/regression tests were added. None of these changes independently certifies the Windows ACL.
- **Issue #14:** https://github.com/pddczpl/ChatMCP/issues/14 . Review the latest independent comment there before implementation.

## Mandatory implementation and Windows-real tests

1. **Confirm actual native file ACL while secret exists.** On an owned, disposable Windows Sandbox instance use a synthetic per-run secret, never a real model API key. Inspect effective NTFS access-control entries and parent directory using GetNamedSecurityInfo, GetFileSecurity or icacls. Attempt file open/read as the actual non-SYSTEM restricted child AND as a pre-existing lower-trust guest process while host `.auth_key` is staged, including races before supervisor deletion. Report Boolean access and Win32 error only; never log, print, hash or upload the bearer secret.
2. **Fix G4 file/transport isolation, not just the WMI symptom.** Design and implement a demonstrable Windows-enforced one-use supervisor-only channel or ACL-protected guest-local handoff. Do not assume host pipes work across the host↔Sandbox VM boundary. If guest-writable host mapping cannot protect a secret from untrusted principals, redesign the protocol to isolate the publisher/broker; keep production hostAttested:false until this is proven.
3. **Narrow Windows object permissions.** Replace broad GENERIC_ALL grants for Everyone/BUILTIN\Users with exact required principal SID and least privilege on WindowStation/Desktop, process/thread/token and stdio handles. Check every return value of ConvertStringSecurityDescriptor..., SetUserObjectSecurity, SetKernelObjectSecurity, SetTokenInformation and SID conversion; fail closed and preserve/restore original DACL when required. Prove denied OpenProcess(PROCESS_VM_READ/QUERY), token handle duplication, impersonation and unauthorized desktop modifications.
4. **Account lifecycle.** Prove NetUserSetInfo changes only a disposable guest; either use dedicated ephemeral non-admin account with documented cleanup or justify WDAGUtilityAccount lifecycle. Avoid persistent account or password modification on the host and avoid log/receipt disclosure.
5. **Negative key cases:** missing `.auth_key`; malformed/truncated HMAC key; pre-existing file/symlink/hardlink/junction; guest secret passed through argv; failure to read, overwrite or delete `.auth_key`. For every case, no untrusted child must run and the output must not report an authenticated PASS. Test the latest exclusive-create and native fail-closed changes on real Windows (not only portable source tests).
6. **True guest-origin spoof:** restricted malicious child attempts to alter receipt.json, checksum and signature, with a host verifier reading the untouched resulting files after child exit. Include replay/stale run, generation, check and snapshot hash attacks. Key material must remain unrecoverable even to a child from an earlier run.
7. **Re-run full-stack diagnostics on the final SHA:** WorkerTestBroker → ExecutionSnapshotStore → WindowsSandboxBackend → owned CLI driver → supervisor → HMAC publisher; Node test FAIL → scripted implementation-only repair → PASS, unchanged assertions, parsed TAP, callback cancellation and cleanup. Keep the test-scoped hostAttested:true distinct from shipping hostAttested:false. Never stop unowned Sandbox UUIDs.
8. **Release gate:** clean-machine install → first launch → upgrade preserving user settings → uninstall preserving unrelated files on a user-approved disposable VM, or clearly report NOT VERIFIED. Installer build/payload and WebView2 smoke alone do not establish this gate.

## Scope, Git safety and reporting

Work in `F:\Personal_Project\Vin\ChatMCP` on `feat/phase1-complete-autonomous-coding`. Begin with git status, branch, git fetch, PR #13 HEAD, AGENTS.md and diff of latest GitHub commits. Preserve unrelated edits; do not reset/clean/force-push. Review old Round 3 notes below only as historical context. Directly IMPLEMENT, BUILD, TEST, DIAGNOSE and FIX, not merely analyze.
Preserve product decisions: standalone Windows desktop without external IDE, user-owned compatible Base URL/model/API key, no ChatMCP model-token/request/spending budget, explicit Full Access with typed confirmation, Windows Sandbox as OS isolation for automated tests, and **no host shell fallback or paid model benchmark**.
Do NOT change production `WindowsSandboxPublisher({hostAttested:false})` to true unless an independently reviewed, non-forgeable Windows trust boundary is proven and explicitly approved. Do not merge PR #12 or #13, change main, tag or release.
At completion push only scoped changes to PR #13; inspect both hosted CI workflows on the exact final SHA, re-run real guest negatives after any source/security change, and return a Vietnamese G1–G6 PASS/FAIL/BLOCKED/NOT VERIFIED matrix with actual child SID, native ACL, key-read denials, attack results, signed TAP evidence, cancellation/ownership, installer and hashes. If unable to prove the Windows file/key boundary, report G4 BLOCKED instead of inventing PASS.

---

## Earlier Round 3 task (historical context; Round 4 above takes precedence)
# ANTIGRAVITY_NEXT_TASK — Round 3, Confirmed HMAC Key Leak (2026-10-13)


**New acceptance-test contract:** The current real-guest.mjs now includes the child User SID (whoami /user), parses that SID and checks the Boolean PARENT_AUTH_KEY_VISIBLE via restricted-child WMI, without logging any HMAC secret. It deliberately returns **nonzero G3/G4 security acceptance** while the child remains SYSTEM or the key remains exposed. Do NOT "fix" that failing test by bypassing its verdict. Make the OS boundary genuinely secure and re-run the real guest test on the final SHA.

The owner-only cleanup utility is exercised by verify-windows-driver.mjs and the real-coding-e2e.mjs diagnostic. Any new or unowned Windows Sandbox guest seen during cleanup must NEVER be stopped by the test. The real-coding E2E success status is explicitly **FUNCTIONAL DIAGNOSTIC ONLY**, not a security gate. Shipping assemble.mjs must continue to construct WindowsSandboxPublisher with hostAttested:false until independently approved.

**P0 SECURITY DEFECT CONFIRMED BY REAL WINDOWS GUEST:** A restricted test child still has SYSTEM User SID S-1-5-18 and can retrieve the SYSTEM supervisor's command-line HMAC bearer key using WMI. Reducing privileges and marking Administrators deny-only DOES NOT change the token's user SID. **G4 = FAIL. PHASE 1 = BLOCKED.**

**TRACKING ISSUE:** https://github.com/pddczpl/ChatMCP/issues/14 (mandatory prerequisite to Phase 1 security acceptance; NOT optional Phase 2 work).

**DECISIONS ALREADY MADE — DO NOT ASK AGAIN**
1. Keep PR #13 and PR #12 Draft/Open. No main merge, tag, release, or production worker enablement. Continue implementation of this fix under Phase 1 on feat/phase1-complete-autonomous-coding.
2. A named pipe is NOT automatically a secure host↔guest pipe; Windows Sandbox is a separate VM. Verify actual wsb transport and Windows security descriptors before proposing it as the solution.
3. The preferred identity invariant is that arbitrary code runs under a **different non-SYSTEM, standard-user SID/security principal** from the trusted supervisor; a merely restricted SYSTEM token is insufficient. Any alternative must demonstrate equally strong child isolation and WMI secrecy. Implement via verified native Windows primitives, do not emulate account separation with a Boolean receipt flag.
4. The HMAC signing key must not be recoverable from process argv, environment, mapped input, inherited handles, WMI/CIM, or untrusted guest scripts. Investigate a one-time ACL-protected internal guest channel/bootstrap or an OS-authenticated host broker, but **never assume a Windows host pipe crosses Sandbox VM boundary**. If infeasible, document the exact blocker and leave hostAttested:false.
5. Preserve the user's BYO Base URL/API key/model, unlimited provider-managed API usage, standalone desktop without IDE integration, and explicit Full Access confirmation. Full Access must not bypass test isolation or grant Windows elevation.

## What changed in GitHub after your report cc22baa

- New test-only owner cleanup helper: CHATMCP-HUB/tests/windows-sandbox/owned-guest-cleanup.mjs.
- The real-coding-e2e.mjs script had an UNSAFE loop stopping EVERY Sandbox listed by wsb list, including potentially another user's Sandbox created during the test. It is now replaced with owned UUID+generation-only cleanup, and uncertain ownership must result in BLOCKED rather than stopping an unknown guest. A portable unit test asserts that foreign instance UUIDs are never stopped.
- A 300-second watchdog used to process.exit(2) without cleanup. The diagnostic now aborts owned operations cooperatively and reaches owner-only cleanup.
- real-guest.mjs WMI audit now returns only a Boolean PARENT_AUTH_KEY_VISIBLE=True/False, never the key; a visible bearer key results in **G4 FAIL and nonzero security acceptance exit**, even if other functionality checks pass. Do not silence that failure or mark it 28/28 security PASS.
- Check the remote PR #13 HEAD fresh; never assume the SHA from this description is the final tested SHA.

## Required implementation and evidence

### G3 / G4 — Fix the actual trust boundary, not just the symptom

- Inspect the current GuestSupervisor Program.cs token creation, privilege/group data and CreateProcessAsUserW path. Produce a real separate standard-user child token SID different from S-1-5-18. Verify child User SID, Administrators deny-only, restricted SIDs, integrity, privileges, WMI access to parent supervisor and relevant PROCESS_QUERY/VM_READ access. Deny process handles and parent command-line reads.
- Remove HMAC key from SYSTEM supervisor argv / inheritable environment. Investigate and implement a proven secure key-transfer mechanism with guest-only ACL/pipe/bootstrap synchronization. Run real attack attempts from the separate low-privileged child. The key is never printed, persisted to repo, included in stdout, or stored in a guest-untrusted mapped file.
- The real malicious guest child must attempt to forge receipt.json and SHA-256 and HMAC signature from inside the guest; host must read the unchanged resulting artifacts and reject unauthorized signed PASS. Cover WMI/argv, handle inheritance, permissions, stale/replayed request, children/grandchildren, timestamp/snapshot/check mismatch, cancellation.
- DO NOT set production hostAttested:true just to make the fixture pass. Keep the sandbox-only worker backend unavailable until the user approves a separate independent security review of the final implementation and raw OS evidence.

### G2 / E2E — Preserve actual achievements, avoid unsafe testing

- The new real-coding-e2e.mjs is a helpful **test-scoped** full-stack harness: actual guest failure then scripted code repair and actual guest PASS, not a live model benchmark. It injects hostAttested:true to test wiring, so its signed receipts are NOT proof of the current production key boundary.
- Rerun on the final SHA after security changes and provide guest UUID, child non-SYSTEM token SID, immutable baseline hash, signed but security-attested receipt identity, TAP counts, and genuine malicious child forgery denial. Test that a revoked grant or parent downgrade causes zero launches.
- Never stop an unowned Sandbox. An unknown instance appearing during cleanup is a BLOCKED/manual reconciliation result, not authorization to call wsb stop on its UUID. Verify test-only cleanup helper on real Windows. Preserve forensic output when ownership is uncertain.
- Ensure the watchdog cancellation does not leave orphan Sandbox processes or kill an unrelated guest.

### G6 — Installer / desktop

- A successful setup build, payload regression and WebView2 smoke are NOT clean-machine installation evidence. Test install, launch, upgrade and uninstall in a user-approved disposable Windows environment, or say NOT VERIFIED. Preserve unrelated config and files.
- Verify isolated guest runtime files and SHA manifests in their actual installed directories. Missing Windows Sandbox must not make the desktop unusable or force reboot/feature installation.
- Do not call paid model APIs.

## How to execute and report

1. Read this entire file, AGENTS/workspace rules and the linked Issue #14. Work on the real F:\Personal_Project\Vin\ChatMCP Windows workspace. Fetch origin, inspect git status, branch and PR #13 HEAD; preserve unrelated edits, no destructive reset or force push.
2. Make narrowly scoped code/Win32 changes, add regression + real OS security probes, run full relevant Node, Windows Sandbox guest, React/WebView2 and installer tests serially where guest ownership matters. Check 9/9 PR and 9/9 push CI jobs on the same final SHA. Commit/push only PR #13 branch.
3. Return exact tested SHA, command exit codes, Windows build and verified child distinct user SID, WMI key secrecy results, actual 28-check functional result vs G4 FAIL/PASS, E2E failure→repair→PASS receipts, guest UUID/cleanup evidence, installer results and G1–G6 acceptance matrix.
4. If different non-SYSTEM SID or secure key channel is blocked by actual Windows APIs, state concrete error and propose a feasible prerequisite. Do NOT report Phase 1 GO.

**VERDICT UNTIL PROVEN AND INDEPENDENTLY REVIEWED: P0 G4 FAIL — PHASE 1 BLOCKED — NO MERGE / NO RELEASE.**

---

## Historical Round 2 and initial task instructions (read for context)

# ANTIGRAVITY_NEXT_TASK — Round 2, Security Remediation (2026-10-13)

**Verdict: PHASE 1 BLOCKED — NO MERGE / NO RELEASE.**

**The previous Antigravity report was received.** It reported Windows 11 Pro build 26300, Windows Sandbox CLI 0.8.107.0, GuestSupervisor hash 606aa8c1ee523ad36d0691fe9b18be600e7b46b937e7ed6c1b4f2d6f0be35003, 25 prototype guest checkpoints, 62 Hub suites, 46 UI unit tests, 7 Playwright tests, 42 installer-payload checks, and a successful installer build/WebView2 smoke. We do NOT need another copy of the same report. **Fix the precise remaining blockers and collect stronger evidence.**

The previous report tested SHA **310e9fe5afbe1b8b834197c6486d3db745b6fe5f**. ChatGPT then changed the output verifier and test labels at commit **f61346ed83caed07a743068fe316a606b6fdfad5**, plus the subsequent documentation commit. **Fetch the actual PR #13 HEAD before work and retest the new final source and published exe hashes.** Work on branch **feat/phase1-complete-autonomous-coding** only. Preserve unrelated local changes and do not force-push, merge, tag or release.

## P0 / G4 — Fix unverified publisher key transfer

1. Currently CHATMCP-HUB/lib/windows-sandbox-driver.mjs places a 256-bit HMAC key on the command line of the SYSTEM GuestSupervisor via wsb exec -c. The restricted child is not intended to read that key, but no conclusive negative OS test covers its visibility through command-line/process enumeration. Production in CHATMCP-HUB/lib/assemble.mjs correctly has hostAttested:false; **DO NOT switch it to true for green tests**.
2. Design and **prove** a safer one-use transfer from the host to the trusted supervisor that does not expose the key in supervisor argv, readable guest-mapped input, environment, logs or child-inherited handles. A named pipe / guest-local protected channel is a candidate **only if verified to work across Windows Sandbox's host/guest VM boundary and with the exact wsb CLI**. Do not invent an assumed cross-VM named pipe. If impossible, document BLOCKED with a minimal transport prerequisite instead of changing the isolation policy.
3. From the actual restricted child, attempt to query the supervisor's command line/process metadata with relevant Win32 APIs, including OpenProcess / QueryFullProcessImageName / Process command-line queries as supported. Record access granted/denied and the actual SID, integrity, groups and privileges. **Never print, hash or upload the key or any real API secret.**
4. Test a **real guest-origin** receipt forgery. The restricted child, not the host, attempts to replace receipt.json, receipt.sha256 and receipt.sig and recompute SHA-256 for fake completed/exitCode:0. After the guest exits, the host verifier must read the files **without changing them itself**. Record child's actual exit/error, resulting host HMAC result, replay/stale mismatch, and key-visibility outcome.
5. Previous real-guest.mjs section D was mislabelled: it tried a guest write but then manually overwrote receipt.json and receipt.sha256 on the HOST. That is a useful host-tamper regression, not an authentic OS proof of inaccessible HMAC key. The GitHub reviewer corrected this label. Preserve the original check; add a separate genuine in-guest adversarial test.
6. The PR #13 receipt reader now uses descriptor-bound, byte-limited reads. On actual Windows, test concurrent export rewriting, oversized files, symlink/reparse/junction substitution and hard-link cases. Node's POSIX O_NOFOLLOW is not a native Windows no-reparse guarantee. Fail closed on unproven security.

## P0 / G2–G3 — Prove the full coding stack in a real guest

The previous report's D3 statement says full integration was verified. Yet production hostAttested:false means real worker execution through the registered backend remains UNAVAILABLE; verify-phase1-coding-e2e.mjs explicitly uses FakeIsolatedBackend. Meanwhile real-guest.mjs calls wsb/GuestSupervisor directly. Those are **two separate partial tests**, not genuine production-path E2E.

Implement a **test-scoped, owner-invoked diagnostic harness** that exercises WorkerTestBroker -> ExecutionSnapshotStore -> ExecutionRegistry -> WindowsSandboxBackend -> LazyWindowsSandboxDriver -> real wsb guest -> trusted authenticated publisher, with a disposable Node project and scripted model. It must not expose a model/API flag for switching on hostAttested, or enable untrusted production execution. Only if the key-transfer boundary is genuinely proven should the product-level security gate later be enabled through a separately reviewed controlled mechanism.

Required real E2E: initially failing Node test -> agent repairs implementation **without changing original assertions** -> new immutable code snapshot -> authenticated test PASS with parsed nonzero TAP assertions -> manual review remains separate. Verify no host command fallback. Include Stop/cancel, lost instance ID, stale active.lock, guest exec failure, parent policy downgrade/grant revocation between probe and dispatch, crash/restart and owned-instance cleanup. Never stop a guest without a proven owned UUID.

## P1 / G6 — Separate build/smoke from real installation

A successful Build-Installer.ps1, Test-InstallerPayload.ps1 and WebView2 smoke is **NOT** evidence of clean-machine install, upgrade and uninstall. Use an explicitly disposable Windows VM / test environment and capture actual installer install -> first launch -> upgrade with preserved user settings -> uninstall preserving unrelated data, or mark this gate NOT VERIFIED. Verify installed layouts:
- CHATMCP-HUB/runtimes/windows-sandbox/GuestSupervisor.exe plus SHA-256 manifest.
- runtimes/node/node.exe plus SHA-256 manifest (sibling to CHATMCP-HUB).

Confirm the desktop starts without Windows Sandbox and reports blocked execution honestly (no forced Windows feature installation/reboot). Full Access must still require explicit FULL ACCESS confirmation; it is not admin elevation. ChatMCP remains a standalone WinForms/WebView2 desktop app, no external IDE. Model Base URL, API key, model and provider-side usage/billing remain under the user. **No ChatMCP model-token/spend budget** and **no paid API requests** during testing.

## Evidence, branch and completion rules

- Begin with git status / branch / fetch / PR #13 HEAD / AGENTS rules. Do not overwrite dirty worktrees; do not reset, clean, force-push or merge.
- Group tests by: host preflight; synthetic/mock; functional guest; genuine negative security; integrated guest E2E; clean-machine installer; cleanup. **25 checkpoints are not 25 negative security probes.**
- Report actual OS build, CLI, .NET/Node, signed helper and installer hashes, all real exit codes, child SID/groups/privileges/Job evidence, unauthenticated spoof attempts, network and ACL evidence, and exact final SHA. Redact secrets and temporary usernames/paths.
- Rerun all impacted Node/React/installer/real guest checks after source changes. Check all GitHub CI jobs on that same SHA, retain Draft PR #13.
- Return a clear G1–G6 matrix: PASS / FAIL / BLOCKED / NOT VERIFIED with evidence. Mark G4 BLOCKED unless transport secrecy and host-verifier origin are independently demonstrated.
- **Do not merge PR #12 or #13, update main, tag or release.**

### Historical original handoff

The original detailed execution instructions follow for reference. This Round 2 section takes precedence if any instructions differ.

---

# ANTIGRAVITY_NEXT_TASK — ChatMCP Phase 1 PR #13

**Issued:** 2026-10-13  
**Assignee:** Antigravity on the user-owned Windows desktop  
**From:** ChatGPT GitHub implementation/review  
**Status:** Ready for real Windows acceptance; NOT authorized to merge or release

**This document is the complete executable task. Implement, test, fix, commit, push and report the real results. Do not merely return a plan.**

## A. Authoritative scope and product decisions

Repository: https://github.com/pddczpl/ChatMCP  
Integration PR: https://github.com/pddczpl/ChatMCP/pull/13  
Work branch: feat/phase1-complete-autonomous-coding  
Base branch: feat/phase1-integrate-windows-sandbox-experimental (PR #12)  
Local workspace: F:\Personal_Project\Vin\ChatMCP  
PR #12 guest security work: commit 6f22d58f0ca97fa300f656127dce5af81bc13faa  
PR #13 reference HEAD before this task document: caee25fdf36356334b38db42982f1f016aa618d5. **Fetch the actual HEAD before changes and record exact final SHA.**

The product is a standalone Windows desktop coding agent, not a VS Code/IDE plugin. It uses its own WinForms/WebView2 window, file tools, terminal, Git review and UI. Model Base URL, API key and model come from user settings. **No ChatMCP-imposed model token, API-request or monetary spending budget.** Provider billing/rate limits belong to the user. Do not reintroduce WorkerBudget or remove explicit Full Access, which requires the user to confirm FULL ACCESS and never grants Windows elevation. There are still separate security limits on concurrent processes, isolated test attempts, timeouts, permissions, cancellation and Sandbox ownership. Do not use actual paid model API keys for this handoff: use scripted provider fixtures.

Windows Sandbox remains the OS isolation choice for untrusted automated worker tests. There is **no** silent host shell fallback, Docker/WSL replacement or permission bypass. The production publisher is intentionally created with hostAttested:false until real evidence justifies a separately reviewed production enablement.

## B. Git safety and read-only intake

Run PowerShell from the real Windows workspace. Preserve any unrelated existing edits and user branches; if dirty, use a separate clean worktree or stop and report the conflict. No destructive reset, clean, force-push or merge.

~~~powershell
Set-Location 'F:\Personal_Project\Vin\ChatMCP'
git status --short
git branch -vv
git remote -v
git rev-parse HEAD
git fetch origin
gh pr view 13 --json state,isDraft,headRefName,baseRefName,headRefOid
gh pr checks 13
git log -5 --oneline origin/feat/phase1-complete-autonomous-coding
git diff --check
~~~

Read README.md, SECURITY.md, docs/ARCHITECTURE.md, docs/DEVELOPMENT.md, docs/PHASE1-IMPLEMENTATION-PLAN.md, docs/PHASE1-STAGED-STATUS.md, docs/WINDOWS-SANDBOX-REAL-FEASIBILITY.md and AGENTS.md/rules if present. Inspect all source before editing, especially:

- CHATMCP-HUB/lib/assemble.mjs, windows-sandbox-backend.mjs, windows-sandbox-driver.mjs, windows-sandbox-publisher.mjs, windows-sandbox-transport.mjs, execution-snapshot-store.mjs and execution-snapshots.mjs.
- CHATMCP-HUB/lib/worker-test-broker.mjs, worker-tools.mjs, verification-receipt.mjs, coding-orchestrator.mjs, coding-verification-loop.mjs, worker-capabilities.mjs, worker-scheduler.mjs, dynamic-delegates.mjs and permissions.mjs.
- CHATMCP-HUB/windows/sandbox/GuestSupervisor/Program.cs, CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs and smoke.mjs.
- CHATMCP-HUB/hub.mjs, React OrchestratorTab.tsx, IsolatedChecksPanel.tsx, DynamicSubagents.tsx and VerificationReceipts.tsx.
- scripts/Build-Installer.ps1, scripts/InstallerPayload.ps1, scripts/tests/Test-InstallerPayload.ps1 and native WebView2 installer code.

## C. Host / guest preflight (do not mutate Windows settings)

~~~powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture
Get-CimInstance Win32_ComputerSystem | Select-Object HypervisorPresent,TotalPhysicalMemory
Get-CimInstance Win32_Processor | Select-Object Name,VirtualizationFirmwareEnabled
Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM
Get-Command wsb,node,dotnet,git,gh -ErrorAction SilentlyContinue
wsb list --raw
~~~

If prerequisites are unavailable or another unowned Sandbox is running, mark that gate BLOCKED. Do NOT install/enable Windows features, reboot, elevate or stop someone else's instance. Do not start tests that require OS Sandbox until ownership can be proven. Record OS build, CLI and .NET/Node versions, exact git SHA and hash of published GuestSupervisor.exe.

## D. Mandatory real Windows security checks

**D1 — Supervisor restricted token / Job Object:** Start only a positively owned disposable Sandbox. Launch supervisor in the correct bootstrap identity and verify the untrusted test child actually has a separately restricted nonadmin token. Capture child SID, admin deny-only groups, privileges, elevation and integrity, and prove protected guest input/supervisor/request files cannot be modified. Verify suspended child -> Job attachment -> resume sequence. Inject failures in identity, token creation, CreateProcessAsUser, Job assignment, resume, wait, exit code and timeout, asserting zero privileged fallback and no surviving grandchildren. Do not trust only a JSON restrictedChild flag.

**D2 — HMAC trust boundary:** Host creates per-run key; the driver currently passes it as SYSTEM supervisor command-line argument. **Prove the untrusted child cannot read that key via process enumeration, command line, handles, environment, file mappings, logs or system diagnostics.** If confidentiality is not proven, keep publisher production availability false; propose a safer authenticated pipe/ACL-protected broker handshake instead. Malicious child must attempt forging receipt.json and receipt.sha256, recomputing checksum for a fake completed/exitCode 0; without the key it must NOT be able to replace receipt.sig with a matching HMAC. Verify nonce, run, instance/generation identity, snapshot hash, check hash, pinned toolchain hash, anti-replay, truncated output, oversized files, symlink/junction paths, export flooding and strict publisher verdict. Assert a zero exit code without actual Node test assertions is UNVERIFIED.

**D3 — Real CLI integration:** Execute the actual WindowsSandboxBackend -> LazyWindowsSandboxDriver -> GuestSupervisor -> WindowsSandboxPublisher path, not just the standalone PR #12 real-guest fixture. Verify wsb start -c XML and exec --raw argument/exit-code parsing on the installed build. Test owner-only stop and list, occupied slot, simultaneous dispatch, crashes during wsb start, unknown instance ID, disk staging error, interrupted output collection, Stop and cleanup. Stale active.lock must quarantine an orphan but a live-owned lock must not permanently quarantine a healthy run. Never stop an instance not positively owned.

**D4 — OS isolation:** Test synthetic host canaries with unauthorized read AND write; read-only input mapping; guest networking disabled against a valid host-positive control; blocked writes to supervisor binary/request/config; no persistence after cancellation; no real user secrets/profile writable inside guest. An XML setting alone is not runtime evidence. Separate genuine negative security assertions from preflight, staging, happy-path and cleanup counters.

## E. End-to-end coding worker, test broker and standalone UI

With a disposable synthetic Node project and SCRIPTED model (no paid API), run one real failed-check -> repair -> retest scenario through the actual application components:

1. Start ChatMCP desktop and Local Hub without requiring VS Code. Confirm user-set Base URL/model/API key settings, Read Only, Review, Autonomous and opt-in Full Access remain visible. Do not expose/send a real credential.
2. Create a managed Git worktree with explicit user authorization. The coding model edits ONLY its managed branch.
3. checks_list discovers only pinned offline node --test; bind both package.json test definition AND test source files. A malicious npm lifecycle script or deleted/modified baseline test must invalidate a grant.
4. Owner explicitly grants AUTHORIZE ISOLATED CHECK; grant has immutable worker ID, check ID, policy, source/snapshot hash, expiration and bounded test attempts.
5. Execute WorkerTestBroker -> ExecutionSnapshotStore -> ExecutionRegistry -> WindowsSandboxBackend -> actual wsb guest -> HMAC receipt verifier.
6. First run must produce a genuine failing assertion with recorded signed receipt. Simulate one bounded code repair that changes implementation only; second actual guest test must PASS with a new fresh code snapshot and original test baseline.
7. Check parent permission change and grant revocation during asynchronous capability probe; no guest executes after permission/grant revocation. A worker must never gain host shell, Git push, secret access or auto-merge because Full Access is selected.
8. Cancellation, restart, stale evidence, zero tests, forged positive TAP, changed tests, missing dependencies, skipped checks and backend unavailable must result in explicit BLOCKED/NEEDS_ATTENTION rather than invented green passes.
9. A completed test does not grant integration/publishing. Verify manual diff review and draft PR confirmation are still independent user actions.

The GitHub portable verify-phase1-coding-e2e.mjs test uses synthetic OS results. It proves a control-flow fixture, NOT that Windows Sandbox actually enforces boundaries. Provide real guest logs/exit codes/hash evidence for this final PR source SHA.

## F. Installer, clean-machine and native release readiness

Check the actual installed ChatMCPSetup.exe payload, not only source code. Validate these two distinct install paths and their hashes:

- CHATMCP-HUB/runtimes/windows-sandbox/GuestSupervisor.exe (self-contained published .NET binary).
- runtimes/node/node.exe (portable Node runtime, a SIBLING of CHATMCP-HUB).

PR #13 patched assemble.mjs to resolve the sibling Node path and added installer regression coverage. Validate clean install, upgrade, uninstall, WebView2 startup, user configuration retention, empty/new workspace, missing Sandbox feature without forcing restart, and no deletion of unrelated data or guests. Installer build success in hosted CI is NOT a clean-machine install/upgrade/uninstall PASS.

## G. Tests to run and preserve

Run real Windows guest tests SERIALIZED — one positively owned Sandbox only. Run other portable suites normally. Adapt commands only after checking the actual repository scripts and working directories.

~~~powershell
Set-Location 'F:\Personal_Project\Vin\ChatMCP'
node CHATMCP-HUB/tests/verify-execution-contract.mjs
node CHATMCP-HUB/tests/verify-execution-snapshots.mjs
node CHATMCP-HUB/tests/verify-execution-snapshot-store.mjs
node CHATMCP-HUB/tests/verify-execution-lifecycle.mjs
node CHATMCP-HUB/tests/verify-windows-driver.mjs
node CHATMCP-HUB/tests/verify-sandbox-publisher.mjs
node CHATMCP-HUB/tests/verify-worker-tests.mjs
node CHATMCP-HUB/tests/verify-worker-scheduler.mjs
node CHATMCP-HUB/tests/verify-dynamic-delegates.mjs
node CHATMCP-HUB/tests/verify-coding-loop.mjs
node CHATMCP-HUB/tests/verify-phase1-coding-e2e.mjs
node CHATMCP-HUB/tests/verify-v2-http.mjs
node CHATMCP-HUB/tests/windows-sandbox/smoke.mjs
node CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs
node CHATMCP-HUB/tests/run-all.mjs --no-skip all
npm --prefix CHATMCP-HUB/ui run test:unit
npm --prefix CHATMCP-HUB/ui run build
npm --prefix CHATMCP-HUB/ui run test:e2e
dotnet publish CHATMCP-HUB/windows/sandbox/GuestSupervisor/GuestSupervisor.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tests\Test-InstallerPayload.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Build-Installer.ps1
node CHATMCP-HUB/ui/e2e/webview2-smoke.mjs
git diff --check
~~~

Report every real exit code and whether a test is portable/mock, real OS guest, UI, or clean-machine installer. Never claim a skipped required gate is PASS. If you edit any relevant code after running Windows tests, retest the affected gates on the exact updated final SHA. Inspect all GitHub Actions jobs on final PR #13 HEAD.

## H. Required report / Git safety

If bugs remain, make scoped fixes ONLY on feat/phase1-complete-autonomous-coding after reviewing local changes; push without force. Do not merge PR #12 or #13, update main, create a tag/release, spend on user API, enable OS features or auto-elevate. Preserve user state. Keep source provenance and security records honest.

Return a Vietnamese report containing: initial/final SHA, changed files and commits; OS/build/feature/CLI/tool versions; G1–G6 PASS/FAIL/BLOCKED/NOT VERIFIED matrix with corresponding raw evidence and final tested SHA; actual restricted-child SID/groups/privileges/Job Object; HMAC key leakage/forgery/replay outcomes; genuine fail -> repair -> retest guest logs and signed assertion counts; Full Access + standalone UI checks; install/upgrade/uninstall; all local commands/exit codes; exact CI run URLs; remaining blockers and handoff back to ChatGPT for independent review.

**Default verdict until all proofs pass: PHASE 1 BLOCKED — NO MERGE / NO RELEASE.**
