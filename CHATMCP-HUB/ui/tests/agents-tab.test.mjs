import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { AgentsTab } from './src/components/inspector/AgentsTab';
  import { InspectorPanel } from './src/components/inspector/InspectorPanel';
  import { translations } from './src/lib/i18n';
  export { AgentsTab, InspectorPanel, translations };
`, 'chatmcp-agents-tab-');
after(dispose);
const { renderWith, AgentsTab, InspectorPanel, translations } = loaded;

const hub = { workspace: { path: '/project' }, workspaces: { activePath: '/project', items: [{ path: '/project', name: 'project' }] }, tasks: [], agent: { tasks: [] } };
const base = [[['hubState'], hub], [['backgroundRuns'], { tasks: [], workflows: [] }]];
const tabs = (html) => [...html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map(match => ({ tag: match[0], text: match[1].replace(/<[^>]+>/g, '').trim() }));

test('the Agents tab opens on background tasks and offers agent groups and code edits next to them', async () => {
  const html = await renderWith(AgentsTab, {}, base);
  assert.match(html, /role="tablist"[^>]*aria-label="Các mục của Tác nhân"/);
  const found = tabs(html);
  assert.deepEqual(found.map(tab => tab.text), ['Công việc nền', 'Nhóm trợ lý', 'Sửa mã']);
  assert.match(found[0].tag, /aria-selected="true"/);
  assert.match(found[0].tag, /tabindex="0"/);
  for (const tab of found.slice(1)) {
    assert.match(tab.tag, /aria-selected="false"/);
    assert.match(tab.tag, /tabindex="-1"/, 'a roving tabindex: one stop for the whole switch');
  }
  assert.match(html, /Chưa có công việc nền\./, 'what the tab showed before is still what opens');
});

test('the same switch in English', async () => {
  const html = await renderWith(AgentsTab, {}, base, [], { lang: 'en' });
  assert.match(html, /aria-label="Agent sections"/);
  assert.deepEqual(tabs(html).map(tab => tab.text), ['Background', 'Agent groups', 'Code edits']);
});

test('tabs and panel are wired to each other for a screen reader', async () => {
  const html = await renderWith(AgentsTab, {}, base);
  const found = tabs(html);
  assert.deepEqual(found.map(tab => /id="([^"]+)"/.exec(tab.tag)?.[1]), ['agents-view-background', 'agents-view-groups', 'agents-view-coding']);
  for (const tab of found) assert.match(tab.tag, /aria-controls="agents-viewpanel"/);
  assert.match(html, /id="agents-viewpanel"[^>]*role="tabpanel"[^>]*aria-labelledby="agents-view-background"|role="tabpanel"[^>]*id="agents-viewpanel"[^>]*aria-labelledby="agents-view-background"|id="agents-viewpanel"[^>]*aria-labelledby="agents-view-background"[^>]*role="tabpanel"/);
});

test('the sections can be opened directly, and each shows its own content', async () => {
  const groups = await renderWith(AgentsTab, { initialView: 'groups' }, base);
  assert.match(tabs(groups)[1].tag, /aria-selected="true"/);
  assert.match(groups, /data-testid="agent-groups"/);
  assert.doesNotMatch(groups, /data-testid="coding-agents"/);
  const coding = await renderWith(AgentsTab, { initialView: 'coding' }, base);
  assert.match(tabs(coding)[2].tag, /aria-selected="true"/);
  assert.match(coding, /data-testid="coding-agents"/);
  assert.doesNotMatch(coding, /data-testid="agent-groups"/);
});

test('no section name repeats a tab of the work panel, so a tab can still be found by its name', () => {
  const outer = ['tab_progress', 'tab_changes', 'tab_files', 'tab_terminal', 'tab_activity', 'tab_agents', 'tab_preview', 'tab_more'];
  const inner = ['agents_view_background', 'agents_view_groups', 'agents_view_coding'];
  for (const lang of ['vi', 'en']) {
    const taken = new Set(outer.map(key => translations[lang][key].toLowerCase()));
    for (const key of inner) assert.ok(!taken.has(translations[lang][key].toLowerCase()), `${lang}: "${translations[lang][key]}" is already a tab of the work panel`);
  }
});

test('the work panel mounts the switch in its Agents tab, and the work panel keeps its five tabs and More', async () => {
  const html = await renderWith(InspectorPanel, {}, base, [], { activeTab: 'agents' });
  assert.match(html, /aria-selected="true"[^>]*>Tác nhân</);
  assert.match(html, /id="agents-view-background"/);
  assert.match(html, /id="agents-view-groups"/);
  assert.match(html, /id="agents-view-coding"/);
  // the work panel's own strip is still its own tablist: ids of the two never overlap
  assert.match(html, /id="inspector-tab-agents"/);
  assert.equal((html.match(/id="inspector-tab-/g) || []).length >= 5, true);
});

test('another tab of the work panel does not carry the switch', async () => {
  const html = await renderWith(InspectorPanel, {}, base, [], { activeTab: 'plan' });
  assert.doesNotMatch(html, /agents-view-/);
});

test('with another folder in view, groups and code edits say so and are switched off; background tasks stay usable', async () => {
  const other = { ...hub, workspaces: { activePath: '/elsewhere', items: [] } };
  const entries = [[['hubState'], other], [['backgroundRuns'], { tasks: [], workflows: [] }]];
  const groups = await renderWith(AgentsTab, { initialView: 'groups' }, entries, [], { selectedWorkspacePath: '/elsewhere' });
  assert.match(groups, /role="status"[^>]*>[^<]*\/project[^<]*\/elsewhere|\/project[^<]*\/elsewhere/);
  assert.match(groups, /<fieldset[^>]*disabled/);
  const coding = await renderWith(AgentsTab, { initialView: 'coding' }, entries, [], { selectedWorkspacePath: '/elsewhere' });
  assert.match(coding, /<fieldset[^>]*disabled/);
  // the background list does not act on a folder, so it is not switched off
  const background = await renderWith(AgentsTab, {}, entries, [], { selectedWorkspacePath: '/elsewhere' });
  assert.doesNotMatch(background, /<fieldset[^>]*disabled/);
});
