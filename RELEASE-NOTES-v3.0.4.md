# ChatMCP v3.0.4 — Goal-Aware Agent Autonomy

ChatMCP v3.0.4 improves reliability for multi-step coding tasks by tracking the user's objectives, independently verifying work evidence, and changing strategy before a stalled tool loop is terminated. The AI gateway implementation is unchanged from v3.0.3.

## What's new

- **Goal-aware planning:** Multi-part requests receive a host-proposed decomposition into inspection, code-editing, testing, and review phases, saved to the Studio Plan where supported. A suggested plan does not authorize any new tool or override the user's instructions.
- **Semantic inspection-loop safeguards:** The agent detects repeated, unchanged read/search evidence across equivalent tools or reordered queries. Distinct files/ranges and legitimate background process polling are not automatically classified as stagnation.
- **Verified progress receipts:** For first-party local file editing, the host independently re-reads the file and checks its SHA-256 before counting a verified change. Approved project test commands count as passing only with a real exit code 0 and no timeout, cancellation, truncation or unverified lingering process.
- **Adaptive recovery:** When a tool loop recurs, the agent is asked to use the existing evidence and switch strategy at bounded checkpoints (4 and 7 repeated results). After 10 repeated results it stops with a saved `progress_stalled` record instead of looping indefinitely.
- **Durable reporting:** Plans and evidence receipts survive explicit task continuation and Hub restarts. The report clearly separates verified tool receipts from any model claim that the entire task is complete.
- **Regressions:** New `verify-agent-autonomy.mjs` scripted-provider and disposable-workspace tests bring the Node suite total to 76; Windows/Ubuntu, Node 22/24, React E2E and installer checks are part of CI.

## Security and limitations

All existing permission approvals, unknown-outcome mutation protections, Git review and Windows Sandbox policies remain in force. The new planning and progress system is evidence-based, but **does not guarantee completion of every large task** or automatically create a multi-worker DAG for every user request. Live paid-model benchmark results are not part of the offline CI suite; use the documented opt-in benchmark before claiming parity with other desktop coding agents.

## Windows installation

Download `ChatMCPSetup.exe` and `ChatMCPSetup.exe.sha256` from this release. Verify the checksum before running the installer, and close any running ChatMCP Hub and Desktop processes when upgrading. Microsoft Edge WebView2 Runtime and Git for Windows are required for the features that use them.

The installer is self-contained but is **not Authenticode-signed**. Hub, UI, Desktop and Installer version: **3.0.4**.

For source changes and the opt-in model trial instructions, see `CHANGELOG.md` and `docs/TESTING-WITH-REAL-MODELS.md`.
