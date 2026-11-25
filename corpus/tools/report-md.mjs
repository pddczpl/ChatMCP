// The benchmark's report (report-model.mjs) as one Markdown file in one language (plan task P7 pod-39, corpus/REPORT.md, "Markdown"): every
// page is a part of it, with the banner at its head, and every pack is linked.
//
// As in the proof pack's report (docs/PROOF-RENDER.md), a text of the data stands in a code span, where it is no link, mention, HTML or
// emphasis whatever it holds; a text of many lines stands in a fence longer than any run of backticks in it. No raw HTML is written. Links
// lead to files of the report only: a page is a part of this file, so its name alone stands here.
import { mdCode, mdText, visible } from './render.mjs';

/** A fence that no line of `lines` can close. */
const fenceOf = (lines) => '`'.repeat(lines.reduce((longest, line) => (line.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length + 1), longest), 3));

function inline(nodes, table = false) {
  return nodes.map((node) => {
    switch (node.type) {
      case 'code': case 'word': return mdCode(node.value, { table });
      case 'chip': return inline(node.value, table);
      case 'link': return node.target.endsWith('.html') || node.target.includes('.html#') ? inline(node.value, table) : `[${inline(node.value, table)}](${node.target})`;
      case 'break': return '; ';
      default: return mdText(node.value);
    }
  }).join('');
}

const row = (cells) => `| ${cells.map((cell) => inline(cell, true)).join(' | ')} |`;

function fenced(lines) {
  const fence = fenceOf(lines);
  return [`${fence}text`, ...lines, fence];
}

function blockOf(block) {
  switch (block.type) {
    case 'table': return [row(block.head), `|${' --- |'.repeat(block.head.length)}`, ...block.rows.map(({ cells }) => row(cells))];
    case 'facts': return block.rows.map(([label, value]) => `- **${inline(label)}:** ${inline(value)}`);
    case 'list': return block.items.map((item) => `- ${inline(item)}`);
    case 'commands': return fenced(block.lines);
    case 'verbatim': return fenced(block.lines.map(visible));
    case 'verdict': return [`**${inline(block.body)}**`];
    default: return [inline(block.body)];
  }
}

/** The whole report as Markdown. */
export function renderMarkdown(report) {
  const banner = report.banner === null ? [] : [`**${inline(report.banner.title)}**`, '', ...report.banner.reasons.map((reason) => `- ${inline(reason)}`), ''];
  const blocks = (list) => list.flatMap((block) => [...blockOf(block), '']);
  const parts = report.pages.flatMap((page) => [
    `## ${inline(page.title)}`, '', ...banner, ...blocks(page.lead), ...page.sections.flatMap((section) => [`### ${inline(section.title)}`, '', ...blocks(section.blocks)]),
  ]);
  return `${[...parts, inline(report.footer)].join('\n')}\n`;
}
