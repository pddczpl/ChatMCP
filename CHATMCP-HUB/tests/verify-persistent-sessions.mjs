import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BrowserRunner } from '../lib/browser-runner.mjs';
import { AgentRunner } from '../lib/agent.mjs';
import { DualAgent } from '../lib/dual-agent.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-sessions-'));
const workspace='F:\\Personal_Project\\Sample';
const chatUrl='https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b';
const clientId='3c2f9c78-436d-4b2e-bd8d-2e803d8695cf';
const nonceFrom = (msg)=>msg.nonce;
let held=null, count=0, generation=2;
const manager={secrets:[],instanceId:'hub-test',
  state(){return {instanceId:'hub-test',generation,workspace:{path:workspace}}},
  acquireTask(id){if(held) return false;held=id;return true},
  releaseTask(id){if(held===id)held=null},
  async createAgentSession(){return {catalog:{tools:[{name:'desktop-commander.list_directory',description:'read-only',server:'desktop-commander'}],servers:{}},async close(){}}}
};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function acceptFinal(runner,task,text){
  const v=await runner.poll({clientId});
  assert.equal(v.message.taskId,task.id);
  const m=v.message;
  await runner.claim({clientId,taskId:task.id,messageId:m.id});
  await runner.sent({clientId,taskId:task.id,messageId:m.id,url:chatUrl});
  const blocks=[JSON.stringify({chatmcp_hub:'v1',task:task.id,turn:m.turn,nonce:nonceFrom(m),kind:'final',text})];
  await runner.reply({clientId,taskId:task.id,messageId:m.id,replyId:'reply-'+m.turn,text:blocks[0],blocks,url:chatUrl,initialRouteBinding:m.turn===1});
  for(let i=0;i<100;i++) {if(runner.get(task.id).status==='completed')break;await wait(5)}
  assert.equal(runner.get(task.id).status,'completed');
  return m;
}
try{
  const browserDir=path.join(root,'browser');
  const b=new BrowserRunner({manager,directory:browserDir});
  b.client={clientId,extensionId:'a'.repeat(32),tokenHash:'f'.repeat(64)};
  const task=await b.start({prompt:'Đọc README, không sửa.'});
  assert.equal((await b.poll({clientId})).message.turn,1);
  await acceptFinal(b,task,'README đã đọc.');
  const resumed=await b.continue({id:task.id,prompt:'Tiếp tục phân tích các file chưa hoàn thành.'});
  assert.equal(resumed.id,task.id,'MUST retain same conversation/task ID');
  assert.equal(resumed.chatUrl,chatUrl);
  assert.equal(resumed.prompts.length,2);
  assert.equal(resumed.runs.length,2);
  const msg=(await b.poll({clientId})).message;
  assert.equal(msg.turn,2);
  assert.equal(msg.resumeUrl,chatUrl,'must carry verified original chat URL to browser Companion');
  assert.equal(msg.resumeStart,true,'first resumed packet alone can reattach into existing chat');
  assert.match(msg.text,/CONTINUE THE EXISTING CHAT/);
  assert.match(msg.text,/CURRENT_TURN=2/);
  await acceptFinal(b,task,'Đã rà soát tiếp, không thay đổi file.');
  assert.equal(b.get(task.id).toolCalls,0);
  assert.equal(b.get(task.id).steps,2,'AI response count should NOT count tool protocol packets twice');
  assert.equal(b.get(task.id).lastIssuedTurn,2);
  assert.equal(b.get(task.id).prompts.length,2);
  assert.match(await fs.readFile(path.join(browserDir,'tasks',task.id,'task.json'),'utf8'),/Tiếp tục phân tích/);
  assert.match(await b.report(task.id),/Đọc README/);
  assert.match(await b.report(task.id),/Tiếp tục phân tích/);
  await b.setAutoResume(task.id,true);
  assert.equal(b.get(task.id).autoResume,true);
  await b.context?.finishing; // old process fully released its workspace lock
  const bReload=new BrowserRunner({manager,directory:browserDir});
  await bReload.load();bReload.client=b.client;
  assert.equal(bReload.get(task.id).status,'completed');
  assert.equal(bReload.get(task.id).autoResume,true,'Web auto-resume preference must survive restart');
  await bReload.setAutoResume(task.id,false);
  const afterRestart=await bReload.continue({id:task.id,prompt:'Hoàn thành phần kiểm thử còn thiếu.'});
  assert.equal(afterRestart.id,task.id);
  const msg3=(await bReload.poll({clientId})).message;
  assert.equal(msg3.turn,3);
  assert.equal(msg3.resumeUrl,chatUrl);
  assert.equal(msg3.resumeStart,true);
  await bReload.cancel(task.id);
  assert.equal(bReload.get(task.id).status,'cancelled');
  assert.equal((await bReload.continue({id:task.id,prompt:'Tiếp tục sau khi tôi bấm dừng.'})).id,task.id);
  assert.equal((await bReload.poll({clientId})).message.turn,4);
  await bReload.cancel(task.id);
  const removed=await bReload.delete(task.id);
  assert.equal(removed.remoteChatUnchanged,true);
  assert.equal(bReload.get(task.id),null);
  assert.equal(await fs.stat(path.join(browserDir,'tasks',task.id)).then(()=>true,()=>false),false);
  console.log('PASS Web conversation: same ID/URL, four distinct user follow-ups, persisted after restart, manual stop/continue, explicit local deletion');

  // A lost Companion must not strand Retry / Continue at queued indefinitely.
  // Only an UNSENT packet may time out; it must remain safe to retry in the same chat.
  const stalledBrowser = new BrowserRunner({manager,directory:path.join(root,'unclaimed-browser'),queueTimeoutMs:1200});
  stalledBrowser.client=b.client;
  const browserFirst=await stalledBrowser.start({prompt:'Thử lại cùng cuộc chat sau lỗi.'});
  await acceptFinal(stalledBrowser,browserFirst,'Đã kiểm tra lượt đầu.');
  await stalledBrowser.continue({id:browserFirst.id,prompt:'Tiếp tục, nhưng Companion đang tắt.'});
  assert.equal(stalledBrowser.get(browserFirst.id).status,'queued');
  for(let i=0;i<110 && stalledBrowser.get(browserFirst.id).status==='queued';i++)await wait(20);
  assert.equal(stalledBrowser.get(browserFirst.id).status,'failed','unsent continuation must not wait forever');
  assert.equal(stalledBrowser.get(browserFirst.id).errorCode,'browser_queue_timeout');
  assert.equal(held,null,'timeout must release the workspace lock');
  const afterTimeout=await stalledBrowser.continue({id:browserFirst.id,prompt:'Tiếp tục sau khi Companion hoạt động lại.'});
  assert.equal(afterTimeout.id,browserFirst.id,'retry preserves the durable conversation ID');
  await acceptFinal(stalledBrowser,browserFirst,'Đã tiếp tục thành công.');
  assert.equal(stalledBrowser.get(browserFirst.id).prompts.length,3);
  assert.equal(stalledBrowser.get(browserFirst.id).runs.length,3);
  await stalledBrowser.delete(browserFirst.id);
  console.log('PASS Web queue watchdog: unclaimed retry becomes actionable failure and can continue in same chat');

  // A crash after SENDING must not erase evidence, claim that no send occurred,
  // or force a fresh ChatGPT conversation on follow-up.
  const risky=new BrowserRunner({manager,directory:path.join(root,'crashed')});risky.client=b.client;
  const opened=await risky.start({prompt:'Bắt đầu kiểm tra.'});
  const first=(await risky.poll({clientId})).message;
  await risky.claim({clientId,taskId:opened.id,messageId:first.id});
  await risky.sent({clientId,taskId:opened.id,messageId:first.id,url:chatUrl});
  // An older Hub release persisted message.turn but had no lastIssuedTurn.
  const legacyFile=path.join(root,'crashed','tasks',opened.id,'task.json');
  const legacy=JSON.parse(await fs.readFile(legacyFile,'utf8'));delete legacy.lastIssuedTurn;
  await fs.writeFile(legacyFile,JSON.stringify(legacy));
  const restarted=new BrowserRunner({manager,directory:path.join(root,'crashed')});
  // Simulate power loss. This fixture does not call shutdown/cancel on the old object.
  held=null;await restarted.load();restarted.client=b.client;
  assert.equal(restarted.get(opened.id).status,'paused');
  assert.equal(restarted.get(opened.id).unverifiedDelivery.turn,1);
  assert.equal(restarted.get(opened.id).lastIssuedTurn,1,'legacy lastIssuedTurn must be reconstructed before pending message is cleared');
  const next=await restarted.continue({id:opened.id,prompt:'Kiểm tra trạng thái thực tế rồi tiếp tục.'});
  assert.equal(next.id,opened.id);
  assert.equal((await restarted.poll({clientId})).message.turn,2);
  await restarted.cancel(opened.id);
  console.log('PASS crash recovery: paused checkpoint, remembers uncertain delivery, never allocates a replacement chat');

  let messages=[];let calls=0;
  const provider={
    snapshot(){return {model:'mock-gemini',provider:'gateway-gemini'}},ready(){return true},
    async respond(payload){messages.push(structuredClone(payload.input));calls++;return {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:`Đã xong đoạn ${calls}`}]}],usage:{input_tokens:5,output_tokens:5}}}
  };
  const aDir=path.join(root,'api');const a=new AgentRunner({manager,provider,taskDirectory:aDir});await a.load();
  const firstRun=await a.start({prompt:'Đọc project đầu tiên',maxSteps:5,maxMinutes:1});
  for(let i=0;i<200;i++) {if(a.get(firstRun.id).status==='completed')break;await wait(5)}
  assert.equal(a.get(firstRun.id).status,'completed');
  assert.equal(a.get(firstRun.id).steps,1);
  const second=await a.continue({id:firstRun.id,prompt:'Tiếp tục xử lý TODO còn thiếu',maxSteps:5,maxMinutes:1});
  assert.equal(second.id,firstRun.id);
  for(let i=0;i<200;i++) {if(a.get(firstRun.id).status==='completed')break;await wait(5)}
  assert.equal(a.get(firstRun.id).status,'completed');
  assert.equal(a.get(firstRun.id).steps,2);
  assert.equal(a.get(firstRun.id).prompts.length,2);
  assert.equal(a.get(firstRun.id).runs.length,2);
  assert.match(JSON.stringify(messages[1]),/Đọc project đầu tiên/);
  assert.match(JSON.stringify(messages[1]),/Tiếp tục xử lý TODO còn thiếu/);
  assert.match(JSON.stringify(messages[1]),/Đã xong đoạn 1/);
  await a.setAutoResume(firstRun.id,true);
  assert.equal(a.get(firstRun.id).autoResume,true);
  await a.context?.done.promise; // simulate the old Hub completely stopped before a new process starts
  const reloaded=new AgentRunner({manager,provider,taskDirectory:aDir});await reloaded.load();
  assert.equal(reloaded.get(firstRun.id).prompts.length,2);
  assert.equal(reloaded.get(firstRun.id).autoResume,true,'API auto-resume preference must survive restart');
  await reloaded.setAutoResume(firstRun.id,false);
  const third=await reloaded.continue({id:firstRun.id,prompt:'Kiểm tra kết quả một lần nữa',maxSteps:5,maxMinutes:1});
  assert.equal(third.id,firstRun.id);
  for(let i=0;i<200;i++) {if(reloaded.get(firstRun.id).status==='completed')break;await wait(5)}
  assert.equal(reloaded.get(firstRun.id).steps,3);
  assert.equal(reloaded.get(firstRun.id).runs.length,3);
  assert.equal(reloaded.get(firstRun.id).dialogue.filter(m=>m.role==='assistant').length,3);
  assert.match(await reloaded.report(firstRun.id),/Kiểm tra kết quả một lần nữa/);
  await reloaded.delete(firstRun.id);
  console.log('PASS API conversation: durable same ID, user/agent dialogue and checkpoint context reused after restart, no MCP replay');

  // Stalled local tool/session initialization previously held queued indefinitely
  // when no optional task time limit was configured. It must fail and unlock,
  // without claiming any model/tool request was sent.
  const realSessionFactory=manager.createAgentSession;
  manager.createAgentSession=()=>new Promise(()=>{});
  const stalledApi=new AgentRunner({manager,provider,taskDirectory:path.join(root,'queued-api'),preflightTimeoutMs:120});
  await stalledApi.load();
  await assert.rejects(
    stalledApi.start({prompt:'Khởi tạo phiên công cụ bị treo.'}),
    error=>error.code==='preflight_timeout',
    'queued preflight must terminate with a distinct error code');
  const failedId=stalledApi.state().tasks[0].id;
  assert.equal(stalledApi.get(failedId).state,'failed');
  assert.equal(stalledApi.get(failedId).errorCode,'preflight_timeout');
  assert.equal(stalledApi.get(failedId).usage.httpRequests,0,'preflight timeout must not spend model requests');
  assert.equal(held,null,'preflight failure must release the workspace lock');
  manager.createAgentSession=realSessionFactory;
  const retry=await stalledApi.continue({id:failedId,prompt:'Tiếp tục sau khi công cụ khôi phục.'});
  assert.equal(retry.id,failedId);
  for(let i=0;i<150 && stalledApi.get(failedId).status==='running';i++)await wait(10);
  assert.equal(stalledApi.get(failedId).status,'completed','continuation after stalled preflight must succeed');
  assert.equal(stalledApi.get(failedId).runs.length,2);
  await stalledApi.delete(failedId);
  console.log('PASS API preflight watchdog: queued timeout releases lock, retains history and retries in same task');
}finally{await fs.rm(root,{recursive:true,force:true});}
