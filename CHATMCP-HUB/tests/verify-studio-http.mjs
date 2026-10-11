import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHubServer } from '../hub.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { PermissionGate } from '../lib/permissions.mjs';
import { StudioTerminal } from '../lib/studio-terminal.mjs';
import { StudioWorkflow } from '../lib/studio-workflow.mjs';
import { StudioDelegates } from '../lib/studio-delegates.mjs';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-v2-http-'));
const dir=path.join(temp,'repo');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'main.py'),'def hello():\n    return 123\n');
const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
const origin=`http://127.0.0.1:${port}`;const taskId='123e4567-e89b-42d3-a456-426614174000';
const manager={workspace:dir,secrets:[],catalog:{ready:true,tools:[]},log:()=>{},state:()=>({version:'2.0.0',workspace:{path:dir},services:{docker:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'},desktop:{state:'ready'}}})};
manager.studio=new StudioWorkspace({manager,directory:path.join(temp,'state')});
manager.permissions=new PermissionGate({manager,workspace:manager.studio,directory:path.join(temp,'policy')});
manager.terminal=new StudioTerminal({workspace:manager.studio});
manager.workflow=new StudioWorkflow({directory:path.join(temp,'workflow')});
manager.delegates=new StudioDelegates({workspace:manager.studio,provider:{ready:()=>false},directory:path.join(temp,'delegates')});
const browser={browserState:()=>({paired:false})};
const engine={state:()=>({activeTaskId:null,active:null,tasks:[]}),get:()=>null,setAutoResume:async({id,enabled})=>({id,autoResume:enabled})};
const server=createHubServer(manager,{port,agent:engine,browser,bundleRoot:path.resolve(import.meta.dirname,'..')});await new Promise(r=>server.listen(port,'127.0.0.1',r));
let n=0;const ok=x=>{assert.ok(x);n++;};
async function get(url){const r=await fetch(origin+url);return [r,await r.json().catch(()=>null)];}
let csrf;
async function post(url,payload,override=null){const r=await fetch(origin+url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-ChatMCP-Request':'local-dashboard','X-ChatMCP-CSRF':override??csrf},body:JSON.stringify(payload)});return [r,await r.json().catch(()=>null)];}
try{
  const [s,st]=await get('/api/state');ok(s.ok&&st.studio.permissions.mode==='review');csrf=st.csrfToken;
  let [r,v]=await get('/api/studio/tree');ok(r.ok&&v.entries.length===1);
  [r,v]=await get('/api/studio/file?file=main.py');ok(r.ok&&v.content.includes('hello'));
  [r,v]=await get('/api/studio/file?file=../bad');ok(r.status===403);
  [r,v]=await get('/api/studio/search?query=hello&mode=symbol');ok(r.ok&&v.matches.length===1);
  [r,v]=await post('/api/studio/permissions/config',{mode:'autonomous'},'wrong');ok(r.status===403);
  [r,v]=await post('/api/studio/permissions/config',{mode:'autonomous'});ok(r.ok&&v.mode==='autonomous');
  [r,v]=await post('/api/studio/checkpoint',{label:'baseline'});const id=v.id;ok(r.ok&&v.fileCount===1);
  [r,v]=await get('/api/studio/checkpoints');ok(r.ok&&v.some(x=>x.id===id));
  await fs.writeFile(path.join(dir,'main.py'),'def hello():\n    return 456\n');
  [r,v]=await get(`/api/studio/review?checkpointId=${encodeURIComponent(id)}`);const change=v.changes[0];ok(r.ok&&change.currentSha&&change.diff.includes('456'));
  [r,v]=await post('/api/studio/accept',{checkpointId:id,file:'main.py',expectedSha:change.currentSha});ok(r.ok);
  [r,v]=await post('/api/studio/restore',{checkpointId:id,file:'main.py',expectedSha:change.currentSha});ok(r.ok&&(await fs.readFile(path.join(dir,'main.py'),'utf8')).includes('123'));
  [r,v]=await post('/api/studio/terminal/start',{command:'echo HTTP-ok',timeoutMinutes:1});ok(r.ok&&v.id);
  let sawTermLog=false;
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));[r,v]=await get('/api/studio/terminal');if(r.ok&&v[0]?.logs?.some(x=>x.message.includes('HTTP-ok'))){sawTermLog=true;break;}}
  ok(sawTermLog);
  [r,v]=await post('/api/studio/plan/set',{taskId,title:'Roadmap',items:[{text:'Verify',status:'done',evidence:''}]});ok(r.ok&&v.items.length===1);
  [r,v]=await get('/api/studio/plan?taskId='+taskId);ok(r.ok&&v.title==='Roadmap');
  [r,v]=await post('/api/tasks/auto-resume',{id:taskId,enabled:true});ok(r.ok&&v.task.id===taskId&&v.task.autoResume);
  [r,v]=await post('/api/tasks/auto-resume',{id:taskId,enabled:false},'wrong');ok(r.status===403);
  [r,v]=await get('/api/studio/checks');ok(r.ok);
  [r,v]=await get('/api/studio/delegates');ok(r.ok);
  [r,v]=await get('/api/studio/workflow?taskId='+taskId);ok(r.ok&&v.steps.length===0);
  const html=await fetch(origin+'/').then(r=>r.text());ok(html.includes('id="root"')&&html.includes('react-app.js'));
  const script=await fetch(origin+'/react-app.js').then(r=>r.text());ok(script.includes('/api/studio/permissions/decide')&&script.includes('/api/studio/restore'));
  const css=await fetch(origin+'/react.css').then(r=>r.text());ok(css.includes('.studio-columns'));
  console.log(`PASS: ${n} Studio 2.0 HTTP checks (CSRF, path security, review, Git rollback, terminal, plan, UI assets)`);
}finally{await manager.terminal.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true,maxRetries:20,retryDelay:200}).catch(()=>{});}
