import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const route = fs.readFileSync(new URL('../extension/chat-route.js',import.meta.url),'utf8');
const source = fs.readFileSync(new URL('../extension/browser-runner.js',import.meta.url),'utf8');
const code = source.replace(/\}\)\(\);\s*$/,`  globalThis.__test={recoverSend,check,stage(){return current?.stage||null;},clear(){current=null;}};\n})();`);
const taskId='2bbcb531-a49d-49b9-b76c-ff91f6c8c6b0';
const nonce='b'.repeat(48);
const text=`CHATMCP HUB task ${taskId} turn=44 nonce=${nonce}`;
const msg={taskId,messageId:'msg44',turn:44,nonce,text};
const response={chatmcp_hub:'v1',task:taskId,turn:44,nonce,kind:'describe',name:'desktop-commander.read_file'};
const view={url:'https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b',blocks:[],users:[],clicks:0};
function element(content,role=null){
 return {tagName:'DIV',textContent:content,innerText:content,parentElement:null,
  getAttribute(n){return n==='data-message-author-role'?role:null;},hasAttribute(n){return n==='data-message-author-role'&&role!==null},
  querySelector(s){return null},querySelectorAll(){return []},closest(){return null},
  cloneNode(){return {textContent:content,querySelectorAll(){return []}}},
  getBoundingClientRect(){return {width:300,height:60}},compareDocumentPosition(other){return other?.earlier===true?2:4}};
}
const doc={
 querySelectorAll(s){
  if(s==='pre,[data-markdown-copy="code-block"]')return view.blocks;
  if(s==='[data-message-author-role="user"]')return view.users;
  if(s==='[data-testid="user-message"]')return [];
  if(s==='[data-message-author-role="assistant"]')return [];
  return [];
 },querySelector(s){return this.querySelectorAll(s)[0]||null;}
};
const win={}; win.top=win;
const ctx={URL,window:win,document:doc,location:{get origin(){return 'https://chatgpt.com'},get pathname(){return new URL(view.url).pathname}},
 crypto:{randomUUID:crypto.randomUUID,subtle:crypto.webcrypto.subtle},
 chrome:{runtime:{id:'a'.repeat(32),onMessage:{addListener(){}},sendMessage(){return Promise.resolve()}}},
 TextEncoder,setInterval(){},setTimeout,getComputedStyle(){return {display:'block',visibility:'visible'}},
 Node:{DOCUMENT_POSITION_FOLLOWING:4},globalThis:null};ctx.globalThis=ctx;
vm.runInNewContext(route,ctx);vm.runInNewContext(code,ctx);
const f=ctx.__test;
// A page reload has removed the content-script state. An exact matching
// assistant JSON block is a permitted read-only proof in the same owned tab.
view.blocks=[element(`JSON\n${JSON.stringify(response)}\nCopy`)];
let res=f.recoverSend(msg);
assert.equal(res.ok,true);assert.equal(res.state,'confirmed');assert.equal(res.recovered,true);
assert.equal(f.stage(),'sent');assert.equal(view.clicks,0);
console.log('PASS reload + exact assistant nonce witness => recovered without click');
// Wrong nonce: do not recover, do not alter draft/click.
f.clear();view.blocks=[element(JSON.stringify({...response,nonce:'c'.repeat(48)}))];
res=f.recoverSend(msg);assert.equal(res.ok,true);assert.equal(res.state,'waiting');assert.equal(f.stage(),null);
assert.equal(view.clicks,0);
console.log('PASS wrong nonce after reload => wait, no fabricated send');
// A foreign visible user message cannot be overridden by a matching assistant block.
f.clear();view.blocks=[element(JSON.stringify(response))];view.users=[element('foreign message','user')];
res=f.recoverSend(msg);assert.equal(res.ok,false);assert.match(res.reason,/foreign_or_ambiguous/);
assert.equal(f.stage(),null);
console.log('PASS intervening user message => fail closed');
// An exact user bubble is also a valid attestation without an assistant reply.
f.clear();view.blocks=[];view.users=[element(text,'user')];
res=f.recoverSend(msg);assert.equal(res.ok,true);assert.equal(res.state,'confirmed');
assert.equal(f.stage(),'sent');assert.equal(view.clicks,0);
console.log('PASS exact user bubble => resume waiting for original answer');

// A long chat may still show older user messages. They must not prevent an
// exact authenticated assistant reply from proving the current turn, provided
// none of those user bubbles follows the witness.
f.clear();view.blocks=[element(JSON.stringify(response))];
const earlier=element('earlier user turn','user');earlier.earlier=true;view.users=[earlier];
res=f.recoverSend(msg);assert.equal(res.ok,true);assert.equal(res.state,'confirmed');
assert.equal(f.stage(),'sent');assert.equal(view.clicks,0);
console.log('PASS older visible user bubbles before witness do not block safe recovery');
