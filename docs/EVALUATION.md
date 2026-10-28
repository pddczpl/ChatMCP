# Reproducible DatGold evaluations

The deterministic evaluation runner invokes actual repository test processes via `tests/run-all.mjs`. It captures commit identity, fixture version, environment, elapsed time, exit status, and hashed test-result receipts. A passing case means **that regression contract passed**, not that a real model successfully completed a new arbitrary coding task.

## Usage

From the repository root:

```powershell
node DATGOLD-HUB/tests/evaluate.mjs --list
node DATGOLD-HUB/tests/evaluate.mjs --case targeted-bugfix --output DATGOLD-HUB/test-results/evaluation-report.json
npm run eval:deterministic --prefix DATGOLD-HUB
```

Running `--all` executes ten cases sequentially: repository exploration, targeted bug fixes, multi-file implementation, refactoring, repair-loop contract, long context, interruption recovery, Git worktree dependencies, browser regressions, and provider usage. Each case is graded by a separate Node subprocess and the actual suite's assertions and exit status. Skipped or missing receipts never count as passed.

Cases carry the source SHA, fixture ID/version, environment and an evidence hash. The report deliberately uses `null` for unavailable model tokens, model identity and cost; the system must never invent those metrics. The CLI does not send model API requests, create releases or trigger Git pushes.

**Limits:** The repair-loop test uses a controlled broker; worktree tests use scripted workers; browser tests do not establish live signed-in ChatGPT reliability. The test suite is not a representative, independently scored live-model benchmark and cannot support quantitative parity claims against Codex, Claude Code or Antigravity. Live-model evaluation requires its own opt-in runner, an already authorized provider and an explicit command-scoped spending budget; this deterministic CLI refuses `--live`.

Read [Testing with real models](TESTING-WITH-REAL-MODELS.md) for manual/authorized endpoint verification and [Development](DEVELOPMENT.md) for CI prerequisites.
