// Login page of public mode. It is a separate script because the site's Content-Security-Policy allows no inline code.
(() => {
  const form = document.getElementById('login');
  const input = document.getElementById('token');
  const button = document.getElementById('submit');
  const message = document.getElementById('message');
  let busy = false;

  const show = (text) => { message.textContent = text; };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const token = input.value;
    if (!token) { show('Nhập token chủ sở hữu.'); input.focus(); return; }
    busy = true;
    button.disabled = true;
    show('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        input.value = '';
        location.replace('/');
        return;
      }
      if (response.status === 429) show(data.error || 'Thử sai quá nhiều lần. Chờ một lúc rồi thử lại.');
      else if (response.status === 401) show('Token không đúng.');
      else show(data.error || `Máy chủ trả lỗi ${response.status}.`);
      input.select();
    } catch {
      show('Không liên lạc được máy chủ. Dịch vụ free có thể đang thức dậy (khoảng một phút); thử lại sau.');
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
})();
