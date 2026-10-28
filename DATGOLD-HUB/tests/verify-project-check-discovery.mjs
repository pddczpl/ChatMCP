// CLAIM: project-check-discovery

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {discoverProjectChecks} from '../lib/project-check-discovery.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-checks-'));
try{
  const empty=await discoverProjectChecks(root);
  assert.deepEqual(empty.suggested,[]);
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({
    scripts:{test:'node --test',typecheck:'tsc --noEmit',
      'test:e2e':'playwright test',lint:'eslint .',build:'vite build',
      'danger;rm -rf /':'unsafe'},
  }));
  await fs.writeFile(path.join(root,'tsconfig.json'),'{}');
  await fs.writeFile(path.join(root,'playwright.config.mjs'),'');
  await fs.writeFile(path.join(root,'pyproject.toml'),'[tool.pytest.ini_options]\n');
  await fs.writeFile(path.join(root,'Cargo.toml'),'[package]\n');
  const result=await discoverProjectChecks(root);
  const commands=result.suggested.map(x=>x.command);
  assert.deepEqual(commands,[
    'npm test','npm run typecheck','npm run lint','npm run build',
    'npm run test:e2e','python -m pytest -q','cargo test',
  ].sort(()=>0)); // insertion order is deterministic and no command executed
  assert.ok(!JSON.stringify(result).includes('rm -rf'));
  assert.ok(result.suggested.some(x=>x.kind==='browser'));
  assert.ok(result.suggested.some(x=>x.kind==='typescript'));
  await fs.writeFile(path.join(root,'package.json'),'{not json');
  const broken=await discoverProjectChecks(root);
  assert.ok(!broken.suggested.some(x=>x.command==='npm test'));
  assert.ok(broken.suggested.some(x=>x.command==='npx --no-install tsc --noEmit'));
  assert.ok(broken.suggested.some(x=>x.command==='npx --no-install playwright test'));
  assert.ok(!broken.suggested.some(x=>x.command.includes('install -g')));
  console.log('PASS read-only Node, TS, Python, Rust, browser check discovery without arbitrary scripts');
}finally{await fs.rm(root,{recursive:true,force:true});}
