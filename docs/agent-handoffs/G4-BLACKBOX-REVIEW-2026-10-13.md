# G4 independent black-box grader review — 2026-10-13

**Decision: final hardware and identified-build evidence pending. No PASS or production unlock is approved yet.**

This review covers the newly authorized native black-box mode only. Legacy arbitrary Node test execution remains blocked by the unauthenticated child test-event authority described in [the prior independent review](G4-INDEPENDENT-REVIEW-2026-10-13.md). The reviewer does not implement the native grader, host publisher, or broker integration.

## Architectural judgment

The proposed boundary can close the Node IPC authority finding. The native SYSTEM supervisor receives a host/grant-pinned declarative case plan and compares strictly bounded, inert JSON values returned by the restricted implementation process. The native grader owns case validation, equality, counts and outcome. The implementation can return any value, including a hard-coded expected answer; it cannot declare a test passed or replace the native comparison. Public-case overfitting remains an ordinary limitation of finite tests. A PASS means the implementation returned the expected values for the pinned cases, not general program correctness or adequate test coverage.

No additional privileged JavaScript verifier is required. Arbitrary implementation code, adapters, package loading and their descendants must remain in the restricted job. The native supervisor must never import project code or evaluate a predicate provided in the plan as SYSTEM. JSON fields resembling verdicts or Node test-event records remain data and have no publication authority.

The implemented numeric domain is finite IEEE-754 binary64, matching ordinary Node JSON numbers. It deliberately treats `42` and `42.0`, `-0` and `0`, rounded integers beyond exact binary64 precision, and underflowed tiny numbers according to that domain. It does not claim decimal or arbitrary-precision equality. Objects compare by their exact property sets and values independent of key ordering; arrays compare in order; strings, booleans and null retain distinct types.

The following are independent obligations: correct grading; immutable case authority; child isolation and termination; authentic sealed publication; and complete supervisor/runtime provenance. A digest match authenticates the bytes produced by the grader only after the actual process and sealed state have been established.

## Required source-review conditions

| Boundary | Required condition |
| --- | --- |
| Plan authority | Explicit schema/mode version and exact case bytes are pinned by the approved grant/check hash before execution. Implementation-only repair cannot regenerate or silently change the cases. Changed checks require new authorization. |
| Strict JSON | Reject ambiguous schemas, duplicate property names, excessive depth/bytes/cases, unsupported values and numbers outside the documented comparison domain. Equality is type-sensitive and deterministic. No coercion of `false`, `0`, `null`, strings or arrays. Object ordering and number representation rules are explicit. |
| Case accounting | Require a positive bounded case count. Match every result to exactly its intended case; missing, extra, duplicated or reordered replies cannot create success. Native code derives all totals and the overall verdict. |
| Execution | Absolute pinned Node and implementation paths, restricted child token, job attached before resume, explicit handle allowlist, bounded streams/time, nonzero exit rejection and confirmed termination of every descendant before sealing. |
| Outcome authority | The host marks outcome verified only for the reviewed native mode/schema in the authenticated receipt. Neither child output, a legacy reporter summary nor an untrusted JSON flag can opt into this mode. |
| Context | Bind mode, plan/check identity, implementation snapshot, immutable baseline, native and toolchain identities, instance UUID/generation, run ID and fresh nonce through request/envelope/receipt. Retain the one-use collection rule. |
| Publication | Nine exact framed exit words from the owned CLI/process, canonical padding, matching full digest, correct execution status, no interrupted collection and independently confirmed owned guest cleanup. |

## Concrete adversarial acceptance cases

| Case | Required outcome |
| --- | --- |
| Wrong implementation gives plausible values | Native FAIL with its own failed-case count; sealed transport can still authenticate that failure. |
| Implementation-only fix | Native PASS for the same pinned plan, through real Broker → SnapshotStore → backend → supervisor → publisher. Record changed implementation hash and unchanged plan/check authority. |
| Early `process.exit(0)`, empty output, printed TAP or forged reporter events | No PASS; no Node event stream participates in grading. |
| Print `passed:true`, `failed:0`, fabricated native evidence or a forged receipt | Data rejected or compared normally; cannot upgrade the host result. |
| Missing/extra/duplicate/reordered result; wrong case ID; two replies for one case | Fail closed according to the documented protocol; exact correspondence enforced. |
| `1` versus `"1"`, `false` versus `0`, missing property versus `null`, altered array order | Native equality enforces documented type/structure semantics. |
| Duplicate JSON key, trailing JSON, malformed UTF-8, NaN/Infinity, huge exponent, excess nesting or output | No PASS; parser/domain/limit rejection is explicit and bounded. |
| Correct replies followed by nonzero exit, crash, timeout, cancellation or surviving descendant | No PASS; job cleanup must be positively confirmed. |
| Alter case/expected value/plan version after grant; use changed check with old grant | Rejected before grading or publication. |
| Replay receipt/nonce/instance generation; wrong snapshot, request, native or Node hash | Rejected; collection object is one-use even after a failed validation. |
| Forge or replace mapped receipt after native sealing | Full digest comparison rejects the changed bytes. |
| Child accesses known seal directory and known leaf with read/write/delete/WRITE_DAC/WRITE_OWNER | Actual Win32 access denied evidence, correct restricted SID, no privileged inherited handle. |
| Child opens supervisor process/token for tampering, invokes digest command, replaces runtime or plan | Actual denial or fail-closed observation. Child command exit alone is not sufficient evidence for all other rights. |
| Child targets an elevated pre-existing desktop process sharing its user SID | Attempt process query and token duplicate/impersonate/assign rights. Show denial or a token that cannot restore privileged authority; otherwise use a dedicated distinct nonadministrator identity. |
| Missing/malformed/padded/out-of-order digest word; interrupted collection; failed owned cleanup | No trusted PASS; retain explicit error/attention state. |
| Legacy arbitrary Node test produces an apparently valid summary | Remains outside approved native mode and cannot acquire verified outcome authority. |

Pure codec/parser tests can establish deterministic protocol handling. They do not establish Windows ACL, token, process, file mapping or CLI origin properties. Those rows require real owned Windows Sandbox evidence.

## Minimum OS and provenance evidence

Record the final Git commit/dirty state, exact supervisor/toolchain/adapter/plan hashes, installer payload identity, SDK/toolchain versions, host/guest Windows builds, and the selected Windows Sandbox executable's path, hash and installed package/signing/version data. Retain raw envelope bytes, exact receipt bytes and all nine CLI responses, along with successful stop and a well-formed inventory showing that exact owned UUID absent.

Capture the supervisor's actual SYSTEM SID, token groups/integrity/privileges; the child user SID, disabled admin groups, restricted SID set, integrity, enabled privileges; and the actual seal owner/DACL plus direct known-leaf denials. Also inventory the fresh guest's initial processes, token identities and executable origins. Trusted Windows kernel/base-image services are part of the TCB. An adversarial administrator with debugger/ownership authority cannot be treated as isolated by a SYSTEM-only DACL. The evidence must distinguish trusted base-image administrators from adversarial low-trust processes, without pretending that listing signed images detects arbitrary process injection.

The initial guest snapshot must precede any implementation payload execution. Only trusted diagnostics may be introduced for that inventory. For the actual grading run, the only adversarial code admitted before sealing should be the restricted implementation and its descendants; any other low-trust process must receive equivalent denial evidence or cause rejection. A fresh guest is important, but is not a substitute for this principal statement.

The previously published supervisor used self-contained single-file .NET with native extraction before managed `Main`. Microsoft documents extraction into `%TEMP%/.net` by default on Windows and requires that lower-privilege users cannot write the extraction location. Checking the executable hash inside `Main` alone does not establish pre-Main dependency provenance. [Microsoft single-file deployment documentation](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview).

The implementation team selected Native AOT after confirming local C++ build tools. This removes the specific managed-runtime extraction cache, subject to actual publish output and loaded-module verification. AOT also requires reviewing serializer source generation, trimming/analyzer diagnostics and OS DLL loading paths; an AOT setting alone is not runtime evidence. [Microsoft Native AOT documentation](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/).

## Initial clean-guest principal observation

The reviewer independently launched owned guest `6adfd099-c6e1-4921-9928-cf5f7b7d503f` solely for read-only inventory, 2026-10-13 22:20:28–22:20:40 Asia/Bangkok (15:20:28–15:20:40 UTC). No project implementation was staged. The readonly input contained only the diagnostic script and run identifier; networking, clipboard and printing were disabled. `wsb exec --run-as System` returned raw `ExitCode: 0`; the exact owned stop succeeded and a valid subsequent list confirmed its absence.

[Raw process/token/image inventory](evidence/g4-principal-inventory-2026-10-13/principal-inventory.json), [host ownership/cleanup](evidence/g4-principal-inventory-2026-10-13/host-run.json), [collector source](evidence/g4-principal-inventory-2026-10-13/guest-inventory.ps1) and [host harness](evidence/g4-principal-inventory-2026-10-13/run-inventory.ps1) are retained. Inventory SHA-256: `266d4fec4b8daa963185d84775e35a95a451f4bd0df4aaf2d001f9ccd514162f`; collector SHA-256: `6a63bfcd45ee9a1e81dd9f69e06b55e8494f8515791d40c378e4e20b8a15f273`.

Observed guest Windows 11 Enterprise x64 build 26100, 82 processes and 80 successful token reads: SYSTEM 37, Local Service 14, Network Service 7, WDAGUtilityAccount 19, DWM 1 and font-driver identities 2. Idle PID 0 and a transient TSTheme process could not be opened (Win32 87); those are recorded errors, not inferred tokens. The 25 executable paths available to the collector all had Valid Microsoft Windows Authenticode signatures; paths absent from the process query are retained as absent.

WDAGUtilityAccount SID `S-1-5-21-2047949552-857980807-821054962-504` is in local Administrators. Its observed Explorer and most desktop processes have high integrity `S-1-16-12288`, elevated tokens, enabled Administrators SID, and enabled `SeImpersonatePrivilege`/`SeCreateGlobalPrivilege`/`SeChangeNotifyPrivilege`. The same tokens contain disabled administrative privileges including `SeDebugPrivilege` and `SeTakeOwnershipPrivilege`; disabled is not the same as removed. SearchHost has low integrity `S-1-16-4096`. These are the trusted fresh Windows baseline for this observation. The grader's new restricted child must not be conflated with those elevated desktop tokens merely because the user SID matches.

This inventory supports an explicit base-image TCB statement. It does not prove process-memory integrity, absence of every possible injected component, denial against an adversarial administrator, or the token state of a later run. The actual grader acceptance must still record its own supervisor/child tokens and direct tampering denials. An earlier exploratory inventory had an ANSI/Unicode diagnostic SID decoding error; it was discarded, its owned guest cleaned, and it is not acceptance evidence.

**Concrete follow-up finding:** the prior restricted implementation reuses WDAGUtilityAccount's user SID. It therefore shares a user identity with observed elevated desktop processes. Medium integrity and disabled admin groups alone are insufficient evidence that the child cannot reacquire an elevated same-user token or influence that user's writable profile/registry state. Windows documents token access through a process query handle and token DACL, including the same-account case for elevated-process access. This is an untested authority path, not a demonstrated exploit. Require the same-user token-acquisition negative test or replace the execution identity with a fresh separate nonadministrator account before independent approval. [Microsoft OpenProcessToken documentation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken).

## Review completion record

Independent host review found a concrete cleanup issue: `WindowsSandboxCliDriver.stop()` originally accepted any array lacking the owned ID, including malformed entries such as `[{}]`, as confirmed termination. This could preserve a success after ambiguous inventory. **Source finding corrected and independently retested:** the shared inventory parser now requires object entries with valid unique UUIDs, canonicalizes case, and is used at launch, execution, publication and stop. Malformed stop replies retain ownership/staging rather than confirming cleanup. The reviewer ran the updated `verify-windows-driver.mjs` successfully, including malformed start/execution/stop and uppercase-ID regressions.

The shared-WDAG design finding has also been addressed in the new mode's source: the supervisor creates a random fresh standard local account and removes it after confirmed child cleanup. Account removal failure prevents successful grading. It captures the actual child SID, integrity, group attributes and retained privileges before closing the token; comparison and publication remain SYSTEM-only. The legacy mode still uses its older identity and remains outside this review's possible approval. Actual final-binary guest evidence is pending.

The reviewer independently ran `CHATMCP-HUB/tests/verify-blackbox-grader.mjs` successfully against the working tree. Source review of the new grant, staging, typed receipt and verification paths found the expected separation: cases remain pinned across implementation repair, host-only native evidence enables verification, and legacy Node results stay unverified. This portable result is not OS attestation.

The reviewer independently reviewed `Program.cs`, `SealedReceiptChannel.cs`, `NativeBlackBoxGrader.cs`, `NativeSecurityEvidence.cs` and the Native AOT project settings, then ran the actual AOT executable's host-only self-test: **35 passed, 0 failed, exit 0**. Tested artifact SHA-256 `cfbf708419107cf01e4a5becb672951c5ad7f8d4c20ada7055d0c0f6dd64d952`, 4,865,024 bytes. It was built under `bin/native-aot`; an earlier check of the still-old standard publish path was correctly rejected and does not count. Deterministic native parser/comparison fixtures cover type distinctions, array/object semantics, duplicate keys, finite binary64 behavior, malformed/empty/oversized/deep output and ineligible execution. They establish grading behavior, not Windows authority.

The final pre-freeze hardening assigns the restricted child token's owner and group to SYSTEM as well as setting its protected DACL. This avoids relying on a child-owned token DACL to deny the owner's implicit security-descriptor rights. The captured token evidence reads back the actual kernel-object owner/group/SDDL. The reviewer inspected this change and independently repeated the native self-test on candidate SHA-256 `5485212dbd33ec81d760dd8c156df8767e5a79899600c888ad25ce25644c6395`, 4,870,144 bytes: **35 passed, 0 failed, exit 0**. Hardware runs on the earlier candidate do not certify this replacement binary.

The reviewer also independently reviewed `windows-sandbox-cli-identity.mjs`, its absolute PowerShell/Appx preflight query, and the driver wiring, then ran the real read-only preflight successfully. It selected the exact OS-registered `MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__cw5n1h2txyewy` package under protected `C:\Program Files\WindowsApps`, Microsoft Windows publisher, Store signature, status Ok, not development mode, and CLI SHA-256 `247e092b5c5bd37820f225a7dd3ddf10ae37a67e2751a19c24b802c84769c441`. Real driver calls require this identity and recheck the selected bytes before every CLI operation; test injection remains a trusted internal seam. This closes the previous PATH/alias-only provenance source finding within the trusted Windows/package-manager boundary.

Pending: final-commit adversarial hardware results and independent assessment of the complete evidence. G6's prior 55/55 lifecycle result remains separate and must be repeated for the final rebuilt installer if this native implementation changes its payload.
