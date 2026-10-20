# Hướng dẫn phát triển

## Môi trường

| Công cụ | Yêu cầu | Dùng cho |
|---|---|---|
| Node.js | ≥ 22.12 (launcher kiểm tra); đã chạy toàn bộ test với 22.22 (Linux) và 24.19 (Windows) | Hub và toàn bộ kiểm thử Node |
| Git | 2.4x trở lên (đã chạy với 2.55 trên Windows) | quy trình phát triển; công cụ Git của agent; nhiều bộ test tạo kho thật |
| Git Bash | đi kèm Git for Windows | shell mặc định của agent trên Windows (không có thì dùng PowerShell) |
| PowerShell | Windows PowerShell 5.1 (có sẵn trên Windows 11) | launcher, script, kiểm thử script |
| Python 3.11+ | cần cho bộ E2E FastAPI bắt buộc trong CI; tùy chọn khi chạy Hub | (a) chỉ mục ký hiệu Python của Hub (`py -3.11` trên Windows); (b) bộ E2E FastAPI; (c) các bộ giao diện Python cũ |
| Playwright Chromium | cài bằng `npx playwright install chromium` trong `CHATMCP-HUB/ui` | E2E React/Vite hiện tại, phiên bản Playwright ghim trong lockfile |
| .NET SDK 10 + Visual Studio C++ build tools + WebView2 Runtime | Windows installer và native smoke | biên dịch WinForms, Native AOT supervisor, kiểm tra React trong WebView2 thật |
| Docker Desktop | tùy chọn | chỉ cho sandbox test cục bộ, không phải cloud hosting |

Hub **không có bước build** và không có dependency bắt buộc để `npm install`. `node-pty` (ConPTY) là tùy chọn: `CHATMCP-HUB\windows\Install-OptionalConPTY.ps1`; khi thiếu hoặc hỏng, terminal tương tác tự dùng pipe.

## Dynamic task tool schemas

The Hub offers each task either all 99 LocalTools plus the four internal routers (103 schemas, about 15.4k tokens) or the at most 48 LocalTools relevant to the prompt plus the routers (3.1k tokens for a prompt that names no task, 3.9k for one that only asks for a change, 7.7k at most for the corpus below). The foreground chat (the primary runner) follows the context window of the model of the task it starts: an unknown window, or one below 65,536 tokens, gets the selection; 65,536 or more keeps the full list. Background chats always use the selection. `CHATMCP_TOOL_SELECTION=auto` or `=full` overrides the choice either way, and a runner built without a mode (as the tests do) is still `full`. Tools not directly advertised remain registered in the original catalog and reachable via internal `mcp_catalog`, `mcp_describe`, `mcp_call` behind PermissionGate. A run selects on the conversation, not on its first message: the prompt of the run that starts (a continuation included) is matched by words, in English and Vietnamese, to groups of tools, and the up to 20 prompts before it, newest first (a message queued while an earlier run was going counts as one), then add the tools there is room for under the cap. So a follow-up that asks for something new is offered what that needs ("Now update the version in package.json and commit it." after "Explain what calc.js does." gets `edit_file` and `git_commit`), a follow-up that names no task ("yes, go ahead") keeps the tools the conversation has been using, one that names only part of the work (the prompts the Hub writes for an auto-resume or a repair name the edit and test tools) keeps the rest, and no message is offered less than it would be as the first message of a conversation. A conversation can therefore approach the cap: in three five-message coding conversations the fourth and fifth messages were offered 38-45 tools (6.9-7.8k tokens, against 4.0-5.1k when each message is matched alone), which leaves 2.0-2.9k tokens of history on a 16,384-token window (4.7-5.9k when each is matched alone). A run keeps its tool list from start to finish, because its context budget is planned on it: a message queued while it runs is delivered to it, the instructions tell the model that the list is fixed and that `mcp_describe` and `mcp_call` reach the rest, and the message counts when the next run selects. The `tool_selection` event records the prompt of the run and how many earlier prompts were read. The words are the original trigger words (fix, test, browser, commit ...), the general change verbs (update, add, remove, replace, convert, bump, cập nhật, thêm, xóa, đổi ...), the words of a failure report (crashes, TypeError, lỗi ...), plurals (tests, commits) and phrases such as "who calls", "mobile", "CI" or "PR". A change verb offers the four tools that change a file (about 0.8k tokens), not the whole edit group. What the later words add comes after what the original triggers offered, so the cap of 48 can only cut the additions and a prompt that matched before is offered at least what it was. A word the lists do not know still reaches every tool through `mcp_describe` and `mcp_call`, one round trip dearer. `tests/fixtures/tool-selector-corpus.json` lists 87 prompts with the tools a correct solution calls, and `tests/verify-tool-selector.mjs` measures them: every one of those tools is offered directly (the original trigger words alone offered 58% of them, and 33% of those that no prompt gets by default), the median schema cost is 4.7k tokens and no prompt costs more than 7.7k. Measured through the real runner and catalog for a coding prompt against an unconfigured window: fixed overhead 15.4k -> 8.2k tokens, history 10.3k -> 15.3k tokens.

An unknown context window is planned as 32,768 tokens and shown as a warning on the task (`conservative_fallback`). The request may still ask for the full default output (16,384 tokens; v3.9.0 sent 18% of the estimate, 5,898, which ends a reasoning answer as incomplete) while the history is planned against a quarter of the estimate. A window is 4,096..2,000,000 tokens everywhere it can be set (`lib/context-window.mjs`): smaller is refused with `invalid_context_window`, larger is clamped.
Selection does not remove tool permissions and must be benchmarked before
claiming lower total request consumption.
Parallel coding workers use the bounded 48-schema `auto` selection by default; the ordinary single-agent flow keeps its existing full-tool default unless configured.
When launching a parallel coding DAG, ChatMCP also enforces one aggregate
HTTP model-request allowance shared by its workers:
`CHATMCP_MAX_WORKER_HTTP_REQUESTS=120` (0 to disable). It counts retries and
Gemini repair/fallback attempts, and never bypasses an individual worker's
task-scoped request cap. The aggregate is reset for each newly authorized
coding DAG; no separate Windows Sandbox rules are modified.

## Request and token telemetry (no ChatMCP quota)

ChatMCP **does not impose HTTP request, token or spending caps**.
Provider billing and quota are controlled by the user/provider. No
`CHATMCP_MAX_HTTP_REQUESTS`, `CHATMCP_MAX_INPUT_TOKENS`,
`CHATMCP_MAX_OUTPUT_TOKENS` or `CHATMCP_MAX_WORKER_HTTP_REQUESTS`
limits are enforced. The AgentRunner counts real model HTTP sends including
retry/fallback/repair requests. `task.usage.httpRequests` persists
through task resume. Worker orchestration sums HTTP sends for reporting,
not to block tasks. Provider-reported tokens may exclude timed-out or
unbilled requests and should not be treated as exact charges.

## Background agents: results and completion notices (P1-F)

An agent that starts others (`spawn_agent`, `spawn_workflow`) can read what they produced and is told when one stops, without polling. The logic is in two modules that do no I/O, `lib/agent-results.mjs` and `lib/subagent-notices.mjs`; `AgentRunner` and `ConcurrentApiAgent` only hold the hooks. The threat model is Surface 5 of [THREAT-MODEL.md](THREAT-MODEL.md); what the person sees is in [USER-GUIDE.md](USER-GUIDE.md).

**`agent_results`** is read-only. It answers from the pool's records of the calling task's own children (`ConcurrentApiAgent#listSubagents`, reached through `manager.listSubagents`, which the pool sets on its own manager and on every child's), and it is offered where the spawn tools are and to a task that already has agents (a full tree still has to read them). Arguments: `ids` (optional; any id that is not a child of the caller answers `found: false` and nothing else) and `offset` (with exactly one id: reads on in a cut final message). The answer is JSON. For each agent: `id`, `goal` (the parent's own words: the prompt that the child's runner stores also carries the Hub's predecessor handoff), `role`, `workflow`, `status`, `createdAt`, `startedAt`, `finishedAt`, `durationMs`, `claim` and `hubRecord`.

- `claim` is the child's final message: model output, `verifiedByHub: false`, redacted before it is cut, one page of at most 8,000 characters, with a marker in the text and `claim.next.offset` when it is cut. The Hub's own "[Verification notice]" sentence is not part of it.
- `hubRecord` is what the Hub recorded: steps, tool calls, the receipts it made itself (`shaCheckedEdits`, `shaCheckedReads`, `passingChecks`, `diffReviews`: tool activity it saw, not proof the work is right), unverified operations, the error code and message, the branch. `verificationOutcome.ready` is never shown: it is also true when nothing needed checking.
- Bounds, guaranteed and not a target: 16 agents per call (the newest, oldest first, `omitted` counts the rest) and 24,000 characters in all; the answer is rebuilt with less text, then less detail, then fewer agents until it fits. There is no clock in it, so a parent that polls an unchanged child gets the same bytes and the no-progress detector stops it (a recovery hint after 4 repeats, a stop after 10).

**Notices.** The pool sees a child stop (the END event of its runner, plus the endings no runner reports: blocked by a failed dependency, cancelled while queued, failed before it started) and calls `AgentRunner#recordSubagentFinished` on the runner that holds the parent task. That keeps one entry per child in `task.subagentNotices` (at most 64, in `task.json`, validated again by `load()`; `recorded` then `delivered`) and adds the event `subagent_finished`. The model is told by `#tellAboutAgents`: one host message of kind `completion_notice`, added only where no model turn is open, so it follows every result of the turn before it and is never between two:

| the parent is | what happens |
|---|---|
| running, or waiting for an approval | the entry is recorded at once; at the next boundary (the top of the loop, behind `HistoryLedger.endBatch`) the message is added, in front of a message the person queued; event `subagent_notice` |
| writing its final answer when the child stops | the run goes on instead of finishing (the ledger drops what waits when a run ends), the message is added and the model answers again; not when a step limit, the deadline, a stop or the size of the context would end the run at the top of the loop (the answer stands, the entry stays `recorded`), and at most 64 times |
| finished | the entry is only recorded (`subagentNotices[].notice` in its state, the event, nothing started, no request); the next run adds the message before its prompt, once |
| restarted | `load()` restores the entries; nothing is sent or recorded; a delivered entry is never told again, an unread one is told by the next run |

The message is the Hub's: ids, role, how each agent stopped (the word for `completed` is "sent its final answer", which is all it means here), when, the goal the parent wrote (quoted on one line) and a pointer to `agent_results`; nothing an agent wrote. It is never put in `task.prompts`, `task.dialogue` or `task.carriedPrompts`, which are what tool and skill selection and the conversation read, so it selects nothing and does not count as something the person asked.

Not covered. The coding orchestrator's workers (`lib/coding-orchestrator.mjs` builds each a plain `HubManager`, which has no `listSubagents` and no spawn function) and the dynamic delegates (`lib/dynamic-delegates.mjs`, `lib/studio-delegates.mjs`: the Hub itself collects their results) have no parent model to tell. A child's own task files keep its final message as it wrote it (RR-6, RR-13). The `agent_results` call is not hooked, like the spawn calls (RR-11); `SubagentStop` is a separate matter. With `CHATMCP_DIRECT_TOOL_LIMIT=124` the three host functions (`spawn_agent`, `spawn_workflow`, `agent_results`) take the advertised functions past 128, as the two spawn tools already did.

## Trạng thái Windows Sandbox (Phase 1 experimental)

**Chưa có bằng chứng cách ly Windows Sandbox guest thật.** Việc build .NET GuestSupervisor
và chạy lệnh synthetic trực tiếp trên Windows host chỉ chứng minh hành vi host-fixture
(timeout, Job Object, parser). Phần này tuyệt đối không được tính là kiểm thử host/guest
isolation, network denial, supervisor identity hay receipt authenticity.

CI Windows installer phải build GuestSupervisor và chạy
`CHATMCP_REQUIRE_HOST_SUPERVISOR=1 node CHATMCP-HUB/tests/windows-sandbox/smoke.mjs`.
Trên Linux/Windows thiếu .NET, bộ source test nêu rõ **BLOCKED** đối với fixture chưa chạy;
bộ kiểm thử guest thật do máy Windows hỗ trợ thực hiện tách khỏi CI thông thường. Backend sản phẩm và các mô-đun snapshot/check grants/retry/subagents đã có mã nhưng cố ý báo unavailable cho đến khi trusted publication được nghiệm thu.

`receipt.json` và `receipt.sha256` chỉ kiểm tra dữ liệu nhất quán; guest có thể tạo
lại cả hai file và đọc nonce, nên đây KHÔNG phải bằng chứng về danh tính supervisor.
Thư mục export có thể ghi vẫn là bề mặt tấn công host, chưa có quota OS/ACL pinning.
Windows Feature đang chờ khởi động lại không chặn các bài test này.

## Giới hạn công cụ trực tiếp

Từ nhánh nâng cấp LocalTools, `directToolsFor` quảng bá tối đa **99 LocalTools + 4 router** (103 schemas) ở cấu hình mặc định; không còn bài kiểm thử áp đặt dưới 50. Có thể đặt biến môi trường `CHATMCP_DIRECT_TOOL_LIMIT=48` (compact) hoặc `=95` (full); giá trị hợp lệ 0-124, vượt 124 được chặn để giữ tổng advertised functions không quá 128. `0` chỉ giữ các router nội bộ. Các tool không quảng bá trực tiếp vẫn ở catalog và gọi được qua `mcp_call`. Hãy chọn giới hạn thấp hơn nếu provider có tool-limit hoặc prompt-context nhỏ; thay đổi yêu cầu khởi động lại Hub. Đây là giới hạn gửi schemas **không** phải giới hạn quyền PermissionGate hoặc tổng số tool đã đăng ký.

## Chạy kiểm thử

```powershell
cd CHATMCP-HUB
npm test                                         # mọi bộ Node, mỗi bộ một tiến trình riêng
node tests/run-all.mjs --list                    # liệt kê
node tests/run-all.mjs --filter e2e --verbose    # lọc theo tên, in toàn bộ đầu ra
node tests/run-all.mjs --json test-results/summary.json
node tests/run-all.mjs --no-skip all             # một bộ bị SKIP bị tính là FAIL (dùng cho CI)
node tests/run-all.mjs --retry-failed-once       # bộ FAIL/TIMEOUT được chạy lại một lần; qua ở lần hai = FLAKY, không phải PASS
node tests/run-all.mjs --fail-on-flaky           # một bộ FLAKY làm cả lượt chạy thất bại (dùng khi cần sạch hoàn toàn)
npm run test:ui                                  # bộ giao diện Python/Playwright (tùy chọn)
```

Hiện có **131 bộ Node** (`tests/verify-*.mjs`) và **5 bộ giao diện** (`tests/verify-*.py`, cần Python + Playwright). Hai con số này được bộ `verify-docs` đối chiếu với thư mục `tests/`, nên không thể lỗi thời mà không bị phát hiện.

Runner in một dòng cho mỗi bộ (`PASS`/`FAIL`/`TIMEOUT`/`SKIP`, thời gian, mã thoát thật) và thoát khác 0 nếu có bộ nào fail hoặc quá hạn (mặc định 180 giây/bộ, đổi bằng `--timeout`). Bộ kiểm thử in một dòng `CHATMCP_TEST_SKIP: <lý do>` rồi thoát 0 để được báo là **SKIP — không bao giờ được tính là PASS**. `--no-skip all` (hoặc `--no-skip tên1,tên2`) biến SKIP thành FAIL. Workflow hiện tại cài Python 3.11 và các gói ghim trong `tests/requirements-e2e.txt`, rồi chạy **`--no-skip all`** trên cả Windows và Linux, Node 22 và 24. Một bộ bắt buộc bị bỏ qua vì thiếu môi trường vì thế làm CI thất bại. Một phần không thể kiểm chứng trong bản này được in `BLOCKED: <gì> - <vì sao>`.

**Bộ chập chờn (`FLAKY`).** Với `--retry-failed-once`, bộ FAIL hoặc TIMEOUT được chạy lại đúng một lần. Qua ở lần hai thì nhãn là **`FLAKY` — không bao giờ là PASS**: được đếm riêng (`summary.flaky`), kèm cả hai lần chạy và đầu ra của lần hỏng trong JSON, một dòng `::warning` trên GitHub Actions. Hỏng cả hai lần vẫn là FAIL; bỏ qua (SKIP) ở lần hai cũng là FAIL. Một lần FLAKY không làm lượt chạy đỏ; `scripts/ci-flaky-gate.mjs` (job `flaky-gate` trên `main`) làm nó đỏ khi lần chạy này và hai lần chạy trước trên `main` đều có bộ FLAKY. Xem [CI-HEALTH.md](CI-HEALTH.md).

**Máy chủ LSP thật trong CI.** `tests/verify-lsp-tier.mjs` luôn chạy với máy chủ LSP giả; `typescript-language-server` và `pyright` thật chỉ chạy khi tìm thấy (thư mục `node_modules` trong `CHATMCP_LSP_NODE_MODULES`, hoặc bản cài npm toàn cục) và nếu không thì chỉ in một dòng `skip`. Job Windows installer của CI dựng runtime đã khóa bằng `scripts/intelligence-runtime/stage.mjs` (đúng các tệp installer đóng gói) rồi chạy `CHATMCP_REQUIRE_REAL_LSP=1 CHATMCP_LSP_NODE_MODULES=<runtime>/runtimes/lsp/node_modules node CHATMCP-HUB/tests/verify-lsp-tier.mjs`: với biến này, thiếu một máy chủ thật là **lỗi** (và chỉ thư mục đó được tìm, bản cài toàn cục không thay thế được). Bộ `verify-lsp-real-gate` chạy chính tệp đó trong từng tình huống và đọc mã thoát. Bước CI này chưa từng chạy trên GitHub trong bản này; đã chạy cục bộ trên Windows 11 / Node 24 với typescript 5.9.3, typescript-language-server 4.3.4, pyright 1.1.407.

Tổng thời gian cả bộ Node: khoảng 3 phút (Linux, 180 s đã đo) đến 4 phút (Windows, 243 s đã đo); bộ lâu nhất là `verify-e2e-recovery` (~57 s, vì phải giết và khởi động lại Hub nhiều lần).

### Các bộ kiểm thử

| Nhóm | Bộ | Chứng minh gì |
|---|---|---|
| **Chính bộ test** | `verify-test-runner` (26) | `tests/run-all.mjs`: mã thoát thật quyết định PASS/FAIL, bộ treo bị giết và báo `TIMEOUT`, dòng `CHATMCP_TEST_SKIP` không che được lỗi, `--no-skip`, `--retry-failed-once` (FLAKY không bao giờ là PASS, đúng hai lần chạy), `scripts/ci-flaky-gate.mjs` (ba lần chạy liên tiếp trên `main`), lỗi cú pháp lệnh |
| | `verify-mutation-runner` (11) | `tests/mutation/run-mutations.mjs`: đột biến bị nhận ra → `KILLED`, không bị nhận ra → `SURVIVED`, mẫu không khớp → `ERROR` (không bao giờ là "giết miễn phí"), đột biến của hệ điều hành khác → `N/A`, bộ test không chạy được thì không bị phán xét, tệp thật không bị đụng |
| | `verify-dco-check` | `scripts/check-dco.mjs` (chạy bởi `.github/workflows/dco.yml`) trên kho Git tạm: commit có `Signed-off-by: Tên <email>` (ví dụ do `git commit -s` tạo ra) qua, commit thiếu hoặc sai định dạng thì fail và được nêu tên; merge commit và tác giả bot đã biết (`github-actions[bot]`, `dependabot[bot]`, `semantic-release-bot`) được miễn, tên giống bot thì không; dòng sign-off không nằm trong khối trailer không tính; workflow dùng `pull_request`, token chỉ đọc, checkout đủ lịch sử và action ghim SHA |
| | `verify-docs` | tài liệu khớp với mã: liên kết và neo, phiên bản (`package.json` = mã = giao diện = CHANGELOG), các con số được trích dẫn (số bộ test, công cụ, preset, trạng thái), script `.ps1/.cmd` chỉ có ASCII, phụ thuộc test và action CI được ghim, mọi mẫu trong danh sách đột biến còn khớp mã (phần cần cả repository thì SKIP khi thiếu) |
| **Lõi an toàn** | `verify-command-analysis` | bảng ca của bộ phân loại lệnh và vùng cấm, kể cả các cách lách (mở rộng, lồng nhau, pipe) |
| | `verify-shell-guards` (14) | cấu hình/hook Git của kho, theo dõi symlink/junction/bí danh tới nơi thật, ổ PowerShell (`Env:`, registry), phân loại quyền và công cụ Git |
| | `verify-shell-runner` (44) | `ShellRunner` với shell thật: trích dẫn, mã thoát, timeout giết cả cây tiến trình, hủy, giới hạn đầu ra, **lọc biến môi trường** |
| | `verify-execution-contract` (24) | hợp đồng ExecutionBackend, CapabilityReport, ExecutionReceipt, fail-closed dispatch, huỷ bỏ pre-execution, không bao giờ tự fallback |
| | `verify-windows-sandbox-config` (7) | cấu hình .wsb bảo mật cao: cấm mạng, clipboard, thiết bị, vGPU; kẹp bộ nhớ [512, 8192] MB; kiểm tra an toàn đường dẫn và ngăn chặn xung đột |
| | `verify-windows-sandbox-smoke` | kiểm tra config/transport và từ chối lỗi trên mọi OS; các kiểm thử C# trên **Windows host** chỉ chạy khi có .NET 10 và build helper. Không kiểm chứng cách ly guest; không coi nhánh BLOCKED nội bộ là PASS |
| | `verify-fs-helpers` | kiểm tra đối số, ghi nguyên tử, glob, Git runner |
| | `verify-local-tools` | các công cụ cục bộ trên workspace và kho Git thật; nhấn vào điều *không bao giờ* được xảy ra |
| | `verify-permissions-modes`, `verify-full-access` | `PermissionGate`: ba chế độ, đường dẫn bị chặn, `sandbox-only`, Full Access, lịch sử phê duyệt |
| | `verify-readonly-corpus`, `verify-full-access-always-ask`, `verify-spawn-limits`, `verify-batch-write` | chế độ Chỉ đọc chống lách lệnh (kho `tests/fixtures/readonly-bypass-corpus.json`), Full Access vẫn hỏi thao tác không hoàn tác, giới hạn độ sâu/số agent con, `files_write_batch` giữ mã hóa và chống ghi đè |
| | `verify-skill-delivery`, `verify-source-lint`, `verify-lsp-tier`, `verify-lsp-real-gate`, `verify-trust-labels` | kỹ năng cài đặt thật sự tới mô hình, mã không còn dòng bị nuốt vào chú thích, tầng LSP trên workspace thật (máy chủ giả luôn chạy, máy chủ thật khi tìm thấy; kết quả đầu tiên của máy chủ nguội là liên kết import thì xếp sau khai báo), cổng `CHATMCP_REQUIRE_REAL_LSP`, cổng chặn nhãn tin cậy sai |
| **Tích hợp** | `verify-local-backend` | `HubManager` (backend `local`) + gate + công cụ + `AgentRunner` với mô hình giả; không cần Docker, mạng hay khóa |
| | `verify-task-state` | máy trạng thái nhiệm vụ: luật thuần, cách `AgentRunner` áp dụng, kết luận về nhiệm vụ tìm thấy sau khi Hub chết |
| | `verify-launcher` | launcher nền (`lib/launch.mjs`, và `Start/Stop-ChatMcpHub.ps1` trên Windows) |
| | `verify-phase0-regressions` | các lỗi do audit Phase 0 tìm ra (checkpoint qua đường dẫn 8.3, PTY, `close()`) |
| | `verify-agent-results` (17) | `agent_results` và bản ghi thông báo (`lib/agent-results.mjs`, `lib/subagent-notices.mjs`): lời của agent con (`claim`, `verifiedByHub: false`) tách khỏi bản ghi của Hub, dấu phân cách/bản ghi/agent giả trong văn bản vẫn nằm trong chuỗi, giới hạn kích thước là bảo đảm (60 ca ngẫu nhiên và ca xấu nhất), che bí mật TRƯỚC khi cắt, phân trang ghép lại đúng văn bản, không có đồng hồ trong câu trả lời, mỗi agent một mục, tệp nhiệm vụ hỏng nạp lại thành danh sách có giới hạn |
| | `verify-subagent-notices` (20) | `AgentRunner`, `PermissionGate`, `HistoryLedger` và `ConcurrentApiAgent` thật với worktree Git thật, mô hình giả: agent cha đang chạy, đang chờ phê duyệt, đã xong; thông báo luôn đứng sau MỌI kết quả của lượt và trước tin nhắn người dùng xếp hàng; câu trả lời cuối bị giữ lại khi agent con dừng giữa chừng (trừ khi giới hạn bước làm mất câu trả lời; tối đa 64 lần); thông báo không chọn công cụ/kỹ năng và không phải yêu cầu của người dùng; khởi động lại và crash; agent cha poll bị chặn; cây đầy; workflow; agent cháu |
| **Mô hình** | `verify-model-adapters` | Anthropic, OpenAI-chat, preset, liệt kê model, lưu khóa — toàn bộ bằng `fetch` giả |
| | `verify-dual-mode`, `verify-gateway-*`, `verify-gemini-*` | gateway Gemini/OpenAI: dialect, nén khi 413, sửa lệnh lỗi, bị cắt |
| | `verify-mock-protocols` (26) | máy chủ model giả nói đúng giao thức thật (`tests/e2e/mock-model-server.mjs`): Chat Completions, Anthropic Messages, Responses và Gemini `generateContent`, dạng JSON và SSE (trừ Gemini, vì adapter Gemini không stream): mảnh `tool_calls`, khối thinking có chữ ký, `redacted_thinking`, tóm tắt reasoning, `thoughtSignature`, trường cache usage, `max_tokens`, `response.completed` với nhiều `function_call`. Bộ kiểm tra chặt `tests/e2e/protocol-validators.mjs` từ chối điều API thật từ chối (kết quả công cụ sai chỗ, tham số lạ, khối thinking bị sửa hoặc giả chữ ký, `tool_use` thiếu kết quả...; mỗi luật ghi nguồn và có ít nhất một ca chấp nhận và một ca từ chối: 133 ca cho 28 luật). Bơm lỗi mạng: đứng im, cắt trước sự kiện kết thúc, 413, 400 "stream not supported". Sáu hội thoại mẫu chạy qua `respondStandard`, `respondOpenAIResponses`, vòng Gemini của `GatewayProvider`, và `AgentRunner` → `GatewayProvider` thật; một ca đối chứng cho thấy lịch sử viết kiểu cũ bị máy chủ chặt từ chối bằng HTTP 400 |
| | `verify-history-ledger` (18) | `HistoryLedger` (`lib/history-ledger.mjs`), nơi duy nhất ghi lịch sử gửi model: tin nhắn của host (gợi ý phục hồi, tin của Stop hook, thông báo agent nền) luôn nằm sau MỌI kết quả công cụ của lượt. Kiểm bằng hơn 400 lô ngẫu nhiên cho mỗi giao thức (Chat, Responses, Anthropic) qua các bộ chuyển đổi thật, kèm nhóm đối chứng ghi vào mảng thô theo cách cũ (phải thấy lỗi, nếu không bộ kiểm tra vô nghĩa); `pairToolCalls` là phép đồng nhất trên lịch sử của ledger (chỉ lượt bị cắt dở mới được vá); ảnh chụp lịch sử 20 MB so với `structuredClone`; mọi adapter và hai lượt nén chỉ đọc (chạy trên bản sao đóng băng); `AgentRunner` thật với một lượt hai lời gọi |
| **Phiên & HTTP** | `verify-persistent-sessions`, `verify-studio-recovery`, `verify-hub-claim-recovery`, `verify-network-recovery` | phục hồi phiên, tự tiếp tục, mất mạng |
| | `verify-studio-core`, `verify-studio-http`, `verify-studio-verifications`, `verify-v2-http`, `verify-v2-runtime`, `verify-agent-http`, `verify-agent-autotools` | workspace/checkpoint/review, route HTTP, CSRF/Origin, Docker terminal |
| **ChatGPT Web (legacy)** | `verify-browser-continuation`, `verify-first-message`, `verify-recovery-dom`, `verify-reply-witness`, `verify-result-paging`, `verify-send-cycle` | tiện ích trình duyệt và `BrowserRunner` (giữ để không hồi quy) |
| **Giao diện cũ** | `verify-ui-logic` | quyết định của dashboard (`web/ui-logic.js`) chạy không cần trình duyệt; không thay thế bằng chứng React/Vite |
| **Long-task autonomy** | `verify-agent-progress`, `verify-agent-autonomy` | Durable, host-proposed task phases, semantically equivalent read/search cycle detection, real local file hashes, approved test receipts, two strategy pivots and bounded stop; mock models are not live-provider proof |
| **React hiện tại** | `ui/tests/*.test.mjs` | typed Hub adapter, task/approval/history, trạng thái thật, SSE event mapping, inspector và lỗi API |
| | `ui/e2e/studio.spec.mjs` | Playwright Chromium với build React/Vite hiện tại, Local Hub thật và nhà cung cấp mô hình theo kịch bản |
| **Windows native** | `ui/e2e/webview2-smoke.mjs` | WinForms + WebView2 thật tải React từ Hub tạm, lỗi JavaScript/API và điều hướng cơ bản |
| **E2E** | `verify-e2e-bugfix` (34) | sửa một lỗi trong dự án có sẵn và chứng minh bằng test của dự án |
| | `verify-e2e-fastapi` (24) | dựng dịch vụ FastAPI test-first, rồi tác vụ thứ hai ở chế độ Tự động |
| | `verify-e2e-git` (25) | nhánh, commit, và chỉ push khi bạn đồng ý (remote là kho bare cục bộ) |
| | `verify-e2e-recovery` (30) | giết Hub giữa nhiệm vụ; lần khởi động sau không phát lại thao tác chưa rõ kết quả |
| | `verify-e2e-isolation` (52) | hai Hub cạnh nhau không thấy dữ liệu của nhau; cửa vào của Hub |
| | `verify-e2e-subagent-results` (47) | Hub thật + máy chủ model giả (Chat Completions, strict): cha khởi động hai agent con, chúng dừng trong lúc cha còn làm việc, yêu cầu kế tiếp của cha mang MỘT thông báo (không có chữ nào của agent con), cha đọc kết quả bằng `agent_results` và câu trả lời cuối dựng từ kết quả đó; cha xong trước, `kill -9`, khởi động lại, rồi người dùng quay lại; khóa mà agent con in ra không có trong yêu cầu model nào |
| | `verify-e2e-adversarial` (74) | repo độc hại + mô hình "ngoan ngoãn" làm mọi thứ README bảo; kiểm tra điều gì **đúng** sau đó |

Bộ giao diện Python cũ (tùy chọn, cần Python + Playwright; xem bên dưới): `verify-ui-e2e.py`, `verify-react-ui.py`, `verify-v2-ui.py`, `verify-studio-ui.py`, `verify-auto-project-ui.py`. Tên có chữ React không chứng minh bộ đó kiểm tra frontend TypeScript/Vite hiện tại; cổng bắt buộc cho frontend này là bộ bên dưới.

### React/Vite E2E và Windows WebView2

Chạy từ thư mục gốc của repository:

```powershell
cd CHATMCP-HUB/ui
npm ci --no-audit --no-fund
npx playwright install chromium
npm run test:unit
npm run test:e2e
# Chỉ dùng khi đã build cùng mã nguồn cần kiểm tra:
npm run test:e2e:built
# Windows: cần .NET SDK 10 và WebView2 Runtime, dùng build React vừa tạo:
node e2e/webview2-smoke.mjs
```

`test:e2e` chạy TypeScript + Vite build trước khi mở Chromium headless. Local Hub thật phục vụ `web/dist`; không chặn hoặc giả response của Hub, không dùng trang legacy. Mỗi ca tạo kho Git, state Hub và model server loopback riêng trong thư mục tạm; môi trường tiến trình Hub được lọc credential và cấu hình Git cá nhân. File, command, permission gate và Git đều chạy thật. Bộ test dọn tiến trình và dữ liệu tạm sau khi chạy.

Các luồng được kiểm tra từ React: onboarding, chọn workspace, lưu và kiểm tra model, tạo hội thoại trống không gọi model, gửi prompt, tool receipts, preview/rủi ro và Approve/Deny, sửa file và chạy test, Git diff, Files/Activity/Skills, kế hoạch trống và checklist có bằng chứng, Stop/Resume cùng ID, lịch sử sau khi khởi động lại Hub ở trạng thái đã dừng, đổi quyền trong Settings, và test thất bại không trở thành thông báo thành công. Terminal được tạo qua API được bảo vệ của Hub để xác minh tab đọc output/mã thoát của phiên thật. Bộ browser xác nhận kết nối `/api/tasks/events`; token routing có unit test. Streaming token từ provider thật vẫn cần kiểm chứng riêng.

Console errors, runtime exceptions, HTTP lỗi và API error envelopes làm E2E thất bại. Trạng thái task bị hủy theo yêu cầu vẫn là dữ liệu hợp lệ. Một ca dùng API key giả trong fixture để kiểm tra input được xóa sau lưu/đổi provider/đổi origin, và request cấu hình mới không mang key cũ; không dùng credential cá nhân hay gọi model trả phí. Reporter bắt buộc làm cả run thất bại nếu có `test.skip`; `ui/tests/e2e-gate.test.mjs` xác minh mã thoát thật của trường hợp đó. Kết quả JSON, Hub logs và ảnh/trace khi thất bại nằm trong `ui/test-results/` và được CI lưu làm artifact.

CI chạy React unit + Chromium E2E trên Windows và Linux. Job Windows installer chạy smoke WinForms/WebView2 sau build và thất bại nếu thiếu prerequisite; tham số `--allow-unavailable` chỉ dành cho khảo sát local và không dùng trong CI. Native smoke này kiểm tra tải/điều hướng, không thay thế toàn bộ luồng agent của Chromium. Restart React kiểm tra phiên đã dừng; crash giữa thao tác và chống phát lại mutation thuộc các regression Hub như `verify-e2e-recovery`.

Mô hình ở các ca này là máy chủ **theo kịch bản**, không phải model thật. Kết quả không xác nhận chất lượng model trả phí, OS isolation, hay fresh install/upgrade/uninstall trên Windows sạch. Xem thêm [hướng dẫn E2E React](../CHATMCP-HUB/ui/e2e/README.md).

### Bộ cần Python

```powershell
# E2E FastAPI: cần một Python có các gói ghim trong CHATMCP-HUB\tests\requirements-e2e.txt (fastapi, uvicorn, httpx, pytest)
py -3.11 -m venv deploy\.generated\venv-e2e
deploy\.generated\venv-e2e\Scripts\pip install -r CHATMCP-HUB\tests\requirements-e2e.txt
# hoặc trỏ tới interpreter có sẵn các gói đó:
$env:CHATMCP_E2E_PYTHON = 'C:\...\python.exe'

# Giao diện: Playwright + Chromium/Edge/Chrome
deploy\.generated\venv-e2e\Scripts\pip install -r CHATMCP-HUB\tests\requirements-ui.txt   # playwright (ghim)
$env:PATH = "$PWD\deploy\.generated\venv-e2e\Scripts;$env:PATH"   # để runner thấy `python` có Playwright
cd CHATMCP-HUB; npm run test:ui
```

Thiếu gói hoặc trình duyệt → bộ **SKIP** (có lý do), không giả vờ PASS. Trình duyệt được tìm theo thứ tự: `$CHATMCP_CHROMIUM`, các đường dẫn Linux quen thuộc, Chromium của Playwright, Edge hoặc Chrome đã cài. `CHATMCP_E2E_SHOTS=<thư mục>` bật lưu ảnh chụp màn hình.

Script ở thư mục gốc có kiểm thử riêng, chạy bằng dữ liệu giả trong thư mục tạm:

~~~powershell
node CHATMCP-HUB/tests/run-all.mjs
# Windows PowerShell 5.1: payload phải loại state/dev dependencies và dọn đúng thư mục staging.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/Test-InstallerPayload.ps1
# CI yêu cầu regression này trước khi build installer; không có nhánh skip.
~~~

## Bộ E2E: thật ở đâu, giả ở đâu

`tests/e2e/` là một khung nhỏ dùng chung:

- **Thật:** `hub.mjs` chạy như tiến trình con (`hub-process.mjs`), công cụ cục bộ, cổng phê duyệt, máy trạng thái, tệp trên đĩa, Git, pytest/uvicorn (bộ FastAPI), trình duyệt (bộ giao diện).
- **Giả:** *mô hình*. `mock-model-server.mjs` là một máy chủ nói theo kịch bản (`scenarios.mjs`: `call(tool, args)`, `calls(...)` cho nhiều lời gọi trong một lượt, `say(text)`, `thinking(...)`, `sequence(steps)`) và nói đúng giao thức thật: `/v1/chat/completions`, `/v1/messages` (Anthropic), `/v1/responses` và `/v1beta/models/<model>:generateContent` (Gemini), dạng JSON lẫn SSE (trừ Gemini). Nó từ chối điều API thật từ chối (kết quả công cụ sai chỗ, tham số lạ, khối thinking bị sửa; `protocol-validators.mjs` ghi nguồn của từng luật): Anthropic, Responses và Gemini mặc định chặt, còn Chat Completions chặt khi `strict: true` (`t.mock()` của khung E2E Node bật nó). Lỗi mạng bơm bằng `mock.inject({ kind: 'stall' | 'cut' | 'payload-too-large' | 'stream-unsupported' | 'status' })`. Bộ giao diện Playwright dùng `startMockModel()` không đổi (Chat Completions vẫn dễ tính).
- Vì vậy các bộ E2E chứng minh **Hub, công cụ và cổng quyền hoạt động cùng nhau**, *không* chứng minh một mô hình thật lập kế hoạch tốt. Điều đó cần khóa API: xem [TESTING-WITH-REAL-MODELS.md](TESTING-WITH-REAL-MODELS.md).
- Mọi bộ E2E kiểm tra **trạng thái cuối** (tệp trên đĩa, lần chạy test do chính bộ test thực hiện, các lần hỏi duyệt, checkpoint, nhật ký của nhà cung cấp), không tin lời mô hình hay giao diện.

Viết một bộ E2E mới:

```js
import { runScenario } from './e2e/harness.mjs';
import { answerApprovals, connectModel, setMode, startTask } from './e2e/hub-process.mjs';
import { call, say, sequence } from './e2e/scenarios.mjs';
import { gitInit, makeCalcProject } from './e2e/fixtures.mjs';

await runScenario({ name: 'mine', summary: 'what it proves', budgetMs: 120_000 }, async (t) => {
  const project = t.dir('app');
  makeCalcProject(project);
  gitInit(project, t.scratch);
  // Một kịch bản có sẵn ('repair-add', 'explore') hoặc tự viết bằng sequence():
  const mock = await t.mock({ scenarios: { mine: sequence([call('read_file', { path: 'calc.js' })], { final: 'Xong.' }) }, scenario: 'mine' });
  const hub = await t.hub({ project });          // một Hub thật (backend local) trên thư mục dữ liệu riêng
  await connectModel(hub, mock);                 // "Lưu & kiểm tra" như người dùng làm trong Cài đặt
  await setMode(hub, 'review');
  const task = await startTask(hub, 'Đọc calc.js rồi trả lời.');
  const { task: settled, answered } = await answerApprovals(hub, task.id, () => true);   // trả lời mọi yêu cầu duyệt
  t.equal(settled.state, 'completed', 'the task ends completed');
  t.equal(answered.length, 0, 'reading is never put to the person');
  // t.check(cond, label, detail) · t.equal(a, b, label) · t.must(cond, label) · t.note(text) · t.blocked(what, why) · t.skip(reason)
});
```

`runScenario` tạo thư mục tạm (đường dẫn dài, không phải 8.3), dọn Hub và thư mục tạm kể cả khi thất bại, đặt đồng hồ chống treo, in `ok`/`not ok` và `PASS:`/`FAIL:`, và đặt mã thoát. `t.hub({ stateDir })` với cùng `stateDir` mô phỏng khởi động lại. Một kịch bản là hàm chỉ nhìn thấy điều một mô hình thật nhìn thấy (yêu cầu của người dùng và kết quả công cụ đã gọi) và trả về bước kế tiếp; không có ngẫu nhiên, không có mạng.

## Kiểm thử đột biến

`tests/mutation/run-mutations.mjs` trả lời câu hỏi "bộ test này có **thật sự fail được** không?". Nó sao chép Hub vào thư mục tạm, hỏng mã **một chỗ nhỏ mỗi lần** (thay đúng một đoạn văn bản bằng đoạn khác: đổi điều kiện, xóa một lời gọi, tắt một lớp bảo vệ), chạy bộ test trên bản đã hỏng và báo bộ test có nhận ra không.

```powershell
cd CHATMCP-HUB
node tests/mutation/run-mutations.mjs tests/mutation/isolation.json
node tests/mutation/run-mutations.mjs tests/mutation/task-state.json --only M3,M4 --json out.json
node tests/mutation/run-mutations.mjs tests/mutation/fastapi.json     # cần Python như bộ FastAPI
```

| Kết quả | Nghĩa là |
|---|---|
| `KILLED` | bộ test fail trên mã đã hỏng — đúng như mong muốn (kèm tên các kiểm tra đã fail) |
| `SURVIVED` | bộ test vẫn xanh trên mã đã hỏng: lỗ hổng của test, hoặc dòng mã thừa. Công cụ thoát mã 1 |
| `EQUIVALENT` | đột biến không đổi hành vi (dòng phòng thủ thừa); danh sách ghi lý do bằng trường `equivalent`. Nếu nó lại bị `KILLED`, ghi chú báo "annotation is stale" |
| `ERROR` | đoạn văn bản cần thay không còn khớp **đúng một lần** (danh sách đã cũ hoặc mẫu mơ hồ) — không bao giờ coi là "đã giết" |
| `SKIP` | bộ test không chạy được trên máy này (ví dụ thiếu Python) nên không phán xét được; `--allow-skip` để chấp nhận |
| `N/A` | đột biến chỉ áp dụng cho hệ điều hành khác (trường `platforms`, tên theo `process.platform`): không chạy, không tính là sống sót, không đổi mã thoát |

Công cụ chạy bộ test trên bản **chưa hỏng** trước; nếu nó không PASS thì dừng (mã 2) vì mọi "KILLED" sau đó đều vô nghĩa. Tệp thật không bao giờ bị sửa — chỉ bản sao tạm. Mỗi danh sách chạy vài phút nên công cụ **không** thuộc `npm test`.

Các danh sách hiện có: `isolation.json` (cửa vào của Hub: Host/Origin/CSRF/CORS/CSP/địa chỉ nghe, nhốt workspace và symlink, lưu và rò rỉ khóa API, khóa phiên bản, trạng thái từng Hub) → `verify-e2e-isolation`; `task-state.json` (ghi trước khi chạy công cụ, lời gọi đang chờ khi khởi động lại, luật chuyển trạng thái) → `verify-task-state`; `fastapi.json` (phân loại lệnh kiểm tra, cái gì được tính là bằng chứng) → `verify-e2e-fastapi`; `scrub.json` (lọc biến môi trường của tiến trình con) → `verify-shell-runner`; `public.json` (cửa trước của chế độ công khai: Host/HTTPS/Origin/CSRF, đăng nhập, giới hạn thử sai, địa chỉ client sau proxy, các route workspace, tách tài khoản của agent) → `verify-e2e-public` (Phần B chỉ chạy khi là root trên Linux); `broker.json` (kiểm tra yêu cầu gửi tới broker, giới hạn, dọn dẹp sau lệnh, trạng thái kẹt, quyền của socket) → `verify-exec-broker` — **chạy bằng người dùng thường**, vì root không phân biệt được đột biến K25; `separation.json` (từng cờ của launcher, reaper, chủ sở hữu và quyền của từng thư mục supervisor chuẩn bị, 12 kiểm tra của bằng chứng lúc khởi động) → `verify-exec-separation` (chỉ root trên Linux); `workspaces.json` (địa chỉ kho và tham số clone, giới hạn, registry và guard, môi trường cùng cờ cứng hóa của mọi tiến trình Git do Hub chạy, token chỉ đi tới máy chủ tin cậy, che bí mật khỏi thông báo lỗi, loại trừ khi xuất, luật của push) → `verify-workspaces` — **chạy bằng người dùng thường**, vì root bỏ qua quyền tệp nên không phân biệt được W106 và W107. Vài đột biến chỉ có nghĩa trên một hệ điều hành — khóa AES của Linux/macOS, kho DPAPI của Windows, chế độ tệp Unix mà NTFS không có — nên mang trường `platforms`; **hãy chạy mỗi danh sách trên cả hai hệ điều hành** để phủ cả hai nhánh. `verify-docs` kiểm tra mọi mẫu trong các danh sách vẫn khớp mã hiện tại (kể cả mẫu của hệ điều hành khác). Kết quả các lần chạy có ngày tháng nằm trong báo cáo Phase 1, không nằm ở đây (để không lỗi thời).

Giới hạn trung thực: đây là một tập đột biến **nhỏ, viết tay** — chứng minh các bộ test đó bắt được những lỗi cụ thể này, không chứng minh chúng bắt được mọi lỗi. Các đợt đột biến thủ công khác trong quá trình phát triển (cho bộ sửa lỗi, Git, phục hồi phiên, kho độc hại) **chưa được lưu thành danh sách**. Để thêm đột biến: viết mẫu `old` (đúng một lần trong file), `new`, và `what`; chạy; nếu `SURVIVED`, hoặc sửa test, hoặc giải thích vì sao tương đương.

## Viết kiểm thử mới

- Tạo thư mục tạm bằng `fs.mkdtemp(path.join(os.tmpdir(), …))`; không bao giờ đọc/ghi thư mục trạng thái thật của Hub.
- Dùng `fileURLToPath(new URL(…, import.meta.url))`, **không** dùng `URL.pathname` (trên Windows cho `/F:/…`).
- Dọn dẹp bằng `await terminal.close()` *trước* `fs.rm(…)`; trên Windows tiến trình con giữ cwd sẽ gây `EBUSY`.
- Symlink file cần Developer Mode/quyền quản trị trên Windows (`EPERM`). Hãy thử symlink, nếu bị từ chối thì dùng junction thư mục và ghi rõ trong đầu ra (`note - … skipped`). Kiểm tra liên kết **file** vì thế chỉ chạy được trên Linux/macOS hoặc Windows có Developer Mode.
- Đừng giả định hành vi của tên file: trên Windows `.env ` (dấu cách cuối) không tồn tại được và bị từ chối bằng `bad_name`; `ENV~1` có thể là bí danh của `.env` (bị chặn bằng `protected_path`); `a:b` là đường dẫn theo ổ đĩa. Test phải chấp nhận *mọi cách từ chối an toàn* chứ không bám vào một mã lỗi của một hệ điều hành.
- Bí mật trong dữ liệu kiểm thử là giá trị giả có tiền tố rõ ràng (`FAKE-…`, `sk-adversarial-…`). Một test "không lộ bí mật" phải quét **tất cả** nơi bí mật có thể rơi vào (thư mục dữ liệu, nhật ký, transcript, yêu cầu mà mô hình giả nhận được) và nói số tệp đã quét, để "không tìm thấy" không phải lời hứa suông.
- Test hồi quy cho lỗi đã sửa phải **fail trên mã cũ**. Cách đã dùng cho các bộ E2E: *đột biến thủ công* — hỏng đúng dòng mã bảo vệ (đổi điều kiện, xóa một lời gọi), chạy bộ test, xác nhận nó **FAIL vì đúng lý do**, rồi hoàn lại. Một bộ test không thể fail là một bộ test không nói gì. Công cụ và các danh sách đột biến có sẵn: xem mục "Kiểm thử đột biến" ở trên.
- Một test không nên phụ thuộc đồng hồ: dùng `eventually(check, {timeoutMs})` thay cho `sleep` cố định.

## Quy ước Git

- Làm việc trên nhánh riêng (`dev/chatmcp-agent`), không push thẳng `main`, không force-push, không viết lại lịch sử khi chưa có sự đồng ý của chủ sở hữu.
- Commit nhỏ, một mục đích, kiểu Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`); thân commit nêu nguyên nhân, bằng chứng và điều *chưa* được kiểm chứng.
- Không commit: `node_modules`, state/transcript/log, bản sao lưu, ZIP, `.env*`, khóa, `deploy/.generated/`. Trước khi push: `git ls-files -ci --exclude-standard` phải rỗng.
- Cuối dòng: `.gitattributes` dùng `text=auto` — file đã commit với CRLF không bị viết lại; `.sh` luôn LF, `.ps1/.cmd/.bat` luôn CRLF khi checkout. Giữ script `.ps1` ở ASCII (Windows PowerShell 5.1 đọc file không BOM theo ANSI). Cảnh báo `LF will be replaced by CRLF` khi `git add` trên Windows là vô hại.
- Chạy `git diff --cached --check` trước khi commit.

## Đặc thù Windows cần nhớ

- Đường dẫn người dùng có thể chứa dấu cách và dạng ngắn 8.3 (`C:\Users\TENDAI~1\…`): so sánh đường dẫn luôn qua `fs.realpath`.
- Dừng cây tiến trình bằng `taskkill /PID <pid> /T /F`; trên POSIX gửi tín hiệu tới process group. Giết Hub bằng `TerminateProcess` không chạy handler nào: bộ `verify-e2e-recovery` mô phỏng đúng điều này.
- `$PSScriptRoot` dùng trong giá trị mặc định của `param()` trả về rỗng khi chạy `powershell -File` trên PS 5.1 — hãy tính trong thân script.
- Hàm PowerShell tên `Git` sẽ che `git.exe` và gây đệ quy vô hạn; đặt tên hàm có tiền tố.
- Pipe được thừa kế bởi tiến trình con: một dịch vụ nền khởi động từ Hub phải đóng stdio kế thừa, nếu không `Start` treo (đã sửa trong launcher).
- Đổi tên file đang bị chương trình diệt virus/trình lập chỉ mục giữ có thể báo `EBUSY/EPERM`: `lib/fs-safe.mjs` thử lại vài lần.
- Tiếng Việt trong đầu ra của bộ test có thể hiện thành `?` hoặc ký tự lạ khi console (hoặc công cụ điều khiển từ xa) dùng trang mã cũ như cp437/cp1252. Đó chỉ là hiển thị: mã thoát và PASS/FAIL không đổi, và tệp do `--json` ghi ra là UTF-8 nguyên vẹn. Dùng Windows Terminal hoặc `chcp 65001` để đọc. Chuyển hướng bằng `>` trong Windows PowerShell 5.1 sẽ ghi tệp UTF-16 và có thể làm méo chữ; dùng `--json` hoặc `cmd /c "node … > tệp.txt"`.

## Cấu trúc thư mục

```
CHATMCP-HUB/       Hub (hub.mjs, lib/, web/, extension/, tests/, windows/, workers/)
  lib/             mã máy chủ (xem ARCHITECTURE.md); *.mjs, không cần build
  ui/              React/TypeScript/Vite: src/, tests/ (regression), e2e/ (Playwright và native smoke)
  web/dist/        build React được Local Hub và desktop phục vụ
  web/             giữ thêm frontend legacy và tài nguyên phục vụ regression cũ
  tests/           verify-*.mjs (Node), verify-*.py (Playwright), e2e/ (khung E2E)
deps/              khóa phiên bản phụ thuộc bên thứ ba
scripts/           Windows packaging, local developer tooling, tests
docs/              kiến trúc, thiết kế, audit, hướng dẫn
CHATMCP-LOCAL-SETUP/, START-*.{cmd,ps1}, install.sh, manifest.json, bridge.js …   legacy
```

## Giới hạn đã biết của quy trình

- Workflow CI (`.github/workflows/ci.yml`) gồm `hub-tests` (Linux + Windows × Node 22 + 24, pinned Python E2E dependencies, `--no-skip all --retry-failed-once`), `frontend-build`, `react-e2e` (Linux + Windows), `windows-installer` (kèm native WebView2 smoke và kiểm tra SHA-256), `windows-upgrade-from-secretless-hub` (nâng cấp thật từ bản v3.9.0 đã phát hành, Hub chưa có secret), `flaky-gate` (chỉ trên `main`) và `hygiene`. Mọi action được ghim theo SHA commit; `verify-docs` kiểm tra điều đó. `docs/ci-proposal.yml` là đề xuất lịch sử, không phải cấu hình CI đang chạy. Chỉ báo CI xanh khi đã đọc kết quả GitHub Actions trên đúng commit; kết quả local không thay thế trạng thái CI hoặc kiểm thử cài đặt trên máy Windows sạch.
- `CHATMCP-HUB/SHA256SUMS.txt` là của bản phát hành cũ, đã lỗi thời; không dùng để xác minh bản này.
- Các script `windows/Run-StudioSmoke.ps1`, `windows/Test-Gateway-ViaHub.ps1`, `windows/Watch-StudioHub.ps1`, `windows/Run-StudioSoak.ps1`, `windows/Test-Gateway-Live.ps1` là công cụ thủ công, không nằm trong `npm test`. `Run-StudioSmoke`, `Watch-StudioHub` và `Run-StudioSoak` so phiên bản của Hub đang chạy (lấy từ `/api/health`) với `version` trong `package.json` cạnh chúng (tham số `-ExpectedVersion` để ghi đè); `Test-Gateway-ViaHub` dùng đúng bản dựng giao diện mà Hub báo. Không script nào ghi cứng số phiên bản, nên không phải sửa mỗi lần phát hành. Mã thoát phản ánh kết quả thật: `Run-StudioSmoke` thoát 1 nếu có kiểm tra fail (kể cả sai phiên bản hay không có Hub), `Run-StudioSoak` thoát 1 nếu có mẫu nào xấu (kể cả khi Hub không trả lời mẫu nào), `Test-Gateway-ViaHub` thoát 1 nếu kết nối thử lỗi, `Watch-StudioHub` thoát 2 khi cổng đang bị một dịch vụ hay phiên bản khác chiếm (và không khởi động lại gì). Cả bốn đã được chạy thật dưới Windows PowerShell 5.1 với một Hub tạm và mô hình giả (xem báo cáo Phase 1). `Test-Gateway-Live.ps1` chỉ nói chuyện với một gateway Cloud Run có tên máy chủ ghi cứng trong script và không dùng cho việc khác — xem mục quyết định của chủ sở hữu trong báo cáo.


## Phase 1 staged coding verification (chưa phát hành)

Các mô-đun `execution-snapshots.mjs`, `windows-sandbox-backend.mjs`, `worker-test-broker.mjs`, `verification-receipt.mjs`, `coding-verification-loop.mjs`, `worker-capabilities.mjs`, `worker-budget.mjs`, `worker-scheduler.mjs` triển khai nền tảng lập trình với quota và test broker. Chúng **không có quyền host-shell dự phòng**, không được xác thực guest output chỉ từ SHA-256/nonce. Đường thực thi tự động vẫn BLOCKED cho tới khi chuyên gia Windows kiểm tra identity, Job Object, snapshot race, ownership và trusted publication trên mã tích hợp cuối. Suite Node mô phỏng logic không chứng minh guest OS isolation. Xem `docs/PHASE1-STAGED-STATUS.md` cho từng gate.

Windows Sandbox CLI driver `lib/windows-sandbox-driver.mjs` hoạt động qua run-owned disposable guest staging và synthetic CLI tests; dữ liệu receipt trả về vẫn UNTRUSTED, không có production publisher đã chứng nhận. Bộ suite `verify-windows-driver.mjs` chỉ kiểm tra giao thức và vòng đời với CLI mô phỏng, KHÔNG chứng minh cách ly Windows thật.

Offline benchmark manifest `CHATMCP-HUB/tests/benchmarks/manifest.json` and runner `run-offline.mjs` cover scripted fixable failure, unchanged failure, zero-exit/no assertions, blocked isolated backend, cancellation, escalation and token budget. Output is JSON evidence for logic tests ONLY, not the dedicated Windows Sandbox hardware gate.

The HMAC-backed reader in `lib/windows-sandbox-publisher.mjs` validates a per-run signed receipt, but production publisher availability remains false without independent Windows token/key non-disclosure and owned-instance evidence. Portable `verify-sandbox-publisher.mjs` runs synthetic fixtures and must not be counted as an OS security test.

`verify-phase1-coding-e2e.mjs` exercises an actual local AgentRunner and managed Git worktree against **scripted** isolated receipts, including approval, failing check, model repair and retest. No OS Sandbox or paid model is exercised by that fixture.

The run-owned `ExecutionSnapshotStore` shares immutable staging between the broker and the Windows backend. Portable tests verify stale UUID refusal and cleanup. OS-level filesystem ACLs remain a Windows acceptance requirement.


## Model-provider usage policy (Phase 1)

The user selects their compatible model API Base URL, API key, and model. ChatMCP does not implement a token allowance, usage reservation, dollar cap, or parallel-worker spending ledger. The provider is responsible for billing, credits and rate limits. Recorded token counts may be shown as diagnostics but never block further model requests solely because a ChatMCP spending threshold was reached. Optional explicit user-set step/time limits are supported, with unlimited defaults for normal coding model turns. Process concurrency, Windows Sandbox instance ownership, test retries, cancellation and execution timeouts remain safety controls, **not token/price quotas**.

ChatMCP is a standalone local desktop app; no IDE/VS Code integration is needed. PermissionGate supports explicit Full Access confirmation; it does not elevate the OS account or cancel Windows Sandbox isolation requirements for untrusted automated tests.

`dynamic-delegates.mjs` executes user-triggered dynamically planned read-only subagents through the same configured Gateway Provider and requires the literal `AUTHORIZE READONLY DELEGATION` confirmation. It has no internal token/spend budget; workers have no execution tools, and cancellation/restart are explicit.

## Cached and reasoning-token usage diagnostics

Agent tasks now preserve provider-reported cache hits, cache writes and
reasoning tokens separately from total input/output. Prompt caching (`cache_control`)
is requested from endpoints known to accept it, a `promptCaching` flag in `lib/provider-presets.mjs`: the `anthropic` preset and any connection or model profile aimed at api.anthropic.com; compatible gateways remain conservative.
OpenAI-compatible Chat Completions and Gemini include cache and reasoning
telemetry when returned by the provider. Missing or zero usage fields are
**unknown or zero as reported**, not verified billing savings. Reports and
conversation UI disclose this telemetry without imposing quotas.

## Reproducible parity metrics (grades are user-provided)

Run `node tests/benchmarks/summarize-parity.mjs results.json` from
`CHATMCP-HUB`. The input must be a JSON object:
```json
{
  "schema": 1,
  "cases": [{
    "id": "bug-001",
    "baseline": {"grade":"pass","httpRequests":5,"inputTokens":1000,"outputTokens":500,"durationMs":60000},
    "candidate": {"grade":"pass","httpRequests":3,"inputTokens":900,"outputTokens":450,"durationMs":60000}
  }]
}
```
Use the same tasks, model class, hardware, test budget and repeats for
both runners. Grades must be supplied by an external test/evaluation
process. The aggregator validates numeric fields, reports the success
ratio and request/token usage per successful task, but does **not**
cryptographically verify grades, run hidden tests, invoke a model,
or certify parity with Codex/Claude. At least 100 tasks are recommended;
reported sample-count adequacy is not proof of statistical validity.
