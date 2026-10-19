# ChatGPT Web Companion: risks and privacy safeguards

This page describes what the ChatGPT Web Companion does with your workspace content, the risk that comes with it, and the safeguards ChatMCP adds to reduce accidental exposure. The safeguards are **best effort**. They lower the chance of a leak; they do not make the mode safe for material you must not share.

## What the mode is, and the risk

The Companion is a paired Chrome/Edge extension (Manifest V3). It types the Hub's messages into the chat box of the **chatgpt.com tab you are signed in to**, and reads the model's reply back as a fenced JSON block. In other words, it **automates the consumer ChatGPT page**.

- It is not an API, and it is not a channel that OpenAI provides, supports or permits. ChatMCP is not affiliated with OpenAI.
- Automating that page **may conflict with OpenAI's Terms of Use**. Your ChatGPT account could be warned or suspended. ChatMCP cannot assess or remove that risk; read the current terms yourself.
- The Companion sends **workspace content into your ChatGPT chat**: your prompt, the output of every tool the model calls (file contents, search hits, command output, Git output) and any handoff summary. That content is stored in your ChatGPT history and handled under OpenAI's policies, outside ChatMCP's control. Deleting a chat in ChatGPT is not something ChatMCP can do or verify.
- Use the Model API when you need a channel with clear terms, or when the workspace holds material that belongs to a client.

The same wording is shown in Settings (next to the channel selector, before you switch to the mode) and in the task view of every ChatGPT Web task.

## What ChatMCP does to limit accidental exposure

Three safeguards sit between the Hub and the extension. The scanner covers everything the Hub hands over: the first message, a continuation prompt, handoff text, every tool result, every `result_page` and what `poll()` returns. The protected-file filter and the optional review apply to tool results. Nothing here hides the automation from the page or from OpenAI, and nothing here changes how the extension is paired or how it talks to the Hub.

### 1. Outbound secret scanner (always on)

`lib/outbound-redaction.mjs` replaces text that has the shape of a credential with a labelled placeholder such as `[REDACTED:github-token]`. It runs in addition to the exact-match masking of secrets the Hub knows about (`[REDACTED]`).

| Family | Examples of what is recognised |
| --- | --- |
| Key material | PEM, OpenSSH and PGP private key blocks, including a block cut off before its END line; age secret keys |
| Cloud and platform tokens | AWS access key ids and secret keys, Google API keys and OAuth secrets, Azure storage keys and SAS signatures, DigitalOcean, Databricks, Vault, Terraform, Doppler, Grafana, Atlassian, Linear, Postman |
| Source hosts and registries | GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), GitLab, npm, PyPI, Docker, Hugging Face |
| AI and SaaS keys | OpenAI-style `sk-` keys, Anthropic `sk-ant-`, OpenRouter, Stripe, Twilio, SendGrid, Mailgun, Shopify, Slack tokens and webhooks, Discord and Telegram bot tokens and webhooks |
| Generic frames | JWT, `Bearer` tokens, `Authorization`, `X-Api-Key` and cookie headers, `user:password@` in a URL of any scheme, connection strings with `Password=`, SQL `PASSWORD '...'`, `.npmrc`/`.netrc` entries, kubeconfig key data, PowerShell `ConvertTo-SecureString`, secret flags on a command line, secret-looking query parameters |
| Assignments | `NAME=value` where the name looks sensitive (`API_TOKEN`, `DB_PASSWORD`, `SECRET_KEY_BASE`), `"password": "..."` and `key: value` forms, `setx`, `$env:` and `export` lines; a structured result is also judged by its field names |

53 labelled rules in total (`REDACTION_LABELS` in the module lists them, plus `secret-field` for a structured result judged by its field name and `manual` for text you hide yourself). A report from the scanner holds labels and counts only. A matched string is never returned, logged or written into the task events.

Where it runs, and why there:

- On the **result object**, before it is turned into JSON and before it is paged. Line-based rules need real line breaks, the stored copy that `result_page` serves later is already clean, and a secret cannot be split by the 900-character first chunk.
- On the **prompt, handoff and continuation text, before the size limits** (4,800 and 4,700 bytes) are applied. A placeholder can be longer than a short secret, so the limit is checked on the masked text; a message that only fits unmasked is refused, not sent over the limit.
- Again in `makeMessage` and in `messageView` (what `poll()` and `claim()` return), as a last line of defence. A message stored by an older Hub version is masked on its way out.
- The protocol header (task id, turn, nonce) is never altered, so the model can still answer.

The task events carry one line per message that was changed, for example "Before sending to ChatGPT (result desktop-commander.read_file): 2 secret-shaped strings masked (github-token×1, env-secret×1)". That is the ledger of what was removed. A second ledger records what was sent: when the extension confirms a send, the task's `transcript.jsonl` gets an `outbound_message` entry with the exact text that was handed over (already scrubbed), its size and its SHA-256, so you can see afterwards what reached chatgpt.com.

### 2. Protected files are withheld (always on)

When a call or its result names `.env*`, `*.pem`, `*.key`, `id_rsa*` or anything under the existing protected set (`lib/protected-paths.mjs`: `.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `credentials`, `secrets.*`, `.npmrc`, `.netrc` and similar), what the tool read is **withheld whole**: ChatGPT receives a short notice instead, even for lines that look harmless. The check looks at the path arguments of the call, at the tokens of a command line (`cat .env`, `git show HEAD:.env`, `--env-file .env`) and at the file names a search result or a structured result names. `.env.example` is withheld as well (stricter than `lib/protected-paths.mjs`, which lets templates through for the local tools).

The tool itself still runs; only its output is withheld. The built-in `local.*` tools already refuse these files; this safeguard is for external servers such as Desktop Commander and for shell output.

### 3. Review before send (off by default)

Settings, next to the channel selector: **Review before send to ChatGPT**, globally and per workspace ("Always review", "Never review", or follow the global setting). When it is on:

1. After a tool runs, its result (already scrubbed) is **held on your computer** and shown in the task view with the exact text that would be typed into the chat. Status `waiting_approval`; the task list says it waits for you.
2. Nothing is sent. A held message has its own status, so `poll()` does not offer it and `claim()` refuses it. There is no timer that sends it.
3. You choose:
   - **Approve** sends exactly the previewed text.
   - **Redact more** hides strings you type or select (at least 3 characters each). The message is rebuilt from the filtered result, so the header and nonce stay intact; the same strings stay hidden in later results of the task. It remains held.
   - **Withhold** sends only a notice that you chose not to share the result.
4. **Cancelling** the task ends it with nothing sent. If you do nothing, the hold **times out after 10 minutes**, the task fails with `outbound_review_timeout`, nothing is sent, and the task is marked so that a continuation inspects the real file state first (the tool has already run on your machine).

Catalog and describe replies carry no workspace data and are not held. The first message, continuation prompts and handoff text are not held (they are scrubbed); the review applies to tool results.

The preview and the decision routes (`POST /api/browser/outbound/decide`, `POST /api/browser/privacy/config`) sit behind the per-launch Hub secret like every other `/api` route ([Hub authentication](HUB-AUTH.md)). The preview appears only in responses that need the Hub secret (`GET /api/state` and the dashboard POST routes that return the Hub state, such as `/api/browser/privacy/config`); it is not in `/api/extension-state`, not in `poll()` and not in anything else the extension can read.

## What this does not do

- It does not find a secret that has no recognisable shape (a random string in prose, a password in a sentence, a key split over two lines) and does not read images or other binary data. It cannot know which text is confidential for a client. Review before send is the safeguard for that.
- Task history and transcripts stored on your own computer (`tasks/<id>/transcript.jsonl` in the Hub's data folder) keep the raw tool results, masked only for secrets the Hub knows by exact value. Only what is sent to chatgpt.com is filtered.
- It does not change the Terms-of-Use risk, and nothing in ChatMCP hides or disguises the browser automation.
- Withholding is by path and by recognisable output. A tool that returns a protected file's content under no file name, in a command that never names it, is only covered by the scanner.

## How it was tested

`tests/verify-outbound-redaction.mjs` (scanner and deny-list), `tests/verify-outbound-runner.mjs` (the real `BrowserRunner` driven through start, poll, claim, sent and reply, with only the tool server stubbed), `tests/verify-outbound-review.mjs` (hold, approve, redact more, withhold, cancel, timeout), `tests/verify-outbound-hub.mjs` (a real Hub process, the Companion played over HTTP, the real `local.read_file`), `ui/tests/outbound-review.test.mjs` and `ui/e2e/companion-privacy.spec.mjs` (the page).

Measured by `verify-outbound-redaction.mjs`: 53 labelled rules, every one exercised by at least one of 119 generated positive samples (each tried bare and inside surrounding lines: 357 trials), recall 1.000; 0 of 241 benign strings changed (hashes, ids, integrity strings, code that only mentions secrets). Every positive is assembled at run time, so the repository holds no string that resembles a leaked credential.

Read those numbers for what they are: the corpora were written by the same person as the rules, so they show the rules do what they were written to do, not how they perform on text nobody has seen. Expect misses on secrets with unusual shapes.
