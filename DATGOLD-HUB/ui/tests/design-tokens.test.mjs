import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const css = fs.readFileSync(path.join(src, 'index.css'), 'utf8');

// ----------------------------------------------------------------------------------------------------------------------
// The tokens of both themes, and the contrast between the pairs a person actually reads.
// ----------------------------------------------------------------------------------------------------------------------
function themeTokens(header) {
  const start = css.indexOf(header);
  assert.ok(start >= 0, `theme block "${header}" not found in index.css`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const tokens = {};
  for (const [, name, value] of body.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[name] = value;
  return tokens;
}
const channel = (hex, offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255;
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => 0.2126 * lin(channel(hex, 1)) + 0.7152 * lin(channel(hex, 3)) + 0.0722 * lin(channel(hex, 5));
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const themes = { dark: themeTokens(':root, [data-theme="dark"]'), light: themeTokens('[data-theme="light"]') };

for (const [name, t] of Object.entries(themes)) {
  test(`${name} theme: reading text keeps its contrast on every surface it sits on`, () => {
    for (const surface of ['bg', 'panel', 'surface', 'surface-hover']) {
      assert.ok(contrast(t.text, t[surface]) >= 10, `text on ${surface}: ${contrast(t.text, t[surface]).toFixed(2)}`);
      assert.ok(contrast(t.muted, t[surface]) >= 6, `muted on ${surface}: ${contrast(t.muted, t[surface]).toFixed(2)}`);
      assert.ok(contrast(t.faint, t[surface]) >= 4.5, `faint on ${surface}: ${contrast(t.faint, t[surface]).toFixed(2)}`);
    }
  });

  test(`${name} theme: brand, state colours and button text are readable (4.5:1) where they are used`, () => {
    for (const surface of ['bg', 'panel', 'surface']) {
      for (const color of ['primary', 'success', 'warning', 'danger']) {
        assert.ok(contrast(t[color], t[surface]) >= 4.5, `${color} on ${surface}: ${contrast(t[color], t[surface]).toFixed(2)}`);
      }
    }
    assert.ok(contrast(t['primary-foreground'], t.primary) >= 4.5, `text on a primary button: ${contrast(t['primary-foreground'], t.primary).toFixed(2)}`);
    assert.ok(contrast(t['primary-foreground'], t['primary-hover']) >= 4.5, `text on a hovered primary button: ${contrast(t['primary-foreground'], t['primary-hover']).toFixed(2)}`);
    assert.ok(contrast(t['danger-foreground'], t.danger) >= 4.5, `text on a danger button: ${contrast(t['danger-foreground'], t.danger).toFixed(2)}`);
  });

  test(`${name} theme: the focus ring and the strong border stand out from the page (3:1)`, () => {
    assert.ok(contrast(t.focus, t.panel) >= 3, `focus on panel: ${contrast(t.focus, t.panel).toFixed(2)}`);
    assert.ok(contrast(t.focus, t.bg) >= 3, `focus on bg: ${contrast(t.focus, t.bg).toFixed(2)}`);
  });
}

test('the two themes define the same tokens', () => {
  assert.deepEqual(Object.keys(themes.dark).sort(), Object.keys(themes.light).sort());
});

// ----------------------------------------------------------------------------------------------------------------------
// No colour outside the tokens: a raw palette class looks right in one theme and breaks in the other.
// ----------------------------------------------------------------------------------------------------------------------
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx|ts)$/.test(entry.name)) files.push(full);
  }
})(src);
const rel = (file) => path.relative(src, file).split(path.sep).join('/');

test('components use semantic colour tokens, never Tailwind palette classes', () => {
  const palette = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|shadow|outline|decoration|divide|accent|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
  const offenders = files.filter((file) => palette.test(fs.readFileSync(file, 'utf8'))).map(rel);
  assert.deepEqual(offenders, [], 'use text-primary / text-success / bg-danger/10 ... from src/index.css');
});

test('no hard-coded colour values in components (the preview iframe canvas is the one white)', () => {
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/.test(text.replace(/&#\d+;/g, ''))) offenders.push(rel(file));
    if (/\bbg-white\b/.test(text) && rel(file) !== 'components/inspector/PreviewTab.tsx') offenders.push(`${rel(file)} (bg-white)`);
  }
  assert.deepEqual(offenders, []);
});

test('only the two overlay variables are written as arbitrary var() utilities; everything else is a semantic utility', () => {
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, name] of text.matchAll(/(?:bg|text|border|ring|fill|stroke|outline|divide)-\[var\(--([a-z-]+)\)\]/g)) {
      if (name !== 'scrim') offenders.push(`${rel(file)}: ${name}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], []);
});

test('nothing a person has to read is set below 12px (badges and key hints at 11px are the exception)', () => {
  const offenders = [];
  for (const file of files) {
    if (rel(file) === 'components/ui/Kbd.tsx') continue;
    if (/text-\[(?:8|9|10|11)px\]/.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, []);
});

test('no motion effects that fight reduced-motion: the 3D tilt and glow classes are gone', () => {
  for (const name of ['tilt-3d', 'modal-3d-enter', 'floating-step', 'perspective-container', 'transform-style-3d']) {
    assert.ok(!css.includes(name), `${name} is still in index.css`);
    assert.deepEqual(files.filter((file) => fs.readFileSync(file, 'utf8').includes(name)).map(rel), [], name);
  }
  assert.match(css, /prefers-reduced-motion: reduce/);
});
