import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// What the picker was told about the account's models belongs to the connection it was asked for, and a connection is the preset, the address and how many times the form was saved: a new key
// for the same address is another account, and the models of the old one must not stay on the page as if they were this one's. The form (IntelligenceTab) counts its saves and hands the number to
// the field (`accountRevision`); the field keeps the answer for the number it was asked at (ModelPicker, model-picker-component.test.mjs).
const entry = `
  ${renderPrelude}
  import { IntelligenceTab } from './src/components/inspector/IntelligenceTab';
  import { ModelField } from './src/components/inspector/ModelField';
  export { IntelligenceTab, ModelField };
`;
const TAB = '(globalThis as any)';
const REVISION = { file: 'IntelligenceTab.tsx', from: 'const [accountRevision, setAccountRevision] = useState(0);', to: `const [accountRevision, setAccountRevisionState] = useState<number>(${TAB}.__tabInitial?.revision ?? 0); const setAccountRevision = (value: any) => { (${TAB}.__tabLog ??= []).push(['revision', typeof value === 'function' ? value(accountRevision) : value]); setAccountRevisionState(value); };` };
const tab = await bundleTsx(entry, 'chatmcp-revision-', { recordJsx: true, rewrites: [REVISION] });
after(tab.dispose);

const saved = { configured: true, preset: 'anthropic', provider: 'anthropic', protocol: 'anthropic', model: 'claude-sonnet-5-5', apiBaseUrl: 'https://api.anthropic.com', contextWindowTokens: null };
const entries = [[['hubState'], { ai: saved, agent: { tasks: [] } }], [['aiProfiles'], { profiles: [], defaultProfileId: null }]];
const toasts = [];
const showToast = (message, type) => { toasts.push([message, type]); };
const calls = [];
globalThis.fetch = async (route, options = {}) => {
  calls.push([options.method ?? 'GET', route]);
  if (globalThis.__failSave && route === '/api/ai/config') return new Response(JSON.stringify({ error: 'refused' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const body = route === '/api/ai/config' ? { ai: saved } : { ai: saved, agent: { tasks: [] } };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
async function render(initial = {}) {
  globalThis.__tabInitial = initial;
  globalThis.__tabLog = [];
  globalThis.__chatmcpJsx = [];
  await tab.loaded.renderWith(tab.loaded.IntelligenceTab, {}, entries, [], { lang: 'vi', showToast });
  return globalThis.__chatmcpJsx.slice();
}
const fieldOf = (elements) => elements.find((element) => element.type === tab.loaded.ModelField && element.props.id === 'datgold-model');
const saveOf = (elements) => elements.find((element) => element.props?.variant === 'primary' && typeof element.props.onClick === 'function');
async function press(button) {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try { await button.props.onClick(); for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve)); } finally { delete globalThis.localStorage; }
}

test('the form hands the model field the number of its saves, and a save makes it one more; a save that is refused does not', async () => {
  const elements = await render({ revision: 3 });
  assert.equal(fieldOf(elements).props.accountRevision, 3, 'the field is told how many times the form was saved');
  assert.ok(saveOf(elements), 'the button that saves');
  globalThis.__tabLog = [];
  await press(saveOf(elements));
  assert.ok(calls.some(([method, route]) => method === 'POST' && route === '/api/ai/config'), 'the save went to the Hub');
  assert.deepEqual(globalThis.__tabLog, [['revision', 4]], 'and counts as one more save');
  globalThis.__tabLog = [];
  globalThis.__failSave = true;
  try { await press(saveOf(await render({ revision: 3 }))); } finally { delete globalThis.__failSave; }
  assert.deepEqual(globalThis.__tabLog, [], 'a save the Hub refused changes nothing, so what was asked of the provider is still true');
});
