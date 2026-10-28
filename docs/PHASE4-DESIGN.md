# Thiết kế kỹ thuật — Phase 4 (Skills Marketplace & Plugin System, Multi-User RBAC & Enterprise Governance)

> **Tài liệu tham chiếu:** [ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](../SECURITY.md) · [PHASE4-REPORT.md](PHASE4-REPORT.md)  
> **Phiên bản:** 2.3.0 · **Mã nguồn:** `lib/plugins.mjs`, `lib/governance.mjs`, `hub.mjs`, `web/react-app.js`

---

## 1. Mục tiêu và bối cảnh Phase 4

Phase 4 trang bị cho ChatMCP hệ sinh thái mở rộng và kiến trúc quản trị doanh nghiệp:
1. **Chợ kỹ năng & Hệ thống Plugin (Skills Marketplace & Plugin System):** Cho phép người dùng khám phá, cài đặt, bật/tắt các bộ kỹ năng chuyên sâu (Git Workflow Pro, Python Architect, Docker DevOps) và tích hợp công cụ MCP từ bên thứ ba (SQLite Explorer, Web Researcher) với 1-click.
2. **Phân quyền người dùng (Multi-User Role-Based Access Control - RBAC):** Thiết lập ma trận phân quyền theo vai trò (`viewer`, `developer`, `admin`) để bảo vệ dữ liệu nhạy cảm, ngăn chặn thao tác phá hoại hoặc leo thang đặc quyền.
3. **Cô lập không gian làm việc đa người thuê (Tenant Workspace Isolation):** Phân định ranh giới sở hữu workspace theo `tenantId`, bảo đảm người dùng thuộc tenant này không thể truy cập, khóa hoặc xuất mã nguồn của tenant khác.
4. **Nhật ký kiểm toán doanh nghiệp (Enterprise Structured Audit Trail):** Ghi nhận có cấu trúc (append-only JSONL) mọi hành động trọng yếu (chỉnh sửa file, thực thi lệnh, cài đặt plugin, thay đổi cấu hình) phục vụ tuân thủ an ninh và điều tra sự cố.

---

## 2. Kiến trúc các thành phần cốt lõi

### 2.1. Chợ kỹ năng & Quản lý Plugin (`PluginManager`)

Nằm tại [`CHATMCP-HUB/lib/plugins.mjs`](../DATGOLD-HUB/lib/plugins.mjs).

- **Danh mục Chợ kỹ năng tuyển chọn (`MARKETPLACE_CATALOG`):**
  - `git-workflow-pro` (coding): Tự động hóa commit ngữ nghĩa, tạo PR template, hỗ trợ gộp nhánh.
  - `python-architect` (coding): Phân tích cú pháp AST, sinh test pytest tự động, kiểm tra PEP-8.
  - `docker-devops` (devops): Phân tích Dockerfile đa tầng, kiểm tra Docker Compose, chẩn đoán container.
  - `sqlite-mcp-explorer` (mcp-servers): Truy vấn SQLite, trích xuất lược đồ cơ sở dữ liệu qua MCP protocol.
  - `web-researcher` (research): Tìm kiếm tài liệu kỹ thuật, tra cứu changelog thư viện qua web scraping.
  - `security-compliance-guard` (governance): Quét bí mật, chứng chỉ, khóa riêng và kiểm tra giấy phép mã nguồn mở.
- **Vòng đời Plugin:**
  - `marketplace({ category, query })`: Tìm kiếm, phân loại theo danh mục (`coding`, `devops`, `mcp-servers`, `research`, `governance`) và trả trạng thái đã cài đặt.
  - `install(id, customDefinition)`: Cài đặt plugin có sẵn từ chợ hoặc manifest tự định nghĩa.
  - `toggle(id, enabled)`: Bật/tắt plugin linh hoạt theo nhu cầu phiên làm việc.
  - `uninstall(id)`: Gỡ bỏ plugin an toàn.
  - `activeSkills()`: Tập hợp toàn bộ prompt hướng dẫn và công cụ của các plugin đang bật để bơm vào ngữ cảnh của Agent loop.
- **Lưu trữ trạng thái:** Lưu bền vững tại `installed-plugins.json` trong thư mục trạng thái của Hub.

### 2.2. Quản trị Doanh nghiệp, RBAC & Cô lập Tenant (`GovernanceManager`)

Nằm tại [`CHATMCP-HUB/lib/governance.mjs`](../SECURITY.md) (historical multi-tenant governance module was removed).

- **Ma trận phân quyền (RBAC Matrix):**
  - **`viewer`**: Chỉ đọc (`read`, `search`, `view_diff`, `view_status`, `view_audit`). Không được sửa file, không được chạy lệnh, không được cấu hình AI.
  - **`developer`**: Quyền lập trình viên (`read`, `edit`, `checkpoint`, `restore`, `exec_test`, `exec_cmd`). Phải tuân thủ cổng phê duyệt và không được quản lý plugin hay shutdown máy chủ.
  - **`admin`**: Toàn quyền quản trị (`manage_plugins`, `config_ai`, `full_access`, `manage_users`, `shutdown`).
- **Cô lập ranh giới Tenant:**
  - Phương thức `registerWorkspace(tenantId, path)` gắn quyền sở hữu thư mục.
  - Phương thức `canAccessWorkspace(tenantId, path)` từ chối mọi yêu cầu chéo tenant (`tenant_cross_access_denied`).
- **Nhật ký kiểm toán (`enterprise-audit.jsonl`):**
  - Ghi tuần tự:
    ```json
    {
      "id": "uuid",
      "timestamp": "2026-10-11T14:30:00.000Z",
      "actor": "user-developer",
      "role": "developer",
      "action": "edit",
      "target": "src/app.py",
      "allowed": true,
      "reason": "permitted"
    }
    ```
  - Hỗ trợ truy vấn lọc theo hành động, người dùng và giới hạn số bản ghi qua `queryAudit()`.

---

## 3. Điểm cuối API Hub phục vụ Phase 4

| Phương thức | Tuyến đường | Mô tả | Quyền yêu cầu |
|---|---|---|---|
| `GET` | `/api/plugins/marketplace` | Duyệt danh mục chợ kỹ năng (hỗ trợ category & query) | Session / Host |
| `GET` | `/api/plugins/installed` | Danh sách plugin đã cài và active skills | Session / Host |
| `POST` | `/api/plugins/install` | Cài đặt plugin mới | Admin / CSRF |
| `POST` | `/api/plugins/toggle` | Bật/tắt trạng thái plugin | Admin / CSRF |
| `POST` | `/api/plugins/uninstall` | Gỡ bỏ plugin | Admin / CSRF |
| `GET` | `/api/governance/audit` | Truy vấn nhật ký kiểm toán doanh nghiệp | Viewer+ / CSRF |
| `POST` | `/api/governance/rbac/verify` | Kiểm tra quyền của vai trò đối với hành động | Session / CSRF |

---

## 4. Kiểm chứng an toàn và tính toàn vẹn

- Bộ kiểm thử tự động [`tests/verify-phase4-features.mjs`](../DATGOLD-HUB/tests/verify-phase4-features.mjs) xác minh 18/18 tiêu chí (Chợ kỹ năng, lọc danh mục, cài đặt, bật/tắt, gỡ bỏ, ma trận RBAC, cô lập tenant, audit log và HTTP API Hub).
- Không hồi quy bất kỳ tính năng nào của các Phase trước (55/55 bộ Node kiểm thử đều đạt).
