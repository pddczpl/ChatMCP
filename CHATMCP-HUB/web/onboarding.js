/* ChatMCP Studio — first-run wizard.
 *
 * Four steps that end with a task the person can send: the project folder, the AI connection, what the agent may do
 * without asking, and a first prompt. It is a pure view: everything it shows comes from `ctx` (built by react-app.js),
 * every change goes back through the callbacks in `ctx`, and it renders text only. The connection form itself is the
 * same one Settings uses (ctx.providerForm), so there is exactly one place that knows how to save a key.
 * Loaded after ui-logic.js and before react-app.js. */
'use strict';
(function (root) {
  const STEPS = Object.freeze([
    { id: 'workspace', title: 'Thư mục dự án' },
    { id: 'ai', title: 'Kết nối AI' },
    { id: 'safety', title: 'Quyền của agent' },
    { id: 'ready', title: 'Sẵn sàng' },
  ]);
  const EXAMPLES = Object.freeze([
    ['Tìm hiểu dự án', 'Đọc README và cấu trúc thư mục, cho tôi biết dự án làm gì, cách chạy và cách kiểm thử. Chỉ đọc, không sửa file nào.'],
    ['Chạy kiểm thử', 'Tìm cách chạy bộ kiểm thử của dự án, chạy nó và tóm tắt kết quả thực tế. Không sửa file nào.'],
  ]);

  const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;

  // Keep Tab inside the dialog: the page behind it must not be reachable while it is open.
  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const nodes = Array.from(event.currentTarget.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]:not([tabindex="-1"])'))
      .filter((node) => !node.disabled && node.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  /** Whether the step's own goal is met, so "Tiếp tục" can be offered. */
  function canAdvance(ctx, stepId) {
    const hub = ctx.hub || {};
    if (stepId === 'workspace') return Boolean(hub.workspace && hub.workspace.path);
    if (stepId === 'ai') return ctx.UI.agentMode(hub) === 'api' ? Boolean(hub.ai && hub.ai.configured) : Boolean(hub.browser && hub.browser.paired);
    return true;
  }

  function render(h, ctx) {
    const { UI, Icon, Button, Tag } = ctx;
    const hub = ctx.hub || {};
    const guide = UI.onboarding(hub, { dismissed: false });
    const stepIndex = Math.max(0, STEPS.findIndex((step) => step.id === ctx.step));
    const step = STEPS[stepIndex];
    const doneOf = (entry, index) => {
      const known = guide.steps.find((candidate) => candidate.id === entry.id);
      if (entry.id === 'workspace' || entry.id === 'ai') return Boolean(known && known.done);
      return index < stepIndex;
    };
    const workspacePath = hub.workspace && hub.workspace.path ? hub.workspace.path : '';
    const tools = UI.toolsState(hub);
    const badge = UI.toolCallingBadge(hub.ai);
    const mode = UI.agentMode(hub);

    const panels = {
      workspace: () => h('div', { className: 'onboarding-panel-body' },
        h('h2', null, 'Chọn thư mục dự án'),
        h('p', { className: 'small-note' }, 'Agent chỉ đọc và sửa file trong thư mục này. Hãy chọn thư mục gốc của repository bạn muốn làm việc.'),
        h('label', { className: 'form-field' }, 'Đường dẫn thư mục',
          h('input', { id: 'onboarding-workspace', autoFocus: true, spellCheck: false, value: ctx.workspaceDraft, placeholder: 'F:\\Projects\\my-app', onChange: (e) => ctx.setWorkspaceDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && ctx.workspaceDraft.trim() && !ctx.busy) { e.preventDefault(); ctx.applyWorkspace(); } } })),
        h('div', { className: 'button-row' },
          h(Button, { variant: 'outline', icon: 'folder', disabled: ctx.busy, onClick: () => ctx.browse() }, 'Chọn thư mục…'),
          h(Button, { variant: 'primary', icon: 'check', disabled: ctx.busy || ctx.running || !ctx.workspaceDraft.trim(), onClick: () => ctx.applyWorkspace() }, 'Dùng thư mục này')),
        workspacePath
          ? h('div', { className: 'onboarding-status ok' }, h(Icon, { name: 'check', size: 15 }), h('span', null, 'Đang dùng: ', h('code', null, workspacePath), tools.ready ? ' · công cụ đã sẵn sàng' : tools.starting ? ' · đang khởi động công cụ…' : ''))
          : h('div', { className: 'onboarding-status warn' }, h(Icon, { name: 'warning', size: 15 }), h('span', null, 'Chưa chọn thư mục.')),
        h('p', { className: 'small-note' }, 'File nhạy cảm (.env, khóa riêng, thư mục .git) luôn được bảo vệ khỏi agent, kể cả ở chế độ Tự động.')),
      ai: () => h('div', { className: 'onboarding-panel-body' },
        h('h2', null, mode === 'api' ? 'Kết nối AI' : 'Ghép Companion'),
        mode === 'api'
          ? h('div', null,
            h('p', { className: 'small-note' }, 'Chọn nhà cung cấp và dán API key. ChatMCP chỉ gửi key tới địa chỉ API bạn chọn. Agent cần model hỗ trợ tool calling; "Lưu & kiểm tra" thử đúng điều đó bằng một yêu cầu rất nhỏ, không gửi nội dung dự án.'),
            ctx.providerForm())
          : h('div', null,
            h('p', { className: 'small-note' }, 'Bạn đang ở chế độ ChatGPT Web (cũ, chỉ để thử nghiệm cục bộ): bạn tự đăng nhập trên trình duyệt của mình. Mở Cài đặt để ghép Companion, hoặc chuyển sang chế độ API Gateway ở đó.'),
            h('div', { className: 'onboarding-status ' + (canAdvance(ctx, 'ai') ? 'ok' : 'warn') }, h(Icon, { name: canAdvance(ctx, 'ai') ? 'check' : 'warning', size: 15 }), h('span', null, canAdvance(ctx, 'ai') ? 'Companion đã ghép.' : 'Companion chưa ghép.')))),
      safety: () => h('div', { className: 'onboarding-panel-body' },
        h('h2', null, 'Agent được làm gì mà không hỏi?'),
        h('p', { className: 'small-note' }, 'Bạn quyết định mức tự chủ. Có thể đổi bất cứ lúc nào bằng công tắc cạnh ô nhập yêu cầu.'),
        h('div', { className: 'perm-cards', role: 'group', 'aria-label': 'Chọn quyền của agent' }, UI.PERMISSION_MODES.map((entry) => h('button', {
          type: 'button', key: entry.id, className: 'perm-card' + (ctx.permission === entry.id ? ' active' : ''), 'aria-pressed': ctx.permission === entry.id, disabled: ctx.busy, onClick: () => ctx.setPermission(entry.id),
        }, h('span', { className: 'perm-card-title' }, h('strong', null, entry.label), entry.id === 'review' ? h(Tag, { kind: 'success' }, 'Khuyến nghị') : entry.risk === 'high' ? h(Tag, { kind: 'warn' }, 'Rủi ro cao hơn') : null),
        h('small', null, entry.hint)))),
        h('p', { className: 'small-note' }, 'Ở mọi chế độ, thao tác nguy hiểm vẫn cần bạn duyệt, và bạn luôn thấy đúng lệnh hoặc thay đổi trước khi bấm Cho phép.')),
      ready: () => h('div', { className: 'onboarding-panel-body' },
        h('h2', null, 'Sẵn sàng làm việc'),
        h('div', { className: 'checklist' },
          h('div', { className: 'check-row' }, h(Icon, { name: workspacePath ? 'check' : 'warning', size: 15 }), h('span', null, 'Thư mục: ', workspacePath ? h('code', null, workspacePath) : 'chưa chọn')),
          h('div', { className: 'check-row' }, h(Icon, { name: canAdvance(ctx, 'ai') ? 'check' : 'warning', size: 15 }),
            h('span', null, mode === 'api' ? 'AI: ' + (hub.ai && hub.ai.configured ? text(hub.ai.model, 'đã cấu hình') : 'chưa cấu hình') : 'Companion: ' + (canAdvance(ctx, 'ai') ? 'đã ghép' : 'chưa ghép')),
            mode === 'api' && hub.ai && hub.ai.configured ? h(Tag, { kind: badge.kind, title: badge.note }, badge.label) : null),
          h('div', { className: 'check-row' }, h(Icon, { name: 'shield', size: 15 }), h('span', null, 'Quyền: ', UI.modeInfo(ctx.permission).label))),
        guide.complete ? null : h('div', { className: 'onboarding-status warn' }, h(Icon, { name: 'warning', size: 15 }), h('span', null, 'Còn thiếu bước ở trên. Bạn vẫn có thể đóng hướng dẫn và hoàn tất trong Cài đặt.')),
        badge.status === 'unsupported' ? h('div', { className: 'onboarding-status warn' }, h(Icon, { name: 'warning', size: 15 }), h('span', null, 'Model hiện tại không hỗ trợ tool calling nên agent sẽ không làm việc đáng tin. Hãy chọn model khác.')) : null,
        h('p', { className: 'small-note' }, 'Thử một yêu cầu chỉ đọc trước để làm quen:'),
        h('div', { className: 'onboarding-examples' }, EXAMPLES.map(([title, prompt]) => h('button', { type: 'button', key: title, onClick: () => ctx.useExample(prompt) }, h('strong', null, title), h('span', null, prompt)))),
        h('div', { className: 'button-row' }, h(Button, { variant: 'primary', icon: 'arrow', onClick: () => ctx.close(true) }, 'Bắt đầu dùng'))),
    };

    return h('div', { className: 'onboarding-backdrop', role: 'presentation' },
      h('div', { className: 'onboarding-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Thiết lập ChatMCP', onKeyDown: trapFocus },
        h('div', { className: 'onboarding-head' },
          h('div', null, h('strong', null, 'Chào mừng đến ChatMCP Studio'), h('small', null, 'Bốn bước để agent làm việc trong dự án của bạn.')),
          h('button', { type: 'button', className: 'onboarding-close', 'aria-label': 'Đóng hướng dẫn', title: 'Đóng (Esc). Bạn có thể mở lại trong Cài đặt.', onClick: () => ctx.close(true) }, h(Icon, { name: 'x', size: 17 }))),
        h('div', { className: 'onboarding-body' },
          h('ol', { className: 'onboarding-steps', 'aria-label': 'Các bước' }, STEPS.map((entry, index) => {
            const done = doneOf(entry, index);
            return h('li', { key: entry.id },
              h('button', { type: 'button', className: (entry.id === step.id ? 'current' : '') + (done ? ' done' : ''), 'aria-current': entry.id === step.id ? 'step' : undefined, onClick: () => ctx.setStep(entry.id) },
                h('span', { className: 'onboarding-step-mark' }, done ? h(Icon, { name: 'check', size: 13 }) : String(index + 1)), h('span', null, entry.title)));
          })),
          h('div', { className: 'onboarding-panel' }, panels[step.id]())),
        h('div', { className: 'onboarding-foot' },
          h(Button, { variant: 'quiet', onClick: () => ctx.close(true) }, 'Bỏ qua, thiết lập sau'),
          h('div', { className: 'button-row' },
            stepIndex > 0 ? h(Button, { variant: 'outline', onClick: () => ctx.setStep(STEPS[stepIndex - 1].id) }, 'Quay lại') : null,
            stepIndex < STEPS.length - 1 ? h(Button, { variant: 'primary', disabled: !canAdvance(ctx, step.id), title: canAdvance(ctx, step.id) ? '' : 'Hoàn tất bước này trước', onClick: () => ctx.setStep(STEPS[stepIndex + 1].id) }, 'Tiếp tục') : null))));
  }

  root.ChatMcpOnboarding = Object.freeze({ STEPS, render, canAdvance });
})(typeof window !== 'undefined' ? window : globalThis);
