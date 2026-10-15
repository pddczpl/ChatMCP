// Contract: >50 directly exposed tools are supported when a provider can accept
// them; narrower providers use an operator-configurable cap without losing any
// registered local capability from the internal mcp_call/mcp_catalog router.
import assert from 'node:assert/strict';
import { LocalTools } from '../lib/local-tools.mjs';
import {
  ROUTER_TOOLS, directToolsFor, createLocalAgentInstructions,
  resolveDirectToolLimit, DEFAULT_DIRECT_TOOL_LIMIT, MAX_DIRECT_TOOL_LIMIT,
} from '../lib/agent.mjs';

const local = new LocalTools({workspace:{async resolve(){throw new Error('not called');}},shell:{},git:{}});
const tools = local.definitions();
const catalog = { tools };
const full = directToolsFor(catalog);
assert.equal(tools.length,95,'expected versioned internal inventory');
assert.equal(DEFAULT_DIRECT_TOOL_LIMIT,95);
assert.equal(MAX_DIRECT_TOOL_LIMIT,124);
assert.equal(full.functions.length,95,'95 LocalTools are directly advertised by default');
assert.equal(full.functions.length + ROUTER_TOOLS.length,99);
assert.ok(full.functions.length + ROUTER_TOOLS.length <= 128);
assert.equal(full.byName.size,95);
assert.deepEqual(new Set(full.functions.map(tool=>tool.name)),new Set(tools.map(tool=>tool.originalName)));
for (const tool of full.functions) {
  assert.equal(tool.type,'function');
  assert.ok(tool.parameters);
  assert.ok(tool.name.length<=64);
}
const compact=directToolsFor(catalog,{limit:32});
assert.equal(compact.functions.length,32);
for (const name of ['read_file','write_file','edit_file','git_status','run_command','checks_list','checks_run']) {
  if (tools.some(tool=>tool.originalName===name)) {
    assert.equal(compact.byName.has(name),true,'preferred '+name+' must remain callable in compact mode');
  }
}
assert.equal(directToolsFor(catalog,{limit:0}).functions.length,0);
assert.equal(directToolsFor(catalog,{limit:500}).functions.length,95,'bounded by inventory');
assert.equal(resolveDirectToolLimit('50'),50);
assert.equal(resolveDirectToolLimit('110'),110);
assert.equal(resolveDirectToolLimit('1000'),95,'invalid configuration falls back safely');
assert.equal(resolveDirectToolLimit('124'),124);
assert.equal(resolveDirectToolLimit('125'),124,'hard provider-safety boundary');
assert.equal(resolveDirectToolLimit('not-a-number'),95);
const instructions=createLocalAgentInstructions(catalog,{path:'/tmp/project'},null);
assert.match(instructions,/web_search/);
assert.match(instructions,/browser_launch/);
assert.match(instructions,/token_restore/);
const limitedInstructions = createLocalAgentInstructions({
  tools,
},{path:'/tmp/project'},null);
assert.equal(typeof limitedInstructions,'string');
assert.ok(limitedInstructions.length>200);
console.log('PASS direct-tool-capacity: 95 direct + 4 router, adjustable 0..124, prioritized compact fallback and full discoverability');
