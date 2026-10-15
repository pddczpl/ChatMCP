// Browser automation for the built-in local agent. No external MCP bridge or hook.
// Playwright is optional at runtime; commands remain behind LocalTools and PermissionGate.
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';

const requireUi = createRequire(new URL('../ui/package.json', import.meta.url));
const requirePackaged = createRequire(new URL('../runtimes/browser/package.json', import.meta.url));
const O = (properties, required = []) => ({type:'object',properties,required,additionalProperties:false});
const S = (description, more={}) => ({type:'string',description,...more});
const I = (description,more={})=>({type:'integer',description,...more});
const B = description => ({type:'boolean',description});
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
  constructor({driver=null}={}) {this.driver=driver;this.sessions=new Map();}
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
      const record={browser,context,page,errors:[],requests:[],httpErrors:[],captures:new Map()};
      page.on('console',event=>{if(['error','warning'].includes(event.type()))record.errors.push({type:event.type(),message:event.text().slice(0,1400)});record.errors=record.errors.slice(-100);});
      page.on('pageerror',error=>{record.errors.push({type:'pageerror',message:String(error.message).slice(0,1400)});record.errors=record.errors.slice(-100);});
      page.on('requestfailed',request=>{record.requests.push({url:request.url().split('?')[0].slice(0,600),error:request.failure()?.errorText||'unknown'});record.requests=record.requests.slice(-100);});
      page.on('response',response=>{if(response.status()>=400){record.httpErrors.push({status:response.status(),url:response.url().split('?')[0].slice(0,600)});record.httpErrors=record.httpErrors.slice(-100);}});
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
  // Prefer accessible Playwright roles and labels over fragile CSS selectors.
  // When the model provides a role/name, use Playwright strict matching rather
  // than silently clicking the first of several ambiguous matches.
  #locator(page,{selector,role,name,label}={}) {
    if (role && name && typeof page.getByRole==='function')
      return page.getByRole(role,{name,exact:true});
    if(label && typeof page.getByLabel==='function')return page.getByLabel(label,{exact:true});
    if(typeof selector==='string'&&selector.trim())return page.locator(selector).first();
    throw failure('browser_locator_required','Supply role + accessible name, label, or a selector.');
  }
  async click({selector,role,name},{taskId,signal}={}) {
    const s=this.#get(taskId); signal?.throwIfAborted();
    await this.#locator(s.page,{selector,role,name}).click({timeout:10000});
    return ok({clicked:role?{role,name}:selector,url:s.page.url()});
  }
  async fill({selector,role,name,label,text},{taskId,signal}={}) {
    const s=this.#get(taskId);signal?.throwIfAborted();
    await this.#locator(s.page,{selector,role,name,label}).fill(text,{timeout:10000});
    // Never echo form values back to the model; they might be secrets.
    return ok({filled:role?{role,name}:label||selector,length:text.length});
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
        const layout=await s.page.evaluate(()=>({overflowPx:Math.max(0,document.documentElement.scrollWidth-window.innerWidth)}));
        outputs.push({width,height,id,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),horizontalOverflowPx:Number(layout?.overflowPx)||0});
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
  async domSnapshot({limit=100},{taskId,signal}={}) {
    const s=this.#get(taskId);signal?.throwIfAborted();
    if(!Number.isInteger(limit)||limit<1||limit>200)throw failure('bad_snapshot_limit','DOM snapshot limit must be 1..200.');
    const snapshot=await s.page.evaluate((maximum)=>{
      // This is untrusted UI data. Never extract form values, cookies, storage,
      // password fields, scripts, arbitrary HTML, or request bodies.
      const nodes=[];
      const selector='h1,h2,h3,h4,button,a,input,textarea,select,[role]';
      const elements=document.querySelectorAll(selector);
      for(const node of elements){
        if(nodes.length>=maximum)break;
        if(node.closest('[aria-hidden="true"],[hidden]'))continue;
        const tag=node.tagName.toLowerCase(),role=node.getAttribute('role')||
          ({a:'link',button:'button',h1:'heading',h2:'heading',h3:'heading',h4:'heading',input:'textbox',textarea:'textbox',select:'combobox'}[tag]||tag);
        if(tag==='input'&&node.type==='hidden')continue;
        const name=String(node.getAttribute('aria-label')||node.getAttribute('title')||
          (node.labels?.[0]?.textContent)||node.textContent||'').trim().replace(/\s+/g,' ').slice(0,180);
        nodes.push({role,name,tag,disabled:Boolean(node.disabled)});
      }
      return {title:String(document.title||'').slice(0,200),path:location.pathname.slice(0,300),
        nodes,truncated:elements.length>maximum,untrustedDOM:true,formValuesIncluded:false};
    },limit);
    return ok(snapshot);
  }
  async closeOne(taskId) {
    const s=this.#get(taskId);
    this.sessions.delete(taskId);
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
    executor('browser_click','Click by exact accessible role + name, or a CSS selector; real Playwright click validates visibility.',
      O({selector:S('Optional CSS selector.',{maxLength:500}),role:S('Accessible role, e.g. button.'),name:S('Exact accessible name.')}),
      (a,ctx)=>this.click(a,ctx));
    executor('browser_fill','Fill a field by accessible role + name, label, or selector. Values are not echoed.',
      O({selector:S('Optional CSS selector.',{maxLength:500}),role:S('Accessible role.'),name:S('Accessible name.'),label:S('Exact form label.'),text:S('Text to enter.',{maxLength:16000})},['text']),(a,ctx)=>this.fill(a,ctx));
    executor('browser_screenshot','Capture a real PNG screenshot and forward it to a vision-capable model.',
      O({full_page:{type:'boolean',description:'Capture full page instead of viewport.'}}),(a,ctx)=>this.screenshot(a,ctx));
    executor('browser_console','Read browser errors and optionally return an untrusted, bounded semantic DOM snapshot without form values.',
      O({include_dom:B('Include DOM role/name snapshot, limited to 100 elements.')}),
      async(a,ctx)=>a.include_dom?ok({errors:this.#get(ctx.taskId).errors,dom:(await this.domSnapshot({},ctx)).structuredContent}):ok({errors:this.#get(ctx.taskId).errors}),{readOnly:true});
    executor('browser_network','Read failed browser requests and HTTP 4xx/5xx responses; strip query strings and never return bodies.',
      O({}),(_,ctx)=>ok({failedRequests:this.#get(ctx.taskId).requests,httpErrors:this.#get(ctx.taskId).httpErrors}),{readOnly:true});
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
    executor('accessibility_audit','Run basic deterministic accessibility checks (alt, headings, labels, duplicate IDs); not a complete WCAG audit.',
      O({}), (a,ctx)=>this.accessibility(a,ctx),{readOnly:true});
    executor('responsive_check','Capture PNG screenshots at multiple viewport widths, restoring the initial viewport.',
      O({widths:{type:'array',description:'Viewport widths, up to 3.',items:I('Width in pixels.',{minimum:320,maximum:3840}),minItems:1,maxItems:3},
        height:I('Viewport height in pixels.',{minimum:240,maximum:2160})}),(a,ctx)=>this.responsive(a,ctx));
  }
}
export function registerBrowserTools(define,context){const tools=new BrowserTools(context);tools.definitions(define);return tools;}
