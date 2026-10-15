import assert from 'node:assert/strict';
import { LocalTools } from '../lib/local-tools.mjs';
import { ROUTER_TOOLS, selectTaskTools, createLocalAgentInstructions } from '../lib/agent.mjs';
import { requestBudgetConfig, RequestBudget } from '../lib/request-budget.mjs';
import { respondStandard } from '../lib/standard-adapter.mjs';
import { proposeCodingTasks, proposeModelCodingTasks, validateProposedCodingTasks } from '../lib/coding-task-planner.mjs';

const local=new LocalTools({workspace:{async resolve(){throw new Error('unused');}},shell:{},git:{}});
const catalog={tools:local.definitions()};
const select=(prompt,limit=26)=>selectTaskTools(catalog,{prompt,limit,env:{}});
const normal=select('Fix the login bug and run relevant tests.');
assert.equal(normal.functions.length,26);
assert.equal(normal.byName.size,26);
assert.equal(ROUTER_TOOLS.length,4);
assert.ok(normal.byName.has('read_file')&&normal.byName.has('run_command')&&normal.byName.has('git_diff'));
assert.ok(catalog.tools.some(tool=>tool.originalName==='checks_list') ? normal.byName.has('checks_list') : ROUTER_TOOLS.some(tool=>tool.name==='mcp_catalog'),
  'test broker is direct when registered; otherwise discoverable through router');
assert.ok(!normal.byName.has('browser_launch'),'unrelated browser schemas are not advertised');
const browser=select('Fix Playwright website UI mobile responsiveness and accessibility');
assert.ok(browser.byName.has('browser_launch')&&browser.byName.has('responsive_check'));
const semantic=select('Refactor TypeScript symbols and rename interface across files');
assert.ok(semantic.byName.has('rename_symbol')&&semantic.byName.has('code_actions'));
const research=select('Research the package documentation and dependencies',22);
assert.ok(research.byName.has('docs_search'));
const off=selectTaskTools(catalog,{prompt:'browser',env:{CHATMCP_DYNAMIC_TOOL_SELECTION:'off'}});
assert.equal(off.functions.length,95,'legacy full schema mode stays available');
const zero=selectTaskTools(catalog,{prompt:'browser',env:{CHATMCP_DIRECT_TOOL_LIMIT:'0'}});
assert.equal(zero.functions.length,0,'router-only mode supported');
const dynamicInstructions=createLocalAgentInstructions(catalog,{path:'/project'},null,{offered:normal,compact:true});
assert.ok(!dynamicInstructions.includes('Other Built-in Tools:'));
assert.ok(!dynamicInstructions.includes('browser_launch'));
assert.match(dynamicInstructions,/mcp_catalog/);
assert.ok(Buffer.byteLength(dynamicInstructions)<Buffer.byteLength(createLocalAgentInstructions(catalog,{path:'/project'},null)),
  'task-local instructions omit long unused tool name lists');

const defaultConfig=requestBudgetConfig({});
assert.equal(defaultConfig.limits.maxRequests,60);
assert.equal(defaultConfig.limits.maxRetries,8);
assert.equal(defaultConfig.limits.maxCostUSD,0);
assert.throws(()=>requestBudgetConfig({CHATMCP_MAX_TASK_COST_USD:'2'}),/requires explicit/);
assert.throws(()=>requestBudgetConfig({CHATMCP_MAX_MODEL_REQUESTS_PER_TASK:'-1'}),/nonnegative/);
const config=requestBudgetConfig({
  CHATMCP_MAX_MODEL_REQUESTS_PER_TASK:'2',
  CHATMCP_MAX_MODEL_RETRIES_PER_TASK:'1',
  CHATMCP_MAX_INPUT_TOKENS_PER_TASK:'100',
  CHATMCP_INPUT_USD_PER_MTOKENS:'1',
  CHATMCP_OUTPUT_USD_PER_MTOKENS:'5',
  CHATMCP_CACHED_USD_PER_MTOKENS:'0.1',
});
const usage={inputTokens:0,outputTokens:0};
const budget=new RequestBudget({usage,config});
budget.reserve({requestBytes:100});
budget.recordUsage({input_tokens:60,output_tokens:4,cache_read_tokens:20});
assert.equal(usage.apiRequests,1);
assert.equal(usage.cacheReadTokens,20);
assert.equal(budget.estimatedCostUSD(),(40+2+20)/1_000_000);
budget.reserve({retry:true,requestBytes:200});
assert.equal(usage.retryRequests,1);
assert.equal(usage.requestBytes,300);
assert.throws(()=>budget.reserve(),{code:'request_budget_exhausted'});
const restored=new RequestBudget({usage:structuredClone(usage),config});
assert.throws(()=>restored.reserve(),{code:'request_budget_exhausted'},'limits persist across tasks resumed from disk');

const capped=new RequestBudget({usage:{},config:requestBudgetConfig({
  CHATMCP_MAX_MODEL_REQUESTS_PER_TASK:'4',CHATMCP_MAX_MODEL_RETRIES_PER_TASK:'1',
  CHATMCP_MAX_INPUT_TOKENS_PER_TASK:'12',
})});
capped.reserve();
capped.recordUsage({input_tokens:13});
assert.throws(()=>capped.reserve(),{code:'input_budget_exhausted'});
const priced=new RequestBudget({config:requestBudgetConfig({
  CHATMCP_MAX_TASK_COST_USD:'0.001',
  CHATMCP_INPUT_USD_PER_MTOKENS:'100',
  CHATMCP_OUTPUT_USD_PER_MTOKENS:'0',
})});
priced.reserve();
priced.recordUsage({input_tokens:15});
assert.throws(()=>priced.reserve(),{code:'cost_budget_exhausted'});

// Exercise an actual adapter with an HTTP 503 retry: callback observes BOTH
// outbound fetch attempts, not just a single logical AgentRunner turn.
let networkRequests=0;
const fixture=(status,payload)=>({
  ok:status>=200&&status<300,status,headers:{get:()=>null},
  async text(){return JSON.stringify(payload);},
});
const chatBody={choices:[{finish_reason:'stop',message:{content:'Complete.'}}],usage:{prompt_tokens:30,completion_tokens:2}};
const ctx={protocol:'openai-chat',model:'fixture',endpoint:'https://example.invalid/v1/chat/completions',
  headers:{},contextWindowTokens:null,redact:x=>x,sleep:async()=>{},
  limits:{maxHttpRetries:1},
  async fetch(){networkRequests++;return networkRequests===1
    ?fixture(503,{error:{message:'Server is busy'}}):fixture(200,chatBody);},
};
const req=new RequestBudget({config:requestBudgetConfig({CHATMCP_MAX_MODEL_REQUESTS_PER_TASK:'2'})});
const attempts=[];
const response=await respondStandard(ctx,{
  input:[{role:'user',content:[{type:'input_text',text:'Say complete.'}]}],
  instructions:'Answer.',tools:[],onHttpAttempt:info=>{
    attempts.push(info);
    req.reserve(info);
  },
});
assert.equal(response.status,'completed');
assert.deepEqual(attempts.map(x=>x.retry),[false,true]);
assert.equal(networkRequests,2);
assert.equal(req.snapshot().apiRequests,2);
assert.equal(req.snapshot().retryRequests,1);
assert.ok(attempts.every(x=>x.requestBytes>0));
let secondFetches=0;
const tooMany=new RequestBudget({config:requestBudgetConfig({CHATMCP_MAX_MODEL_REQUESTS_PER_TASK:'1'})});
await assert.rejects(respondStandard({...ctx,fetch:async()=>{
  secondFetches++;return fixture(503,{error:{message:'Server is busy'}});
}},{
  input:[{role:'user',content:[{type:'input_text',text:'fix'}]}],
  instructions:'x',onHttpAttempt:info=>tooMany.reserve(info),
}),{code:'request_budget_exhausted'});
assert.equal(secondFetches,1,'budget rejects retry before any second HTTP POST');

// Coding plan preview never mutates a worktree. Model assistance is opt-in
// and validated against the same DAG/ID constraints as real workers.
const proposal=proposeCodingTasks('Build a new app:\n- Implement backend validation and API endpoints\n- Implement a frontend form with client checks');
assert.equal(proposal.modelRequests,0);
assert.equal(proposal.tasks.length,2);
assert.deepEqual(proposal.tasks[1].dependsOn,['task-1']);
assert.throws(()=>validateProposedCodingTasks([
  {id:'a',prompt:'read',dependsOn:['b']},{id:'b',prompt:'write',dependsOn:['a']}
]),/Cyclic|dependency/i);
const proposalModel={
  ready:()=>true,
  async respond({tools,onHttpAttempt,input}){
    assert.equal(tools.length,0,'planner never asks the model to call tools');
    assert.equal(input.length,1);
    onHttpAttempt({retry:false,requestBytes:300});
    return {status:'completed',usage:{input_tokens:30,output_tokens:20},
      output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({tasks:[
        {id:'api',prompt:'Implement backend validation',dependsOn:[],verify:false},
        {id:'frontend',prompt:'Implement form',dependsOn:['api'],verify:false}
      ]})}]}]};
  },
};
const aiPlan=await proposeModelCodingTasks({goal:'Build validated frontend/backend workflow',provider:proposalModel});
assert.equal(aiPlan.source,'model-proposal');
assert.equal(aiPlan.modelRequests,1);
assert.deepEqual(aiPlan.tasks[1].dependsOn,['api']);
await assert.rejects(proposeModelCodingTasks({goal:'Build a dashboard',provider:{
  ready:()=>true,async respond(){return{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'not-json'}]}]};}
}}),{code:'invalid_model_plan'});

console.log('PASS parity runtime: task tool selection, HTTP/request/cost budget, verified retry count and review-only coding plan');
