// Regression: two local coding conversations do not share a Hub-wide run lock;
// dependency tasks do not start early; Stop and provider callbacks are scoped.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { AgentRunner, buildUserAttachmentParts } from '../lib/agent.mjs';
import { ConcurrentApiAgent } from '../lib/concurrent-api-agent.mjs';
import { compactRollingContext, estimateTokens } from '../lib/context-compaction.mjs';

const bundleRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-concurrent-'));
const repo=path.join(temp,'project');
const wait=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(test,label)=>{
  for(let tries=0;tries<300;tries++){if(test())return;await wait(100);}
  throw new Error('Timed out: '+label);
};
const release=new Map();
const arrived=new Set();
const hold=(name)=>new Promise(resolve=>{release.set(name,resolve);arrived.add(name);});
let pool;
try {
  await fs.mkdir(repo,{recursive:true});
  execFileSync('git',['init','-b','main'],{cwd:repo,stdio:'ignore'});
  execFileSync('git',['config','user.email','chatmcp-ci@example.invalid'],{cwd:repo});
  execFileSync('git',['config','user.name','ChatMCP CI'],{cwd:repo});
  await fs.writeFile(path.join(repo,'README.md'),'# Concurrent agent fixture\n');
  execFileSync('git',['add','.'],{cwd:repo});
  execFileSync('git',['commit','-m','fixture'],{cwd:repo,stdio:'ignore'});
  const manager=new HubManager({bundleRoot:bundleRoot,dataDirectory:path.join(temp,'hub'),log:()=>{}});
  await manager.load(repo);
  assembleStudio(manager,{bundleRoot:bundleRoot});
  await manager.permissions.load();
  manager.permissions.mode='autonomous';
  await manager.startLocal(repo);
  const provider={
    ready:()=>true,snapshot:()=>({provider:'fake',model:'mock'}),
    async respond({input}){
      const firstUser=input.find(x=>x?.role==='user'&&Array.isArray(x.content));
      const contents=(firstUser?.content||[]).map(x=>x?.text||'').join(' ');
      const name=contents.includes('Task A')?'A':contents.includes('Task B')?'B':'C';
      if((name==='A'||name==='B')&&!arrived.has(name))await hold(name);
      return {status:'completed',output:[{type:'message',role:'assistant',phase:'final',
        content:[{type:'output_text',text:'Task '+name+' completed.'}]}]};
    },
  };
  const primary=new AgentRunner({manager,provider,taskDirectory:path.join(temp,'hub','api-tasks'),log:()=>{}});
  await primary.load();
  pool=new ConcurrentApiAgent({primary,manager,provider,bundleRoot:bundleRoot,
    directory:path.join(temp,'hub','api-conversations'),log:()=>{}});
  manager.spawnBackgroundAgent=(parentId,request)=>pool.spawnAgent(parentId,request);
  const first=await pool.start({prompt:'Task A: inspect README'});
  await until(()=>arrived.has('A'),'primary running');
  const second=await pool.start({prompt:'Task B: inspect README'});
  await until(()=>arrived.has('B'),'independent child running');
  assert.equal(pool.state().activeTaskIds.length,2,'two independent API conversations must run concurrently');
  const third=await pool.start({prompt:'Task C: summarize B',dependsOn:[second.id]});
  assert.equal(pool.get(third.id).status,'queued');
  assert.deepEqual(pool.get(third.id).dependsOn,[second.id]);
  const newMessage=await pool.continue({id:first.id,prompt:'Please also include a tiny status report.'});
  assert.equal(newMessage.queuedMessagesCount,1,'in-flight message must be accepted, not rejected with 409');
  release.get('B')();
  await until(()=>pool.get(second.id)?.status==='completed','B complete');
  await until(()=>pool.get(third.id)?.status==='completed','C complete after B');
  release.get('A')();
  await until(()=>pool.get(first.id)?.status==='completed','A complete with extra message');
  assert.ok(pool.get(first.id).events.some(x=>x.type==='user_message_delivered'));
  const worktrees=pool.state().tasks.filter(x=>x.workspace?.path&&x.workspace.path!==repo);
  assert.ok(worktrees.length>=2,'child conversations must have their own worktree paths');
  const unique=new Set(worktrees.map(x=>x.workspace.path));
  assert.equal(unique.size,worktrees.length,'each child gets a distinct worktree');

  // Review mode: approval for a new worktree is explicitly pending and can
  // be cancelled without the worktree appearing later.
  manager.permissions.mode='review';
  const cancelled=await pool.start({prompt:'Task D: cancel while awaiting worktree approval',baseRef:'refs/heads/main'});
  await until(()=>manager.permissions.state().pending.some(p=>p.taskId===cancelled.id),'worktree permission pending');
  assert.equal(pool.get(cancelled.id).state,'queued');
  await pool.cancel(cancelled.id);
  await until(()=>!manager.permissions.state().pending.some(p=>p.taskId===cancelled.id),'approval revoked on Stop');
  assert.equal(pool.get(cancelled.id).status,'cancelled');
  const cancelledBranch=execFileSync('git',['branch','--list','chatmcp/chat/'+cancelled.id.slice(0,12)],{cwd:repo,encoding:'utf8'});
  assert.equal(cancelledBranch.trim(),'','cancelled preflight must not create a worktree branch');

  const accepted=await pool.start({prompt:'Task D: allowed worktree after approval',baseRef:'refs/heads/main'});
  await until(()=>manager.permissions.state().pending.some(p=>p.taskId===accepted.id),'second worktree permission pending');
  const approval=manager.permissions.state().pending.find(p=>p.taskId===accepted.id);
  assert.equal(approval.toolName,'local.worktrees_create');
  manager.permissions.decide(approval.id,true);
  await until(()=>pool.get(accepted.id)?.status==='completed','review-approved child completes');
  assert.ok(pool.get(accepted.id).worktree,'approved task owns a separate worktree');
  await pool.shutdown();

  assert.equal(buildUserAttachmentParts([{name:'hello.md',mimeType:'text/markdown',dataBase64:Buffer.from('A text file').toString('base64')}]).parts[0].type,'input_text');
  assert.equal(buildUserAttachmentParts([{name:'photo.png',mimeType:'image/png',dataBase64:'AA=='}]).parts[0].type,'input_image');
  assert.throws(()=>buildUserAttachmentParts([{name:'.env',mimeType:'text/plain',dataBase64:'AA=='}]),/môi trường|khóa/i);

  const records=[{role:'user',content:[{type:'input_text',text:'Implement API'}]}];
  for(let i=0;i<15;i++){
    const id='f'+i;
    records.push({type:'function_call',name:'read_file',call_id:id,arguments:'{"file":"x"}'});
    records.push({type:'function_call_output',call_id:id,output:'tool report '+i+': '+'x'.repeat(5000)});
  }
  records.push({role:'user',content:[{type:'input_text',text:'Final user instruction'}]});
  assert.ok(estimateTokens(records)>10000);
  const snapshot=structuredClone(records);
  const compacted=compactRollingContext(records,{maxTokens:10000,tailTokens:6000,taskCheckpoint:'Keep API plan'});
  assert.ok(compacted.compacted,'long session should compact');
  assert.deepEqual(records,snapshot,'canonical transcript must not be mutated');
  assert.ok(compacted.history[0].content[0].text.includes('Keep API plan'));
  const calls=new Set(compacted.history.filter(e=>e.type==='function_call').map(e=>e.call_id));
  const results=new Set(compacted.history.filter(e=>e.type==='function_call_output').map(e=>e.call_id));
  assert.deepEqual(calls,results,'all preserved calls have paired results');
  assert.ok(compacted.history.at(-1).content[0].text.includes('Final user instruction'));
  console.log('PASS concurrent worktree chats, dependency gating, live instructions, attachments, paired compact context');
}finally{
  for(const cb of release.values())cb();
  await pool?.shutdown().catch(()=>{});
  await fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:200}).catch(()=>{});
}
