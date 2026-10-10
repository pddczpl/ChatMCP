import asyncio
from pathlib import Path
from playwright.async_api import async_playwright
base=Path(__file__).resolve().parents[1]
async def main():
  async with async_playwright() as p:
    browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    page=await browser.new_page(viewport={'width':1440,'height':960}, device_scale_factor=1)
    errors=[];page.on('pageerror',lambda e: errors.append(str(e)))
    await page.set_content((base/'web/index.html').read_text(),wait_until='load')
    await page.add_style_tag(content=(base/'web/style.css').read_text())
    await page.add_style_tag(content=(base/'web/studio.css').read_text())
    # Mock fetch only, with public fixture data. No real account/API access.
    await page.add_script_tag(content='''
    window.fetch=async (url,opts)=>{
      const name=String(url).split('?')[0];
      let data={};
      const state={workspace:{path:'C:\\\\Projects\\\\sensor-fusion'},busy:false,csrfToken:'test-token',services:Object.fromEntries(['docker','cloud','proxy','desktop'].map(x=>[x,{state:'ready',detail:'Mock ready'}])),logs:[],toolCounts:{},agent:{mode:'api',activeTaskId:null,active:null,tasks:[]},ai:{provider:'gemini',model:'gemini-example',configured:false},browser:{paired:false},studio:{workspace:'C:\\\\Projects\\\\sensor-fusion',permissions:{mode:'review',pending:[]},terminals:[]}};
      if(name==='/api/state')data=state;
      if(name==='/api/studio/tree')data={workspace:state.studio.workspace,directory:'',entries:[{name:'student',path:'student',kind:'directory'},{name:'README.md',path:'README.md',kind:'file'}],total:2};
      if(name==='/api/studio/checkpoints')data=[];
      if(name==='/api/studio/git/status')data={head:'a1b2c3',entries:[' M student/workspace/kalman.py']};
      if(name==='/api/studio/plan')data={title:'Sensor Fusion lab',items:[{text:'Read README',status:'done',evidence:''}]};
      if(name==='/api/studio/delegates')data={last:null};
      if(name==='/api/studio/terminal')data=[];
      if(name==='/api/catalog')data={ready:false,tools:[],counts:{}};
      return {ok:true,status:200,json:async()=>data,text:async()=>JSON.stringify(data)};
    };
    ''')
    await page.add_script_tag(content=(base/'web/app.js').read_text())
    await page.add_script_tag(content=(base/'web/studio.js').read_text())
    await page.wait_for_timeout(1500)
    assert await page.locator('#studio-shell').count()==1
    assert await page.locator('#studio-files').is_visible()
    assert await page.locator('#studio-tree .studio-file-entry').count()==2
    await page.get_by_role('tab',name='Git & Review').click()
    assert await page.locator('#studio-git').is_visible()
    await page.get_by_role('tab',name='Terminal').click()
    assert await page.locator('#studio-terminal').is_visible()
    await page.get_by_role('tab',name='Explorer').click()
    assert await page.locator('#studio-files').is_visible()
    await page.screenshot(path='/mnt/data/chatmcp-studio-2-preview.png',full_page=True)
    assert not errors,errors
    print('PASS: headless Chromium UI tabs, source explorer, API mock, no JavaScript runtime errors')
    await browser.close()
asyncio.run(main())
