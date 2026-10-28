// Read-only review harness: executes real Companion code in a mocked VM.
// No browser, network, model request, repository write, or credential access.
// Usage: node review-companion-edgecases.mjs <DATGOLD-HUB/extension>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../extension/', import.meta.url));
if (!dir) throw new Error('Pass the canonical DATGOLD-HUB/extension directory.');
const read = name => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
const original = read('browser-background.js');
const route = read('chat-route.js');
const browser = read('browser-runner.js');
const taskId = 'a1111111-1111-4111-8111-111111111111';
const clientId = 'c3333333-3333-4333-8333-333333333333';
const recovery = {taskId, nonce: 'e'.repeat(48), turn: 1};
const background = original.replace(/\}\)\(\);\s*$/, 'globalThis.fixture={ready,tick,publicState};\n})();');
const rows = [];
async function recoveryCase(name, candidateTypes, expectedBindings) {
  const endpoints = [], probes = [];
  const tabs = candidateTypes.map((kind, i) => ({id: i+1, url: `https://chatgpt.com/c/review-${i+1}`, kind}));
  const event = {addListener(){}};
  const globals = {
    URL, AbortController, TextEncoder, structuredClone,
    crypto: {randomUUID: () => clientId},
    // Advance only the per-tab timeout, deterministically. Do not run the
    // background's boot/poll timers; each test calls tick explicitly.
    setTimeout(fn, ms) { return ms === 1000 ? setTimeout(fn, 1) : {inert: true}; },
    clearTimeout(timer) { if (!timer?.inert) clearTimeout(timer); },
    chrome: {
      runtime: {id:'a'.repeat(32), getURL:p=>`chrome-extension://${'a'.repeat(32)}/${p}`, onMessage:event},
      storage:{local:{async setAccessLevel(){},async get(){return {chatmcpBrowserPairV1:{clientId,token:'t'.repeat(64)},chatmcpBrowserJournalV1:null};},async set(){}}},
      alarms:{async get(){return {};},onAlarm:event},
      tabs:{onUpdated:event,onRemoved:event, async query(){return tabs;}, async sendMessage(id, msg){
        assert.equal(msg.type,'CHATMCP_BROWSER_VERIFY_OFFICIAL_URL'); probes.push(id);
        const tab=tabs.find(x=>x.id===id);
        if(tab.kind==='reject') throw Error('receiver missing');
        if(tab.kind==='ambiguous') return {ok:false,reason:'ambiguous_owned_chat'};
        if(tab.kind==='unknown') return {};
        if(tab.kind==='timeout') return await new Promise(()=>{});
        if(tab.kind==='negative') return {ok:false,reason:'task_nonce_not_visible'};
        return {ok:true,url:tab.url,proof:'user_task_nonce'};
      }},
    },
    async fetch(url, init) {
      const endpoint=new URL(url).pathname.split('/').at(-1); endpoints.push(endpoint);
      assert.ok(['poll','recover-url'].includes(endpoint));
      const response = endpoint==='poll' ? {instanceId:'review-instance',task:{id:taskId,status:'failed',chatUrl:null},message:null,recovery} : {ok:true};
      return {ok:true,async text(){return JSON.stringify(response);}};
    },
  };
  vm.runInNewContext(route, globals);vm.runInNewContext(background, globals);
  await globals.fixture.ready();await globals.fixture.tick();
  const actual=endpoints.filter(x=>x==='recover-url').length;
  const ok=actual===expectedBindings;
  const row={name,expectedBindings,actualBindings:actual,probes:probes.length,pass:ok};rows.push(row);
  console.log(`${ok?'PASS':'FAIL (defect reproduced)'}: ${name}; expected bindings=${expectedBindings}, actual=${actual}`);
}
await recoveryCase('One positive and one explicit negative => unique recovery allowed', ['positive','negative'], 1);
await recoveryCase('Two positive witnesses => ambiguous recovery refused', ['positive','positive'], 0);
await recoveryCase('One positive and one unanswered tab => incomplete scan must not bind', ['positive','timeout'], 0);
await recoveryCase('Missing receiver is not negative evidence', ['positive','reject'], 0);
await recoveryCase('Ambiguous tab witness prevents binding', ['positive','ambiguous'], 0);
await recoveryCase('Malformed response prevents binding', ['positive','unknown'], 0);
await recoveryCase('Unexamined candidate beyond limit prevents binding', ['positive', ...Array(30).fill('negative')], 0);

// Additional test for the newly introduced fallback input selector. The editor
// below belongs to a non-chat form, has an explicit conflicting Search label,
// and there is no verified ChatGPT composer present.
const source = browser.replace(/\}\)\(\);\s*$/, 'globalThis.editorFixture={input,prepare};\n})();');
const searchButton = {tagName:'BUTTON',disabled:false,getAttribute:k=>k==='aria-label'?'Search':null,
  closest:()=>null,getBoundingClientRect:()=>({width:30,height:30})};
const foreignForm = {tagName:'FORM',id:'unrelated-search-form',querySelectorAll:s=>s==='button'?[searchButton]:[]};
searchButton.form = foreignForm;
const foreignEditor = {
  tagName:'DIV', disabled:false,readOnly:false,innerText:'',textContent:'',focus(){},dispatchEvent(){return true;},
  getAttribute(k){return ({role:'textbox',contenteditable:'true','aria-label':'Search'})[k]??null;},
  closest(selector){return selector==='form'?foreignForm:null;},
  getBoundingClientRect(){return {width:300,height:40};},
};
const window={getSelection:()=>({removeAllRanges(){},addRange(){}})};window.top=window;
const globals={URL,window,location:{origin:'https://chatgpt.com',pathname:'/'},
  crypto:{randomUUID:()=> 'fixture-page'},
  document:{visibilityState:'visible',
    querySelectorAll(selector){return selector==='[role="textbox"][contenteditable="true"]'?[foreignEditor]:[];},
    getElementById(){return null;},createRange(){return {selectNodeContents(){}};},
    execCommand(cmd, ui, text){foreignEditor.innerText=text;foreignEditor.textContent=text;return true;},
  },
  chrome:{runtime:{onMessage:{addListener(){}}}},setInterval(){},setTimeout:(fn,ms)=>setTimeout(fn,1),TextEncoder,Event:class{},
  getComputedStyle(){return {visibility:'visible',display:'block'};},
};
vm.runInNewContext(route,globals);vm.runInNewContext(source,globals);
const inputResult=globals.editorFixture.input();
const ok=inputResult.element!==foreignEditor;
rows.push({name:'Conflicting Search-labelled editable inside unrelated form is rejected',pass:ok,selectedForeignEditor:!ok});
console.log(`${ok?'PASS':'FAIL (defect reproduced)'}: Search-labelled editable in unrelated form selected=${!ok}`);
const privateText = `Task ${taskId} nonce ${recovery.nonce} REVIEW_PRIVATE_TEXT_SENTINEL`;
const prepared = await globals.editorFixture.prepare({taskId, messageId:'review-packet',turn:1,nonce:recovery.nonce,text:privateText});
const wroteForeign=foreignEditor.innerText===privateText;
rows.push({name:'PREPARE must not write task into Search editor',pass:!wroteForeign,wroteForeign,reason:prepared.reason?.split(':')[0]});
console.log(`${wroteForeign?'FAIL (defect reproduced)':'PASS'}: PREPARE wrote foreign draft=${wroteForeign}; reason=${prepared.reason?.split(':')[0]}`);
console.log(JSON.stringify({scope:'VM behavior tests; not live Edge acceptance',node:process.version,rows},null,2));
process.exitCode=rows.every(x=>x.pass)?0:1;
