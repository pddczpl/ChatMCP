"""Legacy entry point updated to test the current React dashboard.
The old '#studio-shell' dashboard was retired in Studio 2.1.
This test uses a mocked backend (not a Windows end-to-end test).
"""
from pathlib import Path
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser_launch import expect, launch_chromium, shot, sync_playwright  # noqa: E402
root=Path(__file__).resolve().parent.parent
with sync_playwright() as p:
    browser=launch_chromium(p)
    page=browser.new_page(viewport={'width':1440,'height':900})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('about:blank')
    page.set_content('<!doctype html><html><body><div id="root"></div></body></html>')
    page.add_style_tag(path=str(root/'web/react.css'))
    for script in ['tests/react-mock-api.js','web/vendor/react.production.min.js','web/vendor/react-dom.production.min.js','web/ui-logic.js','web/onboarding.js','web/react-app.js']:
        page.add_script_tag(path=str(root/script))
    expect(page.get_by_text('ChatMCP Studio').first).to_be_visible()
    for tab in ['Files','Git','Terminal']:
        page.get_by_role('button',name=tab,exact=True).click()
        page.wait_for_timeout(100)
    assert not errors,errors
    browser.close()
    print('PASS legacy test entrypoint migrated to React dashboard: Files / Git / Terminal')
