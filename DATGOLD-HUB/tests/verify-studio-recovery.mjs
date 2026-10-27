import assert from 'node:assert/strict';
import { RecoveryScheduler } from '../lib/studio-resumer.mjs';
let count=0;
function check(value,label){assert.ok(value,label);count++;}
const id='123e4567-e89b-42d3-a456-426614174000';
const workspace='F:\\projects\\sensor';
const ready={workspace:{path:workspace},services:{desktop:{state:'ready'},proxy:{state:'ready'}}};
function setup({transport='api',errorCode=transport==='api'?'process_interrupted':'hub_restarted',uncertain=false,network=true,managerReady=true,configured=true,originalChat=true,mode=transport,enabled=true}={}){
  const task={id,status:'paused',autoResume:enabled,transport,errorCode,workspace:{path:workspace},chatUrl:originalChat?'https://chatgpt.com/c/123e4567-e89b-42d3-a456-426614174000':'',...(uncertain?(transport==='api'?{pendingCall:{tool:'write'}}:{unverifiedDelivery:{turn:7}}):{})};
  let active=null;const calls=[];
  const agent={
    state:()=>({mode,activeTaskId:active,tasks:[task]}),get:()=>({...task}),
    setAutoResume:async({id:k,enabled:value})=>{check(k===id,'same id');calls.push('arm:'+value);task.autoResume=value;},
    continue:async payload=>{check(payload.id===id,'same conversation');calls.push('continue');active=id;return {id};},
  };
  const manager={state:()=>managerReady?ready:{...ready,services:{proxy:{state:'starting'},desktop:{state:'ready'}}}};
  const scheduler=new RecoveryScheduler({agent,manager,provider:{ready:()=>configured},browser:{browserState:()=>({connected:network})}});
  return {task,calls,scheduler};
}
{
  const x=setup();check(await x.scheduler.tick()===true,'api resume');check(x.calls.join(',')==='arm:false,continue','persist disarm before continue');
  check(await x.scheduler.tick()===false,'no repeat after active');
}
{
  const x=setup({transport:'chatgpt-web'});check(await x.scheduler.tick()===true,'web same-chat resume');check(x.calls.join(',')==='arm:false,continue','web no duplicate');
}
for (const cfg of [
  {uncertain:true},{transport:'chatgpt-web',uncertain:true},
  {transport:'chatgpt-web',originalChat:false},{transport:'chatgpt-web',network:false},
  {transport:'api',configured:false},{managerReady:false},{mode:'chatgpt-web'},{enabled:false},
  {errorCode:'user_cancelled'}
]){
  const x=setup(cfg);check(await x.scheduler.tick()===false,'must not resume unsafe condition');check(x.calls.length===0,'no sending, no consume flag');
}
{
  const x=setup({managerReady:false});check(await x.scheduler.tick()===false,'wait service');check(x.task.autoResume,'remain armed during outage');
}
console.log(`PASS: ${count} opt-in restart recovery checks: same id, no duplicate, uncertainty/network/mode guards`);
