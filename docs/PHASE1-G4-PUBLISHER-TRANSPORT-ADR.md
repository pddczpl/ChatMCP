# ADR — Phase 1 G4 authenticated publisher without guest-readable HMAC

- **Status:** OPTION A REJECTED BY HARDWARE; OPTION C SOURCE-ONLY FEASIBILITY; PRODUCTION BLOCKED
- **Date:** 2026-10-13
- **Owner:** ChatGPT (GitHub architecture/review), Antigravity (native Windows experiment)
- **Issue:** https://github.com/pddczpl/ChatMCP/issues/14
- **Integration PR:** https://github.com/pddczpl/ChatMCP/pull/13
- **Invariant:** Shipping WindowsSandboxPublisher({hostAttested:false}) stays locked until separate independent G4 review

## 1. Evidence and explicit conclusion

Antigravity's Round 6 report tested PR #13 SHA c7a271ea353beaead1c259877da4f537592efc19 on Windows 11 Pro build 26300, Windows Sandbox CLI wsb.exe 0.8.107.0, .NET 10.0.103 and Node 24.19.0. It reports:

- Real owned guest probe: wsb exec --raw response fields **["ExitCode"] only**. No Stdout field or forwarded stdout echo. ExitCode 0 propagated correctly. Status CLI_PROCESS_STDOUT_NOT_PROVEN, productionAuthenticated:false.
- Actual guest WDAG child could read an arbitrary synthetic file staged in the writable host-mapped output directory: SYNTHETIC_KEY_READ_SUCCESS=True. Thus G4 is BLOCKED, even if supervisor argv no longer contains --auth-key, its child token is non-SYSTEM and the supervisor removes the mapped .auth_key before launching its own test child.
- Genuine broker→guest FAIL→scripted implementation repair→PASS was reported as 17/17 functional checks; Hub 62/62, UI 46/46, installer-payload 42/42 and GitHub-hosted PR/push CI 9/9 on that SHA were reported and GitHub independently confirmed 9/9 CI.
- The separate clean Windows install→first launch→upgrade→uninstall gate remains NOT VERIFIED. The real-guest security suite intentionally exited nonzero because G4 remains blocked.

Microsoft's [Windows Sandbox CLI documentation](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli) explicitly states that wsb exec returns the process exit code and **does not support process I/O/output retrieval**. This agrees with the real hardware observation.

**Decision: do not build a publisher based on a nonexistent Stdout field.** The fixed-marker source probe stays as a regression/diagnostic but is not a supported publisher path. No production authentication override, no host shell fallback.

## 2. Non-negotiable threat model

Actors: positively owned host Hub/WSB CLI, privileged pinned GuestSupervisor launched in a disposable guest, untrusted Node test child, any pre-existing low-trust guest process, untrusted mapped-folder files, and malicious descendants.

The host must accept a result only if it can independently establish the authoritative privileged process produced it, without a bearer key readable from a guest mapping, environment, argv, WMI or inherited handle. Bind all of: owned instance UUID + generation, trusted supervisor/toolchain binary SHA-256, immutable code/test/check snapshot hashes, run ID, fresh host nonce, bounded output, exact execution and cleanup status, zero-test/failed-test rejection and no replay. If ownership, process identity, native channel or cleanup becomes ambiguous, BLOCKED/NEEDS_ATTENTION rather than PASS.

## 3. Option A — WSB CLI Stdout (REJECTED for the tested version)

The original plan was to have supervisor emit a structured result over its own stdout. It is **not possible through the observed wsb.exe 0.8.107.0 JSON API**: only ExitCode is available. Do not spend cycles trying to parse a nonexistent Stdout property or print secret data into files to compensate. Retain the non-attesting test helper solely to detect future CLI behavior changes.

## 4. Option C — 256-bit digest over positive process ExitCodes (EXPERIMENTAL, NOT ATTESTED)

Because OS-owned wsb exec can communicate a process ExitCode, an alternative *may* use a privileged guest-local, SYSTEM-protected sealed digest plus multiple sequential CLI exit-code queries, with NO host HMAC key staged in guest-writable mapped files.

Proposed protocol, contingent on real Windows security proof:

1. Host creates fresh nonce and pinned read-only request/snapshot. Start a **new, positively owned disposable Sandbox**; launch the reviewed GuestSupervisor executable through the exact owned WSB CLI, using a known read-only mapped path. Never run arbitrary project scripts as SYSTEM.
2. The privileged supervisor executes the one approved Node test under its separate non-SYSTEM child SID, validates exit status and positive test assertions, and writes a bounded **untrusted** receipt.json into the host export folder.
3. Before finishing, the supervisor computes SHA-256 of the exact receipt bytes plus a canonical envelope binding run ID, nonce, instance generation, pinned binary/toolchain hashes, check hash and immutable snapshot/test-baseline hash. It stores the 32-byte digest in **guest-local private protected state**, NOT in writable host mapping. This state MUST have OS-enforced SYSTEM-only DACL, no reparse traversal or inherited writable handles, and it must be unreachable/writable by any low-trust guest process or descendants. The host never treats guest-readable contents as authenticated.
4. Host issues **nine serial wsb exec -r System** calls to the same pinned trusted binary, selecting digest word indices 0–8. Each call reads that protected guest-local digest and exits with a **positive nonzero framed 31-bit code**: high two bits 01, lower 30 bits payload. Nine words yield 270 bits, with exactly 256 useful digest bits and 14 canonical zero padding bits. This avoids ambiguous negative ExitCodes, normal zero/status collisions, and unframed/truncated response acceptance.
5. Host compares the reconstructed full SHA-256 digest to the exact receipt bytes and envelope, rejects missing/extra/reordered words, invalid framing, nonzero padding, inconsistent exit status, replay or stale nonce, and verifies every owned CLI command/instance/launch generation. If any call fails, CANCEL, QUARANTINE and report no PASS.
6. Only after real native proof that each exit code came from the pinned privileged supervisor reading **protected guest-local digest state**, and the child cannot replace the state, influence the supervisor's exit code or tamper with the launched executable, can an independent security review consider this a trusted publication path. It must still prove correct supervisor test-result parsing and isolation, not just digest matching.

This is a *candidate*, NOT proof of G4. A malicious actor can provide eight or nine arbitrary numbers if the host blindly trusts unverified guest data. Protecting the state, process identity and host CLI orchestration is absolutely essential. Beware process-creation failure returning apparent ExitCode 0 and hidden shell behavior; require positive framed words plus exact count.

New **OFFLINE, NON-ATTESTING** codec (not wired to production):
- CHATMCP-HUB/lib/windows-sandbox-exitcode-channel.mjs
- CHATMCP-HUB/tests/verify-windows-driver.mjs

The codec demonstrates nine positive 30-bit SHA-256 chunks, loss/tamper/framing detection; every result includes sourceProven:false and productionAuthenticated:false. There is no actual guest digest state, no native digest-return command yet, and no proof of independent process exit-code authenticity. **Do not claim a G4 fix from portable tests**.

## 5. Option B — Guest-local authenticated IPC (ALTERNATIVE, ALSO UNPROVEN)

Investigate an ACL-protected internal guest pipe, Hyper-V socket, or secure broker channel that the host can actually reach, without enabling general Internet access. Do not assume ordinary host Windows named pipes cross the Windows Sandbox VM boundary. If exploring an existing tool/SDK offering guest output forwarding, evaluate its actual supported CLI availability, security boundary, license and packaging implications before proposing dependencies. ChatMCP stays a standalone desktop app with no IDE integration.

## 6. Rejected publisher authority

A host-mapped .auth_key with Node mode:0o600, host icacls or best-effort deletion does not establish confidentiality across the guest mapped-folder redirector. HMAC of receipt.json cannot authenticate a supervisor if pre-existing guest code could read the bearer key. A successful arbitrary stdout/echo or a full digest match from attacker-controlled exit codes also does not establish source provenance.

## 7. Required acceptance before any production integration

- Verify actual wsb ExitCode semantics for several high positive values in 0x40000000–0x7fffffff, correct CLI JSON parsing, errors, timeout, unusual exit status, ownership and final-SHA helper/OS versions. Measure latency/overhead of nine serial invocations.
- Prove exact signed/pinned GuestSupervisor binary identity when invoked via OS-owned CLI; child cannot forge, race, replace protected guest-local digest state or inherit privileged stdout/handle rights. Capture actual Windows SID, DACL, integrity and error codes without any real user secrets.
- Test false PASS attacks: forged receipt, edited source/assertions, wrong request/check/snapshot, replayed digest/nonce, stale generation, corrupted guest sealed state, child invoking the digest-word command, malformed/nonzero-padded word, interruption between calls, unknown guest ownership.
- Run full Broker→SnapshotStore→Backend→privileged supervisor→trusted publisher test FAIL→implementation-only repair→PASS on the same final SHA. Independently review the transport before setting hostAttested or changing production result semantics.
- Run clean-machine install→launch→upgrade→uninstall in a user-approved disposable Windows environment, or mark G6 release-readiness NOT VERIFIED. Hosted CI installer build alone does not satisfy this gate.

## 8. Product and release invariant

Keep Issue #14 open and PRs #12/#13 Draft. No merge, release or shipping hostAttested:true until final native proof. Preserve Windows Sandbox isolation, no unisolated host fallback, explicit user Full Access confirmation, no automatic OS feature/reboot actions, user-provided model Base URL/API key, provider-managed usage/billing with no ChatMCP token/spending budget, standalone Windows desktop without external IDE dependency.
