"""React browser UI regression tests with simulated API replies.

The CI browser cannot access any HTTP URL, including loopback. HTTP endpoints
are tested separately in Node; this test exercises real React DOM interactions.
"""
import re
from pathlib import Path
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser_launch import expect, launch_chromium, shot, sync_playwright  # noqa: E402

root=Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    browser=launch_chromium(p)
    page=browser.new_page(viewport={'width':1580,'height':930},device_scale_factor=1)
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto('about:blank')
    page.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
    page.add_style_tag(path=str(root/'web/react.css'))
    page.add_script_tag(path=str(root/'tests/react-mock-api.js'))
    page.add_script_tag(path=str(root/'web/vendor/react.production.min.js'))
    page.add_script_tag(path=str(root/'web/vendor/react-dom.production.min.js'))
    page.add_script_tag(path=str(root/'web/ui-logic.js'))
    page.add_script_tag(path=str(root/'web/onboarding.js'))
    page.add_script_tag(path=str(root/'web/react-app.js'))
    page.wait_for_timeout(800)
    print('BODY:',page.locator('body').inner_text()[:1200])
    assert not errors,'React exception: '+str(errors)
    expect(page.get_by_text('Rà soát mã nguồn demo').first).to_be_visible()
    page.get_by_role('button',name='Cài đặt',exact=True).first.click()
    page.get_by_role('button',name=re.compile('API Gateway')).last.click()
    page.wait_for_timeout(280)
    assert page.evaluate('window.__apiState.agent.mode')=='api','Mode API not set'
    page.get_by_role('button',name=re.compile('ChatGPT Web')).last.click()
    page.wait_for_timeout(200)
    assert page.evaluate('window.__apiState.agent.mode')=='chatgpt-web','Mode Web not restored'
    page.get_by_role('button',name=re.compile('Rà soát mã nguồn demo')).first.click()
    page.wait_for_timeout(350)
    page.get_by_role('button',name='Xóa phiên').click()
    page.wait_for_timeout(280)
    assert len(page.evaluate('window.__apiState.agent.tasks'))==0
    # Check mutation requests really contain correct CSRF and UI handshake.
    mutations=page.evaluate('window.__requests.filter(x=>x.method==="POST")')
    assert [x['path'] for x in mutations].count('/api/agent/mode')==2
    assert [x['path'] for x in mutations].count('/api/tasks/delete')==1
    assert all(x['headers']['X-ChatMCP-UI-Build']=='2.5.0-react-agent' for x in mutations)
    page.get_by_role('button',name='Files').click()
    page.wait_for_timeout(260)
    page.get_by_role('button',name='README.md').click()
    page.wait_for_timeout(260)
    assert '# Example task' in page.locator('.code-view').inner_text()
    # Command palette is wired to real panel navigation and can use the keyboard.
    page.keyboard.press('Control+k')
    expect(page.get_by_role('dialog',name='Command Palette')).to_be_visible()
    page.get_by_placeholder('Tìm lệnh hoặc điều hướng...').fill('project verification')
    page.keyboard.press('Enter')
    expect(page.get_by_text('Project Verification · bằng chứng kiểm thử')).to_be_visible()
    page.get_by_role('button',name='Run check').first.click()
    page.wait_for_timeout(250)
    assert len(page.evaluate('window.__verificationRuns'))==1,'Verification evidence not saved'
    assert [x['path'] for x in page.evaluate('window.__requests.filter(x=>x.method==="POST")')].count('/api/studio/verify/run')==1
    expect(page.get_by_text('PASS',exact=True)).to_be_visible()
    page.get_by_role('button',name='Files').click()
    shot(page,'chatmcp-studio-2.3.0-preview',full_page=True)
    assert not errors,'React runtime exception: '+str(errors)
    # A React frontend with stale backend assets must stop BEFORE mutations.
    mismatch=browser.new_page(viewport={'width':1250,'height':850})
    mismatch.goto('about:blank')
    mismatch.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
    mismatch.add_style_tag(path=str(root/'web/react.css'))
    mismatch.add_script_tag(path=str(root/'tests/react-mock-api.js'))
    mismatch.add_script_tag(content="base['/api/health']=()=>({app:'chatmcp-local-hub',version:'2.0.0',uiBuild:'old-dashboard',initialized:true});")
    mismatch.add_script_tag(path=str(root/'web/vendor/react.production.min.js'))
    mismatch.add_script_tag(path=str(root/'web/vendor/react-dom.production.min.js'))
    mismatch.add_script_tag(path=str(root/'web/ui-logic.js'))
    mismatch.add_script_tag(path=str(root/'web/onboarding.js'))
    mismatch.add_script_tag(path=str(root/'web/react-app.js'))
    expect(mismatch.get_by_text('Giao diện và tiến trình Hub không cùng phiên bản')).to_be_visible()
    mismatch.get_by_role('button',name='Cài đặt',exact=True).first.click()
    mismatch.get_by_role('button',name=re.compile('API Gateway')).last.click()
    mismatch.wait_for_timeout(120)
    assert not mismatch.evaluate('window.__requests.filter(x=>x.method==="POST")'),'Mismatched Hub must not receive any mutations'
    mismatch.close()
    # Regression: a claimed protocol packet without a send acknowledgement
    # must surface the stall rather than showing only a perpetual spinner.
    stalled=browser.new_page(viewport={'width':1350,'height':850})
    stalled.goto('about:blank')
    stalled.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
    stalled.add_style_tag(path=str(root/'web/react.css'))
    stalled.add_script_tag(path=str(root/'tests/react-mock-api.js'))
    stalled.add_script_tag(content="""
      const waitingTask = window.__apiState.agent.tasks[0];
      waitingTask.status='running';
      waitingTask.delivery={status:'claimed',turn:1,claimedAt:new Date(Date.now()-120000).toISOString()};
      window.__apiState.agent.active=waitingTask;
      window.__apiState.agent.activeTaskId=waitingTask.id;
      window.__apiState.browser={paired:true,connected:true,companionPhase:'reconciling',companionNote:'Đang đối chiếu lượt gửi trong tab tác vụ.'};
    """)
    stalled.add_script_tag(path=str(root/'web/vendor/react.production.min.js'))
    stalled.add_script_tag(path=str(root/'web/vendor/react-dom.production.min.js'))
    stalled.add_script_tag(path=str(root/'web/ui-logic.js'))
    stalled.add_script_tag(path=str(root/'web/onboarding.js'))
    stalled.add_script_tag(path=str(root/'web/react-app.js'))
    expect(stalled.get_by_text('Companion đã nhận gói nhưng Hub chưa xác nhận gửi')).to_be_visible()
    expect(stalled.get_by_text('Đã chờ hơn 90 giây',exact=False)).to_be_visible()
    stalled.close()
    print('PASS React Chromium UI: switch API/Web, delete session, browse/read file, command palette, persisted verification, version mismatch, CSRF headers, no runtime errors')
    browser.close()
