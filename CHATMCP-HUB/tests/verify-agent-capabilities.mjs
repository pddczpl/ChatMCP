import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalTools } from '../lib/local-tools.mjs';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { assertPublicUrl, htmlToText } from '../lib/agent-capabilities.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-extended-tools-'));
try {
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'fixture',scripts:{test:'node --test'}}));
  const workspace=new StudioWorkspace({manager:{workspace:root},directory:root});
  const tools=new LocalTools({workspace,stateDirectory:root});
  for(const name of ['web_fetch','web_search','docs_search','dependency_lookup','github_code_search','test_discover','test_run',
    'test_results','test_coverage','github_workflow_runs','github_workflow_status','github_job_logs','github_pr_review',
    'github_pr_merge','github_release_create','github_rerun_failed']) assert.ok(tools.has(name),name);
  const discovered=await tools.call('test_discover',{});
  assert.equal(discovered.isError,false);
  assert.equal(discovered.structuredContent.commands[0].command,'npm test');
  assert.equal((await tools.assess('github_pr_merge',{number:12})).category,'dangerous');
  assert.equal((await tools.assess('web_fetch',{url:'https://example.com'})).category,'execute');
  assert.equal((await tools.call('test_results',{}, {taskId:'fixture'})).structuredContent.status,'not_run');
  const denied=await tools.call('web_fetch',{url:'http://127.0.0.1:1234'});
  assert.equal(denied.isError,true);
  const denied2=await tools.call('web_fetch',{url:'https://localhost'});
  assert.equal(denied2.isError,true);
  await assert.rejects(assertPublicUrl('https://169.254.169.254/'),/Private IP/);
  await assert.rejects(assertPublicUrl('https://example.com/',async()=>[{address:'10.0.0.3'}]),/Private or unresolved/);
  assert.equal(htmlToText('<h1>Hello</h1><script>steal()</script><p>A &amp; B</p>'),'Hello\nA & B');
  assert.equal((await tools.call('test_run',{framework:'invalid'})).isError,true);
  await tools.close();
  console.log('PASS extended agent tools: registry, permissions, discovery, SSRF protections and HTML extraction');
} finally {await fs.rm(root,{recursive:true,force:true,maxRetries:3});}
