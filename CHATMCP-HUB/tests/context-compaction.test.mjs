// CHATMCP-HUB/tests/context-compaction.test.mjs
// Automated test suite for CHATMCP-HUB/lib/context-compaction.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';

const mod = await import('../lib/context-compaction.mjs').catch(() => import('./context-compaction.mjs'));
const {
  estimateTokens,
  extractPromptHints,
  injectRepoMapIntoInstructions,
  compactSingleToolOutput,
  compactConversationHistory,
} = mod;

async function createMockWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-compaction-test-'));
  await fs.mkdir(path.join(root, 'lib'), { recursive: true });

  await fs.writeFile(
    path.join(root, 'lib', 'agent.mjs'),
    `import { validateArguments } from './tool-schema.mjs';
export class AgentRunner {
  async runTask(prompt) {
    return validateArguments({}, { prompt });
  }
}
`,
    'utf8'
  );

  await fs.writeFile(
    path.join(root, 'lib', 'tool-schema.mjs'),
    `export function validateArguments(schema, input) {
  return { ok: true, value: input };
}
`,
    'utf8'
  );

  // Production workspace, not a hand-written double that carries a path property StudioWorkspace does not have.
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-compaction-state-'));
  return {
    workspace: new StudioWorkspace({ manager: { workspace: root, secrets: [] }, directory: stateDirectory }),
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(stateDirectory, { recursive: true, force: true });
    },
  };
}

async function runTests() {
  console.log('Running ChatMCP Smart Context Compaction test suite...');
  const { workspace, cleanup } = await createMockWorkspace();

  try {
    // Test 1: Extract technical hints and file paths from user prompt
    const hints = extractPromptHints('Hãy kiểm tra hàm validateArguments trong file lib/agent.mjs và sửa lỗi');
    assert(hints.focusFiles.includes('lib/agent.mjs'), 'Should detect lib/agent.mjs');
    assert.equal(hints.query, 'validateArguments', 'Should prioritize camelCase identifier validateArguments');
    console.log('  [PASS] 1. Prompt technical hint & focus file extraction');

    // Test 2: Auto-inject Repo Map into instructions (and idempotency check)
    const baseInst = 'You are ChatMCP local coding agent.';
    const injected1 = await injectRepoMapIntoInstructions(baseInst, workspace, {
      prompt: 'Fix AgentRunner in lib/agent.mjs',
      maxTokens: 800,
    });
    assert.equal(injected1.injected, true, 'Should inject Repo Map on first call');
    assert(injected1.instructions.includes('WORKSPACE REPO MAP (AUTO-GENERATED)'));
    assert(injected1.instructions.includes('lib/agent.mjs'));
    assert(injected1.instructions.includes('AgentRunner'));

    const injected2 = await injectRepoMapIntoInstructions(injected1.instructions, workspace);
    assert.equal(injected2.injected, false, 'Should not duplicate Repo Map if already present');
    console.log('  [PASS] 2. Auto-inject Repo Map into system instructions & idempotency');

    // Test 3: Single large tool output compaction preserves head, tail, and error lines
    const bigLines = [];
    for (let i = 1; i <= 120; i++) {
      if (i === 60) {
        bigLines.push(`Line ${i}: AssertionError [ERR_ASSERTION]: critical failure in module X`);
      } else {
        bigLines.push(`Line ${i}: ${'x'.repeat(50)}`);
      }
    }
    const bigOutput = bigLines.join('\n');
    const singleCompacted = compactSingleToolOutput(bigOutput, {
      toolName: 'run_command',
      maxChars: 1500,
      headLines: 10,
      tailLines: 10,
    });
    assert.equal(singleCompacted.compacted, true);
    assert(singleCompacted.text.includes('Line 1:'));
    assert(singleCompacted.text.includes('Line 120:'));
    assert(
      singleCompacted.text.includes('AssertionError [ERR_ASSERTION]: critical failure in module X'),
      'Must preserve middle error diagnostic line'
    );
    assert(singleCompacted.savedChars > 3000);
    console.log('  [PASS] 3. Single tool output compaction with error-line preservation');

    // Test 4: Conversation history compaction (deduplicates repeated reads & preserves call_id pairing)
    const longReadContent = Array.from({ length: 80 }, (_, i) => `${i + 1}: const a_${i} = ${i}; // padding text`).join('\n');
    const history = [
      { role: 'user', content: 'Inspect lib/agent.mjs' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"lib/agent.mjs"}' },
      { type: 'function_call_output', call_id: 'call_1', output: longReadContent },
      { type: 'function_call', call_id: 'call_2', name: 'search_files', arguments: '{"pattern":"validate"}' },
      { type: 'function_call_output', call_id: 'call_2', output: longReadContent },
      // Duplicate read_file of lib/agent.mjs later in history:
      { type: 'function_call', call_id: 'call_3', name: 'read_file', arguments: '{"path":"lib/agent.mjs"}' },
      { type: 'function_call_output', call_id: 'call_3', output: longReadContent },
      { type: 'function_call', call_id: 'call_4', name: 'git_status', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_4', output: 'On branch main\nnothing to commit' },
    ];

    const res = compactConversationHistory(history, {
      preserveRecentOutputs: 2, // protects call_3 and call_4, compacts call_1 and call_2
      maxOldOutputChars: 800,
      deduplicateReads: true,
    });

    assert.equal(res.compacted, true);
    assert.equal(res.stats.deduplicatedCount, 1, 'call_1 should be deduplicated because call_3 reads the same file');
    assert(history[2].output.includes('duplicate output of read_file omitted'), 'call_1 output replaced with receipt');
    assert(history[4].output.includes('Smart Compaction (search_files)'), 'call_2 large output summarized');
    assert.equal(history[6].output, longReadContent, 'Recent call_3 output must remain untouched');
    // Verify call_id pairing is 100% intact
    const callIds = history.filter((h) => h.type === 'function_call').map((h) => h.call_id);
    const outIds = history.filter((h) => h.type === 'function_call_output').map((h) => h.call_id);
    assert.deepEqual(callIds, ['call_1', 'call_2', 'call_3', 'call_4']);
    assert.deepEqual(outIds, ['call_1', 'call_2', 'call_3', 'call_4']);
    assert(res.stats.savedTokens > 500);
    console.log('  [PASS] 4. In-place history compaction, duplicate read pruning & call_id pairing integrity');

    console.log('\nALL 4 SMART CONTEXT COMPACTION TEST SUITES PASSED!');
  } finally {
    await cleanup();
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exitCode = 1;
});
