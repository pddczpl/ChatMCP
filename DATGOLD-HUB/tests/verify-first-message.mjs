import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
// fileURLToPath (not URL.pathname) so Windows drive paths stay valid: "/F:/x" -> "F:\x".
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/, '');
const { browserInstructions, BrowserRunner }=await import(pathToFileURL(root+'/lib/browser-runner.mjs').href+'?test='+Date.now());
const longTools=Array.from({length:400},(_,i)=>({name:`desktop-commander.fake_tool_number_${i}`,description:'test'}));
const task={id:'7ecb4109-d92a-472c-818b-1ce8b46bfa16',nonce:'a'.repeat(48),workspace:{path:'F:\\Projects\\sensor-fusion-lab'},prompt:'Đọc README, RULES, RUBRIC, CHECKPOINTS và SUBMISSION trước. Rà soát cấu trúc dự án, đọc các file nguồn, notebook và cấu hình liên quan để xác định phần còn thiếu. Hoàn thành bài lab theo đúng yêu cầu của repository, giữ những thay đổi tôi đã có. Chạy các kiểm tra mà dự án hướng dẫn và sửa lỗi liên quan nếu có.'};
const intro=browserInstructions({tools:longTools},task);
assert.ok(Buffer.byteLength(intro)<4800,'Intro must remain compact despite a huge catalog');
assert.match(intro,/400 available MCP tools/);
assert.match(intro,/kind":"tool/);
assert.ok(!intro.includes('fake_tool_number_1'), 'No giant tool name dump');
console.log('PASS short browser intro',Buffer.byteLength(intro,'utf8'),'bytes');
// Test paging via BrowserRunner, using a synthetic live context, without networking.
let fake={manager:{},directory:'/tmp',tasks:new Map()};
const runner=new BrowserRunner(fake);
const huge='abc'.repeat(10000);
const context={pagedResults:new Map(),catalog:{tools:[],servers:{}},index:new Map()};
context.pagedResults.set('result-1',huge);
let out='';
for(let cursor=0;cursor!==null;){const page=await runner.dispatch(context,{kind:'result_page',resultId:'result-1',offset:cursor,limit:1000});out+=page.text;cursor=page.nextOffset;}
assert.equal(out,huge);
const unicodePayload = 'a'.repeat(999) + '😀' + 'b'.repeat(2000);
context.pagedResults.set('unicode-result',unicodePayload);
const firstUnicodePage = await runner.dispatch(context,{kind:'result_page',resultId:'unicode-result',offset:0,limit:1000});
assert.equal(firstUnicodePage.nextOffset,999,'do not cut the UTF-16 surrogate pair');
let unicodeRebuilt='';
for(let cursor=0;cursor!==null;){const page=await runner.dispatch(context,{kind:'result_page',resultId:'unicode-result',offset:cursor,limit:1000});unicodeRebuilt+=page.text;cursor=page.nextOffset;}
assert.equal(unicodeRebuilt,unicodePayload);
await assert.rejects(()=>runner.dispatch(context,{kind:'result_page',resultId:'unicode-result',offset:1000,limit:10}),/giữa một ký tự Unicode/);
console.log('PASS bounded paging incl. UTF-16 boundary',huge.length,'chars');
const routeFile=fs.readFileSync(root+'/extension/chat-route.js','utf8');
let browserFile=fs.readFileSync(root+'/extension/browser-runner.js','utf8');
browserFile=browserFile.replace(/\}\)\(\);\s*$/,'  globalThis.__fixture={ownUser, routeStatus, routeFailure, authored, update(x){current=x;}};\n})();');
const view={url:'https://chatgpt.com/',users:[],editor:null};
const window={};window.top=window;
const cssInvisible=()=>null;
const document={
  querySelectorAll(selector){
    if(selector==='[data-message-author-role="user"]') return view.users.filter(n=>n.hasAttribute('data-message-author-role'));
    if(selector==='[data-testid="user-message"]') return view.users.filter(n=>n.hasAttribute('data-testid'));
    if(selector==='#prompt-textarea') return view.editor?[view.editor]:[];
    return [];
  },
};
function elm(text,{role=false,testId=false,children=[]}={}){
  const n={tagName:'DIV',innerText:text,textContent:text,disabled:false,readOnly:false,parentElement:null,
    getAttribute(s){return s==='data-message-author-role'&&role?'user':s==='data-testid'&&testId?'user-message':null;},hasAttribute(s){return (s==='data-message-author-role'&&role)||(s==='data-testid'&&testId);},
    querySelectorAll(selector){return selector==='[data-testid="user-message"],[data-testid="message-content"],[data-message-content],.whitespace-pre-wrap,.prose'?children:[];},
    getBoundingClientRect(){return {width:150,height:25}},
    closest(s){return null;},
    cloneNode(){return {textContent:text,querySelectorAll(){return []}}}
  };
  return n;
}
const child=elm(intro);child.closest=selector=>selector==='[data-message-author-role]'?null:null;
const contextGlobals={ URL,window,location:{get origin(){return 'https://chatgpt.com'},get pathname(){return new URL(view.url).pathname}},document,
  chrome:{runtime:{id:'abcdefabcdefabcdefabcdefabcdefab',onMessage:{addListener(){}}}},crypto:{randomUUID(){return 'rand-id'},subtle:{}},setInterval(){},getComputedStyle(){return {visibility:'visible',display:'block'}},TextEncoder,Node:{DOCUMENT_POSITION_FOLLOWING:4},globalThis:null
};
contextGlobals.globalThis=contextGlobals;
vm.runInNewContext(routeFile,contextGlobals);
vm.runInNewContext(browserFile,contextGlobals);
const t=contextGlobals.__fixture;
function current(stage='sending') {return {route:'/',taskId:task.id,promptNormalized:intro.replace(/\s+/g,' ').trim(),turn:1,stage,routeLocked:false,routePendingSince:null,stableText:null,stableSince:0,provisionalReplySince:null,text:intro};}
view.url='https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b';
let outer=elm('You said:\n'+intro+'\nCopy\nEdit',{role:true,children:[elm(intro)]});
outer.querySelectorAll=(selector)=>selector==='[data-testid="user-message"],[data-testid="message-content"],[data-message-content],.whitespace-pre-wrap,.prose'?[{...elm(intro),closest(sel){return sel==='[data-message-author-role]'?outer:null}}]:[];
view.users=[outer];t.update(current());
assert.equal(t.routeStatus(),'ok');
assert.equal(t.ownUser(),outer);
console.log('PASS home->conversation with chat wrapper UI labels');
const stripped=elm(intro,{testId:true});view.users=[stripped];t.update(current());
assert.equal(t.routeStatus(),'ok');
assert.equal(t.ownUser(),stripped);
console.log('PASS home->conversation with user-message test ID only');
view.users=[elm('Completely different user message',{role:true})];t.update(current());
assert.equal(t.routeStatus(),'pending');
let now=Date.now();const delayed=current();delayed.routePendingSince=now-91000;t.update(delayed);
assert.equal(t.routeStatus(),'blocked');
assert.match(t.routeFailure(),/submitted_user_message_unverified/);
console.log('PASS fail-closed for foreign conversation / unverified user message');
