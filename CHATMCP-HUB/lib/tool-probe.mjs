// Can this model call tools? A coding agent that cannot is useless, and the failure otherwise shows up late: on the first
// real task, as a confusing error. This sends ONE tiny request with ONE harmless fake tool and reports what happened.
// It sends no project content, makes no retries, and the fake tool is never executed.
import { buildAnthropicBody, normalizeAnthropic } from './anthropic-api.mjs';
import { buildChatBody, normalizeChatCompletion } from './openai-chat-api.mjs';
import { errorDetail } from './model-http.mjs';

const PROBE_TOOL = Object.freeze({
  name: 'record_probe',
  description: 'Records a connectivity probe value. Call it exactly once.',
  parameters: { type: 'object', properties: { value: { type: 'string', description: 'The text to record.' } }, required: ['value'] },
});
const INSTRUCTIONS = 'This is an automated connectivity test. Always answer by calling the provided function.';
const PROMPT = 'Call the function record_probe with the value "ok".';
const NO_TOOLS = /(?:does(?:n'?t| not) support (?:tools?|function)|tools? (?:is|are) not supported|tool use is not supported|function calling is not supported|unsupported (?:parameter|field)s?:? ?'?tools?|invalid parameter: ?'?tools?|tools? .*not (?:available|enabled))/i;

/**
 * @returns {Promise<{status: 'supported'|'unsupported'|'unreliable'|'unknown', note: string}>}
 *   supported   the model answered with a call to the probe function
 *   unsupported the provider refused the request because the model has no tool support
 *   unreliable  the request was accepted but the model answered in text instead of calling the function
 *   unknown     the probe could not be completed (network, rate limit, unexpected answer); says nothing about the model
 */
export async function probeToolCalling({ protocol, endpoint, headers, model, fetch: fetchImpl, signal, redact = (text) => text, timeoutMs = 8000 }) {
  if (protocol !== 'anthropic' && protocol !== 'openai-chat') return { status: 'unknown', note: 'Giao thức này không có bước thăm dò công cụ; tool calling được dò khi chạy tác vụ thật.' };
  signal?.throwIfAborted();
  const input = [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }];
  const body = protocol === 'anthropic'
    ? buildAnthropicBody({ model, input, instructions: INSTRUCTIONS, tools: [PROBE_TOOL], maxOutputTokens: 256 })
    : buildChatBody({ model, input, instructions: INSTRUCTIONS, tools: [PROBE_TOOL] });
  let response, raw;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    raw = (await response.text()).slice(0, 64000);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return { status: 'unknown', note: `Chưa thăm dò được tool calling: ${redact(error?.name === 'TimeoutError' ? 'quá thời gian chờ' : (error?.message || 'lỗi kết nối'))}.` };
  }
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  if (!response.ok) {
    const detail = redact(errorDetail(data));
    if ((response.status === 400 || response.status === 404 || response.status === 422 || response.status === 501) && NO_TOOLS.test(detail)) {
      return { status: 'unsupported', note: `Model hoặc máy chủ này không hỗ trợ tool calling${detail ? ` (${detail.slice(0, 200)})` : ''}. Agent cần tool calling để đọc/sửa file và chạy lệnh; chọn model khác.` };
    }
    return { status: 'unknown', note: `Chưa thăm dò được tool calling (HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}).` };
  }
  let normalized;
  try { normalized = protocol === 'anthropic' ? normalizeAnthropic(data) : normalizeChatCompletion(data); }
  catch { return { status: 'unknown', note: 'Chưa thăm dò được tool calling: phản hồi không đúng định dạng.' }; }
  const called = normalized.output.find((item) => item.type === 'function_call');
  if (called?.name === PROBE_TOOL.name) return { status: 'supported', note: 'Model gọi công cụ đúng cách.' };
  if (called) return { status: 'unreliable', note: `Model gọi một hàm không tồn tại (${String(called.name).slice(0, 60)}); tool calling có thể không đáng tin.` };
  return { status: 'unreliable', note: 'Model trả lời bằng văn bản thay vì gọi hàm khi được yêu cầu rõ. Tool calling có thể không đáng tin với model này; hãy thử Review mode và kiểm tra kỹ kết quả, hoặc chọn model khác.' };
}
