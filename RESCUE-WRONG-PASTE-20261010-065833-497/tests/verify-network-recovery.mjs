import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/browser-background.js',import.meta.url),'utf8');
const testSource = source.replace(/\}\)\(\);\s*$/,`  globalThis.__networkTest={ready,tick,publicState,storageState(){return journal;}};\n})();`);
const taskId='e482ed8b-2d23-4ed1-94dc-2b4fc4791f6d';
const clientId='8c62d2a3-a877-4216-ab1d-f65c42194a05';
const messageId='p-44';
const nonce='a'.repeat(48);
const msg={id:messageId,taskId,turn:44,text:`CHATMCP TOOL RESULT task=${taskId} turn=44 nonce=${nonce}`,nonce};
const url='https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b';
const replies=[];
function harness({loseSendAck=false,loseClaimAck=false,definitelyOfflineBeforeClick=false}={}){
  const store={chatmcpBrowserPairV1:{clientId,token:'z'.repeat(64)},chatmcpBrowserJournalV1:null};
  const state={claimCount:0,sendCount:0,recoverCount:0,sentCount:0,failCount:0,replyCount:0,
    hubOnline:true,chatOnline:true,sentEvidence:false,phase:'pending',tab:{id:42,status:'complete',url:'https://chatgpt.com/'},loseSendAck,loseClaimAck,definitelyOfflineBeforeClick};
  function makeWorker(){
    const chrome={
      runtime:{id:'a'.repeat(32),getURL:s=>`chrome-extension://${'a'.repeat(32)}/${s}`,onMessage:{addListener(){}}},
      storage:{local:{async get(keys){return Object.fromEntries(keys.map(k=>[k,structuredClone(store[k])]));},async set(items){Object.assign(store,structuredClone(items));},async setAccessLevel(){},async remove(keys){keys.forEach(k=>delete store[k]);}}},
      alarms:{async get(){return {name:'chatmcp-browser-poll'}},async create(){},async clear(){},onAlarm:{addListener(){}}},
      tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}},
        async create({url}){state.tab={id:42,status:'complete',url};return state.tab},
        async get(){return state.tab},
        async sendMessage(id,m){
          assert.equal(id,42);
          if (m.type==='CHATMCP_BROWSER_PREPARE') return {ok:true,pageId:'page-1',url:state.tab.url};
          if (m.type==='CHATMCP_BROWSER_SEND') {
            if (state.definitelyOfflineBeforeClick && !state.chatOnline)
              return {ok:false,reason:'network_offline',retryable:true,pageId:'page-1'};
            state.sendCount++;state.tab.url=url;state.sentEvidence=true;
            if(state.loseSendAck){state.loseSendAck=false;throw Error('message_port_closed_after_click')}
            return {ok:true,pageId:'page-1',url};
          }
          if(m.type==='CHATMCP_BROWSER_RECOVER_SEND') {
            state.recoverCount++; assert.equal(m.messageId,messageId);assert.equal(m.nonce,nonce);
            assert.equal(m.turn,44);assert.equal(m.text,msg.text);assert.equal(m.pageId,null);
            return state.chatOnline && state.sentEvidence ? {ok:true,state:'confirmed',pageId:'page-1',url} :
              {ok:true,state:'waiting',reason:'submitted_message_not_yet_verifiable',pageId:'page-1'};
          }
          if(m.type==='CHATMCP_BROWSER_CHECK') return {ok:true,state:'reply',pageId:'page-1',replyId:'reply-44',text:'test',blocks:[JSON.stringify({chatmcp_hub:'v1',task:taskId,turn:44,nonce,kind:'final',text:'ok'})],url};
          if(m.type==='CHATMCP_BROWSER_CANCEL') return {ok:true};
          throw Error(`Unknown tab message ${m.type}`);
        }
      }
    };
    const ctx={chrome,console,URL,AbortController,TextEncoder,structuredClone,setTimeout:()=>1,clearTimeout(){},
      crypto:{randomUUID:()=>clientId},globalThis:null,fetch:async (uri, opts)=>{
        if(!state.hubOnline) throw Error('Failed to fetch');
        const endpoint=new URL(uri).pathname.split('/').at(-1),body=JSON.parse(opts.body);
        assert.equal(body.clientId,clientId);
        let res;
        switch(endpoint){
          case 'poll': res={instanceId:'h-instance',task:{id:taskId,status:'running'},message:msg};break;
          case 'claim': {
            state.claimCount++;
            const duplicate=state.phase!=='pending';state.phase='claimed';
            if(state.loseClaimAck){state.loseClaimAck=false;throw Error('Lost claim ack')}
            res={ok:true,message:msg,duplicate};break;
          }
          case 'sent': state.sentCount++;state.phase='sent';res={ok:true};break;
          case 'reply': state.replyCount++;replies.push(body);res={accepted:true};break;
          case 'fail': state.failCount++;res={ok:true};break;
          default:throw Error('Unexpected Hub endpoint '+endpoint);
        }
        return {ok:true,async text(){return JSON.stringify(res)}};
      }};
    ctx.globalThis=ctx;
    ctx.__chatmcpChatRoute={normalize(u){return typeof u==='string' && u.startsWith('https://chatgpt.com/')?u:null}};
    vm.runInNewContext(testSource,ctx);
    return ctx.__networkTest;
  }
  return {state,store,makeWorker};
}

// Case 1: Internet drops AFTER one click. Acknowledgement is lost, then returns.
{
 const h=harness({loseSendAck:true});let worker=h.makeWorker();await worker.ready();
 await worker.tick();assert.equal(h.state.sendCount,1);assert.equal(worker.storageState().phase,'reconciling');
 h.state.hubOnline=false;h.state.chatOnline=false;
 await worker.tick();assert.equal(worker.storageState().phase,'reconciling');assert.equal(h.state.failCount,0);
 // MV3 service worker restart during outage preserves the ambiguous state.
 worker=h.makeWorker();await worker.ready();assert.equal(worker.storageState().phase,'reconciling');
 h.state.hubOnline=true;await worker.tick();assert.equal(worker.storageState().phase,'reconciling');
 h.state.chatOnline=true;await worker.tick();assert.equal(worker.storageState().phase,'sent');
 assert.equal(h.state.sendCount,1,'must never click twice');assert.equal(h.state.sentCount,1);
 await worker.tick();assert.equal(worker.storageState().phase,'replied');
 assert.equal(h.state.replyCount,1);assert.equal(h.state.failCount,0);
 console.log('PASS lost SEND ack + network outage + service worker restart => read-only reconciliation + 1 click + 1 reply');
}
// Case 2: claim reached Hub but claim acknowledgement was lost.
{
 const h=harness({loseClaimAck:true});const w=h.makeWorker();await w.ready();
 await w.tick();assert.equal(w.storageState().phase,'claiming');assert.equal(h.state.sendCount,0);
 await w.tick();assert.equal(h.state.claimCount,2);assert.equal(h.state.sendCount,1);
 assert.equal(w.storageState().phase,'sent');assert.equal(h.state.failCount,0);
 console.log('PASS lost CLAIM ack => idempotent claim by same client + first/only send');
}
// Case 3: network known-offline BEFORE click: content script positively proves it did not click.
{
 const h=harness({definitelyOfflineBeforeClick:true});h.state.chatOnline=false;
 const w=h.makeWorker();await w.ready();await w.tick();
 assert.equal(w.storageState().phase,'claimed');assert.equal(h.state.sendCount,0);
 await w.tick();assert.equal(h.state.sendCount,0);
 h.state.chatOnline=true;await w.tick();assert.equal(h.state.sendCount,1);
 console.log('PASS confirmed pre-click offline => waits, then exactly one Send click');
}
// Case 4: no proof of click after lost ack; wait without duplicate send or fail.
{
 const h=harness({loseSendAck:true});const w=h.makeWorker();await w.ready();await w.tick();
 h.state.sentEvidence=false;await w.tick();await w.tick();await w.tick();
 assert.equal(h.state.sendCount,1);assert.equal(h.state.failCount,0);
 assert.equal(w.storageState().phase,'reconciling');
 console.log('PASS ambiguous lost Send with no DOM proof => safe waiting, no replay');
}
