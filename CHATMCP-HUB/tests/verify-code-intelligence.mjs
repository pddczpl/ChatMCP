// Includes the owner's focused Code Intelligence fixture AND the real
// StudioWorkspace/LocalTools integration contract used by production.
import './code-intelligence.test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-intel-integration-'));
try {
  const project=path.join(dir,'project');
  const state=path.join(dir,'state');
  await fs.mkdir(path.join(project,'src'),{recursive:true});
  await fs.writeFile(path.join(project,'src','math.mjs'),"export function calculateSum(a,b){ return a+b; }\n");
  await fs.writeFile(path.join(project,'src','entry.mjs'),
    "import { calculateSum } from './math.mjs';\nexport const result = calculateSum(1,2);\n");
  await fs.writeFile(path.join(project,'secrets.json'),JSON.stringify({token:'NEVER_INCLUDE_THIS_SECRET'}));
  const workspace=new StudioWorkspace({manager:{workspace:project,secrets:[]},directory:state});
  const local=new LocalTools({workspace,stateDirectory:state});
  const expected=['repo_map','code_symbols','find_definition','find_references','dependency_graph','code_diagnostics'];
  for(const name of expected) assert.equal(local.has(name),true,name+' is registered in LocalTools');
  const map=await local.call('repo_map',{path:'.',max_tokens:850});
  assert.equal(map.isError,false,JSON.stringify(map).slice(0,500));
  assert.ok(map.structuredContent.totalFiles>=2,'Repo Map detects real workspace source');
  assert.match(map.content[0].text,/src\/math\.mjs/);
  assert.equal(map.content[0].text.includes('NEVER_INCLUDE_THIS_SECRET'),false);
  const symbols=await local.call('code_symbols',{path:'src',query:'calculateSum'});
  assert.equal(symbols.isError,false,JSON.stringify(symbols).slice(0,450));
  assert.match(symbols.content[0].text,/calculateSum/);
  const def=await local.call('find_definition',{symbol:'calculateSum',path:'src'});
  assert.equal(def.isError,false,JSON.stringify(def).slice(0,450));
  assert.equal(def.structuredContent.definitions[0].file,'src/math.mjs');
  const refs=await local.call('find_references',{symbol:'calculateSum',path:'src'});
  assert.equal(refs.isError,false,JSON.stringify(refs).slice(0,450));
  const graph=await local.call('dependency_graph',{path:'src/math.mjs'});
  assert.equal(graph.isError,false,JSON.stringify(graph).slice(0,450));
  const diag=await local.call('code_diagnostics',{path:'src'});
  assert.equal(diag.isError,false,JSON.stringify(diag).slice(0,450));
  const outside=await local.call('repo_map',{path:'../../'});
  assert.equal(outside.isError,true,'path traversal must be rejected');
  const secret=await local.call('code_symbols',{path:'secrets.json'});
  assert.equal(secret.isError,true,'protected files must not be exposed');
  console.log('PASS real async StudioWorkspace/LocalTools Code Intelligence and protected-path integration');
} finally {await fs.rm(dir,{recursive:true,force:true});}
