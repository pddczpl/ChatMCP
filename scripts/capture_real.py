"""Capture screenshots from running Hub server at http://127.0.0.1:3099/"""
from pathlib import Path
from playwright.sync_api import sync_playwright

output_dir = Path("design/audit")
output_dir.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    
    # Capture dark
    ctx_dark = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx_dark.add_init_script("localStorage.setItem('chatmcp:theme', 'dark');")
    page_dark = ctx_dark.new_page()
    page_dark.goto("http://127.0.0.1:3099/")
    page_dark.wait_for_timeout(800)
    page_dark.screenshot(path="design/audit/screen-main-dark-1440.png")
    page_dark.close()
    
    # Capture light
    ctx_light = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx_light.add_init_script("localStorage.setItem('chatmcp:theme', 'light');")
    page_light = ctx_light.new_page()
    page_light.goto("http://127.0.0.1:3099/")
    page_light.wait_for_timeout(800)
    # Click light theme button to make sure it's light
    theme_btn = page_light.get_by_role("button", name="Tối")
    if theme_btn.count() > 0:
        theme_btn.click()
        page_light.wait_for_timeout(300)
    page_light.screenshot(path="design/audit/screen-main-light-1440.png")
    page_light.close()
    
    browser.close()
    print("Done capturing real hub screens!")
