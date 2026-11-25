# ChatMCP v3.4.1 — Retry & Preflight Reliability

This patch release addresses the **“Đang chuẩn bị” / queued** state reported after clicking **Tiếp tục** or **Thử lại** on v3.4.0.

## Fixes

- **API coding agent:** cancellable 90-second preparation watchdog, actionable `preflight_timeout` errors, task-lock cleanup and retained conversation history (PR #28).
- **Browser Companion:** 120-second limit for unclaimed continuation packets, preserving the original ChatGPT conversation and refusing to replay uncertain sends (PR #28).
- **Automatic Repo Map:** v3.4.0 traversed and parsed the whole codebase before its first model request, despite a 900-token output limit. The preflight map now uses a bounded, cancellable heuristic-only scan (up to 240 source entries, 320 directories, 100 files parsed and 12 seconds). Full code-intelligence tools remain available after startup.
- **Progress visibility:** `repo_map_started` and `repo_map_skipped` identify optional indexing; a failed optional map does not prevent the coding agent from starting.
- **Tests:** regression coverage for failed continuations, large source trees, safe cancellation and retained task history.

## Verification and security

The automated CI and Windows installer build validate packaged code and scripted-provider workflows. Real paid-model behavior, clean Windows guest acceptance and hardware Sandbox security remain separately unverified.

The installer is **not Authenticode-signed**. Download both `ChatMCPSetup.exe` and `ChatMCPSetup.exe.sha256` and verify integrity before installing. Shut down the old Hub process before upgrading; the installer is not intended to clear per-user state.
