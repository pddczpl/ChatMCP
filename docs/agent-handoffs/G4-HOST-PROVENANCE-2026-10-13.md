# Host CLI provenance and cleanup review — 2026-10-13

The host driver now rejects malformed Sandbox inventories before launch,
execution, publication collection, and cleanup confirmation. Every entry must
contain a UUID; duplicate UUIDs, including differing letter case, are rejected.
Execution/publication require exactly the owned instance. A failed cleanup
confirmation retains ownership and staging for reconciliation. In particular,
`WindowsSandboxEnvironments: [{}]` no longer confirms that the owned guest has
terminated. This closes the concrete false cleanup confirmation reported by
the independent reviewer.

Real preflight now obtains the current user's installed package from the OS
Appx package manager through the absolute System32 Windows PowerShell binary
and absolute System32 Appx module. It does not resolve the CLI through PATH or
the user-writable app execution alias. It requires the exact Microsoft Windows
publisher and package family, Store signature kind, status `Ok`, x64, no
development mode, and the package's expected protected WindowsApps path.
Linked executable ancestry is rejected. The preflight records the package
identity and executable SHA-256; the production lazy driver requires that
identity and rechecks the same executable hash before every CLI operation.
Explicit injected transports remain test seams; a real diagnostic wrapper
must pass `cliPackage` to retain these checks.

Read-only observation on this host:

- Package: `MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__cw5n1h2txyewy`.
- Family: `MicrosoftWindows.WindowsSandbox_cw5n1h2txyewy`.
- Publisher: `CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US`.
- Signature kind: `Store`; status: `Ok`; architecture: `X64`; development mode: `false`.
- Executable: `C:\Program Files\WindowsApps\MicrosoftWindows.WindowsSandbox_0.8.107.0_x64__cw5n1h2txyewy\wsb.exe`.
- SHA-256: `247e092b5c5bd37820f225a7dd3ddf10ae37a67e2751a19c24b802c84769c441`.
- Read-only preflight returned `available: true` with no blockers.

The trust assertion is the OS-registered signed Store package and protected
installation, not an individual PE Authenticode signature. OS package
management and the privileged host remain part of the trusted computing
base. This does not independently attest the Sandbox service's internals or
defend against a compromised host administrator.

Focused verification passed:

- `tests/verify-windows-driver.mjs`: malformed inventories fail closed for
  launch, execution, and stop; owned state/staging are retained; case changes
  cannot hide an active instance.
- `tests/verify-sandbox-cli-identity.mjs`: untrusted publishers, mismatched
  versions, aliases, development/unsigned package identities and directory
  junction ancestry are rejected; measured bytes change the hash; real
  dispatch requires package identity. The file-symlink fixture is skipped on
  this host because creating it requires an unavailable privilege; the
  directory-junction regression runs successfully without elevation.
- `tests/verify-sealed-publication.mjs`: existing sealed transport regression
  suite remains passing.

These results verify host correctness and observed CLI identity. They do not
alone pass G4. The gate still needs the final native blackbox hardware and
independent principal/runtime acceptance; legacy Node test output remains
unauthenticated. No production gate was enabled by this change.
