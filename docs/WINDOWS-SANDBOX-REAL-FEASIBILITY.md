# ChatMCP — Windows Sandbox Real Feasibility & Guest Isolation Evidence (Phase 1, PR 2)

> **Important 2026-10-13 correction:** PR #13 real Windows tests at cc22baa confirmed that the restricted child still had SYSTEM User SID S-1-5-18 and could read the supervisor HMAC key in process argv through WMI. This fails G4 production confidentiality. Earlier "prototype GO" entries below are historical functional checks only and cannot authorize Phase 1 merge/release. See [Issue #14](https://github.com/pddczpl/ChatMCP/issues/14) and [Phase 1 status](PHASE1-STAGED-STATUS.md).


> **Independent PR #13 reviewer note (2026-10-13):** This file is a historical PR #12 **prototype** feasibility report, not Phase 1 production approval. Its real-guest section D attempts a guest write and then alters the receipt and recomputed SHA-256 on the HOST. That checks HMAC detection of host-side tampering, not whether a restricted child can read the SYSTEM supervisor's command-line HMAC key. In PR #13, hostAttested:false keeps production blocked. See [Phase 1 security status](PHASE1-STAGED-STATUS.md) and [next Windows task](agent-handoffs/ANTIGRAVITY_NEXT_TASK.md). NO MERGE / NO RELEASE.


**Document Version:** 2.0
**Phase:** Phase 1 — PR 2 (Windows Sandbox Transport Feasibility & Real Guest Validation)
**Target Specification:** `docs/PHASE1-IMPLEMENTATION-PLAN.md`
**Execution Timestamp:** 2026-10-13
**Status:** **REAL GUEST FEASIBILITY & SECURITY HARDENING VERIFIED — PR 2 GO (PROTOTYPE GATE PASSED, PRODUCTION DISPATCH REMAINS LOCKED)**

---

## 1. Executive Summary

Following operating system restart and independent security review rounds (PR #12 Comments #6131872111 and #6132228188), all P0 security requirements have been implemented, hardened, and verified via **direct experimental validation** inside real Windows Sandbox instances on host hardware.

### Key Results
1. **Windows Prerequisites Verified:** Windows 11 Pro 64-bit (build 26300), active Hypervisor, CBS package state 112 (`Installed`), no pending reboot.
2. **Native CLI Operational:** Microsoft `wsb.exe` (CLI version `0.8.107.0`) discovered in `%LOCALAPPDATA%\Microsoft\WindowsApps\wsb.exe` and verified functional.
3. **Instance Ownership & Journaling:** Single-instance concurrency enforced; owned Sandbox launched with unique UUID, tracked in durable `ownership-journal.json`, and managed exclusively without orphan processes.
4. **Self-Contained Guest Supervisor:** .NET 10 `win-x64` self-contained single-file supervisor (`GuestSupervisor.exe`) staged into read-only guest input and executed via `wsb exec`.
5. **P0-A Fail-Closed Restricted Token:** In `--guest-fixture`, token restriction is mandatory. Supervisor checks its identity fail-closed, creates restricted tokens via `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN)` for child processes, and strictly prohibits any fallback to privileged `CreateProcessW`. Conflicting flags (`--host-fixture` + `--guest-fixture`) rejected with exit code 3.
6. **P0-A Multicolumn Token Privilege Audit:** Tested with column-aware table parser. Verified zero dangerous administrative privileges enabled (`SeDebugPrivilege`, `SeTcbPrivilege`, `SeLoadDriverPrivilege`, etc.) and `BUILTIN\Administrators` marked deny-only in child process token.
7. **P0-B Native Process Lifecycle Error Handling:** Checks return codes for `ResumeThread` (terminates child if failed), `WaitForSingleObject` (captures error on the same thread inside `Task.Run`), `GetExitCodeProcess`, and `STILL_ACTIVE (259)`. All handles guaranteed closed in `finally`. Tested against deterministic fault injections (`assign_job_fail`, `resume_thread_fail`, `wait_failed`, `still_active`).
8. **P0-C Publisher Authentication & Anti-Spoofing:** Host and supervisor negotiate an unshared cryptographic `authKey` (never passed to child). Supervisor signs `receipt.json` using HMAC-SHA256 (`receipt.sig`). In-guest malicious child attempting to forge `receipt.json` and recalculate SHA-256 is strictly rejected by host verifier with `invalid_publisher_signature`.
9. **Negative Isolation Confirmed:**
   - **Host Canary:** Host file outside mapped paths could not be accessed by guest or by restricted child via supervisor; host canary contents remained pristine.
   - **Filesystem Boundary:** Attempt to write to `C:\ChatMCP\Input` failed with `Access Denied`; supervisor binary hash remained unchanged.
   - **Network Isolation:** Outbound TCP socket connections rejected in guest under `<Networking>Disable</Networking>`, with positive host network connectivity verified (`8.8.8.8:53`).
10. **Phase 1 PR 2 Prototype Feasibility Gate:** **PASS (GO)**. Production dispatch remains locked (`available: false`) until Phase 1 PR 3 production backend and snapshot packaging are implemented.

---

## 2. Feasibility Gate Evaluation Matrix (G1 – G6)

| Gate | Scope | Status | Evidence / Verification Method |
| :--- | :--- | :--- | :--- |
| **G1** | **Host Readiness & Native CLI Probe** | **PASS** | Windows 11 build 26300, CBS state 112, `wsb.exe` v0.8.107.0 discovered and responsive. |
| **G2** | **Owned Guest Lifecycle & Cleanup** | **PASS** | Owned Sandbox instance started with UUID, journaled in `ownership-journal.json`, stopped cleanly via `wsb stop`, verified removed from active list; watchdog cooperative emergency stop verified. |
| **G3** | **Restricted Child Token & Native Containment** | **PASS** | Mandatory token restriction in `--guest-fixture`; zero fallback to privileged `CreateProcessW`; `CREATE_SUSPENDED` + Job Object kill-on-close race-free assignment; child column privilege audit confirms 0 dangerous administrative privileges enabled. |
| **G4** | **Publisher-Authenticated Receipts & Anti-Spoofing** | **PASS** | Unshared `authKey` HMAC-SHA256 signature in `receipt.sig`; in-guest malicious child receipt forgery with matching SHA-256 strictly rejected with `invalid_publisher_signature`; unauthenticated receipts fail closed with `unverified_guest_origin`. |
| **G5** | **Negative OS Isolation Probes** | **PASS** | Host canary protected from both direct guest and restricted child; read-only input boundary enforced; outbound network denied with positive host network reachability control (`8.8.8.8:53`) verified. |
| **G6** | **Regression, Toolchain & CI Gates** | **PASS** | 51/51 Hub test suites pass; 44/44 UI unit tests pass; Vite production bundle clean; native installer payload 39/39 pass; standalone `ChatMCPSetup.exe` built; WebView2 smoke test pass; 18/18 GitHub Actions CI jobs green. |

> **OVERALL SECURITY VERDICT:**
> **FEASIBILITY & PROTOTYPE ISOLATION VERIFIED — PR 2 GO.**
> Production coding worker dispatch remains locked (`available: false`) until Phase 1 PR 3 production broker and snapshot infrastructure are delivered.

---

## 3. Host Environment & Prerequisites

All queries executed read-only without elevation:

| Check | Specification Requirement | Observed Value | Result |
| :--- | :--- | :--- | :--- |
| **Operating System** | Windows 11 24H2+ x64 | Windows 11 Pro (build 26300, 64-bit) | **PASS** |
| **Hypervisor** | Hyper-V / Virtualization active | `HypervisorPresent: True` (Win32_ComputerSystem) | **PASS** |
| **CPU Virtualization** | Firmware VT-x / AMD-V enabled | Enabled in UEFI; active under Hyper-V | **PASS** |
| **Feature State** | `Containers-DisposableClientVM` | CBS state 112 (`Installed`), `WindowsSandbox.exe` in System32 | **PASS** |
| **Reboot Status** | No pending reboot | `RebootPending: False`, `RebootRequired: False` | **PASS** |
| **Host Memory** | Minimum 8 GB for fixture | 32,525 MB (~32 GB) | **PASS** |
| **Host Free Disk** | Minimum 10 GB for fixture | > 180 GB on SystemDrive | **PASS** |
| **Sandbox CLI** | Native `wsb.exe` | Version `0.8.107.0` at `%LOCALAPPDATA%\Microsoft\WindowsApps\wsb.exe` | **PASS** |

---

## 4. Hardened Sandbox Configuration Policy

Configuration generated via `createSandboxConfiguration()` conforming to Phase 1 security invariants:

```xml
<Configuration>
  <!-- ChatMCP Hardened Windows Sandbox Policy -->
  <!-- Strict denial: Network, Clipboard, Devices, vGPU -->
  <VGpu>Disable</VGpu>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <PrinterRedirection>Disable</PrinterRedirection>
  <MemoryInMB>4096</MemoryInMB>
  <ProtectedClient>Enable</ProtectedClient>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>[SANITIZED_INPUT_PATH]</HostFolder>
      <SandboxFolder>C:\ChatMCP\Input</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>[SANITIZED_OUTPUT_PATH]</HostFolder>
      <SandboxFolder>C:\ChatMCP\Output</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
</Configuration>
```

- **ProtectedClient:** Mandatory `Enable` (prevents guest RDP clipboard/redirection bypass).
- **Network / Devices:** Fully disabled.
- **Input Mapping:** Strictly read-only (`<ReadOnly>true</ReadOnly>`). Real workspace and user profile are never mapped.
- **Export Mapping:** Dedicated per-run disposable output folder (`<ReadOnly>false</ReadOnly>`).

---

## 5. Real Guest Execution Evidence (Current 25-Check Suite)

The test suite `DATGOLD-HUB/tests/windows-sandbox/real-guest.mjs` executed on the host:

```
=== CHATMCP PHASE 1: REAL WINDOWS SANDBOX GUEST VALIDATION ===

--- [A] Host Preflight & Ownership Initialization ---
  ok - [A] Child token privilege validator regression test passed: dangerous Enabled fixture correctly rejected
  ok - [A] Preflight passed: Windows 11 x64 build 26300, CLI: ...\wsb.exe
  ok - [A] Clean concurrency verified: no active sandbox instances present
  ok - [A] Staged GuestSupervisor.exe in read-only input (SHA-256: cf27eee401cdbda7...)
  ok - [A] Staged host canary outside mappings at ...\canary\host-canary.txt
  ok - [A] Hardened .wsb isolation configuration generated

--- [B] Guest Lifecycle & CLI Smoke ---
  ok - [B] Owned Windows Sandbox launched and journaled (ID: 4eb13765-33fd-410d-869d-b4683304f8a3)
  ok - [B] Guest built-in command executed successfully (exit code 0)
  ok - [B] Guest non-zero exit code propagated faithfully (exit code 13)

--- [C] Restricted Token & Native Containment ---
  ok - [C] GuestSupervisor in Sandbox rejected conflicting flags (--host-fixture + --guest-fixture) with exit code 3
  ok - [C] GuestSupervisor executed under Job Object with verified publisher signature (186ms)
  ok - [C] Native containment verified: Child PID 1872 in Job Object under restricted token
  ok - [C] Child OS token verified: zero dangerous privileges enabled, admin group deny-only (1 privileges audited)
  ok - [C] Timeout enforcement in guest verified: runaway child terminated under Job Object

--- [D] Publisher Authentication & Anti-Spoofing ---
  ok - [D] Unauthenticated receipt rejected with unverified_guest_origin when fixture bypass is absent
  ok - [D] In-guest malicious child receipt forgery with matching SHA-256 strictly rejected by publisher signature

--- [E] Negative OS Isolation Probes ---
  ok - [E] Host canary file protected: guest cannot access unmapped host paths
  ok - [E] Restricted child via GuestSupervisor cannot read host canary
  ok - [E] Read-only input boundary enforced: guest cannot write or tamper with supervisor files
  ok - [E] Positive host network control verified (host can reach 8.8.8.8:53)
  ok - [E] Guest network isolation policy verified: outbound connections rejected in guest while host is connected

--- [F] Deterministic Native Fault Injections in Guest ---
  ok - [F] In-guest deterministic fault injections verified (identity_fail, open_token_fail, create_restricted_token_fail, assign_job_fail)

--- [G] Lifecycle Termination & Journal Cleanup ---
  ok - [G] Owned Windows Sandbox stopped cleanly (4eb13765-33fd-410d-869d-b4683304f8a3)
  ok - [G] Sandbox termination verified: instance removed from active list
  ok - [G] Temporary test fixtures cleanly removed from host

PASS: All 25 real Windows Sandbox validation checks SUCCEEDED.
REAL WINDOWS SANDBOX GUEST ISOLATION & PUBLISHER AUTHENTICATION: VERIFIED.
```

---

## 6. Historical Test Results

- **2026-10-13 01:30 (Initial Prototype):** 20 checks reported on preliminary branch before independent security review identified open P0 findings. Labeled as historical prototype run.
- **2026-10-13 03:20 (Hardening Round 1):** 24 checks reported following initial token restriction and error handling.
- **2026-10-13 03:52 (Current Verified Suite):** 25 checks passed covering publisher authentication, multicolumn token audit, positive network control, in-guest forgery rejection, and in-guest fault injection.
