# G6 — Kiểm thử bộ cài trên Windows sạch, 2026-10-13

**PASS: 55/55 kiểm tra vòng đời thực tế; host exit 0, guest exit 0, cleanup xác nhận.**
Đây là cài baseline **2.6.0 → cập nhật tại chỗ sang candidate 2.6.0**, không phải
một phiên bản mới được tự tạo. Kết quả cuối áp dụng cho bộ cài từ commit sạch
`acc2f840dfd7c1b279d2c58c2bc5d1294ffcfc43`. Cùng payload đã được [G4 xác nhận
riêng cho chế độ native black-box](G4-BLACKBOX-REVIEW-2026-10-13.md).
Không có thao tác merge/release trong lần kiểm thử này.

## Môi trường và định danh

- Thời gian: **23:12:53–23:14:56, ngày 13/10/2026, Asia/Bangkok**
  (16:12:53–16:14:56 UTC).
- Host: Windows 11 Pro **10.0.26300**, Windows Sandbox CLI **0.8.107.0**,
  .NET SDK **10.0.401**, Node **v24.19.0**.
- Guest mới: Windows 11 Enterprise **10.0.26100 x64**, 4095 MB RAM; không có
  node, npm, dotnet, Git trên PATH; chưa có ứng dụng, dữ liệu hay registry ChatMCP.
- UUID duy nhất sở hữu: `f3e5de81-3628-4358-a458-9e3d7f1d004e`.
- Guest bị tắt mạng, clipboard và printer redirection; bộ cài/script được map
  read-only, chỉ thư mục evidence riêng được ghi.
- WebView2 **155.0.4283.45** được cài offline trong guest bằng bộ cài Microsoft
  có Authenticode hợp lệ. Đây là prerequisite đã được README công bố, không phải
  runtime phát triển. Không cài/gỡ phần mềm hay bật tính năng trên host.
- Tài khoản desktop `WDAGUtilityAccount` của G6 chạy elevated; đây **không phải**
  restricted child token của thử nghiệm G4. CDP được bật bằng policy HKLM chỉ
  dành cho `ChatMCP.exe` trong guest rồi xóa sau mỗi lần khởi chạy.

Source tại đầu lần chạy cuối: HEAD **`acc2f840dfd7c1b279d2c58c2bc5d1294ffcfc43`**,
`dirty: false`. Implementation giữ nguyên trong suốt kiểm thử; các cập nhật tài
liệu/evidence sau đó không thay thế định danh build này. Các hash binary được lưu
tại [source-and-artifact-hashes.json](evidence/g6-clean-install-final-2026-10-13/source-and-artifact-hashes.json).

| Artifact | Phiên bản / SHA-256 |
| --- | --- |
| Baseline thật đã giữ lại | `2.6.0+cb97f1901e9b007be46b23ab05a5be85e2a46e3f` |
| Baseline installer | `155d2f1b8777deb47e963fb362618bc2d864b5b9378de00982bb158ac4f1575a` |
| Candidate | `2.6.0+acc2f840dfd7c1b279d2c58c2bc5d1294ffcfc43`, 200,706,208 bytes |
| Candidate installer | `037cea6f5794da6cd19f67e284cc84f05e4c88f006a96de60b0f26c5b1931fe7` |
| Payload ZIP | `132a16c6fc3d9e18e75e47795a97ba270f72fb08365febd9697695709eba324f` |
| Native AOT GuestSupervisor đóng trong candidate | `e4c5ee3c2cd8b79e6d1cc088af52ce0a04cc0e4b0f10a79c37bc4e55bd495fb1` |
| Node portable đóng trong candidate | `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237` |
| Lifecycle report cuối | `2af20c5eab71412b42e3c3c1366cbea1aa6442f6374a2cf4ca61f1576427907f` |
| Host metadata/cleanup cuối | `3717b29c6551923407a82d070b91e9ea514d2aef889b0c784fe456276bfb4111` |

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
6. Wizard uninstall thật thành công (exit 0). **157 file của candidate**, kể cả
   uninstaller sau khi thoát, và **toàn bộ 151 file baseline quan sát độc lập**
   đã được xóa. Không còn registry/shortcut của ứng dụng. Profile BYO, WebView2
   user profile, bốn file không liên quan trong/ngoài thư mục cài/Start Menu,
   file obsolete đã sửa và hardlink target đều còn nguyên.
7. Host dừng đúng UUID sở hữu, yêu cầu stop/list thành công và kiểm tra inventory
   hợp lệ trước khi ghi `cleanupConfirmed:true`. Đọc lại `wsb list --raw` cho
   thấy không còn guest.

## Evidence và tái chạy

- [Lifecycle report, 55 kiểm tra](evidence/g6-clean-install-final-2026-10-13/lifecycle-report.json)
- [Host metadata và cleanup](evidence/g6-clean-install-final-2026-10-13/host-run.json)
- [Baseline native desktop](evidence/g6-clean-install-final-2026-10-13/baseline-desktop.json),
  [ảnh](evidence/g6-clean-install-final-2026-10-13/baseline-desktop.png)
- [Candidate native desktop](evidence/g6-clean-install-final-2026-10-13/upgrade-desktop.json),
  [ảnh](evidence/g6-clean-install-final-2026-10-13/upgrade-desktop.png)
- [Baseline inventory](evidence/g6-clean-install-final-2026-10-13/baseline-file-inventory.json),
  [missing-Sandbox preflight](evidence/g6-clean-install-final-2026-10-13/missing-sandbox-preflight.json)
- [Hướng dẫn harness](../PHASE1-G6-CLEAN-WINDOWS.md).

Artifacts đầy đủ của lần chạy: `.tmp/g6-clean-windows-accepted/`.
Build log: `.tmp/g4-g6-final-installer-build.log` (exit 0).
Installer payload regression: **42/42, exit 0**.
Đã đọc lại độc lập metadata/lifecycle/raw CLI exit, hai desktop probe JSON và
hai ảnh WebView2 thực tế. Cả hai hiển thị giao diện ChatMCP và Hub kết nối;
ảnh candidate giữ workspace `G6EmptyWorkspace`. Hai probe đều exit 0, không có
AI task được gửi. Sau uninstall không còn file nào trong inventory baseline.

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

Lần PASS trước lúc 22:04–22:06 dùng candidate `7224ff9a…`, nguồn `497c082…`
có working-tree changes, helper `b822407d…` và 155 file thuộc manifest. Evidence
cũ vẫn được giữ ở [thư mục lịch sử](evidence/g6-clean-install-2026-10-13/host-run.json).
Nó không được dùng để chứng nhận bộ cài hiện tại; toàn bộ vòng đời đã được chạy
lại trên guest mới và artifact cuối như báo cáo này.

Giới hạn: cặp baseline/candidate này không có filename legacy-only; inventory
thật đã xác nhận không còn sót. Không suy rộng cho mọi installer lịch sử thiếu
manifest, Windows 10, ARM64, Authenticode của ChatMCP hay tính xác thực publisher
G4. Sau một build/commit khác, phải kiểm thử lại artifact mới trước khi dùng
báo cáo này làm bằng chứng cho artifact đó.
