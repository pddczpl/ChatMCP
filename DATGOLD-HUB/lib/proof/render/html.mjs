// A report (./model.mjs) as one HTML file (docs/PROOF-RENDER.md, "HTML"): its own style inline, no script, no link, no image, nothing loaded.
//
// The policy in the page forbids scripts and every load and names the one style by its hash, so markup that got in by a mistake could do
// nothing; the escaping below is what keeps it out. Every text of the pack is a <code> element; the only attributes that hold anything of a
// pack are `title`s of whole tree ids and digests (hex by the schema).
import { createHash } from 'node:crypto';
import { glyphOf } from './md.mjs';
import { shortId, visible } from './text.mjs';

/** The style of the page; the policy names it by its sha256. */
export const STYLE = `
:root { color-scheme: light dark; --page: #ffffff; --ink: #1c1e21; --soft: #5a6068; --line: #d5d9de; --band: #f4f6f8; --code: #eef1f4; --pass: #12683a; --warn: #8a5a00; --fail: #a8201a; }
@media (prefers-color-scheme: dark) { :root { --page: #16181b; --ink: #e8eaed; --soft: #a3abb5; --line: #363b42; --band: #1f2327; --code: #262b31; --pass: #6fd39b; --warn: #e7b655; --fail: #ff8f86; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 72rem; padding: 1.5rem 1rem 3rem; background: var(--page); color: var(--ink); font: 1rem/1.55 "Segoe UI", "Noto Sans", Roboto, "Helvetica Neue", Arial, sans-serif; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 0.75rem; }
h2 { font-size: 1.2rem; line-height: 1.3; margin: 2rem 0 0.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--line); }
p, ul { margin: 0.5rem 0; }
ul { padding-left: 1.25rem; }
.verdict { margin: 0 0 1rem; padding: 0.75rem 1rem; border: 1px solid currentColor; border-left-width: 0.4rem; border-radius: 0.25rem; font-size: 1.15rem; font-weight: 600; }
.verdict.pass { color: var(--pass); }
.verdict.warn { color: var(--warn); }
.verdict.fail { color: var(--fail); }
.note { color: var(--soft); }
.scroll { overflow-x: auto; margin: 0.5rem 0 1rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
.wide { min-width: 44rem; }
th, td { padding: 0.35rem 0.6rem; border: 1px solid var(--line); text-align: left; vertical-align: top; }
thead th { background: var(--band); }
.facts th { width: 30%; background: var(--band); font-weight: 600; }
code, pre { font: 0.9em/1.45 Consolas, "Cascadia Mono", "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace; }
code { padding: 0.05rem 0.25rem; border-radius: 0.2rem; background: var(--code); white-space: pre-wrap; overflow-wrap: anywhere; direction: ltr; unicode-bidi: isolate; }
code.word { white-space: nowrap; }
pre { overflow-x: auto; padding: 0.75rem 1rem; border-radius: 0.25rem; background: var(--code); }
.chip { display: inline-block; padding: 0 0.5rem; border: 1px solid currentColor; border-radius: 1rem; font-size: 0.85rem; font-weight: 600; white-space: nowrap; }
.chip.evidenced, .chip.owner_accepted, .chip.passed { color: var(--pass); }
.chip.failed, .chip.checks_modified { color: var(--fail); }
.chip.unverified, .chip.stale, .chip.repeats_short, .chip.tree_unknown, .chip.not_run { color: var(--warn); }
@media print {
  :root { color-scheme: light; --page: #ffffff; --ink: #000000; --soft: #333333; --line: #999999; --band: #f2f2f2; --code: #f2f2f2; --pass: #0b4f2a; --warn: #6b4500; --fail: #8a1510; }
  body { max-width: none; padding: 0; font-size: 10pt; }
  h2 { break-after: avoid; }
  tr, .verdict { break-inside: avoid; }
  thead { display: table-header-group; }
  .scroll, pre { overflow: visible; }
  .wide { min-width: 0; }
  pre { white-space: pre-wrap; }
}
`;

const styleHash = createHash('sha256').update(STYLE, 'utf8').digest('base64');
/** The policy of the page: no script, no load of any kind, one style named by its hash. */
export const CSP = [
  "default-src 'none'", "script-src 'none'", `style-src 'sha256-${styleHash}'`, "img-src 'none'", "font-src 'none'", "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const ENTITIES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
/** A text for HTML, in an element or in a quoted attribute. */
export const htmlText = (value) => value.replace(/[&<>"']/g, (char) => ENTITIES[char]);

function inline(nodes) {
  return nodes.map((node) => {
    switch (node.type) {
      case 'code': return `<code>${htmlText(visible(node.value) || ' ')}</code>`;
      case 'word': return `<code class="word">${htmlText(visible(node.value))}</code>`;
      case 'id': return `<code class="word" title="${htmlText(visible(node.value))}">${htmlText(visible(shortId(node.value)))}</code>`;
      case 'chip': return `<span class="chip ${node.kind}">${glyphOf(node.kind)} ${inline(node.value)}</span>`;
      default: return htmlText(node.value);
    }
  }).join('');
}

function blockOf(block) {
  switch (block.type) {
    case 'table': return [
      '<div class="scroll">', block.head.length > 3 ? '<table class="wide">' : '<table>', '<thead>', `<tr>${block.head.map((cell) => `<th scope="col">${inline(cell)}</th>`).join('')}</tr>`, '</thead>', '<tbody>',
      ...block.rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`), '</tbody>', '</table>', '</div>',
    ];
    case 'facts': return [
      '<div class="scroll">', '<table class="facts">', '<tbody>', ...block.rows.map(([label, value]) => `<tr><th scope="row">${inline(label)}</th><td>${inline(value)}</td></tr>`), '</tbody>', '</table>', '</div>',
    ];
    case 'list': return ['<ul>', ...block.items.map((item) => `<li>${inline(item)}</li>`), '</ul>'];
    case 'commands': return [`<pre>${block.lines.map(htmlText).join('\n')}</pre>`];
    case 'note': return [`<p class="note">${inline(block.body)}</p>`];
    default: return [`<p>${inline(block.body)}</p>`];
  }
}

/** {text} of a report: the whole page. */
export function renderHtml(report) {
  const lines = [
    '<!doctype html>', `<html lang="${report.lang}">`, '<head>', '<meta charset="utf-8">', `<meta http-equiv="Content-Security-Policy" content="${htmlText(CSP)}">`,
    '<meta name="referrer" content="no-referrer">', '<meta name="viewport" content="width=device-width, initial-scale=1">', `<title>${inline(report.title)}</title>`, `<style>${STYLE}</style>`, '</head>', '<body>',
    '<header>', `<h1>${inline(report.title)}</h1>`, `<p class="verdict ${report.tone}">${glyphOf(report.tone)} ${inline(report.headline)}</p>`, ...report.lead.flatMap(blockOf), '</header>', '<main>',
    ...report.sections.flatMap((section) => [`<section id="${section.id}">`, `<h2>${inline(section.title)}</h2>`, ...section.blocks.flatMap(blockOf), '</section>']),
    '</main>', '</body>', '</html>',
  ];
  return { text: `${lines.join('\n')}\n` };
}
