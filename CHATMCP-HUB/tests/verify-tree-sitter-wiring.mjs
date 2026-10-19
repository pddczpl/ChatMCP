// A Tree-sitter adapter injected through LocalTools must reach the Code Intelligence engine.
//
// LocalTools and registerCodeIntelligenceTools used to hand the option over as `treeSitterParser`
// while CodeIntelligenceEngine only reads `treeSitterAdapter`, so an injected adapter was dropped
// and every tool answered from the heuristic tier. code-intelligence.test.mjs builds the engine
// directly with the engine's own option name, which is why nothing noticed. This suite goes
// through the production integration point only: a real StudioWorkspace (it has `root`, not
// `path`) and a real LocalTools, driven through the registered tools.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';
import { LocalTools } from '../lib/local-tools.mjs';

const TIER = 'tree-sitter';
const FALLBACK_TIER = 'heuristic-fallback';
const PROJECT_FILES = ['src/entry.mjs', 'src/math.mjs'];

/**
 * Stand-in for web-tree-sitter that turns the fixture's one-line `function name(...)` declarations
 * into tree-sitter shaped nodes and records every parse request. The recording is what proves the
 * injected adapter was reached; a tier label alone could also come from somewhere else.
 *
 * The engine accepts two shapes: an adapter with getParser(language), and a parser with parse().
 */
function recordingAdapter(shape) {
  const requests = [];
  const languages = [];
  const parser = {
    parse(source, previousTree, context) {
      requests.push({ relPath: context?.relPath, language: context?.language });
      const lines = source.split('\n');
      const declarations = [];
      lines.forEach((line, row) => {
        const match = /^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
        if (!match) return;
        const name = { type: 'identifier', text: match[1], namedChildren: [] };
        declarations.push({
          type: 'function_declaration',
          startPosition: { row, column: 0 },
          endPosition: { row, column: line.length },
          namedChildren: [name],
          childForFieldName: (field) => (field === 'name' ? name : null),
        });
      });
      return {
        rootNode: {
          type: 'program',
          startPosition: { row: 0, column: 0 },
          endPosition: { row: Math.max(0, lines.length - 1), column: 0 },
          namedChildren: declarations,
          childForFieldName: () => null,
        },
      };
    },
  };
  const adapter = shape === 'getParser'
    ? { getParser(language) { languages.push(language); return parser; } }
    : parser;
  return { adapter, requests, languages };
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-tree-sitter-wiring-'));
try {
  const project = path.join(dir, 'project');
  const state = path.join(dir, 'state');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'math.mjs'),
    'export function calculateSum(a, b) { return a + b; }\nexport function scaleBy(value, factor) { return value * factor; }\n');
  await fs.writeFile(path.join(project, 'src', 'entry.mjs'),
    "import { calculateSum } from './math.mjs';\nexport function run() { return calculateSum(1, 2); }\n");
  const workspace = new StudioWorkspace({ manager: { workspace: project, secrets: [] }, directory: state });

  // Each probe gets a fresh LocalTools: the engine caches parsed files, so a shared instance would
  // let the first tool's parse hide whether the next tool reaches the adapter.
  const probes = [
    {
      tool: 'repo_map',
      args: { path: '.', max_tokens: 850 },
      // repo_map reports no tier of its own; the adapter requests below are its evidence.
      check({ structured, text }) {
        assert.equal(structured.totalFiles, PROJECT_FILES.length);
        assert.match(text, /calculateSum/);
      },
    },
    {
      tool: 'code_symbols',
      args: { path: 'src' },
      check({ structured }) {
        // querySymbols labels an empty result 'tree-sitter' too, so require real symbols first.
        assert.equal(structured.totalMatches, 3, 'calculateSum, scaleBy and run');
        assert.deepEqual(structured.symbols.map((symbol) => symbol.name).sort(), ['calculateSum', 'run', 'scaleBy']);
        for (const symbol of structured.symbols) assert.equal(symbol.tier, TIER, `${symbol.name} tier`);
        assert.equal(structured.provenance.tier, TIER);
        assert.equal(structured.provenance.engine, 'web-tree-sitter');
        assert.equal(structured.provenance.fallbackUsed, false);
      },
    },
    {
      tool: 'find_definition',
      args: { symbol: 'calculateSum', context_path: 'src/entry.mjs', path: 'src' },
      check({ structured }) {
        assert.equal(structured.definitions[0].file, 'src/math.mjs');
        assert.equal(structured.definitions[0].tier, TIER);
        assert.equal(structured.provenance.tier, TIER);
      },
    },
  ];

  for (const shape of ['getParser', 'parse']) {
    for (const probe of probes) {
      const { adapter, requests, languages } = recordingAdapter(shape);
      const local = new LocalTools({ workspace, stateDirectory: state, treeSitterAdapter: adapter });
      const result = await local.call(probe.tool, probe.args);
      assert.equal(result.isError, false, `${probe.tool}: ${JSON.stringify(result).slice(0, 400)}`);
      probe.check({ structured: result.structuredContent, text: result.content[0].text });
      assert.deepEqual([...new Set(requests.map((request) => request.relPath))].sort(), PROJECT_FILES,
        `${probe.tool} (${shape} adapter): every project file must be parsed by the injected adapter`);
      assert.ok(requests.every((request) => request.language === 'javascript'), `${probe.tool}: language handed to the adapter`);
      if (shape === 'getParser') assert.ok(languages.length > 0 && languages.every((language) => language === 'javascript'), `${probe.tool}: getParser(language)`);
      console.log(`PASS ${probe.tool} answers from the injected ${shape} adapter, tier ${TIER}`);
    }
  }

  // Control: without an adapter the same calls report the heuristic tier. That is what shows the
  // assertions above are caused by the injection (it assumes, like code-intelligence.test.mjs, that
  // no web-tree-sitter runtime and grammars are installed).
  {
    const local = new LocalTools({ workspace, stateDirectory: state });
    const symbols = await local.call('code_symbols', { path: 'src' });
    assert.equal(symbols.isError, false);
    assert.equal(symbols.structuredContent.totalMatches, 3);
    for (const symbol of symbols.structuredContent.symbols) assert.equal(symbol.tier, FALLBACK_TIER, `${symbol.name} tier`);
    assert.equal(symbols.structuredContent.provenance.tier, FALLBACK_TIER);
    const definition = await local.call('find_definition', probes.find((probe) => probe.tool === 'find_definition').args);
    assert.equal(definition.structuredContent.definitions[0].tier, FALLBACK_TIER);
    console.log(`PASS without an adapter the same calls stay on ${FALLBACK_TIER}`);
  }
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
