import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { BrowserTools, comparePngBuffers, validateBrowserUrl } from '../lib/browser-tools.mjs';

const png=(width,height,rgba)=>{
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  const chunk=(tag,data)=>{const out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length);out.write(tag,4);data.copy(out,8);return out;};
  const scan=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++){scan[y*(width*4+1)]=0;for(let x=0;x<width;x++){const src=(y*width+x)*4;for(let c=0;c<4;c++)scan[y*(width*4+1)+1+x*4+c]=rgba[src+c];}}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
};
assert.equal(validateBrowserUrl('http://127.0.0.1:3007/').hostname,'127.0.0.1');
for(const url of ['http://10.0.0.8/','https://evil.example/', 'file:///etc/passwd', 'https://username:pass@localhost/'])
  assert.throws(()=>validateBrowserUrl(url),/host|Only|allowed/i);
assert.equal(validateBrowserUrl('https://docs.vendor.com/',{hosts:new Set(['docs.vendor.com'])}).hostname,'docs.vendor.com');
const red=png(1,1,[255,0,0,255]), blue=png(1,1,[0,0,255,255]);
assert.equal(comparePngBuffers(red,red).equal,true);
assert.equal(comparePngBuffers(red,blue).changedPixels,1);
assert.equal(comparePngBuffers(red,blue,{tolerance:255}).equal,true);
assert.equal(comparePngBuffers(red,png(2,1,[255,0,0,255,255,0,0,255])).sameDimensions,false);
assert.throws(()=>comparePngBuffers(Buffer.from('invalid'),red),/PNG/);
const defs=[];
const handlers={},accessible=[];
const fakeLocator={click:async()=>{},fill:async()=>{}};
const fake={chromium:{launch:async()=>({newContext:async()=>({
  route:async()=>{},newPage:async()=>({
    on(type,fn){handlers[type]=fn;},goto:async()=>({status:()=>200}),url:()=>'http://localhost:3007/',
    title:async()=> 'fixture', locator:()=>({first:()=>fakeLocator}),
    getByRole(role,options){accessible.push({role,...options});return fakeLocator;},
    getByLabel(label,options){accessible.push({label,...options});return fakeLocator;},
    screenshot:async()=>red,evaluate:async(fn)=>fn.toString().includes('untrustedDOM:true')
      ?{nodes:[{role:'button',name:'Submit'}],untrustedDOM:true,formValuesIncluded:false}
      :fn.toString().includes('scrollWidth')?{overflowPx:7}:
        {issues:[{rule:'image-alt'}],count:1,engine:'built-in-heuristics',wcagCertified:false},
    viewportSize:()=>({width:1280,height:800}),setViewportSize:async()=>{},waitForTimeout:async()=>{}
  }),close:async()=>{}
}),close:async()=>{}})}};
const driver=new BrowserTools({driver:fake});driver.definitions((name,spec)=>defs.push({name,...spec}));
assert.ok(defs.length>=13);
assert.equal(defs.find(x=>x.name==='browser_fill').category,'execute');
assert.equal(defs.find(x=>x.name==='screenshot_compare').category,'read');
assert.equal(defs.find(x=>x.name==='accessibility_audit').category,'read');
const session={taskId:'task-1'};
assert.equal((await driver.launch({},session)).structuredContent.status,'launched');
assert.equal((await driver.navigate({url:'http://localhost:3007/'},session)).structuredContent.status,200);
const image=await driver.screenshot({},session);const shot=image.structuredContent.id;
assert.equal(image.content[1].type,'image');
const comparison=driver.compare({before:shot,after:shot},session);
assert.equal(comparison.structuredContent.equal,true);
await driver.click({role:'button',name:'Submit'},session);
await driver.fill({label:'Email',text:'SECRET_VALUE_DO_NOT_ECHO'},session);
assert.deepEqual(accessible,[{role:'button',name:'Submit',exact:true},{label:'Email',exact:true}]);
const snapshot=(await driver.domSnapshot({},session)).structuredContent;
assert.equal(snapshot.untrustedDOM,true);
assert.equal(snapshot.formValuesIncluded,false);
const consoleSpec=defs.find(x=>x.name==='browser_console');
const consoleState=await consoleSpec.run({include_dom:true},session);
assert.equal(consoleState.structuredContent.dom.untrustedDOM,true);
assert.ok(!JSON.stringify(consoleState).includes('SECRET_VALUE_DO_NOT_ECHO'));
handlers.response({status:()=>503,url:()=>'http://localhost:3007/api/status?token=private'});
const network=await defs.find(x=>x.name==='browser_network').run({},session);
assert.equal(network.structuredContent.httpErrors[0].status,503);
assert.equal(network.structuredContent.httpErrors[0].url,'http://localhost:3007/api/status');
assert.equal((await driver.responsive({widths:[375]},session)).structuredContent.viewportScreenshots[0].horizontalOverflowPx,7);
const audit=await driver.accessibility({},session);
assert.equal(audit.structuredContent.wcagCertified,false);
assert.equal(audit.structuredContent.count,1);
assert.throws(()=>driver.compare({before:shot,after:shot},{taskId:'task-2'}),/session/);
assert.equal((await driver.closeOne('task-1')).structuredContent.closed,true);
console.log('PASS browser tools: URL allowlist, fake Playwright lifecycle, image output and PNG pixel comparisons');
