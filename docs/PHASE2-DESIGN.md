# Phase 2 — Thiết kế: máy chủ tin cậy một chủ sở hữu, chạy trên Render (gói free)

> Tài liệu **thiết kế**, viết trước khi làm. Trạng thái thật của từng hạng mục (đã làm, đã kiểm thử, bị chặn) nằm ở [PHASE2-REPORT.md](PHASE2-REPORT.md) và [DEPLOYMENT.md](DEPLOYMENT.md); nếu hai nơi khác nhau thì báo cáo là đúng.

## 0. Mục tiêu, không-mục-tiêu, nhãn

**Mục tiêu:** một người (chủ sở hữu) mở Hub từ trình duyệt qua HTTPS, đăng nhập, nhận một kho GitHub (clone), giao việc cho agent, xem diff, rồi đẩy kết quả lên một nhánh mới trên GitHub. Toàn bộ chạy bằng tài nguyên miễn phí: Render free (máy chủ), GitHub (mã nguồn), nhà cung cấp model có gói miễn phí hoặc khóa của chính bạn.

**Không phải mục tiêu (và sẽ không được tuyên bố):**

- Nhiều người dùng / dịch vụ công cộng. Một container Render là **một** ranh giới tin cậy; không có VM/microVM riêng cho từng người. Trạng thái `blocked` giữ nguyên.
- Lưu trữ bền. Gói free có **ổ đĩa tạm** (xem mục 1): workspace, lịch sử tác vụ và cấu hình lưu trên đĩa **mất** khi dịch vụ ngủ, khởi động lại hoặc triển khai lại. Mã nguồn chỉ an toàn khi đã **push lên GitHub**.
- Chống kẻ có quyền chạy lệnh *bằng chính quyền của agent* làm điều agent đã được phép (đọc/ghi workspace, gọi mạng ra ngoài). Thiết kế chỉ bảo vệ **bí mật và quyền điều khiển của Hub** khỏi lệnh của agent (mục 3, D6).

Nhãn dùng trong tài liệu này: *implemented* (có mã), *tested* (có test chạy thật, nêu mã thoát), *verified-live* (đã thử trên dịch vụ thật), *blocked* (cần thứ tôi không có), *unverified* (chưa có bằng chứng).

## 1. Sự thật về Render free (tra cứu 2026-10-11, từ tài liệu chính thức)

| Sự thật | Hệ quả cho thiết kế | Nguồn |
|---|---|---|
| 750 giờ instance miễn phí mỗi tháng cho mỗi workspace; dịch vụ ngủ không tính giờ; hết giờ thì mọi dịch vụ free bị tạm ngưng tới đầu tháng sau | Không cần chạy 24/7; ngủ khi rảnh là tốt | render.com/docs/free |
| Ngủ sau **15 phút** không có lưu lượng vào; đánh thức mất khoảng **1 phút** | Tác vụ chạy lâu mà tab đóng sẽ bị cắt; giao diện phải chịu được lần mở đầu chậm | render.com/docs/free |
| Hệ thống file **tạm**; không có persistent disk; không SSH/Shell | Mọi thứ trên đĩa là bộ nhớ đệm. Cấu hình lấy từ **biến môi trường**; kết quả phải được push | render.com/docs/free |
| Gói free: **0,1 CPU, 512 MB RAM** (web service) | Một tác vụ tại một thời điểm (đã có); giới hạn tiến trình con; `--max-old-space-size` cho Hub | render.com/docs/blueprint-spec |
| Cổng SMTP 25/465/587 bị chặn đi ra; băng thông và phút build có hạn mức (không nêu số) | Không dùng SMTP. Git đi qua HTTPS (443) | render.com/docs/free |
| Có thể bị khởi động lại bất kỳ lúc nào; có thể bị tạm ngưng nếu lưu lượng đi ra bất thường lớn | Agent không được dùng làm công cụ tải/quét hàng loạt; quyền `exec` luôn cần duyệt | render.com/docs/free |
| Dịch vụ phải bind `0.0.0.0` vào cổng `PORT` (mặc định 10000); TLS kết thúc ở load balancer, HTTP được chuyển hướng sang HTTPS | Hub cần tùy chọn bind; không tự làm TLS | render.com/docs/web-services |
| Biến tự có: `RENDER=true`, `RENDER_EXTERNAL_URL`, `RENDER_EXTERNAL_HOSTNAME`, `PORT` | Danh sách `Host` cho phép lấy từ `RENDER_EXTERNAL_HOSTNAME` | render.com/docs/environment-variables |
| Health check: HTTP 2xx/3xx là khỏe, trả lời trong **5 giây**; `Host` là tên miền `onrender.com` (hoặc tên miền riêng đã xác minh); 15 giây liên tục lỗi thì ngừng định tuyến, 60 giây thì khởi động lại | `/healthz` công khai, tối giản, trả lời trước kiểm tra `Host` | render.com/docs/health-checks |
| `render.yaml`: `type: web`, `runtime: docker`, `plan: free`, `healthCheckPath`, `envVars` với `generateValue: true` (chuỗi base64 256 bit, tạo một lần) hoặc `sync: false` (hỏi giá trị ở Dashboard khi tạo Blueprint) | Token chủ sở hữu do Render sinh; khóa model và token GitHub nhập ở Dashboard, không nằm trong Git | render.com/docs/blueprint-spec |
| Proxy của Render **thêm** địa chỉ vào `X-Forwarded-For` nhưng **không bỏ** phần client tự gửi (cộng đồng Render ghi nhận bị giả mạo được) | Địa chỉ client chỉ tin phần tử đếm từ **bên phải**; giới hạn đăng nhập có thêm hạn mức **toàn cục** không phụ thuộc IP | community.render.com (bài "Accessing client IPs in a Node Express App") |

Những điều **chưa biết** và chỉ kiểm chứng được sau khi triển khai thật: Render có cho `setuid/setgid` trong container hay không (quyết định chế độ tách quyền, mục D6); số bước proxy thật sự đứng trước Hub (để chọn phần tử của `X-Forwarded-For`); dung lượng đĩa tạm.

### Nhà cung cấp model có gói miễn phí (tra cứu 2026-10-11; **hạn mức đổi thường xuyên**, luôn kiểm tra lại)

| Nhà cung cấp | Điều trang chính thức nói | Lưu ý cho agent lập trình |
|---|---|---|
| Google Gemini API | Có gói free; các model free hiện liệt kê gồm họ Flash/Flash-Lite và 2.5 Pro; hạn mức theo **dự án**, xem trong AI Studio; ở gói free, dòng "Used to improve our products" là **Yes** (nội dung dùng để cải thiện sản phẩm của Google) | **Đừng gửi mã riêng tư/độc quyền qua gói free của Gemini.** Mã mã nguồn mở thì chấp nhận được |
| OpenRouter | Model có hậu tố `:free`: **20 yêu cầu/phút**; **50 yêu cầu/ngày** nếu đã mua < 10 credit, **1000/ngày** nếu ≥ 10 | Mỗi lượt gọi công cụ là một yêu cầu: 50/ngày chỉ đủ vài tác vụ nhỏ |
| Groq | Giới hạn theo tổ chức, tính theo yêu cầu và token mỗi phút/ngày; bảng ví dụ ghi vài chục yêu cầu/phút và vài nghìn token/phút | Ngữ cảnh lớn của agent dễ vượt hạn mức token/phút; xem trang giới hạn trong console của bạn |
| Mistral (La Plateforme) | Có tầng API free với giới hạn "restrictive"; số liệu ở console.mistral.ai/limits; điều khoản dùng dữ liệu không nằm trên trang tra cứu | Đọc điều khoản dữ liệu trước khi gửi mã |
| Ollama / LM Studio | Chạy trên máy bạn | **Không dùng được từ Render** (máy chủ không với tới máy bạn); chỉ dùng với Hub chạy cục bộ |

Tôi **chưa đo** chất lượng hay số tác vụ thực tế của từng gói free với agent này; không có số liệu đó thì tài liệu không được hứa.

## 2. Mô hình đe dọa

**Tài sản:** A1 token chủ sở hữu (đăng nhập); A2 khóa API model (tốn tiền/hạn mức); A3 token GitHub (ghi vào kho); A4 mã nguồn trong workspace; A5 hạn mức tính toán/mạng của dịch vụ; A6 toàn vẹn của Hub (quyền duyệt lệnh của agent).

**Tác nhân:**

| Tác nhân | Có gì | Muốn gì |
|---|---|---|
| T1 Kẻ trên Internet, chưa đăng nhập | Địa chỉ `*.onrender.com`, mọi HTTP | Điều khiển agent (chạy lệnh), lấy khóa, dùng hạn mức |
| T2 Trang web hại người dùng (CSRF/DNS rebinding) | Trình duyệt đã đăng nhập của chủ | Làm Hub thực hiện thao tác thay chủ |
| T3 Agent bị prompt-injection (nội dung kho/trang web/tệp chứa chỉ thị) | Quyền của công cụ + lệnh shell đã được duyệt hoặc loại "an toàn" | Đọc A1–A3, **tự duyệt lệnh của chính nó**, lấy dữ liệu ra ngoài |
| T4 Kho độc hại (hook, cấu hình git, symlink, đường dẫn) | Nội dung kho sau khi clone | Chạy mã trong Hub, đọc/ghi ngoài workspace, lấy token khi push |
| T5 Chủ sở hữu nhập nhầm | — | Push nhầm lên `main`, clone kho lạ |

**Điểm mấu chốt (T3):** ở Phase 1, lệnh của agent chạy **cùng tài khoản hệ điều hành với Hub**. Trên máy cá nhân điều đó chấp nhận được (chính bạn chạy). Trên máy chủ, cùng tài khoản nghĩa là lệnh của agent đọc được biến môi trường của Hub (`/proc/<pid>/environ`), tức token chủ sở hữu, khóa model, token GitHub. Có token chủ sở hữu thì agent gọi được `POST /api/studio/permissions/decide` và **duyệt thay con người** — phá vỡ lớp bảo vệ quan trọng nhất của Review. Cho nên tách quyền không phải "tính năng thêm" mà là điều kiện để chế độ công khai có ý nghĩa.

Ranh giới tin cậy:

```
Internet ──HTTPS──▶ Render edge (TLS, X-Forwarded-*) ──HTTP──▶ container
                                                                 tini (PID 1)
                                                                  └ supervisor  [root, ~300 dòng, không phục vụ HTTP]
                                                                       ├ môi giới lệnh (socket 0660 root:hub)
                                                                       └ Hub  [uid hub, bí mật chỉ ở đây]
                                                                            │  yêu cầu chạy lệnh qua socket
                                                                            ▼
                                                              lệnh của agent [uid agent, nhóm ws, bỏ mọi capability,
                                                                              no_new_privs, env đã lọc, không thấy /proc của Hub]
```

## 3. Quyết định thiết kế

**D1 — Chế độ công khai phải được bật rõ ràng, và không có đường vòng.** `CHATMCP_PUBLIC=1` bật chế độ; bind ra ngoài loopback mà không bật chế độ này → Hub **từ chối khởi động**. Ở chế độ công khai, thiếu hoặc yếu `CHATMCP_OWNER_TOKEN` (ngắn hơn 32 ký tự, hoặc ít hơn 12 ký tự khác nhau) → từ chối khởi động. Không có giá trị mặc định cho bí mật.

**D2 — Xác thực: một chủ sở hữu, token → phiên.** `POST /api/auth/login {token}` so sánh hằng-thời-gian (băm SHA-256 hai phía rồi `timingSafeEqual`). Đúng thì cấp phiên: id ngẫu nhiên 256 bit, **chỉ lưu băm của nó trong bộ nhớ**, cookie `__Host-chatmcp_session` với `HttpOnly; Secure; SameSite=Strict; Path=/` (không `Domain`). Hết hạn khi rảnh 60 phút hoặc tuyệt đối 12 giờ; tối đa 5 phiên cùng lúc. Mỗi phiên có token CSRF riêng (thay token CSRF toàn cục của chế độ loopback). Phiên nằm trong RAM: khởi động lại = đăng nhập lại (đúng với đĩa tạm). Đổi `CHATMCP_OWNER_TOKEN` = mọi phiên cũ vô hiệu.

**D3 — Từ chối mặc định.** Trước khi vào bất kỳ route nào (kể cả `GET`, SSE, tệp tĩnh), yêu cầu phải có phiên hợp lệ, **trừ**: `GET|HEAD /healthz`, trang đăng nhập (`/`, `/login`, `/login.js`, `/login.css` khi chưa có phiên), `POST /api/auth/login`. Cổng này đứng **trước** bộ định tuyến nên route thêm sau này tự động bị chặn. Có test duyệt qua toàn bộ `POST_ROUTES` và danh sách `GET`.

**D4 — Host, Origin, HTTPS, tiêu đề.** `Host` phải thuộc danh sách (`RENDER_EXTERNAL_HOSTNAME` + `CHATMCP_ALLOWED_HOSTS`); ngoại lệ duy nhất là `/healthz`. `Origin` (khi có) phải bằng `https://<host cho phép>`. `X-Forwarded-Proto` khác `https` bị từ chối (trừ `/healthz`), trừ khi đặt `CHATMCP_ALLOW_INSECURE_HTTP=1` (chỉ để thử cục bộ; tên cookie bỏ tiền tố `__Host-` và cờ `Secure`). POST cần: phiên + `Origin` đúng + tiêu đề `X-ChatMCP-Request` + CSRF của phiên (như hiện nay). Thêm `Strict-Transport-Security`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`; CSP `frame-src 'none'` (xem trước localhost vô nghĩa từ xa).

**D5 — Chống dò mật khẩu.** Tối đa 5 lần sai / 15 phút cho mỗi địa chỉ (địa chỉ lấy từ `X-Forwarded-For` đếm từ bên phải theo `CHATMCP_TRUSTED_PROXY_HOPS`, mặc định 2 trên Render — phải xác minh sau khi triển khai), thêm hạn mức **toàn cục** 40 lần sai / 15 phút (không phụ thuộc tiêu đề nào, vì tiêu đề giả mạo được); vượt thì trả `429` + `Retry-After`. Mỗi lần sai chờ cố định 400 ms. Thành công không xóa hạn mức toàn cục. Token 256 bit sinh ngẫu nhiên nên dò trực tiếp không khả thi; giới hạn này chủ yếu chống làm đầy nhật ký và đoán token yếu do người dùng tự đặt.

**D6 — Tách quyền: supervisor + môi giới lệnh (fail-closed).** Tiến trình gốc (`docker/supervisor.mjs`, chạy root dưới `tini`) làm đúng ba việc: chuẩn bị thư mục và quyền; mở **socket Unix** `0660 root:hub` làm *môi giới lệnh*; chạy Hub bằng `setpriv` (uid `hub`, bỏ mọi capability, `no_new_privs`). Hub không bao giờ là root và không có `CAP_SETUID`. Khi Hub cần chạy lệnh (`run_command`, Git, kiểm thử), nó gửi yêu cầu (`file`, `args`, `cwd`, `env`) qua socket; môi giới chạy bằng `setpriv --reuid=agent --regid=agent --groups=ws --bounding-set=-all --inh-caps=-all --no-new-privs`, nhóm tiến trình riêng, `env` **chỉ** gồm những gì Hub gửi (đã lọc biến giống khóa) cộng `HOME=/home/agent`. Môi giới chỉ có một việc nguy hiểm — "chạy bằng agent" — và không thể chạy bằng root. Lúc khởi động có **thăm dò** (chạy `id -u` bằng agent): nếu `setpriv` hoặc `setuid` không được phép trong môi trường này thì chế độ lệnh = `no-shell` (xem D10), **không** quay về "cùng người dùng" trừ khi đặt cờ nguy hiểm `CHATMCP_UNSAFE_SAME_USER_EXEC=1` (dùng cho test trên Windows; nhãn *unsafe*). Môi giới giới hạn số lệnh đồng thời, tổng byte đầu ra, và giết cả nhóm khi Hub ngắt kết nối. Thư mục trạng thái của Hub là `0700 hub:hub` nên agent không đọc được `master.key`/cấu hình model.

**D7 — Bí mật.** Chỉ đi qua biến môi trường của Render (`sync: false`/`generateValue`), không bao giờ trong Git, argv, nhật ký, phản hồi HTTP hay `env` của tiến trình con. Token GitHub dùng qua `GIT_CONFIG_COUNT/KEY/VALUE` (tiêu đề `http.extraHeader` cho đúng một host) trong **tiến trình Git do Hub chạy** (uid hub), không qua dòng lệnh. Đăng ký mọi bí mật vào `manager.secrets` để lớp che (`redact`) hoạt động.

**D8 — Workspace.** Gốc cố định `CHATMCP_WORKSPACES_ROOT` (mặc định `/var/lib/chatmcp/workspaces`, `hub:ws 2775`). `POST /api/workspace/select` chỉ nhận thư mục **con trực tiếp** của gốc (sau `realpath`). Clone: URL chỉ chấp nhận `https://github.com/<owner>/<repo>(.git)` hoặc `owner/repo` (host cho phép cấu hình được; mặc định chỉ `github.com`); bác `ssh://`, `git@`, `file://`, `ext::`, `http://`, có `user:pass@`, cổng, query/fragment, ký tự điều khiển, tên bắt đầu `-`. Lệnh `git clone` dùng `protocol.allow=never` + `protocol.https.allow=always`, `http.followRedirects=false`, `transfer.fsckObjects=true`, `--depth`, `--single-branch`, `--no-tags`, `core.hooksPath` rỗng, `GIT_CONFIG_NOSYSTEM/GLOBAL` trỏ vào tệp rỗng, hết giờ 180 s, kiểm kích thước tối đa (`CHATMCP_MAX_CLONE_MB`, mặc định 200) và số workspace tối đa (3). Metadata (origin, nhánh gốc, SHA gốc) nằm ở thư mục trạng thái của Hub — agent không sửa được.

**D9 — Lấy kết quả ra: tải tarball, hoặc push nhánh.** Không có token GitHub trên máy chủ: `GET /api/workspace/export` tải cây làm việc (`tar.gz`, bỏ `.git`, `node_modules`, tệp bí mật). Có `GITHUB_TOKEN` (token chi tiết, chỉ một kho, quyền Contents: read/write): `POST /api/workspace/push` — *chỉ* chủ sở hữu (phiên + CSRF), nhánh đích luôn có tiền tố `chatmcp/`, không bao giờ `--force`, không bao giờ đẩy nhánh gốc/`main`/`master`. Quy trình tránh để cấu hình `.git` do agent kiểm soát chạm tới token: (1) agent-uid tạo `git bundle` các commit mới (`<SHA gốc>..<nhánh>`) vào thư mục trao đổi; (2) Hub (uid hub) `git init --bare` một kho **sạch**, `fetch --depth=1` nhánh gốc từ GitHub (có token), `fetch` bundle (`transfer.fsckObjects`), rồi `push` refspec cố định; (3) xóa thư mục tạm. Trả về liên kết `compare` của GitHub để chủ tự mở Pull Request (máy chủ không giữ quyền tạo PR).

**D10 — Tính năng bị tắt khi công khai (trả `403 public_mode_disabled`, có test):** Browser Companion và `extension-state`/`instructions`; terminal tương tác và SSE terminal; `lsp/start`; xem trước localhost; chọn thư mục hệ điều hành (`workspace/browse`); mở VS Code; `hub/shutdown`; `executionPolicy` khác `host-review`. Chế độ lệnh `no-shell` (khi không tách được quyền): công cụ `run_command` bị gỡ khỏi danh mục, terminal/kiểm thử thủ công tắt; công cụ Git vẫn chạy bằng uid Hub **với các lớp bảo vệ Phase 1** (`git-trust`, ghi đè `-c`, hook tắt) vì khi đó agent không có đường nào sửa `.git/config`.

**D11 — Mô hình lưu trữ.** Mặc định coi mọi thứ trên đĩa là tạm. Cấu hình model được tự áp dụng từ môi trường khi khởi động: `CHATMCP_AI_PRESET`, `CHATMCP_AI_MODEL` + khóa theo preset (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`...). Giao diện nói rõ: "Máy chủ free sẽ xóa dữ liệu khi ngủ — hãy push".

**D12 — Tài nguyên.** `NODE_OPTIONS=--max-old-space-size=192`; một tác vụ tại một thời điểm (có sẵn); lệnh tối đa 300 s ở chế độ công khai; đầu ra bị chặn (có sẵn); `RLIMIT_NPROC`/`NOFILE`/`FSIZE` cho lệnh của agent qua `prlimit` khi có.

## 4. Ma trận route ở chế độ công khai

| Nhóm | Chưa đăng nhập | Đã đăng nhập |
|---|---|---|
| `GET /healthz` | 200 `{ok}` (503 khi Hub chưa nạp xong) | như cũ |
| `GET /`, `/login`, `/login.js`, `/login.css` | trang đăng nhập | `/` = ứng dụng; `/login` chuyển về `/` |
| `POST /api/auth/login` | thử đăng nhập (giới hạn tốc độ) | cấp phiên mới |
| `POST /api/auth/logout`, `GET /api/auth/session` | 401 / `{authenticated:false}` | hủy phiên / thông tin phiên |
| Mọi `GET /api/*`, tệp tĩnh của ứng dụng, SSE | **401** | như chế độ loopback |
| Mọi `POST /api/*` | **401** | cần Origin + CSRF của phiên |
| Nhóm bị tắt ở D10 | 401 | **403 `public_mode_disabled`** |
| `POST /api/workspace/clone`, `/delete`, `/push`; `GET /api/workspace/list`, `/export` | 401 | mới (D8, D9) |

## 5. Kế hoạch bằng chứng

| Khẳng định | Bằng chứng cần có | Nơi |
|---|---|---|
| Không vào được nếu chưa đăng nhập | Duyệt mọi route bằng yêu cầu không cookie → 401; yêu cầu có cookie giả/hết hạn → 401 | `verify-public-http.mjs` |
| Host/Origin/CSRF/HTTPS đúng | Tấn công `Host` giả, `Origin` lạ, thiếu CSRF, `X-Forwarded-Proto: http` | `verify-public-http.mjs` |
| Chống dò | 6 lần sai → 429 + `Retry-After`; hạn mức toàn cục không bị tiêu đề giả vượt | `verify-auth.mjs`, `verify-public-http.mjs` |
| Cấu hình yếu bị từ chối | Mọi tổ hợp env thiếu/yếu → Hub không khởi động (mã thoát ≠ 0) | `verify-public-config.mjs` |
| Tách quyền thật | Chạy bằng root trong môi trường thử: lệnh agent không đọc được `/proc/<hub>/environ`, state dir, socket; không leo quyền (`su`, `setuid`); `NoNewPrivs=1`, `CapEff=0` | `verify-exec-broker.mjs` (chỉ Linux+root, còn lại SKIP có lý do) và thử trong Docker thật |
| Môi giới an toàn khi Hub sập | Ngắt kết nối → giết nhóm tiến trình | `verify-exec-broker.mjs` |
| Clone/push an toàn | Danh sách URL độc hại bị bác; clone thật qua `git http-backend` cục bộ, kiểm tra tiêu đề `Authorization` chỉ xuất hiện ở tiến trình Hub; push không `--force`, không vào `main`; cấu hình `.git` độc hại không chạm token | `verify-workspaces.mjs`, `verify-e2e-public.mjs` |
| Chạy được trong container | `docker build` + chạy với env giống Render + bộ kiểm tra HTTP | Docker Desktop trên máy bạn |
| Chạy được trên Render | URL thật: `/healthz`, 401 khi chưa đăng nhập, đăng nhập đúng/sai, Host giả | chỉ nếu triển khai được; nếu không → *blocked*, nói rõ ở báo cáo |

## 6. Việc tôi cố ý không làm

- Không viết lại lịch sử Git, không force-push, không đẩy lên `main`, không đổi chế độ hiển thị (public/private) của kho.
- Không đụng vào thư mục `.github/workflows/` (công cụ của phiên bị chặn có chủ đích). Bản workflow đề xuất vẫn nằm ở `docs/ci-proposal.yml`.
- Không dùng dịch vụ trả phí (đĩa bền, gói Starter, tên miền riêng), không dán khóa thật vào bất kỳ tệp nào.
- Không tuyên bố đa người dùng, không tuyên bố "an toàn tuyệt đối". Tách quyền bảo vệ bí mật của Hub khỏi lệnh của agent; nó **không** ngăn agent gọi mạng ra ngoài hay làm hỏng workspace của chính nó.

## 7. Khôi phục

Xóa dịch vụ trên Render là gỡ sạch (không có dữ liệu bền). Quay lại bản trước = triển khai lại commit cũ. Chế độ công khai tắt theo mặc định: không đặt `CHATMCP_PUBLIC` thì Hub hành xử y hệt Phase 1 (loopback, không đăng nhập) và các test cũ phải vẫn đạt.
