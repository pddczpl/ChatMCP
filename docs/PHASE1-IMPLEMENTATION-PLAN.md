# Phase 1: Windows isolated verification and bounded coding workers — Implementation Plan

The independent-review waiver applies to the current Phase 0 integration only. It grants no future implementation, OS setup, execution, spending, publication, or review exception. Existing repository rules and any later task authorization govern Phase 1.

**Status:** Implementation plan finalized 2026-10-12 after Phase 0 PRs #7/#8 merged and integrated main `2764000da93b466f933ecfadfad2f4c0bec1abca` passed [all nine CI jobs](https://github.com/pddczpl/ChatMCP/actions/runs/38240516292). No Phase 1 implementation, operating-system setup, model spending, or release is authorized by this document. This is the next phase after the current desktop Phase 0; the older `docs/PHASE1-DESIGN.md` describes historical v2.3.0 work and is not this specification.

**Goal:** Let coding workers verify and repair their own changes through an explicitly isolated Windows execution service, with bounded retries and delegated authority that can only decrease.

**Architecture:** Keep the provider and credentials in the local Hub. Keep file editing in broker-owned, individually scoped worktrees or snapshots, and execute project code only in a verified OS execution backend when isolation is requested. A trusted test broker owns snapshots, environment, execution, cancellation and receipts; workers receive test IDs and evidence, never a general host shell or the broker's authority.

**Tech stack:** Existing Node.js ESM Hub and React/TypeScript UI; an intentionally small .NET 10 Windows guest supervisor if required for process ownership and Job Objects; Windows Sandbox CLI as the first candidate backend. The application retains Windows 10/11 support; the first isolated execution backend targets Windows 11 24H2+ x64 on supported editions. Missing backend prerequisites must not prevent ordinary application installation/startup. Integration tests use disposable fixtures and a scripted loopback model.

**Spec and existing contracts:** Current user direction plus `docs/PHASE0-DESKTOP-CONTRACT-AUDIT.md`, `docs/ARCHITECTURE.md`, and the actual modules listed below. Establish the merged main SHA and its successful CI run before implementing; do not treat historical phase reports as proof of current behavior.

## Global constraints

- Local, single-user desktop scope. No cloud service, remote execution service, public listener or multi-tenant design.
- A Git worktree separates changes; it is not a security boundary. Permission prompts, command classification and environment scrubbing are also not OS isolation.
- Existing Read Only, Review, Autonomous, `sandbox-only`, `host-review` and `full-access` settings must keep their actual restrictions. Model role names cannot change them.
- An isolation-required operation either runs in a backend verified for that operation or returns a structured blocked result. Never retry it on the host, WSL, Docker or a different provider implicitly.
- Preserve existing explicit integration/publish decisions. Tests cannot integrate, push, publish, install host software, change OS features, reset another user's Sandbox or grant new capabilities.
- Workers never receive provider credentials, user profiles, SSH agents, credential helpers, browser profiles, Docker sockets, host named pipes, existing Hub state or arbitrary environment overrides.
- No live-model benchmark is automatically triggered by CI or source changes. The user chooses the AI base URL, API key, and model, and controls usage, rate limits, and billing at their provider. ChatMCP does **not** set a token, model-request, or monetary usage quota; lack of an app-side quota never bypasses local execution permissions.
- Technical safeguards such as isolated-process timeouts, bounded retry/check grants, owned-instance cleanup, and concurrency are unrelated to provider charges. No new live-model benchmark or paid requests are authorized by merely editing this plan.

## Current implementation and gaps

| Touchpoint | Current behavior | Phase 1 change |
| --- | --- | --- |
| `CHATMCP-HUB/lib/sandbox-engine.mjs` | Only `host`; reports `osIsolated:false`. Memory/CPU fields are not enforced by this class. | Explicit execution providers and enforced-versus-requested capabilities. |
| `CHATMCP-HUB/hub.mjs` | Creates a standalone host SandboxEngine for `/api/sandbox/status`; other execution routes use different objects. | Wire one capability registry/broker; ensure reported status describes the route that actually executes. |
| `CHATMCP-HUB/lib/assemble.mjs` | Wires ShellRunner, local tools, terminal, permissions and verification. | Inject the broker into actual execution consumers without changing ordinary host execution defaults. |
| `CHATMCP-HUB/lib/studio-sandbox.mjs` | Docker Linux-only, read-only host workspace mount, no network; separate terminal path. | Retain as a clearly named optional Linux verification backend; it does not establish Windows test compatibility. |
| `CHATMCP-HUB/lib/coding-orchestrator.mjs` | Explicit worktree confirmation; 1–4 static coding tasks; workers have bounded file/read tools and no shell. | Add brokered check tools, evidence-aware completion and bounded delegation. Keep arbitrary shell revoked. |
| `CHATMCP-HUB/lib/studio-verification.mjs` | Accepts discovered command strings; relies on terminal state; never replays interrupted work. | Content-bound check IDs and execution receipts independent of model text or terminal retention. |
| `CHATMCP-HUB/lib/studio-delegates.mjs` | Read-only research/static DAG; no code execution tools. | Preserve behavior; reuse attenuated capabilities and bounded simultaneous execution for dynamic descendants; no token/spend allocator. |
| `CHATMCP-HUB/lib/agent.mjs` | Existing task states, events, cancellation, steps/minutes and usage accounting; default top-level limits may be unbounded. | Bound only the new verified coding workflow; do not silently change unrelated task behavior. |

## Windows backend decision and prerequisites

Read-only inspection of this development machine on 2026-10-12 found Windows 11 Pro x64, OS version `10.0.26300`, no `C:\Windows\System32\WindowsSandbox.exe`, and no `wsb.exe` command. CIM reported `HypervisorPresent:true` and false for the processor firmware-virtualization/SLAT fields; those processor fields under a hypervisor are not a conclusive hardware or firmware diagnosis. Actual isolation remains unavailable/unverified here. No Windows feature was enabled, Sandbox launched, reboot requested or host configuration changed. PR 2 needs a supported, explicitly prepared execution environment before its real gate can pass.

**First candidate: Windows Sandbox, gated by a real feasibility PR.** It has a separate kernel through Microsoft's hypervisor, supports Pro/Enterprise/Education editions, excludes Home, and currently permits only one instance at a time. Consequently, multiple model workers may prepare changes concurrently, but isolated execution is a single-owner queue. Never adopt a Sandbox the user already opened. These are documented product constraints, not inferred capabilities. [Microsoft Windows Sandbox overview](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/)

The initial supported target should be **Windows 11 24H2 or later, x64**, matching the current installer architecture. The CLI begins with 24H2 and provides creation, instance IDs, command exit codes, folder sharing and stopping. Its documented `exec` does **not** provide process output streams. Probe actual installed CLI functionality and JSON output; an OS build number alone is insufficient. The documentation's CLI example uses `Disabled` while the configuration reference specifies `Disable`: generate settings from the reference, and prove effective network denial in the smoke test. [Microsoft Windows Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)

The machine needs firmware virtualization, the Windows Sandbox optional feature and any required restart/client setup. Microsoft's base minimums are 4 GB RAM, 1 GB free disk and two CPU cores, with higher recommended resources. These are not adequate guarantees for every project. Set a product preflight target of **8 GB host RAM and 10 GB free space** for the initial small offline fixture; report per-project toolchain needs separately. Feature enablement/restart are owner actions, not automatic installer steps. [Microsoft installation requirements](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install)

Require networking, clipboard, audio, video, printer and vGPU sharing disabled; Protected Client enabled; fixed absolute input mappings read-only. Copy inputs into a guest-local writable workspace. Never map the real workspace writable. Writable exports affect host files, so a narrow artifact channel is an explicit part of the threat model, not an exception to ignore. Start with 4096 MB guest memory; report the effective value and do not advertise host CPU/disk limits without an enforcement mechanism. [Microsoft Sandbox configuration reference](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)

**Alternatives are deferred, not silent fallbacks:**

- Hyper-V-isolated Windows containers have a separate kernel and can support concurrent instances. Process-isolated Windows containers share the host kernel. An explicit future adapter could use pinned Windows images and mandatory `--isolation=hyperv`; Docker/Windows-container mode, image compatibility and deployment prerequisites add substantial setup. [Microsoft isolation modes](https://learn.microsoft.com/en-us/virtualization/windowscontainers/manage-containers/hyperv-container)
- Windows client container prerequisites and usage terms need to be checked for the intended desktop distribution, not extrapolated from a developer machine. Do not ship an automatic Docker installation or promise a Windows Home solution. [Microsoft container environment setup](https://learn.microsoft.com/en-us/virtualization/windowscontainers/quick-start/set-up-environment), [Microsoft Windows container FAQ](https://learn.microsoft.com/en-us/virtualization/windowscontainers/about/faq)
- AppContainer is a real Windows boundary, but arbitrary compiler/shell compatibility and least-privilege capability selection need a separate native engineering effort. The newer packaged Win32 app isolation feature is documented as preview and requires Windows 11 24H2+. It is not the shortcut for this release. [Microsoft AppContainer packaging](https://learn.microsoft.com/en-us/windows/msix/msix-container), [Microsoft Win32 app isolation overview](https://learn.microsoft.com/en-us/windows/win32/secauthz/app-isolation-overview)
- Do not use `winapp run --on sandbox` to claim safe project builds: Microsoft says evaluation, restore and compilation still run on the host. Its reuse of an existing shared Sandbox also differs from this plan's ownership model. [Microsoft winapp Sandbox execution](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/sandbox-execution)

On Home, missing virtualization, pending restart, unsupported CLI, occupied Sandbox or unproven artifact transport, report `blocked` with a concrete reason. Host execution remains available only through the existing separately selected host policy. Keep Windows 10, Arm64, Linux-container equivalence, network-enabled dependency installation and GUI/browser tests outside the first backend guarantee.

## Review focus

1. An installed backend becomes unavailable after preflight: the execution dispatch must still fail closed. Tests belong to PR 1/3.
2. Snapshot/output names contain Unicode, spaces, traversal, drive/UNC paths, ADS, reserved names or reparse points: reject unsafe inputs without following them. Tests belong to PR 2/3.
3. Stop, host restart or a stale completion arrives between durable intent and launch/result publication: no replay, false pass or termination of an unrelated instance. Tests belong to PR 3/5.
4. A model or repository requests stronger tools, secret access, nested spending, a new command or changed test configuration: reject authority growth and invalidate old grants/evidence. Tests belong to PR 4/6.
5. A test exits zero without running checks, fails then passes unchanged, tampers with its tests, or emits a forged success record: distinguish execution evidence from correctness and retain every attempt. Tests belong to PR 4/5.

## Ordered pull requests

### PR 1 — Honest execution contracts and fail-closed dispatch

**Files:** Modify `CHATMCP-HUB/lib/sandbox-engine.mjs`, `CHATMCP-HUB/lib/assemble.mjs`, `CHATMCP-HUB/lib/permissions.mjs`, `CHATMCP-HUB/hub.mjs`, `CHATMCP-HUB/ui/src/lib/api.ts`, `CHATMCP-HUB/ui/src/components/inspector/SettingsTab.tsx`. Create `CHATMCP-HUB/lib/execution-contract.mjs` and `CHATMCP-HUB/tests/verify-execution-contract.mjs`.

**Interfaces:** `ExecutionBackend.probe() -> CapabilityReport`; `execute(ExecutionRequest, {signal}) -> ExecutionReceipt`; `cancel(runId)`. A report includes `backend`, `available`, `osIsolated`, `platform`, `networkPolicy`, `writeScope`, `concurrency`, `enforcedLimits`, `unsupportedLimits`, `reasons`, and `observedAt`. A request binds `runId`, `snapshotId`, `checkId`, `isolationRequired`, immutable limits and an environment allowlist. A receipt includes terminal status, nullable exit code, timestamps, backend identity, snapshot/check hashes, truncation and evidence paths.

- [ ] Add tests for unknown backend, missing backend, stale availability, unsupported required limit and sandbox-only dispatch; assert the host spawner is never invoked for all rejected cases.
- [ ] Implement validation and a registry containing host plus an unavailable Windows provider placeholder. Missing isolation is a distinct `isolation_unavailable` result, not a successful command or automatic approval request.
- [ ] Route status and future execution through the same injected registry. Report `osIsolated:false` and actual limits for host mode; retain existing host tools and policies.
- [ ] Add UI contract tests for unavailable, probing and verified states. No permanent “safe” badge based merely on configuration.
- [ ] Run `node CHATMCP-HUB/tests/run-all.mjs --filter execution-contract --no-skip all` and existing permissions/shell suites. Ship independently with isolated worker tests still disabled.

### PR 2 — Disposable Windows transport feasibility and negative isolation tests

**Files:** Create `CHATMCP-HUB/lib/windows-sandbox-probe.mjs`, `CHATMCP-HUB/windows/sandbox/configuration.ps1`, `CHATMCP-HUB/windows/sandbox/GuestSupervisor/GuestSupervisor.csproj`, `CHATMCP-HUB/windows/sandbox/GuestSupervisor/Program.cs`, and `CHATMCP-HUB/tests/windows-sandbox/smoke.mjs`. Add pure configuration tests in `CHATMCP-HUB/tests/verify-windows-sandbox-config.mjs`. No worker tool wiring in this PR.

**Interfaces:** `probeWindowsSandbox() -> CapabilityReport`; `createSandboxConfiguration({inputDirectory, exportDirectory, memoryMb}) -> string`; a versioned guest request/receipt schema with a host-created run ID and nonce. This PR proves one owned guest can execute a bundled, trusted fixture and return its actual exit code plus bounded stdout/stderr.

- [ ] Write schema/configuration tests first: XML escaping, exact disabled settings, read-only input, exclusive private export root, no workspace/user-profile mounts and no environment interpolation from model input.
- [ ] Implement capability probes with timeouts and explicit readiness reasons. Never enable Windows features, restart the machine, elevate, install a third-party tool or stop an existing Sandbox during a probe.
- [ ] Bootstrap only the trusted guest supervisor through the CLI's `System` launch identity; the CLI does not directly create the required restricted identity, and `ExistingLogin` requires an active guest session. The supervisor must explicitly create/use a separate non-administrator token for the test child and attach a kill-on-close Job Object before allowing execution. Never launch project code as the privileged bootstrap identity. Prove the child cannot modify supervisor binaries, request metadata, receipts or publication paths. Run offline using a bundled, hash-verified fixture/runtime.
- [ ] Prove the output transport before choosing it for production: the candidate is a dedicated per-run export directory containing only bounded data files. Do not map any real project directory writable. Reject reparse entries, arbitrary filenames, invalid schema and oversize files; never execute returned content on the host. Treat the export as untrusted even if its nonce matches.
- [ ] Run real negative probes using synthetic host canaries: attempted reads/writes outside granted mappings, host loopback/LAN access, clipboard/device access, child-process persistence, receipt tampering and output flood. Confirm original-workspace and profile canaries remain unchanged.
- [ ] Record what resource limits are truly enforced. A Node output-length check does not impose a hard quota on a writable host share. If safe artifact export/availability controls cannot be demonstrated, leave the provider unavailable and stop the isolated-execution rollout; do not relax mappings or quietly replace it with host execution. A quota-backed export or brokered stream transport would then be a separate prerequisite PR.
- [ ] Gate: real pass/fail output, ownership, timeout/cancel and negative probes on a supported Windows machine. Source-only/mocked success is insufficient. Preserve this evidence as CI/release artifacts. This is a go/no-go engineering gate, not a claim that the selected transport already works.

### PR 3 — Production backend, snapshots, cancellation and packaging

**Files:** Create `CHATMCP-HUB/lib/windows-sandbox-backend.mjs`, `CHATMCP-HUB/lib/execution-snapshots.mjs`, `CHATMCP-HUB/tests/verify-execution-snapshots.mjs`, `CHATMCP-HUB/tests/verify-execution-lifecycle.mjs`. Modify `sandbox-engine.mjs`, `assemble.mjs`, `hub.mjs`, `scripts/Build-Installer.ps1`, `scripts/InstallerPayload.ps1`, `scripts/tests/Test-InstallerPayload.ps1`, and Windows guest files from PR 2.

**Interfaces:** `createExecutionSnapshot({workspace, files, baseSha, signal}) -> {snapshotId, manifest, contentHash, directory}`; `WindowsSandboxBackend` implements PR 1's interface. `files` is a broker-produced set of regular files, never a path list taken directly from a model.

- [ ] Add tests for immutable snapshot identity, file-change races, protected files, symlinks/junctions, hard-link alias risks, ADS, long/Unicode paths, missing toolchain and denied network. Default to rejecting unsupported special files; missing excluded dependencies cause a clear blocked result.
- [ ] Copy only selected project inputs into private staging without `.git`, user state, secrets or incidental dependency trees. Guest code writes only to its guest copy. Package a minimal offline Node fixture toolchain first; additional toolchains require a pinned manifest and supported provisioning path.
- [ ] Persist launch intent, instance ownership and generation before work; serialize Windows Sandbox jobs with an interprocess ownership lock. Never reuse unrelated or ambiguous instances. Recheck effective readiness at dispatch.
- [ ] Implement timeout, Stop, shutdown and recovery. Kill the owned guest process tree and stop only the owned Sandbox ID. Allow at most 30 seconds for shutdown/reconciliation; import output and release the execution slot only after confirmed termination. If ownership or termination remains uncertain, return interrupted/unknown, persist a quarantined ownership record, and block further dispatch without leaving the caller pending forever. Treat quarantined output as untrusted diagnostics, never a verification receipt. After crash, reconcile ownership and never replay a test automatically.
- [ ] Add end-to-end tests for failure between each durable-state transition, stale results, cancellation while queued/running, another instance appearing, and output collection failure. A missing exit code stays unknown.
- [ ] Package the trusted supervisor/runtime explicitly with hashes and third-party notices. Exclude native `bin/obj` and development sources from the broad `CHATMCP-HUB/windows/` payload selection; extend the payload regression accordingly.
- [ ] Gate: pure suites pass everywhere; required real Windows gate passes on dedicated supported hardware/VM with working nested virtualization. Standard hosted CI is not assumed to offer that capability. Missing required hardware is blocked, never green via skip.

### PR 4 — Safe worker test tools and content-bound evidence

**Files:** Create `CHATMCP-HUB/lib/worker-test-broker.mjs`, `CHATMCP-HUB/lib/verification-receipt.mjs`, `CHATMCP-HUB/tests/verify-worker-tests.mjs`. Modify `coding-orchestrator.mjs`, `studio-verification.mjs`, `studio-workspace.mjs`, `local-tools.mjs`, `manager.mjs`, `permissions.mjs`, `assemble.mjs`, `hub.mjs`, and UI API contracts.

**Interfaces:** `discoverChecks({workerId}) -> CheckDescriptor[]`; `requestCheck({workerId, checkId, grantId, signal}) -> ExecutionReceipt`. A descriptor binds command/shell/cwd, source configuration hash and toolchain. The broker resolves worker ownership and paths from its own records. The model cannot supply host paths, executable overrides, environment, mount flags or isolation mode.

- [ ] Test malicious package scripts/configuration, new command IDs, stale grants, modified test definitions, changed snapshots and permission changes between discovery and dispatch. Discovered scripts remain untrusted code and execute only in the selected verified guest.
- [ ] Before adding check tools, replace unconditional worker `autonomous`/`host-review` assignments with authority derived from the parent policy and the worker's scoped grant. Add `checks_list` and `checks_run` to the attenuated catalog, classify their permissions explicitly, and emit verification events only from broker receipts. Keep `run_command`, background tasks, arbitrary terminal/LSP startup, shell, Git writes, integration and publish absent. Test real dispatch under parent Read Only, Review, sandbox-only and full-access policies, including revocation between discovery and execution. Reject bypass calls server-side, not merely by hiding tools from the catalog. PR 6 extends this foundation to dynamic descendants.
- [ ] Scope any approval to worker, immutable check definition, toolchain, execution policy and approved execution attempt count. A new check definition or broadened request requires a fresh grant under the current gate; ordinary retries within the granted bounded scope reuse that grant.
- [ ] Persist raw execution facts and parsed test counts separately from model explanations. A zero exit code with no valid test evidence is “command succeeded; tests unverified,” not “tests passed.” A schema-valid receipt is execution evidence, not proof that tests are sufficient or honest.
- [ ] Mark evidence stale when tested content, toolchain or configuration changes. Show failing and previous attempts; never replace history with only the last green result.
- [ ] Gate: an actual coding worker using the scripted provider changes a disposable Node project, runs its registered test in Windows Sandbox, receives a real failure and later a real pass. A direct host command attempt must fail.

### PR 5 — Bounded code → test → diagnose → repair → retest

**Files:** Create `CHATMCP-HUB/lib/coding-verification-loop.mjs`, `CHATMCP-HUB/tests/verify-coding-loop.mjs`, `CHATMCP-HUB/tests/e2e/isolated-coding-loop.mjs`, and `CHATMCP-HUB/ui/src/components/inspector/VerificationReceipts.tsx`. Modify `coding-orchestrator.mjs`, `agent.mjs`, `studio-workflow.mjs`, task view adapters and `PlanTab.tsx`. The receipt display is new work: the existing plan evidence is agent-provided text, and `api.getVerifications()` currently has no display consumer. Wire an actual query plus completion/invalidation events, and test that the inspector distinguishes receipts from model claims.

**Interfaces:** `runVerifiedCoding({workerId, checks, grants, signal}) -> WorkerOutcome`; durable stages `editing`, `testing`, `diagnosing`, `repairing`, `ready_for_review`, `needs_attention`, `cancelled`, `interrupted`. Map them into existing task states/events rather than inventing a second incompatible task state API.

- [ ] Add deterministic tests for a fixable failure, nonfixable failure, setup failure, timeout, no tests, unchanged repeat failure, flaky pass without code change, deleted/weakened tests, cancellation and restart at every stage.
- [ ] Implement proposed defaults: at most **2 repair cycles / 3 test attempts**, **20 minutes total** including queueing, snapshots, guest startup, execution and output collection, and **120 seconds per command**; explicit lower user limits win. After the total deadline, allow only PR 3's bounded 30-second ownership-safe shutdown, with quarantine on uncertainty. No app-side provider token, request, or spending reservations are enforced; repair retries and guest timeouts are safety controls rather than API billing limits.
- [ ] Separate code/test failure from infrastructure failure. A missing runtime/network/dependency is blocked setup, not an invitation to run an installer on the host or burn model repair turns.
- [ ] Require changed-content evidence before ordinary retry; label an explicitly authorized unchanged retry as a flakiness investigation. Preserve the prior failure. Never accept removed checks or lowered assertions automatically; route such changes for review.
- [ ] Completion requires fresh receipts for all required checks and a final diff still matching the tested snapshot. Otherwise return `needs_attention` with actual changes, failed/unknown evidence and remaining verification attempts. The model's “done” message cannot mark verification complete.
- [ ] Keep manual integration separate. Test execution does not authorize merging the worker result into the user's checkout.
- [ ] Gate: deterministic provider suite plus current React E2E shows attempts, failure, repair, actual pass, Stop and interrupted recovery without paid requests or fabricated progress.

### PR 6 — Dynamic delegation with attenuated capabilities and safe concurrency (no provider usage caps)

**Files:** Create `CHATMCP-HUB/lib/worker-capabilities.mjs`, `CHATMCP-HUB/lib/worker-scheduler.mjs`, `CHATMCP-HUB/tests/verify-worker-capabilities.mjs`, `CHATMCP-HUB/tests/verify-worker-scheduler.mjs`. Modify `coding-orchestrator.mjs`, `studio-delegates.mjs`, `agent.mjs`, and task event/API adapters.

**Interfaces:** `deriveChildCapabilities({parent, role, requested, workspaceScope}) -> CapabilitySet`; `spawnWorker({parentId, role, goal, dependencies, requestedCapabilities, workspaceScope}) -> WorkerRecord`. The server looks up the authoritative parent; a model-supplied object cannot define it.

- [ ] Test forged parent IDs, role-name escalation, path widening, cross-worker data access, cycles, duplicate delivery, Stop races and concurrent scheduling. Check every actual call against live capabilities and revocation.
- [ ] Define child authority as parent authority intersected with role policy, run grants, backend capabilities and requested scope. A coding child may edit only its own managed tree; a testing child may invoke only the test broker; a read-only/reviewer child gets no edit/execute authority. No child receives integration/publish rights.
- [ ] Add proposed hard defaults: **2 concurrent model workers**, **6 total workers per run**, **depth 2**, and **1 Windows Sandbox execution slot**. These are OS/process safety limits, **not** limits on tokens, model calls, or provider spending. There is no shared token ledger.
- [ ] Allow model-driven spawning only inside an explicitly authorized coding workflow. Treat goals, repository instructions and child summaries as untrusted context. Models cannot create credentials, expand the approved provider/model set, or change user-selected API credentials.
- [ ] Persist parent/child relationships, dependencies, receipts and cancellation generation. Revocation/Stop propagates through every descendant and queued execution. Restart requires explicit continuation; do not auto-spawn or re-run tools.
- [ ] Gate: scripted coordinator creates a justified research child and coding/test child; escalation probes fail; concurrent saves retain all nodes; unsafe concurrent execution is prevented; canceled children cannot publish late successful results. Keep existing static research behavior passing.

### PR 7 — Supported-machine release gate, honest UI and benchmark readiness

**Files:** Modify `.github/workflows/ci.yml`, `CHATMCP-HUB/ui/e2e/studio.spec.mjs`, `CHATMCP-HUB/ui/e2e/windows-webview2/Program.cs`, installer regression tests, `docs/DEVELOPMENT.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`. Create `docs/WINDOWS-ISOLATED-EXECUTION.md` and `CHATMCP-HUB/tests/benchmarks/manifest.json` plus an offline benchmark runner.

- [ ] Document supported build/edition/architecture, actual capability probes, offline toolchains, one-instance limit, export trust boundary and every unenforced resource limit. Settings displays observed backend and reasons; it does not claim a general secure Windows desktop.
- [ ] Add a dedicated Windows isolation job with no-skips enforcement, plus pure Windows/Linux suites, React E2E, WebView2 smoke and installer payload checks. Never expose a persistent privileged/self-hosted runner or secrets to untrusted fork PR code; run native evidence on a disposable approved runner after the relevant code is trusted.
- [ ] Exercise installer install/upgrade/uninstall and missing-prerequisite behavior on clean disposable supported machines. Verify existing user profiles/state and unrelated Sandbox sessions remain untouched. Record tested OS/client/helper versions and artifact hashes.
- [ ] Build an offline benchmark manifest covering real-file fix, failing-test repair, nonfixable task, malicious project, cancellation and multi-worker conflict. Report correctness, regressions, verified-check coverage, repair attempts, latency and task outcome from actual receipts.
- [ ] Do not trigger live-provider benchmarks during CI, install, startup or passive monitoring. Explicitly initiated user model tasks use the user-configured Base URL, API key and model without a ChatMCP token or cost quota. Any billing/rate limits remain with the provider; ChatMCP must not claim to enforce a dollar cap. No live runs form part of implementing this draft.
- [ ] Gate: required CI succeeds on each PR, then on merged main; real isolated-execution evidence matches the released build. If PR 2/3's backend cannot pass, ship truthful unavailable status and retain worker shell revocation, not partial “sandbox verified” claims.

## Delivery order and decision gates

1. Phase 0 PR #7 merged at `270e5b9`; #8 merged at `2764000`, and [integrated-main CI](https://github.com/pddczpl/ChatMCP/actions/runs/38240516292) passed all nine jobs. Future implementation must start from a current clean base with passing required checks.
2. PR 1 can land independently. PR 2 is the first meaningful Windows feasibility result; it needs supported test hardware and owner-managed optional-feature setup.
3. PR 3 depends on PR 2 proving safe transport and ownership. PR 4 depends on PR 3's real negative tests; no bypass for convenient worker testing.
4. PR 5 and PR 6 depend on PR 4 receipts/grants. Their pure logic can be developed with a fake broker, but final acceptance must use the actual backend.
5. PR 7 integrates evidence and distribution. The presence of fake-provider tests proves orchestration, not live-model effectiveness; optional paid benchmarking is a later, separately authorized activity.

**Definition of Phase 1 done:** A supported Windows machine runs the scripted end-to-end coding/repair/delegation scenarios through the verified backend; escape/authority/cancellation probes fail safely; all outcomes bind to actual content and command receipts; worker host shell stays unavailable; unsupported machines show accurate blocked states; current desktop, packaging and main CI gates pass. The user has not yet authorized execution of this plan or any live model spending.

**Planning self-review:** All four requested tracks have owned PRs (OS isolation 1–3, safe worker tests 4, bounded repair 5, dynamic delegation 6). The five review-focus cases map to explicit tests. The exported-artifact channel, supported Windows hardware and offline toolchain are acknowledged prerequisites with a stop gate rather than hidden assumptions. Existing historical Phase 1 reports are not overwritten. No cloud, automatic OS setup, unrelated cleanup or new independent-review requirement was added.
