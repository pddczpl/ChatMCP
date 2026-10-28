// Includes the owner's focused compaction suite and checks actual AgentRunner
// wiring. The canonical transcript and newest receipts must never be lost.
import './context-compaction.test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../lib/agent.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { compactConversationHistory, resolveEffectiveContextBudget } from '../lib/context-compaction.mjs';
import { GatewayProvider } from '../lib/gateway-provider.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { createPrimaryAgentRunner } from '../hub.mjs';
import { agentOptionsView } from '../lib/agent-options.mjs';

const fallback=resolveEffectiveContextBudget({instructions:'policy',tools:[{name:'probe'}]});
assert.equal(fallback.source,'conservative_fallback');
assert.equal(fallback.capacityTokens,32768);
assert.ok(fallback.maxHistoryTokens>0&&fallback.reservedOutputTokens>0);
const explicit=resolveEffectiveContextBudget({
  contextWindowTokens:8192,modelMetadataTokens:128000,
  instructions:'policy'.repeat(120),tools:[{name:'probe'}]});
assert.equal(explicit.source,'provider_configuration');
assert.equal(explicit.capacityTokens,8192);
assert.ok(explicit.maxHistoryTokens<fallback.maxHistoryTokens);
const metadata=resolveEffectiveContextBudget({modelMetadataTokens:100000});
assert.equal(metadata.source,'trusted_model_metadata');
assert.equal(metadata.capacityTokens,100000);

// Output policy. An unknown window is a planning estimate (32,768), not a fact: the request may still ask for the full default output
// (reasoning models spend it on hidden reasoning and end "incomplete" when it is small; v3.9.0 sent 18% of the estimate = 5,898), while
// the history is planned against a quarter of the estimate so that the tool schemas and a useful history still fit.
// F = about 8.2k tokens of instructions + tool schemas, what the real catalog costs in auto mode for a coding prompt (measured in
// the agent wiring test below).
const instructionsAbout1500Tokens='i'.repeat(Math.round(1500*3.8));
const toolsAbout6700Tokens=Array.from({length:30},(_,index)=>({type:'function',name:'tool_'+index,description:'d'.repeat(500),parameters:{type:'object',properties:{value:{type:'string'}}}}));
const unknownWindow=resolveEffectiveContextBudget({instructions:instructionsAbout1500Tokens,tools:toolsAbout6700Tokens});
assert.equal(unknownWindow.source,'conservative_fallback');
assert.equal(unknownWindow.capacityTokens,32768);
assert.equal(unknownWindow.reservedOutputTokens,16384,'the request may use the full default output when the window is unknown');
assert.equal(unknownWindow.plannedOutputTokens,8192,'but history is planned against min(16,384, capacity/4)');
assert.ok(unknownWindow.maxHistoryTokens>=8000,'an unknown window still leaves 8k tokens of history with a trimmed tool list ('+unknownWindow.maxHistoryTokens+')');
assert.equal(unknownWindow.maxHistoryTokens,32768-8192-unknownWindow.safetyMarginTokens-unknownWindow.fixedOverheadTokens);
// A known window is a fact: the cap IS the reservation, a quarter of the window up to the default output.
for(const [window,expected] of [[8192,2048],[16384,4096],[32768,8192],[65535,16383],[65536,16384],[200000,16384],[1000000,16384]]){
  const known=resolveEffectiveContextBudget({contextWindowTokens:window});
  assert.equal(known.source,'provider_configuration');
  assert.equal(known.reservedOutputTokens,expected,window+' tokens: output cap');
  assert.equal(known.plannedOutputTokens,expected,window+' tokens: planned output equals the cap when the window is known');
}
assert.equal(resolveEffectiveContextBudget({contextWindowTokens:4096}).reservedOutputTokens,1024,'never below 1,024');
assert.equal(resolveEffectiveContextBudget({modelMetadataTokens:100000,maxOutputTokens:4000}).reservedOutputTokens,4000,'a caller\'s smaller maximum is respected');
// One bound for every validator (lib/context-window.mjs): above the cap is clamped, not discarded; below the minimum is not a window.
const oversized=resolveEffectiveContextBudget({contextWindowTokens:5_000_000});
assert.deepEqual([oversized.source,oversized.capacityTokens],['provider_configuration',2_000_000]);
assert.equal(resolveEffectiveContextBudget({modelMetadataTokens:9_000_000}).capacityTokens,2_000_000);
assert.equal(resolveEffectiveContextBudget({contextWindowTokens:3000}).source,'conservative_fallback','a window below 4,096 is not used as a window');
assert.equal(resolveEffectiveContextBudget({contextWindowTokens:'64000'}).source,'conservative_fallback','only a number from the provider counts');
const big='output: '+('abcdefghijklmno'.repeat(950));
const sameCall={type:'function_call',call_id:'a',name:'git_status',arguments:'{}'};
const differing=[
  {role:'user',content:[{type:'input_text',text:'Check status'}]},
  sameCall,
  {type:'function_call_output',call_id:'a',output:big+' first'},
  {...sameCall,call_id:'b'},
  {type:'function_call_output',call_id:'b',output:big+' changed'},
];
const differ=compactConversationHistory(differing,{maxHistoryTokens:500,preserveRecentOutputs:1});
assert.equal(differ.stats.deduplicatedCount,0,
  'identical command args but changed Git output must NOT be deduplicated');
assert.equal(differing[4].output,big+' changed','latest receipt must be preserved');
assert.deepEqual(differing.filter(x=>x.type==='function_call_output').map(x=>x.call_id),['a','b']);

const image=[{type:'input_text',text:'Image inspection'},{type:'input_image',image_url:'data:image/png;base64,AA=='}];
const multimodal=[
  {type:'function_call',call_id:'i',name:'read_file',arguments:'{}'},
  {type:'function_call_output',call_id:'i',output:image},
  {type:'function_call',call_id:'s',name:'read_file',arguments:'{"path":"other"}'},
  {type:'function_call_output',call_id:'s',output:big},
];
compactConversationHistory(multimodal,{maxHistoryTokens:100,preserveRecentOutputs:0});
assert.deepEqual(multimodal[1].output,image,'multimodal arrays must never be converted to plain text');

let defaultCheckpointStep=0; // the request at which the first checkpoint reached the model, when the owner has chosen no percent
const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-context-wiring-'));
try{
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'src','core.mjs'),'export function startTask(){ return 1; }\n');
  let locked=false,steps=0,sawMap=false,sawCompact=false,sawCheckpoint=false;
  const prompt='Inspect src/core.mjs and report the available function.';
  const manager={
    backend:'local',workspace:root,generation:1,instanceId:'smart-context-test',secrets:[],
    state(){return {workspace:{path:root},generation:1,instanceId:'smart-context-test'};},
    acquireTask(){if(locked)return false;locked=true;return true;},
    releaseTask(){locked=false;},
    async createAgentSession(){return {
      catalog:{tools:[{name:'local.read_file',originalName:'read_file',server:'local',
        inputSchema:{type:'object',properties:{path:{type:'string'}}}}],
        prompts:[],resources:[],resourceTemplates:[],servers:{}},
      async close(){},
      async callTool(name){
        assert.equal(name,'local.read_file');
        return {isError:false,content:[{type:'text',text:big}],structuredContent:{notVerified:true}};
      },
    };},
  };
  manager.studio=new StudioWorkspace({manager,directory:path.join(root,'state')});
  const provider={
    ready:()=>true,snapshot:()=>({provider:'fixture',model:'fixture'}),
    async respond({input}){
      steps++;
      const user=input.find(x=>x.role==='user');
      if(steps===1){
        assert.equal(user?.content?.[0]?.text,prompt);
        assert.ok(user.content[1].text.includes('WORKSPACE REPO MAP (AUTO-GENERATED)'));
        assert.ok(user.content[1].text.includes('src/core.mjs'));
        sawMap=true;
      }
      const received=input.filter(x=>x.type==='function_call_output');
      const calledIds=input.filter(x=>x.type==='function_call').map(x=>x.call_id);
      assert.deepEqual(received.map(x=>x.call_id),calledIds,'every receipt in the provider request is paired with its call, in order');
      // From the owner's percent of the history budget (80 when none is chosen) the old messages are replaced by a checkpoint (lib/compaction-v2.mjs): the receipts that remain are paired
      // with their calls and the newest are there; until then all of them are.
      const checkpointed=String(input[0]?.content?.[0]?.text??'').startsWith('STRUCTURED CONTEXT CHECKPOINT');
      if(checkpointed){sawCheckpoint=true;if(!defaultCheckpointStep)defaultCheckpointStep=steps;assert.ok(received.length<steps-1,'a checkpoint stands for the oldest pairs');}
      else assert.equal(received.length,steps-1,'until a checkpoint, all call_id receipts remain paired in the provider request');
      if(steps>9){
        if(received[0].output.length < big.length||checkpointed)sawCompact=true;
        assert.equal(received.at(-1).output.includes(big.slice(0,90)),true,
          'newest tool output must remain available to model');
        // The compaction works on the copy that is sent. The ledger (the canonical history) still holds every result in full,
        // although its snapshot is a shallow copy that shares the items with it.
        const canonical=runner.context.history.snapshotForModel().filter(x=>x.type==='function_call_output');
        assert.equal(canonical.length,steps-1,'the ledger holds every result the model was offered, and the ones a checkpoint stood for');
        assert.ok(canonical[0].output.length>big.length,'the ledger keeps the first result in full');
        if(!checkpointed)assert.ok(canonical[0].output.length>received[0].output.length,'only the copy sent to the model was compacted');
      }
      if(steps<=12)return {status:'completed',output:[{
        type:'function_call',call_id:'call-'+steps,name:'read_file',status:'completed',
        arguments:JSON.stringify({path:'src/'+steps+'.mjs'}),
      }]};
      return {status:'completed',output:[{type:'message',role:'assistant',phase:'final',
        content:[{type:'output_text',text:'Inspected, no edit requested.'}]}]};
    },
  };
  const runner=new AgentRunner({manager,provider,taskDirectory:path.join(root,'tasks')});
  await runner.load();
  const started=await runner.start({prompt,maxSteps:20});
  const finish=await Promise.race([runner.context.done.promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('smart context integration timed out')),15000))]);
  assert.equal(finish.status,'completed',finish.error);
  assert.equal(finish.contextPolicy?.source,'conservative_fallback');
  assert.equal(finish.contextPolicy?.capacityTokens,32768);
  assert.ok(finish.events.some(e=>e.type==='context_budget'));
  assert.equal(sawMap,true);
  assert.equal(sawCompact,true,'long history must compact a COPY before model request');
  assert.equal(sawCheckpoint,true,'with no choice of the owner the checkpoint starts at 80% of the history budget of this run');
  assert.ok(finish.events.some(e=>e.type==='repo_map_injected'));
  assert.ok(finish.events.some(e=>e.type==='context_compaction'));
  const log=await fs.readFile(path.join(root,'tasks',started.id,'transcript.jsonl'),'utf8');
  assert.ok(log.includes(big.slice(100,180)),'full original tool output stays in durable transcript');
  await runner.shutdown();
  console.log('PASS Smart Context Compaction wired to AgentRunner, safe Repo Map, paired call IDs, durable full transcript');
}finally{await fs.rm(root,{recursive:true,force:true});}

// ---------------------------------------------------------------------------------------------------------------------------------
// The owner's percent (Settings, lib/agent-options.mjs) is read at EVERY model request. The same run (a real AgentRunner and StudioWorkspace; twelve tool results of about 3,750 tokens each, in a
// history budget of about 21,600 tokens) is given its first checkpoint at the request that the percent decides: later at 95, earlier at 50, the same at a saved 80 as with none chosen, and a percent
// changed DURING the run is followed from the next request. The transcript says which percent started each checkpoint, and what the checkpoint kept.
// ---------------------------------------------------------------------------------------------------------------------------------
{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-context-percent-'));
  try{
    await fs.mkdir(path.join(root,'src'));
    await fs.writeFile(path.join(root,'src','core.mjs'),'export function startTask(){ return 1; }\n');
    let runs=0;
    // percentAt: null (the owner chose none), a number, or a function of the requests made so far.
    const run=async(percentAt)=>{
      const number=(runs+=1);
      let locked=false,steps=0,firstCheckpoint=0,promptKept=true;
      const ask='Inspect src/core.mjs and report the available function.';
      const manager={
        backend:'local',workspace:root,generation:1,instanceId:'compact-percent',secrets:[],
        state(){return {workspace:{path:root},generation:1,instanceId:'compact-percent'};},
        acquireTask(){if(locked)return false;locked=true;return true;},
        releaseTask(){locked=false;},
        async createAgentSession(){return {
          catalog:{tools:[{name:'local.read_file',originalName:'read_file',server:'local',inputSchema:{type:'object',properties:{path:{type:'string'}}}}],prompts:[],resources:[],resourceTemplates:[],servers:{}},
          async close(){},
          async callTool(){return {isError:false,content:[{type:'text',text:big}],structuredContent:{notVerified:true}};},
        };},
      };
      manager.studio=new StudioWorkspace({manager,directory:path.join(root,'state-'+number)});
      const provider={
        ready:()=>true,snapshot:()=>({provider:'fixture',model:'fixture'}),
        async respond({input}){
          steps++;
          const first=String(input[0]?.content?.[0]?.text??'');
          if(first.startsWith('STRUCTURED CONTEXT CHECKPOINT')){
            if(!firstCheckpoint)firstCheckpoint=steps;
            if(!first.includes(ask))promptKept=false; // the owner's words, as written, must be in the request that replaced the old messages
          }
          if(steps<=12)return {status:'completed',output:[{type:'function_call',call_id:'call-'+steps,name:'read_file',status:'completed',arguments:JSON.stringify({path:'src/'+steps+'.mjs'})}]};
          return {status:'completed',output:[{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'Inspected, no edit requested.'}]}]};
        },
      };
      const saved=()=>{const percent=typeof percentAt==='function'?percentAt(steps):percentAt;return percent===null?{}:{autoCompactPercent:percent};};
      const runner=new AgentRunner({manager,provider,taskDirectory:path.join(root,'tasks-'+number),agentOptions:{current:()=>agentOptionsView(saved())}});
      await runner.load();
      const started=await runner.start({prompt:ask,maxSteps:20});
      const finish=await Promise.race([runner.context.done.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('compact percent integration timed out')),15000))]);
      assert.equal(finish.status,'completed',finish.error);
      const log=(await fs.readFile(path.join(root,'tasks-'+number,started.id,'transcript.jsonl'),'utf8')).split('\n').filter(Boolean).map((line)=>JSON.parse(line));
      const checkpoints=log.filter((x)=>x.type==='context_compaction'&&x.detail?.strategy==='rolling-checkpoint');
      await runner.shutdown();
      return {firstCheckpoint,checkpoints,finish,promptKept};
    };
    const none=await run(null);
    const saved80=await run(80);
    const early=await run(70);
    const late=await run(95);
    const lowest=await run(50);
    const live=await run((requests)=>requests>=3?70:95);
    assert.ok(none.firstCheckpoint>0,'the default run gets a checkpoint');
    assert.equal(none.firstCheckpoint,defaultCheckpointStep,'the same request as the run above, which had no options at all');
    assert.equal(saved80.firstCheckpoint,none.firstCheckpoint,'a saved 80 is the default: the same request');
    assert.ok(early.firstCheckpoint>0&&early.firstCheckpoint<none.firstCheckpoint,'at 70 the checkpoint starts earlier ('+early.firstCheckpoint+' < '+none.firstCheckpoint+')');
    assert.ok(late.firstCheckpoint===0||late.firstCheckpoint>none.firstCheckpoint,'at 95 it starts later or not at all within these twelve requests ('+late.firstCheckpoint+' > '+none.firstCheckpoint+')');
    // the transcript names the percent of every checkpoint, and the retention check ran on each
    for(const [name,result,percent] of [['none',none,80],['saved 80',saved80,80],['70',early,70],['95',late,95]]){
      assert.ok(result.checkpoints.every((x)=>x.detail.compactPercent===percent),name+': every checkpoint says it started at '+percent+'%');
      assert.ok(result.checkpoints.every((x)=>x.detail.retention&&x.detail.retention.total>=1&&x.detail.retention.kept===x.detail.retention.total&&x.detail.retention.missing.length===0),name+': nothing the checkpoint keeps is missing from the request');
      assert.equal(result.promptKept,true,name+': the request of the owner was in every request that carried a checkpoint');
    }
    // 95 from the start, 70 from the fourth request on: the runner follows the option as it is at each request, not as it was when the run began
    assert.equal(live.finish.agentOptions.autoCompactPercent,95,'the run records the option that applied when it began');
    assert.ok(live.firstCheckpoint>=4,'nothing started before the request at which the option changed ('+live.firstCheckpoint+')');
    assert.equal(live.firstCheckpoint,early.firstCheckpoint,'a percent lowered during the run is followed from its next request: the checkpoint comes where a run at 70 all along has it');
    assert.ok(late.firstCheckpoint===0||live.firstCheckpoint<late.firstCheckpoint);
    assert.equal(live.checkpoints[0].detail.compactPercent,70,'the first checkpoint of that run started at the percent of ITS request, not the one the run began with');
    // 50: three pairs of about 3,800 tokens (the Hub keeps at least the three newest pairs whole) do not fit under half of this small budget, so there is no safe boundary: nothing is cut, the run
    // goes on, and the Hub says so on each request
    assert.equal(lowest.firstCheckpoint,0,'at 50 no checkpoint can be made from results this big in a budget this small');
    assert.equal(lowest.finish.status,'completed');
    assert.ok(lowest.finish.events.some((e)=>e.type==='context_compaction_skipped'),'the skipped compaction is said, not silent');
    console.log('PASS the owner\'s percent is read at every model request: 70 earlier, 80 = none chosen, 95 later, a change during the run followed, 50 skipped without loss when no safe boundary exists; each checkpoint records its percent and the retention check');
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The Repo Map a delegated worker is given. Its first prompt is its goal followed by the Hub's handoff (branch names, the predecessors' results, the Hub's own
// instructions) and start() takes the goal as selectionPrompt. The map is ranked by the files the whole prompt names (a file a predecessor's result names focuses
// it) and by one query word. Read as a whole, the handoff's header "WORKFLOW" was that word for every worker whose goal has no identifier of its own, and ranked a
// workflow module first. Real AgentRunner and StudioWorkspace over six small modules whose scores are hand-derived: base 1; +25 for a focus file; the query
// word "summarize" +6 for each of the two symbols of summary.mjs, "workflow" +15 for the path and +6 for each of the three symbols of workflow-engine.mjs.
// ---------------------------------------------------------------------------------------------------------------------------------
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-repo-map-selection-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    const sources = {
      'alpha.mjs': 'export function loadAlpha() { return 1; }\n',
      'beta.mjs': 'export function loadBeta() { return 2; }\n',
      'auth.mjs': 'export function verifyToken(token) { return token.length > 0; }\n',
      'session.mjs': 'export function openSession(id) { return id; }\n',
      'summary.mjs': 'export function summarizeFindings(list) { return list.join(" "); }\nexport function summarizeText(text) { return text.slice(0, 80); }\n',
      'workflow-engine.mjs': 'export class WorkflowStep { run() { return 1; } }\nexport function runWorkflow(steps) { return steps.map((step) => step.run()); }\nexport function planWorkflow(spec) { return spec; }\n',
    };
    for (const [name, text] of Object.entries(sources)) await fs.writeFile(path.join(root, 'src', name), text);
    const own = 'Summarize the findings in two sentences.';
    const whole = own + '\n\nWORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):\n' +
      'Predecessor 0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d (completed) branch=chatmcp/chat/0b1c2d3e-4f50 worktree=/hub/api-conversations/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/worktree\n' +
      'UNTRUSTED RESULT (independently verify before use):\nReviewed src/auth.mjs and src/session.mjs: both need a check.\n' +
      'Previous workers used independent worktrees. Changes are NOT automatically merged. Inspect source, diffs and run actual checks; do not claim prior edits are integrated or verified without evidence.';
    let runs = 0;
    // One run on a runner of its own. Resolves with the map the model was given (the files in the order it lists them) and what the Hub recorded about it.
    const mapOf = async (prompt, options = {}) => {
      const number = (runs += 1);
      let locked = false;
      let map = '';
      const manager = {
        backend: 'local', workspace: root, generation: 1, instanceId: 'repo-map-selection', secrets: [],
        state() { return { workspace: { path: root }, generation: 1, instanceId: 'repo-map-selection' }; },
        acquireTask() { if (locked) return false; locked = true; return true; },
        releaseTask() { locked = false; },
        async createAgentSession() {
          return { catalog: { tools: [{ name: 'local.read_file', originalName: 'read_file', server: 'local', inputSchema: { type: 'object' } }], prompts: [], resources: [], resourceTemplates: [], servers: {} },
            async close() {}, async callTool() { throw new Error('the model calls no tool'); } };
        },
      };
      manager.studio = new StudioWorkspace({ manager, directory: path.join(root, 'state-' + number) });
      const provider = {
        ready: () => true, snapshot: () => ({ provider: 'fixture', model: 'fixture' }),
        async respond({ input }) {
          const user = input.find((item) => item.role === 'user');
          assert.equal(user.content[0].text, prompt, 'the model reads the whole prompt');
          map = String(user.content[1]?.text ?? '');
          return { status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'Done.' }] }] };
        },
      };
      const taskDirectory = path.join(root, 'tasks-' + number);
      const runner = new AgentRunner({ manager, provider, taskDirectory });
      await runner.load();
      let timer;
      try {
        const started = await runner.start({ prompt, ...options, maxSteps: 4 });
        const finish = await Promise.race([runner.context.done.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('repo map selection timed out')), 15000); })]);
        assert.equal(finish.status, 'completed', finish.error);
        const log = (await fs.readFile(path.join(taskDirectory, started.id, 'transcript.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const { stats } = log.find((entry) => entry.type === 'repo_map_injected').detail;
        return { files: [...map.matchAll(/^## (\S+) \(/gm)].map((match) => match[1]), query: stats.queryHint, focus: stats.focusFiles };
      } finally { clearTimeout(timer); await runner.shutdown(); }
    };

    // The worker: the query is made from its goal, the files from everything the prompt names.
    const worker = await mapOf(whole, { selectionPrompt: own });
    assert.equal(worker.query, 'Summarize', 'the query is a word of the goal, not the "WORKFLOW" of the handoff');
    assert.deepEqual(worker.focus, ['src/auth.mjs', 'src/session.mjs'], 'the files the predecessor\'s result names still focus the map');
    assert.deepEqual(worker.files, ['src/auth.mjs', 'src/session.mjs', 'src/summary.mjs', 'src/alpha.mjs', 'src/beta.mjs', 'src/workflow-engine.mjs'],
      'the focus files first (26), then summary.mjs by its query (13), then the rest by name');
    // The same goal without a predecessor: the same query; only the focus files differ, since there is no result to name any.
    const alone = await mapOf(own);
    assert.equal(alone.query, worker.query, 'a worker with a predecessor is given the query of the same goal alone');
    assert.deepEqual(alone.focus, []);
    assert.deepEqual(alone.files, ['src/summary.mjs', 'src/alpha.mjs', 'src/auth.mjs', 'src/beta.mjs', 'src/session.mjs', 'src/workflow-engine.mjs'], 'summary.mjs first by its query (13), the rest by name');
    // Without a selectionPrompt, or with one that is the prompt, the map is made from the whole prompt exactly as before.
    for (const [label, options] of [['no selectionPrompt', {}], ['a selectionPrompt that is the prompt', { selectionPrompt: whole }], ['a null one', { selectionPrompt: null }]]) {
      const before = await mapOf(whole, options);
      assert.equal(before.query, 'WORKFLOW', `${label}: the query of the whole prompt, as before`);
      assert.deepEqual(before.focus, ['src/auth.mjs', 'src/session.mjs'], `${label}: and its focus files`);
      assert.deepEqual(before.files, ['src/workflow-engine.mjs', 'src/auth.mjs', 'src/session.mjs', 'src/alpha.mjs', 'src/beta.mjs', 'src/summary.mjs'],
        `${label}: workflow-engine.mjs first by its query (34), the focus files (26), the rest by name`);
    }
    console.log('PASS Repo Map of a delegated worker: query from its goal, focus files from the whole prompt, unchanged without a selectionPrompt');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The numbers of gate G1-7 through the REAL path: the hub's primary AgentRunner -> its context policy -> a GatewayProvider speaking OpenAI
// Responses -> the request body. Only the network is replaced; the catalog is the real 99-tool LocalTools inventory and the prompt is a
// coding task, so the numbers are what a person with an unconfigured Responses endpoint gets. (v3.9.0: 103 schemas = 15.4k tokens, 10.3k
// tokens of history, max_output_tokens 5,898.)
// ---------------------------------------------------------------------------------------------------------------------------------
{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-window-policy-'));
  try{
    const catalogTools=new LocalTools({workspace:{async resolve(){throw new Error('not called');}},shell:{},git:{}}).definitions();
    let runNumber=0;
    const sse=payload=>({ok:true,status:200,headers:{get:name=>String(name).toLowerCase()==='content-type'?'text/event-stream':null},
      body:new Response('data: '+JSON.stringify({type:'response.completed',response:payload})+'\n\n').body});
    const completed={status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Nothing to change.'}]}],usage:{input_tokens:20000,output_tokens:5}};
    async function runTask({window,prompt}){
      const number=++runNumber;
      const requests=[];
      const provider=new GatewayProvider({directory:path.join(base,'gateway-'+number),bundleRoot:path.resolve(import.meta.dirname,'..'),manager:{secrets:[]},env:{},platform:'linux',sleep:async()=>{},
        fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return sse(completed);}});
      await provider.load();
      await provider.configure({preset:'custom-responses',apiBaseUrl:'https://responses.example/v1',model:'gpt-test',apiKey:'sk-window-policy-key-0123456789',
        ...(window?{contextWindowTokens:window}:{})});
      let locked=false;
      const root=path.join(base,'workspace-'+number);
      await fs.mkdir(root,{recursive:true});
      const manager={secrets:[],workspace:root,generation:1,instanceId:'window-policy',
        studio:{checks:async()=>({suggested:[{from:'package.json',command:'npm test'}]})},
        state(){return {workspace:{path:root},generation:1,instanceId:'window-policy',services:{}};},
        acquireTask(){if(locked)return false;locked=true;return true;},releaseTask(){locked=false;},
        async createAgentSession(){return {catalog:{tools:catalogTools,prompts:[],resources:[],resourceTemplates:[],servers:{}},async close(){},async callTool(){throw new Error('no tool is called');}};}};
      const runner=createPrimaryAgentRunner(AgentRunner,{manager,provider,taskDirectory:path.join(base,'tasks-'+number),log:()=>{},env:{}});
      await runner.load();
      const {id}=await runner.start({prompt,maxSteps:3,maxMinutes:1});
      await Promise.race([runner.context.done.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('window policy task timed out')),20000))]);
      const task=runner.get(id);
      await runner.shutdown();
      return {task,requests};
    }
    const codingTask='Fix the failing test in src/core.mjs and run the tests.';

    const unknown=await runTask({window:null,prompt:codingTask});
    assert.equal(unknown.task.status,'completed',unknown.task.error);
    const unknownBody=unknown.requests[0].body;
    assert.equal(unknown.task.contextPolicy.source,'conservative_fallback','nothing configured: the policy says so');
    assert.ok(unknownBody.max_output_tokens>=16384,'Responses request for an unknown window: max_output_tokens '+unknownBody.max_output_tokens+' (v3.9.0: 5,898)');
    assert.ok(unknown.task.contextPolicy.reservedOutputTokens>=4096);
    assert.ok(unknown.task.contextPolicy.maxHistoryTokens>=8000,'unknown window, task-selected tools: history '+unknown.task.contextPolicy.maxHistoryTokens+' tokens');
    assert.ok(unknownBody.tools.length>0&&unknownBody.tools.length<60,'an unknown window gets the task-selected schemas, not all 103 ('+unknownBody.tools.length+')');
    assert.ok(unknown.task.events.some(e=>e.type==='tool_selection'),'and the selection is recorded');
    const unknownToolTokens=Math.ceil(JSON.stringify(unknownBody.tools).length/3.8);
    assert.ok(unknownToolTokens<9000,'tool schemas cost '+unknownToolTokens+' tokens in auto mode (full list: about 13.4k)');

    const large=await runTask({window:200000,prompt:codingTask});
    assert.equal(large.task.contextPolicy.source,'provider_configuration');
    assert.equal(large.requests[0].body.tools.length,103,'a known large window keeps the full list, as before');
    assert.equal(large.requests[0].body.max_output_tokens,16384);
    assert.ok(large.task.contextPolicy.maxHistoryTokens>100000);

    const small=await runTask({window:16384,prompt:codingTask});
    assert.equal(small.task.status,'completed',small.task.error);
    assert.ok(small.requests[0].body.tools.length<60,'a small known window is trimmed too');
    assert.equal(small.requests[0].body.max_output_tokens,4096,'and its output cap is a quarter of it, not more than fits');
    console.log('PASS unknown window: warning source, >=8k history, task-selected tools, Responses max_output_tokens >= 16,384; large window unchanged');
  }finally{await fs.rm(base,{recursive:true,force:true,maxRetries:8,retryDelay:150});}
}
