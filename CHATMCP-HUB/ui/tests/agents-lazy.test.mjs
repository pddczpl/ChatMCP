import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bundleTsx, renderPrelude, ui } from './support/bundle.mjs';
import { parseHtml, byId, byRole, all } from './support/html.mjs';

// The Agents tab fetches the script of its two delegation sections (agent groups, code edits) the first time each one is opened, so that the first
// screen does not carry them. A lazy component that an earlier render has already loaded renders at once, so every test here bundles its own copy
// of the app: what a render shows depends on that test alone, never on the order in which the tests run.

const bundleSwitch = () => bundleTsx(`
  ${renderPrelude}
  import { AgentsTab } from './src/components/inspector/AgentsTab';
  import { translations } from './src/lib/i18n';
  export { AgentsTab, translations };
`, 'chatmcp-agents-lazy-');
/** Time for a script that is already on its way to be evaluated (the bundled import settles in microtasks). */
const settle = () => new Promise((resolve) => setImmediate(resolve));
const hub = { workspace: { path: '/project' }, workspaces: { activePath: '/project', items: [{ path: '/project', name: 'project' }] }, tasks: [], agent: { tasks: [] } };
const base = [[['hubState'], hub], [['backgroundRuns'], { tasks: [], workflows: [] }]];
const SECTION_IDS = ['agent-groups', 'coding-agents'];
const sectionsIn = (html) => all(parseHtml(html)).map((node) => node.attrs['data-testid']).filter((id) => SECTION_IDS.includes(id));

test('a section whose script has not arrived is one loading line in the tab panel, and the switch around it stays as it was', async () => {
  for (const [view, lang] of [['groups', 'vi'], ['coding', 'en']]) {
    const { loaded, dispose } = await bundleSwitch();
    try {
      const { renderWith, AgentsTab, translations } = loaded;
      // one render only: a second one could find the script already evaluated
      const html = await renderWith(AgentsTab, { initialView: view }, base, [], { lang });
      const root = parseHtml(html);
      const panel = byId(root, 'agents-viewpanel');
      const statuses = byRole(panel, 'status');
      assert.equal(statuses.length, 1, `${view}: the panel holds one status line`);
      assert.equal(statuses[0].text, translations[lang].agents_section_loading, `${view}: it is the loading line, in ${lang}`);
      assert.deepEqual(sectionsIn(html), [], `${view}: nothing of the section is shown yet`);
      // what a keyboard or a screen reader relies on does not wait for the script: the opened tab is the selected one and names the panel
      assert.equal(byId(root, `agents-view-${view}`).attrs['aria-selected'], 'true');
      assert.equal(panel.attrs['aria-labelledby'], `agents-view-${view}`);
      assert.equal(byRole(root, 'tab').length, 3, 'all three tabs are there while it loads');
    } finally {
      await dispose();
    }
  }
});

test('once its script has arrived the same switch shows the section, and each tab brings its own', async () => {
  const { loaded, dispose } = await bundleSwitch();
  try {
    const { renderWith, AgentsTab, translations } = loaded;
    // the first render of a section starts its fetch ...
    assert.deepEqual(sectionsIn(await renderWith(AgentsTab, { initialView: 'groups' }, base)), []);
    assert.deepEqual(sectionsIn(await renderWith(AgentsTab, { initialView: 'coding' }, base)), []);
    await settle();
    // ... and afterwards the section is rendered in place of the line, the right one under the right tab
    const groups = await renderWith(AgentsTab, { initialView: 'groups' }, base);
    const coding = await renderWith(AgentsTab, { initialView: 'coding' }, base);
    assert.deepEqual(sectionsIn(groups), ['agent-groups']);
    assert.deepEqual(sectionsIn(coding), ['coding-agents']);
    for (const html of [groups, coding]) assert.ok(!html.includes(translations.vi.agents_section_loading), 'the loading line is gone');
  } finally {
    await dispose();
  }
});

test('bundling the app keeps the two sections out of what the first screen loads, and what the other tabs share in it', async () => {
  const { build } = createRequire(path.join(ui, 'package.json'))('esbuild');
  // a real bundler run with code splitting: what the entry file reaches by static imports loads with it, what only import() reaches is fetched later
  const result = await build({
    absWorkingDir: ui, entryPoints: ['src/App.tsx'], bundle: true, splitting: true, format: 'esm', platform: 'browser', metafile: true, write: false,
    outdir: path.join(os.tmpdir(), 'chatmcp-lazy-split-never-written'), tsconfig: path.join(ui, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const { outputs } = result.metafile;
  const firstScreen = new Set([Object.keys(outputs).find((file) => outputs[file].entryPoint)]);
  for (const file of firstScreen) {
    for (const edge of outputs[file].imports) if (edge.kind === 'import-statement' && outputs[edge.path]) firstScreen.add(edge.path);
  }
  const holds = (output, file) => (outputs[output].inputs[`src/components/inspector/${file}`]?.bytesInOutput ?? 0) > 0;
  const loadsFirst = (file) => [...firstScreen].some((output) => holds(output, file));
  const loadsLater = (file) => Object.keys(outputs).some((output) => !firstScreen.has(output) && holds(output, file));
  const sections = ['AgentGroups.tsx', 'DynamicSubagents.tsx', 'ManualGroup.tsx', 'CodingWorkers.tsx', 'CodingRunView.tsx', 'CodingWorkerCard.tsx', 'CodingReview.tsx'];
  for (const file of sections) {
    assert.ok(!loadsFirst(file), `${file} loads with the first screen`);
    assert.ok(loadsLater(file), `${file} is in no script that loads later either`);
  }
  // the Progress tab (PlanTab) and the Changes tab (GitTab) use these, so they must keep loading with the first screen
  for (const file of ['AgentsTab.tsx', 'OrchestratorTab.tsx', 'IsolatedChecksPanel.tsx', 'DiffView.tsx', 'HiddenText.tsx', 'useDelegation.ts']) {
    assert.ok(loadsFirst(file), `${file} does not load with the first screen`);
  }
});
