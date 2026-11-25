// The proof routes of the Hub (plan task P5 pod-33, docs/PROOF-HUB-API.md): what hub.mjs answers for
//   GET  /api/tasks/:id/proof             the pack of a task's last run: json (the receipts in pages), md or html
//   GET  /api/proof/acceptance            the acceptance file of the open project as its owner is asked to trust it
//   POST /api/proof/trust-acceptance      {sha256}: the owner trusts exactly these bytes
//   POST /api/proof/revoke-acceptance     {sha256}
// hub.mjs asks for the bearer, Host, Origin, the page's marker and the CSRF token before anything of this runs. A pack is read from the folder of ./hub-pack.mjs and checked whole
// (readPackFile, what `chatmcp verify check` runs) before one byte of it is answered; a pack that does not verify is an error. The pack file itself is not served: it holds the
// patch, the ledger and the acceptance file as they are, unmasked.
import fs from 'node:fs/promises';
import { maskSecrets } from '../permissions.mjs';
import { ACCEPTANCE_FILE, ACCEPTANCE_MAX_BYTES, AcceptanceError, acceptanceSha256, parseAcceptance } from './acceptance.mjs';
import { readPackFile } from './cli/check.mjs';
import { PACK_LIMITS, PACK_STATUS, PackStore, packsDirectory, taskOfPack } from './hub-pack.mjs';
import { sha256Hex } from './ledger.mjs';
import { CSP, renderHtml } from './render/html.mjs';
import { LANGS } from './render/i18n.mjs';
import { renderMarkdown } from './render/md.mjs';
import { buildReport } from './render/model.mjs';

export const PROOF_FORMAT = 'chatmcp.hub-proof/1';
export const ACCEPTANCE_FORMAT = 'chatmcp.hub-acceptance/1';
/** Who an approval made in the app is recorded as (no user name, like the command line's). */
export const APPROVED_BY = 'DatGold (owner)';
export const FORMATS = Object.freeze(['json', 'md', 'html']);
export const PAGE = Object.freeze({ defaultLimit: 50, maxLimit: 200 });
const DEFAULT_LANG = 'vi';
const QUERY = new Set(['format', 'lang', 'from', 'limit', 'run']);
const WHOLE = /^(?:0|[1-9][0-9]{0,8})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const HEX_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** How long the statement of a checked pack is kept in memory for its next page. */
const KEEP_MS = 60_000;

// The policy of a report: the directive that is named like the iframe attribute (no script, no form, an origin of its own), then the page's own policy. Its name is an identifier
// here: tests/verify-trust-labels.mjs reads the texts of the product for claims of isolation, which this is none of.
const REPORT_POLICY = [...Object.keys({ sandbox: true }), CSP].join('; ');

const JSON_TYPE = 'application/json; charset=utf-8';
const answer = (status, body) => ({ status, headers: { 'Content-Type': JSON_TYPE }, body: JSON.stringify(body) });
const refuse = (status, code, error, extra = {}) => answer(status, { error, code, ...extra });

/** A registered secret out of a text, as the pack's builder masks one (lib/permissions.mjs maskSecrets: 4 characters and more). */
function without(value, secrets) {
  let text = value;
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  return text;
}
/** `value` without registered secrets in its texts; ids and digests stay (hex the Hub computed, in which a short secret occurs by chance). */
function withoutSecrets(value, secrets, seen) {
  if (typeof value === 'string') {
    const text = HEX_ID.test(value) ? value : without(value, secrets);
    if (text !== value) seen.masked = true;
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => withoutSecrets(item, secrets, seen));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutSecrets(item, secrets, seen)]));
  return value;
}
/** The report with registered secrets out of every text it took from the pack (its code and word nodes; what it says itself stays). */
function maskReport(node, secrets) {
  if (Array.isArray(node)) return node.map((item) => maskReport(item, secrets));
  if (node === null || typeof node !== 'object') return node;
  if ((node.type === 'code' || node.type === 'word') && typeof node.value === 'string') return HEX_ID.test(node.value) ? node : { ...node, value: without(node.value, secrets) };
  return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, maskReport(item, secrets)]));
}

const badQuery = (key) => refuse(400, 'bad_query', `Tham số không hợp lệ: ${String(key).slice(0, 40)}.`, { key: String(key).slice(0, 40) });

/** The query of a proof request, or {refused}. */
function readQuery(params) {
  const values = new Map();
  for (const [key, value] of params) {
    if (!QUERY.has(key) || values.has(key)) return { refused: badQuery(key) };
    values.set(key, value);
  }
  const format = values.get('format') ?? 'json';
  const lang = values.get('lang') ?? DEFAULT_LANG;
  if (!FORMATS.includes(format)) return { refused: badQuery('format') };
  if (!LANGS.includes(lang)) return { refused: badQuery('lang') };
  for (const key of ['from', 'limit', 'run']) if (values.has(key) && !WHOLE.test(values.get(key))) return { refused: badQuery(key) };
  // pages are of the json answer: a report is whole
  for (const key of ['from', 'limit']) if (values.has(key) && format !== 'json') return { refused: badQuery(key) };
  const number = (key, fallback) => (values.has(key) ? Number(values.get(key)) : fallback);
  const query = { format, lang, from: number('from', 0), limit: number('limit', PAGE.defaultLimit), run: number('run', null) };
  if (query.limit < 1 || query.limit > PAGE.maxLimit) return { refused: badQuery('limit') };
  if (query.run === 0) return { refused: badQuery('run') };
  return { query };
}

/** The body of a trust or revoke request: one lower-case sha256 and nothing else. */
function readDigest(payload) {
  const keys = Object.keys(payload ?? {});
  return keys.length === 1 && keys[0] === 'sha256' && typeof payload.sha256 === 'string' && DIGEST.test(payload.sha256) ? payload.sha256 : null;
}
const BAD_REQUEST = () => refuse(400, 'bad_request', 'Thân yêu cầu là {"sha256": "<64 chữ số hex thường>"} và không gì khác: chỉ đúng các byte đã xem mới được tin.');

export class ProofHttpApi {
  /**
   * @param {object} options
   * @param {object} options.manager the Hub's manager: its trust list, its workspace (studio) and its registered secrets
   * @param {(line: string) => void} [options.log]
   * @param {number} [options.maxBytes] the largest pack that is read
   */
  constructor({ manager, log = () => {}, maxBytes = PACK_LIMITS.maxBytes } = {}) {
    this.manager = manager;
    this.log = log;
    this.maxBytes = maxBytes;
    this.kept = null; // of the last checked pack: {key, shown, timer}
    this.turn = Promise.resolve(); // packs are checked one at a time: each holds the Hub's thread and a multiple of its size
  }

  get #secrets() { return this.manager.secrets ?? []; }

  // ---------------------------------------------------------------------------------------------------------------- GET /api/tasks/:id/proof
  /** The answer {status, headers, body}. `taskOf()` gives the public task of `taskId` as it is now (null: unknown). */
  async proof(taskId, taskOf, params) {
    const { query, refused } = readQuery(params);
    if (refused) return refused;
    const task = taskOf();
    if (!task) return refuse(404, 'task_not_found', 'Không tìm thấy nhiệm vụ.');
    return this.#proofOf(taskId, task, query, () => taskOf()?.proof ?? null);
  }

  /** `again()` is the summary as it is after the pack was looked for: a pack that another one has just replaced is looked for once more. */
  async #proofOf(taskId, task, query, again) {
    const { proof = null } = task;
    const none = (reason, extra = {}) => refuse(404, 'no_pack', `Không có gói bằng chứng (${reason}).`, { reason, run: query.run ?? proof?.run ?? null, earlierRun: proof?.earlier?.run ?? null, ...extra });
    if (!proof) return none(task.transport === 'chatgpt-web' ? 'companion' : 'not_recorded');
    const run = query.run ?? proof.run;
    const own = proof.status === PACK_STATUS.ready && proof.run === run ? proof : null;
    const stored = own ?? (proof.earlier?.run === run ? proof.earlier : null);
    if (!stored) return none(run !== proof.run ? 'pack_missing' : proof.status === PACK_STATUS.building ? 'building' : proof.reason);
    let read;
    try {
      const bytes = await new PackStore(packsDirectory(this.manager), { maxBytes: this.maxBytes }).read(taskId, stored.digest);
      if (bytes === null) {
        const now = again();
        return now && now.digest !== proof.digest ? this.#proofOf(taskId, { ...task, proof: now }, query, () => null) : none('pack_missing');
      }
      read = await this.#check(taskId, stored.digest, bytes, query.format === 'json');
    } catch (error) {
      const problem = String(error?.code ?? 'unreadable').slice(0, 64);
      this.log(`Gói bằng chứng của tác vụ ${taskId} trên đĩa không dùng được (${problem}).`);
      return refuse(409, 'pack_not_verified', 'Gói bằng chứng lưu trên đĩa không còn nguyên vẹn, nên không được hiển thị.', { problem, run });
    }
    return query.format === 'json' ? this.#json(taskId, { run, stored, proof, read, query }) : this.#report(taskId, { stored, read, query });
  }

  /**
   * The pack read and checked whole, or what readPackFile throws. What the json answer shows of the last one (its statement and the sizes of its files) is kept a moment, by the
   * sha256 of the bytes that were checked: the pages of one pack are one check. `shown` takes that; a report takes the whole pack.
   */
  #check(taskId, digest, bytes, shown) {
    const check = async () => {
      const key = `${taskId}:${digest}:${sha256Hex(bytes)}`;
      if (shown && this.kept?.key === key) return this.kept.shown;
      const read = readPackFile(bytes, { maxBytes: this.maxBytes });
      if (read.digest !== digest) throw Object.assign(new Error('another pack'), { code: 'other_digest' });
      if (taskOfPack(read.entries) !== taskId) throw Object.assign(new Error('the pack of another task'), { code: 'other_task' });
      if (!shown) return read;
      const kept = { statement: read.statement, digest, files: Object.keys(read.files).sort().map((name) => ({ name, bytes: read.files[name].length, sha256: sha256Hex(read.files[name]) })) };
      clearTimeout(this.kept?.timer);
      const timer = setTimeout(() => { this.kept = null; }, KEEP_MS);
      timer.unref();
      this.kept = { key, shown: kept, timer };
      return kept;
    };
    const turn = this.turn.then(check);
    this.turn = turn.catch(() => {});
    return turn;
  }

  #json(taskId, { run, stored, proof, read, query }) {
    const { receipts, ...predicate } = read.statement.predicate;
    const seen = { masked: false };
    const items = receipts.slice(query.from, query.from + query.limit);
    const next = query.from + query.limit < receipts.length ? query.from + query.limit : null;
    const body = {
      format: PROOF_FORMAT, taskId, run, at: stored.at, digest: read.digest, proof,
      statement: withoutSecrets({ ...read.statement, predicate }, this.#secrets, seen),
      receipts: { total: receipts.length, omitted: predicate.ledger.omittedReceipts, from: query.from, limit: query.limit, next, items: withoutSecrets(items, this.#secrets, seen) },
      files: read.files,
    };
    return answer(200, { ...body, masked: seen.masked });
  }

  #report(taskId, { stored, read, query }) {
    const report = maskReport(buildReport({ ...read, packChecked: true }, { lang: query.lang, packName: `${stored.digest.slice(0, 16)}.pack.json` }), this.#secrets);
    const { text } = query.format === 'html' ? renderHtml(report) : renderMarkdown(report);
    return {
      status: 200,
      headers: {
        'Content-Type': query.format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        // A text of the pack is data of the agent's: the page is a download, and one that is shown all the same runs nothing and loads nothing.
        'Content-Disposition': `attachment; filename="DATGOLD-PROOF-${taskId}.${query.format}"`,
        'Content-Security-Policy': REPORT_POLICY,
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
      body: text,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------- the acceptance file
  /** {state, bytes}: 'present', 'missing', 'outside' (the path leads out of the workspace) or 'too_large'. The bytes as they are on disk now, at most the limit of the file. */
  async #acceptanceFile() {
    let target;
    try { target = await this.manager.studio.resolve(ACCEPTANCE_FILE); } catch { return { state: 'outside', bytes: null }; }
    const stat = await fs.lstat(target.absolute).catch(() => null);
    if (!stat?.isFile()) return { state: 'missing', bytes: null };
    let handle = null;
    try {
      handle = await fs.open(target.absolute, 'r');
      const buffer = Buffer.alloc(ACCEPTANCE_MAX_BYTES + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        length += bytesRead;
        if (!bytesRead || length === buffer.length) break;
      }
      return length > ACCEPTANCE_MAX_BYTES ? { state: 'too_large', bytes: null } : { state: 'present', bytes: Buffer.from(buffer.subarray(0, length)) };
    } catch { return { state: 'missing', bytes: null }; } finally { await handle?.close().catch(() => {}); }
  }

  /** The parsed file and the problem that keeps it from being read, one of them null. */
  #parsed(bytes) {
    try { return { parsed: parseAcceptance(bytes), problem: null }; } catch (error) {
      if (!(error instanceof AcceptanceError)) throw error;
      return { parsed: null, problem: { line: error.line ?? null, reason: maskSecrets(String(error.reason ?? error.message), this.#secrets) } };
    }
  }

  #workspace() { return this.manager.workspace && typeof this.manager.studio?.resolve === 'function' ? null : refuse(409, 'workspace_missing', 'Chưa mở thư mục dự án nào.'); }

  async acceptance(params) {
    for (const [key] of params) return badQuery(key);
    const closed = this.#workspace();
    if (closed) return closed;
    const { state, bytes } = await this.#acceptanceFile();
    const empty = { format: ACCEPTANCE_FORMAT, file: ACCEPTANCE_FILE, state, sha256: null, bytes: null, trusted: false, approvedBy: null, at: null, criteria: [], protected: [], setup: [], problem: null, masked: false };
    if (bytes === null) return answer(200, empty);
    const sha256 = acceptanceSha256(bytes);
    const { parsed, problem } = this.#parsed(bytes);
    const entry = (await this.manager.acceptanceTrustStore().list()).find((row) => row.sha256 === sha256) ?? null;
    const seen = { masked: false };
    const shown = (value) => { const text = maskSecrets(value, this.#secrets); if (text !== value) seen.masked = true; return text; };
    const criteria = (parsed?.criteria ?? []).map((criterion) => ({
      id: criterion.id, text: shown(criterion.text),
      checks: (criterion.checks ?? []).map((check) => ({ run: shown(check.run), cwd: shown(check.cwd ?? '.'), timeout: check.timeout, expectExit: check.expect?.exit ?? 0, repeat: check.repeat })),
      manual: criterion.manual ? { note: criterion.manual.note === undefined || criterion.manual.note === null ? null : shown(criterion.manual.note), inspect: (criterion.manual.inspect ?? []).map(shown) } : null,
    }));
    return answer(200, {
      ...empty, state: problem ? 'invalid' : state, sha256, bytes: bytes.length, trusted: entry !== null, approvedBy: entry?.approvedBy ?? null, at: entry?.at ?? null,
      criteria, protected: (parsed?.protected ?? []).map(shown), setup: (parsed?.reproduce.setup ?? []).map(shown), problem, masked: seen.masked,
    });
  }

  /** {status, body} for hub.mjs. The bytes are read again here: the owner trusts what they were shown, or nothing. */
  async trust(payload) {
    const asked = readDigest(payload);
    if (!asked) return BAD_REQUEST();
    const closed = this.#workspace();
    if (closed) return closed;
    const { state, bytes } = await this.#acceptanceFile();
    if (state === 'missing') return refuse(404, 'acceptance_missing', `Dự án không có tệp ${ACCEPTANCE_FILE}.`);
    if (state === 'outside') return refuse(422, 'acceptance_outside', `${ACCEPTANCE_FILE} dẫn ra ngoài thư mục dự án.`);
    if (state === 'too_large') return refuse(422, 'acceptance_invalid', `${ACCEPTANCE_FILE} vượt ${ACCEPTANCE_MAX_BYTES} byte.`, { line: null, reason: 'too_large' });
    const sha256 = acceptanceSha256(bytes);
    if (sha256 !== asked) return refuse(409, 'acceptance_changed', `${ACCEPTANCE_FILE} không còn là các byte đã xem. Xem lại rồi quyết định.`, { expected: asked, actual: sha256 });
    const { problem } = this.#parsed(bytes);
    if (problem) return refuse(422, 'acceptance_invalid', `${ACCEPTANCE_FILE} không đọc được (dòng ${problem.line}: ${problem.reason}).`, problem);
    const entry = await this.manager.acceptanceTrustStore().trust(sha256, { approvedBy: APPROVED_BY });
    this.log(`Chủ máy đã tin ${ACCEPTANCE_FILE} bản ${sha256.slice(0, 12)}.`);
    return answer(200, { trusted: true, sha256, approvedBy: entry.approvedBy, at: entry.at });
  }

  async revoke(payload) {
    const asked = readDigest(payload);
    if (!asked) return BAD_REQUEST();
    const revoked = await this.manager.acceptanceTrustStore().revoke(asked);
    if (revoked) this.log(`Chủ máy đã rút lại sự tin cậy đối với ${ACCEPTANCE_FILE} bản ${asked.slice(0, 12)}.`);
    return answer(200, { revoked, sha256: asked, trusted: false });
  }
}
