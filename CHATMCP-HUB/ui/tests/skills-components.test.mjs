import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const result = await build({
  stdin: {
    contents: `import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { SkillsTab } from './src/components/inspector/SkillsTab';
      import { useAppStore } from './src/store/useAppStore';
      export async function render({ installed = [], skills = [], updates = [], failInstalled = false }) {
        Object.assign(useAppStore.getInitialState(), { lang: 'vi' });
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
        client.setQueryData(['pluginsMarketplace', 'all', ''], { catalog: [] });
        client.setQueryData(['skillsRegistry', ''], { sources: [], skills, updates });
        if (failInstalled) await client.fetchQuery({ queryKey: ['pluginsInstalled'], queryFn: () => Promise.reject(new Error('Installed list unavailable')) }).catch(() => {});
        else client.setQueryData(['pluginsInstalled'], { plugins: installed });
        const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(SkillsTab)));
        client.clear(); return html;
      }`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  define: { 'process.env.NODE_ENV': '"production"' },
  tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { render } = compiled.exports;
const skill = { id: 'anthropic-test-skill', key: 'anthropic:skills/test-skill', name: 'Test skill', repo: 'anthropics/skills' };
const card = (html) => html.match(/<article\b[^>]*>[\s\S]*?<\/article>/)?.[0] || '';

test('registry imports show installed/disabled state with enable and uninstall instead of install', async () => {
  const html = await render({ skills: [skill], installed: [{ ...skill, enabled: false }] });
  const item = card(html);
  assert.match(item, /Đã cài · Đang tắt/);
  assert.match(item, />Bật<\/button>/);
  assert.match(item, /Gỡ cài đặt<\/button>/);
  assert.doesNotMatch(item, />Cài đặt<\/button>/);
  assert.match(html, /Đã cài \(1\)/);
});

test('enabled skill offers Disable as the action, not an ambiguous Enabled button', async () => {
  const html = await render({ skills: [skill], installed: [{ ...skill, enabled: true }] });
  assert.match(card(html), /Đã cài · Đang bật/);
  assert.match(card(html), />Tắt<\/button>/);
  assert.doesNotMatch(card(html), />Bật<\/button>/);
});

test('installed skill remains manageable without registry discovery or marketplace membership', async () => {
  const html = await render({ installed: [{ id: 'custom-guidance', name: 'My guidance', enabled: false }] });
  assert.match(card(html), /My guidance/);
  assert.match(card(html), /Gỡ cài đặt<\/button>/);
  assert.doesNotMatch(card(html), />Cài đặt<\/button>/);
});

test('new revision offers Update while retaining installed controls', async () => {
  const html = await render({ skills: [skill], installed: [{ ...skill, enabled: true }], updates: [{ ...skill, updateAvailable: true }] });
  assert.match(card(html), /Cập nhật<\/button>/);
  assert.match(card(html), /Gỡ cài đặt<\/button>/);
  assert.doesNotMatch(card(html), />Cài đặt<\/button>/);
});

test('uninstalled registry entry offers Install', async () => {
  const html = await render({ skills: [skill] });
  assert.match(card(html), /Chưa cài/);
  assert.match(card(html), /Cài đặt<\/button>/);
  assert.doesNotMatch(card(html), /Gỡ cài đặt/);
});

test('missing installed state disables install instead of inviting duplicate installation', async () => {
  const html = await render({ skills: [skill], failInstalled: true });
  assert.match(html, /role="alert"/);
  assert.match(card(html), /Chưa xác định trạng thái cài đặt/);
  assert.match(card(html), /<button[^>]*disabled=""[^>]*>[\s\S]*Cài đặt<\/button>/);
});

// The product was renamed from ChatMCP to DatGold. The built-in skills are now by "DatGold Team"; an installation made by an earlier Hub saved "ChatMCP Team" in its
// installed list, and the card must say DatGold for both. Any other author is shown as it is.
test('the author of a built-in skill reads DatGold whether the Hub that saved it wrote DatGold Team or ChatMCP Team, and any other author is shown as it is', async () => {
  const source = (html) => card(html).match(/<p class="break-words text-\[12px\] text-muted">([^<]*)<\/p>/)?.[1];
  for (const author of ['DatGold Team', 'ChatMCP Team']) {
    assert.equal(source(await render({ installed: [{ id: 'built-in', name: 'Built in', author, enabled: true }] })), 'DatGold', author);
  }
  for (const author of ['Ada Lovelace', 'DatGold Security Team', 'ChatMCP Security Team']) {
    assert.equal(source(await render({ installed: [{ id: 'other', name: 'Other', author, enabled: true }] })), author, author);
  }
  assert.equal(source(await render({ installed: [{ id: 'unknown', name: 'Unknown', author: 'unknown', enabled: true }] })), 'Kỹ năng tự thêm');
});
