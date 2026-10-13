# G4 independent review — 2026-10-13

**Decision: G4 remains BLOCKED.** The native sealed transport has a successful hardware observation. That observation does not establish the full adversarial execution/result-authenticity gate. Keep shipping `WindowsSandboxPublisher({hostAttested:false})` and `productionAuthenticated:false`.

## Scope and identity

Reviewed the final working-tree host driver, sealed receipt reader, publisher, native `Program.cs`/`SealedReceiptChannel.cs`, Sandbox mapping configuration, reporter integration, and `test-results/native-seal.json`. The reviewer independently reviewed the host/native work and authored the registered-test reporter correction; this is not a second independent review of that reporter implementation.

- Git baseline: `497c082bdde937dad935dcec60244909dc341b6e`; changes were still uncommitted during review. This is **not** final-commit attestation.
- Recorded native supervisor SHA-256: `b822407d785164a313493e5cf9afc4e04996b64f2ac9d42f6b143f86ba8a3528`.
- Recorded Node SHA-256: `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`; local regression runtime was Node 24.19.0.
- Reviewed reporter SHA-256: `9efd4e764f55523ced290d9a148a0ee3fd1dcdf621b7546a5dfb6b40533cdeca`.
- Recorded hardware run: Windows 11 Pro build 26300, 2026-10-13 21:39:44–21:40:12 Asia/Bangkok (14:39:44–14:40:12 UTC). This review read the resulting record; it did not independently observe the launch.

## Evidence established

The native report records owned instance `68d2db9e-9520-42e5-abca-ec5e4e9a8cb9`, generation `73a66b0b-bfcf-4c4b-a913-166f6e5ba31a`, completed execution, a valid registered-test summary, transport PASS, and confirmed owned-instance stop. Collection took 20,155 ms. The driver reaches that result only after nine serial framed digest words match the exact envelope and receipt bytes; the report does not retain each raw word or envelope bytes.

The restricted child reported SID `S-1-5-21-2047949552-857980807-821054962-504`. Opening the **seal directory** for read, write, delete, `WRITE_DAC`, and `WRITE_OWNER` each returned Win32 error 5. Invoking the digest command as that child returned 3. These are useful observed denials for that principal. They are not evidence about all pre-existing guest principals, nor direct leaf-seal access tests.

Source review confirms canonical envelope binding, fixed executable/reporter paths and hashes, one-use host collection, exact SYSTEM-only seal DACL checks, non-inheritable protected handles, an explicit child stdin/stdout/stderr handle list, restricted token checks, and confirmed job cleanup before sealing. The final sealed runner uses read-only mapped `C:\ChatMCP\Input\project` with writable temporary output elsewhere. This removes the earlier mutable `Work` directory race and the need to rely on revoking its old ACL handles.

The real Node regression proved that ordinary TAP counts an empty or early-exited test file as one passing test. The replacement reporter rejects those cases, printed summary markers, skipped tests, incomplete files and failed tests, while accepting completed registered tests. Focused worker, coding-loop fixture, driver and sealed-protocol regressions passed. These are correctness/protocol results, not OS attestation. Registered test counts do not count assertions or establish test adequacy.

## Remaining gate blockers

1. **Adversarial test-result authenticity.** The pinned Node runtime's embedded `internal/test_runner/runner` deserializes child stdout report events and counts `test:pass` events. The reporter receives that same unauthenticated event stream. Its stricter summaries fix empty/early-exit correctness, but do not create an authentication boundary between untrusted implementation code and test authority. Parent runner and test children also execute under the same restricted user. No process-tampering or protocol-forgery experiment was performed in this review. A reviewed architecture must keep authoritative assertions/result production outside the untrusted program's control, then demonstrate rejection of false PASS against that boundary.

2. **Pre-existing guest authority.** This run proves denials for the newly restricted child only. It does not inventory pre-existing guest processes, their token groups, integrity levels, enabled privileges, or ability to access privileged process/state. A SYSTEM-only DACL alone is insufficient evidence against an actor already holding elevated administrative authority. Capture the actual initial guest principal/process evidence and establish which actors the threat model permits.

3. **Complete execution identity.** Preflight selects a `wsb.exe` path; the report explicitly contains `runtimeVerified:false` and omits CLI package/signing/version evidence. Also, the supervisor project enables single-file native-library extraction and the installer publishes it self-contained. Native runtime loading/extraction occurs before managed `Main` verifies the executable hash. No runtime extraction ACL/dependency identity evidence was supplied. These are unproven provenance requirements, not demonstrated exploits. Verify the OS-owned CLI identity and all loaded supervisor runtime dependencies, or use a reviewed deployment whose complete dependency tree can be pinned.

4. **Final reproducible acceptance.** Repeat against an identified final commit and record toolchain/CLI versions, exact envelope/word responses, seal owner/DACL/integrity evidence, direct known leaf-seal access denials, and negative cases required by the ADR (wrong/replayed request and nonce, stale ownership/generation, altered snapshot/check, interrupted collection, and unconfirmed cleanup). Include the real Broker → SnapshotStore → backend → supervisor → publisher FAIL → implementation-only repair → PASS sequence. Preserve failures as failures. A passing happy-path transport probe cannot substitute for this evidence.

G6 installer validation is separate and is not assessed by this note. No merge, release, production authentication override, or gate-unlock recommendation follows from this review.

## Additional host identity observation

The root executor subsequently recorded `test-results/wsb-cli-identity.json`: installed MSIX package `MicrosoftWindows.WindowsSandbox`, version `0.8.107.0`, Microsoft Windows publisher, `SignatureKind: Store`, package status `Ok`; package `wsb.exe` SHA-256 `247e092b5c5bd37820f225a7dd3ddf10ae37a67e2751a19c24b802c84769c441`. The individual PE reports `NotSigned`; this is distinct from Store package signing and is not by itself evidence of a compromised package. This read-only metadata improves identification but does not close the runtime execution-provenance or Node IPC findings.
