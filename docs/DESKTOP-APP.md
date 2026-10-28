# DatGold Desktop — Windows build and release guide

Hướng dẫn phát hành DatGold Studio trên **Windows 10/11 x64** từ mã nguồn đã được review. Đây là tài liệu dành cho maintainer; người dùng cuối tải bản cài tại [GitHub Releases](https://github.com/pddczpl/ChatMCP/releases).

## Tổng quan

- **Ứng dụng Windows:** WinForms + WebView2, xuất thành ChatMCP.exe từ desktop-shell/ChatMCP.csproj.
- **Bộ cài:** DatGoldSetup.exe từ installer/ChatMCP.Installer.csproj (bản đến v3.10.2 tên là ChatMCPSetup.exe).
- Hai dự án C# hiện nhắm **net10.0-windows**, build self-contained win-x64.
- **Frontend React:** DATGOLD-HUB/ui -> DATGOLD-HUB/web/dist. Bắt buộc build lại UI nếu thêm tab/tính năng.
- **Backend:** Node.js portable được đóng cùng installer; Git for Windows, WebView2 Runtime và nhà cung cấp AI/API key không đi kèm.
- Coding workers chỉ cô lập Git worktree, **không cô lập tiến trình hệ điều hành**. Đừng sử dụng như sandbox cho người dùng không tin cậy.
- CI xanh là điều kiện cần, **không phải bằng chứng đã test cài/gỡ trên máy Windows sạch**.

## 1. Điều kiện cần trước khi build

| Thành phần | Yêu cầu |
| --- | --- |
| Windows | Windows 10/11 x64 |
| Git for Windows | Checkout mã, Git worktrees |
| Node.js | 22+ kèm npm |
| .NET SDK | 10.0+ |
| Internet lúc build | Để tải npm/NuGet nếu cache chưa có |
| WebView2 Runtime | Cần trên máy chạy/test desktop |

Mở PowerShell:

~~~powershell
git --version
node --version
npm --version
dotnet --version
~~~

## 2. Chọn release commit và đồng bộ phiên bản

Trước khi build bản công khai, merge PR sau review/CI và **chọn số version chính thức**, v2.6.0 là phiên bản local-only tiếp theo sau v2.5.0; kiểm tra tag hiện có trước khi chọn phiên bản tiếp theo.

Đồng bộ các vị trí sau khi tăng version:
- DATGOLD-HUB/package.json và VERSION trong DATGOLD-HUB/lib/manager.mjs
- desktop-shell/ChatMCP.csproj và installer/ChatMCP.Installer.csproj
- DATGOLD-HUB/ui/package.json và package-lock.json nếu tăng version UI
- UI_BUILD ở DATGOLD-HUB/hub.mjs cùng DATGOLD-HUB/ui/src/lib/api.ts khi thay build identity
- README.md, CHANGELOG.md và các assertion phụ thuộc version

~~~powershell
git switch main
git pull --ff-only origin main
git status --short
git rev-parse HEAD
~~~

Chỉ release khi trạng thái Git sạch và HEAD đúng commit đã review.

## 3. Kiểm thử và build installer

~~~powershell
node .\DATGOLD-HUB\tests\run-all.mjs
npm ci --prefix .\DATGOLD-HUB\ui
npm run build --prefix .\DATGOLD-HUB\ui
.\scripts\Build-Installer.ps1
~~~

Script tự kiểm tra .NET SDK 10 / Node.js 22, chạy lại npm ci và frontend build, publish self-contained executable, chép tài nguyên Hub, portable node.exe rồi nén vào installer.

Sau khi thành công:

~~~text
dist\DatGoldSetup.exe
dist\DatGoldSetup.exe.sha256
dist\DatGold-Browser-Companion.zip (và bản sao ChatMCP-Browser-Companion.zip, cùng checksum riêng)
~~~

Kiểm tra SHA-256:

~~~powershell
$exe = '.\dist\DatGoldSetup.exe'
$actual = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$expected = ((Get-Content "$exe.sha256" -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
if ($actual -ne $expected) { throw 'Installer checksum mismatch; stop release' }
Write-Host "SHA-256 OK: $actual"
~~~

GitHub Actions ở đúng commit cũng xuất artifact **DatGoldSetup-win-x64** (EXE, Companion và các checksum) và **chatmcp-ui-dist**. Đây là build artifact, không phải bản release đã phát hành.

## 4. Kiểm thử trên Windows sạch trước khi công bố

Dùng máy ảo Windows sạch, ghi lại kết quả:
1. Cài DatGoldSetup.exe, khởi chạy DatGold Studio, kiểm tra WebView2 và launcher/Hub.
2. Tạo/chọn repository Git thử nghiệm không chứa thông tin bí mật. Chọn chế độ Review.
3. Cấu hình model có khả năng gọi công cụ (hoặc Ollama/LM Studio hỗ trợ tool calling).
4. Kiểm tra đọc file, sửa file có phê duyệt, Git diff, checkpoint và restore.
5. Thử Skills Hub: tìm SKILL.md thật, tải nested/binary resources, kiểm tra file hash và mặc định disabled. Script của nguồn bên ngoài không được tự thực thi.
6. Tắt ứng dụng, kiểm tra Hub không còn tiến trình con ngoài ý muốn; thử uninstall và hành vi lưu trữ dữ liệu theo chính sách.

Không đánh dấu bước này hoàn tất chỉ vì dotnet build hoặc CI xanh.

## 5. Code signing và GitHub Release

Nếu có chứng chỉ Authenticode hợp lệ, ký các executable theo quy trình ký Windows. **Sau khi ký bất kỳ file phân phối nào, tính lại SHA-256**. Chữ ký giúp xác định nhà phát hành nhưng không thay thế kiểm thử bảo mật.

Tag phải trỏ đến **chính commit đã kiểm thử/build**:

~~~powershell
git rev-parse HEAD
git tag -a vX.Y.Z -m "DatGold vX.Y.Z"
git push origin vX.Y.Z
gh auth status
gh release create vX.Y.Z .\dist\DatGoldSetup.exe .\dist\DatGoldSetup.exe.sha256 .\dist\DatGold-Browser-Companion.zip .\dist\DatGold-Browser-Companion.zip.sha256 .\dist\ChatMCP-Browser-Companion.zip .\dist\ChatMCP-Browser-Companion.zip.sha256 --draft --title "DatGold vX.Y.Z" --generate-notes
~~~

Xem lại nội dung và file checksum trên Draft Release rồi publish thủ công. Chưa chọn version / chưa test máy sạch thì không tạo tag hay release.

## 6. Chạy development từ source

~~~powershell
git clone https://github.com/pddczpl/ChatMCP.git
cd ChatMCP
# Test nhánh beta PR chưa merge:
# git fetch origin
# git switch feat/parallel-coding-agents-skills-registry-v2
npm ci --prefix .\DATGOLD-HUB\ui
npm run build --prefix .\DATGOLD-HUB\ui
.\START-CHATMCP-DESKTOP.cmd
~~~

Chỉ cần Hub qua browser:

~~~powershell
.\DATGOLD-HUB\START-CHATMCP-HUB.cmd -ProjectPath 'C:\Projects\Demo'
~~~

Sau khi cập nhật code, hãy dừng Hub cũ trước khi khởi động bản mới. Không tự tắt tiến trình không thuộc DatGold.

## 7. Gỡ cài đặt và xử lý lỗi

Gỡ bằng Windows Settings -> Apps -> Installed apps hoặc trình Uninstall.exe của bản cài. Trước khi xóa dữ liệu trong %LOCALAPPDATA%\ChatMCP, sao lưu những cuộc hội thoại và cấu hình bạn muốn giữ.

Nếu Desktop không mở, kiểm tra WebView2 Runtime, cổng 3007, Git for Windows, Hub log và phiên bản frontend/backend.

Tài liệu liên quan: [Windows setup](WINDOWS-SETUP.md), [User guide](USER-GUIDE.md), [Troubleshooting](TROUBLESHOOTING.md), [Architecture](ARCHITECTURE.md), [Security](../SECURITY.md).
