import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const base = new URL('../',import.meta.url);
const routeSource=fs.readFileSync(new URL('extension/chat-route.js',base),'utf8');
const contentSource=fs.readFileSync(new URL('extension/browser-runner.js',base),'utf8').replace(/\}\)\(\);\s*$/,`  globalThis.__test={prepare,send,check, current:()=>current};\n})();`);
const workerSource=fs.readFileSync(new URL('extension/browser-background.js',base),'utf8').replace(/\}\)\(\);\s*$/,`  globalThis.__test={ready,tick, journal:()=>journal};\n})();`);
const taskId='6f3dc089-8cd4-4428-a7ad-1136896a0ad3';
const otherTask='7f3dc089-8cd4-4428-a7ad-1136896a0ad3';
const nonce='e'.repeat(48);
const ownUrl='https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b';
const foreignUrl='https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001c';

// DOM continuation in the exact OLD chat URL, even after a full page reload.
function makeContent(url=ownUrl) {
  const view={url,oldUsers:[],blocks:[],clicks:0};
  class AreaElement {
    constructor(){this._value='';this.tagName='TEXTAREA';this.disabled=false;this.readOnly=false;this.parentElement=null;}
    get value(){return this._value;} set value(v){this._value=v;}
    focus(){} dispatchEvent(){return true;} closest(){return null;} getAttribute(){return null;}
    getBoundingClientRect(){return {width:500,height:40};}
  }
  const area=new AreaElement();
  const button={tagName:'BUTTON',disabled:false,form:null,
    getAttribute(n){return n==='data-testid'?'send-button':n==='aria-label'?'Send':n==='type'?'button':null;},
    closest(){return null},getBoundingClientRect(){return {width:40,height:40}},
    click(){
      view.clicks++;
      const message={chatmcp_hub:'v1',task:taskId,turn:73+view.clicks,nonce,kind:view.clicks===1?'describe':'final',name:'desktop-commander.list_directory',text:'completed'};
      const raw=JSON.stringify(message);
      view.blocks.push({tagName:'DIV',textContent:raw,innerText:raw,earlier:false,
        querySelector(){return null},closest(){return null},getBoundingClientRect(){return {width:400,height:80}},
        compareDocumentPosition(other){return other?.earlier?2:4}});
      area.value='';
    }};
  const form={tagName:'DIV',parentElement:{tagName:'MAIN'},closest(){return null},contains(){return false},querySelector(){return null},
    querySelectorAll(s){return s==='button'?[button]:[]}};
  area.parentElement=form;
  const oldUser={tagName:'DIV',textContent:'Tin nhắn cũ do người dùng gửi trước khi Hub restart',
    innerText:'Tin nhắn cũ do người dùng gửi trước khi Hub restart',earlier:true,
    getAttribute(n){return n==='data-message-author-role'?'user':null},
    hasAttribute(n){return n==='data-message-author-role'},
    closest(){return null},querySelectorAll(){return []},cloneNode(){return {textContent:this.textContent,querySelectorAll(){return []}}},getBoundingClientRect(){return {width:350,height:70}},
    compareDocumentPosition(){return 2}};
  view.oldUsers=[oldUser];
  const document={
    querySelectorAll(s){
      if(s==='#prompt-textarea')return [area];
      if(s==='button')return [button];
      if(s==='pre,[data-markdown-copy="code-block"]')return view.blocks;
      if(s==='[data-message-author-role="user"]')return view.oldUsers;
      return [];
    },querySelector(s){return this.querySelectorAll(s)[0]||null},getElementById(){return null}
  };
  const window={}; window.top=window;
  const context={URL,window,document,HTMLTextAreaElement:AreaElement,Event:class{constructor(type){this.type=type}},
    location:{get origin(){return 'https://chatgpt.com'},get pathname(){return new URL(view.url).pathname}},
    crypto:{randomUUID:crypto.randomUUID,subtle:crypto.webcrypto.subtle},
    chrome:{runtime:{id:'a'.repeat(32),onMessage:{addListener(){}},sendMessage(){return Promise.resolve({ok:true})}}},
    setInterval(){},setTimeout,TextEncoder,
    getComputedStyle(){return {display:'block',visibility:'visible'}},
    Node:{DOCUMENT_POSITION_FOLLOWING:4},globalThis:null};context.globalThis=context;
  vm.runInNewContext(routeSource,context); vm.runInNewContext(contentSource,context);
  return {view,area,api:context.__test};
}
{
  const c=makeContent();
  const msg={taskId,messageId:'followup-74',turn:74,nonce,text:`Continue same task ${taskId} with nonce ${nonce}`,resumeUrl:ownUrl,resumeStart:true};
  const prep=await c.api.prepare(msg);
  assert.equal(prep.ok,true,`resume first PREPARE must succeed: ${JSON.stringify(prep)}`);
  assert.equal(c.area.value,msg.text,'prompt replaces any draft');
  const sent=await c.api.send(msg);
  assert.equal(sent.ok,true,`resume SEND must succeed: ${JSON.stringify(sent)}`);
  assert.equal(c.view.clicks,1);
  // A subsequent protocol message must recheck the existing owned turn;
  // resumeStart is intentionally false for every additional MCP result.
  c.api.current().stage='reply';c.api.current().replyWitnessVerified=true;
  const second={...msg,messageId:'followup-75',turn:75,text:`Tool data for ${taskId}, ${nonce}`,resumeStart:false};
  const prep2=await c.api.prepare(second);
  assert.equal(prep2.ok,true,`continuation result PREPARE: ${JSON.stringify(prep2)}`);
  assert.equal(c.api.current().resumedFromCheckpoint,false,'resume privilege is one packet only');
  assert.equal((await c.api.send(second)).ok,true);
  assert.equal(c.view.clicks,2);
  console.log('PASS DOM existing conversation with history + fresh content script => first resume + next MCP packet, one click each');
}
{
  const c=makeContent(foreignUrl);
  const msg={taskId,messageId:'followup-74',turn:74,nonce,text:`Continue same task ${taskId} nonce=${nonce}`,resumeUrl:ownUrl,resumeStart:true};
  const prep=await c.api.prepare(msg);
  assert.equal(prep.ok,false);assert.match(prep.reason,/resume_chat_mismatch/);
  assert.equal(c.view.clicks,0);
  console.log('PASS DOM foreign conversation URL refused without editing draft or sending');
}

function makeBackground({oldPhase='failed',oldInstance='same-hub',url=ownUrl,newUrl=ownUrl,resumeStart=true}={}) {
  const clientId='f0a010a3-e807-438a-a8aa-d4a8157c06d2';
  const msg={id:'new-packet-74',taskId,turn:74,nonce,text:`Follow-up ${taskId} nonce=${nonce}`,resumeUrl:newUrl,resumeStart};
  const store={
    chatmcpBrowserPairV1:{clientId,token:'f'.repeat(64)},
    chatmcpBrowserJournalV1:{taskId,messageId:'old-packet-73',turn:73,phase:oldPhase,tabId:10,instanceId:oldInstance,pageId:'old-page',failurePending:false,url}
  };
  const calls={opened:[],cancels:0,sends:0,prepares:0,claims:0,failures:0};
  let tab={id:10,status:'complete',url},once=false;
  const chrome={
    runtime:{id:'a'.repeat(32),getURL:s=>`chrome-extension://${'a'.repeat(32)}/${s}`,onMessage:{addListener(){}}},
    storage:{local:{async get(keys){return Object.fromEntries(keys.map(k=>[k,structuredClone(store[k])]));},
      async set(changes){Object.assign(store,structuredClone(changes));},async setAccessLevel(){},async remove(keys){keys.forEach(k=>delete store[k])}}},
    alarms:{async get(){return {name:'chatmcp-browser-poll'}},async create(){},async clear(){},onAlarm:{addListener(){}}},
    tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}},
      async get(id){return id===tab.id?tab:null},
      async query(){return [tab]},
      async create({url}){calls.opened.push(url);tab={id:11,status:'complete',url};return tab},
      async sendMessage(_id,req){
        if(req.type==='CHATMCP_BROWSER_CANCEL'){calls.cancels++;return {ok:true}}
        if(req.type==='CHATMCP_BROWSER_PREPARE'){calls.prepares++;return {ok:true,pageId:'resume-page',url:tab.url}}
        if(req.type==='CHATMCP_BROWSER_SEND'){calls.sends++;return {ok:true,pageId:'resume-page',url:tab.url}}
        if(req.type==='CHATMCP_BROWSER_CHECK') return {ok:true,pageId:'resume-page',state:'waiting'};
        throw Error('Unexpected message '+req.type);
      }}
  };
  const context={chrome,console,URL,AbortController,TextEncoder,structuredClone,crypto:{randomUUID:crypto.randomUUID},
    setTimeout:()=>1,clearTimeout(){},globalThis:null,
    fetch:async (uri,opt)=>{
      const endpoint=new URL(uri).pathname.split('/').at(-1);
      let response;
      if(endpoint==='poll') response={instanceId:'same-hub',task:{id:taskId,status:'queued',chatUrl:ownUrl},message:msg};
      else if(endpoint==='claim'){calls.claims++;response={ok:true,message:msg}}
      else if(endpoint==='sent')response={ok:true};
      else if(endpoint==='fail'){calls.failures++;response={ok:true}}
      else throw Error('Unexpected endpoint '+endpoint);
      return {ok:true,async text(){return JSON.stringify(response)}};
    }};
  context.globalThis=context;
  vm.runInNewContext(routeSource,context);vm.runInNewContext(workerSource,context);
  return {api:context.__test,store,calls,msg};
}
for(const fixture of [{oldPhase:'failed',oldInstance:'same-hub'}, {oldPhase:'reconciling',oldInstance:'old-hub'}]) {
  const x=makeBackground(fixture);await x.api.ready();await x.api.tick();
  assert.equal(x.calls.cancels,1,'must detach old per-message ownership');
  assert.equal(x.calls.prepares,1);
  assert.equal(x.calls.sends,1,'exactly 1 Send click for new user prompt');
  assert.equal(x.calls.failures,0,'old failed journal or changed Hub instance must not fail new user-authorized continuation');
  assert.equal(x.api.journal().messageId,x.msg.id);
  assert.equal(x.api.journal().phase,'sent');
  assert.equal(x.calls.opened.length,0,'must reuse verified existing tab, not create a new chat');
  console.log(`PASS background ${fixture.oldPhase}/${fixture.oldInstance} => same-URL follow-up, 1 send, no stale journal failure`);
}
{
  const x=makeBackground({oldPhase:'failed',newUrl:foreignUrl});await x.api.ready();await x.api.tick();
  assert.equal(x.calls.sends,0);assert.equal(x.calls.cancels,0);
  console.log('PASS background rejected mismatching resume URL; did not click Send');
}
