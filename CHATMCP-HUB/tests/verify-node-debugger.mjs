import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import { NodeDebugTools, redactDebugValue } from '../lib/node-debug-tools.mjs';
assert.equal(redactDebugValue('DATABASE_PASSWORD','private'),'[REDACTED]');
assert.equal(redactDebugValue('MY_API_KEY','private'),'[REDACTED]');
assert.equal(redactDebugValue('value','42'),'42');

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-node-debug-'));
const taskId='debug-real-node-1';
let debug;
try {
  await fs.writeFile(path.join(root,'example.mjs'),
    'function calculate(a,b) {\n  const result=a+b;\n  return result;\n}\nconsole.log(calculate(2,3));\n');
  await fs.writeFile(path.join(root,'.env'),'SECRET=never-expose');
  const workspace=new StudioWorkspace({manager:{workspace:root},directory:root});
  const local=new LocalTools({workspace,stateDirectory:root});
  assert.equal(local.has('debug_start'),true);
  assert.equal(local.has('debug_breakpoint'),true);
  assert.equal((await local.assess('debug_start',{program:'example.mjs'})).category,'execute');
  assert.equal((await local.assess('debug_evaluate',{expression:'3+4'})).category,'dangerous');
  debug=new NodeDebugTools({workspace});
  assert.equal((await debug.start({program:'example.mjs'},{taskId})).structuredContent.running,true);
  const breakpoint=await debug.breakpoint({file:'example.mjs',line:3},{taskId});
  assert.equal(typeof breakpoint.structuredContent.breakpointId,'string');
  const state=debug.stack({taskId}).structuredContent;
  assert.equal(state.running,true);
  assert.equal(Array.isArray(state.frames),true);
  assert.equal((await debug.stop({taskId})).structuredContent.stopped,true);
  await assert.rejects(debug.continueTask({taskId}),/No debugger session/);
  assert.equal((await local.call('debug_start',{program:'.env'}, {taskId:'not-started'})).isError,true);
  await local.close();
  console.log('PASS debugger: real Node inspector start, attach, breakpoint and task-scoped teardown');
} finally {
  await debug?.close();
  await fs.rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});
}
