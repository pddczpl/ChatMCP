# G6 — Kiểm thử bộ cài trên Windows sạch, 2026-10-13

**PASS: 55/55 kiểm tra vòng đời thực tế; host exit 0, guest exit 0, cleanup xác nhận.**
Đây là cài baseline **2.6.0 → cập nhật tại chỗ sang candidate 2.6.0**, không phải
một phiên bản mới được tự tạo. Kết quả G6 này không thay đổi cổng bảo mật G4 và
không cho phép merge/release.

## Môi trường và định danh

- Thời gian: **22:04:12–22:06:11, ngày 13/10/2026, Asia/Bangkok**.
- Host: Windows 11 Pro **10.0.26300**, Windows Sandbox CLI **0.8.107.0**,
  .NET SDK **10.0.401**, Node **v24.19.0**.
- Guest mới: Windows 11 Enterprise **10.0.26100 x64**, 4095 MB RAM; không có
  node, npm, dotnet, Git trên PATH; chưa có ứng dụng, dữ liệu hay registry ChatMCP.
- UUID duy nhất sở hữu: `0edf8eda-eb16-4487-99cb-44c244c96704`.
- Guest bị tắt mạng, clipboard và printer redirection; bộ cài/script được map
  read-only, chỉ thư mục evidence riêng được ghi.
- WebView2 **155.0.4283.45** được cài offline trong guest bằng bộ cài Microsoft
  có Authenticode hợp lệ. Đây là prerequisite đã được README công bố, không phải
  runtime phát triển. Không cài/gỡ phần mềm hay bật tính năng trên host.
- Tài khoản desktop `WDAGUtilityAccount` của G6 chạy elevated; đây **không phải**
  restricted child token của thử nghiệm G4. CDP được bật bằng policy HKLM chỉ
  dành cho `ChatMCP.exe` trong guest rồi xóa sau mỗi lần khởi chạy.

Source tại lần chạy này: HEAD **`497c082bdde937dad935dcec60244909dc341b6e` + working-tree changes**,
`dirty: true`. Không mô tả nó là commit đã sạch hoặc đã xuất bản.
Các hash source/binary được lưu tại
[source-and-artifact-hashes.json](evidence/g6-clean-install-2026-10-13/source-and-artifact-hashes.json).

| Artifact | Phiên bản / SHA-256 |
| --- | --- |
| Baseline thật đã giữ lại | `2.6.0+cb97f1901e9b007be46b23ab05a5be85e2a46e3f` |
| Baseline installer | `155d2f1b8777deb47e963fb362618bc2d864b5b9378de00982bb158ac4f1575a` |
| Candidate | `2.6.0+497c082bdde937dad935dcec60244909dc341b6e` + các thay đổi source nói trên |
| Candidate installer | `7224ff9ad030e4d20b1d9b9284553c592632928a1c5ae476fce8f4c3873e95bd` |
| GuestSupervisor đóng trong candidate | `b822407d785164a313493e5cf9afc4e04996b64f2ac9d42f6b143f86ba8a3528` |

## Quan sát thực tế

1. Wizard baseline cài thành công (exit 0). Layout chứa desktop executable,
   WebView2 loader, Node portable cùng SHA-256, Hub/UI, GuestSupervisor cùng
   SHA-256 và uninstaller. Shortcut và Windows Installed Apps trỏ đúng bản cài.
2. **Ứng dụng ChatMCP.exe thật** khởi chạy Hub bằng Node đã cài và render React
   trong WebView2 thật; onboarding mới xuất hiện. API thật lưu profile BYO không
   chứa API key, chọn workspace mới rỗng khi chưa cài Git, không tạo AI task.
   Đóng desktop đồng thời dọn đúng Hub con. Probe exit **0**.
3. Wizard candidate cập nhật lên chính thư mục đó (exit 0); executable của
   uninstaller mới khớp hash candidate. Profile BYO được giữ nguyên từng byte.
   Profile này hiện nằm trong `CHATMCP-HUB/ai-profiles.json` tại thư mục cài đặt;
   installer manifest bảo vệ dữ liệu runtime này khỏi việc gỡ nhầm.
4. Khởi chạy candidate xác nhận lại React, model profile, workspace và
   localStorage onboarding đã lưu. Probe exit **0**. Preflight đã cài báo
   `available:false`, `osIsolated:false`, `featureState:"Disabled"`,
   `cliPath:null` khi thiếu Sandbox; không tự bật tính năng hoặc reboot.
5. **Fixture maintenance riêng**, sau vòng cập nhật thật: thêm một file
   obsolete được manifest sở hữu, một file obsolete đã được người dùng sửa,
   và hardlink `Uninstall.exe` tới canary không liên quan. Chạy wizard candidate
   lần nữa xác nhận chỉ file obsolete nguyên vẹn bị xóa, file đã sửa và target
   hardlink được giữ. Không chèn manifest giả cho baseline legacy.
6. Wizard uninstall thật thành công (exit 0). **155 file của candidate**, kể cả
   uninstaller sau khi thoát, và **toàn bộ 151 file baseline quan sát độc lập**
   đã được xóa. Không còn registry/shortcut của ứng dụng. Profile BYO, WebView2
   user profile, bốn file không liên quan trong/ngoài thư mục cài/Start Menu,
   file obsolete đã sửa và hardlink target đều còn nguyên.
7. Host dừng đúng UUID sở hữu, yêu cầu stop/list thành công và kiểm tra inventory
   hợp lệ trước khi ghi `cleanupConfirmed:true`. Đọc lại `wsb list --raw` cho
   thấy không còn guest.

## Evidence và tái chạy

- [Lifecycle report, 55 kiểm tra](evidence/g6-clean-install-2026-10-13/lifecycle-report.json)
- [Host metadata và cleanup](evidence/g6-clean-install-2026-10-13/host-run.json)
- [Baseline native desktop](evidence/g6-clean-install-2026-10-13/baseline-desktop.json),
  [ảnh](evidence/g6-clean-install-2026-10-13/baseline-desktop.png)
- [Candidate native desktop](evidence/g6-clean-install-2026-10-13/upgrade-desktop.json),
  [ảnh](evidence/g6-clean-install-2026-10-13/upgrade-desktop.png)
- [Baseline inventory](evidence/g6-clean-install-2026-10-13/baseline-file-inventory.json),
  [missing-Sandbox preflight](evidence/g6-clean-install-2026-10-13/missing-sandbox-preflight.json)
- [Hướng dẫn harness](../PHASE1-G6-CLEAN-WINDOWS.md).

Artifacts đầy đủ của lần chạy: `.tmp/g6-clean-windows-final7/`.
Build log: `.tmp/g6-build-installer-final.log` (exit 0).
Installer payload regression: **42/42, exit 0**.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\tests\Test-CleanWindowsInstall.ps1 `
  -BaselineInstaller 'C:\Users\DATPHA~1\AppData\Local\Temp\ChatMCP-G6-f1e8d67cf9fd4914b0d90d52a576656e\BaselineSetup.exe' `
  -CandidateInstaller 'dist\ChatMCPSetup.exe' `
  -WebView2Prerequisite 'C:\Users\DATPHA~1\AppData\Local\Temp\ChatMCP-G6-WebView2OfflineX64.exe' `
  -OutputDirectory '.tmp\g6-clean-windows-postcommit'
```

Các lần thử trước vẫn được ghi nhận **FAIL**, không tính vào PASS này: lỗi retry
session của harness, nhầm WebView2 bootstrapper cần mạng với offline installer,
debug flag bị WebView2 elevated bỏ qua, PowerShell mất exit-code handle khi
redirect, và giả định sai đường dẫn profile. Những lỗi instrumentation đó đã
được sửa rồi chạy lại **toàn bộ** trên guest mới. Không bỏ qua bước thất bại.

Giới hạn: cặp baseline/candidate này không có filename legacy-only; inventory
thật đã xác nhận không còn sót. Không suy rộng cho mọi installer lịch sử thiếu
manifest, Windows 10, ARM64, Authenticode của ChatMCP hay tính xác thực publisher
G4. Sau một build/commit khác, phải kiểm thử lại artifact mới trước khi dùng
báo cáo này làm bằng chứng cho artifact đó.
