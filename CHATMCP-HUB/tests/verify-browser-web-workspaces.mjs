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
// Canonical paired companion, not the obsolete repository-root "Button Fix".
// Keep the packaged extension manifest self-contained on Chrome and Edge.
const companionRoot=path.join(bundleRoot,'extension');
const companionManifest=JSON.parse(await fs.readFile(path.join(companionRoot,'manifest.json'),'utf8'));
assert.equal(companionManifest.manifest_version,3);
assert.equal(companionManifest.name,'ChatMCP Hub Companion');
assert.ok(/^\d+\.\d+\.\d+$/.test(companionManifest.version));
assert.deepEqual(companionManifest.host_permissions.slice().sort(),
  ['http://127.0.0.1:3007/*','https://chatgpt.com/*'].sort());
const companionFiles=[
  companionManifest.background.service_worker,companionManifest.action.default_popup,
  ...companionManifest.content_scripts.flatMap(item=>[...item.js,...(item.css||[])]),
  'browser-background.js','browser-popup.js','popup.js','popup.css','INSTALL-EXTENSION.txt',
];
for(const filename of companionFiles){
  assert.match(filename,/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  assert.ok((await fs.stat(path.join(companionRoot,filename))).isFile(),
    'Missing browser extension runtime source: '+filename);
}

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-browser-workspaces-'));
const primary=path.join(temp,'A'),other=path.join(temp,'B');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
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
  await createRepo(primary);
  await createRepo(other);
  const manager=new HubManager({bundleRoot,dataDirectory:path.join(temp,'hub'),log:()=>{}});
  await manager.load(primary);
  assembleStudio(manager,{bundleRoot});
  await manager.permissions.load();
  manager.permissions.mode='review';
  await manager.startLocal(primary);
  const registered=new WorkspaceRegistry({manager,directory:path.join(temp,'hub')});
  await registered.load();
  await registered.add(other);
  manager.workspaceRegistry=registered;
  browser=new BrowserRunner({manager,directory:path.join(temp,'browser'),log:()=>{}});
  await browser.load();
  const pairing=await browser.createPairCode();
  const clientId=randomUUID(),extensionId='a'.repeat(32);
  const pair=await browser.pair({code:pairing.code,clientId,extensionId});
  browser.authenticate(pair.token,clientId,'chrome-extension://'+extensionId);
  assert.equal(browser.browserState().paired,true);

  let apiStarted=null;
  const apiRecords=new Map();
  const api={manager,state:()=>({activeTaskIds:[],activeTaskId:null,tasks:[...apiRecords.values()],active:null}),
    get:id=>apiRecords.get(id)||null,
    start:async payload=>{
      apiStarted=payload;
      const result={id:randomUUID(),prompt:payload.prompt,conversationId:payload.conversationId||null,
        linkedFromTaskId:payload.linkedFromTaskId||null,
        workspace:{path:payload.workspacePath},status:'completed',createdAt:new Date().toISOString()};
      apiRecords.set(result.id,result);
      return result;
    },
    continue:async payload=>({id:payload.id,status:'completed',prompt:payload.prompt}),
    delete:async id=>{apiRecords.delete(id);return {ok:true,deletedId:id};},
    shutdown:async()=>{},
  };
  const dual=new DualAgent({browser,api,directory:path.join(temp,'hub'),defaultMode:'api'});
  await dual.configure({mode:'chatgpt-web'});
  const second=await fs.realpath(other),first=await fs.realpath(primary);
  const task=await dual.start({prompt:'Read the README in the currently selected project.',workspacePath:second});
  assert.equal(task.workspace.path,second);
  assert.equal(dual.get(task.id).transport,'chatgpt-web');
  assert.equal(browser.context.executionManager.workspace,second);
  assert.notEqual(browser.context.executionManager,manager);
  assert.equal(manager.workspace,first,'primary project must remain untouched by workspace switch');
  assert.equal(browser.state().activeTaskId,task.id);
  assert.equal(browser.backgroundTasks()[0].workspacePath,second);
  assert.equal(browser.backgroundTasks()[0].conversationId,task.id);
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
  await browser.claim({clientId,taskId:task.id,messageId:packet.id});
  const url='https://chatgpt.com/c/'+randomUUID();
  await browser.sent({clientId,taskId:task.id,messageId:packet.id,url});
  const nonce=browser.tasks.get(task.id).nonce;
  await browser.reply({clientId,taskId:task.id,messageId:packet.id,replyId:'reply1',
    url, text:'Finished task',
    blocks:[JSON.stringify({chatmcp_hub:'v1',task:task.id,turn:packet.turn,nonce,
      kind:'final',text:'Read the target README.'})]});
  // finish() sets status before it has persisted the transcript and closed
  // the dedicated task manager. Wait for its real ownership release first;
  // polling publicTask while the async writer is still settling is not proof
  // that the browser conversation is ready for continuation.
  await until(()=>browser.context===null,'final reply persisted and task owner released');
  assert.equal(browser.get(task.id).status,'completed','final web result accepted');
  assert.equal(browser.context,null,'browser manager must be released');
  const summary=browser.backgroundTasks()[0];
  assert.equal(summary.status,'completed');
  assert.equal(summary.transport,'chatgpt-web');
  assert.equal(manager.workspace,first);

  // A mode switch applies to the NEXT instruction, including this existing
  // Web chat. API receives a new linked physical task, not a Web continuation.
  const continued=await dual.continue({id:task.id,prompt:'Check it once more using the API.'});
  assert.notEqual(continued.id,task.id);
  assert.equal(continued.transport,'api');
  assert.equal(continued.conversationId,task.id);
  assert.equal(continued.linkedFromTaskId,task.id);
  assert.equal(apiStarted.workspacePath,second);
  assert.equal(apiStarted.conversationId,task.id);
  assert.equal(apiStarted.linkedFromTaskId,task.id);
  // The handoff carries the user's requests twice: inside the text the model reads, and apart from it, so that the API worker selects its skills and tool
  // schemas on them (as it does on the earlier prompts of a conversation) and not on the Hub's own sentences around them.
  assert.deepEqual(apiStarted.handoffRequests,['Read the README in the currently selected project.'],'the handoff carries the user\'s requests apart from the Hub\'s text');
  assert.ok(apiStarted.handoffText.startsWith('Previous conversation task '+task.id+' (chatgpt-web).\nUser requests: Read the README in the currently selected project.\nRecent dialogue (untrusted): '),
    'and the text the model reads is written as before');
  assert.ok(apiStarted.handoffText.endsWith('\nThe ChatGPT Web tab and the API backend have distinct model histories. Reinspect the original workspace before editing.'),'ending with the Hub\'s own sentence');
  assert.equal(browser.backgroundTasks().filter(r=>r.conversationId===task.id).length,1);
  assert.equal(manager.workspace,first);

  // Switching back creates a NEW ChatGPT Web task with the same logical ChatMCP
  // conversation ID, but cannot impersonate/reuse an API model session or
  // arbitrarily attach to the earlier ChatGPT thread.
  await dual.configure({mode:'chatgpt-web'});
  // Only the API worker has anything to select: the Web chat is handed the text, and nothing else is new.
  const startWeb=browser.start.bind(browser);
  let webStarted=null;
  browser.start=async payload=>{webStarted=payload;return startWeb(payload);};
  const back=await dual.continue({id:continued.id,prompt:'Switch back to ChatGPT Web.'});
  delete browser.start;
  assert.ok(webStarted.handoffText.startsWith('Previous conversation task '+continued.id+' (api).')&&!('handoffRequests' in webStarted),'switching back hands the Web chat the text alone');
  assert.equal(back.transport,'chatgpt-web');
  assert.notEqual(back.id,task.id);
  assert.equal(back.conversationId,task.id);
  assert.equal(back.linkedFromTaskId,continued.id);
  assert.equal(browser.get(back.id).chatUrl,null);
  await browser.cancel(back.id);
  // URL missing after the first send is recoverable ONLY from an explicitly
  // paired extension proving task/nonce on a canonical official chat URL.
  const recovery=browser.requestUrlRecovery({id:back.id});
  assert.equal(recovery.pending,true);
  const checkpoint=await browser.poll({clientId,taskId:back.id});
  assert.equal(checkpoint.recovery.taskId,back.id);
  const childNonce=browser.tasks.get(back.id).nonce;
  await assert.rejects(browser.recoverUrl({clientId,taskId:back.id,nonce:'f'.repeat(48),
    url,proof:'user_task_nonce'}),{code:'url_recovery_identity'});
  await assert.rejects(browser.recoverUrl({clientId,taskId:back.id,nonce:childNonce,
    url:'https://chatgpt.com/c/local-chatgpt%3A'+randomUUID(),
    proof:'user_task_nonce'}),{code:'url_recovery_provisional'});
  const accepted=await browser.recoverUrl({clientId,taskId:back.id,nonce:childNonce,
    url:'https://chatgpt.com/c/'+randomUUID(),proof:'user_task_nonce'});
  assert.equal(accepted.ok,true);
  assert.equal(browser.get(back.id).chatUrl,accepted.chatUrl);
  assert.equal((await browser.poll({clientId,taskId:back.id})).recovery,null);
  const reloaded=new DualAgent({browser,api,directory:path.join(temp,'hub'),defaultMode:'api'});
  await reloaded.load();
  assert.equal(reloaded.get(back.id).conversationId,task.id);
  assert.equal(reloaded.get(back.id).linkedFromTaskId,continued.id);
  assert.equal(manager.workspace,first);

  // The user's requests of a longer conversation: the last 4, in the order they were asked, each cut at 150 characters and without the secrets the Hub knows
  // (the strings the text lists under "User requests:", but for the blank one, which selects nothing).
  {
    const SECRET='hunter2-secret-value',long='Update the Dockerfile and the docker compose file for the new service. '+'x'.repeat(200);
    const lastFour=[long.slice(0,150),'Fourth request with the key '+SECRET+' in it.','','Sixth request.'];
    const earlier={id:randomUUID(),status:'completed',finalText:'Done.',workspace:{path:first},dialogue:[],
      prompts:['An old request that is not carried.','Second request.',long,lastFour[1],lastFour[2],lastFour[3]].map(text=>({text}))};
    const quiet=new DualAgent({browser:{state:()=>({tasks:[earlier],active:null}),get:id=>id===earlier.id?earlier:null,settle:async()=>{}},
      api:{...api,manager:{secrets:[SECRET],workspaceRegistry:registered,workspace:first}},directory:path.join(temp,'quiet'),defaultMode:'api'});
    await quiet.continue({id:earlier.id,prompt:'Go on.'});
    const scrubbed=lastFour.map(text=>text.replace(SECRET,'[REDACTED]'));
    assert.deepEqual(apiStarted.handoffRequests,scrubbed.filter(Boolean),'the last 4 requests, in order, cut, scrubbed, without the blank one');
    assert.equal(apiStarted.handoffText.split('\n')[1],'User requests: '+scrubbed.join(' | '),'the same strings as the text lists');
    assert.ok(!JSON.stringify(apiStarted).includes(SECRET),'the secret is in neither');
  }

  await registered.remove(other);
  await assert.rejects(dual.continue({id:task.id,prompt:'Detached folder must be refused.'}),
    {code:'unregistered_workspace'});
  assert.ok((await fs.stat(path.join(other,'README.md'))).isFile());
  console.log('PASS browser-paired Web chat uses selected workspace, independent API jobs, correct transport and safe continuation');
}finally{
  await browser?.shutdown().catch(()=>{});
  await fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:100}).catch(()=>{});
}
