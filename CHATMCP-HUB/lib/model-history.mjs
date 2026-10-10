// Helpers shared by the model adapters. They work on the conversation format the agent keeps internally:
//   { role:'user', content:[{type:'input_text', text}] }
//   { type:'message', role:'assistant', content:[{type:'output_text', text}], phase }
//   { type:'function_call', call_id, name, arguments:'<json>' }
//   { type:'function_call_output', call_id, output }
import { createHash } from 'node:crypto';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** Plain text of a message `content` (string, or a list of text parts). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('\n');
}

/** What a tool result looks like to a model that only reads text. */
export function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((part) => {
      if (part?.type === 'input_text') return part.text || '';
      if (part?.type === 'input_image') return '[Image returned by a tool. This model adapter cannot inspect images; do not claim to have viewed it.]';
      return JSON.stringify(part);
    }).join('\n');
  }
  return JSON.stringify(output ?? null);
}

/** Arguments of a function call as an object; anything that is not a JSON object becomes {}. */
export function parseArguments(value) {
  if (isObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try { const parsed = JSON.parse(value); return isObject(parsed) ? parsed : {}; } catch { return {}; }
}

/**
 * Anthropic accepts tool-use ids that match ^[a-zA-Z0-9_-]{1,64}$. Ids produced by other providers (UUIDs with dots,
 * long ids, ...) are mapped to a stable valid id so the call and its result still refer to each other.
 */
export function safeToolId(callId) {
  const text = String(callId ?? '');
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(text)) return text;
  return `toolu_${createHash('sha256').update(text).digest('hex').slice(0, 24)}`;
}

/**
 * Calls without a result and results without a call make most APIs answer HTTP 400. This should not happen inside
 * one run, but a model that is switched mid-session or an interrupted run can leave one behind. Missing results
 * become an explicit error (never silently "succeeded"), orphan results are dropped.
 */
export function pairToolCalls(history) {
  const answered = new Set(history.filter((item) => item?.type === 'function_call_output').map((item) => item.call_id));
  const called = new Set(history.filter((item) => item?.type === 'function_call').map((item) => item.call_id));
  const result = [];
  const pending = [];
  const flush = () => {
    for (const call of pending.splice(0)) {
      if (!answered.has(call.call_id)) result.push({ type: 'function_call_output', call_id: call.call_id, output: 'Không có kết quả cho lời gọi này (phiên bị gián đoạn). Hãy kiểm tra trạng thái thật trước khi giả định nó đã chạy hoặc chưa chạy.' });
    }
  };
  for (const item of history) {
    if (item?.type === 'function_call') { result.push(item); pending.push(item); continue; }
    if (item?.type === 'function_call_output') {
      if (!called.has(item.call_id)) continue;
      const index = pending.findIndex((call) => call.call_id === item.call_id);
      if (index >= 0) pending.splice(index, 1);
      result.push(item);
      continue;
    }
    // Any other item ends the group of results that belong to the previous model turn.
    flush();
    result.push(item);
  }
  flush();
  return result;
}

/** Size of the conversation as it will be sent (UTF-8 bytes of its JSON form). */
export function historyBytes(history) {
  return Buffer.byteLength(JSON.stringify(history), 'utf8');
}

/** Cheap token estimate: about 3.5 bytes per token for code and prose mixed. Good enough for budgets, not for billing. */
export function estimateTokens({ input = [], instructions = '', tools = [] } = {}) {
  const bytes = historyBytes(input) + Buffer.byteLength(String(instructions), 'utf8') + Buffer.byteLength(JSON.stringify(tools), 'utf8');
  return Math.ceil(bytes / 3.5);
}

const STUB_HEAD = 240;
function stub(label, original) {
  const text = outputText(original);
  const head = text.slice(0, STUB_HEAD).replace(/\s+/g, ' ').trim();
  return `[${label}: ${text.length} ký tự đã rút gọn để vừa ngữ cảnh của model. Đầu nội dung: "${head}${text.length > STUB_HEAD ? '…' : ''}". Gọi lại công cụ nếu cần đọc lại.]`;
}
function shrinkStrings(value, limit) {
  if (typeof value === 'string') return value.length > limit ? `[đã rút gọn ${value.length} ký tự]` : value;
  if (Array.isArray(value)) return value.map((entry) => shrinkStrings(entry, limit));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shrinkStrings(entry, limit)]));
  return value;
}

/**
 * Make the conversation fit a byte budget WITHOUT touching what the model needs most: the user's messages and the
 * latest turns stay as they are. Older tool results (the bulk of a coding session: file reads, command output) are
 * replaced by a short stub, then large arguments of older calls (file contents that were written) are shortened. The
 * full history stays in the agent; only the copy that is sent is smaller, and every stub says how to get the data back.
 *
 * @returns {{history: object[], changed: boolean, before: number, after: number, fits: boolean}}
 */
export function compactHistory(history, { maxBytes, keepRecent = 10 } = {}) {
  const before = historyBytes(history);
  if (!Number.isFinite(maxBytes) || before <= maxBytes) return { history, changed: false, before, after: before, fits: true };
  const copy = structuredClone(history);
  const protectedFrom = Math.max(0, copy.length - keepRecent);
  let size = before;
  const apply = (index, replacement) => {
    const old = historyBytes(copy[index]);
    copy[index] = replacement;
    size += historyBytes(replacement) - old;
  };
  // 1. Oldest tool results first.
  for (let i = 0; i < protectedFrom && size > maxBytes; i += 1) {
    const item = copy[i];
    if (item?.type !== 'function_call_output') continue;
    if (outputText(item.output).length <= STUB_HEAD * 2) continue;
    apply(i, { ...item, output: stub('Kết quả công cụ cũ', item.output) });
  }
  // 2. Large arguments of older calls, oldest first.
  for (const limit of [4000, 800]) {
    for (let i = 0; i < protectedFrom && size > maxBytes; i += 1) {
      const item = copy[i];
      if (item?.type !== 'function_call' || typeof item.arguments !== 'string' || item.arguments.length < limit) continue;
      const parsed = parseArguments(item.arguments);
      if (!Object.keys(parsed).length) continue;
      apply(i, { ...item, arguments: JSON.stringify(shrinkStrings(parsed, limit)) });
    }
  }
  // 3. Long older assistant text.
  for (let i = 0; i < protectedFrom && size > maxBytes; i += 1) {
    const item = copy[i];
    if (item?.type !== 'message' || item.role !== 'assistant') continue;
    const text = contentText(item.content);
    if (text.length <= 1200) continue;
    apply(i, { ...item, content: [{ type: 'output_text', text: `${text.slice(0, 600)}\n[… ${text.length - 600} ký tự đã rút gọn …]` }] });
  }
  return { history: copy, changed: true, before, after: size, fits: size <= maxBytes };
}
