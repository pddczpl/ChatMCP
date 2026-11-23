// End-to-end lifecycle test with scripted providers plus independent host evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AgentRunner } from '../lib/agent.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { createTaskProgress, observeTaskTool, treeKey } from '../lib/agent-progress.mjs';
import { MISSING, decomposeCodingTask, evidenceReport, planInstructions, recoveryInstructions, updateGoalPlan, verifyHostEvidence, assessCompletionEvidence, classifyTaskCompletion } from '../lib/agent-autonomy.mjs';

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
// The completion is judged against the final tree (pod-18): a receipt counts only when it is fresh, i.e. made on the latest tree the Hub knows.
const T=(c)=>({status:'ok',treeAlgorithm:'git-pinned-v1',objectFormat:'sha1',tree:c.repeat(40),rawTree:null});
const K=(c)=>treeKey(T(c));
const on=(c,receipts)=>({version:1,tree:c===null?null:K(c),receipts});
const r=(kind,step,c)=>({kind,step,tree:c===null?null:K(c),...(kind==='edit'?{path:'src/a.js',sha256:'e'.repeat(64)}:{id:kind+'-'+step})});
const STALE=' on the final tree: its receipts are stale (the files changed after them)';
const UNKNOWN=' on the final tree: freshness unknown (the Hub has no tree to compare them with)';
assert.deepEqual(MISSING,{edit:'No independently SHA-verified file edit',verify:'No verified successful project check',review:'No independently recorded Git diff review'});
const none=assessCompletionEvidence(plan,on('a',[]));
assert.deepEqual([none.ready,none.missing,none.freshness],[false,[MISSING.edit,MISSING.verify,MISSING.review],'missing'],'no receipt at all');
const fresh=on('b',[r('inspect',1,'a'),r('edit',2,'b'),r('verify',3,'b'),r('review',4,'b')]);
assert.deepEqual([assessCompletionEvidence(plan,fresh).ready,assessCompletionEvidence(plan,fresh).missing,assessCompletionEvidence(plan,fresh).freshness],[true,[],'fresh'],'edit, check and review on the final tree');
// A later edit: the check and the diff were made on a tree that is gone.
const later=on('c',[...fresh.receipts,r('edit',5,'c')]);
assert.deepEqual([assessCompletionEvidence(plan,later).ready,assessCompletionEvidence(plan,later).missing,assessCompletionEvidence(plan,later).freshness],
  [false,[MISSING.verify+STALE,MISSING.review+STALE],'stale'],'later repair makes the older passing check and diff stale');
// A move after the passing check, with no edit receipt: nothing is fresh.
assert.deepEqual(assessCompletionEvidence(plan,on('c',fresh.receipts)).missing,[MISSING.edit+STALE,MISSING.verify+STALE,MISSING.review+STALE]);
// The Hub does not know the final tree (checks-only, the service disabled): unknown, never fresh.
const blind=assessCompletionEvidence(plan,on(null,fresh.receipts));
assert.deepEqual([blind.ready,blind.missing,blind.freshness],[false,[MISSING.edit+UNKNOWN,MISSING.verify+UNKNOWN,MISSING.review+UNKNOWN],'unknown'],'an unknown final tree certifies nothing');
assert.deepEqual(assessCompletionEvidence(plan,on('b',[r('edit',2,'b'),r('verify',3,null),r('review',4,'a')])).missing,[MISSING.verify+UNKNOWN,MISSING.review+STALE],'per kind: a receipt without a tree is unknown, one of another tree stale');
assert.equal(assessCompletionEvidence(plan,on('b',[r('edit',2,'b'),r('verify',3,null),r('review',4,'a')])).freshness,'unknown','unknown wins over stale: it could be fresh');
assert.deepEqual(assessCompletionEvidence(plan,on('b',[r('edit',2,'b'),r('verify',3,'a'),r('verify',5,null),r('review',6,'b')])).missing,[MISSING.verify+UNKNOWN],'within one kind too: a stale check and one of unknown tree say unknown');
assert.equal(assessCompletionEvidence(plan,on('b',[r('edit',2,'b'),r('verify',3,null),r('verify',6,'b'),r('review',4,'b')])).ready,true,'one fresh receipt of a kind is enough');
// A task saved by an older version: its receipts have no tree.
const old={version:1,verifiedFiles:[{kind:'edit',step:2,path:'a.js',sha256:'b'.repeat(64)}],verifiedChecks:[{kind:'verify',step:3,id:'check-a'}],gitReviews:[{kind:'review',step:4,id:'diff-a'}]};
assert.deepEqual([assessCompletionEvidence(plan,old).ready,assessCompletionEvidence(plan,old).freshness],[false,'unknown'],'an old task: freshness unknown, not ready');
assert.equal(assessCompletionEvidence(plan,{verifiedFiles:[{kind:'edit',step:2,tree:K('b')}],verifiedChecks:[{kind:'verify',step:3,id:'x',tree:K('b')}],gitReviews:[{kind:'review',step:4,id:'y',tree:K('b')}],tree:K('b'),version:1}).ready,false,'the lists are projections: they are never read as receipts');
// The final tree can be given: what pod-23's gate will judge against.
assert.deepEqual([assessCompletionEvidence(plan,fresh,{tree:T('9')}).ready,assessCompletionEvidence(plan,fresh,{tree:T('9')}).freshness],[false,'stale']);
assert.equal(assessCompletionEvidence(plan,fresh,{tree:{status:'failed'}}).freshness,'unknown');
assert.equal(assessCompletionEvidence(plan,on('9',fresh.receipts),{tree:T('b')}).ready,true);
assert.deepEqual([assessCompletionEvidence(null,{}).ready,assessCompletionEvidence(null,{}).freshness],[true,'not_applicable']);
assert.equal(classifyTaskCompletion(null,{}).verification,'not_applicable','read-only simple tasks do not need test receipts');
assert.equal(classifyTaskCompletion(null,{}).freshness,'not_applicable');
assert.equal(classifyTaskCompletion(plan,{}).requirements,'unverified');
assert.deepEqual([classifyTaskCompletion(plan,fresh).requirements,classifyTaskCompletion(plan,fresh).verification,classifyTaskCompletion(plan,fresh).freshness],
  ['unverified','evidence_present_not_objective_certified','fresh'],'generic receipt categories do not certify unrelated user objectives');
assert.deepEqual([classifyTaskCompletion(plan,later).verification,classifyTaskCompletion(plan,later).freshness],['missing_evidence','stale']);
assert.deepEqual([classifyTaskCompletion(plan,on('9',fresh.receipts),{tree:T('b')}).verification,classifyTaskCompletion(plan,on('9',fresh.receipts),{tree:T('b')}).freshness],['evidence_present_not_objective_certified','fresh'],'the final tree can be given to the completion too');
assert.deepEqual([classifyTaskCompletion(plan,on(null,fresh.receipts)).verification,classifyTaskCompletion(plan,on(null,fresh.receipts)).freshness],['missing_evidence','unknown']);
// What the model is told on a resume carries no tree: no receipt id (they hold a tree prefix), only kinds, steps, paths and freshness counts.
const report=JSON.stringify(evidenceReport(fresh,plan));
assert.ok(!report.includes('b'.repeat(12))&&!report.includes('a'.repeat(12)),'no tree id or prefix in the evidence report');
assert.deepEqual(evidenceReport(fresh,plan).verifiedEvidence,{verifiedFiles:1,verifiedChecks:1,gitReviews:1,freshness:{tree:true,fresh:3,stale:1,unknown:0}});
assert.match(recoveryInstructions({progress:fresh,plan,attempt:1}),/Fresh verified file changes: 1; fresh passing approved checks: 1\./,'the recovery text counts the fresh receipts of saved progress, not lists written in it');
assert.match(recoveryInstructions({progress:{...later,verifiedChecks:[{kind:'verify',step:3,id:'x',tree:K('c')}]},plan,attempt:1}),/fresh passing approved checks: 0\./,'a list written in saved progress is not read');

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
// The tree a receipt is bound to (pod-18). A check: its trees before and after must be the same tree, the one it is bound to; a check that changed the files it
// checked is unreliable and is no receipt (the strict pass rule of docs/PROOF-CHECKS.md). Without both trees, or with a call that overlapped another one, its tree is unknown.
{
  const trees=(b,a,extra={})=>({treeBefore:b===null?{status:'failed'}:T(b),treeAfter:a===null?{status:'failed'}:T(a),overlapped:false,...extra});
  const passing=result('passed',{kind:'verify',exitCode:0,timedOut:false,cancelled:false,truncated:{stdout:false,stderr:false}});
  const check=(proof,extra={})=>verifyHostEvidence({manager:backend,name:'local.run_command',result:passing,step:3,proof,...extra});
  assert.deepEqual([(await check(trees('a','a'))).kind,(await check(trees('a','a'))).tree],['verify',K('a')],'a check that left the tree is bound to it');
  assert.equal(await check(trees('a','b')),null,'a check that changed the files it checked is unreliable: no receipt');
  assert.equal((await check(trees('a','a',{overlapped:true}))).tree,null,'a check that ran beside another call: its tree is unknown');
  assert.equal((await check(trees('a',null))).tree,null,'no tree after it: unknown');
  assert.equal((await check(trees(null,'a'))).tree,null,'no tree before it: unknown');
  assert.equal((await check(null,{tree:K('a')})).tree,null,'no trees at all (checks-only): unknown, whatever the tree before it was');
  assert.equal(await verifyHostEvidence({manager:backend,name:'local.run_command',result:result('cut',{kind:'verify',exitCode:0,truncated:{stdout:true,stderr:false}}),proof:trees('a','a')}),null,'a cut output is no receipt');
  assert.equal(await verifyHostEvidence({manager:backend,name:'local.run_command',result:result('ran',{kind:'execute',exitCode:0}),proof:trees('a','a')}),null,'a command that is not a check is no receipt');
  // An edit is bound to the tree after it.
  await fs.writeFile(code,fixed);
  const edit=(proof)=>verifyHostEvidence({manager:backend,name:'local.edit_file',result:signed,step:2,proof,tree:K('a')});
  assert.equal((await edit(trees('a','b'))).tree,K('b'),'an edit: the tree after it');
  assert.equal((await edit(null)).tree,null,'an edit without trees: unknown, not the tree before it');
  assert.equal((await edit(trees('a','b',{overlapped:true}))).tree,null);
  // A read is not scanned (it cannot change files): bound to the current tree, the latest the Hub knows.
  const read=result('calc.js inspected',{path:'calc.js',sha256:sha(fixed)});
  assert.equal((await verifyHostEvidence({manager:backend,name:'local.read_file',result:read,step:1,tree:K('b')})).tree,K('b'));
  assert.equal((await verifyHostEvidence({manager:backend,name:'local.read_file',result:read,step:1,tree:null})).tree,null,'no current tree: unknown');
  assert.equal((await verifyHostEvidence({manager:backend,name:'local.read_file',result:read,step:1,tree:K('b'),proof:trees('b','c')})).tree,null,'a read whose own trees differ: unknown');
  assert.equal((await verifyHostEvidence({manager:backend,name:'local.read_file',result:read,step:1,tree:K('b'),proof:trees('c','c')})).tree,K('c'),'a read with trees of its own: that tree');
  await fs.writeFile(code,initial);
}
// The review receipt is made from what the REAL local git_diff returns, on a real repository. (This test once fed the verifier {diff:'...'}, a field that no tool returns: the receipt was
// never made in a real run, and every coding run ended with "No independently recorded Git diff review".)
{
  const repo=path.join(root,'diff-repo');
  await fs.mkdir(repo);
  const git=(...args)=>{
    const run=spawnSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','-c','core.autocrlf=false',...args],{cwd:repo,encoding:'utf8'});
    assert.equal(run.status,0,'git '+args.join(' ')+': '+run.stderr);
  };
  await fs.writeFile(path.join(repo,'calc.js'),initial);
  git('init','-q');git('add','-A');git('commit','-q','-m','initial');
  const state=path.join(root,'diff-state');
  const tools=new LocalTools({workspace:new StudioWorkspace({manager:{workspace:repo},directory:state}),stateDirectory:state});
  const diffOf=()=>tools.call('git_diff',{});
  const receiptOf=(taken,manager=backend)=>verifyHostEvidence({manager,name:'local.git_diff',result:taken,step:7,tree:K('d')});
  assert.equal(await receiptOf(await diffOf()),null,'a clean tree has nothing to review');
  await fs.writeFile(path.join(repo,'calc.js'),fixed);
  const taken=await diffOf();
  assert.equal(taken.isError,false,taken.content[0].text);
  assert.match(taken.content[0].text,/\+export const add=\(a,b\)=>a\+b;/,'(premise) the real tool returned the change');
  const review=await receiptOf(taken);
  assert.deepEqual([review?.kind,review?.step,review?.tree],['review',7,K('d')],'the diff of a real change is a review receipt, on the current tree');
  assert.match(review.id,/^[a-f0-9]{16}$/);
  await fs.writeFile(path.join(repo,'calc.js'),'export const add=(a,b)=>b+a;\n');
  assert.notEqual((await receiptOf(await diffOf())).id,review.id,'another change is another diff, so another receipt');
  assert.equal(await receiptOf(taken,{...backend,backend:'mcp'}),null,'an external MCP server cannot fabricate a review');
  assert.equal(await receiptOf({...taken,isError:true}),null,'a failed call is no review');
  assert.equal(await verifyHostEvidence({manager:backend,name:'local.git_log',result:taken,step:7}),null,'the digest means something only in the answer of git_diff');
  assert.equal(await receiptOf(result('diff',{diff:'diff --git a/calc.js b/calc.js',truncated:false})),null,'a result that carries a diff field of its own is no evidence: the tool does not vouch for it');
  assert.equal(await receiptOf(result('diff',{...taken.structuredContent,truncated:true})),null,'a diff the tool cut is no review');
  assert.equal(await receiptOf(result('diff',{...taken.structuredContent,diffSha256:'not a digest'})),null,'a digest that is none is no review');
  await fs.writeFile(path.join(repo,'calc.js'),Array.from({length:4000},(_,at)=>'export const line'+at+"='"+'x'.repeat(80)+"';").join('\n')+'\n');
  const long=await diffOf();
  assert.match(long.content[0].text,/Diff quá lớn nên đã bị cắt/,'(premise) the tool cut the long diff');
  assert.equal(await receiptOf(long),null,'a diff shown in part is no review');
}
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
  // The proof service's trees (lib/proof/service.mjs), as the real manager gives them: the run's start tree on the session, a scanned call's trees through onProof.
  async createAgentSession(){return {
    proofStart:T('1'),
    catalog:{tools:['read_file','edit_file','run_command'].map(name=>({
      name:'local.'+name,originalName:name,server:'local',inputSchema:{type:'object'}})),
      prompts:[],resources:[],resourceTemplates:[],servers:{}},
    async close(){},
    async callTool(name,args,{onDecision,onProof}={}){
      if(name==='local.read_file'){
        await onDecision?.({name,allowed:true,category:'read'});
        return result('calc.js inspected',{path:'calc.js',sha256:sha(await fs.readFile(code)),start:1,end:1});
      }
      if(name==='local.edit_file'){
        await onDecision?.({name,allowed:true,category:'workspace_edit'});
        const prev=sha(await fs.readFile(code));await fs.writeFile(code,fixed);
        await onProof?.({tool:name,outcome:'ok',changed:true,overlapped:false,treeBefore:T('1'),treeAfter:T('2'),granularity:'calls'});
        return result('File updated',{path:'calc.js',previousSha:prev,sha256:sha(fixed)});
      }
      if(name==='local.run_command'){
        await onDecision?.({name,allowed:true,category:'execute',kind:'verify'});
        await onProof?.({tool:name,outcome:'ok',changed:false,overlapped:false,treeBefore:T('2'),treeAfter:T('2'),granularity:'calls'});
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
  assert.deepEqual(finished.verificationOutcome.missing,[MISSING.review],'the edit and the check are fresh on the final tree: only the review is missing');
  assert.deepEqual([finished.progress.verifiedInspections.length,finished.progress.receipts.length],[0,3],'the read was made on the start tree, stale after the edit');
  assert.equal(finished.completionOutcome.freshness,'missing');
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
  // A delegated worker's first prompt is its goal followed by text the Hub wrote: a handoff of branch names, the predecessors' results (another model's output) and
  // the Hub's own instructions. start() takes the goal as selectionPrompt, and the host plan is made from it, as the skills and the tool schemas are. Made from the
  // whole prompt, the handoff was long enough to decompose every worker of a workflow: the Hub's sentences became "User-requested work units" of a plan with a verify
  // and a review phase, saved to the Studio plan, and the worker's answer was ended with "NOT independently verified full completion", whatever its goal. The model still
  // reads the whole prompt. The handoff is a copy of the Hub's text; verify-concurrent-chat-workspaces runs the code that writes it.
  {
    const GOAL='Summarize the findings in two sentences.';
    const handoff='\n\nWORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):\n'+
      'Predecessor 0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d (completed) branch=chatmcp/chat/0b1c2d3e-4f50 worktree=/hub/api-conversations/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/worktree\n'+
      'UNTRUSTED RESULT (independently verify before use):\nThe review found nothing to change.\n'+
      'Previous workers used independent worktrees. Changes are NOT automatically merged. Inspect source, diffs and run actual checks; do not claim prior edits are integrated or verified without evidence.';
    const BLOCK=/HOST-PROPOSED TASK DECOMPOSITION/,NOTICE=/NOT independently verified full completion/;
    assert.equal(decomposeCodingTask(GOAL),null,'(the premise: the goal alone is not decomposed)');
    assert.ok(decomposeCodingTask(GOAL+handoff),'(the premise: with the handoff the prompt is decomposed)');
    assert.ok(decomposeCodingTask(objective+handoff).objectives.some(o=>o.text.includes('WORKFLOW PREDECESSOR HANDOFF')),'(the premise: the handoff is among its objectives)');
    let conversations=0;
    // One conversation on a runner of its own: every model request is recorded with its instructions, and so is every plan saved to the Studio.
    const conversation=()=>{
      const requests=[],saved=[],taskDirectory=path.join(root,'delegated-'+(++conversations));
      let locked=false,id=null;
      const workerManager={...manager,
        acquireTask(){if(locked)return false;locked=true;return true;},releaseTask(){locked=false;},
        studio:{async checks(){return {suggested:[]};},read:fakeRead,async plan({operation,items,title}){if(operation==='set')saved.push({title,items});return {title,items};}},
        async createAgentSession(){return {catalog:{tools:[{name:'local.read_file',originalName:'read_file',server:'local',inputSchema:{type:'object'}}],
          prompts:[],resources:[],resourceTemplates:[],servers:{}},async close(){},async callTool(){return result('unused');}};},
      };
      const answering={ready:provider.ready,snapshot:provider.snapshot,async respond({input,instructions,beforeModelRequest}){
        beforeModelRequest?.();
        requests.push({instructions:String(instructions),input:structuredClone(input)});
        return {status:'completed',usage:{input_tokens:1,output_tokens:1},output:[{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Done.'}]}]};
      }};
      const runner=new AgentRunner({manager:workerManager,provider:answering,taskDirectory});
      // One message of the conversation: the first starts it, the others continue it. Resolves with the model requests that run made.
      const say=async(prompt,options={})=>{
        const before=requests.length;
        id=(id===null?await runner.start({prompt,...options,maxSteps:6}):await runner.continue({id,prompt,maxSteps:6})).id;
        // Until the run has released the workspace as well: a runner that starts after a restart takes the lock, and a run that has just finished still holds it.
        for(let i=0;i<1500&&(runner.get(id).status==='running'||runner.activeTaskId!==null);i++)await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(runner.get(id).status,'completed',runner.get(id).error);
        return requests.slice(before);
      };
      return {runner,requests,saved,say,workerManager,answering,taskDirectory,get id(){return id;}};
    };

    // A worker whose goal is short is not decomposed, nor is its next message, nor a long follow-up (the plan is made from the first prompt of the conversation),
    // nor after the Hub restarts. Each of these used to re-read the stored whole prompt.
    {
      const c=conversation();
      await c.runner.load();
      try{
        const [one]=await c.say(GOAL+handoff,{selectionPrompt:GOAL});
        const task=c.runner.get(c.id);
        assert.equal(task.goalPlan,null,'a worker whose goal is short has no plan, though its prompt is long');
        assert.doesNotMatch(one.instructions,BLOCK,'its instructions carry no decomposition');
        assert.equal(c.saved.length,0,'none is saved to the Studio plan');
        assert.ok(!task.events.some(event=>event.type==='goal_decomposed'),'and no goal_decomposed event is raised');
        assert.equal(task.finalText,'Done.','its answer does not end with a verification notice');
        assert.equal(task.completionOutcome.verification,'not_applicable','and the completion is assessed as for any short request');
        assert.equal(one.input.at(-1).content[0].text,GOAL+handoff,'the model still reads the whole prompt');
        const [two]=await c.say('ok');
        assert.equal(c.runner.get(c.id).goalPlan,null,'the worker\'s next message does not decompose the stored prompt');
        assert.doesNotMatch(two.instructions,BLOCK);
        assert.equal(c.runner.get(c.id).finalText,'Done.');
        const [three]=await c.say(objective);
        assert.equal(c.runner.get(c.id).goalPlan,null,'a long follow-up does not either: the plan is the first prompt\'s');
        assert.doesNotMatch(three.instructions,BLOCK);
        const restarted=new AgentRunner({manager:c.workerManager,provider:c.answering,taskDirectory:c.taskDirectory});
        await restarted.load();
        try{
          assert.equal(restarted.get(c.id).goalPlan,null,'a Hub that restarts does not decompose the stored prompt');
          await restarted.continue({id:c.id,prompt:'ok',maxSteps:6});
          for(let i=0;i<1500&&restarted.get(c.id).status==='running';i++)await new Promise(resolve=>setTimeout(resolve,10));
          assert.equal(restarted.get(c.id).goalPlan,null);
          assert.doesNotMatch(c.requests.at(-1).instructions,BLOCK,'nor does the first message after the restart');
        }finally{await restarted.shutdown();}
      }finally{await c.runner.shutdown();}
    }

    // A worker whose goal is long is decomposed as the same goal alone is: the objectives are the clauses of the goal, and the Studio plan is titled by it.
    {
      const withHandoff=conversation(),alone=conversation();
      await withHandoff.runner.load();await alone.runner.load();
      try{
        const [one]=await withHandoff.say(objective+handoff,{selectionPrompt:objective});
        await alone.say(objective);
        const planned=withHandoff.runner.get(withHandoff.id).goalPlan;
        assert.deepEqual(planned.objectives.map(o=>o.text),[
          'Đọc tài liệu và phân tích luồng coding agent trong workspace để xác định chức năng còn thiếu',
          'sau đó sửa file mã nguồn có liên quan bằng thay đổi nhỏ và có SHA kiểm chứng',
          'tiếp theo chạy các bài kiểm thử thật, đối chiếu kết quả và báo cáo những hạn chế còn tồn tại.',
        ],'the objectives are the clauses of the goal, none of the handoff');
        assert.deepEqual(planned,alone.runner.get(alone.id).goalPlan,'a worker with a predecessor is decomposed as the same goal alone');
        assert.match(one.instructions,BLOCK);
        assert.ok(one.instructions.includes(JSON.stringify(planned.goal)),'its instructions name the goal of the plan');
        assert.ok(!planned.goal.includes('WORKFLOW'),'which is the goal');
        assert.deepEqual(withHandoff.saved.map(plan=>plan.title),['Agent plan: '+planned.goal.slice(0,150)],'the Studio plan is titled by it');
        assert.deepEqual(withHandoff.saved[0].items,alone.saved[0].items);
      }finally{await withHandoff.runner.shutdown();await alone.runner.shutdown();}
    }

    // Without a selectionPrompt, or with one that is the prompt, null or blank, the plan is made from the whole prompt exactly as before: a worker without
    // predecessors has no handoff (its prompt is its goal), and a caller that composes text of its own is decomposed on it.
    {
      const whole=decomposeCodingTask(GOAL+handoff);
      for(const [label,options] of [['no selectionPrompt',{}],['a selectionPrompt that is the prompt',{selectionPrompt:GOAL+handoff}],['a null one',{selectionPrompt:null}],['a blank one',{selectionPrompt:'  \n '}]]){
        const c=conversation();
        await c.runner.load();
        try{
          const [one]=await c.say(GOAL+handoff,options);
          assert.deepEqual(c.runner.get(c.id).goalPlan,whole,`${label}: the plan of the whole prompt, as before`);
          assert.match(one.instructions,BLOCK,`${label}: and its instructions`);
          assert.match(c.runner.get(c.id).finalText,NOTICE,`${label}: and the notice that goes with it`);
          const [two]=await c.say('ok');
          assert.deepEqual(c.runner.get(c.id).goalPlan,whole,`${label}: the next message keeps it`);
          assert.match(two.instructions,BLOCK);
        }finally{await c.runner.shutdown();}
      }
    }
  }
  console.log('PASS goal decomposition, trust-boundary receipts, semantic cycling, bounded adaptive recovery, durable resume');
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
