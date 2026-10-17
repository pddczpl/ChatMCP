// Read-only project test discovery. Checks returned by this module are
// suggestions; StudioVerification/PermissionGate remain the only execution
// authority. No dependency installation, internet or command is run here.
import fs from 'node:fs/promises';
import path from 'node:path';
const exists=async p=>(await fs.stat(p).catch(()=>null))?.isFile()===true;
export async function discoverProjectChecks(root){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new TypeError('Absolute project root required.');
  const found=[],seen=new Set();
  const add=(from,command,kind)=>{
    if(seen.has(command))return;
    seen.add(command);found.push({from,command,kind});
  };
  const packageFile=path.join(root,'package.json');
  if(await exists(packageFile)){
    let pkg=null;
    try{
      const stat=await fs.stat(packageFile);
      if(stat.size<200000)pkg=JSON.parse(await fs.readFile(packageFile,'utf8'));
    }catch{}
    if(pkg?.scripts && typeof pkg.scripts==='object'&&!Array.isArray(pkg.scripts)){
      for(const [script,kind] of [
        ['test','node'],['test:unit','node'],['typecheck','typescript'],
        ['lint','static-analysis'],['build','build'],['test:e2e','browser'],
      ])if(typeof pkg.scripts[script]==='string'&&pkg.scripts[script].trim())
        add('package.json',script==='test'?'npm test':'npm run '+script,kind);
    }
    // The runner must be installed locally; never ask npx to fetch a package.
    if(await exists(path.join(root,'tsconfig.json'))&&
       !found.some(x=>x.kind==='typescript'))
      add('tsconfig.json','npx --no-install tsc --noEmit','typescript');
    const hasPlaywright=await exists(path.join(root,'playwright.config.ts'))||
      await exists(path.join(root,'playwright.config.js'))||
      await exists(path.join(root,'playwright.config.mjs'));
    if(hasPlaywright&&!found.some(x=>x.kind==='browser'))
      add('playwright.config','npx --no-install playwright test','browser');
  }
  if(await exists(path.join(root,'pyproject.toml'))||await exists(path.join(root,'pytest.ini'))||
     await exists(path.join(root,'tox.ini')))
    add('Python test configuration','python -m pytest -q','python');
  for(const [name,command,kind] of [
    ['Cargo.toml','cargo test','rust'],['go.mod','go test ./...','go'],
    ['Makefile','make test','make'],
  ])if(await exists(path.join(root,name)))add(name,command,kind);
  return {suggested:found,execution:'Discovery is read-only. Executing any check requires user action or PermissionGate approval.'};
}
