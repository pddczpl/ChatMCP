import path from 'node:path';
import { readJson, writeJson } from './runtime.mjs';

const ACTIVE = new Set(['preparing','queued','running']);
const BAD_MODE = () => Object.assign(new Error('Chế độ phải là chatgpt-web hoặc api.'), { statusCode: 400 });

/** A single task surface backed by either the original browser runner or API runner. */
export class DualAgent {
  constructor({ browser, api, directory, defaultMode = 'chatgpt-web' }) {
    if (!['chatgpt-web', 'api'].includes(defaultMode)) throw BAD_MODE();
    this.browser = browser;
    this.api = api;
    this.file = path.join(directory, 'agent-mode.json');
    this.mode = defaultMode;
  }
  async load() {
    const data = await readJson(this.file);
    if (['chatgpt-web','api'].includes(data?.mode)) this.mode = data.mode;
  }
  state() {
    const web = this.browser.state(), api = this.api.state();
    const active = web.active || api.active || null;
    const tasks = [...web.tasks.map(x=>({ ...x, transport:'chatgpt-web' })), ...api.tasks.map(x=>({ ...x, transport:'api' }))].sort((a,b)=> String(b.updatedAt ?? b.startedAt).localeCompare(String(a.updatedAt ?? a.startedAt)));
    return { mode: this.mode, activeTaskId: active?.id || null,
      activeTaskIds: [...(web.activeTaskId ? [web.activeTaskId] : []), ...(api.activeTaskIds || (api.activeTaskId ? [api.activeTaskId] : []))],
      active: active ? { ...active, transport: web.active?.id === active.id ? 'chatgpt-web' : 'api' } : null, tasks };
  }
  get(id) {
    const browser = this.browser.get(id);
    if (browser) return { ...browser, transport:'chatgpt-web' };
    const api = this.api.get(id);
    return api ? { ...api, transport:'api' } : null;
  }
  async report(id) { return this.browser.get(id) ? this.browser.report(id) : this.api.report(id); }
  async configure({ mode }) {
    if (!['chatgpt-web', 'api'].includes(mode)) throw BAD_MODE();
    if (this.state().activeTaskId) throw Object.assign(new Error('Không đổi chế độ khi agent đang chạy.'), { statusCode:409 });
    await writeJson(this.file, { version: 1, mode });
    this.mode = mode;
    return this.state();
  }
  // Web Companion executes one task at a time. Its manager is selected from
  // the same registered per-workspace managers used for coding agents; this
  // keeps Studio tools, the Git runner, approvals and OS execution registry
  // consistently bound to the requested project without mutating the main Hub.
  async #ensureBrowserWorkspace(requestedPath) {
    const primary = this.api.manager || this.browser.manager;
    const registry = primary?.workspaceRegistry;
    const selected = requestedPath || registry?.state()?.activePath || primary?.workspace;
    if (!selected) throw Object.assign(new Error(
      'Hãy chọn workspace trước khi giao việc cho ChatGPT Web.'
    ),{statusCode:409,code:'workspace_missing'});
    let root=selected;
    if (registry) root=(await registry.resolve(selected)).path;
    else if(root!==primary?.workspace)throw Object.assign(new Error(
      'Workspace chưa được đăng ký trong ChatMCP.'
    ),{statusCode:403,code:'unregistered_workspace'});
    if (this.state().activeTaskIds.length || primary.busy || primary.taskId ||
        primary.codingOrchestrator?.active || primary.codingOrchestrator?.integrating ||
        primary.dynamicDelegates?.activeRunId) {
      throw Object.assign(new Error(
        'Không thể bắt đầu ChatGPT Web khi còn agent hoặc coding worker đang sử dụng Hub. Đợi/dừng tác vụ trước hoặc tiếp tục bằng API mode.'
      ),{statusCode:409,code:'browser_workspace_busy'});
    }
    const targetManager=root===primary.workspace?primary
      : typeof this.api.browserWorkspaceManager==='function'
        ? await this.api.browserWorkspaceManager(root)
        : null;
    if (!targetManager || targetManager.workspace!==root)
      throw Object.assign(new Error(
        'Workspace chưa được chuẩn bị độc lập cho Browser Companion; không chuyển công cụ sang sai thư mục.'
      ),{statusCode:503,code:'browser_workspace_unavailable'});
    // The paired extension belongs to BrowserRunner, not to a particular
    // project manager. Rebind only when the Web runner has no active task.
    this.browser.manager=targetManager;
    return root;
  }
  async start(payload) {
    if (this.mode === 'api') {
      if (this.browser.state().activeTaskId) throw Object.assign(new Error('Chờ browser agent dừng trước khi bắt đầu coding.'), { statusCode:409 });
      return this.api.start(payload);
    }
    if (this.state().activeTaskIds.length) throw Object.assign(new Error(
      'ChatGPT Web chỉ chạy một tác vụ qua Browser Companion tại một thời điểm. Dừng/đợi tác vụ hiện tại, hoặc dùng API mode để chạy đồng thời.'
    ), { statusCode:409 });
    if (payload?.attachments?.length) throw Object.assign(new Error(
      'ChatGPT Web Companion hiện chỉ chuyển nội dung văn bản. Dùng API mode để đính kèm ảnh/tệp trực tiếp.'
    ),{statusCode:415,code:'browser_attachments_unsupported'});
    await this.#ensureBrowserWorkspace(payload?.workspacePath);
    return this.browser.start(payload);
  }
  async continue(payload) {
    if (this.mode === 'chatgpt-web' && this.state().activeTaskId) throw Object.assign(new Error('Browser agent đang chạy.'),{statusCode:409});
    const existing = this.get(payload?.id);
    if (!existing) throw Object.assign(new Error('Không tìm thấy hội thoại cũ. Không tự tạo phiên mới.'),{statusCode:404});
    if (existing.transport !== this.mode) throw Object.assign(new Error('Hội thoại này thuộc chế độ '+existing.transport+'. Hãy chọn đúng chế độ để tiếp tục.'),{statusCode:409});
    if (existing.transport==='chatgpt-web') {
      if(payload?.attachments?.length)throw Object.assign(new Error(
        'Browser Companion chưa hỗ trợ đính kèm ảnh/tệp. Hãy dùng API mode.'
      ),{statusCode:415,code:'browser_attachments_unsupported'});
      const root=existing.workspacePath||existing.workspace?.path;
      await this.#ensureBrowserWorkspace(root);
    }
    return this.mode === 'api' ? this.api.continue(payload) : this.browser.continue(payload);
  }
  async setAutoResume({ id, enabled } = {}) {
    if (this.browser.get(id)) return this.browser.setAutoResume(id, enabled);
    if (this.api.get(id)) return this.api.setAutoResume(id, enabled);
    throw Object.assign(new Error('Không tìm thấy phiên hội thoại.'),{statusCode:404});
  }
  async delete(id) {
    if (this.state().activeTaskIds.includes(id)) throw Object.assign(new Error('Dừng phiên đang chạy trước khi xóa.'),{statusCode:409});
    if (this.browser.get(id)) return this.browser.delete(id);
    if (this.api.get(id)) return this.api.delete(id);
    throw Object.assign(new Error('Không tìm thấy hội thoại.'),{statusCode:404});
  }
  async cancel(id) { return this.browser.get(id) ? this.browser.cancel(id) : this.api.cancel(id); }
  async shutdown() {
    // Browser tasks may own an isolated manager cached by the API coordinator.
    // Stop the BrowserRunner and close its MCP session before shutting down the
    // managers used by concurrently capable API agents.
    await this.browser.shutdown().catch(()=>{});
    await this.api.shutdown();
  }
}
