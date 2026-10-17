import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { NO_PROGRESS_LIMIT, createTaskProgress, observeTaskTool, progressCheckpoint } from '../lib/agent-progress.mjs';

const call = (name, args = {}) => ({name:'mcp_call',arguments:JSON.stringify({name,arguments_json:JSON.stringify(args)})});
const successful = {content:[{type:'text',text:'[FILE] README.md'}]};
let p = createTaskProgress();
for (let i = 0; i < NO_PROGRESS_LIMIT; i++) {
  const value = observeTaskTool(p,{call:call('desktop-commander.list_directory',{path:'C:\\work'}),result:successful,step:i+1});
  p = value.progress;
  if (i === 0) assert.equal(value.repeated,false);
  if (i === 1) assert.equal(value.repeated,true);
  if (i === NO_PROGRESS_LIMIT - 1) assert.equal(value.stalled,false);
}
assert.equal(observeTaskTool(p,{call:call('desktop-commander.list_directory',{path:'C:\\work'}),result:successful}).stalled,true);
assert.match(progressCheckpoint(p),/HOST PROGRESS CHECKPOINT/);
assert.equal(p.recentFingerprints.length,1);
assert.equal(p.editAttempts,0);
p = observeTaskTool(p,{call:call('desktop-commander.read_file',{path:'C:\\work\\other.js'}),result:{content:[{text:'different'}]}}).progress;
assert.equal(p.noProgress,0,'different inspections reset repetition count');

let failedEdit = observeTaskTool(p,{call:call('local.write_file',{path:'C:\\work\\x.js'}),result:{isError:true,error:'denied'}});
assert.equal(failedEdit.progress.editAttempts,0,'a denied edit never counts as successful');
const successfulEdit = observeTaskTool(failedEdit.progress,{call:call('local.write_file',{path:'C:\\work\\x.js'}),result:{content:[{text:'written'}]}});
assert.equal(successfulEdit.progress.editAttempts,1);
assert.equal(successfulEdit.progress.changedCandidates.includes('C:\\work\\x.js'),true);
assert.match(progressCheckpoint(successfulEdit.progress),/NOT verified file changes/);

// Previously passing test and diff receipts cannot survive a later source edit.
let evidence=createTaskProgress();
evidence=observeTaskTool(evidence,{call:call('local.run_command',{command:'node --test'}),
  result:{isError:false},step:1,verified:{kind:'verify',id:'check-a',step:1}}).progress;
evidence=observeTaskTool(evidence,{call:call('local.git_diff',{}),
  result:{isError:false},step:2,verified:{kind:'review',id:'diff-a',step:2}}).progress;
assert.equal(evidence.verifiedChecks.length,1);
assert.equal(evidence.gitReviews.length,1);
evidence=observeTaskTool(evidence,{call:call('local.files_apply_patch',{path:'src/a.js'}),
  result:{isError:false},step:3,verified:{kind:'edit',path:'src/a.js',sha256:'a'.repeat(64),step:3}}).progress;
assert.equal(evidence.verifiedChecks.length,0,'changing a file invalidates prior passing checks');
assert.equal(evidence.gitReviews.length,0,'changing a file invalidates the prior Git review');
assert.equal(evidence.verifiedFiles.length,1,'only the freshly proven revision remains');
assert.equal(evidence.invalidatedEvidence,2);
const failedMutation=observeTaskTool(evidence,{call:call('local.write_file',{path:'src/b.js'}),
  result:{isError:true},step:4}).progress;
assert.equal(failedMutation.verifiedFiles.length,0,'an errored mutation may have taken effect');
assert.equal(failedMutation.invalidatedEvidence,3);
const freshCheck=observeTaskTool(failedMutation,{call:call('local.run_command',{command:'node --test'}),
  result:{isError:false},step:5,verified:{kind:'verify',id:'check-b',step:5}}).progress;
const deniedMutation=observeTaskTool(freshCheck,{call:call('local.write_file',{path:'src/b.js'}),
  result:{isError:true,executed:false},step:6}).progress;
assert.equal(deniedMutation.verifiedChecks.length,1,'a tool conclusively not executed cannot stale a passing check');
assert.match(progressCheckpoint(deniedMutation),/Invalidated stale evidence/);

const pollCall=call('desktop-commander.get_process_output',{pid:123});
p=createTaskProgress();
for(let i=0;i<25;i++) {
  const poll=observeTaskTool(p,{call:pollCall,result:{content:[{text:'still running'}]}});
  assert.equal(poll.stalled,false,'legitimate process polling is never marked stalled');
  p=poll.progress;
}
assert.equal(p.noProgress,0);
assert.equal(createTaskProgress({...p,noProgress:7},{newRun:true}).noProgress,0,'a new run resets consecutive stagnation');
assert.equal(createTaskProgress({...p,inspected:Array(100).fill('x')}).inspected.length,24);

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-stall-'));
try {
  let modelCalls=0, toolCalls=0;
  const manager={
    secrets:[],generation:1,instanceId:'stall-fixture',locked:false,
    state(){return {workspace:{path:root},generation:1,instanceId:this.instanceId};},
    acquireTask(){if(this.locked)return false;this.locked=true;return true;},
    releaseTask(){this.locked=false;},
    async createAgentSession(){return {
      catalog:{tools:[{name:'desktop-commander.list_directory',server:'desktop-commander',inputSchema:{type:'object'}}],prompts:[],resources:[],resourceTemplates:[],servers:{}},
      async close(){},
      async callTool(name,args,{onDecision}={}) {
        assert.equal(name,'desktop-commander.list_directory');
        toolCalls++;
        await onDecision?.({name,category:'read',allowed:true});
        return successful;
      },
    };},
  };
  const provider={
    snapshot:()=>({provider:'fixture',model:'fixture'}),ready:()=>true,
    async respond({input}) {
      modelCalls++;
      const output=[{type:'function_call',call_id:'call-'+modelCalls,name:'mcp_call',status:'completed',arguments:JSON.stringify({name:'desktop-commander.list_directory',arguments_json:JSON.stringify({path:root})})}];
      return {status:'completed',usage:{input_tokens:1,output_tokens:1},output};
    },
  };
  const runner=new AgentRunner({manager,provider,taskDirectory:path.join(root,'tasks')});
  await runner.load();
  const job=await runner.start({prompt:'Inspect the project until finished.'});
  const task=await Promise.race([
    runner.context.done.promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('stagnation test timeout')),6000)),
  ]);
  assert.equal(task.status,'failed');
  assert.equal(task.errorCode,'progress_stalled');
  assert.equal(toolCalls,NO_PROGRESS_LIMIT+1);
  assert.equal(modelCalls,toolCalls);
  assert.equal(task.progress.noProgress,NO_PROGRESS_LIMIT);
  assert.ok(task.events.some(x=>x.type==='progress_warning'));
  assert.ok(task.events.some(x=>x.type==='progress_stalled'));
  const loaded=new AgentRunner({manager,provider,taskDirectory:path.join(root,'tasks')});
  await loaded.load();
  assert.equal(loaded.get(job.id).progress.noProgress,NO_PROGRESS_LIMIT,'progress must survive restart');
  assert.match(await loaded.report(job.id),/TIẾN ĐỘ CÓ BẰNG CHỨNG/);
  await runner.shutdown();
  await loaded.shutdown();
  console.log('PASS bounded repeated inspections, legitimate polling, restart-safe checkpoint and stalled agent termination');
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
