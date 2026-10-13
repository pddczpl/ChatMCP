// Host protocol regressions; this suite does not certify the guest OS boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WindowsSandboxCliDriver } from '../lib/windows-sandbox-driver.mjs';
import { WindowsSandboxPublisher } from '../lib/windows-sandbox-publisher.mjs';
import { createExecutionSnapshot } from '../lib/execution-snapshots.mjs';
import { SEALED_PROTOCOL, sealedReceiptPayload } from '../lib/windows-sandbox-sealed-receipt.mjs';
import { candidateDigestExitCodes } from '../lib/windows-sandbox-exitcode-channel.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-seal-protocol-'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
try {
  const runtime=path.join(root,'runtime'),node=path.join(root,'node'),workspace=path.join(root,'workspace');
  for(const directory of [runtime,node,workspace]) await fs.mkdir(directory);
  for(const [directory,name] of [[runtime,'GuestSupervisor.exe'],[node,'node.exe']]) {
    const bytes=Buffer.from(name);
    await fs.writeFile(path.join(directory,name),bytes);
    await fs.writeFile(path.join(directory,name+'.sha256'),sha(bytes)+'  '+name);
  }
  await fs.writeFile(path.join(workspace,'calc.test.mjs'),'// synthetic protocol test');
  const snapshot=await createExecutionSnapshot({workspace,files:['calc.test.mjs'],outputRoot:path.join(root,'snapshots')});
  const publisher=new WindowsSandboxPublisher();
  assert.equal(publisher.productionAuthenticated,false);
  async function runCase(kind) {
    const instanceId=crypto.randomUUID(),generation=crypto.randomUUID(),runId=crypto.randomUUID();
    const state=path.join(root,kind),input=path.join(state,'run-'+generation,'input');
    const output=path.join(state,'run-'+generation,'output');
    const request={runId,command:'node --test',snapshotHash:snapshot.contentHash,checkHash:'b'.repeat(64)};
    let running=false,words=[],wordIndex=0;
    const driver=new WindowsSandboxCliDriver({cliPath:path.join(root,'wsb.exe'),runtimeDirectory:runtime,
      nodeToolchainDirectory:node,stateDirectory:state,publicationProtocol:SEALED_PROTOCOL,
      runCli:async args=>{
        if(args[0]==='list') return JSON.stringify({WindowsSandboxEnvironments:running?[{Id:instanceId}]:[]});
        if(args[0]==='start'){running=true;return JSON.stringify({Id:instanceId});}
        if(args[0]==='stop'){running=false;return '{}';}
        assert.equal(args[args.indexOf('--id')+1],instanceId);
        assert.equal(args[args.indexOf('-r')+1],'System');
        const command=args[args.indexOf('-c')+1];
        if(command.includes('\\robocopy.exe '))return '{"ExitCode":1}';
        if(command.includes('--seal-envelope ')){
          assert.equal((await fs.readdir(output)).includes('.auth_key'),false);
          const envelopeBytes=await fs.readFile(path.join(input,'envelope.json'));
          const envelope=JSON.parse(envelopeBytes);
          assert.equal(sha(await fs.readFile(path.join(input,'request.json'))),envelope.requestSha256);
          assert.equal(sha(await fs.readFile(path.join(input,'snapshot.json'))),envelope.snapshotSha256);
          const now=new Date().toISOString();
          const receipt={version:1,runId,nonce:envelope.nonce,status:'completed',exitCode:0,stdout:'',stderr:'',
            startedAt:now,completedAt:now,durationMs:1,truncated:false,reasons:[],isGuestExecution:true,
            restrictedChild:true,jobObjectAttached:true,cleanupConfirmed:kind!=='unclean'};
          const bytes=Buffer.from(JSON.stringify(receipt));
          words=candidateDigestExitCodes(sealedReceiptPayload(envelopeBytes,bytes));
          await fs.writeFile(path.join(output,'receipt.json'),kind==='tamper'?Buffer.from(JSON.stringify({...receipt,stdout:'forged'})):bytes);
          return '{"ExitCode":0}';
        }
        assert.equal(command,'C:\\ChatMCP\\Input\\GuestSupervisor.exe --digest-word C:\\ChatMCP\\Input\\envelope.json '+wordIndex);
        const code=kind==='missing-word'?0:words[wordIndex];wordIndex++;
        return JSON.stringify({ExitCode:code});
      }});
    await driver.start({request,snapshot,generation});
    try {
      if(['tamper','missing-word'].includes(kind)) {
        await assert.rejects(driver.execute({request,instanceId,generation}),{code:kind==='tamper'?'sealed_digest_mismatch':'untrusted_exitcode_channel'});
        return;
      }
      const raw=await driver.execute({request,instanceId,generation});
      const context={raw,request,snapshot,instanceId,generation};
      await assert.rejects(publisher.verify({...context,raw:{...raw}}),{code:'untrusted_publisher_context'});
      await assert.rejects(driver.execute({request,instanceId,generation}),{code:'replayed_generation'});
      if(kind==='unclean')await assert.rejects(publisher.verify(context),{code:'unverified_guest_origin'});
      else if(kind==='stale')await assert.rejects(publisher.verify({...context,request:{...request,checkHash:'c'.repeat(64)}}),{code:'stale_receipt'});
      else {
        const verified=await publisher.verify(context);
        assert.equal(verified.publisherAuthenticated,true);
        assert.equal(verified.receipt.snapshotHash,snapshot.contentHash);
        await assert.rejects(publisher.verify(context),{code:'untrusted_publisher_context'});
      }
    } finally { await driver.stop({instanceId,generation}); }
  }
  for(const kind of ['good','tamper','missing-word','unclean','stale'])await runCase(kind);
  console.log('PASS: native-seal host protocol rejects forged objects, tamper, missing frames, replay, stale checks and incomplete cleanup; production remains locked');
} finally {await fs.rm(root,{recursive:true,force:true});}
