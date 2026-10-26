# Hướng dẫn sử dụng DatGold Studio

## Current React UI

**Layout.** The top bar has the sessions toggle, the workspace and branch, search (**Ctrl K**), the light/dark toggle, **Cài đặt** (**Ctrl ,**) and the work-panel toggle (**Ctrl J**). The left column lists conversations per workspace. The right **work panel** has one row of tabs: **Tiến độ** (plan and evidence), **Thay đổi** (Git diff and checkpoints), **Tệp**, **Terminal**, **Tác nhân** (background tasks) and, under **⋯**, **Hoạt động** and **Xem trước**. The bar at the bottom shows the Hub connection, the branch, the agent channel, the context window, the model and the permission mode; each of those opens the matching page of Settings. **Cài đặt** is a page of its own (project, AI model, permissions and execution, agent channel and Companion, skills, code intelligence, appearance and language, about); **Esc** closes it. While **FULL ACCESS** is on, a red strip under the top bar says so and offers one click back to Review.

**The Agents tab (Tác nhân).** It lists what runs in the background: the tasks and subagents the agent started while you chat (`spawn_agent`, `spawn_workflow`), grouped by workspace and conversation. A filter (**Tất cả**, **Workspace này**, **Hội thoại này**) narrows the list, each card shows the state of the task and of its subagents, **Mở đúng hội thoại** opens the conversation it belongs to and **Dừng task** stops that one task. The tab used to have two more buttons, **Nhóm trợ lý** and **Sửa mã**, where you handed work out by hand; they were removed on 2026-10-25 because they were hard to understand. The Hub still has the routes behind them, so a coding worker started through the API still asks you, in the **Tiến độ** tab under **Kiểm thử cần bạn cho phép**, to allow its test commands (the Hub waits about 90 seconds; without your permission the worker stops as *Cần bạn kiểm tra* and its changes stay uncommitted in its own working copy).

**Evidence under each answer.** After a turn that changed files or ran commands, a strip says what the Hub recorded: *Kiểm tra đã được xác minh* (green) appears only when the Hub verified the outcome of a check itself, or when you accepted the criteria; *Chưa có bằng chứng kiểm tra được ghi nhận* or *Lệnh chạy xong, chưa xác minh kết quả test* (amber) means the agent says it is done but nothing independent backs that; red means a tool or check failed. Even green does not prove every requirement is met: read the diff. **Xem bằng chứng** opens the **Tiến độ** tab.

**Agents the agent started.** When the agent starts background agents (`spawn_agent`, `spawn_workflow`), the **Hoạt động** tab shows a line when each one stops (*Tác nhân nền … đã dừng*, with how it stopped: completed, failed, cancelled, a limit, or blocked by a failed dependency). The agent that started them is told too, once, in a message the Hub writes (it says it is not yours): while the agent is working it arrives before its next model request, and if the agent already answered, nothing is started, the line says so, and the agent is told before your next message. It can then read what they produced with `agent_results`: each agent's own final message, marked as that agent's claim (the Hub has not checked it), next to what the Hub recorded itself (steps, files whose hash it re-read, checks that passed). Read each agent's branch and diff before you trust either.

Choose **Hội thoại mới** to open an empty draft; the model starts only after **Gửi**. Select a saved session to load its recorded conversation. **Dừng** requests cancellation without undoing edits; **Tiếp tục** starts a new run in the same conversation. For an uncertain operation, inspect Git changes before continuing.

Pending approvals show the real tool, operation preview, risk category and expiry. **Phê duyệt** and **Từ chối** send your decision to the gate; resolved decisions are available in history. The **Tiến độ** tab says **Chưa có kế hoạch** until a plan has been stored. A final model answer does not prove tests were run or passed: inspect tool results and the real Git diff.

Onboarding accepts a typed workspace path as well as the native folder picker. Apply the path, configure and test the actual AI endpoint, then save the chosen permission mode. Failed operations stay visible. The older guide below describes historical labels and should not override this workflow.

Dành cho người dùng cuối: bạn đã cài và chạy được Hub (xem [WINDOWS-SETUP.md](WINDOWS-SETUP.md)) và muốn giao việc lập trình cho agent trong một thư mục dự án trên máy mình.

> Tài liệu này mô tả đúng các nhãn trên giao diện bản **2.3.0**. Nếu giao diện của bạn khác, hãy kiểm tra phiên bản ở Cài đặt → "Phiên bản hệ thống".

## 1. Agent làm được gì, và không làm gì

**Làm được**, trong *một thư mục dự án bạn chọn*: đọc và tìm kiếm file, xem Git (status/diff/log), sửa và tạo file, đổi tên/di chuyển file, `git add`, `git commit`, tạo/đổi nhánh, chạy lệnh (kiểm thử, build, lint, công cụ của dự án) và giữ một danh sách việc cần làm (kế hoạch) cho cả phiên.

**Không làm**:

- Công cụ file của agent không đọc hay sửa file nằm ngoài thư mục dự án (đường dẫn tuyệt đối, `..`, symlink/junction trỏ ra ngoài đều bị từ chối). Với **lệnh shell**, Hub phân tích từng đường dẫn trong lệnh: lệnh có đường dẫn trỏ ra ngoài dự án hoặc tới file nhạy cảm không được tự chạy (luôn hỏi bạn, hoặc bị từ chối ở chế độ Chỉ đọc). Đây là phân tích lệnh, **không phải sandbox hệ điều hành**.
- Không đụng vào file nhạy cảm bằng công cụ file: `.env*`, khóa riêng (`id_*`, `*.pem`, `*.key`, `*.pfx`…), `credentials`, `.npmrc`, `.git-credentials`, thư mục `.git`, `.ssh`, `.aws`… Các thao tác này bị từ chối thẳng (không hỏi) ở **cả ba chế độ** và cả khi bật Full Access.
- Công cụ `git_commit` của agent từ chối commit khi vùng stage đang chứa file bí mật (`protected_staged`).
- Không đẩy code lên GitHub thay bạn một cách âm thầm: `git push` luôn bị coi là thao tác nguy hiểm và luôn hỏi bạn (ở chế độ Chỉ đọc thì bị từ chối). Hub không có công cụ riêng để tạo Pull Request; nếu agent thử `gh`, `curl`… qua shell thì đó là lệnh truy cập mạng và phải được bạn duyệt.
- Không tự chạy lại một thao tác mà nó không chắc đã chạy hay chưa (xem mục 8).

**Điều bạn cần nhớ**: agent chạy lệnh *bằng quyền Windows của bạn*, không có sandbox hệ điều hành. Chọn đúng thư mục dự án và đọc kỹ lệnh trước khi bấm **Cho phép**. Xem [SECURITY.md](../SECURITY.md) cho đầy đủ các giới hạn.

## 2. Làm quen với màn hình

| Khu vực | Có gì |
|---|---|
| **Thanh trên cùng** | Tên thư mục dự án; "Hub đã kết nối"; **Lệnh · Ctrl K** (bảng lệnh); Làm mới; Sáng/Tối; **Ẩn công cụ / Hiện công cụ**; **Cài đặt** |
| **Cột trái — HỘI THOẠI** | **Hội thoại mới**, ô "Tìm hội thoại…", danh sách các phiên (mỗi dòng có thư mục và trạng thái). Phiên được lưu tự động trên máy bạn |
| **Giữa** | Tiêu đề phiên, thẻ trạng thái, nút **Dừng tác vụ**, **Xóa phiên**, **Báo cáo ↗**; nội dung hội thoại; khung duyệt; ô nhập yêu cầu |
| **Cột phải — CÔNG CỤ DỰ ÁN** | Các tab: **Hoạt động**, **Files**, **Git**, **Terminal**, **Code / LSP**, **Preview**, **Plan**, **Skills**, **Cài đặt** |

Phím tắt: `Ctrl+K` mở bảng lệnh · `Enter` gửi · `Shift+Enter` xuống dòng · `Esc` đóng bảng lệnh hoặc hướng dẫn.

Tab trình duyệt đổi tiêu đề thành **"(n) Cần duyệt — DatGold Studio"** khi agent đang chờ bạn, và **"Đang chạy — …"** khi agent làm việc, để bạn nhận ra từ cửa sổ khác.

## 3. Thiết lập lần đầu (4 bước)

Lần đầu mở, một hộp thoại **"Chào mừng đến DatGold Studio"** hiện ra. Bạn có thể **Bỏ qua, thiết lập sau**, đóng bằng `Esc`, hoặc mở lại: Cài đặt → **Thiết lập nhanh** → **Mở trình hướng dẫn** (hoặc `Ctrl+K` → "Hướng dẫn thiết lập").

1. **Thư mục dự án.** Nhập đường dẫn (ví dụ `F:\Projects\my-app`) rồi **Dùng thư mục này**, hoặc bấm **Chọn thư mục…**. Hãy chọn *thư mục gốc của repository* bạn muốn làm việc.
2. **Kết nối AI.** Chọn nhà cung cấp, dán API key, bấm **Lưu & kiểm tra**. Xem mục 4.
3. **Quyền của agent** ("Agent được làm gì mà không hỏi?"). Chọn *Chỉ đọc*, *Review* (khuyến nghị) hoặc *Tự động*. Đổi được bất cứ lúc nào bằng công tắc cạnh ô nhập yêu cầu.
4. **Sẵn sàng làm việc.** Một danh sách kiểm tra (thư mục, AI + tình trạng tool calling, quyền) và hai yêu cầu mẫu **chỉ đọc**: *Tìm hiểu dự án*, *Chạy kiểm thử*. Bấm **Bắt đầu dùng**.

**Lời khuyên**: lần đầu hãy thử *Tìm hiểu dự án* ở chế độ Review. Bạn sẽ thấy agent chỉ đọc, và sẽ thấy cách khung duyệt hoạt động khi nó cần chạy lệnh.

## 4. Kết nối một model

Mở ở Cài đặt → **Nhà cung cấp AI** (cùng một form với bước 2 của hướng dẫn).

| Trường | Ý nghĩa |
|---|---|
| **Nhà cung cấp** | Preset điền sẵn giao thức, địa chỉ và model: Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, DeepSeek, xAI (Grok), Z.ai (GLM), Alibaba (Qwen), MiniMax, Groq, Mistral, Ollama (máy cục bộ), LM Studio (máy cục bộ), và các tùy chọn "Khác" cho dịch vụ tương thích OpenAI / Anthropic / Gemini (mọi nhà cung cấp còn lại: nhập địa chỉ gốc và API key). Chọn **Tự nhập thủ công** nếu không có preset phù hợp |
| **Giao thức** | Anthropic Messages · OpenAI-compatible (chat completions) · Gemini generateContent |
| **Base URL** | Phải bắt đầu bằng `https://` (hoặc `http://localhost…` cho máy chủ cục bộ) |
| **Model** | Gõ tên model (tên nào cũng được), hoặc bấm mũi tên ▾ bên phải ô để chọn từ danh sách model của nhà cung cấp này. Danh sách là của Hub (đọc từ danh mục model, không gọi mạng); mỗi model kèm điều danh mục biết về nó: cửa sổ ngữ cảnh (và giới hạn đầu vào nếu thấp hơn cửa sổ), giá mỗi 1 triệu token (vào / ra), giá theo bậc, có suy luận, dùng công cụ, đọc ảnh, ngừng hỗ trợ. Gõ để lọc, ↑ ↓ để di chuyển, Enter để chọn, Esc để đóng. Gõ một tên danh mục không có (tên tự đặt, thẻ Ollama, máy chủ riêng) thì không hiện hộp nào. Dưới ô, một dòng nói danh mục biết gì về model đang gõ; nếu tên chỉ *giống* một model trong danh mục, dòng nói rõ Hub không dựa vào đó để lập kế hoạch hay tính giá. **Chỉ hiện model của tài khoản** (trong danh sách; chỉ có khi form đang là cấu hình đã lưu) hỏi nhà cung cấp, bằng key đã lưu, tài khoản này dùng được model nào (danh sách ấy thuộc kết nối đã hỏi: đổi nhà cung cấp hay địa chỉ trong form thì bộ chọn quay về danh sách của nhà cung cấp mới) |
| **API key** | Chỉ gửi tới Base URL ở trên. Để trống = giữ key đang lưu. Máy chủ cục bộ (Ollama, LM Studio) không cần key |
| **Ghi nhớ key trên máy này** | Bật: key được mã hóa và lưu (Windows DPAPI). Tắt: key chỉ ở trong bộ nhớ Hub và **mất khi Hub dừng** |
| **Dùng key từ biến môi trường …** | Dùng `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`… nếu Hub thấy; không lưu vào file |
| **Mức suy luận (thinking effort)** | **Tự động** (mặc định): Hub không gửi gì, model tự quyết định. Hoặc một mức: mức cao nghĩ lâu hơn, làm tốt hơn việc khó nhưng chậm hơn và tốn nhiều token hơn. Danh sách mức lấy từ danh mục model của Hub (đi kèm bản cài hoặc bản bạn đã cập nhật; ngày ghi ở dưới ô): ví dụ Claude Sonnet 5.5 có Thấp, Vừa, Cao, Rất cao, Tối đa; GPT-5 mini có Tối thiểu đến Cao. Model không có trong danh mục (tên tự đặt, Ollama, LM Studio) hiện ba mức thông dụng và ô nói đó là phỏng đoán: nếu nhà cung cấp từ chối, Hub gửi lại đúng yêu cầu đó một lần không kèm thiết lập, báo trong tác vụ và nhớ cho model này đến khi bạn lưu lại cấu hình. Gemini 3 và 4 có mức riêng (Thấp, Vừa, Cao; một số model thêm Tối thiểu). Gemini 2.5 suy luận theo ngân sách token nên Hub quy mỗi mức ra một ngân sách (Tối đa là ngân sách lớn nhất của model; Gemini 2.5 Pro không tắt được suy luận, Flash thì có Tắt suy luận); giới hạn đầu ra được nâng lên để còn chỗ viết câu trả lời sau phần suy nghĩ. Model chỉ có công tắc, Claude đời cũ điều khiển bằng ngân sách token, và model không suy luận chỉ có Tự động, kèm lý do. Hồ sơ model có ô riêng cùng cách chọn. Mỗi tác vụ còn chọn được mức riêng ở thanh công cụ của khung nhập (biểu tượng bộ não, cạnh ô chọn hồ sơ model): *Mặc định* là mức đang có hiệu lực (của kết nối, hoặc của chính cuộc hội thoại), *Tự động* là không gửi gì, hoặc một mức mà model của tác vụ đó có. Lựa chọn chỉ áp cho tác vụ ấy, các lượt sau của nó và các agent nó khởi tạo; cấu hình kết nối không đổi. Với Claude, phần suy luận của bước vừa rồi được giữ và gửi lại cùng kết quả công cụ để model nối mạch; những bước mà Hub phải cắt gọn kết quả cũ cho vừa cửa sổ thì không gửi (model tự nghĩ lại), và nếu nhà cung cấp từ chối thì Hub gửi lại đúng yêu cầu đó một lần không kèm. Phần suy luận không được lưu vào bản ghi tác vụ trên đĩa |
| **Nâng cao** | Kiểu xác thực (`auto`, `bearer`, `google-key`), đường dẫn endpoint tùy chỉnh, **Context window (tokens)** (4.096 đến 2.000.000). Để trống: nếu danh mục chắc chắn về model (khớp đúng id, hoặc chỉ khác vùng / ngày / dấu chấm; không phải chỉ "giống"), Hub lập kế hoạch theo cửa sổ của danh mục và ghi chú dưới ô nói số đó và nguồn, nhưng không ghi gì vào ô; model nhận vào ít hơn cửa sổ của nó thì Hub lập kế hoạch theo phần đầu vào còn lại. Nếu giá của model tăng khi lời nhắc dài hơn một mốc (mốc đầu tiên trong các bậc giá của danh mục, riêng cho từng cặp nhà cung cấp + model: gpt-5.4 trên 272.000 token, gemini-2.5-pro trên 200.000), Hub không tự lập kế hoạch quá mốc đó, và không xuống dưới 128.000 (mốc thấp hơn thì Hub vẫn dùng 128.000); ghi chú dưới ô nói mốc, giá trước và sau mốc và lý do. Model giá phẳng (không có bậc giá) dùng cả phần cửa sổ model cho phép. Danh mục không biết model: chưa biết cửa sổ, Hub tính theo ước lượng 32.768 và hiện cảnh báo trên mỗi tác vụ. Số bạn nhập luôn được dùng thay cho danh mục, kể cả số lớn hơn mốc đổi giá; cửa sổ nhỏ hơn giữ hội thoại ngắn hơn và rẻ hơn |
| **Danh sách model của Hub** | Dòng dưới ô Model nói Hub đang dùng danh sách nào, ví dụ `catalog@2026-10-19 · đi kèm Hub · 5 ngày tuổi · 9.056 model`. Hub không tự tải gì: không lịch, không kiểm tra khi khởi động, không kiểm tra khi bạn chọn model. **Cập nhật từ models.dev** chỉ chạy khi bạn bấm: Hub tải một tệp công khai từ `https://models.dev/api.json` (không key, không cookie, không gửi tên dự án hay nội dung của bạn; tối đa 12 MB và 30 giây, không theo chuyển hướng), kiểm tra tệp rồi mới thay danh sách đang dùng và lưu vào thư mục dữ liệu của Hub (dùng lại sau mỗi lần khởi động). Có lỗi thì danh sách đang dùng giữ nguyên và dòng nói vì sao. Hub từ chối cập nhật khi đang có tác vụ chạy (mỗi lượt chạy giữ nguyên kế hoạch và giá của nó) và khi đồng hồ máy trước ngày của danh sách đi kèm (bản mới sẽ bị coi là cũ hơn). Danh sách chỉ gồm model có id mà Hub nhận được. Bản đã lưu bị hỏng, cũ hơn bản đi kèm hoặc đề ngày trong tương lai thì Hub bỏ qua và dòng cũng nói vậy |

Các nút:

- **Lưu & kiểm tra** — lưu cấu hình rồi gửi một yêu cầu nhỏ để thử đúng khả năng *gọi công cụ*. Không gửi nội dung dự án. Đây là nút nên dùng.
- **Lưu API** — chỉ lưu, không thử.
- **Test API · Tự nhận dạng** — thử lại kết nối và tự chọn cấu hình phù hợp.
- **Xóa key** — xóa key đã lưu hoặc đang giữ trong phiên.

Kết quả kiểm tra hiện thành một nhãn:

| Nhãn | Nghĩa là |
|---|---|
| Tool calling hoạt động | Dùng được |
| Tool calling chưa đáng tin | Model gọi công cụ không ổn định: nên đổi model |
| Model không hỗ trợ tool calling | Agent sẽ **không** làm việc đáng tin: đổi model |
| Chưa xác định được tool calling | Chưa kết luận được (lỗi mạng, hết hạn mức…) |
| Chưa kiểm tra tool calling — bấm Test API | Chưa thử |

**Ollama / LM Studio**: model phải hỗ trợ tool calling, và *cửa sổ ngữ cảnh phải đủ lớn*. Nhiều máy chủ cục bộ cắt ngữ cảnh lặng lẽ ở 2 048–4 096 token, khiến agent "quên" yêu cầu. Xem [TROUBLESHOOTING.md](TROUBLESHOOTING.md#ollama-hoặc-lm-studio-cắt-ngữ-cảnh-lặng-lẽ) và điền ô *Ngữ cảnh model* khi bạn biết giá trị.

**Chi phí trên thanh tiến độ.** Hub nhân số token mà nhà cung cấp báo với giá. Giá lấy theo thứ tự: giá bạn nhập trong hồ sơ model (USD mỗi 1 triệu token, các ô *Model rate*); nếu bạn để trống và danh mục chắc chắn về model thì giá trong danh mục, và khi đó con số luôn kèm chữ **(ước tính)** cùng nguồn của danh mục, vì nó không phải hóa đơn; model có giá theo bậc (cả yêu cầu bị tính giá cao hơn khi lời nhắc vượt một ngưỡng) được tính theo bậc ấy. Không có giá nào, hoặc nhà cung cấp không báo số token: Hub không hiện tổng thay vì đoán (chỉ biết một phần thì hiện phần đã biết và ghi rõ là tạm tính). Thử lại và lỗi có thể phát sinh phí mà Hub không biết; giá riêng cho suy luận và âm thanh trong danh mục chưa được dùng. Model có cửa sổ lớn (hàng triệu token) thì Hub rút gọn hội thoại muộn hơn, nên mỗi bước có thể gửi nhiều token hơn: nhập một cửa sổ nhỏ hơn vào ô *Context window* nếu bạn muốn chặn chi phí.

**Đổi Base URL thì key đã lưu bị xóa** (để không gửi nhầm key của nhà này sang nhà khác). Bạn phải nhập lại key.

## 5. Giao việc cho agent

Gõ yêu cầu vào ô *"Hãy mô tả tác vụ bạn muốn agent thực hiện…"* rồi bấm **Bắt đầu** (hoặc `Enter`). Trong phiên đã có, nút là **Tiếp tục** và ô nhập là *"Tiếp tục công việc trong đúng hội thoại này…"*: agent nhớ toàn bộ hội thoại trước đó.

Màn hình trống có ba gợi ý: *Tìm hiểu dự án*, *Sửa lỗi*, *Viết kiểm thử*.

**Một yêu cầu tốt** nói rõ: việc cần làm, tiêu chí xong, và cách kiểm tra. Ví dụ:

> Hàm `parse_date` trong `src/dates.py` trả sai khi chuỗi có múi giờ. Viết một test tái hiện lỗi, sửa tối thiểu, chạy `pytest -q` và báo kết quả thực tế. Đừng đổi API công khai.

Mẹo:

- Giao việc **nhỏ và kiểm chứng được**. "Sửa lỗi X và chạy test Y" tốt hơn "cải thiện dự án".
- Với việc lớn, bảo agent "lập kế hoạch trước, chưa sửa" ở chế độ Chỉ đọc, đọc kế hoạch, rồi mới chuyển sang Review.
- Làm việc trên **nhánh riêng** và `git commit` trạng thái sạch trước khi giao việc, để luôn hoàn tác được bằng Git.
- Dòng gợi ý dưới ô nhập cho biết điều gì đang chặn bạn (chưa chọn thư mục, chưa cấu hình AI…) và có nút bấm để sửa. Công cụ của dự án tự khởi động khi bạn giao việc.

## 6. Quyền: ba chế độ

Công tắc **Chỉ đọc · Review · Tự động** nằm cạnh ô nhập (và ở Cài đặt → **Quyền của agent**).

| | **Chỉ đọc** | **Review** (khuyến nghị) | **Tự động** |
|---|---|---|---|
| Đọc, tìm kiếm, Git chỉ đọc, lệnh chỉ đọc (`ls`, `cat`, `git status`… với mọi đường dẫn nằm trong dự án) | Tự chạy | Tự chạy | Tự chạy |
| Cập nhật kế hoạch của agent | Được | Được | Được |
| Ghi/sửa/đổi tên file, tạo thư mục, `git add`/`commit`, tạo/đổi nhánh | **Từ chối**, không hỏi | **Hỏi từng lần** | Tự chạy |
| Lệnh kiểm tra (`pytest`, `npm test`, build, lint…) và lệnh sửa file trong dự án | **Từ chối** | **Hỏi** | Tự chạy |
| Chạy chương trình khác, truy cập mạng, đường dẫn ngoài dự án | **Từ chối** | **Hỏi** | **Hỏi** |
| Lệnh nguy hiểm (xóa, `git push`, ghi đè lịch sử, cài đặt hệ thống…), `delete_path` | **Từ chối** | **Hỏi** | **Hỏi** |
| Công cụ chưa phân loại (chỉ gặp với MCP ngoài ở backend cũ) | **Từ chối** | **Hỏi** | **Từ chối** |
| File nhạy cảm (`.env`, khóa, `.git`…) | **Từ chối** | **Từ chối** | **Từ chối** |

Hai điều hay bị hiểu nhầm:

- *Tự động* **không** có nghĩa là "làm gì cũng được". Nó chỉ bỏ câu hỏi cho việc sửa file trong dự án và cho các lệnh đã được phân loại là kiểm tra hoặc sửa file. Lệnh khác và lệnh nguy hiểm vẫn hỏi. Khi bạn bật Tự động, giao diện hỏi xác nhận một lần.
- Lệnh kiểm tra như `pytest` hay `npm test` **chạy mã của dự án** với quyền của bạn. Chỉ dùng *Tự động* với repository bạn tin tưởng (không phải repo vừa tải về từ nguồn lạ).

### Khung duyệt

Khi cần quyền, khung **"Agent đang chờ bạn duyệt n thao tác"** hiện ngay phía trên ô nhập. **Không có gì chạy cho tới khi bạn quyết định.**

Mỗi thẻ cho bạn thấy *chính xác* điều sẽ xảy ra:

- **Chạy lệnh**: lệnh đầy đủ, thư mục chạy, shell, phân loại (*Lệnh chỉ đọc / Lệnh kiểm tra / Lệnh có thể sửa file / Chạy chương trình / Lệnh nguy hiểm*), lý do phân loại, giới hạn thời gian.
- **Ghi file**: đường dẫn, kích thước, có ghi đè không, phần đầu nội dung.
- **Sửa file**: đường dẫn, đoạn cũ → đoạn mới, thay một chỗ hay *tất cả* chỗ khớp.

Bấm **Cho phép** hoặc **Từ chối** (có thêm **Từ chối tất cả** khi có nhiều yêu cầu). Mỗi yêu cầu có đồng hồ đếm ngược; hết **10 phút** mà bạn chưa quyết định thì bị **từ chối tự động**. Khi bị từ chối (do bạn hoặc do hết hạn), agent nhận thông báo "Người dùng từ chối hoặc hết hạn phê duyệt" và thường thử cách khác hoặc hỏi lại bạn.

> **Full Access** (Cài đặt → "Môi trường thực thi & Cách ly OS" → "Quyền chạy MCP"; phải gõ đúng `FULL ACCESS` để bật) **bỏ khung duyệt** cho các công cụ thường ngày (kể cả `run_command`) và cho phép lỗi sao lưu checkpoint đi qua. Ngoại lệ: những thao tác không thể hoàn tác (xóa dữ liệu bằng `delete_path`/`rm`, `git push`, merge pull request, tạo hoặc xóa release/repo GitHub, `npm publish`, `docker push`...) **vẫn xin phê duyệt như bình thường**; agent chạy nền (worker, agent con ở chế độ Tự động/Full Access) không có ai để hỏi nên các thao tác đó bị từ chối ngay. File nhạy cảm vẫn bị chặn và chế độ **Chỉ đọc vẫn thắng**. Giao diện hiện cảnh báo đỏ "FULL ACCESS đang bật" và khóa công tắc quyền. Mặc định là *Host review*; đừng bật Full Access cho dự án lạ.

## 7. Theo dõi một tác vụ

**Thẻ trạng thái** cạnh tiêu đề:

| Trạng thái | Nghĩa là | Bạn làm gì |
|---|---|---|
| Đang chuẩn bị | Hub khóa thư mục và nối công cụ | Chờ |
| Đọc & lập kế hoạch | Agent đang đọc dự án; chưa sửa gì | Chờ |
| Đang thực hiện | Đang sửa file hoặc chạy lệnh | Chờ, hoặc **Dừng tác vụ** |
| **Chờ bạn duyệt** | Cần bạn cho phép một thao tác | Đọc khung duyệt, quyết định |
| Đang kiểm tra | Đang chạy test/lệnh kiểm tra | Chờ |
| Tạm dừng | Dừng giữa chừng (hết giới hạn, hoặc Hub khởi động lại) | **Tiếp tục từ chỗ dừng** |
| Hoàn tất | Agent đã trả lời kết thúc | Đọc kết quả **và dòng bằng chứng** |
| Thất bại | Dừng vì lỗi | Đọc lý do; có thể là lỗi cấu hình (nút sửa kèm theo) |
| Đã dừng | Bạn đã dừng | Dừng *không* hoàn tác những gì đã làm |
| **Chưa rõ kết quả** | Có thao tác có thể đã chạy nhưng Hub không biết kết quả | Mục 8 |

**Kế hoạch của agent** hiện trong một thẻ "Kế hoạch của agent" với tiến độ `n/m xong` và từng bước *Chưa làm / Đang làm / Xong / Bị chặn*. Bạn sửa kế hoạch ở tab **Plan**.

**Tab Hoạt động**: số *Phản hồi AI*, *Lần gọi công cụ*, *Yêu cầu*; **Lịch sử trạng thái** (vì sao đổi trạng thái); **Timeline** (80 sự kiện gần nhất: lời agent nói, công cụ nào được gọi, kết quả); trạng thái công cụ cục bộ; **Hub Logs**.

### Dòng bằng chứng — đọc nó trước khi tin "Hoàn tất"

Khi tác vụ xong, dưới câu trả lời của agent có một dòng do **Hub** ghi (không phải do model tự khai), ví dụ:

> `2 thao tác sửa file thành công · 1 lệnh kiểm tra đã chạy và đạt (exit code 0)`

hoặc, màu cảnh báo:

> `1 thao tác sửa file thành công · CHƯA có lệnh kiểm tra nào chạy thành công`

Ý nghĩa: *"Hoàn tất"* chỉ có nghĩa là **model đã ngừng và trả lời**. Việc code có đúng hay không được thể hiện bằng dòng bằng chứng: chỉ khi có **lệnh kiểm tra thật sự chạy và thoát với mã 0** thì mới có chữ "đạt". Nếu có lệnh shell, Hub nói "có thể đã thay đổi file (xem Git diff)" vì nó không thể biết lệnh đó đã sửa gì. Bấm **Xem thay đổi** để mở Git diff.

## 8. Khi tác vụ dừng giữa chừng

### Tạm dừng
Hub khởi động lại, hoặc agent chạm một giới hạn: thời gian hay số lượt model nếu có đặt, ngữ cảnh của phiên (48 MiB), hoặc model bị cắt đầu ra. Mặc định Hub **không** đặt giới hạn thời gian hay số lượt; giới hạn của nhà cung cấp và nút **Dừng tác vụ** của bạn vẫn áp dụng. Bấm **Tiếp tục từ chỗ dừng**: agent được yêu cầu kiểm tra `git status`/`git diff` trước rồi làm nốt phần còn lại.

### Chưa rõ kết quả (rất quan trọng)
Nếu Hub tắt hoặc mất kết nối *đúng lúc một thao tác ghi/chạy lệnh đang diễn ra*, nó **không biết** thao tác đó đã xảy ra chưa. Hub **không bao giờ chạy lại** thao tác đó. Banner **"Chưa rõ một thao tác đã chạy hay chưa"** liệt kê các thao tác chưa rõ và có hai nút:

- **Xem thay đổi (Git diff)** — tự kiểm tra bằng mắt.
- **Tiếp tục: kiểm tra trước** — gửi cho agent chỉ dẫn "đừng giả định thao tác đó đã chạy hay chưa; hãy kiểm tra trạng thái hiện tại rồi mới tiếp tục".

### Thất bại
Banner nêu mã lỗi và lý do. Với lỗi cấu hình (khóa sai, hết hạn mức, model không tồn tại, thư mục không còn…) có nút **Sửa cấu hình AI** hoặc **Chọn lại thư mục dự án**. Có thêm **Thử lại** và, nếu agent đã gọi công cụ, **Xem thay đổi (Git diff)**.

### Tự tiếp tục sau restart
Công tắc ở tab **Hoạt động**. Khi bật, Hub tự tiếp tục một phiên *tạm dừng* sau khi khởi động lại — **chỉ khi không có thao tác nào chưa rõ kết quả**. Mặc định tắt.

## 9. Xem, kiểm tra và hoàn tác thay đổi

Agent sửa file thật trong dự án của bạn. Có ba lớp an toàn, theo thứ tự nên dùng:

**1) Git (lớp chính).** Tab **Git**:

- **Git changes** hiển thị `HEAD` và danh sách file thay đổi. **Tải lại** để cập nhật.
- **Diff** — các thay đổi chưa stage của file đã theo dõi. **Diff check** — phát hiện lỗi khoảng trắng/xung đột (`git diff --check`).
- File *mới* (chưa theo dõi) hiện ở danh sách trạng thái; xem nội dung bằng tab Files.
- **Checkpoint** — tạo một bản sao lưu (xem dưới).

**2) Checkpoint của Hub.** Trước mỗi lần agent sửa file (hoặc chạy lệnh có thể sửa file), Hub tự lưu một checkpoint của các file sắp đổi (lệnh shell: ảnh chụp có giới hạn của thư mục làm việc). Nếu không lưu được checkpoint, thao tác **không được chạy** (`checkpoint_failed`). Trong **Snapshot review**: chọn checkpoint → **Review** → với từng file bạn thấy diff và hai nút **Accept** (giữ thay đổi) / **Restore** (đưa *riêng file đó* về checkpoint; có hỏi xác nhận; chỉ thực hiện nếu file chưa bị đổi tiếp kể từ lúc bạn xem).

> Checkpoint chỉ sao lưu **file văn bản trong giới hạn** (tối đa 140 file mỗi lần). Nó **không thay thế Git** và không phải backup toàn bộ.

**3) Chính bạn.** `git commit` trạng thái sạch trước khi giao việc; cần là `git restore .` / `git switch` hoặc bỏ nhánh. Cũng đừng giao việc khi bạn còn thay đổi chưa commit mà bạn không muốn lẫn với thay đổi của agent.

### Tab Files
- **Explorer**: duyệt cây thư mục (tối đa 350 mục mỗi thư mục; ẩn `.git`, `node_modules`, `.venv`, `__pycache__`, `dist`, `build`…).
- **Tìm codebase**: tìm *Text / Symbol / Filename*.
- **Editor**: xem file kèm SHA-256 và kích thước; **Sửa file** → **Lưu có checkpoint**. Bản ghi chỉ thành công nếu file không bị đổi từ lúc bạn mở (kiểm tra SHA-256) — để không ghi đè nhầm thay đổi của agent hay của editor khác.

## 10. Kiểm thử và Terminal

Tab **Terminal**:

- Ô lệnh (ví dụ `python -m pytest -q`) → **Run**. Đây là terminal **của bạn** (không phải của agent): mặc định chạy **trên máy bạn, không sandbox**, và trình duyệt hiện hộp xác nhận "CHẠY LỆNH TRÊN WINDOWS HOST" trước mỗi lần chạy. Có tùy chọn **Docker sandbox (read-only)** (không mạng, chỉ đọc thư mục dự án; cần Docker Desktop) và **Shell tương tác** (cần ConPTY; không cài thì Hub dùng pipe và nói rõ — xem [WINDOWS-SETUP.md](WINDOWS-SETUP.md)). **Stop** dừng lệnh đang chạy.
- **Project Verification · bằng chứng kiểm thử**: Hub nhìn các file cấu hình ở thư mục gốc và đề xuất lệnh: `pyproject.toml` hoặc `pytest.ini` → `python -m pytest -q`; `package.json` → `npm test`; `Cargo.toml` → `cargo test`; `go.mod` → `go test ./...`; `Makefile` → `make test`. Hub **không** chạy gì khi chỉ đề xuất. **Run check** chạy sau khi bạn xác nhận ở hộp thoại của trình duyệt. Kết quả được lưu kèm exit code: **PASS** (exit 0), **FAIL**, **RUNNING**, hoặc **UNCONFIRMED** (Hub tắt giữa chừng nên không biết kết quả). Lịch sử này còn sau khi Hub khởi động lại. Nếu dự án dùng lệnh khác, hãy chạy thủ công ở ô lệnh phía trên hoặc bảo agent chạy (ở chế độ Review bạn sẽ được hỏi).

Quy tắc: **chỉ tin "đạt" khi bạn thấy exit code 0 do Hub ghi**, không phải khi model nói "đã đạt".

## 11. Các tab khác

- **Plan** — danh sách việc cần làm của phiên. Bạn thêm/sửa/xóa bước và đổi trạng thái (*todo, doing, done, blocked*), **Lưu plan**. Agent đọc cùng danh sách này. Mục **Research subagents** chạy phân tích chỉ đọc với model đã cấu hình (mỗi dòng một câu hỏi).
- **Skills** ("Project instructions") — hiển thị `AGENTS.md`, `SKILL.md`, `CLAUDE.md` và các hướng dẫn của repository mà agent nhìn thấy. Chúng được coi là **dữ liệu không tin cậy**: chỉ là gợi ý, không thể nâng quyền hay bỏ qua khung duyệt.
- **Hướng dẫn dự án tự động nạp** — đầu mỗi lượt chạy, Hub đọc `AGENTS.md`, `CLAUDE.md` và `.claude/CLAUDE.md` ở **thư mục gốc workspace** (theo thứ tự đó; không đọc thư mục con hay thư mục cha) và đưa vào chỉ dẫn của agent với giới hạn cứng **tối đa 8.192 byte**. Chỉ dẫn được gửi lại ở mọi yêu cầu của lượt chạy và lấy chỗ của lịch sử, nên Hub chỉ cho nó tối đa **10% lịch sử dự toán** của model (cộng 5% cho chỉ mục kỹ năng bên dưới; tổng không quá nửa phần còn lại trên ngưỡng 1.000 token, để chỉ dẫn không bao giờ là lý do khiến tác vụ hết chỗ): model có cửa sổ lớn nhận đủ 8.192 byte, cửa sổ 16.384 token nhận khoảng 1–2,5 KB, cửa sổ chưa biết được tính như 32.768 token (nên cũng nhận ít hơn mức tối đa), và khi chỉ còn sát ngưỡng thì không nạp gì. Phần không nạp vẫn đọc được bằng `read_file` (dòng cắt nói rõ cách), và dòng `instructions_loaded` nêu lý do hạ giới hạn kèm con số. Phần vượt quá bị cắt, kèm dòng ghi tên tệp và số byte đã cắt; tệp thứ hai hết chỗ thì được nêu là "không nạp". Nội dung là **dữ liệu không tin cậy** do chủ kho viết: nó không thể nâng quyền, bỏ qua khung duyệt hay đổi yêu cầu của bạn, kể cả khi nó tự nói như vậy. Hub không đọc tệp nằm ngoài workspace (liên kết/junction trỏ ra ngoài bị từ chối), tệp lớn hơn 256 KiB, tệp nhị phân hay không phải UTF-8; ký tự ẩn bị xóa, chuỗi giống khóa bị che. Dòng `instructions_loaded` trong tab Hoạt động cho biết đã nạp tệp nào, bao nhiêu byte, có bị cắt không (kèm sha256, không kèm nội dung). Cách bật/tắt: xem mục ngay dưới.
- **Bật/tắt hướng dẫn dự án** — **Cài đặt → Dự án → Hướng dẫn của dự án**: một ô chọn, lưu cùng dữ liệu Hub, áp dụng từ lượt chạy kế tiếp (lượt đang chạy giữ nguyên những gì đã nạp, nên đổi được cả khi có tác vụ đang chạy). Tắt chỉ có nghĩa là Hub không tự nạp: agent vẫn có thể tự mở `AGENTS.md`/`CLAUDE.md` bằng công cụ đọc tệp như mọi tệp khác. Chỉ kênh Model API dùng tính năng này (kênh ChatGPT Web thì không). Biến môi trường `CHATMCP_PROJECT_INSTRUCTIONS=off` (hoặc `on`; đọc khi Hub khởi động) **mạnh hơn** cài đặt: khi có biến, ô chọn bị khóa, hiện tên biến cùng lựa chọn đã lưu của bạn, và Hub từ chối thay đổi (`POST /api/agent/project-instructions` trả 409); bỏ biến rồi khởi động lại Hub để dùng lựa chọn của bạn. Dưới mỗi lượt đã xong có một dòng ghi nhận Hub đã nạp tệp nào (tên, kích thước, "cắt N byte" nếu bị cắt, hoặc "tắt") và model đã đọc kỹ năng nào theo yêu cầu. Đó là ghi nhận việc Hub đã làm, **không phải bằng chứng**: nạp vào chỉ dẫn không có nghĩa là model đã làm theo. `/api/state` có mục `projectInstructions` (`enabled`, `source` là `env`, `config` hoặc `default`, và `saved`).
- **Báo có bản mới và tải bộ cài** — một dải dưới thanh trên cùng hỏi **một lần** có muốn DatGold báo khi có bản phát hành mới không (**Có, kiểm tra** / **Không**); chưa trả lời thì DatGold không gửi yêu cầu nào. Khi bạn đồng ý, khoảng nửa phút sau khi Hub khởi động rồi khoảng 12 giờ một lần, Hub gửi hai chuỗi ngắn yêu cầu GET, bắt đầu ở github.com (nơi chuyển tiếp tới máy chủ tệp của GitHub, release-assets.githubusercontent.com): chuỗi thứ nhất lấy `RELEASE-MANIFEST.json` của bản ổn định mới nhất, chuỗi thứ hai lấy chữ ký của nó (`RELEASE-MANIFEST.json.sig`); các máy chủ đó thấy địa chỉ IP của bạn và dòng `DatGold/<phiên bản>`, không có gì khác về bạn. Có bản mới thì dải báo **Đã có DatGold x.y.z** kèm **Có gì mới** (trang ghi chú trên GitHub; trong ứng dụng desktop nó mở trong trình duyệt hệ thống, và nút **Sao chép** vẫn có để chép địa chỉ) và **Bỏ qua bản này**, và bên dưới là một trong các trạng thái: nút **Tải về (cỡ)** khi chữ ký của bản đó khớp với khóa công khai đi kèm ứng dụng; thanh tiến trình kèm **Hủy** khi đang tải; **Đã tải xong và đã kiểm tra** khi bộ cài đã về đủ (trong ứng dụng desktop kèm nút **Cài đặt và khởi động lại**, xem bên dưới); hoặc lý do không có nút (bản chưa được ký, chữ ký không khớp hay ký bằng khóa chưa biết, chưa đọc được hoặc chưa xem chữ ký trong lần chạy này — bấm **Kiểm tra ngay** —, hoặc bản phát hành không nêu đúng một bộ cài Windows mà DatGold chấp nhận). Bộ cài chỉ được tải khi **bạn bấm Tải về**: không tự tải, không tải sau một lần kiểm tra hay sau khi bạn đồng ý kiểm tra tự động, và tải được cả khi có tác vụ đang chạy. Hub lấy lại manifest của bản đó theo thẻ phát hành và kiểm lại chữ ký rồi mới tải; tên, cỡ và SHA-256 của bộ cài chỉ lấy từ manifest đã ký. Bộ cài được ghi dần vào thư mục `updates` trong dữ liệu Hub (mặc định `%LOCALAPPDATA%\ChatMCP\hub\updates\<phiên bản>\`; không giữ trong bộ nhớ), cần chỗ trống gấp đôi cỡ của nó, tối đa 2 GiB, và bị bỏ nếu im lặng 60 giây; nó được giữ lại **chỉ khi cỡ và SHA-256 đúng như manifest đã ký** (sai thì xóa và báo lỗi), cạnh một bản sao của manifest và chữ ký. **Cài đặt → Cập nhật** cho xem bản đang chạy, bản mới nhất đã biết, chữ ký, cỡ bộ cài, lần kiểm tra gần nhất, nút **Kiểm tra ngay** (luôn dùng được, tối đa một lần mỗi phút) và ô tự kiểm tra. **Cài đặt và khởi động lại** chỉ có trong ứng dụng desktop (trong trình duyệt thường chỉ có một dòng chỉ chỗ để làm việc đó) và chỉ hiện cho bộ cài đã tải xong và đã kiểm tra. Nút bị giữ lại, kèm lý do, khi còn tác vụ, terminal hay worker nền đang chạy. Bấm vào sẽ hỏi lại một lần ("DatGold sẽ đóng lại, cài phiên bản x.y.z rồi mở lại. Cài đặt và dự án của bạn nằm ngoài các tệp chương trình nên không bị thay thế."; con trỏ bàn phím nằm sẵn trên **Để sau**, và nếu lúc bạn đang cân nhắc có tác vụ bắt đầu chạy thì câu hỏi được rút lại và không tự quay lại), và **không có gì được cài hay chạy nếu bạn không bấm xác nhận**. Sau khi bạn xác nhận, ứng dụng tự kiểm lại tệp đã tải bằng mã của chính nó (chữ ký của manifest với khóa công khai gắn trong chương trình, cỡ và SHA-256 của bộ cài, và tên sản phẩm của bộ cài), hỏi lại Hub xem còn tác vụ nào đang chạy không, rồi đóng lại và chạy bộ cài; nếu có gì không khớp, ứng dụng không chạy gì và trang nói lý do, kèm nút **Đóng** để tắt lời báo và, khi bản đã tải không còn hoặc không qua được kiểm tra, nút **Tải lại** để Hub tải lại đúng bản đó. Nếu ứng dụng không trả lời kịp, trang nói rằng nó không biết cập nhật đã bắt đầu hay chưa (chứ không nói "chưa bắt đầu"). Vỏ cũng đọc trước các đối số theo cách bộ cài sẽ đọc, và chỉ đóng cửa sổ khi bộ cài còn chạy sau vài giây; bộ cài đã tự thoát thì chưa thay gì, cửa sổ ở lại và báo `launch_failed`. Trong lúc cài có một cửa sổ nhỏ "Updating DatGold to x.y.z" (không có nút nào và bạn không đóng được nó cho tới khi xong). Bộ cài đợi tối đa 30 giây cho ứng dụng đóng, từ chối bản không mới hơn bản đang cài hoặc khi thiếu chỗ trống, giữ các lối tắt bạn đang có (lối tắt bạn đã xóa vẫn không bị tạo lại), thay tệp trong một giao dịch có hoàn tác, rồi mở lại ứng dụng: bản mới nếu thành công; bản cũ nếu bị từ chối hay đã hoàn tác sạch; không mở gì khi bản cài dở cần khôi phục (khi đó DatGold không khởi động, và chạy lại `DatGoldSetup.exe` không giúp được vì bộ cài từ chối khi còn tệp `.chatmcp-update-pending.json`; cửa sổ cập nhật nói rõ điều này và cách khôi phục bằng tay nằm trong [WINDOWS-SETUP.md](WINDOWS-SETUP.md)). Lần mở sau, một dải báo **Đã cập nhật lên DatGold x.y.z** (kèm **Có gì mới**) hoặc lý do bản cập nhật không xong và phiên bản nào vẫn đang chạy; bấm **Đóng** để tắt. Bộ cài chỉ để lại ghi chú đó khi không có chương trình nào đang nghe cổng 3007: một lần từ chối chưa dừng gì (ví dụ vì còn tác vụ) chỉ được nói trong cửa sổ cập nhật, để không có lời báo cũ xuất hiện nhiều ngày sau. Bộ cài chưa có chữ ký Authenticode nên Windows có thể cảnh báo; chữ ký trên manifest chỉ cho biết manifest do người giữ khóa phát hành ký, và hiện chưa bản phát hành nào được ký nên nút **Tải về** chưa xuất hiện cho tới khi chủ dự án tạo khóa phát hành và ký một bản. **Chưa được thử trên máy thật:** cú bấm trong cửa sổ WebView2, một bản phát hành có chữ ký thật, một lần cài đè lên ứng dụng đang chạy với bộ cài 230 MB, và việc Windows (SmartScreen, Smart App Control) có cho vỏ chạy một bộ cài chưa ký do Hub ghi hay không; chỉ có kiểm thử tự động và lần chạy trên máy chủ CI dùng một lần.
- **Kỹ năng theo yêu cầu** — thay vì nhét toàn văn tối đa 4 kỹ năng vào mọi yêu cầu gửi model, hội thoại chỉ mang một **chỉ mục tối đa 4.096 byte** (mã, tên, một dòng mô tả). Chỉ mục và định nghĩa công cụ `skill_load` cùng nằm trong **5% lịch sử dự toán** của model, nên model có cửa sổ nhỏ nhận chỉ mục ngắn hơn; nếu không đủ chỗ cho công cụ thì chỉ các kỹ năng nhỏ được mang nguyên văn, kỹ năng còn lại bị bỏ và dòng `skills_activated` nói rõ bao nhiêu kỹ năng bị bỏ và vì sao. Kỹ năng nhỏ (từ 1 KiB trở xuống, như các kỹ năng Hub đi kèm) được mang nguyên văn trong chỉ mục; kỹ năng lớn hơn chỉ là một dòng "on demand" và model đọc toàn văn bằng công cụ `skill_load` khi cần — mỗi lần nạp tối đa 16 KiB, một lần cho mỗi lần gọi, đã che khóa bí mật, và không thể đổi quyền. Model không gọi `skill_load` vẫn nhận các kỹ năng nhỏ nhưng không nhận văn bản kỹ năng lớn. Tab Hoạt động ghi `skills_activated` và `skill_loaded` (có sha256 của văn bản đã gửi).
- **Code / LSP** — chỉ mục ký hiệu (Python AST; không chạy mã) với tìm *symbol* và *references theo tên*; và Language Server (Pyright / TypeScript) nếu bạn đã cài. Không bắt buộc.
- **Preview** — xem ứng dụng web đang chạy trên `localhost` trong khung cách ly. Hãy khởi động dev server ở Terminal trước, rồi nhập cổng.
- **Cài đặt** — thư mục (**Chọn thư mục**/**Áp dụng**; không đổi được khi agent đang chạy), nhà cung cấp AI, quyền, **AI mode** (API Gateway / ChatGPT Web cũ), giao diện (Sáng/Tối/Theo máy), **Tính năng trên máy này** (Docker sandbox, ConPTY, chỉ mục AST, Language Server — chỉ báo "Sẵn sàng" khi thật sự kiểm tra được), công cụ cục bộ (Khởi động/Dừng), Browser Companion (chỉ chế độ ChatGPT Web cũ), Windows host & sandbox, Phiên bản hệ thống.

## 12. Phiên, lịch sử, dữ liệu

- Mỗi hội thoại là một **phiên**. Chọn trong cột trái; tìm bằng ô "Tìm hội thoại…".
- **Báo cáo ↗** tải một bản ghi văn bản của phiên: ID, trạng thái, thư mục, model, thời gian, token, các yêu cầu, kết quả cuối, lỗi, thao tác chưa rõ kết quả và nhật ký gần nhất. Bí mật đã biết được che. Nội dung đầy đủ nằm trong `transcript.jsonl` của phiên.
- **Xóa phiên** xóa lịch sử của phiên *trong Hub* (có hỏi xác nhận, không hoàn tác được). Không đụng tới file dự án.
- Tất cả nằm ở thư mục dữ liệu của Hub (mặc định `%LOCALAPPDATA%\ChatMCP\hub`). Thư mục này chứa nội dung dự án mà agent đã đọc (trong transcript và đầu ra công cụ) — **coi như dữ liệu riêng tư**.

## 13. Quy trình làm việc đề xuất

1. Mở dự án bằng launcher; tạo nhánh mới: `git switch -c feature/ten-viec`; commit hoặc stash thay đổi đang dở.
2. Chế độ **Chỉ đọc**: *"Tìm hiểu dự án và đề xuất kế hoạch cho việc X. Chưa sửa gì."* Đọc kế hoạch; sửa ở tab Plan.
3. Chuyển sang **Review**: *"Thực hiện bước 1, 2. Chạy `pytest -q` sau mỗi bước."* Đọc từng khung duyệt.
4. Khi **Hoàn tất**: đọc dòng bằng chứng → **Xem thay đổi** → đọc diff → tự chạy lại kiểm thử ở tab Terminal nếu muốn chắc.
5. **Bạn** `git add`/`git commit` (hoặc yêu cầu agent commit, và đọc commit đó). `git push`/PR luôn do bạn quyết định.

## 14. Việc cần lưu ý (giới hạn đã biết)

Danh sách đầy đủ ở [SECURITY.md](../SECURITY.md). Các điểm người dùng hay gặp:

- Chữ của câu trả lời hiện **dần theo từng mảnh** với Chat Completions (OpenAI và các máy chủ tương thích), Anthropic Messages, Responses và Gemini (đường `streamGenerateContent`; một gateway Gemini tự đặt đường dẫn, hoặc đã phải chuyển sang kiểu yêu cầu tương thích, thì chữ hiện khi model trả xong từng lượt). Một luồng bị cắt giữa chừng không bao giờ được dùng: Hub bỏ phần dở, gửi lại đúng yêu cầu đó một lần không có luồng (không công cụ nào chạy từ phần dở) và nhớ rằng endpoint đó không stream được. Chữ hiện dần chưa qua bước che bí mật; chỉ bản lưu vào lịch sử được che.
- Che bí mật trong đầu ra là theo **mẫu** (đoán dạng key, `Bearer …`, `sk-…`…), không phải đảm bảo tuyệt đối.
- Bí mật đã bị commit vào lịch sử Git vẫn đọc được bằng `git log -p`.
- Nội dung file/README/issue trong dự án có thể chứa **chỉ dẫn độc hại nhắm vào agent** (prompt injection). Lớp phòng thủ là khung duyệt: hãy đọc kỹ lệnh trước khi cho phép, đặc biệt với repo lạ.
- Hub chỉ dành cho **một người dùng trên máy của chính bạn**, nghe ở `127.0.0.1`. Đừng mở cổng này ra Internet hay mạng chung. Xem [DEPLOYMENT.md](DEPLOYMENT.md).
- Chế độ ChatGPT Web là đường **cũ, thử nghiệm cục bộ**; bạn tự đăng nhập, Hub không đọc cookie hay phiên của bạn. Chế độ này tự động hóa trang ChatGPT dành cho người dùng cuối: đó không phải kênh do OpenAI cung cấp hay cho phép, có thể vi phạm Điều khoản sử dụng của OpenAI (tài khoản có thể bị cảnh báo hoặc đình chỉ) và đưa nội dung workspace vào lịch sử ChatGPT của bạn. DatGold che chuỗi giống bí mật theo cách nỗ lực tối đa, giữ lại nội dung file `.env`/khóa riêng khi lời gọi hoặc kết quả nêu tên chúng, và có tùy chọn **Xem lại trước khi gửi**; xem [ChatGPT Web Companion privacy](COMPANION-PRIVACY.md).

Gặp sự cố: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
