# ChatMCP Studio — Design Direction & System Specification

> **Phiên bản:** 2.4.0 (Frontend Rebuild)  
> **Tác giả:** Principal Product Designer & Staff Front-end Engineer  
> **Trạng thái:** Chờ phê duyệt (Giai đoạn 1)  
> **Nguyên tắc chủ đạo:** *Calm Precision* (Bình tĩnh · Chính xác · Kiểm soát · Thân thiện)

---

## 1. Tầm nhìn & Triết lý Thiết kế: "Calm Precision"

ChatMCP là một **AI Coding Agent tự trị** hoạt động trực tiếp trên mã nguồn thật của lập trình viên trên Windows 11 và các môi trường Cloud/Container. Mỗi lệnh sửa file, chạy bash/PowerShell hay git commit đều tác động tới repository thật.

Do đó, cảm xúc trọng tâm của giao diện phải là: **Bình tĩnh, chính xác, đáng tin cậy và hoàn toàn trong tầm kiểm soát**.
Người dùng không cần những hiệu ứng hào nhoáng, gradient tím hồng ("AI slop") hay chuyển động giật mắt. Họ cần một công cụ làm việc 8 tiếng mỗi ngày như **Linear, Cursor, Raycast, Claude.ai hay VS Code**:
- Mật độ thông tin cao nhưng thoáng đãng, phân cấp thị giác rõ ràng.
- Mọi hành động của Agent đều minh bạch: biết rõ agent đang nghĩ gì, đọc file nào, sửa gì, chạy lệnh gì với quyền hạn gì.
- Phê duyệt an toàn (Approvals & Permissions) là trung tâm của sự tin cậy.
- Phím tắt là công dân hạng nhất (`Ctrl+K`, `Ctrl+B`, `Ctrl+J`, `Enter`/`Shift+Enter`, `Esc`).

---

## 2. Điểm nhấn Nhận diện (Design Signatures)

### Signature 1: Thanh Pha Agent (Agent Phase Ribbon)
Một dải mảnh tinh tế (chiều cao 28px) xuất hiện dưới header khi Agent đang hoạt động, hiển thị tiến trình chu kỳ nhận thức:
`[ Đang nghĩ ] ──> [ Đọc file ] ──> [ Sửa đổi ] ──> [ Chạy kiểm thử ] ──> [ Hoàn tất ]`
Mỗi pha có biểu tượng ngữ nghĩa, màu sắc tương ứng, thời gian thực thi (ms/s) và hiệu ứng pulse nhẹ nhàng. Người dùng luôn biết agent đang ở pha nào mà không cần đọc từng dòng log thô.

### Signature 2: Tool-Call Receipt Card
Thay vì in log thô dạng text hoặc JSON cồng kềnh, mỗi hành động gọi công cụ của Agent được đóng gói trong một **Receipt Card** gọn gàng:
- **Header:** Icon công cụ (`file-edit`, `terminal`, `search`, `git`), tên tool, đường dẫn file mono `student/kalman.py`, thời lượng chạy `1.2s`, trạng thái (thành công / đang chạy / lỗi).
- **Body (thu gọn mặc định):** Nhấn để mở rộng xem output chi tiết hoặc diff thu nhỏ, có nút sao chép (Copy) và xem trong Inspector tương ứng.

### Signature 3: Mode Pill Ngữ nghĩa & Quyền Hạn Minh Bạch
Nằm cố định góc dưới bên trái của Composer và hiển thị trên Header:
- **Chỉ đọc (Read-only):** Màu xanh xám `neutral`, icon `Eye`.
- **Review (Mặc định):** Màu xanh dương `info`, icon `ShieldCheck`. Mọi thay đổi file và lệnh shell đều hỏi duyệt.
- **Tự động (Autonomous):** Màu tím nhạt `primary`, icon `Bot`. Tự động sửa file trong workspace và chạy test an toàn.
- **FULL ACCESS ⚠️:** Màu đỏ cam `danger`, viền sọc chéo tinh xảo, icon `Unlock`. Khi bật, một cảnh báo cố định xuất hiện ở header. Yêu cầu nhập đúng `FULL ACCESS` để kích hoạt.

### Signature 4: Diff Viewer Chuẩn IDE
Diff viewer chuyên dụng tích hợp trong Review & Git Inspector:
- Hỗ trợ cả hai chế độ **Split** (2 cột) và **Unified** (1 cột).
- Line numbers rõ ràng, highlight cấp từ (word-level diff) với màu nền `add` (`oklch(0.92 0.08 145)` / dark: `oklch(0.28 0.06 145)`) và `delete` (`oklch(0.92 0.08 25)` / dark: `oklch(0.28 0.06 25)`).
- Thanh công cụ hành động dính dưới đáy: "Chấp nhận thay đổi (Accept)" và "Khôi phục checkpoint (Restore)".

### Signature 5: Empty States & Skeletons Đồng bộ
Không sử dụng spinner đơn điệu ở khắp nơi:
- Khi đang tải dữ liệu: Skeleton animation đồng bộ hình dạng của card, table và message stream.
- Khi rỗng: Minh họa vector đơn sắc tối giản, một dòng tiêu đề súc tích, mô tả ngắn và một nút hành động tiếp theo rõ ràng (Call-to-Action).

---

## 3. Hệ thống Design Tokens (OKLCH & Tailwind v4)

Hệ thống token được khai báo qua CSS variables thuần túy (không sinh `<style>` động lúc runtime), tương thích 100% CSP `'style-src self'`.

### 3.1 Bảng màu Trung tính 12 bậc (Radix-inspired Slate)

| Bậc | Mục đích | Giá trị Dark Mode (OKLCH) | Giá trị Light Mode (OKLCH) |
|---|---|---|---|
| **1** | Nền ứng dụng chính (App Canvas) | `oklch(0.14 0.015 250)` (#0e1217) | `oklch(0.985 0.005 250)` (#f8fafc) |
| **2** | Nền panel / Card bề mặt (Surface) | `oklch(0.17 0.018 250)` (#131820) | `oklch(1.000 0.000 000)` (#ffffff) |
| **3** | Nền phần tử tương tác (Component BG) | `oklch(0.21 0.020 250)` (#19212b) | `oklch(0.955 0.008 250)` (#f1f5f9) |
| **4** | Hover trên tương tác | `oklch(0.25 0.024 250)` (#212b38) | `oklch(0.925 0.012 250)` (#e2e8f0) |
| **5** | Active / Selected bề mặt | `oklch(0.29 0.028 250)` (#2a3747) | `oklch(0.890 0.015 250)` (#cbd5e1) |
| **6** | Viền mờ phụ (Subtle Border) | `oklch(0.24 0.018 250)` | `oklch(0.910 0.010 250)` |
| **7** | Viền mặc định (Default Border 1px) | `oklch(0.30 0.022 250)` | `oklch(0.830 0.015 250)` |
| **8** | Viền nổi bật (Hover/Focus Border) | `oklch(0.40 0.030 250)` | `oklch(0.700 0.020 250)` |
| **9** | Solid Primary Accent | `oklch(0.72 0.140 175)` (Cyan Mint) | `oklch(0.55 0.130 175)` (Deep Teal) |
| **10** | Solid Primary Hover | `oklch(0.78 0.150 175)` | `oklch(0.48 0.140 175)` |
| **11** | Chữ phụ / Muted text (≥ 4.5:1) | `oklch(0.72 0.025 250)` | `oklch(0.42 0.030 250)` |
| **12** | Chữ chính / High-contrast text (≥ 12:1)| `oklch(0.96 0.008 250)` | `oklch(0.16 0.020 250)` |

### 3.2 Màu Ngữ nghĩa (Semantic Colors)

- **Brand Accent:** Cyan-Teal `oklch(0.72 0.14 175)` — kế thừa nhận diện của ChatMCP Studio, sắc sảo và hiện đại.
- **Success:** `oklch(0.72 0.16 145)` (Dark text) / `oklch(0.25 0.07 145)` (Dark bg) — Tác vụ hoàn tất, test pass, checkpoint an toàn.
- **Warning:** `oklch(0.78 0.14 80)` (Dark text) / `oklch(0.26 0.06 80)` (Dark bg) — Cần chú ý, tạm dừng, session recovery.
- **Danger:** `oklch(0.68 0.20 25)` (Dark text) / `oklch(0.25 0.08 25)` (Dark bg) — Lỗi, từ chối, Full Access ⚠️, xóa session.
- **Info:** `oklch(0.70 0.14 240)` (Dark text) / `oklch(0.24 0.06 240)` (Dark bg) — Review mode, chỉ dẫn hệ thống.

### 3.3 Typography & Font Stacks

- **UI Text:** `"Segoe UI Variable", "Inter Variable", system-ui, -apple-system, sans-serif`
  - Đảm bảo font Windows 11 nguyên bản (`Segoe UI Variable`), hiển thị dấu tiếng Việt hoàn hảo, không bị đè dấu hay vỡ kerning trên Windows WebView2.
- **Code & Numbers:** `"JetBrains Mono", "Cascadia Code", Consolas, monospace`
  - Tự host via `@fontsource/jetbrains-mono`, hiển thị số liệu dạng `font-variant-numeric: tabular-nums` (`tnum`) để cột số và bảng không bị rung khi nhảy số.
- **Thang kích thước:**
  - Micro: `10px / 14px` (Tags, status badges, timestamps)
  - Caption: `11px / 16px` (Field notes, secondary labels)
  - Compact: `12px / 18px` (Table cells, file tree items, buttons)
  - Body: `13px / 20px` (Mặc định cho đoạn văn, chat stream, composer)
  - Body Large: `14px / 22px` (Tiêu đề tin nhắn, modal body)
  - Heading Sm: `16px / 24px` (Card titles, section headings)
  - Heading Md: `20px / 28px` (Screen headers, modal titles)
  - Heading Lg: `26px / 34px` (Welcome headline)

### 3.4 Lưới & Spacing, Bo góc, Viền
- Lưới cơ sở **4px** (`4px, 8px, 12px, 16px, 20px, 24px, 32px, 48px`).
- Radius: `rounded-sm: 4px`, `rounded-md: 6px`, `rounded-lg: 8px` (mặc định cho button, input, card), `rounded-xl: 12px` (modal, popover), `rounded-full: 9999px` (pills, badges).
- Viền mảnh **1px solid** tinh tế, không dùng bóng đổ dày mà dùng viền phân cách sạch sẽ kèm 1px inner highlight trên nền tối.

---

## 4. Kiến trúc Màn hình & Tương tác

### 4.1 Bố cục 3 Panel (App Shell)
- Sử dụng `react-resizable-panels`:
  - **Trái: Sessions Sidebar (240px - 320px, mặc định 260px)**. Thu gọn nhanh bằng `Ctrl+B`.
  - **Giữa: Conversation View (min 500px, flex 1, độ rộng đọc tin nhắn max 780px căn giữa)**.
  - **Phải: Inspector 9 Tabs (320px - 550px, mặc định 380px)**. Thu gọn nhanh bằng `Ctrl+J`.
- Header đồng nhất 48px:
  - Trái: Logo ChatMCP Studio + Workspace selector pill (nhấn mở dropdown chọn thư mục gần đây hoặc browse).
  - Giữa: Ô tìm kiếm nhanh "Tìm hoặc chạy lệnh… `Ctrl K`".
  - Phải: Badge kết nối Hub (Online/Offline), Provider Chip (model hiện tại + tool-call status), Theme Toggle (Dark/Light/System), nút Thu gọn Inspector, Avatar + Role.

### 4.2 Sessions List (Quản lý Phiên)
- Nhóm thông minh: **Hôm nay**, **7 ngày qua**, **Cũ hơn**.
- Mỗi item: Tiêu đề tóm tắt (1-2 dòng), thời gian tương đối (`5 phút trước`), trạng thái (chấm xanh hoàn tất, chấm vàng pulse đang chạy, chấm đỏ lỗi), workspace tương ứng.
- Menu context `...`: Đổi tên phiên, Sao chép ID, Xóa phiên.
- Tìm kiếm tức thì có highlight từ khóa, virtualized bằng `@tanstack/react-virtual`.

### 4.3 Màn hình Chào (Welcome Screen) & Luồng Hội thoại
- Khi chưa chọn phiên: Lời chào thân thiện theo thời gian trong ngày ("Chào buổi sáng, lập trình viên!"), hiển thị workspace đang mở, và **4 gợi ý tác vụ thực tế** (quét mã nguồn, tìm lỗi chưa commit, kiểm tra test suite, đề xuất refactor).
- Luồng tin nhắn:
  - Tin nhắn User: Căn phải, nền subtly tinted, rõ ràng số thứ tự yêu cầu.
  - Tin nhắn Agent: Căn trái kèm avatar AI, render Markdown chuẩn GFM an toàn (không dùng `rehype-raw`), code block có nút Copy, hiển thị ngôn ngữ và đường dẫn file liên quan.
  - Receipt card cho các tool call thu gọn gọn gàng.
  - Nút **Dừng tác vụ (Cancel)** nổi bật khi agent đang chạy, đi kèm bộ đếm thời gian và bước hiện tại.
  - Tự động cuộn thông minh: Khi người dùng cuộn lên để đọc lịch sử, hệ thống không tự giật xuống; hiển thị nút pill "↓ Có tin mới" ở góc dưới.

### 4.4 Composer Đẳng cấp
- Textarea auto-grow từ 1 đến 10 dòng, placeholder động theo ngữ cảnh.
- Hỗ trợ `@` mention file trong workspace (popup combobox tìm kiếm file nhanh).
- Mode pill: hiển thị rõ quyền hiện tại (Chỉ đọc, Review, Tự động, FULL ACCESS) ngay cạnh nút Gửi.
- Provider selector: Nhấp để chuyển nhanh AI profile hoặc mở Settings.
- Ước tính context / token counter.
- Phím tắt: `Enter` gửi, `Shift+Enter` xuống dòng, `Esc` dừng, `↑` khi ô rỗng để lật lại prompt vừa gửi.

### 4.5 Inspector 9 Tabs Đầy Đủ (Feature Parity)
1. **Activity (`activity`):** Nhật ký timeline các sự kiện theo lượt, lọc theo loại (Tools, AI thoughts, System, Checkpoints).
2. **Files (`files`):** Cây thư mục dự án tương tác chuẩn ARIA tree, tìm kiếm file nhanh, trình xem file tích hợp Shiki highlight và số dòng, cho phép sửa file thủ công có kiểm tra SHA-256 an toàn.
3. **Git (`git`):** Trạng thái nhánh hiện tại, danh sách file thay đổi (M/A/D/U), diff viewer Split/Unified, tạo checkpoint và review checkpoint trước khi merge.
4. **Terminal (`terminal`):** Terminal tích hợp với `@xterm/xterm`, hỗ trợ cả interactive shell và non-interactive commands, hiển thị exit code, lịch sử kiểm thử dự án (Project Verification).
5. **Plan (`plan`):** Checklist công việc của agent theo từng bước (`todo`, `doing`, `done`, `blocked`), cho phép người dùng thêm/bớt/sửa bước hoặc kích hoạt research subagents.
6. **Preview (`preview`):** Trình xem ứng dụng localhost an toàn trong sandboxed iframe (chặn truy cập vào origin dashboard), kiểm tra cổng dev server và reload 1-click.
7. **Intelligence (`intelligence`):** Code Index AST (Python AST index), tìm kiếm symbols, references, definitions; khởi động và quản lý Pyright / TypeScript LSP server.
8. **Skills Marketplace (`skills`):** Lưới các kỹ năng, plugins và công cụ MCP được phân loại (Coding, Testing, Security, Automation), tìm kiếm, bộ lọc, xem chi tiết và bật/tắt/cài đặt.
9. **Settings (`settings`):** Cấu hình chung, Quản lý Profiles AI (multi-profile, test kết nối có hiển thị độ trễ ms, tự động phát hiện tool calling), Quyền hạn phê duyệt, Tùy chọn giao diện và kiểm tra tính năng hệ thống.

### 4.6 Approval Stack & Chế độ Quyền Hạn (Trọng tâm An toàn)
- Xuất hiện ở vị trí ưu tiên cao (phía trên Composer hoặc dialog modal khi thao tác rủi ro cao):
  - Badge mức độ rủi ro: **Thấp** (xanh), **Trung bình** (vàng), **Cao** (đỏ).
  - Tóm tắt hành vi: lệnh shell nào được thực thi, file nào bị ghi đè, diff chi tiết.
  - Đồng hồ đếm ngược tự động từ chối khi hết hạn.
  - Phím tắt: `Enter` chấp nhận, `Esc` từ chối.
- Chế độ **FULL ACCESS**:
  - Hộp thoại cảnh báo bảo mật nghiêm ngặt (`AlertDialog`), giải thích nguy cơ truy cập toàn bộ máy và Internet không qua sandbox.
  - Bắt buộc gõ chính xác chuỗi `FULL ACCESS` mới kích hoạt nút Xác nhận.
  - Header và Composer đổi sang theme cảnh báo đỏ-cam khi chế độ này đang bật.

### 4.7 Command Palette (`Ctrl+K`)
- Sử dụng `cmdk`:
  - Tìm kiếm mờ (fuzzy search) với highlight ký tự khớp.
  - Nhóm lệnh: Hành động nhanh, Điều hướng tab, Quản lý phiên, Chế độ quyền, Cài đặt & Theme.
  - Hiển thị phím tắt dạng `<kbd>` chuẩn đẹp.
  - Ghi nhớ các lệnh vừa chạy gần đây (Recent commands).

---

## 5. Tiêu chuẩn Tiếp cận (A11y) & Hiệu năng

- **WCAG 2.2 AA:** Tương phản chữ chính ≥ 7:1, chữ phụ ≥ 4.5:1, viền tương tác ≥ 3:1 ở cả 2 theme.
- **Hỗ trợ bàn phím 100%:** Focus ring rõ ràng (`outline: 2px solid var(--mint)`), focus trap chuẩn trong modal, phím tắt điều hướng tab và danh sách.
- **Tôn trọng người dùng:** Tự động nhận diện `prefers-reduced-motion` để tắt chuyển động; hỗ trợ `forced-colors` (High Contrast mode của Windows); hỗ trợ phóng to màn hình 200%.
- **Ngân sách Bundle & Tải trang:**
  - Initial JS bundle ≤ 260 KB gzip (đạt ngân sách 300 KB).
  - Static CSS ≤ 35 KB gzip (đạt ngân sách 50 KB).
  - Lazy load: `@xterm/xterm`, `shiki`, `react-diff-view`, `marketplace`.
  - Không có bất kỳ request nào ra ngoài domain lúc chạy (0 external requests, 0 telemetry).
  - Tốc độ First Meaningful Paint ≤ 800ms trên máy cục bộ.
