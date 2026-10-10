'use strict';

const summary = document.getElementById('summary');
const nextStep = document.getElementById('next-step');
const checks = document.getElementById('checks');
const diagnostics = document.getElementById('diagnostics');
const details = document.getElementById('details');
const refresh = document.getElementById('refresh');
const copy = document.getElementById('copy');

async function updateStatus() {
  refresh.disabled = true;
  copy.disabled = true;
  summary.textContent = 'Đang kiểm tra tab hiện tại…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error('No active tab');
    const status = await chrome.tabs.sendMessage(
      tab.id,
      { type: 'CHATMCP_BUTTON_FIX_STATUS' },
      { frameId: 0 }
    );
    if (!status || status.version !== '1.1.0') throw new Error('No compatible response');

    checks.hidden = false;
    details.hidden = false;
    copy.disabled = false;
    diagnostics.value = JSON.stringify(status, null, 2);
    document.getElementById('anchor-status').textContent = status.observedAnchors > 0 ? 'Đã tìm thấy' : 'Chưa tìm thấy';
    const ambiguous = status.observedAnchors > 1 || status.compatibleAnchors > 1;
    document.getElementById('compat-status').textContent = ambiguous
      ? 'Có nhiều điểm chèn'
      : status.compatibleAnchors > 0 ? 'Đã sẵn sàng' : 'Chưa sẵn sàng';
    document.getElementById('mcp-status').textContent = status.popoverHasButton ? 'Đã có phần tử nút' : 'Chưa có phần tử nút';
    const bridge = status.bridge;
    document.getElementById('bridge-ready').textContent = bridge ? String(bridge.readyCalls || 0) : 'Chưa nạp';
    document.getElementById('bridge-cards').textContent = bridge ? String(bridge.importedCards || 0) : 'Chưa nạp';

    if (!bridge) {
      summary.textContent = 'Phần hỗ trợ khối lệnh chưa được nạp.';
      nextStep.textContent = 'Tải lại ChatGPT bằng Ctrl + R sau khi Reload ChatMCP Button Fix 1.1.0 trong trang quản lý tiện ích.';
    } else if (bridge.importedCards > 0) {
      summary.textContent = 'MCP SuperAssistant đã tạo thẻ từ khối bạn chuyển.';
      nextStep.textContent = 'Đóng bảng này và bấm Run trên thẻ khi Auto Execute đang tắt. Có thẻ chưa có nghĩa là công cụ đã chạy thành công.';
    } else if (bridge.pendingCards > 0) {
      summary.textContent = 'Khối đã được chuyển; MCP SuperAssistant chưa tạo thẻ.';
      nextStep.textContent = 'Bấm Kiểm tra lại sau vài giây. Nếu vẫn chưa có thẻ, bấm Sao chép kiểm tra và gửi kết quả vào cuộc chat.';
    } else if (bridge.detachedImports > 0) {
      summary.textContent = 'Trang đã gỡ một thẻ được chuyển trước đó.';
      nextStep.textContent = 'Tắt ba chế độ Auto, tải lại trang rồi chuyển lại khối để thử bằng Run. Thao tác này không hủy một công cụ đã bắt đầu chạy.';
    } else if (bridge.readyCalls > 0) {
      summary.textContent = 'Đã tìm thấy khối lệnh có thể chuyển sang MCP.';
      nextStep.textContent = 'Đóng bảng này. Tắt Auto Execute, Auto Insert và Auto Submit trong nút MCP. Bên dưới khối JSONL, bấm “Chuyển lời gọi này sang MCP”, rồi chờ thẻ Run.';
    } else if (bridge.blockedReasons?.native_pre > 0) {
      summary.textContent = 'Khối mã đã có pre, nhưng chưa tìm thấy thẻ MCP tương ứng.';
      nextStep.textContent = 'Đây là trường hợp khác với khối mã mới mà bản sửa hỗ trợ. Bấm Sao chép kiểm tra và gửi kết quả vào cuộc chat để xác định bước tiếp theo.';
    } else if (bridge.callCandidates > 0 && bridge.nativeCardsInSources === 0) {
      summary.textContent = 'Có nội dung MCP nhưng chưa có khối lệnh hợp lệ để chuyển.';
      nextStep.textContent = 'Đợi câu trả lời hoàn tất rồi bấm Kiểm tra lại. Nếu vẫn vậy, gửi phần kiểm tra; nội dung lời gọi không nằm trong báo cáo này.';
    } else if (ambiguous) {
      summary.textContent = 'Trang có nhiều điểm chèn, cần xác định ô chat đang dùng.';
      nextStep.textContent = 'Gửi phần kiểm tra để xác định vị trí phù hợp; số lượng phần tử hiện có chưa chứng minh nút nằm đúng ô nhập.';
    } else if (status.popoverHasButton && status.popoverButtonHasSize) {
      summary.textContent = 'MCP SuperAssistant đã tạo nút trên trang.';
      nextStep.textContent = 'Đóng bảng này và xem cạnh dấu + trong ô chat. Việc thực thi công cụ cần được kiểm tra bằng một lời gọi thật.';
    } else if (status.popoverContainers > 0) {
      summary.textContent = 'Tiện ích đã tạo chỗ chứa, nút chưa hiển thị đầy đủ.';
      nextStep.textContent = 'Bấm Kiểm tra lại. Nếu trạng thái vẫn vậy, gửi phần kiểm tra để xem tiếp bước hiển thị của MCP SuperAssistant.';
    } else if (status.compatibleAnchors > 0) {
      summary.textContent = 'Điểm chèn đã sẵn sàng; MCP SuperAssistant chưa tạo nút.';
      nextStep.textContent = status.inspectedAdapterUrlMatch
        ? 'Kiểm tra MCP SuperAssistant đang bật, tải lại trang rồi mở bảng này. Nếu vẫn chưa có nút, gửi phần kiểm tra.'
        : 'URL hiện tại nằm ngoài các dạng mà bản mã MCP SuperAssistant đã kiểm tra nhận diện. Gửi phần kiểm tra để xử lý tiếp bước kích hoạt tiện ích.';
    } else {
      summary.textContent = 'Chưa tìm thấy điểm chèn phù hợp.';
      nextStep.textContent = 'Đợi ô nhập ChatGPT hiện xong rồi bấm Kiểm tra lại. Nếu vẫn chưa có, gửi phần kiểm tra.';
    }
  } catch {
    checks.hidden = true;
    details.hidden = true;
    diagnostics.value = '';
    summary.textContent = 'Chưa đọc được trạng thái trong tab này.';
    nextStep.textContent = 'Mở tab https://chatgpt.com, nhấn Ctrl + R sau khi cài bản hỗ trợ, rồi bấm biểu tượng ChatMCP Button Fix lần nữa.';
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener('click', updateStatus);
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagnostics.value);
    nextStep.textContent = 'Đã sao chép phần kiểm tra. Bạn có thể dán vào cuộc chat.';
  } catch {
    details.open = true;
    diagnostics.focus();
    diagnostics.select();
    nextStep.textContent = 'Nội dung đã được chọn. Nhấn Ctrl + C để sao chép.';
  }
});

updateStatus();
