import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PermissionGate } from '../lib/permissions.mjs';

let passed=0;
const ok=(condition,reason)=>{assert.ok(condition,reason);passed++;};
const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-full-access-'));
const manager={secrets:[],workspace:path.join(root,'repo')};
let pathChecks=0;
const workspace={root:manager.workspace,async resolve(value){pathChecks++;throw Object.assign(new Error('not in selected workspace'),{code:'outside_workspace'});}};
try {
  const gate=new PermissionGate({manager,workspace,directory:root});
  ok(gate.state().executionPolicy==='host-review','review is safe default');
  assert.throws(()=>gate.configure({executionPolicy:'full-access'}),{code:'full_access_confirmation_required'});passed++;
  assert.throws(()=>gate.configure({executionPolicy:'full-access',confirmation:'full access'}),{code:'full_access_confirmation_required'});passed++;
  ok(gate.state().executionPolicy==='host-review','missing confirmation does not mutate state');
  gate.configure({executionPolicy:'full-access',confirmation:'FULL ACCESS'});
  ok(gate.state().executionPolicy==='full-access'&&gate.state().fullAccess,'explicit full access activated');
  let audit=0;gate.onEvent=e=>{if(e.type==='full_access_tool')audit++;};
  const result=await gate.authorize({name:'desktop-commander.start_process',args:{path:'/some/outside/workspace',command:'example'},taskId:'task'});
  ok(result.allowed&&result.category==='execute','shell tool authorized without approval in full access');
  ok(pathChecks===0,'full access does not apply workspace path gate');
  const stopped=new AbortController();stopped.abort(new Error('STOP'));
  await assert.rejects(gate.authorize({name:'desktop-commander.start_process',taskId:'task',signal:stopped.signal}),/STOP/);passed++;
  // Full Access still stops for what cannot be taken back (see tests/verify-full-access-always-ask.mjs).
  const dangerousRun=gate.authorize({name:'desktop-commander.delete_file',args:{file:'/outside'},taskId:'task'});
  for(let i=0;i<200&&gate.state().pending.length===0;i++)await new Promise(resolve=>setTimeout(resolve,10));
  ok(gate.state().pending.length===1&&gate.state().pending[0].category==='dangerous','a destructive tool still asks in Full Access');
  gate.decide(gate.state().pending[0].id,false);
  const dangerous=await dangerousRun;
  ok(!dangerous.allowed&&audit===1,'and runs only when the owner approves it (audited full-access calls: the shell tool only)');
  await gate.writes;
  const reloaded=new PermissionGate({manager,workspace,directory:root});await reloaded.load();
  ok(reloaded.state().fullAccess,'full access is persisted across restart');
  reloaded.configure({executionPolicy:'host-review'});
  ok(reloaded.state().fullAccess===false,'full access can be disabled');
  await assert.rejects(reloaded.authorize({name:'desktop-commander.start_process',args:{path:'/outside'},taskId:'task'}),/not in selected workspace/);passed++;
  ok(pathChecks===1,'host-review restores workspace path checks');
  reloaded.configure({executionPolicy:'sandbox-only'});
  const deny=await reloaded.authorize({name:'desktop-commander.start_process',args:{},taskId:'task'});
  ok(!deny.allowed&&deny.reason.includes('Sandbox-only'),'sandbox-only blocks external MCP');
  await reloaded.writes;
  const last=new PermissionGate({manager,workspace,directory:root});await last.load();
  ok(last.state().executionPolicy==='sandbox-only','safe policy persists after full access disabled');
  console.log(`PASS ${passed} Full Access assertions: explicit opt-in, cross-workspace, shell, audit, persistence, downgrade, sandbox`);
} finally {await fs.rm(root,{force:true,recursive:true});}
