# ChatMCP v3.0.3 — Agent progress and stall recovery

This patch makes long-running coding sessions safer when a model repeatedly reads the same unchanged tool results. The AI gateway implementation is unchanged.

## Changes

- **Stall detection:** ChatMCP tracks recent tool/argument/result fingerprints. Four consecutive repeated results raise a warning; ten repeated results end the run with `progress_stalled` instead of consuming more model calls without new evidence.
- **Resumable progress:** task records and reports persist bounded inspected-target labels, edit attempts, verification attempts and result fingerprints across a Hub restart or explicit continuation. These are tool receipts, not proof of correct edits or passing tests.
- **Legitimate polling:** unchanged process-output polling does not count as agent stagnation.
- **Regression testing:** `verify-agent-progress.mjs` covers repeated reads, legitimate polling, denied writes, checkpoint persistence and safe termination.
- **Safety preserved:** existing permission approvals, uncertain mutation handling, Git review and Windows Sandbox boundaries remain in effect.

## Limitations

Identical tool results are only one type of unproductive repetition. This patch does not automatically decompose large tasks into dependency graphs or prove long-running task success with a real paid model. Review Git diffs and actual project test results before accepting a coding task as complete.

## Windows installer

The release includes `ChatMCPSetup.exe` and `ChatMCPSetup.exe.sha256`, both from the exact passing CI commit. Verify the SHA-256 digest before installing. Close ChatMCP before upgrading. Git for Windows and Microsoft Edge WebView2 Runtime are prerequisites for the features that use them. The installer is **not Authenticode-signed**.

Hub, UI, Desktop and Installer use version **3.0.3**.
