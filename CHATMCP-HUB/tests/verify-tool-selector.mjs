import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalTools } from '../lib/local-tools.mjs';
import {selectTaskToolNames,selectTaskCatalog,taskToolSelectionMode,windowToolSelectionMode,followProviderWindow,LARGE_WINDOW_TOKENS} from '../lib/tool-selector.mjs';
import {directToolsFor,ROUTER_TOOLS,AgentRunner,selectConversationCatalog} from '../lib/agent.mjs';
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
    // One message of the conversation: the first starts it, the others continue it. Resolves with the model requests that run made.
    const say=async(prompt)=>{
      const before=requests.length;
      id=(id===null?await runner.start({prompt,maxSteps:6}):await runner.continue({id,prompt,maxSteps:6})).id;
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

  // A follow-up with no task word keeps what the conversation has been using: "yes, go ahead" after the agent proposed the edit, and the
  // prompts the Hub writes itself (the auto-resume after a restart, the repair prompt of a coding worker).
  {
    const chat=conversation();
    try{
      const [one]=await chat.say('Fix the failing test in calc.js');
      const [two]=await chat.say('yes, go ahead');
      for(const tool of ['edit_file','test_run'])assert.ok(one.offered.includes(tool)&&two.offered.includes(tool),'"yes, go ahead" is still offered '+tool);
      assert.deepEqual(sorted(two.offered),sorted(one.offered),'the same tools as the message it answers');
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
