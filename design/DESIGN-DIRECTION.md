# DatGold Studio — Hướng thiết kế giao diện

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
| **Ý "báo xong vs chứng minh xong" bị giấu** trong tab Kế hoạch. | Đúng thứ làm DatGold khác biệt (lộ trình P4–P7) lại không thấy ở chỗ người dùng nhìn. |

## 2. Triết lý

DatGold là một agent lập trình chạy trên mã nguồn thật, bằng quyền của người dùng. Cảm giác cần có là **bình tĩnh và đáng tin**, không phải hào nhoáng. Bốn ý dẫn đường:

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
│ Header 48 px: [☰] DatGold · 📁 workspace ▾ · ⎇ nhánh ▾      [🔍 Tìm kiếm hoặc chạy lệnh  Ctrl K]      ☀  ⚙  ▯ │
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
- **Work panel:** một hàng tab, chữ thuần (không icon), tab đang chọn có gạch chân; `Hoạt động` và `Xem trước` (dùng ít hơn) nằm dưới `⋯` và tự hiện thành tab khi được chọn; bàn phím `←/→/Home/End`. Không còn tầng "Background tasks / Inspector": tác vụ nền là tab **Tác nhân**, chỉ gồm danh sách **Công việc nền** (mục 5.5; hai mục **Nhóm trợ lý** và **Sửa mã** từng nằm trong tab này đã được gỡ ngày 2026-10-25), nên tab không có thanh chuyển mục. Phím `←/→/Home/End` của hàng tab dùng `lib/tab-keys.ts`.
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

### 5.5 Tab Tác nhân: công việc nền

Tab **Tác nhân** chỉ có danh sách **Công việc nền**: các task và subagent mà agent giao trong lúc bạn trò chuyện (`BackgroundTasks` và thẻ workflow `WorkflowCard`, thẻ này cũng hiện trong hội thoại), nhóm theo thư mục và hội thoại, có bộ lọc, trạng thái của từng task, nút **Mở đúng hội thoại** và **Dừng task**. `InspectorPanel` gắn thẳng `BackgroundTasks` vào tab; không còn thanh chuyển mục. Dùng token, mọi chuỗi qua `t()` (`lib/i18n-agents.ts` và `lib/i18n.ts`, vi và en, có test đối chiếu khóa và chỗ giữ `{tham_số}`): tiếng Việt giữ nguyên từng chữ (e2e khớp theo chữ của nó), tiếng Anh có đủ chữ, kể cả nhãn, tooltip và thông báo; số ít/số nhiều có khóa `_one`/`_other`; trạng thái của một task đọc từ khóa `agents_bg_state_*` (`taskStateText`), có test ghim chữ Việt bằng `taskStateLabel` của `lib/task-view.ts`. `tests/agents-strings.test.mjs` quét các tệp của tab. Dải tiêu đề của hội thoại (`PhaseRibbon`) và banner của hội thoại đã dừng (`StateBanner`) gọi tên trạng thái bằng cùng bộ chữ ấy nên cũng qua từ điển (khóa `agents_ribbon_*` và `agents_banner_*`; các dòng dưới "Chi tiết" nằm trong hàm `ribbonRows` để test được cả hai ngôn ngữ); `tests/state-banner-ribbon.test.mjs` ghim chữ Việt của chúng, `agents-strings` quét cả hai tệp, và chữ do chính Hub viết (`task.error`, ghi chú xác minh) vẫn hiện nguyên văn (mục 8). Màn hội thoại (`ConversationView`) và thanh bên (`SessionSidebar`) cũng qua từ điển (khóa `agents_conv_*` và `agents_side_*`, ở phần đầu từ điển vì là mã của màn đầu tiên): thông báo, hộp xác nhận, nhãn, tooltip, và hai câu mà màn tự viết thay bạn (nút Tiếp tục/Thử lại gửi câu "Tiếp tục tác vụ trong cùng cuộc hội thoại…", gửi chỉ có tệp thì câu "Hãy phân tích tệp/ảnh đính kèm."; ở màn tiếng Anh cả hai là tiếng Anh, vì chúng hiện trong hội thoại như lời của bạn). Tiếng Việt giữ nguyên từng chữ: `tests/conversation-screen.test.mjs` hiển thị cả hai tệp rồi gọi chính các hàm xử lý của chúng (toast, `window.confirm`, câu gửi đi) bằng một Hub giả, ở cả hai ngôn ngữ; `agents-strings` quét cả hai tệp.

**Đã gỡ ngày 2026-10-25, theo yêu cầu của chủ máy (hai mục đó khó hiểu với người dùng).** Tab từng có thêm hai mục để bạn tự giao việc: **Nhóm trợ lý** (helper chỉ đọc: AI tự chia việc hoặc bạn tự chia) và **Sửa mã** (worker sửa mã, mỗi việc một nhánh Git và một worktree riêng, có xem diff, gộp nhánh và xuất bản nháp PR trên GitHub). Chỉ phần giao diện bị gỡ: các route của Hub (`/api/studio/dynamic-delegates/*`, `/api/studio/delegates/*`, `/api/studio/coding/*`, `/api/studio/workflow`), các lớp phía Hub và test của chúng giữ nguyên, nên giao diện không còn nút nào để bắt đầu một nhóm trợ lý hay một lượt sửa mã (route vẫn gọi được bằng API), còn công cụ `spawn_agent`/`spawn_workflow` của agent là cơ chế khác và chạy như trước. Mã của hai mục nằm trong lịch sử Git nếu sau này cần thiết kế lại cho dễ hiểu hơn. Các trường Hub vẫn ghi cho mỗi worker (`workspace`, `verificationNote`, `runnerError` và `runnerErrorCode`, `runnerNotice`, `runnerHookNotice`) giữ nguyên; giao diện không còn hiện chúng (xem `docs/THREAT-MODEL.md`, K13 và C52).

**Bảng kiểm thử cần bạn cho phép** (`IsolatedChecksPanel`, hiện ở tab **Tiến độ**) còn lại, vì Hub vẫn chờ bạn cho phép lệnh kiểm thử của một worker đã yêu cầu kiểm thử, kể cả lượt bắt đầu qua API. Bảng chỉ hỏi worker đã yêu cầu kiểm thử của lượt đang chạy (chỉ các worker đó đang có test broker và là đường Hub chờ bạn), nói rõ Hub chờ khoảng 90 giây; danh sách check của Hub không cho biết quyền nào đã cấp, nên trang giữ câu trả lời của Hub khi bạn cho phép (tối đa số lần chạy và hạn dùng) và hiện "Đã cho phép: tối đa N lần trong Windows Sandbox, đến HH:MM" cho tới khi hết hạn; "đã cho phép" không phải "đã đạt": kết quả chỉ hiện ở mục đã ghi nhận khi Hub chạy xong, và chỉ nói "Hub đã xác minh" khi `testOutcomeVerified` là true. Khi panel đang xem thư mục khác, nút cho phép tắt (Hub chỉ đọc lượt của thư mục chính; `delegationTarget` trong `lib/agent-proof.ts`). Quyền đã cho giữ trong bộ nhớ khi bạn sang tab khác (`store/useCheckGrants.ts`, không ghi đĩa).

**Đọc diff.** Ký tự nhìn không thấy nhưng đổi cách đọc (ghi đè chiều chữ, khoảng trắng độ rộng 0, ký tự điều khiển) trong diff hiện thành dấu `‹U+202E›` và một dòng giải thích (`lib/hidden-chars.ts`; dấu thay chính ký tự nên hiệu ứng đổi chiều cũng mất; ZWJ/ZWNJ hợp lệ trong emoji ghép hay vài hệ chữ, và BOM ở đầu tệp, cũng hiện dấu: chấp nhận vài báo động giả hơn là bỏ sót; áp dụng cho tab **Thay đổi** qua `DiffView`). Lỗi từ Hub nói bằng ngôn ngữ trên màn hình theo `error.code` (`lib/agent-errors.ts`); mã chưa có câu thì hiện nguyên văn của Hub.

## 6. Lộ trình hạ cánh ở đâu trong giao diện (dự kiến)

Bảng này là kế hoạch chỗ đặt, không phải danh sách đã làm: mục "Hooks", mục "MCP", nút xuất gói bằng chứng, duyệt diff theo hunk và plan mode **chưa tồn tại**. Điều đã có là chỗ để chúng vào (`SECTIONS`, hàng tab, danh sách mục của thanh trạng thái, các trạng thái của dải bằng chứng) mà không phải làm lại bố cục.

| Hạng mục lộ trình | Chỗ trong giao diện |
|---|---|
| P1 hooks (PreToolUse/PostToolUse, Stop), `agent_results`, lỗi provider | mục "Hooks" mới trong `SECTIONS`; dòng hook trong tab Hoạt động; kết quả của `agent_results` hiện như mọi kết quả công cụ khác trong hội thoại (tab **Tác nhân** chỉ còn danh sách công việc nền, mục 5.5); lỗi provider ở dải trạng thái hội thoại |
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
- Ngân sách: JS khởi tạo = **255,208 byte gzip** (≈ 255 KB) trên ngân sách 260 KB, còn dư khoảng 4.8 KB. Đo bằng `gzip -c web/dist/assets/index-*.js | wc -c` trên bản build dựng từ đầu (dựng ba lần, 26 tệp giống hệt từng byte): đó là tệp `index.html` nạp (chỉ một tệp `index-*.js`), và tên tệp nằm trong tiêu đề gzip (nén từ stdin ra ít hơn 18 byte). Lịch sử, đều đo cùng cách: bản chưa có tab Tác nhân (main 4054e69) là 231,834 byte; 254,689 khi tab Tác nhân còn nằm hết trong tệp vào (P1-G riêng lẻ); 246,808 sau khi hai mục thành chunk lazy và 239,166 sau khi chuỗi chỉ hai mục dùng đi theo hai mục (hai con số này đo trên cây riêng của từng nhánh); 252,398 trên bản gộp đợt 2 trước lượt gộp cuối; 246,710 sau khi gộp thêm màn hội thoại, thanh bên, banner và dải giai đoạn qua từ điển cùng việc tách từ điển; 248,686 sau khi gộp thêm chuỗi lỗi của runner (27 câu theo mã nằm ở phần từ điển nạp cùng màn hình đầu: `lib/agent-errors.ts` nạp cùng màn hình đầu và dựng khóa `agent_error_` + mã, nên `tests/i18n-split.test.mjs` từ chối chúng ở phần của hai mục); 248,703 sau khi runner ghi lại nơi lời của model kết thúc và thẻ worker có thêm dòng ghi chú hook; 250,401 sau khi phần còn lại của màn hội thoại (thẻ gói ChatGPT, thẻ phê duyệt, ô soạn tin, nút sao chép, chọn profile, nhóm công cụ, thông báo, màn hình đầu) đi qua từ điển (87 chuỗi mỗi ngôn ngữ); 250,991 sau khi thanh trên cùng, thanh trạng thái, dải FULL ACCESS và bộ chọn nhánh Git đi qua từ điển cùng chữ "Xong" của hai dòng công cụ (24 chuỗi mỗi ngôn ngữ); 253,736 sau khi hộp thoại FULL ACCESS, sáu mục của Cài đặt (Giới thiệu, Kênh agent, Giao diện, Code Intelligence, Quyền, Thư mục dự án), bảng lệnh, màn thiết lập, các thông báo của biểu mẫu AI và của Inspector và nhãn trạng thái của tab Tệp đi qua từ điển (182 chuỗi mỗi ngôn ngữ, từ 161 lên 343 khóa); 253,634 sau khi việc hạ FULL ACCESS chuyển sang cờ `leaveFullAccess` của Hub (bảng lệnh không còn tự đọc trạng thái nữa); 255,432 sau khi ô mức suy luận (thinking effort) vào form kết nối AI và hồ sơ model (thành phần `ReasoningEffortField`, các hàm chọn mức và 17 khóa từ điển mỗi ngôn ngữ, từ 343 lên 360 khóa); 256,730 sau khi ô Model của form kết nối AI và của hồ sơ model thành `ModelField` (ô nhập thuần cho tới khi chunk bộ chọn tới, xem bullet dưới), ghi chú cửa sổ ngữ cảnh lấy từ danh mục model (2 khóa trong `lib/i18n.ts`, từ 360 lên 362) và nhãn "ước tính" cùng chú thích của dải giai đoạn (3 khóa trong `lib/i18n-agents.ts`); 256,890 sau các sửa của hai lượt rà soát bộ chọn (tiêu điểm khi bấm nút duyệt, cuộn danh sách vào khung nhìn, phím đang dành cho bộ gõ, danh sách của tài khoản gắn với kết nối, câu hỏi model-info chỉ gửi khi trả lời được); 257,395 sau khi ghi chú dưới ô cửa sổ biết lý do Hub dừng ở mốc đổi giá của model (hai khóa từ điển mỗi ngôn ngữ trong `lib/i18n.ts`, và hàm `windowHintSentence` dùng chung cho form kết nối và hồ sơ model thay cho hai chuỗi điều kiện lặp); 258,392 trên main b569471 (bản 3.10.1); 255,208 sau khi gỡ hai mục Nhóm trợ lý và Sửa mã (tab Tác nhân chỉ còn danh sách công việc nền, nên hai chunk lazy của chúng, `agent-draft` và từ điển riêng của chúng không còn trong bản dựng). Tệp vào nặng hơn main 4054e69 khoảng 23.4 KB: tab Tác nhân, thẻ công tắc hướng dẫn dự án và các chuỗi mà màn hình đầu hỏi tới (367 chuỗi mỗi ngôn ngữ trong `lib/i18n-agents.ts`), cộng những gì tab Tiến độ và tab Thay đổi dùng chung (`IsolatedChecksPanel`, `DiffView`). Tính cả hai chunk thư viện được tải kèm (`radix` 15,048 và `icons` 9,929 byte) thì JS khởi tạo là 280,285 byte. CSS = 10,234 byte gzip (`index-BO-0y5so.css`, 54,276 byte thô; lần đo trước 10,257, trước nữa 10,024 và main 4054e69 9,999: hơn các lần đó là quy tắc `.line-clamp-4` của ghi chú của Hub trên thẻ workflow và các lớp của bộ chọn model và của huy hiệu).
- Bộ chọn model là một chunk riêng (`ModelPicker`: 15,601 byte thô, 5,843 byte gzip), gồm `ModelPicker`, `CatalogStatusLine`, `lib/model-picker.ts` và từ điển của nó (`lib/i18n-models.ts`: 41 chuỗi mỗi ngôn ngữ, nạp bằng `addTranslations`; `lib/i18n.ts` chỉ nhắc tới nó bằng `import type`). Nó được tải khi ô Model của một form AI vẽ lần đầu (màn chào lần đầu, Cài đặt → Mô hình AI), không phải khi mở app: cho tới lúc đó, và mãi mãi nếu chunk không tới được, ô là input thuần như trước (`ModelField` với `Suspense` và `PickerBoundary`), nên gõ tên model luôn dùng được. Hộp danh sách do gõ mở ra chỉ được vẽ khi có gì để đưa (gõ tên danh mục không có, thẻ Ollama hay máy chủ riêng thì không hiện hộp nào); nút ▾ và phím mũi tên mở nó bằng mọi giá. `e2e/model-picker.spec.mjs` kiểm trên bản dựng thật.
- Trang không gọi domain nào ngoài Hub, không telemetry (Hub, không phải trang, chỉ tải danh mục model từ models.dev khi chủ máy bấm nút cập nhật: `docs/THREAT-MODEL.md`, Surface 7); CSP của Hub (`script-src 'self'; style-src 'self'`) vẫn đúng: chunk lazy là script cùng nguồn, trong HTML không có style nội tuyến.

## 8. Chưa làm / giới hạn đã biết

- **Chuỗi cứng còn lại** ở các panel chưa làm lại hẳn (`ModelProfilesPanel`, `SkillsTab`, `PreviewTab`; mục "Công việc nền" của tab Tác nhân đã làm xong, mục 5.5; `IntelligenceTab` đã lấy chữ Việt từ từ điển, xem bullet về màn thiết lập dưới đây); chúng đã dùng token, đã đạt độ tương phản và cỡ chữ, nhưng bố cục bên trong là bản cũ. `SkillsTab` viết mỗi câu thành một cặp Việt/Anh tại chỗ (`copy(vi, en)`); `ModelProfilesPanel` và các nhãn tiếng Anh sẵn có của `IntelligenceTab` ("Context window", "Custom HTTP headers") là tiếng Anh ở cả hai ngôn ngữ. Lint i18n thuộc P8.
- **Thanh trạng thái chưa có thước đo ngữ cảnh đang dùng**: Hub chỉ báo cửa sổ cấu hình và ngân sách lịch sử, chưa báo số token đang chiếm. Hiện hiển thị đúng những gì có, không vẽ thước giả.
- **Cửa sổ ngữ cảnh chưa rõ (P1-C)**: cảnh báo `ContextPolicyNotice` (`data-testid="context-window-warning"`) nằm ngay dưới thanh tiêu đề hội thoại, nói tên chỗ sửa là "Cài đặt → Mô hình AI" và có nút "Mở cài đặt" tới đúng trường. Hàng "Cửa sổ ngữ cảnh" trong "Chi tiết" và thanh trạng thái ghi "chưa rõ", không còn chữ "ước tính" im lặng. Các trường mới của profile (đường dẫn tùy chỉnh, header, cửa sổ) dùng token như phần còn lại nhưng bố cục trong panel vẫn là bản cũ.
- **Mục "Công việc nền", giới hạn đã biết.** (1) Thẻ workflow vẫn hiện các chữ tiếng Anh sẵn có ("Workflow running", "3/3 completed", "Phases") ở màn tiếng Việt, vì `agents.spec.mjs` khớp theo "3/3 completed"; Việt hóa cần sửa spec đó. (2) Các nút dừng và mở nói lỗi bằng từ điển chỉ khi Hub trả mã lỗi mà `lib/agent-errors.ts` biết; lỗi khác hiện nguyên lời của Hub (có thể là tiếng Việt ở màn tiếng Anh), và chưa có e2e nào gây ra lỗi đó. (3) Trạng thái `preparing` không có chữ ở cả hai ngôn ngữ (hiện nguyên chữ Hub). (4) `StateBanner` và `PhaseRibbon` đã qua từ điển (khóa `agents_banner_*` và `agents_ribbon_*`, tên trạng thái bằng `taskStateText`; chữ Việt không đổi một chữ, có `tests/state-banner-ribbon.test.mjs` ghim). Còn lại là chữ do chính Hub viết, hiện nguyên văn: `task.error` (khi bạn bấm Dừng, Hub ghi "Đã dừng theo yêu cầu. Tác vụ chưa được xác nhận hoàn tất.", nên banner của hội thoại đã dừng ở màn tiếng Anh có tiêu đề và nút bằng tiếng Anh nhưng một câu tiếng Việt), ghi chú của hàng "Yêu cầu chưa xác minh" và danh sách của hàng "Kiểm tra còn thiếu"; muốn hết cần Hub trả mã và tham số (bản ghi đã có `errorCode`) để giao diện chọn câu. `ConversationView` và `SessionSidebar` đã qua từ điển (mục 5.5; giới hạn của chúng ở mục kế).
- **Màn hội thoại và thanh bên, giới hạn đã biết.** (1) Lời của chính Hub vẫn hiện nguyên văn ở màn tiếng Anh: câu từ chối trong toast (ví dụ "Hub đang bận hoặc chưa thể khóa workspace."), `task.handoff.note` và `task.error`. Hai tệp này không dùng `agentErrorText`, vì câu cho mã lỗi trong từ điển (`agent_error_*`) viết cho tab Tác nhân (`workspace_missing` nói "thư mục dự án Git", sai với một cuộc chat chưa có thư mục) và dùng chúng cũng đổi chữ Việt của toast; muốn hết cần Hub trả mã và tham số cho từng route. (2) Đã sửa: các thành phần mà hai tệp dựng lên nay đã qua từ điển (khóa `agents_out_*`, `agents_apr_*`, `agents_cmp_*`, `agents_msg_*`, `agents_copy*`, `agents_mp_*`, `agents_tool_*`, `agents_toast_*`, `agents_empty_*`; chữ Việt không đổi một chữ; bốn câu gợi ý của `EmptyState` được dịch, muốn đảo lại thì đặt giá trị tiếng Anh của `agents_empty_prompt_1..4` về câu tiếng Việt). Trước đó chúng còn chữ Việt cứng ở màn tiếng Anh: thẻ gói chờ gửi sang ChatGPT (`OutboundReviewCard`), thẻ phê duyệt (`ApprovalStack`; các spec Playwright khớp theo tên nút tiếng Việt của nó), `Composer` (nhãn, placeholder lúc đang chạy, nút đính kèm, nút "Chờ task"), `MessageItem` và `CopyButton` ("Bạn", "Sao chép"), `ModelProfilePicker`, `ToolActivityGroup` ("Có lỗi"), `Toast` ("Đóng thông báo"), và bốn câu gợi ý của `EmptyState`: tiêu đề và mô tả đã dịch, nhưng câu được gửi đi khi bấm là tiếng Việt ở cả hai ngôn ngữ. Lượt kiểm tra sau đó tìm ra thêm hai thứ, nay đã sửa: chữ "Xong" của hai dòng công cụ (`ToolReceipt`, `ToolActivityGroup`; không có dấu nên lần quét theo chữ cái tiếng Việt không thấy, và `tests/agents-strings.test.mjs` nay tìm nó theo tên), và bốn thành phần quanh hội thoại mà lượt đầu chưa xem (khóa `agents_hdr_*`, `agents_sbar_*`, `agents_fab_*`, `agents_git_*`, `agents_tool_done`; 24 chuỗi mỗi ngôn ngữ): thanh trên cùng `Header` (nút thanh bên và Inspector, nút thư mục, nút tìm kiếm), thanh trạng thái `StatusBar`, dải `FullAccessBanner` và bộ chọn nhánh Git `GitWorkspacePicker`. Header từng nhận ra "chưa chọn thư mục" bằng cách so đường dẫn với đúng câu tiếng Việt "Chưa chọn workspace"; dịch câu ấy mà giữ phép so sánh thì chữ tiếng Anh "No workspace selected" thành một thư mục và bị đưa cho bộ chọn nhánh Git và hộp thoại chọn thư mục, nên nó là một giá trị đúng/sai tính từ đường dẫn đã chọn (`tests/conversation-shell.test.mjs` ghim cả hai ngôn ngữ). (3) Ở màn tiếng Anh, nút Tiếp tục/Thử lại và việc gửi chỉ có tệp gửi cho model câu tiếng Anh (Hub không phản ứng theo chữ của câu; công cụ và chín kỹ năng của Hub được chọn y như với câu tiếng Việt; kỹ năng riêng của người dùng có từ khóa tiếng Anh có thể phản ứng khác); muốn đảo lại chỉ cần đặt giá trị tiếng Anh của `agents_conv_continue_prompt` và `agents_conv_files_prompt` về câu tiếng Việt. (4) "ChatGPT Web (text-only)", "Model profile: …" và tên kênh vốn là tiếng Anh ở cả hai màn hình nên giữ nguyên; ô nhập thư mục thủ công có chữ mẫu `F:\\Personal_Project\\Vin\\ChatMCP` (đường dẫn của chính người viết, hai dấu `\` vì thuộc tính JSX không xử lý escape) hiện cho mọi người dùng. (5) Câu hỏi xóa hội thoại đếm cả các đoạn nối của cùng hội thoại (sau khi đổi kênh) như "subagent". (6) Các thành phần ở (2) có test render và test bấm riêng (`tests/conversation-core.test.mjs`, `conversation-shell.test.mjs`, `conversation-rest.test.mjs`: tiếng Việt ghim đúng chữ cũ, màn tiếng Anh không còn chữ Việt hay khóa, mỗi toast chạy thật với một Hub giả) và test e2e tiếng Anh của `orchestrator.spec.mjs` đọc cả thanh trên cùng, thanh trạng thái và bộ chọn nhánh Git. Cũng đã chạy bộ test mới trên các thành phần cũ (nguồn ở `ae26446`: 116 khẳng định sai, không cái nào ở phía tiếng Việt), so sánh render cũ/mới (690 lượt render của 14 thành phần: tiếng Việt giống từng byte, tiếng Anh khớp markup cũ sau khi thay bằng từ điển, 120 chuỗi Việt cũ đều có trong từ điển, 17 khác biệt cố ý đều bị thấy) và chạy đột biến (57 đột biến: 57 bị bắt, 0 sống sót). Chỉ có test đơn vị ghim, chưa có e2e: quyết định xem lại gói gửi ChatGPT (cần Companion), dừng workflow, khôi phục URL ChatGPT, "Đang trả lời…", "Về nội dung mới nhất ↓", dòng đang tải, thông báo lỗi khi chọn thư mục và biểu mẫu nhập thư mục thủ công. (7) Chữ Việt cứng còn lại ở màn tiếng Anh (hộp thoại FULL ACCESS, sáu mục của Cài đặt, bảng lệnh, màn thiết lập, các thông báo của biểu mẫu AI và của Inspector): đã làm ở lượt sau, xem bullet kế tiếp.
- **Màn thiết lập, Cài đặt, bảng lệnh, hộp thoại FULL ACCESS và hai thông báo của Inspector, giới hạn đã biết.** Đã làm: `FullAccessDialog` (hộp thoại vẫn đòi gõ đúng `FULL ACCESS`), sáu mục của Cài đặt (Giới thiệu, Kênh agent, Giao diện, Code Intelligence, Quyền, Thư mục dự án), `CommandPalette`, `OnboardingModal`, thông báo cấu hình chưa áp dụng và các lỗi của `IntelligenceTab`, thông báo workspace thứ hai của `InspectorPanel`, nhãn trạng thái Git của `FilesTab` (Mới, Xóa, Thêm, Đổi tên, Sửa) và ba câu dự phòng của `GitTab`: 182 chuỗi mỗi ngôn ngữ (161 → 343 khóa). Chữ Việt không đổi một chữ: các thành phần cũ và mới được vẽ trên cùng 31 trạng thái với cùng câu trả lời của Hub (từng mục Cài đặt, hộp thoại đã gõ và chưa gõ, màn thiết lập từng bước kèm thư mục đã chọn và lỗi, bảng lệnh, biểu mẫu AI có và không có bản nháp, thông báo giữ khóa đã lưu, thông báo workspace thứ hai, tab Tệp), markup tiếng Việt giống từng byte ở cả 31; ở chính 31 trạng thái đó màn tiếng Anh cũ có 334 đoạn chữ Việt, màn mới chỉ còn tên ngôn ngữ trong bộ chọn ("Tiếng Việt (Vietnamese)", viết bằng tiếng Việt có chủ ý). Ô mẫu tên model của biểu mẫu AI ở màn tiếng Anh từng đọc "vd:" (ví dụ) và nay đọc "e.g.". `tests/settings-screens.test.mjs` (11 test) ghim từng chữ Việt của từng trạng thái (`tests/support/settings-screens.vi.json`, lấy từ các thành phần cũ bằng `visibleWords`, giữ cả khoảng trắng ở rìa đoạn chữ), đòi chữ Anh của từng trạng thái không có chữ Việt, không có khóa từ điển và nói đúng câu cần nói, đòi cả từ điển tiếng Anh sạch chữ Việt (trừ `lang_vi`), đòi mười một tệp không viết chữ Việt nào nữa (trừ hai dòng ở (1)), và gọi từng handler mà các màn giao cho nút, ở cả hai ngôn ngữ (toast có `{mode}` và `{path}`, câu hỏi ngắt ghép, câu dự phòng khi lỗi không có lời). Hai test e2e tiếng Anh trong `e2e/studio.spec.mjs` đi từ màn thiết lập tới lúc làm việc, rồi qua các mục Cài đặt, hộp thoại FULL ACCESS và bảng lệnh. Đã kiểm bằng cách phá có chủ ý: 24 đột biến đơn vị (hai con sống ở lần đầu, đều là một khoảng trắng ở rìa đoạn chữ, nên `visibleWords` giữ khoảng trắng đó; sau đó 24/24 bị bắt) và 7 đột biến e2e (7/7 bị bắt, một thay đổi tiếng Anh vô hại không bị bắt). Còn lại: (1) Hai dòng chữ Việt ở lại có chủ ý: toast sau khi chuyển sang Tiếng Việt (nó bằng tiếng Việt) và hai từ khóa tìm kiếm của bảng lệnh ("kế hoạch", "nhật ký": người dùng tiếng Việt tìm "Tiến độ" bằng cách gõ "kế hoạch"). (2) Các tệp trong `src/components` còn chữ Việt đều viết chữ Anh ngay cạnh (`lang === 'vi' ? … : …` hoặc `copy(vi, en)`: `ChatGptWebRiskNote`, `ContextPolicyNotice`, `ProofStrip`, `ActivityTab`, `FilesTab`, `GitTab`, `PlanTab`, `SkillsTab`, `TerminalTab`, `VerificationReceipts`); 19 lần vẽ tiếng Anh của chúng (Kỹ năng ở năm trạng thái, Git ở ba, Tệp ở hai, Terminal ở ba, Tiến độ, Hoạt động, ghi chú rủi ro ChatGPT Web, hồ sơ model, xem trước, hướng dẫn dự án) không có chữ Việt, còn `ContextPolicyNotice`, `ProofStrip` và `VerificationReceipts` chưa được vẽ trong lần đo đó. `SessionRequired` nói cả hai ngôn ngữ trong cùng một dòng có chủ ý. (3) Thông báo lỗi của mã thư viện vẫn chỉ có tiếng Việt và hiện ở màn tiếng Anh khi lỗi không có lời của Hub: `lib/api.ts` (bốn câu: "Lỗi HTTP …", "Phản hồi JSON không hợp lệ …" và hai câu về phiên đăng nhập), `lib/model-profile-selection.ts` (năm câu về ghi đè profile theo vai trò) và `lib/native-folder-picker.ts` (hai câu về hộp chọn thư mục Windows). (4) Đã sửa (lỗi có từ trước, tìm thấy khi viết test e2e tiếng Anh): bảng lệnh, mục Quyền của Cài đặt và menu chế độ của ô soạn tin quyết định có hạ chính sách thực thi về `host-review` hay không theo bản sao trạng thái Hub mà trang đang giữ, mà bản sao đó có thể cũ vài giây sau khi bật FULL ACCESS (hộp thoại không làm mới nó, các panel làm mới mỗi vài giây). Chọn Review trong khoảng đó đổi chế độ nhưng để Hub ở full-access (dải FULL ACCESS vẫn hiện, nên không có trạng thái ẩn, nhưng Hub làm khác điều người dùng vừa chọn). Nay ba nơi đó, và cả màn thiết lập (vốn đọc trạng thái mới trước khi gửi, nên chỉ còn một khoảng hở nhỏ giữa hai lời gọi), gửi `leaveFullAccess: true` cùng chế độ và chính Hub (`PermissionGate.configure`) hạ về `host-review` nếu lúc đó nó đang ở full-access: không đụng tới `sandbox-only` hay `host-review`, nhường cho chính sách ghi rõ trong cùng yêu cầu và cho yêu cầu bật FULL ACCESS, và chỉ giá trị `true` có tác dụng; một chế độ gửi riêng vẫn không đổi chính sách (Chỉ đọc vẫn thắng Full Access, `tests/verify-full-access-always-ask.mjs`). Hộp thoại FULL ACCESS cũng làm mới `hubState` ngay sau khi bật, nên dải và thanh trạng thái không chờ lượt hỏi kế tiếp. Giữ bằng `verify-permissions-modes` và `verify-v2-http` (mỗi bộ có một khối kiểm tra cờ; 6/6 đột biến của `configure` bị bắt), `settings-screens.test.mjs` và `conversation-screen.test.mjs` (7/7 đột biến của giao diện) và một test e2e cho trang bị giữ trạng thái cũ (`studio.spec.mjs`: trang được báo `host-review` trong khi Hub ở full-access, rồi chọn Review từ bảng lệnh, từ Cài đặt và từ menu ô soạn tin; 3/3 đột biến bị bắt).
- Đã kiểm trên Chromium (Playwright); WebView2 thật được kiểm bằng `e2e/webview2-smoke.mjs`.

## 9. Kiểm tra và chụp lại

```sh
cd CHATMCP-HUB/ui
npm run build          # web/dist
npm run test:unit      # token, độ tương phản, dải bằng chứng, định dạng, nhãn công cụ, component
npm run test:e2e:built # luồng thật: Hub thật, model giả lập, Chromium
npm run gallery        # ảnh chụp mọi màn hình (test-results/gallery; gồm các mục của tab Tác nhân), thất bại nếu trang ghi lỗi console
```
