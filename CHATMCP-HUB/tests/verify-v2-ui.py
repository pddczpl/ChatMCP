"""Real React DOM smoke test in Chromium using simulated same-origin Hub API.
This is NOT an end-to-end Windows/Edge test, nor a live Docker/LSP test.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page(viewport={'width':1600,'height':960},device_scale_factor=1)
    errors=[]
    page.on('pageerror',lambda err: errors.append(str(err)))
    page.goto('about:blank');page.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
    for asset in ['web/react.css','tests/react-mock-api.js','web/vendor/react.production.min.js','web/vendor/react-dom.production.min.js','web/react-app.js']:
        if asset.endswith('.css'):page.add_style_tag(path=str(root/asset))
        else:page.add_script_tag(path=str(root/asset))
    page.wait_for_timeout(450)
    expect(page.get_by_text('ChatMCP Studio').first).to_be_visible()
    expect(page.get_by_role('button',name='Tối')).to_be_visible()
    page.get_by_role('button',name='Tối').click()
    assert page.evaluate('document.documentElement.getAttribute("data-theme")')=='light'
    expect(page.get_by_role('button',name='Sáng')).to_be_visible()
    page.get_by_role('button',name='Files').click();page.wait_for_timeout(280)
    page.get_by_role('button',name='README.md').click();page.wait_for_timeout(280)
    assert '# Example task' in page.locator('.code-view').inner_text()
    page.screenshot(path='/mnt/data/chatmcp-studio-2.2.4-light.png',full_page=True)
    page.get_by_role('button',name='Code / LSP').click();page.wait_for_timeout(200)
    page.get_by_role('button',name='Lập chỉ mục mã nguồn').click();page.wait_for_timeout(350)
    page.get_by_placeholder('Tên hàm, class, interface…').fill('calculate')
    page.get_by_role('button',name='Tìm',exact=True).last.click();page.wait_for_timeout(250)
    expect(page.get_by_text('calculate',exact=True)).to_be_visible()
    page.get_by_role('button',name='Refs').click();page.wait_for_timeout(230)
    assert page.get_by_text('main.py:7 · calculate').is_visible()
    page.get_by_role('button',name='Preview').click();page.wait_for_timeout(170)
    expect(page.get_by_text('Local App Preview')).to_be_visible()
    page.get_by_role('button',name='Kiểm tra preview').click();page.wait_for_timeout(250)
    assert page.get_by_text('Connection refused',exact=False).is_visible()
    page.get_by_role('button',name='Ẩn công cụ').click()
    assert page.locator('.studio-no-inspector').count()==1
    page.get_by_role('button',name='Hiện công cụ').click()
    page.get_by_role('button',name='Sáng').click()
    assert page.evaluate('document.documentElement.getAttribute("data-theme")')=='dark'
    page.get_by_role('button',name='Cài đặt',exact=True).first.click();page.wait_for_timeout(300)
    expect(page.get_by_text('Tính năng trên máy này')).to_be_visible()
    expect(page.get_by_text('Desktop Commander sandbox OS')).to_be_visible()
    page.evaluate('window.prompt=()=>"FULL ACCESS"')
    page.get_by_label('Quyền chạy MCP').select_option('full-access');page.wait_for_timeout(250)
    assert page.evaluate('window.__apiState.studio.permissions.executionPolicy')=='full-access'
    assert page.get_by_text('FULL ACCESS ĐANG BẬT').count() >= 1
    page.get_by_label('Quyền chạy MCP').select_option('sandbox-only');page.wait_for_timeout(250)
    assert page.evaluate('window.__apiState.studio.permissions.executionPolicy')=='sandbox-only'
    assert '/api/studio/permissions/config' in page.evaluate('window.__requests.filter(x=>x.method==="POST").map(x=>x.path)')
    page.get_by_role('button',name='Files').click()
    page.screenshot(path='/mnt/data/chatmcp-studio-2.2.4-dark.png',full_page=True)
    assert not errors, 'React runtime errors: '+str(errors)
    mutations=page.evaluate('window.__requests.filter(x=>x.method === "POST").map(x=>x.path)')
    assert '/api/studio/intelligence/index' in mutations
    browser.close()
    print('PASS v2.2 React UI: dark/light theme, saved preference, file viewer, index, refs, preview, inspector visibility, no JS errors')
