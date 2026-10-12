# Bảo mật ChatMCP — local-only

> This security policy describes the **v2.6.0 local-only release**. Hosted public mode, Cloud Harness MCP proxy, multi-tenant RBAC, Linux execution broker and Render/VPS deployment were removed from the current runtime. Older commits and previously deployed copies may still contain those features.

## Báo lỗi bảo mật

Tạo GitHub Security Advisory riêng tư nếu có thể; không đăng API keys, token, private keys hay dữ liệu cá nhân trong Issues công khai. Nếu không có kênh private, chỉ gửi mô tả không chứa bí mật và yêu cầu mở kênh trao đổi bảo mật.

## Phạm vi được hỗ trợ

- Local Windows app và Hub trên **127.0.0.1**, một chủ sở hữu.
- Agent file/Git/terminal, checkpoint, plugin/Skills Hub và provider gateway.
- Browser companion (nếu người dùng tự bật) được ghép qua loopback và xác thực riêng.
- **Không hỗ trợ** triển khai Hub qua địa chỉ mạng công khai, reverse proxy, Render/VPS, public multi-tenant hoặc backend Cloud Harness MCP.
- Có thể dùng API model ngoài hoặc Ollama/LM Studio ở loopback. Truyền dữ liệu ra provider là một quyết định riêng của người dùng.

## Threat model và giới hạn an toàn

1. Mã trong repository, SKILL.md và kết quả tìm kiếm là dữ liệu **không đáng tin**. Prompt injection có thể xuất hiện trong bất kỳ file nào.
2. Quyền công cụ được kiểm tra bởi PermissionGate. Review và Read-only hạn chế tác động; Full Access chỉ dùng khi người dùng chủ động đồng ý.
3. File path/symlink/Windows path normalization và checkpoint/SHA guards làm giảm rủi ro mất dữ liệu, nhưng không bảo đảm mọi lệnh shell đều vô hại.
4. **Git worktree không phải sandbox hệ điều hành.** Các coding workers chạy dưới tài khoản Windows đang dùng và không được quyền trực tiếp shell/push/merge; các công cụ file đã được hạn chế. Bản thân tài khoản vẫn có thể truy cập các vị trí mà hệ điều hành cho phép nếu có lỗ hổng.
5. Local Hub kiểm tra Host/Origin, chỉ listen trên 127.0.0.1, và bắt buộc CSRF cho POST. Các tiến trình khác cùng tài khoản Windows vẫn cần được coi là đáng tin cậy.
6. Skills tải từ GitHub ghim revision, xác minh SHA blob và giới hạn dung lượng. Assets/scripts được lưu, không tự động thực thi. Chỉ bật skills sau khi kiểm tra nội dung và giấy phép.
7. Kiểm tra mã nguồn/manifest có thể suy ra **bằng chứng** giấy phép, không thể tự động cho phép redistribution hay chứng minh quyền sở hữu.
8. Model/API requests, GitHub Skills refresh, Git push/Draft PR và nghiên cứu web là các thao tác có thể dùng mạng. **Local-only không phải offline-only**.
9. Bộ lọc secret/log và giới hạn size/timeout là defense in depth. Không đưa thông tin bí mật vào prompt hoặc repository không tin tưởng.
10. SandboxEngine trạng thái host không phải cách ly VM/AppContainer. Docker test sandbox nếu có là một tính năng cục bộ tùy chọn, khác với việc host ChatMCP trên Docker.

## Lưu ý an ninh từ lịch sử Cloud Harness

Các bản cũ của repository có thể chứa thông tin xác thực/URL Cloud Harness hoặc cấu hình deploy trong **Git history**. Việc xóa file khỏi HEAD **không xóa lịch sử Git và không thu hồi một token đã lộ**. Nếu token cũ từng có hiệu lực, chủ sở hữu phải thu hồi/xoay token trên dịch vụ liên quan và đánh giá các bản sao đã clone. Không dựa vào việc xóa file để kết luận token an toàn.

Nếu từng triển khai public server từ bản cũ, cần tắt riêng những tài nguyên đó ở nền tảng quản lý (Render/VPS/Docker) sau khi sao lưu dữ liệu. Nhánh local-only không tự đóng các server đã triển khai trước đây.

## Kiểm thử và phát hành

React approval review reads the actual PermissionGate request IDs and server-provided previews; only explicit Approve/Deny actions submit a decision. Expired/cancelled decisions remain visible in history. New-conversation and SSE handling do not authorize tools or replay mutations. UI/mock-provider regression tests establish these specific flows, not OS isolation or live-model safety.

The AI configuration form clears typed credentials after successful persistence and when the selected provider or endpoint origin changes. This prevents an unsaved key being carried to another destination; backend key storage and provider transmission still follow the existing local secret policy.

Installer builds enumerate tracked runtime files and fresh Vite output instead of copying whole checkout folders. Ignored user state, imported skills, test output and development dependencies are excluded; symlink/junction payload sources and unsafe staging cleanup paths fail the build. This packaging check does not certify installer lifecycle behavior on a clean machine.

- Chạy regression tests, desktop frontend build, Windows installer build và kiểm thử cài/gỡ trên máy ảo Windows sạch.
- Không mở cổng Hub ra Internet. Không bypass Origin/CSRF để dùng ở mạng LAN.
- Không xem CI xanh như penetration test hay chứng nhận legal license.
- Release installer nên ký Authenticode nếu có certificate, và xuất checksum SHA-256 sau khi ký.

[README](README.md) · [Windows Setup](docs/WINDOWS-SETUP.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)
