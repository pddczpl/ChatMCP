// Additional internal coding-agent tools. No hooks, external MCP connections or cloud broker.
// All tools are routed through LocalTools -> PermissionGate; outbound access is always 'execute'.
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const object = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const string = (description, other = {}) => ({ type: 'string', description, ...other });
const integer = (description, other = {}) => ({ type: 'integer', description, ...other });
const boolean = (description) => ({ type: 'boolean', description });
const ok = (payload, text = null) => ({ isError: false, content: [{type:'text',text:text === null ? JSON.stringify(payload) : text}], structuredContent: payload });
const fail = (code, message) => Object.assign(new Error(message), { code });
const isPrivateIP = (address) => {
  const ip = address.toLowerCase().replace(/^\[|\]$/g,'').split('%')[0];
  if (ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip)) return true;
  if (ip.startsWith('::ffff:')) return isPrivateIP(ip.slice(7));
  if (net.isIP(ip) === 4) {
    const octets = ip.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 192 && octets[1] === 0)
      || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19));
  }
  return false;
};
export async function assertPublicUrl(value, lookup = (host) => dns.lookup(host,{all:true})) {
  let url;
  try { url = new URL(value); } catch { throw fail('invalid_url','A full HTTPS URL is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443')
    throw fail('unsafe_url','Only HTTPS without credentials or nonstandard ports is supported.');
  const host = url.hostname.replace(/\.$/,'').toLowerCase();
  if (!host || !host.includes('.') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.localhost') || host.endsWith('.example'))
    throw fail('unsafe_url','Local or unresolvable web host is refused.');
  if (net.isIP(host) && isPrivateIP(host)) throw fail('unsafe_url','Private IP is refused.');
  const addresses = net.isIP(host) ? [{address:host}] : await lookup(host);
  if (!addresses.length || addresses.some(entry => !net.isIP(entry.address) || isPrivateIP(entry.address)))
    throw fail('unsafe_url','Private or unresolved DNS address is refused.');
  url.hash='';
  return url;
}
async function publicFetch(input, { signal, maxBytes = 450_000, fetcher = fetch, lookup } = {}) {
  let target = input;
  for (let redirect = 0; redirect < 4; redirect++) {
    const url = await assertPublicUrl(target, lookup);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once:true });
    try {
      const response = await fetcher(url.toString(), {
        redirect:'manual', signal:controller.signal,
        headers: { 'user-agent':'ChatMCP/3.2 (+public-documentation-tool)', 'accept':'text/html, text/plain, application/json, application/xml' },
      });
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw fail('bad_redirect','Redirect missing Location.');
        await response.body?.cancel();
        target = new URL(location,url).toString();
        continue;
      }
      if (!response.ok) throw fail('http_error','HTTP '+response.status);
      const type = response.headers.get('content-type') || '';
      if (!/text\/|json|xml/.test(type)) throw fail('unsupported_media','Web fetch supports text, HTML and JSON only.');
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > maxBytes) throw fail('too_large','Remote document exceeds '+maxBytes+' bytes.');
      const reader = response.body?.getReader();
      if (!reader) throw fail('empty_body','Empty response body.');
      let bytes = 0;
      const chunks=[];
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw fail('too_large','Remote document exceeded byte limit.'); }
        chunks.push(item.value);
      }
      return { url:url.toString(), type, text:Buffer.concat(chunks).toString('utf8'), bytes };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  throw fail('too_many_redirects','More than three web redirects.');
}
export function htmlToText(html) {
  const decoded = String(html || '').replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<!--[\s\S]*?-->/g,' ').replace(/<\/(?:p|h[1-6]|div|li|tr|section|article|br)\s*>/gi,'\n')
    .replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160);/gi,' ')
    .replace(/&(?:amp|#38);/gi,'&').replace(/&(?:lt|#60);/gi,'<').replace(/&(?:gt|#62);/gi,'>')
    .replace(/&quot;|&#34;/gi,'"').replace(/&#39;|&apos;/gi,"'");
  return decoded.split('\n').map(s=>s.replace(/[ \t]+/g,' ').trim()).filter(Boolean).join('\n');
}
function findCommands(info) {
  const commands=[];
  if (info.packageJson) {
    const scripts=info.packageJson.scripts || {};
    if (scripts.test) commands.push({framework:'npm',command:'npm test',source:'package.json scripts.test'});
    else commands.push({framework:'node',command:'node --test',source:'Node built-in test runner'});
  }
  if (info.pyproject || info.pytestIni || info.requirements) commands.push({framework:'pytest',command:'python -m pytest',source:'Python project metadata'});
  if (info.solution) commands.push({framework:'dotnet',command:'dotnet test',source:'Solution or C# project'});
  return commands;
}
export class AgentCapabilities {
  constructor({ workspace, shell, stateDirectory }) {
    this.workspace = workspace; this.shell = shell; this.stateDirectory=stateDirectory;
    this.testRuns = new Map();
  }
  async projectMeta() {
    const { root } = await this.workspace.resolve('');
    const read = name => fs.readFile(path.join(root,name),'utf8').catch(()=>null);
    const pkg = await read('package.json');
    const list=await fs.readdir(root).catch(()=>[]);
    let packageJson=null;
    if(pkg){try{packageJson=JSON.parse(pkg);}catch{ /* return absent */ }}
    return { packageJson, pyproject: Boolean(await read('pyproject.toml')), pytestIni:Boolean(await read('pytest.ini')),
      requirements:Boolean(await read('requirements.txt')), solution:list.some(x=>/\.(sln|slnx|csproj)$/i.test(x)) };
  }
  async shellTest({ framework, cwd = '', failed_only:failedOnly = false, timeout_seconds:timeoutSeconds=180 }, { signal,taskId }) {
    if (failedOnly && framework !== 'pytest') throw fail('unsupported','failed_only is currently supported only for pytest.');
    const commands = { npm:'npm test', node:'node --test', pytest:'python -m pytest' + (failedOnly ? ' --lf' : ''), dotnet:'dotnet test' };
    if (!commands[framework]) throw fail('bad_framework','Supported runners: npm, node, pytest, dotnet.');
    // Commands are fixed by the host; arbitrary model-supplied shell text is never interpolated.
    const started = Date.now();
    const result = await this.shell.run({ command:commands[framework], cwd, timeoutMs: Math.max(1000,Math.min(600000,timeoutSeconds*1000)), signal });
    const record={framework,command:commands[framework],cwd,exitCode:result.exitCode,timedOut:result.timedOut,cancelled:result.cancelled,
      durationMs: Date.now()-started, stdout: result.stdout.slice(-70000),stderr:result.stderr.slice(-30000), truncated:result.truncated};
    if(taskId) this.testRuns.set(taskId,record);
    return {isError:record.exitCode !== 0 || record.timedOut || record.cancelled,content:[{type:'text',
      text:'Test '+framework+' exitCode='+record.exitCode+', timeout='+record.timedOut+'\n'+record.stdout+'\n'+record.stderr}],
      structuredContent:{framework,exitCode:record.exitCode,timedOut:record.timedOut,cancelled:record.cancelled,durationMs:record.durationMs,truncated:record.truncated}};
  }
  async gh(args,{signal}={}) {
    const {root}=await this.workspace.resolve('');
    try {
      const res=await execFileAsync('gh',args,{cwd:root,env:this.shell.environment(),encoding:'utf8',timeout:90000,maxBuffer:1_000_000,windowsHide:true,signal});
      return res.stdout.trim();
    } catch (e) {
      if (e.code === 'ENOENT') throw fail('missing_gh','GitHub CLI gh is not installed or not on PATH.');
      throw fail('gh_failed',String(e.stderr || e.message || e).slice(0,1800));
    }
  }
  async ghRead({action,run_id:runId,number,query},{signal}) {
    const argv={
      workflow_runs:['run','list','--limit','20','--json','databaseId,name,status,conclusion,headBranch,headSha,url'],
      workflow_status:['run','view',String(runId),'--json','databaseId,status,conclusion,jobs,url'],
      job_logs:['run','view',String(runId),'--log-failed'],
      pr_review:['pr','view',String(number),'--json','number,title,reviews,comments,statusCheckRollup,headRefName,baseRefName'],
    }[action];
    if(action==='code_search') {
      if(!query?.trim())throw fail('bad_query','Code search query is required.');
      return ok(JSON.parse(await this.gh(['api','-X','GET','search/code','-f','q='+query.slice(0,240),'-F','per_page=10'],{signal})));
    }
    if(!argv || ((action==='workflow_status'||action==='job_logs') && !Number.isInteger(runId)) || (action==='pr_review'&&!Number.isInteger(number)))
      throw fail('bad_action','Missing run_id / PR number or invalid GitHub read action.');
    const stdout=await this.gh(argv,{signal});
    if(action==='job_logs')return ok({runId,bytes:stdout.length},stdout.slice(0,70000));
    try{return ok(JSON.parse(stdout));}catch{return ok({action,stdout});}
  }
  async ghWrite({action,run_id:runId,number,tag,notes},{signal}) {
    const args=action==='rerun_failed' && Number.isInteger(runId) ? ['run','rerun',String(runId),'--failed']
      : action==='pr_merge' && Number.isInteger(number) ? ['pr','merge',String(number),'--merge']
      : action==='release_create' && typeof tag==='string' && /^[A-Za-z0-9][\w.+-]{0,100}$/.test(tag) ?
        ['release','create',tag,'--notes',String(notes || '').slice(0,30000)] : null;
    if(!args)throw fail('bad_action','Invalid GitHub mutation action or arguments.');
    return ok({action,output:await this.gh(args,{signal})});
  }
  async coverage({path:source='coverage/coverage-summary.json'}) {
    const target=await this.workspace.resolve(source);
    const raw=await fs.readFile(target.absolute,'utf8');
    const json=JSON.parse(raw);
    if(Buffer.byteLength(raw)>500000)throw fail('too_large','Coverage summary too large.');
    const total=json.total || json;
    return ok({path:target.relative,total});
  }
  definitions(define) {
    const read = (name,description,schema,run,summary=()=>name) => define(name,{description,schema,category:'read',reason:'Read local project data',summary,run});
    const network = (name,description,schema,run) => define(name,{description,schema,category:'execute',reason:'Outbound HTTPS request, requires user approval',summary:()=>name,
      annotations:{readOnlyHint:false,openWorldHint:true},run});
    const active = (name,description,schema,run,category='execute') => define(name,{description,schema,category,reason:category==='dangerous'?'Remote repository mutation':'Execute project code with approved permissions',
      summary:()=>name,annotations:{readOnlyHint:false,destructiveHint:category==='dangerous',openWorldHint:category==='dangerous'},run});
    network('web_fetch','Fetch a public HTTPS text document with DNS/private-network protections, redirect and size limits.',object({url:string('Full public HTTPS URL, never a local address.'),max_chars:integer('Limit returned characters, up to 25000.',{minimum:500,maximum:25000})},['url']),
      async(a,ctx)=>{const r=await publicFetch(a.url,{signal:ctx.signal});return ok({url:r.url,bytes:r.bytes,contentType:r.type,text:r.text.slice(0,a.max_chars||16000)});});
    network('web_extract','Extract readable text from a public HTTPS HTML page without executing its JavaScript.',object({url:string('Full public HTTPS URL.'),max_chars:integer('Limit extracted text characters.',{minimum:500,maximum:25000})},['url']),
      async(a,ctx)=>{const r=await publicFetch(a.url,{signal:ctx.signal});return ok({url:r.url,bytes:r.bytes,text:htmlToText(r.text).slice(0,a.max_chars||18000)});});
    network('web_search','Search public web pages via DuckDuckGo HTML; results are untrusted and search provider may block automated traffic.',object({query:string('Search query, 1-200 characters.',{maxLength:200})},['query']),
      async(a,ctx)=>{const r=await publicFetch('https://html.duckduckgo.com/html/?q='+encodeURIComponent(a.query),{signal:ctx.signal});return ok({query:a.query,source:r.url,text:htmlToText(r.text).slice(0,16000)});});
    network('docs_search','Find public documentation for a package or API using a bounded web search.',object({query:string('API or library documentation query.',{maxLength:200})},['query']),
      async(a,ctx)=>{const r=await publicFetch('https://html.duckduckgo.com/html/?q='+encodeURIComponent(a.query+' documentation reference'),{signal:ctx.signal});return ok({query:a.query,source:r.url,text:htmlToText(r.text).slice(0,16000)});});
    network('dependency_lookup','Look up current npm or PyPI dependency versions directly from official HTTPS registries.',object({ecosystem:string('Package registry.',{enum:['npm','pypi']}),name:string('Dependency package name.',{maxLength:120})},['ecosystem','name']),
      async(a,ctx)=>{
        if(!/^[@A-Za-z0-9._/-]+$/.test(a.name)||a.name.includes('..')) throw fail('bad_package','Invalid package name.');
        const url=a.ecosystem==='npm'?'https://registry.npmjs.org/'+encodeURIComponent(a.name.replace(/\//g,'%2F')).replace(/%252F/g,'%2F')+'/latest':
          'https://pypi.org/pypi/'+encodeURIComponent(a.name)+'/json';
        const r=await publicFetch(url,{signal:ctx.signal,maxBytes:600000});const data=JSON.parse(r.text);
        return ok(a.ecosystem==='npm'?{ecosystem:'npm',name:data.name,version:data.version,engines:data.engines,homepage:data.homepage,dependencies:data.dependencies}:
          {ecosystem:'pypi',name:data.info?.name,version:data.info?.version,requires_python:data.info?.requires_python,home_page:data.info?.home_page});
      });
    network('github_code_search','Search GitHub code via authenticated GitHub CLI; access limited by the user GitHub account.',object({query:string('GitHub code search query.',{maxLength:240})},['query']),
      (a,ctx)=>this.ghRead({action:'code_search',query:a.query},ctx));
    read('test_discover','Discover supported repository test runners from Python, Node and .NET project manifests; no execution.',object({}),async()=>ok({commands:findCommands(await this.projectMeta())}));
    active('test_run','Run a selected known test framework through the bounded local shell; real exit code and timeout reported.',object({
      framework:string('Selected test runner.',{enum:['npm','node','pytest','dotnet']}),
      cwd:string('Workspace-relative working directory.'),timeout_seconds:integer('Timeout in seconds, 1-600.',{minimum:1,maximum:600}),
      failed_only:boolean('Re-run failed tests when supported.')},['framework']),
      (a,ctx)=>this.shellTest(a,ctx));
    read('test_results','Get actual output and status of the latest test_run in this task.',object({}),(_,ctx)=>{const r=this.testRuns.get(ctx.taskId);return r?ok(r):ok({status:'not_run'});});
    read('test_coverage','Read a structured JSON coverage summary from within the current workspace.',object({path:string('Workspace-relative JSON coverage file path.')}),
      a=>this.coverage(a));
    read('github_workflow_runs','Read the current repository GitHub Actions workflow runs via authenticated gh CLI.',object({}),(_,ctx)=>this.ghRead({action:'workflow_runs'},ctx));
    read('github_workflow_status','Get real GitHub Actions run conclusion and jobs using a run ID.',object({run_id:integer('GitHub workflow run numeric ID.',{minimum:1})},['run_id']),
      (a,ctx)=>this.ghRead({action:'workflow_status',run_id:a.run_id},ctx));
    read('github_job_logs','Read failed-step output of a GitHub workflow run for CI diagnosis.',object({run_id:integer('GitHub workflow run numeric ID.',{minimum:1})},['run_id']),
      (a,ctx)=>this.ghRead({action:'job_logs',run_id:a.run_id},ctx));
    read('github_pr_review','Read PR reviews, status checks and comments from the authenticated repository.',object({number:integer('Pull request number.',{minimum:1})},['number']),
      (a,ctx)=>this.ghRead({action:'pr_review',number:a.number},ctx));
    active('github_rerun_failed','Request rerun of failed jobs in a GitHub workflow run (requires approval).',object({run_id:integer('Run ID to rerun.',{minimum:1})},['run_id']),
      (a,ctx)=>this.ghWrite({action:'rerun_failed',run_id:a.run_id},ctx),'dangerous');
    active('github_pr_merge','Merge a GitHub pull request with normal branch protection (requires explicit approval).',object({number:integer('Pull request number to merge.',{minimum:1})},['number']),
      (a,ctx)=>this.ghWrite({action:'pr_merge',number:a.number},ctx),'dangerous');
    active('github_release_create','Create a GitHub release from an existing tag (requires approval and gh credentials).',object({tag:string('Release version tag.'),notes:string('Release notes.')},['tag']),
      (a,ctx)=>this.ghWrite({action:'release_create',tag:a.tag,notes:a.notes},ctx),'dangerous');
  }
  async close(){this.testRuns.clear();}
}
export function registerAgentCapabilityTools(define,ctx) {
  const manager = new AgentCapabilities(ctx);
  manager.definitions(define);
  return manager;
}
