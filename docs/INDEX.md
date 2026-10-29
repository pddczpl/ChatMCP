# DatGold Documentation Library

The documents below cover detailed setup, development, architecture, historical phase reports, and release verification. Historical reports describe the state at the time they were written; use the latest release notes for current behavior.

Current provider catalog: **19 preset** choices (including OpenAI Responses API, the popular providers Grok, GLM, Qwen, MiniMax and Kimi, and a custom Responses-compatible gateway). Provider compatibility requires a successful function-call probe.\n\nCurrent agent capability inventory: **LocalTools (99 công cụ)**. This count is checked against the actual local tool definitions by the documentation regression test; capability quantity does not prove quality, security, or parity with another coding agent.

Comprehensive documentation across all architecture, implementation, and verification phases:

### System Architecture and Guides
- [Naming: DatGold, formerly ChatMCP](NAMING.md) — what the new name covers, what still has the old name and why, and the step that changes each
- [Reproducible evaluation harness](EVALUATION.md) — deterministic external-process evaluation and explicit live-model limits
- [Upgrade implementation checkpoint](UPGRADE-IMPLEMENTATION-STATUS.md) — shipped-source changes, outstanding acceptance work and restart handoff
- [Bundled Code Intelligence Runtime](CODE-INTELLIGENCE-RUNTIME.md) — Offline LSP, WASM, embedded Python staging, verification and limitations
- [Architecture](ARCHITECTURE.md) — System components, security model, and task state machine
- [Hub authentication](HUB-AUTH.md) — Per-launch bearer secret, session file, dashboard sign-in ticket, and what it does not protect
- [Review API (Hub side)](REVIEW-API.md) — The events of a tool call (`callId`, `input`, `checkpointId`), the review of a whole task as full texts, rejecting a file the task created, and the text save with its 300 KB limit
- [Claims map](CLAIMS.md) — Which claim of the README and release notes is exercised by which test on the production path, and which is not (the unmapped ratchet)
- [CI health](CI-HEALTH.md) — Workflow triggers (one run per push), documentation gates, `scripts/ci-health.mjs` definitions and the 2026-10-19 baseline
- [Threat model](THREAT-MODEL.md) — Hub credential, Companion outbound filter, Read Only classifier, lifecycle hooks, agent results, project instructions and skills, and the list of models with its one optional download: assets, actors, mitigations with code references, residual risks
- [Hooks](HOOKS.md) — Owner-level lifecycle hooks (a Claude Code compatible subset), the approval of a project hooks file, what a hook can and cannot do, and what is not verified
- [ChatGPT Web Companion privacy](COMPANION-PRIVACY.md) — Terms-of-Use risk, outbound secret scanner, protected-file deny-list, review before send, and what they do not do
- [Windows Setup](WINDOWS-SETUP.md) — Prerequisites, environment variables, and Windows configuration
- [Desktop Application](DESKTOP-APP.md) — WinForms + WebView2 architecture, packaging, and releases
- [User Guide](USER-GUIDE.md) — Workflow instructions, tool definitions, and dashboard navigation
- [Development](DEVELOPMENT.md) — Contributing guidelines, testing workflows, and codebase conventions
- [Contributing](../CONTRIBUTING.md) — Apache-2.0 inbound = outbound, Developer Certificate of Origin sign-off, commit conventions, AI-assistance policy
- [License and dependency scan](LICENSE-SCAN.md) — Apache-2.0 compatibility of every redistributed component, findings and open notice gaps
- [Testing with Real Models](TESTING-WITH-REAL-MODELS.md) — Integration testing with live AI provider endpoints
- [Agent Tools & Token Optimization](AGENT-TOOL-CAPABILITIES.md) — Updated internal tool inventory, security contracts, deployment dependencies, and acceptance gaps
- [Troubleshooting](TROUBLESHOOTING.md) — Diagnosing common startup, permission, and runtime issues
- [Historical Cloud Deployment Notice](DEPLOYMENT.md) — Archived notice regarding deprecated cloud infrastructure
- [Windows Sandbox Feasibility](WINDOWS-SANDBOX-REAL-FEASIBILITY.md) — Technical feasibility analysis of Windows Sandbox integration

### Phase 0: Desktop Contract Reconnection
- [Phase 0 Audit](PHASE0-AUDIT.md) — Codebase baseline audit and debt assessment
- [Phase 0 Desktop Contract Audit](PHASE0-DESKTOP-CONTRACT-AUDIT.md) — Hub-to-UI contract alignment and API verification
- [Phase 0 Execution Report](PHASE0-EXECUTION-REPORT.md) — Test receipts and reconnection milestone verification

### Phase 1: Windows Sandbox & Hardware Security
- [Phase 1 Design](PHASE1-DESIGN.md) — Windows Sandbox isolation design and security requirements (historical)
- [Phase 1 Implementation Plan](PHASE1-IMPLEMENTATION-PLAN.md) — Step-by-step development roadmap for execution drivers
- [Phase 1 Report](PHASE1-REPORT.md) — Verification receipts and security gate assessment
- [Phase 1 Blackbox Checks](PHASE1-BLACKBOX-CHECKS.md) — Native test suite for guest execution boundaries
- [Phase 1 Staged Status](PHASE1-STAGED-STATUS.md) — Incremental verification log for driver integration
- [Phase 1 G4 Publisher Transport ADR](PHASE1-G4-PUBLISHER-TRANSPORT-ADR.md) — Architecture decision record for guest exit-code transport
- [Phase 1 G6 Clean Windows](PHASE1-G6-CLEAN-WINDOWS.md) — Clean-machine installation, upgrade, and uninstallation verification
- [Phase 1 G4/G6 Execution Handoff](agent-handoffs/G4-G6-EXECUTION-2026-10-13.md) — Detailed execution handoff and test receipts

### Phase 2: Reliable Local Development
- [Phase 2 Design](PHASE2-DESIGN.md) — Journaling engine, crash recovery, and context management specifications
- [Phase 2 Local Reliability](PHASE2-LOCAL-RELIABILITY.md) — Implementation guide for crash resilience and rollback protection
- [Phase 2 Report](PHASE2-REPORT.md) — Verification receipts and recovery benchmark results

### Phase 3: Advanced Multi-Agent Worktrees
- [Phase 3 Design](PHASE3-DESIGN.md) — Multi-agent DAG engine, worktree coordinator, and review token architecture
- [Phase 3 Local Multi-Agent](PHASE3-LOCAL-MULTIAGENT.md) — Coordination workflows, concurrency rules, and Git integration
- [Phase 3 Report](PHASE3-REPORT.md) — Multi-agent benchmark results, DAG execution receipts, and merge verification

### Phase 4: Extended Planning & Optimization
- [Phase 4 Design](PHASE4-DESIGN.md) — Long-horizon agent planning and autonomous optimization design
- [Phase 4 Report](PHASE4-REPORT.md) — Experimental evaluation and future milestone documentation

---
