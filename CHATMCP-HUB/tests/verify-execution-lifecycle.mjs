import assert from 'node:assert/strict';
import { WindowsSandboxBackend } from '../lib/windows-sandbox-backend.mjs';
const calls = [];
const driver = { async start() { calls.push('start'); return { instanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }; },
  async execute() { calls.push('execute'); return { output: 'fixture' }; },
  async stop() { calls.push('stop'); } };
const noAttestation = new WindowsSandboxBackend({ preflight: async () => ({ available: true, blockers: [] }), driver });
assert.equal((await noAttestation.probe()).available, false);
const response = await noAttestation.execute({ runId:'no-trust',isolationRequired:true,snapshotHash:'x' });
assert.equal(response.status, 'isolation_unavailable');
assert.deepEqual(calls, [], 'guest may not launch without authenticated publisher');
const failed = new WindowsSandboxBackend({ preflight: async () => { throw new Error('probe failed'); } });
assert.equal((await failed.probe()).available, false);
assert.equal(await failed.cancel('missing'), false);
console.log('PASS: Windows backend authentication gate fails closed without launching guest');
