import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The real components of the project-instructions switch and of the line under a turn, rendered for each state. What is pinned here is what a person reads
// and what the page must never look like: the line is a record of what the Hub did, not a proof, so it is never drawn in the colours of the evidence strip.
const ui = fileURLToPath(new URL('../', import.meta.url));
const requireUi = createRequire(path.join(ui, 'package.json'));
const { build } = requireUi('esbuild');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-project-instructions-'));
try {
  const bundle = path.join(scratch, 'components.cjs');
  await build({
    stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { ProjectInstructionsNote } from './src/components/conversation/ProjectInstructionsNote';
      import { ProjectInstructionsPanel } from './src/components/settings/ProjectInstructionsCard';
      import { translations } from './src/lib/i18n';
      export const note = (task, lang = 'vi') => renderToStaticMarkup(React.createElement(ProjectInstructionsNote, { task, lang }));
      export const panel = (props, lang = 'vi') => renderToStaticMarkup(React.createElement(ProjectInstructionsPanel, { onChange: () => {}, lang, ...props }));
      export { translations };
    `, resolveDir: ui, loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    tsconfig: path.join(ui, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const { note, panel, translations } = createRequire(import.meta.url)(bundle);

  const file = (overrides = {}) => ({ path: 'AGENTS.md', status: 'loaded', reason: null, sizeBytes: 1229, textBytes: 1229, loadedBytes: 1229, cutBytes: 0, aliasOf: null, ...overrides });
  const record = (overrides = {}) => ({ enabled: true, maxBytes: 8192, blockBytes: 3000, truncated: false, error: null, files: [file()], ...overrides });
  const setting = (overrides = {}) => ({ enabled: true, source: 'default', saved: null, variable: 'CHATMCP_PROJECT_INSTRUCTIONS', maxBytes: 8192, files: ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'], ...overrides });
  const event = (type, extra = {}) => ({ type, at: '2026-10-20T10:00:00.000Z', message: type, ...extra });
  // The <input> of the switch, as its attributes.
  const checkbox = (html) => {
    const tag = /<input[^>]*data-testid="project-instructions-toggle"[^>]*>/.exec(html)?.[0] ?? '';
    assert.ok(tag, 'the page has the switch');
    return { checked: /\bchecked=""/.test(tag), disabled: /\bdisabled=""/.test(tag), type: /type="checkbox"/.test(tag) };
  };
  // Everything that would make this line look like the evidence strip, or like a verdict.
  const PROOF_LOOK = /text-success|border-success|bg-success|text-danger|border-danger|bg-danger|text-warning|border-warning|bg-warning|ShieldCheck|CircleCheck|lucide-shield|lucide-circle-check|lucide-check|data-testid="proof-strip"/;

  // ---- the line under a turn -------------------------------------------------------------------------------------------------------------------

  await test('files that were loaded are listed with their size and what was cut, in a neutral note', () => {
    const task = { projectInstructions: record({ blockBytes: 7340, files: [file(), file({ path: 'CLAUDE.md', status: 'truncated', loadedBytes: 6900, textBytes: 9000, cutBytes: 2100 })] }) };
    const html = note(task, 'vi');
    assert.match(html, /data-testid="project-instructions-note"/);
    assert.match(html, /data-kind="files"/);
    assert.match(html, /Hướng dẫn dự án đã nạp \(7,2 KB trong giới hạn 8 KB\)/);
    assert.match(html, />AGENTS\.md · 1,2 KB</);
    assert.match(html, />CLAUDE\.md · 6,7 KB, cắt 2\.100 byte</);
    assert.equal((html.match(/data-testid="project-instructions-file"/g) ?? []).length, 2, 'one chip per file');
    assert.match(html, /<p class="mt-1">[^<]*không có nghĩa là model đã làm theo[^<]*<\/p>/, 'loaded is not followed, in the text a person reads (not only in the tooltip)');
    assert.match(html, /<p class="mt-1">[^<]*không tin cậy/, 'and the text is untrusted');
    assert.doesNotMatch(html, PROOF_LOOK, 'never the look of the evidence strip');
    assert.match(html, /border-line/, 'it is drawn with the neutral tokens');
    const en = note(task, 'en');
    assert.match(en, />CLAUDE\.md · 6\.7 KB, cut 2,100 bytes</);
    assert.match(en, /<p class="mt-1">[^<]*does not mean the model followed it[^<]*<\/p>/, 'the same words in English, in the visible text');
    assert.doesNotMatch(en, PROOF_LOOK);
  });

  await test('off says off, and says the agent can still read the files itself', () => {
    const html = note({ projectInstructions: record({ enabled: false, files: [], blockBytes: 0 }) }, 'vi');
    assert.match(html, /data-kind="off"/);
    assert.match(html, /Hướng dẫn dự án: tắt/);
    assert.match(html, /<p class="mt-1">[^<]*vẫn có thể tự mở chúng bằng công cụ đọc tệp/, 'in the visible text');
    assert.doesNotMatch(html, /data-testid="project-instructions-file"/, 'no file is listed when none was loaded');
    assert.doesNotMatch(html, PROOF_LOOK);
    assert.match(note({ projectInstructions: record({ enabled: false, files: [], blockBytes: 0 }) }, 'en'), /Project instructions: off/);
  });

  await test('a workspace that could not be read, and files that were refused, are shown without a colour of their own', () => {
    const error = note({ projectInstructions: record({ error: 'workspace_unreadable', files: [], blockBytes: 0 }) }, 'en');
    assert.match(error, /data-kind="error"/);
    assert.match(error, /could not be read/);
    assert.doesNotMatch(error, PROOF_LOOK);
    const refused = note({ projectInstructions: record({ files: [file({ status: 'skipped', reason: 'protected_path', loadedBytes: 0 })] }) }, 'en');
    assert.match(refused, />AGENTS\.md · not loaded: protected file</);
    assert.doesNotMatch(refused, PROOF_LOOK, 'a refusal is a fact, not a verdict');
  });

  await test('the skills the model read on demand in this run are listed with their size', () => {
    const task = {
      projectInstructions: record({ files: [] }),
      events: [event('instructions_loaded'), event('skill_loaded', { skillLoad: { id: 'git-helper', loadedBytes: 2300, textBytes: 2300, cutBytes: 0, truncated: false } })],
    };
    const html = note(task, 'en');
    assert.match(html, /data-testid="project-instructions-skills"/);
    assert.match(html, /Skills read on demand/);
    assert.match(html, />git-helper · 2\.2 KB</);
    assert.doesNotMatch(html, PROOF_LOOK);
    assert.doesNotMatch(note({ ...task, events: [event('skill_loaded', { skillLoad: { id: 'old', loadedBytes: 5 } }), event('instructions_loaded')] }, 'en'), /data-testid="project-instructions-skills"/, 'a skill of an earlier run is not listed');
  });

  await test('nothing is drawn for a task without a record, or for a workspace with nothing to load', () => {
    for (const task of [{}, { projectInstructions: null }, { projectInstructions: record({ files: [], blockBytes: 0 }) }]) assert.equal(note(task, 'vi'), '', JSON.stringify(task).slice(0, 80));
  });

  // ---- the switch in Settings ------------------------------------------------------------------------------------------------------------------

  await test('on by default: checked, usable, and it says it is the default', () => {
    const html = panel({ setting: setting() }, 'vi');
    assert.deepEqual(checkbox(html), { checked: true, disabled: false, type: true });
    assert.match(html, /data-testid="project-instructions-status" data-source="default"[^>]*>Đang bật \(mặc định\)\./);
    assert.match(html, /AGENTS\.md · CLAUDE\.md · \.claude\/CLAUDE\.md/, 'which files are read');
    assert.doesNotMatch(html, /data-testid="project-instructions-locked"/);
  });

  await test('a choice of the owner shows as that, off included', () => {
    const off = panel({ setting: setting({ enabled: false, source: 'config', saved: false }) }, 'vi');
    assert.deepEqual(checkbox(off), { checked: false, disabled: false, type: true });
    assert.match(off, /Đang tắt \(bạn đã chọn\)\./);
    assert.match(panel({ setting: setting({ source: 'config', saved: true }) }, 'en'), /On \(your choice\)\./);
    assert.match(panel({ setting: setting({ enabled: false, source: 'config', saved: false }) }, 'en'), /Off \(your choice\)\./);
  });

  await test('the environment variable decides: shown, named, unusable, and the saved choice is still visible', () => {
    const html = panel({ setting: setting({ enabled: false, source: 'env', saved: true }) }, 'vi');
    assert.deepEqual(checkbox(html), { checked: false, disabled: true, type: true });
    assert.match(html, /data-source="env"[^>]*>Đang tắt do biến môi trường của Hub: <code[^>]*>CHATMCP_PROJECT_INSTRUCTIONS<\/code>/);
    assert.match(html, /data-testid="project-instructions-locked"[^>]*>Không đổi được ở đây\. Bỏ biến môi trường rồi khởi động lại Hub để dùng lựa chọn của bạn\. Lựa chọn đã lưu của bạn: bật\./);
    const on = panel({ setting: setting({ enabled: true, source: 'env', saved: null }) }, 'en');
    assert.deepEqual(checkbox(on), { checked: true, disabled: true, type: true });
    assert.match(on, /On because of the Hub&#x27;s environment variable: <code/);
    assert.doesNotMatch(on, /Your saved choice/, 'nothing is said about a choice that was never made');
  });

  await test('a Hub that has not said what the setting is, a save in progress: the switch cannot be used', () => {
    assert.deepEqual(checkbox(panel({ setting: undefined })), { checked: false, disabled: true, type: true });
    assert.match(panel({ setting: undefined }, 'en'), /has not reported the state of this setting/);
    assert.deepEqual(checkbox(panel({ setting: setting(), busy: true })), { checked: true, disabled: true, type: true });
  });

  await test('a running task does not lock it; the page says when the change applies', () => {
    const running = panel({ setting: setting(), running: true }, 'vi');
    assert.deepEqual(checkbox(running), { checked: true, disabled: false, type: true }, 'the Hub accepts the change while a task runs');
    assert.match(running, /data-testid="project-instructions-running"[^>]*>Có tác vụ đang chạy: thay đổi áp dụng từ lượt chạy kế tiếp\./);
    assert.doesNotMatch(panel({ setting: setting() }, 'vi'), /project-instructions-running/, 'and says nothing when nothing runs');
    assert.doesNotMatch(panel({ setting: setting({ source: 'env' }), running: true }, 'vi'), /project-instructions-running/, 'nor where the variable decides anyway');
  });

  for (const lang of ['vi', 'en']) {
    await test(`${lang}: the explanation says plainly that the files are untrusted, capped, cannot change permissions, and that off does not stop the agent reading them`, () => {
      const html = panel({ setting: setting() }, lang).replace(/&#x27;/g, "'");
      const patterns = lang === 'vi'
        ? [/văn bản không tin cậy do người viết dự án đặt/, /tối đa 8\.192 byte \(phần dư bị cắt và được ghi rõ\)/, /không thể nâng quyền hay bỏ qua bước duyệt/,
          /Tắt chỉ có nghĩa là Hub không tự nạp; agent vẫn có thể mở các tệp này bằng công cụ đọc tệp/, /áp dụng từ lượt chạy kế tiếp; lượt đang chạy giữ nguyên những gì đã nạp/, /Chỉ kênh Model API dùng tính năng này/]
        : [/untrusted text written by whoever owns the project/, /at most 8,192 bytes \(the rest is cut, and says so\)/, /cannot raise permissions or skip an approval/,
          /Off only means the Hub does not load them itself; the agent can still open these files with its file-reading tool/, /applies from the next run; a run that is going keeps what it loaded/, /Only the Model API channel uses this/];
      for (const pattern of patterns) assert.match(html, pattern, String(pattern));
      assert.doesNotMatch(html, PROOF_LOOK, 'the card is a plain settings card');
    });
  }

  await test('every string of the card exists in both languages, is different in each, and the status keys of the switch are among them', () => {
    const keys = Object.keys(translations.vi).filter((key) => key.startsWith('pi_'));
    assert.deepEqual(Object.keys(translations.en).filter((key) => key.startsWith('pi_')).sort(), [...keys].sort(), 'the same keys in vi and en');
    assert.ok(keys.length >= 18);
    for (const key of keys) {
      assert.ok(typeof translations.vi[key] === 'string' && translations.vi[key].trim() && typeof translations.en[key] === 'string' && translations.en[key].trim(), key);
      assert.notEqual(translations.vi[key], translations.en[key], `${key} is translated`);
    }
    for (const key of ['pi_status_unknown', 'pi_status_default_on', 'pi_status_config_on', 'pi_status_config_off', 'pi_status_env_on', 'pi_status_env_off']) assert.ok(keys.includes(key), key);
  });
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
