import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { bundleTsx, ui } from './support/bundle.mjs';


// The line under a finished turn that says which skills the Hub took for it and on what grounds, or why it took none. The real component and the real wording,
// rendered for each state. What is pinned here is what a person reads, that it is a record of what the Hub did and not a verdict (never drawn in the colours of the
// evidence strip), and that the strings of the record, which come from skills and project files, are text and never markup.
const { loaded, dispose } = await bundleTsx(`
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { SkillSelectionNote } from './src/components/conversation/SkillSelectionNote';
  import { describeSkillSelection } from './src/lib/skill-selection';
  export const note = (task, lang = 'vi') => renderToStaticMarkup(React.createElement(SkillSelectionNote, { task, lang }));
  export { describeSkillSelection };
`, 'chatmcp-skill-selection-');
try {
  const { note, describeSkillSelection } = loaded;
  const record = (overrides = {}) => ({
    reason: 'selected', considered: 9, threshold: 3,
    selected: [{ id: 'git-workflow-pro', name: 'Git Workflow Pro', score: 18, source: 'run', why: [
      { kind: 'description', word: 'commit' }, { kind: 'description', word: 'branch', via: 'nhánh' }, { kind: 'trigger', word: 'commit' }, { kind: 'trigger', word: 'branch', via: 'nhánh' },
    ] }],
    nearest: null, project: [], concepts: [{ phrase: 'nhánh', words: ['branch'] }], ...overrides,
  });
  const none = (overrides = {}) => record({ reason: 'no_match', selected: [], concepts: [], ...overrides });
  const none_ = none;
  const plain = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
  // Everything that would make this line look like the evidence strip, or like a verdict.
  const PROOF_LOOK = /text-success|border-success|bg-success|text-danger|border-danger|bg-danger|text-warning|border-warning|bg-warning|ShieldCheck|CircleCheck|lucide-shield|lucide-circle-check|lucide-check|data-testid="proof-strip"/;

  await test('a skill that was chosen is named with the grounds: the word typed, the Vietnamese phrase it was read from, the words of its description', () => {
    const html = note({ skillSelection: record() }, 'vi');
    assert.match(html, /data-testid="skill-selection-note"/);
    assert.match(html, /data-kind="selected"/);
    assert.match(html, /Kỹ năng Hub nạp sẵn cho lượt này: 1/);
    assert.match(html, />Git Workflow Pro</);
    assert.equal((html.match(/data-testid="skill-selection-skill"/g) ?? []).length, 1, 'one line per skill');
    assert.match(html, /nhắc tới “commit”/, 'a word of the request');
    assert.match(html, /“nhánh” → branch/, 'a Vietnamese phrase and the word it counted as');
    assert.match(html, /từ trong mô tả: commit, branch/, 'the words of the description, once');
    assert.match(html, /<p class="mt-1">[^<]*không có nghĩa là model đã làm theo/, 'loaded is not followed, in the visible text');
    assert.doesNotMatch(html, PROOF_LOOK, 'never the look of the evidence strip');
    assert.match(html, /border-line/, 'it is drawn with the neutral tokens');
    assert.doesNotMatch(html, /data-testid="skill-selection-nearest"/, 'nothing is missing, so no nearest miss');
    const en = plain(note({ skillSelection: record() }, 'en'));
    assert.match(en, /Skills the Hub preloaded for this turn: 1/);
    assert.match(en, /mentions “commit”/);
    assert.match(en, /“nhánh” → branch/);
    assert.match(en, /words in its description: commit, branch/);
    assert.match(en, /does not mean the model followed it/);
    assert.doesNotMatch(en, PROOF_LOOK);
  });

  await test('the project and the earlier message are grounds too, and a skill is named once with each ground once', () => {
    const task = { skillSelection: record({
      selected: [
        { id: 'docker-devops', name: 'Docker DevOps Engine', score: 3, source: 'run', why: [{ kind: 'description', word: 'dockerfile' }, { kind: 'project', label: 'Dockerfile' }] },
        { id: 'git-workflow-pro', name: 'Git Workflow Pro', score: 8, source: 'earlier', why: [{ kind: 'trigger', word: 'commit' }, { kind: 'trigger', word: 'commit' }] },
      ],
      project: [{ id: 'docker', label: 'Dockerfile' }],
    }) };
    const html = note(task, 'vi');
    assert.equal((html.match(/data-testid="skill-selection-skill"/g) ?? []).length, 2);
    assert.match(html, /dự án có Dockerfile/);
    assert.match(html, /từ tin nhắn trước/, 'a skill carried from an earlier message says so');
    assert.equal((html.match(/nhắc tới “commit”/g) ?? []).length, 1, 'a ground that repeats is shown once');
    assert.doesNotMatch(html.slice(html.indexOf('Docker DevOps Engine'), html.indexOf('Git Workflow Pro')), /từ tin nhắn trước/, 'and only for the skill that came from it');
    const en = plain(note(task, 'en'));
    assert.match(en, /the project has Dockerfile/);
    assert.match(en, /from an earlier message/);
  });

  await test('no skill chosen: the line says so, says why, how many there were, the closest one, and what the Hub saw of the project', () => {
    const task = { skillSelection: none({ nearest: { id: 'docker-devops', name: 'Docker DevOps Engine', score: 2 }, project: [{ id: 'docker', label: 'Dockerfile' }, { id: 'react', label: 'package.json: react' }] }) };
    const html = note(task, 'vi');
    assert.match(html, /data-kind="none"/);
    assert.match(html, /Hub không nạp sẵn kỹ năng nào cho lượt này/);
    assert.match(html, /Yêu cầu không nhắc tới việc nào của 9 kỹ năng đang bật \(cần đạt 3 điểm khớp\)/);
    assert.match(html, /chỉ hiểu một số cụm tiếng Việt thường gặp, nên có thể bỏ sót/, 'and the limit of the Hub is in the visible text');
    assert.match(html, /data-testid="skill-selection-nearest"[^>]*>Gần nhất: Docker DevOps Engine \(2\/3 điểm\)/);
    assert.match(html, /data-testid="skill-selection-project"[^>]*>Hub thấy dự án có: Dockerfile · package\.json: react/);
    assert.doesNotMatch(html, /data-testid="skill-selection-skills"/, 'no list of skills');
    assert.doesNotMatch(html, PROOF_LOOK);
    const en = plain(note(task, 'en'));
    assert.match(en, /The Hub preloaded no skill for this turn/);
    assert.match(en, /does not mention anything that the 9 skills turned on are about \(a match needs 3 points\)/);
    assert.match(en, /understands only some common Vietnamese phrases, so it can miss/);
    assert.match(en, /Closest: Docker DevOps Engine \(2\/3 points\)/);
    assert.match(en, /The Hub sees a project with: Dockerfile · package\.json: react/);
  });

  await test('no skill chosen and no project recognised: it says that too; no skill turned on and no request are their own lines', () => {
    const bare = note({ skillSelection: none() }, 'vi');
    assert.match(bare, /Hub chưa nhận ra loại dự án từ các tệp ở thư mục gốc/);
    assert.doesNotMatch(bare, /data-testid="skill-selection-nearest"/);
    assert.match(plain(note({ skillSelection: none() }, 'en')), /does not recognise a kind of project from the files in the root folder/);
    const off = note({ skillSelection: none({ reason: 'no_skills', considered: 0 }) }, 'vi');
    assert.match(off, /data-kind="off"/);
    assert.match(off, /Chưa bật kỹ năng nào/);
    assert.match(off, /Bật hoặc cài kỹ năng trong phần Kỹ năng/);
    assert.doesNotMatch(off, /skill-selection-project/, 'a project is no use to the line when no skill is on');
    assert.match(plain(note({ skillSelection: none({ reason: 'no_skills', considered: 0 }) }, 'en')), /No skill is turned on/);
    const empty = note({ skillSelection: none({ reason: 'no_prompt' }) }, 'vi');
    assert.match(empty, /data-kind="empty"/);
    assert.match(empty, /Không có yêu cầu nào để chọn kỹ năng/);
    assert.match(plain(note({ skillSelection: none({ reason: 'no_prompt' }) }, 'en')), /No request to choose skills for/);
  });

  await test('nothing is drawn for a task without a record, or with one this page does not know', () => {
    for (const task of [{}, { skillSelection: null }, { skillSelection: 'selected' }, { skillSelection: {} }, { skillSelection: { reason: 'something-new', selected: [], considered: 9, threshold: 3 } },
      { skillSelection: { reason: 'selected' } }, { skillSelection: { reason: 'no_match', selected: 'all' } }, { skillSelection: { reason: 'selected', selected: [], considered: 'many' } }]) {
      assert.equal(note(task, 'vi'), '', JSON.stringify(task));
    }
    assert.equal(describeSkillSelection(null), null);
    assert.equal(describeSkillSelection(undefined, 'en'), null);
    const { threshold, ...unknownThreshold } = none();
    assert.match(note({ skillSelection: unknownThreshold }, 'vi'), /cần đạt 3 điểm khớp/, 'a record that does not say the threshold is read with the Hub\'s own, 3');
  });

  await test('what comes from skills and project files is text: names, ids, labels and words are escaped, long lists are cut', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = note({ skillSelection: record({
      selected: [{ id: hostile, name: hostile, score: 5, source: 'run', why: [{ kind: 'trigger', word: hostile, via: hostile }, { kind: 'project', label: hostile }] }],
      project: [{ id: 'x', label: hostile }],
    }) }, 'vi');
    assert.doesNotMatch(html, /<img/, 'no element from the data');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    const reasons = note({ skillSelection: record({ selected: [{ id: 'busy', name: 'Busy', score: 50, source: 'run', why: Array.from({ length: 10 }, (_, n) => ({ kind: 'trigger', word: `word${n}` })) }] }) }, 'vi');
    assert.equal((reasons.match(/nhắc tới “/g) ?? []).length, 6, 'at most 6 grounds for a skill');
    const many = note({ skillSelection: record({ selected: Array.from({ length: 30 }, (_, n) => ({ id: `s${n}`, name: `Skill ${n}`, score: 5, source: 'run', why: [] })) }) }, 'vi');
    assert.ok((many.match(/data-testid="skill-selection-skill"/g) ?? []).length <= 8, 'at most 8 skills are drawn');
    const wide = note({ skillSelection: none({ project: Array.from({ length: 30 }, (_, n) => ({ id: `k${n}`, label: `file-${n}` })) }) }, 'vi');
    assert.ok(wide.includes('file-7') && !wide.includes('file-8'), 'and at most 8 project labels');
  });

  await test('describeSkillSelection: the kind, the wording in both languages, and that vi and en are not the same text', () => {
    const view = describeSkillSelection(record(), 'vi');
    assert.deepEqual([view.kind, view.skills.length, view.skills[0].id, view.nearest, view.project], ['selected', 1, 'git-workflow-pro', null, null]);
    assert.deepEqual(describeSkillSelection(none(), 'vi').kind, 'none');
    assert.deepEqual(describeSkillSelection(none({ reason: 'no_skills' }), 'vi').kind, 'off');
    assert.deepEqual(describeSkillSelection(none({ reason: 'no_prompt' }), 'vi').kind, 'empty');
    for (const r of [record(), none(), none({ reason: 'no_skills' }), none({ reason: 'no_prompt' })]) {
      const vi = describeSkillSelection(r, 'vi');
      const en = describeSkillSelection(r, 'en');
      assert.notEqual(vi.headline, en.headline);
      assert.notEqual(vi.note, en.note);
      assert.ok(vi.headline.trim() && en.headline.trim() && vi.note.trim() && en.note.trim());
    }
  });

  await test('the model chooses too: the line says what the model itself is told, and where to see what it read', () => {
    const named = { listed: ['docker-devops', 'sqlite-explorer', 'web-researcher'], omitted: [] };
    const html = note({ skillSelection: record({ catalog: named }) }, 'vi');
    assert.match(html, /data-testid="skill-selection-catalog"[^>]*>Model còn thấy tên và mô tả của 3 kỹ năng khác đang bật và tự đọc khi cần bằng skill_load; kỹ năng nó đã đọc hiện ở dòng “Kỹ năng đã đọc theo yêu cầu”\./);
    assert.doesNotMatch(html, /không đủ chỗ để nêu tên/, 'nothing is said about skills that were not left out');
    assert.match(note({ skillSelection: record({ catalog: { listed: ['a'], omitted: ['b', 'c'] } }) }, 'vi'), /1 kỹ năng khác đang bật \(còn 2 kỹ năng nữa không đủ chỗ để nêu tên\)/, 'and what did not fit is said');
    const en = plain(note({ skillSelection: record({ catalog: named }) }, 'en'));
    assert.match(en, /The model also sees the name and description of 3 other skills that are turned on and reads one with skill_load when it needs it; the skills it read are on the line "Skills read on demand"\./);
    assert.match(plain(note({ skillSelection: record({ catalog: { listed: ['a'], omitted: ['b'] } }) }, 'en')), /\(1 more did not fit, so they are not named\)/);
    // Nothing selected by a keyword: the note says the model still sees the skills, and does not tell the person to name a tool.
    const none = note({ skillSelection: none_({ catalog: named }) }, 'vi');
    assert.match(none, /Từ khóa trong yêu cầu không khớp kỹ năng nào trong 9 kỹ năng đang bật \(cần đạt 3 điểm khớp\)\. Model vẫn thấy tên và mô tả của 3 kỹ năng và tự đọc cái cần bằng skill_load, dựa trên cuộc trò chuyện và các tệp nó đã xem/);
    assert.doesNotMatch(none, /nên có thể bỏ sót|hãy nhắc tên công cụ/, 'the limit of the keywords is not the end of the story any more');
    assert.doesNotMatch(none, /data-testid="skill-selection-catalog"/, 'the sentence is the note itself');
    assert.match(plain(note({ skillSelection: none_({ catalog: { listed: ['a', 'b'], omitted: ['c'] } }) }, 'en')), /No keyword of the request matched any of the 9 skills turned on \(a match needs 3 points\)\. The model still sees the name and description of 2 skills \(1 more did not fit, so they are not named\) and reads what it needs with skill_load/);
    // A small room names the ids alone: the page says "name", not "name and description".
    const ids = { listed: ['a', 'b', 'c'], omitted: [], form: 'names' };
    assert.match(note({ skillSelection: record({ catalog: ids }) }, 'vi'), /Model còn thấy tên của 3 kỹ năng khác đang bật/);
    assert.doesNotMatch(note({ skillSelection: record({ catalog: ids }) }, 'vi'), /tên và mô tả/);
    assert.match(note({ skillSelection: none_({ catalog: ids }) }, 'vi'), /Model vẫn thấy tên của 3 kỹ năng và tự đọc cái cần bằng skill_load/);
    assert.match(plain(note({ skillSelection: record({ catalog: ids }) }, 'en')), /The model also sees the name of 3 other skills/);
    assert.match(plain(note({ skillSelection: none_({ catalog: ids }) }, 'en')), /The model still sees the name of 3 skills and reads what it needs with skill_load/);
    assert.match(note({ skillSelection: record({ catalog: { ...ids, form: 'lines' } }) }, 'vi'), /tên và mô tả của 3 kỹ năng/, 'and the long form says both');
    // No room to name them (or an older record that has no catalog): the old note, with the limit of the keywords.
    for (const catalog of [undefined, null, 'all', { listed: [], omitted: ['a'] }, { listed: 'a' }, { listed: [1, null] }]) {
      const old = note({ skillSelection: none_({ catalog }) }, 'vi');
      assert.match(old, /nên có thể bỏ sót/, JSON.stringify(catalog));
      assert.doesNotMatch(old, /Model vẫn thấy tên/, JSON.stringify(catalog));
      assert.doesNotMatch(note({ skillSelection: record({ catalog }) }, 'vi'), /data-testid="skill-selection-catalog"/, JSON.stringify(catalog));
    }
    // No skill turned on, no request: nothing about a catalog.
    for (const reason of ['no_skills', 'no_prompt']) assert.doesNotMatch(note({ skillSelection: none_({ reason, catalog: named }) }, 'vi'), /Model (còn|vẫn) thấy/, reason);
  });

  await test('the record the Hub builds is the record this page reads: the same fields, from the real builder to the markup', async () => {
    const { buildSkillSelectionRecord, catalogRecord } = await import(pathToFileURL(path.join(ui, '..', 'lib', 'skill-selection-record.mjs')).href);
    const scored = (id, name, score, passed, why) => ({ id, name, score, passed, why });
    const made = buildSkillSelectionRecord({
      calls: [
        { reason: 'selected', considered: 9, threshold: 3, concepts: [{ phrase: 'nhánh', words: ['branch'] }], chosen: ['git-workflow-pro'],
          candidates: [scored('git-workflow-pro', 'Git Workflow Pro', 18, true, [{ kind: 'description', word: 'branch', via: 'nhánh' }, { kind: 'trigger', word: 'branch', via: 'nhánh' }, { kind: 'project', label: 'Dockerfile' }])] },
        { reason: 'selected', considered: 9, threshold: 3, concepts: [], chosen: ['docker-devops'],
          candidates: [scored('docker-devops', 'Docker DevOps Engine', 20, true, [{ kind: 'trigger', word: 'docker' }])] },
      ],
      picks: [{ id: 'git-workflow-pro', call: 0 }, { id: 'docker-devops', call: 1 }],
    }, { project: [{ id: 'docker', label: 'Dockerfile' }] });
    const html = note({ skillSelection: { ...made, catalog: catalogRecord({ listed: ['web-researcher', 'sqlite-explorer'], omitted: [] }) } }, 'vi');
    assert.match(html, /Kỹ năng Hub nạp sẵn cho lượt này: 2/);
    assert.match(html, /Model còn thấy tên và mô tả của 2 kỹ năng khác đang bật/, 'the record the Hub builds, with its catalog, is read by the page');
    assert.match(html, />Git Workflow Pro</);
    assert.match(html, />Docker DevOps Engine</);
    assert.match(html, /“nhánh” → branch/);
    assert.match(html, /dự án có Dockerfile/);
    assert.match(html, /nhắc tới “docker”/);
    assert.match(html, /Hub thấy dự án có: Dockerfile/);
    assert.equal((html.match(/từ tin nhắn trước/g) ?? []).length, 1, 'only the skill of the earlier message says so');
    const quiet = buildSkillSelectionRecord({
      calls: [{ reason: 'no_match', considered: 9, threshold: 3, concepts: [], chosen: [], candidates: [scored('docker-devops', 'Docker DevOps Engine', 2, false, [])] }], picks: [],
    }, { project: [{ id: 'react', label: 'package.json: react' }] });
    const none = note({ skillSelection: quiet }, 'vi');
    assert.match(none, /Gần nhất: Docker DevOps Engine \(2\/3 điểm\)/);
    assert.match(none, /Hub thấy dự án có: package\.json: react/);
    assert.match(none, /của 9 kỹ năng đang bật/);
    for (const [reason, kind] of [['no_skills', 'off'], ['no_prompt', 'empty']]) {
      assert.match(note({ skillSelection: buildSkillSelectionRecord({ calls: [{ reason, considered: 0, threshold: 3 }], picks: [] }) }, 'en'), new RegExp(`data-kind="${kind}"`));
    }
  });

  await test('the page draws the line under the finished turn, after the project instructions', async () => {
    const source = await fs.readFile(path.join(ui, 'src', 'components', 'conversation', 'ConversationView.tsx'), 'utf8');
    const instructions = source.indexOf('<ProjectInstructionsNote task={task} />');
    const skills = source.indexOf('<SkillSelectionNote task={task} />');
    assert.ok(instructions > 0 && skills > instructions, 'the skills line comes after the project instructions line');
    assert.match(source, /\{task && !isWorking && <SkillSelectionNote task=\{task\} \/>\}/, 'only when the turn is finished');
    assert.match(source, /import \{ SkillSelectionNote \} from '\.\/SkillSelectionNote';/);
  });
} finally {
  await dispose();
}
