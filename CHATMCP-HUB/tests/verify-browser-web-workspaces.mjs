// Ordinary ChatGPT Web paired-browser transport, bound to a selected
// registered workspace, with no ChatGPT cookies or private API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {HubManager} from '../lib/manager.mjs';
import {assembleStudio} from '../lib/assemble.mjs';
import {WorkspaceRegistry} from '../lib/workspace-registry.mjs';
import {BrowserRunner} from '../lib/browser-runner.mjs';
import {DualAgent} from '../lib/dual-agent.mjs';

const bundleRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-browser-workspaces-'));
const primary=path.join(temp,'A'),other=path.join(temp,'B');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let stage='init';
const mark=(name)=>{stage=name;process.stderr.write('[web-fixture] '+name+' heapMB='+Math.round(process.memoryUsage().heapUsed/1048576)+'\n');};
const heartbeat=setInterval(()=>mark('HEARTBEAT: '+stage),4000);
heartbeat.unref();
const until=async(test,message)=>{for(let i=0;i<100;i++){if(await test())return;await wait(30);}
  throw new Error('Timeout: '+message);
};
const createRepo=async root=>{
  await fs.mkdir(root,{recursive:true});
  execFileSync('git',['init','-b','main'],{cwd:root,stdio:'ignore'});
  execFileSync('git',['config','user.name','CI'],{cwd:root});
  execFileSync('git',['config','user.email','ci@example.invalid'],{cwd:root});
  await fs.writeFile(path.join(root,'README.md'),'# '+path.basename(root)+'\n');
  execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['commit','-m','fixture'],{cwd:root,stdio:'ignore'});
};
let browser;
try{
  mark('create primary');
  await createRepo(primary);
  mark('create secondary');
  await createRepo(other);
  mark('instantiate manager');
  const manager=new HubManager({bundleRoot,dataDirectory:path.join(temp,'hub'),log:()=>{}});
  await manager.load(primary);
  assembleStudio(manager,{bundleRoot});
  await manager.permissions.load();
  manager.permissions.mode='review';
  mark('start primary local tools');
  await manager.startLocal(primary);
  const registered=new WorkspaceRegistry({manager,directory:path.join(temp,'hub')});
  await registered.load();
  await registered.add(other);
  manager.workspaceRegistry=registered;
  mark('browser runner');
  browser=new BrowserRunner({manager,directory:path.join(temp,'browser'),log:()=>{}});
  await browser.load();
  const pairing=await browser.createPairCode();
  const clientId=randomUUID(),extensionId='a'.repeat(32);
  const pair=await browser.pair({code:pairing.code,clientId,extensionId});
  browser.authenticate(pair.token,clientId,'chrome-extension://'+extensionId);
  assert.equal(browser.browserState().paired,true);

  let apiStarted=null;
  const api={manager,state:()=>({activeTaskIds:[],activeTaskId:null,tasks:[],active:null}),
    get:()=>null,start:async payload=>{apiStarted=payload;return {id:randomUUID(),status:'queued'};},
    continue:async()=>{throw new Error('No API continuation expected');},
    shutdown:async()=>{},
  };
  const dual=new DualAgent({browser,api,directory:path.join(temp,'hub'),defaultMode:'api'});
  await dual.configure({mode:'chatgpt-web'});
  const second=await fs.realpath(other),first=await fs.realpath(primary);
  mark('start web task secondary');
  const task=await dual.start({prompt:'Read the README in the currently selected project.',workspacePath:second});
  assert.equal(task.workspace.path,second);
  assert.equal(dual.get(task.id).transport,'chatgpt-web');
  assert.equal(browser.context.executionManager.workspace,second);
  assert.notEqual(browser.context.executionManager,manager);
  assert.equal(manager.workspace,first,'primary project must remain untouched by workspace switch');
  assert.equal(browser.state().activeTaskId,task.id);
  assert.equal(browser.backgroundTasks()[0].workspacePath,second);
  assert.equal(browser.backgroundTasks()[0].conversationId,task.id);
  mark('poll companion');
  const result=await browser.poll({clientId,taskId:task.id,phase:'waiting',note:'Paired'});
  assert.equal(result.message.taskId,task.id);
  assert.ok(result.message.text.includes('WINDOWS WORKSPACE: '+second));
  // Mode selector affects NEW chats only; a running browser task is preserved.
  await dual.configure({mode:'api'});
  const apiTask=await dual.start({prompt:'Independent API task.',workspacePath:first});
  assert.ok(apiTask.id);
  assert.equal(apiStarted.workspacePath,first);
  await assert.rejects(dual.start({prompt:'Should not edit B in parallel.',workspacePath:second}),{statusCode:409});
  const packet=result.message;
  mark('claim companion');
  await browser.claim({clientId,taskId:task.id,messageId:packet.id});
  const url='https://chatgpt.com/c/'+randomUUID();
  mark('sent companion');
  await browser.sent({clientId,taskId:task.id,messageId:packet.id,url});
  const nonce=browser.tasks.get(task.id).nonce;
  mark('reply final');
  await browser.reply({clientId,taskId:task.id,messageId:packet.id,replyId:'reply1',
    url, text:'Finished task',
    blocks:[JSON.stringify({chatmcp_hub:'v1',task:task.id,turn:packet.turn,nonce,
      kind:'final',text:'Read the target README.'})]});
  await until(()=>browser.get(task.id).status==='completed','final web result accepted');
  assert.equal(browser.context,null,'browser manager must be released');
  const summary=browser.backgroundTasks()[0];
  assert.equal(summary.status,'completed');
  assert.equal(summary.transport,'chatgpt-web');
  assert.equal(manager.workspace,first);

  // Follow-up automatically continues the ORIGINAL Web chat even if the
  // global new-conversation mode changed to API in the meantime.
  mark('continue existing web chat');
  const continued=await dual.continue({id:task.id,prompt:'Check it once more.'});
  assert.equal(continued.id,task.id);
  assert.equal(continued.workspace.path,second);
  mark('poll continuation');
  const next=await browser.poll({clientId,taskId:task.id});
  assert.equal(next.message.resumeUrl,url);
  mark('claim companion');
  await browser.claim({clientId,taskId:task.id,messageId:next.message.id});
  mark('sent companion');
  await browser.sent({clientId,taskId:task.id,messageId:next.message.id,url});
  mark('reply final');
  await browser.reply({clientId,taskId:task.id,messageId:next.message.id,replyId:'reply2',
    url,text:'Follow-up finished',
    blocks:[JSON.stringify({chatmcp_hub:'v1',task:task.id,turn:next.message.turn,nonce,
      kind:'final',text:'Follow-up successfully completed.'})]});
  await until(()=>browser.get(task.id).status==='completed','follow-up result');
  assert.equal(browser.backgroundTasks().filter(r=>r.conversationId===task.id).length,2);
  assert.equal(manager.workspace,first);

  mark('detach workspace');
  await registered.remove(other);
  await assert.rejects(dual.continue({id:task.id,prompt:'Detached folder must be refused.'}),
    {code:'unregistered_workspace'});
  assert.ok((await fs.stat(path.join(other,'README.md'))).isFile());
  mark('success');
  console.log('PASS browser-paired Web chat uses selected workspace, independent API jobs, correct transport and safe continuation');
}finally{
  mark('finally: shutdown');
  await browser?.shutdown().catch(()=>{});
  mark('cleanup filesystem');
  await fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:100}).catch(()=>{});
  clearInterval(heartbeat);
}
