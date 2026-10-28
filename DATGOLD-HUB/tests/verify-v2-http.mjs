import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHubServer,UI_BUILD} from '../hub.mjs';
import {VERSION} from '../lib/manager.mjs';
import {StudioWorkspace} from '../lib/studio-workspace.mjs';
import {PermissionGate} from '../lib/permissions.mjs';
import {StudioTerminal} from '../lib/studio-terminal.mjs';
import {CodeIntelligence} from '../lib/studio-intelligence.mjs';
import {previewStatus} from '../lib/studio-preview.mjs';
let n=0;const check=(x,m)=>{assert.ok(x,m);n++};
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-v2.2-http-'));const repo=path.join(temp,'repo');await fs.mkdir(repo);
await fs.writeFile(path.join(repo,'test.py'),'def hello():\n    return 10\n\nvalue = hello()\n');
const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));const origin=`http://127.0.0.1:${port}`;
const manager={workspace:repo,secrets:[],log:()=>{},state:()=>({version:VERSION,workspace:{path:repo},services:{proxy:{state:'ready'},desktop:{state:'ready'},cloud:{state:'ready'},docker:{state:'ready'}}})};
manager.studio=new StudioWorkspace({manager,directory:path.join(temp,'studio')});
manager.permissions=new PermissionGate({manager,workspace:manager.studio,directory:path.join(temp,'policy')});
manager.terminal=new StudioTerminal({workspace:manager.studio});
manager.intelligence=new CodeIntelligence({workspace:manager.studio,directory:path.join(temp,'index')});
manager.preview=previewStatus;
// Detached workers have their own permission gates; status changes must not
// race an active worker or leave it with inherited stale authority.
manager.codingOrchestrator={active:null,integrating:false};
manager.dynamicDelegates={activeRunId:null,state:()=>({activeRunId:null,last:null})};
const agent={state:()=>({activeTaskId:null,active:null,tasks:[]})};
const secret='v2-http-test-secret-0123456789abcdef';const auth={Authorization:`Bearer ${secret}`};
const http=createHubServer(manager,{port,secret,agent,bundleRoot:path.resolve('.')});
await new Promise(r=>http.listen(port,'127.0.0.1',r));
let csrf;async function get(route){const res=await fetch(origin+route,{headers:auth});return {status:res.status,value:await res.json()};}
async function post(route,body={},headers={}){const res=await fetch(origin+route,{method:'POST',headers:{...auth,'Content-Type':'application/json','Origin':origin,'X-ChatMCP-Request':'local-dashboard','X-ChatMCP-CSRF':csrf,'X-ChatMCP-UI-Build':UI_BUILD,...headers},body:JSON.stringify(body)});return {status:res.status,value:await res.json()};}
try{
  let a=await get('/api/health');check(a.value.version===VERSION&&a.value.uiBuild===UI_BUILD,'version handshake');
  a=await get('/api/state');csrf=a.value.csrfToken;check(csrf?.length===64,'csrf exists');
  // The settings page asks what the catalog knows about a model: a file read behind the same bearer as every other call.
  a=await get('/api/ai/model-info?preset=anthropic&model=claude-sonnet-5-5');
  check(a.status===200&&a.value.found===true&&a.value.reasoning.levels.join()==='low,medium,high,xhigh,max'&&a.value.contextWindow===1000000,'HTTP model-info: the catalog answer for a Claude model, with the levels its settings page offers');
  a=await get('/api/ai/model-info?preset=custom-openai&apiBaseUrl=https%3A%2F%2Flitellm.example.com&model=my-alias');
  check(a.status===200&&a.value.found===false&&a.value.reasoning.known===false&&a.value.reasoning.levels.length===3,'HTTP model-info: an alias is not found, and the answer says its levels are a guess');
  a=await get('/api/ai/model-info?preset=anthropic');check(a.status===400&&a.value.code==='invalid_model_info_query','HTTP model-info: a query without a model is refused');
  a=await fetch(origin+'/api/ai/model-info?preset=anthropic&model=claude-sonnet-5-5');check(a.status===401,'HTTP model-info: needs the Hub secret');
  a=await get('/api/studio/intelligence/status');check(a.status===200&&!a.value.indexedAt,'index initially empty');
  a=await post('/api/studio/intelligence/index');
  // On loaded Windows CI hosts, the isolated Python AST worker can fall back
  // when its initial 12-second startup window expires. Retry the actual AST
  // build once (force is essential: a failed first pass is cached as fallback).
  // Do not weaken this check to accept a heuristic-only symbol index.
  if (a.status !== 200 || a.value.symbolCount !== 1 || a.value.parser !== 'python-ast') {
    await new Promise(resolve => setTimeout(resolve, 250));
    a=await post('/api/studio/intelligence/index',{force:true});
  }
  check(a.status===200 && a.value.symbolCount===1 && a.value.parser==='python-ast',
    'HTTP AST index built: HTTP '+a.status+', parser='+a.value.parser+', symbols='+a.value.symbolCount);
  a=await get('/api/studio/intelligence/symbols?query=hello');check(a.status===200&&a.value.matches[0].name==='hello','HTTP symbol search');
  a=await get('/api/studio/intelligence/references?symbol=hello');check(a.status===200&&a.value.matches.some(x=>x.line===4),'HTTP AST references');
  a=await post('/api/studio/intelligence/index',{force:true},{'X-ChatMCP-CSRF':'wrong'});check(a.status===403,'CSRF rejects index mutation');
  a=await post('/api/studio/permissions/config',{executionPolicy:'full-access'});check(a.status===403&&a.value.code==='full_access_confirmation_required','HTTP full access cannot be enabled by mistake');
  a=await post('/api/studio/permissions/config',{executionPolicy:'full-access',confirmation:'FULL ACCESS'}, {'X-ChatMCP-CSRF':'wrong'});check(a.status===403,'HTTP Full Access still requires CSRF');
  a=await post('/api/studio/permissions/config',{executionPolicy:'full-access',confirmation:'FULL ACCESS'});check(a.status===200&&a.value.fullAccess===true,'HTTP full access explicit opt in');
  a=await get('/api/state');check(a.value.studio.permissions.fullAccess===true,'HTTP full access visible in hub state');
  // A page lowers Full Access by saying so in the request that picks the mode, not by guessing from a snapshot of the state.
  a=await post('/api/studio/permissions/config',{mode:'review',leaveFullAccess:true});
  check(a.status===200&&a.value.mode==='review'&&a.value.executionPolicy==='host-review'&&a.value.fullAccess===false,'HTTP leaving Full Access: one request sets the mode and lowers the policy');
  a=await get('/api/state');check(a.value.studio.permissions.fullAccess===false&&a.value.studio.permissions.mode==='review','HTTP hub state shows Full Access left');
  a=await post('/api/studio/permissions/config',{executionPolicy:'full-access',confirmation:'FULL ACCESS'});check(a.status===200&&a.value.fullAccess===true,'HTTP full access turned on again for the checks below');
  manager.codingOrchestrator.active='worktree-run';
  a=await post('/api/studio/permissions/config',{mode:'review',executionPolicy:'host-review'});
  check(a.status===409&&a.value.code==='workers_active','A live coding worker blocks permission changes');
  a=await get('/api/state');
  check(a.value.studio.permissions.fullAccess===true,'Blocked permission update preserves existing Full Access');
  manager.codingOrchestrator.active=null;
  manager.dynamicDelegates.activeRunId='dynamic-run';
  a=await post('/api/studio/permissions/config',{mode:'readonly'});
  check(a.status===409&&a.value.code==='workers_active','Dynamic subagent work prevents permission change');
  manager.dynamicDelegates.activeRunId=null;
  a=await post('/api/studio/permissions/config',{executionPolicy:'sandbox-only'});check(a.status===200&&a.value.executionPolicy==='sandbox-only','HTTP strict execution mode');
  a=await get('/api/state');check(a.value.studio.permissions.executionPolicy==='sandbox-only','HTTP reflects strict mode');
  a=await get('/api/studio/preview?port=65534');check(a.status===200&&a.value.url==='http://127.0.0.1:65534/','local preview only');
  a=await get('/api/studio/preview?port=99999');check(a.status===400,'reject invalid preview ports');
  a=await get('/api/studio/sandbox');check(a.status===200&&typeof a.value.ready==='boolean','sandbox probe shows real Docker status');
  a=await post('/api/studio/terminal/start',{interactive:true,command:'echo SHOULD_BLOCK',timeoutMinutes:1});check(a.status===403,'Sandbox-only rejects host terminal');
  a=await post('/api/studio/file/save',{file:'test.py',content:'test'});check(a.status===403,'Sandbox-only rejects manual file save');
  a=await post('/api/studio/restore',{checkpointId:'invalid',file:'test.py'});check(a.status===403,'Sandbox-only rejects host restore');
  a=await post('/api/studio/accept',{checkpointId:'invalid',file:'test.py'});check(a.status===403,'Sandbox-only rejects host accept');
  a=await post('/api/studio/intelligence/lsp/start',{language:'python'});check(a.status===403,'Sandbox-only rejects host language server process');
  a=await post('/api/studio/permissions/config',{executionPolicy:'host-review'});check(a.status===200,'host review explicit switch');
  a=await post('/api/studio/terminal/start',{interactive:true,command:'echo FIRST_LINE',timeoutMinutes:1});
  check(a.status===200&&a.value.interactive&&a.value.id,'HTTP start interactive shell');const id=a.value.id;
  a=await post('/api/studio/terminal/input',{id,text:'echo SECOND_LINE\n'});check(a.status===200&&a.value.ok,'HTTP send stdin');
  // Windows PowerShell startup is variable (especially Node 22 CI runners).
  // Poll the exact terminal session rather than assert after a fixed 400 ms.
  // This still requires actual stdout containing the submitted second command.
  const deadline = Date.now() + 10000;
  let observed = false;
  let lastTerminal = null;
  while (Date.now() < deadline) {
    a = await get('/api/studio/terminal');
    lastTerminal = a.value.find(session => session.id === id);
    observed = Boolean(lastTerminal?.logs?.some(entry => entry.type === 'stdout' && entry.message.includes('SECOND_LINE')));
    if (observed) break;
    if (lastTerminal && ['failed', 'completed', 'stopped'].includes(lastTerminal.status)) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  check(observed, 'HTTP terminal output' + (observed ? '' : `: status=${lastTerminal?.status || 'missing'} logs=${JSON.stringify(lastTerminal?.logs?.slice(-6) || [])}`));
  a=await post('/api/studio/terminal/stop',{id});check(a.status===200,'HTTP terminal stop');
  a=await get('/api/capabilities');check(a.value.postRoutes.includes('/api/studio/terminal/input')&&a.value.postRoutes.includes('/api/studio/intelligence/index'),'routes advertised');
  console.log(`PASS ${n} v2.2 HTTP integration assertions: code index, strict permissions, preview, sandbox status, interactive terminal, CSRF`);
}finally{await manager.terminal.close();manager.intelligence.close();http.closeAllConnections();await new Promise(r=>http.close(r));await fs.rm(temp,{recursive:true,force:true,maxRetries:20,retryDelay:200}).catch(()=>{});}
