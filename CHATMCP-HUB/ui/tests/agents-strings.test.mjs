import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// "No new hard-coded strings": every word the Agents tab shows comes from lib/i18n-agents.ts through t(), so it exists in both languages.
// These read the source of the files that make up the tab and refuse prose that is written into them.

const src = fileURLToPath(new URL('../src/', import.meta.url));
const FILES = [
  'AgentsTab.tsx', 'OrchestratorTab.tsx', 'AgentGroups.tsx', 'DynamicSubagents.tsx', 'ManualGroup.tsx', 'CodingWorkers.tsx', 'CodingRunView.tsx',
  'CodingWorkerCard.tsx', 'CodingReview.tsx', 'ConfirmDialog.tsx', 'IsolatedChecksPanel.tsx', 'agent-parts.tsx', 'agentLabels.ts', 'useDelegation.ts', 'DiffView.tsx',
].map((name) => `components/inspector/${name}`).concat(['lib/agent-proof.ts', 'lib/agent-draft.ts', 'lib/tab-keys.ts', 'store/useAgentDrafts.ts']);

const read = (file) => fs.readFileSync(path.join(src, file), 'utf8');
/** The source without its comments (a comment may be written in Vietnamese; a string may not). */
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;

/** String literals and JSX text that read as a sentence: a capital letter, then words. Class lists, ids, keys and test ids never do. */
function prose(text) {
  const found = [];
  const body = withoutComments(text);
  for (const match of body.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) found.push(match[2]);
  for (const match of body.matchAll(/>([^<>{}\n][^<>{}]*)</g)) found.push(match[1].trim());
  return found.filter((chunk) => /^[A-Z][a-z]+(?:[ ,.'’-]+[A-Za-z]+){1,}/.test(chunk) && /[a-z]{2,} [a-z]{2,}/.test(chunk));
}

test('no Vietnamese is written into a component of the Agents tab', () => {
  for (const file of FILES) assert.doesNotMatch(withoutComments(read(file)), VIETNAMESE, `${file} holds Vietnamese text outside the dictionary`);
});

test('no English sentence is written into a component of the Agents tab either', () => {
  for (const file of FILES) assert.deepEqual(prose(read(file)), [], `${file} holds a sentence that should be a dictionary string`);
});

test('the sentence detector knows a sentence from a class list (a negative control)', () => {
  assert.deepEqual(prose("const a = 'flex items-center gap-2 rounded-lg border'; const b = 'Start the analysis now'; const c = <p>Nothing to show here</p>;"), ['Start the analysis now', 'Nothing to show here']);
  assert.deepEqual(prose("t('group_goal_title'); const d = 'agents-view-groups'; const e = 'INTEGRATE WORKTREES'; const f = 'SHA-256: ';"), []);
});

test('every dictionary key a component asks for exists', () => {
  const dictionary = read('lib/i18n-agents.ts');
  const known = new Set([...dictionary.matchAll(/^\s{2}([a-z_0-9]+):/gm)].map((match) => match[1]));
  const base = read('lib/i18n.ts');
  for (const match of base.matchAll(/^\s{4}([a-z_0-9]+):/gm)) known.add(match[1]);
  const missing = [];
  for (const file of FILES) {
    for (const match of withoutComments(read(file)).matchAll(/\bt\(\s*'([a-z_0-9]+)'/g)) if (!known.has(match[1])) missing.push(`${file}: ${match[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('every key of the agents dictionary is used somewhere (no strings left behind)', () => {
  const dictionary = read('lib/i18n-agents.ts');
  const viBlock = dictionary.slice(0, dictionary.indexOf('export const agentsEn'));
  const keys = [...viBlock.matchAll(/^\s{2}([a-z_0-9]+):/gm)].map((match) => match[1]);
  const code = FILES.map(read).map(withoutComments).join('\n') + read('components/inspector/DynamicSubagents.tsx');
  // keys built at run time: agent_role_<role>, agent_status_<status>, agent_proof_<kind>_title|note, agent_draft_<field>_<code>
  const dynamic = /^(agent_role_|agent_status_|agent_proof_|agent_draft_)/;
  const unused = keys.filter((key) => !dynamic.test(key) && !code.includes(`'${key}'`));
  assert.deepEqual(unused, []);
});
