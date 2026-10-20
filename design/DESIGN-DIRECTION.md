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
- **Work panel:** một hàng tab, chữ thuần (không icon), tab đang chọn có gạch chân; `Hoạt động` và `Xem trước` (dùng ít hơn) nằm dưới `⋯` và tự hiện thành tab khi được chọn; bàn phím `←/→/Home/End`. Không còn tầng "Background tasks / Inspector": tác vụ nền là tab **Tác nhân**.
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

## 6. Lộ trình hạ cánh ở đâu trong giao diện (dự kiến)

Bảng này là kế hoạch chỗ đặt, không phải danh sách đã làm: mục "Hooks", mục "MCP", nút xuất gói bằng chứng, duyệt diff theo hunk và plan mode **chưa tồn tại**. Điều đã có là chỗ để chúng vào (`SECTIONS`, hàng tab, danh sách mục của thanh trạng thái, các trạng thái của dải bằng chứng) mà không phải làm lại bố cục.

| Hạng mục lộ trình | Chỗ trong giao diện |
|---|---|
| P1 hooks (PreToolUse/PostToolUse, Stop), `agent_results`, gắn lại OrchestratorTab, lỗi provider | mục "Hooks" mới trong `SECTIONS`; dòng hook trong tab Hoạt động; OrchestratorTab thành mục của tab **Tác nhân**; lỗi provider ở dải trạng thái hội thoại |
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
- Ngân sách: JS khởi tạo ≈ 230 KB gzip (ngân sách 260 KB), CSS ≈ 10 KB gzip. Không có request ra ngoài domain, không telemetry; CSP của Hub (`style-src 'self'`) vẫn đúng vì không có style nội tuyến trong HTML.

## 8. Chưa làm / giới hạn đã biết

- **Chuỗi tiếng Việt cứng còn lại** ở các panel chưa làm lại hẳn (`IntelligenceTab`, `ModelProfilesPanel`, `SkillsTab`, `PreviewTab`, `OrchestratorTab`); chúng đã dùng token, đã đạt độ tương phản và cỡ chữ, nhưng bố cục bên trong là bản cũ. Lint i18n thuộc P8.
- **Thanh trạng thái chưa có thước đo ngữ cảnh đang dùng**: Hub chỉ báo cửa sổ cấu hình và ngân sách lịch sử, chưa báo số token đang chiếm. Hiện hiển thị đúng những gì có, không vẽ thước giả.
- **Cửa sổ ngữ cảnh chưa rõ (P1-C)**: cảnh báo `ContextPolicyNotice` (`data-testid="context-window-warning"`) nằm ngay dưới thanh tiêu đề hội thoại, nói tên chỗ sửa là "Cài đặt → Mô hình AI" và có nút "Mở cài đặt" tới đúng trường. Hàng "Cửa sổ ngữ cảnh" trong "Chi tiết" và thanh trạng thái ghi "chưa rõ", không còn chữ "ước tính" im lặng. Các trường mới của profile (đường dẫn tùy chỉnh, header, cửa sổ) dùng token như phần còn lại nhưng bố cục trong panel vẫn là bản cũ.
- Đã kiểm trên Chromium (Playwright); WebView2 thật được kiểm bằng `e2e/webview2-smoke.mjs`.

## 9. Kiểm tra và chụp lại

```sh
cd CHATMCP-HUB/ui
npm run build          # web/dist
npm run test:unit      # token, độ tương phản, dải bằng chứng, định dạng, nhãn công cụ, component
npm run test:e2e:built # luồng thật: Hub thật, model giả lập, Chromium
npm run gallery        # ảnh chụp mọi màn hình (test-results/gallery), thất bại nếu trang ghi lỗi console
```
