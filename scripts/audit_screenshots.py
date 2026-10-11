"""Audit screenshot script for ChatMCP Studio UI.
Captures screens across themes (dark, light) and widths (1920, 1440, 1280, 940, 600).
"""
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

output_dir = Path("design/audit")
output_dir.mkdir(parents=True, exist_ok=True)

root = Path("CHATMCP-HUB")

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        
        widths = [1920, 1440, 1280, 940, 600]
        themes = ["dark", "light"]
        
        for theme in themes:
            for w in widths:
                h = 1080 if w >= 1280 else 900
                ctx = browser.new_context(viewport={"width": w, "height": h})
                ctx.add_init_script(f"""
                    localStorage.setItem('chatmcp:theme', '{theme}');
                """)
                page = ctx.new_page()
                page.goto("about:blank")
                page.set_content('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
                
                page.add_style_tag(path=str(root / "web/react.css"))
                page.add_script_tag(path=str(root / "tests/react-mock-api.js"))
                page.add_script_tag(content=f"""
                    document.documentElement.setAttribute('data-theme', '{theme}');
                    window.__apiState.studio.permissions.pending = [
                        {{
                            id: 'appr-1',
                            category: 'file-write',
                            risk: 'high',
                            title: 'Ghi đè file cấu hình nhạy cảm',
                            file: 'config.py',
                            detail: 'Ghi đè cấu hình sản xuất với 42 dòng thay đổi',
                            requestedAt: new Date(Date.now() - 30000).toISOString(),
                            expiresAt: new Date(Date.now() + 270000).toISOString(),
                            command: 'write config.py',
                            diff: '--- config.py\\n+++ config.py\\n@@ -1,3 +1,3 @@\\n-DEBUG = False\\n+DEBUG = True'
                        }}
                    ];
                """)
                page.add_script_tag(path=str(root / "web/vendor/react.production.min.js"))
                page.add_script_tag(path=str(root / "web/vendor/react-dom.production.min.js"))
                page.add_script_tag(path=str(root / "web/ui-logic.js"))
                page.add_script_tag(path=str(root / "web/onboarding.js"))
                page.add_script_tag(path=str(root / "web/react-app.js"))
                
                page.wait_for_timeout(600)
                
                # Capture main screen with pending approval
                shot_path = output_dir / f"screen-main-{theme}-{w}.png"
                page.screenshot(path=str(shot_path), full_page=True)
                print(f"Saved: {shot_path}")
                
                # Capture inspector tabs at 1440 width
                if w == 1440 and theme == "dark":
                    for tab, filename in [
                        ("Files", "tab-files"),
                        ("Git", "tab-git"),
                        ("Terminal", "tab-terminal"),
                        ("Code / LSP", "tab-intelligence"),
                        ("Plan", "tab-plan"),
                        ("Skills", "tab-skills"),
                        ("Cài đặt", "tab-settings")
                    ]:
                        btn = page.get_by_role("button", name=tab, exact=True)
                        if btn.count() > 0:
                            btn.first.click()
                            page.wait_for_timeout(300)
                            tab_shot = output_dir / f"{filename}-{theme}.png"
                            page.screenshot(path=str(tab_shot), full_page=True)
                            print(f"Saved: {tab_shot}")
                    
                    # Capture Command Palette
                    page.keyboard.press("Control+k")
                    page.wait_for_timeout(300)
                    palette_shot = output_dir / f"dialog-palette-{theme}.png"
                    page.screenshot(path=str(palette_shot), full_page=True)
                    print(f"Saved: {palette_shot}")
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(200)

                page.close()
                
        browser.close()

if __name__ == "__main__":
    run()
