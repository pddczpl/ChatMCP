## Báo cáo bằng chứng

**✅ Mọi tiêu chí đều có bằng chứng hoặc được chủ dự án chấp nhận (2 có bằng chứng, 1 được chấp nhận).**

Số tiêu chí theo trạng thái: ✅ Có bằng chứng 2; 👤 Chủ dự án chấp nhận 1

Tệp gói đã được kiểm khi tạo báo cáo này: lược đồ, digest, các tệp và sổ cái khớp nhau, và kết quả các lệnh kiểm tra suy ra từ chính sổ cái đó. Những gì chủ dự án chấp nhận, các thay đổi ở lệnh kiểm tra và việc tệp tiêu chí có được tin cậy hay không được lấy nguyên như statement ghi. Gói chưa được ký, nên điều này cho biết gói còn nguyên vẹn, không cho biết ai đã tạo nó.

Báo cáo này được tạo từ một gói bằng chứng để dễ đọc. Bản thân nó không phải bằng chứng và ai cũng có thể sửa nó: hãy kiểm gói bằng các lệnh ở cuối.

### Thay đổi gì, do ai thực hiện

- **Agent:** `DatGold`, phiên bản `3.12.0`
- **Mô hình:** `nhà cung cấp mẫu` / `mô-hình-1`
- **Phiên bản hồ sơ:** không được ghi trong gói này
- **Commit gốc:** `752b556a42ff0d908a4cb28c6ee18d36ad0693d5`
- **Cây ban đầu:** `79ebfc4279196a5ecd3e7b36569209217e59d40b` (`git-pinned-v1`, `sha1`; số tệp: 1.234, số byte: 5.678.901)
- **Cây cuối:** `f3ef6ce42152415b9cbc552a192c34b8f9b56212` (`git-pinned-v1`, `sha1`; số tệp: 1.235, số byte: 5.678.901)
- **Bản vá (sha256):** `71376f6fd0a391c4a5680da50a229e072233d9aabdb4c1b6f7a62a5d7228eb44`
- **Digest của statement:** `3276dcef03af58a754cffa015df1c1f53e0927a289ccf73bdeac7e4f7f9b1bc5`
- **Tệp tiêu chí (sha256):** `20a660e79e70b325b5fd5e88650df7d3574769e63874e8be104c5dd75f409480`: được người tạo gói tin cậy

### Tiêu chí

| Tiêu chí | Trạng thái | Yêu cầu | Lệnh kiểm tra đạt |
| --- | --- | --- | --- |
| `kiem-thu` | ✅ Có bằng chứng | `Các kiểm thử đơn vị đều đạt, chạy hai lần liên tiếp` | 1/1 |
| `lint` | ✅ Có bằng chứng | `Không còn cảnh báo lint; mã thoát của bộ kiểm là 3 như tài liệu ghi` | 2/2 |
| `giao-dien` | 👤 Chủ dự án chấp nhận | `Màn hình đăng nhập hiển thị đúng dấu tiếng Việt: ắ ằ ẳ ẵ ặ, ố ồ ổ ỗ ộ, ứ ừ ử ữ ự, đ Đ` | – |

Các lệnh kiểm tra của từng tiêu chí, và những lần chạy được tính cho cây cuối:

| Tiêu chí | Lệnh kiểm tra | Lệnh | Thư mục | Mã thoát mong đợi | Lần chạy được tính | Kết quả | Các biên nhận |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `kiem-thu` | 1 | `node --test` | `.` | `0` | 2/2 | ✅ Đạt | 6, 7 |
| `lint` | 1 | `npm run lint` | `packages/ui` | `0` | 1/1 | ✅ Đạt | 8 |
| `lint` | 2 | `node lint.mjs` | `.` | `3` | 1/1 | ✅ Đạt | 9 |

- `giao-dien`, cần một người xem: `src/đăng-nhập.mjs`
- `giao-dien`, ghi chú trong tệp tiêu chí: `Xem ở cỡ chữ 200 %`

Vì sao một tiêu chí có trạng thái đó:

| Tiêu chí | Lệnh kiểm tra | Lý do | Chi tiết |
| --- | --- | --- | --- |
| `giao-dien` | – | Chủ dự án đã chấp nhận tiêu chí này cho cây cuối. | `by Nguyễn Thị Ánh at 2026-11-23T09:30:00Z` |

### Biên nhận

| Biên nhận số | Lệnh | Kết cục | Cây | Thời lượng | Thời điểm | Lệnh kiểm tra liệt kê nó |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | `node --test`, trong shell `bash` | mã thoát `0` | `f3ef6ce42152` (cây cuối) | 1,840 s | `2026-11-23T08:00:06.000Z` | `kiem-thu` (1) |
| 7 | `node --test`, trong shell `bash` | mã thoát `0` | `f3ef6ce42152` (cây cuối) | 1,795 s | `2026-11-23T08:00:07.000Z` | `kiem-thu` (1) |
| 8 | `npm run lint` ở thư mục `packages/ui`, trong shell `bash` | mã thoát `0` | `f3ef6ce42152` (cây cuối) | 912 ms | `2026-11-23T08:00:08.000Z` | `lint` (1) |
| 9 | `node lint.mjs`, trong shell `bash` | mã thoát `3` | `f3ef6ce42152` (cây cuối) | 61,007 s | `2026-11-23T08:00:09.000Z` | `lint` (2) |
| 10 | `git status --short`, trong shell `bash` | mã thoát `0` | `79ebfc427919` (cây khác) | 33 ms | `2026-11-23T08:00:10.000Z` | – |

Gói không chứa đầu ra của lệnh, chỉ có sha256 và kích thước; báo cáo này cũng lược bỏ chúng.

### Thống kê thay đổi

Số tệp: 5. Dòng thêm: 4. Dòng bớt: 2. Tệp nhị phân: 1.

| Đường dẫn | Thay đổi | Dòng thêm | Dòng bớt |
| --- | --- | --- | --- |
| `src/tính-tổng.mjs` | sửa đổi | 2 | 1 |
| `docs/huong dan.md` | thêm mới | 2 | 0 |
| `old.txt` | xóa | 0 | 1 |
| `logo.bin` | sửa đổi | nhị phân | nhị phân |
| `run.sh` | sửa đổi | 0 | 0 |

### Thay đổi ở các lệnh kiểm tra

Báo cáo về thay đổi lệnh kiểm tra không thấy thay đổi nào ở các tệp mà lệnh kiểm tra phụ thuộc vào.

Tệp tiêu chí không bị sửa trong lúc làm tác vụ.

Không tệp khóa nào trong báo cáo thay đổi (số tệp đã xem: 1).

### Quyết định cấp quyền

Số bản ghi cấp quyền trong sổ cái: 4.

| Quyết định | Số lượng |
| --- | --- |
| Đồng ý | 2 |
| Từ chối | 1 |
| Do chính sách quyết định | 1 |

### Sự kiện không chắc chắn

Sổ cái của gói này không có bản ghi không chắc chắn nào. Đó là những gì đã được ghi lại, không phải chứng minh rằng không có gì không chắc chắn xảy ra.

### Dữ liệu gửi ra ngoài (Companion)

Không được ghi trong gói này: statement v0.1 không có trường nào cho dữ liệu đã gửi ra khỏi máy này, qua Companion hay bằng cách khác. Điều đó không có nghĩa là không có gì được gửi.

### Chi phí

1.234,5678 USD cho toàn bộ lần chạy. Gói cho biết số này gồm mọi lời gọi.

Quy ra đồng Việt Nam: 31.358.022 VND, theo tỷ giá do người tạo báo cáo đưa ra: 1 USD = 25.400 VND ngày 2026-11-20, nguồn `Vietcombank, tỷ giá bán ra`. Tỷ giá này chưa được kiểm tra.

Chi phí cho mỗi tiêu chí được kiểm chứng: không được ghi trong gói này. Statement v0.1 chỉ có một chi phí cho toàn bộ lần chạy, và ở đây không chia nhỏ số đó.

### Mức toàn vẹn và giới hạn

- **Mức toàn vẹn:** `unconfined`: agent chạy dưới cùng tài khoản với Hub và có thể ghi lại những gì gói này được tạo từ đó. Gói ghi lại điều đã quan sát được. Nó không phải niêm phong chống lại agent.
- **Sổ cái:** Số bản ghi: 11. Toàn bộ chuỗi khớp; mã băm của bản ghi cuối là `d117fe6dfc11db1bfe0cb6eedc948c54e35c25ba5c04c0bd14c0e321c5f0c0d0`.

Gói chưa được ký.

Các giới hạn mà gói nêu:

- Statement chưa được ký: digest chỉ định danh nó, không cho biết ai đã tạo nó.
- Không có gì giới hạn agent, nên nó có thể đã thay đổi đầu vào của gói này.
- Phần cuối của sổ cái không được neo: bỏ các dòng ở cuối vẫn còn một sổ cái ngắn hơn và vẫn khớp.
- Không thấy được thay đổi ở các đường dẫn bị bỏ qua và không được theo dõi.
- Các quy tắc phỏng đoán cũng đánh dấu cả những thay đổi chính đáng ở kiểm thử.
- Không biết một lệnh chạy những kiểm thử nào, nên một thay đổi ở kiểm thử được tính cho mọi tiêu chí có chạy lệnh.
- Các tệp được bảo vệ (bí mật và khóa) không bao giờ được đọc, nên không thấy được thay đổi ở chúng.

Những gì mã cây không bao gồm:

- các tệp được bảo vệ (khóa, thông tin đăng nhập, tệp môi trường): 2
- thư mục các lần chạy: 1
- các đường dẫn bị bỏ qua và không được theo dõi, không được đếm
- nội dung của các kho lồng bên trong, chỉ tính theo commit của chúng: 0

### Cách kiểm chứng

Báo cáo này nói về statement `3276dcef03af58a754cffa015df1c1f53e0927a289ccf73bdeac7e4f7f9b1bc5`. Hãy chạy check trên tệp gói rồi so sánh: lệnh phải in ra đúng digest đó, nếu không thì báo cáo là của một gói khác.

```text
chatmcp verify check evidenced.pack.json
chatmcp verify trust --pack evidenced.pack.json
chatmcp verify reproduce evidenced.pack.json --base 752b556a42ff0d908a4cb28c6ee18d36ad0693d5
```

Các lệnh này kiểm gói, cho xem những lệnh mà gói sẽ chạy, và chạy lại các lệnh kiểm tra của gói. Reproduce chạy những lệnh có thể do người khác viết, nên hãy đọc những gì trust hiển thị trước khi tin cậy.
