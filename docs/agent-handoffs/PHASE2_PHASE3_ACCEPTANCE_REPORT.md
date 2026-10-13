# **BÁO CÁO KIỂM THỬ NGHIỆM THU PHASE 2 & PHASE 3**

**Dự án:** ChatMCP — Local Autonomous Coding Agent for Windows\
&#x20;  **Nhánh kiểm tra:** `feat/phase3-advanced-multiagent` (PR #16, xếp chồng trên Phase 2 PR #15 và Phase 1 PR #13)\
&#x20;  **Commit SHA kiểm tra:** `8be970e888cf1e5a3eaa99c349b1b9ba4af8176a`\
&#x20;  **Môi trường thực thi:** Host Windows 11 Pro Build 26300 x64, Node.js v24.19.0, Git 2.55.0.windows.1, .NET SDK 10.0.103.\
&#x20;  **Thời gian thực hiện:** 2026-10-14

---

## **1. TỔNG QUAN PHÁN QUYẾT (EXECUTIVE SUMMARY)**

| Giai đoạn                           | Trạng thái Kiểm thử Chức năng / Hợp đồng | Trạng thái Nghiệm thu Sản xuất (Production Release) | Lý do then chốt                                                                                                                                                                                                                                                                                       |
| :---------------------------------- | :--------------------------------------: | :-------------------------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 2 (Local Reliability)**     |              **PASS** (100%)             |                     **BLOCKED**                     | Toàn bộ 72/72 Hub test suites, kiểm thử crash/restart journal, persistence của acknowledgement, và context preview đều PASS. Tuy nhiên, theo quy tắc kiến trúc tại `docs/PHASE2-LOCAL-RELIABILITY.md`, Phase 2 bị chặn xuất bản sản xuất do phụ thuộc vào cổng G4 (Phase 1) và clean-machine install. |
| **Phase 3 (Multi-Agent Worktrees)** |              **PASS** (100%)             |                     **BLOCKED**                     | Toàn bộ các ca kiểm thử DAG, Git worktree thật, A → no-op B → C, xung đột file-vs-directory, review tokens và concurrency đều PASS. Tương tự, Phase 3 bị chặn xuất bản do phụ thuộc vào Phase 2 và Phase 1 G4.                                                                                        |

IMPORTANT

&#x20; **Chỉ thị an toàn bắt buộc:**

- **KHÔNG MERGE** PR #13, #15, #16 vào `main`.
- **KHÔNG TẠO** tag/release.
- **GIỮ NGUYÊN** chính sách bảo mật G4 (`hostAttested: false` trong `assemble.mjs`).

---

## **2. KẾT QUẢ KIỂM THỬ CHI TIẾT THEO YÊU CẦU**

### **2.1. Kiểm thử Thành phần Phase 2 & Phase 3 (CHATMCP-HUB)**

| STT | Lệnh kiểm thử                               | Exit Code |  Kết quả | Ghi chú & Bằng chứng xác nhận                                                                                                                                                               |
| :-: | :------------------------------------------ | :-------: | :------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|  1  | `node tests/verify-phase2-recovery.mjs`     |     0     | **PASS** | Kiểm tra crash giữa journal & jobs.json; khôi phục worker bị gián đoạn; chuỗi băm SHA-256 chống giả mạo; acknowledgement tồn tại sau restart; từ chối auto-replay.                          |
|  2  | `node tests/verify-phase2-context.mjs`      |     0     | **PASS** | Xem trước ngữ cảnh read-only bị giới hạn, lọc bí mật, kiểm tra đường dẫn an toàn (chặn traversal/ADS/symlink), không chứng thực kết quả test.                                               |
|  3  | `node tests/verify-phase2-benchmarks.mjs`   |     0     | **PASS** | 9 ca benchmark độ tin cậy ngoại tuyến không dùng API trả phí và không gọi lệnh host shell.                                                                                                  |
|  4  | `node tests/verify-phase3-coordination.mjs` |     0     | **PASS** | Kiểm tra DAG do owner khai báo; chặn cycle/self-ref; chặn downstream khi upstream hỏng; suy giảm quyền của vai trò architect/debugger.                                                      |
|  5  | `node tests/verify-phase3-worktrees.mjs`    |     0     | **PASS** | Vận hành Git worktree thật; kế thừa commit A → B → C; ca A → no-op B → C kế thừa commit; giới hạn 2 worker đồng thời; xung đột cùng file & xung đột file-vs-directory; bảo vệ checkout gốc. |
|  6  | `node tests/verify-phase3-benchmarks.mjs`   |     0     | **PASS** | 9 ca benchmark điều phối/concurrency ngoại tuyến; `modelRequests=0`, `hostCommandExecutions=0`.                                                                                             |
|  7  | `node tests/run-all.mjs --no-skip all`      |     0     | **PASS** | **72/72 test suites đạt PASS**, 0 fail, 0 timeout, 0 skip.                                                                                                                                  |
|  8  | `npm --prefix ui run test:unit`             |     0     | **PASS** | **46/46 UI unit tests đạt PASS**.                                                                                                                                                           |
|  9  | `Test-InstallerPayload.ps1`                 |     0     | **PASS** | **42/42 payload regression tests đạt PASS**.                                                                                                                                                |

---

### **2.2. Nghiệm thu Phase 2: Cơ chế Phục hồi & Nhất quán khi Crash (Crash/Restart & Recovery)**

1. **Phát hiện hỏng hóc & Cách ly (`Quarantine`):**     &#x20;
   - Khi `jobs.json` bị cắt cụt (`{truncated`), Orchestrator khởi động ở chế độ an toàn, thiết lập `recoveryFault: "Unreadable saved coding jobs..."` và khóa toàn bộ việc tạo run mới (`recovery_unresolved`).
2. **Chuẩn hóa trạng thái sau khi sập tiến trình (`Interrupted Normalization`):**     &#x20;
   - Khi Hub khởi động lại sau crash, mọi công việc và worker đang ở trạng thái dở dang (`preparing`, `running`, `testing`, `awaiting_test_grant`) tự động chuyển thành `interrupted`.
   - Tuyệt đối **không tự động chạy lại (no auto-replay)** bất kỳ lệnh model, Git hay test Sandbox nào.
3. **Tính nhất quán giữa Journal và Jobs (`Cross-Check Consistency`):**     &#x20;
   - Khi `jobs.json` ghi nhận sai lệch (`ready_for_review`) nhưng `recovery/` checkpoint ghi nhận `running`, Orchestrator lập tức đánh dấu công việc là `interrupted` với lỗi `"Checkpoint and jobs.json disagree"`, xóa bỏ hoàn toàn kết quả xác thực giả tạo.
4. **Xác nhận phục hồi có chủ đích (`Owner Acknowledgement Persistence`):**     &#x20;
   - Endpoint `POST /api/studio/coding/recovery/acknowledge` yêu cầu xác nhận chính xác chuỗi `REVIEW INTERRUPTED RUN`, đúng `runId` và đúng `integrityDigest` của chuỗi băm SHA-256.
   - Sau khi owner xác nhận, trạng thái chuyển thành `needs_attention`.
   - **Sau khi khởi động lại Hub lần nữa:** Trạng thái `needs_attention` tiếp tục được bảo toàn (`restartedAcknowledged.state().jobs[0].status === 'needs_attention'`), không quay lại `interrupted`, và không tự động tin tưởng các test receipts cũ (`verificationReceiptsTrusted === false`).

---

### **2.3. Nghiệm thu Phase 3: Điều phối Multi-Agent & Git Worktree (DAG, Inheritance & Conflicts)**

1. **Kiểm tra DAG & Ngăn chặn vòng lặp:**     &#x20;
   - Đồ thị tuần hoàn (`A -> B -> A`) bị từ chối fail-closed với mã lỗi `cyclic_coding_dependency`, không tạo bất kỳ nhánh Git nào.
2. **Kế thừa mã nguồn đáng tin cậy (A → B → C):**     &#x20;
   - Các worker thực thi trên các disposable Git worktree riêng biệt (`git worktree add`).
   - Worker B (`middle`) và Worker C (`leaf`) kế thừa chính xác commit SHA đã commit của tiền nhiệm qua trusted `GitRunner`, không thông qua tóm tắt mô hình.
3. **Trường hợp A → no-op B → C:**     &#x20;
   - Worker B (`noop`) không tạo commit riêng (`status: 'no_changes'`, `commitSha: null`).
   - Tuy nhiên, commit của A vẫn được chuyển tiếp chính xác cho Worker C thông qua `inheritedHeadSha` (`chainWorkers[2].inheritedCommits.noop === chainWorkers[1].inheritedHeadSha`). Worker C hoàn thành thành công (`ready_for_review`).
4. **Hai worker độc lập & Giới hạn Concurrency:**     &#x20;
   - Hai worker độc lập `left` và `right` chạy song song với `maxConcurrency: 2`. Đỉnh điểm concurrency thực tế ghi nhận đúng `peakIndependent = 2`.
5. **Chặn đứng Worker hạ nguồn khi Worker thượng nguồn thất bại:**     &#x20;
   - Khi worker `failbase` thất bại, worker phụ thuộc `should-not-run` lập tức bị chuyển thành `blocked` và **không bao giờ được gửi tới `AgentRunner`** (`actions` không chứa `should-not-run`).
6. **Hủy bỏ giữa chừng (`Cancellation`):**     &#x20;
   - Khi nhận tín hiệu hủy bỏ giữa chừng, run chuyển sang `cancelled` và các worker kế tiếp (`aftercancel`) không bao giờ được khởi chạy.
7. **Phát hiện xung đột tệp và thư mục (File-vs-Directory & Same-File Conflict):**     &#x20;
   - **Xung đột cùng tệp:** Hai worker độc lập cùng sửa `shared.js` bị phát hiện xung đột trước khi tạo worktree tích hợp (`worker_file_conflict`).
   - **Xung đột File-vs-Directory:** Worker `flat` tạo `src/feature` dưới dạng tệp tin; Worker `nested` tạo `src/feature/index.js` (dưới dạng thư mục con). Orchestrator phát hiện xung đột cấu trúc Git trước khi tích hợp (`worker_file_conflict`).
   - **Xung đột Unicode & Case-insensitive trên Windows:** Các đường dẫn như `src/App.tsx` vs `src/app.tsx` hoặc `src/café.ts` vs `src/cafe\u0301.ts` đều được chuẩn hóa NFC và so sánh không phân biệt chữ hoa/thường, chặn đứng va chạm trước khi đến Git.
8. **Bảo toàn Workspace gốc:**     &#x20;
   - Trong suốt toàn bộ quá trình tạo, sửa, gộp worktree, kiểm tra SHA của checkout gốc bằng `git rev-parse HEAD` luôn trả về đúng `baseSha` ban đầu. Workspace người dùng hoàn toàn nguyên vẹn.

---

### **2.4. Trạng thái CI GitHub Actions trên Remote**

- **PR #15 (`feat/phase2-reliable-autonomous-development`):**     &#x20;
  - Run ID: `38446773120` (Push) & `38446775910` (PR) -> **9/9 PR + 9/9 Push jobs PASS (100% green)**.
- **PR #16 (`feat/phase3-advanced-multiagent`):**     &#x20;
  - Run ID: `38447281371` (Push) & `38447286949` (PR) -> **9/9 PR + 9/9 Push jobs PASS (100% green)**.

---

## **3. PHÁN QUYẾT CUỐI CÙNG CHO TỪNG PHASE**

### **Phase 2:**

- **Kiểm thử Hợp đồng & Chức năng (Functional & Contract):** **PASS**     &#x20;
  - 100% các ca kiểm thử phục hồi journal, crash consistency, xác nhận acknowledgement bền vững, và xem trước ngữ cảnh commit đều hoạt động chính xác.
- **Nghiệm thu Phát hành (Production Release Gate):** **BLOCKED**     &#x20;
  - Phụ thuộc bắt buộc vào Phase 1 G4 (Trusted Publisher Attestation) và nghiệm thu cài đặt clean-machine.

### **Phase 3:**

- **Kiểm thử Hợp đồng & Chức năng (Functional & Contract):** **PASS**     &#x20;
  - 100% các ca kiểm thử DAG, Git worktree độc lập, kế thừa commit A → no-op B → C, concurrency, cancellation, và phát hiện xung đột cấu trúc tệp/thư mục đều hoạt động chính xác.
- **Nghiệm thu Phát hành (Production Release Gate):** **BLOCKED**     &#x20;
  - Xếp chồng (stacked) trên Phase 2 và Phase 1; tiếp tục bị khóa sản xuất cho đến khi Phase 1 G4 được giải quyết triệt để.