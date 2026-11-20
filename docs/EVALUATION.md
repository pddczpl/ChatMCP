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

**Limits:** The repair-loop test uses a controlled broker; worktree tests use scripted workers; browser tests do not establish live signed-in ChatGPT reliability. The test suite is not a representative, independently scored live-model benchmark and cannot support quantitative parity claims against Codex, Claude Code or Antigravity. Live-model evaluation requires its own opt-in runner, an already authorized provider and an explicit command-scoped spending budget; this deterministic CLI refuses `--live`. That runner is `tests/evaluate-live.mjs`, below.

## Live runner (opt-in, spends money)

`tests/evaluate-live.mjs` runs tasks through a real Hub (a child process with its own port, state folder and scratch project; never the Hub you use) against a real model provider. It is not part of `run-all`, CI never runs it, and it is a skeleton: the spend governor, the pre-registered corpus with hidden tests and the Proof-of-Done report are later P7 tasks. Its suite, `tests/verify-live-runner.mjs`, drives it only against the scripted model server.

```powershell
node DATGOLD-HUB/tests/evaluate-live.mjs --list
$env:CHATMCP_LIVE_OK = '1'; $env:CHATMCP_LIVE_SANDBOX = '1'   # only inside a throwaway VM or container
node DATGOLD-HUB/tests/evaluate-live.mjs --provider deepseek-flash --budget-usd 0.10 --output DATGOLD-HUB/test-results/live-report.json
```

| Flag | Meaning |
|---|---|
| `--provider <id>` | required; an entry of `tests/live/providers.json` (or of `--providers <file>`) |
| `--budget-usd <usd>` | required; a positive amount; the run stops once the Hub's cost ledger passes it |
| `--tasks <file>` | the tasks (default `tests/live/tasks/smoke.json`: one file and one command); each task has `id`, `prompt`, `files`, `maxSteps` (1 to 50) and `maxMinutes` (up to 30) |
| `--output <file>` | the JSON report (provider, rates and their source, budget, spend, each task's state, steps, limit reached, denied approvals and cost ledger) |
| `--scratch <dir>` | keep the scratch folder (Hub state, log, project) there instead of deleting a temporary one |
| `--list` | print the providers and their prices; nothing is checked or started |

**Safety rules.** Every rule below is checked before a Hub starts or a request is sent, and each refusal exits **2**:

- `CHATMCP_LIVE_OK=1` (exactly `1`): the owner's yes for this command.
- A disposable sandbox: `CI=true`, `/.dockerenv`, or `CHATMCP_LIVE_SANDBOX=1`. The tasks run in **Full Access** with nobody to approve them, so the model's commands run with the rights of the user who started the runner; never set `CHATMCP_LIVE_SANDBOX=1` on a machine you care about. The few tools Full Access still asks about (a push, a forced or destructive command) are always answered **no**.
- A known price: the provider's input and output price must be in the providers file. `ollama-local` has none (a local server is not in the models.dev snapshot) and is refused.
- The key: the provider's key variable must be set. It is the **only** credential-like variable the Hub receives (`tests/live/lib/session.mjs` forwards one allow-listed variable: `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`; everything else that looks like a key, token, secret or password is stripped). The Hub reads it from its environment through a profile (`envKeyName`), and the connection test gets it in one loopback request without `remember`, so it is never saved; the runner also replaces the value with `[redacted]` in everything it prints or writes.
- Tool calling: the Hub's own "Test API" check must report it as `supported`, or the run is refused before any task.
- Use a throwaway key with a provider-side spending cap, and revoke it afterwards.

**Exit codes:** `0` every task completed; `1` a task did not complete (it failed, or reached its step or minute limit) or the run failed; `2` refused or usage error; `3` stopped by the budget, or by a response whose cost the ledger could not price.

**The budget stop is coarse.** It sums the Hub's cost ledgers of the responses that already came back and cancels the running task once the sum passes `--budget-usd`; the next task is not started. A run can therefore end above the budget by about one response, and retries or failed sends cost money no ledger records. To count high rather than low, the ledger is given the provider's highest price tier, no cache-read discount (a cached token is charged as input) and a cache-write rate only when it is a surcharge. The Hub's task API takes no step or time limit, so the runner enforces `maxSteps` and `maxMinutes` the same way: it cancels a task once it is past its limit (the step that was running may finish). A real spend governor is the next task (bc-2).

**Providers.** `tests/live/providers.json` takes each model id, context window and price from the repository's models.dev snapshot (`lib/model-catalog.data.json`, 2026-10-28); `verify-live-runner` compares every number with the snapshot. A value the snapshot lacks is `null` with a note. The prices are a dated public list, not a bill.

Read [Testing with real models](TESTING-WITH-REAL-MODELS.md) for manual/authorized endpoint verification and [Development](DEVELOPMENT.md) for CI prerequisites.
