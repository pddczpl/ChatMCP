// Runs with the installed portable Node, against the actual installed WinForms
// WebView2 window. No development runtime, browser substitute, or AI call.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [phase, output] = process.argv.slice(2);
assert.ok(['baseline', 'upgrade'].includes(phase));
let socket;
const deadline = Date.now() + 120_000;
let target;
while (Date.now() < deadline) {
  try {
    const targets = await (await fetch('http://127.0.0.1:9229/json/list')).json();
    target = targets.find(t => t.type === 'page' && t.url === 'http://127.0.0.1:3007/');
    if (target) break;
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 400));
}
assert.ok(target, 'installed desktop must initialize WebView2 and navigate to the real Hub');
socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let serial = 0;
const pending = new Map();
socket.addEventListener('message', ({ data }) => {
  const reply = JSON.parse(data);
  const waiter = pending.get(reply.id);
  if (waiter) { pending.delete(reply.id); reply.error ? waiter.reject(reply.error) : waiter.resolve(reply.result); }
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
// A current build signs the page in with the Hub's per-launch secret (kept in sessionStorage); the older build this probe also
// meets in the baseline phase has none and needs no header. Either way the page itself makes the request, as a person's click would.
const AUTH = "(() => { const secret = sessionStorage.getItem('chatmcp.hub-session'); return secret ? { Authorization: 'Bearer ' + secret } : {}; })()";
async function evaluate(expression) {
  const reply = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
  return reply.result.value;
}
try {
  let rendered = false;
  for (let i = 0; i < 120; i++) {
    rendered = await evaluate("Boolean(document.querySelector('#root header'))");
    if (rendered) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(rendered, 'actual desktop React root rendered');
  const state = await evaluate(`fetch('/api/state', { headers: ${AUTH} }).then(r => r.json())`);
  assert.equal(state.agent.tasks.length, 0, 'clean startup creates no AI task');
  if (phase === 'baseline') {
    assert.equal(await evaluate("Boolean(document.querySelector('[role=dialog][aria-label=\"Thiết lập DatGold\"]'))"), true, 'fresh onboarding rendered');
    await evaluate("document.querySelector('[aria-label=\"Đóng thiết lập\"]').click()");
    const profile = await evaluate(`(async () => {
      const state = await (await fetch('/api/state', { headers: ${AUTH} })).json();
      const response = await fetch('/api/ai/profiles/upsert', { method: 'POST',
        headers: { ...${AUTH}, 'Content-Type': 'application/json', 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': state.csrfToken },
        body: JSON.stringify({ id: 'g6-retained', name: 'G6 retained configuration', provider: 'custom', model: 'g6-test-model', apiBaseUrl: 'http://127.0.0.1:9/v1' }) });
      return { status: response.status, body: await response.json() };
    })()`);
    assert.equal(profile.status, 200, 'a real BYO model setting can be saved without sending any AI request');
    await fs.mkdir('C:\\G6EmptyWorkspace');
    const workspace = await evaluate(`(async () => {
      const state = await (await fetch('/api/state', { headers: ${AUTH} })).json();
      const response = await fetch('/api/workspace/select', { method: 'POST',
        headers: { ...${AUTH}, 'Content-Type': 'application/json', 'X-ChatMCP-Request': 'local-dashboard', 'X-ChatMCP-CSRF': state.csrfToken },
        body: JSON.stringify({ path: 'C:\\\\G6EmptyWorkspace' }) });
      return { status: response.status, body: await response.json() };
    })()`);
    assert.equal(workspace.status, 200, 'new empty workspace works without Git installed');
  } else {
    assert.equal(await evaluate("localStorage.getItem('chatmcp:onboarding-completed')"), 'true', 'WebView2 user preferences survive upgrade');
    assert.equal(state.ai.profiles.find(p => p.id === 'g6-retained')?.model, 'g6-test-model', 'Hub model settings survive upgrade');
    assert.equal(state.workspace.path, 'C:\\G6EmptyWorkspace', 'selected empty workspace survives upgrade');
    const installRoot = path.resolve(path.dirname(process.execPath), '..', '..');
    const { probeWindowsSandboxPreflight } = await import(pathToFileURL(path.join(installRoot, 'DATGOLD-HUB/lib/windows-sandbox-probe.mjs')));
    const preflight = await probeWindowsSandboxPreflight();
    assert.equal(preflight.available, false, 'missing guest Sandbox prerequisites fail closed');
    assert.equal(preflight.osIsolated, false, 'missing Sandbox never claims OS isolation');
    await fs.writeFile(path.join(output, 'missing-sandbox-preflight.json'), JSON.stringify(preflight, null, 2));
  }
  const version = await command('Browser.getVersion');
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(output, `${phase}-desktop.png`), Buffer.from(screenshot.data, 'base64'));
  await fs.writeFile(path.join(output, `${phase}-desktop.json`), JSON.stringify({ result: 'PASS', phase, rendered, tasks: state.agent.tasks.length, browser: version.product, title: await evaluate('document.title'), profileSavedOrRetained: true }, null, 2));
} finally { socket.close(); }
