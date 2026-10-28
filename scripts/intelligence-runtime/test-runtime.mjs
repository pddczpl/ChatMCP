// Windows CI: actual bundled engines, not scripted LSP/AST substitutes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LspProcess } from '../../DATGOLD-HUB/lib/studio-intelligence.mjs';
import { checkCompiledPcre2, checkCompiledRust, checkReportedPcre2, checkStaticCrt } from './notices.mjs';
import { verifyRuntime } from './verify.mjs';

if (process.platform !== 'win32') throw new Error('Bundled Windows acceptance requires Windows.');
const hubRoot = path.resolve(process.argv[2] || '');
const nodeExe = path.resolve(process.argv[3] || '');
const packageRoot = path.join(hubRoot, 'runtimes', 'lsp', 'node_modules');
await verifyRuntime(hubRoot);
assert.equal((await fs.stat(nodeExe)).isFile(), true, 'The bundled Node executable is required.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-runtime-test-'));
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function checkLsp(language, entry, files, queryName) {
  const workspace = path.join(temp, language);
  await fs.mkdir(workspace, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(workspace, name), content);
  const initializationOptions = language === 'typescript' ? {
    disableAutomaticTypingAcquisition: true,
    tsserver: {path: path.join(packageRoot, 'typescript', 'lib', 'tsserver.js')},
  } : null;
  const client = new LspProcess({
    root:workspace,exe:nodeExe,args:[path.join(packageRoot,entry),'--stdio'],initializationOptions,
  });
  try {
    await client.start();
    const mainName = language === 'python' ? 'main.py' : 'main.ts';
    const mainText = files[mainName];
    const uri = pathToFileURL(path.join(workspace,mainName)).href;
    // Provide the imported source as a real open document, then the importer;
    // this works even while the TypeScript project scanner warms up.
    const utilName=language==='python'?'util.py':'util.ts';
    const utilUri=pathToFileURL(path.join(workspace,utilName)).href;
    client.open(utilUri,files[utilName],language);
    client.open(uri,mainText,language);
    const row = mainText.split('\n')[1];
    const character = row.indexOf(queryName) + 1;
    assert(character > 0, 'Fixture symbol must be present.');
    const args = {textDocument:{uri},position:{line:1,character}};
    let definitions = null;
    for (let attempt = 0; attempt < 16; attempt++) {
      await delay(450);
      definitions = await client.request('textDocument/definition',args,20000);
      if (definitions && (Array.isArray(definitions) ? definitions.length : true)) break;
    }
    const locations=Array.isArray(definitions)?definitions:[definitions].filter(Boolean);
    assert(locations.some(loc=>String(loc?.uri||loc?.targetUri||'').endsWith(language==='python'?'/util.py':'/util.ts')),
      language + ' bundled LSP must resolve cross-file definition; actual='
      + JSON.stringify(locations).slice(0,1100) + '; messages='
      + JSON.stringify(client.serverMessages).slice(0,1000)
      + '; stderr=' + client.stderrTail.slice(0,700));
    const references=await client.request('textDocument/references',
      {...args,context:{includeDeclaration:true}},20000);
    assert(Array.isArray(references) && references.length>0,language+' bundled LSP must find references');
    console.log('PASS bundled '+language+' semantic definition and references');
  } finally { client.close(); }
}
try {
  await checkLsp('typescript','typescript-language-server/lib/cli.mjs',{
    'tsconfig.json':JSON.stringify({compilerOptions:{module:'ESNext',moduleResolution:'Node',strict:true}}),
    'util.ts':"export function greet(name: string): string { return name; }\n",
    'main.ts':"import { greet } from './util';\nconst answer = greet('hello');\n",
  },'greet');
  await checkLsp('python','pyright/langserver.index.js',{
    'util.py':'def greet(name: str) -> str:\n    return name\n',
    'main.py':"from util import greet\nvalue = greet('hello')\n",
  },'greet');
  const pythonExe=path.join(hubRoot,'runtimes','python','python.exe');
  const worker=path.join(hubRoot,'workers','python_index.py');
  const result=spawnSync(pythonExe,['-I','-X','utf8',worker],{
    input:JSON.stringify({schemaVersion:1,files:[{path:'demo.py',source:'class Demo:\n    def run(self):\n        return 1\n'}]}),
    encoding:'utf8',windowsHide:true,timeout:12000,
  });
  assert.equal(result.status,0,result.stderr || String(result.error));
  const json=JSON.parse(result.stdout);
  assert(json.files?.[0]?.symbols?.some(s=>s.qualifiedName==='Demo.run'),
    'Embedded CPython must run real AST worker and return qualified method');
  console.log('PASS bundled embedded CPython AST worker');
  // ripgrep: the Hub's own class finds the bundled binary in the installed layout, it is the release the staging script pins, and it searches
  const { Ripgrep } = await import('../../DATGOLD-HUB/lib/ripgrep.mjs');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pinned = (await fs.readFile(path.join(here, 'stage-ripgrep.ps1'), 'utf8')).match(/\$expectedVersion = '(\d+\.\d+\.\d+)'/)?.[1];
  assert(pinned, 'stage-ripgrep.ps1 must pin a version.');
  const ripgrep = new Ripgrep({ hubDirectory: hubRoot, env: { PATH: '' } });
  const info = await ripgrep.info();
  assert(info, 'The bundled ripgrep must run: ' + ripgrep.problem);
  assert.equal(info.source, 'bundled');
  assert.equal(info.path, path.join(hubRoot, 'runtimes', 'ripgrep', 'rg.exe'));
  assert.equal(info.version, pinned, 'The bundled ripgrep must be the pinned release.');
  // The notices of what is linked into rg.exe (licenses/ripgrep) are derived from sources. This is where they meet the binary. `rg --pcre2-version` prints the constants of the Rust
  // bindings (10.45 for this build, while the library compiled in is 10.46), so it only tells that this is the build the inventory was derived for; the notice itself is tied to the
  // version string that the PCRE2 library carries, which must be in the bytes of rg.exe.
  const noticeInventory = JSON.parse(await fs.readFile(path.join(hubRoot, 'licenses', 'ripgrep', 'MANIFEST.json'), 'utf8'));
  const reportedPcre2 = spawnSync(info.path, ['--pcre2-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const pcre2Problem = checkReportedPcre2(noticeInventory, reportedPcre2.stdout);
  assert.equal(pcre2Problem, null, pcre2Problem ?? '');
  const binary = await fs.readFile(info.path);
  const compiledProblem = checkCompiledPcre2(noticeInventory, binary);
  assert.equal(compiledProblem, null, compiledProblem ?? '');
  console.log('PASS bundled ripgrep carries the PCRE2 version string of the shipped notice');
  // The Rust standard library of the notice is the one of the toolchain that the inventory derives from ripgrep's release record (rustStd.toolchain): core and std leave the paths of their
  // sources, /rustc/<commit>/library/..., in the binary, and that commit must be among them. And the C runtime that the notices name (libcmt, libvcruntime, libucrt) is linked statically:
  // the import table of the PE file names no runtime DLL.
  const rustProblem = checkCompiledRust(noticeInventory, binary);
  assert.equal(rustProblem, null, rustProblem ?? '');
  const crtProblem = checkStaticCrt(binary);
  assert.equal(crtProblem, null, crtProblem ?? '');
  console.log('PASS bundled ripgrep carries the source paths of the Rust toolchain of the shipped notice and imports no C runtime DLL');
  const searched = path.join(temp, 'ripgrep');
  await fs.mkdir(path.join(searched, 'src'), { recursive: true });
  await fs.writeFile(path.join(searched, 'src', 'a.js'), 'const needle = 1;\r\nfunction go() { return needle; }\r\n');
  const found = await ripgrep.search({ directory: searched, pattern: 'needle', limit: 10, accept: () => true });
  assert.equal(found.matches, 2);
  assert.deepEqual(found.files.map(file => file.path), ['src/a.js']);
  if (info.pcre2) assert.equal((await ripgrep.search({ directory: searched, pattern: 'needle(?= =)', regex: true, limit: 10, accept: () => true })).matches, 1);
  console.log('PASS bundled ripgrep ' + info.version + ' (PCRE2 ' + (info.pcre2 ? 'yes' : 'no') + ')');
} finally {
  const dir=await fs.realpath(temp), base=await fs.realpath(os.tmpdir());
  if(path.dirname(dir)!==base || !path.basename(dir).startsWith('chatmcp-runtime-test-')) throw new Error('Unsafe fixture cleanup.');
  await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:150});
}
