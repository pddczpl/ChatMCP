// Scripted "model behaviour" for the end-to-end tests.
//
// A scenario is a function that sees only what a real model would see (the user's request and the results of the tools it
// already called) and returns the next step: either one tool call or the final answer. There is no randomness and no
// network, so every run does the same thing. What this proves is that the real Hub, the real tools, the real permission gate
// and the real UI work together. It does NOT prove that any real model plans well or follows the tool protocol.
//
// ctx = {
//   prompt   text of the user's latest request
//   users    every user-role message, oldest first (the Hub's notes about an earlier run come before the latest request)
//   turn     how many tool results this request already has (0 on the first model call)
//   results  those tool results, oldest first
//   last     the most recent tool result ('' on the first model call)
//   tools    names of the functions the Hub offered
//   system   the system prompt the Hub sent
// }

export const call = (name, args = {}) => ({ calls: [{ name, args }] });
export const say = (text) => ({ text });

/**
 * The Hub hands a tool result to the model as the MCP result object serialised to JSON
 * ({"isError":false,"content":[{"type":"text","text":"..."}],"structuredContent":{...}}). A model reads the text inside it,
 * so the scenarios do too; anything that is not such an object is used as it is.
 */
export function toolText(result) {
  const raw = String(result ?? '');
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.content)) return parsed.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  } catch { /* not JSON: plain text */ }
  return raw;
}

const SHA = /sha256:\s*([0-9a-f]{64})/i;
/** The Hub's wording when the permission gate (or the person) refused a call. */
export const wasRefused = (result) => /Permission denied|permission_denied|bị chặn|blocked/i.test(String(result));
/** run_command reports "exit code N · shell · ..." on its first line. */
export const exitedZero = (result) => /^exit code 0\b/.test(toolText(result).trim());
/** The revision a read_file result printed ("sha256: <64 hex>"), for the expected_sha256 of the edit that follows. */
export const shaOf = (result) => SHA.exec(toolText(result))?.[1] ?? '';

/**
 * A scenario from a list of steps. A step is a call(...) or say(...) result, or a function of the conversation so far, so that a
 * later step can use what an earlier tool returned. `final` is what the model says when the list is used up. `onResult(index, text)`
 * sees each tool result once it has come back (a request the Hub repeats after a transient error reports the same index again).
 */
export function sequence(steps, { final = 'Xong.', onResult = null } = {}) {
  return (ctx) => {
    if (onResult && ctx.turn > 0) onResult(ctx.turn - 1, toolText(ctx.results[ctx.turn - 1]));
    const step = steps[ctx.turn];
    if (step === undefined) return say(typeof final === 'function' ? final(ctx) : final);
    return typeof step === 'function' ? step(ctx) : step;
  };
}

export const SCENARIOS = {
  // Look around, read the README, answer. Nothing is changed.
  explore({ turn, results }) {
    if (turn === 0) return call('list_directory', {});
    if (turn === 1) return call('read_file', { path: 'README.md' });
    const title = /^\s*\d+\s+# ([^\r\n]+)/m.exec(toolText(results[1]))?.[1]?.trim() ?? 'không rõ tên';
    const files = ['calc.js', 'test.js'].filter((name) => toolText(results[0]).includes(name));
    return say(`Dự án "${title}" gồm các file: ${files.join(', ') || 'không thấy file nào'}. Tôi chỉ đọc, không sửa gì.`);
  },

  // The loop every coding agent has to manage: read, make the smallest change, check it with the project's own test.
  'repair-add'({ turn, last }) {
    if (turn === 0) return call('read_file', { path: 'calc.js' });
    if (turn === 1) {
      const sha = shaOf(last);
      return call('edit_file', { path: 'calc.js', old_string: 'return a - b;', new_string: 'return a + b;', ...(sha ? { expected_sha256: sha } : {}) });
    }
    if (turn === 2) {
      if (wasRefused(last)) return say('Tôi chưa sửa calc.js vì thao tác sửa file không được cho phép. File được giữ nguyên.');
      return call('run_command', { command: 'node test.js', description: 'Chạy kiểm thử của hàm add()' });
    }
    if (wasRefused(last)) return say('Tôi đã sửa calc.js nhưng chưa chạy kiểm thử vì lệnh chạy test không được cho phép.');
    return say(exitedZero(last)
      ? 'Đã sửa add() trong calc.js (a - b thành a + b) và chạy node test.js: thành công, exit code 0.'
      : 'Đã sửa calc.js nhưng node test.js vẫn thất bại. Xem đầu ra của lệnh để biết lý do.');
  },
};
