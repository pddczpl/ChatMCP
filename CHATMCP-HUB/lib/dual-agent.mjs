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
    this.handoffFile = path.join(directory, 'transport-handoffs.json');
    this.handoffs = new Map();
    this.mode = defaultMode;
  }
  async load() {
    const data = await readJson(this.file);
    if (['chatgpt-web','api'].includes(data?.mode)) this.mode = data.mode;
    const saved=await readJson(this.handoffFile).catch(()=>null);
    for(const item of Array.isArray(saved?.links)?saved.links.slice(-500):[]){
      if(typeof item?.fromTaskId==='string'&&typeof item?.toTaskId==='string'&&
         ['api','chatgpt-web'].includes(item?.toTransport))
        this.handoffs.set(item.toTaskId,item);
    }
  }
  async saveHandoffs(){
    await writeJson(this.handoffFile,{version:1,links:[...this.handoffs.values()].slice(-500)});
  }
  lineage(id){
    const tasks=[...this.browser.state().tasks,...this.api.state().tasks];
    const actual=tasks.find(t=>t.id===id);
    const root=actual?.conversationId||this.handoffs.get(id)?.conversationId||id;
    return {conversationId:root,segments:tasks.filter(t=>t.id===id||t.conversationId===root),
      linkedFromTaskId:this.handoffs.get(id)?.fromTaskId||actual?.linkedFromTaskId||null};
  }
  buildHandoff(existing,prompt){
    // Deliberately omit raw tool output, credentials, images and hidden model
    // reasoning. This context transfer is not evidence of a successful edit.
    const dialogue=Array.isArray(existing.dialogue)?existing.dialogue.slice(-8)
      .filter(x=>['user','assistant'].includes(x.role))
      .map(x=>(x.role+': '+String(x.text||'').slice(0,200))):[];
    const prompts=Array.isArray(existing.prompts)?existing.prompts.slice(-4).map(x=>String(x.text||'').slice(0,150)):[];
    const text=[
      'Previous conversation task '+existing.id+' ('+existing.transport+').',
      'User requests: '+prompts.join(' | '),
      'Recent dialogue (untrusted): '+dialogue.join(' | '),
      'Last reported answer (unverified): '+String(existing.finalText||'').slice(0,350),
      'Previous task status: '+String(existing.status||'unknown')+'.',
      'The ChatGPT Web tab and the API backend have distinct model histories. Reinspect the original workspace before editing.',
    ].join('\n');
    const secrets=this.api.manager?.secrets||[];
    let cleaned=text;
    for(const secret of secrets)if(typeof secret==='string'&&secret.length>=4)
      cleaned=cleaned.split(secret).join('[REDACTED]');
    return cleaned.slice(0,1400);
  }
  state() {
    const web = this.browser.state(), api = this.api.state();
    const active = web.active || api.active || null;
    const tasks = [...(web.tasks||[]).map(x=>({ ...x, transport:'chatgpt-web' })),
      ...(api.tasks||[]).map(x=>({ ...x, transport:'api' }))].map(t=>{
        const link=this.handoffs.get(t.id);
        return {...t,conversationId:link?.conversationId||t.conversationId||t.id,
          linkedFromTaskId:link?.fromTaskId||t.linkedFromTaskId||null};
      }).sort((a,b)=> String(b.updatedAt ?? b.startedAt).localeCompare(String(a.updatedAt ?? a.startedAt)));
    return { mode: this.mode, activeTaskId: active?.id || null,
      activeTaskIds: [...(web.activeTaskId ? [web.activeTaskId] : []), ...(api.activeTaskIds || (api.activeTaskId ? [api.activeTaskId] : []))],
      active: active ? { ...active, transport: web.active?.id === active.id ? 'chatgpt-web' : 'api' } : null, tasks };
  }
  get(id) {
    const browser = this.browser.get(id);
    if (browser) return { ...browser,workspacePath:browser.workspace?.path,
      conversationId:this.handoffs.get(id)?.conversationId||browser.conversationId||browser.id,
      linkedFromTaskId:this.handoffs.get(id)?.fromTaskId||browser.linkedFromTaskId||null,transport:'chatgpt-web' };
    const api = this.api.get(id);
    return api ? { ...api,transport:'api',
      conversationId:this.handoffs.get(id)?.conversationId||api.conversationId||api.id,
      linkedFromTaskId:this.handoffs.get(id)?.fromTaskId||api.linkedFromTaskId||null } : null;
  }
  async report(id) { return this.browser.get(id) ? this.browser.report(id) : this.api.report(id); }
  async configure({ mode }) {
    if (!['chatgpt-web', 'api'].includes(mode)) throw BAD_MODE();
    // The selected transport applies to the NEXT user instruction, including
    // an existing conversation. In-flight tool calls continue in their
    // original runner and cannot be silently transferred mid-operation.
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
    if(payload?.attachments?.length)
      throw Object.assign(new Error('Chế độ ChatGPT Web Companion hiện hỗ trợ prompt văn bản; không tự bỏ qua file/ảnh đính kèm. Hãy chuyển sang Model API để phân tích ảnh/file.'),{statusCode:415});
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
    const root=existing.workspacePath||existing.workspace?.path;
    if(this.api.manager?.workspaceRegistry&&root)await this.api.manager.workspaceRegistry.resolve(root);
    const physicalRunning=this.state().activeTaskIds.includes(existing.id);
    if(existing.transport!==this.mode){
      if(physicalRunning)
        throw Object.assign(new Error('Tác vụ cũ còn chạy. Hãy dừng/chờ hoàn thành trước khi chuyển backend cho lượt tiếp theo.'),{statusCode:409,code:'transport_switch_busy'});
      if(this.mode==='chatgpt-web'&&payload?.attachments?.length)
        throw Object.assign(new Error('ChatGPT Web Companion chỉ hỗ trợ văn bản. Chuyển sang Model API nếu cần đính kèm ảnh/file.'),{statusCode:415});
      const switched=await this.start({
        prompt:payload.prompt,attachments:payload.attachments||[],workspacePath:root,
        conversationId:existing.conversationId||existing.id,
        linkedFromTaskId:existing.id,
        handoffText:this.buildHandoff(existing,payload.prompt),
      });
      const link={fromTaskId:existing.id,toTaskId:switched.id,
        conversationId:existing.conversationId||existing.id,
        workspacePath:root,fromTransport:existing.transport,toTransport:this.mode,
        createdAt:new Date().toISOString()};
      this.handoffs.set(switched.id,link);
      await this.saveHandoffs();
      return {...switched,conversationId:link.conversationId,
        linkedFromTaskId:existing.id,
        transport:this.mode,
        handoff:{fromTaskId:existing.id,toTransport:this.mode,
          note:'Đã tạo lượt mới ở kênh được chọn. Ngữ cảnh cũ được chuyển ở dạng bản tóm tắt; lịch sử/model của hai kênh không tự đồng bộ.'}};
    }
    if(existing.transport==='api'){
      if(this.browser.state().active?.workspace?.path===root)
        throw Object.assign(new Error('ChatGPT Web đang sử dụng checkout này.'),{statusCode:409});
      return this.api.continue(payload);
    }
    if(payload?.attachments?.length)
      throw Object.assign(new Error('ChatGPT Web Companion hiện không truyền tệp/ảnh. Chọn Model API.'),{statusCode:415});
    if(this.browser.state().activeTaskId&&this.browser.state().activeTaskId!==payload.id)
      throw Object.assign(new Error('Đã có một ChatGPT Web task khác đang chạy.'),{statusCode:409});
    if((this.api.state().activeTaskIds||[]).some(id=>{
      const task=this.api.get(id);return task?.workspace?.path===root&&!task?.worktree;
    }))throw Object.assign(new Error('API agent đang sử dụng checkout này.'),{statusCode:409});
    return this.browser.continue(payload);
  }
  async setAutoResume({ id, enabled } = {}) {
    if (this.browser.get(id)) return this.browser.setAutoResume(id, enabled);
    if (this.api.get(id)) return this.api.setAutoResume(id, enabled);
    throw Object.assign(new Error('Không tìm thấy phiên hội thoại.'),{statusCode:404});
  }
  async delete(id) {
    const existing=this.get(id);
    if(!existing)throw Object.assign(new Error('Không tìm thấy hội thoại.'),{statusCode:404});
    const root=existing.conversationId||id;
    const tasks=this.state().tasks.filter(t=>t.conversationId===root&&!t.parentTaskId);
    if(tasks.some(t=>this.state().activeTaskIds.includes(t.id)))
      throw Object.assign(new Error('Dừng tất cả các lượt đang chạy trước khi xóa hội thoại.'),{statusCode:409});
    const results=[];
    for(const entry of [...tasks].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))){
      results.push(entry.transport==='chatgpt-web'
        ? await this.browser.delete(entry.id):await this.api.delete(entry.id));
      this.handoffs.delete(entry.id);
    }
    await this.saveHandoffs();
    return {ok:true,deletedId:id,deletedIds:tasks.map(t=>t.id),results};
  }
  async cancel(id) { return this.browser.get(id) ? this.browser.cancel(id) : this.api.cancel(id); }
  async shutdown() { await Promise.allSettled([this.api.shutdown(), this.browser.shutdown()]); }
}
