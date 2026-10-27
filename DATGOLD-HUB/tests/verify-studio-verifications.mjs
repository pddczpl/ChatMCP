import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { StudioTerminal } from '../lib/studio-terminal.mjs';
import { StudioVerification } from '../lib/studio-verification.mjs';
import { createHubServer, assertCompatibleRunningHub, UI_BUILD } from '../hub.mjs';
import { VERSION } from '../lib/manager.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-verify-'));
// Deliberately free of quote characters: Windows PowerShell 5.1 and POSIX shells parse embedded
// double quotes differently, and this suite checks the evidence workflow, not shell quoting.
const suggested='node -p 1';
const workspace={requireRoot:()=>root,resolve:async()=>({root}),checks:async()=>({suggested:[{from:'mock-tests.json',command:suggested}]})};
const terminal=new StudioTerminal({workspace});
const extraTerminals=[];
const newTerminal=()=>{const t=new StudioTerminal({workspace});extraTerminals.push(t);return t;};
const verifications=new StudioVerification({workspace,terminal,directory:path.join(root,'evidence')});
let n=0;const ok=(x,label)=>{assert.ok(x,label);n++;};
let server;
try{
  ok(assertCompatibleRunningHub({app:'chatmcp-local-hub',version:VERSION,uiBuild:UI_BUILD}), 'matching running Hub accepted');
  assert.throws(()=>assertCompatibleRunningHub({app:'chatmcp-local-hub',version:'2.0.0'},3007),/STOP-CHATMCP-HUB/);n++;
  assert.throws(()=>assertCompatibleRunningHub({app:'malicious-app',version:VERSION,uiBuild:UI_BUILD}),/ứng dụng khác/);n++;
  await assert.rejects(verifications.start({command:'rm -rf .'}),{statusCode:403});n++;
  const run=await verifications.start({command:suggested});ok(run.terminalId&&run.status==='running','persisted run created');
  for(let i=0;i<150&&terminal.state()[0]?.status==='running';i++)await new Promise(r=>setTimeout(r,35));
  const first=await verifications.list();ok(first.total===1&&first.runs[0].status==='completed'&&first.runs[0].exitCode===0,'success recorded');
  const reloaded=new StudioVerification({workspace,terminal:newTerminal(),directory:path.join(root,'evidence')});
  const history=await reloaded.list();ok(history.runs[0].exitCode===0&&history.runs[0].command===suggested,'survives restart');
  await assert.rejects(reloaded.list({taskId:'oops'}));n++;
  const fakeTask='123e4567-e89b-42d3-a456-426614174000';
  const pending=await reloaded.start({command:suggested,taskId:fakeTask});
  // A subsequent Hub restart has no evidence of the live process outcome;
  // must record interrupted and must NOT repeat the command.
  const third=new StudioVerification({workspace,terminal:newTerminal(),directory:path.join(root,'evidence')});
  const unfinished=await third.list({taskId:fakeTask});ok(unfinished.runs.length===1&&unfinished.runs[0].status==='interrupted','restart leaves unconfirmed status');
  await terminal.close();
  // Real HTTP routes for the new test evidence API.
  const bind=net.createServer();await new Promise(r=>bind.listen(0,'127.0.0.1',r));const port=bind.address().port;await new Promise(r=>bind.close(r));
  const origin=`http://127.0.0.1:${port}`;
  const stub={workspace:root,secrets:[],log:()=>{},catalog:{ready:false,tools:[],counts:{}},state:()=>({version:VERSION,workspace:{path:root},services:{docker:{state:'ready'},cloud:{state:'ready'},proxy:{state:'ready'},desktop:{state:'ready'}}})};
  stub.studio=workspace;stub.verification=third;
  stub.permissions={state:()=>({mode:'review'}),configure:()=>{},decide:()=>{}};
  stub.terminal=third.terminal;stub.delegates={state:()=>null};stub.workflow={state:()=>({steps:[]})};
  const engine={state:()=>({activeTaskId:null,tasks:[]})};
  const secret='studio-verifications-test-secret-0123456789abcdef';const auth={Authorization:`Bearer ${secret}`};
  server=createHubServer(stub,{port,secret,agent:engine,bundleRoot:path.resolve(import.meta.dirname,'..')});
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const st=await fetch(origin+'/api/state',{headers:auth}).then(r=>r.json());
  const headers={...auth,Origin:origin,'Content-Type':'application/json','X-ChatMCP-Request':'local-dashboard','X-ChatMCP-CSRF':st.csrfToken,'X-ChatMCP-UI-Build':UI_BUILD};
  const post=(p,data)=>fetch(origin+p,{method:'POST',headers,body:JSON.stringify(data)});
  let response=await post('/api/studio/verify/run',{command:'echo arbitrary'});ok(response.status===403,'arbitrary check blocked');
  response=await post('/api/studio/verify/run',{command:suggested});ok(response.ok,'allowed check accepted by HTTP');
  const opened=await response.json();ok(opened.terminalId,'HTTP returns a terminal process ID');
  response=await fetch(origin+'/api/studio/verifications',{headers:auth});const body=await response.json();ok(response.ok&&body.runs.length>=2,'HTTP read evidence');
  response=await post('/api/agent/mode/',{mode:'api'});ok(response.status!==404,'trailing slash normalized, route reached');
  response=await post('/api/unknown-action',{});const x=await response.json();ok(response.status===404&&x.code==='unknown_action'&&x.serverVersion===VERSION,'action mismatch diagnostic');
  const old={...headers,'X-ChatMCP-UI-Build':'2.0.0-old'};
  response=await fetch(origin+'/api/tasks/delete',{method:'POST',headers:old,body:'{}'});const bad=await response.json();ok(response.status===409&&bad.code==='ui_backend_version_mismatch','old UI rejected with clear error');
  console.log(`PASS: ${n} checks for real test evidence, restart, route errors, stale daemon`);
}finally{await Promise.all([terminal,...extraTerminals].map((t)=>t.close()));server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
