# Hướng dẫn sử dụng ChatMCP Studio

## Current React UI

**Layout.** The top bar has the sessions toggle, the workspace and branch, search (**Ctrl K**), the light/dark toggle, **Cài đặt** (**Ctrl ,**) and the work-panel toggle (**Ctrl J**). The left column lists conversations per workspace. The right **work panel** has one row of tabs: **Tiến độ** (plan and evidence), **Thay đổi** (Git diff and checkpoints), **Tệp**, **Terminal**, **Tác nhân** (background tasks, agent groups and code edits) and, under **⋯**, **Hoạt động** and **Xem trước**. The bar at the bottom shows the Hub connection, the branch, the agent channel, the context window, the model and the permission mode; each of those opens the matching page of Settings. **Cài đặt** is a page of its own (project, AI model, permissions and execution, agent channel and Companion, skills, code intelligence, appearance and language, about); **Esc** closes it. While **FULL ACCESS** is on, a red strip under the top bar says so and offers one click back to Review.

**The Agents tab (Tác nhân).** A row of three buttons at its top switches between **Công việc nền** (what runs in the background; the tab opens here), **Nhóm trợ lý** and **Sửa mã**. It is a real tab list: the arrow keys, **Home** and **End** move between the sections, like the row of work-panel tabs above it. What you have typed in its forms is kept while you look at another tab.

- **Nhóm trợ lý** hands a goal to *read-only* helpers. **Bắt đầu phân tích** lets the AI split your request between 1–5 helpers; **Tự chia việc cho từng trợ lý** lets you choose roles, tasks and order yourself (1–8 helpers, at most 3 at once). A helper searches the project, sends the excerpts it finds to your configured AI provider (which bills the usage) and writes a report. Helpers cannot edit files, run commands or push anything, and each run first asks **Cho phép và bắt đầu**. What comes back sits under **Báo cáo của AI** and is marked *Hub chưa kiểm chứng*: the Hub does not check it and it is never shown in green. Open the files it cites. The tab says when the Hub would refuse a start (the main agent working, a coding run, another group, a change of the AI connection), and a group the Hub saved as running while nothing runs is shown as *Bị gián đoạn*.
- **Sửa mã** lets AI workers change code, each on its own Git branch and working copy (a Git worktree), never on your checkout. It needs the permission mode **Tự động**; in another mode the tab says so and **Mở cài đặt quyền** takes you to the setting. Describe a goal and choose **Đề xuất chia công việc** (without **Cho AI đề xuất cách chia việc** no model is asked: bullet lines become tasks), edit the 1–4 tasks (order, and **yêu cầu bằng chứng kiểm thử** if you want the Hub to run an isolated check: that needs Windows Sandbox and a registered Node test, and after the AI finishes the Hub waits about 90 seconds for you to allow the test in **Kiểm thử cần bạn cho phép**; without that the worker stops as *Cần bạn kiểm tra* and its changes stay uncommitted in its own working copy, whose path its card shows), then **Bắt đầu sửa mã** and confirm. Before you click, the tab says when the Hub would refuse a start: the permission mode, the main agent working, a group of helpers running. A worker ends as *Chờ bạn duyệt*: that means it committed something, not that the work is right. Its card keeps these apart: what the Hub recorded (status, branch, changed files, the evidence line), the Hub's own words beside the evidence line (**Ghi chú của Hub**, why it could not verify: it found no supported test to run, you did not allow the checks in time, or the checks kept failing; for a worker whose run stopped with an error, **Lý do công việc dừng, Hub ghi nguyên văn**, the Hub's record of why, quoted as it wrote it: it may be in Vietnamese, quote your AI provider, or hold the model's own refusal, and for the reasons this tab knows (you stopped it, a time or step limit, a rejected API key, a rate limit, an empty reply, a refusal) a line above it says what the reason means in the language on screen, without replacing it; and, for a long task with several steps that the Hub could not back with a check or a Git diff it recorded itself, **Ghi chú của Hub lúc AI báo xong, nguyên văn**, the sentence the Hub adds to the AI's answer (*ChatMCP has NOT independently verified full completion* and what is missing; in English as the Hub wrote it; it was written when the AI reported done, so it can stand beside a green line for a check the Hub ran afterwards); and, when a Stop-type hook of yours kept objecting until its eight blocks ran out, **Ghi chú của Hub về hook vẫn phản đối, ghi lúc lượt chạy kết thúc, nguyên văn**, the note the Hub wrote when it let the task complete anyway (in English as the Hub wrote it; it is not part of the AI's report); all of them are plain text, never green) and **Báo cáo của AI**, the AI's own summary, which is exactly what the AI said when it finished (a worker whose model said nothing has no AI report at all). The evidence line stays amber (*AI báo xong · Hub chưa xác minh*) until the Hub has run and verified a check for that worker; only then, and only if you asked for verification, is it green (*Hub đã xác minh kiểm tra*), and even then read the diff. **Xem thay đổi** shows the exact diff from Git and unlocks **Tạo bản nháp trên GitHub**; **Xem nội dung tệp** is a local preview that is not sent to the AI. **Gộp các công việc đã chọn** merges the ticked workers into one new branch (you type **INTEGRATE WORKTREES**; your main branch is not changed) and **Đưa bản gộp lên GitHub** opens a draft pull request (you type **PUBLISH DRAFT PR**); both need you to have read the diff first, and merging happens once per run, and only for a run that is ready for review or partly failed. A worker of a run that was stopped or interrupted is shown as *Đã dừng*, never as still working. When a diff, a file preview or an AI report holds characters nobody can see (direction overrides, zero-width marks, control characters), they are shown as markers such as ‹U+202E› and a line says so. When the Hub refuses something for a reason this tab knows (a review that is out of date, a run that is not ready to merge, the Hub being busy, the permission mode), the tab says why in the language on screen; any other refusal shows the Hub's own message, which may be in the other language.
- Delegated work acts on the Hub's own project folder. While another workspace is shown, the forms of both sections are switched off and say which folder they would act on; the **Dừng** buttons keep working. **Sửa mã** lists only the runs of the folder in view and says how many belong to other folders (the Hub keeps the runs of every folder it has worked on in one list and records which folder each belongs to). The Hub reads, merges and publishes only the runs of its own folder, so a run of the folder in view that the Hub has since left is shown as a record, with reading, merging and drafts switched off. A run whose record names no folder (a damaged record) is counted, not shown.

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

Tab trình duyệt đổi tiêu đề thành **"(n) Cần duyệt — ChatMCP Studio"** khi agent đang chờ bạn, và **"Đang chạy — …"** khi agent làm việc, để bạn nhận ra từ cửa sổ khác.

## 3. Thiết lập lần đầu (4 bước)

Lần đầu mở, một hộp thoại **"Chào mừng đến ChatMCP Studio"** hiện ra. Bạn có thể **Bỏ qua, thiết lập sau**, đóng bằng `Esc`, hoặc mở lại: Cài đặt → **Thiết lập nhanh** → **Mở trình hướng dẫn** (hoặc `Ctrl+K` → "Hướng dẫn thiết lập").

1. **Thư mục dự án.** Nhập đường dẫn (ví dụ `F:\Projects\my-app`) rồi **Dùng thư mục này**, hoặc bấm **Chọn thư mục…**. Hãy chọn *thư mục gốc của repository* bạn muốn làm việc.
2. **Kết nối AI.** Chọn nhà cung cấp, dán API key, bấm **Lưu & kiểm tra**. Xem mục 4.
3. **Quyền của agent** ("Agent được làm gì mà không hỏi?"). Chọn *Chỉ đọc*, *Review* (khuyến nghị) hoặc *Tự động*. Đổi được bất cứ lúc nào bằng công tắc cạnh ô nhập yêu cầu.
4. **Sẵn sàng làm việc.** Một danh sách kiểm tra (thư mục, AI + tình trạng tool calling, quyền) và hai yêu cầu mẫu **chỉ đọc**: *Tìm hiểu dự án*, *Chạy kiểm thử*. Bấm **Bắt đầu dùng**.

**Lời khuyên**: lần đầu hãy thử *Tìm hiểu dự án* ở chế độ Review. Bạn sẽ thấy agent chỉ đọc, và sẽ thấy cách khung duyệt hoạt động khi nó cần chạy lệnh.

## 4. Kết nối một model

Mở ở Cài đặt → **Nhà cung cấp AI** (cùng một form với bước 2 của hướng dẫn).

| Trường | Ý nghĩa |
|---|---|
| **Nhà cung cấp** | Preset điền sẵn giao thức, địa chỉ và model: Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, DeepSeek, Groq, Mistral, Ollama (máy cục bộ), LM Studio (máy cục bộ), và ba tùy chọn "Khác" cho gateway tương thích OpenAI / Anthropic / Gemini. Chọn **Tự nhập thủ công** nếu không có preset phù hợp |
| **Giao thức** | Anthropic Messages · OpenAI-compatible (chat completions) · Gemini generateContent |
| **Base URL** | Phải bắt đầu bằng `https://` (hoặc `http://localhost…` cho máy chủ cục bộ) |
| **Model** | Gõ tên model. **Tải danh sách model** hỏi nhà cung cấp danh sách model của tài khoản (cần lưu cấu hình trước) |
| **API key** | Chỉ gửi tới Base URL ở trên. Để trống = giữ key đang lưu. Máy chủ cục bộ (Ollama, LM Studio) không cần key |
| **Ghi nhớ key trên máy này** | Bật: key được mã hóa và lưu (Windows DPAPI). Tắt: key chỉ ở trong bộ nhớ Hub và **mất khi Hub dừng** |
| **Dùng key từ biến môi trường …** | Dùng `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`… nếu Hub thấy; không lưu vào file |
| **Nâng cao** | Kiểu xác thực (`auto`, `bearer`, `google-key`), đường dẫn endpoint tùy chỉnh, **Ngữ cảnh model (token)** (4.096 đến 2.000.000; để trống là chưa biết: Hub tính theo ước lượng 32.768 và hiện cảnh báo trên mỗi tác vụ) |

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

- Hub **không có streaming**: câu trả lời hiện khi model trả xong từng lượt.
- Che bí mật trong đầu ra là theo **mẫu** (đoán dạng key, `Bearer …`, `sk-…`…), không phải đảm bảo tuyệt đối.
- Bí mật đã bị commit vào lịch sử Git vẫn đọc được bằng `git log -p`.
- Nội dung file/README/issue trong dự án có thể chứa **chỉ dẫn độc hại nhắm vào agent** (prompt injection). Lớp phòng thủ là khung duyệt: hãy đọc kỹ lệnh trước khi cho phép, đặc biệt với repo lạ.
- Hub chỉ dành cho **một người dùng trên máy của chính bạn**, nghe ở `127.0.0.1`. Đừng mở cổng này ra Internet hay mạng chung. Xem [DEPLOYMENT.md](DEPLOYMENT.md).
- Chế độ ChatGPT Web là đường **cũ, thử nghiệm cục bộ**; bạn tự đăng nhập, Hub không đọc cookie hay phiên của bạn. Chế độ này tự động hóa trang ChatGPT dành cho người dùng cuối: đó không phải kênh do OpenAI cung cấp hay cho phép, có thể vi phạm Điều khoản sử dụng của OpenAI (tài khoản có thể bị cảnh báo hoặc đình chỉ) và đưa nội dung workspace vào lịch sử ChatGPT của bạn. ChatMCP che chuỗi giống bí mật theo cách nỗ lực tối đa, giữ lại nội dung file `.env`/khóa riêng khi lời gọi hoặc kết quả nêu tên chúng, và có tùy chọn **Xem lại trước khi gửi**; xem [ChatGPT Web Companion privacy](COMPANION-PRIVACY.md).

Gặp sự cố: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
