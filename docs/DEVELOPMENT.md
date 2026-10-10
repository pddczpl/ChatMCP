# Hướng dẫn phát triển

## Môi trường

| Công cụ | Yêu cầu | Dùng cho |
|---|---|---|
| Node.js | ≥ 22 (đã chạy test với 22.23 và 24.19) | Hub và toàn bộ kiểm thử |
| Git | 2.4x trở lên | quy trình phát triển |
| PowerShell | Windows PowerShell 5.1 (có sẵn trên Windows 11) | launcher, script, kiểm thử script |
| Python 3.11 | tùy chọn | chỉ mục ký hiệu Python (`py -3.11` trên Windows) và kiểm thử giao diện Playwright |
| Docker Desktop | tùy chọn | Cloud Harness MCP và sandbox chạy test |

Hub **không có bước build** và không có dependency bắt buộc để `npm install`. `node-pty` (ConPTY) là tùy chọn: `CHATMCP-HUB\windows\Install-OptionalConPTY.ps1`; khi thiếu hoặc hỏng, terminal tương tác tự dùng pipe.

## Chạy kiểm thử

```powershell
cd CHATMCP-HUB
npm test                                         # 26 bộ kiểm thử Node, mỗi bộ một tiến trình
node tests/run-all.mjs --list                    # liệt kê
node tests/run-all.mjs --filter studio --verbose # lọc theo tên, in toàn bộ đầu ra
node tests/run-all.mjs --json test-results/summary.json
npm run test:ui                                  # 4 bộ giao diện Python/Playwright (tùy chọn)
```

Runner in một dòng cho mỗi bộ (`PASS`/`FAIL`/`TIMEOUT`/`SKIP`, thời gian, mã thoát thật) và thoát khác 0 nếu có bộ nào fail hoặc quá hạn (mặc định 180 giây/bộ, đổi bằng `--timeout`). Bộ kiểm thử có thể in một dòng `CHATMCP_TEST_SKIP: <lý do>` rồi thoát 0 để được báo là SKIP — không bao giờ được tính là PASS.

Script ở thư mục gốc có kiểm thử riêng, chạy bằng dữ liệu giả trong thư mục tạm:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tests\Test-RotateToken.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tests\Test-Bootstrap.ps1
bash scripts/tests/test-bootstrap.sh              # Linux/macOS/Git Bash
```

## Viết kiểm thử mới

- Tạo thư mục tạm bằng `fs.mkdtemp(path.join(os.tmpdir(), …))`; không bao giờ đọc/ghi thư mục trạng thái thật của Hub.
- Dùng `fileURLToPath(new URL(…, import.meta.url))`, **không** dùng `URL.pathname` (trên Windows cho `/F:/…`).
- Dọn dẹp bằng `await terminal.close()` *trước* `fs.rm(…)`; trên Windows tiến trình con giữ cwd sẽ gây `EBUSY`.
- Symlink file cần Developer Mode/quyền quản trị trên Windows (`EPERM`). Hãy thử symlink, nếu bị từ chối thì dùng junction thư mục và ghi rõ trong đầu ra.
- Lệnh shell trong test không nên chứa dấu nháy kép lồng nhau: PowerShell 5.1 xử lý khác POSIX (xem *Giới hạn đã biết*).
- Bí mật trong dữ liệu kiểm thử phải là giá trị giả có tiền tố rõ ràng (`FAKE-…`).
- Test hồi quy cho lỗi đã sửa phải **fail trên mã cũ** — hãy chạy thử trước khi tin nó.

## Quy ước Git

- Làm việc trên nhánh riêng (`dev/chatmcp-agent`), không push thẳng `main`, không force-push, không viết lại lịch sử khi chưa có sự đồng ý của chủ sở hữu.
- Commit nhỏ, một mục đích, kiểu Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`); thân commit nêu nguyên nhân, bằng chứng và điều *chưa* được kiểm chứng.
- Không commit: `node_modules`, state/transcript/log, bản sao lưu, ZIP, `.env*`, khóa. Trước khi push: `git ls-files -ci --exclude-standard` phải rỗng.
- Cuối dòng: `.gitattributes` dùng `text=auto` — file đã commit với CRLF không bị viết lại; `.sh` luôn LF, `.ps1/.cmd/.bat` luôn CRLF khi checkout. Giữ script `.ps1` ở ASCII (Windows PowerShell 5.1 đọc file không BOM theo ANSI).

## Đặc thù Windows cần nhớ

- Đường dẫn người dùng có thể chứa dấu cách và dạng ngắn 8.3 (`C:\Users\DATPHA~1\…`): so sánh đường dẫn luôn qua `fs.realpath`.
- Dừng cây tiến trình bằng `taskkill /PID <pid> /T /F`; trên POSIX gửi tín hiệu tới process group.
- `$PSScriptRoot` dùng trong giá trị mặc định của `param()` trả về rỗng khi chạy `powershell -File` trên PS 5.1 (đã gặp) — hãy tính trong thân script.
- Hàm PowerShell tên `Git` sẽ che `git.exe` và gây đệ quy vô hạn; đặt tên hàm có tiền tố.

## Cấu trúc thư mục

```
CHATMCP-HUB/       Hub (hub.mjs, lib/, web/, extension/, tests/, windows/, workers/)
deps/              khóa phiên bản phụ thuộc bên thứ ba
scripts/           bootstrap Cloud Harness, xoay token, kiểm thử script
docs/              kiến trúc, audit, hướng dẫn
CHATMCP-LOCAL-SETUP/, START-*.{cmd,ps1}, install.sh, manifest.json, bridge.js …   legacy
```

## Giới hạn đã biết

- **Trích dẫn PowerShell 5.1.** Lệnh có dấu nháy kép lồng nhau (`node -e "console.log(\"x\")"`) bị PowerShell 5.1 làm hỏng khi truyền cho chương trình native. Hub chạy lệnh bằng `powershell -Command`; agent cần được nhắc rằng shell là PowerShell, và một lớp `ShellRunner` có chọn shell nằm trong kế hoạch Phase 1.
- Bộ giao diện Python (`npm run test:ui`) không nằm trong baseline Phase 0 và chưa được chạy.
- Workflow CI (`.github/workflows/ci.yml`) đã được viết nhưng **chưa từng chạy trên GitHub** — chỉ chạy sau khi nhánh được push; đừng coi CI là xanh cho tới khi thấy kết quả thật.
