// DATGOLD-HUB/lib/agent-options.mjs
// Two options of the agent that the owner changes in Settings. They are kept with the Hub's data and READ AT EVERY MODEL REQUEST (a runner that exists when the owner changes one follows it from
// its next request, a pooled chat or a coding worker included: every place that makes a runner is handed the store, as it is for the project instructions).
//
//   autoCompactPercent  from which percent of the history budget the history is compacted (lib/compaction-v2.mjs): a whole number from 50 to 95; 80 when the owner has chosen none.
//   autoAcceptChecks    OFF unless the owner turns it on. On, a criterion that asks for a check ("Run required supported checks...") is matched by the Hub itself to the fresh passing check that it ran
//                       and recorded (lib/objective-acceptance.mjs autoAcceptVerifiedChecks). The evidence it writes says acceptedBy "auto_hub_check", never "local_owner": this RELAXES the claim that
//                       only the owner accepts, for checks only, and the page and the documents say so.
import path from 'node:path';
import { DEFAULT_COMPACT_PERCENT, MAX_COMPACT_PERCENT, MIN_COMPACT_PERCENT, cleanCompactPercent } from './compaction-v2.mjs';
import { readJson, writeJson } from './runtime.mjs';

export const AGENT_OPTIONS_FILE = 'agent-options.json';

const invalid = (message) => Object.assign(new TypeError(message), { statusCode: 400, code: 'agent_options_invalid' });

/** What applies, from what the owner saved: the percent in use and the one saved (null: none), the switch, and the limits the page needs. */
export function agentOptionsView(saved = {}) {
  const percent = cleanCompactPercent(saved?.autoCompactPercent);
  return Object.freeze({
    autoCompactPercent: percent ?? DEFAULT_COMPACT_PERCENT,
    autoCompactSaved: percent,
    autoAcceptChecks: saved?.autoAcceptChecks === true,
    defaultCompactPercent: DEFAULT_COMPACT_PERCENT,
    minCompactPercent: MIN_COMPACT_PERCENT,
    maxCompactPercent: MAX_COMPACT_PERCENT,
  });
}

export class AgentOptionsStore {
  #saved = {};
  #writes = Promise.resolve();

  constructor({ directory, log = () => {} } = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('AgentOptionsStore needs the data folder of the Hub.');
    this.file = path.join(directory, AGENT_OPTIONS_FILE);
    this.log = log;
  }

  /** Reads what the owner saved. Never throws: a file that cannot be used costs the owner the saved choices and nothing else (the defaults apply: 80%, checks not accepted by the Hub). */
  async load() {
    this.#saved = {};
    let data;
    try { data = await readJson(this.file); } catch (error) {
      this.log(`Không đọc được ${AGENT_OPTIONS_FILE} (${error?.code ?? 'dữ liệu không hợp lệ'}); dùng mặc định: nén ở 80%, Hub không tự chấp nhận check.`);
      return;
    }
    if (data === null) return;
    const percent = cleanCompactPercent(data?.autoCompactPercent);
    if (percent !== null) this.#saved.autoCompactPercent = percent;
    if (typeof data?.autoAcceptChecks === 'boolean') this.#saved.autoAcceptChecks = data.autoAcceptChecks;
    if (!Object.keys(this.#saved).length) this.log(`${AGENT_OPTIONS_FILE} không có lựa chọn hợp lệ; dùng mặc định.`);
  }

  /** What applies now. */
  current() { return agentOptionsView(this.#saved); }

  /**
   * Saves a change: `autoCompactPercent` (a whole number from 50 to 95, or null to go back to the default) and/or `autoAcceptChecks` (true or false). Anything else, or nothing to change, is refused
   * with 400 and nothing is saved. The file is written first and the memory follows, so a failed write changes nothing; calls are applied in the order they were made.
   */
  async set(patch) {
    const body = patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
    if (!body) throw invalid('Cần một đối tượng JSON với autoCompactPercent và/hoặc autoAcceptChecks.');
    const known = ['autoCompactPercent', 'autoAcceptChecks'];
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !known.includes(key))) throw invalid('Chỉ nhận autoCompactPercent và autoAcceptChecks.');
    // The whole patch is checked before anything is queued; it is MERGED into what is saved only when its turn comes, so two changes made at the same time cannot undo each other.
    if ('autoCompactPercent' in body && body.autoCompactPercent !== null && !(typeof body.autoCompactPercent === 'number' && cleanCompactPercent(body.autoCompactPercent) !== null)) {
      throw invalid(`autoCompactPercent là số nguyên từ ${MIN_COMPACT_PERCENT} đến ${MAX_COMPACT_PERCENT}, hoặc null để dùng mặc định (${DEFAULT_COMPACT_PERCENT}).`);
    }
    if ('autoAcceptChecks' in body && typeof body.autoAcceptChecks !== 'boolean') throw invalid('autoAcceptChecks phải là true hoặc false.');
    const change = { ...body };
    const write = this.#writes.catch(() => {}).then(async () => {
      const next = { ...this.#saved };
      if ('autoCompactPercent' in change) {
        if (change.autoCompactPercent === null) delete next.autoCompactPercent;
        else next.autoCompactPercent = change.autoCompactPercent;
      }
      if ('autoAcceptChecks' in change) next.autoAcceptChecks = change.autoAcceptChecks;
      await writeJson(this.file, { version: 1, ...next });
      this.#saved = next;
      this.log(`Cài đặt tác tử: nén ngữ cảnh từ ${this.current().autoCompactPercent}%${this.#saved.autoCompactPercent === undefined ? ' (mặc định)' : ''}; Hub ${this.current().autoAcceptChecks ? 'TỰ chấp nhận' : 'không tự chấp nhận'} các check nó đã chạy (chủ máy chọn trong Cài đặt); áp dụng từ lượt gọi model tiếp theo.`);
      return this.current();
    });
    this.#writes = write;
    return write;
  }
}
