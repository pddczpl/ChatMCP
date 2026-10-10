import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const base=new URL('../',import.meta.url);
const route=fs.readFileSync(new URL('extension/chat-route.js',base),'utf8');
const code=fs.readFileSync(new URL('extension/browser-runner.js',base),'utf8');
const injected=code.replace(/\}\)\(\);\s*$/,'  globalThis.__test={prepare,send,check,get(){return current;}};\n})();');
const taskId='718c9f5c-a637-44b8-b6e5-83787d0b7cf2';
const nonce='bf652a94fdf059de0a20c45199b8775682b7a668b24e23af';
const currentMessages=[
 {chatmcp_hub:'v1',task:taskId,turn:1,nonce,kind:'describe',name:'desktop-commander.list_directory'},
 {chatmcp_hub:'v1',task:taskId,turn:2,nonce,kind:'tool',name:'desktop-commander.list_directory',arguments:{path:'F:\\project',depth:1}},
 {chatmcp_hub:'v1',task:taskId,turn:3,nonce,kind:'final',text:'5 files observed in read-only mode'}
];
const view={url:'https://chatgpt.com/',blocks:[],buttonClicks:0};
class FakeArea {
 constructor(){this._value='';this.tagName='TEXTAREA';this.disabled=false;this.readOnly=false;this.parentElement=null;}
 get value(){return this._value;}
 set value(v){this._value=v;}
 closest(){return null;}
 getAttribute(){return null;}
 getBoundingClientRect(){return {width:500,height:40};}
 focus(){}
 dispatchEvent(){return true;}
}
const area=new FakeArea();
const button={tagName:'BUTTON',disabled:false,form:null,
 getAttribute(n){return n==='data-testid'?'send-button':n==='aria-label'?'Send':n==='type'?'button':null;},
 closest(){return null;},getBoundingClientRect(){return {width:40,height:40};},
 click(){
   view.buttonClicks++;
   const response=currentMessages[view.buttonClicks-1];
   if(!response) throw new Error('Unexpected additional click');
   view.url='https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b';
   const raw=`JSON\n${JSON.stringify(response,null,2)}\nCopy`;
   view.blocks.push({tagName:'DIV',textContent:raw,innerText:raw,
      querySelector(){return null;},closest(){return null;},
      getBoundingClientRect(){return {width:450,height:200};}});
   area.value='';
 }
};
const container={tagName:'DIV',parentElement:{tagName:'MAIN'},closest(){return null;},querySelector(){return null;},querySelectorAll(s){return s==='button'?[button]:[];}};
area.parentElement=container;
const document={
 querySelectorAll(s){
  if(s==='#prompt-textarea')return [area];
  if(s==='button')return [button];
  if(s==='pre,[data-markdown-copy="code-block"]')return view.blocks;
  return [];
 },
 querySelector(s){return this.querySelectorAll(s)[0]||null;},
 getElementById(){return null;}
};
const window={};window.top=window;
class FakeEvent{constructor(type,opts){this.type=type;this.opts=opts;}}
const globals={URL,document,window,HTMLTextAreaElement:FakeArea,Event:FakeEvent,
  location:{get origin(){return 'https://chatgpt.com';},get pathname(){return new URL(view.url).pathname;}},
  crypto:{randomUUID:crypto.randomUUID,subtle:crypto.webcrypto.subtle},
  chrome:{runtime:{id:'a'.repeat(32),onMessage:{addListener(){}},sendMessage(){return Promise.resolve();}}},
  setInterval(){},setTimeout,TextEncoder,
  getComputedStyle(){return {display:'block',visibility:'visible'}},
  Node:{DOCUMENT_POSITION_FOLLOWING:4},globalThis:null};
globals.globalThis=globals;
vm.runInNewContext(route,globals);vm.runInNewContext(injected,globals);
const f=globals.__test;
for(let turn=1;turn<=3;turn++){
  const message={taskId,messageId:'m'+turn,turn,nonce,text:`CHATMCP HUB task ${taskId}; turn=${turn}; nonce=${nonce}; do not resend`};
  const prep=await f.prepare(message);
  assert.equal(prep.ok,true,`turn ${turn} prepare: ${JSON.stringify(prep)}`);
  assert.equal(area.value,message.text,'full draft must be placed exactly');
  const sent=await f.send(message);
  assert.equal(sent.ok,true,`turn ${turn} send: ${JSON.stringify(sent)}`);
  assert.equal(view.buttonClicks,turn,'exactly one click per turn');
  assert.equal(f.get().boundViaReply,true,'send bound by answer, not missing user bubble');
  f.get().sentAt=Date.now()-8000;
  let result=await f.check(message);
  assert.equal(result.ok,true,`turn ${turn} check: ${JSON.stringify(result)}`);
  assert.equal(result.state,'stabilizing');
  f.get().stableSince=Date.now()-5000;
  result=await f.check(message);
  assert.equal(result.ok,true,`turn ${turn} reply: ${JSON.stringify(result)}`);
  assert.equal(result.state,'reply');
  assert.equal(result.initialRouteBinding,turn===1);
  assert.equal(JSON.parse(result.blocks[0]).turn,turn);
  console.log('PASS complete live-like cycle:',turn, 'clicked',view.buttonClicks,'times');
}
