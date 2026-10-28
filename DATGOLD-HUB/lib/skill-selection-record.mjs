// What a run keeps of choosing its skills (task.skillSelection) and the page shows under the turn: which skills were taken and on what grounds, or why none was. It is made of
// the trace that the scorer (lib/plugins.mjs) and selectConversationSkills (lib/agent.mjs) fill, and it holds nothing of the prompt: only the names of skills and of project
// kinds, the words of the skills that matched, and the Vietnamese phrases of the table (lib/skill-vocabulary.mjs) that were read. Everything is bounded: the page draws it, and
// a skill's name and a project file's name come from outside the Hub.

/** The points a skill needs to be taken. (A word of a description is worth 1, a word of its name 4, of its id 5, an explicit trigger 8 to 10: lib/plugins.mjs.) */
export const SKILL_THRESHOLD = 3;

const MAX_SELECTED = 8;
const MAX_WHY = 12;
const MAX_PROJECT = 8;
const MAX_CONCEPTS = 8;
const NAME = 80;
const ID = 64;
const WORD = 40;
const LABEL = 64;
const KINDS = new Set(['id', 'name', 'description', 'trigger', 'project']);
const REASONS = new Set(['no_skills', 'no_prompt']);

const text = (value, length) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, length);
const count = (value, fallback) => (Number.isInteger(value) && value >= 0 ? value : fallback);
const list = (value) => (Array.isArray(value) ? value : []);
const plain = (value) => (value !== null && typeof value === 'object' ? value : {});

function reasonOf(item) {
  const entry = plain(item);
  if (!KINDS.has(entry.kind)) return null;
  const out = { kind: entry.kind };
  if (typeof entry.word === 'string') out.word = text(entry.word, WORD);
  if (typeof entry.via === 'string') out.via = text(entry.via, WORD);
  if (typeof entry.label === 'string') out.label = text(entry.label, LABEL);
  return out;
}

/**
 * @param {object} [trace] what selectConversationSkills filled: `calls` (one trace of selectSkillsForTask per prompt it read, the run's own first) and `picks` ([{ id, call }]:
 *   the skills it returned, and the call that took each).
 * @param {object} [options]
 * @param {Array<{id: string, label: string}>} [options.project] the kinds of project the workspace was found to be
 * @returns {{reason: string, considered: number, threshold: number, selected: object[], nearest: object|null, project: object[], concepts: object[]}}
 */
export function buildSkillSelectionRecord(trace = {}, { project = [] } = {}) {
  const calls = list(plain(trace).calls);
  const first = plain(calls[0]);
  const selected = list(plain(trace).picks).slice(0, MAX_SELECTED).map((pick) => {
    const call = Number.isInteger(plain(pick).call) ? pick.call : 0;
    const candidate = plain(list(plain(calls[call]).candidates).find((item) => plain(item).id === pick.id));
    return {
      id: text(pick.id, ID),
      name: text(candidate.name ?? pick.id, NAME),
      score: count(candidate.score, 0),
      source: call === 0 ? 'run' : 'earlier',
      why: list(candidate.why).slice(0, MAX_WHY).map(reasonOf).filter((item) => item !== null),
    };
  });
  const reason = selected.length ? 'selected' : REASONS.has(first.reason) ? first.reason : 'no_match';
  const near = reason === 'no_match' ? plain(list(first.candidates).find((item) => plain(item).passed === false)) : {};
  return {
    reason,
    considered: count(first.considered, 0),
    threshold: count(first.threshold, SKILL_THRESHOLD),
    selected,
    nearest: typeof near.id === 'string' ? { id: text(near.id, ID), name: text(near.name ?? near.id, NAME), score: count(near.score, 0) } : null,
    project: list(project).filter((signal) => typeof plain(signal).id === 'string' && typeof signal.label === 'string').slice(0, MAX_PROJECT)
      .map((signal) => ({ id: text(signal.id, 32), label: text(signal.label, LABEL) })),
    concepts: list(first.concepts).slice(0, MAX_CONCEPTS).map((entry) => ({ phrase: text(plain(entry).phrase, WORD), words: list(plain(entry).words).slice(0, 6).map((word) => text(word, WORD)) })),
  };
}
