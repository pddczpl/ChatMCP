import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { NO_PROGRESS_LIMIT, createTaskProgress, observeTaskTool, observeTree, progressCheckpoint, receiptFreshness, receiptSummary, treeKey } from '../lib/agent-progress.mjs';

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

// Receipts are bound to the workspace tree they were made on (plan task pod-18, docs/PROOF-RECEIPTS.md): a receipt is fresh while its tree is the latest tree
// the Hub knows, stale once a later tree differs, and of unknown freshness when either tree is not known. verifiedInspections, verifiedFiles, verifiedChecks
// and gitReviews are the fresh receipts of each kind; the receipts themselves stay, stale or not.
{
  const T=(c)=>({status:'ok',treeAlgorithm:'git-pinned-v1',objectFormat:'sha1',tree:c.repeat(40),rawTree:null});
  const K=(c)=>treeKey(T(c));
  const proof=(before,after,extra={})=>({treeBefore:before===null?{status:'failed'}:T(before),treeAfter:after===null?{status:'failed'}:T(after),overlapped:false,changed:before!==after,...extra});
  const held=(value)=>[value.verifiedInspections.length,value.verifiedFiles.length,value.verifiedChecks.length,value.gitReviews.length];
  // (premise) the tree key: only a tree id of a known algorithm counts, and the algorithm and object format are part of it.
  assert.equal(K('a'),'git-pinned-v1:sha1:'+'a'.repeat(40));
  assert.equal(treeKey({status:'failed',engineReason:'snapshot_failed'}),null,'a failed snapshot has no tree');
  assert.equal(treeKey({status:'unbounded',treeAlgorithm:null,objectFormat:'sha1',tree:null}),null,'an unbounded one has none either');
  assert.equal(treeKey({...T('a'),tree:'not hex'}),null);
  assert.equal(treeKey({...T('a'),treeAlgorithm:'raw-v1'})===K('a'),false,'two algorithms are never the same tree');
  assert.equal(treeKey(null),null);
  assert.deepEqual([receiptFreshness({tree:K('a')},K('a')),receiptFreshness({tree:K('a')},K('b')),receiptFreshness({tree:null},K('a')),receiptFreshness({tree:K('a')},null)],
    ['fresh','stale','unknown','unknown'],'fresh on the same tree, stale on another, unknown when either is not known');

  // read on tree a, edit a->b, a passing check on b, the diff on b: every receipt is fresh on b.
  const routed=(name,args={})=>call(name,args);
  let state=observeTree(createTaskProgress(),T('a'));
  assert.equal(state.tree,K('a'),'the start tree is the current tree');
  state=observeTaskTool(state,{call:routed('local.read_file',{path:'a.js'}),result:{isError:false},step:1,verified:{kind:'inspect',path:'a.js',sha256:'1'.repeat(64),step:1,tree:K('a')}}).progress;
  assert.deepEqual(held(state),[1,0,0,0]);
  state=observeTaskTool(state,{call:routed('local.edit_file',{path:'a.js'}),result:{isError:false},step:2,proof:proof('a','b'),scanned:true,verified:{kind:'edit',path:'a.js',sha256:'2'.repeat(64),step:2,tree:K('b')}}).progress;
  assert.equal(state.tree,K('b'),'the tree after a call is the current tree');
  assert.deepEqual(held(state),[0,1,0,0],'the read was made on a: stale on b');
  state=observeTaskTool(state,{call:routed('local.run_command',{command:'npm test'}),result:{isError:false},step:3,proof:proof('b','b'),scanned:true,verified:{kind:'verify',id:'check-a',step:3,tree:K('b')}}).progress;
  state=observeTaskTool(state,{call:routed('local.git_diff',{}),result:{isError:false},step:4,verified:{kind:'review',id:'diff-a',step:4,tree:K('b')}}).progress;
  assert.deepEqual(held(state),[0,1,1,1],'edit, check and review are fresh on b');
  assert.equal(state.receipts.length,4,'the stale read is kept as a receipt');
  assert.deepEqual(receiptSummary(state),{tree:true,fresh:3,stale:1,unknown:0});
  assert.ok(state.verifiedChecks.every((r)=>r.tree===K('b')),'a projection holds the receipts themselves, with their tree');

  // Whatever its name, a call whose trees say the files did not change leaves every receipt fresh; one whose trees changed makes them stale.
  for(const name of ['local.write_file','local.move_path','desktop-commander.write_file','local.delete_path','some_server.anything']){
    assert.deepEqual(held(observeTaskTool(state,{call:routed(name,{path:'x'}),result:{isError:false},step:5,proof:proof('b','b'),scanned:true}).progress),[0,1,1,1],`${name} that changed nothing leaves them`);
  }
  for(const name of ['local.move_path','local.run_command','local.git_checkout','local.read_file','some_server.anything']){
    const after=observeTaskTool(state,{call:routed(name,{source:'a.js',destination:'b.js'}),result:{isError:false},step:5,proof:proof('b','c'),scanned:true}).progress;
    assert.deepEqual(held(after),[0,0,0,0],`${name} that changed the tree makes them stale`);
    assert.deepEqual(receiptSummary(after),{tree:true,fresh:0,stale:4,unknown:0});
  }
  // A change the Hub saw only in the tree BEFORE a later call (made outside a scanned call): the tree after that call is the current tree.
  assert.deepEqual(held(observeTaskTool(state,{call:routed('local.run_command',{}),result:{isError:false},step:5,proof:proof('c','c'),scanned:true}).progress),[0,0,0,0],'a change between calls makes them stale too');
  // An errored call is judged by its trees, like any other.
  assert.deepEqual(held(observeTaskTool(state,{call:routed('local.move_path',{}),result:{isError:true},step:5,proof:proof('b','c'),scanned:true}).progress),[0,0,0,0],'a call that failed after it changed the files');
  assert.deepEqual(held(observeTaskTool(state,{call:routed('local.move_path',{}),result:{isError:true},step:5,proof:proof('b','b'),scanned:true}).progress),[0,1,1,1],'a call that failed and changed nothing');
  // No trees for a call of a category that can change files (checks-only, the service disabled, a snapshot that failed): the current tree is unknown, so is every freshness.
  for(const [label,observed] of [
    ['no proof',{scanned:true}],['the snapshot after failed',{proof:proof('b',null),scanned:true}],
  ]){
    const after=observeTaskTool(state,{call:routed('local.move_path',{}),result:{isError:false},step:5,...observed}).progress;
    assert.equal(after.tree,null,`${label}: the current tree is unknown`);
    assert.deepEqual(held(after),[0,0,0,0],`${label}: nothing is fresh`);
    assert.deepEqual(receiptSummary(after),{tree:false,fresh:0,stale:0,unknown:4},`${label}: and nothing is stale either: unknown`);
  }
  assert.deepEqual(held(observeTaskTool(state,{call:routed('local.move_path',{}),result:{isError:true,executed:false},step:5,scanned:true}).progress),[0,1,1,1],'a call that never ran changes nothing');
  assert.deepEqual(held(observeTaskTool(state,{call:routed('local.read_file',{}),result:{isError:false},step:5,scanned:false}).progress),[0,1,1,1],'a call of a category that cannot change files leaves the tree');
  // An unknown tree becomes known again with the next call's trees: the receipts of that tree are fresh again.
  const unknown=observeTaskTool(state,{call:routed('local.move_path',{}),result:{isError:false},step:5,scanned:true}).progress;
  assert.deepEqual(held(observeTaskTool(unknown,{call:routed('local.run_command',{}),result:{isError:false},step:6,proof:proof('b','b'),scanned:true}).progress),[0,1,1,1]);

  // A receipt without a tree (made where the Hub had none) is never fresh.
  const blind=observeTaskTool(observeTree(createTaskProgress(),T('a')),{call:routed('local.run_command',{}),result:{isError:false},step:1,verified:{kind:'verify',id:'check-x',step:1,tree:null}}).progress;
  assert.deepEqual([held(blind),receiptSummary(blind)],[[0,0,0,0],{tree:true,fresh:0,stale:0,unknown:1}],'a receipt of unknown freshness is not fresh');
  assert.equal(observeTaskTool(blind,{call:routed('local.run_command',{}),result:{isError:false},step:2,verified:{kind:'verify',id:'check-y',step:2,tree:'git-pinned-v1:sha1:zz'}}).progress.receipts.at(-1).tree,null,'a tree that is not a tree key is dropped');
  // A batch write: one receipt per file, all on the tree after the batch.
  const batch=observeTaskTool(state,{call:routed('local.files_write_batch',{}),result:{isError:false},step:7,proof:proof('b','d'),scanned:true,
    verified:{kind:'edit',path:'r1.txt',sha256:'3'.repeat(64),step:7,tree:K('d'),more:[{path:'r2.txt',sha256:'4'.repeat(64),step:7},{path:'r3.txt',sha256:'5'.repeat(64),step:7}]}}).progress;
  assert.deepEqual(batch.verifiedFiles.map((r)=>[r.path,r.tree]),[['r1.txt',K('d')],['r2.txt',K('d')],['r3.txt',K('d')]],'every file of a batch is a fresh receipt on the tree after it');
  assert.deepEqual(held(batch),[0,3,0,0],'and the earlier check and diff are stale');
  // A check whose own trees differ changed the files it checked: counted, and the loop gives it no receipt (verifyHostEvidence).
  assert.equal(observeTaskTool(state,{call:routed('local.run_command',{command:'npm test'}),result:{isError:false},step:8,proof:proof('b','e'),scanned:true}).progress.checksChangedTree,1);
  assert.equal(observeTaskTool(state,{call:routed('local.edit_file',{}),result:{isError:false},step:8,proof:proof('b','e'),scanned:true}).progress.checksChangedTree,0,'an edit is not a check');

  // Saved, loaded and run again: the receipts and the tree survive a reload; a new run does not know the tree until it is told it.
  const saved=JSON.parse(JSON.stringify(state));
  assert.deepEqual(held(createTaskProgress(saved)),[0,1,1,1],'a reload keeps the freshness');
  saved.verifiedChecks=[];saved.verifiedFiles=[{kind:'edit',step:99,path:'forged.js',sha256:'f'.repeat(64),tree:K('b')}];
  assert.deepEqual(createTaskProgress(saved).verifiedFiles.map((r)=>r.path),['a.js'],'the projections are made again from the receipts, never read from the file');
  const next=createTaskProgress(state,{newRun:true});
  assert.equal(next.tree,null,'a new run starts with no current tree');
  assert.deepEqual(held(next),[0,0,0,0]);
  assert.deepEqual(held(observeTree(next,T('b'))),[0,1,1,1],'its start tree is the tree they were made on: fresh again');
  assert.deepEqual(held(observeTree(next,T('9'))),[0,0,0,0],'another start tree: stale');
  assert.deepEqual(held(observeTree(next,{status:'failed'})),[0,0,0,0],'no start tree: unknown');
  // A task saved by an older version: its receipts load, without a tree, and are of unknown freshness.
  const old=createTaskProgress({version:1,verifiedInspections:[{kind:'inspect',step:1,path:'a.js',sha256:'1'.repeat(64)}],verifiedFiles:[{kind:'edit',step:2,path:'a.js',sha256:'2'.repeat(64)}],
    verifiedChecks:[{kind:'verify',step:3,id:'check-a'}],gitReviews:[{kind:'review',step:4,id:'diff-a'}],invalidatedEvidence:2});
  assert.deepEqual(old.receipts.map((r)=>[r.kind,r.step,r.tree]),[['inspect',1,null],['edit',2,null],['verify',3,null],['review',4,null]]);
  assert.deepEqual([held(old),receiptSummary(old)],[[0,0,0,0],{tree:false,fresh:0,stale:0,unknown:4}],'an old task: four receipts, freshness unknown');
  assert.match(progressCheckpoint(old),/freshness unknown: 4/);
  // Lists without `receipts` are an older version's, whatever is written in them: a tree in them is not believed.
  assert.deepEqual(held(createTaskProgress({version:1,tree:K('a'),verifiedChecks:[{kind:'verify',step:3,id:'check-a',tree:K('a')}]})),[0,0,0,0],'an old list never yields a fresh receipt');
  // A receipt observed twice in a row is kept once; the count of checks that changed the files is saved.
  const twice=observeTaskTool(state,{call:routed('local.git_diff',{}),result:{isError:false},step:4,verified:{kind:'review',id:'diff-a',step:4,tree:K('b')}}).progress;
  assert.equal(twice.receipts.length,state.receipts.length,'the same receipt again is not a second receipt');
  const changedCheck=observeTaskTool(state,{call:routed('local.run_command',{command:'npm test'}),result:{isError:false},step:8,proof:proof('b','e'),scanned:true}).progress;
  assert.equal(createTaskProgress(JSON.parse(JSON.stringify(changedCheck))).checksChangedTree,1,'the count survives a reload');
  assert.equal(observeTree(state,{status:'failed'}).tree,null,'a start tree that failed makes a known tree unknown');
  // At most 24 receipts of each kind are kept.
  let many=observeTree(createTaskProgress(),T('a'));
  for(let i=1;i<=30;i++)many=observeTaskTool(many,{call:routed('local.run_command',{n:i}),result:{isError:false},step:i,proof:proof('a','a'),scanned:true,verified:{kind:'verify',id:'check-'+i,step:i,tree:K('a')}}).progress;
  many=observeTaskTool(many,{call:routed('local.read_file',{}),result:{isError:false},step:31,verified:{kind:'inspect',path:'a.js',sha256:'1'.repeat(64),step:31,tree:K('a')}}).progress;
  assert.deepEqual([many.verifiedChecks.length,many.verifiedChecks[0].step,many.verifiedInspections.length],[24,7,1],'the 24 latest checks, and the other kinds are not pushed out');
  // What the model is told counts the receipts by freshness and never names a tree.
  const told=progressCheckpoint(state);
  assert.match(told,/fresh on the latest tree: 3; stale: 1; freshness unknown: 0/);
  assert.ok(!told.includes('a'.repeat(40))&&!told.includes('b'.repeat(40)),'no tree id in the text the model reads');
}


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
