// The fifth bridge from the corpus tools into DatGold (corpus/README.md, "Splitting out the corpus"): the pieces of the proof pack's
// renderers (DATGOLD-HUB/lib/proof/render/, plan task pod-30, docs/PROOF-RENDER.md) that the report of the benchmark is written with
// (report*.mjs, corpus/REPORT.md). A text of a run pack, a task, a registration or a response becomes a `code` or `word` node, is made
// visible and is escaped by the same code as a text of a proof pack, so the two cannot drift apart. The four files import node:crypto and
// each other only, so they are vendored together when the corpus is split out. The dictionary of i18n.mjs is not passed on: the report has
// words of its own (corpus/templates/).
export { LANGS, chip, code, text, word } from '../../DATGOLD-HUB/lib/proof/render/i18n.mjs';
export { mdCode, mdText } from '../../DATGOLD-HUB/lib/proof/render/md.mjs';
export { CSP, STYLE, htmlText } from '../../DATGOLD-HUB/lib/proof/render/html.mjs';
export { RATE_RULES, cutText, formatDecimal, formatInteger, visible } from '../../DATGOLD-HUB/lib/proof/render/text.mjs';
