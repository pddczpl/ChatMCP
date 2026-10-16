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
    if (browser) return { ...browser,workspacePath:browser.workspace?.path,conversationId:browser.id,transport:'chatgpt-web' };
    const api = this.api.get(id);
    return api ? { ...api, transport:'api' } : null;
  }
  async report(id) { return this.browser.get(id) ? this.browser.report(id) : this.api.report(id); }
  async configure({ mode }) {
    if (!['chatgpt-web', 'api'].includes(mode)) throw BAD_MODE();
    // Mode selects transport for NEW chats; existing running tasks retain
    // their own runner and may continue independently.
    await writeJson(this.file, { version: 1, mode });
    this.mode = mode;
    return this.state();
  }
  async start(payload) {
    const registry=this.api.manager?.workspaceRegistry;
    const selected=registry
      ? (await registry.resolve(payload?.workspacePath)).path
      : this.api.manager?.workspace;
    if(!selected)throw Object.assign(new Error('Chọn workspace trước khi giao task.'),{statusCode:409});
    if(this.mode==='api'){
      const active=this.browser.state().active;
      if(active?.workspace?.path===selected)
        throw Object.assign(new Error('ChatGPT Web đang sử dụng checkout này. Chọn workspace khác hoặc đợi browser task hoàn tất.'),{statusCode:409});
      return this.api.start({...payload,workspacePath:selected});
    }
    if(this.browser.state().activeTaskId)
      throw Object.assign(new Error('ChatGPT Web Companion đang xử lý một task khác. Dừng hoặc chờ task này trước khi giao tác vụ web mới.'),{statusCode:409});
    const apiWorkers=this.api.state().activeTaskIds||[];
    if(apiWorkers.some(id=>{
      const task=this.api.get(id);
      return (task?.workspace?.path===selected)&&!task?.worktree;
    }))throw Object.assign(new Error('Một API agent đang ghi trực tiếp vào workspace này. Chờ agent hoàn tất hoặc chọn workspace khác.'),{statusCode:409});
    return this.browser.start({...payload,workspacePath:selected});
  }
  async continue(payload) {
    const existing=this.get(payload?.id);
    if(!existing)throw Object.assign(new Error('Không tìm thấy cuộc hội thoại cũ.'),{statusCode:404});
    // Continue each chat with its ORIGINAL transport, even when the global
    // selector has since changed for new conversations.
    if(existing.transport==='api'){
      if(this.browser.state().active?.workspace?.path===
        (existing.workspacePath||existing.workspace?.path))
        throw Object.assign(new Error('ChatGPT Web đang sử dụng checkout này.'),{statusCode:409});
      return this.api.continue(payload);
    }
    if(this.browser.state().activeTaskId && this.browser.state().activeTaskId!==payload.id)
      throw Object.assign(new Error('Đã có một ChatGPT Web task khác đang chạy.'),{statusCode:409});
    const root=existing.workspacePath||existing.workspace?.path;
    if(this.api.manager?.workspaceRegistry&&root)await this.api.manager.workspaceRegistry.resolve(root);
    if((this.api.state().activeTaskIds||[]).some(id=>{
      const task=this.api.get(id);return task?.workspace?.path===root&&!task?.worktree;
    }))throw Object.assign(new Error('API agent đang sử dụng checkout này. Chờ hoặc chọn workspace khác.'),{statusCode:409});
    return this.browser.continue(payload);
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
  async shutdown() { await Promise.allSettled([this.api.shutdown(), this.browser.shutdown()]); }
}
