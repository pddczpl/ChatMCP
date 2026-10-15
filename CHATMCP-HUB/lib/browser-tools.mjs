// Browser automation for the built-in local agent. No external MCP bridge or hook.
// Playwright is optional at runtime; commands remain behind LocalTools and PermissionGate.
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const requireUi = createRequire(new URL('../ui/package.json', import.meta.url));
const requirePackaged = createRequire(new URL('../runtimes/browser/package.json', import.meta.url));
const O = (properties, required = []) => ({type:'object',properties,required,additionalProperties:false});
const S = (description, more={}) => ({type:'string',description,...more});
const I = (description,more={})=>({type:'integer',description,...more});
const failure = (code,message) => Object.assign(new Error(message),{code});
const ok = (data) => ({isError:false,content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
function allowedHosts() {
  return new Set(['localhost','127.0.0.1','[::1]',...(process.env.CHATMCP_BROWSER_ALLOWED_HOSTS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)]);
}
export function validateBrowserUrl(input,{ hosts=allowedHosts() }={}) {
  let url;
  try { url=new URL(input); } catch { throw failure('invalid_url','Browser navigation requires full http(s) URL.'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password)
    throw failure('unsafe_url','Only normal HTTP(S) URLs without credentials are allowed.');
  if (!hosts.has(url.hostname.toLowerCase()) && !hosts.has(url.host.toLowerCase()))
    throw failure('unapproved_host','Browser host is not approved. Default: localhost/127.0.0.1. Configure CHATMCP_BROWSER_ALLOWED_HOSTS to explicitly allow an external hostname.');
  return url;
}
function decodePng(image) {
  const magic=Buffer.from([137,80,78,71,13,10,26,10]);
  if (!Buffer.isBuffer(image) || !image.subarray(0,8).equals(magic)) throw failure('invalid_png','Only PNG screenshots can be compared.');
  let at=8, width=0,height=0,depth=0,color=0,interlace=0;
  const data=[];
  while(at+12 <= image.length) {
    const size=image.readUInt32BE(at), kind=image.toString('ascii',at+4,at+8);
    if (size>image.length-at-12) throw failure('invalid_png','Malformed PNG chunk.');
    const payload=image.subarray(at+8,at+8+size);
    if(kind==='IHDR') {
      width=payload.readUInt32BE(0);height=payload.readUInt32BE(4);depth=payload[8];color=payload[9];interlace=payload[12];
    } else if(kind==='IDAT')data.push(payload);
    at+=size+12;
    if(kind==='IEND')break;
  }
  if(!width || !height || width*height>4_000_000)throw failure('invalid_png','PNG dimensions unsupported or too large.');
  if(depth!==8 || ![0,2,6].includes(color) || interlace!==0)throw failure('unsupported_png','Use 8-bit non-interlaced gray/RGB/RGBA PNG screenshots.');
  const bytesPerPixel=color===6?4:color===2?3:1;
  const rowSize=width*bytesPerPixel, expected=(rowSize+1)*height;
  const buffer=inflateSync(Buffer.concat(data),{maxOutputLength:expected+1});
  if(buffer.length!==expected)throw failure('invalid_png','Unexpected scanline size.');
  const rgba=Buffer.alloc(width*height*4);
  let previous=Buffer.alloc(rowSize), src=0;
  for(let y=0;y<height;y++){
    const filter=buffer[src++], row=Buffer.from(buffer.subarray(src,src+rowSize));src+=rowSize;
    if(filter>4)throw failure('invalid_png','Unsupported PNG filter.');
    for(let x=0;x<rowSize;x++){
      const a=x>=bytesPerPixel?row[x-bytesPerPixel]:0,b=previous[x],c=x>=bytesPerPixel?previous[x-bytesPerPixel]:0;
      const prediction=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):(() => {
        const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
        return pa<=pb&&pa<=pc?a:pb<=pc?b:c;
      })();
      row[x]=(row[x]+prediction)&255;
    }
    for(let x=0;x<width;x++){
      const off=y*width*4+x*4,source=x*bytesPerPixel;
      if(color===0){rgba[off]=rgba[off+1]=rgba[off+2]=row[source];rgba[off+3]=255;}
      else {rgba[off]=row[source];rgba[off+1]=row[source+1];rgba[off+2]=row[source+2];rgba[off+3]=color===6?row[source+3]:255;}
    }
    previous=row;
  }
  return {width,height,rgba};
}
export function comparePngBuffers(left,right,{tolerance=0}={}) {
  if(!Number.isInteger(tolerance)||tolerance<0||tolerance>255)throw failure('bad_tolerance','Tolerance must be 0-255.');
  const a=decodePng(left),b=decodePng(right);
  if(a.width!==b.width||a.height!==b.height)return {sameDimensions:false,left:{width:a.width,height:a.height},right:{width:b.width,height:b.height},changedPixels:null,ratio:1,equal:false};
  let changed=0, maxChannelDelta=0;
  for(let p=0;p<a.rgba.length;p+=4) {
    let differs=false;
    for(let c=0;c<4;c++){
      const delta=Math.abs(a.rgba[p+c]-b.rgba[p+c]);
      maxChannelDelta=Math.max(maxChannelDelta,delta);
      if(delta>tolerance)differs=true;
    }
    if(differs)changed++;
  }
  return {sameDimensions:true,width:a.width,height:a.height,changedPixels:changed,totalPixels:a.width*a.height,ratio:changed/(a.width*a.height),maxChannelDelta,equal:changed===0,tolerance};
}
export class BrowserTools {
  constructor({driver=null,artifactDirectory=null}={}) {
    this.driver=driver;this.sessions=new Map();
    this.artifactDirectory=artifactDirectory||path.join(os.tmpdir(),'chatmcp-browser-traces');
  }
  async #loadDriver() {
    if(this.driver)return this.driver;
    try{return requirePackaged('playwright');}
    catch {try{return requireUi('playwright');}catch{throw failure('playwright_unavailable','Playwright JS runtime missing. The installer packages it and uses installed Edge on Windows; developers should npm ci in CHATMCP-HUB/ui and install Chromium.');}}
  }
  #get(taskId) {
    const record=this.sessions.get(taskId);
    if(!taskId||!record)throw failure('browser_not_running','Start a browser session using browser_launch.');
    return record;
  }
  async launch({width=1280,height=800},{taskId}={}) {
    if(!taskId)throw failure('missing_task','Browser session requires a task ID.');
    if(this.sessions.has(taskId))return ok({status:'already_running',viewport:{width,height}});
    const driver=await this.#loadDriver();
    let browser;
    if(process.platform==='win32') {
      try {browser=await driver.chromium.launch({headless:true,channel:'msedge'});}
      catch {browser=await driver.chromium.launch({headless:true});}
    } else browser=await driver.chromium.launch({headless:true});
    let context;
    try {
      context=await browser.newContext({viewport:{width,height},acceptDownloads:false,serviceWorkers:'block',ignoreHTTPSErrors:false});
      // Every request, not just top-level navigation, stays on explicitly approved hosts.
      await context.route('**/*',async route=>{
        try { validateBrowserUrl(route.request().url());await route.continue(); }
        catch {await route.abort('blockedbyclient');}
      });
      const page=await context.newPage();
      const record={browser,context,page,errors:[],requests:[],captures:new Map(),traceStarted:false};
      page.on('console',event=>{if(['error','warning'].includes(event.type()))record.errors.push({type:event.type(),message:event.text().slice(0,1400)});record.errors=record.errors.slice(-100);});
      page.on('pageerror',error=>{record.errors.push({type:'pageerror',message:String(error.message).slice(0,1400)});record.errors=record.errors.slice(-100);});
      page.on('requestfailed',request=>{record.requests.push({url:request.url().slice(0,600),error:request.failure()?.errorText||'unknown'});record.requests=record.requests.slice(-100);});
      this.sessions.set(taskId,record);
      return ok({status:'launched',viewport:{width,height},headless:true,restrictedNetwork:true});
    } catch(error) {await context?.close().catch(()=>{});await browser.close().catch(()=>{});throw error;}
  }
  async navigate({url},{taskId,signal}={}) {
    const s=this.#get(taskId), checked=validateBrowserUrl(url);
    signal?.throwIfAborted();
    const response=await s.page.goto(checked.toString(),{waitUntil:'domcontentloaded',timeout:20000});
    const final=validateBrowserUrl(s.page.url());
    return ok({url:final.toString(),status:response?.status()??null,title:(await s.page.title()).slice(0,250)});
  }
  async click({selector,role,name},{taskId,signal}={}) {
    const s=this.#get(taskId); signal?.throwIfAborted();
    if(!selector && !role)throw failure('missing_locator','Provide a selector or an accessible role.');
    if(role && !name)throw failure('missing_accessible_name','Role-based actions require an exact accessible name.');
    const target=role?s.page.getByRole(role,{name,exact:true}):s.page.locator(selector);
    await target.first().click({timeout:10000});
    return ok({clicked:role?{role,name}:selector,url:s.page.url()});
  }
  async fill({selector,role,name,text},{taskId,signal}={}) {
    const s=this.#get(taskId);signal?.throwIfAborted();
    if(!selector && !role)throw failure('missing_locator','Provide a selector or an accessible role.');
    if(role && !name)throw failure('missing_accessible_name','Role-based actions require an exact accessible name.');
    const target=role?s.page.getByRole(role,{name,exact:true}):s.page.locator(selector);
    await target.first().fill(text,{timeout:10000});
    // Never echo form values back to the model; they might be secrets.
    return ok({filled:role?{role,name}:selector,length:text.length});
  }
  async screenshot({full_page:fullPage=false},{taskId,signal}={}) {
    const s=this.#get(taskId);signal?.throwIfAborted();
    const bytes=await s.page.screenshot({type:'png',fullPage,timeout:20000,animations:'disabled'});
    if(bytes.length>4_000_000)throw failure('large_screenshot','Screenshot exceeds 4 MB.');
    const id='shot_'+randomUUID();
    s.captures.set(id,bytes);
    while(s.captures.size>8)s.captures.delete(s.captures.keys().next().value);
    const info={id,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,url:s.page.url()};
    return {isError:false,content:[{type:'text',text:JSON.stringify(info)},{type:'image',mimeType:'image/png',data:bytes.toString('base64')}],structuredContent:info};
  }
  compare({before,after,tolerance=0},{taskId}) {
    const s=this.#get(taskId),left=s.captures.get(before),right=s.captures.get(after);
    if(!left||!right)throw failure('missing_screenshot','Both screenshot IDs must belong to the current task.');
    return ok({before,after,...comparePngBuffers(left,right,{tolerance})});
  }
  async responsive({widths=[375,768,1280],height=800},{taskId,signal}={}) {
    const s=this.#get(taskId), original=s.page.viewportSize(),outputs=[];
    try {
      for(const width of widths) {
        signal?.throwIfAborted();
        await s.page.setViewportSize({width,height});
        await s.page.waitForTimeout(80);
        const bytes=await s.page.screenshot({type:'png',animations:'disabled'});
        const id='shot_'+randomUUID();
        s.captures.set(id,bytes);while(s.captures.size>8)s.captures.delete(s.captures.keys().next().value);
        outputs.push({width,height,id,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
      }
      return ok({viewportScreenshots:outputs, note:'Screenshots captured; layout quality still requires human or vision-model evaluation.'});
    } finally {if(original)await s.page.setViewportSize(original);}
  }
  async accessibility({},{taskId,signal}={}) {
    const s=this.#get(taskId);
    signal?.throwIfAborted();
    const report=await s.page.evaluate(() => {
      // Smoke checks only: not a full axe or WCAG certification.
      const issues=[];
      const add=(rule,node,index,detail)=>{if(issues.length<100)issues.push({rule,tag:node?.tagName?.toLowerCase()||'document',index,detail});};
      if(!document.documentElement.getAttribute('lang'))add('html-lang',document.documentElement,0,'Missing html[lang]');
      if(!document.title?.trim())add('document-title',document.documentElement,0,'Missing title');
      if(!document.querySelector('h1'))add('heading-one',document.documentElement,0,'Missing h1');
      [...document.querySelectorAll('img')].forEach((node,i)=>{if(!node.hasAttribute('alt'))add('image-alt',node,i,'Missing alt attribute');});
      [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].forEach((node,i)=>{
        const named=Boolean(node.labels?.length||node.getAttribute('aria-label')?.trim()||
          node.getAttribute('aria-labelledby')?.trim()||node.getAttribute('title')?.trim());
        if(!named)add('form-label',node,i,'Control lacks an associated accessible label');
      });
      [...document.querySelectorAll('button')].forEach((node,i)=>{
        const named=Boolean(node.getAttribute('aria-label')?.trim()||node.getAttribute('aria-labelledby')?.trim()||
          node.getAttribute('title')?.trim()||node.textContent?.trim());
        if(!named)add('button-name',node,i,'Button lacks an accessible name');
      });
      const ids=new Set();
      [...document.querySelectorAll('[id]')].forEach((node,i)=>{
        if(ids.has(node.id))add('duplicate-id',node,i,'Duplicate id');
        ids.add(node.id);
      });
      return {issues,count:issues.length,limited:issues.length>=100,engine:'built-in-heuristics',wcagCertified:false};
    });
    return ok(report);
  }

  async domSnapshot({limit=16000}={},{taskId,signal}={}) {
    const s=this.#get(taskId);signal?.throwIfAborted();
    if(!Number.isInteger(limit)||limit<100||limit>25000)throw failure('bad_snapshot_limit','Snapshot limit must be 100-25000.');
    // Playwright's ARIA snapshot omits input values, so model context does not
    // accidentally include passwords entered through browser_fill.
    if(typeof s.page.locator('body')?.ariaSnapshot!=='function')
      throw failure('aria_snapshot_unavailable','Installed Playwright does not support ARIA snapshots.');
    const text=String(await s.page.locator('body').ariaSnapshot({timeout:10000}));
    return ok({url:validateBrowserUrl(s.page.url()).toString(),ariaSnapshot:text.slice(0,limit),
      truncated:text.length>limit,characters:text.length});
  }
  async assertElement({selector,role,name,visible=true,count}={},{taskId,signal}={}) {
    const s=this.#get(taskId);signal?.throwIfAborted();
    if(!selector&&!role)throw failure('missing_locator','Assertion requires an ARIA role or selector.');
    if(role&&!name)throw failure('missing_accessible_name','ARIA assertions require an exact name.');
    if(count!==undefined&&(!Number.isInteger(count)||count<0||count>10000))
      throw failure('bad_assert_count','Expected count must be 0-10000.');
    const loc=role?s.page.getByRole(role,{name,exact:true}):s.page.locator(selector);
    const actualCount=await loc.count();
    const actualVisible=actualCount>0?await loc.first().isVisible():false;
    const passed=(count===undefined||actualCount===count)&&actualVisible===visible;
    if(!passed)throw failure('browser_assert_failed',
      'Browser assertion failed: count='+actualCount+', visible='+actualVisible+'.');
    return ok({passed:true,actualCount,actualVisible,role:role||null,name:name||null,selector:selector||null});
  }
  async traceStart({},{taskId,signal}={}) {
    const s=this.#get(taskId);signal?.throwIfAborted();
    if(s.traceStarted)throw failure('trace_already_running','A trace is already recording for this task.');
    if(typeof s.context.tracing?.start!=='function')
      throw failure('trace_unavailable','Installed browser runtime lacks trace recording.');
    await s.context.tracing.start({screenshots:true,snapshots:true,sources:false});
    s.traceStarted=true;
    return ok({recording:true,taskId,includes:['screenshots','DOM snapshots','network metadata']});
  }
  async traceStop({},{taskId,signal}={}) {
    const s=this.#get(taskId);signal?.throwIfAborted();
    if(!s.traceStarted)throw failure('trace_not_running','Start browser tracing before stopping it.');
    if(!/^[a-zA-Z0-9-]{1,80}$/.test(String(taskId)))
      throw failure('bad_task_id','Unsafe trace task ID.');
    const dir=path.join(this.artifactDirectory,String(taskId));
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const target=path.join(dir,'trace-'+randomUUID()+'.zip');
    try{
      await s.context.tracing.stop({path:target});
      s.traceStarted=false;
      const stat=await fs.stat(target);
      if(!stat.isFile()||stat.size>64*1024*1024||stat.size<1)
        throw failure('trace_size','Playwright trace ZIP is empty or exceeds 64MiB.');
      const bytes=await fs.readFile(target);
      return ok({saved:true,path:target,bytes:bytes.length,
        sha256:createHash('sha256').update(bytes).digest('hex'),
        containsSensitivePageData:true,localArtifact:true});
    }catch(error){
      s.traceStarted=false;await fs.unlink(target).catch(()=>{});
      throw error;
    }
  }
  async closeOne(taskId) {
    const s=this.#get(taskId);
    this.sessions.delete(taskId);
    if(s.traceStarted)await s.context.tracing?.stop?.().catch(()=>{});
    await s.context.close().catch(()=>{});await s.browser.close().catch(()=>{});
    return ok({closed:true});
  }
  async close(){for(const key of [...this.sessions.keys()])await this.closeOne(key);}
  definitions(define) {
    const executor = (name,description,schema,run,{readOnly=false}={})=>define(name,{
      description,schema,reason:'Browser access to locally running apps, approved by PermissionGate',
      category:readOnly?'read':'execute',annotations:{readOnlyHint:readOnly,openWorldHint:!readOnly},
      summary:()=>name,run});
    executor('browser_launch','Launch an isolated headless Chromium session; requires Playwright and Chromium installed in the runtime.',
      O({width:I('Viewport width (320-3840).',{minimum:320,maximum:3840}),height:I('Viewport height (240-2160).',{minimum:240,maximum:2160})}),
      (a,ctx)=>this.launch(a,ctx));
    executor('browser_navigate','Navigate Chromium only to localhost or explicitly allowed hosts; subrequests are restricted.',
      O({url:S('Full http(s) navigation URL, host must be allowed.')},['url']),(a,ctx)=>this.navigate(a,ctx));
    executor('browser_click','Click a Playwright selector or exact accessible role/name; prefer semantic locators for robust UI tests.',
      O({selector:S('Optional CSS or text selector.',{maxLength:500}),role:S('Optional accessible ARIA role.',{maxLength:80}),name:S('Exact accessible name when role is given.',{maxLength:300})}),
      (a,ctx)=>this.click(a,ctx));
    executor('browser_fill','Fill input by selector or exact ARIA role/name; entered value is never echoed.',
      O({selector:S('Optional CSS or text selector.',{maxLength:500}),role:S('Optional accessible ARIA role.',{maxLength:80}),
        name:S('Exact accessible name when role is given.',{maxLength:300}),text:S('Text to enter.',{maxLength:16000})},['text']),
      (a,ctx)=>this.fill(a,ctx));
    executor('browser_screenshot','Capture a real PNG screenshot and forward it to a vision-capable model.',
      O({full_page:{type:'boolean',description:'Capture full page instead of viewport.'}}),(a,ctx)=>this.screenshot(a,ctx));
    executor('browser_console','Read recent browser console errors and page exceptions (within this task only).',
      O({}),(_,ctx)=>ok({errors:this.#get(ctx.taskId).errors}),{readOnly:true});
    executor('browser_network','Read recent failed browser network requests; no arbitrary response bodies.',
      O({}),(_,ctx)=>ok({failedRequests:this.#get(ctx.taskId).requests}),{readOnly:true});
    executor('browser_close','Close the isolated browser process and clear its captured images.',
      O({}),(_,ctx)=>this.closeOne(ctx.taskId));
    executor('screenshot_capture','Capture a PNG screenshot with Playwright; returns image and screenshot ID.',
      O({full_page:{type:'boolean',description:'Capture entire page.'}}),(a,ctx)=>this.screenshot(a,ctx));
    executor('screenshot_compare','Compare two in-task PNG captures using per-pixel RGBA differences and optional channel tolerance.',
      O({before:S('First screenshot ID.'),after:S('Second screenshot ID.'),tolerance:I('Maximum allowed difference per channel.',{minimum:0,maximum:255})},['before','after']),
      (a,ctx)=>this.compare(a,ctx),{readOnly:true});
    executor('visual_diff','Compare captured PNG images pixel by pixel, with safe task-scoped screenshot IDs.',
      O({before:S('First screenshot ID.'),after:S('Second screenshot ID.'),tolerance:I('Channel tolerance 0-255.',{minimum:0,maximum:255})},['before','after']),
      (a,ctx)=>this.compare(a,ctx),{readOnly:true});

    executor('browser_dom_snapshot','Read a bounded ARIA semantic tree, never reading form input values.',
      O({limit:I('Maximum ARIA snapshot characters.',{minimum:100,maximum:25000})}),
      (a,ctx)=>this.domSnapshot(a,ctx),{readOnly:true});
    executor('browser_assert','Assert visible/hidden UI state and exact element count using accessible locators.',
      O({selector:S('Optional CSS selector.'),role:S('Accessible role.'),name:S('Exact accessible name.'),
        visible:{type:'boolean',description:'Whether an exact matching element must be visible.'},count:I('Expected number of matching elements.',{minimum:0,maximum:10000})}),
      (a,ctx)=>this.assertElement(a,ctx),{readOnly:true});
    executor('browser_trace_start','Start user-approved task-scoped Playwright tracing (may contain sensitive UI data).',
      O({}), (a,ctx)=>this.traceStart(a,ctx));
    executor('browser_trace_stop','Save a local Playwright trace ZIP for developer diagnostics (may contain sensitive UI data).',
      O({}), (a,ctx)=>this.traceStop(a,ctx));
    executor('accessibility_audit','Run basic deterministic accessibility checks (alt, headings, labels, duplicate IDs); not a complete WCAG audit.',
      O({}), (a,ctx)=>this.accessibility(a,ctx),{readOnly:true});
    executor('responsive_check','Capture PNG screenshots at multiple viewport widths, restoring the initial viewport.',
      O({widths:{type:'array',description:'Viewport widths, up to 3.',items:I('Width in pixels.',{minimum:320,maximum:3840}),minItems:1,maxItems:3},
        height:I('Viewport height in pixels.',{minimum:240,maximum:2160})}),(a,ctx)=>this.responsive(a,ctx));
  }
}
export function registerBrowserTools(define,context){const tools=new BrowserTools(context);tools.definitions(define);return tools;}
