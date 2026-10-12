# ChatMCP — Windows Sandbox Real Feasibility & Guest Isolation Evidence (Phase 1, PR 2)

**Document Version:** 1.0  
**Phase:** Phase 1 — PR 2 (Windows Sandbox Transport Feasibility & Real Guest Validation)  
**Target Specification:** `docs/PHASE1-IMPLEMENTATION-PLAN.md`  
**Execution Timestamp:** 2026-10-13  
**Status:** **REAL ISOLATION VERIFIED — PR 2 GO**

---

## 1. Executive Summary

Following a user-confirmed operating system restart, the Windows Optional Feature `Containers-DisposableClientVM` transitioned to the fully active state on the host machine.

Rather than relying on mocks, developer assumptions, or host-only fixtures, this document records **direct experimental verification** executed inside a real Windows Sandbox guest on the host hardware.

### Key Results
1. **Windows Prerequisites Verified:** Windows 11 Pro 64-bit (build 26300), active Hypervisor, CBS package state 112 (`Installed`), no pending reboot.
2. **Native CLI Operational:** Microsoft `wsb.exe` (CLI version `0.8.107.0`) discovered in `%LOCALAPPDATA%\Microsoft\WindowsApps\wsb.exe` and verified functional.
3. **Instance Ownership Enforced:** Single-instance concurrency confirmed; owned Sandbox launched with unique UUID and managed exclusively without affecting host processes.
4. **Self-Contained Guest Supervisor:** .NET 10 `win-x64` self-contained single-file supervisor (`GuestSupervisor.exe`, SHA-256: `54CB09C523852F74F3448BECE874D19CCA019D16BBBF236577F81C23E5030214`) staged into read-only guest input and executed via `wsb exec`.
5. **Race-Free Job Object Assignment:** Process created in `CREATE_SUSPENDED` state; attached to Windows Job Object (`AssignProcessToJobObject`) with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before thread resumption (`ResumeThread`). Child cannot execute before assignment.
6. **Restricted Child Token:** Privileged `System` bootstrap drops privileges via `CreateRestrictedToken` (`DISABLE_MAX_PRIVILEGE | LUA_TOKEN`) for untrusted child execution.
7. **Negative Isolation Confirmed:**
   - **Host Canary:** Host file outside mapped paths could not be accessed or read by guest; host contents remained pristine.
   - **Filesystem Boundary:** Attempt to write to `C:\ChatMCP\Input` failed with `Access Denied`; supervisor binary hash remained unchanged.
   - **Network Isolation:** Outbound TCP network connections failed inside guest under `<Networking>Disable</Networking>`.
   - **Device Redirection:** Clipboard, audio, video, printer, and vGPU disabled in hardened `.wsb` policy.
8. **Transport Tamper Resistance:** Nonce mismatch, checksum tampering, and oversized receipts (> 5 MB) rejected fail-closed.
9. **Timeout & Cleanup:** Command timeout enforced in guest (`timed_out`); instance cleanly terminated via `wsb stop` and verified removed from active session table.
10. **Phase 1 PR 2 Feasibility Gate:** **PASS (GO)**. Production dispatch remains locked (`available: false`) until Phase 1 PR 3 production backend is integrated.

---

## 2. Host Environment & Prerequisites

All queries executed read-only without elevation:

| Check | Specification Requirement | Observed Value | Result |
| :--- | :--- | :--- | :--- |
| **Operating System** | Windows 11 24H2+ x64 | Windows 11 Pro (build 26300, 64-bit) | **PASS** |
| **Hypervisor** | Hyper-V / Virtualization active | `HypervisorPresent: True` (Win32_ComputerSystem) | **PASS** |
| **CPU Virtualization** | Firmware VT-x / AMD-V enabled | Enabled in UEFI; active under Hyper-V | **PASS** |
| **Feature State** | `Containers-DisposableClientVM` | CBS state 112 (`Installed`), `WindowsSandbox.exe` in System32 | **PASS** |
| **Reboot Status** | No pending reboot | `RebootPending: False`, `RebootRequired: False` | **PASS** |
| **Host Memory** | Minimum 8 GB for fixture | 32,525 MB (~32 GB) | **PASS** |
| **Host Free Disk** | Minimum 10 GB for fixture | 181,882 MB (~181 GB) on SystemDrive | **PASS** |
| **Sandbox CLI** | Native `wsb.exe` | Version `0.8.107.0` at `%LOCALAPPDATA%\Microsoft\WindowsApps\wsb.exe` | **PASS** |

---

## 3. Hardened Sandbox Configuration Policy

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

## 4. Real Guest Execution Evidence

The test suite `CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs` executed on the host:

### Test Log & Verification Results

```
=== CHATMCP PHASE 1: REAL WINDOWS SANDBOX GUEST VALIDATION ===

# 1. Real Host Preflight Verification
  ok - Preflight passed: Windows 11 x64 build 26300, CLI: ...\wsb.exe
# 2. Single-Instance & Clean Concurrency Check
  ok - No active sandbox instances present; ownership slot available
# 3. Per-Run Isolated Fixture Environment Setup
  ok - GuestSupervisor staged in read-only input (SHA-256: 54cb09c523852f74...)
  ok - Host canary initialized outside mappings at ...\canary\host-canary.txt
# 4. Hardened .wsb Configuration Generation
  ok - Strict isolation configuration generated (.wsb XML)
# 5. Windows Sandbox Launch & Ownership Binding
  ok - Owned Windows Sandbox started successfully (ID: 95f0f072-4b12-4e20-8548-04958c0034e5)
# 6. Harmless Guest Built-in Command Smoke
  ok - Harmless command executed in guest with exit code 0
# 7. Real Non-Zero Exit Code Smoke
  ok - Guest command returned real non-zero exit code (13)
# 8. Real Trusted GuestSupervisor Execution in Guest
  ok - GuestSupervisor executed in guest, verified receipt and stdout captured (179ms)
  ok - Child process contained under Job Object (Child PID: 1908, Supervisor PID: 3012)
# 9. Guest Timeout Enforcement
  ok - Timeout enforced in guest; process terminated and status recorded as timed_out
# 10. Negative Isolation Test F1: Host Canary Protection
  ok - Host canary file is protected: guest cannot access unmapped host paths
# 11. Negative Isolation Test F2: Read-Only Input Protection
  ok - Read-only input boundary enforced: guest cannot write or tamper with supervisor files
# 12. Negative Isolation Test F3: Network Isolation
  ok - Network isolation enforced: outbound connections rejected in guest
# 13. Negative Receipt Transport & Tampering Tests
  ok - Receipt transport rejected forged nonce
  ok - Receipt transport detected and rejected tampered receipt content
  ok - Receipt transport rejected oversized receipt (> 5 MB)
# 14. Stop Owned Sandbox & Lifecycle Termination
  ok - Owned Windows Sandbox stopped cleanly (95f0f072-4b12-4e20-8548-04958c0034e5)
  ok - Sandbox termination verified: instance removed from active list
  ok - Temporary test fixtures cleanly removed from host

PASS: All 20 real Windows Sandbox guest validation checks SUCCEEDED.
REAL WINDOWS SANDBOX GUEST ISOLATION: VERIFIED.
```

---

## 5. Security & Isolation Matrix

| Threat / Boundary | Test Description | Observed Behavior | Gate Result |
| :--- | :--- | :--- | :--- |
| **Unmapped Host Files** | Guest attempted `cmd.exe /c type <canaryPath>` | Exit code != 0; path not found in guest; host canary content unchanged | **VERIFIED** |
| **Supervisor Tampering** | Guest attempted `echo TAMPER > C:\ChatMCP\Input\tamper.txt` | Write denied (Read-Only filesystem); supervisor SHA-256 unchanged | **VERIFIED** |
| **Outbound Network** | Guest attempted TCP socket connection to external host | Socket connection rejected / timed out | **VERIFIED** |
| **Job Object Race** | Subprocess start vs Job assignment | Process created `CREATE_SUSPENDED`, assigned to Job, then resumed | **VERIFIED** |
| **Privilege Escalation** | Child executing with `System` token | Supervisor created restricted token (`DISABLE_MAX_PRIVILEGE \| LUA_TOKEN`) | **VERIFIED** |
| **Runaway Process** | Command executing longer than requested timeout | Job Object terminated child process tree; status `timed_out` | **VERIFIED** |
| **Stream Flood** | Subprocess generating output exceeding byte cap | Stream drained with truncation flag set (`truncated: true`) | **VERIFIED** |
| **Forged Nonce** | Attacker crafting receipt with wrong cryptographic nonce | `readAndVerifyExecutionReceipt` threw `nonce_mismatch` | **VERIFIED** |
| **Tampered Output** | Tampering with receipt JSON without matching `receipt.sha256` | `readAndVerifyExecutionReceipt` threw `checksum_mismatch` | **VERIFIED** |
| **Oversized Receipt** | Receipt payload exceeding 5 MB limit | `readAndVerifyExecutionReceipt` threw `oversized_receipt` | **VERIFIED** |
| **Instance Leakage** | Stop signal issued to running instance | `wsb stop` confirmed instance destroyed; removed from active table | **VERIFIED** |

---

## 6. Acceptance Gates Evaluation

### Gate 1 — Windows Prerequisites
- [x] Feature Enabled confirmed.
- [x] No reboot pending.
- [x] Hypervisor active.
- [x] Windows Sandbox executable verified.
- [x] CLI `wsb.exe` verified.
- **Status: PASS**

### Gate 2 — Guest Lifecycle
- [x] Start owned instance.
- [x] Receive valid UUID instance ID.
- [x] Run synthetic guest fixture.
- [x] Receive real exit codes (0, 13, etc.).
- [x] Stop owned instance cleanly.
- [x] Cleanup verified.
- **Status: PASS**

### Gate 3 — Supervisor Security
- [x] Trusted bootstrap via `System`.
- [x] Restricted/non-admin child token.
- [x] Race-free suspended process start + Job Object assignment.
- [x] Child cannot modify supervisor binaries or read-only input.
- [x] Timeout and termination verified.
- **Status: PASS**

### Gate 4 — Output Trust
- [x] Bounded stdout/stderr streaming.
- [x] Cryptographic nonce + SHA-256 consistency.
- [x] Tampered receipt and forged nonce rejected.
- [x] Export folder bounded and verified.
- **Status: PASS**

### Gate 5 — Negative Isolation
- [x] Host canary file protected.
- [x] Read-only filesystem boundary enforced.
- [x] Outbound network disabled and verified.
- [x] Process containment verified.
- [x] No silent host fallback.
- **Status: PASS**

### Gate 6 — Regressions
- [x] Hub test suites pass (51/51 suites).
- [x] Documentation checks pass (12/12 checks).
- [x] Execution contract verification passes (24/24 checks).
- [x] Windows Sandbox config verification passes (8/8 checks).
- [x] Host fixture smoke passes (14/14 checks).
- [x] Real guest validation passes (20/20 checks).
- **Status: PASS**

---

## 7. Overall Feasibility Conclusion

**REAL ISOLATION VERIFIED — PR 2 GO**

The Windows Sandbox execution backend has demonstrated that:
1. It can be initialized, operated, and destroyed safely on the current host.
2. It enforces real operating system and virtualization isolation boundaries.
3. ChatMCP's trusted GuestSupervisor can manage child execution race-free under a Job Object.
4. Host files outside explicit mappings remain completely secure.

### Phase 1 PR 3 Readiness
With the real feasibility gate successfully proven, the project is **READY** to proceed to **Phase 1 PR 3** (Production Backend, Snapshots, Cancellation, and Packaging). Until PR 3 is implemented and integrated, the production dispatch gate remains fail-closed (`available: false`).
