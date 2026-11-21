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

`tests/evaluate-live.mjs` runs tasks through a real Hub (a child process with its own port, state folder and scratch project; never the Hub you use) against a real model provider. It is not part of `run-all`, CI never runs it, and the pre-registered corpus with hidden tests and the Proof-of-Done report are later P7 tasks. Its suites, `tests/verify-live-runner.mjs` and `tests/verify-live-budget.mjs` (the spend governor), drive it only against the scripted model server.

```powershell
node DATGOLD-HUB/tests/evaluate-live.mjs --list
$env:CHATMCP_LIVE_OK = '1'; $env:CHATMCP_LIVE_SANDBOX = '1'   # only inside a throwaway VM or container
node DATGOLD-HUB/tests/evaluate-live.mjs --provider deepseek-flash --budget-usd 1.00 --monthly-cap-usd 3.00 --output DATGOLD-HUB/test-results/live-report.json
```

| Flag | Meaning |
|---|---|
| `--provider <id>` | required; an entry of `tests/live/providers.json` (or of `--providers <file>`) |
| `--budget-usd <usd>` | required; a positive amount: the cap of this run (see "Spend governor" below) |
| `--monthly-cap-usd <usd>` | required; a positive amount: the cap of all runs of this calendar month (UTC) together, kept in the ledger |
| `--ledger <file>` | the append-only spend ledger (default `bench-results/ledger.jsonl` at the repository root; git ignores `bench-results/`) |
| `--poll-ms <ms>` | how often the governor looks at the running task, 50 to 2000 (default 500) |
| `--tasks <file>` | the tasks (default `tests/live/tasks/smoke.json`: one file and one command); each task has `id`, `prompt`, `files`, `maxSteps` (1 to 50) and `maxMinutes` (up to 30) |
| `--output <file>` | the JSON report (provider, rates and their source, ceiling, caps, estimate, spend and whether it is an upper bound, each task's state, steps, limit reached, denied approvals, cost ledger, spend and cancel attempts) |
| `--scratch <dir>` | keep the scratch folder (Hub state, log, project) there instead of deleting a temporary one |
| `--list` | print the providers, their prices and the ceiling of one request; nothing is checked or started |

**Safety rules.** Every rule below is checked before a Hub starts or a request is sent, and each refusal exits **2**:

- `CHATMCP_LIVE_OK=1` (exactly `1`): the owner's yes for this command.
- A disposable sandbox: `CI=true`, `/.dockerenv`, or `CHATMCP_LIVE_SANDBOX=1`. The tasks run in **Full Access** with nobody to approve them, so the model's commands run with the rights of the user who started the runner; never set `CHATMCP_LIVE_SANDBOX=1` on a machine you care about. The few tools Full Access still asks about (a push, a forced or destructive command) are always answered **no**.
- A known price: the provider's input and output price must be in the providers file. `ollama-local` has none (a local server is not in the models.dev snapshot) and is refused.
- The key: the provider's key variable must be set. It is the **only** credential-like variable the Hub receives (`tests/live/lib/session.mjs` forwards one allow-listed variable: `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`; everything else that looks like a key, token, secret or password is stripped). The Hub reads it from its environment through a profile (`envKeyName`), and the connection test gets it in one loopback request without `remember`, so it is never saved; the runner also replaces the value with `[redacted]` in everything it prints or writes.
- Tool calling: the Hub's own "Test API" check must report it as `supported`, or the run is refused before any task.
- The ceiling of one request must be known (context window, maximum output and both prices), and the pre-flight below must pass; it reads the ledger and is checked before the Hub starts.
- Use a throwaway key with a provider-side spending cap, and revoke it afterwards (see "The real backstop" below).

**Exit codes:** `0` every task completed; `1` a task did not complete (it failed, or reached its step or minute limit) or the run failed; `2` refused or usage error; `3` stopped by the budget (`budget_exhausted`).

### Spend governor

`tests/live/lib/budget.mjs` keeps the spend of a live run under its caps. The cap lives in the runner and deliberately not in the Hub: the Hub imposes no request, token or money quota (`lib/request-budget.mjs`), and `tests/benchmarks/run-offline.mjs` still reports `no-local-token-cap` as `unlimited`.

- **The ceiling of one request** is `(context window x input price + maximum output x output price) / 1e6`, plus a 25 % safety margin, at the runner's rates (the highest price tier, no cache-read discount). It is the most one request can cost by the provider's own limits, so it does not trust the Hub to keep prompts small. `--list` prints it. With today's providers it is large: about 0.49 USD for `deepseek-flash`, 1.03 USD for `claude-haiku-5-5` and 0.33 USD for `openrouter-deepseek-v4-flash`, so a run needs a cap of at least two ceilings (0.98, 2.05 and 0.67 USD). A 0.10 USD smoke run is refused; the actual spend of a smoke task is far below its cap.
- **What a task has spent** is the Hub's cost ledger (`modelCost.knownSubtotalUsd`, the responses it priced) plus one ceiling for every request the Hub counted (`usage.httpRequests`) that has no priced response: the one in flight, a failed or retried send, a response without usage, a response without a price. A figure with such requests in it is an **upper bound**, and the report (`spentBasis: "upper_bound"`), the ledger line and the printed total say so. No total is ever invented: when the provider sends no usage, the runner prints the upper bound and calls it that.
- **The figure of a run** counts every Hub task once, at its last value: the runner's tasks and the subagents they start. The report lists them (`hubTasks`), each task's record names the part its subagents spent (`othersUsd`), a task's ledger line is what the run's figure grew by while it ran, and the settlement is the run's figure.
- **The stop rule.** The governor polls `GET /api/tasks/:id` and `/api/state` (every 0.5 s by default, never less often than every 2 s), adds up the run, and cancels the task (`POST /api/tasks/cancel`), and every subagent of the run still running, once spent + one ceiling would pass the cap; the run then ends with `budget_exhausted` and the next task is not started. A task that settled between two polls is checked the same way before the next one starts. The step and minute limits of each task are enforced by the same loop (the Hub's task API takes none). A cancel the Hub refuses or does not answer within 10 s is tried again at the next poll; 30 s after the first attempt the runner stops the Hub itself and counts one more request at the ceiling for every task still running.
- **Subagents are counted, not switched off.** In Full Access a task is offered `spawn_agent` and `spawn_workflow`. The agents they start are tasks of the same Hub: `ConcurrentApiAgent` lists them in `/api/state` with their own usage and cost ledger, so the governor counts them like the task, waits until they have settled before the next task starts (a subagent can outlive the task that started it), and cancels them with it. `verify-live-budget` runs a task that calls `spawn_agent` and checks that the report, the task line and the settlement hold the subagent's spend. The Hub's other model workers (research and dynamic delegates, the coding orchestrator) start only from dashboard routes (the coding and dynamic-delegate routes refuse while the task holds the workspace, the research and orchestrate routes while any task is active), and a command the model runs gets no Hub secret (the shell runner strips `CHATMCP_HUB_SECRET`), so a task cannot start them through its tools; the runner never calls those routes. Not covered, and outside the governor's count: a subagent that waits on a dependency (state `paused`) and starts after the governor's last look (the Hub is stopped right after the run, which cuts it short), and a model that reads the Hub's session file in the scratch folder to call the Hub's API itself (the disposable sandbox and the provider-side cap are the only answer to that).
- **How far it can overshoot.** The request in flight is already counted at the ceiling, so the run ends within **cap + one ceiling** as long as no more than one response comes back between two polls (`verify-live-budget` proves this over 20 seeded runs against a real Hub). Requests faster than the poll can add more. Local accounting also cannot see what the provider does on its side (its own retries, a gateway's fallback to another upstream), nor the Hub's connection check before the first task (up to five protocol attempts and one tool-calling probe, which report no usage): the report lists that check under `uncounted`.
- **The pre-flight.** Before the Hub starts, the effective cap of the run is the smaller of `--budget-usd` and what the monthly cap leaves after this month's ledger and one ceiling of overshoot. It must hold two ceilings (the request in flight and the next one), plus the calibrated estimate of the tasks: for a task that ran unstopped on the same provider and model five times or more, the 90th percentile of those runs. A task with fewer runs is listed as uncalibrated and limited by the in-run cap alone. A refused run exits 2 and leaves no ledger line.
- **The ledger** (`bench-results/ledger.jsonl`, one JSON object per line) is shared by every run on the machine. A run appends a reservation (its effective cap + one ceiling), reads the file again and counts only the runs whose first line comes before its own, so two runs started at the same moment cannot both take the last of the month; the one that lost writes a release and is refused. Then it appends one line per task (what the run's figure grew by while it ran, with `ownUsd` and `othersUsd`, `basis`, what stopped it) and a settlement. Each line is one write to a file opened for appending, followed by fsync. A run that never settled (killed) counts as its whole reservation; correct it by appending a `settle` line with the provider's real figure. An unreadable line (a truncated tail, a hand edit) is skipped and reported by line number, and the next append first closes a line a killed writer left open. A run that fails while a task is under way settles at its whole reservation, since that task's spend is unknown.
- **A price of 0** gives a ceiling of 0: the run is allowed, with a warning that the runner cannot limit its spend (only the step and minute limits apply). Whether a local model may run at a price of 0 is the owner's decision; `ollama-local` has no price and is refused.

### The real backstop: provider-side caps

The governor is local accounting, so treat it as a second line. Before a paid run, set a hard cap at the provider, on a throwaway key:

- **DeepSeek:** a prepaid balance. Top up only what the run may spend; requests fail once the balance is used up.
- **OpenRouter:** a credit limit on the API key itself, set when the key is created or edited.
- **Anthropic:** a spend limit on the workspace the key belongs to, set in the Console.

Check how each limit behaves in the provider's own console before relying on it. Local accounting can end about one in-flight request above the cap, more when responses come back faster than the poll, and it cannot see provider-side retries or the connection check; only the provider-side cap stops those.

**Providers.** `tests/live/providers.json` takes each model id, context window, maximum output and price from the repository's models.dev snapshot (`lib/model-catalog.data.json`, 2026-10-28); `verify-live-runner` compares every number with the snapshot. A value the snapshot lacks is `null` with a note. The prices are a dated public list, not a bill.

Read [Testing with real models](TESTING-WITH-REAL-MODELS.md) for manual/authorized endpoint verification and [Development](DEVELOPMENT.md) for CI prerequisites.
