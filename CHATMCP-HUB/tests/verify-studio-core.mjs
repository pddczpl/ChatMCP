import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { PermissionGate } from '../lib/permissions.mjs';
import { StudioTools } from '../lib/studio-tools.mjs';
import { StudioWorkflow } from '../lib/studio-workflow.mjs';
import { StudioDelegates } from '../lib/studio-delegates.mjs';
import { StudioTerminal } from '../lib/studio-terminal.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-2-test-'));
const workspace=path.join(root,'project');await fs.mkdir(path.join(workspace,'src'),{recursive:true});
const git=(...args)=>{const r=spawnSync('git',args,{cwd:workspace,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout;};
git('init','-q');git('config','user.email','agent-test@example.invalid');git('config','user.name','Agent Fixture');
await fs.writeFile(path.join(workspace,'src','app.py'),'def compute_aqi(x):\n    return x+1\n');
await fs.writeFile(path.join(workspace,'README.md'),'# Example\n');
await fs.writeFile(path.join(workspace,'.env'),'SECRET=DO_NOT_READ_ME\n');
git('add','README.md','src/app.py');git('commit','-qm','baseline');
const manager={workspace,secrets:[],log:()=>{}};
const studio=new StudioWorkspace({manager,directory:path.join(root,'state')});
let n=0;const check=(condition)=>{assert.ok(condition);n++};
try{
  const tree=await studio.tree({directory:'src'});check(tree.entries.some(e=>e.name==='app.py'));
  const source=await studio.read({file:'src/app.py'});check(source.content.includes('compute_aqi'));
  const found=await studio.search({query:'compute_aqi',mode:'symbol'});check(found.matches[0]?.line===1);
  const text=await studio.search({query:'return x+1'});check(text.matches.length===1);
  const file=await studio.search({query:'app.py',mode:'filename'});check(file.matches.length===1);
  await assert.rejects(()=>studio.read({file:'../../etc/passwd'}),e=>e.statusCode===403);n++;
  await assert.rejects(()=>studio.read({file:'.env'}),e=>e.statusCode===403);n++;
  const escape=path.join(root,'elsewhere.txt');await fs.writeFile(escape,'outside');
  // Reading through a link that leaves the workspace must be refused. File symlinks need
  // Developer Mode/administrator rights on Windows (EPERM); a directory junction needs no
  // privilege and exercises the same realpath containment check, so fall back to it.
  let linkedFile=null,linkKind='file symlink';
  try{await fs.symlink(escape,path.join(workspace,'src','link.txt'));linkedFile='src/link.txt';}
  catch(error){
    if(error.code!=='EPERM'&&error.code!=='EACCES')throw error;
    const outsideDirectory=path.join(root,'outside-dir');await fs.mkdir(outsideDirectory);await fs.writeFile(path.join(outsideDirectory,'secret.txt'),'outside');
    try{await fs.symlink(outsideDirectory,path.join(workspace,'src','linkdir'),'junction');linkedFile='src/linkdir/secret.txt';linkKind='directory junction (file symlink not permitted)';}
    catch(junctionError){if(junctionError.code!=='EPERM'&&junctionError.code!=='EACCES')throw junctionError;}
  }
  if(linkedFile){await assert.rejects(()=>studio.read({file:linkedFile}),e=>e.statusCode===403);n++;console.log(`link-escape check ran with a ${linkKind}`);}
  else console.warn('SKIPPED link-escape check: this environment does not allow creating symlinks or junctions');
  const before=await studio.checkpoint({label:'before update'});check(before.fileCount>=2 && before.partial===true);
  const now=path.join(workspace,'src','app.py');await fs.writeFile(now,'def compute_aqi(x):\n    return x+2\n');
  const status=await studio.gitStatus();check(status.entries.some(line=>line.includes('app.py')));
  const diff=await studio.gitDiff({file:'src/app.py'});check(diff.diff.includes('return x+2'));
  const review=await studio.review({checkpointId:before.id,file:'src/app.py'});const change=review.changes[0];check(change?.currentSha&&change.diff.includes('return x+2'));
  const approved=await studio.accept({checkpointId:before.id,file:'src/app.py',expectedSha:change.currentSha});check(approved.ok);
  await assert.rejects(()=>studio.restore({checkpointId:before.id,file:'src/app.py',expectedSha:'0'.repeat(64)}),e=>e.statusCode===409);n++;
  await fs.writeFile(now,'def compute_aqi(x):\n    return x+3\n');
  await assert.rejects(()=>studio.restore({checkpointId:before.id,file:'src/app.py',expectedSha:change.currentSha}),e=>e.statusCode===409);n++;
  const after=await studio.review({checkpointId:before.id,file:'src/app.py'});const rollback=await studio.restore({checkpointId:before.id,file:'src/app.py',expectedSha:after.changes[0].currentSha});
  check(rollback.ok&&(await fs.readFile(now,'utf8')).includes('return x+1'));
  check((await fs.readFile(path.join(workspace,'.env'),'utf8')).includes('DO_NOT_READ_ME')); // unrelated file untouched
  const lists=await studio.checkpoints();check(lists.some(x=>x.id===before.id));
  const src=await studio.read({file:'src/app.py'});
  const saved=await studio.save({file:'src/app.py',content:'def compute_aqi(x):\n    return x+4\n',expectedSha:src.sha256});check(saved.ok&&saved.checkpointId);
  await assert.rejects(()=>studio.save({file:'src/app.py',content:'overwrite',expectedSha:src.sha256}),e=>e.statusCode===409);n++;
  check((await fs.readFile(path.join(workspace,'README.md'),'utf8')).includes('Example'));
  const planId='123e4567-e89b-42d3-a456-426614174000';
  const plan=await studio.plan({taskId:planId,operation:'set',title:'Implement',items:[{text:'Read',status:'done',evidence:'Read README'}]});check(plan.items[0].status==='done');
  check((await studio.plan({taskId:planId})).items.length===1);
  const gate=new PermissionGate({manager,workspace:studio,directory:path.join(root,'policy'),timeout:1000});
  const reader=await gate.authorize({name:'desktop-commander.read_file',args:{path:'src/app.py'},taskId:planId});check(reader.allowed);
  check(gate.classify('remote-connector.write_file',{}, {annotations:{readOnlyHint:true}}).category==='workspace_edit');
  check(gate.classify('unknown.tool',{}, {annotations:{readOnlyHint:true}}).category==='unknown');
  const controller=new AbortController();const request=gate.authorize({name:'desktop-commander.start_process',args:{command:'echo hello'},taskId:planId,signal:controller.signal});
  await new Promise(r=>setTimeout(r,10));check(gate.state().pending.length===1);const [pending]=gate.state().pending;gate.decide(pending.id,true);check((await request).allowed);
  const refused=gate.authorize({name:'desktop-commander.delete_file',args:{path:'src/app.py'},taskId:planId});await new Promise(r=>setTimeout(r,10));gate.decide(gate.state().pending[0].id,false);check((await refused).allowed===false);
  await assert.rejects(()=>gate.authorize({name:'desktop-commander.edit_file',args:{path:'../../escape'},taskId:planId}),e=>e.statusCode===403);n++;
  gate.configure({mode:'autonomous'});check((await gate.authorize({name:'desktop-commander.edit_file',args:{path:'src/app.py'},taskId:planId})).allowed);
  const shell=gate.authorize({name:'desktop-commander.start_process',args:{command:'rm -rf src'},taskId:planId});await new Promise(r=>setTimeout(r,10));check(gate.state().pending.length===1);gate.decide(gate.state().pending[0].id,false);await shell;
  await gate.writes;
  const gateAgain=new PermissionGate({manager,workspace:studio,directory:path.join(root,'policy')});await gateAgain.load();check(gateAgain.state().mode==='autonomous'&&gateAgain.state().recent.length>=2);
  const router=new StudioTools({workspace:studio,gate});check(router.definitions().length>=12);
  const output=await router.call('studio.search',{query:'compute_aqi',mode:'symbol',limit:5},{taskId:planId});check(output.structuredContent.matches.length===1);
  const workflow=new StudioWorkflow({directory:path.join(root,'workflow')});await workflow.mark(planId,'tool_start',{toolName:'studio.diff_check',category:'read'});await workflow.mark(planId,'tool_result',{toolName:'studio.diff_check',verified:true});
  check((await workflow.state(planId)).verified===true);
  const workflowReload=new StudioWorkflow({directory:path.join(root,'workflow')});check((await workflowReload.state(planId)).checksObserved===1);
  const provider={ready:()=>true,respond:async()=>({output:[{type:'message',content:[{type:'output_text',text:'Inspect src/app.py line 1'}]}]})};
  const delegates=new StudioDelegates({workspace:studio,provider,directory:path.join(root,'delegates')});const job=await delegates.research({queries:['compute_aqi']});check(job.status==='completed'&&job.workers[0].references.length===1);
  const delegatesAgain=new StudioDelegates({workspace:studio,provider,directory:path.join(root,'delegates')});await delegatesAgain.load();check(delegatesAgain.state().last.id===job.id);
  const terminal=new StudioTerminal({workspace:studio});const run=await terminal.start({command:'echo terminal-ok',timeoutMinutes:1});
  for(let i=0;i<100&&terminal.state().find(x=>x.id===run.id).status==='running';i++)await new Promise(r=>setTimeout(r,30));
  const t=terminal.state().find(x=>x.id===run.id);check(t.status==='completed'&&t.logs.some(line=>line.message.includes('terminal-ok')));
  await terminal.close();
  console.log(`PASS: ${n} Studio 2.0 checks (path containment, git, checkpoint rollback, permissions, workflow, delegates, terminal)`);
}finally{await fs.rm(root,{recursive:true,force:true});}
