"""Shared by the Python browser suites: find a Chromium, or tell the runner that there is none.

Order: $CHATMCP_CHROMIUM, the usual Linux locations, Playwright's own download, then Edge or Chrome installed on the machine.
A suite that cannot get a browser prints "CHATMCP_TEST_SKIP: <reason>" and exits 0, which tests/run-all.mjs reports as SKIP,
never as PASS. Screenshots are written only when CHATMCP_E2E_SHOTS names a folder, so no test needs a fixed output path.
"""
import os
import sys
from pathlib import Path

# The suites print Vietnamese. A Windows console or a pipe defaults to cp1252, which cannot encode it and turns a passing test
# into a crash, so output is UTF-8 whatever the machine's code page is.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:  # pragma: no cover - a stream that cannot be reconfigured keeps its encoding
        pass

BROWSER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage']
LINUX_LOCATIONS = ('/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome')


def skip(reason):
    print(f'CHATMCP_TEST_SKIP: {reason}')
    sys.exit(0)


try:
    from playwright.sync_api import expect, sync_playwright  # noqa: F401  (re-exported for the suites)
except Exception as error:  # pragma: no cover - depends on the machine
    skip(f'Playwright for Python is not installed ({error})')


def launch_chromium(playwright):
    candidates = []
    if os.environ.get('CHATMCP_CHROMIUM'):
        candidates.append({'executable_path': os.environ['CHATMCP_CHROMIUM']})
    candidates += [{'executable_path': path} for path in LINUX_LOCATIONS if Path(path).exists()]
    candidates += [{}, {'channel': 'msedge'}, {'channel': 'chrome'}]
    last = None
    for options in candidates:
        try:
            return playwright.chromium.launch(headless=True, args=BROWSER_ARGS, **options)
        except Exception as error:  # try the next place
            last = error
    skip(f'no Chromium could be started ({str(last).splitlines()[0] if last else "none found"})')


def shot(page, name, **options):
    """Save a screenshot as <CHATMCP_E2E_SHOTS>/<name>.png when that folder is set; otherwise do nothing."""
    folder = os.environ.get('CHATMCP_E2E_SHOTS', '')
    if not folder:
        return None
    Path(folder).mkdir(parents=True, exist_ok=True)
    target = Path(folder) / f'{name}.png'
    page.screenshot(path=str(target), **options)
    return target
