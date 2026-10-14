# Windows Authenticode signing for ChatMCP

**Status:** The published v3.1.2 ChatMCPSetup.exe is **unsigned**. A GitHub
checksum verifies bytes, **not publisher identity**. Adding a signature changes
the binary bytes and therefore changes SHA-256. Never silently replace a
published release/tag with a differently signed installer.

## Owner prerequisites

Public Authenticode identity requires a publicly trusted Code Signing
certificate from a recognized CA, identity validation and control of its
authorized private key. A self-signed certificate is useful for a disposable
test only: it will NOT create a trusted Windows publisher or remove SmartScreen
warnings. Hardware token/HSM/CNG key storage is preferred. Do not export or
send the private key to ChatGPT, the repository, GitHub Issues, CI logs or PRs.

Microsoft Artifact Signing is a possible cloud alternative *only for eligible
public-trust identities*: Microsoft's published eligibility list does not
currently include Vietnam for public-trust individual or organization
validation. Private-trust signing is not equivalent to public Windows trust.
Check current Microsoft service eligibility before selecting a provider.

## Sign and verify a finished installer (Windows host)

1. Build the unsigned installer from the intended, CI-tested commit. Verify
   the CI-provided unsigned SHA-256 first. Close ChatMCP processes.
2. Import/access your approved Code Signing certificate via its
   Cert:\CurrentUser\My\<THUMBPRINT> entry. The private key may remain in
   a USB token/HSM and must be accessible through the certificate provider.
3. Install the Windows SDK SignTool and ensure your timestamp service allows
   RFC3161 SHA-256.

Run from the repository root on the **authorized signing machine**:

~~~powershell
# This command should run only after a real CA signing identity is available.
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Sign-Authenticode.ps1 -FilePath .\dist\ChatMCPSetup.exe -CertificateThumbprint '<CA-CERTIFICATE-THUMBPRINT>' -ExpectedPublisher '<VERIFIED-PUBLISHER-NAME>' -WriteChecksum
~~~

The script refuses missing certificates, invalid/untrusted signatures,
wrong publisher identity, absent timestamps, wrong executables and signing
over an already-signed binary. On success it verifies SignTool's Authenticode
policy and PowerShell's signature status, then computes a NEW SHA-256 file.

To verify a trusted signed installer without touching it:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Sign-Authenticode.ps1 -FilePath .\dist\ChatMCPSetup.exe -VerifyOnly -ExpectedPublisher '<VERIFIED-PUBLISHER-NAME>'
~~~

Verification requires an actual Windows trust chain and a cryptographic
timestamp. Signing the outer ChatMCPSetup.exe does **not** sign the embedded
ChatMCP.exe, GuestSupervisor.exe or other portable binaries. These need
their own pre-packaging signing phase if independently verified publishers are
required for all shipped executables.

## Safe automated release architecture (to enable AFTER certificate setup)

1. Run the normal PR, Windows/Ubuntu CI and installer build.
2. Authenticate a dedicated, protected signing environment. Use an HSM,
   approved CNG/SignTool provider, or an eligible cloud signing service.
   Limit access to reviewed main releases and require human approval.
3. Download the **exact** unsigned installer from the successful main CI
   run; compare to its original CI checksum before signing.
4. Sign and time-stamp only the authenticated installer; verify Authenticode
   chain, expected publisher and timestamp. FAIL CLOSED if missing.
5. Recompute SHA-256 for the now-signed bytes. Publish that signed installer
   and new checksum under a **new** version tag (for example v3.1.3) pointing
   to the exact original tested commit.
6. Verify the release download's Authenticode signature in a clean Windows
   environment without relying on a local developer's manually trusted roots.

Do not install a signing secret into generic PR or untrusted fork CI. Ordinary
CI should test the **fail-closed verifier**, not embed real signing credentials.
scripts/tests/Test-Authenticode.ps1 rejects unsigned/missing artifacts.
A real signing integration and release workflow must be configured for your
chosen provider before publishing a claimed signed release.

The signature authenticates publisher identity and file integrity, but Windows
SmartScreen reputation is separate and a warning can still appear on new
validly signed applications.

References:

- [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- [Microsoft Authenticode timestamping](https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures)
- [Microsoft Artifact Signing availability](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
