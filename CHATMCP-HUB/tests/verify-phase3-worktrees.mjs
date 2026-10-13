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
  let independentActive=0,peakIndependent=0;
  let signalCancelWorkerStarted;
  const cancelWorkerStarted=new Promise(resolve=>{signalCancelWorkerStarted=resolve;});
  const orchestrator=new CodingWorktreeOrchestrator({
    manager:parent,provider:{ready:()=>true},
    directory:path.join(root,'coding-runs'),
    bundleRoot:path.resolve('.'),
    createWorker:async({worktree,node,signal})=>{
      actions.push(node.id);
      if(node.id==='middle'){
        assert.match(await fs.readFile(path.join(worktree,'ancestor.js'),'utf8'),/ancestor=41/);
        await fs.writeFile(path.join(worktree,'middle.js'),'export const middle=42;\n');
      }else if(node.id==='leaf'){
        assert.match(await fs.readFile(path.join(worktree,'ancestor.js'),'utf8'),/ancestor=41/);
        assert.match(await fs.readFile(path.join(worktree,'middle.js'),'utf8'),/middle=42/);
        await fs.writeFile(path.join(worktree,'leaf.js'),'export const leaf=43;\n');
      }else if(node.id==='noop'){
        // Deliberate no-op: after the trusted dependency merge its worktree
        // still contains inherited code, which MUST propagate downstream.
        assert.match(await fs.readFile(path.join(worktree,'ancestor.js'),'utf8'),/ancestor=41/);
      }else if(node.id==='samefile'){
        assert.match(await fs.readFile(path.join(worktree,'ancestor.js'),'utf8'),/ancestor=41/);
        await fs.writeFile(path.join(worktree,'ancestor.js'),'export const ancestor=99;\n');
      }else if(node.id==='failbase'){
        return {state:'failed',summary:'Scripted non-repairable worker failed',toolCalls:0};
      }else if(node.id==='cancelbase'){
        signalCancelWorkerStarted();
        await new Promise((resolve,reject)=>{
          if(signal.aborted){reject(signal.reason||new Error('cancelled'));return;}
          signal.addEventListener('abort',()=>reject(signal.reason||new Error('cancelled')),{once:true});
        });
      }else if(node.id==='base'){
        await fs.writeFile(path.join(worktree,'ancestor.js'),'export const ancestor=41;\n');
      }else if(node.id==='descendant'){
        assert.match(await fs.readFile(path.join(worktree,'ancestor.js'),'utf8'),/ancestor=41/,
          'Downstream worktree MUST inherit the committed upstream source, not model prose');
        await fs.writeFile(path.join(worktree,'child.js'),'export const child=42;\n');
      }else if(node.id==='flat'||node.id==='nested'){
        // Structural Git conflict: same path is a file in one branch and
        // a directory in another. Branches are separate disposable worktrees.
        await fs.mkdir(path.join(worktree,'src'),{recursive:true});
        if(node.id==='flat'){
          await fs.writeFile(path.join(worktree,'src','feature'),'export const flat=1;\n');
        }else{
          await fs.mkdir(path.join(worktree,'src','feature'));
          await fs.writeFile(path.join(worktree,'src','feature','index.js'),
            'export const nested=1;\n');
        }
      }else if(node.id==='left'||node.id==='right'){
        independentActive++;peakIndependent=Math.max(independentActive,peakIndependent);
        await new Promise(resolve=>setTimeout(resolve,30));
        independentActive--;
        await fs.writeFile(path.join(worktree,'shared.js'),
          'export const worker='+JSON.stringify(node.id)+';\n');
      }else if(node.id==='overflow'){
        // Exceeds the trusted 250-file conflict inventory limit. The
        // orchestrator must refuse to commit rather than silently truncate.
        for(let i=0;i<251;i++){
          await fs.writeFile(path.join(worktree,'overflow-'+String(i).padStart(3,'0')+'.js'),
            'export const n='+i+';\n');
        }
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

  const context=await orchestrator.contextPreview({runId:run.id,workerId:'descendant'});
  assert.equal(context.workerId,'descendant');
  assert.equal(context.sentToModel,false);
  assert.equal(context.testOutcomeAuthenticated,false);
  assert.deepEqual(context.files.map(x=>x.path),['child.js']);
  assert.match(context.files[0].sha256,/^[0-9a-f]{64}$/);
  await assert.rejects(orchestrator.contextPreview({
    runId:run.id,workerId:'unknown',
  }),{code:'worker_not_ready'});
  // Three serial ancestor→middle→leaf waves must inherit real commits, not
  // model summaries or post-hoc source edits.
  const beforeChain=actions.length;
  const chain=await orchestrator.run({
    confirmation:'CREATE WORKTREES',maxConcurrency:2,
    tasks:[
      {id:'base',prompt:'Produce base module'},
      {id:'middle',prompt:'Consume base',dependsOn:['base']},
      {id:'leaf',prompt:'Consume middle',dependsOn:['middle']},
    ],
  });
  assert.equal(chain.status,'ready_for_review',JSON.stringify(chain));
  assert.deepEqual(actions.slice(beforeChain),['base','middle','leaf']);
  const chainNodes=orchestrator.jobs.get(chain.id).workers;
  assert.equal(chainNodes[1].inheritedCommits.base,chainNodes[0].commitSha);
  assert.equal(chainNodes[2].inheritedCommits.middle,chainNodes[1].commitSha);
  assert.equal(git('rev-parse','HEAD').trim(),run.baseSha,'Main checkout must not change during DAG merges');
  // Regression: A -> no-op B -> C MUST retain A's committed source.
  // A no-op worker has no OWN commit, but its branch HEAD advances when
  // trusted dependency merges are applied.
  const chainStart=actions.length;
  const noOpChain=await orchestrator.run({
    confirmation:'CREATE WORKTREES',maxConcurrency:2,
    tasks:[
      {id:'base',prompt:'Commit reusable base source'},
      {id:'noop',prompt:'Review base without edits',dependsOn:['base']},
      {id:'descendant',prompt:'Consume base through no-op',dependsOn:['noop']},
    ],
  });
  assert.equal(noOpChain.status,'ready_for_review',JSON.stringify(noOpChain));
  assert.deepEqual(actions.slice(chainStart),['base','noop','descendant']);
  const chainWorkers=orchestrator.jobs.get(noOpChain.id).workers;
  assert.equal(chainWorkers[1].status,'no_changes');
  assert.equal(chainWorkers[1].commitSha,null,'No-op must not manufacture its own edit commit');
  assert.match(chainWorkers[1].inheritedHeadSha,/^[0-9a-f]{40}$/);
  assert.equal(chainWorkers[2].inheritedCommits.noop,chainWorkers[1].inheritedHeadSha);
  assert.equal(chainWorkers[2].status,'ready_for_review');
  assert.equal(git('rev-parse','HEAD').trim(),run.baseSha,'User checkout stays untouched');

  // Same-file edits are permitted ONLY when the owner-declared DAG and
  // actual Git ancestry prove B inherited reviewed A. Independent siblings
  // editing this path remain rejected by the separate conflict test below.
  const sequence=await orchestrator.run({
    confirmation:'CREATE WORKTREES',maxConcurrency:2,
    tasks:[
      {id:'base',prompt:'Create shared implementation'},
      {id:'samefile',prompt:'Edit inherited implementation',dependsOn:['base']},
    ],
  });
  assert.equal(sequence.status,'ready_for_review',JSON.stringify(sequence));
  const baseReviewed=await orchestrator.review({runId:sequence.id,workerId:'base'});
  const descendantReviewed=await orchestrator.review({runId:sequence.id,workerId:'samefile'});
  const integrated=await orchestrator.integrate({
    runId:sequence.id,workerIds:['base','samefile'],confirmation:'INTEGRATE WORKTREES',
    reviewTokens:{base:baseReviewed.reviewToken,samefile:descendantReviewed.reviewToken},
  });
  assert.equal(integrated.status,'ready_for_review');
  const finalText=await fs.readFile(path.join(integrated.worktree,'ancestor.js'),'utf8');
  assert.match(finalText,/ancestor=99/);
  assert.equal(git('rev-parse','HEAD').trim(),run.baseSha,
    'Ancestor-aware integration must not touch user main checkout');

  // A failed predecessor must NEVER dispatch its dependent to AgentRunner.
  const beforeFailure=actions.length;
  const failed=await orchestrator.run({
    confirmation:'CREATE WORKTREES',maxConcurrency:2,
    tasks:[
      {id:'failbase',prompt:'A scripted failed predecessor'},
      {id:'should-not-run',prompt:'Must not execute',dependsOn:['failbase']},
    ],
  });
  assert.equal(failed.status,'partial_failure');
  assert.deepEqual(actions.slice(beforeFailure),['failbase']);
  assert.equal(failed.workers.find(x=>x.id==='should-not-run').status,'blocked');
  // An interruption also cannot release downstream work or publish a
  // fabricated success even when cancellation happens mid-await.
  const cancelledRunPromise=orchestrator.run({
    confirmation:'CREATE WORKTREES',
    tasks:[
      {id:'cancelbase',prompt:'Wait for stop signal'},
      {id:'aftercancel',prompt:'Never run after cancellation',dependsOn:['cancelbase']},
    ],
  });
  await Promise.race([
    cancelWorkerStarted,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('Cancellation worker did not start')),5000)),
  ]);
  assert.equal(orchestrator.cancel().cancelled,true);
  const stopped=await cancelledRunPromise;
  assert.equal(stopped.status,'cancelled');
  assert.equal(actions.includes('aftercancel'),false);
  assert.equal(git('rev-parse','HEAD').trim(),run.baseSha);
  // Two independent workers must overlap without widening the permitted
  // process concurrency or leaving either Git index partially staged.
  const conflict=await orchestrator.run({
    confirmation:'CREATE WORKTREES',maxConcurrency:2,
    tasks:[{id:'left',prompt:'Change shared file'}, {id:'right',prompt:'Change shared file'}],
  });
  assert.equal(conflict.status,'ready_for_review');
  assert.equal(peakIndependent,2,'Independent workers should overlap within allowed concurrency=2');
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
  // File/directory structural conflict across independent Git branches
  // must be detected BEFORE creating an integration worktree.
  const fileDirCollision=await orchestrator.run({
    confirmation:'CREATE WORKTREES',maxConcurrency:2,
    tasks:[
      {id:'flat',prompt:'Create src/feature as a file'},
      {id:'nested',prompt:'Create src/feature/index.js'},
    ],
  });
  assert.equal(fileDirCollision.status,'ready_for_review',JSON.stringify(fileDirCollision));
  const flatReview=await orchestrator.review({runId:fileDirCollision.id,workerId:'flat'});
  const nestedReview=await orchestrator.review({runId:fileDirCollision.id,workerId:'nested'});
  await assert.rejects(orchestrator.integrate({
    runId:fileDirCollision.id,workerIds:['flat','nested'],
    confirmation:'INTEGRATE WORKTREES',
    reviewTokens:{flat:flatReview.reviewToken,nested:nestedReview.reviewToken},
  }),{code:'worker_file_conflict'});
  assert.equal(orchestrator.jobs.get(fileDirCollision.id).integration,null);
  assert.equal(git('rev-parse','HEAD').trim(),run.baseSha,
    'File/directory conflicts must leave the user checkout intact');

  const overflow=await orchestrator.run({
    confirmation:'CREATE WORKTREES',tasks:[
      {id:'overflow',prompt:'Create more files than safely reportable'},
    ],
  });
  const overflowWorker=orchestrator.jobs.get(overflow.id).workers[0];
  assert.equal(overflow.status,'partial_failure');
  assert.equal(overflowWorker.status,'failed');
  assert.equal(overflowWorker.commitSha,null,
    'Over-limit worker must not publish a commit missing some changed paths');
  assert.match(overflowWorker.error,/more than 250 files/i);
  assert.equal(git('rev-parse','HEAD').trim(),run.baseSha,
    'User checkout remains unchanged after overflow');
  console.log('PASS: Phase3 3-stage Git DAG, bounded concurrent workers, cancellation, blocked descendants, reviewed context and conflict safety; no host model shell');
}finally{
  if(parent)await parent.shutdown().catch(()=>{});
  await fs.rm(root,{recursive:true,force:true});
}
