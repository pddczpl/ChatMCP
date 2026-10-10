# Xử lý sự cố

Tìm triệu chứng của bạn trong mục lục, làm theo cột "Cách xử lý". Với lỗi khi gọi model, Hub hiện thông báo tiếng Việt kèm mã (ví dụ `gateway_auth`) và, nếu sửa được ở cấu hình, một nút **Sửa cấu hình AI**.

- [Khởi động Hub](#khởi-động-hub)
  - [Node.js không tìm thấy hoặc quá cũ](#nodejs-không-tìm-thấy-hoặc-quá-cũ)
  - [PowerShell chặn script (ExecutionPolicy)](#powershell-chặn-script-executionpolicy)
  - [Cổng 3007 đang bận](#cổng-3007-đang-bận)
  - [Một Hub đang giữ cấu hình này](#một-hub-đang-giữ-cấu-hình-này)
  - [Trang không mở, trắng, hoặc báo 403](#trang-không-mở-trắng-hoặc-báo-403)
  - [Giao diện và Hub không cùng phiên bản](#giao-diện-và-hub-không-cùng-phiên-bản)
- [Kết nối model](#kết-nối-model)
  - [Lỗi khóa, hạn mức, model, địa chỉ](#lỗi-khóa-hạn-mức-model-địa-chỉ)
  - [Tool calling không hoạt động](#tool-calling-không-hoạt-động)
  - [Key biến mất sau khi khởi động lại](#key-biến-mất-sau-khi-khởi-động-lại)
  - [Mạng công ty: proxy, chứng chỉ](#mạng-công-ty-proxy-chứng-chỉ)
  - [Ollama hoặc LM Studio cắt ngữ cảnh lặng lẽ](#ollama-hoặc-lm-studio-cắt-ngữ-cảnh-lặng-lẽ)
- [Khi agent làm việc](#khi-agent-làm-việc)
  - [Agent đứng yên](#agent-đứng-yên)
  - [Bị từ chối file `.env`, khóa, `.git`](#bị-từ-chối-file-env-khóa-git)
  - [`checkpoint_failed`](#checkpoint_failed)
  - [`git_config_untrusted`](#git_config_untrusted)
  - [Lệnh shell: Git Bash, PowerShell, treo](#lệnh-shell-git-bash-powershell-treo)
  - [Chưa rõ kết quả, Tạm dừng, Thất bại](#chưa-rõ-kết-quả-tạm-dừng-thất-bại)
  - [Báo "đang chạy" (HTTP 409)](#báo-đang-chạy-http-409)
  - [Không lưu được file (`stale_revision`)](#không-lưu-được-file-stale_revision)
- [Máy và dữ liệu](#máy-và-dữ-liệu)
  - [Xem nhật ký](#xem-nhật-ký)
  - [Không ghi được xuống đĩa](#không-ghi-được-xuống-đĩa)
  - [Chương trình diệt virus giữ file](#chương-trình-diệt-virus-giữ-file)
  - [Đặt lại Hub về trạng thái ban đầu](#đặt-lại-hub-về-trạng-thái-ban-đầu)
  - [Terminal tương tác, ConPTY](#terminal-tương-tác-conpty)
- [Báo lỗi](#báo-lỗi)

---

## Khởi động Hub

### Node.js không tìm thấy hoặc quá cũ

**Triệu chứng:** launcher in `Node.js was not found. Install Node.js 22.12 or newer…` hoặc `Node.js 22.12 or newer is required.`

**Cách xử lý:** cài Node.js bản 22.12 trở lên (<https://nodejs.org> hoặc `winget install OpenJS.NodeJS.LTS`), **mở cửa sổ terminal mới** (PATH chỉ được nạp khi mở mới), kiểm tra `node --version`.

### PowerShell chặn script (ExecutionPolicy)

**Triệu chứng:** chạy `START-CHATMCP-HUB.cmd` báo "running scripts is disabled on this system" (hoặc "cannot be loaded because the file … is not digitally signed"). Launcher dừng và in nhắc nhở về script bị chặn.

**Nguyên nhân:** Windows PowerShell có *chính sách thực thi*. Hai trường hợp hay gặp:

1. Chính sách là `Restricted` (mặc định của nhiều bản Windows mới): không script `.ps1` nào chạy được.
2. Chính sách là `RemoteSigned` nhưng thư mục được tải về dạng ZIP: các file mang dấu "đã tải từ Internet" nên bị coi là script từ xa, chưa ký.

Launcher **không** tự đổi chính sách của bạn.

**Cách xử lý** (chọn một, từ ít can thiệp nhất):

1. **Bỏ chặn một lần** nếu file đến từ ZIP (trường hợp 2). Trong PowerShell, ở thư mục repo:
   ```powershell
   Get-ChildItem -Recurse -File . | Unblock-File
   ```
2. **Không dùng PowerShell**: chạy Hub trực tiếp bằng Node (không cần chính sách nào):
   ```powershell
   node .\CHATMCP-HUB\hub.mjs --backend local --project C:\duong\dan\du-an --port 3007
   ```
   Nhược điểm: cửa sổ này giữ Hub (đóng cửa sổ = dừng Hub) và không tự mở trình duyệt; mở `http://127.0.0.1:3007` bằng tay.
3. **Chỉ cho một lần chạy**, không đổi cấu hình máy:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\CHATMCP-HUB\Start-ChatMcpHub.ps1 -ProjectPath C:\duong\dan\du-an
   ```
4. **Đổi chính sách cho tài khoản của bạn** (quyết định của bạn; ảnh hưởng mọi script PowerShell chạy dưới tài khoản này):
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```
   Kiểm tra bằng `Get-ExecutionPolicy -List`. Nếu `MachinePolicy` hoặc `UserPolicy` có giá trị, công ty bạn đã áp chính sách bằng Group Policy và bạn không đổi được; dùng cách 2.

### Cổng 3007 đang bận

**Triệu chứng:** launcher báo cổng đang được chương trình khác dùng. Hub **không** chiếm cổng của chương trình khác.

**Cách xử lý:** đổi cổng: `START-CHATMCP-HUB.cmd -Port 3017` (cổng từ 1024 đến 65535; tránh 3006, cổng của proxy MCP cũ). Nếu cổng đang giữ bởi chính một Hub cũ của bạn, chạy `STOP-CHATMCP-HUB.cmd` (thêm `-Port` nếu đã đổi cổng).

### Một Hub đang giữ cấu hình này

**Triệu chứng:** `Một Hub đang giữ cấu hình này (PID …, cổng …). Mở lại Hub đó; không chạy hai phiên với cùng cấu hình.`

**Nguyên nhân:** mỗi thư mục dữ liệu chỉ cho một Hub chạy, để hai Hub không cùng ghi một lịch sử. Hub cũ vẫn đang chạy (có thể ở nền).

**Cách xử lý:** mở `http://127.0.0.1:<cổng>` ghi trong thông báo, hoặc `STOP-CHATMCP-HUB.cmd` rồi mở lại. Muốn chạy hai Hub song song cho hai việc khác nhau, cho mỗi Hub một `-StateDir` riêng (nhưng đừng cho chúng cùng một thư mục dự án: Hub không khóa thư mục dự án giữa các Hub).

Nếu thấy `Một launcher đang nhận khóa Hub` hoặc `File khóa Hub chưa hợp lệ` sau khi máy tắt đột ngột lúc đang khởi động: chắc chắn không còn Hub nào chạy (Task Manager → `node.exe`), rồi *đổi tên* (đừng xóa vội) `hub-instance.claim` / `hub-instance.lock` trong thư mục dữ liệu và mở lại.

### Trang không mở, trắng, hoặc báo 403

- Hub chỉ nghe ở `127.0.0.1` và chỉ chấp nhận `Host` là `127.0.0.1:<cổng>` hoặc `localhost:<cổng>`. Mở bằng địa chỉ IP của máy, tên máy hay từ máy khác → **403**. Đây là chủ ý (xem [DEPLOYMENT.md](DEPLOYMENT.md)).
- Kiểm tra Hub còn sống: mở `http://127.0.0.1:3007/api/health`. Có JSON (phiên bản, `uiBuild`) là Hub chạy. Không có: chạy lại launcher, xem `hub.log` ([Xem nhật ký](#xem-nhật-ký)).
- Thông báo "Mất kết nối với Hub… đang thử kết nối lại" nghĩa là trang vẫn mở nhưng Hub đã dừng. Lịch sử vẫn nằm trên đĩa; chạy lại Hub.
- Các tiện ích trình duyệt chặn script hoặc chính sách công ty chặn `localhost` có thể làm trang trắng; thử cửa sổ ẩn danh.
- Giao diện được kiểm thử tự động bằng Chromium (nền của Edge/Chrome); các trình duyệt khác chưa được kiểm thử.

### Giao diện và Hub không cùng phiên bản

**Triệu chứng:** banner "Giao diện và tiến trình Hub không cùng phiên bản", hoặc lỗi "Không tìm thấy thao tác".

**Nguyên nhân:** bạn cập nhật mã nguồn nhưng một Hub *cũ* vẫn đang chạy ở nền, hoặc trình duyệt giữ bản giao diện cũ trong cache.

**Cách xử lý:** `STOP-CHATMCP-HUB.cmd` → `START-CHATMCP-HUB.cmd` → `Ctrl+F5` trong trình duyệt. Đừng giao việc trong lúc banner còn hiện.

---

## Kết nối model

### Lỗi khóa, hạn mức, model, địa chỉ

| Thông báo / mã | Nghĩa là | Cách xử lý |
|---|---|---|
| `gateway_auth` — "Model từ chối khóa API (HTTP 401/403)" | Key sai, hết hạn, thiếu quyền, hoặc gửi sai kiểu header | Dán lại key; kiểm tra key thuộc đúng nhà cung cấp và có quyền với model; ở **Nâng cao → Kiểu xác thực** thử `bearer` (gateway tự dựng thường cần `bearer`) hoặc `google-key` (Gemini) |
| `gateway_quota` — "hết hạn mức hoặc chưa có thanh toán" (HTTP 402, hoặc 400/429 nói về quota) | Tài khoản API chưa nạp tiền / hết credit | Mở trang Billing/Usage của nhà cung cấp. Lưu ý: gói chat (ví dụ ChatGPT Plus, Claude Pro) **không** phải API |
| `gateway_rate_limit` — HTTP 429 | Gửi quá nhanh | Hub tự thử lại có giãn cách (tôn trọng `Retry-After`). Nếu vẫn lỗi: chờ, hoặc đổi model/gói |
| `gateway_overloaded` — HTTP 503/529 | Nhà cung cấp quá tải | Hub tự thử lại; chờ vài phút |
| `gateway_model_not_found` — "Model đã chọn không khả dụng với tài khoản này" | Sai tên model, hoặc tài khoản chưa được cấp | Bấm **Tải danh sách model** (cần đã lưu cấu hình) và chọn từ danh sách |
| "Không tìm thấy đường dẫn API (HTTP 404)" | Sai **Base URL** hoặc **Giao thức** | Dùng đúng giá trị của preset: nhiều dịch vụ OpenAI-compatible có đuôi `/v1` (không phải tất cả), Anthropic và Gemini dùng địa chỉ gốc của hãng; gateway riêng thì xem **Nâng cao → Đường dẫn endpoint** |
| `gateway_context_length` — "vượt giới hạn ngữ cảnh của model" | Phiên quá dài cho model này | Bắt đầu **Hội thoại mới**; điền **Ngữ cảnh model** để Hub cắt bớt lịch sử trước khi vượt; chọn model có cửa sổ lớn hơn. Với máy chủ cục bộ xem [mục Ollama](#ollama-hoặc-lm-studio-cắt-ngữ-cảnh-lặng-lẽ) |
| `gateway_network` — "Không kết nối được tới nhà cung cấp model sau nhiều lần thử" | Mất mạng, sai URL, DNS, tường lửa, proxy | Kiểm tra bằng trình duyệt cùng máy; xem [Mạng công ty](#mạng-công-ty-proxy-chứng-chỉ) |
| "Phản hồi lỗi không phải JSON (trang lỗi của proxy hoặc gateway)" | Có thiết bị trung gian trả HTML | Như trên: proxy/captive portal/gateway |
| `gateway_too_large` — "Phản hồi model vượt giới hạn 12 MiB" | Máy chủ trả dữ liệu bất thường | Kiểm tra gateway; Hub không tự lặp lại |
| `missing_key` — "Nhập API key trước khi lưu." | Chọn "Ghi nhớ" nhưng ô key trống | Dán key |
| `provider_not_ready` / `gateway_not_ready` | Chưa đủ URL + model + key | Hoàn tất form rồi **Lưu & kiểm tra** |

Trước khi nghi ngờ Hub, thử đúng key/URL/model bằng công cụ của chính nhà cung cấp (curl, trang playground).

### Tool calling không hoạt động

**Triệu chứng:** nhãn "Model không hỗ trợ tool calling" / "chưa đáng tin"; hoặc agent chỉ "nói" mà không làm gì, gõ ra JSON thay vì gọi công cụ.

**Nguyên nhân:** agent cần model hỗ trợ *gọi công cụ gốc* (function calling). Nhiều model nhỏ hoặc cấu hình gateway không hỗ trợ.

**Cách xử lý:** chọn model có hỗ trợ tool calling (xem tài liệu của nhà cung cấp); với Ollama/LM Studio chọn model được ghi là hỗ trợ "tools"; bấm **Lưu & kiểm tra** lại sau khi đổi. Kết quả "Chưa xác định được" thường là lỗi tạm (mạng, hạn mức), không phải kết luận về model. Hub **không** thử lại hay "đoán" lệnh từ văn bản của model khi tool calling hỏng, vì như vậy không an toàn.

### Key biến mất sau khi khởi động lại

Ba nguyên nhân thường gặp:

1. Bạn không bật **Ghi nhớ key trên máy này**: key chỉ nằm trong bộ nhớ Hub và mất khi Hub dừng (thông báo "Key chỉ giữ trong bộ nhớ của Hub"). Bật tùy chọn, hoặc dùng biến môi trường.
2. Bạn **đổi Base URL** (hoặc đổi nhà cung cấp) mà không nhập lại key: Hub xóa key đã lưu để không gửi nhầm key của nhà này sang địa chỉ khác. Nhập lại key.
3. Dùng biến môi trường (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`…): biến phải được đặt **trước khi** khởi động Hub, trong cùng phiên đăng nhập; mở lại terminal rồi chạy lại launcher. Tùy chọn "Dùng key từ biến môi trường" chỉ hiện với nhà cung cấp có biến tương ứng.

Nếu Windows báo không giải mã được key (ví dụ bạn chép thư mục dữ liệu sang tài khoản/máy khác): DPAPI gắn key với tài khoản Windows và máy; nhập lại key.

### Mạng công ty: proxy, chứng chỉ

- Hub gọi API trực tiếp bằng `fetch` của Node và **không có thiết lập proxy riêng**. Dự án **chưa được kiểm thử sau proxy công ty**.
- Gợi ý chưa được kiểm chứng ở đây: bản Node mới hỗ trợ proxy từ biến môi trường khi đặt `NODE_USE_ENV_PROXY=1` cùng `HTTPS_PROXY` (xem tài liệu Node của bạn) trước khi khởi động Hub. Nếu mạng chèn chứng chỉ của công ty (TLS inspection), trỏ `NODE_EXTRA_CA_CERTS` tới file CA công ty. Nếu thử mà vẫn lỗi, hãy dùng nhà cung cấp cục bộ (Ollama/LM Studio) hoặc mạng khác và báo lại.
- Tuyệt đối đừng tắt kiểm tra chứng chỉ TLS để "cho chạy".

### Ollama hoặc LM Studio cắt ngữ cảnh lặng lẽ

**Triệu chứng:** agent chạy tốt vài bước rồi "quên" yêu cầu ban đầu, lặp lại việc đã làm, trả lời lạc đề, hoặc bỏ qua các quy tắc; không có lỗi nào hiện ra.

**Nguyên nhân:** máy chủ model cục bộ có thể dùng cửa sổ ngữ cảnh **nhỏ theo mặc định** (tùy phiên bản, chỉ vài nghìn token) và *cắt bớt phần đầu hội thoại mà không báo lỗi*. Mỗi lần gọi công cụ cộng thêm nội dung vào hội thoại nên rất nhanh vượt giới hạn. Hub không thể nhìn thấy sự cắt này.

**Cách xử lý:**

1. Tăng ngữ cảnh ở chính máy chủ model:
   - **Ollama**: đặt biến môi trường `OLLAMA_CONTEXT_LENGTH` (ví dụ `32768`) rồi khởi động lại Ollama; hoặc đặt `num_ctx` trong Modelfile của model.
   - **LM Studio**: khi nạp model, tăng **Context Length**.
   Tên và mặc định của các tùy chọn này có thể khác theo phiên bản; hãy xem tài liệu của chúng.
2. Điền cùng giá trị vào **Nâng cao → Ngữ cảnh model (token)** trong Hub (ví dụ `32768`). Khi biết cửa sổ, Hub chủ động rút gọn **có kiểm soát** trước khi bản gửi đi vượt khoảng 85% cửa sổ: các kết quả công cụ cũ được thay bằng bản tóm tắt ngắn (yêu cầu của bạn và các lượt gần nhất được giữ nguyên) và Timeline ghi một sự kiện "Đã rút gọn ngữ cảnh gửi tới model", thay vì để máy chủ cắt ngẫu nhiên. Nếu máy chủ trả lỗi vượt ngữ cảnh, Hub cũng rút gọn rồi thử lại một vài lần.
3. Chọn model cục bộ đủ lớn cho việc lập trình và có tool calling; model nhỏ (vài tỷ tham số) thường không làm việc đáng tin với agent.
4. Giao việc nhỏ hơn và dùng **Hội thoại mới** thường xuyên.

---

## Khi agent làm việc

### Agent đứng yên

- Thẻ trạng thái **Chờ bạn duyệt**? Khung duyệt ở **ngay trên ô nhập yêu cầu**; tiêu đề tab trình duyệt có dạng `(1) Cần duyệt`. Yêu cầu tự bị từ chối sau 10 phút.
- Trạng thái "Đang thực hiện" lâu: có thể lệnh đang chạy (xem **Hoạt động → Timeline**) hoặc model đang trả lời chậm. Mỗi lệnh có thời gian tối đa (mặc định 120 giây, tối đa 900); mỗi lần gọi model chờ tối đa 4 phút rồi thử lại. **Dừng tác vụ** luôn dùng được.
- Nhà cung cấp trả 429/503 liên tục: Hub chờ rồi thử lại có giãn cách (tối đa vài lần) nên bạn có thể thấy tác vụ đứng yên một lúc; **Timeline** ghi các lần chờ. Xem bảng lỗi ở trên.

### Bị từ chối file `.env`, khóa, `.git`

Chủ ý, để một prompt độc hại không đọc hay gửi đi bí mật của bạn:

- **Công cụ file** (đọc, ghi, sửa, xóa, đổi tên) từ chối các đường dẫn này **thẳng, không hỏi**, ở mọi chế độ; tìm kiếm và liệt kê thì không hiển thị nội dung của chúng. Muốn đổi `.env`, hãy tự sửa. Tên "lạ" cũng bị chặn nếu thực chất trỏ tới chúng (tên có dấu cách cuối, tên rút gọn 8.3 như `ENV~1`, symlink/junction).
- **Lệnh shell** có tham chiếu tới các đường dẫn này (hoặc tới ngoài dự án) không tự chạy: khung duyệt hiện lý do "thực chất là file bí mật". Ở chế độ Chỉ đọc nó bị từ chối; ở Review/Tự động, bạn quyết định, và nếu bạn cho phép thì nội dung sẽ đi vào hội thoại và tới nhà cung cấp model.
- Với bí mật của dự án, đưa cho agent file mẫu (`.env.example`) thay vì file thật.

### `checkpoint_failed`

**Triệu chứng:** thao tác bị từ chối với "Could not create pre-operation checkpoint … The operation was NOT executed."

**Ý nghĩa:** trước mỗi lần sửa file hoặc chạy lệnh có thể sửa file, Hub lưu bản sao các file sắp thay đổi. Nếu không lưu được, Hub **không** chạy thao tác — đây là bảo vệ, không phải lỗi cần bỏ qua.

**Cách xử lý:** giải phóng ổ đĩa và kiểm tra quyền ghi vào thư mục dữ liệu; nếu thư mục dự án có nhiều file hoặc file rất lớn (ảnh chụp trước lệnh shell bị giới hạn khoảng 140 file / 8 MiB), tách việc nhỏ hơn hoặc yêu cầu agent sửa file bằng công cụ file (chỉ sao lưu đúng file bị đổi); xem `hub.log`.

### `git_config_untrusted`

**Triệu chứng:** "Cấu hình Git của kho này (.git/config) có mục chạy chương trình: … Hub không chạy Git khi chưa kiểm tra để tránh thực thi mã của kho."

**Ý nghĩa:** một kho được tải về hoặc sao chép mang cấu hình Git của người khác. Một số mục (`core.fsmonitor`, `core.hooksPath`, bộ lọc `filter.*`, `diff.*.textconv`, `credential.helper`, `core.sshCommand`, `include.path`, chương trình `gpg`…) làm cho `git status` hay `git diff` **chạy chương trình** do kho chỉ định. Hub nêu *tên* các mục (không in giá trị vì có thể chứa mật khẩu).

**Cách xử lý:** mở `.git/config` của kho, xem các mục được nêu; nếu bạn tin kho, xóa hoặc sửa chúng; nếu không tin, đừng cho agent chạy Git trên kho đó. Các thiết lập Git *toàn cục* của chính bạn không bị coi là rủi ro. Git LFS đúng chuẩn được nhận biết và không bị chặn.

### Lệnh shell: Git Bash, PowerShell, treo

- Trên Windows agent dùng **Git Bash** nếu tìm thấy (cài Git for Windows, hoặc trỏ `CHATMCP_BASH` tới `bash.exe`). `C:\Windows\System32\bash.exe` (WSL) không được dùng. Không có Git Bash thì dùng Windows PowerShell 5.1, nơi `&&`, `||` không hợp lệ và cú pháp khác bash; model thường tự điều chỉnh nhưng sẽ chậm hơn. Cài Git for Windows để tránh vấn đề này.
- Lệnh bị treo vì chờ nhập (đăng nhập, xác nhận y/n, `git commit` mở trình soạn thảo): stdin của lệnh bị đóng và `GIT_TERMINAL_PROMPT=0`; lệnh sẽ thất bại thay vì chờ. Bảo agent dùng tùy chọn không tương tác (`-y`, `-m "…"`).
- Lệnh vượt giờ bị kết thúc cùng cả cây tiến trình con.
- Lệnh cần biến môi trường chứa khóa/mật khẩu (ví dụ `AWS_SECRET_ACCESS_KEY`) sẽ không thấy chúng: Hub xóa biến có tên giống khóa/token/mật khẩu (và URL có mật khẩu) khỏi môi trường của lệnh. Nếu một lệnh *cần* biến như vậy, hãy tự chạy nó trong Terminal của bạn thay vì nhờ agent.
- Tiếng Việt/Unicode trong đầu ra: Hub đặt `PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8` cho lệnh của agent. Ở Terminal tab (terminal của bạn) trang mã của Windows có thể làm méo ký tự; dùng Windows Terminal hoặc `chcp 65001`.

### Chưa rõ kết quả, Tạm dừng, Thất bại

Xem [USER-GUIDE.md, mục 8](USER-GUIDE.md#8-khi-tác-vụ-dừng-giữa-chừng). Tóm tắt: "Chưa rõ kết quả" → xem Git diff rồi **Tiếp tục: kiểm tra trước**; Hub không bao giờ tự chạy lại thao tác đó.

### Báo "đang chạy" (HTTP 409)

- "Một nhiệm vụ hoặc thao tác dịch vụ đang chạy." / "Đã có một tác vụ đang chạy. Hãy chờ hoặc dừng tác vụ đó." — mỗi lúc một Hub chỉ chạy **một** tác vụ. Chờ xong hoặc bấm **Dừng tác vụ**. Không đổi thư mục dự án hay khởi động/dừng công cụ khi đang chạy.
- "Phiên này vẫn đang chạy." — phiên đó chưa kết thúc; dừng rồi gửi lại.
- "Workspace hoặc phiên MCP đã thay đổi" (`workspace_changed`) — bạn đã đổi thư mục dự án giữa chừng. Chọn lại đúng thư mục của phiên rồi tiếp tục, hoặc mở hội thoại mới.

### Không lưu được file (`stale_revision`)

**Triệu chứng:** sửa trong tab **Files** rồi lưu → "File đã thay đổi; tải lại trước khi lưu."

**Ý nghĩa:** file trên đĩa khác với bản bạn đã mở (agent, editor khác hoặc lệnh đã sửa nó). Hub từ chối ghi đè để không mất thay đổi kia. Mở lại file, áp dụng chỉnh sửa của bạn lên bản mới. Tương tự, **Accept/Restore** trong Snapshot review báo "File đã đổi hoặc không nằm trong bản review; hãy tải lại diff" khi file đã đổi kể từ lúc bạn bấm Review.

---

## Máy và dữ liệu

### Xem nhật ký

- Khi chạy bằng launcher, Hub ghi vào **`hub.log`** trong thư mục dữ liệu (mặc định `%LOCALAPPDATA%\ChatMCP\hub\hub.log`). Mở bằng Notepad.
- Trong giao diện: tab **Hoạt động** → *Hub Logs* (24 dòng cuối) và *Timeline*.
- Chạy `node CHATMCP-HUB\hub.mjs …` thì nhật ký hiện ngay trong cửa sổ; thêm `--log-file <tệp>` để ghi ra tệp.
- Nhật ký đã che các dạng bí mật quen thuộc nhưng **đọc lại trước khi gửi cho ai**.

### Không ghi được xuống đĩa

**Triệu chứng:** tác vụ chuyển "Chưa rõ kết quả" với lý do "Không ghi được trạng thái xuống đĩa" (`persistence_failed`), hoặc thông báo lưu cấu hình thất bại.

**Cách xử lý:** ổ chứa `%LOCALAPPDATA%` đầy hoặc chỉ đọc, thư mục bị OneDrive/ứng dụng khác khóa, hoặc thiếu quyền. Giải phóng dung lượng; không đặt `-StateDir` trên ổ mạng hay thư mục đồng bộ đám mây đang khóa file. Sau đó xem Git diff để biết tác vụ đã làm được gì (Hub không biết chắc).

### Chương trình diệt virus giữ file

Trình quét có thể giữ file vừa ghi trong giây lát khiến việc đổi tên báo `EBUSY`/`EPERM`. Hub thử lại vài lần. Nếu vẫn lỗi lặp lại, thêm thư mục dữ liệu của Hub (và thư mục dự án nếu bạn thấy phù hợp) vào danh sách loại trừ quét thời gian thực — quyết định này là của bạn.

### Đặt lại Hub về trạng thái ban đầu

1. `STOP-CHATMCP-HUB.cmd`.
2. **Đổi tên** (đừng xóa vội) thư mục dữ liệu, ví dụ `hub` → `hub.bak`, trong `%LOCALAPPDATA%\ChatMCP\`.
3. Chạy lại launcher: trình hướng dẫn lần đầu xuất hiện lại và bạn nhập lại key.

Lịch sử cũ nằm trong `hub.bak` (đọc được bằng trình soạn thảo). Chỉ xóa thư mục sao lưu khi chắc không cần. **Không** sao chép thư mục dữ liệu giữa các tài khoản/máy: key đã mã hóa không giải mã được ở nơi khác.

### Terminal tương tác, ConPTY

Thông báo "ConPTY chưa được cài" / `Mode: pipes` là bình thường: terminal tương tác dùng pipe (không có đầy đủ TTY). Agent không cần terminal tương tác. Muốn đủ tính năng, chạy `CHATMCP-HUB\windows\Install-OptionalConPTY.ps1 -Install` (xem [WINDOWS-SETUP.md](WINDOWS-SETUP.md)); nếu `node-pty` cài được nhưng không chạy, Hub nói rõ lý do và tiếp tục dùng pipe.

---

## Báo lỗi

Khi báo lỗi, hãy gửi: phiên bản Hub (Cài đặt → "Phiên bản hệ thống"), `node --version`, `git --version`, bản Windows, loại nhà cung cấp/model (không gửi key), các bước tái hiện, và đoạn `hub.log` liên quan sau khi đã đọc lại để xóa thông tin riêng tư.

**Đừng** gửi nguyên thư mục dữ liệu hay "Báo cáo ↗" của một phiên chưa đọc: chúng chứa nội dung dự án và có thể chứa bí mật mà bộ che theo mẫu không nhận ra. Nếu nghi ngờ đã lộ key, thu hồi key ở trang của nhà cung cấp và tạo key mới.

Lỗi bảo mật: xem [SECURITY.md](../SECURITY.md).
