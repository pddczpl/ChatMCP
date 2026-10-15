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
  async start(payload) {
    if (this.mode === 'api') {
      if (this.browser.state().activeTaskId) throw Object.assign(new Error('Chờ browser agent dừng trước khi bắt đầu coding.'), { statusCode:409 });
      return this.api.start(payload);
    }
    if (this.state().activeTaskId) throw Object.assign(new Error('Browser agent đang sử dụng workspace.'), { statusCode:409 });
    return this.browser.start(payload);
  }
  async continue(payload) {
    if (this.mode === 'chatgpt-web' && this.state().activeTaskId) throw Object.assign(new Error('Browser agent đang chạy.'),{statusCode:409});
    const existing = this.get(payload?.id);
    if (!existing) throw Object.assign(new Error('Không tìm thấy hội thoại cũ. Không tự tạo phiên mới.'),{statusCode:404});
    if (existing.transport !== this.mode) throw Object.assign(new Error('Hội thoại này thuộc chế độ '+existing.transport+'. Hãy chọn đúng chế độ để tiếp tục.'),{statusCode:409});
    return this.mode === 'api' ? this.api.continue(payload) : this.browser.continue(payload);
  }
  async setAutoResume({ id, enabled } = {}) {
    if (this.browser.get(id)) return this.browser.setAutoResume(id, enabled);
    if (this.api.get(id)) return this.api.setAutoResume(id, enabled);
    throw Object.assign(new Error('Không tìm thấy phiên hội thoại.'),{statusCode:404});
  }
  async delete(id) {
    if (this.state().activeTaskId === id) throw Object.assign(new Error('Dừng phiên đang chạy trước khi xóa.'),{statusCode:409});
    if (this.browser.get(id)) return this.browser.delete(id);
    if (this.api.get(id)) return this.api.delete(id);
    throw Object.assign(new Error('Không tìm thấy hội thoại.'),{statusCode:404});
  }
  async cancel(id) { return this.browser.get(id) ? this.browser.cancel(id) : this.api.cancel(id); }
  async shutdown() { await Promise.allSettled([this.api.shutdown(), this.browser.shutdown()]); }
}
