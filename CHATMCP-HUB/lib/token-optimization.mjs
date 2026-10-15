// Agent-native token budget pipeline. No hooks, proxies, external MCP client or remote telemetry.
// RTK-inspired CLI/log filtering -> Headroom-style context compaction -> Caveman response discipline.
// These names describe complementary strategies; no third-party binaries are bundled or impersonated.
import { randomUUID } from 'node:crypto';

const MODES = new Set(['off', 'safe', 'balanced', 'aggressive']);
const DEFAULT_MODE = MODES.has(process.env.CHATMCP_TOKEN_PROFILE) ? process.env.CHATMCP_TOKEN_PROFILE : 'safe';
const sessions = new Map();
const originals = new Map();
const MAX_ORIGINALS = 128;
const MAX_STORED_CHARS = 8_000_000;
let storedChars = 0;

function session(id) {
  const owner = String(id || '');
  if (!sessions.has(owner)) sessions.set(owner, { mode: DEFAULT_MODE, inputChars: 0, outputChars: 0, compressed: 0 });
  return sessions.get(owner);
}
export function setTokenProfile(taskId, mode) {
  if (!taskId || !MODES.has(mode)) throw new Error('Unknown token profile or missing task ID');
  session(taskId).mode = mode;
  return getTokenStats(taskId);
}
export function getTokenStats(taskId) {
  const { mode, inputChars, outputChars, compressed } = session(taskId);
  return { mode, optimizedOutputs: compressed, originalChars: inputChars, deliveredChars: outputChars,
    savedChars: Math.max(0, inputChars - outputChars), approximateTokensSaved: Math.floor(Math.max(0, inputChars - outputChars) / 4),
    estimatesOnly: true, externalServicesUsed: false };
}
function storeOriginal(taskId, toolName, text) {
  const id = 'tok_' + randomUUID();
  originals.set(id, { taskId, toolName, text, at: Date.now() });
  storedChars += text.length;
  while (originals.size > MAX_ORIGINALS || storedChars > MAX_STORED_CHARS) {
    const [old, value] = originals.entries().next().value;
    originals.delete(old);
    storedChars -= value.text.length;
  }
  return id;
}
export function restoreTokenOutput(taskId, id, offset = 0, limit = 12000) {
  const item = originals.get(id);
  if (!item || !taskId || item.taskId !== taskId) throw Object.assign(new Error('Token receipt not found for this task.'), { code: 'token_receipt_not_found' });
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000)
    throw Object.assign(new Error('Invalid token restoration range.'), { code: 'bad_range' });
  const text = item.text.slice(offset, offset + limit);
  return { id, toolName: item.toolName, text, offset, nextOffset: offset + text.length < item.text.length ? offset + text.length : null, length: item.text.length, exact: true };
}
export function purgeTokenTask(taskId) {
  sessions.delete(taskId);
  for (const [id, value] of originals) if (value.taskId === taskId) {
    storedChars -= value.text.length;
    originals.delete(id);
  }
}
const diagnostics = /(?:error|fail(?:ed|ure)?|exception|traceback|assert|fatal|panic|warning|denied|timeout|exit code|not found|✗|×|✘)/i;
const hasImportantText = (line) => diagnostics.test(line);
function compactText(text, mode, toolName) {
  // Never rewrite actual source files, patches, snapshots, approval text or image data.
  const eligible = /(?:run_command|tasks_status|git_log|git_diff|search_files|github_|web_|docs_search|test_|browser_console|browser_network|dependency_lookup)/.test(toolName);
  if (!eligible) return text;
  const min = mode === 'aggressive' ? 2200 : mode === 'balanced' ? 4500 : 7500;
  if (text.length < min) return text;
  let value = text;
  // Headroom-style lossless JSON whitespace reduction first.
  if (/^\s*[\[{]/.test(value)) {
    try { value = JSON.stringify(JSON.parse(value)); } catch { /* ordinary tool text */ }
  }
  // RTK-style log noise collapse, retaining summaries and all diagnostic lines.
  const lines = value.split(/\r?\n/);
  if (lines.length > 50) {
    const reduced = [];
    let previous = null, repeats = 0;
    const flush = () => {
      if (previous !== null) reduced.push(previous);
      if (repeats > 1) reduced.push('[same line repeated ' + (repeats - 1) + ' more times]');
    };
    for (const line of lines) {
      if (line === previous && !hasImportantText(line)) { repeats += 1; continue; }
      flush(); previous = line; repeats = 1;
    }
    flush();
    value = reduced.join('\n');
  }
  const max = mode === 'aggressive' ? 4200 : mode === 'balanced' ? 7000 : 11500;
  if (value.length <= max) return value;
  const rows = value.split('\n');
  const head = mode === 'aggressive' ? 20 : 36;
  const tail = mode === 'aggressive' ? 22 : 40;
  const kept = new Set();
  for (let i = 0; i < Math.min(head, rows.length); i++) kept.add(i);
  for (let i = Math.max(0, rows.length - tail); i < rows.length; i++) kept.add(i);
  // Every diagnostic is kept up to a fixed hard cap. Long diagnostics stay near their true line positions.
  const matches = [];
  for (let i = head; i < rows.length - tail; i++) if (hasImportantText(rows[i])) matches.push(i);
  for (const i of matches.slice(0, 60)) {
    for (let j = Math.max(head, i - 1); j <= Math.min(rows.length - tail - 1, i + 1); j++) kept.add(j);
  }
  const positions = [...kept].sort((a,b) => a-b);
  const result = [];
  let last = -1;
  for (const i of positions) {
    if (last >= 0 && i > last + 1) result.push('[... ' + (i - last - 1) + ' lines omitted ...]');
    result.push(rows[i].slice(0, 1500));
    last = i;
  }
  if (matches.length > 60) result.push('[+ ' + (matches.length - 60) + ' diagnostic matches available in raw receipt]');
  return result.join('\n');
}
export function optimizeToolResult(result, { taskId, toolName = '' } = {}) {
  const stats = session(taskId);
  if (!taskId || stats.mode === 'off' || result?.isError === true || !result || !Array.isArray(result.content)) return result;
  if (String(toolName).endsWith('token_restore') || String(toolName).endsWith('token_stats') || String(toolName).endsWith('token_profile')) return result;
  const copy = { ...result, content: result.content.map(item => ({ ...item })) };
  let changed = false;
  for (const item of copy.content) {
    if (item.type !== 'text' || typeof item.text !== 'string') continue;
    const original = item.text;
    const reduced = compactText(original, stats.mode, toolName);
    if (reduced.length >= original.length - 200) continue;
    const id = storeOriginal(taskId, toolName, original);
    item.text = '[TOKEN OPTIMIZED: ' + stats.mode + ', raw receipt ' + id + '; call local.token_restore with id/offset/limit for exact original]\n' + reduced;
    if (item.text.length >= original.length) { item.text = original; originals.delete(id); storedChars -= original.length; continue; }
    stats.inputChars += original.length;
    stats.outputChars += item.text.length;
    stats.compressed += 1;
    changed = true;
  }
  // structuredContent frequently duplicates content and can dwarf the text reduction.
  // Preserve small structured status/proof; raw full result remains in the persisted transcript.
  if (changed && copy.structuredContent && JSON.stringify(copy.structuredContent).length > 6000) {
    const object = copy.structuredContent;
    copy.structuredContent = Object.fromEntries(['exitCode', 'kind', 'status', 'count', 'failed', 'passed', 'timedOut', 'cancelled', 'taskId', 'error']
      .filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
    copy.structuredContent.optimizedForModel = true;
  }
  return changed ? copy : result;
}
export const TOKEN_AGENT_INSTRUCTIONS = [
  'TOKEN DISCIPLINE (Caveman-inspired concise communication, not an external service):',
  'Choose concise, information-dense status updates and final answers. Keep code, commands, paths, safety warnings and test evidence exact.',
  'Read targeted file ranges; avoid re-reading identical source. Use structured tools over verbose shell output.',
  'Tool outputs may show token receipts; call local.token_restore for an exact original segment if a necessary fact was omitted.',
  'Do not treat a compressed summary as complete proof. Do not invent test status or infer missing details from truncation.',
].join('\n');
