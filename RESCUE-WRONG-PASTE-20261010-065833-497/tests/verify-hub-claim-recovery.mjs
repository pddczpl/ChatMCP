import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserRunner } from '../lib/browser-runner.mjs';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-recover-test-'));
const workspace='F:\\TEST_WORKSPACE';
const clientId='3c2f9c78-436d-4b2e-bd8d-2e803d8695cf';
const manager={
 secrets:[],instanceId:'mock-instance',
 state(){return {instanceId:'mock-instance',workspace:{path:workspace},generation:1}},
 acquireTask(id){this.taskId=id},releaseTask(id){if(this.taskId===id)this.taskId=null},
 async createAgentSession(){return {catalog:{tools:[{name:'desktop-commander.list_directory',description:'read-only',server:'desktop-commander'}],servers:{}},async close(){}}}
};
try{
 const runner=new BrowserRunner({manager,directory:temp});
 runner.client={clientId,extensionId:'a'.repeat(32),tokenHash:'f'.repeat(64)};
 const task=await runner.start({prompt:'List 5 files. No writes.'});
 const message=await runner.poll({clientId});
 assert.equal(message.message.taskId,task.id);
 const input={clientId,taskId:task.id,messageId:message.message.id};
 const claimed=await runner.claim(input);
 assert.equal(claimed.ok,true);assert.equal(claimed.message.id,input.messageId);
 const repeated=await runner.claim(input);
 assert.equal(repeated.ok,true);assert.equal(repeated.duplicate,true);
 const stillClaimed=await runner.poll({clientId});
 assert.equal(stillClaimed.message.id,input.messageId,'same client can retrieve same claimed message');
 assert.equal(stillClaimed.message.turn,1);
 await runner.sent({...input,url:'https://chatgpt.com/c/6ac909f3-4148-83ec-b716-dc86f121001b'});
 const alreadySent=await runner.claim(input);
 assert.equal(alreadySent.ok,true);assert.equal(alreadySent.alreadySent,true);
 const stillSent=await runner.poll({clientId});
 assert.equal(stillSent.message.id,input.messageId,'same client can retrieve same sent message');
 assert.equal(stillSent.message.nonce,stillClaimed.message.nonce);
 assert.equal((await runner.get(task.id)).steps,0);
 await runner.cancel(task.id);
 console.log('PASS actual BrowserRunner claim idempotence + same-client poll during claimed/sent + no duplicate turn');
}finally{await fs.rm(temp,{recursive:true,force:true})}
