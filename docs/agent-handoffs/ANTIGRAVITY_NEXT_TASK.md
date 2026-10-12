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
