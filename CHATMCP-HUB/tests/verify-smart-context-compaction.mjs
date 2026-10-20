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

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-context-wiring-'));
try{
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'src','core.mjs'),'export function startTask(){ return 1; }\n');
  let locked=false,steps=0,sawMap=false,sawCompact=false;
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
      assert.equal(received.length,steps-1,'all call_id receipts remain paired in the provider request');
      if(steps>9){
        if(received[0].output.length < big.length)sawCompact=true;
        assert.equal(received.at(-1).output.includes(big.slice(0,90)),true,
          'newest tool output must remain available to model');
        // The compaction works on the copy that is sent. The ledger (the canonical history) still holds every result in full,
        // although its snapshot is a shallow copy that shares the items with it.
        const canonical=runner.context.history.snapshotForModel().filter(x=>x.type==='function_call_output');
        assert.equal(canonical.length,received.length,'the ledger holds every result the model was offered');
        assert.ok(canonical[0].output.length>big.length,'the ledger keeps the first result in full');
        assert.ok(canonical[0].output.length>received[0].output.length,'only the copy sent to the model was compacted');
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
  assert.ok(finish.events.some(e=>e.type==='repo_map_injected'));
  assert.ok(finish.events.some(e=>e.type==='context_compaction'));
  const log=await fs.readFile(path.join(root,'tasks',started.id,'transcript.jsonl'),'utf8');
  assert.ok(log.includes(big.slice(100,180)),'full original tool output stays in durable transcript');
  await runner.shutdown();
  console.log('PASS Smart Context Compaction wired to AgentRunner, safe Repo Map, paired call IDs, durable full transcript');
}finally{await fs.rm(root,{recursive:true,force:true});}

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
