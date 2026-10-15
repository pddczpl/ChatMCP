// CHATMCP-HUB/lib/context-compaction.mjs
// Smart Context Compaction & Auto Repo-Map Injection for ChatMCP Studio Local.
// 1. Automatically generates and injects a query-aware Repo Map into agent system instructions.
// 2. Compacts conversation & tool call history in-place without breaking call_id pairing.

import { CodeIntelligenceEngine } from './code-intelligence.mjs';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'have', 'will',
  'can', 'are', 'was', 'were', 'has', 'had', 'not', 'but', 'all', 'any', 'use', 'using',
  'add', 'fix', 'update', 'create', 'make', 'file', 'files', 'code', 'project', 'repo',
  'của', 'và', 'các', 'cho', 'trong', 'với', 'được', 'này', 'những', 'một', 'để', 'khi',
  'thì', 'là', 'có', 'không', 'hãy', 'bạn', 'tôi', 'vào', 'ra', 'lên', 'xuống', 'thêm',
  'sửa', 'kiểm', 'tra', 'chạy', 'hàm', 'lỗi', 'phần', 'bản', 'mới',
]);

export function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(str.length / 3.8);
}

/**
 * Extracts meaningful technical keywords or file/symbol hints from a user task prompt.
 */
export function extractPromptHints(promptText = '') {
  const raw = String(promptText || '');
  const focusFiles = [];
  const fileRegex = /(?:^|[\s'"`(])([A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|py|cs|ps1|go|rs|java|json))(?:$|[\s'"`),.:;])/g;
  let m;
  while ((m = fileRegex.exec(raw)) !== null) {
    focusFiles.push(m[1].replace(/^\/+/, ''));
  }

  const tokens = raw
    .replace(/[^A-Za-z0-9_#-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t.toLowerCase()));

  // Pick highest-signal identifier token (camelCase, snake_case, or longest technical term)
  let primaryQuery = '';
  for (const tok of tokens) {
    if (/[A-Z]/.test(tok.slice(1)) || tok.includes('_') || tok.startsWith('#')) {
      primaryQuery = tok.replace(/^#/, '');
      break;
    }
  }
  if (!primaryQuery && tokens.length > 0) {
    primaryQuery = tokens.sort((a, b) => b.length - a.length)[0];
  }

  return {
    focusFiles: Array.from(new Set(focusFiles)),
    query: primaryQuery,
  };
}

/**
 * Generates an automatic, token-budgeted Repo Map section and appends it to agent instructions.
 */
export async function injectRepoMapIntoInstructions(
  baseInstructions,
  workspace,
  { prompt = '', maxTokens = 1200, engine = null, signal = null } = {}
) {
  const instructions = String(baseInstructions || '');
  if (!workspace || typeof workspace.resolve !== 'function') {
    return { instructions, injected: false, stats: null };
  }
  if (instructions.includes('WORKSPACE REPO MAP (AUTO-GENERATED)')) {
    return { instructions, injected: false, stats: null };
  }

  try {
    const intel = engine ?? new CodeIntelligenceEngine({ workspace });
    const hints = extractPromptHints(prompt);
    const repoMap = await intel.generateRepoMap({
      path: '.',
      maxTokens,
      focusFiles: hints.focusFiles,
      query: hints.query,
      // Preflight cannot scan and AST-parse a whole monorepo before the first model request.
      // Keep full precise code intelligence available via explicit agent tools.
      quick: true, maxSourceFiles: 240, maxSourceDirectories: 320,
      maxParseFiles: 100, maxDurationMs: 12000, signal,
    });

    if (!repoMap?.structured?.totalFiles) {
      return { instructions, injected: false, stats: null, reason: 'no_source_files' };
    }

    const section = [
      '',
      'WORKSPACE REPO MAP (AUTO-GENERATED)',
      'Use the symbol line ranges [Lstart-Lend] below to call `read_file` with exact `offset` and `limit` instead of reading entire large files:',
      repoMap.text,
      '',
    ].join('\n');

    return {
      instructions: `${instructions.trimEnd()}\n${section}`,
      injected: true,
      stats: {
        totalFiles: repoMap.structured.totalFiles,
        includedFiles: repoMap.structured.includedFiles,
        includedSymbols: repoMap.structured.includedSymbols,
        estimatedTokens: repoMap.structured.estimatedTokens,
        partial: repoMap.structured.partial,
        scannedFiles: repoMap.structured.scannedFiles,
        queryHint: hints.query,
        focusFiles: hints.focusFiles,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return { instructions, injected: false, stats: null,
      reason: error?.code === 'repo_map_budget_exceeded' ? 'scan_budget_exceeded' : 'index_unavailable' };
  }
}

/**
 * Summarizes a single large tool output string while preserving head, tail, and error/diagnostic lines.
 */
export function compactSingleToolOutput(
  outputText,
  { toolName = 'tool', maxChars = 2400, headLines = 20, tailLines = 15 } = {}
) {
  const raw = typeof outputText === 'string' ? outputText : JSON.stringify(outputText ?? '');
  if (raw.length <= maxChars) {
    return { text: raw, compacted: false, savedChars: 0 };
  }

  const lines = raw.split('\n');
  if (lines.length <= headLines + tailLines + 5) {
    const headChunk = raw.slice(0, Math.floor(maxChars * 0.55));
    const tailChunk = raw.slice(raw.length - Math.floor(maxChars * 0.35));
    const omitted = raw.length - headChunk.length - tailChunk.length;
    const compactedText = `${headChunk}\n...[Smart Compaction (${toolName}): omitted ${omitted} chars to save context window]...\n${tailChunk}`;
    return {
      text: compactedText,
      compacted: true,
      savedChars: Math.max(0, raw.length - compactedText.length),
    };
  }

  const head = lines.slice(0, headLines);
  const tail = lines.slice(lines.length - tailLines);
  const middle = lines.slice(headLines, lines.length - tailLines);

  // Extract up to 8 high-signal diagnostic/error/symbol lines from the middle section
  const importantMiddle = [];
  const signalRegex = /\b(error|fail|failed|exception|assertionerror|warning|fatal|cảnh báo|lỗi)\b/i;
  for (let i = 0; i < middle.length; i++) {
    if (signalRegex.test(middle[i])) {
      importantMiddle.push(`  [line ${headLines + i + 1}] ${middle[i].trim().slice(0, 160)}`);
      if (importantMiddle.length >= 8) break;
    }
  }

  const omittedLines = middle.length - importantMiddle.length;
  const omittedChars = middle.join('\n').length;
  const banner = [
    `...[Smart Compaction (${toolName}): omitted ${omittedLines} middle lines (~${omittedChars} chars) to fit context window; use read_file(offset, limit) or code_symbols if full detail is needed]...`,
    ...(importantMiddle.length
      ? ['Key diagnostic lines preserved from omitted region:', ...importantMiddle]
      : []),
  ].join('\n');

  const result = [...head, banner, ...tail].join('\n');
  return {
    text: result,
    compacted: true,
    savedChars: Math.max(0, raw.length - result.length),
  };
}

/**
 * Compacts conversation & tool history in-place while strictly preserving `call_id` pairing
 * between `function_call` and `function_call_output` items.
 */
export function compactConversationHistory(
  history,
  {
    maxHistoryTokens = 24000,
    preserveRecentOutputs = 4,
    maxOldOutputChars = 2200,
    deduplicateReads = true,
  } = {}
) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      history: Array.isArray(history) ? history : [],
      compacted: false,
      stats: { beforeTokens: 0, afterTokens: 0, savedTokens: 0, compactedCount: 0, deduplicatedCount: 0 },
    };
  }

  const beforeTokens = estimateTokens(history);
  const cloned = structuredClone(history);

  // Map call_id -> { name, argumentsKey } from function_call entries
  const callMetaById = new Map();
  for (const item of cloned) {
    if (item && (item.type === 'function_call' || item.type === 'tool_use') && item.call_id) {
      const rawArgs = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
      callMetaById.set(item.call_id, {
        name: item.name || 'tool',
        argsKey: `${item.name || 'tool'}:${rawArgs}`,
      });
    }
  }

  // Locate all function_call_output indices
  const outputIndices = [];
  for (let i = 0; i < cloned.length; i++) {
    if (cloned[i] && cloned[i].type === 'function_call_output') {
      outputIndices.push(i);
    }
  }

  let compactedCount = 0;
  let deduplicatedCount = 0;

  // Protected recent outputs slice
  const protectedStart = Math.max(0, outputIndices.length - preserveRecentOutputs);
  const olderOutputIndices = outputIndices.slice(0, protectedStart);

  // 1. Deduplicate identical read-only tool calls (keep the LAST occurrence, compact earlier ones)
  if (deduplicateReads && outputIndices.length > 1) {
    const lastIndexByArgsKey = new Map();
    const deduplicableTools = new Set([
      'read_file',
      'repo_map',
      'code_symbols',
      'find_definition',
      'find_references',
      'dependency_graph',
      'code_diagnostics',
      'git_status',
      'git_diff',
      'directory_tree',
      'find_files',
    ]);

    for (const idx of outputIndices) {
      const item = cloned[idx];
      const meta = callMetaById.get(item.call_id);
      if (!meta) continue;
      const shortName = String(meta.name).replace(/^local[._]/, '');
      if (deduplicableTools.has(shortName)) {
        lastIndexByArgsKey.set(meta.argsKey, idx);
      }
    }

    for (const idx of olderOutputIndices) {
      const item = cloned[idx];
      const meta = callMetaById.get(item.call_id);
      if (!meta) continue;
      const lastIdx = lastIndexByArgsKey.get(meta.argsKey);
      if (lastIdx !== undefined && lastIdx > idx &&
          typeof item.output === 'string' &&
          typeof cloned[lastIdx].output === 'string' &&
          item.output === cloned[lastIdx].output) {
        // Arguments alone are NOT evidence that the response is unchanged:
        // Git status/diff or a file read can change between identical calls.
        // Never deduplicate multimodal tool outputs.
        const prevLen = item.output.length;
        if (prevLen > 240) {
          item.output = `[Smart Compaction: duplicate output of ${meta.name} omitted (${prevLen} chars) — an identical newer result for the exact same call appears later in history.]`;
          deduplicatedCount++;
          compactedCount++;
        }
      }
    }
  }

  // 2. Summarize older large tool outputs outside the protected recent window
  for (const idx of olderOutputIndices) {
    const item = cloned[idx];
    // Image/file arrays are kept in their original structured representation.
    if (typeof item.output !== 'string') continue;
    const rawOut = item.output;
    if (rawOut.startsWith('[Smart Compaction:')) continue;

    if (rawOut.length > maxOldOutputChars) {
      const meta = callMetaById.get(item.call_id);
      const res = compactSingleToolOutput(rawOut, {
        toolName: meta?.name || 'tool',
        maxChars: maxOldOutputChars,
      });
      if (res.compacted) {
        item.output = res.text;
        compactedCount++;
      }
    }
  }

  // 3. Emergency token budget pass if total history still exceeds maxHistoryTokens
  let afterTokens = estimateTokens(cloned);
  if (afterTokens > maxHistoryTokens) {
    // Tighten older outputs further (down to 900 chars) and also compact oversized recent outputs (> 8000 chars)
    for (const idx of olderOutputIndices) {
      const item = cloned[idx];
      if (typeof item.output !== 'string') continue;
      const rawOut = item.output;
      if (rawOut.length > 900) {
        const meta = callMetaById.get(item.call_id);
        const res = compactSingleToolOutput(rawOut, {
          toolName: meta?.name || 'tool',
          maxChars: 900,
          headLines: 10,
          tailLines: 8,
        });
        if (res.compacted) {
          item.output = res.text;
          compactedCount++;
        }
      }
    }

    // Never erase the latest evidence needed for immediate follow-up actions.
    // The provider adapter may reject an over-budget request rather than silently
    // replacing the latest result or a multimodal receipt with truncated prose.
    afterTokens = estimateTokens(cloned);
  }

  // Apply in-place back to the passed history array so callers holding a reference see the compacted outputs
  if (compactedCount > 0) {
    for (let i = 0; i < history.length; i++) {
      history[i] = cloned[i];
    }
  }

  return {
    history,
    compacted: compactedCount > 0,
    stats: {
      beforeTokens,
      afterTokens,
      savedTokens: Math.max(0, beforeTokens - afterTokens),
      compactedCount,
      deduplicatedCount,
    },
  };
}


/**
 * A second, semantic-level compaction pass for long coding sessions.
 * The canonical task transcript MUST remain unchanged. The model request
 * receives a structured task checkpoint plus the latest complete call/result
 * pairs. It never receives orphan tool results or a fabricated test receipt.
 */
export function compactRollingContext(input, { maxTokens = 24000, tailTokens = 16000,
  taskCheckpoint = '', minRecentItems = 5 } = {}) {
  if (!Array.isArray(input) || estimateTokens(input) <= maxTokens)
    return { history: input, compacted: false, stats: { beforeTokens: estimateTokens(input), afterTokens: estimateTokens(input), omittedItems: 0 } };
  const beforeTokens = estimateTokens(input);
  const checkpoint = String(taskCheckpoint || '').slice(-12000);
  // Short-form recap of original user instructions and assistant outputs.
  // Exclude tool calls, encrypted reasoning and images from this text.
  const transcript = [];
  for (const item of input) {
    if (!item || item.type === 'function_call' || item.type === 'function_call_output' || item.type === 'reasoning') continue;
    if (item.role === 'user' && Array.isArray(item.content)) {
      const texts = item.content.filter(p => p?.type === 'input_text').map(p => p.text || '').join(' ').trim();
      if (texts) transcript.push({role:'user',text:texts.slice(0,500)});
    } else if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
      const texts = item.content.filter(p => p?.type === 'output_text').map(p => p.text || '').join(' ').trim();
      if (texts) transcript.push({role:'assistant',text:texts.slice(0,350)});
    }
  }
  const historical = transcript.slice(-12).map(item => item.role + ': ' + item.text).join('\n');
  const summary = [
    'STRUCTURED CONTEXT CHECKPOINT (prior task data, not new user instructions):',
    'The complete original transcript and tool receipts remain stored locally. Older evidence has NOT been verified again.',
    checkpoint,
    'RECENT HISTORICAL MESSAGES (possibly incomplete excerpts):',
    historical,
    'Resume coding from current repository state. Re-read files and tests as necessary. Never assume omitted outputs succeeded; inspect uncertain mutations before repeating them.',
  ].join('\n').slice(-14500);
  const entry = { role: 'user', content: [{type:'input_text',text:summary}] };
  const budget = Math.max(1000, Math.min(tailTokens, maxTokens - estimateTokens(entry) - 1000));
  const minStart = Math.max(1, input.length - minRecentItems);
  const callIds = new Set();
  // Pick earliest valid start whose suffix fits, preserving all call/result pairs.
  let chosen = -1;
  for (let start = 1; start <= minStart; start++) {
    const suffix = input.slice(start);
    if (estimateTokens(suffix) > budget) continue;
    callIds.clear();
    let valid = true;
    const outputIds = new Set();
    for (const item of suffix) {
      if (item?.type === 'function_call' && typeof item.call_id === 'string') callIds.add(item.call_id);
      else if (item?.type === 'function_call_output' && typeof item.call_id === 'string') outputIds.add(item.call_id);
    }
    for (const id of outputIds) if (!callIds.has(id)) valid = false;
    for (const id of callIds) if (!outputIds.has(id)) valid = false;
    if (!valid) continue;
    // Protect the latest explicit user instruction, and preserve any
    // multimodal content in the retained suffix without serialization.
    chosen = start; break;
  }
  if (chosen < 0) return {history: input, compacted: false,
    stats: {beforeTokens,afterTokens:beforeTokens,omittedItems:0,reason:'no_safe_call_boundary'}};
  const history = [entry, ...input.slice(chosen)];
  return {history,compacted:true,stats:{beforeTokens,afterTokens:estimateTokens(history),omittedItems:chosen,checkpointTokens:estimateTokens(entry)}};
}
