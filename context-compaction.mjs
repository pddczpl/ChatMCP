// DATGOLD-HUB/lib/context-compaction.mjs
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
  { prompt = '', maxTokens = 1200, engine = null } = {}
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
    });

    if (!repoMap?.structured?.totalFiles) {
      return { instructions, injected: false, stats: null };
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
        queryHint: hints.query,
        focusFiles: hints.focusFiles,
      },
    };
  } catch {
    return { instructions, injected: false, stats: null };
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
      if (lastIdx !== undefined && lastIdx > idx) {
        const prevLen = String(item.output || '').length;
        if (prevLen > 240) {
          item.output = `[Smart Compaction: duplicate output of ${meta.name} omitted (${prevLen} chars) — a newer result for the exact same call appears later in history.]`;
          deduplicatedCount++;
          compactedCount++;
        }
      }
    }
  }

  // 2. Summarize older large tool outputs outside the protected recent window
  for (const idx of olderOutputIndices) {
    const item = cloned[idx];
    const rawOut = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
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
      const rawOut = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
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

    const recentIndices = outputIndices.slice(protectedStart);
    for (const idx of recentIndices) {
      const item = cloned[idx];
      const rawOut = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      if (rawOut.length > 8000) {
        const meta = callMetaById.get(item.call_id);
        const res = compactSingleToolOutput(rawOut, {
          toolName: meta?.name || 'tool',
          maxChars: 6000,
          headLines: 45,
          tailLines: 30,
        });
        if (res.compacted) {
          item.output = res.text;
          compactedCount++;
        }
      }
    }

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
