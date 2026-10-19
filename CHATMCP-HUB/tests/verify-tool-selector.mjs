import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LocalTools } from '../lib/local-tools.mjs';
import {selectTaskToolNames,selectTaskCatalog,taskToolSelectionMode,windowToolSelectionMode,followProviderWindow,LARGE_WINDOW_TOKENS} from '../lib/tool-selector.mjs';
import {directToolsFor,ROUTER_TOOLS,AgentRunner} from '../lib/agent.mjs';
import {estimateTokens} from '../lib/context-compaction.mjs';
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

// The corpus. tests/fixtures/tool-selector-corpus.json holds realistic coding prompts (English and Vietnamese) and, for each, the local tools a
// correct solution calls. In auto mode only the selected schemas are offered directly: every other tool costs the model a mcp_describe +
// mcp_call detour, and a model that calls an unadvertised function by name gets unknown_function. So the selector is measured on what it offers
// directly (recall) and on what the offered schemas cost, the four router tools included, the way the agent sends them.
const corpus=JSON.parse(fs.readFileSync(new URL('./fixtures/tool-selector-corpus.json',import.meta.url),'utf8'));
const prompts=corpus.prompts;
const KINDS=['question','edit','bug-report','refactor','test-ci','git','browser-ui'];
assert.equal(corpus.version,1);
assert.ok(prompts.length>=60,'a corpus of about 60 prompts or more: '+prompts.length);
assert.equal(new Set(prompts.map(p=>p.id)).size,prompts.length,'prompt ids are unique');
const localNames=new Set(catalog.tools.map(t=>t.originalName));
for(const p of prompts) {
  assert.ok(KINDS.includes(p.kind)&&['en','vi'].includes(p.lang),p.id+': kind and lang');
  assert.equal(p.prompt,p.prompt.normalize('NFC'),p.id+': the prompt is NFC text');
  assert.ok(p.tools.length>0&&new Set(p.tools).size===p.tools.length,p.id+': tools');
  for(const tool of p.tools)assert.ok(localNames.has(tool),p.id+' lists '+tool+', which is not a local tool');
}
for(const kind of KINDS)assert.ok(prompts.filter(p=>p.kind===kind).length>=7,'at least 7 prompts of kind '+kind);
for(const lang of ['en','vi'])assert.ok(prompts.filter(p=>p.lang===lang).length>=20,'at least 20 '+lang+' prompts');

const offeredFor=(prompt)=>directToolsFor(selectTaskCatalog(catalog,prompt,{cap:48})).functions;
const alwaysOffered=new Set(offeredFor('Hello.').map(f=>f.name));
const rows=prompts.map(p=>{
  const functions=offeredFor(p.prompt);
  const names=new Set(functions.map(f=>f.name));
  return {...p,names,tokens:estimateTokens([...ROUTER_TOOLS,...functions]),missed:p.tools.filter(t=>!names.has(t))};
});
const recallOf=(set,counts=()=>true)=>{
  const needed=set.flatMap(r=>r.tools.filter(counts).map(t=>[r,t]));
  return needed.filter(([r,t])=>r.names.has(t)).length/needed.length;
};
const median=(numbers)=>{const s=[...numbers].sort((a,b)=>a-b);return (s[(s.length-1)>>1]+s[s.length>>1])/2;};
const misses=(set)=>set.filter(r=>r.missed.length).map(r=>r.id+' '+r.missed.join('+')).join(', ');
const recall=recallOf(rows);
const decided=recallOf(rows,t=>!alwaysOffered.has(t));
const served=rows.filter(r=>!r.missed.length).length;
const medianTokens=median(rows.map(r=>r.tokens));
const maxTokens=Math.max(...rows.map(r=>r.tokens));
const summary='recall '+(100*recall).toFixed(1)+'% ('+(100*decided).toFixed(1)+'% of the tools the selector decides on), '+served+'/'+rows.length+' prompts served in full, '
  +'tokens median '+medianTokens+' max '+maxTokens;

// Floors and ceilings are what the selector measures today, so a change that loses recall or adds cost fails here. A prompt the corpus gains
// that the selector cannot serve yet is a decision: fix the selector, or lower a floor on purpose.
// A tool the prompt needs but the selector did not offer is a detour; the mutation tools below are the ones whose absence strands an ordinary
// edit prompt ("Update the version in package.json", "Remove the unused helper", "Convert this file to TypeScript").
const FLOOR={recall:1,decided:1,served:rows.length};
const CEILING={median:5000,max:8000};
assert.ok(recall>=FLOOR.recall,'the selector offers the tools a solution calls: '+summary+'. Missed: '+misses(rows));
assert.ok(decided>=FLOOR.decided,'and those it has to decide on: '+summary+'. Missed: '+misses(rows));
assert.ok(served>=FLOOR.served,'prompts served in full: '+summary+'. Missed: '+misses(rows));
for(const tool of ['edit_file','write_file','delete_path']) {
  const stranded=rows.filter(r=>r.tools.includes(tool)&&!r.names.has(tool)).map(r=>r.id);
  assert.deepEqual(stranded,[],tool+' is offered directly for every corpus prompt whose solution calls it');
}
// The prompts that stranded the edit tools (the problem as it was reported), word for word: each is offered the four tools that change a file.
for(const prompt of ['Update the version in package.json','Add a --verbose flag to the CLI','Change the default port','Remove the unused helper','Replace X with Y',
  'Convert this file to TypeScript','Bump the dependency','Cập nhật phiên bản trong package.json','Thêm cờ --verbose','Xóa hàm không dùng']) {
  const names=selectTaskToolNames(prompt);
  for(const tool of ['edit_file','write_file','files_apply_patch','delete_path'])assert.ok(names.includes(tool),'"'+prompt+'" is offered '+tool);
}
// Cost ceilings. The median prompt stays far inside the budget the dynamic selection exists for (the full list is 13.4k tokens, and the brief for
// this selection was a median of 7k at most); the dearest corpus prompt is one that already matched three original groups and fills the cap.
assert.ok(medianTokens<=CEILING.median,'median schema cost of the corpus: '+summary);
assert.ok(maxTokens<=CEILING.max,'the dearest prompt: '+summary+' ('+rows.find(r=>r.tokens===maxTokens).id+')');
for(const r of rows)assert.ok(selectTaskToolNames(r.prompt).length<=48,r.id+': the cap of 48 names holds');
assert.equal(selectTaskToolNames('fix test browser git symbol debug research',{cap:12}).length,12,'a smaller cap still cuts');
// A question does not pay for the edit tools: it is the group of prompts the added words could over-trigger on.
const questionTokens=median(rows.filter(r=>r.kind==='question').map(r=>r.tokens));
assert.ok(questionTokens<=4500,'median schema cost of the questions: '+questionTokens);
assert.deepEqual(selectTaskToolNames('Explain what calc.js does.'),selectTaskToolNames('Hello.'),'a prompt with no task word is offered the baseline only (the real-Hub Playwright test counts on it)');

// Never narrow what was advertised. ORIGINAL is the selector as it was before the added words, frozen on purpose: its base list, its seven groups
// and the order they apply in. Whatever else a prompt says, and however many groups it matches, it is still offered everything ORIGINAL offers it:
// the cap of 48 may cut only what the added words bring, which is why they are applied after the original triggers.
const ORIGINAL_BASE=[
  'read_file','list_directory','find_files','search_files','file_info',
  'git_status','git_diff','get_plan','update_plan','checks_list','checks_run',
  'run_command','tasks_status','tasks_cancel','token_restore',
];
const ORIGINAL_GROUPS=[
  {re:/\b(fix|edit|write|implement|patch|refactor|rename|create|develop|feature|code)\b|sửa|viết|tạo|triển khai|lập trình/i,
   names:['edit_file','write_file','files_apply_patch','files_write_batch','make_directory','move_path','delete_path','rename_symbol','format_document','organize_imports']},
  {re:/\b(test|lint|verify|check|coverage|build|compile|ci)\b|kiểm thử|kiểm tra|biên dịch/i,
   names:['test_discover','test_run','test_results','test_coverage','test_impact_analysis','build_detect','build_run','code_diagnostics']},
  {re:/\b(browser|web ui|frontend|responsive|screenshot|playwright|css|html|accessibility)\b|giao diện|trình duyệt/i,
   names:['browser_launch','browser_navigate','browser_click','browser_fill','browser_screenshot','browser_console','browser_network','browser_close','responsive_check','accessibility_audit','screenshot_compare','visual_diff']},
  {re:/\b(lsp|symbol|reference|definition|dependency|type|ast|tree.?sitter)\b|định nghĩa|tham chiếu|ký hiệu/i,
   names:['repo_map','code_symbols','find_definition','find_references','dependency_graph','code_diagnostics','code_actions','find_implementations','type_hierarchy']},
  {re:/\b(debug|breakpoint|stacktrace|call stack|runtime exception)\b|gỡ lỗi/i,
   names:['debug_start','debug_breakpoint','debug_continue','debug_step','debug_stack','debug_variables','debug_evaluate','debug_stop']},
  {re:/\b(git|branch|commit|merge|worktree|conflict|pull request|github|release)\b|nhánh|hợp nhất/i,
   names:['git_log','git_add','git_commit','git_branch','git_checkout','git_merge','git_conflict_inspect','worktrees_list','worktrees_create','github_workflow_runs','github_pr_review']},
  {re:/\b(research|search web|documentation|docs|internet|dependency lookup)\b|tra cứu|tài liệu/i,
   names:['web_search','web_fetch','web_extract','docs_search','dependency_lookup','github_code_search']},
];
const originalOffer=(prompt,cap=48)=>{
  const set=new Set(ORIGINAL_BASE);
  for(const group of ORIGINAL_GROUPS)if(group.re.test(prompt))for(const name of group.names)set.add(name);
  for(const x of ['repo_map','code_symbols','find_definition'])set.add(x);
  return [...set].slice(0,cap);
};
const narrowed=(prompt,cap=48)=>{
  const now=selectTaskToolNames(prompt,{cap});
  return originalOffer(prompt,cap).filter(name=>!now.includes(name));
};
const ORIGINAL_WORDS=['fix','edit','write','implement','patch','refactor','rename','create','develop','feature','code','sửa','viết','tạo','triển khai','lập trình',
  'test','lint','verify','check','coverage','build','compile','ci','kiểm thử','kiểm tra','biên dịch','browser','web ui','frontend','responsive','screenshot','playwright',
  'css','html','accessibility','giao diện','trình duyệt','lsp','symbol','reference','definition','dependency','type','ast','tree-sitter','định nghĩa','tham chiếu','ký hiệu',
  'debug','breakpoint','stacktrace','call stack','runtime exception','gỡ lỗi','git','branch','commit','merge','worktree','conflict','pull request','github','release',
  'nhánh','hợp nhất','research','search web','documentation','docs','internet','dependency lookup','tra cứu','tài liệu'];
const ADDED_WORDS=['update the readme','run the tests','the last 3 commits','on mobile','who calls it','start the dev server','my PR','the latest version','crashes with ENOENT',
  'organize imports','split it','cập nhật','add a screenshot','which classes implement it','thêm','lỗi'];
const mustKeep=(prompt,cap=48)=>assert.deepEqual(narrowed(prompt,cap),[],'"'+prompt+'" (cap '+cap+') is no longer offered what it was offered before');
for(const p of prompts)mustKeep(p.prompt);
for(const word of ORIGINAL_WORDS)for(const prompt of [word,'please '+word+' now',word.toUpperCase(),'Explain what calc.js does. '+word])mustKeep(prompt);
// One word per original group, every subset of them, each followed by words only the added triggers know.
const oneWordPerGroup=['fix','test','browser','symbol','debug','git','research'];
for(let mask=0;mask<1<<oneWordPerGroup.length;mask++) {
  const original=oneWordPerGroup.filter((_,i)=>mask&(1<<i)).join(' ');
  mustKeep(original);
  for(const added of ADDED_WORDS)for(const cap of [48,30]) {mustKeep(original+' '+added,cap);mustKeep(added+' '+original,cap);}
}
// And sentences of random words, original and added, with random caps (a fixed seed keeps a failure reproducible).
let seed=20241020;
const random=()=>(seed=(seed*1664525+1013904223)>>>0)/2**32;
const vocabulary=[...ORIGINAL_WORDS,...ADDED_WORDS,'the','a','in','src/app.js','please','and','then','to','file','function','add','remove','replace','tests','commits','callers','đổi tên','các thay đổi','cài đặt'];
for(let sentence=0;sentence<3000;sentence++) {
  const words=Array.from({length:2+Math.floor(random()*13)},()=>vocabulary[Math.floor(random()*vocabulary.length)]);
  mustKeep(words.join(' '),[48,48,30,20,12][Math.floor(random()*5)]);
}
// Vietnamese typed in decomposed form (some editors and PDF copies) is the same text, and the prompt is user text: a pasted log stays cheap to scan.
assert.ok(selectTaskToolNames('Cập nhật phiên bản trong package.json'.normalize('NFD')).includes('edit_file'));
const pasted='error  thay  đổi doesnt does '.repeat(10000)+'x'.repeat(100000);
const scanStarted=Date.now();
selectTaskToolNames(pasted);
assert.ok(Date.now()-scanStarted<1500,'scanning a 390 kB prompt took '+(Date.now()-scanStarted)+' ms');

console.log('PASS task-tool-selector: dynamic intent routing, full catalog untouched, exact router fallback; corpus of '+prompts.length+' prompts: '+summary);
