# ChatMCP Studio 2.2.0 — Local coding agent (React sáng/tối, code/LSP, sandboxed tests)

**Hướng dẫn mới:** [`STUDIO-2.2.0.md`](STUDIO-2.2.0.md) · [`UPGRADE-2.2.0.md`](UPGRADE-2.2.0.md) · [`TEST-RESULTS-2.2.0.txt`](TEST-RESULTS-2.2.0.txt). Giữ Companion **1.4.0**. UI dùng React offline và có theme sáng/tối. Hỗ trợ Docker restricted container **chỉ cho các lệnh được sandbox**, terminal session (ConPTY tùy cài thêm), Python AST index và LSP nếu có language server, preview localhost, script smoke/soak/watchdog Windows. **Không phải full Windows OS sandbox hay clone tính năng hoàn chỉnh Codex/Antigravity**; đọc giới hạn trước khi bật Host-review.

---

# ChatMCP Studio 2.1.0 — React IDE, khôi phục phiên và Project Verification

**Bản mới:** `STUDIO-2.1.0.md` · `UPGRADE-2.1.0.md` · `TEST-RESULTS-2.1.0.txt`. Dashboard mới dùng React offline, gọi đúng endpoint đổi chế độ và xóa phiên, chống kết nối nhầm tiến trình Hub cũ, có Git Review, editor, Command Palette (Ctrl+K) và kết quả kiểm thử lưu qua lần khởi động lại. Companion vẫn 1.4.0.

---

# ChatMCP Studio 1.3.0 — Agent đa lượt, giữ nguyên hội thoại và checkpoints

**Mới trong 1.3.0 / Companion 1.4.0:** Một hội thoại agent có thể có **nhiều lần chạy và prompt tiếp nối**. Bảng bên trái chứa toàn bộ lịch sử phiên; nhấp phiên cũ, nhập “Tiếp tục hoàn thành bài lab” để làm việc trong **cùng ID**, không tự sinh cuộc chat mới. Sau khi mất mạng, crash hoặc bạn bấm Dừng, checkpoint trên đĩa vẫn còn để tiếp tục thủ công nếu tự hồi phục chưa đủ bằng chứng. ChatGPT Web mở lại đúng URL chat cũ; API Gateway dựng lại ngữ cảnh từ bản ghi đã lưu. Chỉ bấm **+ Cuộc chat mới** khi thực sự muốn tạo một cuộc hội thoại khác. Xem [SESSION-RECOVERY.md](SESSION-RECOVERY.md) trước khi sử dụng.

Hub có **hai chế độ** dùng cùng workspace và toàn bộ công cụ MCP:

- **ChatGPT Web (Companion 1.4.0)**: giữ nguyên luồng gửi/nhận ChatGPT web từ bản 1.1.6; không cần API key.  
- **API Gateway**: gọi Gemini native `generateContent` hoặc OpenAI-compatible `chat/completions` trực tiếp bằng API key nhập trên dashboard. Key tùy chọn lưu mã hóa Windows DPAPI; không đưa key vào mã nguồn/URL/trang báo cáo.  

**Dashboard agent**: chọn mode, thiết lập API, test kết nối (có thể tính phí), xem bước đang làm, mục tiêu/ghi chú công khai, tham số gọi MCP và kết quả lỗi thực, báo cáo. Không hiển thị suy luận nội bộ của model. Xem **[AGENT-MODES.md](AGENT-MODES.md)** để có hướng dẫn cài, dùng đúng gateway, an toàn dữ liệu, giới hạn và lệnh test.

**Khôi phục mạng:** Web mode giữ khôi phục từ bản 1.1.6; API mode chờ mạng rồi thử lại yêu cầu model trước khi thực thi MCP mới (yêu cầu API có thể tính phí trùng). Không tự gọi lại các thao tác MCP ghi/xóa chưa rõ kết quả. Giữ Hub chạy khi chờ. Trong bản 1.3.0, các phiên có chat URL chính thức hoặc bản ghi API có thể được tiếp tục thủ công từ sidebar; không tự phát lại thao tác chưa xác minh.

---

## Lịch sử và hướng dẫn chế độ ChatGPT Web (từ 1.1.6)

### Ghi chú lịch sử 1.1.6

**Nhập yêu cầu trên localhost, dùng ChatGPT web thông thường để xử lý và để Hub thực thi các công cụ MCP trên máy Windows.** Luồng chính dùng ChatMCP Hub Companion 1.3.6 cùng phiên ChatGPT đã đăng nhập trong trình duyệt. Không cần API key hoặc Sign in with ChatGPT cho ứng dụng; không dùng quota Codex/Work. Các lượt chat vẫn chịu hạn mức và điều kiện của ChatGPT web trên tài khoản của bạn.

## Bản sửa 1.1.6 / Companion 1.3.6 — chờ mạng và tự tiếp tục an toàn

**Nguyên nhân thực tế:** Tác vụ chỉnh bài lab đã hoàn thành 43 lượt/11 công cụ, đến lượt 44 mất xác nhận trong `CHATMCP_BROWSER_SEND` và bản 1.3.5 đánh dấu `send_uncertain` rồi kết thúc. Lượt này CÓ THỂ đã vào ChatGPT, nên không được gửi lại mù quáng.

- Khi Hub tạm thời không truy cập được, Companion tiếp tục giữ tác vụ và thăm dò kết nối lại theo nhịp tăng dần (3–30 giây); sự kiện `online` trong tab đánh thức việc kiểm tra ngay.
- Nếu mất xác nhận **sau thao tác gửi**, ghi `reconciling`, chỉ **đọc lại** tin nhắn ở đúng tab tác vụ; khớp nguyên văn tin user hoặc khối JSON trợ lý với đúng `task`, `turn`, `nonce` thì tiếp tục chờ/nhận kết quả và gọi MCP. **Không bấm Gửi hai lần.** Trạng thái này được lưu qua lần khởi động lại service worker của tiện ích.
- Nếu mất xác nhận **claim** với Hub, thử lại cùng `messageId` an toàn nhờ Hub hỗ trợ claim idempotent theo `clientId`.
- Nếu trang báo offline **trước khi bấm Gửi**, giữ `claimed` và thử thao tác lần đầu khi mạng hoạt động lại. Nếu không biết thao tác đã được gửi hay chưa, chỉ chờ xác minh, không thử lại.
- `sent` và `reply` có thể truyền lại về Hub nếu mất phản hồi HTTP; Hub dùng `messageId` và `replyId` để không chạy lại công cụ đã có kết quả.
- Hiện trạng chờ được hiển thị trong **popup Companion**. Task trên dashboard vẫn là đang chạy; người dùng có thể chủ động hủy.

**Giới hạn quan trọng:** Nếu tab bị đóng, nội dung ChatGPT đổi sang cuộc chat khác, hoặc không còn bằng chứng đúng lượt, Hub sẽ không tự phát lại. Mạng hồi phục không bảo đảm ChatGPT đã xử lý một lệnh; trường hợp này cần người dùng kiểm tra. Lỗi kết nối ngay **trong** lời gọi MCP có thể có tác dụng phụ chưa xác nhận; Hub **không tự thực thi lại** lệnh ghi/xóa. Hub bị dừng/khởi động lại vẫn sẽ đánh dấu tác vụ đang dở là `interrupted` (không thể phục hồi đầy đủ phiên MCP in-memory); cơ chế tiếp tục tự động này dành cho mất mạng khi **Hub vẫn đang chạy**. Task đã báo `failed` từ bản cũ không thể tự nối lại, cần tạo task mới sau nâng cấp.

**Nâng cấp trên Windows:** Dùng `STOP-CHATMCP-HUB.cmd` dừng Hub, thay file ZIP vào thư mục Hub cũ, Reload tiện ích ở `edge://extensions` và kiểm tra **Companion 1.3.6**, rồi `START-CHATMCP-HUB.cmd`. Đóng tab riêng của tác vụ **đã thất bại** và giao việc lại; không thao tác trên một task cũ chưa rõ kết quả. Giữ nguyên thư mục `cloud-harness-mcp\deploy\.generated`, cấu hình ghép nối và dự án Windows. Sau khi nâng cấp, nếu chỉ mạng LAN chớp vài giây, giữ máy/Hub/tab chạy để tiện ích tự kiểm tra lại.

### Lịch sử bản sửa 1.1.5 / Companion 1.3.5 — tin nhắn bị ẩn


BẰNG CHỨNG NGƯỜI DÙNG: Trong tab ChatGPT của nhiệm vụ, AI đã trả về một khối mã JSON với đúng `chatmcp_hub:v1`, `task`, `turn:1`, `nonce` và `kind:describe`. Tuy vậy giao diện ChatGPT không còn thẻ user message khớp selector của bản 1.3.4 (`visibleUsers=0`), khiến Hub dừng trước khi nhận phản hồi và chưa gọi MCP (`0 bước/0 công cụ`). Không chạy lại lời gọi `Send` đã thực hiện.

Ở lượt đầu, tiện ích vẫn ưu tiên so khớp tin nhắn user đúng như cũ. **Chỉ khi trang không có bất cứ user bubble có thể đọc** và ChatGPT đã tạo một câu trả lời là *một lệnh JSON hoàn chỉnh* có đúng task, turn và nonce bí mật được cung cấp bởi Hub, Companion mới dùng lệnh đó làm bằng chứng xác nhận cuộc chat. Mã này được kiểm tra lại phía Hub trước mọi công cụ, không dựa riêng vào URL và không chấp nhận nội dung JSON tùy ý, nhiều lệnh cùng lượt hoặc user bubble khác không khớp. Tương tự, mỗi lượt kế tiếp phải có một phản hồi với cùng mã tác vụ, nonce, số lượt chính xác và không được tái gửi khi không biết lần trước đã thành công hay chưa. Tác vụ vẫn chạy trong tab riêng được Hub mở. Thời gian chờ nhận diện tin nhắn đầu là tối đa 90 giây (không phải giới hạn tổng tác vụ).

**Điều kiện kết thúc lượt:** khi không đọc được container role=assistant, cần JSON lệnh đã hoàn chỉnh, không có nút Stop đang hoạt động, không còn biến động nội dung sau 4 giây. Hub vẫn xác thực chặt chẽ cấu trúc phản hồi trước khi gọi MCP. Đây là cơ chế tương thích với UI, chưa được kiểm tra trực tiếp trên phiên Edge của người dùng; nếu UI thay đổi tiếp có thể cần cập nhật. Nếu một đoạn tin của người dùng khác được phát hiện, Companion dừng để tránh thực thi nhầm.

Nâng cấp: dừng Hub nền, thay các file trong cùng thư mục, Reload Companion **1.3.5** ở `edge://extensions`, đóng tab nhiệm vụ lỗi, khởi động lại Hub rồi thử một prompt *chỉ đọc 5 file*. Không sử dụng lại tab nhiệm vụ đã dừng vì lệnh đầu tiên có thể đã gửi thành công.

Các kiểm thử mới: `node tests/verify-send-cycle.mjs`, `node tests/verify-reply-witness.mjs`, `node tests/verify-first-message.mjs`, `node tests/verify-result-paging.mjs`. Chúng dùng VM/DOM giả lập khối JSON như ảnh, không phải test trực tiếp trong ChatGPT web/Windows của người dùng.

### Lịch sử bản sửa 1.1.4


Log mới `companion=1.3.3;from=home;to=conversation;turn=1;locked=false` cho thấy URL mới hợp lệ, nhưng Companion không đối chiếu được **đúng tin nhắn user của tác vụ** trong 15 giây. Lỗi này khác với lỗi URL tạm của bản trước. Không có căn cứ cho rằng MCP đã sửa file; báo cáo ghi 0 lượt / 0 công cụ.

Một nguyên nhân hợp lý là prompt mở đầu của Hub trước đây luôn đính kèm danh sách **toàn bộ tên công cụ**, làm văn bản quá dài. ChatGPT có thể biến nội dung lớn thành tệp `Pasted text` thay vì một tin nhắn hiển thị nguyên văn. Vì chưa kiểm tra được DOM thật trên Edge của bạn, đây là giả thuyết có cơ sở, không phải nguyên nhân đã được xác nhận 100%.

Bản này giảm prompt đầu xuống khoảng 2–3 KB với yêu cầu lab như ví dụ, **không bỏ mất công cụ**: agent lấy tên qua `kind=catalog` và schema qua `kind=describe`. Nếu prompt mở đầu vượt **4.800 byte UTF-8**, Hub từ chối từ bước chuẩn bị và giải thích thay vì gửi nội dung có nguy cơ biến thành file đính kèm. Khi kết quả MCP dài, Hub lưu nguyên nội dung và chuyển bằng các trang nhỏ thông qua `kind=result_page`; bản đầy đủ nằm trong transcript của tác vụ. Các trang giữ nguyên thứ tự và cặp surrogate Unicode.

Companion thử khớp **phần văn bản thực của tin nhắn user** ở cả các phần tử con trong bubble (nút Copy/Edit có thể làm nội dung wrapper khác văn bản gốc), đồng thời chấp nhận biến thể có `data-testid="user-message"`. Việc gắn một cuộc chat mới với tác vụ vẫn yêu cầu văn bản/ID duy nhất khớp; nếu không chứng minh được thì dừng, **không gửi lại prompt**. Thời gian chờ đồng bộ URL/DOM của tin đầu tăng từ 15 lên 30 giây và có chẩn đoán riêng `submitted_user_message_unverified`.

Khi nâng cấp: dừng Hub, thay gói tại cùng thư mục, Reload Companion 1.3.5 trong `edge://extensions`, **đóng tab tác vụ cũ**, mở lại Hub và tạo tác vụ mới. Không phải cài lại Docker hay ghép lại nếu giữ nguyên vị trí tiện ích/profile. Nên thử yêu cầu ngắn chỉ đọc một thư mục trước khi giao bài lab dài.

Các kiểm thử tập trung đi kèm gói, chạy từ thư mục gốc bằng `node tests/verify-first-message.mjs` và `node tests/verify-result-paging.mjs`. Chúng chỉ mô phỏng UI và xác minh logic, không truy cập ChatGPT thật hoặc sửa file bài lab.

### Lịch sử sửa 1.1.3 (URL tạm)

Đã tái hiện lỗi `conversation_changed` với `from=home;to=unsupported` bằng URL thực tế bạn cung cấp: ChatGPT tạo `/c/local-chatgpt%3A<UUID>` trước khi chuyển sang `/c/<mã chính thức>`. Companion 1.3.2 từ chối dấu `%3A` trong mã tạm. Bản này nhận đúng tiền tố `local-chatgpt` cùng UUID, chuẩn hoá `%3A`, `%3a` và dấu `:` thành cùng một địa chỉ tạm. Không giải mã hoặc chấp nhận mọi đường dẫn tuỳ ý.

Companion, Hub và dashboard dùng chung bộ nhận diện đã sửa. Trong lượt đầu, Companion tiếp tục đối chiếu đúng tin nhắn vừa gửi và chờ nếu URL cập nhật trước DOM. Nếu câu trả lời đã ổn định mà URL vẫn còn tạm, tiện ích chờ ChatGPT cấp địa chỉ chính thức trước khi chuyển lệnh về Hub. Nó kiểm tra lại độ ổn định của câu trả lời rồi cố định mã cuộc chat. Nếu địa chỉ vẫn chưa chuyển sau 60 giây kể từ lúc trả lời ổn định, báo `local_conversation_not_saved`; không gửi lại prompt hay chạy lệnh công cụ từ kết quả chưa được xác nhận này. Đây là thời gian chờ lưu cuộc chat, không phải giới hạn tổng thời gian tác vụ.

Theo yêu cầu của bạn, **bản nháp văn bản trong tab riêng do Hub quản lý được thay toàn bộ bằng prompt mới** trước khi gửi, kể cả khi bản nháp đổi trong lúc chờ nút Gửi hoặc trước lượt kết quả công cụ tiếp theo. Bản nháp chưa gửi không làm dừng việc nhận câu trả lời; nó được thay ở lượt tiếp. Tiện ích vẫn chỉ bấm Gửi một lần cho mỗi lượt. Tin nhắn khác đã gửi thủ công hoặc chuyển sang cuộc chat khác vẫn làm dừng để tránh tiếp tục sai ngữ cảnh. Hành vi này không áp dụng cho các tab chat khác hay tệp đính kèm.

Bản này giữ cách nhận nút Gửi đã sửa ở 1.1.1, thay draft đã thêm ở 1.1.2 và `STOP-CHATMCP-HUB.cmd` để dừng Hub nền bằng một lệnh.

**Nâng từ bản trước:** chạy `STOP-CHATMCP-HUB.cmd` hoặc bấm **Tắt Hub**, thay file gói ở cùng đường dẫn, bấm **Reload** trên thẻ Companion trong `edge://extensions` hoặc `chrome://extensions` và kiểm tra phiên bản **1.3.6**. Đóng tab riêng của tác vụ đã lỗi, khởi động lại Hub bằng lệnh hằng ngày và tạo tác vụ mới. Ghép đã lưu được dùng lại nếu vẫn nạp cùng thư mục/profile. Không gửi thủ công bản nháp thuộc tác vụ đã dừng.

## 1. Cấu hình dành cho máy này

| Thành phần | Đường dẫn / địa chỉ |
| --- | --- |
| Thư mục gói Hub | `F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB` |
| Cloud Harness đã cài | `F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp` |
| Cấu hình MCP nguồn | `deploy\.generated\mcp-client.proxy.json` trong Cloud Harness |
| Cloud Harness local | `http://127.0.0.1:3100/mcp` |
| MCP proxy | `http://127.0.0.1:3006/mcp` |
| Dashboard và địa chỉ Companion sử dụng | `http://127.0.0.1:3007` |

Cần Windows PowerShell 5.1, Node.js 22.12 trở lên, npm, Docker Desktop và Edge/Chrome có hỗ trợ extension Manifest V3. Node 24.19.0 bạn đã kiểm tra đáp ứng yêu cầu. Hub dùng lại Cloud Harness, cấu hình và thông tin xác thực MCP đã có; đây không phải bộ cài Cloud Harness từ đầu.

## 2. Cài hoặc nâng cấp một lần

### A. Đặt gói và khởi động Hub

1. Nếu Hub bản cũ đang chạy, mở dashboard, **Huỷ tác vụ** nếu cần và chờ dừng, rồi bấm **Tắt Hub**. Nếu cửa sổ proxy cũ `START-MCP-BROWSER.ps1` hoặc lệnh `npx ... --port 3006` còn chạy, nhấn **Ctrl+C trong đúng cửa sổ đó**.
2. Giải nén toàn bộ thư mục `CHATMCP-HUB` vào `F:\Personal_Project\Vin\ChatMCP`. Khi nâng cấp, thay các file của gói tại **cùng đường dẫn cũ**. Không xoá repository dự án hoặc thư mục dữ liệu `deploy\.generated`. Kiểm tra không bị lồng thành `CHATMCP-HUB\CHATMCP-HUB`.
3. Nếu Windows chặn các script tải về với lỗi `not digitally signed`, có thể Unblock ZIP trong **Properties** trước khi giải nén. Hoặc chạy một lần cho các script trong đúng gói vừa giải nén:

```powershell
Get-ChildItem -LiteralPath 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB' -Filter '*.ps1' -File -Recurse | Unblock-File
```

Lệnh này không thay execution policy và không cần terminal Administrator. Nếu máy có chính sách tổ chức bắt buộc chữ ký, cần dùng quy trình ký/cho phép của tổ chức.

4. Trong terminal PowerShell của VS Code hoặc Windows, chạy:

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
```

Hub mở `http://127.0.0.1:3007` và trả lại dấu nhắc terminal sau khi tiến trình nền đã khởi tạo. Lần đầu, việc cài dependency và chuẩn bị Docker/MCP có thể cần vài phút; theo dõi các thẻ trạng thái và **Nhật ký hoạt động** trên trang.

### B. Nạp Companion 1.3.6 và ghép trình duyệt

1. Trong chính trình duyệt/profile mà launcher vừa dùng để mở localhost, mở `edge://extensions` hoặc `chrome://extensions`, bật **Developer mode**, chọn **Load unpacked** và chọn đúng thư mục chứa `manifest.json`:

```text
F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\extension
```

Nếu đã nạp Companion từ chính thư mục này, bấm **Reload** trên thẻ tiện ích và kiểm tra phiên bản **1.3.6**. Nếu còn bản Companion/Button Fix từ thư mục khác, tắt bản cũ để tránh chạy hai bản. Tải lại các tab ChatGPT sau khi nạp hoặc reload extension.

2. **Tắt MCP SuperAssistant trong trình duyệt dùng Hub.** Trong luồng này, Hub thực thi MCP và Companion vận chuyển tin nhắn. Bật thêm Auto Execute/Auto Insert/Auto Submit của MCP SuperAssistant có thể tạo hai bên cùng thực thi. Phần **MCP SuperAssistant — Kết nối thủ công tuỳ chọn** trên dashboard chỉ dành cho một luồng riêng khi Hub không có tác vụ đang chạy.
3. Trên dashboard, mở **Kết nối ChatGPT web**, bấm **Tạo mã ghép**, rồi **Sao chép mã**.
4. Mở popup **ChatMCP Hub Companion**, dán 8 chữ số vào **Mã ghép lấy trên Hub** và bấm **Ghép và bật**. Nếu mã hết hạn, tạo mã mới trên dashboard. Tiện ích lưu ghép nối để dùng lại; bạn không cần ghép cho mỗi yêu cầu.
5. Trong ChatGPT mở ra, đăng nhập nếu cần và chọn **Chat thông thường**, không chọn Work/Codex. Chọn model bạn muốn dùng trong ChatGPT. Companion không tự đổi model, tài khoản hay hạn mức.

Mã ghép chỉ cấp kết nối giữa Companion và Hub local. Token được tạo sau ghép là **token của Hub**, không phải token ChatGPT. Bạn không phải lấy cookie, mã đăng nhập ChatGPT hay API key để dán vào Hub.

### C. Chọn workspace

Trong **Workspace**, bấm **Chọn thư mục…**, chọn thư mục rồi bấm **Dùng thư mục này**. Hoặc dán đường dẫn:

```text
F:\Personal_Project\Vin\K4-Track4-Day23-PhanDanhDat-02627-Sensor-Fusion-Student
```

Chờ **4/4 dịch vụ sẵn sàng**. Nếu cần, bấm **Khởi động MCP**. Hub kiểm tra Docker, mở Docker Desktop hoặc gọi launcher Cloud Harness hiện có khi cần, cài/dùng lại dependency và kiểm tra các công cụ. Những bước khởi tạo riêng của Docker/Windows vẫn có thể cần bạn xử lý thông báo trên máy.

## 3. Dùng hằng ngày: một lệnh

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
```

Lệnh mở lại dashboard và chuẩn bị MCP với workspace đã lưu; nếu Hub đã chạy thì dùng lại instance hiện có. Nhập việc cần làm vào **Bạn muốn làm gì?** và bấm **Chạy yêu cầu**. Companion mở một tab ChatGPT riêng cho tác vụ, gửi yêu cầu và chuyển tiếp kết quả MCP. Bạn không phải soạn JSONL hoặc bấm Run cho từng tool.

Muốn dùng ngay thư mục đang mở trong terminal VS Code:

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd' -ProjectPath .
```

Muốn dừng Hub đang chạy nền:

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\STOP-CHATMCP-HUB.cmd'
```

Lệnh kiểm tra đúng dịch vụ Hub, gửi yêu cầu dừng và đợi tối đa khoảng 15 giây để xác nhận đã đóng. Nếu đã dừng thì kết thúc bình thường. Chờ thông báo `Stopped` trước khi thay gói hoặc khởi động lại. Đây cũng là cách dừng ở các lần nâng cấp sau; bản trước 1.1.2 chưa có hai file STOP này thì dùng nút **Tắt Hub** trên dashboard.

Nếu Cloud Harness ở vị trí khác, thêm `-RepoRoot 'D:\duong-dan\cloud-harness-mcp'`. Giữ dashboard ở cổng **3007**: Companion 1.3.6 chỉ nối địa chỉ cố định này.

Ví dụ yêu cầu cho bài lab:

> Đọc README và các file RULES, RUBRIC, CHECKPOINTS, SUBMISSION, AGENTS hoặc SKILL.md liên quan nếu có. Kiểm tra phần còn thiếu của bài Sensor Fusion, giữ những thay đổi hiện có của tôi, rồi sửa file trong workspace Windows đã chọn. Chạy các kiểm tra mà dự án hướng dẫn. Cuối cùng báo file đã sửa, lệnh đã chạy, kết quả thực tế và phần còn bị chặn.

## 4. Tác vụ chạy nền như thế nào?

- Có thể đóng **dashboard hoặc terminal** sau khi Hub đã chạy nền. **Giữ trình duyệt và tab ChatGPT của tác vụ mở**, máy còn hoạt động và Windows còn đăng nhập. Văn bản nháp trong tab tác vụ sẽ được thay khi Hub chuẩn bị lượt tiếp; dùng tab khác nếu muốn giữ một bản nháp cá nhân. Gửi thêm tin nhắn thủ công vào tab tác vụ sẽ làm dừng điều phối.
- **Đã ghép · chờ trình duyệt** vẫn cho phép xếp hàng yêu cầu. Mở đúng trình duyệt đã cài Companion để tiện ích kết nối. Trạng thái kết nối tiện ích không tự chứng minh ChatGPT đã đăng nhập hoặc còn quota.
- Xem **Tiến độ & kết quả**, chọn tác vụ trong lịch sử, **Mở cuộc chat** hoặc **Tải báo cáo**. Kết quả có số lượt, số lần gọi tool và nhật ký; ChatGPT web không cung cấp số token cho cầu nối này.
- **Huỷ tác vụ** dừng điều phối tiếp theo. Nó không hoàn tác file đã sửa; lệnh đã gửi tới MCP có thể đã có tác dụng. Tác vụ gián đoạn không được tự chạy lại các lệnh ghi chưa rõ kết quả.
- Khi không có tác vụ đang chạy, **Dừng kết nối** dừng MCP do Hub quản lý; **Tắt Hub** dừng Hub cùng các tiến trình con nó sở hữu. Docker Desktop và dịch vụ Cloud Harness dùng chung không bị tắt. Hub không tự đăng ký Windows Startup.

BrowserRunner không đặt giới hạn tổng số lượt hoặc tổng thời gian cho một tác vụ. Timeout của từng lời gọi/transport MCP, giới hạn kích thước tin nhắn/ngữ cảnh, quyền server, tài nguyên máy và hạn mức ChatGPT vẫn áp dụng. Đăng nhập, xác minh, thay đổi giao diện ChatGPT hoặc feature flags có thể cần thao tác thủ công. Nếu báo lỗi hoặc hết lượt, đọc thông báo trong cuộc chat và báo cáo; Hub không đổi tài khoản, chuyển sang API hoặc vượt giới hạn để tiếp tục.

## 5. File, công cụ và phạm vi hỗ trợ

| Phần | Cách Hub sử dụng |
| --- | --- |
| File Windows | Desktop Commander đọc/sửa trực tiếp thư mục đã chọn; thay đổi hiện trong VS Code. Terminal chạy với quyền tài khoản Windows. Phạm vi của file tools không phải sandbox hệ điều hành. |
| Workspace Cloud Harness | Các clone Docker dùng `workspaceId` riêng. Chúng không phải đường dẫn `F:\...` và không tự đồng bộ/bind-mount với thư mục Windows. |
| Toàn bộ tools | Đọc hết danh mục của cả Cloud Harness và Desktop Commander, giữ tên, mô tả và input schema. Xem **Toàn bộ công cụ MCP**, tìm theo tên/tham số hoặc tải JSON. Không dùng một danh sách con cố định. |
| Resources, prompts, skills | Lấy các danh mục mà server công bố; các tool `skills_list`, `skills_read`, `skills_run` và tool khác vẫn có khi upstream cung cấp. Hướng dẫn trong repository được đọc theo yêu cầu tác vụ. |
| Dữ liệu đưa vào ChatGPT | Cầu nối hiện hỗ trợ tin nhắn văn bản/JSON. Chưa tự đính kèm ảnh, audio hoặc file vào ChatGPT. Tool có thể trả byte/binary, nhưng điều đó không có nghĩa model đã nhìn hoặc nghe nội dung đó. |

Đủ danh mục không bảo đảm mọi tool và mọi định dạng đều dùng được trọn vẹn qua giao diện chat. GitHub permissions, network profile, lease, dependency và khả năng upstream vẫn quyết định kết quả. `network-none` trong Docker vẫn giữ nguyên; Hub không tự cấp quyền push hoặc bật mạng. Muốn kết quả từ Docker xuất hiện trên Windows, tác vụ phải chuyển file rõ ràng và kiểm tra file đích.

Hub sao lưu trước khi cập nhật `allowedDirectories` của Desktop Commander theo tài khoản Windows. Cấu hình này có thể được client Desktop Commander khác dùng chung; tránh đổi nó từ client khác trong khi Hub đang chạy tác vụ.

## 6. Dữ liệu được lưu

Thư mục dữ liệu:

```text
F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub
```

| File / thư mục | Nội dung |
| --- | --- |
| `hub-state.json` | Workspace đã chọn |
| `mcp-client.hub.json` | Cấu hình MCP riêng của Hub, có thông tin xác thực upstream |
| `browser\browser-client.json` | Định danh ghép Companion, thời điểm ghép và hash token Hub; không lưu token Hub thô ở file này |
| `browser\tasks\<id>` | `task.json`, `transcript.jsonl`, `report.txt` của từng tác vụ |
| `hub.log` | Nhật ký Hub, che các secret đã nhận diện |

Token Hub thô được Companion lưu trong storage local của extension để kết nối lại. Prompt và phần file/kết quả MCP cần cho tác vụ được gửi vào cuộc chat ChatGPT; nhật ký cũng có thể chứa nội dung dự án. Không chia sẻ nguyên cấu hình hoặc thư mục dữ liệu khi chỉ cần gửi một thông báo lỗi.

Nếu nâng từ bản 1.0, các file model/credential và mã nguồn API/SIWC cũ có thể còn để tham khảo. **Launcher và trang chính 1.1.6 không nạp thông tin xác thực đó hoặc khởi chạy provider API/SIWC.** Không cần cấu hình chúng để dùng bản này.

## 7. Khi chưa chạy được

| Hiện tượng | Cách xử lý |
| --- | --- |
| `not digitally signed` | Unblock script của gói như mục 2, rồi chạy lại launcher. Không đổi execution policy toàn máy. |
| Vẫn thấy giao diện cấu hình API của bản cũ | Huỷ/dừng Hub cũ, bấm **Tắt Hub**, chạy lại launcher mới và tải lại dashboard. Thay file khi daemon cũ còn chạy chưa làm daemon đó đổi phiên bản. |
| Cổng 3006 đang dùng | Ctrl+C trong đúng cửa sổ proxy cũ đã mở, rồi **Khởi động MCP**. Không mở hai launcher proxy cùng lúc. |
| Thiếu cấu hình hoặc MCP chưa sẵn sàng | Kiểm tra cấu hình nguồn hiện có, Docker Desktop và **Nhật ký hoạt động**. Lần cài package đầu cần npm/Internet; một dòng npm notice chưa chứng minh cài thành công. |
| Đã ghép nhưng yêu cầu vẫn chờ | Mở đúng browser/profile có Companion 1.3.6; kiểm tra tiện ích được bật, Hub ở `127.0.0.1:3007`, rồi mở popup và bấm **Cập nhật**. |
| Không hiện mã / mã hết hạn / đổi profile | **Tạo mã ghép** mới trên Hub rồi **Ghép và bật** trong popup. Khi cần ghép lại một kết nối đã lưu, dùng **Huỷ ghép tiện ích** trên Hub trước. |
| `send_button_missing`, `send_button_disabled` hoặc `send_button_ambiguous` | Giữ tab tác vụ để xem ô nhập/nút Gửi và gửi lại nguyên dòng lỗi có phần trong ngoặc vuông. Dùng Companion 1.3.6. Không tự bật nút disabled hoặc gửi bản nháp cũ. |
| `conversation_changed` với `companion=1.3.2;from=home;to=unsupported` và URL `/c/local-chatgpt%3A…` | Đã sửa trong Companion 1.3.4: cập nhật cả gói, khởi động lại Hub và Reload extension rồi tạo tác vụ mới. |
| `submitted_user_message_unverified` trong 1.3.5 | Chỉ số `visibleUsers=0` và `replyWitness=false` nghĩa là chưa tìm thấy lệnh JSON đúng mã phiên trong tab. Gửi nguyên chẩn đoán và ảnh code block hiện trên ChatGPT; không gửi lại prompt. |
| `user_navigated_chat` từ bản cũ hoặc `conversation_changed` khác | Kiểm tra phiên bản Companion 1.3.6. Nếu vẫn lỗi, gửi chẩn đoán có `from`, `to`, `turn`, `locked` và đường dẫn tab tác vụ sau khi bỏ query/hash. Không chuyển tab tác vụ sang cuộc chat khác khi đang chạy. |
| `local_conversation_not_saved` | ChatGPT vẫn giữ URL tạm sau 60 giây từ lúc câu trả lời ổn định. Giữ tab để xem thông báo của ChatGPT và báo cáo tác vụ. Tiện ích chưa chuyển câu trả lời này thành lệnh công cụ và không tự gửi lại prompt. |
| ChatGPT yêu cầu đăng nhập, xác minh, báo hết lượt hoặc không nhận diện được ô chat | Mở tab tác vụ và xử lý thông báo. Giữ Chat thông thường. Không liên tục gửi lại prompt hoặc chạy lại lệnh ghi khi kết quả chưa rõ. |
| Browser ngủ, tab bị đóng hoặc Hub dừng giữa tác vụ | Xem trạng thái/báo cáo và kiểm tra file hiện tại trước khi giao việc tiếp. Không coi lỗi transport là bằng chứng file chưa thay đổi. |
| Không mở được hộp chọn thư mục | Dán đường dẫn vào **Workspace** và bấm **Dùng thư mục này**. |

## 8. Kiểm chứng và nguồn

Xem **VALIDATION.txt** để biết phạm vi kiểm thử của bản bàn giao. Trong lần chuẩn bị này, Desktop Commander thật đã được chạy kiểm tra với dữ liệu thử sau khi bạn đồng ý telemetry/feature flags của upstream; giao thức BrowserRunner, HTTP local và các tình huống lỗi được kiểm thử bằng fixture. Chưa xác minh native Windows trên máy bạn hoặc thao tác DOM ChatGPT thật. Các kiểm tra này không phải kết quả chạy bài lab Sensor Fusion.

Trạng thái **Hoàn thành** nghĩa là Hub đã nhận kết quả cuối hợp lệ của model. Đánh giá việc hoàn thành yêu cầu dựa trên file đã thay đổi và kết quả kiểm tra thực tế trong báo cáo; không có cam kết mọi giao diện, tool hoặc tác vụ luôn không lỗi.

- Cloud Harness: <https://github.com/bestagentkits/cloud-harness-mcp>
- Desktop Commander: <https://github.com/wonderwhy-er/DesktopCommanderMCP>
- MCP SuperAssistant/proxy: <https://github.com/srbhptl39/MCP-SuperAssistant>
- MCP SDK: <https://github.com/modelcontextprotocol/typescript-sdk>

Hướng dẫn chi tiết của Companion nằm trong **extension/HUONG-DAN.txt**. Phiên bản dependency và thông báo bên thứ ba nằm trong **THIRD-PARTY-NOTICES.txt**.
