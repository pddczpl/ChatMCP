// Synthetic HMAC reader integration; not a Windows isolation certification.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsSandboxPublisher } from '../lib/windows-sandbox-publisher.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-publisher-'));
const instanceId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const generation='11111111-2222-3333-4444-555555555555';
const runId='run-provenance',nonce=crypto.randomBytes(32).toString('hex'),key=crypto.randomBytes(32).toString('hex');
const now=new Date().toISOString();
const request={runId,checkHash:'b'.repeat(64),snapshotHash:'c'.repeat(64)};
const snapshot={contentHash:request.snapshotHash};
const raw={instanceId,generation,runId,exportDirectory:root,expectedNonce:nonce,expectedAuthKey:key,cliExitCode:0};
const receipt={version:1,runId,nonce,status:'completed',exitCode:0,stdout:'TAP version 13',
  stderr:'',startedAt:now,completedAt:now,durationMs:1,truncated:false,reasons:[]};
const writePair=async({signingKey=key,content=receipt}={})=>{
  const bytes=Buffer.from(JSON.stringify(content));
  await fs.writeFile(path.join(root,'receipt.json'),bytes);
  await fs.writeFile(path.join(root,'receipt.sha256'),crypto.createHash('sha256').update(bytes).digest('hex')+'  receipt.json\n');
  await fs.writeFile(path.join(root,'receipt.sig'),crypto.createHmac('sha256',Buffer.from(signingKey,'hex')).update(bytes).digest('hex')+'  receipt.json\n');
};
try {
  assert.equal(new WindowsSandboxPublisher().productionAuthenticated,false);
  await writePair();
  const verifier=new WindowsSandboxPublisher();
  const result=await verifier.verify({raw,request,snapshot,instanceId,generation});
  assert.equal(result.publisherAuthenticated,true);
  assert.equal(result.testOutcomeVerified,false);
  assert.equal(result.receipt.snapshotHash,request.snapshotHash);
  assert.equal(result.receipt.checkHash,request.checkHash);
  await assert.rejects(verifier.verify({raw:{...raw,instanceId:'00000000-0000-0000-0000-000000000000'},request,snapshot,instanceId,generation}),{code:'untrusted_publisher_context'});
  await assert.rejects(verifier.verify({raw:{...raw,cliExitCode:1},request,snapshot,instanceId,generation}),{code:'contradictory_exit'});
  await assert.rejects(verifier.verify({raw,request:{...request,checkHash:null},snapshot,instanceId,generation}),{code:'stale_receipt'});
  await writePair({signingKey:crypto.randomBytes(32).toString('hex')});
  await assert.rejects(verifier.verify({raw,request,snapshot,instanceId,generation}),{code:'invalid_publisher_signature'});
  const forged={...receipt,stdout:'fake success',exitCode:0};
  await writePair({content:forged,signingKey:crypto.randomBytes(32).toString('hex')});
  await assert.rejects(verifier.verify({raw,request,snapshot,instanceId,generation}),{code:'invalid_publisher_signature'});
  console.log('PASS: HMAC publisher verification, owner/run binding, forged fully-rehashed receipt denial and host-bound hashes');
} finally {await fs.rm(root,{recursive:true,force:true});}
