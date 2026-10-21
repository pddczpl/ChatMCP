# ChatMCP Studio — Hướng thiết kế giao diện

> **Trạng thái:** đang áp dụng cho bản làm mới giao diện sau v3.9.0 (nhánh `pddczpl/ux-refresh`). Thay thế bản đặc tả "Frontend Rebuild 2.4.0".
> **Nguyên tắc chủ đạo:** *Calm Precision* — bình tĩnh, chính xác, kiểm soát được — và một nguyên tắc mới: **báo xong khác với chứng minh xong**.
> **Nguồn sự thật:** mã trong `CHATMCP-HUB/ui/src` (token ở `src/index.css`). Tài liệu này giải thích *vì sao*; test ở `ui/tests` và `ui/e2e` giữ cho nó đúng.
> **Ảnh minh họa:** `design/screenshots/v3/` (tạo lại bằng `npm run gallery`, xem mục 9).

---

## 1. Vì sao làm lại

Kiểm tra giao diện của v3.9.0 bằng ảnh chụp thật (Hub thật, model giả lập, Chromium) cho thấy:

| Vấn đề | Hậu quả |
|---|---|
| **Theme sáng hỏng một nửa.** Khoảng 300 chỗ dùng màu Tailwind cố định (`bg-sky-500/10`, `text-rose-400`, `bg-slate-…`) thay vì token. | Thẻ, chip và ô nhập vẫn tối trên nền sáng; chữ nhạt khó đọc. |
| **Panel phải quá tải.** Hai tầng tab (Background tasks / Inspector), rồi 9 tab xếp hai dòng; Cài đặt, AI Model và Skills bị nhồi vào cột 440 px. | Khó tìm, khó dùng form dài, không còn chỗ cho hooks, MCP, receipts. |
| **Nhiễu thị giác.** Lẫn Việt–Anh ("This computer · Workspaces", "Role overrides"), ngày giờ kiểu Mỹ ("10/20/2026, 2:47 AM"), nhãn thô (`workspace_edit`), dòng số liệu kỹ thuật luôn hiện ở đầu hội thoại, nhãn 10–11 px viết hoa, hiệu ứng 3D/glow. | Mắt phải lọc nhiễu để thấy việc quan trọng. |
| **Ý "báo xong vs chứng minh xong" bị giấu** trong tab Kế hoạch. | Đúng thứ làm ChatMCP khác biệt (lộ trình P4–P7) lại không thấy ở chỗ người dùng nhìn. |

## 2. Triết lý

ChatMCP là một agent lập trình chạy trên mã nguồn thật, bằng quyền của người dùng. Cảm giác cần có là **bình tĩnh và đáng tin**, không phải hào nhoáng. Bốn ý dẫn đường:

1. **Bằng chứng trước tiên.** Mọi thứ agent *nói* được tách khỏi thứ hệ thống *ghi nhận*. Màu xanh lá chỉ có nghĩa "Hub đã xác minh", không bao giờ là "model báo xong".
2. **Hội thoại là nhân vật chính.** Cột đọc rộng tối đa 820 px; trạng thái nền (kết nối, quyền, model, ngữ cảnh) nằm ở thanh dưới cùng, không chen vào việc đang làm.
3. **An toàn đọc được trong một cái liếc.** Chế độ quyền hiện ở ô nhập và thanh trạng thái; FULL ACCESS có dải đỏ cố định dưới thanh trên cùng; thẻ phê duyệt nói rõ làm gì, ở đâu, rủi ro cỡ nào, thay đổi gì.
4. **Chỗ cho những gì sắp tới.** Cài đặt là trang riêng với danh sách mục mở rộng được; panel phải là một hàng tab; thanh trạng thái là danh sách mục. Hooks, MCP, receipts, duyệt diff theo hunk, plan mode đều có nơi để vào mà không phải dựng lại bố cục.

## 3. Hệ thống token

Một nguồn duy nhất: `src/index.css`. Component dùng tiện ích ngữ nghĩa (`bg-panel`, `text-muted`, `border-line`, `text-primary`, `bg-danger/10`…), được khai báo bằng `@theme inline` nên đổi theme lúc chạy không cần build lại, và đi cùng độ trong suốt (`/10`). Bảng màu mặc định của Tailwind bị tắt (`--color-*: initial`), nên một lớp như `text-sky-400` không tạo ra CSS.

### 3.1 Màu

| Token | Tối | Sáng | Dùng cho |
|---|---|---|---|
| `bg` | `#0b0e13` | `#f3f5f8` | nền ứng dụng, vùng đọc |
| `panel` | `#11151b` | `#ffffff` | header, sidebar, panel, thẻ |
| `surface` | `#171c24` | `#f6f8fb` | ô nhập, chip, hàng trong danh sách |
| `hover` / `active` | `#1e2530` / `#263040` | `#edf1f6` / `#e3e9f1` | rê chuột / đang chọn |
| `line-subtle` / `line` / `line-strong` | `#1a2029` / `#273040` / `#394558` | `#e9edf3` / `#d9e0ea` / `#bcc7d6` | viền |
| `text` / `muted` / `faint` | `#e9edf3` / `#a6b1c0` / `#8591a3` | `#0f1722` / `#475468` / `#5b6a82` | chữ chính / phụ / mờ |
| `primary` (+ `-hover`, `-fg`) | `#5aa9ff`, `#7bbcff`, `#06121f` | `#1763d8`, `#0f4fb2`, `#ffffff` | thương hiệu, liên kết, hành động chính, vòng focus |
| `accent` | `#38d2bd` | `#0b8a7a` | logo, chế độ Tự động (dùng rất ít) |
| `success` | `#3fd99b` | `#0b7a52` | **đã xác minh**, thành công |
| `warning` | `#f3b94d` | `#9a5a00` | **agent tự báo / chưa xác minh**, chú ý |
| `danger` (+ `-fg`) | `#ff7f8f`, `#1d0509` | `#c22d45`, `#ffffff` | lỗi, từ chối, FULL ACCESS |

**Nghĩa của màu, không đổi:** xanh dương là thương hiệu và focus; xanh lá = *bằng chứng được Hub xác minh*; vàng = *chưa có bằng chứng*; đỏ = *lỗi hoặc nguy hiểm*. Không dùng các màu này cho việc khác.

Độ tương phản đo từ chính token (và `ui/tests/design-tokens.test.mjs` giữ ngưỡng ở cả hai theme):

| Cặp | Tối | Sáng | Ngưỡng của test |
|---|---|---|---|
| chữ chính trên panel | 15,6 | 18,0 | ≥ 10 trên mọi nền |
| chữ phụ (`muted`) trên panel | 8,4 | 7,7 | ≥ 6 |
| chữ mờ (`faint`) trên panel / surface | 5,7 / 5,4 | 5,5 / 5,2 | ≥ 4,5 |
| `primary`, `success`, `warning`, `danger` trên panel | 7,5–10,3 | 5,4–5,6 | ≥ 4,5 |
| chữ trên nút `primary` | 7,7 | 5,5 | ≥ 4,5 |

### 3.2 Chữ, khoảng cách, góc

- **Font:** Inter Variable (tự host), JetBrains Mono cho mã. Nội dung đọc (tin nhắn, mã) 15 px / 1,72; giao diện 13–14 px; **không dùng cỡ dưới 12 px** cho thứ cần đọc (chỉ phím tắt `Kbd` 11 px). Test chặn lớp `text-[8–11px]`.
- **Không viết hoa** nhãn tiếng Việt; nhãn nhóm là câu thường 12 px, màu `faint`.
- **Ngày giờ** theo ngôn ngữ giao diện, đồng hồ 24 giờ (`lib/format.ts`): `20/10/2026 14:47`, "5 phút trước", `842 ms`, `12k` token.
- **Góc:** điều khiển 8 px (`rounded-lg`), thẻ 12 px (`rounded-xl`), hộp thoại 16 px (`rounded-2xl`), chip tròn đầy. Viền 1 px, không bóng đổ trừ lớp nổi (popover, hộp thoại, toast: `--shadow-pop`).
- **Chuyển động:** ngắn và đơn giản (`anim-pop`, `anim-rise`, 140–180 ms). Đã bỏ hiệu ứng nghiêng 3D và quầng sáng. `prefers-reduced-motion` tắt hết; `forced-colors` giữ focus nhìn thấy.

### 3.3 Cổng chống tái phát

`ui/tests/design-tokens.test.mjs` fail khi: có lớp màu Tailwind cố định, có mã màu hex trong component (ngoại lệ duy nhất: nền trắng của khung Preview), có `bg-[var(--…)]` thay cho tiện ích ngữ nghĩa, có chữ dưới 12 px, còn lớp hiệu ứng 3D, hoặc hai theme không khai báo cùng một bộ token.

## 4. Kiến trúc màn hình

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Header 48 px: [☰] ChatMCP · 📁 workspace ▾ · ⎇ nhánh ▾      [🔍 Tìm kiếm hoặc chạy lệnh  Ctrl K]      ☀  ⚙  ▯ │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ (dải đỏ cố định khi FULL ACCESS bật)                                                      │
├────────────┬───────────────────────────────────────────────┬─────────────────────────────┤
│ Sidebar    │ Hội thoại                                     │ Work panel                  │
│ Workspace  │  Tiêu đề · trạng thái · thời gian · [Dừng]     │ Tiến độ · Thay đổi · Tệp ·  │
│  └ chat    │  tin nhắn · chuỗi công cụ · thẻ phê duyệt      │ Terminal · Tác nhân · ⋯     │
│            │  ▸ Dải bằng chứng                              │ (⋯: Hoạt động, Xem trước)   │
│            │  Ô nhập: [chế độ] 📎 [profile]        [Gửi]    │                             │
├────────────┴───────────────────────────────────────────────┴─────────────────────────────┤
│ Status bar 28 px: ● Hub · ⎇ nhánh · kênh        Ngữ cảnh · model · chế độ quyền · phiên bản │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Header** chỉ có thứ dùng liên tục: bật/tắt panel (`Ctrl B`, `Ctrl J`), nơi đang làm việc (workspace, nhánh), tìm kiếm/lệnh (`Ctrl K`), theme, Cài đặt (`Ctrl ,`). Báo mất kết nối Hub hiện ở đây khi có sự cố.
- **Thanh trạng thái** chỉ hiện dữ liệu thật của Hub: kết nối, nhánh (chấm vàng khi có thay đổi chưa commit), kênh ChatGPT Web Companion (khi dùng), cửa sổ ngữ cảnh (dấu `~` = ước tính), model, chế độ quyền, phiên bản. Mỗi mục mở đúng trang của Cài đặt. Không có mục giữ chỗ cho tính năng chưa có.
- **Sidebar:** workspace → hội thoại, thời gian tương đối, nút xóa chỉ hiện khi rê chuột/focus.
- **Work panel:** một hàng tab, chữ thuần (không icon), tab đang chọn có gạch chân; `Hoạt động` và `Xem trước` (dùng ít hơn) nằm dưới `⋯` và tự hiện thành tab khi được chọn; bàn phím `←/→/Home/End`. Không còn tầng "Background tasks / Inspector": tác vụ nền là tab **Tác nhân**, và tab này có thanh chuyển mục riêng (**Công việc nền** · **Nhóm trợ lý** · **Sửa mã**, mục 5.5): một `tablist` thứ hai nằm *trong* tab, kiểu nút phân đoạn (không phải hàng tab thứ hai), cùng phím `←/→/Home/End` (`lib/tab-keys.ts` dùng chung với hàng tab của panel); tên các mục không trùng tên tab nào của panel.
- **Cài đặt** là hộp thoại toàn trang (native `<dialog>`: focus nằm trong, `Esc` đóng) với menu trái: Dự án · Mô hình AI · Quyền & thực thi · Kênh agent · Kỹ năng · Phân tích mã · Giao diện & ngôn ngữ · Thông tin & dữ liệu. Thêm mục mới = thêm một phần tử vào `SECTIONS` (`components/settings/SettingsView.tsx`). Toast hiện *bên trong* hộp thoại khi nó đang mở (chỉ có một toast tại mọi thời điểm). Hộp xác nhận FULL ACCESS cũng là native modal nên mở được *phía trên* Cài đặt.
- **Bảng lệnh** (`Ctrl K`): câu thường, nhóm theo việc (hội thoại, quyền, đi tới, cài đặt, giao diện), mục đang chọn bằng bàn phím được tô sáng.
- **Hướng dẫn khởi động:** 3 bước (thư mục → mô hình → quyền) với bước đã xong đánh dấu rõ.
- **Màn hình hẹp:** dưới 1100 px sidebar và work panel thành lớp phủ; ô nhập dùng container query để ẩn bớt nhãn thay vì xuống dòng.

## 5. Điểm nhấn

### 5.1 Dải bằng chứng (`ProofStrip`, `lib/proof.ts`)

Dưới câu trả lời của một lượt có sửa file hoặc chạy lệnh, một dải nói rõ lượt đó là *được báo xong* hay *được chứng minh xong*, **chỉ từ những gì Hub ghi nhận** (lời gọi công cụ, kiểm tra đã chạy, kết quả xác minh của chính Hub), không bao giờ từ lời của model.

| Trạng thái | Màu | Điều kiện |
|---|---|---|
| Có lỗi trong lượt này | đỏ | lượt `failed`, có công cụ báo lỗi, hoặc có kiểm tra thất bại |
| Đã nghiệm thu | xanh | chủ máy đã xác nhận các tiêu chí bằng bằng chứng còn mới (`completionOutcome.requirements = verified`) |
| Kiểm tra đã được xác minh | xanh | có ít nhất một kiểm tra mà Hub tự xác minh kết quả (`testOutcomeVerified`), và không còn thiếu bằng chứng; lời ghi chú nhắc rằng điều này *chưa* chứng minh mọi yêu cầu |
| Chưa xác minh đầy đủ | vàng | Hub còn liệt kê bằng chứng thiếu (`verificationOutcome.ready = false`) |
| Lệnh chạy xong, chưa xác minh kết quả test | vàng | mã thoát 0 nhưng kết quả test chưa được xác minh |
| Chưa có bằng chứng kiểm tra được ghi nhận | vàng | có sửa file/chạy lệnh nhưng Hub không ghi nhận kiểm tra nào |
| *(không hiện)* | — | lượt chỉ đọc và trả lời |

**Bài học đã ghi vào mã:** `verificationOutcome.ready` của Hub *cũng bằng true khi không có yêu cầu xác minh nào* ("No complex task graph required"), nên nó không bao giờ tự làm dải thành xanh. `ui/tests/proof.test.mjs` và hai bài e2e (`studio.spec.mjs`) giữ điều đó.

### 5.2 Thẻ phê duyệt

Tiêu đề (đang chờ / đã quyết), mức rủi ro bằng chữ (Thấp / Trung bình / Cao, `lib/tool-labels.ts`), đếm ngược tới lúc tự từ chối, mô tả, tên công cụ, "Phân loại rủi ro: Sửa tệp trong workspace", đường dẫn, lệnh hoặc diff có nền tô màu, chi tiết gập lại, rồi hai nút. Quyết định từ chối cần xác nhận lần hai. Cố ý **không** gán Enter/Esc toàn cục cho phê duyệt: Enter đang dùng để gửi tin nhắn.

### 5.3 Chuỗi công cụ

Mỗi đoạn công cụ giữa hai tin nhắn gập thành một dòng ("Đọc 2 tệp · sửa 1 tệp · chạy 1 lệnh"); mở ra là từng việc bằng lời ("Sửa tệp calc.js", thời lượng, trạng thái), tên kỹ thuật (`local.edit_file`) nằm ở tooltip và nhãn truy cập.

### 5.4 Chế độ quyền

Bốn chế độ (Chỉ đọc, Review, Tự động, FULL ACCESS) chọn ở ô nhập hoặc Cài đặt; chế độ hiện tại luôn thấy ở thanh trạng thái. FULL ACCESS cần gõ đúng cụm từ, có dải đỏ cố định và một nút "Quay về Review".

### 5.5 Tab Tác nhân: giao việc cho trợ lý và worker sửa mã

`OrchestratorTab` (gắn lại từ P1-G) là hai mục của tab Tác nhân: `AgentGroups` (nhóm trợ lý **chỉ đọc**: AI tự chia việc hoặc bạn tự chia) và `CodingWorkers` (worker sửa mã, mỗi việc một nhánh Git và một worktree riêng). Dùng token, mọi chuỗi qua `t()` (`lib/i18n-agents.ts` và `lib/i18n-agents-sections.ts`, vi và en, có test đối chiếu khóa và chỗ giữ `{tham_số}`), không còn `confirm()`/`prompt()`: hộp thoại xác nhận là `<dialog>` native, hành động nguy hiểm đòi gõ đúng cụm (`INTEGRATE WORKTREES`, `PUBLISH DRAFT PR`, `REVIEW INTERRUPTED RUN`). Mục **Công việc nền** (`BackgroundTasks` và thẻ workflow `WorkflowCard`, thẻ này cũng hiện trong hội thoại) cũng qua từ điển: tiếng Việt giữ nguyên từng chữ (e2e khớp theo chữ của nó), tiếng Anh có đủ chữ, kể cả nhãn, tooltip và thông báo; số ít/số nhiều có khóa `_one`/`_other`; trạng thái của một task đọc từ khóa `agents_bg_state_*` (`taskStateText`), có test ghim chữ Việt bằng `taskStateLabel` của `lib/task-view.ts`. `tests/agents-strings.test.mjs` quét cả hai tệp. Dải tiêu đề của hội thoại (`PhaseRibbon`) và banner của hội thoại đã dừng (`StateBanner`) gọi tên trạng thái bằng cùng bộ chữ ấy nên cũng qua từ điển (khóa `agents_ribbon_*` và `agents_banner_*`; các dòng dưới "Chi tiết" nằm trong hàm `ribbonRows` để test được cả hai ngôn ngữ); `tests/state-banner-ribbon.test.mjs` ghim chữ Việt của chúng, `agents-strings` quét cả hai tệp, và chữ do chính Hub viết (`task.error`, ghi chú xác minh) vẫn hiện nguyên văn (mục 8). Màn hội thoại (`ConversationView`) và thanh bên (`SessionSidebar`) cũng qua từ điển (khóa `agents_conv_*` và `agents_side_*`, ở phần đầu từ điển vì là mã của màn đầu tiên): thông báo, hộp xác nhận, nhãn, tooltip, và hai câu mà màn tự viết thay bạn (nút Tiếp tục/Thử lại gửi câu "Tiếp tục tác vụ trong cùng cuộc hội thoại…", gửi chỉ có tệp thì câu "Hãy phân tích tệp/ảnh đính kèm."; ở màn tiếng Anh cả hai là tiếng Anh, vì chúng hiện trong hội thoại như lời của bạn). Tiếng Việt giữ nguyên từng chữ: `tests/conversation-screen.test.mjs` hiển thị cả hai tệp rồi gọi chính các hàm xử lý của chúng (toast, `window.confirm`, câu gửi đi) bằng một Hub giả, ở cả hai ngôn ngữ; `agents-strings` quét cả hai tệp.

**Báo xong khác với chứng minh xong, cho worker.** Một worker là một model: `summary` của nó là lời của nó, nằm trong khối **Báo cáo của AI**, tách khỏi **dòng bằng chứng** (`lib/agent-proof.ts`, giữ bởi `tests/agent-proof.test.mjs`, `tests/coding.test.mjs`, `e2e/orchestrator.spec.mjs`):

| Dòng bằng chứng | Màu | Điều kiện (chỉ từ bản ghi của Hub) |
|---|---|---|
| Hub đã xác minh kiểm tra | xanh | bạn yêu cầu kiểm thử (`verifyRequired`), Hub kết thúc vòng xác minh bằng `ready_for_review`, và lần thử mới nhất của **mọi** check đều do Hub xác minh (`testOutcomeVerified`); ghi chú nhắc rằng chưa chứng minh mọi yêu cầu |
| AI báo xong · Hub chưa xác minh | vàng | worker `ready_for_review` nhưng thiếu một trong các điều kiện trên (không có lần thử nào, `exit 0` không đủ, vòng xác minh chưa xong, không yêu cầu kiểm thử) |
| Có kiểm tra thất bại | đỏ | lần thử mới nhất của một check thất bại, dù trước đó đã có lần đạt |
| Cần bạn kiểm tra · Công việc không hoàn tất | vàng · đỏ | `needs_attention`/`blocked`/`interrupted`/trạng thái lạ · `failed` |
| Đang làm việc · Đã dừng · Không có thay đổi | trung tính | đang chạy trong lượt mà Hub đang chạy · `cancelled`, hoặc worker còn "đang chạy/đang chờ" trong lượt **không còn chạy** (đã dừng, hỏng, Hub khởi động lại: trạng thái đã lưu không phải trạng thái đang chạy) · `no_changes` |
| Chờ bạn cho phép kiểm thử | vàng | `awaiting_test_grant` trong lượt đang chạy: Hub chờ khoảng 90 giây sau khi AI xong; hết hạn thì worker dừng ở `needs_attention` và thay đổi **chưa commit** nằm trong bản làm việc riêng (thẻ worker ghi đường dẫn) |
| AI báo cáo · Hub chưa kiểm chứng | trung tính | kết quả của nhóm trợ lý chỉ đọc: không bao giờ xanh |

Từ trạng thái của một lượt chạy hay một bản gộp (`completed`, `ready_for_review`, `verified`, `published`...) không bao giờ tô xanh; chỉ `failed` là đỏ và các trạng thái cần bạn là vàng (`statusTone`). Thông báo khi lượt chạy kết thúc là thông tin, không phải "thành công". Xuất bản và gộp bị khóa đến khi bạn đọc diff của chính nhánh đó (token duyệt của Hub), mỗi lượt chạy chỉ gộp một lần, và Hub chỉ gộp lượt đang `ready_for_review` hoặc `partial_failure` (lượt đã dừng hay hỏng: tab nói lý do ngay cạnh nút, không chỉ làm nút xám). Token duyệt khóa theo `worker:<id>` hoặc `merge` nên một worker tên `integration` không đụng bản gộp. Nhóm trợ lý mà Hub lưu "đang chạy" khi không có gì chạy là lượt bị cắt ngang: hiện **Bị gián đoạn** (vàng), không hiện là đang làm việc.

Ảnh: `design/screenshots/v3/agents-coding-evidence.png` (worker "AI báo xong · Hub chưa xác minh", vàng, báo cáo của AI tách riêng), `agents-groups-report.png` (nhóm trợ lý: báo cáo trung tính), `agents-narrow-600.png` (cửa sổ 600 px), `agents-english-light.png` (tiếng Anh, giao diện sáng). Chụp lại bằng `npx playwright test e2e/orchestrator.spec.mjs` (ảnh nằm ở `test-results/`) hoặc `npm run gallery`.

**Việc Hub sẽ từ chối được nói trước.** Sửa mã chỉ chạy ở chế độ quyền **Tự động** (Hub trả 403 ở chế độ khác): tab nói rõ chế độ hiện tại và có nút tới Cài đặt → Quyền. Hub cũng từ chối (409) khi agent chính đang làm việc, khi một nhóm trợ lý đang chạy, khi một lượt sửa mã đang chạy (với phân tích) và khi kết nối AI đang đổi: mỗi lý do là một dòng thông tin trung tính (không phải lỗi) và nút bắt đầu tắt (`codingBlock`, `analysisBlock`, `groupBlock` trong `lib/agent-proof.ts`, có test thứ tự lý do). Giao việc chỉ làm trên *thư mục chính* của Hub: khi panel đang xem thư mục khác, form của hai mục tắt và nêu hai thư mục; gộp, tạo bản nháp, ghi nhận lượt bị gián đoạn, cho phép kiểm thử và cả đọc diff, đọc tệp, xem nhật ký khôi phục cũng tắt (Hub chỉ đọc lượt của thư mục chính nên mọi lời gọi đó đều bị từ chối; nút **Dừng** vẫn dùng được). Mục **Sửa mã** chỉ hiện lượt của thư mục đang xem (mục *Lượt của thư mục nào* bên dưới). Form kiểm tra id, phụ thuộc, vòng lặp và độ dài trước khi bấm bắt đầu (`lib/agent-draft.ts`). Bảng kiểm thử cần cho phép chỉ hỏi worker đã yêu cầu kiểm thử, của lượt đang chạy (chỉ các worker đó đang có test broker và là đường Hub chờ bạn), nói rõ Hub chờ khoảng 90 giây; danh sách check của Hub không cho biết quyền nào đã cấp, nên trang giữ câu trả lời của Hub khi bạn cho phép (tối đa số lần chạy và hạn dùng) và hiện "Đã cho phép: tối đa N lần trong Windows Sandbox, đến HH:MM" cho tới khi hết hạn; "đã cho phép" không phải "đã đạt": kết quả chỉ hiện ở mục đã ghi nhận khi Hub chạy xong. Chữ đang gõ giữ lại khi sang tab khác (`store/useAgentDrafts.ts`, trong bộ nhớ, không ghi đĩa).

**Lượt của thư mục nào, và lời của Hub.** Hub giữ lượt sửa mã của mọi thư mục nó từng làm trong một danh sách (tối đa 20). `GET /api/studio/coding` trả `workspace` cho từng lượt: đúng chuỗi Hub báo cho thư mục chính của nó (`hub.workspace.path`) và cũng là chuỗi nó so (`!==`) trước khi đọc, gộp hay xuất bản một lượt; Hub luôn ghi thư mục của lượt (từ bản đầu tiên của lớp này), chỉ chưa báo ra; một bản ghi hỏng không có thư mục báo `null`. Đó là đường dẫn thư mục dự án của chính chủ máy, chuỗi trang đã có từ `/api/state` (tuyến vẫn sau bearer): không phải loại thông tin mới. Mục **Sửa mã** chỉ hiện lượt của thư mục đang xem (`runsOfFolder` trong `lib/agent-proof.ts`, so khớp chính xác như Hub: khác cách viết là thư mục khác) và nói còn bao nhiêu lượt thuộc thư mục khác; khi đang xem thư mục khác, lượt của thư mục chính nằm trong số bị ẩn và dòng ghi chú nêu thư mục chính. Lượt của thư mục đang xem mà Hub đã rời đi là một bản ghi để xem: đọc, gộp, bản nháp đều tắt kèm một dòng giải thích. Bảng kiểm thử chỉ nhận lượt đang hiện, và trang chờ trạng thái Hub trước khi xếp lượt vào thư mục nên không tuyên bố danh sách trống quá sớm. Câu của Hub không còn nằm trong `summary` của worker: `summary` là lời của model (khối **Báo cáo của AI** đúng nghĩa), còn Hub ghi `verificationNote: { code, text, detail? }` với bốn mã `no_checks`, `grant_timeout`, `blocked`, `verified`. Tab dịch theo mã (hai ngôn ngữ; mã lạ hiện nguyên `text` của Hub, ghi chú `blocked` mất lý do cũng vậy) và hiện cạnh dòng bằng chứng với nhãn **Ghi chú của Hub**, chữ thường, không bao giờ mang màu bằng chứng. Ghi chú `verified` chỉ lặp lại điều dòng bằng chứng nói nên chỉ hiện khi `assessWorker` cũng ra `verified` (`hubNoteOf`): sau một commit hỏng, một lần Hub khởi động lại, một lần thử sau thất bại hay một lần thử Hub chưa xác minh, nó không hiện. Lý do của `blocked` là chữ của vòng kiểm thử nên giữ nguyên tiếng Anh. `tests/agent-errors.test.mjs` giữ danh sách mã Hub gửi bằng danh sách mã tab biết dịch.

**Đọc diff và lời của AI.** Diff chia dòng theo vị trí (`diff --git` đặt lại, tiêu đề tệp chỉ có trước hunk đầu, trong hunk mọi dòng bắt đầu bằng khoảng trắng, `+` hoặc `-`), nên dòng xóa có nội dung `-- ghi chú` vẫn là dòng xóa. Ký tự nhìn không thấy nhưng đổi cách đọc (ghi đè chiều chữ, khoảng trắng độ rộng 0, ký tự điều khiển) trong diff, bản xem trước tệp và báo cáo của AI hiện thành dấu `‹U+202E›` và một dòng giải thích (`lib/hidden-chars.ts`; dấu thay chính ký tự nên hiệu ứng đổi chiều cũng mất; ZWJ/ZWNJ hợp lệ trong emoji ghép hay vài hệ chữ, và BOM ở đầu tệp, cũng hiện dấu: chấp nhận vài báo động giả hơn là bỏ sót; áp dụng cả cho tab **Thay đổi** vì dùng chung `DiffView`). Vùng cuộn của diff và của tệp là `region` có tên, nhận focus bằng bàn phím.

**Bàn phím và trình đọc màn hình.** Hộp thoại xác nhận gắn cụm phải gõ vào tên của ô nhập và quy tắc (nút chỉ bật khi khớp) vào mô tả của nó; khi đóng, focus về nút đã mở, hoặc về tiêu đề của mục nếu nút đó đã thành "đang chạy". Mở một bản xem diff/tệp đưa focus vào nó, đóng thì trả về đúng nút đã mở; xóa một dòng công việc đưa focus tới "Thêm công việc". Lỗi nhập liệu là *mô tả* của ô (`aria-describedby`), không phải `role="alert"` (sẽ bị đọc lại ở mỗi phím gõ). Lỗi từ Hub nói bằng ngôn ngữ trên màn hình theo `error.code` (`lib/agent-errors.ts`); mã chưa có câu thì hiện nguyên văn của Hub.

**Hai mục tải khi mở.** `AgentGroups` và `CodingWorkers` là hai chunk riêng, tải lần đầu khi bạn mở tab của mục (`OrchestratorTab.tsx` dùng `React.lazy`, `LazySection.tsx` giữ phần chờ và phần lỗi); nhờ vậy màn hình đầu không mang theo hai mục này (số liệu ở mục 7). Trong lúc chờ, vùng của mục mang tên mục và chứa một dòng `role="status"` ("Đang tải mục này…"), còn thanh chuyển mục vẫn dùng được bằng phím nên chờ một chunk chậm không giữ ai lại. Nếu trình duyệt không lấy được tệp (trang đã cũ so với các tệp Hub đang phát sau khi build lại, hoặc mất kết nối), mục hiện một cảnh báo kèm nút **Tải lại trang** thay vì để React gỡ cả ứng dụng, còn các tab khác vẫn chạy. Chỉ đúng lỗi tải đó bị bắt (`SectionLoadError`); lỗi khác trong một mục đi lên như trước khi mục là lazy, không bị gọi nhầm là "không tải được". `IsolatedChecksPanel` (tab Tiến độ) và `DiffView` (tab Thay đổi) vẫn nằm trong tệp vào vì hai tab đó import chúng. Test: server render không đợi được một script, nên test đơn vị render từng mục riêng (`agents.test.mjs`, `coding.test.mjs`); `agents-lazy.test.mjs` kiểm tra dòng chờ ở lần render đầu, mục thay dòng chờ khi script đã tới, và (bằng một lần bundle thật có chia chunk) hai mục không nằm trong thứ màn hình đầu nạp; `lazy-section.test.mjs` kiểm tra phần lỗi; `e2e/agents-lazy.spec.mjs` kiểm tra trong trình duyệt thật với CSP của Hub.

**Chuỗi của hai mục đi cùng hai mục.** Từ điển của tab chia làm hai phần. `lib/i18n-agents.ts` (cùng `lib/i18n.ts`) nạp với màn hình đầu và chứa mọi chuỗi mà một thành phần của màn hình đầu hỏi tới: nhãn tab và dòng chờ hoặc lỗi của mục, tên vai trò và trạng thái, câu trả lời cho mã lỗi của Hub, bảng kiểm thử của tab Tiến độ, ghi chú ký tự ẩn. `lib/i18n-agents-sections.ts` chứa 202 chuỗi mỗi ngôn ngữ mà chỉ hai mục hỏi tới và nạp cùng chunk của chúng: mô-đun này tự thêm chuỗi vào từ điển (`addTranslations`) khi được nạp, và mọi mô-đun của hai mục có hỏi tới chuỗi ấy đều import nó, nên một mục (hay một phần của mục được render riêng) có chữ ngay lần render đầu; chuỗi của cả hai ngôn ngữ nằm cùng chỗ nên đổi ngôn ngữ khi đang mở mục là tức thì. Chuỗi mới: vào `i18n-agents.ts` nếu một thành phần của màn hình đầu dùng nó, vào `i18n-agents-sections.ts` nếu chỉ hai mục dùng. Đặt sai phần thì test bắt, cả hai chiều (`tests/i18n-split.test.mjs`; danh sách mô-đun của màn hình đầu lấy từ một lần bundle thật có chia chunk, không viết tay): chuỗi mà màn hình đầu hỏi tới nhưng nằm ở phần sau sẽ hiện khóa thô cho tới khi mở một mục, còn chuỗi chỉ hai mục hỏi tới nhưng nằm ở phần đầu làm nặng tệp vào. `e2e/agents-lazy.spec.mjs` và `e2e/orchestrator.spec.mjs` kiểm trong trình duyệt thật rằng chunk chung (có chuỗi) không được tải cho màn hình đầu và không mục nào hiện khóa thô, ở cả hai ngôn ngữ.

## 6. Lộ trình hạ cánh ở đâu trong giao diện (dự kiến)

Bảng này là kế hoạch chỗ đặt, không phải danh sách đã làm: mục "Hooks", mục "MCP", nút xuất gói bằng chứng, duyệt diff theo hunk và plan mode **chưa tồn tại**. Điều đã có là chỗ để chúng vào (`SECTIONS`, hàng tab, danh sách mục của thanh trạng thái, các trạng thái của dải bằng chứng) mà không phải làm lại bố cục.

| Hạng mục lộ trình | Chỗ trong giao diện |
|---|---|
| P1 hooks (PreToolUse/PostToolUse, Stop), `agent_results`, lỗi provider | mục "Hooks" mới trong `SECTIONS`; dòng hook trong tab Hoạt động; kết quả của `agent_results` vào thẻ worker và khối báo cáo của tab **Tác nhân** (OrchestratorTab đã gắn lại, mục 5.5); lỗi provider ở dải trạng thái hội thoại |
| P1 cửa sổ ngữ cảnh | thanh trạng thái ("Ngữ cảnh", `~` = ước tính) + hàng "Chi tiết" của đầu hội thoại; cảnh báo cửa sổ chưa rõ giữ ở hội thoại |
| P2 MCP client | mục "MCP" trong Cài đặt (máy chủ, công cụ, allow-list); công cụ ngoài hiện trong chuỗi công cụ với nguồn gốc |
| P4–P5 Receipt v2, `acceptance.yml`, done-gate, gói evidence | **dải bằng chứng** và tab **Tiến độ** (tiêu chí, receipt, hash cây file); nút "Xuất gói bằng chứng" cạnh "Xem bằng chứng" |
| P5 sổ egress Companion | mục "Kênh agent" (đã có thẻ xem lại trước khi gửi) + danh sách những gì đã gửi |
| P8 duyệt diff theo hunk, rollback | tab **Thay đổi** (đã có DiffView theo dòng; thêm duyệt theo hunk); hộp thoại phê duyệt dùng cùng DiffView |
| P8 i18n lint | `lib/i18n.ts` + `lib/format.ts`; phần giao diện mới đã đi qua `t()` hoặc `lang`, phần cũ còn chuỗi cứng (xem mục 8) |
| P9 plan mode | tab **Tiến độ** (kế hoạch cần duyệt) và chế độ thứ năm trong menu quyền |
| Files tab, PTY, onboarding (D7) | tab **Tệp**, tab **Terminal**, hướng dẫn khởi động (đã làm lại) |

## 7. Truy cập và hiệu năng

- Độ tương phản như mục 3.1; vòng focus 2 px (`--focus`) ở mọi điều khiển; hộp thoại là `<dialog>` native; hàng tab là `tablist` thật (`aria-selected`, `aria-controls`, phím mũi tên); trạng thái không chỉ bằng màu (luôn có chữ hoặc nhãn).
- Giảm chuyển động và chế độ tương phản cao của Windows được tôn trọng.
- Ngân sách: JS khởi tạo = **239,166 byte gzip** (≈ 239 KB) trên ngân sách 260 KB, còn dư khoảng 20.8 KB. Đo bằng `gzip -c web/dist/assets/index-*.js | wc -c` trên bản build dựng từ đầu: đó là tệp `index.html` nạp (chỉ một tệp `index-*.js`), và tên tệp nằm trong tiêu đề gzip (nén từ stdin ra ít hơn 18 byte). Lịch sử: 254,689 byte khi tab Tác nhân còn nằm hết trong tệp vào (dư khoảng 5 KB), 246,808 sau khi hai mục thành chunk lazy, 239,166 sau khi chuỗi chỉ hai mục dùng đi theo hai mục; bản chưa có tab Tác nhân (main 4054e69) là khoảng 231.8 KB, nên tab còn thêm khoảng 7.3 KB vào tệp vào (trước đó khoảng 15 KB, và khoảng 23 KB trước nữa). Phần còn lại là những gì tab Tiến độ và tab Thay đổi dùng chung (`IsolatedChecksPanel`, `DiffView`) và 85 chuỗi mỗi ngôn ngữ mà màn hình đầu hỏi tới (`lib/i18n-agents.ts`). Tính cả hai chunk thư viện được tải kèm (`radix` 15,048 và `icons` 9,929 byte) thì JS khởi tạo là 264,143 byte (trước đó 271,785, và 279,666 trước nữa). CSS = 10,007 byte gzip, không đổi.
- Hai mục của tab Tác nhân là chunk riêng, chỉ tải khi mở tab của mục (mục 5.5): `AgentGroups` 3,495 + `CodingWorkers` 6,226 + chunk chung `agent-draft` 11,032 byte gzip. Chunk chung gồm `ConfirmDialog`, `agent-parts`, `agent-draft.ts` (2,654 byte) và từ điển của hai mục (`lib/i18n-agents-sections.ts`: 202 chuỗi mỗi ngôn ngữ, khoảng 8.4 KB), nên mở nhóm trợ lý tải 14.5 KB, mở sửa mã 17.3 KB, cả hai 20.8 KB (trước khi tách từ điển: 6.1, 8.9 và 12.4 KB). Người không mở mục nào bớt 7.6 KB ở màn hình đầu; người mở cả hai tải thêm 8.4 KB, một lần. Chuỗi nén kém hơn khi nằm riêng trong chunk 11 KB so với trong tệp 800 KB, nên tệp vào nhẹ đi 7.6 KB còn chunk nặng thêm 8.4 KB.
- Tách từ điển: hai cách đã được đo bằng bản dựng thật của hai bản thử (đã bỏ), rồi chọn một. (a) Cả từ điển tiếng Anh (phần nền và phần Tác nhân) thành một script chỉ tải khi ngôn ngữ là English: tệp vào 239,419 byte (nhẹ đi 7,389) nhưng script tiếng Anh nặng 9,072 byte, nên người dùng English tải 248,491 byte trước khi vẽ màn hình đầu (nhiều hơn 246,808 của trước khi tách), phải đợi script đó khi mở ứng dụng với ngôn ngữ đã lưu và khi đổi ngôn ngữ trong Cài đặt (`translations` không phải state của React, chuỗi tới muộn không vẽ lại gì), và mọi test đọc `translations.en` phải sửa. (b) Chuỗi chỉ hai mục dùng đi cùng hai mục: tệp vào 239,166 byte (nhẹ đi 7,642), lợi cho cả hai ngôn ngữ và không đổi đường khởi động. Chọn (b). Làm thêm (a) lên trên (b) cho tệp vào khoảng 235.3 KB (script tiếng Anh còn 5,227 byte) nhưng người dùng English trả thêm một request trước khi vẽ: chưa làm, đó là bước kế tiếp nếu cần thêm chỗ.
- Không có request ra ngoài domain, không telemetry; CSP của Hub (`script-src 'self'; style-src 'self'`) vẫn đúng: chunk lazy là script cùng nguồn, trong HTML không có style nội tuyến, và `e2e/agents-lazy.spec.mjs` ghi `securitypolicyviolation` khi mở cả hai mục mà không có gì bị từ chối.

## 8. Chưa làm / giới hạn đã biết

- **Chuỗi tiếng Việt cứng còn lại** ở các panel chưa làm lại hẳn (`IntelligenceTab`, `ModelProfilesPanel`, `SkillsTab`, `PreviewTab`; `OrchestratorTab` và mục "Công việc nền" của tab Tác nhân đã làm xong, mục 5.5); chúng đã dùng token, đã đạt độ tương phản và cỡ chữ, nhưng bố cục bên trong là bản cũ. Lint i18n thuộc P8.
- **Thanh trạng thái chưa có thước đo ngữ cảnh đang dùng**: Hub chỉ báo cửa sổ cấu hình và ngân sách lịch sử, chưa báo số token đang chiếm. Hiện hiển thị đúng những gì có, không vẽ thước giả.
- **Cửa sổ ngữ cảnh chưa rõ (P1-C)**: cảnh báo `ContextPolicyNotice` (`data-testid="context-window-warning"`) nằm ngay dưới thanh tiêu đề hội thoại, nói tên chỗ sửa là "Cài đặt → Mô hình AI" và có nút "Mở cài đặt" tới đúng trường. Hàng "Cửa sổ ngữ cảnh" trong "Chi tiết" và thanh trạng thái ghi "chưa rõ", không còn chữ "ước tính" im lặng. Các trường mới của profile (đường dẫn tùy chỉnh, header, cửa sổ) dùng token như phần còn lại nhưng bố cục trong panel vẫn là bản cũ.
- **Tab Tác nhân, giới hạn đã biết (P1-G).** Đã sửa: (1) lượt không ghi thư mục của nó và (3) câu của Hub nằm trong `summary` của worker: Hub nay trả `workspace` cho từng lượt và `verificationNote` riêng, tab chỉ hiện lượt của thư mục đang xem và gắn đúng nhãn cho từng loại lời (xem 5.5, mục *Lượt của thư mục nào, và lời của Hub*). Lượt đã lưu trước thay đổi đó không bị viết lại: thư mục của chúng vẫn đúng (Hub luôn ghi, chỉ chưa báo ra) nên chúng hiện đúng chỗ, nhưng `summary` của chúng vẫn mang câu của Hub trong khối "Báo cáo của AI". Còn lại: (2) Token duyệt chỉ sống trong lần mở tab: rời tab rồi quay lại phải đọc diff lại (an toàn, hơi phiền). (4) Bước cho phép kiểm thử với Windows Sandbox thật và việc tạo bản nháp trên GitHub thật chưa được thử (chỉ có test đơn vị và hộp thoại). (5) Bảng "Kiểm thử cần bạn cho phép" ở tab Tiến độ (không truyền `run`) vẫn theo lượt đang chạy hoặc lượt mới nhất của Hub bất kể thư mục đang xem; và khi model không nói gì, `summary` của một worker thất bại là lỗi của runner chứ không phải lời của model. (6) Một mục không tải được thì chỉ tải lại cả trang mới lấy lại được: React giữ kết quả bị từ chối của chunk nên mở lại mục vẫn gặp lỗi đó, và chưa có nút "thử lại" riêng cho một chunk. (7) Chuỗi của hai mục nằm chung một chunk cho cả hai ngôn ngữ, nên mở mục lần đầu tải thêm khoảng 8.4 KB trong đó khoảng một nửa (ngôn ngữ kia) không dùng tới; tách theo ngôn ngữ buộc phải tải thêm khi đổi ngôn ngữ giữa chừng nên chưa làm.
- **Mục "Công việc nền", giới hạn đã biết.** (1) Thẻ workflow vẫn hiện các chữ tiếng Anh sẵn có ("Workflow running", "3/3 completed", "Phases") ở màn tiếng Việt, vì `agents.spec.mjs` khớp theo "3/3 completed"; Việt hóa cần sửa spec đó. (2) Các nút dừng và mở nói lỗi bằng từ điển chỉ khi Hub trả mã lỗi mà `lib/agent-errors.ts` biết; lỗi khác hiện nguyên lời của Hub (có thể là tiếng Việt ở màn tiếng Anh), và chưa có e2e nào gây ra lỗi đó. (3) Trạng thái `preparing` không có chữ ở cả hai ngôn ngữ (hiện nguyên chữ Hub). (4) `StateBanner` và `PhaseRibbon` đã qua từ điển (khóa `agents_banner_*` và `agents_ribbon_*`, tên trạng thái bằng `taskStateText`; chữ Việt không đổi một chữ, có `tests/state-banner-ribbon.test.mjs` ghim). Còn lại là chữ do chính Hub viết, hiện nguyên văn: `task.error` (khi bạn bấm Dừng, Hub ghi "Đã dừng theo yêu cầu. Tác vụ chưa được xác nhận hoàn tất.", nên banner của hội thoại đã dừng ở màn tiếng Anh có tiêu đề và nút bằng tiếng Anh nhưng một câu tiếng Việt), ghi chú của hàng "Yêu cầu chưa xác minh" và danh sách của hàng "Kiểm tra còn thiếu"; muốn hết cần Hub trả mã và tham số (bản ghi đã có `errorCode`) để giao diện chọn câu. `ConversationView` và `SessionSidebar` đã qua từ điển (mục 5.5; giới hạn của chúng ở mục kế).
- **Màn hội thoại và thanh bên, giới hạn đã biết.** (1) Lời của chính Hub vẫn hiện nguyên văn ở màn tiếng Anh: câu từ chối trong toast (ví dụ "Hub đang bận hoặc chưa thể khóa workspace."), `task.handoff.note` và `task.error`. Hai tệp này không dùng `agentErrorText`, vì câu cho mã lỗi trong từ điển (`agent_error_*`) viết cho tab Tác nhân (`workspace_missing` nói "thư mục dự án Git", sai với một cuộc chat chưa có thư mục) và dùng chúng cũng đổi chữ Việt của toast; muốn hết cần Hub trả mã và tham số cho từng route. (2) Các thành phần mà hai tệp dựng lên nhưng không nằm trong chúng vẫn còn chữ Việt cứng ở màn tiếng Anh: thẻ gói chờ gửi sang ChatGPT (`OutboundReviewCard`), thẻ phê duyệt (`ApprovalStack`; các spec Playwright khớp theo tên nút tiếng Việt của nó), `Composer` (nhãn, placeholder lúc đang chạy, nút đính kèm, nút "Chờ task"), `MessageItem` và `CopyButton` ("Bạn", "Sao chép"), `ModelProfilePicker`, `ToolActivityGroup` ("Có lỗi"), `Toast` ("Đóng thông báo"), và bốn câu gợi ý của `EmptyState`: tiêu đề và mô tả đã dịch, nhưng câu được gửi đi khi bấm là tiếng Việt ở cả hai ngôn ngữ. (3) Ở màn tiếng Anh, nút Tiếp tục/Thử lại và việc gửi chỉ có tệp gửi cho model câu tiếng Anh (Hub không phản ứng theo chữ của câu; công cụ và chín kỹ năng của Hub được chọn y như với câu tiếng Việt; kỹ năng riêng của người dùng có từ khóa tiếng Anh có thể phản ứng khác); muốn đảo lại chỉ cần đặt giá trị tiếng Anh của `agents_conv_continue_prompt` và `agents_conv_files_prompt` về câu tiếng Việt. (4) "ChatGPT Web (text-only)", "Model profile: …" và tên kênh vốn là tiếng Anh ở cả hai màn hình nên giữ nguyên; ô nhập thư mục thủ công có chữ mẫu `F:\\Personal_Project\\Vin\\ChatMCP` (đường dẫn của chính người viết, hai dấu `\` vì thuộc tính JSX không xử lý escape) hiện cho mọi người dùng. (5) Câu hỏi xóa hội thoại đếm cả các đoạn nối của cùng hội thoại (sau khi đổi kênh) như "subagent". (6) Chỉ có test đơn vị ghim, chưa có e2e: quyết định xem lại gói gửi ChatGPT (cần Companion), dừng workflow, khôi phục URL ChatGPT, "Đang trả lời…", "Về nội dung mới nhất ↓", dòng đang tải, thông báo lỗi khi chọn thư mục và biểu mẫu nhập thư mục thủ công.
- Đã kiểm trên Chromium (Playwright); WebView2 thật được kiểm bằng `e2e/webview2-smoke.mjs`.

## 9. Kiểm tra và chụp lại

```sh
cd CHATMCP-HUB/ui
npm run build          # web/dist
npm run test:unit      # token, độ tương phản, dải bằng chứng, định dạng, nhãn công cụ, component
npm run test:e2e:built # luồng thật: Hub thật, model giả lập, Chromium
npm run gallery        # ảnh chụp mọi màn hình (test-results/gallery; gồm các mục của tab Tác nhân), thất bại nếu trang ghi lỗi console
```
