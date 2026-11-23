// A report (./model.mjs) as Markdown for a pull request comment (docs/PROOF-RENDER.md, "Markdown").
//
// Every text of the pack stands in a code span: there it is no link, no mention, no issue number, no HTML and no emphasis, whatever it
// holds, and a site that links mentions after it has rendered the Markdown leaves code alone. The words of the report are escaped too, so
// that a mistake in them stays a mistake in words. No raw HTML is written.
import { translate } from './i18n.mjs';
import { RenderError, cutText, formatInteger, shortId, visible } from './text.mjs';

/** The most characters (UTF-16 code units) of a report: a GitHub comment takes 65,536. */
export const MD_MAX_CHARS = 65_000;
/** The least a caller may lower it to: the parts of a report that always stay must fit, whatever texts a pack fills them with. */
export const MD_MIN_CHARS = 24_000;
/** The most characters of one text of the pack; the HTML page shows it whole. */
export const MD_TEXT_CHARS = 300;

const GLYPHS = Object.freeze({
  evidenced: '✅', owner_accepted: '👤', unverified: '❔', failed: '❌', stale: '⏳', checks_modified: '🚩', passed: '✅', repeats_short: '🔁', tree_unknown: '❔', not_run: '⚪',
  pass: '✅', warn: '❔', fail: '❌',
});
export const glyphOf = (kind) => GLYPHS[kind];

/** Words of the report: every character that could be markup has a backslash before it. */
export const mdText = (value) => value.replace(/[\\`*_{}[\]<>|#~&!]/g, '\\$&');

/**
 * A text as one code span: a fence longer than any run of backticks in it, a space at both ends where the text has a backtick or a space
 * there (a reader takes one off). In a table cell a pipe has exactly one backslash before it: readers of tables disagree on a longer run
 * (cmark-gfm pairs backslashes, markdown-it looks at one character), so a backslash right before a pipe is written as its code point.
 */
export function mdCode(value, { table = false } = {}) {
  let shown = visible(value) || ' ';
  if (table) shown = shown.replace(/\\(?=\|)/g, '⟦U+005C⟧').replaceAll('|', '\\|');
  const longest = Math.max(0, ...(shown.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^[` ]|[` ]$/.test(shown) && shown.trim() !== '' ? ' ' : '';
  return `${fence}${pad}${shown}${pad}${fence}`;
}

// ------------------------------------------------------------------------------------------------------------- nodes and blocks
class Writer {
  constructor(lang) { this.lang = lang; }

  t(key, params) { return this.inline(translate(this.lang, key, params)); }

  n(value) { return { type: 'text', value: formatInteger(value, this.lang) }; }

  inline(nodes, table = false) {
    return nodes.map((node) => {
      switch (node.type) {
        case 'code': case 'word': {
          const cut = cutText(node.value, MD_TEXT_CHARS);
          return mdCode(cut.text, { table }) + (cut.cut ? ` ${this.t('md.text_cut', { shown: this.n(MD_TEXT_CHARS), length: this.n(cut.length) })}` : '');
        }
        case 'id': return mdCode(shortId(node.value), { table });
        case 'chip': return `${GLYPHS[node.kind]} ${this.inline(node.value, table)}`;
        default: return mdText(node.value);
      }
    }).join('');
  }

  row(cells) { return `| ${cells.map((cell) => this.inline(cell, true)).join(' | ')} |`; }

  /** A block as {head, rows}: rows are whole lines that the cap may leave out from the end; a block without rows is fixed. */
  block(block) {
    switch (block.type) {
      case 'table': return { head: [this.row(block.head), `|${' --- |'.repeat(block.head.length)}`], rows: block.rows.map((row) => this.row(row)) };
      case 'list': return { head: [], rows: block.items.map((item) => `- ${this.inline(item)}`) };
      case 'facts': return { head: block.rows.map(([label, value]) => `- **${this.inline(label)}:** ${this.inline(value)}`), rows: [] };
      case 'commands': return { head: ['```text', ...block.lines, '```'], rows: [] };
      default: return { head: [this.inline(block.body)], rows: [] };
    }
  }
}

const size = (lines) => lines.reduce((sum, line) => sum + line.length + 1, 0);

/** How many rows of each block fit in `room` characters: at first no block takes more than half of what is left, then the rest is given out in order. */
function allot(blocks, room) {
  const kept = blocks.map(() => 0);
  for (const share of [2, 1]) {
    for (const [index, { rows }] of blocks.entries()) {
      let budget = Math.floor(room / share);
      while (kept[index] < rows.length && rows[kept[index]].length + 1 <= budget) {
        const cost = rows[kept[index]].length + 1;
        budget -= cost;
        room -= cost;
        kept[index] += 1;
      }
    }
  }
  return kept;
}

/**
 * {text, truncated} of a report, at most `maxChars` characters. When the whole report is longer, rows of tables and lists are left out,
 * whole lines from the end of a block, and every block that lost some says how many; the verdict, every section's own sentences and how to
 * verify always stay, and a note at the top says that the report was shortened.
 */
export function renderMarkdown(report, { maxChars = MD_MAX_CHARS } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < MD_MIN_CHARS || maxChars > MD_MAX_CHARS) throw new RenderError(`maxChars is a whole number from ${MD_MIN_CHARS} to ${MD_MAX_CHARS}`);
  const writer = new Writer(report.lang);
  const top = [`## ${writer.inline(report.title)}`, '', `**${GLYPHS[report.tone]} ${writer.inline(report.headline)}**`, ''];
  const blocks = [
    ...report.lead.map((block) => writer.block(block)),
    ...report.sections.flatMap((section) => [{ head: [`### ${writer.inline(section.title)}`], rows: [] }, ...section.blocks.map((block) => writer.block(block))]),
  ];
  const left = (n) => writer.t('md.rows_left', { n });
  /** The document with `kept` rows of each block; `dropped` rows in all are left out. */
  const compose = (kept, dropped) => {
    const lines = [...top, ...(dropped ? [writer.t('md.truncated', { n: dropped }), ''] : [])];
    for (const [index, { head, rows }] of blocks.entries()) {
      const missing = rows.length - kept[index];
      if (rows.length && !kept[index] && missing) lines.push(left(missing));
      else lines.push(...head, ...rows.slice(0, kept[index]), ...(missing ? ['', left(missing)] : []));
      lines.push('');
    }
    return lines.slice(0, -1);
  };
  const all = blocks.map(({ rows }) => rows.length);
  const whole = compose(all, 0);
  if (size(whole) <= maxChars) return { text: `${whole.join('\n')}\n`, truncated: false };
  // what is always there, with the longest form of every note (a count of fewer rows is never longer)
  const total = all.reduce((sum, n) => sum + n, 0);
  const fixed = size([...top, writer.t('md.truncated', { n: total }), '']) + blocks.reduce((sum, { head, rows }) => sum + size([...head, '', ...(rows.length ? ['', left(rows.length)] : [])]), 0);
  const kept = allot(blocks, maxChars - fixed);
  return { text: `${compose(kept, total - kept.reduce((sum, n) => sum + n, 0)).join('\n')}\n`, truncated: true };
}
