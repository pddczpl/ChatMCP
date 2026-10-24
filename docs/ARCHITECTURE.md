# Kiến trúc DatGold

Đây là kiến trúc **local-only một người dùng**, áp dụng cho nhánh refactor hiện tại. Tài liệu Phase 0–4 ghi lại quá trình phát triển, một số hướng dẫn cloud trong đó đã lỗi thời.

## 1. Sơ đồ

~~~mermaid
flowchart LR
  U[WinForms WebView2 or Browser UI] --> H[Hub localhost only]
  H --> A[AgentRunner and DualAgent]
  A --> P[Provider Gateway and Local Models]
  A --> G[PermissionGate and Checkpoints]
  G --> T[LocalTools GitRunner ShellRunner]
  H --> W[Parallel Coding Worktrees]
  H --> S[GitHub Agent Skills Hub]
  H --> D[Private User State]
  B[Optional Browser Companion] --> H
~~~

The Windows desktop starts the local Node Hub. It does not deploy a shared/public service.

## 2. Hai backend

Trong các phiên bản trước có hai backend local và MCP legacy. **Hiện chỉ còn local.** Toàn bộ đường Cloud Harness/Desktop Commander MCP proxy, Docker/Render hosting, public-mode login và remote workspace manager đã bị gỡ. Startup từ chối tùy chọn public, --repo-root và --backend mcp.

Outbound HTTPS đến nhà cung cấp AI, GitHub, Skills và nghiên cứu web **vẫn được hỗ trợ**; thêm một yêu cầu tới `https://models.dev/api.json` để cập nhật danh mục model, chỉ khi chủ máy bấm nút cập nhật (mục 9). Local-only không có nghĩa offline-only.

## 3. Vòng lặp agent

AgentRunner gửi nội dung nhiệm vụ cho GatewayProvider, nhận lời gọi công cụ, chạy qua HubManager tool session, lưu bằng chứng và quay lại model đến khi kết thúc. Các provider hỗ trợ giao thức OpenAI-compatible, Anthropic và Gemini; Ollama/LM Studio ở localhost nếu model hỗ trợ tool-calling. Mô hình không được tự cấp thêm quyền chỉ bằng câu chữ trong prompt.

## 4. Đường đi của một lời gọi công cụ

1. Kiểm tra task, thế hệ workspace và JSON schema của tool.
2. PermissionGate phân loại lệnh và yêu cầu người dùng duyệt khi cần.
3. Ghi pending decision trước hành động có tác dụng.
4. Tạo checkpoint hoặc từ chối khi không thể bảo vệ dữ liệu.
5. Chạy LocalTools/StudioTools trong workspace với path và command guards.
6. Ghi kết quả thực tế, kể cả test pass/fail và tác vụ chưa rõ kết quả.

## 5. Máy trạng thái nhiệm vụ

Trạng thái tác vụ được xác thực bởi TRANSITIONS trong lib/task-state.mjs. Không tự replay tác vụ ghi không chắc chắn sau lỗi.

```mermaid
stateDiagram-v2
  [*] --> created
  created --> queued
  queued --> planning
  planning --> running
  running --> waiting_approval
  waiting_approval --> running
  running --> verifying
  verifying --> running
  running --> completed
  running --> failed
  running --> cancelled
  running --> paused
  running --> uncertain
  completed --> queued: gửi tin nhắn tiếp
  paused --> queued
  uncertain --> queued
```

## 6. Phân quyền

PermissionGate trong lib/permissions.mjs là chính sách cục bộ và vẫn hoạt động. Các vai trò quản trị tenant/RBAC doanh nghiệp của public Hub đã bị loại bỏ. Có Review, Read-only, Autonomous và Full Access có xác nhận riêng.

## 7. Công cụ cục bộ

`local-tools.mjs` — 99 công cụ; StudioTools bổ sung kiểm tra, checkpoint, code intelligence và Git review. Các tool không thuộc danh sách cho phép không được thực thi.

## 8. Chạy lệnh và các lớp bảo vệ quanh nó

ShellRunner lọc biến môi trường, áp timeout, kiểm tra lệnh và đường dẫn. Tuy vậy lệnh được duyệt chạy với quyền tài khoản hệ điều hành hiện tại. SandboxEngine hiện chỉ là chế độ host (osIsolated:false) và **không phải** VM/AppContainer. Optional Docker sandbox chỉ dành cho bài test cục bộ, không phải cloud hosting.

## 9. Nhà cung cấp mô hình và khóa API

Khóa lưu dưới state directory per-user, được che khi ghi log. Endpoint của provider phải được cấu hình và origin thay đổi không được tự ý nhận khóa cũ. Dữ liệu gửi ra remote provider tuân theo lựa chọn của người dùng; Ollama/LM Studio có thể chạy hoàn toàn cục bộ.

**Danh mục model và mức suy luận.** `lib/model-catalog.mjs` trả lời "model này có giới hạn, giá và cách điều khiển suy luận thế nào" từ một bản chụp có ngày của https://models.dev/api.json (`lib/model-catalog.data.json`, giấy phép MIT, định dạng 2 có bậc giá theo cỡ lời nhắc và trạng thái model, dựng bằng `scripts/update-model-catalog.mjs` từ `lib/model-catalog-build.mjs`; Hub không tải gì, trừ khi chủ máy bấm **Cập nhật từ models.dev**: xem đoạn dưới). Mỗi câu trả lời ghi nguồn (`catalog@NGÀY`) và độ chắc chắn (`exact`, `normalized`, `alias`, `none`): một id không có trong danh mục (bí danh của người dùng, thẻ Ollama) trả về `none`, không bao giờ đoán sang model khác. `lib/reasoning-effort.mjs` đặt cài đặt "mức suy luận" (`auto` hoặc một mức) lên từng giao thức: `reasoning_effort` (Chat Completions), `reasoning: {effort}` (OpenRouter và Responses), `output_config: {effort}` (Anthropic Messages; với mức cao thì `max_tokens` được nâng lên mặc định để còn chỗ viết câu trả lời); Gemini chưa có. Nhà cung cấp từ chối thiết lập (400 nêu tên trường) thì adapter gửi lại đúng yêu cầu model đó một lần không kèm nó, và `GatewayProvider` nhớ theo endpoint + model + mức. `GET /api/ai/model-info` đưa cùng câu trả lời cho trang cài đặt. Mức nằm trong `gateway-config.json` và trong từng hồ sơ model.

**Danh mục cấp ngân sách, chi phí và cập nhật.** `lib/model-facts.mjs` biến câu trả lời *chắc chắn* của danh mục (`exact` hoặc `normalized`, không bao giờ `alias`) thành các dữ kiện mà bộ lập kế hoạch dùng: cửa sổ, giới hạn đầu vào (`maxInput`), giới hạn đầu ra (`outputCap`, chỉ khi từ 1.024 trở lên), giá kể cả các bậc, và **năng lực** (`capacity` bằng cửa sổ, hoặc, khi model nhận vào ít hơn cửa sổ, là số lớn nhất mà lời nhắc được lập kế hoạch vẫn không dài hơn `maxInput`: tối đa `maxInput` cộng phần đầu ra dành cho agent, tính bằng đúng hai công thức dự phòng của ngân sách một lượt chạy trong `lib/context-reserve.mjs`). `GatewayProvider` dùng chúng: `state().contextWindowTokens` vẫn là số chủ máy nhập, `effectiveContextWindowTokens` là số Hub thật sự lập kế hoạch (chủ máy, rồi danh mục, rồi không có) và `contextWindowSource` là `configured`, `catalog` hoặc `fallback`; `resolveEffectiveContextBudget` ghi nguồn (`provider_configuration`, `trusted_model_metadata` hoặc `conservative_fallback`), việc chọn công cụ (`followProviderWindow`) và việc cắt lịch sử của adapter theo đúng cửa sổ đó; các preset Anthropic, Gemini, Groq và Mistral không còn mang cửa sổ cố định (danh mục trả lời cho từng model), DeepSeek vẫn giữ 128.000 vì danh mục không có `deepseek-chat`. Giá được đóng băng vào `context.pricing` khi một lượt chạy bắt đầu, và `lib/model-cost.mjs` tính chi phí: giá chủ máy nhập luôn thắng; không có thì, với model danh mục chắc chắn, ước tính từ giá danh mục (bậc cao nhất có `aboveTokens` nhỏ hơn số token của lời nhắc, áp cho cả yêu cầu), đánh dấu `approximate` và `estimateSource` trong sổ chi phí (lược đồ vẫn là 1, chỉ thêm trường) và giao diện ghi **(ước tính)**; thiếu tách cache thì mọi token vào tính theo giá vào, thiếu giá cache thì dùng giá vào, giá suy luận và âm thanh của danh mục chưa dùng. Token suy luận của Gemini (`thoughtsTokenCount`) được cộng vào đầu ra. `lib/model-catalog-store.mjs` giữ bản danh mục chủ máy đã cập nhật (`<thư mục dữ liệu>/model-catalog.json`): đúng một yêu cầu tới `https://models.dev/api.json` và chỉ khi `POST /api/ai/catalog/refresh` được gọi (không key, không cookie, không nội dung, không theo chuyển hướng, 30 giây, 12 MB); kết quả được kiểm (`validateRaw`, `checkSnapshot`) trước khi thay bản đang dùng và được ghi nguyên tử; hai lần cập nhật cùng lúc dùng chung một yêu cầu; tệp trong thư mục dữ liệu cũng không được tin (hỏng, cũ hơn bản đi kèm hoặc đề ngày tương lai thì bị bỏ qua và `GET /api/ai/catalog` nói lý do). Các route khác: `GET /api/ai/catalog` (nguồn, tuổi, số model) và `GET /api/ai/catalog/models` (danh sách model của một nhà cung cấp cho bộ chọn; chỉ đọc bản danh mục đang dùng, tối đa 1.000 model).

## 10. Độ bền và phục hồi

Transcript, task history và evidence được lưu trên ổ đĩa per-user. Checkpoint restore kiểm tra SHA và xung đột. Worktree coding worker giữ thay đổi trên branch riêng, cần review commit/diff trước khi tích hợp.

## 11. Dữ liệu trên đĩa

Mặc định Windows: %LOCALAPPDATA%\ChatMCP\hub; có thể đổi bằng --state-dir. Đây là dữ liệu riêng tư gồm lịch sử, key store, logs, checkpoints, skills registry, coding-agent state và, chỉ khi chủ máy đã bấm cập nhật, `model-catalog.json` (danh mục model đã tải; mục 9). Không lưu vào repository.

## 12. HTTP API (nội bộ của dashboard)

Chỉ lắng nghe 127.0.0.1; kiểm tra Host và Origin, giới hạn CORS, CSRF cho mọi POST từ giao diện. Browser companion có một số đường pairing được kiểm soát riêng. Các API workspace hosted/tenant governance cũ trả 404 hoặc không tồn tại.

## 13. Giao diện

`ui/src/lib/api.ts` adapts `agent.tasks` summaries into the session list and loads the selected full task separately. `task-view.ts` maps recorded dialogue/prompts/runs/events into the conversation view and canonical states into controls. Permission reviews come from `studio.permissions`, never inferred task fields. Plans, Git and terminal sessions use existing Studio routes. `useTaskStream` subscribes to the real task event endpoint; it scopes transient text by task ID and refetches durable state on reconnect because SSE does not provide event replay. Polling remains a recovery fallback. This does not add provider-level token streaming.

React/TypeScript/Vite trong CHATMCP-HUB/ui được biên dịch vào CHATMCP-HUB/web/dist và nhúng trong desktop WinForms + WebView2. Các tab gồm Files, Git, Agents, Skills, Terminal, Plans, Preview và Settings. Luôn build lại UI trước khi đóng gói installer.

## 14. Ranh giới tin cậy

| Bên liên quan | Biện pháp | Giới hạn |
| --- | --- | --- |
| Desktop -> Hub | Loopback, Host, Origin, CSRF, CSP | Máy đang dùng vẫn phải tin cậy |
| Model -> tools | PermissionGate, checkpoint, đường dẫn | Shell host vẫn nguy hiểm |
| Coding workers | Git worktree riêng, limited tools, review diff | Không phải OS sandbox |
| GitHub Skills | Pin SHA, hash blob, giới hạn size, opt-in | Third-party content không đáng tin |
| AI provider | API key được bảo vệ theo origin | Remote model nhận dữ liệu nếu được chọn |

## 15. Chiến lược phụ thuộc

Node.js >=22.12 khi chạy từ source, Git for Windows để sử dụng Git/worktree, WebView2 Runtime cho desktop. Installer mang theo Node portable; .NET SDK 10 chỉ dùng lúc build. Optional ConPTY, Playwright, Python test runner và Docker test sandbox tách biệt khỏi runtime server.

Các nguồn Cloud Harness proxy và Render/Docker public-hosting không còn là phụ thuộc sản phẩm.

## 16. Độ lệch so với thiết kế và hạng mục chưa làm

Không hỗ trợ public SaaS, public multi-tenant hoặc Cloud Harness backend. MCP client tích hợp một cách chính thức cho local server khác, Windows Sandbox cấp hệ điều hành, benchmark model thật, cập nhật tự động và clean-VM installer E2E là các hướng tương lai. Các tài liệu thiết kế Phase 1–4 là lịch sử, không phải mô tả hiện tại.

## 17. Parallel Coding Workers và Skills Registry nâng cao (nhánh phát triển)

CodingWorktreeOrchestrator chạy tối đa bốn worker trên Git worktrees riêng, giới hạn tool sửa file. Người dùng xem diff và xác nhận trước khi merge vào nhánh integration mới; Draft PR cũng cần xác nhận, không tự merge main. Worktree chỉ cách ly working copy và Git index.

Skills Hub duyệt SKILL.md lồng sâu theo Git tree được pin, kiểm tra blob SHA của tài nguyên text/binary, quản lý nguồn/update và ghi thông tin license evidence. Mặc định skills bên thứ ba tắt; không tự chạy script.

## 16. Multi-Agent Orchestrator và GitHub Skills Hub (giai đoạn đầu)

StudioDelegates là read-only DAG phục vụ research/planning/review, không có tools thực thi. Chức năng này độc lập với các coding workers có worktree riêng.

Tham khảo [Development](DEVELOPMENT.md), [Windows Setup](WINDOWS-SETUP.md), [User Guide](USER-GUIDE.md) và [Security](../SECURITY.md).
