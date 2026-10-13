# Native black-box checks

The `node-json-blackbox` mode checks the values a program returns for explicitly
approved public examples. The Windows native supervisor compares these values
with the approved expectations. Project code cannot supply the pass count or
replace the comparison. Ordinary `node --test` remains a diagnostic mode with
no authenticated test-outcome claim.

This mode passed scoped G4 acceptance and is enabled on supported Windows hosts.
Its activation and exact-artifact hardware acceptance are
recorded separately in the [independent review](agent-handoffs/G4-BLACKBOX-REVIEW-2026-10-13.md).
The example below does not itself grant execution permission.

## Define a check

Add a version-controlled file such as `chatmcp.checks/addition.json`:

```json
{
  "version": 1,
  "kind": "node-json-blackbox",
  "adapter": "check-adapter.mjs",
  "cases": [
    { "id": "positive", "input": { "a": 2, "b": 3 }, "expected": 5 },
    { "id": "negative", "input": { "a": -9, "b": 4 }, "expected": -5 }
  ]
}
```

The adapter is ordinary untrusted project code. For example:

```javascript
import { add } from './calculator.mjs';

let bytes = '';
for await (const chunk of process.stdin) bytes += chunk;
const request = JSON.parse(bytes);
const results = request.cases.map(({ id, input }) => ({
  id,
  value: add(input.a, input.b),
}));
process.stdout.write(JSON.stringify({ version: 1, results }));
```

The program receives one JSON document on stdin:
`{"version":1,"cases":[{"id":"positive","input":{"a":2,"b":3}},...]}`.
It must write exactly one JSON response with `version` and `results`, containing
one `{id,value}` item for each case in the original order. Send diagnostic logs
to stderr. A zero exit status is necessary, but only successful native
comparisons can verify the outcome.

## Approval and repair

The existing worker check list discovers the check files from its Git worktree.
The owner approves a check through the existing grant flow. Approval binds the
exact manifest bytes, case IDs and expected values. Each attempt also binds the
current implementation snapshot, toolchain, supervisor, run and owned guest.
Changing the manifest requires a new approval. Editing the adapter or the
implementation can be retried under the same bounded grant.

Use `chatmcp.checks/`, which can be committed normally. `.chatmcp/` is private
application state and is commonly ignored by Git. Required project files must
be in the worker snapshot. Dependencies excluded from that snapshot are not
downloaded during the check; the guest has no network access.

## Scope and rejection rules

A manifest is limited to 64 KiB and 1–64 uniquely named cases. The schema has no
executable assertion or predicate fields. Paths are relative to the immutable
project snapshot; the native launcher runs only the pinned Node executable.
No project code executes with the grader's Windows authority.

Comparison is type-sensitive. Strings, booleans, nulls, arrays and objects are
distinct; arrays retain their order and object property order is immaterial.
Numbers use finite IEEE-754 binary64 values, including `-0 == 0`, matching
JavaScript numeric precision rather than arbitrary-precision decimal arithmetic.
Duplicate JSON property names, malformed
input, missing/extra/reordered results, unsupported schema fields, truncated
output, nonzero exit, cancellation or unconfirmed cleanup cannot authorize a
PASS. The implementation's printed `pass`, `grader`, TAP or Node reporter
messages have no authority.

These are public test examples. An implementation can see them and overfit to
them. A PASS establishes the expected returned values for these examples;
it does not establish coverage or correctness for every possible input.

## Build and verification

The privileged supervisor is published with .NET Native AOT, so its managed
runtime is compiled into the executable rather than extracted at startup.
Maintainers building the Windows installer need .NET SDK 10 and Visual Studio
2022 or later with the C++ desktop build tools and Windows SDK. End users do
not need a .NET SDK, Visual Studio, Node or Git installed.

The real Windows acceptance harness is
`CHATMCP-HUB/tests/windows-sandbox/real-blackbox-acceptance.mjs`. It runs a
genuine failing implementation, repairs only implementation code, then tests
malformed and forged child results. It retains exact envelope/receipt bytes,
the nine native digest responses and confirmation that each owned guest stopped.
Portable checks cover deterministic schema/grant/receipt rules and are not
substitutes for native security evidence.
