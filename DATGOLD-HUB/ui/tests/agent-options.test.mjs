import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The owner's two agent options in Settings (the percent from which the history is compacted, and whether the Hub accepts the checks it ran), and the tag the objective panel draws
// on a criterion that the Hub matched itself. What is pinned here is what a person reads: the second option RELAXES "only the owner accepts", so its warning is always on the page
// next to the switch (in both languages), and a criterion the Hub accepted never looks like one the owner accepted.
const ui = fileURLToPath(new URL('../', import.meta.url));
const requireUi = createRequire(path.join(ui, 'package.json'));
const { build } = requireUi('esbuild');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-agent-options-ui-'));
try {
  const bundle = path.join(scratch, 'components.cjs');
  await build({
    stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { AgentOptionsPanel } from './src/components/settings/AgentOptionsCard';
      import { ObjectiveAcceptancePanel } from './src/components/conversation/ObjectiveAcceptancePanel';
      import { AUTO_ACCEPTED_BY, acceptedByHub, describeOptions, parsePercent } from './src/lib/agent-options';
      import { translations } from './src/lib/i18n';
      export const panel = (props, lang = 'vi') => renderToStaticMarkup(React.createElement(AgentOptionsPanel, { onPercent: () => {}, onAutoAccept: () => {}, lang, ...props }));
      export const objectives = (task) => renderToStaticMarkup(React.createElement(ObjectiveAcceptancePanel, { task, onAccepted: () => {} }));
      export { AUTO_ACCEPTED_BY, acceptedByHub, describeOptions, parsePercent, translations };
    `, resolveDir: ui, loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    tsconfig: path.join(ui, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const { panel, objectives, AUTO_ACCEPTED_BY, acceptedByHub, describeOptions, parsePercent, translations } = createRequire(import.meta.url)(bundle);

  const options = (overrides = {}) => ({ autoCompactPercent: 80, autoCompactSaved: null, autoAcceptChecks: false, defaultCompactPercent: 80, minCompactPercent: 50, maxCompactPercent: 95, ...overrides });
  const tag = (html, testId) => new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? '';
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

  test('a percent is a whole number inside the limits of the Hub, and nothing else', () => {
    for (const good of ['50', '80', '95', ' 65 ', '051']) assert.notEqual(parsePercent(good), null, `${JSON.stringify(good)} is a percent`);
    assert.deepEqual(['50', '80', '95', ' 65 '].map((value) => parsePercent(value)), [50, 80, 95, 65]);
    for (const bad of ['', ' ', '49', '96', '0', '-80', '80.5', '8e1', '0x50', '80%', 'abc', null, undefined, NaN, {}, [], '1000', '+80']) assert.equal(parsePercent(bad), null, `${JSON.stringify(bad)} is no percent`);
    assert.equal(parsePercent('60', { minCompactPercent: 60, maxCompactPercent: 90 }), 60, 'the limits are the Hub\'s');
    assert.equal(parsePercent('59', { minCompactPercent: 60, maxCompactPercent: 90 }), null);
    assert.equal(parsePercent('91', { minCompactPercent: 60, maxCompactPercent: 90 }), null);
  });

  test('the options as the page describes them: unknown until the Hub says, the default, or the owner\'s choice', () => {
    const unknown = [null, undefined, {}, { autoCompactPercent: 'x', autoAcceptChecks: true }, { autoCompactPercent: 80 }].map(describeOptions);
    for (const view of unknown) assert.deepEqual([view.known, view.statusKey, view.canReset, view.autoAccept, view.percent], [false, 'ao_percent_status_unknown', false, false, 80]);
    const byDefault = describeOptions(options());
    assert.deepEqual([byDefault.known, byDefault.percent, byDefault.statusKey, byDefault.canReset, byDefault.autoAccept, byDefault.min, byDefault.max, byDefault.defaultPercent], [true, 80, 'ao_percent_status_default', false, false, 50, 95, 80]);
    const chosen = describeOptions(options({ autoCompactPercent: 65, autoCompactSaved: 65, autoAcceptChecks: true }));
    assert.deepEqual([chosen.percent, chosen.statusKey, chosen.canReset, chosen.autoAccept], [65, 'ao_percent_status_saved', true, true]);
    // 80 chosen on purpose is a choice: the default can be asked for again, and the status says so
    assert.deepEqual([describeOptions(options({ autoCompactSaved: 80 })).statusKey, describeOptions(options({ autoCompactSaved: 80 })).canReset], ['ao_percent_status_saved', true]);
  });

  test('only the mark the Hub writes says that the Hub accepted a criterion', () => {
    assert.equal(AUTO_ACCEPTED_BY, 'auto_hub_check');
    assert.equal(acceptedByHub({ acceptedBy: 'auto_hub_check' }), true);
    for (const other of [{ acceptedBy: 'local_owner' }, { acceptedBy: 'AUTO_HUB_CHECK' }, { acceptedBy: '' }, {}, null, undefined, { acceptedBy: ['auto_hub_check'] }]) assert.equal(acceptedByHub(other), false, JSON.stringify(other));
  });

  for (const lang of ['vi', 'en']) {
    const t = (key, values = {}) => translations[lang][key].replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));

    test(`${lang}: the default state says 80 and that it is the default; the reset is not offered; the acceptance is off and its warning is on the page`, () => {
      const html = panel({ options: options() }, lang);
      assert.match(tag(html, 'agent-options-percent'), /value="80"/);
      assert.match(tag(html, 'agent-options-percent'), /min="50"/);
      assert.match(tag(html, 'agent-options-percent'), /max="95"/);
      assert.doesNotMatch(tag(html, 'agent-options-percent'), / disabled=""/);
      assert.match(tag(html, 'agent-options-percent-reset'), / disabled=""/, 'nothing chosen: nothing to reset');
      assert.match(tag(html, 'agent-options-percent-save'), / disabled=""/, 'nothing typed that differs: nothing to save');
      assert.match(text(html), new RegExp(t('ao_percent_status_default', { percent: 80 }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(tag(html, 'agent-options-percent-status'), /data-saved="false"/);
      const accept = tag(html, 'agent-options-auto-accept');
      assert.doesNotMatch(accept, /checked/);
      assert.match(tag(html, 'agent-options-auto-accept-status'), /data-on="false"/);
      assert.match(text(html), new RegExp(t('ao_accept_status_off').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      // the warning is always there, not only when the switch is on
      assert.match(html, /data-testid="agent-options-auto-accept-warning"/);
      for (const key of ['ao_accept_warning', 'ao_accept_point_what', 'ao_accept_point_keeps', 'ao_accept_point_limit', 'ao_percent_point_what', 'ao_percent_point_check', 'ao_percent_point_limit']) {
        assert.ok(text(html).includes(t(key)), `${key} is on the page`);
      }
      assert.ok(!html.includes('agent-options-running'), 'no task is running: no note about it');
      assert.ok(!html.includes('agent-options-percent-invalid'), 'nothing invalid is shown for a value the Hub gave');
    });

    test(`${lang}: the owner's choices are shown as theirs, and the reset is offered`, () => {
      const html = panel({ options: options({ autoCompactPercent: 65, autoCompactSaved: 65, autoAcceptChecks: true }), running: true }, lang);
      assert.match(tag(html, 'agent-options-percent'), /value="65"/);
      assert.doesNotMatch(tag(html, 'agent-options-percent-reset'), / disabled=""/);
      assert.match(tag(html, 'agent-options-percent-status'), /data-saved="true"/);
      assert.ok(text(html).includes(t('ao_percent_status_saved', { percent: 65 })));
      assert.ok(text(html).includes(t('ao_percent_reset', { percent: 80 })));
      assert.match(tag(html, 'agent-options-auto-accept'), /checked/);
      assert.match(tag(html, 'agent-options-auto-accept-status'), /data-on="true"/);
      assert.ok(text(html).includes(t('ao_accept_status_on')));
      assert.match(html, /data-testid="agent-options-auto-accept-warning"/, 'and the warning stays while it is on');
      assert.match(html, /data-testid="agent-options-running"/, 'a task is running: the change applies from its next model request, and the page says so');
    });

    test(`${lang}: before the Hub has said what the options are, nothing can be changed`, () => {
      const html = panel({ options: null }, lang);
      assert.match(tag(html, 'agent-options-percent'), / disabled=""/);
      assert.match(tag(html, 'agent-options-auto-accept'), / disabled=""/);
      assert.ok(text(html).includes(t('ao_percent_status_unknown')));
    });

    test(`${lang}: while a save is going, the controls are off`, () => {
      const html = panel({ options: options({ autoCompactSaved: 70, autoCompactPercent: 70 }), busy: true }, lang);
      for (const id of ['agent-options-percent', 'agent-options-percent-save', 'agent-options-percent-reset', 'agent-options-auto-accept']) assert.match(tag(html, id), / disabled=""/, id);
    });

    test(`${lang}: the warning says what is relaxed, what is not, and that a passing check proves little`, () => {
      const warning = text(panel({ options: options() }, lang));
      const words = lang === 'vi'
        ? ['nới lỏng', 'chỉ bạn chấp nhận', 'auto_hub_check', 'vẫn chỉ do bạn chấp nhận', 'thoát với mã 0', 'không chứng minh']
        : ['relaxes', 'only you accept', 'auto_hub_check', 'accepted by you alone', 'exited with 0', 'not that the command is enough'];
      for (const word of words) assert.ok(warning.includes(word), `${lang}: "${word}" is in the warning`);
    });
  }

  // ---- the objective panel ----------------------------------------------------------------------------------------------------------------------
  // The "Confirm" button of each criterion (not the one that confirms them all).
  const confirmButtons = (html) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].filter((match) => match[1] === translations.vi.agents_obj_confirm).map((match) => match[0]);
  const CHECK = 'Run required supported checks and capture real exit status evidence.';
  const task = (evidence) => ({
    id: 'task-1',
    objectiveReceipts: [{ receiptId: 'r-inspect', kind: 'inspect', step: 1, path: 'a.mjs' }, { receiptId: 'r-edit', kind: 'edit', step: 2, path: 'a.mjs' }, { receiptId: 'r-verify', kind: 'verify', step: 3 }],
    goalPlan: { objectives: [{ id: 'objective-1', text: 'Fix a.mjs', status: 'has_evidence', dependsOn: [], acceptanceCriteria: ['Observe workspace evidence for the task.', 'If code changes are required, show an edit.', CHECK], evidence }] },
  });

  test('a criterion the Hub matched itself carries a tag, a note says what it is, and the owner can still take it over', () => {
    const html = objectives(task([{ criterionIndex: 2, receiptId: 'r-verify', acceptedAt: '2026-10-28T10:00:00.000Z', acceptedBy: 'auto_hub_check' }]));
    assert.equal((html.match(/data-testid="objective-by-hub"/g) || []).length, 1, 'one criterion was accepted by the Hub: one tag');
    assert.ok(text(html).includes(translations.vi.agents_obj_by_hub));
    assert.match(html, /data-testid="objective-auto-note"/);
    assert.ok(text(html).includes(translations.vi.agents_obj_auto_note), 'the note says what the tag means');
    // the three Confirm buttons: [observe, edit] are open for the owner (nothing matched), and so is the Hub's: the owner can replace it
    const buttons = confirmButtons(html);
    assert.equal(buttons.length, 3);
    assert.deepEqual(buttons.map((button) => / disabled=""/.test(button)), [false, false, false], 'a criterion the Hub accepted can be confirmed by the owner (it replaces the Hub\'s mark)');
  });

  test('a criterion the owner accepted has no tag, no note, and cannot be confirmed again', () => {
    const html = objectives(task([{ criterionIndex: 2, receiptId: 'r-verify', acceptedAt: '2026-10-28T10:00:00.000Z', acceptedBy: 'local_owner' }]));
    assert.ok(!html.includes('objective-by-hub'), 'the owner\'s own acceptance is not tagged');
    assert.ok(!html.includes('objective-auto-note'));
    const buttons = confirmButtons(html);
    assert.deepEqual(buttons.map((button) => / disabled=""/.test(button)), [false, false, true], 'the owner\'s acceptance of the check is final here: its button is off');
    // evidence from before the field existed has no acceptedBy: it is not the Hub's either
    const older = objectives(task([{ criterionIndex: 2, receiptId: 'r-verify', acceptedAt: '2026-10-28T10:00:00.000Z' }]));
    assert.ok(!older.includes('objective-by-hub'));
  });

  test('evidence for a receipt that is no longer current is not shown as accepted by anyone', () => {
    const html = objectives(task([{ criterionIndex: 2, receiptId: 'r-gone', acceptedAt: '2026-10-28T10:00:00.000Z', acceptedBy: 'auto_hub_check' }]));
    assert.ok(!html.includes('objective-by-hub'), 'a stale match carries no tag');
    assert.ok(!html.includes('objective-auto-note'));
  });

  test('the intro no longer says that nothing is accepted before the owner confirms without the exception', () => {
    for (const lang of ['vi', 'en']) {
      const intro = translations[lang].agents_obj_intro;
      assert.ok(intro.includes(lang === 'vi' ? 'trừ các tiêu chí kiểm tra' : 'except the criteria that ask for a check'), `${lang}: the exception is in the intro`);
      assert.ok(intro.includes(lang === 'vi' ? 'Hub tự chấp nhận các check nó đã chạy' : 'The Hub accepts the checks it ran'), `${lang}: and it names the option as the Settings page does`);
      assert.ok(translations[lang].ao_accept_label === (lang === 'vi' ? 'Hub tự chấp nhận các check nó đã chạy' : 'The Hub accepts the checks it ran'));
    }
  });
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
