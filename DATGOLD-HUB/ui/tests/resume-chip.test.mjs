import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { bundleTsx, ui } from './support/bundle.mjs';

// The chip beside the model profile that says how the latest run of a conversation started (P9 ac-18): from the conversation's real history, replayed
// from the Hub's journal ('transcript'), or from the checkpoint summary when the journal could not be used ('checkpoint'). The real component and the
// real words, rendered for each case in both languages. The numbers are the Hub's (task.resume); the chip prints them, it never works them out.
const { loaded, dispose } = await bundleTsx(`
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { ResumeChip } from './src/components/conversation/ResumeChip';
  import { describeResume, formatSize } from './src/lib/resume-chip';
  export const chip = (task, lang = 'vi') => renderToStaticMarkup(React.createElement(ResumeChip, { task, lang }));
  export { describeResume, formatSize };
`, 'chatmcp-resume-chip-');
try {
  const { chip, describeResume, formatSize } = loaded;
  const transcript = (overrides = {}) => ({ resumeMode: 'transcript', resume: { mode: 'transcript', run: 2, at: '2026-11-22T10:00:00.000Z', items: 12, bytes: 3482, droppedTailItems: 2, droppedOldItems: 0, summaryUsed: false, interruptedCalls: 1, noResultCalls: 1, unverified: 1, ...overrides } });
  const checkpoint = (overrides = {}) => ({ resumeMode: 'checkpoint', resume: { mode: 'checkpoint', run: 2, at: '2026-11-22T10:00:00.000Z', reason: 'no_journal', bytes: 5120, unverified: 1, ...overrides } });
  const plain = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  await test('a conversation that did not resume draws nothing, and neither does a mode the page does not know', () => {
    assert.equal(describeResume({ resumeMode: null, resume: null }, 'vi'), null);
    assert.equal(describeResume(undefined, 'en'), null);
    assert.equal(describeResume({ resumeMode: 'rewind', resume: { mode: 'rewind' } }, 'en'), null);
    assert.equal(describeResume({ resumeMode: 'transcript', resume: null }, 'en'), null, 'a mode without its record has no numbers to show');
    assert.equal(chip({ resumeMode: null, resume: null }), '');
  });

  await test('sizes are written the way each language writes numbers', () => {
    assert.equal(formatSize(512, 'en'), '512 B');
    assert.equal(formatSize(3482, 'en'), '3.4 KB');
    assert.equal(formatSize(3482, 'vi'), '3,4 KB');
    assert.equal(formatSize(48 * 1024 * 1024, 'en'), '48 MB');
    assert.equal(formatSize(undefined, 'en'), '0 B');
  });

  await test('transcript: the mode, the items replayed and the calls with no recorded result, in both languages', () => {
    const vi = describeResume(transcript(), 'vi');
    assert.equal(vi.mode, 'transcript');
    assert.equal(vi.text, 'Tiếp tục từ lịch sử đã lưu · 12 mục · 1 lời gọi chưa có kết quả');
    assert.equal(vi.attention, true, 'a call with no recorded result asks for attention');
    assert.match(vi.title, /12 mục, 3,4 KB/);
    assert.match(vi.title, /2 mục của lượt bị ngắt/);
    assert.match(vi.title, /0 mục cũ/);
    assert.match(vi.title, /bản tóm tắt: không/);
    assert.match(vi.title, /chưa có kết quả được ghi: 1; thao tác chưa xác minh: 1/);
    const en = describeResume(transcript(), 'en');
    assert.equal(en.text, 'Resumed from the transcript · 12 items · 1 call without a result');
    assert.match(en.title, /12 items, 3\.4 KB/);
    assert.match(en.title, /2 items of an interrupted turn/);
    assert.match(en.title, /summary used: no/);
    assert.match(en.title, /no recorded result: 1; unverified operations: 1/);
    const clean = describeResume(transcript({ items: 1, droppedTailItems: 0, interruptedCalls: 0, noResultCalls: 0, unverified: 0, summaryUsed: true }), 'en');
    assert.equal(clean.text, 'Resumed from the transcript · 1 item', 'nothing missing: no third part');
    assert.equal(clean.attention, false);
    assert.match(clean.title, /summary used: yes/);
    const unverifiedOnly = describeResume(transcript({ noResultCalls: 0, unverified: 2 }), 'en');
    assert.equal(unverifiedOnly.text, 'Resumed from the transcript · 12 items');
    assert.equal(unverifiedOnly.attention, true, 'an unverified operation asks for attention too');
    assert.equal(describeResume(transcript({ noResultCalls: 3 }), 'en').text, 'Resumed from the transcript · 12 items · 3 calls without a result');
  });

  await test('checkpoint: the mode, and the reason the journal could not be used', () => {
    const vi = describeResume(checkpoint(), 'vi');
    assert.equal(vi.mode, 'checkpoint');
    assert.equal(vi.text, 'Tiếp tục từ bản tóm tắt (checkpoint)');
    assert.match(vi.title, /\(no_journal\)/);
    assert.match(vi.title, /5 KB/);
    assert.equal(vi.attention, true);
    const en = describeResume(checkpoint({ unverified: 0, reason: 'journal_gap' }), 'en');
    assert.equal(en.text, 'Resumed from the checkpoint summary');
    assert.match(en.title, /could not be used \(journal_gap\)/);
    assert.equal(en.attention, false);
  });

  await test('the component: the chip with its mode, its text and its details on hover; a reason is text, never markup', () => {
    const html = plain(chip(transcript(), 'en'));
    assert.match(html, /data-testid="resume-chip"/);
    assert.match(html, /data-mode="transcript"/);
    assert.match(html, /data-attention="true"/);
    assert.match(html, />Resumed from the transcript · 12 items · 1 call without a result</);
    assert.match(html, /title="This run started from the conversation's real history/);
    const vi = plain(chip(checkpoint({ reason: '<b>x</b>' }), 'vi'));
    assert.match(vi, /data-mode="checkpoint"/);
    assert.match(vi, />Tiếp tục từ bản tóm tắt \(checkpoint\)</);
    assert.doesNotMatch(vi, /<b>x<\/b>/, 'the reason is escaped');
  });

  await test('the conversation screen draws the chip for the selected task, beside the model profile', async () => {
    const source = await fs.readFile(path.join(ui, 'src/components/conversation/ConversationView.tsx'), 'utf8');
    assert.match(source, /import \{ ResumeChip \} from '\.\/ResumeChip';/);
    assert.match(source, /\{!!selectedTaskId && !!task && <ResumeChip task=\{task\} \/>\}/);
    assert.ok(source.indexOf('<ResumeChip') > source.indexOf('data-testid="active-model-profile"'), 'after the model profile chip');
  });
} finally {
  await dispose();
}
