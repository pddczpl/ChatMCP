import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSwitch, describeTurn, formatBytes, skillsLoadedInLatestRun } from '../src/lib/project-instructions.ts';

const setting = (overrides = {}) => ({ enabled: true, source: 'default', saved: null, variable: 'CHATMCP_PROJECT_INSTRUCTIONS', maxBytes: 8192, files: ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'], ...overrides });
const file = (overrides = {}) => ({ path: 'AGENTS.md', status: 'loaded', reason: null, sizeBytes: 1200, textBytes: 1200, loadedBytes: 1200, cutBytes: 0, aliasOf: null, ...overrides });
const record = (overrides = {}) => ({ enabled: true, maxBytes: 8192, blockBytes: 3000, truncated: false, error: null, files: [file()], ...overrides });
const event = (type, extra = {}) => ({ type, at: '2026-10-20T10:00:00.000Z', message: type, ...extra });

// ---- the switch -----------------------------------------------------------------------------------------------------------------------------

test('the switch shows what applies, who decided, and only the environment variable locks it', () => {
  const cases = [
    [setting(), { checked: true, locked: false, disabled: false, statusKey: 'pi_status_default_on', hiddenChoice: null }],
    [setting({ source: 'config', saved: true }), { checked: true, locked: false, disabled: false, statusKey: 'pi_status_config_on', hiddenChoice: null }],
    [setting({ enabled: false, source: 'config', saved: false }), { checked: false, locked: false, disabled: false, statusKey: 'pi_status_config_off', hiddenChoice: null }],
    [setting({ enabled: true, source: 'env', saved: null }), { checked: true, locked: true, disabled: true, statusKey: 'pi_status_env_on', hiddenChoice: null }],
    [setting({ enabled: false, source: 'env', saved: null }), { checked: false, locked: true, disabled: true, statusKey: 'pi_status_env_off', hiddenChoice: null }],
    // a runner given a fixed setting by its caller is not the owner's variable: a click is not refused by the Hub for that
    [setting({ enabled: false, source: 'option' }), { checked: false, locked: false, disabled: false, statusKey: 'pi_status_config_off', hiddenChoice: null }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(describeSwitch(input), expected, JSON.stringify(input));
});

test('while the variable decides, the choice the owner saved is still shown (it applies again when the variable is gone)', () => {
  assert.equal(describeSwitch(setting({ enabled: true, source: 'env', saved: false })).hiddenChoice, false);
  assert.equal(describeSwitch(setting({ enabled: false, source: 'env', saved: true })).hiddenChoice, true);
  assert.equal(describeSwitch(setting({ enabled: false, source: 'env', saved: null })).hiddenChoice, null);
  // not shown when nothing hides it
  assert.equal(describeSwitch(setting({ source: 'config', saved: false, enabled: false })).hiddenChoice, null);
});

test('a Hub that has not said what the setting is leaves the switch unusable and unchecked, never "on"', () => {
  for (const input of [undefined, null, {}, { enabled: 'yes' }, 'on']) {
    assert.deepEqual(describeSwitch(input), { checked: false, locked: false, disabled: true, statusKey: 'pi_status_unknown', hiddenChoice: null }, JSON.stringify(input));
  }
});

// ---- sizes ----------------------------------------------------------------------------------------------------------------------------------

test('sizes are short, grouped for the language, and never invented', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(842, 'en'), '842 B');
  assert.equal(formatBytes(1023, 'en'), '1023 B');
  assert.equal(formatBytes(1024, 'en'), '1 KB');
  assert.equal(formatBytes(1229, 'en'), '1.2 KB');
  assert.equal(formatBytes(1229, 'vi'), '1,2 KB');
  assert.equal(formatBytes(8192, 'vi'), '8 KB');
  assert.equal(formatBytes(10 * 1024 + 100, 'en'), '10 KB', 'from ten kilobytes up, whole numbers');
  assert.equal(formatBytes(10 * 1024 + 600, 'en'), '11 KB', 'rounded');
  for (const bad of [undefined, null, NaN, Infinity, -1, '12']) assert.equal(formatBytes(bad), '–', String(bad));
});

// ---- the line under a turn ------------------------------------------------------------------------------------------------------------------

test('a task with no record, or nothing to say, has no line', () => {
  for (const task of [undefined, null, {}, { projectInstructions: null }, { projectInstructions: 'x' }, { projectInstructions: undefined, events: [event('skill_loaded', { skillLoad: { id: 'a', loadedBytes: 5 } })] }]) {
    assert.equal(describeTurn(task, 'en'), null, JSON.stringify(task));
  }
  // loading was on and the workspace has neither file, and no skill was read
  assert.equal(describeTurn({ projectInstructions: record({ files: [], blockBytes: 0 }) }, 'en'), null);
  // a file that is empty is nothing to report either
  assert.equal(describeTurn({ projectInstructions: record({ files: [file({ status: 'skipped', reason: 'empty', loadedBytes: 0, textBytes: 0 })], blockBytes: 0 }) }, 'en'), null);
});

test('the files that were loaded: name, size, and what was cut, in the language of the page', () => {
  const task = { projectInstructions: record({ blockBytes: 7340, files: [
    file({ path: 'AGENTS.md', loadedBytes: 1229, textBytes: 1229 }),
    file({ path: 'CLAUDE.md', status: 'truncated', loadedBytes: 6900, textBytes: 9000, cutBytes: 2100 }),
  ] }) };
  const en = describeTurn(task, 'en');
  assert.equal(en.kind, 'files');
  assert.deepEqual(en.files, ['AGENTS.md · 1.2 KB', 'CLAUDE.md · 6.7 KB, cut 2,100 bytes']);
  assert.equal(en.headline, 'Project instructions loaded (7.2 KB of a 8 KB limit)', 'the size of the block and the limit it was cut to');
  const vi = describeTurn(task, 'vi');
  assert.deepEqual(vi.files, ['AGENTS.md · 1,2 KB', 'CLAUDE.md · 6,7 KB, cắt 2.100 byte']);
  assert.equal(vi.headline, 'Hướng dẫn dự án đã nạp (7,2 KB trong giới hạn 8 KB)');
});

test('a copy of an earlier file, and a file that was not loaded with the reason', () => {
  const view = describeTurn({ projectInstructions: record({ files: [
    file({ path: 'AGENTS.md' }),
    file({ path: 'CLAUDE.md', status: 'alias', aliasOf: 'AGENTS.md', loadedBytes: 0 }),
    file({ path: '.claude/CLAUDE.md', status: 'skipped', reason: 'too_large', loadedBytes: 0, textBytes: 0 }),
  ] }) }, 'en');
  assert.deepEqual(view.files, ['AGENTS.md · 1.2 KB', 'CLAUDE.md · same as AGENTS.md', '.claude/CLAUDE.md · not loaded: file too large']);
  const vi = describeTurn({ projectInstructions: record({ files: [file({ path: 'CLAUDE.md', status: 'skipped', reason: 'budget_exhausted' }), file({ path: 'AGENTS.md', status: 'alias', aliasOf: 'x.md' })] }) }, 'vi');
  assert.deepEqual(vi.files, ['CLAUDE.md · không nạp: hết chỗ trong giới hạn byte', 'AGENTS.md · giống x.md']);
});

test('every reason the Hub gives has words in both languages, and an unknown one is not echoed', () => {
  const reasons = ['budget_exhausted', 'too_large', 'binary', 'not_utf8', 'unsupported_encoding', 'outside_workspace', 'protected_path', 'not_file', 'unreadable', 'dangling_link'];
  for (const reason of reasons) {
    for (const lang of ['vi', 'en']) {
      const line = describeTurn({ projectInstructions: record({ files: [file({ status: 'skipped', reason })] }) }, lang).files[0];
      assert.ok(!line.includes('_') && !/reason unknown|lý do không rõ/.test(line), `${lang} ${reason}: ${line}`);
    }
  }
  const odd = describeTurn({ projectInstructions: record({ files: [file({ status: 'skipped', reason: '<script>alert(1)</script>' })] }) }, 'en').files[0];
  assert.equal(odd, 'AGENTS.md · not loaded: reason unknown', 'a reason this page does not know is not printed');
  assert.equal(describeTurn({ projectInstructions: record({ files: [file({ status: 'skipped', reason: 'constructor' })] }) }, 'en').files[0], 'AGENTS.md · not loaded: reason unknown', 'nor is a property of Object');
});

test('loading off, and a workspace that could not be read, each say so and never claim files were loaded', () => {
  const off = describeTurn({ projectInstructions: record({ enabled: false, files: [], blockBytes: 0 }) }, 'en');
  assert.deepEqual([off.kind, off.headline, off.files], ['off', 'Project instructions: off', []]);
  assert.match(off.note, /did not load AGENTS\.md or CLAUDE\.md for this run/);
  assert.match(off.note, /can still open them with its file-reading tool/, 'off does not mean the agent cannot read the files');
  assert.equal(describeTurn({ projectInstructions: record({ enabled: false, files: [], blockBytes: 0 }) }, 'vi').headline, 'Hướng dẫn dự án: tắt');
  const broken = describeTurn({ projectInstructions: record({ error: 'workspace_unreadable', files: [], blockBytes: 0 }) }, 'en');
  assert.deepEqual([broken.kind, broken.files], ['error', []]);
  assert.match(broken.headline, /could not be read/);
  // off wins over a stale file list
  assert.equal(describeTurn({ projectInstructions: record({ enabled: false }) }, 'en').files.length, 0);
});

test('"loaded" is never "followed" or "verified": the wording says what the Hub knows and no more', () => {
  const task = { projectInstructions: record(), events: [event('instructions_loaded'), event('skill_loaded', { skillLoad: { id: 'git-helper', loadedBytes: 2300 } })] };
  const texts = [];
  for (const lang of ['vi', 'en']) {
    for (const input of [task, { projectInstructions: record({ enabled: false }) }, { projectInstructions: record({ error: 'workspace_unreadable' }) }]) {
      const view = describeTurn(input, lang);
      texts.push(JSON.stringify(view));
      if (view.kind === 'files') {
        assert.match(view.note, lang === 'vi' ? /không có nghĩa là model đã làm theo/ : /does not mean the model followed it/, `${lang}: loaded is not followed`);
        assert.match(view.note, lang === 'vi' ? /không tin cậy/ : /[Uu]ntrusted/, `${lang}: and it is untrusted text`);
      }
    }
  }
  assert.doesNotMatch(texts.join('\n'), /xác minh|đã xác thực|chứng minh|bằng chứng|an toàn|verified|proof|evidence|safe|trusted by/i, 'no word of the evidence strip');
});

test('the skills the model read on demand: only the latest run, once each', () => {
  const receipt = (id, extra = {}) => event('skill_loaded', { skillLoad: { id, loadedBytes: 2300, textBytes: 2300, cutBytes: 0, truncated: false, forced: false, ...extra } });
  const events = [
    event('instructions_loaded'), receipt('first-run-skill'), event('assistant'),
    event('instructions_loaded'), receipt('git-helper'), event('tool_result'), receipt('docker-ops', { loadedBytes: 16384, textBytes: 20000, cutBytes: 3616, truncated: true }), receipt('git-helper', { loadedBytes: 2400, forced: true }),
  ];
  assert.deepEqual(skillsLoadedInLatestRun(events).map((entry) => [entry.id, entry.loadedBytes]), [['docker-ops', 16384], ['git-helper', 2400]], 'a skill of an earlier run is not listed; one read twice is listed once, with its last receipt');
  // The page holds the newest events only: when the event that began the run is not among them, they all belong to the latest run.
  assert.deepEqual(skillsLoadedInLatestRun([receipt('a'), event('tool_result'), receipt('b')]).map((entry) => entry.id), ['a', 'b']);
  for (const bad of [undefined, null, [], 'x', [null], [{}], [event('skill_loaded')], [event('skill_loaded', { skillLoad: {} })], [event('skill_loaded', { skillLoad: { id: 7 } })]]) assert.deepEqual(skillsLoadedInLatestRun(bad), [], JSON.stringify(bad));
  const view = describeTurn({ projectInstructions: record({ files: [] }), events }, 'en');
  assert.equal(view.kind, 'files', 'skills alone are enough for a line');
  assert.deepEqual(view.skills, ['docker-ops · 16 KB, cut 3,616 bytes', 'git-helper · 2.3 KB']);
  assert.equal(view.skillsLabel, 'Skills read on demand');
  assert.deepEqual(describeTurn({ projectInstructions: record({ files: [] }), events }, 'vi').skills, ['docker-ops · 16 KB, cắt 3.616 byte', 'git-helper · 2,3 KB']);
  // and a run that read none lists none, even though an earlier run did
  assert.deepEqual(describeTurn({ projectInstructions: record(), events: [...events, event('instructions_loaded')] }, 'en').skills, []);
});

test('the view is made from the record and changes nothing in it', () => {
  const task = Object.freeze({ projectInstructions: Object.freeze(record({ files: Object.freeze([Object.freeze(file({ status: 'truncated', cutBytes: 10 }))]) })), events: Object.freeze([Object.freeze(event('instructions_loaded'))]) });
  assert.doesNotThrow(() => describeTurn(task, 'en'));
  assert.doesNotThrow(() => skillsLoadedInLatestRun(task.events));
});
