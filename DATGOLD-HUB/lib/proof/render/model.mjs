// A proof pack as a report (plan task pod-30, docs/PROOF-RENDER.md): what is said, in which order, in which language, as data. ./md.mjs and
// ./html.mjs write it; neither of them reads a pack.
//
// Three rules. A section whose data the pack does not hold says so: it never shows an empty table, which would read as "none happened". A
// text of the pack or of the caller is a `code` node (./i18n.mjs), never a word of the report, so a renderer cannot take it for markup. And
// a text read from a file of the pack (the criteria, the paths of the patch) is masked as the statement's own texts are: a report is posted.
import { maskSecrets } from '../../permissions.mjs';
import { AcceptanceError, parseAcceptance } from '../acceptance.mjs';
import { sha256Hex } from '../ledger.mjs';
import { AGENT_CHANGE_SCHEMA, SUBJECT_NAMES, statementDigest, validateStatement } from '../pack.mjs';
import { diffStat } from './diffstat.mjs';
import { LANGS, chip, code, id, text, translate, word } from './i18n.mjs';
import { RenderError, formatDecimal, formatDuration, formatInteger, readRate, vndOf } from './text.mjs';

export { RenderError } from './text.mjs';

/** The verdicts, and how each one is shown. */
const TONES = Object.freeze({ evidenced: 'pass', accepted: 'pass', failed: 'fail', checks_modified: 'fail', not_evidenced: 'warn', no_criteria: 'warn' });
export const VERDICTS = Object.freeze(Object.keys(TONES));
const OPTIONS = new Set(['lang', 'packName', 'vnd']);
// A name that can be pasted into a command line of any shell as it is.
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_LOCKFILES = AGENT_CHANGE_SCHEMA.$defs.predicate.properties.lockfiles.maxItems;

// ------------------------------------------------------------------------------------------------------------- blocks
const para = (...body) => ({ type: 'para', body: body.flat() });
const note = (...body) => ({ type: 'note', body: body.flat() });
const facts = (rows) => ({ type: 'facts', rows });
const table = (head, rows) => ({ type: 'table', head, rows });
const list = (items) => ({ type: 'list', items });

// ------------------------------------------------------------------------------------------------------------- reading the source
/** The texts and the manual parts of the criteria by id, from the acceptance file of the pack; null when there is none or it does not read. */
function readTexts(bytes) {
  if (!bytes) return null;
  try { return new Map(parseAcceptance(bytes).criteria.map((criterion) => [criterion.id, criterion])); } catch (error) {
    if (error instanceof AcceptanceError) return null;
    throw error;
  }
}

/** The source, checked: the statement validates, and a file given with it is the one the statement names. */
function readSource(source) {
  if (source === null || typeof source !== 'object' || source.statement === undefined) throw new RenderError('the source is {statement, files, entries, packChecked}');
  const checked = validateStatement(source.statement);
  if (!checked.valid) throw new RenderError(`the statement does not validate: ${checked.errors[0].path || '/'} ${checked.errors[0].message}`);
  const { statement, entries = null } = source;
  const packChecked = source.packChecked === true;
  const { predicate } = statement;
  const subject = (name) => statement.subject.find((item) => item.name === name)?.digest ?? null;
  const wanted = { 'change.diff': subject(SUBJECT_NAMES.diff).sha256, 'acceptance.yml': predicate.acceptance.baselineSha256 };
  const files = {};
  for (const [name, sha256] of Object.entries(wanted)) {
    const bytes = source.files?.[name];
    if (bytes === undefined) continue;
    if (!(bytes instanceof Uint8Array) || sha256Hex(bytes) !== sha256) throw new RenderError(`files[${JSON.stringify(name)}] is not the file the statement names`);
    files[name] = bytes;
  }
  if (packChecked && !(files['change.diff'] && Array.isArray(entries))) throw new RenderError('a pack that was checked comes with its files and its ledger entries');
  return {
    statement, predicate, files, entries: Array.isArray(entries) ? entries : [], packChecked, digest: statementDigest(statement),
    before: subject(SUBJECT_NAMES.before).gitTree, after: subject(SUBJECT_NAMES.after).gitTree, patch: wanted['change.diff'], commit: subject(SUBJECT_NAMES.commit)?.gitCommit ?? null,
  };
}

function readOptions(options) {
  const unknown = Object.keys(options).find((name) => !OPTIONS.has(name));
  if (unknown) throw new RenderError(`${unknown} is not an option of a report`);
  const { lang, packName = null, vnd = null } = options;
  if (!LANGS.includes(lang)) throw new RenderError(`lang is ${LANGS.join(' or ')}`);
  if (packName !== null && typeof packName !== 'string') throw new RenderError('packName is the name of the pack file');
  return { lang, packName: packName !== null && PLAIN_NAME.test(packName) ? packName : null, vnd: readRate(vnd) };
}

// ------------------------------------------------------------------------------------------------------------- the verdict
/** The verdict that follows from the statuses of the criteria, worst first. */
function verdictOf(criteria) {
  const count = (status) => criteria.filter((criterion) => criterion.status === status).length;
  const counts = { total: criteria.length, evidenced: count('evidenced'), accepted: count('owner_accepted'), failed: count('failed'), modified: count('checks_modified') };
  counts.open = counts.total - counts.evidenced - counts.accepted;
  let kind = 'not_evidenced';
  if (counts.total === 0) kind = 'no_criteria';
  else if (counts.failed > 0) kind = 'failed';
  else if (counts.modified > 0) kind = 'checks_modified';
  else if (counts.open === 0) kind = counts.accepted > 0 ? 'accepted' : 'evidenced';
  return { kind, counts };
}

// ------------------------------------------------------------------------------------------------------------- the sections
class Builder {
  constructor(source, options) {
    Object.assign(this, source, options);
    this.texts = readTexts(this.files['acceptance.yml']);
  }

  /** The words of `key`. */
  t(key, params) { return translate(this.lang, key, params); }

  n(value) { return [text(formatInteger(value, this.lang))]; }

  orNot(value) { return value === null ? this.t('not_recorded') : [code(value)]; }

  statusChip(status) { return chip(status, this.t(`status.${status}`)); }

  head(...keys) { return keys.map((key) => this.t(`col.${key}`)); }

  /** A sentence where the ledger is missing or broken, for a section that reads it. */
  ledgerNote() {
    const { ledger } = this.predicate;
    if (!ledger.present) return note(this.t('ledger.absent'));
    return ledger.verified ? null : note(this.t('ledger.prefix'));
  }

  subject() {
    const { agent, model, baseCommit, trees, acceptance } = this.predicate;
    const tree = (side, value) => this.t('subject.tree', {
      tree: code(value), algorithm: code(trees[side].treeAlgorithm), format: code(trees[side].objectFormat), files: trees[side].files, bytes: trees[side].bytes,
    });
    let trust = this.t('subject.no_acceptance');
    if (acceptance.baselineSha256 !== null) trust = this.t(acceptance.trusted ? 'subject.trusted' : 'subject.untrusted', { sha: code(acceptance.baselineSha256) });
    const rows = [
      ['agent', this.t('subject.version', { name: code(agent.name), version: code(agent.version) })],
      ['model', [...this.orNot(model.provider), text(' / '), ...this.orNot(model.id)]],
      ['profile', this.orNot(model.profileRevision)],
      ['base', this.orNot(baseCommit)],
      ...(this.commit === null ? [] : [['commit', [code(this.commit)]]]),
      ['before', tree('before', this.before)],
      ['after', tree('after', this.after)],
      ['patch', [code(this.patch)]],
      ['digest', [code(this.digest)]],
      ['acceptance', trust],
    ];
    return [facts(rows.map(([label, value]) => [this.t(`label.${label}`), value]))];
  }

  criteria() {
    const { criteria } = this.predicate;
    if (!criteria.length) return [note(this.t('criteria.none'))];
    const blocks = [];
    const rows = criteria.map((criterion) => {
      const known = this.texts?.get(criterion.id);
      const passed = criterion.checks.filter((check) => check.result === 'passed').length;
      return [
        [word(criterion.id)], [this.statusChip(criterion.status)], ...(this.texts ? [known ? [code(maskSecrets(known.text))] : this.t('not_recorded')] : []),
        [text(criterion.checks.length ? `${formatInteger(passed, this.lang)}/${formatInteger(criterion.checks.length, this.lang)}` : '–')],
      ];
    });
    blocks.push(table(this.head('criterion', 'status', ...(this.texts ? ['text'] : []), 'passed'), rows));
    if (!this.texts) blocks.push(note(this.t('criteria.no_texts')));
    const checks = criteria.flatMap((criterion) => criterion.checks.map((check) => [
      [word(criterion.id)], this.n(check.index + 1), [code(check.run)], [code(check.cwd)], [code(check.expectExit)],
      [text(`${formatInteger(check.passes, this.lang)}/${formatInteger(check.repeat, this.lang)}`)], [chip(check.result, this.t(`result.${check.result}`))],
      [text(check.receipts.length ? check.receipts.map((seq) => String(seq)).join(', ') : '–')],
    ]));
    if (checks.length) blocks.push(para(this.t('criteria.checks')), table(this.head('criterion', 'check', 'command', 'folder', 'expected', 'runs', 'result', 'receipts'), checks));
    const look = [];
    for (const criterion of criteria) {
      const manual = this.texts?.get(criterion.id)?.manual;
      if (manual?.inspect.length) look.push(this.t('criteria.look', { criterion: word(criterion.id), paths: manual.inspect.flatMap((path, index) => [...(index ? [text(', ')] : []), code(maskSecrets(path))]) }));
      if (manual?.note) look.push(this.t('criteria.note', { criterion: word(criterion.id), note: code(maskSecrets(manual.note)) }));
    }
    if (look.length) blocks.push(list(look));
    // the findings of checks_modified are in their own section
    const reasons = criteria.flatMap((criterion) => {
      const seen = new Set();
      return criterion.reasons.filter((reason) => reason.code !== 'checks_modified' || (!seen.has(reason.code) && seen.add(reason.code))).map((reason) => [
        [word(criterion.id)], reason.check === null ? [text('–')] : this.n(reason.check + 1), this.t(`reason.${reason.code}`),
        reason.detail === null || reason.code === 'checks_modified' ? [text('–')] : [code(reason.detail)],
      ]);
    });
    if (reasons.length) blocks.push(para(this.t('criteria.reasons')), table(this.head('criterion', 'check', 'reason', 'detail'), reasons));
    const omitted = criteria.filter((criterion) => criterion.omittedReasons > 0);
    if (omitted.length) blocks.push(list(omitted.map((criterion) => this.t('criteria.omitted', { criterion: word(criterion.id), n: criterion.omittedReasons }))));
    return blocks;
  }

  outcome(receipt) {
    if (receipt.timedOut) return this.t('outcome.timed_out');
    if (receipt.cancelled) return this.t('outcome.cancelled');
    if (receipt.signal !== null) return this.t('outcome.signal', { signal: code(receipt.signal) });
    return receipt.exit === null ? this.t('outcome.unknown') : this.t('outcome.exit', { exit: code(receipt.exit) });
  }

  receiptTree({ treeBefore: before, treeAfter: after }) {
    if (before === null || before.tree === null) return this.t('tree.none');
    const { treeAlgorithm, objectFormat } = this.predicate.trees.after;
    const comparable = before.treeAlgorithm === treeAlgorithm && before.objectFormat === objectFormat;
    const which = before.tree === this.after ? 'tree.final' : 'tree.other';
    const nodes = this.t(comparable ? which : 'tree.unknown', { tree: id(before.tree) });
    if (after === null || after.tree === null) return [...nodes, text('; '), ...this.t('tree.after_none')];
    const same = after.tree === before.tree && after.treeAlgorithm === before.treeAlgorithm && after.objectFormat === before.objectFormat;
    return same ? nodes : [...nodes, text('; '), ...this.t('tree.changed', { tree: id(after.tree) })];
  }

  receipts() {
    const { receipts, ledger, criteria } = this.predicate;
    const about = this.ledgerNote();
    if (!ledger.present) return [about];
    const blocks = about ? [about] : [];
    if (!receipts.length && !ledger.omittedReceipts) blocks.push(note(this.t('receipts.none')));
    const usedBy = new Map();
    for (const criterion of criteria) {
      for (const check of criterion.checks) for (const seq of check.receipts) usedBy.set(seq, [...(usedBy.get(seq) ?? []), [criterion.id, check.index + 1]]);
    }
    if (receipts.length) {
      blocks.push(table(this.head('receipt', 'command', 'outcome', 'tree', 'duration', 'time', 'used'), receipts.map((receipt) => {
        const place = this.t(receipt.cwd === '.' ? 'receipts.place_root' : 'receipts.place', { command: code(receipt.command), folder: code(receipt.cwd), shell: code(receipt.shell) });
        const used = (usedBy.get(receipt.seq) ?? []).flatMap(([criterion, check], index) => [...(index ? [text(', ')] : []), word(criterion), text(` (${check})`)]);
        return [
          [text(String(receipt.seq))], receipt.commandTruncated ? [...place, text(' '), ...this.t('receipts.command_cut')] : place, this.outcome(receipt), this.receiptTree(receipt),
          [text(formatDuration(receipt.durationMs, this.lang))], [word(receipt.ts)], used.length ? used : [text('–')],
        ];
      })), note(this.t('receipts.outputs')));
    }
    if (ledger.omittedReceipts) blocks.push(note(this.t('receipts.omitted', { n: ledger.omittedReceipts })));
    return blocks;
  }

  diff() {
    const patch = this.files['change.diff'];
    if (!patch) return [note(this.t('diff.absent'))];
    if (!patch.length) return [note(this.t('diff.empty'))];
    const stat = diffStat(patch);
    if (stat === null) return [note(this.t('diff.unreadable', { bytes: patch.length }))];
    const blocks = [
      para(this.t('diff.total', { files: stat.total, added: stat.added, removed: stat.removed, binary: stat.binary })),
      table(this.head('path', 'change', 'added', 'removed'), stat.files.map((file) => [
        [code(maskSecrets(file.path))], this.t(`change.${file.change}`), file.binary ? this.t('diff.binary') : this.n(file.added), file.binary ? this.t('diff.binary') : this.n(file.removed),
      ])),
    ];
    if (stat.total > stat.files.length) blocks.push(note(this.t('diff.more', { n: stat.total - stat.files.length })));
    return blocks;
  }

  tamper() {
    const { checkChanges, acceptance, criteria, lockfiles } = this.predicate;
    const blocks = [];
    const flagged = criteria.filter((criterion) => criterion.reasons.some((reason) => reason.code === 'checks_modified'));
    if (!checkChanges.reported) blocks.push(note(this.t('tamper.absent')));
    else if (flagged.length) {
      blocks.push(para(this.t('tamper.modified', { n: flagged.length })), table(this.head('criterion', 'finding'), flagged.flatMap((criterion) => criterion.reasons
        .filter((reason) => reason.code === 'checks_modified').map((reason) => [[word(criterion.id)], this.orNot(reason.detail)]))));
    } else blocks.push(para(this.t(checkChanges.checksModified ? 'tamper.modified_elsewhere' : 'tamper.clean')));
    if (acceptance.baselineSha256 === null) blocks.push(note(this.t('tamper.no_acceptance')));
    else blocks.push(para(this.t(acceptance.edited ? 'tamper.edited' : 'tamper.not_edited')));
    if (!checkChanges.reported) return blocks;
    const changed = lockfiles.filter((file) => file.status !== 'unchanged');
    const sha = (value) => (value === null ? [text('–')] : [id(value)]);
    if (changed.length) {
      blocks.push(para(this.t('tamper.lockfiles')), table(this.head('path', 'change', 'before', 'after'), changed.map((file) => [[code(file.path)], this.t(`lockfile.${file.status}`), sha(file.sha256Before), sha(file.sha256After)])));
      if (changed.length < lockfiles.length) blocks.push(note(this.t('tamper.lockfiles_same', { n: lockfiles.length - changed.length })));
    } else blocks.push(para(this.t('tamper.lockfiles_none', { n: lockfiles.length })));
    if (lockfiles.length === MAX_LOCKFILES) blocks.push(note(this.t('tamper.lockfiles_cut', { n: MAX_LOCKFILES })));
    return blocks;
  }

  permissions() {
    const { permissions, ledger } = this.predicate;
    const about = this.ledgerNote();
    if (!ledger.present) return [about];
    const blocks = about ? [about] : [];
    if (!permissions.records) return [...blocks, note(this.t('permissions.absent'))];
    const { records, ...decisions } = permissions;
    const rows = Object.keys(AGENT_CHANGE_SCHEMA.$defs.predicate.properties.permissions.properties).filter((name) => name !== 'records' && decisions[name] > 0);
    return [...blocks, para(this.t('permissions.total', { n: records })), table(this.head('decision', 'count'), rows.map((name) => [this.t(`permission.${name}`), this.n(decisions[name])]))];
  }

  uncertain() {
    const { uncertain, ledger } = this.predicate;
    const about = this.ledgerNote();
    if (!ledger.present) return [about];
    const blocks = about ? [about] : [];
    if (!uncertain.length && !ledger.omittedUncertain) return [...blocks, note(this.t('uncertain.none'))];
    if (uncertain.length) blocks.push(table(this.head('record', 'reason'), uncertain.map((event) => [[text(String(event.seq))], [code(event.reason)]])));
    if (ledger.omittedUncertain) blocks.push(note(this.t('uncertain.omitted', { n: ledger.omittedUncertain })));
    return blocks;
  }

  egress() {
    const outbound = this.entries.filter((entry) => entry.type === 'outbound').length;
    return [note(this.t('egress.absent')), ...(outbound ? [note(this.t('egress.unread', { n: outbound }))] : [])];
  }

  cost() {
    const { cost } = this.predicate;
    const blocks = [];
    if (cost === 'unknown') blocks.push(note(this.t('cost.unknown')));
    else {
      blocks.push(para(this.t(cost.complete ? 'cost.complete' : 'cost.incomplete', { amount: text(`${formatDecimal(cost.knownSubtotal, this.lang)} ${cost.currency}`) })));
      if (this.vnd === null) blocks.push(note(this.t('cost.no_rate')));
      else if (cost.currency !== 'USD') blocks.push(note(this.t('cost.not_usd')));
      else {
        const amount = vndOf(cost.knownSubtotal, this.vnd.rate, this.lang);
        const rate = { rate: text(formatDecimal(this.vnd.rate, this.lang)), date: text(this.vnd.date), source: code(this.vnd.source) };
        blocks.push(para(amount === null ? this.t('cost.vnd_small', rate) : this.t('cost.vnd', { ...rate, amount: text(amount) })));
      }
    }
    blocks.push(note(this.t('cost.per_criterion')));
    return blocks;
  }

  integrity() {
    const { integrity, ledger, limitations, trees, excludedPaths } = this.predicate;
    let chain = this.t('ledger.absent');
    if (ledger.present && ledger.verified) chain = this.t('ledger.whole', { records: ledger.records, hash: code(ledger.lastHash) });
    else if (ledger.present && (ledger.brokenAt === null || ledger.reason === null)) chain = this.t('ledger.broken_somewhere', { records: ledger.records });
    else if (ledger.present) chain = this.t('ledger.broken', { at: ledger.brokenAt, reason: this.t(`ledger.${ledger.reason}`), records: ledger.records });
    const counts = { 'protected-files': excludedPaths.protected, 'runs-folder': excludedPaths.runs, 'nested-repository-content': excludedPaths.gitlinks };
    const codes = [...new Set([...limitations, ...trees.before.limitations, ...trees.after.limitations])];
    const engine = [['engine_before', trees.before.engineReason], ['engine_after', trees.after.engineReason]].filter(([, reason]) => reason !== null);
    const blocks = [
      facts([[this.t('label.level'), this.t('integrity.level', { level: code(integrity.level) })], [this.t('label.ledger'), chain]]),
      para(this.t('integrity.unsigned')),
    ];
    if (codes.length) blocks.push(para(this.t('integrity.limitations')), list(codes.map((name) => this.t(`limitation.${name}`))));
    if (excludedPaths.classes.length) blocks.push(para(this.t('integrity.excluded')), list(excludedPaths.classes.map((name) => this.t(`excluded.${name}`, { n: counts[name] }))));
    if (engine.length) blocks.push(list(engine.map(([key, reason]) => this.t(`integrity.${key}`, { reason: code(reason) }))));
    return blocks;
  }

  verify() {
    const { baseCommit } = this.predicate;
    const name = this.packName ?? '<pack>';
    return [
      para(this.t('verify.digest', { digest: code(this.digest) })),
      { type: 'commands', lines: [`chatmcp verify check ${name}`, `chatmcp verify trust --pack ${name}`, `chatmcp verify reproduce ${name} --base ${baseCommit ?? '<commit|folder>'}`] },
      para(this.t('verify.reproduce')),
      ...(this.packName === null ? [note(this.t('verify.name'))] : []),
      ...(baseCommit === null ? [note(this.t('verify.base'))] : []),
    ];
  }
}

const SECTIONS = Object.freeze(['subject', 'criteria', 'receipts', 'diff', 'tamper', 'permissions', 'uncertain', 'egress', 'cost', 'integrity', 'verify']);

/**
 * The report of a pack. `source` is {statement, files, entries, packChecked}: what readPackFile (../cli/check.mjs) resolves, with
 * `packChecked: true` from the code that called it; a statement alone makes a report that says so. A file given is compared with the sha256
 * the statement names. `options` is {lang, packName (the file name to show in the commands), vnd (./text.mjs, readRate)}.
 * Returns {lang, verdict, tone, title, lead, sections: [{id, title, blocks}]}. Throws RenderError for what it cannot read.
 */
export function buildReport(source, options = {}) {
  const builder = new Builder(readSource(source), readOptions(options));
  const { kind, counts } = verdictOf(builder.predicate.criteria);
  // a statement alone is not shown as a pass: nobody compared it with anything
  const tone = TONES[kind] === 'pass' && !builder.packChecked ? 'warn' : TONES[kind];
  const statuses = AGENT_CHANGE_SCHEMA.$defs.criterion.properties.status.enum.map((status) => [status, builder.predicate.criteria.filter((criterion) => criterion.status === status).length]).filter(([, n]) => n > 0);
  const summary = statuses.flatMap(([status, n], index) => [text(index ? '; ' : ' '), builder.statusChip(status), text(' '), ...builder.n(n)]);
  return {
    lang: builder.lang,
    verdict: kind,
    tone,
    title: builder.t('title'),
    headline: builder.t(`verdict.${kind}`, counts),
    lead: [
      ...(summary.length ? [para(builder.t('verdict.counts'), summary)] : []),
      para(builder.t(builder.packChecked ? 'basis.pack' : 'basis.statement')),
      note(builder.t('caveat')),
    ],
    sections: SECTIONS.map((name) => ({ id: name, title: builder.t(`section.${name}`), blocks: builder[name]() })),
  };
}
