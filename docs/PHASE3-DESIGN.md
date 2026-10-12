# Thiết kế kỹ thuật — Phase 3 (Sandboxing, Multi-Workspace Isolation & Multi-Profile AI)

> **Tài liệu tham chiếu:** [ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](../SECURITY.md) · [PHASE3-REPORT.md](PHASE3-REPORT.md)  
> **Phiên bản:** 2.3.0 · **Mã nguồn:** `lib/workspace-lock.mjs`, `lib/ai-profiles.mjs`, `lib/sandbox-engine.mjs`, `lib/permissions.mjs`, `hub.mjs`

---

## 1. Mục tiêu và bối cảnh Phase 3

Phase 3 nâng cấp hệ thống ChatMCP từ một coding agent đơn nhiệm trên một thư mục sang nền tảng hỗ trợ:
1. **Kiểm soát đồng thời Workspace (Concurrency & Locking):** Ngăn chặn xung đột file khi nhiều tiến trình hoặc tác vụ cùng chạy trên một workspace.
2. **Đa hồ sơ AI (Multi-Profile AI Configuration):** Quản lý đồng thời nhiều mô hình (Claude 3.5 Sonnet lập trình, GPT-4o đánh giá mã, Ollama cục bộ bảo mật) với khả năng chuyển đổi linh hoạt và mã hóa thông tin xác thực.
3. **Động cơ Sandbox hợp nhất (Unified Sandbox Engine):** Cung cấp tầng trừu tượng thực thi linh hoạt (`host`, `broker`, `isolated`) với hạn ngạch tài nguyên (RAM, CPU, timeout) và thu thập số liệu vận hành chi tiết.
4. **Chế độ Full Access 1-Click an toàn:** Cho phép người dùng chuyển đổi trực tiếp trên thanh công cụ UI với cảnh báo rõ ràng, duy trì nguyên tắc bất biến cấm truy cập file nhạy cảm (`.env`, `.git/`, credential keys).

---

## 2. Kiến trúc các thành phần cốt lõi

### 2.1. Khóa đồng thời Workspace (`WorkspaceLock`)

Nằm tại [`CHATMCP-HUB/lib/workspace-lock.mjs`](../CHATMCP-HUB/lib/workspace-lock.mjs).

- **Cơ chế ghi nguyên tử:** Lưu file `.chatmcp-workspace.lock` tại thư mục gốc của workspace chứa:
  ```json
  {
    "pid": 12345,
    "taskId": "task-uuid",
    "acquiredAt": 1718000000000,
    "workspaceRoot": "F:/Project/App"
  }
  ```
- **Kiểm tra tiến trình còn sống (PID liveness):** Dùng `process.kill(pid, 0)` để xác định tiến trình giữ khóa còn tồn tại hay không.
- **Tự động thu hồi khóa chết (Stale Lock Reclaim):**
  - Nếu PID không còn tồn tại trên hệ điều hành (`process_dead`).
  - Hoặc thời gian giữ khóa vượt quá 30 phút (`expired`).
  - Khóa được giải phóng tự động khi tác vụ mới xin giữ, tránh treo workspace vĩnh viễn sau sự cố sập nguồn/crash.

### 2.2. Trình quản lý Đa cấu hình AI (`AiProfiles`)

Nằm tại [`CHATMCP-HUB/lib/ai-profiles.mjs`](../CHATMCP-HUB/lib/ai-profiles.mjs).

- **Lưu trữ độc lập:** Quản lý danh sách trong file `ai-profiles.json` tại thư mục trạng thái (`stateDir`).
- **An toàn khóa API (Credential Security):**
  - Các hàm `list()` và `get()` tự động ẩn hoàn toàn khóa API (`apiKey`, `encryptedKey`), chỉ trả cờ `hasKey: true`.
  - Hỗ trợ lưu trữ tham chiếu biến môi trường (`envKeyName`) hoặc mã hóa khóa qua KeyStore (DPAPI trên Windows / AES).
  - Hàm `resolveConfig(id)` giải mã khóa an toàn trong bộ nhớ chỉ khi khởi tạo kết nối gateway cho phiên thực thi.
- **Chuyển đổi mặc định an toàn:** Tự động chỉ định profile mặc định và cập nhật cascade khi profile hiện tại bị xóa.

### 2.3. Động cơ Sandbox hợp nhất (`SandboxEngine`)

Nằm tại [`CHATMCP-HUB/lib/sandbox-engine.mjs`](../CHATMCP-HUB/lib/sandbox-engine.mjs).

- **Ba chế độ thực thi (`SANDBOX_MODES`):**
  - `'host'`: Chạy qua `ShellRunner` với phân tích cú pháp an toàn, kiểm tra whitelist, bảo vệ file hệ thống Windows.
  - `'broker'`: Thực thi qua Unix command broker tách biệt UID người dùng (dành cho môi trường Linux VPS/Docker).
  - `'isolated'`: Chế độ cô lập bổ sung hỗ trợ containerization trong tương lai.
- **Hạn ngạch tài nguyên (`DEFAULT_LIMITS`):**
  - `timeoutSeconds`: 120s (tối đa 900s).
  - `maxMemoryMb`: 512 MB.
  - `maxCpuCores`: 1 core.
  - `maxOutputBytes`: 100 KB.
- **Ghi nhận số liệu:** Mỗi lệnh trả về thời gian chạy thực tế (`durationMs`), cờ hết giờ (`timedOut`), mã thoát (`exitCode`), và toàn bộ luồng stdout/stderr.

### 2.4. Chế độ Full Access 1-Click trên UI

- **Thanh công cụ Composer:** Tích hợp nút `[ Full Access ⚠️ ]` trực tiếp trên thanh công cụ với cảnh báo trực quan viền đỏ nổi bật.
- **Xác nhận người dùng:** Yêu cầu người dùng xác nhận tường minh trước khi kích hoạt.
- **Tự động hoàn nguyên:** Khi người dùng chuyển sang bất kỳ chế độ an toàn nào khác (`readonly`, `review`, `autonomous`), chính sách thực thi tự động hạ cấp về `host-review`.
- **Nguyên tắc bảo vệ tối cao:** Mọi đường dẫn cấm (`.env`, `.git/`, DPAPI keys) vẫn bị chặn vĩnh viễn kể cả ở chế độ Full Access (Fail-closed by design).

---

## 3. Giao tiếp API & Tuyến đường Hub

Hub cung cấp các điểm cuối mới phục vụ Phase 3:

| Phương thức | Tuyến đường | Mô tả | Bảo vệ |
|---|---|---|---|
| `GET` | `/api/ai/profiles` | Liệt kê danh sách hồ sơ AI (đã che giấu key) | Session / Host |
| `POST` | `/api/ai/profiles/upsert` | Tạo hoặc cập nhật hồ sơ mô hình | CSRF + Header |
| `POST` | `/api/ai/profiles/default` | Đặt hồ sơ mặc định | CSRF + Header |
| `POST` | `/api/ai/profiles/delete` | Xóa hồ sơ mô hình | CSRF + Header |
| `GET` | `/api/sandbox/status` | Truy vấn trạng thái sandbox & quota | Session / Host |
| `GET` | `/api/workspace/lock` | Kiểm tra tình trạng khóa workspace | Session / Host |

---

## 4. Kiểm chứng chất lượng

Mọi thành phần trong Phase 3 đều được bảo vệ bằng kiểm thử tự động:
- Bộ kiểm thử [`tests/verify-phase3-features.mjs`](../CHATMCP-HUB/tests/verify-phase3-features.mjs) xác minh 17 tiêu chí bao gồm khóa đồng thời, khôi phục khóa chết, quản lý hồ sơ AI và thực thi sandbox.
- Bộ kiểm thử [`tests/verify-full-access.mjs`](../CHATMCP-HUB/tests/verify-full-access.mjs) xác minh 15 tiêu chí an toàn của chế độ Full Access.
- Bộ kiểm thử [`tests/verify-public-http.mjs`](../SECURITY.md) (historical public-mode verification suite was removed) và [`tests/verify-permissions-modes.mjs`](../CHATMCP-HUB/tests/verify-permissions-modes.mjs) đảm bảo không có bất kỳ hồi quy nào.
