import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CHATGPT_WEB_RISK, describeRedactions, formatCountdown, parseRedactionInput, secondsLeft } from '../src/lib/outbound-review.ts';

const result = await build({
  stdin: {
    contents: `import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { OutboundReviewCard } from './src/components/approval/OutboundReviewCard';
      import { ChatGptWebRiskNote } from './src/components/approval/ChatGptWebRiskNote';
      export const card = props => renderToStaticMarkup(React.createElement(OutboundReviewCard, props));
      export const note = props => renderToStaticMarkup(React.createElement(ChatGptWebRiskNote, props));`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'tsx',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  define: { 'process.env.NODE_ENV': '"production"' },
  tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { card, note } = compiled.exports;

const review = (extra = {}) => ({
  id: 'r-1', taskId: 't-1', turn: 4, tool: 'desktop-commander.read_file', kind: 'tool', at: '2026-10-19T10:00:00Z', expiresAt: '2099-01-01T00:00:00Z', bytes: 812,
  preview: 'CHATMCP HUB TOOL RESULT\n{"text":"key [REDACTED:aws-access-key-id] and <b>markup</b>"}', redactions: { 'aws-access-key-id': 1 }, withheld: [], manualCount: 0, ...extra,
});

test('the redaction box accepts one string per line, at least 3 characters, no duplicates, at most 20', () => {
  assert.deepEqual(parseRedactionInput('  Project Zephyr \r\nab\n\nProject Zephyr\nbudget 4M'), ['Project Zephyr', 'budget 4M']);
  assert.deepEqual(parseRedactionInput(''), []);
  assert.equal(parseRedactionInput(Array.from({ length: 40 }, (_, i) => `value-${i}`).join('\n')).length, 20);
  assert.deepEqual(parseRedactionInput('x'.repeat(201)), []);
});

test('redaction summary and countdown show labels, counts and time, nothing else', () => {
  assert.equal(describeRedactions({ 'aws-access-key-id': 1, 'env-secret': 3, jwt: 0 }), 'aws-access-key-id ×1, env-secret ×3');
  assert.equal(describeRedactions(null), '');
  const now = Date.parse('2026-10-19T10:00:00Z');
  assert.equal(secondsLeft('2026-10-19T10:01:05Z', now), 65);
  assert.equal(secondsLeft('2026-10-19T09:00:00Z', now), 0);
  assert.equal(secondsLeft(undefined, now), null);
  assert.equal(formatCountdown(65), '1:05');
  assert.equal(formatCountdown(null), '');
});

test('the review card shows the exact text, says nothing has been sent and offers the three decisions', () => {
  const html = card({ review: review(), onDecide() {} });
  assert.match(html, /data-testid="outbound-review-card"/);
  assert.match(html, /Chưa có gì được gửi/);
  assert.match(html, /desktop-commander\.read_file/);
  assert.match(html, /\[REDACTED:aws-access-key-id\]/);
  assert.match(html, /&lt;b&gt;markup&lt;\/b&gt;/, 'the preview is text, never markup');
  assert.doesNotMatch(html, /<b>markup<\/b>/);
  assert.match(html, /aria-label="Approve and send"/);
  assert.match(html, /aria-label="Withhold this result"/);
  assert.match(html, /aria-label="Redact more"/);
  assert.match(html, /Đã tự động che: aws-access-key-id ×1/);
  assert.doesNotMatch(html, /disabled=""[^>]*data-testid="outbound-review-approve"/);
});

test('an expired hold cannot be approved and says that the task stops without sending', () => {
  const html = card({ review: review({ expiresAt: '2020-01-01T00:00:00Z' }), onDecide() {} });
  assert.match(html, /Đã hết thời gian chờ/);
  assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="outbound-review-approve"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="outbound-review-withhold"/);
});

test('withheld protected files are listed by name, never by content', () => {
  const html = card({ review: review({ withheld: ['.env.production'] }), onDecide() {} });
  assert.match(html, /Không gửi nội dung file được bảo vệ: \.env\.production/);
});

test('the ChatGPT Web risk note says what the mode automates, the Terms-of-Use risk and where the content goes, in both languages', () => {
  for (const [lang, copy] of Object.entries(CHATGPT_WEB_RISK)) {
    const text = `${copy.title} ${copy.summary} ${copy.points.join(' ')}`;
    assert.match(text, /chatgpt\.com/, `${lang}: names the consumer page`);
    assert.match(text, lang === 'en' ? /Terms of Use/ : /Điều khoản sử dụng của OpenAI/, `${lang}: Terms of Use`);
    assert.match(text, lang === 'en' ? /suspension/ : /đình chỉ/, `${lang}: suspension risk`);
    assert.match(text, lang === 'en' ? /ChatGPT history/ : /lịch sử ChatGPT/, `${lang}: content goes into the chat history`);
    assert.match(text, lang === 'en' ? /best effort/ : /nỗ lực tối đa/, `${lang}: the masking is best effort`);
    assert.doesNotMatch(text, /\b(official(?:ly)?|sanctioned|certified|guaranteed)\b/i, `${lang}: no claim of approval`);
  }
  const html = note({ testId: 'chatgpt-web-risk-note' });
  assert.match(html, /data-testid="chatgpt-web-risk-note"/);
  assert.match(html, /Điều khoản sử dụng của OpenAI/);
  const compact = note({ testId: 'chatgpt-web-task-risk-note', compact: true });
  assert.match(compact, /<details>/, 'the task view keeps the list one click away');
  assert.match(compact, /Điều khoản sử dụng của OpenAI/, 'but the summary with the risk is always visible');
});
