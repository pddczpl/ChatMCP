import assert from 'node:assert/strict';
import { LocalTools } from '../lib/local-tools.mjs';
import {selectTaskToolNames,selectTaskCatalog,taskToolSelectionMode,windowToolSelectionMode,followProviderWindow,LARGE_WINDOW_TOKENS} from '../lib/tool-selector.mjs';
import {directToolsFor,ROUTER_TOOLS,AgentRunner} from '../lib/agent.mjs';
import {createPrimaryAgentRunner} from '../hub.mjs';

const fake=new LocalTools({workspace:{async resolve(){throw Error('not called');}},shell:{},git:{}});
const catalog={tools:fake.definitions()};
assert.equal(taskToolSelectionMode({}), 'full');
assert.equal(taskToolSelectionMode({CHATMCP_TOOL_SELECTION:'auto'}), 'auto');
const basic=selectTaskToolNames('Please inspect README and tell me its purpose.');
assert.ok(basic.includes('read_file'));
assert.ok(!basic.includes('browser_launch'));
assert.ok(!basic.includes('debug_start'));
assert.ok(!basic.includes('git_commit'));
const web=selectTaskToolNames('Fix the frontend browser UI and take a screenshot.');
assert.ok(web.includes('browser_launch'));
assert.ok(web.includes('browser_screenshot'));
assert.ok(web.includes('edit_file'));
const debug=selectTaskToolNames('Debug a Node exception using a breakpoint.');
assert.ok(debug.includes('debug_start'));
const selected=selectTaskCatalog(catalog,'Fix the frontend browser UI and take a screenshot.');
assert.ok(selected.tools.length>10 && selected.tools.length<catalog.tools.length);
const direct=directToolsFor(selected);
assert.equal(direct.functions.length,selected.tools.length);
assert.equal(ROUTER_TOOLS.length,4);
assert.equal(catalog.tools.length,99,'full catalog unchanged');
assert.throws(()=>selectTaskToolNames('x',{cap:0}),TypeError);

// The hub's primary runner (the foreground chat) offered all 103 schemas, about 15.4k tokens, to every model. Whether that fits depends on the
// window of the model that task uses: an unknown or small window gets the task-selected subset; a large one keeps the full list.
assert.equal(LARGE_WINDOW_TOKENS,65536);
for(const [window,expected] of [[null,'auto'],[undefined,'auto'],[NaN,'auto'],[4096,'auto'],[32768,'auto'],[65535,'auto'],[65536,'full'],[200000,'full'],[2_000_000,'full']])
  assert.equal(windowToolSelectionMode(window,{}),expected,'window '+window);
assert.equal(windowToolSelectionMode(null,{CHATMCP_TOOL_SELECTION:'full'}),'full','CHATMCP_TOOL_SELECTION=full opts out whatever the window');
assert.equal(windowToolSelectionMode(200000,{CHATMCP_TOOL_SELECTION:'auto'}),'auto','and =auto opts in');
assert.equal(windowToolSelectionMode(null,{CHATMCP_TOOL_SELECTION:'nonsense'}),'auto','an unknown value is ignored, the window decides');
const follower={provider:{state:()=>({contextWindowTokens:null})},toolSelectionMode:null};
assert.equal(followProviderWindow(follower,{}),follower);
assert.equal(follower.toolSelectionMode,'auto');
follower.provider={state:()=>({contextWindowTokens:128000})};
assert.equal(follower.toolSelectionMode,'full','it follows the provider of the task that is starting now');
follower.provider={state:()=>{throw new Error('provider not ready');}};
assert.equal(follower.toolSelectionMode,'auto','a provider that cannot say counts as unknown');
follower.toolSelectionMode='full';
assert.equal(follower.toolSelectionMode,'full','an explicit mode wins');
follower.toolSelectionMode=null;
assert.equal(follower.toolSelectionMode,'auto','and null hands the choice back to the window');
// The wiring hub.mjs uses for its primary runner, on a real AgentRunner.
const hubWindow={value:null};
const primary=createPrimaryAgentRunner(AgentRunner,{manager:{},provider:{ready:()=>true,state:()=>({contextWindowTokens:hubWindow.value})},taskDirectory:'unused',log:()=>{},env:{}});
assert.ok(primary instanceof AgentRunner);
assert.equal(primary.toolSelectionMode,'auto','unknown window: task-selected tools');
hubWindow.value=1_000_000;
assert.equal(primary.toolSelectionMode,'full','known large window: the full list, as before');
assert.equal(createPrimaryAgentRunner(AgentRunner,{manager:{},provider:{state:()=>({contextWindowTokens:null})},taskDirectory:'unused',log:()=>{},env:{CHATMCP_TOOL_SELECTION:'full'}}).toolSelectionMode,'full');
console.log('PASS task-tool-selector: dynamic intent routing, full catalog untouched, exact router fallback');
