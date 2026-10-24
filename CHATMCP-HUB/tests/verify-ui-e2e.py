#!/usr/bin/env python3
"""Real-browser end-to-end test: a real Hub, real tools, the real permission gate and the real UI, with a scripted model.

What is real:  hub.mjs started as a subprocess (local backend), the React UI in Chromium, the local tools (read_file,
               edit_file, run_command), the permission gate, the task state machine, the files on disk.
What is fake:  the model. tests/e2e/mock-model-server.mjs answers /v1/chat/completions with a fixed script, so this proves
               the pieces work together, NOT that a real model plans well (that needs an API key; see docs/TESTING-WITH-REAL-MODELS.md).

Flows (one Hub, one browser, in this order):
  0  first run: the wizard (folder -> AI connection with the tool-calling check -> permission -> example) and a read-only task
  1  Review mode, approve:  nothing is written until "Cho phép"; the card shows the exact change and command; reload keeps it
  2  Review mode, deny:     "Từ chối" leaves the file untouched and the agent says so
  3  Read Only mode:        no approval is ever asked, the edit is refused, the file is untouched
  4  Autonomous mode:       the edit and the project's own test run without asking, and the evidence footer says so

Skips (exit 0 with a CHATMCP_TEST_SKIP line) when Playwright or a Chromium is missing, or when the browser cannot reach
loopback HTTP at all; any other problem is a failure.
"""
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HUB_ROOT = Path(__file__).resolve().parent.parent
NODE = os.environ.get('CHATMCP_NODE') or shutil.which('node') or 'node'
SHOTS = os.environ.get('CHATMCP_E2E_SHOTS', '')


sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser_launch import expect, launch_chromium, shot as save_shot, skip, sync_playwright  # noqa: E402

CHECKS = 0


def check(condition, label):
    global CHECKS
    if not condition:
        raise AssertionError(label)
    CHECKS += 1


def step(message):
    print(f'  - {message}', flush=True)


# ---------------------------------------------------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------------------------------------------------
class Proc:
    def __init__(self, name, argv, cwd, env, log_path):
        self.name = name
        self.log_path = log_path
        self.log = open(log_path, 'wb')
        extra = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
        self.process = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT, **extra)

    def text(self):
        try:
            return Path(self.log_path).read_text(encoding='utf-8', errors='replace')
        except OSError:
            return ''

    def stop(self):
        if self.process.poll() is None:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(self.process.pid), '/T', '/F'], capture_output=True)
            else:
                try:
                    os.killpg(self.process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                if os.name != 'nt':
                    try:
                        os.killpg(self.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                self.process.wait(timeout=5)
        self.log.close()


def wait_until(predicate, timeout, message, interval=0.15):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception as error:  # the thing being waited for may not exist yet
            last = error
        time.sleep(interval)
    raise AssertionError(f'Timed out after {timeout}s waiting for: {message} (last: {last!r})')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never route loopback through a proxy


def http_json(url, method='GET', body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={'content-type': 'application/json'} if data else {})
    with OPENER.open(request, timeout=10) as response:
        return json.loads(response.read().decode('utf-8'))


def clean_environment(home):
    """The caller's environment minus anything that looks like a credential, so the run cannot touch a real account."""
    sensitive = re.compile(r'(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^OPENAI_|^ANTHROPIC_|^GEMINI_|^GOOGLE_|^OPENROUTER_|^DEEPSEEK_|^GROQ_|^MISTRAL_|^CHATMCP_|PROXY)', re.I)
    env = {name: value for name, value in os.environ.items() if not sensitive.search(name)}
    env.update({'HOME': str(home), 'USERPROFILE': str(home), 'NO_PROXY': '127.0.0.1,localhost', 'CHATMCP_NO_OPEN': '1'})
    return env


# ---------------------------------------------------------------------------------------------------------------------
# Fixture project
# ---------------------------------------------------------------------------------------------------------------------
BUGGY_CALC = 'function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n'
FIXED_CALC = BUGGY_CALC.replace('return a - b;', 'return a + b;')
TEST_JS = "const assert = require('node:assert/strict');\nconst { add } = require('./calc');\n\nassert.equal(add(2, 3), 5);\nconsole.log('add() ok');\n"
README = '# Máy tính mini\n\nThư viện nhỏ để thử agent.\n'
PROMPT = 'Hàm add trong calc.js đang sai (trừ thay vì cộng). Hãy sửa nó và chạy node test.js để kiểm tra.'


def make_workspace(root):
    workspace = Path(root) / 'mini-calc'
    workspace.mkdir(parents=True)
    (workspace / 'README.md').write_text(README, encoding='utf-8')
    (workspace / 'calc.js').write_text(BUGGY_CALC, encoding='utf-8', newline='')
    (workspace / 'test.js').write_text(TEST_JS, encoding='utf-8', newline='')
    return workspace


def calc_text(workspace):
    return (Path(workspace) / 'calc.js').read_text(encoding='utf-8')


def project_test_passes(workspace):
    result = subprocess.run([NODE, 'test.js'], cwd=str(workspace), capture_output=True, text=True, timeout=30)
    return result.returncode == 0


# ---------------------------------------------------------------------------------------------------------------------
# Browser
# ---------------------------------------------------------------------------------------------------------------------
def main():
    scratch = Path(tempfile.mkdtemp(prefix='chatmcp-e2e-'))
    procs = []
    failure = None
    diagnostics = {}
    try:
        mock = Proc('mock-model', [NODE, str(HUB_ROOT / 'tests/e2e/mock-model-server.mjs'), '--scenario', 'explore'], HUB_ROOT, clean_environment(scratch), scratch / 'mock.log')
        procs.append(mock)
        ready = wait_until(lambda: re.search(r'^READY (\{.*\})$', mock.text(), re.M), 20, 'the mock model server to start')
        mock_info = json.loads(ready.group(1))
        mock_url, mock_origin = mock_info['url'], mock_info['origin']

        workspace = make_workspace(scratch)
        state_dir = scratch / 'state'
        hub_port = free_port()
        hub = Proc('hub', [NODE, str(HUB_ROOT / 'hub.mjs'), '--backend', 'local', '--port', str(hub_port), '--state-dir', str(state_dir), '--no-open'],
                   HUB_ROOT, clean_environment(scratch), scratch / 'hub.log')
        procs.append(hub)
        hub_url = f'http://127.0.0.1:{hub_port}'
        health = wait_until(lambda: http_json(hub_url + '/api/health'), 40, 'the Hub to answer /api/health')
        check(health.get('initialized') is True and health.get('backend') == 'local', 'the Hub starts with the local backend and finishes initialising')
        step(f'Hub {health.get("version")} / UI build {health.get("uiBuild")} on {hub_url}; mock model on {mock_origin}')

        with sync_playwright() as playwright:
            browser = launch_chromium(playwright)
            context = browser.new_context(viewport={'width': 1500, 'height': 940}, locale='vi-VN')
            context.set_default_timeout(30000)
            page = context.new_page()
            page_errors, console_errors, dialogs = [], [], []
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
            failed_calls = []

            def on_response(response):
                if response.status >= 400 and '/api/' in response.url:
                    try:
                        body = response.text()[:400]
                    except Exception:
                        body = ''
                    failed_calls.append(f'{response.status} {response.request.method} {response.url.split("/api/", 1)[1]} {body}')
            page.on('response', on_response)

            def on_dialog(dialog):
                dialogs.append(dialog.message)
                dialog.accept()
            page.on('dialog', on_dialog)

            # The browser must be able to reach loopback HTTP at all; some CI sandboxes block it.
            try:
                page.goto(mock_origin + '/__ping', timeout=10000)
                reachable = '"ok":true' in page.content()
            except Exception:
                reachable = False
            if not reachable:
                skip('the browser cannot reach loopback HTTP in this environment')

            def shot(name):
                save_shot(page, name)

            def vis(locator, timeout=30000):
                expect(locator).to_be_visible(timeout=timeout)

            def hub_state():
                return http_json(hub_url + '/api/state')

            def newest_task():
                tasks = hub_state().get('agent', {}).get('tasks', [])
                return tasks[0] if tasks else None

            def dock():
                return page.get_by_role('region', name='Yêu cầu chờ bạn duyệt')

            def pending_count():
                return len(hub_state().get('studio', {}).get('permissions', {}).get('pending', []))

            def new_conversation():
                page.get_by_role('button', name='Hội thoại mới').first.click()
                expect(page.locator('#agent-prompt')).to_have_value('')

            def send(prompt):
                page.locator('#agent-prompt').fill(prompt)
                page.get_by_role('button', name='Bắt đầu', exact=True).click()

            def set_scenario(name):
                http_json(mock_origin + '/__scenario', 'POST', {'name': name})

            def finish_tag(text='Hoàn tất'):
                vis(page.locator('.chat-meta').get_by_text(text, exact=True), 45000)

            try:
                # ------------------------------------------------------------------------------------------------------
                # 0. First run
                # ------------------------------------------------------------------------------------------------------
                step('0. first run: wizard, folder, AI connection, permission, first read-only task')
                page.goto(hub_url + '/')
                wizard = page.get_by_role('dialog', name='Thiết lập DatGold')
                vis(wizard, 40000)
                check(not page_errors, f'no page error while loading the app: {page_errors}')
                shot('0-wizard-folder')

                wizard.locator('#onboarding-workspace').fill(str(workspace))
                wizard.get_by_role('button', name='Dùng thư mục này').click()
                vis(wizard.get_by_text('Đang dùng:').first)
                wizard.get_by_role('button', name='Tiếp tục').click()

                wizard.locator('#ai-preset').select_option('ollama')
                wizard.get_by_placeholder('https://api.example.com/v1').fill(mock_url)
                wizard.get_by_placeholder('tên model').fill('mock-coder')
                check(wizard.get_by_text('Máy chủ cục bộ: không cần API key').count() >= 1, 'a loopback server needs no API key')
                wizard.get_by_role('button', name='Lưu & kiểm tra').click()
                vis(wizard.locator('.tc-line.tc-success'))
                check('Tool calling hoạt động' in wizard.locator('.tc-line').inner_text(), 'the tool-calling check passes against the model server')
                shot('0-wizard-ai')
                wizard.get_by_role('button', name='Tiếp tục').click()

                wizard.locator('.perm-card', has_text='Review').click()
                check(wizard.locator('.perm-card.active', has_text='Review').count() == 1, 'Review is selected')
                wizard.get_by_role('button', name='Tiếp tục').click()
                vis(wizard.get_by_text('Sẵn sàng làm việc').first)
                wizard.get_by_role('button', name=re.compile('Tìm hiểu dự án')).click()
                expect(wizard).to_be_hidden()
                check('Chỉ đọc, không sửa file nào' in page.locator('#agent-prompt').input_value(), 'the example fills the prompt box')
                shot('0-first-prompt')

                ai = hub_state().get('ai', {})
                check(ai.get('configured') is True and ai.get('toolCalling') == 'supported', f'the Hub reports the model as configured with working tool calling: {ai.get("toolCalling")}')
                check(ai.get('keySource') in (None, 'none'), f'no key is stored for a keyless local server: {ai.get("keySource")}')

                page.get_by_role('button', name='Bắt đầu', exact=True).click()
                vis(page.get_by_text('Tôi chỉ đọc, không sửa gì.').first, 45000)
                finish_tag()
                check('Dự án "Máy tính mini" gồm các file: calc.js, test.js' in page.locator('.chat-stream').inner_text(), 'the answer is built from what the tools returned')
                check(calc_text(workspace) == BUGGY_CALC, 'a read-only task changes nothing on disk')
                check(pending_count() == 0, 'reading needs no approval')
                first = newest_task()
                check(first and first.get('state') == 'completed', f'the first task is completed: {first and first.get("state")}')
                shot('0-first-answer')

                # ------------------------------------------------------------------------------------------------------
                # 1. Review mode, approve
                # ------------------------------------------------------------------------------------------------------
                step('1. Review mode: nothing is written until "Cho phép"; reload keeps the pending approval')
                set_scenario('repair-add')
                new_conversation()
                send(PROMPT)
                vis(dock(), 45000)
                card = dock().get_by_role('group', name='Sửa file')
                vis(card)
                card_text = card.inner_text()
                check('calc.js' in card_text and 'return a - b;' in card_text and 'return a + b;' in card_text, 'the card shows the file and the exact old and new text')
                check(calc_text(workspace) == BUGGY_CALC, 'nothing is written while the edit waits for approval')
                wait_until(lambda: page.title().startswith('(1) Cần duyệt'), 10, 'the tab title to show the pending approval')
                check(True, 'the tab title shows the pending approval')
                check(pending_count() == 1, 'the Hub holds exactly one pending request')
                vis(page.locator('.chat-meta').get_by_text('Chờ bạn duyệt', exact=True))
                shot('1-approval-edit')
                card.get_by_role('button', name='Cho phép').click()

                command_card = dock().get_by_role('group', name='Chạy lệnh trên máy của bạn')
                vis(command_card, 45000)
                command_text = command_card.inner_text()
                check('node test.js' in command_text, 'the command card shows the exact command')
                check(calc_text(workspace) == FIXED_CALC, 'the approved edit is on disk')
                shot('1-approval-command')

                page.reload()
                vis(dock(), 40000)
                command_card = dock().get_by_role('group', name='Chạy lệnh trên máy của bạn')
                vis(command_card)
                check('node test.js' in command_card.inner_text(), 'after a reload the same pending command is shown again')
                check(pending_count() == 1, 'the reload did not lose or duplicate the pending request')
                command_card.get_by_role('button', name='Cho phép').click()

                vis(page.get_by_text('thành công, exit code 0').first, 60000)
                finish_tag()
                footer = page.locator('.result-footer')
                vis(footer)
                check('1 thao tác sửa file thành công' in footer.inner_text() and 'exit code 0' in footer.inner_text(), f'the evidence footer states what really happened: {footer.inner_text()!r}')
                check(calc_text(workspace) == FIXED_CALC and project_test_passes(workspace), 'the fix is on disk and the project test passes when run independently')
                check(pending_count() == 0, 'no approval is left behind')
                timeline = page.locator('.timeline').inner_text()
                check('exit code 0' in timeline and '"isError"' not in timeline, 'the timeline shows the command result as text, not as raw JSON')
                check('Phê duyệt lệnh MCP' not in page.locator('body').inner_text(), 'the approval toast no longer talks about MCP in the local agent')
                shot('1-completed')

                # ------------------------------------------------------------------------------------------------------
                # 2. Review mode, deny
                # ------------------------------------------------------------------------------------------------------
                step('2. Review mode: "Từ chối" leaves the file untouched')
                (workspace / 'calc.js').write_text(BUGGY_CALC, encoding='utf-8', newline='')
                new_conversation()
                send(PROMPT)
                vis(dock(), 45000)
                card = dock().get_by_role('group', name='Sửa file')
                vis(card)
                card.get_by_role('button', name='Từ chối').click()
                vis(page.get_by_text('Tôi chưa sửa calc.js vì thao tác sửa file không được cho phép').first, 45000)
                finish_tag()
                check(calc_text(workspace) == BUGGY_CALC, 'a denied edit leaves the file untouched')
                check(page.locator('.result-footer').count() == 0, 'no "work done" footer is shown when nothing was changed')
                check(pending_count() == 0, 'nothing is left pending after the denial')
                shot('2-denied')

                # ------------------------------------------------------------------------------------------------------
                # 3. Read Only
                # ------------------------------------------------------------------------------------------------------
                step('3. Read Only mode: the edit is refused without asking')
                switch = page.get_by_role('group', name='Quyền của agent')
                switch.get_by_role('button', name='Chỉ đọc').click()
                expect(switch.get_by_role('button', name='Chỉ đọc')).to_have_attribute('aria-pressed', 'true')
                new_conversation()
                send(PROMPT)
                asked = []

                def watch_dock():
                    asked.append(dock().count() + pending_count())
                    return page.get_by_text('Tôi chưa sửa calc.js vì thao tác sửa file không được cho phép').count() > 0
                wait_until(watch_dock, 45, 'the Read Only run to finish', interval=0.1)
                finish_tag()
                check(sum(asked) == 0, 'Read Only never shows or holds an approval request')
                check(calc_text(workspace) == BUGGY_CALC, 'Read Only leaves the file untouched')
                timeline = page.locator('.timeline').inner_text()
                check('Chế độ Chỉ đọc' in timeline and '"isError"' not in timeline, 'the timeline says why the edit was refused, in words and not as raw JSON')
                shot('3-readonly')

                # ------------------------------------------------------------------------------------------------------
                # 4. Autonomous
                # ------------------------------------------------------------------------------------------------------
                step('4. Autonomous mode: edit and the project test run without asking')
                switch.get_by_role('button', name='Tự động').click()
                expect(switch.get_by_role('button', name='Tự động')).to_have_attribute('aria-pressed', 'true')
                check(any('Chế độ Tự động' in message for message in dialogs), 'switching to Autonomous asks for confirmation first')
                new_conversation()
                send(PROMPT)
                asked.clear()

                def watch_autonomous():
                    asked.append(dock().count() + pending_count())
                    return page.get_by_text('thành công, exit code 0').count() > 0
                wait_until(watch_autonomous, 60, 'the Autonomous run to finish', interval=0.1)
                finish_tag()
                check(sum(asked) == 0, 'Autonomous runs the edit and the verification without asking')
                check(calc_text(workspace) == FIXED_CALC and project_test_passes(workspace), 'the Autonomous fix is on disk and the test passes')
                vis(page.locator('.result-footer'))
                shot('4-autonomous')

                # ------------------------------------------------------------------------------------------------------
                # What the model server saw, and what the browser reported
                # ------------------------------------------------------------------------------------------------------
                step('checking what the model server and the browser saw')
                seen = http_json(mock_origin + '/__requests')['requests']
                check(seen, 'the model server received requests')
                check(not any(r['hasAuthorization'] for r in seen), 'no Authorization header was sent to a keyless local server')
                check(all(r['model'] == 'mock-coder' for r in seen), 'every request used the configured model')
                offered = {name for r in seen for name in r['tools']}
                check({'read_file', 'edit_file', 'run_command'} <= offered, f'the agent offered its local tools to the model: {sorted(offered)}')
                last = http_json(mock_origin + '/__last')
                system_prompt = last['messages'][0]['content']
                real_workspace = os.path.realpath(workspace)
                check(real_workspace in system_prompt or json.dumps(real_workspace)[1:-1] in system_prompt, 'the system prompt names the workspace')
                check(not page_errors, f'no page errors during the whole run: {page_errors}')
                bad_console = [m for m in console_errors if re.search(r'Content Security Policy|Uncaught|is not defined|Failed to load module', m)]
                check(not bad_console, f'no CSP or script errors in the console: {bad_console}')
                tasks = hub_state().get('agent', {}).get('tasks', [])
                states = sorted(t.get('state') for t in tasks)
                check(states == ['completed'] * 5, f'all five tasks ended completed: {states}')
                hub_log = hub.text()
                check('Bearer' not in hub_log and 'sk-' not in hub_log, 'the Hub log contains no credential-looking text')
            except BaseException as flow_error:  # noqa: BLE001 - keep what the browser shows, then fail
                diagnostics['page'] = page
                try:
                    out = Path(SHOTS or scratch) / 'e2e-failure.png'
                    out.parent.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(out))
                    print(f'screenshot: {out}')
                    print('page text (start):', page.locator('body').inner_text()[:2500])
                    print('page errors:', page_errors, '| console errors:', console_errors[:8], '| dialogs:', dialogs)
                    print('failed API calls:', *failed_calls[:8], sep='\n  ')
                except Exception as diag_error:
                    print('(could not capture diagnostics:', diag_error, ')')
                raise
            browser.close()
        step(f'{CHECKS} checks passed')
        print(f'PASS verify-ui-e2e: {CHECKS} checks (real Hub + real browser + scripted model)')
    except SystemExit:
        raise
    except BaseException as error:  # noqa: BLE001 - report everything, then clean up
        failure = error
        print(f'FAIL: {type(error).__name__}: {error}')
        for proc in procs:
            print(f'--- {proc.name} log (last lines) ---')
            print('\n'.join(proc.text().splitlines()[-25:]))
    finally:
        for proc in reversed(procs):
            try:
                proc.stop()
            except Exception:
                pass
        if failure is None:
            shutil.rmtree(scratch, ignore_errors=True)
        else:
            print(f'(kept for inspection: {scratch})')
    return 1 if failure is not None else 0


if __name__ == '__main__':
    sys.exit(main())
