# ANTIGRAVITY_NEXT_TASK — Round 3, Confirmed HMAC Key Leak (2026-10-13)

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
