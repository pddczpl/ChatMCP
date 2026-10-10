(() => {
  'use strict';
  const note = document.getElementById('browser-note');
  const code = document.getElementById('browser-pair-code');
  const pair = document.getElementById('browser-pair');
  const reset = document.getElementById('browser-reset');
  const refresh = document.getElementById('browser-refresh');
  async function act(type, extra = {}) {
    pair.disabled = reset.disabled = refresh.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type, ...extra });
      note.textContent = result?.ok ? result.note : result?.reason || 'Chưa liên lạc được với phần chạy extension.';
      if (result?.ok && type === 'CHATMCP_BROWSER_PAIR') code.value = '';
      document.getElementById('browser-paired').textContent = result?.paired ? 'Đã ghép' : 'Chưa ghép';
      reset.hidden = result?.paired !== true;
    } catch { note.textContent = 'Chưa thực hiện được. Kiểm tra Hub rồi bấm Cập nhật.'; }
    finally { pair.disabled = reset.disabled = refresh.disabled = false; }
  }
  pair.addEventListener('click', () => act('CHATMCP_BROWSER_PAIR', { code: code.value }));
  reset.addEventListener('click', () => act('CHATMCP_BROWSER_RESET'));
  refresh.addEventListener('click', () => act('CHATMCP_BROWSER_STATUS'));
  void act('CHATMCP_BROWSER_STATUS');
})();
