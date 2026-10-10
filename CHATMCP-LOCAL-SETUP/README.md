# ChatMCP Hub 1.0.0

Ứng dụng local dành cho bộ Cloud Harness + Desktop Commander đang có trên máy Windows của bạn. Mở VS Code, chạy một lệnh, chọn thư mục và giao việc bằng ngôn ngữ bình thường. Hub điều phối mô hình AI và MCP, hiển thị tiến độ và lưu báo cáo của từng nhiệm vụ.

## 1. Bắt đầu với máy hiện tại

Bộ này được chuẩn bị cho cấu hình đã có của bạn:

| Thành phần | Đường dẫn / địa chỉ |
| --- | --- |
| Cloud Harness đã cài | `F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp` |
| Cấu hình nguồn | `deploy\.generated\mcp-client.proxy.json` bên trong Cloud Harness |
| Launcher Cloud Harness đã chạy thành công | `deploy\.generated\start-cloud-harness.ps1` |
| Cloud Harness local | `http://127.0.0.1:3100/mcp` |
| MCP proxy do Hub quản lý | `http://127.0.0.1:3006/mcp` |
| Trang làm việc | `http://127.0.0.1:3007` |

Cần Windows PowerShell 5.1, Node.js từ 22.12 trở lên, npm và Docker Desktop đã cài. Node 24.19.0 bạn đã kiểm tra đáp ứng điều kiện. Bộ này dùng lại bản Cloud Harness và thông tin xác thực hiện có; không phải bộ cài Docker/GitHub App từ đầu.

### Thiết lập một lần

1. Nếu cửa sổ `START-MCP-BROWSER.ps1` hoặc lệnh `npx ... --port 3006` cũ còn chạy, nhấn **Ctrl+C trong đúng cửa sổ đó**. Hub cần tự quản lý cổng 3006. Giữ Docker Desktop và dịch vụ Cloud Harness hiện có.
2. Trước khi giải nén ZIP, có thể mở **Properties → Unblock → Apply** của ZIP nếu Windows hiển thị mục này. Giải nén toàn bộ thư mục `CHATMCP-HUB` vào `F:\Personal_Project\Vin\ChatMCP`. Kiểm tra file dưới đây tồn tại, tránh lồng thêm một thư mục cùng tên.
3. Mở terminal PowerShell trong VS Code và chạy:

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
```

Trang `http://127.0.0.1:3007` sẽ mở. Terminal trả lại dấu nhắc sau khi tiến trình Hub nền đã khởi tạo; việc chuẩn bị MCP tiếp tục được báo trên trang.

4. Trong **Workspace**, bấm **Chọn thư mục…**, chọn thư mục dự án và bấm **Dùng thư mục này**. Có thể dán trực tiếp đường dẫn sau:

```text
F:\Personal_Project\Vin\K4-Track4-Day23-PhanDanhDat-02627-Sensor-Fusion-Student
```

5. Mở **Thiết lập AI** và chọn một cách kết nối ở mục 2 bên dưới. Việc đăng nhập hoặc nhập key chỉ cần thực hiện lúc thiết lập, khi bạn chủ động đổi thông tin, hoặc khi nhà cung cấp yêu cầu xác thực lại.
6. Chờ phần MCP và AI sẵn sàng. Nhập yêu cầu vào **Bạn muốn làm gì?** rồi bấm **Chạy yêu cầu**. Hub tự thực hiện các lượt gọi công cụ tiếp theo trong giới hạn của nhiệm vụ.

Lần đầu có thể cần vài phút để cài đúng phiên bản dependency và khởi động Docker. Các lần sau Hub dùng lại cấu hình, thư mục và package đã lưu. Hub chủ động mở Docker Desktop nếu engine chưa sẵn sàng; các bước khởi tạo riêng của Docker/Windows vẫn có thể cần người dùng xử lý nếu máy chưa được thiết lập.

### Lệnh dùng hằng ngày

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd'
```

Hub mở lại trang và chuẩn bị MCP với workspace đã lưu. Bạn có thể chọn thư mục khác khi không có nhiệm vụ đang chạy. Nếu Hub đã chạy, lệnh dùng lại phiên hiện có.

Muốn chọn ngay thư mục hiện tại của terminal VS Code:

```powershell
& 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB\START-CHATMCP-HUB.cmd' -ProjectPath .
```

Nếu Cloud Harness nằm ở vị trí khác, truyền `-RepoRoot 'D:\duong-dan\cloud-harness-mcp'`. `-Port 3007` cho phép đổi cổng trang Hub; 3006 được giữ cho proxy. Companion tùy chọn chỉ hỗ trợ Hub tại cổng 3007.

## 2. Chọn kết nối AI

### A. Đăng nhập ChatGPT

1. Chọn **ChatGPT — đăng nhập tài khoản** trong **Thiết lập AI**.
2. Có thể giữ tên model đang gợi ý để bắt đầu đăng nhập. Bấm **Đăng nhập ChatGPT**.
3. Trong trang đăng nhập chính thức của OpenAI, chọn tài khoản và xem quyền sử dụng gói ChatGPT. Kết nối cần quyền dùng gói cho các yêu cầu AI; quyền nhận diện tài khoản riêng lẻ chưa đủ để chạy nhiệm vụ.
4. Quay về Hub. Sau khi xác thực, Hub đọc model thực sự có cho kết nối; nếu cần, bấm **Đọc danh sách model**, chọn model được hỗ trợ và **Lưu cài đặt AI**.

Đây là luồng Sign in with ChatGPT chính thức cho ứng dụng cá nhân chạy local. Khả năng sử dụng phụ thuộc điều kiện của tài khoản/gói và trạng thái dịch vụ. Nó dùng hạn mức Codex / ChatGPT work hiện có của gói, không tạo thêm quota. Nếu quota đó đã hết, đăng nhập vào Hub không làm quota được cấp lại. Hub báo nguyên nhân và không tự chuyển sang API tính phí.

Luồng đăng nhập có thể cần thực hiện lại khi bạn thu hồi kết nối hoặc khi token không còn sử dụng được. Bản này quản lý một kết nối ChatGPT trên một thư mục dữ liệu Hub; giao diện chưa có bộ quản lý nhiều tài khoản. Lịch sử và memory của các cuộc chat trên chatgpt.com không tự nhập vào Hub.

### B. OpenAI API key

1. Chọn **OpenAI API — dùng API key**.
2. Nhập key vào ô trên trang localhost, chọn đúng model được tài khoản API hỗ trợ và bấm **Lưu cài đặt AI**. Không gửi key vào cuộc chat.
3. Có thể dùng `OPENAI_API_KEY` của môi trường thay cho nhập key. Hub ưu tiên key đã lưu khi có; ô trên trang không hiển thị lại giá trị đã lưu.

API có hệ thống thanh toán riêng với ChatGPT. Bạn cần tài khoản API được phép gọi model và còn ngân sách. Ô model có thể sửa; danh sách model trong chế độ ChatGPT được lấy từ tài khoản, còn chế độ API dùng tên model bạn nhập.

Nếu chọn lưu thông tin đăng nhập, Hub dùng Windows DPAPI theo tài khoản Windows hiện tại để mã hóa dữ liệu đăng nhập. Key không được lưu trong mã nguồn hoặc ô giao diện. Nếu bỏ chọn lưu đối với API key mới, key dùng cho phiên Hub hiện tại. Kết nối ChatGPT cần lưu thông tin đăng ký và refresh token để dùng lại.

## 3. Giao nhiệm vụ

Ví dụ phù hợp với bài Sensor Fusion:

> Đọc README, RULES, RUBRIC, CHECKPOINTS và SUBMISSION trước. Rà soát toàn bộ cấu trúc dự án và đọc các file nguồn, notebook, cấu hình liên quan để xác định phần còn thiếu. Hoàn thành bài lab theo đúng yêu cầu trong repository, giữ những thay đổi tôi đã có. Chạy các kiểm tra mà dự án hướng dẫn, sửa lỗi liên quan nếu có. Cuối cùng báo rõ đã sửa file nào, đã chạy lệnh kiểm tra nào, kết quả thực tế và phần nào còn bị chặn. Làm việc trong workspace đã chọn.

Bạn có thể nhập yêu cầu ngắn như “đọc thư mục này, hoàn thành bài lab” rồi để mô hình lập các bước. Yêu cầu nêu tiêu chí hoàn thành giúp đánh giá kết quả rõ hơn. Với binary hoặc dữ liệu lớn, agent dùng công cụ phù hợp để kiểm tra thay vì nhét toàn bộ byte vào ngữ cảnh.

Trong luồng chính này không cần gửi JSONL, bấm Run trên từng thẻ, mở tab ChatGPT hay cài thêm tiện ích. Mô hình nhận kết quả MCP thật sau mỗi lời gọi và tiếp tục cho tới khi trả lời cuối, bị hủy, gặp lỗi ngăn tiếp tục hoặc chạm giới hạn đã chọn.

**Giới hạn mặc định:** 100 lượt phản hồi mô hình và 30 phút. Một lượt có thể chứa nhiều lời gọi công cụ. Có thể thay đổi trước khi chạy, tối đa 1.000 lượt và 240 phút. Giới hạn này giúp chặn vòng lặp kéo dài; không phải lời hứa mọi bài lab sẽ hoàn tất trong 30 phút.

Trong **Tiến độ & kết quả** có trạng thái, lời gọi công cụ, số lượt, lượng token nhà cung cấp trả về, kết quả cuối và nút tải báo cáo. Nhiệm vụ mới độc lập với lịch sử của nhiệm vụ cũ; khi cần làm tiếp, mô tả việc còn lại và để agent kiểm tra trạng thái file hiện tại. Đóng trang không dừng nhiệm vụ. Máy tắt, Windows đăng xuất hoặc Hub dừng thì nhiệm vụ không còn tiếp tục chạy.

**Huỷ tác vụ** ngừng việc điều phối tiếp theo. Một thao tác đã được server tiếp nhận có thể đã thay đổi file hoặc còn cần thời gian dừng; hủy không hoàn tác những thay đổi đó. Nhiệm vụ bị gián đoạn không được tự chạy lại các lệnh ghi không rõ kết quả.

## 4. Đầy đủ công cụ và skills nghĩa là gì trong Hub

Hub đọc danh mục thực tế của **cả Cloud Harness và Desktop Commander**, không giữ cố định con số 92 hoặc một danh sách con tự chọn.

| Phần | Cách xử lý |
| --- | --- |
| Tools | Đọc hết các trang `tools/list`, giữ tên gốc, mô tả, input schema và metadata. Tên hiển thị có tiền tố server. |
| Đối chiếu proxy | So tên và input schema của toàn bộ danh mục nguồn với proxy; lỗi, trùng tên hoặc thiếu công cụ sẽ làm kiểm tra thất bại. |
| Gọi từ agent | Kết nối trực tiếp tới hai MCP server trong phiên nhiệm vụ; giữ nguyên tên và schema nguồn, không bóp thành một vài thao tác đọc/ghi. |
| Prompts / resources | Đọc hết danh mục mà server công bố; agent có thao tác lấy prompt, liệt kê và đọc resource/template. |
| Skills, hooks, memories | Các tool như `skills_list`, `skills_read`, `skills_run`, hooks và memories được đưa vào danh mục khi Cloud Harness đang chạy có cung cấp chúng. Nội dung và khả năng chạy phụ thuộc repository/server. |
| Hướng dẫn trong dự án | Agent được hướng dẫn đọc README, RULES, AGENTS và SKILL.md liên quan trước khi sửa. |
| Theo dõi | Trang **Toàn bộ công cụ MCP** hiển thị số lượng từng server, tìm theo tên/tham số và tải JSON đầy đủ. |

Để không bị giới hạn số function đăng ký ở API hoặc khác biệt schema giữa các model, mô hình dùng bốn hàm điều phối: `mcp_catalog`, `mcp_describe`, `mcp_call`, `mcp_capabilities`. Đây là cửa gọi tới toàn bộ danh mục, không phải chỉ có bốn MCP tool sử dụng được. Agent lấy mô tả/schema rồi gọi đúng tool cần dùng.

Đủ danh mục không đồng nghĩa có thể kiểm chứng trước mọi hành vi của mọi tool. Quyền GitHub, network profile, workspace lease, phần mềm cần cài và lỗi của upstream vẫn áp dụng. Hub không cấp thêm quyền push, không bật Internet cho container đang dùng `network-none`, và không biến một tool server không công bố thành tool có sẵn. Các skill/plugin của một app AI khác cũng không tự được chuyển sang chỉ vì kết nối MCP.

Adapter cho browser proxy bỏ trường `outputSchema` ở danh mục gửi riêng cho client trình duyệt để tương thích phiên bản proxy cũ. Tên tool, mô tả và toàn bộ input schema vẫn được giữ. Phiên agent chính đọc trực tiếp nguồn và giữ metadata gốc, gồm output schema nếu có.

## 5. File Windows và workspace Cloud Harness

Thư mục bạn chọn ở Hub là thư mục Windows thật. Desktop Commander dùng đường dẫn này và các thao tác file được đặt phạm vi theo thư mục đã chọn. Lệnh terminal chạy với quyền tài khoản Windows của bạn; giới hạn đường dẫn của công cụ file không phải sandbox hệ điều hành.

Cloud Harness HTTP hiện có chạy workspace clone riêng trong Docker. `workspaceId` của Cloud Harness không phải đường dẫn `F:\...`. Agent được hướng dẫn sử dụng Desktop Commander cho file Windows và giữ đúng workspaceId khi dùng Cloud Harness. Bản này không tự đồng bộ toàn bộ file giữa hai nơi và không tự bind-mount thư mục Windows vào container.

Ví dụ: sửa notebook trong thư mục VS Code dùng Desktop Commander. Muốn mở clone Docker, dùng tính năng Cloud Harness qua prompt và chỉ rõ mục đích. Nếu một bước tạo kết quả trong Docker cần đưa về Windows, nhiệm vụ phải thực hiện việc chuyển file rõ ràng; không được báo rằng file Windows đã sửa chỉ dựa vào thay đổi trong clone.

## 6. Những gì chạy nền và được lưu

Hub khởi chạy Node nền và quản lý proxy/tiến trình MCP do nó tạo. Nó kiểm tra Docker, gọi launcher Cloud Harness hiện có khi cần, kiểm tra kết nối thật, chuẩn bị workspace và xác minh danh mục trước khi cho chạy nhiệm vụ. Tác vụ đang chạy khóa việc đổi workspace/cấu hình AI và khởi động lại kết nối.

Địa chỉ Hub và proxy chỉ bind `127.0.0.1`. Hub gọi mô hình qua Internet; nội dung file/kết quả công cụ cần cho nhiệm vụ có thể được đưa vào yêu cầu mô hình. Đây là app điều phối local dùng AI trực tuyến, không phải mô hình AI offline. Package và dịch vụ MCP giữ hành vi mạng riêng của phiên bản bạn cài.

Các file dữ liệu của Hub nằm tại:

```text
F:\Personal_Project\Vin\ChatMCP\cloud-harness-mcp\deploy\.generated\chatmcp-hub
```

| File / thư mục | Nội dung |
| --- | --- |
| `hub-state.json` | Workspace đã chọn |
| `mcp-client.hub.json` | Bản cấu hình riêng do Hub dùng, có thông tin xác thực MCP |
| `model-provider.json` | Provider/model, không chứa API key |
| `model-credentials.dpapi` | Thông tin đăng nhập được DPAPI mã hóa |
| `chatgpt-host.json` | Định danh của bản cài để đăng ký kết nối ChatGPT |
| `tasks` | Nhật ký, trạng thái và báo cáo của từng nhiệm vụ |
| `hub.log` | Nhật ký Hub, có cơ chế che các secret đã nhận diện |

Prompt và kết quả công cụ có thể chứa nội dung dự án. Không gửi nguyên thư mục dữ liệu/config cho người khác để nhờ chẩn đoán. Mã nguồn trong ZIP không có token của bạn.

Hub dùng bản sao cấu hình proxy nguồn và giữ các mục không liên quan. Chọn workspace cập nhật `allowedDirectories` trong cấu hình Desktop Commander theo tài khoản Windows; file gốc được sao lưu trước. Thay đổi đó có thể ảnh hưởng các client Desktop Commander khác dùng cùng cấu hình. Trong lúc nhiệm vụ chạy, tránh dùng một client khác để đổi thư mục/cấu hình này.

## 7. Dừng và dùng lại

- Đóng tab hoặc terminal VS Code: Hub và tác vụ đã chạy nền tiếp tục.
- **Dừng kết nối:** dừng các tiến trình MCP do Hub quản lý khi không có tác vụ đang chạy.
- **Tắt Hub:** dừng Hub và các tiến trình con nó sở hữu; nếu có tác vụ đang chạy, tác vụ được yêu cầu hủy. Docker Desktop và dịch vụ Cloud Harness dùng chung không bị tắt.
- Chạy lệnh khởi động lần nữa để mở lại. Hub dùng lại phiên có sẵn, không cố giết tiến trình đang chiếm cổng.
- Bản này không tự đăng ký tác vụ Windows Startup: đúng luồng bạn mô tả là mở VS Code và chủ động nhập một lệnh sau khi bật máy.

## 8. Nếu lần đầu chưa sẵn sàng

| Hiện tượng | Việc cần kiểm tra |
| --- | --- |
| `not digitally signed` | Unblock ZIP trước khi giải nén hoặc unblock các script trong đúng thư mục gói. Hub không đổi execution policy. Với chính sách tổ chức bắt buộc chữ ký, cần quy trình ký/cho phép của tổ chức. |
| Cổng 3006 đang dùng | Ctrl+C trong cửa sổ proxy cũ mà bạn đã mở, sau đó bấm **Khởi động MCP**. Không chạy hai launcher proxy cùng lúc. |
| Không có cấu hình nguồn | Kiểm tra file `mcp-client.proxy.json` hiện có. Hub cần mục `cloud-harness` trỏ local và Authorization hợp lệ từ bản cài của bạn. |
| Docker chưa sẵn sàng | Chờ engine Docker Desktop khởi động hoặc xem thông báo trong Docker, rồi **Khởi động MCP**. |
| Cài package thất bại | Xem nhật ký đã che key. Kiểm tra npm, Internet/proxy công ty và dung lượng ổ đĩa. Cài lần đầu tải dependency thật; không coi dòng npm notice là bằng chứng cài thành công. |
| Mất session / danh mục lệch | Khi không có tác vụ chạy, bấm **Khởi động MCP** để dựng lại kết nối và đối chiếu. Hub không tự phát lại lệnh ghi có kết quả chưa xác định. |
| Không mở hộp chọn thư mục | Dán đường dẫn vào ô Workspace rồi **Dùng thư mục này**. |
| Hết hạn mức / không đủ điều kiện ChatGPT | Xem trạng thái AI và hạn mức trong ChatGPT. Chờ hạn mức khôi phục hoặc chủ động chọn API có ngân sách. |
| Không lưu được đăng nhập | Kiểm tra đang chạy đúng tài khoản Windows và quyền ghi thư mục dữ liệu. Dữ liệu DPAPI không thể được chuyển tùy tiện sang tài khoản Windows khác. |
| Hub đang chạy ở cổng khác với cùng thư mục dữ liệu | Dùng lại phiên hiện có hoặc tắt nó từ giao diện trước. Hub chỉ cho một tiến trình ghi vào cùng dữ liệu tác vụ/đăng nhập. |
| Sau khi máy tắt đột ngột, có lỗi khóa `hub-instance.claim` | Kiểm tra chắc chắn không còn Hub đang chạy trước khi xử lý thư mục khóa được nêu trong lỗi. Đây là khóa ngắn để tránh hai lần khởi động cùng ghi dữ liệu; Hub không tự đoán và giết tiến trình. |

Chỉ nếu Windows chặn các script đã giải nén của chính gói này, có thể chạy một lần:

```powershell
Get-ChildItem -LiteralPath 'F:\Personal_Project\Vin\ChatMCP\CHATMCP-HUB' -Filter '*.ps1' -Recurse | Unblock-File
```

Sau đó chạy lại lệnh khởi động thông thường. Lệnh này không đổi execution policy và không yêu cầu mở terminal Administrator.

## 9. Kiểm chứng của bản bàn giao

Xem **VALIDATION.txt** để biết chính xác các kiểm tra đã qua và các phần chưa được chạy trên máy Windows thật. Bộ mã đã được thử bằng MCP SDK/proxy thật cùng hai server kiểm thử local và mô hình giả lập: lập danh mục nhiều trang, gọi tool ghi file tạm, đọc lại file và lưu báo cáo. Các kiểm tra đó không tương đương chạy bài lab của bạn hoặc đăng nhập ChatGPT thật.

Việc thử khởi động Desktop Commander thật trong môi trường tạo gói bị cơ chế xét duyệt tự động chặn do có thể phát sinh telemetry/feature-flag request ra ngoài. Bản bàn giao không gắn nhãn kiểm tra đó là thành công. Hub sẽ chạy kiểm tra kết nối và thư mục trên chính máy Windows khi bạn khởi động.

Không có cơ sở để cam kết mọi tool và mọi nhiệm vụ không bao giờ lỗi. Bản này kiểm tra đầy đủ danh mục, báo lỗi rõ, giữ nhật ký, khóa workspace khi chạy và không báo nhiệm vụ thành công khi transport bị đứt. Trạng thái “hoàn thành” nghĩa là mô hình đã kết thúc với kết quả cuối; việc đạt rubric vẫn cần được đối chiếu với file và các kiểm tra thực tế trong báo cáo.

## 10. Tiện ích ChatGPT web — tùy chọn

Thư mục `extension` chứa ChatMCP Hub Companion 1.2.0 để giữ lại luồng MCP SuperAssistant trước đây. Luồng nhập prompt ngay trên localhost không cần cài phần này. Nếu muốn dùng chatgpt.com thay thế, đọc `extension/HUONG-DAN.txt`: lần đầu vẫn cần bật tiện ích, chuẩn bị hướng dẫn trong chat và chọn các chế độ Auto của MCP SuperAssistant. Companion không tự đăng nhập, bấm Send/Run hoặc thay quyền của tiện ích khác.

## Nguồn và dependency

Tài liệu được đối chiếu ngày 09/10/2026:

- Cloud Harness, công cụ và ranh giới local/Docker: <https://github.com/bestagentkits/cloud-harness-mcp>
- Desktop Commander: <https://github.com/wonderwhy-er/DesktopCommanderMCP>
- MCP SuperAssistant: <https://github.com/srbhptl39/MCP-SuperAssistant>
- Sign in with ChatGPT cho ứng dụng local: <https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt>
- SIWC model/inference: <https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference>
- SIWC giới hạn tính năng: <https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations>
- Tài khoản, quyền và hạn mức: <https://learn.chatgpt.com/docs/sign-in-with-chatgpt>
- API billing riêng: <https://help.openai.com/en/articles/9039756-managing-billing-settings-on-the-chatgpt-web-and-api-platform>

Thông tin về các phần mềm bên thứ ba nằm trong **THIRD-PARTY-NOTICES.txt**.
