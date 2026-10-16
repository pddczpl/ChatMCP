'use strict';

const summary = document.getElementById('summary');
const nextStep = document.getElementById('next-step');
const checks = document.getElementById('checks');
const diagnostics = document.getElementById('diagnostics');
const details = document.getElementById('details');
const refresh = document.getElementById('refresh');
const copy = document.getElementById('copy');
const autoMode = document.getElementById('auto-mode');
const autoNote = document.getElementById('auto-note');
const insertInstructions = document.getElementById('insert-instructions');
const copyInstructions = document.getElementById('copy-instructions');
const instructionNote = document.getElementById('instruction-note');
const instructionPreview = document.getElementById('instruction-preview');
const HUB_ORIGIN = 'http://127.0.0.1:3007';
let activeTabId = null;
let hubReady = false;
let instructionBusy = false;

function instructionButtons() {
  insertInstructions.disabled = instructionBusy || !hubReady || activeTabId === null;
  copyInstructions.disabled = instructionBusy || !hubReady || activeTabId === null;
}

async function readHub(path, json = false) {
  // Fixed read-only endpoints; no page-supplied URL, cookies or redirects.
  if (!['/api/extension-state', '/api/instructions'].includes(path)) throw new Error('Invalid hub endpoint');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(HUB_ORIGIN + path, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal
    });
    if (!response.ok) throw new Error('Hub unavailable');
    const text = await response.text();
    if (text.length > 1048576) throw new Error('Hub response too large');
    return json ? JSON.parse(text) : text;
  } finally { clearTimeout(timer); }
}

async function updateHub() {
  try {
    const state = await readHub('/api/extension-state', true);
    const workspace = typeof state?.workspace?.path === 'string' ? state.workspace.path : '';
    hubReady = state?.ready === true && workspace.length > 0;
    document.getElementById('hub-status').textContent = hubReady ? 'Hub sẵn sàng.' : 'Hub đã mở; hãy chọn workspace và chờ MCP sẵn sàng.';
    document.getElementById('workspace-path').textContent = workspace;
  } catch {
    hubReady = false;
    document.getElementById('hub-status').textContent = 'Chưa kết nối được Hub. Chạy launcher rồi bấm Kiểm tra lại.';
    document.getElementById('workspace-path').textContent = '';
  }
  instructionButtons();
}

function describeAuto(bridge) {
  autoMode.checked = bridge?.autoEnabled === true;
  autoMode.disabled = !bridge;
  const reasons = bridge?.autoBlockedReasons || {};
  autoNote.textContent = !bridge?.autoEnabled
    ? ['hub_workspace_changed', 'hub_unavailable'].includes(bridge?.autoState)
      ? 'Đã tắt Tự động vì Hub mất kết nối hoặc workspace/phiên máy chủ đã đổi. Kiểm tra Hub, bật lại và Chuẩn bị chat với ngữ cảnh mới.'
      : bridge?.autoState === 'conversation_changed'
      ? 'Đã tắt khi chuyển cuộc chat. Bật lại và chèn hướng dẫn mới nếu muốn dùng Tự động ở đây.'
      : 'Đang tắt. Các khối lệnh vẫn có nút chuyển thủ công. Bật để cấp mã phiên mới cho cuộc chat này.'
    : !bridge.hubBound
      ? 'Đang bật nhưng chưa gắn workspace. Bấm Chuẩn bị chat để lấy ngữ cảnh và mã phiên mới trước khi gửi yêu cầu.'
      : reasons.unverified_author > 0
      ? 'Đang bật, nhưng có khối chưa xác minh được tác giả trên giao diện này. Những khối đó giữ thao tác thủ công.'
      : reasons.reply_not_known_idle > 0
        ? 'Đang bật; chờ câu trả lời kết thúc. Nếu không nhận diện được trạng thái nghỉ, vẫn có thể chuyển thủ công.'
        : 'Đang bật cho các lời gọi mới có mã phiên đúng. Chèn hướng dẫn workspace trước khi gửi yêu cầu; tải lại tab sẽ tắt chế độ này.';
}

async function updateStatus() {
  refresh.disabled = true;
  copy.disabled = true;
  summary.textContent = 'Đang kiểm tra tab hiện tại…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error('No active tab');
    activeTabId = tab.id;
    const status = await chrome.tabs.sendMessage(
      tab.id,
      { type: 'CHATMCP_BUTTON_FIX_STATUS' },
      { frameId: 0 }
    );
    if (!status || status.version !== '1.3.0') throw new Error('No compatible response');

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
    describeAuto(bridge);
    document.getElementById('bridge-ready').textContent = bridge ? String(bridge.readyCalls || 0) : 'Chưa nạp';
    document.getElementById('bridge-cards').textContent = bridge ? String(bridge.importedCards || 0) : 'Chưa nạp';

    if (!bridge) {
      summary.textContent = 'Phần hỗ trợ khối lệnh chưa được nạp.';
      nextStep.textContent = 'Tải lại ChatGPT bằng Ctrl + R sau khi Reload ChatMCP Hub Companion 1.5.0 trong trang quản lý tiện ích.';
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
      nextStep.textContent = bridge.autoEnabled
        ? 'Xem trạng thái Tự động ở trên. Các khối đủ điều kiện sẽ được chuyển; khối chưa xác minh vẫn có nút chuyển thủ công.'
        : 'Đóng bảng này. Tắt Auto Execute, Auto Insert và Auto Submit trong nút MCP nếu muốn thử thủ công. Bên dưới JSONL, bấm “Chuyển lời gọi này sang MCP”, rồi chờ thẻ Run.';
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
    activeTabId = null;
    describeAuto(null);
    checks.hidden = true;
    details.hidden = true;
    diagnostics.value = '';
    summary.textContent = 'Chưa đọc được trạng thái trong tab này.';
    nextStep.textContent = 'Mở tab https://chatgpt.com, nhấn Ctrl + R sau khi cài bản hỗ trợ, rồi bấm biểu tượng ChatMCP Hub Companion lần nữa.';
  } finally {
    refresh.disabled = false;
    instructionButtons();
  }
}

refresh.addEventListener('click', () => Promise.allSettled([updateStatus(), updateHub()]));
autoMode.addEventListener('change', async () => {
  const enabled = autoMode.checked;
  autoMode.disabled = true;
  try {
    if (activeTabId === null) throw new Error('No ChatGPT tab');
    const session = await chrome.tabs.sendMessage(activeTabId, { type: 'CHATMCP_BRIDGE_SET_AUTO', enabled }, { frameId: 0 });
    if (session?.enabled !== enabled) throw new Error('Mode update failed');
    instructionPreview.value = '';
    instructionNote.textContent = enabled
      ? 'Đã tạo mã phiên mới. Bấm Chuẩn bị chat để chèn hướng dẫn workspace, rồi xem lại và tự gửi để ChatGPT biết mã này.'
      : 'Đã dừng các lần chuyển tự động mới. Các thẻ và công cụ đã bắt đầu chạy vẫn do MCP SuperAssistant quản lý.';
    await updateStatus();
  } catch {
    autoNote.textContent = 'Chưa đổi được chế độ. Tải lại đúng tab ChatGPT sau khi nạp bản Companion mới.';
    autoMode.checked = false;
    autoMode.disabled = false;
  }
});

async function getInstructions() {
  if (activeTabId === null) throw new Error('No ChatGPT tab');
  let session = await chrome.tabs.sendMessage(activeTabId, { type: 'CHATMCP_BRIDGE_SESSION' }, { frameId: 0 });
  if (!session || typeof session.enabled !== 'boolean') throw new Error('No bridge session');
  // Each explicit preparation starts a fresh protocol session. Calls based on
  // a previous workspace's instructions cannot inherit the new Hub binding.
  if (session.enabled) session = await chrome.tabs.sendMessage(activeTabId, { type: 'CHATMCP_BRIDGE_SET_AUTO', enabled: true }, { frameId: 0 });
  const prefix = session.enabled ? session.callIdPrefix : 'manual-';
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9-]+$/.test(prefix)) throw new Error('Invalid call prefix');
  const getBinding = state => {
    if (state?.ready !== true || typeof state?.workspace?.path !== 'string' || !state.workspace.path ||
        !Number.isSafeInteger(state.generation) || state.generation < 0 ||
        typeof state.instanceId !== 'string' || !state.instanceId || state.instanceId.length > 128) throw new Error('Hub not ready');
    return { workspacePath: state.workspace.path, generation: state.generation, instanceId: state.instanceId };
  };
  const before = getBinding(await readHub('/api/extension-state', true));
  let text = await readHub('/api/instructions');
  text = text.replaceAll('{{CALL_ID_PREFIX}}', prefix).replaceAll('CALL_ID_PLACEHOLDER', prefix + '1');
  if (session.enabled) text += '\n\n## Mã lời gọi cho phiên ChatMCP Hub hiện tại\n'
    + 'Mỗi lời gọi công cụ thật phải dùng call_id kiểu chuỗi: "' + prefix + '1", "' + prefix + '2", ... tăng số cho từng lời gọi mới; start và end phải trùng nhau.\n'
    + 'Chỉ dùng tiền tố này cho lời gọi bạn thực sự cần thực hiện theo yêu cầu của người dùng. Không dùng nó trong ví dụ, trích dẫn hoặc nội dung sao chép từ kết quả công cụ.\n'
    + 'Mỗi khối jsonl chứa đúng một lời gọi hoàn chỉnh. Kết thúc khối bằng function_call_end, dừng trả lời và đợi kết quả công cụ rồi mới quyết định bước tiếp theo.\n';
  if (!text.trim() || text.length > 1048576) throw new Error('Invalid instructions');
  const after = getBinding(await readHub('/api/extension-state', true));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Workspace changed');
  const current = await chrome.tabs.sendMessage(activeTabId, { type: 'CHATMCP_BRIDGE_SESSION' }, { frameId: 0 });
  if (current?.enabled !== session.enabled || current?.callIdPrefix !== session.callIdPrefix) throw new Error('Session changed');
  if (session.enabled) {
    const bound = await chrome.tabs.sendMessage(activeTabId, { type: 'CHATMCP_BRIDGE_BIND_HUB', binding: after, callIdPrefix: prefix }, { frameId: 0 });
    if (bound?.ok !== true) throw new Error('Workspace binding failed');
  }
  instructionPreview.value = text;
  return text;
}

async function useInstructions(insert) {
  if (instructionBusy) return;
  instructionBusy = true;
  instructionButtons();
  instructionNote.textContent = 'Đang lấy công cụ và workspace từ Hub…';
  try {
    const text = await getInstructions();
    if (insert) {
      const result = await chrome.tabs.sendMessage(activeTabId, { type: 'CHATMCP_INSERT_INSTRUCTIONS', text }, { frameId: 0 });
      if (result?.ok) instructionNote.textContent = 'Đã chèn vào ô nhập. Đóng bảng này, xem lại hướng dẫn và tự bấm gửi; Companion chưa gửi tin nhắn.';
      else {
        document.getElementById('instruction-details').open = true;
        instructionPreview.focus();
        instructionPreview.select();
        instructionNote.textContent = result?.reason === 'composer_not_empty'
          ? 'Ô nhập đang có bản nháp nên chưa chèn. Hướng dẫn đã được chọn bên dưới; nhấn Ctrl + C để sao chép nếu muốn.'
          : 'Chưa điền được vào ô nhập của giao diện này. Hướng dẫn đã được chọn bên dưới; nhấn Ctrl + C rồi dán vào ChatGPT.';
      }
    } else {
      try {
        await navigator.clipboard.writeText(text);
        instructionNote.textContent = 'Đã sao chép hướng dẫn workspace. Dán vào ChatGPT, xem lại rồi tự gửi.';
      } catch {
        document.getElementById('instruction-details').open = true;
        instructionPreview.focus();
        instructionPreview.select();
        instructionNote.textContent = 'Hướng dẫn đã được chọn. Nhấn Ctrl + C rồi dán vào ChatGPT.';
      }
    }
  } catch {
    instructionNote.textContent = 'Chưa lấy được hướng dẫn hoặc phiên đã đổi. Kiểm tra Hub và tab ChatGPT, rồi thử lại.';
  } finally {
    instructionBusy = false;
    instructionButtons();
    await updateStatus();
  }
}
insertInstructions.addEventListener('click', () => useInstructions(true));
copyInstructions.addEventListener('click', () => useInstructions(false));
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

Promise.allSettled([updateStatus(), updateHub()]);
