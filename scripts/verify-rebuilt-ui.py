import subprocess
import time
import urllib.request
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 3899
URL = f"http://127.0.0.1:{PORT}"

def wait_for_hub(timeout=15):
    start = time.time()
    while time.time() - start < timeout:
        try:
            req = urllib.request.urlopen(f"{URL}/api/health", timeout=1)
            if req.status == 200:
                return True
        except Exception:
            pass
        time.sleep(0.3)
    return False

def main():
    hub_proc = subprocess.Popen(
        ["node", str(ROOT / "CHATMCP-HUB/hub.mjs"), "--no-open", "--port", str(PORT), "--project", str(ROOT)],
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    try:
        print(f"Waiting for ChatMCP Hub on port {PORT}...")
        if not wait_for_hub():
            print("Failed to start Hub server!")
            out, err = hub_proc.communicate(timeout=2)
            print("STDOUT:", out)
            print("STDERR:", err)
            sys.exit(1)

        print("Hub is ready! Launching Playwright Chromium...")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1600, "height": 960})
            page = context.new_page()

            console_errors = []
            page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda err: console_errors.append(str(err)))

            print(f"Navigating to {URL}/...")
            page.goto(URL, wait_until="networkidle")
            page.wait_for_timeout(800)

            title = page.title()
            print("Page Title:", title)
            assert "ChatMCP Studio" in title, f"Unexpected title: {title}"

            shots_dir = ROOT / "design/screenshots"
            shots_dir.mkdir(parents=True, exist_ok=True)

            # 1. Capture Onboarding Modal
            page.screenshot(path=str(shots_dir / "rebuilt-onboarding-dark.png"))
            print("Captured: design/screenshots/rebuilt-onboarding-dark.png")

            # Close Onboarding Modal
            skip_btn = page.get_by_role("button", name="Bỏ qua")
            if skip_btn.is_visible():
                skip_btn.click()
                page.wait_for_timeout(400)

            # 2. Capture Conversation Empty State in Dark Mode (3D cards)
            page.screenshot(path=str(shots_dir / "rebuilt-conversation-dark.png"))
            print("Captured: design/screenshots/rebuilt-conversation-dark.png")

            # 3. Open Command Palette with Ctrl+K
            page.keyboard.press("Control+k")
            page.wait_for_timeout(400)
            page.screenshot(path=str(shots_dir / "rebuilt-palette-dark.png"))
            print("Captured: design/screenshots/rebuilt-palette-dark.png")

            # Close Command Palette
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)

            # 4. Click Skills Marketplace Tab
            skills_btn = page.get_by_role("button", name="Skills")
            if skills_btn.is_visible():
                skills_btn.click()
                page.wait_for_timeout(500)
                page.screenshot(path=str(shots_dir / "rebuilt-skills-3d-dark.png"))
                print("Captured: design/screenshots/rebuilt-skills-3d-dark.png")

            # 5. Click AI Model Tab
            ai_btn = page.get_by_role("button", name="AI Model")
            if ai_btn.is_visible():
                ai_btn.click()
                page.wait_for_timeout(400)
                page.screenshot(path=str(shots_dir / "rebuilt-ai-model-dark.png"))
                print("Captured: design/screenshots/rebuilt-ai-model-dark.png")

            # 6. Switch to Light Mode
            theme_btn = page.locator('button[title="Chuyển theme sáng / tối"]')
            if theme_btn.is_visible():
                theme_btn.click()
                page.wait_for_timeout(500)
                page.screenshot(path=str(shots_dir / "rebuilt-conversation-light.png"))
                print("Captured: design/screenshots/rebuilt-conversation-light.png")

            # Check console errors
            print("Console Errors:", console_errors)
            assert len(console_errors) == 0, f"Found console errors: {console_errors}"

            browser.close()

        print("\nAll Rebuilt UI/UX verification checks passed with 0 console errors and 0 CSP violations!")

    finally:
        hub_proc.terminate()
        try:
            hub_proc.wait(timeout=3)
        except Exception:
            hub_proc.kill()

if __name__ == "__main__":
    main()
