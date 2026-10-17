// End-to-end lifecycle test with scripted providers plus independent host evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AgentRunner } from '../lib/agent.mjs';
import { createTaskProgress, observeTaskTool } from '../lib/agent-progress.mjs';
import { decomposeCodingTask, evidenceReport, planInstructions, recoveryInstructions, updateGoalPlan, verifyHostEvidence, assessCompletionEvidence, classifyTaskCompletion } from '../lib/agent-autonomy.mjs';

const sha=(s)=>createHash('sha256').update(s).digest('hex');
const call=(name,args={})=>({name:'mcp_call',arguments:JSON.stringify({name,arguments_json:JSON.stringify(args)})});
const result=(content,structuredContent={})=>({isError:false,content:[{type:'text',text:content}],structuredContent});
const objective='Đọc tài liệu và phân tích luồng coding agent trong workspace để xác định chức năng còn thiếu; '+
  'sau đó sửa file mã nguồn có liên quan bằng thay đổi nhỏ và có SHA kiểm chứng; '+
  'tiếp theo chạy các bài kiểm thử thật, đối chiếu kết quả và báo cáo những hạn chế còn tồn tại.';
assert.equal(decomposeCodingTask('Liệt kê 5 file đầu tiên.'),null,'simple requests must not be decomposed');
const plan=decomposeCodingTask(objective);
assert.ok(plan && plan.objectives.length>=2 && plan.phases.some(p=>p.id==='edit') && plan.phases.some(p=>p.id==='verify'));
assert.match(planInstructions(plan),/Work one bounded objective/);
assert.ok(plan.objectives.every(o=>Array.isArray(o.acceptanceCriteria)&&o.acceptanceCriteria.length>=1));
assert.deepEqual(plan.objectives[0].dependsOn,[]);
if(plan.objectives.length>1)assert.deepEqual(plan.objectives[1].dependsOn,['objective-1']);
assert.equal(updateGoalPlan(plan,{kind:'edit'}).objectives[0].status,'working','host receipt must not satisfy objective automatically');
assert.equal(plan.phases[0].status,'working');
assert.equal(assessCompletionEvidence(plan,{verifiedFiles:[],verifiedChecks:[],gitReviews:[]}).ready,false);
assert.equal(assessCompletionEvidence(null,{}).ready,true);
assert.equal(classifyTaskCompletion(null,{}).verification,'not_applicable','read-only simple tasks do not need test receipts');
assert.equal(classifyTaskCompletion(plan,{}).requirements,'unverified');
assert.equal(classifyTaskCompletion(plan,{verifiedFiles:[{}],verifiedChecks:[{}],gitReviews:[{}]}).requirements,'unverified',
  'generic receipt categories do not certify unrelated user objectives');
assert.equal(assessCompletionEvidence(plan,{verifiedFiles:[{}],verifiedChecks:[{}],gitReviews:[{}]}).ready,true);
let stale=createTaskProgress();
for(const [name,verified] of [
  ['local.edit_file',{kind:'edit',path:'src/a.js',sha256:'b'.repeat(64),step:1}],
  ['local.run_command',{kind:'verify',id:'check-a',step:2}],
  ['local.git_diff',{kind:'review',id:'diff-a',step:3}],
]){
  stale=observeTaskTool(stale,{call:call(name,{path:'src/a.js'}),result:result('observed'),step:verified.step,verified}).progress;
}
assert.equal(assessCompletionEvidence(plan,stale).ready,true);
stale=observeTaskTool(stale,{call:call('local.edit_file',{path:'src/a.js'}),result:result('new version'),step:4,
  verified:{kind:'edit',path:'src/a.js',sha256:'c'.repeat(64),step:4}}).progress;
assert.equal(assessCompletionEvidence(plan,stale).ready,false,'later repair invalidates older passing check and diff');
assert.ok(assessCompletionEvidence(plan,stale).missing.length>=2);
const updatedPlan=updateGoalPlan(plan,{kind:'edit'});
assert.equal(updatedPlan.evidence.edit,1);
assert.equal(plan.evidence.edit,0,'plan transition must not mutate previous snapshots');

let p=createTaskProgress();
const empty=result('No matching symbols',{count:0});
for(let i=0;i<11;i++){
  const n=i%2===0?'local.find_files':'local.search_files';
  const r=observeTaskTool(p,{call:call(n,{query:i%2?'login permissions':'permissions login'}),result:empty,step:i+1});
  p=r.progress;
  if(i===4)assert.equal(r.recover,1,'semantic inspection repetition should trigger first recovery');
  if(i===7)assert.equal(r.recover,2,'semantic repetition should trigger second recovery');
  if(i===10)assert.equal(r.stalled,true,'cycling equivalent read/search results must end');
}
assert.equal(p.noProgress,10);
assert.equal(p.recoveryAttempts,2);
assert.match(recoveryInstructions({progress:p,plan,attempt:2}),/Final recovery attempt/);
assert.equal(p.semanticFingerprints.length,1,'synonyms and reordered queries share the same evidence fingerprint');
assert.equal(evidenceReport(p,plan).verifiedEvidence.verifiedFiles,0);

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-goal-aware-'));
const code=path.join(root,'calc.js');
const initial='export const add=(a,b)=>a-b;\n',fixed='export const add=(a,b)=>a+b;\n';
await fs.writeFile(code,initial);
const fakeRead=async({file})=>{
  assert.equal(file,'calc.js');
  const body=await fs.readFile(code);
  return {path:'calc.js',sha256:sha(body),content:body.toString('utf8')};
};
const backend={backend:'local',studio:{read:fakeRead}};
const signed=result('Changed calc.js',{path:'calc.js',previousSha:sha(initial),sha256:sha(fixed)});
assert.equal(await verifyHostEvidence({manager:backend,name:'local.edit_file',result:signed}),null,
  'a claim without the changed file on disk is not evidence');
await fs.writeFile(code,fixed);
assert.equal((await verifyHostEvidence({manager:backend,name:'local.edit_file',result:signed})).kind,'edit');
assert.equal(await verifyHostEvidence({manager:{...backend,backend:'mcp'},name:'local.edit_file',result:signed}),null,
  'an external MCP server cannot fabricate local verification');
assert.equal(await verifyHostEvidence({manager:backend,name:'local.edit_file',result:result('unchanged',{...signed.structuredContent,unchanged:true})}),null);
assert.equal(await verifyHostEvidence({manager:backend,name:'local.run_command',result:result('no-op',{kind:'execute',exitCode:0})}),null);
assert.equal((await verifyHostEvidence({manager:backend,name:'local.run_command',result:result('passed',{kind:'verify',exitCode:0})})).kind,'verify');
assert.equal(await verifyHostEvidence({manager:backend,name:'local.run_command',result:result('failed',{kind:'verify',exitCode:1})}),null);
assert.equal((await verifyHostEvidence({manager:backend,name:'local.git_diff',result:result('diff',{diff:'diff --git a/calc.js b/calc.js',truncated:false})})).kind,'review');
await fs.writeFile(code,initial);

let savedPlan=null, locked=false,modelTurns=0;
const manager={
  backend:'local',secrets:[],instanceId:'goal-test',generation:1,
  state(){return {workspace:{path:root},generation:this.generation,instanceId:this.instanceId};},
  acquireTask(){if(locked)return false;locked=true;return true;},
  releaseTask(){locked=false;},
  studio:{
    async checks(){return {suggested:[]};},
    read:fakeRead,
    async plan({operation,items,title}) {
      if(operation==='set')savedPlan={title,items};return savedPlan;
    },
  },
  async createAgentSession(){return {
    catalog:{tools:['read_file','edit_file','run_command'].map(name=>({
      name:'local.'+name,originalName:name,server:'local',inputSchema:{type:'object'}})),
      prompts:[],resources:[],resourceTemplates:[],servers:{}},
    async close(){},
    async callTool(name,args,{onDecision}={}){
      if(name==='local.read_file'){
        await onDecision?.({name,allowed:true,category:'read'});
        return result('calc.js inspected',{path:'calc.js',sha256:sha(await fs.readFile(code)),start:1,end:1});
      }
      if(name==='local.edit_file'){
        await onDecision?.({name,allowed:true,category:'workspace_edit'});
        const prev=sha(await fs.readFile(code));await fs.writeFile(code,fixed);
        return result('File updated',{path:'calc.js',previousSha:prev,sha256:sha(fixed)});
      }
      if(name==='local.run_command'){
        await onDecision?.({name,allowed:true,category:'verify',kind:'verify'});
        return result('PASS tests',{kind:'verify',exitCode:0,timedOut:false,cancelled:false,
          truncated:{stdout:false,stderr:false}});
      }
      throw new Error('Unexpected model tool: '+name);
    },
  };},
};
const responses=[
  ['read_file',{path:'calc.js'}],
  ['edit_file',{path:'calc.js'}],
  ['run_command',{command:'node --test tests/calc.test.mjs'}],
];
const provider={
  ready:()=>true,snapshot:()=>({provider:'fixture',model:'scripted'}),
  async respond({input,instructions,beforeModelRequest}){
    beforeModelRequest?.();
    modelTurns++;
    if(modelTurns===1){
      assert.match(instructions,/HOST-PROPOSED TASK DECOMPOSITION/);
      assert.equal(input.at(-1).content[0].text,objective,'first user message is unchanged');
    }
    const next=responses[modelTurns-1];
    return {status:'completed',usage:{input_tokens:1,output_tokens:1},output:next?
      [{type:'function_call',call_id:'call'+modelTurns,name:next[0],arguments:JSON.stringify(next[1]),status:'completed'}]:
      [{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Change made and tested.'}]}]};
  },
};
try{
  const runner=new AgentRunner({manager,provider,taskDirectory:path.join(root,'tasks')});
  await runner.load();
  const started=await runner.start({prompt:objective,maxSteps:12});
  const finished=await Promise.race([runner.context.done.promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('lifecycle timeout')),9000))]);
  assert.equal(finished.status,'completed',finished.error);
  assert.ok(savedPlan?.items?.length>=3,'decomposition must be persisted in Studio Plan');
  assert.equal(finished.goalPlan.evidence.edit,1);
  assert.equal(finished.goalPlan.evidence.verify,1);
  assert.equal(finished.progress.verifiedFiles.length,1);
  assert.equal(finished.progress.verifiedChecks.length,1);
  assert.equal(finished.usage.httpRequests,4,'count all actual model transport sends, not just tool calls');
  assert.equal(finished.usage.inputUsageReported,4);
  assert.equal(finished.usage.inputUsageMissing,0);
  assert.equal(finished.verificationOutcome.ready,false,'missing Git diff evidence is not silently certified');
  assert.equal(finished.status,'completed','execution answered normally');
  assert.equal(finished.completionOutcome.requirements,'unverified','answer is not requirement acceptance');
  assert.equal(finished.completionOutcome.verification,'missing_evidence');
  assert.ok(finished.completionOutcome.unresolvedObjectiveIds.length>0);
  assert.match(finished.finalText,/NOT independently verified full completion/);
  assert.equal(await fs.readFile(code,'utf8'),fixed);
  assert.ok(finished.events.some(e=>e.type==='goal_decomposed'));
  assert.ok(finished.events.some(e=>e.type==='goal_evidence'));
  assert.match(await runner.report(started.id),/KẾ HOẠCH & BẰNG CHỨNG/);
  const restored=new AgentRunner({manager,provider,taskDirectory:path.join(root,'tasks')});
  await restored.load();
  assert.equal(restored.get(started.id).progress.verifiedFiles[0].sha256,sha(fixed));
  assert.equal(restored.get(started.id).goalPlan.evidence.verify,1);
  await restored.shutdown();await runner.shutdown();

  // With different search tool names and shuffled query words, the runtime
  // must give at most two strategic retries, preserve function-call pairs,
  // then stop with a resumable checkpoint instead of spinning indefinitely.
  let turns=0;
  const searchManager={...manager,studio:undefined,
    async createAgentSession(){return {
      catalog:{tools:['search_files','find_files'].map(name=>({name:'local.'+name,originalName:name,
        server:'local',inputSchema:{type:'object'}})),prompts:[],resources:[],resourceTemplates:[],servers:{}},
      async close(){},
      async callTool(){return empty;},
    };},
  };
  const searchProvider={snapshot:provider.snapshot,ready:provider.ready,
    async respond({input}){
      turns++;
      if(turns===6){
        const entries=input.filter(x=>x.type==='function_call_output');
        assert.equal(entries.length,5,'recovery must follow a fully paired tool result');
      }
      const n=turns%2?'search_files':'find_files';
      return {status:'completed',output:[{type:'function_call',call_id:'search-'+turns,
        name:n,arguments:JSON.stringify({query:turns%2?'permissions login':'login permissions'}),status:'completed'}]};
    },
  };
  const looping=new AgentRunner({manager:searchManager,provider:searchProvider,taskDirectory:path.join(root,'loop-tasks')});
  await looping.load();
  const startedLoop=await looping.start({prompt:objective});
  const end=await Promise.race([looping.context.done.promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('loop timeout')),9000))]);
  assert.equal(end.status,'failed');
  assert.equal(end.usage.inputUsageMissing,11,'responses without usage cannot be reported as zeros');
  assert.equal(end.usage.inputUsageReported,0);
  assert.equal(end.errorCode,'progress_stalled');
  assert.equal(end.progress.recoveryAttempts,2);
  assert.ok(end.events.some(e=>e.type==='progress_warning'));
  assert.ok(end.events.some(e=>e.type==='progress_recovery'));
  assert.ok(end.events.some(e=>e.type==='progress_stalled'));
  assert.equal(turns,11);
  assert.equal(looping.get(startedLoop.id).progress.noProgress,10);
  await looping.shutdown();
  console.log('PASS goal decomposition, trust-boundary receipts, semantic cycling, bounded adaptive recovery, durable resume');
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
