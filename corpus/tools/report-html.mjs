// The benchmark's report (report-model.mjs) as a static HTML site in one language (plan task P7 pod-39, corpus/REPORT.md, "HTML"): pages with
// their own style inline, relative links to each other and to the packs, no script, no image, nothing loaded.
//
// The policy of the proof pack's report (docs/PROOF-RENDER.md) forbids scripts and every load and names the one style by its hash. Every text
// of the data is a <code> element; no attribute holds one. A link is one of the report's own paths.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CSP, STYLE, htmlText, visible } from './render.mjs';
import { template } from './report-text.mjs';

/** The style of every page: the proof pack report's, and what a site needs more. */
export const PAGE_STYLE = `${STYLE}${template('report.css')}`;
const styleHash = createHash('sha256').update(PAGE_STYLE, 'utf8').digest('base64');
/** The policy of the proof pack's report with this style in it. */
export const PAGE_CSP = CSP.replace(/'sha256-[^']*'/, `'sha256-${styleHash}'`);
const PAGE = template('page.html').split(/\{\{([a-z]+)\}\}/);

/** A template filled in one pass: what is put in is never read for a placeholder again. */
const fill = (parts) => PAGE.map((part, index) => (index % 2 === 0 ? part : parts[part])).join('');

/** The href of `target` (a path from the report's folder) on the page `from` (the same). */
const hrefOf = (target, from) => {
  const [file, anchor] = target.split('#');
  return `${path.posix.relative(path.posix.dirname(from), file)}${anchor === undefined ? '' : `#${anchor}`}`;
};

class Writer {
  constructor(from) { this.from = from; }

  a(target, body, attributes = '') { return `<a href="${htmlText(hrefOf(target, this.from))}"${attributes}>${body}</a>`; }

  inline(nodes) {
    return nodes.map((node) => {
      switch (node.type) {
        case 'code': return `<code>${htmlText(visible(node.value) || ' ')}</code>`;
        case 'word': return `<code class="word">${htmlText(visible(node.value) || ' ')}</code>`;
        case 'chip': return `<span class="chip ${node.kind}">${this.inline(node.value)}</span>`;
        case 'link': return this.a(node.target, this.inline(node.value));
        case 'break': return '<br>';
        default: return htmlText(node.value);
      }
    }).join('');
  }

  block(block) {
    switch (block.type) {
      case 'table': return [
        '<div class="scroll">', block.head.length > 3 ? '<table class="wide">' : '<table>', '<thead>', `<tr>${block.head.map((cell) => `<th scope="col">${this.inline(cell)}</th>`).join('')}</tr>`, '</thead>', '<tbody>',
        ...block.rows.map((row) => `${row.id === null ? '<tr>' : `<tr id="${row.id}">`}${row.cells.map((cell, index) => (index ? `<td>${this.inline(cell)}</td>` : `<th scope="row">${this.inline(cell)}</th>`)).join('')}</tr>`), '</tbody>', '</table>', '</div>',
      ];
      case 'facts': return [
        '<div class="scroll">', '<table class="facts">', '<tbody>', ...block.rows.map(([label, value]) => `<tr><th scope="row">${this.inline(label)}</th><td>${this.inline(value)}</td></tr>`), '</tbody>', '</table>', '</div>',
      ];
      case 'list': return ['<ul>', ...block.items.map((item) => `<li>${this.inline(item)}</li>`), '</ul>'];
      case 'commands': return [`<pre>${block.lines.map(htmlText).join('\n')}</pre>`];
      case 'verbatim': return [`<pre class="verbatim"><code>${block.lines.map((line) => htmlText(visible(line))).join('\n')}</code></pre>`];
      case 'verdict': return [`<p class="verdict ${block.tone}">${this.inline(block.body)}</p>`];
      case 'note': return [`<p class="note">${this.inline(block.body)}</p>`];
      default: return [`<p>${this.inline(block.body)}</p>`];
    }
  }

  lines(blocks) { return blocks.flatMap((block) => this.block(block)); }
}

/** The words of nodes, without markup: for the title of a page. */
const plain = (nodes) => nodes.map((node) => htmlText(visible(node.value))).join('');

/** The pages of a report: a Map of `<lang>/<file>` to the whole page. */
export function renderHtml(report) {
  return new Map(report.pages.map((page) => {
    const from = `${report.lang}/${page.file}`;
    const writer = new Writer(from);
    const banner = report.banner === null ? [] : [
      '<aside class="banner" role="note">', `<p><strong>${writer.inline(report.banner.title)}</strong></p>`, '<ul>', ...report.banner.reasons.map((reason) => `<li>${writer.inline(reason)}</li>`), '</ul>', '</aside>',
    ];
    const links = [
      ...report.nav.map((item) => `<li>${writer.a(`${report.lang}/${item.file}`, writer.inline(item.title))}</li>`),
      `<li>${writer.a(`${report.other.lang}/${page.file}`, writer.inline(report.other.title), ` lang="${report.other.lang}" hreflang="${report.other.lang}"`)}</li>`,
    ];
    const sections = page.sections.flatMap((section) => [`<section id="${section.id}">`, `<h2>${writer.inline(section.title)}</h2>`, ...writer.lines(section.blocks), '</section>']);
    return [from, fill({
      lang: report.lang,
      csp: htmlText(PAGE_CSP),
      title: plain(page.title),
      style: PAGE_STYLE,
      banner: [...banner, ''].join('\n'),
      nav: [`<nav aria-label="${plain(report.other.label)}">`, '<ul>', ...links, '</ul>', '</nav>'].join('\n'),
      heading: writer.inline(page.title),
      lead: writer.lines(page.lead).join('\n'),
      main: sections.join('\n'),
      footer: writer.inline(report.footer),
    })];
  }));
}
