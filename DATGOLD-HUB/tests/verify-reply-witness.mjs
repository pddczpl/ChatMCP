import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const base = new URL('../', import.meta.url);
const routeFile = fs.readFileSync(new URL('extension/chat-route.js', base),'utf8');
const source = fs.readFileSync(new URL('extension/browser-runner.js',base),'utf8');
const fixture = source.replace(/\}\)\(\);\s*$/, `  globalThis.__fixture = {replyWitness,routeStatus,routeFailure,authored,ownUser,sendEvidence,check,beforeSendGuard,update(x){current=x;},state(){return current;}};\n})();`);

const taskId = '718c9f5c-a637-44b8-b6e5-83787d0b7cf2';
const nonce = 'bf652a94fdf059de0a20c45199b8775682b7a668b24e23af';
const matching = {chatmcp_hub:'v1', task:taskId, turn:1, nonce, kind:'describe',name:'desktop-commander.list_directory'};
const blockText = `JSON\n${JSON.stringify(matching,null,2)}\nCopy`;
const view={url:'https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b',blocks:[],users:[],assistants:[]};
const makeCode = (text) => ({
  tagName:'DIV',textContent:text,innerText:text,
  querySelector(){return null;},closest(){return null;},
  compareDocumentPosition(){return 4;},
  getBoundingClientRect(){return {width:400,height:300}},
});
const selectors = {
  '[data-message-author-role="user"]':()=>view.users,
  '[data-testid="user-message"]':()=>view.users,
  '[data-message-author-role="assistant"]':()=>view.assistants,
  'pre,[data-markdown-copy="code-block"]':()=>view.blocks,
  'button':()=>[],
};
const document={querySelectorAll(s){return selectors[s]?.()||[];},querySelector(s){return this.querySelectorAll(s)[0]||null;}};
const window={};window.top=window;
const ctx={URL,document,window,
  location:{get origin(){return 'https://chatgpt.com';},get pathname(){return new URL(view.url).pathname;}},
  crypto:{randomUUID:()=>crypto.randomUUID(),subtle:crypto.webcrypto.subtle},
  chrome:{runtime:{id:'a'.repeat(32),onMessage:{addListener(){}},sendMessage(){return Promise.resolve();}}},
  setInterval(){},setTimeout,getComputedStyle(){return {display:'block',visibility:'visible'}},TextEncoder,Node:{DOCUMENT_POSITION_FOLLOWING:4},globalThis:null,
}; ctx.globalThis=ctx;
vm.runInNewContext(routeFile,ctx); vm.runInNewContext(fixture,ctx);
const f=ctx.__fixture;
function state(overrides={}){
  return {taskId,nonce,messageId:'message-1',turn:1,route:'/',stage:'sending',routeLocked:false,
    text:`Task ${taskId} nonce ${nonce}`,promptNormalized:`Task ${taskId} nonce ${nonce}`,
    routePendingSince:null,provisionalReplySince:null,stableText:null,stableSince:0,
    sentAt:Date.now()-10000,stopSeen:false,confirmedUser:false,boundViaReply:false,
    replyWitnessVerified:false, ...overrides};
}
const id = ()=>({taskId,messageId:'message-1'});

// Reproduce the exact screenshot: the user bubble is collapsed/virtualized,
// but the completed assistant JSON code block is in the DOM.
view.blocks=[makeCode(blockText)];f.update(state());
assert.equal(f.authored('user').length,0);
assert.equal(f.replyWitness()?.value.name,'desktop-commander.list_directory');
assert.equal(f.routeStatus(),'ok','one matching answer safely anchors home->conversation');
let sent=f.sendEvidence();
assert.equal(sent.ok,true); assert.equal(f.state().boundViaReply,true);
assert.equal(f.state().stage,'sent');
let check=await f.check(id());
assert.equal(check.ok,true); assert.equal(check.state,'stabilizing');
await new Promise(r=>setTimeout(r,10));
f.state().stableSince=Date.now()-5000;
check=await f.check(id());
assert.equal(check.ok,true); assert.equal(check.state,'reply');
assert.equal(check.initialRouteBinding,true);
assert.equal(JSON.parse(check.blocks[0]).nonce,nonce);
assert.equal(f.state().routeLocked,true);
assert.equal(f.state().replyWitnessVerified,true);
console.log('PASS: screenshot-style hidden user / matching assistant proof / binding / reply');

// Next-turn ownership can continue through an already attested previous reply.
f.update(state({stage:'prepared',turn:2,route:new URL(view.url).pathname,routeLocked:true,previousWitnessBound:true, previousPromptNormalized:'prior'}));
assert.equal(f.beforeSendGuard(),null);
console.log('PASS: next turn after a verified reply without a visible user bubble');

// A reply with the wrong nonce is never an ownership proof, even if it names
// the right tool and task. The URL transition stays pending and no tool runs.
view.blocks=[makeCode(JSON.stringify({...matching,nonce:'0'.repeat(48)}))];
f.update(state());
assert.equal(f.replyWitness(),null);
assert.equal(f.routeStatus(),'pending');
console.log('PASS: wrong nonce cannot claim the conversation');

// A different visible user bubble must not be bypassed by the assistant proof.
const strange={tagName:'DIV',textContent:'Unexpected user message',innerText:'Unexpected user message',
  getBoundingClientRect(){return {width:200,height:40}},hasAttribute(name){return name==='data-message-author-role';},getAttribute(name){return name==='data-message-author-role'?'user':null;},
  closest(){return null;},querySelectorAll(){return []},cloneNode(){return {textContent:'Unexpected user message',querySelectorAll(){return []}}},parentElement:null};
view.users=[strange];view.blocks=[makeCode(blockText)];f.update(state());
assert.equal(f.routeStatus(),'pending');
console.log('PASS: foreign visible user message blocks the fallback');
view.users=[];

// Different authenticated replies for the same task/turn cannot be chosen
// opportunistically: stop instead of risking two executions.
view.blocks=[makeCode(blockText),makeCode(JSON.stringify({...matching,kind:'catalog',query:'x'}))];
f.update(state());
assert.equal(f.replyWitness()?.ambiguous,true);
assert.equal(f.routeStatus(),'pending');
console.log('PASS: ambiguous authenticated replies are not accepted');

const background = fs.readFileSync(new URL('extension/browser-background.js',base),'utf8');
assert.match(background,/turn: message\.turn, text: message\.text, nonce: message\.nonce/);
assert.match(source,/!\/\^\[0-9a-f\]\{48\}\$\/i\.test\(message\.nonce/);
console.log('PASS: nonce is carried from authenticated Hub queue to the content script');
