"""Capture screenshots of the 3 mockup views in Dark and Light mode."""
from pathlib import Path
from playwright.sync_api import sync_playwright

output_dir = Path("design/audit")
output_dir.mkdir(parents=True, exist_ok=True)
html_file = Path("design/mockup-preview.html").resolve()

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    
    for theme in ["dark", "light"]:
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.goto(html_file.as_uri())
        
        # Apply theme
        page.evaluate(f"document.documentElement.setAttribute('data-theme', '{theme}')")
        page.wait_for_timeout(200)
        
        # View 1: Conversation
        page.evaluate("switchMockup('conversation')")
        page.wait_for_timeout(300)
        page.screenshot(path=f"design/audit/mockup-conversation-{theme}.png")
        print(f"Captured: mockup-conversation-{theme}.png")
        
        # View 2: Approval
        page.evaluate("switchMockup('approval')")
        page.wait_for_timeout(300)
        page.screenshot(path=f"design/audit/mockup-approval-{theme}.png")
        print(f"Captured: mockup-approval-{theme}.png")
        
        # View 3: Skills Marketplace
        page.evaluate("switchMockup('skills')")
        page.wait_for_timeout(300)
        page.screenshot(path=f"design/audit/mockup-skills-{theme}.png")
        print(f"Captured: mockup-skills-{theme}.png")
        
        ctx.close()
        
    browser.close()
    print("Done capturing all mockup views!")
