import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';
import {applyLspTextEdits} from '../lib/lsp-refactor-tools.mjs';
assert.equal(applyLspTextEdits('ab\ncd\n',[{range:{start:{line:0,character:1},end:{line:0,character:2}},newText:'X'}]),'aX\ncd\n');
assert.throws(()=>applyLspTextEdits('test',[{range:{start:{line:0,character:2},end:{line:0,character:1}},newText:'x'}]),/Reversed/);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'chatmcp-semantic-'));
try {
  await fs.writeFile(path.join(root,'test.ts'),'const broken=1;\n');
  await fs.writeFile(path.join(root,'other.ts'),'export const fixed=2;\n');
  let multiRename=false;
  const uri=pathToFileURL(path.join(root,'test.ts')).href;
  const client={
    ready:true,open:()=>{},
    request:async(method)=>method==='textDocument/formatting'?[{range:{start:{line:0,character:0},end:{line:0,character:15}},newText:'const fixed=1;'}]:
      method==='textDocument/rename'?(multiRename?{changes:{
        [uri]:[{range:{start:{line:0,character:6},end:{line:0,character:11}},newText:'renamed'}],
        [pathToFileURL(path.join(root,'other.ts')).href]:[{range:{start:{line:0,character:13},end:{line:0,character:18}},newText:'renamed'}]
      }}:{changes:{[uri]:[{range:{start:{line:0,character:6},end:{line:0,character:12}},newText:'updated'}]}}):
        method==='textDocument/prepareTypeHierarchy'?[]:[]
  };
  const fake={lsp:new Map([['typescript',client]]),lspStart:async()=>({ready:true})};
  const workspace=new StudioWorkspace({manager:{workspace:root},directory:root});
  const tools=new LocalTools({workspace,stateDirectory:root,studioIntelligence:fake});
  assert.equal((await tools.assess('format_document',{file:'test.ts',language:'typescript',apply:true})).category,'workspace_edit');
  assert.equal((await tools.assess('format_document',{file:'test.ts',language:'typescript'})).category,'read');
  const preview=await tools.call('format_document',{file:'test.ts',language:'typescript'});
  assert.equal(preview.isError,false);
  assert.equal(preview.structuredContent.previewOnly,true);
  assert.equal((await tools.call('format_document',{file:'test.ts',language:'typescript',apply:true,expected_sha256:'0'.repeat(64)})).isError,true);
  const sha=createHash('sha256').update(await fs.readFile(path.join(root,'test.ts'),'utf8')).digest('hex');
  const changed=await tools.call('format_document',{file:'test.ts',language:'typescript',apply:true,expected_sha256:sha});
  assert.equal(changed.isError,false,JSON.stringify(changed));
  assert.equal(await fs.readFile(path.join(root,'test.ts'),'utf8'),'const fixed=1;\n');
  multiRename=true;
  const multiPreview=await tools.call('rename_symbol',{file:'test.ts',language:'typescript',new_name:'renamed'});
  assert.equal(multiPreview.isError,false,JSON.stringify(multiPreview));
  assert.equal(multiPreview.structuredContent.previewOnly,true);
  assert.equal(multiPreview.structuredContent.fileCount,2);
  assert.equal(multiPreview.structuredContent.changesApplied,0);
  assert.equal(await fs.readFile(path.join(root,'other.ts'),'utf8'),'export const fixed=2;\n');
  const blocked=await tools.call('rename_symbol',{file:'test.ts',language:'typescript',new_name:'renamed',apply:true,expected_sha256:sha});
  assert.equal(blocked.isError,true,'multi-file changes without an exact reviewed manifest are refused');
  const approved=multiPreview.structuredContent.files.map(f=>({file:f.file,beforeSha256:f.beforeSha256}));
  // Stale review must fail without changing either file.
  await fs.writeFile(path.join(root,'other.ts'),'export const wrong=2;\n');
  const stale=await tools.call('rename_symbol',{file:'test.ts',language:'typescript',new_name:'renamed',
    apply:true,expected_files:approved});
  assert.equal(stale.isError,true);
  assert.equal(await fs.readFile(path.join(root,'test.ts'),'utf8'),'const fixed=1;\n');
  await fs.writeFile(path.join(root,'other.ts'),'export const fixed=2;\n');
  const transaction=await tools.call('rename_symbol',{file:'test.ts',language:'typescript',new_name:'renamed',
    apply:true,expected_files:approved});
  assert.equal(transaction.isError,false,JSON.stringify(transaction));
  assert.equal(transaction.structuredContent.transaction,true);
  assert.ok(transaction.structuredContent.checkpointId);
  assert.equal(await fs.readFile(path.join(root,'test.ts'),'utf8'),'const renamed=1;\n');
  assert.equal(await fs.readFile(path.join(root,'other.ts'),'utf8'),'export const renamed=2;\n');
  const lookup=await tools.call('find_implementations',{file:'test.ts',language:'typescript',line:1,column:1});
  assert.equal(lookup.isError,false);
  await tools.close();
  console.log('PASS LSP semantic tools: preview, permissions, SHA guard, actual single-file write and read-only navigation');
}finally{await fs.rm(root,{recursive:true,force:true,maxRetries:3});}
