// Real (not mocked) Playwright and LocalTools browser integration on CI Windows/Linux.
import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { BrowserTools } from '../../lib/browser-tools.mjs';

test('new agent browser tools navigate, interact, capture, compare and audit a real local page', async () => {
  const html = '<!doctype html><html lang="en"><head><title>Browser agent fixture</title></head>' +
    '<body><h1>Fixture app</h1><label for="entry">Entry</label><input id="entry" value="">' +
    '<button id="change" type="button">Update</button><p id="result">Before interaction</p>' +
    '<script>document.getElementById("change").addEventListener("click", () => {' +
    'document.getElementById("result").textContent="After interaction: "+document.getElementById("entry").value;});</script></body></html>';
  const server=createServer((_request,response)=>{
    response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    response.end(html);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  const origin='http://127.0.0.1:'+address.port+'/';
  const browserTools=new BrowserTools({driver:{chromium}});
  const taskId='playwright-real-e2e';
  try {
    const launch=await browserTools.launch({width:800,height:600},{taskId});
    expect(launch.structuredContent.status).toBe('launched');
    const navigation=await browserTools.navigate({url:origin},{taskId});
    expect(navigation.structuredContent.status).toBe(200);
    expect(navigation.structuredContent.title).toBe('Browser agent fixture');
    const baseline=await browserTools.screenshot({}, {taskId});
    expect(baseline.content[1].mimeType).toBe('image/png');
    const before=baseline.structuredContent.id;
    expect((await browserTools.fill({selector:'#entry',text:'hello world'},{taskId})).structuredContent.filled).toBe('#entry');
    expect((await browserTools.click({selector:'#change'},{taskId})).structuredContent.clicked).toBe('#change');
    const changed=await browserTools.screenshot({}, {taskId});
    const diff=browserTools.compare({before,after:changed.structuredContent.id},{taskId});
    expect(diff.structuredContent.sameDimensions).toBe(true);
    expect(diff.structuredContent.changedPixels).toBeGreaterThan(0);
    const audit=await browserTools.accessibility({}, {taskId});
    expect(audit.structuredContent.wcagCertified).toBe(false);
    expect(audit.structuredContent.issues).toEqual([]);
    const responsive=await browserTools.responsive({widths:[375,768],height:650},{taskId});
    expect(responsive.structuredContent.viewportScreenshots).toHaveLength(2);
    const definitions=[];browserTools.definitions((name,spec)=>definitions.push({name,...spec}));
    expect(definitions.find(tool=>tool.name==='browser_console').category).toBe('read');
    expect((await definitions.find(tool=>tool.name==='browser_console').run({}, {taskId})).structuredContent.errors).toEqual([]);
    expect((await definitions.find(tool=>tool.name==='browser_network').run({}, {taskId})).structuredContent.failedRequests).toEqual([]);
  } finally {
    await browserTools.close();
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  }
});
