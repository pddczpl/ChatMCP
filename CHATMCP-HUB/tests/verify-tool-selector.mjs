import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
// A tool the prompt needs but the selector did not offer is a detour; the file-changing tools below are the ones whose absence strands an
// ordinary edit prompt ("Update the version in package.json", "Remove the unused helper", "Convert this file to TypeScript").
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
// The bound is generous on purpose (this takes under 0.1 s on Node 24; a slower runner or Node 22 must not trip it): a pattern that backtracks
// badly on 390 kB would take minutes.
assert.ok(selectTaskToolNames('Cập nhật phiên bản trong package.json'.normalize('NFD')).includes('edit_file'));
const pasted='error  thay  đổi doesnt does '.repeat(10000)+'x'.repeat(100000);
const scanStarted=Date.now();
selectTaskToolNames(pasted);
assert.ok(Date.now()-scanStarted<5000,'scanning a 390 kB prompt took '+(Date.now()-scanStarted)+' ms');

// The selection follows the conversation, not its first message. The preflight of every run used to select on task.prompt, which is set once,
// when the task is created, so "Now update the version in package.json and commit it." was offered the tools that "Explain what calc.js does."
// had selected. Here the real AgentRunner, the real 99-tool catalog and a scripted model: what each model request is offered.
const conversations=await fsp.mkdtemp(path.join(os.tmpdir(),'chatmcp-tool-selection-'));
try{
  let workspaces=0;
  const routerNames=new Set(ROUTER_TOOLS.map(t=>t.name));
  const finalAnswer=(text)=>({status:'completed',output:[{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text}]}]});
  const readFile=(callId)=>({status:'completed',output:[{type:'function_call',call_id:callId,name:'read_file',status:'completed',arguments:JSON.stringify({path:'package.json'})}]});
  // script({requests,runner}) answers the model; every request is recorded: the functions it offered, its instructions and its input.
  // onSession({runner}) runs while a run is preparing (the tool session is opened), which is after the task is running and before tools are selected.
  const conversation=({mode='auto',script=()=>finalAnswer('Done.'),onSession=null}={})=>{
    const requests=[],root=path.join(conversations,'workspace-'+(++workspaces));
    let locked=false,id=null;
    const manager={secrets:[],workspace:root,generation:1,instanceId:'tool-selection',
      state(){return {workspace:{path:root},generation:1,instanceId:'tool-selection',services:{}};},
      acquireTask(){if(locked)return false;locked=true;return true;},releaseTask(){locked=false;},
      async createAgentSession(){
        await onSession?.({runner});
        return {catalog:{tools:fake.definitions(),prompts:[],resources:[],resourceTemplates:[],servers:{}},async close(){},
          async callTool(){return {isError:false,content:[{type:'text',text:'{"version":"1.0.0"}'}],structuredContent:{notVerified:true}};}};
      }};
    const provider={ready:()=>true,snapshot:()=>({provider:'fixture',model:'fixture'}),
      async respond({input,instructions,tools}) {
        requests.push({offered:tools.map(t=>t.name).filter(name=>!routerNames.has(name)),instructions,input:structuredClone(input)});
        return script({requests,runner});
      }};
    const runner=new AgentRunner({manager,provider,taskDirectory:path.join(root,'tasks'),toolSelectionMode:mode});
    // One message of the conversation: the first starts it, the others continue it. Resolves with the model requests that run made. `options` are more
    // arguments of runner.start() for the message that starts the conversation.
    const say=async(prompt,options={})=>{
      const before=requests.length;
      id=(id===null?await runner.start({prompt,...options,maxSteps:6}):await runner.continue({id,prompt,maxSteps:6})).id;
      for(let i=0;i<1500&&runner.get(id).status==='running';i++)await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(runner.get(id).status,'completed',runner.get(id).error);
      return requests.slice(before);
    };
    return {runner,requests,say,directory:path.join(root,'tasks'),get id() {return id;}};
  };
  const transcript=(chat)=>fs.readFileSync(path.join(chat.directory,chat.id,'transcript.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const offeredAsFirst=(prompt)=>offeredFor(prompt).map(f=>f.name).sort();
  const sorted=(names)=>[...names].sort();

  // The problem as it was reported: a read-only first message, then a continuation that asks for an edit and a commit.
  {
    const first='Explain what calc.js does.',second='Now update the version in package.json and commit it.';
    const chat=conversation();
    try{
      const [one]=await chat.say(first);
      const [two]=await chat.say(second);
      assert.deepEqual(sorted(one.offered),offeredAsFirst(first),'the first message of a conversation is offered what it always was');
      for(const tool of ['edit_file','git_commit'])assert.ok(!one.offered.includes(tool),'a question about calc.js is not offered '+tool);
      for(const tool of ['edit_file','write_file','git_add','git_commit','read_file'])assert.ok(two.offered.includes(tool),'the continuation is offered '+tool);
      assert.deepEqual(sorted(two.offered),offeredAsFirst(second),'and what the same message would be offered as the first message of a conversation');
    }finally{await chat.runner.shutdown();}
  }

  // A follow-up with no task word keeps what the conversation has been using: "yes, go ahead" after the agent proposed the edit.
  {
    const chat=conversation();
    try{
      const [one]=await chat.say('Fix the failing test in calc.js');
      const [two]=await chat.say('yes, go ahead');
      for(const tool of ['edit_file','test_run'])assert.ok(one.offered.includes(tool)&&two.offered.includes(tool),'"yes, go ahead" is still offered '+tool);
      assert.deepEqual(sorted(two.offered),sorted(one.offered),'the same tools as the message it answers');
    }finally{await chat.runner.shutdown();}
  }

  // A follow-up that names only part of the work keeps the rest. The prompts the Hub writes itself (the auto-resume after a restart, the repair
  // prompt of a coding worker) name the edit and test tools and not what the conversation used besides, such as the browser.
  {
    const first='Open the app in the browser and take a screenshot.',second='Now fix the failing test.';
    const chat=conversation();
    try{
      const [one]=await chat.say(first);
      const [two]=await chat.say(second);
      for(const tool of ['browser_launch','browser_screenshot'])assert.ok(one.offered.includes(tool)&&!offeredAsFirst(second).includes(tool),'(only the first message asks for '+tool+')');
      assert.ok(!one.offered.includes('edit_file')&&offeredAsFirst(second).includes('edit_file'));
      for(const tool of ['edit_file','test_run','browser_launch','browser_screenshot'])assert.ok(two.offered.includes(tool),'the second message is offered '+tool);
    }finally{await chat.runner.shutdown();}
  }

  // The run's own prompt selects first. The cap cuts by group order, not by prompt: these prompts joined would lose git_commit to the cap, so a
  // follow-up after a long first request would be offered no commit tool. A message is offered at least what it is offered as the first message.
  {
    const earlier='Fix the frontend browser UI, run the tests and check the symbol definition.',current='Commit it.';
    assert.equal(selectTaskToolNames(earlier).length,48,'(the first request fills the cap)');
    assert.ok(selectTaskToolNames(current).includes('git_commit')&&!selectTaskToolNames(earlier).includes('git_commit'));
    assert.ok(!selectTaskToolNames(earlier+'\n'+current).includes('git_commit'),'(and the prompts joined lose git_commit; if the selector changes, pick another pair)');
    const chat=conversation();
    try{
      await chat.say(earlier);
      const [two]=await chat.say(current);
      for(const tool of offeredAsFirst(current))assert.ok(two.offered.includes(tool),'"'+current+'" after a full-cap request is offered '+tool);
      for(const tool of ['edit_file','test_run'])assert.ok(two.offered.includes(tool),'and, with the room that is left, '+tool+' of the request before');
      assert.ok(two.offered.length<=48,'under the cap of 48: '+two.offered.length);
    }finally{await chat.runner.shutdown();}
  }

  // The event and the instruction line say which prompt the schemas were selected from.
  {
    const first='Explain what calc.js does.',second='Now update the version in package.json and commit it.';
    const filling='Fix the frontend browser UI, run the tests and check the symbol definition.';
    const chat=conversation();
    try{
      const [one]=await chat.say(first);
      const [two]=await chat.say(second);
      const [three]=await chat.say(filling);
      const selections=transcript(chat).filter(entry=>entry.type==='tool_selection');
      assert.equal(selections.length,3,'one tool_selection event per run');
      assert.deepEqual(selections.map(entry=>[entry.detail.basis.runPrompt,entry.detail.basis.earlierPromptsRead]),[[first,0],[second,1],[filling,0]],
        'the event names the prompt of the run and counts the earlier ones it read (none when the run prompt filled the cap by itself)');
      assert.deepEqual(selections.map(entry=>entry.detail.basis.fromRunPrompt),[first,second,filling].map(prompt=>selectTaskToolNames(prompt).length),'and how many tools the run prompt selected by itself');
      assert.deepEqual(selections.map(entry=>entry.detail.basis.cap),[48,48,48]);
      assert.ok(selections.every(entry=>entry.detail.basis.fromRunPrompt+entry.detail.basis.fromEarlierPrompts<=48),'the two add up to at most the cap');
      assert.equal(selections[0].detail.basis.fromEarlierPrompts+selections[2].detail.basis.fromEarlierPrompts,0,'the first message has no earlier prompt to read and the third filled the cap alone');
      assert.deepEqual(selections[1].detail.offered,two.offered,'and lists what the model was offered');
      assert.ok(/selected from this run's prompt and 1 earlier prompt of the conversation\.$/.test(selections[1].message),selections[1].message);
      assert.ok(/selected from this run's prompt\.$/.test(selections[0].message)&&/selected from this run's prompt\.$/.test(selections[2].message),selections[0].message+' | '+selections[2].message);
      assert.ok(one.instructions.includes('task-selected from the request that started this run.')&&!one.instructions.includes('before it'),'the instructions of a first message');
      assert.ok(two.instructions.includes('task-selected from the request that started this run and the 1 before it in this conversation.'),'and of a continuation');
      assert.ok(three.instructions.includes('task-selected from the request that started this run.')&&!three.instructions.includes('before it'),'and of a request that fills the cap by itself');
    }finally{await chat.runner.shutdown();}
  }

  // A message queued while a run is going is delivered to that run, which keeps the tool list it started with (its context budget was planned on
  // that list); the next run of the conversation selects on the queued message too, though "ok" names no task.
  {
    const queued='Also update the version in package.json and commit it.';
    const chat=conversation({script:async({requests,runner})=>{
      if(requests.length>1)return finalAnswer('Done.');
      await runner.enqueueMessage({id:runner.activeTaskId,prompt:queued});
      return readFile('call-1');
    }});
    try{
      const [one,two]=await chat.say('Explain what calc.js does.');
      assert.equal(chat.requests.length,2);
      assert.deepEqual(two.offered,one.offered,'the run keeps the tool list it started with');
      for(const tool of ['edit_file','git_commit'])assert.ok(!two.offered.includes(tool),'a queued message does not add '+tool+' to the run');
      assert.ok(!JSON.stringify(one.input).includes(queued)&&JSON.stringify(two.input).includes(queued),'the message reaches the model, in the same run');
      assert.equal(two.instructions,one.instructions);
      assert.ok(one.instructions.includes('The list is fixed for this run: a message that arrives while you work is delivered to you, but it does not add schemas to this list.'),'the model is told so');
      const note=chat.runner.get(chat.id).events.find(event=>event.type==='user_message_queued');
      assert.ok(note&&note.message.includes('Danh sách công cụ của lần chạy này giữ nguyên'),'and so is the person who sent it: '+note?.message);
      const [next]=await chat.say('ok');
      for(const tool of ['edit_file','git_commit'])assert.ok(next.offered.includes(tool),'the next run is offered '+tool+' because of the queued message');
    }finally{await chat.runner.shutdown();}
  }

  // A message queued while the run is still preparing (the task is running, the tools are not selected yet) is part of the conversation when the
  // tools are selected, and the run's own prompt is not counted twice or mistaken for an earlier one.
  {
    const queued='Also commit it.';
    let queuedYet=false;
    const chat=conversation({onSession:async({runner})=>{
      if(queuedYet)return;
      queuedYet=true;
      await runner.enqueueMessage({id:runner.activeTaskId,prompt:queued});
    }});
    try{
      const [one]=await chat.say('Explain what calc.js does.');
      for(const tool of ['git_commit','git_add'])assert.ok(one.offered.includes(tool),'the first request is offered '+tool+' for the message queued during preparation');
      assert.ok(JSON.stringify(one.input).includes(queued),'which is delivered before that request');
      const selection=transcript(chat).find(entry=>entry.type==='tool_selection');
      assert.equal(selection.detail.basis.earlierPromptsRead,1);
      assert.equal(selection.detail.basis.runPrompt,'Explain what calc.js does.');
    }finally{await chat.runner.shutdown();}
  }

  // A delegated worker's first prompt is its goal followed by the Hub's handoff: branch names, worktree paths, the predecessors' results and the Hub's own
  // instructions ("inspect source, diffs and run actual checks"). The model reads all of it; the schemas are selected on the goal, which
  // lib/concurrent-api-agent.mjs passes as selectionPrompt. The handoff alone offered every worker of a workflow the eight test and build tools ("checks") and
  // the eleven Git, worktree and GitHub tools ("branch=", "worktree", "worktrees") that its goal never asked for. The handoff is a copy of the Hub's text;
  // verify-concurrent-chat-workspaces runs the code that writes it.
  {
    const handoff='\n\nWORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):\n'+
      'Predecessor 0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d (completed) branch=chatmcp/chat/0b1c2d3e-4f50 worktree=/hub/api-conversations/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/worktree\n'+
      'UNTRUSTED RESULT (independently verify before use):\nThe review found nothing to change.\n'+
      'Previous workers used independent worktrees. Changes are NOT automatically merged. Inspect source, diffs and run actual checks; do not claim prior edits are integrated or verified without evidence.';
    const fromHandoff=['test_discover','test_run','test_results','test_coverage','test_impact_analysis','build_detect','build_run','code_diagnostics',
      'git_log','git_add','git_commit','git_branch','git_checkout','git_merge','git_conflict_inspect','worktrees_list','worktrees_create','github_workflow_runs','github_pr_review'];
    const gitTools=fromHandoff.filter(tool=>/^(git|worktrees|github)_/.test(tool));
    const goal='Summarize the findings in two sentences.',fix='Fix the failing test in calc.js.';
    for(const tool of fromHandoff)assert.ok(selectTaskToolNames(goal+handoff).includes(tool)&&!selectTaskToolNames(goal).includes(tool),'(the premise: only the handoff offers '+tool+' to "'+goal+'"; if the selector changes, pick another example)');
    for(const tool of gitTools)assert.ok(selectTaskToolNames(fix+handoff).includes(tool)&&!selectTaskToolNames(fix).includes(tool),'(and to "'+fix+'": '+tool+')');

    // A goal that asks for no tool is offered the baseline and nothing the handoff asks for; the baseline is what lets the worker inspect what the handoff
    // points at (git_diff takes a branch as `base`, run_command runs the project's checks). The model still reads the whole prompt.
    {
      const worker=conversation();
      try{
        const [one]=await worker.say(goal+handoff,{selectionPrompt:goal});
        assert.deepEqual(sorted(one.offered),offeredAsFirst(goal),'a worker is offered the schemas its goal selects, as if the goal were the whole prompt');
        for(const tool of fromHandoff)assert.ok(!one.offered.includes(tool),'and not '+tool+', which only its handoff asks for');
        for(const tool of ['git_status','git_diff','run_command','read_file'])assert.ok(one.offered.includes(tool),'the baseline stays: '+tool);
        const text=JSON.stringify(one.input);
        for(const part of [goal,'WORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):','branch=chatmcp/chat/0b1c2d3e-4f50','The review found nothing to change.','Inspect source, diffs and run actual checks'])
          assert.ok(text.includes(part),'the model still reads the whole prompt: "'+part+'"');
        const selection=transcript(worker).find(entry=>entry.type==='tool_selection');
        assert.equal(selection.detail.basis.runPrompt,goal,'the event names the text the schemas were selected on, not the handoff');
        assert.equal(selection.detail.basis.fromRunPrompt,selectTaskToolNames(goal).length,'and how many tools it selected');
        assert.deepEqual(selection.detail.offered,one.offered,'and lists what the model was offered');
        assert.equal(worker.runner.get(worker.id).prompts[0].selectionText,goal);
        const [two]=await worker.say('ok');
        assert.deepEqual(sorted(two.offered),offeredAsFirst('ok'),'the next message reads the goal of the first prompt, not its handoff: the baseline');
      }finally{await worker.runner.shutdown();}
    }

    // A goal that asks for edits and tests is offered those, and "yes, go ahead" keeps them: the first prompt counts by its goal. Not the Git tools.
    {
      const worker=conversation();
      try{
        const [one]=await worker.say(fix+handoff,{selectionPrompt:fix});
        assert.deepEqual(sorted(one.offered),offeredAsFirst(fix));
        for(const tool of ['edit_file','test_run'])assert.ok(one.offered.includes(tool),'the goal asks for '+tool);
        for(const tool of gitTools)assert.ok(!one.offered.includes(tool),'and not for '+tool);
        const [two]=await worker.say('yes, go ahead');
        assert.deepEqual(sorted(two.offered),sorted(one.offered),'"yes, go ahead" is offered what the goal selected, and still not '+gitTools[0]+' and the other Git tools');
      }finally{await worker.runner.shutdown();}
    }

    // Without a selectionPrompt, or with one that is the prompt, the schemas are selected on the whole prompt exactly as before (a worker without
    // predecessors has no handoff: its prompt is its goal), and the event names that prompt.
    for(const [label,options] of [['no selectionPrompt',{}],['a selectionPrompt that is the prompt',{selectionPrompt:fix+handoff}]]){
      const worker=conversation();
      try{
        const [one]=await worker.say(fix+handoff,options);
        assert.deepEqual(sorted(one.offered),offeredAsFirst(fix+handoff),label+': the schemas of the whole prompt, as before');
        for(const tool of gitTools)assert.ok(one.offered.includes(tool),label+': whole, the prompt is offered '+tool);
        const selection=transcript(worker).find(entry=>entry.type==='tool_selection');
        assert.equal(selection.detail.basis.runPrompt,(fix+handoff).slice(0,300),label+': the event names the prompt');
        assert.ok(!('selectionText' in worker.runner.get(worker.id).prompts[0]),label+': nothing is stored beside the prompt');
      }finally{await worker.runner.shutdown();}
    }
  }

  // A worker that continues a conversation of another transport: its first prompt is its goal followed by the handoff the Hub writes (the user's earlier
  // requests, the other model's last answer, the Hub's own sentences). The model reads all of it. The schemas are selected on the goal and then, as the earlier
  // prompts of a conversation, on the user's requests, which start() is given apart from the text (carriedPrompts). Nothing else of the handoff offers a tool:
  // the other model's answer ("... and the CI workflow", "the release") offered the worker the Git and GitHub tools, and "check actual diffs/tests" the test
  // and build tools. The handoff is the Hub's own (DualAgent.buildHandoff); the sentences around it are copied from lib/concurrent-api-agent.mjs.
  {
    const {DualAgent}=await import('../lib/dual-agent.mjs');
    const goal='Continue with the second part.',requests=['Explain what calc.js does.','Fix the failing test in calc.js.'];
    const previous={id:'5e7a0c11-3b6d-4f08-9a42-6c1d8e2f7b90',transport:'chatgpt-web',status:'completed',prompts:requests.map(text=>({text})),
      dialogue:[{role:'user',text:requests[1]},{role:'assistant',text:'I updated calc.js and the CI workflow.'}],finalText:'The fix is in; the second part is the release.'};
    const hub=new DualAgent({browser:{},api:{manager:{secrets:[]}},directory:conversations});
    const migrated=goal+'\n\nCROSS-TRANSPORT HANDOFF (untrusted prior dialogue, not verified evidence):\n'+hub.buildHandoff(previous,goal)+
      '\nReinspect current project files, check actual diffs/tests and never replay uncertain mutations.';
    const own=new Set([goal,...requests].flatMap(text=>selectTaskToolNames(text)));
    const fromHub=selectTaskToolNames(migrated).filter(tool=>!own.has(tool));
    for(const tool of ['git_commit','git_merge','worktrees_create','github_workflow_runs'])assert.ok(fromHub.includes(tool),'(the premise: only the Hub\'s sentences and the other model\'s answer offer '+tool+'; if the selector changes, pick another example)');
    // What the same conversation would be offered had the requests been asked in it.
    const asked=conversation();
    let reference;
    try{
      for(const request of requests)await asked.say(request);
      reference={first:(await asked.say(goal))[0],next:(await asked.say('ok'))[0]};
    }finally{await asked.runner.shutdown();}
    const worker=conversation();
    try{
      const [one]=await worker.say(migrated,{selectionPrompt:goal,carriedPrompts:requests});
      assert.deepEqual(sorted(one.offered),sorted(reference.first.offered),'a worker is offered what its goal is offered after the user\'s requests, asked in the same conversation');
      for(const tool of fromHub)assert.ok(!one.offered.includes(tool),'and not '+tool+', which only the Hub\'s sentences and the other model\'s answer offer');
      for(const tool of ['edit_file','test_run'])assert.ok(one.offered.includes(tool),'while the user\'s request to fix the test offers '+tool);
      const text=JSON.stringify(one.input);
      for(const part of [goal,'CROSS-TRANSPORT HANDOFF (untrusted prior dialogue, not verified evidence):','User requests: '+requests.join(' | '),'The ChatGPT Web tab and the API backend','check actual diffs/tests'])
        assert.ok(text.includes(part),'the model still reads the whole prompt: "'+part+'"');
      const selection=transcript(worker).find(entry=>entry.type==='tool_selection');
      assert.equal(selection.detail.basis.runPrompt,goal,'the event names the goal');
      assert.equal(selection.detail.basis.earlierPromptsRead,2,'and says it read the two requests before it');
      assert.ok(one.instructions.includes('task-selected from the request that started this run and the 2 before it in this conversation.'),'the instructions say so too');
      const entry=worker.runner.get(worker.id);
      assert.deepEqual(entry.prompts.map(prompt=>prompt.text),[migrated],'the conversation holds the worker\'s own prompt only: the requests are not prompts of it');
      const [two]=await worker.say('ok');
      assert.deepEqual(sorted(two.offered),sorted(reference.next.offered),'the next message is offered what it is offered after those requests: they stay in the conversation');
      for(const tool of ['edit_file','test_run'])assert.ok(two.offered.includes(tool),'including '+tool);
      for(const tool of fromHub)assert.ok(!two.offered.includes(tool),'and still not '+tool);
    }finally{await worker.runner.shutdown();}
  }

  // A conversation across the kinds of prompt of the corpus: each message is offered at least what it is offered alone, never more than the cap.
  {
    const kinds=KINDS.map(kind=>prompts.find(p=>p.kind===kind));
    const chat=conversation();
    try{
      for(const p of kinds) {
        const [request]=await chat.say(p.prompt);
        for(const tool of offeredAsFirst(p.prompt))assert.ok(request.offered.includes(tool),p.id+' ('+p.kind+') after '+(chat.requests.length-1)+' messages is offered '+tool);
        assert.ok(request.offered.length<=48,p.id+': under the cap of 48: '+request.offered.length);
      }
    }finally{await chat.runner.shutdown();}
  }

  // The full list is not selected, whatever the conversation says: every local tool in every request, no selection recorded, and a queued message
  // is not told that a tool list is kept (there is nothing to keep).
  {
    const chat=conversation({mode:'full',script:async({requests,runner})=>{
      if(requests.length!==1)return finalAnswer('Done.');
      await runner.enqueueMessage({id:runner.activeTaskId,prompt:'Also commit it.'});
      return readFile('call-1');
    }});
    try{
      const [one,queuedRun]=await chat.say('Explain what calc.js does.');
      const [two]=await chat.say('Now update the version in package.json and commit it.');
      for(const request of [one,queuedRun,two]) {
        assert.equal(request.offered.length,catalog.tools.length,'full mode offers every local tool');
        assert.ok(!request.instructions.includes('task-selected'));
      }
      assert.ok(!transcript(chat).some(entry=>entry.type==='tool_selection'),'and records no selection');
      const queued=chat.runner.get(chat.id).events.filter(event=>event.type==='user_message_queued');
      assert.equal(queued.length,1);
      assert.ok(!queued[0].message.includes('Danh sách công cụ'),queued[0].message);
    }finally{await chat.runner.shutdown();}
  }

  // The same selection as a pure function, over many histories: whatever has been said before, a message is offered at least what it is offered as
  // the first message of a conversation, within the cap, and a conversation of one message is selected exactly as selectTaskCatalog does.
  {
    // Imported here and not at the top: run against an agent.mjs without it, the blocks above fail first, on the behaviour they test.
    const {selectConversationCatalog}=await import('../lib/agent.mjs');
    const offeredBy=(selection)=>directToolsFor(selection.catalog).functions.map(f=>f.name);
    for(const p of prompts) {
      assert.deepEqual(selectConversationCatalog(catalog,p.prompt).catalog.tools,selectTaskCatalog(catalog,p.prompt).tools,p.id+': a conversation of one message is selected as before');
      const history=Array.from({length:Math.floor(random()*30)},()=>prompts[Math.floor(random()*prompts.length)].prompt);
      const selection=selectConversationCatalog(catalog,p.prompt,history);
      const offered=new Set(offeredBy(selection));
      for(const tool of offeredAsFirst(p.prompt))assert.ok(offered.has(tool),p.id+' after '+history.length+' messages is no longer offered '+tool);
      assert.ok(selection.fromRunPrompt+selection.fromEarlierPrompts<=48&&selection.catalog.tools.length<=48,p.id+': the cap of 48');
      assert.ok(selection.earlierPromptsRead<=Math.min(history.length,20));
    }
    // Only the last 20 earlier prompts are read (the window of the conversation checkpoint the model is shown) ...
    assert.ok(!offeredBy(selectConversationCatalog(catalog,'ok',['Fix the bug',...Array(20).fill('ok')])).includes('edit_file'),'the 21st prompt back is not read');
    assert.ok(offeredBy(selectConversationCatalog(catalog,'ok',['Fix the bug',...Array(19).fill('ok')])).includes('edit_file'),'the 20th is');
    // ... and the newest first, when there is room for one of two.
    const room=(history)=>offeredBy(selectConversationCatalog(catalog,'Hello.',history,{cap:24}));
    assert.ok(room(['Commit it.','Fix the bug.']).includes('edit_file')&&!room(['Commit it.','Fix the bug.']).includes('git_commit'),'the newest earlier prompt fills the room first');
    assert.ok(room(['Fix the bug.','Commit it.']).includes('git_commit')&&!room(['Fix the bug.','Commit it.']).includes('edit_file'));
    assert.throws(()=>selectConversationCatalog(catalog,'x',[],{cap:0}),TypeError);
    // A run prompt that fills the cap by itself leaves the earlier prompts unread; a tool of another server with a local name is not offered.
    const filling='Fix the frontend browser UI, run the tests and check the symbol definition.';
    const full=selectConversationCatalog(catalog,filling,['Commit it.','Fix the bug.']);
    assert.deepEqual([full.fromRunPrompt,full.earlierPromptsRead,full.fromEarlierPrompts],[48,0,0]);
    const some=selectConversationCatalog(catalog,'Hello.',['Commit it.','Fix the bug.'],{cap:24});
    assert.deepEqual([some.fromRunPrompt,some.earlierPromptsRead,some.fromEarlierPrompts],[selectTaskToolNames('Hello.',{cap:24}).length,1,24-selectTaskToolNames('Hello.',{cap:24}).length],'and one that leaves some room reads as many as the room needs');
    const mixed={tools:[...catalog.tools,{name:'remote.read_file',originalName:'read_file',server:'remote',inputSchema:{type:'object'}}]};
    assert.deepEqual(selectConversationCatalog(mixed,'Fix the bug.',['Commit it.']).catalog.tools.filter(tool=>tool.server!=='local'),[],'only the local server is offered directly, as selectTaskCatalog does');
    assert.deepEqual(selectConversationCatalog(mixed,'Fix the bug.').catalog.tools,selectTaskCatalog(mixed,'Fix the bug.').tools);
  }
}finally{await fsp.rm(conversations,{recursive:true,force:true,maxRetries:8,retryDelay:150});}

console.log('PASS task-tool-selector: dynamic intent routing, full catalog untouched, exact router fallback, a conversation selects on the prompt of each run and then the earlier ones; corpus of '+prompts.length+' prompts: '+summary);
