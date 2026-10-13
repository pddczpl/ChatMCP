// Phase 3: real Git worktrees with SCRIPTED workers, no paid model and
// no Windows Sandbox attestation. Exercises trusted dependency propagation,
// review tokens and conflict fail-closed integration without touching a user
// checkout, cloud remote, shell tool delegation or production publisher.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HubManager } from '../lib/manager.mjs';
import { assembleStudio } from '../lib/assemble.mjs';
import { CodingWorktreeOrchestrator } from '../lib/coding-orchestrator.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-phase3-worktrees-'));
const project=path.join(root,'project');
const data=path.join(root,'state');
const git=(...args)=>execFileSync('git',args,{cwd:project,encoding:'utf8',timeout:30000,windowsHide:true});
let parent=null;
try{
  await fs.mkdir(project);
  git('init','-b','main');
  git('config','user.name','Phase3 CI');
  git('config','user.email','ci@example.invalid');
  await fs.writeFile(path.join(project,'package.json'),
    JSON.stringify({name:'phase3-scripted-test',version:'1.0.0',private:true}));
  await fs.writeFile(path.join(project,'baseline.js'),'export const baseline=1;\n');
  git('add','.');git('commit','-m','baseline');

  parent=new HubManager({bundleRoot:path.resolve('.'),dataDirectory:data,backend:'local',log:()=>{}});
  await parent.load(project);
  assembleStudio(parent,{bundleRoot:path.resolve('.')});
  parent.permissions.mode='autonomous';
  await parent.startLocal();
  const actions=[];
  const orchestrator=new CodingWorktreeOrchestrator({
    manager:parent,provider:{ready:()=>true},
    directory:path.join(root,'coding-runs'),
    bundleRoot:path.resolve('.'),
    createWorker:async({worktree,node})=>{
      actions.push(node.id);
      if(node.id==='base'){
        await fs.writeFile(path.join(worktree,'ancestor.js'),'export const ancestor=41;\n');
      }else if(node.id==='descendant'){
        assert.match(await fs.readFile(path.join(worktree,'ancestor.js'),'utf8'),/ancestor=41/,
          'Downstream worktree MUST inherit the committed upstream source, not model prose');
        await fs.writeFile(path.join(worktree,'child.js'),'export const child=42;\n');
      }else if(node.id==='left'||node.id==='right'){
        await fs.writeFile(path.join(worktree,'shared.js'),
          'export const worker='+JSON.stringify(node.id)+';\n');
      }
      return {state:'completed',summary:'Scripted worker completed; no model tools used.',toolCalls:0};
    },
  });

  const invalid=await orchestrator.run({
    confirmation:'CREATE WORKTREES',
    tasks:[{id:'a',prompt:'a',dependsOn:['b']},{id:'b',prompt:'b',dependsOn:['a']}],
  }).then(()=>null,e=>e);
  assert.equal(invalid?.code,'cyclic_coding_dependency');
  assert.equal(git('branch','--list','chatmcp/*').trim(),'',
    'Cyclic DAG must not create managed Git branches');

  const run=await orchestrator.run({
    confirmation:'CREATE WORKTREES',maxConcurrency:2,
    tasks:[
      {id:'base',prompt:'Create ancestor source'},
      {id:'descendant',prompt:'Consume ancestor commit',dependsOn:['base']},
    ],
  });
  assert.equal(run.status,'ready_for_review',JSON.stringify(run));
  assert.deepEqual(actions,['base','descendant']);
  const job=orchestrator.jobs.get(run.id);
  assert.equal(job.workers[1].inheritedCommits.base,job.workers[0].commitSha);
  assert.equal(git('rev-parse','HEAD').trim(),run.baseSha,'User main checkout remains unchanged');
  const reviewed=await orchestrator.review({runId:run.id,workerId:'descendant'});
  assert.match(reviewed.diff,/ancestor\.js/);
  assert.match(reviewed.diff,/child\.js/);
  assert.match(reviewed.reviewToken,/^[0-9a-f]{64}$/);

  const recovery=await orchestrator.recoveryStatus({runId:run.id});
  assert.equal(recovery.found,true);
  assert.equal(recovery.status,'ready_for_review');
  assert.equal(recovery.autoResume,false);
  assert.equal(recovery.verificationReceiptsTrusted,false);

  const conflict=await orchestrator.run({
    confirmation:'CREATE WORKTREES',maxConcurrency:2,
    tasks:[{id:'left',prompt:'Change shared file'}, {id:'right',prompt:'Change shared file'}],
  });
  assert.equal(conflict.status,'ready_for_review');
  const left=await orchestrator.review({runId:conflict.id,workerId:'left'});
  const right=await orchestrator.review({runId:conflict.id,workerId:'right'});
  await assert.rejects(
    orchestrator.integrate({
      runId:conflict.id,workerIds:['left','right'],
      confirmation:'INTEGRATE WORKTREES',
      reviewTokens:{left:left.reviewToken,right:right.reviewToken},
    }),
    {code:'worker_file_conflict'}
  );
  assert.equal(orchestrator.jobs.get(conflict.id).integration,null,
    'Conflict must be detected BEFORE integration worktree creation');
  assert.equal(git('rev-parse','HEAD').trim(),run.baseSha);
  console.log('PASS: Phase3 real Git-worktree DAG inheritance, review tokens, manual-only recovery and conflict preflight; no host model shell');
}finally{
  if(parent)await parent.shutdown().catch(()=>{});
  await fs.rm(root,{recursive:true,force:true});
}
