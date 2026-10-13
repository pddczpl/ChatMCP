# ADR — Phase 1 G4 trusted Windows Sandbox publisher transport

- **Status:** PROPOSED / BLOCKED pending native Windows trust proof
- **Date:** 2026-10-13
- **Issue:** https://github.com/pddczpl/ChatMCP/issues/14
- **Integration PR:** https://github.com/pddczpl/ChatMCP/pull/13
- **Shipping invariant:** WindowsSandboxPublisher({hostAttested:false}) stays locked

## 1. Verified facts versus missing proof

1. GitHub confirms PR #13 SHA 68099a5 passed 9/9 push and 9/9 PR CI. Windows hardware report independently supplied by Antigravity reports real diagnostic broker→guest FAIL→repair→PASS, distinct non-SYSTEM child SID, and genuine WMI process checks.
2. That same Windows report shows SYNTHETIC_KEY_READ_SUCCESS=True for a synthetic guest-mapped host output file opened by the WDAG child. It explicitly marks HMAC publisher G4 BLOCKED. Neither Windows host icacls nor Node mode:0o600 alone proves confidentiality between guest principals through this VM redirector.
3. Production driver currently reads a host-exported receipt and expects an HMAC key temporarily written under the guest-writable output mapping. HMAC authenticity fails if an earlier untrusted guest process can read the key before its scheduled child starts.
4. The installed wsb exec --raw JSON is known to convey ExitCode to the host. Whether this CLI version also forwards a trusted supervisor process Stdout and how that channel is bound to a specific executable are NOT yet proven.

## 2. Required security invariant

A low-trust child, any earlier guest process or any descendant must not acquire a private signing key, create an accepted supervisor result, or gain privileged token/process access. The host must positively correlate exact owned Sandbox instance UUID, launch generation, run ID, nonce, pinned supervisor and toolchain hashes, immutable snapshot/check/test baseline hash, bounded stdout/stderr, execution exit code and cancellation status. Missing or ambiguous provenance is BLOCKED/NEEDS_ATTENTION, never PASS.

No model/user-supplied attestation flag, host shell fallback, automatic elevation, stop of an unowned Sandbox, or bypass through user Full Access.

## 3. Feasibility option A: OS-owned wsb CLI process stdout

Investigate whether the trusted host wsb.exe exec --raw response can carry the output of the exact supervisor process the host launched, without any signing key entering the guest.

- The supervisor would emit a bounded, typed JSON result over its OWN stdout, never over project child stdout or a guest-writable mapped output file. Raw child output must be escaped/embedded as untrusted text.
- The host may create/sign a durable verification record using HOST-ONLY key material only AFTER independent native proof that the result came from the pinned supervisor executable and exact owned guest execution. A host signature alone cannot turn attacker-supplied stdout into authenticated evidence.
- Reject ambiguous output, duplicate/unknown fields, exceeding byte limits, spoofed nonzero/zero exit codes, stale challenge, cross-run/generation/snapshot/check mismatches, and result replay.
- Verify the child cannot inherit or write the privileged supervisor stdout handle, forge the structured result, hijack the launched process, change the readonly supervisor binary or fake the native owned instance lifecycle.

**A successful arbitrary echo returned by wsb exec is NOT a publisher security proof.** It establishes only a possible CLI stdout transport shape. This distinction must remain explicit.

An intentionally non-attesting feasibility probe now exists:
- CHATMCP-HUB/lib/windows-sandbox-cli-channel-probe.mjs
- CHATMCP-HUB/tests/verify-windows-driver.mjs (offline mock regression)
- CHATMCP-HUB/tests/windows-sandbox/real-guest.mjs (diagnostic call inside a positively owned guest)

It sends a PUBLIC fresh marker in a fixed guest echo command, exposes only bounded status booleans/field names, and always returns productionAuthenticated:false. No API credentials are used. This code cannot enable the production publisher.

## 4. Alternative option B: verified guest-local supervisor/broker channel

If CLI process stdout is absent or has unprovable origin, investigate a genuinely secure guest-local pipe/ACL/handle protocol that can deliver an authenticated result to the HOST across the Windows Sandbox VM boundary. Do not assume ordinary host named pipes connect across this boundary. Prove supported native Windows IPC availability, the exact low-privilege SID denial, handle noninheritance, object DACLs, bounded messages and crash cleanup.

## 5. Rejected option: mapped-host HMAC key as sole publisher proof

No security GO for HMAC keys staged in an export folder writable/readable from untrusted guest contexts. Host NTFS ACLs may not maintain separate identities across a Hyper-V mapped-folder redirector. Overwrite/delete-before-start and no argv logging are useful defense in depth only, not a complete solution against a pre-existing malicious process.

## 6. Mandatory evidence and acceptance

1. Collect actual supported Windows build, wsb CLI version, exact final source SHA, pinned GuestSupervisor exe SHA256, process identity, owned instance ID/generation and bounded CLI raw response schema (redacted; no secret).
2. Test trusted supervisor stdout versus hostile child stdout injection, forged JSON/exit status, replay and cancelled/unknown instance. Reject all malicious or ambiguous cases; show native error codes.
3. Run real WorkerTestBroker→ExecutionSnapshotStore→WindowsSandboxBackend→pinned GuestSupervisor→publisher, using a scripted model and disposable immutable-baseline Node tests: genuine FAIL→implementation-only repair→PASS, then prove OS-authenticated result provenance independently.
4. Check Windows ACL/Job Object/token, key/read/handle access from a pre-existing untrusted guest process, cleanup of owned UUID only, no host execution fallback and missing-Sandbox behavior.
5. Preserve issuer permission gates; user-selected Full Access is not guest publisher attestation.
6. Perform separate clean-machine install→launch→upgrade→uninstall tests on an owner-approved disposable Windows environment or mark release gate NOT VERIFIED.
7. Run every affected Windows native/portable suite and GitHub PR+push CI on the SAME final source and binary SHA; obtain independent review before any production unlock.

**Decision:** G4 remains BLOCKED. Neither a valid HMAC over guest-writable files nor an arbitrary echo observed via wsb exec can be accepted as an authenticated supervisor publisher. PR #12 and PR #13 stay Draft; no main merge, release or hostAttested production enablement.

Product direction is unchanged: standalone Windows desktop without external IDE dependency; user-provided Base URL, model and API key; provider-managed usage/billing with no ChatMCP token or spend quota; explicit Full Access; Windows Sandbox for isolated automated worker checks.
