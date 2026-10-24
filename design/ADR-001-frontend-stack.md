# ADR-001: Hiện đại hóa Frontend Stack và Kiến trúc Triển khai DatGold Studio

* **Trạng thái:** Đề xuất (Chờ phê duyệt Giai đoạn 1)
* **Ngày:** 2026-10-12
* **Tác giả:** Principal Product Designer & Staff Front-end Engineer
* **Quyết định:** Chuyển đổi từ React 17/18 inline thủ công (`React.createElement` không bước build, nợ kỹ thuật 1070 dòng `react-app.js` và 380 dòng CSS chồng chéo) sang **Vite 6 + React 19 + TypeScript + Tailwind CSS v4 + Radix UI Primitives + TanStack Query/Virtual**.

---

## 1. Bối cảnh & Vấn đề

DatGold Studio hiện tại:
1. `react-app.js` được viết bằng `React.createElement` thủ công không có JSX hay bước build, khó bảo trì, dễ sai sót khi logic mở rộng.
2. `react.css` gồm nhiều lớp override chồng lên các phiên bản 2.0, 2.1, 2.2; nhiều màu bị hardcode hex code dẫn đến lỗi hiển thị ở light theme và độ tương phản kém.
3. Không có type-safety, không có linting chuẩn, và khó mở rộng các tính năng hiện đại như virtualized message list, code diff viewer chuyên nghiệp, autocomplete `@` mention, v.v.
4. Tuy nhiên, kiến trúc phải tuân thủ nghiêm ngặt **các bất biến bảo mật và phân phối**:
   - Chạy 100% offline (không tải font/icon/CDN từ internet khi chạy app).
   - Tuân thủ CSP của `hub.mjs`: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` (+ loopback frame-src). Không được dùng `'unsafe-inline'` hay `'unsafe-eval'`. Thư viện không được chèn thẻ `<style>` runtime.
   - Không bắt người dùng cuối phải cài Node/npm hay chạy build.
   - Giữ nguyên hợp đồng backend API và CSRF tokens.

---

## 2. Quyết định Kiến trúc & Công nghệ (Tech Stack)

### 2.1 Bảng Thành phần Công nghệ

| Lớp | Thư viện / Công nghệ | Phiên bản | License | Lý do & Đánh giá CSP |
|---|---|---|---|---|
| **Build Tool** | **Vite** | 6.x | MIT | Build cực nhanh, module ESM tối ưu, sinh output tĩnh sạch sẽ vào `CHATMCP-HUB/web/dist/`. |
| **Language** | **TypeScript** | 5.7+ | Apache-2.0 | Strict mode, bảo đảm type safety cho mọi API schema, loại bỏ lỗi runtime null/undefined. |
| **Framework** | **React** | 19.x | MIT | Hooks, Server Components-ready, Concurrent features, tối ưu hóa render. |
| **Styling** | **Tailwind CSS v4** | 4.x | MIT | Khai báo token qua `@theme`, biên dịch toàn bộ class thành file CSS tĩnh lúc build. **Hoàn toàn tuân thủ CSP `style-src 'self'`**, 0 runtime style injection. |
| **Components** | **shadcn/ui** pattern trên **Radix UI Primitives** | latest | MIT | Mã nguồn component nằm trong repo (in-tree), tùy biến 100%, tuân thủ chuẩn WAI-ARIA APG, không phụ thuộc runtime styling ngoài. |
| **Icons** | **lucide-react** | latest | ISC | Bộ icon SVG đồng nhất, stroke 1.5 - 1.75px chuẩn IDE, render ra React SVG element trực tiếp, offline 100%. |
| **Command Palette** | **cmdk** | latest | MIT | Command palette chuẩn Raycast/Linear, hỗ trợ fuzzy search, nhóm lệnh, phím tắt keyboard-first. |
| **Split Panels** | **react-resizable-panels** | latest | MIT | Cho phép kéo giãn 3 panel linh hoạt, lưu kích thước vào `localStorage`, không inject `<style>` động. |
| **Server State** | **@tanstack/react-query** | 5.x | MIT | Quản lý cache, polling mượt mà, retry tự động, đồng bộ state với Hub và SSE stream. |
| **UI State** | **zustand** | 5.x | MIT | State nhẹ cho theme, active tabs, search query, panel collapse. Không boilerplate. |
| **Danh sách dài** | **@tanstack/react-virtual** | 3.x | MIT | Virtualize timeline 500+ tin nhắn, log terminal, file tree, giữ 60fps mượt mà. |
| **Markdown** | **react-markdown** + **remark-gfm** | latest | MIT | **STRICT: Không dùng `rehype-raw`**. Không bao giờ render raw HTML từ model/tool. Mọi link gắn `rel="noopener noreferrer"`. |
| **Syntax Highlighting** | **shiki** (`codeToTokens`) | latest | MIT | Render syntax token thành các `<span>` tĩnh với CSS class hoặc inline style React, sử dụng JavaScript regex engine (`oniguruma-to-js`), **tránh load WASM ngoài**, lazy load khi xem code. |
| **Diff Viewer** | **react-diff-view** + **diff** (jsdiff) | latest | MIT / BSD-3 | Hỗ trợ split & unified diff, word-level highlight, cực nhẹ so với Monaco Editor, hoàn toàn không cần Web Worker hay nới lỏng CSP. |
| **Terminal** | **@xterm/xterm** + **@xterm/addon-fit** | 5.x | MIT | Chuẩn terminal giả lập IDE, lazy load khi mở tab Terminal, chạy DOM/Canvas renderer tuân thủ CSP. |
| **Font chữ** | **@fontsource/jetbrains-mono** & Segoe UI Variable | latest | OFL-1.1 | Font được bundle tự host offline, hỗ trợ đầy đủ tiếng Việt có dấu. |
| **Toast** | **Radix Toast** / Custom Tailwind Toast | latest | MIT | Thông báo nổi góc dưới phải, hỗ trợ aria-live, không chèn runtime `<style>`. |

### 2.2 Đánh giá An toàn CSP (Content Security Policy)

Mọi thư viện được chọn đều được rà soát để đảm bảo **KHÔNG vi phạm CSP**:
1. **Chặn runtime `<style>` tags:** Loại trừ hoàn toàn `styled-components`, `emotion`, và các bản toast tự chèn thẻ style vào head. Sử dụng Tailwind CSS v4 xuất ra một file `dist/assets/index.css` duy nhất.
2. **Chặn `unsafe-eval` & `unsafe-inline`:** Vite được cấu hình không tạo inline scripts. Tất cả JavaScript được đóng gói vào các file `.js` độc lập.
3. **Chặn CDN & External Fetch:** Không gọi bất kỳ URL ngoại vi nào (`fonts.googleapis.com`, `cdnjs.cloudflare.com`, telemetry endpoints). Tất cả asset, icons, font đều được bundle trong `web/dist/`.
4. **Markdown an toàn:** `react-markdown` chạy ở chế độ thuần AST, parse các cú pháp Markdown sang React Elements. Bất kỳ thẻ HTML thô nào (`<script>`, `<iframe>`, `<div>`) do model trả về đều bị escape thành text hoặc stripped, ngăn chặn triệt để XSS.

---

## 3. Dự toán Dung lượng Bundle (Performance Budget)

Ngân sách đặt ra trong yêu cầu:
- **Initial JS Bundle:** ≤ 300 KB gzip.
- **Static CSS:** ≤ 50 KB gzip.

### Dự toán phân bổ:
- **App Shell Core (React 19 + Radix primitives + Zustand + Query + Lucide icons rút gọn):** ~170 - 210 KB gzip.
- **Main CSS (Tailwind v4 compiled + CSS variables):** ~25 - 35 KB gzip.
- **Lazy Chunks (chỉ tải khi người dùng mở tab tương ứng):**
  - Tab Git / Review Diff (`react-diff-view` + `jsdiff`): ~40 KB gzip.
  - Tab Terminal (`@xterm/xterm` + `addon-fit`): ~75 KB gzip.
  - Code Viewer (`shiki` token engine + grammars phổ biến): ~65 KB gzip.
  - Skills Marketplace: ~25 KB gzip.

=> **Kết quả:** Initial load chỉ cần ~200 KB JS + ~30 KB CSS, vượt tiêu chuẩn ngân sách (dưới 300 KB / 50 KB). Thời gian Interactive (TTI) trên localhost đạt < 300ms.

---

## 4. Chiến lược Phân phối & Triển khai (Build Strategy)

Chúng tôi lựa chọn **Chiến lược A (Khuyên dùng)**:
1. **Mã nguồn UI mới** đặt tại thư mục: `CHATMCP-HUB/ui/`.
2. **Build output** xuất ra: `CHATMCP-HUB/web/dist/`.
3. **Commit thư mục build `dist/` vào repo:**
   - Cập nhật `.gitignore` để un-ignore: `!CHATMCP-HUB/web/dist/**`.
   - Trong CI GitHub Actions: thêm bước kiểm tra `npm run build` trong `CHATMCP-HUB/ui/` và sau đó chạy `git diff --exit-code CHATMCP-HUB/web/dist` để cam đoan bản build đã commit luôn trùng khớp 100% với mã nguồn TypeScript.
   - **Lợi ích tối thượng:** Người dùng cuối tải `ChatMCPSetup.exe`, người clone repo, người chạy Docker hay VPS Render **không cần phải chạy `npm install` hay `npm run build` cho frontend**. Mọi thứ sẵn sàng chạy ngay bằng Node.js như trước.

---

## 5. Cơ chế Phục vụ File An toàn trong `hub.mjs`

Sửa đổi `hub.mjs` để phục vụ thư mục build `CHATMCP-HUB/web/dist/`:
1. **Bảo vệ Path Traversal:**
   - Chuẩn hóa đường dẫn bằng `path.normalize()`.
   - Kiểm tra `path.resolve(distPath).startsWith(distRoot)`. Chặn đứng mọi nỗ lực `../`, `%2e%2e`, `%00`.
2. **Danh sách đuôi file cho phép (Allowlist):**
   - Chỉ cho phép: `.html`, `.js`, `.css`, `.woff2`, `.woff`, `.svg`, `.png`, `.webp`, `.ico`, `.json`, `.map`.
   - Bổ sung đầy đủ bảng `MIME` cho các định dạng trên.
3. **Cache-Control tối ưu:**
   - Với file tài nguyên có hash (vd: `assets/*.js`, `assets/*.css`): Đặt header `Cache-Control: public, max-age=31536000, immutable`.
   - Với `index.html`: Đặt `Cache-Control: no-cache, no-store, must-revalidate`.
4. **Chế độ Public Gating:**
   - Khi chưa đăng nhập trong public mode: Chỉ phục vụ `login.html`, `login.css`, `login.js`. Toàn bộ asset của app chính bị chặn `401 login_required`.

---

## 6. Kế hoạch Chuyển đổi & Chung sống (Rollout & Compatibility)

1. **Giao diện mới mặc định:** Đường dẫn `/` và `/index.html` sẽ phục vụ UI mới từ `web/dist/index.html`.
2. **Giao diện cũ (`/classic`):** UI React cũ (`react-app.js`, `react.css`) vẫn được giữ nguyên và truy cập được tại `/classic` hoặc `/legacy` trong phiên bản này để dự phòng rủi ro.
3. **Bảo toàn Test:**
   - Port `web/ui-logic.js` và `web/onboarding.js` sang TypeScript trong `CHATMCP-HUB/ui/src/lib/`, giữ nguyên file gốc để suite test hiện có `verify-ui-logic.mjs` tiếp tục PASS 100%.
   - Đặt các thuộc tính `data-testid` ổn định trên các thành phần UI mới để các bộ test Python (`verify-react-ui.py`, `verify-v2-ui.py`) hoặc Playwright mới kiểm thử chính xác hành vi tương đương.
