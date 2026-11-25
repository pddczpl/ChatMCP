// What the benchmark's report says (plan task P7 pod-39, corpus/REPORT.md), as data: pages of sections of blocks of nodes, in one language.
// report-html.mjs and report-md.mjs write it; neither of them reads a result, a pack or a task.
//
// Four rules. Every rate is one of metrics.mjs and stands as k/n with its interval; nothing is computed here but counts of what is missing.
// A text of the data is a `code` or `word` node, never a word of the report. Agents and tasks stand in id order and are never compared:
// the protocol defines no comparison. What is not there is said: an agent without a run, a task without a run, a cost that is not known.
import { AGENT_ID } from './freeze.mjs';
import { byName } from './load.mjs';
import { MARKER_CONTRACT, MARKER_CONTRACT_VERSION } from './marker.mjs';
import { WILSON_Z } from './metrics.mjs';
import { KILL_RULE, METRICS, PROTOCOL } from './protocol.mjs';
import { chip, code, cutText, formatDecimal, formatInteger, text, word } from './render.mjs';
import { BREAK, fixed, link, percent, rateNodes, refuse, translate } from './report-text.mjs';
import { resultKey } from './score.mjs';

/** Why a report has the banner: what makes its input not a registered run set. */
export const BANNER_REASONS = Object.freeze(['no_registration', 'no_tag', 'example']);
/** Why the kill rule is not applied: what keeps the run set from being the registered one, complete. */
export const KILL_REASONS = Object.freeze(['not_registered', 'no_agent', 'repeats', 'scoring_errors', 'controls', 'agent_missing', 'task_missing']);
/** The most characters of a text that a run left, and the most paths listed of one run; the pack holds the rest. */
export const TEXT_CHARS = 500;
export const PATHS_LISTED = 20;

const TASK_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DASH = [text('–')];

// ---- names ----------------------------------------------------------------------------------------------------------------------------
// Every file name and anchor is made of an id that its rule allows and of words written here, so none can leave the report's folder, name a
// Windows device or be the name of another: `agent-` and `control-` keep an agent called "oracle" apart from the oracle.
const whoOf = (result) => (result.control === null ? `agent-${result.agent}` : `control-${result.control}`);
/** The copy of a run's pack in the report's folder. */
export const packFile = (result) => `packs/${result.task}_${whoOf(result)}_${result.repeat}.json`;
export const agentFile = (agent) => `agent-${agent}.html`;
export const taskFile = (task) => `task-${task}.html`;
const runAnchor = (result) => `run-${whoOf(result)}-${result.repeat}`;

function checkId(id, rule, what) {
  if (typeof id !== 'string' || !rule.test(id)) refuse('bad_id', `${JSON.stringify(id)} is not ${what}`);
  return id;
}

// ---- blocks ---------------------------------------------------------------------------------------------------------------------------
const para = (...body) => ({ type: 'para', body: body.flat() });
const note = (...body) => ({ type: 'note', body: body.flat() });
const verdict = (tone, ...body) => ({ type: 'verdict', tone, body: body.flat() });
const facts = (rows) => ({ type: 'facts', rows });
const list = (items) => ({ type: 'list', items });
const commands = (lines) => ({ type: 'commands', lines });
/** A text of many lines, shown line by line. */
const verbatim = (value) => ({ type: 'verbatim', lines: value.replace(/\r\n/g, '\n').split('\n') });
/** `rows` are lists of cells, or {id, cells} for a row with an anchor. */
const table = (head, rows) => ({ type: 'table', head, rows: rows.map((row) => (Array.isArray(row) ? { id: null, cells: row } : row)) });
/** `items` (lists of nodes) with `between` between them. */
const joined = (items, between = [text(', ')]) => items.flatMap((item, index) => (index ? [...between, ...item] : item));

/** The example tasks of a corpus (corpus/README.md, "Layout"): by their id or their tag. */
const examplesOf = (tasks) => tasks.filter((task) => task.id.startsWith('example-') || task.task.tags.includes('example')).length;

/** Why `data` is not a registered run set: some of BANNER_REASONS, none when it is one. */
export function bannerReasons({ registration, tasks }) {
  return BANNER_REASONS.filter((reason) => ({ no_registration: registration === null, no_tag: registration !== null && registration.tag === null, example: examplesOf(tasks) > 0 })[reason]);
}

class Builder {
  constructor(data, lang) {
    Object.assign(this, data);
    this.lang = lang;
    for (const task of data.tasks) checkId(task.id, TASK_ID, 'the id of a task');
    this.measured = new Map(data.metrics.agents.map((agent) => [checkId(agent.agent, AGENT_ID, 'the id of an agent'), agent]));
    this.registeredAgents = new Map((data.registration?.document.agents ?? []).map((agent) => [checkId(agent.id, AGENT_ID, 'the id of an agent'), agent]));
    this.agents = [...new Set([...this.measured.keys(), ...this.registeredAgents.keys()])].sort(byName);
    this.byRun = new Map(data.results.map((result) => [resultKey(result), result]));
    this.byTask = new Map(data.tasks.map((task) => [task.id, []]));
    this.byAgent = new Map(this.agents.map((agent) => [agent, []]));
    for (const result of data.results) {
      this.byTask.get(result.task).push(result);
      if (result.control === null) this.byAgent.get(result.agent).push(result);
    }
    this.repeats = Array.from({ length: PROTOCOL.repeats_per_task_and_agent }, (_, index) => index + 1);
    // a task nobody ran is not among the tasks of the metrics, which know the results only
    this.missing = new Map(this.agents.map((agent) => [agent, data.tasks.map((task) => ({ task: task.id, repeats: this.repeats.filter((repeat) => !this.runOf(task.id, agent, repeat)) })).filter((entry) => entry.repeats.length)]));
    this.unrunTasks = data.tasks.filter((task) => !this.byTask.get(task.id).length).map((task) => task.id);
    this.unrunAgents = this.agents.filter((agent) => !this.measured.has(agent));
    this.bannerReasons = bannerReasons(data);
  }

  // ---- words, numbers and texts ---------------------------------------------------------------------------------------------------------
  t(key, params) { return translate(this.lang, key, params); }

  n(value) { return [text(formatInteger(value, this.lang))]; }

  rate(value) { return rateNodes(value, this.lang); }

  /** A rate over the runs where the answer is known, and how many are left out of it. */
  knownRate(value) { return value.unknown ? this.t('rate.unknown', { rate: this.rate(value), n: value.unknown }) : this.rate(value); }

  yesNo(value) { return value === null ? this.t('unknown') : this.t(value ? 'yes' : 'no'); }

  usd(value) { return [text(`${fixed(value, 4, this.lang)} USD`)]; }

  seconds(value) { return [text(`${formatDecimal(value, this.lang)} s`)]; }

  /** Seconds that are a sum or a median, to one decimal. */
  about(value) { return [text(`${fixed(value, 1, this.lang)} s`)]; }

  head(...keys) { return keys.map((key) => this.t(`col.${key}`)); }

  /** A text that a run left, at most TEXT_CHARS of it. */
  cut(value) {
    const { text: shown, length, cut } = cutText(value, TEXT_CHARS);
    return cut ? [code(shown), text(' '), ...this.t('text.cut', { shown: TEXT_CHARS, length })] : [code(shown)];
  }

  paths({ items, total }, show) {
    if (!total) return DASH;
    return [...joined(items.map(show), [BREAK]), ...(total > items.length ? [BREAK, ...this.t('paths.more', { n: total - items.length })] : [])];
  }

  // ---- links ----------------------------------------------------------------------------------------------------------------------------
  page(file, value) { return link(`${this.lang}/${file}`, value); }

  agentLink(agent) { return [this.page(agentFile(agent), [word(agent)])]; }

  taskLink(task) { return [this.page(taskFile(task), [word(task)])]; }

  agentLinks(agents) { return joined(agents.map((agent) => this.agentLink(agent))); }

  // ---- one run --------------------------------------------------------------------------------------------------------------------------
  runOf(task, agent, repeat) { return this.byRun.get(resultKey({ task, agent, control: null, repeat })) ?? null; }

  claim(result) { return this.t(`claim.${result.marker ?? 'none'}`); }

  /** What a run is, in one chip: its claim and the outcome of its hidden tests, as they are. */
  runChip(result) {
    if (result === null) return chip('gap', this.t('run.missing'));
    if (result.scoring_error !== null) return chip('error', this.t('run.scoring_error'));
    const kind = result.false_done ? 'false' : result.claimed_done ? 'held' : 'plain';
    return chip(kind, this.t('run.cell', { claim: this.claim(result), outcome: this.t(`outcome.${result.hidden_outcome}`) }));
  }

  /** Every repeat of an agent on a task, each leading to its row on the task's page. */
  repeatCells(task, agent) {
    return joined(this.repeats.map((repeat) => {
      const result = this.runOf(task, agent, repeat);
      const shown = this.runChip(result);
      return [text(`${repeat}: `), result === null ? shown : this.page(`${taskFile(task)}#${runAnchor(result)}`, [shown])];
    }), [BREAK]);
  }

  who(result) {
    const name = result.control === null ? this.agentLink(result.agent) : this.t(`control.name.${result.control}`);
    return this.t('run.name', { who: name, repeat: result.repeat });
  }

  hidden(result) {
    const outcome = this.t(`outcome.${result.hidden_outcome}`);
    return ['pass', 'fail', 'flaky'].includes(result.hidden_outcome) ? this.t('run.hidden', { outcome, k: result.hidden_passes, n: PROTOCOL.hidden_test_runs }) : outcome;
  }

  runCost(result) {
    if (result.cost_status === null) return DASH;
    return result.cost_status === 'complete' ? [text(`${formatDecimal(result.cost_usd, this.lang)} USD`)] : this.t(`cost.status.${result.cost_status}`);
  }

  // ---- index ----------------------------------------------------------------------------------------------------------------------------
  index() {
    return {
      file: 'index.html',
      title: this.t('title'),
      lead: [para(this.t('about')), note(this.t('about.order')), note(this.t('about.comparison'))],
      sections: [
        ['set', this.set()], ['rates', this.rates()], ['other', this.otherRates()], ['costs', this.costs()], ['apart', this.apart()], ['kill', this.kill()], ['controls', this.controlTable()], ['grid', this.grid()],
      ],
    };
  }

  set() {
    const { registration } = this;
    const runs = this.results.filter((result) => result.control === null).length;
    const tag = registration?.tag ?? null;
    let state = this.t('registration.none');
    if (registration !== null) state = tag === null ? this.t('registration.untagged') : this.t('registration.tag', { tag: code(tag.name), time: word(new Date(tag.time * 1000).toISOString()), signature: this.t(tag.signed ? 'registration.signed' : 'registration.unsigned') });
    const rows = [
      ['registration', state],
      ...(registration === null ? [] : [
        ['freeze', [link('preregistration.json', [code('preregistration.json')]), text(' '), code(registration.sha256)]],
        ['commit', [code(registration.document.corpus.commit)]],
        ['path', [code(registration.document.corpus.path)]],
        ...(tag === null ? [] : [['tag_object', [code(tag.object)]]]),
      ]),
      ['corpus', [code(this.corpusSha256)]],
      ['results', [link('results.jsonl', [code('results.jsonl')]), text(' '), code(this.resultsSha256)]],
      ['protocol', this.n(PROTOCOL.version)],
      ['tasks', this.n(this.tasks.length)],
      ['agents', this.t('set.agents', { n: this.agents.length, run: this.measured.size })],
      ['runs', this.t('set.runs', { runs, controls: this.results.length - runs })],
      ['date', this.date === null ? this.t('set.no_date') : [word(this.date)]],
    ];
    return [facts(rows.map(([label, value]) => [this.t(`label.${label}`), value]))];
  }

  /** A table with a row for every agent: `cells` of its metrics, or a sentence for an agent without a run. */
  agentTable(head, cells) {
    if (!this.agents.length) return [note(this.t('agents.none'))];
    const width = head.length;
    return [table(head, this.agents.map((agent) => {
      const metrics = this.measured.get(agent);
      return [this.agentLink(agent), ...(metrics ? cells(metrics) : [this.t('agent.no_run'), ...Array.from({ length: width - 2 }, () => DASH)])];
    }))];
  }

  rates() {
    return [
      para(this.t('rates.about')),
      ...this.agentTable(this.head('agent', 'scored', 'claimed', 'hidden', 'false_rate'), (agent) => [this.n(agent.scored_runs), this.rate(agent.claimed_done), this.rate(agent.hidden_pass), this.rate(agent.false_done_rate)]),
    ];
  }

  otherRates() {
    return this.agentTable(this.head('agent', 'reverified', 'tamper', 'scope'), (agent) => [this.knownRate(agent.reverified_pass), this.knownRate(agent.tamper), this.rate(agent.out_of_scope)]);
  }

  /** {total, perTask} of an agent's cost, in words. */
  costOf(agent) {
    const cost = agent.cost_per_verified_task;
    if (cost.status === 'unknown_cost') {
      const runs = this.byAgent.get(agent.agent);
      const of = (status) => runs.filter((run) => run.cost_status === status).length;
      const total = this.t('cost.unknown', { n: runs.filter((run) => run.cost_usd === null).length, m: runs.length });
      return { total: [...total, BREAK, ...this.t('cost.breakdown', { unknown: of('unknown'), incomplete: of('incomplete'), other: of('not_usd') })], perTask: this.t('cost.not_known') };
    }
    return { total: this.usd(cost.total_usd), perTask: cost.status === 'no_verified_task' ? this.t('cost.none_passed') : this.t('cost.per', { usd: this.usd(cost.usd), total: this.usd(cost.total_usd), n: cost.verified }) };
  }

  costs() {
    return [
      ...this.agentTable(this.head('agent', 'cost_total', 'cost_per', 'wall_total', 'wall_median'), (agent) => {
        const { total, perTask } = this.costOf(agent);
        return [total, perTask, this.about(agent.wall_seconds.total), this.about(agent.wall_seconds.median)];
      }),
      ...(this.agents.length ? [note(this.t('costs.about'))] : []),
    ];
  }

  apartOf(agent) {
    const metrics = this.measured.get(agent);
    const missing = this.missing.get(agent).reduce((sum, entry) => sum + entry.repeats.length, 0);
    return [metrics?.scoring_errors, metrics?.flaky, metrics?.false_done_flaky, metrics?.timed_out, metrics?.markers.blocked, metrics?.markers.none, missing].map((value) => value ?? 0);
  }

  apart() {
    if (!this.agents.length) return [note(this.t('agents.none'))];
    return [
      table(this.head('agent', 'scoring_errors', 'flaky', 'flaky_false', 'timed_out', 'blocked', 'no_marker', 'missing'), this.agents.map((agent) => [this.agentLink(agent), ...this.apartOf(agent).map((value) => this.n(value))])),
      note(this.t('apart.about')),
    ];
  }

  // ---- the kill rule --------------------------------------------------------------------------------------------------------------------
  /** Why this is not the registered run set, complete: [reason, what the sentence names]. */
  killReasons() {
    const { agents, controls } = this.metrics;
    const named = (test) => ({ agents: this.agentLinks(agents.filter(test).map((agent) => agent.agent)) });
    return [
      [this.bannerReasons.length > 0, 'not_registered'],
      [agents.length === 0, 'no_agent'],
      [agents.some((agent) => !agent.repeats.complete), 'repeats', () => named((agent) => !agent.repeats.complete)],
      [agents.some((agent) => agent.scoring_errors > 0), 'scoring_errors', () => named((agent) => agent.scoring_errors > 0)],
      [!controls.ok, 'controls'],
      [this.unrunAgents.length > 0, 'agent_missing', () => ({ agents: this.agentLinks(this.unrunAgents) })],
      [this.unrunTasks.length > 0, 'task_missing', () => ({ n: this.unrunTasks.length })],
    ].filter(([holds]) => holds).map(([, reason, params]) => this.t(`kill.reason.${reason}`, params?.() ?? {}));
  }

  kill() {
    const rule = this.metrics.kill_rule;
    const threshold = text(percent(rule.threshold, this.lang));
    const reasons = this.killReasons();
    const state = rule.triggered === null ? 'undecided' : rule.triggered ? 'met' : 'not_met';
    const above = this.agentLinks(rule.agents_above);
    const blocks = [para(this.t('kill.about', { threshold }))];
    if (reasons.length || !rule.final) blocks.push(verdict('warn', this.t('kill.not_applied')), list(reasons), para(this.t(`kill.reading.${state}`, state === 'not_met' ? { threshold, agents: above } : { threshold })));
    else blocks.push(verdict(state === 'undecided' ? 'warn' : 'plain', this.t(`kill.${state}`, state === 'not_met' ? { threshold, agents: above } : { threshold })));
    const states = this.agentTable(this.head('agent', 'claims', 'false_claims', 'false_rate', 'above'), (agent) => [
      this.n(agent.false_done_rate.n), this.n(agent.false_done), this.rate(agent.false_done_rate), agent.false_done_rate.n === 0 ? this.t('kill.no_rate') : this.yesNo(rule.agents_above.includes(agent.agent)),
    ]);
    return [...blocks, ...states, note(this.t('kill.points'))];
  }

  // ---- controls and grid ----------------------------------------------------------------------------------------------------------------
  controlTable() {
    const rows = new Map(this.metrics.controls.tasks.map((row) => [row.task, row]));
    const problems = (task) => this.metrics.controls.problems.filter((problem) => problem.task === task);
    return [
      para(this.t('controls.about')),
      table(this.head('task', 'oracle', 'null', 'state'), this.tasks.map((task) => {
        const row = rows.get(task.id);
        if (!row) return [this.taskLink(task.id), DASH, DASH, this.t('task.no_run')];
        return [
          this.taskLink(task.id), this.t('controls.passed', { k: row.oracle.passed, n: row.oracle.runs }), this.t('controls.failed', { k: row.null.failed, n: row.null.runs }),
          row.ok ? this.t('control.ok') : joined(problems(task.id).map((problem) => this.t(`control.${problem.code}`)), [BREAK]),
        ];
      })),
      para(this.t(this.metrics.controls.ok ? 'controls.ok' : 'controls.not_ok')),
    ];
  }

  grid() {
    if (!this.agents.length) return [note(this.t('agents.none')), list(this.tasks.map((task) => this.taskLink(task.id)))];
    return [
      para(this.t('grid.about')),
      table([this.t('col.task'), ...this.agents.map((agent) => this.agentLink(agent))], this.tasks.map((task) => [this.taskLink(task.id), ...this.agents.map((agent) => this.repeatCells(task.id, agent))])),
    ];
  }

  // ---- one agent ------------------------------------------------------------------------------------------------------------------------
  agentPage(agent) {
    const metrics = this.measured.get(agent);
    const response = [para(this.responses.has(agent) ? this.t('response.there', { page: this.page(`responses.html#response-${agent}`, this.t('page.responses')) }) : this.t('response.none'))];
    return {
      file: agentFile(agent),
      title: this.t('page.agent', { agent: word(agent) }),
      lead: [],
      sections: [
        ['identity', this.identity(agent)],
        ...(metrics ? [['metrics', this.agentMetrics(metrics)], ['agent-apart', this.agentApart(agent)], ['agent-runs', this.agentRuns(agent)]] : [['metrics', [note(this.t('agent.no_run'))]]]),
        ['agent-response', response],
      ],
    };
  }

  identity(agent) {
    const given = this.registeredAgents.get(agent);
    if (!given) return [note(this.t('identity.none'))];
    const rows = ['cli', 'version', 'model', 'notes'].map((key) => [this.t(`label.${key}`), given[key] === undefined ? this.t('not_recorded') : [code(given[key])]]);
    return [facts(rows), note(this.t('identity.about'))];
  }

  agentMetrics(agent) {
    const { total, perTask } = this.costOf(agent);
    const values = {
      claimed_done: this.rate(agent.claimed_done),
      reverified_pass: this.knownRate(agent.reverified_pass),
      hidden_pass: this.rate(agent.hidden_pass),
      false_done: this.t('count.claims', { k: agent.false_done, n: agent.claimed_done.k }),
      false_done_rate: this.rate(agent.false_done_rate),
      tamper: this.knownRate(agent.tamper),
      out_of_scope: this.rate(agent.out_of_scope),
      cost_per_verified_task: perTask,
      wall_seconds: this.t('wall.both', { total: this.about(agent.wall_seconds.total), median: this.about(agent.wall_seconds.median) }),
    };
    return [
      facts([[this.t('label.scored'), this.t('count.scored', { scored: agent.scored_runs, runs: agent.runs })], ...METRICS.map((metric) => [this.t(`metric.${metric.id}`), values[metric.id]]), [this.t('label.cost_total'), total]]),
      note(this.t('rates.about')),
    ];
  }

  agentApart(agent) {
    const keys = ['scoring_errors', 'flaky', 'flaky_false', 'timed_out', 'blocked', 'no_marker', 'missing'];
    const missing = this.missing.get(agent);
    return [
      facts(this.apartOf(agent).map((value, index) => [this.t(`col.${keys[index]}`), this.n(value)])),
      ...(missing.length ? [para(this.t('missing.about')), list(missing.map((entry) => this.t('missing.item', { task: this.taskLink(entry.task), repeats: text(entry.repeats.join(', ')) })))] : []),
    ];
  }

  agentRuns(agent) {
    return [para(this.t('grid.about')), table(this.head('task', 'repeats'), this.tasks.map((task) => [this.taskLink(task.id), this.repeatCells(task.id, agent)]))];
  }

  // ---- one task -------------------------------------------------------------------------------------------------------------------------
  taskPage(task) {
    const runs = this.byTask.get(task.id);
    return {
      file: taskFile(task.id),
      title: this.t('page.task', { task: word(task.id) }),
      lead: [para(this.t('task.title', { title: code(task.task.title) }))],
      sections: [['task', this.taskFacts(task)], ['prompt', [note(this.t('prompt.about')), verbatim(task.task.prompt)]], ['criteria', this.criteria(task)], ['runs', this.runTable(runs)], ...(runs.length ? [['left', this.left(runs)]] : [])],
    };
  }

  taskFacts({ id, sha256, task }) {
    const { repo, limits, hidden_tests: hidden } = task;
    const codes = (values) => (values.length ? joined(values.map((value) => [code(value)]), [BREAK]) : this.t('none'));
    const rows = [
      ['id', [word(id)]],
      ['task_sha256', [code(sha256)]],
      ['source', repo.git ? this.t('source.git', { url: code(repo.git.url), commit: code(repo.git.commit) }) : this.t('source.tarball', { file: code(repo.tarball.file), sha: code(repo.tarball.sha256) })],
      ['hidden', this.t('hidden.archive', { file: code(hidden.archive), sha: code(hidden.sha256) })],
      ['setup', codes(task.setup)],
      ['allowed', codes(task.allowed_paths)],
      ['wall', this.seconds(limits.wall_seconds)],
      ['turns', limits.max_turns === undefined ? this.t('not_set') : this.n(limits.max_turns)],
      ['cents', limits.max_cost_cents === undefined ? this.t('not_set') : this.n(limits.max_cost_cents)],
      ['tags', codes(task.tags)],
    ];
    return [facts(rows.map(([label, value]) => [this.t(`label.${label}`), value]))];
  }

  criteria({ acceptance }) {
    return [table(this.head('criterion', 'asks', 'checks'), acceptance.criteria.map((criterion) => [[word(criterion.id)], [code(criterion.text)], criterion.checks?.length ? joined(criterion.checks.map((check) => [code(check.run)]), [BREAK]) : this.t('criterion.manual')]))];
  }

  runTable(results) {
    if (!results.length) return [note(this.t('runs.none'))];
    const agentOnly = (result, nodes) => (result.control === null ? nodes() : DASH);
    return [
      table(this.head('run', 'claim', 'hidden_tests', 'false_done', 'reverified_run', 'tamper_run', 'scope_run', 'cost', 'seconds', 'pack'), results.map((result) => ({
        id: runAnchor(result),
        cells: [
          this.who(result),
          agentOnly(result, () => this.claim(result)),
          this.hidden(result),
          agentOnly(result, () => (result.false_done === null ? this.t('run.scoring_error') : this.yesNo(result.false_done))),
          agentOnly(result, () => this.yesNo(result.reverified_pass)),
          agentOnly(result, () => this.yesNo(result.tamper)),
          result.out_of_scope_count === null ? this.t('unknown') : this.n(result.out_of_scope_count),
          this.runCost(result),
          agentOnly(result, () => (result.timed_out ? this.t('run.timed_out', { seconds: this.seconds(result.wall_seconds) }) : this.seconds(result.wall_seconds))),
          [link(this.runFacts(result).file, this.t('run.pack')), text(' '), code(result.pack_sha256)],
        ],
      }))),
      note(this.t('runs.about')),
    ];
  }

  runFacts(result) { return this.runs.get(resultKey(result)); }

  left(results) {
    const exit = (run) => (run.signal !== null ? this.t('left.signal', { signal: code(run.signal) }) : run.exitCode === null ? this.t('not_recorded') : [code(run.exitCode)]);
    const rows = results.map((result) => {
      const run = this.runFacts(result);
      const control = result.control !== null;
      return [
        this.who(result), control ? DASH : exit(run), control ? DASH : run.finalLine === null ? this.t('left.no_message') : run.finalLine === '' ? this.t('left.empty') : this.cut(run.finalLine),
        this.paths(run.outOfScope, (change) => [...this.cut(change.path), text(' '), ...this.t(`change.${change.change}`)]), this.paths(run.overwritten, (file) => this.cut(file)),
      ];
    });
    return [para(this.t('left.about')), table(this.head('run', 'exit', 'last_line', 'scope_paths', 'overwritten'), rows)];
  }

  // ---- methods --------------------------------------------------------------------------------------------------------------------------
  methods() {
    return {
      file: 'methods.html',
      title: this.t('page.methods'),
      lead: [para(this.t('methods.about'))],
      sections: [
        ['protocol', this.protocol()], ['definitions', this.definitions()], ['interval', this.interval()], ['marker', [para(this.t('marker.about', { version: MARKER_CONTRACT_VERSION })), verbatim(MARKER_CONTRACT)]],
        ['readings', [para(this.t('readings.about')), list(['scoring_error', 'cost', 'kill', 'null', 'tamper', 'complete'].map((key) => this.t(`reading.${key}`)))]],
        ['limits', [list(['marker', 'ignored', 'versions', 'autonomy', 'repeats', 'pack_read', 'public', 'sandbox', 'hidden', 'cost', 'secrets', 'tag'].map((key) => this.t(`limit.${key}`)))]],
        ['reproduce', this.reproduce()],
      ],
    };
  }

  protocol() {
    const scoring = this.registration?.document.scoring_code ?? null;
    const rows = [
      ['protocol', this.n(PROTOCOL.version)], ['repeats', this.n(PROTOCOL.repeats_per_task_and_agent)], ['hidden_runs', this.t('protocol.hidden', { n: PROTOCOL.hidden_test_runs, k: PROTOCOL.hidden_pass_requires_runs })],
      ['interval', [code(PROTOCOL.interval)]], ['controls', joined(PROTOCOL.controls.map((control) => [code(control)]), [BREAK])], ['claim', [code(PROTOCOL.claim)]], ['kill_rule', [code(KILL_RULE.rule)]],
      ['scoring_code', scoring === null ? this.t('not_recorded') : joined([[code(scoring.commit)], ...(scoring.repository === null ? [] : [[code(scoring.repository)]])], [BREAK])],
    ];
    return [facts(rows.map(([label, value]) => [this.t(`label.${label}`), value])), note(this.t(this.registration === null ? 'protocol.unregistered' : 'protocol.registered'))];
  }

  definitions() {
    return [para(this.t('definitions.about')), table(this.head('metric', 'meaning', 'definition'), METRICS.map((metric) => [[word(metric.id)], this.t(`metric.${metric.id}.about`), [code(metric.definition)]]))];
  }

  interval() {
    return [para(this.t('interval.about', { z: code(WILSON_Z) })), commands(['center = (p + z*z/(2*n)) / (1 + z*z/n)', 'half   = z / (1 + z*z/n) * sqrt(p*(1 - p)/n + z*z/(4*n*n))', 'low    = center - half', 'high   = center + half']), para(this.t('interval.edges'))];
  }

  reproduce() {
    const registered = this.registration === null ? '' : ` --preregistration preregistration.json${this.registration.tag === null ? '' : ' --tag <tag>'}`;
    const rest = `${this.responses.size ? ' --responses responses' : ''}${this.date === null ? '' : ` --date ${this.date}`}`;
    return [
      para(this.t('reproduce.about')),
      commands([
        'node corpus/tools/score.mjs --corpus <corpus> --packs packs --check results.jsonl',
        'node corpus/tools/metrics.mjs --results results.jsonl',
        `node corpus/tools/report.mjs --corpus <corpus> --packs packs --results results.jsonl${registered}${rest} --out <new folder>`,
      ]),
      para(this.t('reproduce.compare')),
    ];
  }

  // ---- vendor responses -----------------------------------------------------------------------------------------------------------------
  responsePage() {
    return {
      file: 'responses.html',
      title: this.t('page.responses'),
      lead: [para(this.t('responses.about')), ...(this.agents.length ? [] : [note(this.t('agents.none'))])],
      sections: this.agents.map((agent) => [`response-${agent}`, this.response(agent), this.t('page.agent', { agent: word(agent) })]),
    };
  }

  response(agent) {
    const given = this.responses.get(agent);
    if (!given) return [note(this.t('response.none'))];
    return [facts([[this.t('label.response'), [link(`responses/agent-${agent}.txt`, this.t('response.file')), text(' '), code(given.sha256)]], [this.t('label.bytes'), this.n(given.bytes)]]), note(this.t('response.about')), verbatim(given.text)];
  }

  // ---- everything -----------------------------------------------------------------------------------------------------------------------
  pages() {
    return [this.index(), ...this.agents.map((agent) => this.agentPage(agent)), ...this.tasks.map((task) => this.taskPage(task)), this.methods(), this.responsePage()]
      .map((page) => ({ ...page, sections: page.sections.map(([id, blocks, title]) => ({ id, title: title ?? this.t(`section.${id}`), blocks })) }));
  }
}

/**
 * The report of `data` (report.mjs, readData) in `lang`: {lang, banner: {title, reasons} | null, footer, pages: [{file, title, lead, sections:
 * [{id, title, blocks}]}]}. Throws ReportError bad_id for an id that its rule does not allow.
 */
export function buildReport(data, lang) {
  const builder = new Builder(data, lang);
  const reason = { no_registration: {}, no_tag: {}, example: { n: examplesOf(data.tasks) } };
  return {
    lang,
    banner: builder.bannerReasons.length ? { title: builder.t('banner.title'), reasons: builder.bannerReasons.map((name) => builder.t(`banner.${name}`, reason[name])) } : null,
    footer: builder.t('footer', { results: code(data.resultsSha256), corpus: code(data.corpusSha256) }),
    nav: ['index', 'methods', 'responses'].map((name) => ({ file: `${name}.html`, title: builder.t(`nav.${name}`) })),
    other: { lang: lang === 'en' ? 'vi' : 'en', title: builder.t('nav.other'), label: builder.t('nav.label') },
    pages: builder.pages(),
  };
}
