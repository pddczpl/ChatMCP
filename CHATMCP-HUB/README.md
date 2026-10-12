# ChatMCP Hub — local runtime

Đây là Hub nền của [ChatMCP Studio](../README.md), chạy dưới tài khoản người dùng và chỉ phục vụ loopback (127.0.0.1). Các kết nối tới API model/GitHub là **outbound** theo tính năng được sử dụng, không phải public hosting.

## Chạy trên Windows

~~~powershell
.\START-CHATMCP-HUB.cmd -ProjectPath 'C:\Projects\Demo'
~~~

Có thể dùng backend local duy nhất; các flag -RepoRoot, -Backend mcp và CHATMCP_PUBLIC=1 đã bị loại bỏ.

## Các thành phần

- lib/manager.mjs: trạng thái Hub, workspace, local catalog và permission-gated tool sessions.
- lib/agent.mjs và lib/gateway-provider.mjs: vòng lặp coding agent và model providers.
- lib/studio-workspace.mjs, lib/local-tools.mjs, lib/git-runner.mjs: Git, file operations, checks, checkpoint.
- lib/coding-orchestrator.mjs và lib/studio-delegates.mjs: worktree coding agents và read-only DAG.
- lib/skill-registry.mjs và lib/plugins.mjs: pinned GitHub skills và import tài nguyên.
- extension/: browser companion tự chọn của người dùng, không phải Cloud Harness proxy.

## An toàn

Hub chỉ listen 127.0.0.1 và kiểm tra Host, Origin, CSRF. PermissionGate bảo vệ tools; worktree không cung cấp cách ly VM/OS. Không mở Hub trực tiếp ra Internet.

## Test

~~~powershell
node tests/run-all.mjs
~~~

Xem [README gốc](../README.md), [SECURITY](../SECURITY.md) và [Windows Setup](../docs/WINDOWS-SETUP.md).
