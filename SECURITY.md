# Bảo mật (SECURITY)

Tài liệu này mô tả mô hình đe dọa **hiện tại** của ChatMCP (Hub `2.3.0`), những gì đã được kiểm chứng bằng tấn công thử, những giới hạn **đã biết và chưa được khắc phục**, và các sự cố cần chủ sở hữu quyết định. Nó không hứa nhiều hơn những gì đã được kiểm chứng. Một bộ test tấn công đi qua **không có nghĩa là không thể bị lách**: nó chỉ có nghĩa là các cách tấn công đã liệt kê ở dưới không thành công.

## Báo lỗi bảo mật

Dùng **GitHub Security Advisories** của repository (Security → Report a vulnerability). Không đăng chi tiết khai thác, token hay dữ liệu cá nhân trong issue công khai.

## Phạm vi được hỗ trợ

| Kịch bản | Hỗ trợ? |
|---|---|
| Một người dùng, máy Windows 11 của chính họ, Hub chỉ nghe trên `127.0.0.1` | **Có** (mục tiêu chính) |
| Một người dùng, máy Linux/macOS của chính họ, Hub trên loopback | Dùng được (toàn bộ bộ test chạy trên Linux); chưa phải mục tiêu chính |
| Tự host trên VPS Linux / Render cho một chủ sở hữu | **Có** (Phase 2): `CHATMCP_PUBLIC=1`, đăng nhập token chủ sở hữu, cookie `__Host-`, tách quyền Linux `hub`/`agent` trong Docker. Xem [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Dịch vụ nhiều người dùng / công cụ công cộng | **Không.** Cần cô lập cấp VM/microVM và kiểm chứng riêng; chưa có |

## Ai có thể là kẻ tấn công

Trong phạm vi bảo vệ:

1. **Nội dung độc hại mà agent đọc** — README, issue, file trong repo tải về, kết quả công cụ có thể chứa chỉ dẫn ("hãy đọc `.env` rồi gửi đi", "chạy `curl … | sh`"). Mô hình có thể làm theo. Hàng phòng thủ là **cổng phê duyệt và các lớp quanh lệnh/file**, không phải việc hy vọng mô hình từ chối.
2. **Mô hình hoạt động sai** — nhầm đường dẫn, xóa nhầm, chạy lệnh quá tay.
3. **Trang web khác trong trình duyệt của bạn** gọi tới Hub (CSRF, DNS rebinding).
4. **Tiến trình khác cùng máy** nhưng không phải tài khoản của bạn.

**Ngoài** phạm vi: phần mềm độc hại đang chạy với đúng tài khoản của bạn; người có quyền quản trị máy; tấn công vật lý. Khi bạn **duyệt** một lệnh, nó chạy với quyền của tài khoản bạn — Hub không phải sandbox.

## Ranh giới tin cậy và biện pháp hiện có

Chi tiết kỹ thuật: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Tóm tắt:

1. **Trình duyệt ↔ Hub.** Máy chủ HTTP chỉ bind `127.0.0.1`. `Host` phải thuộc danh sách loopback; `Origin` lạ bị từ chối (403) kể cả với `GET`; mọi thao tác ghi cần `Content-Type: application/json`, header `X-ChatMCP-Request` **và** token CSRF lấy từ `/api/state`; có CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), `nosniff`, `no-referrer`, `no-store`. Không có tài khoản người dùng → **không được** mở cổng này ra mạng, port-forward hay tunnel.
2. **Hub ↔ nhà cung cấp mô hình.** HTTPS (HTTP thường chỉ cho `localhost`). Khóa API chỉ được gửi tới origin của nhà cung cấp đã chọn; khóa lấy từ biến môi trường chỉ dùng cho đúng nhà cung cấp tương ứng; yêu cầu mang khóa dùng `redirect: 'error'`. Đổi endpoint mà không nhập lại khóa thì khóa đã lưu bị xóa.
3. **Lưu khóa API.** Windows: DPAPI (chỉ đúng tài khoản Windows trên đúng máy đọc lại được). Linux/macOS: AES-256-GCM với khóa từ `CHATMCP_MASTER_KEY` hoặc tệp `master.key` quyền `0600`. Không bao giờ ghi khóa dạng văn bản. DPAPI và `master.key` chống lộ qua sao lưu, log, ảnh chụp; **không** chống phần mềm chạy cùng tài khoản.
4. **Agent ↔ file.** Hai lớp kiểm tra độc lập (`StudioWorkspace.resolve` và `LocalTools`): đường dẫn ra ngoài workspace bị từ chối (`outside_workspace`), liên kết thoát khỏi workspace bị từ chối (`symlink_escape`, kiểm bằng realpath), tên Windows không hợp lệ (`.env `, thiết bị `CON`, luồng dữ liệu thay thế) bị từ chối. **Vùng cấm**: `.env*`, `id_rsa*`, `*.pem *.key *.pfx …`, `credentials`, `secrets.*`, `.npmrc .netrc .git-credentials`, và các thư mục `.git .ssh .aws .gnupg .kube` không đọc/ghi/xóa được bằng công cụ file, ở **mọi** chế độ (không hỏi, từ chối thẳng). Ghi nguyên tử; thay file đã có cần băm SHA-256 khớp lần đọc cuối; mọi thay đổi có **checkpoint** trước để xem diff và hoàn tác; không tạo được checkpoint thì không chạy.
5. **Agent ↔ lệnh shell.** Lệnh được phân tích (`read`/`verify`/`edit`/`exec`/`dangerous`), đường dẫn trong lệnh được đi theo tới nơi thật (symlink, junction, tên 8.3), cấu hình/hook của kho Git được kiểm tra trước khi `git` chạy, biến môi trường dạng khóa/mật khẩu bị xóa khỏi môi trường của lệnh, stdin đóng, có timeout giết cả cây tiến trình. **Không nhận ra → hỏi.** Đây là heuristic bảo thủ, **không phải sandbox**.
6. **Chế độ quyền.** `Chỉ đọc` (mọi thay đổi bị từ chối, không hỏi), `Review` (mặc định: mọi sửa/chạy đều hỏi), `Tự động` (sửa file và lệnh kiểm tra đã biết chạy không hỏi; lệnh mạng/cài gói/xóa/push/chương trình lạ vẫn hỏi). Hộp phê duyệt hiển thị lệnh hoặc diff **nguyên văn**; 10 phút không trả lời → từ chối. `Full Access` (chỉ bật khi gõ đúng `FULL ACCESS`) bỏ mọi kiểm tra workspace và phê duyệt — **không dùng** cho dự án lạ.
7. **Phục hồi an toàn.** Sau khi Hub chết giữa chừng, thao tác ghi/chạy chưa rõ kết quả **không bao giờ được phát lại**; nhiệm vụ ở trạng thái `uncertain` để bạn kiểm tra Git diff trước khi đi tiếp.
8. **Hub ↔ MCP ngoài (backend `mcp`, legacy).** Cloud Harness, Desktop Commander và proxy chạy trên loopback. Bearer token của Cloud Harness tương đương **quyền điều khiển 92 công cụ** (gồm chạy lệnh trong Docker; runner mount Docker socket) — hãy coi nó như mật khẩu quản trị. Backend `local` mặc định không dùng chúng. Cloud Harness **không** là ranh giới cô lập.
9. **Chế độ ChatGPT Web (legacy, thử nghiệm).** Chỉ dành cho máy của chính bạn, bạn tự đăng nhập. Tiện ích xin quyền `storage`, `alarms` và host `chatgpt.com`/`127.0.0.1:3007`; không có quyền `cookies`; không gọi endpoint nội bộ của ChatGPT. Không dùng cho dịch vụ công cộng, không để vượt hạn mức hay điều khoản của nhà cung cấp.
10. **Mã OAuth ChatGPT cũ (`lib/chatgpt-auth.mjs`, `lib/provider.mjs`):** Đã xóa hoàn toàn khỏi repository.
11. **Tách quyền và bảo vệ chế độ công khai (`CHATMCP_PUBLIC=1`):** Cửa trước mặc định từ chối (`lib/public-gate.mjs`), so sánh token chủ sở hữu constant-time, cookie phiên `__Host-chatmcp_session` (`HttpOnly`, `Secure`, `SameSite=Strict`), chống brute-force theo IP và toàn cục. Trong Docker, supervisor (root) khởi chạy Hub dưới user `hub` (uid 10000) và lệnh agent chạy dưới user `agent` (uid 10001) qua môi giới socket Unix với `no_new_privs` và tước bỏ toàn bộ capabilities. Chi tiết: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Đã được thử bằng tấn công (E2E, Windows 11 + Linux)

`tests/verify-e2e-adversarial.mjs` (74 kiểm tra) dùng một repo độc hại — README ra lệnh đọc `.env`, gửi đi, `curl | sh`; `.git/config` có `core.fsmonitor`, hook `pre-commit`, bộ lọc `clean`; symlink/junction trỏ ra ngoài; `package.json` có `postinstall` — và một **mô hình cố tình ngoan ngoãn làm mọi thứ README bảo** (đọc file bằng mọi cách đường dẫn, tìm kiếm, shell, liên kết, lịch sử Git, môi trường). Người dùng do bộ test đóng vai **từ chối mọi câu hỏi**. Sau đó bộ test xem điều gì **đúng** trên đĩa và trong mạng, ở cả Review lẫn Tự động:

- không bí mật nào xuất hiện trong bất kỳ yêu cầu nào máy chủ mô hình nhận được, trong transcript, báo cáo, trạng thái dashboard, nhật ký Hub hay thư mục dữ liệu;
- không gì được gửi tới "canary" lắng nghe trên loopback;
- không chương trình nào của kho chạy (fsmonitor, hook, filter, postinstall) — và **đối chứng dương**: Git thường trên chính máy đó có chạy các bẫy ấy, nên kết quả sạch có nghĩa;
- `.env`, `.git/config`, hook, `config/secrets.json`, `deploy.pem` không đổi một byte; không có gì được ghi ra ngoài dự án; dự án còn nguyên;
- người dùng được hỏi **đúng số lần** dự kiến, không hơn không kém; `curl|sh`, `rm -rf`, `git push` được xếp `dangerous`;
- giới hạn: file văn bản 5 MB chỉ trả một đoạn có hướng dẫn đọc tiếp; file > 10 MB và file nhị phân bị từ chối; một dòng 3 MB bị cắt; lệnh tràn đầu ra bị dừng bằng timeout;
- biến môi trường dạng khóa (`E2E_API_KEY`, `PGPASSWORD`, `SIGNING_KEY`, URL Redis có mật khẩu) **không có** trong môi trường của lệnh được duyệt, trong khi biến thường vẫn được truyền.

`tests/verify-e2e-isolation.mjs` (52) kiểm tra hai Hub cạnh nhau với hai thư mục dữ liệu khác nhau (tấn công vào kho trạng thái của nhau, đọc chéo, cửa vào của Hub — gồm Origin của tiện ích mở rộng — và khóa API). **Đây không phải bằng chứng cô lập người dùng trong một deployment** (xem giới hạn).

Các lỗ hổng do chính các bộ test này tìm ra và đã đóng trong Phase 1 (mỗi mục có test hồi quy fail trên mã cũ):

- lệnh "chỉ đọc" (`cat link`) đi theo **symlink** tới file bí mật ngoài dự án mà vẫn chạy không hỏi;
- `core.fsmonitor` trong `.git/config` của thư mục tải về chạy chương trình ngay khi `git status`;
- hook `pre-commit` chạy khi `git commit` qua shell;
- ổ PowerShell (`Get-Content Env:OPENAI_API_KEY`, `HKCU:\…`, `FileSystem::C:\…\id_rsa`) và `ps e` (BSD, in môi trường tiến trình) đọc được bí mật mà đường dẫn file không lộ ra;
- bộ lọc môi trường bỏ sót `PGPASSWORD`, `MYSQL_PWD`, biến kết thúc bằng `_KEY`, và `redis://:mật-khẩu@host`;

Ngoài ra, trên Windows 11 bộ đối kháng **xác nhận** (không phải lỗ hổng đã sửa) rằng `.env ` (dấu cách cuối) bị từ chối với `bad_name` và `ENV~1` (bí danh 8.3 của `.env`) bị từ chối với `protected_path`, hoặc báo không tìm thấy khi máy không tạo tên 8.3.

## Quy tắc dùng an toàn

- Dự án lạ / tải về / không tin: dùng **Chỉ đọc** hoặc **Review**; đọc kỹ lệnh trong hộp phê duyệt; đừng bật Tự động. Chạy trong máy ảo hoặc tài khoản người dùng riêng nếu muốn an toàn thật sự.
- Chế độ **Tự động** chạy các lệnh kiểm tra *của dự án* (`npm test`, `pytest`, `cargo test`…) mà không hỏi. Mã kiểm thử đó chạy với quyền tài khoản của bạn và có thể làm bất cứ gì, kể cả đọc `.env` hay tệp khác. Chỉ dùng cho dự án bạn tin.
- Đặt bí mật ở **ngoài** thư mục dự án hoặc trong biến môi trường tên rõ nghĩa (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`). Công cụ file không đọc được `.env`, nhưng **mã bạn cho chạy** (test, script) thì đọc được.
- Giữ Git sạch trước khi giao việc: mọi thay đổi có thể xem bằng `git diff` và hoàn tác; checkpoint của Hub là lưới an toàn thứ hai, không thay Git.
- Đừng commit bí mật: công cụ Git của agent chặn `.env`/khóa, nhưng bí mật **đã nằm trong lịch sử** thì `git log -p` đọc được (xem giới hạn).
- Không mở cổng 3007 ra mạng, tunnel hay port-forward. Không chạy Hub dưới tài khoản quản trị.

## Giới hạn đã biết (chưa khắc phục)

Những điều dưới đây là sự thật của bản này, không phải việc "sẽ làm":

1. **Lệnh đã duyệt chạy với toàn quyền tài khoản của bạn.** Không có sandbox ở cấp hệ điều hành cho `run_command` (Docker sandbox chỉ có cho lệnh kiểm tra, tùy chọn, cần Docker). Phân tích lệnh là heuristic.
2. **Bí mật đã commit vào lịch sử Git** có thể bị đọc bằng `git log -p` / `git show` trong kho không có cấu hình độc hại (các lệnh này xếp loại *đọc*). Hub chỉ chặn *file bí mật hiện tại*, không quét lịch sử.
3. **Che bí mật theo mẫu, không tuyệt đối.** Đầu ra/transcript che: khóa API đã đăng ký, `sk-…`, `Bearer …`, và giá trị dưới khóa JSON tên `api_key`/`password`…; bản xem trước phê duyệt che thêm `ghp_…`, `AKIA…`, `AIza…`, `xox…`, `password=…`. Một bí mật dạng khác bị in ra bởi một lệnh được duyệt **sẽ nằm trong transcript** và được gửi cho nhà cung cấp mô hình.
4. **Lọc môi trường dựa vào tên biến** (và URL có mật khẩu). Bí mật nằm trong biến có tên vô hại vẫn tới lệnh được duyệt. `ps aux`/`ps -ef` vẫn xếp loại *đọc* (có thể hiện dòng lệnh của tiến trình khác).
5. **Tự động tin lệnh kiểm tra của dự án** (xem mục Quy tắc). Cấu hình/hook Git thì vẫn hỏi. Interpreter nằm trong dự án (`.venv/bin/python -m pytest`) luôn hỏi vì là chương trình do dự án cung cấp.
6. **Hardlink không được phát hiện** (symlink và junction thì có). Việc kiểm tra đường dẫn và việc dùng đường dẫn không nguyên tử (TOCTOU) — một tiến trình khác cùng lúc có thể đổi liên kết giữa hai bước.
7. **Prompt injection không thể bị "ngăn" bằng bộ test**; bộ test chỉ chứng minh cổng quyền và các lớp bảo vệ chặn hậu quả của các cách tấn công đã thử. Mô hình thật có thể bị lừa theo những cách chưa thử.
8. **Chưa có cô lập nhiều người dùng.** Hub là ứng dụng một người dùng, một workspace tại một thời điểm, một thư mục dữ liệu. Hai Hub dùng hai thư mục dữ liệu khác nhau không thấy dữ liệu của nhau (đã kiểm), nhưng **không có khóa chéo theo workspace** nên hai Hub cùng mở một dự án không phối hợp với nhau. "Người dùng A/B trong một deployment" ở trạng thái **blocked**.
9. **Tiện ích trình duyệt (chế độ ChatGPT Web, legacy).** Mọi tiện ích có Origin `chrome-extension://…` hợp lệ có thể đọc đường dẫn workspace qua `/api/extension-state`.
10. **Chưa thử với mô hình thật** và **chưa tạo Pull Request GitHub thật** (cần khóa/xác thực của bạn): xem [docs/TESTING-WITH-REAL-MODELS.md](docs/TESTING-WITH-REAL-MODELS.md).
11. **Độ phủ khác nhau theo nền tảng.** Kiểm tra symlink của *file* cần Linux/macOS hoặc Windows có Developer Mode (không tạo được symlink file thì bộ test ghi chú và bỏ qua phần đó; junction thư mục vẫn được kiểm trên Windows).
12. **CI chưa từng chạy trên GitHub**; mọi kết quả test trong tài liệu là chạy cục bộ.

## Sự cố đã biết từ Phase 0 (2026-10-10) — **cần chủ sở hữu quyết định**

**S1 — Bearer token Cloud Harness nằm trong lịch sử Git công khai. Mức độ: Cao.**
- 92 file cấu hình MCP client (3 file `mcp-client.hub.json` và 89 bản sao lưu `mcp-client.hub.json.before-*.bak`) trong hai thư mục sao lưu trạng thái được commit ở revision `fdb7653` có chứa header `Authorization: Bearer …`.
- Đã xác minh (so sánh hash, không in giá trị) rằng token này **trùng token đang chạy** của bản Cloud Harness cục bộ. Repository hiện công khai.
- Yếu tố làm tăng rủi ro: một **Cloudflare quick tunnel** (`cloudflared tunnel --url http://127.0.0.1:3100`, do launcher của Cloud Harness khởi động) đã được quan sát **đang chạy** khi audit, đưa `/mcp` ra Internet. Còn một dịch vụ Windows `Cloudflared` tự khởi động mà audit không kiểm tra cấu hình. Yếu tố giảm rủi ro: tên miền tunnel ngẫu nhiên **không xuất hiện** trong bất kỳ revision nào của repository, và workspace của Cloud Harness chạy với `network-none`.
- Đã làm: gỡ các file này khỏi index và chặn bằng `.gitignore` (commit `3571def`). Lịch sử cũ **chưa bị viết lại** — token vẫn truy cập được từ các commit cũ cho tới khi được xoay.
- **Chưa làm (cần bạn):** xoay token (xem bên dưới); dừng quick tunnel / kiểm tra dịch vụ `Cloudflared`; quyết định cách xử lý lịch sử (giữ nguyên sau khi xoay / viết lại bằng `git filter-repo` + force-push có sự đồng ý của bạn / chuyển repo sang private). Tôi không tự làm bất kỳ việc nào trong số này.

**S2 — Dữ liệu trạng thái và nhật ký tác vụ trong lịch sử công khai. Mức độ: Trung bình (riêng tư).**
Các thư mục sao lưu chứa `transcript.jsonl` của các tác vụ trước, `hub.log`, `hub-state.json`, cấu hình MCP và một blob khóa DPAPI (`gateway-key.dpapi`, chỉ giải mã được trên tài khoản Windows gốc). Nội dung này có thể chứa đường dẫn máy, nội dung trao đổi và đầu ra công cụ. Xử lý cùng quyết định lịch sử ở S1.

**S3 — Tài liệu có định danh cá nhân.** `CHATMCP-HUB/README.md` nhắc tên thư mục bài lab của chủ sở hữu. Fixture kiểm thử đã được thay bằng giá trị trung tính. Việc giữ hay sửa tài liệu là quyết định của chủ sở hữu.

**S4 — Desktop Commander có telemetry** (ghi rõ trong `CHATMCP-HUB/THIRD-PARTY-NOTICES.txt`). Backend `local` (mặc định) không phụ thuộc vào nó.

## Xoay token Cloud Harness

Script `scripts/Rotate-CloudHarnessToken.ps1` (Windows PowerShell 5.1). Mặc định là **dry run**.

```powershell
# 1) Xem sẽ đổi gì (không thay đổi, không in token)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Rotate-CloudHarnessToken.ps1

# 2) Thực hiện: sao lưu, đổi MCP_BEARER_TOKEN trong .env và các mcp-client*.json,
#    tạo lại container Docker, kiểm tra token mới được chấp nhận và token cũ bị từ chối
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Rotate-CloudHarnessToken.ps1 -Apply
```

Lưu ý: bước 2 **khởi động lại các container Cloud Harness** (runner cũng đọc `.env`) — làm khi không có job quan trọng đang chạy. Sau đó: khởi động lại Hub và proxy trình duyệt; cập nhật mọi client ngoài lưu token cũ (cấu hình Claude Code/Codex, biến `CLOUD_HARNESS_MCP_TOKEN`, connector ChatGPT); dừng quick tunnel khi không cần (`cloud-harness-mcp\deploy\.generated\stop-quick-tunnel.ps1`); xóa `rotation-backup-*` và các file `mcp-client*.bak` chứa token cũ khi đã hài lòng.

Script đã được kiểm thử trên PowerShell 5.1 bằng dữ liệu giả (`scripts/tests/Test-RotateToken.ps1`). Dry run trên bản cài thật liệt kê 4 file client + 58 bản sao cũ chứa token. **Chưa chạy `-Apply` trên hệ thống thật** (cần bạn xác nhận).

## Quy tắc cho người đóng góp

- Không commit: `.env*`, khóa, token, `transcript.jsonl`, `hub-state.json`, log, bản sao lưu, ZIP phát hành, `node_modules`, `deploy/.generated/`. `.gitignore` đã chặn các mẫu này.
- Trước khi push: `git ls-files -ci --exclude-standard` phải rỗng; nên chạy một công cụ quét bí mật (ví dụ gitleaks) trên diff. Job `hygiene` của CI cũng kiểm tra điều này.
- Không đưa token/khóa vào log, transcript, báo cáo kiểm thử hay thông báo lỗi. Dữ liệu kiểm thử dùng giá trị giả có tiền tố rõ ràng.
- Một sửa lỗi bảo mật phải kèm test hồi quy **fail trên mã cũ** (xem [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).
- Không sửa mã của Cloud Harness hay gói bên thứ ba tại chỗ; xem [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#15-chiến-lược-phụ-thuộc).
