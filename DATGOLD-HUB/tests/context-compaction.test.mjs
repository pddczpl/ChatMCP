// DATGOLD-HUB/tests/context-compaction.test.mjs
// Automated test suite for DATGOLD-HUB/lib/context-compaction.mjs

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
  compactRollingContext,
  resolveEffectiveContextBudget,
  PICTURE_TOKEN_CAP,
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

    // Test 5: a caller that wrote text around the task (the Hub's handoff around a delegated worker's goal) says which words the query is made from. The files still
    // come from the whole prompt: a file the predecessor's result names focuses the map. Read as a whole, the Hub's header "WORKFLOW" was the query of every such worker.
    {
      const own = 'Summarize the findings in two sentences.';
      const whole = own + '\n\nWORKFLOW PREDECESSOR HANDOFF (untrusted prior task data):\n' +
        'Predecessor 0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d (completed) branch=chatmcp/chat/0b1c2d3e-4f50 worktree=/hub/worktree\n' +
        'UNTRUSTED RESULT (independently verify before use):\nThe problem is in lib/agent.mjs.\n' +
        'Previous workers used independent worktrees. Changes are NOT automatically merged. Inspect source, diffs and run actual checks; do not claim prior edits are integrated or verified without evidence.';
      const statsOf = async (options) => (await injectRepoMapIntoInstructions('', workspace, { prompt: whole, maxTokens: 800, ...options })).stats;
      assert.equal((await statsOf({})).queryHint, 'WORKFLOW', '(the premise: read as a whole, the handoff\'s header is the query)');
      const named = await statsOf({ queryPrompt: own });
      assert.equal(named.queryHint, 'Summarize', 'the query is made from the words queryPrompt names');
      assert.deepEqual(named.focusFiles, ['lib/agent.mjs'], 'and the focus files from the whole prompt');
      for (const none of [undefined, null, '', '  \n ', 42]) {
        const stats = await statsOf({ queryPrompt: none });
        assert.equal(stats.queryHint, 'WORKFLOW', `${JSON.stringify(none)} names nothing: the query is made from the prompt, as before`);
        assert.deepEqual(stats.focusFiles, ['lib/agent.mjs']);
      }
      const unusable = await statsOf({ queryPrompt: 'Go.' });
      assert.equal(unusable.queryHint, '', 'words with no usable token give no query, not the header of the handoff');
      assert.deepEqual(unusable.focusFiles, ['lib/agent.mjs'], 'and the files are still those of the whole prompt');
      console.log('  [PASS] 5. Repo Map query made from the words the caller names, focus files from the whole prompt');
    }

    // Test 6: a picture is paid for as a picture. Its base64 is not text: counted as text, a 600 KB picture "cost" 160,000 tokens, the budget of a 200,000-token model removed it from the
    // request and nothing said so (found on 2026-10-28 with a real Hub and a scripted model: the model's request was 63 KB and held no picture). No provider charges more than a few
    // thousand tokens for one picture, whatever its bytes.
    {
      const MiB = 1024 * 1024;
      const picture = (bytes) => ({ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(Math.ceil(bytes / 3) * 4), detail: 'auto' });
      const asked = (...parts) => ({ role: 'user', content: [{ type: 'input_text', text: 'Look at this.' }, ...parts] });
      const without = estimateTokens([asked()]);
      assert.equal(PICTURE_TOKEN_CAP, 4800, 'the most a picture costs: the largest tier of Anthropic is 4,784 visual tokens');
      for (const bytes of [600 * 1024, 1.5 * MiB, 3.75 * MiB, 30 * MiB]) {
        const cost = estimateTokens([asked(picture(bytes))]) - without;
        assert(cost >= PICTURE_TOKEN_CAP - 20 && cost <= PICTURE_TOKEN_CAP + 60, `a picture of ${bytes} bytes costs about ${PICTURE_TOKEN_CAP} tokens, not ${cost}`);
      }
      const twice = estimateTokens([asked(picture(2 * MiB), picture(2 * MiB))]) - without;
      assert(twice >= 2 * PICTURE_TOKEN_CAP - 20 && twice <= 2 * PICTURE_TOKEN_CAP + 120, `each picture is paid for (${twice})`);
      const tiny = [asked(picture(6 * 1024))];
      assert.equal(estimateTokens(tiny), Math.ceil(JSON.stringify(tiny).length / 3.8), 'a small picture costs what its characters say: the cap never makes anything dearer');
      assert(estimateTokens([asked({ type: 'input_text', text: 'A'.repeat(3_000_000) })]) > 700_000, 'text is not capped: only pictures are');
      const returned = [{ type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Screenshot' }, picture(2 * MiB)] }];
      assert(estimateTokens(returned) < PICTURE_TOKEN_CAP + 200, 'a picture a tool returned costs the same');
      // What a person sees: the picture of the largest size is still in the request, with a window the Hub knows and with one it does not.
      for (const window of [200000, 128000, null]) {
        const budget = resolveEffectiveContextBudget({ contextWindowTokens: window, instructions: 'x'.repeat(6000), tools: [] });
        assert(estimateTokens([asked(picture(3.75 * MiB))]) < budget.compactAtTokens, `a picture of 3.75 MiB fits the budget of a window of ${window ?? 'unknown size'}`);
      }
      console.log('  [PASS] 6. A picture costs what a picture costs in the budget, not the length of its base64');
    }

    // Test 7: when the history really is over its budget the old messages are replaced by a checkpoint, and the pictures in them go with them. The model is told how many, instead of being
    // left to find that the user's "this picture" is not in front of it.
    {
      const filler = 'x'.repeat(900);
      const history = (first) => [
        { role: 'user', content: first },
        ...Array.from({ length: 30 }, (_, i) => [
          { type: 'function_call', call_id: `k${i}`, name: 'read_file', arguments: '{"path":"a.css"}' },
          { type: 'function_call_output', call_id: `k${i}`, output: filler },
        ]).flat(),
      ];
      const text = { type: 'input_text', text: 'Fix the layout shown here.' };
      const picture = { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' };
      const options = { maxTokens: 3000, tailTokens: 2200, taskCheckpoint: 'Original task: fix the layout.' };
      const withPicture = compactRollingContext(history([text, picture]), options);
      assert.equal(withPicture.compacted, true, '(the premise: the history is over its budget)');
      assert(!JSON.stringify(withPicture.history).includes('input_image'), 'the picture left the request with the message it was in');
      const note = withPicture.history[0].content[0].text;
      assert(/1 picture/i.test(note) && /attach/i.test(note), 'and the checkpoint says that one picture was left out and that the user can attach it again');
      const twoPictures = compactRollingContext(history([text, picture, picture]), options).history[0].content[0].text;
      assert(/2 pictures/i.test(twoPictures), 'it counts them');
      // A picture a tool returned (a screenshot) is left out the same way, and counted with the user's.
      const shot = history([text]);
      shot[2] = { type: 'function_call_output', call_id: 'k0', output: [{ type: 'input_text', text: filler }, picture] };
      const mixed = compactRollingContext([shot[0], ...shot.slice(1)].map((item, i) => (i === 0 ? { role: 'user', content: [text, picture] } : item)), options).history[0].content[0].text;
      assert(/2 pictures/i.test(mixed), 'the picture of a tool result and the one of the user are both counted');
      assert(/1 picture /i.test(compactRollingContext(shot, options).history[0].content[0].text), 'a picture only a tool returned is counted');
      const plain = compactRollingContext(history([text]), options);
      assert.equal(plain.compacted, true);
      assert(!/picture/i.test(plain.history[0].content[0].text), 'no picture was left out: the checkpoint says nothing of pictures');
      console.log('  [PASS] 7. A checkpoint says how many pictures it left out');
    }

    console.log('\nALL 7 SMART CONTEXT COMPACTION TEST SUITES PASSED!');
  } finally {
    await cleanup();
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exitCode = 1;
});
