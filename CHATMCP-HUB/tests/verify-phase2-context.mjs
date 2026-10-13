import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {previewManagedCodingContext} from '../lib/coding-context-preview.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-phase2-context-'));
try{
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'src','one.ts'),'export const n=1;\nexport const m=2;\n');
  await fs.writeFile(path.join(root,'README.md'),'hello\n');
  await fs.writeFile(path.join(root,'.env'),'AI_API_KEY=NEVER_SEND_THIS\n');
  await fs.writeFile(path.join(root,'blob.bin'),Buffer.from([4,0,5]));
  await fs.writeFile(path.join(root,'large.ts'),'a'.repeat(8200));
  const items=['src/one.ts','.env','blob.bin','large.ts','README.md','missing.ts'];
  const view=await previewManagedCodingContext({worktree:root,changedFiles:items});
  assert.deepEqual(view.files.map(f=>f.path),['src/one.ts','README.md']);
  assert.equal(view.fileCount,2);
  assert.equal(view.files[0].lines[0].line,1);
  assert.equal(view.files[0].lines[0].text,'export const n=1;');
  assert.match(view.files[0].sha256,/^[0-9a-f]{64}$/);
  assert.equal(view.sentToModel,false);
  assert.equal(view.testOutcomeAuthenticated,false);
  assert.ok(view.skipped.some(x=>x.path==='.env'&&x.reason==='sensitive_path'));
  assert.ok(view.skipped.some(x=>x.path==='blob.bin'&&x.reason==='binary'));
  assert.ok(view.skipped.some(x=>x.path==='large.ts'&&x.reason==='too_large'));
  assert.ok(view.skipped.some(x=>x.path==='missing.ts'&&x.reason==='deleted'));
  assert.ok(!JSON.stringify(view).includes('NEVER_SEND_THIS'));
  await assert.rejects(previewManagedCodingContext({
    worktree:root,changedFiles:['../outside.txt'],
  }),{code:'context_bad_path'});
  await assert.rejects(previewManagedCodingContext({
    worktree:root,changedFiles:['src/../README.md'],
  }),{code:'context_bad_path'});
  await assert.rejects(previewManagedCodingContext({
    worktree:root,changedFiles:['C:/sensitive.txt'],
  }),{code:'context_bad_path'});
  await assert.rejects(previewManagedCodingContext({
    worktree:root,changedFiles:['src/invalid:ads.txt'],
  }),{code:'context_bad_path'});
  await assert.rejects(previewManagedCodingContext({
    worktree:root,changedFiles:['src/line\nbreak.ts'],
  }),{code:'context_bad_path'});
  await assert.rejects(previewManagedCodingContext({
    worktree:root,changedFiles:[],maxFiles:100,
  }),{code:'context_bad_input'});
  let linked=false;
  try {await fs.symlink(path.join(root,'src'),path.join(root,'linked'),'dir');linked=true;}
  catch(e){if(!['EPERM','EACCES','ENOSYS'].includes(e.code))throw e;}
  if(linked)await assert.rejects(previewManagedCodingContext({
    worktree:root,changedFiles:['linked/one.ts'],
  }),{code:'context_unsafe_path'});
  console.log('PASS: Phase2 read-only context preview is bounded, excludes secrets, validates paths and never certifies tests');
}finally{await fs.rm(root,{recursive:true,force:true});}
