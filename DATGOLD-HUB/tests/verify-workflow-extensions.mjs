import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-workflow-'));
try{
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'fixture',scripts:{build:'echo built'}}));
  await fs.writeFile(path.join(root,'hello.png'),Buffer.from('89504e470d0a1a0a', 'hex'));
  await fs.writeFile(path.join(root,'SKILL.md'),'# Local fixture\n');
  await fs.writeFile(path.join(root,'.env'),'SECRET_VALUE=private');
  const workspace=new StudioWorkspace({manager:{workspace:root},directory:root});
  const tools=new LocalTools({workspace,stateDirectory:root});
  assert.equal((await tools.call('build_detect',{})).structuredContent.candidates[0].runner,'npm');
  const meta=(await tools.call('binary_inspect',{path:'hello.png'}));
  assert.equal(meta.structuredContent.detectedMime,'image/png');
  assert.equal(meta.structuredContent.size,8);
  assert.equal((await tools.call('binary_inspect',{path:'.env'})).isError,true);
  const skills=await tools.call('skills_discover',{});
  assert.ok(skills.structuredContent.instructionFiles.includes('SKILL.md'));
  assert.equal((await tools.assess('build_run',{runner:'npm'})).category,'execute');
  assert.ok(tools.has('git_conflict_inspect'));
  assert.ok(tools.has('test_impact_analysis'));
  await tools.close();
  console.log('PASS workflow tools: build discovery, binary inspection, protected paths and skills discovery');
}finally{await fs.rm(root,{recursive:true,force:true,maxRetries:3});}
