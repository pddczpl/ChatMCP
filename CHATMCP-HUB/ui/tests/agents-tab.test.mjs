import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bundleTsx, renderPrelude } from './support/bundle.mjs';

// The Agents tab of the work panel is the list of background tasks (what the main agent handed to subagents and workflows). It used to have two more
// sections, agent groups and code edits, where the owner started helpers and coding workers by hand; they were removed (the Hub's routes stay).
const { loaded, dispose } = await bundleTsx(`
  ${renderPrelude}
  import { InspectorPanel } from './src/components/inspector/InspectorPanel';
  export { InspectorPanel };
`, 'chatmcp-agents-tab-');
after(dispose);
const { renderWith, InspectorPanel } = loaded;

const hub = { workspace: { path: '/project' }, workspaces: { activePath: '/project', items: [{ path: '/project', name: 'project' }] }, tasks: [], agent: { tasks: [] } };
const base = [[['hubState'], hub], [['backgroundRuns'], { tasks: [], workflows: [] }]];
const REMOVED = /Nhóm trợ lý|Sửa mã|Agent groups|Code edits|Các mục của Tác nhân|Agent sections|agents-view|agents-viewpanel/;

test('the Agents tab opens on the background tasks and has no section switch', async () => {
  const html = await renderWith(InspectorPanel, {}, base, [], { activeTab: 'agents' });
  assert.match(html, /aria-selected="true"[^>]*>Tác nhân</);
  assert.match(html, /Chưa có công việc nền\./);
  assert.match(html, /aria-controls="inspector-tabpanel"/);
  assert.doesNotMatch(html, REMOVED, 'no agent groups, no code edits, no switch between sections');
  assert.doesNotMatch(html, /<button[^>]*>(?:Bắt đầu phân tích|Bắt đầu với nhóm này|Bắt đầu sửa mã)/, 'and nothing here starts delegated work');
});

test('the same tab in English', async () => {
  const html = await renderWith(InspectorPanel, {}, base, [], { activeTab: 'agents', lang: 'en' });
  assert.match(html, /aria-selected="true"[^>]*>Agents</);
  assert.match(html, /No background work yet\./);
  assert.doesNotMatch(html, REMOVED);
});

test('the work panel keeps its five tabs and More', async () => {
  const html = await renderWith(InspectorPanel, {}, base, [], { activeTab: 'agents' });
  assert.match(html, /id="inspector-tab-agents"/);
  assert.equal((html.match(/id="inspector-tab-/g) || []).length >= 5, true);
});

test('another tab of the work panel does not carry the background list', async () => {
  const html = await renderWith(InspectorPanel, {}, base, [], { activeTab: 'plan' });
  assert.doesNotMatch(html, /Chưa có công việc nền/);
  assert.doesNotMatch(html, REMOVED);
});

// With another folder in view the file, Git and terminal tabs are hidden (they work on the Hub's folder only) and the notice points at the Agents tab,
// where the background list stays usable: it does not act on a folder.
test('with another folder in view, the other tabs say what is still possible and the Agents tab stays usable', async () => {
  const other = { ...hub, workspaces: { activePath: '/elsewhere', items: [] } };
  const entries = [[['hubState'], other], [['backgroundRuns'], { tasks: [], workflows: [] }]];
  for (const [lang, expected] of [['vi', /Bạn vẫn có thể xem kết quả và dừng subagent ở tab Tác nhân\./], ['en', /You can still see the results and stop subagents in the Agents tab\./]]) {
    const blocked = await renderWith(InspectorPanel, {}, entries, [], { activeTab: 'files', selectedWorkspacePath: '/elsewhere', lang });
    assert.match(blocked, expected, lang);
    assert.doesNotMatch(blocked, /giao nhiều task|assign several tasks/, `${lang}: the notice no longer promises to hand out tasks`);
  }
  const agents = await renderWith(InspectorPanel, {}, entries, [], { activeTab: 'agents', selectedWorkspacePath: '/elsewhere' });
  assert.doesNotMatch(agents, /<fieldset[^>]*disabled/);
  assert.match(agents, /Chưa có công việc nền\./);
});
