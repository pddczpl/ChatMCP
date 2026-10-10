"""Browser DOM test: prompt starts MCP and the agent chooses tools automatically.
No external network, credentials or real MCP calls are used here.
"""
from pathlib import Path
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser_launch import expect, launch_chromium, shot, sync_playwright  # noqa: E402
root=Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    browser=launch_chromium(p)
    page=browser.new_page(viewport={'width':1550,'height':950})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('about:blank')
    page.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
    page.add_style_tag(path=str(root/'web/react.css'))
    for name in ['tests/react-mock-api.js','web/vendor/react.production.min.js','web/vendor/react-dom.production.min.js','web/ui-logic.js','web/onboarding.js','web/react-app.js']:
        page.add_script_tag(path=str(root/name))
    page.wait_for_timeout(400)
    # Reproduce MCP not started; no pre-start button is pressed.
    page.evaluate("Object.values(window.__apiState.services).forEach(x=>x.state='stopped')")
    page.get_by_role('button',name='Làm mới').click()
    page.wait_for_timeout(160)
    page.get_by_role('button',name='Hội thoại mới').first.click()
    page.locator('#agent-prompt').fill('Kiểm tra README và chạy các tests phù hợp, tự chọn công cụ.')
    page.get_by_role('button',name='Bắt đầu',exact=True).click()
    page.wait_for_timeout(650)
    paths=page.evaluate('window.__requests.filter(x=>x.method==="POST").map(x=>x.path)')
    assert paths.count('/api/services/start')==1, paths
    assert paths.count('/api/tasks/start')==1, paths
    assert paths.index('/api/services/start')<paths.index('/api/tasks/start'),paths
    assert not errors,errors
    # A separate explicit API diagnosis updates protocol/header type in UI.
    page.evaluate("window.__apiState.agent.activeTaskId=null;window.__apiState.agent.active=null;window.__apiState.agent.tasks[0].status='completed'")
    page.get_by_role('button',name='Cài đặt',exact=True).first.click()
    page.get_by_role('button',name='Test API · Tự nhận dạng').click()
    page.wait_for_timeout(400)
    assert '/api/ai/test' in page.evaluate('window.__requests.filter(x=>x.method==="POST").map(x=>x.path)')
    assert not errors,errors
    browser.close()
    print('PASS React UI auto-MCP-start before prompt + one-click API autodetection')
