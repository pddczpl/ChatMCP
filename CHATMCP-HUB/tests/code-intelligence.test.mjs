// CHATMCP-HUB/tests/code-intelligence.test.mjs
// Automated test suite for CHATMCP-HUB/lib/code-intelligence.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioWorkspace } from '../lib/studio-workspace.mjs';

// Support running both inside CHATMCP-HUB/tests/ (../lib/code-intelligence.mjs)
// and in the same directory (./code-intelligence.mjs)
const mod = await import('../lib/code-intelligence.mjs').catch(() => import('./code-intelligence.mjs'));
const {
  CodeIntelligenceEngine,
  maskCommentsAndStrings,
  parseSourceStructure,
  registerCodeIntelligenceTools,
  CODE_INTELLIGENCE_TOOLS,
} = mod;

async function createMockWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-code-intel-test-'));

  await fs.mkdir(path.join(root, 'lib'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.mkdir(path.join(root, 'desktop-shell'), { recursive: true });

  // 1. lib/tool-schema.mjs
  await fs.writeFile(
    path.join(root, 'lib', 'tool-schema.mjs'),
    `// Minimal JSON-Schema validator
/** Validate tool input against schema */
export function validateArguments(schema, input) {
  // comment mentioning fakeFunction() that should be ignored
  const literal = "function fakeInString() { return 1; }";
  return { ok: true, value: input, errors: [], literal };
}

export const SCHEMA_VERSION = 3;
`,
    'utf8'
  );

  // 2. lib/local-tools.mjs (imports tool-schema.mjs, defines class LocalTools with #register and call)
  await fs.writeFile(
    path.join(root, 'lib', 'local-tools.mjs'),
    `import { validateArguments, NON_EXISTENT_EXPORT } from './tool-schema.mjs';

export class LocalTools {
  constructor({ workspace }) {
    this.workspace = workspace;
    this.tools = new Map();
    this.#register();
  }

  #register() {
    this.tools.set('read_file', { name: 'read_file' });
  }

  async call(name, args = {}) {
    const checked = validateArguments({}, args);
    if (!checked.ok) return { isError: true };
    return { isError: false, name };
  }
}
`,
    'utf8'
  );

  // 3. lib/cycle-a.mjs and lib/cycle-b.mjs (circular dependency + broken import)
  await fs.writeFile(
    path.join(root, 'lib', 'cycle-a.mjs'),
    `import { helperB } from './cycle-b.mjs';
export const helperA = () => helperB();
`,
    'utf8'
  );

  await fs.writeFile(
    path.join(root, 'lib', 'cycle-b.mjs'),
    `import { helperA } from './cycle-a.mjs';
import { missing } from './does-not-exist.mjs';
export function helperB() {
  return helperA ? 1 : 0;
}
`,
    'utf8'
  );

  // 4. tests/local-tools.test.mjs (imports lib/local-tools.mjs)
  await fs.writeFile(
    path.join(root, 'tests', 'local-tools.test.mjs'),
    `import { LocalTools } from '../lib/local-tools.mjs';
import { validateArguments } from '../lib/tool-schema.mjs';

export async function runLocalToolsSuite() {
  const lt = new LocalTools({ workspace: { resolve: (p) => p } });
  await lt.call('read_file', {});
  return validateArguments({}, {});
}
`,
    'utf8'
  );

  // 5. desktop-shell/MainForm.cs (C# file test)
  await fs.writeFile(
    path.join(root, 'desktop-shell', 'MainForm.cs'),
    `using System;
using System.Windows.Forms;

public class MainForm : Form {
  public async void InitializeWebView() {
    Console.WriteLine("Ready");
  }
}
`,
    'utf8'
  );

  // The production workspace: StudioWorkspace exposes get root() and an async resolve(); it has no path property. A hand-written
  // double that carried one hid the v3.9.0 defect where the LSP tier read the wrong property and silently fell back.
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-code-intel-state-'));
  const workspace = new StudioWorkspace({ manager: { workspace: root, secrets: [] }, directory: stateDirectory });

  return {
    root,
    workspace,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(stateDirectory, { recursive: true, force: true });
    },
  };
}

async function runTests() {
  console.log('Running ChatMCP Code Intelligence test suite...');
  const { workspace, root, cleanup } = await createMockWorkspace();

  try {
    // Test 1: Comment and string masking preserves exact line numbers
    const sample = `// comment line 1\nconst s = "export function fake() {}";\nexport function realFn(a) {\n  return a + 1;\n}`;
    const masked = maskCommentsAndStrings(sample, 'javascript');
    assert.equal(sample.split('\n').length, masked.split('\n').length, 'Line count must be preserved');
    const parsedSample = parseSourceStructure(sample, 'sample.mjs');
    assert.equal(parsedSample.symbols.length, 1, 'Should only extract realFn, not fake inside string');
    assert.equal(parsedSample.symbols[0].name, 'realFn');
    assert.equal(parsedSample.symbols[0].line, 3);
    assert.equal(parsedSample.symbols[0].endLine, 5);
    console.log('  [PASS] 1. Comment & string masking + exact line/endLine AST extraction');

    const engine = new CodeIntelligenceEngine({ workspace });

    // Test 2: Symbol extraction across JS (with private #register), C#, and constants
    const allSyms = await engine.querySymbols({ path: '.' });
    const names = allSyms.structured.symbols.map((s) => s.qualifiedName);
    assert(names.includes('validateArguments'), 'Should find validateArguments');
    assert(names.includes('SCHEMA_VERSION'), 'Should find exported constant SCHEMA_VERSION');
    assert(names.includes('LocalTools'), 'Should find class LocalTools');
    assert(names.includes('LocalTools.#register'), 'Should find private method LocalTools.#register');
    assert(names.includes('LocalTools.call'), 'Should find async method LocalTools.call');
    assert(names.includes('MainForm'), 'Should find C# class MainForm');
    assert(names.includes('MainForm.InitializeWebView'), 'Should find C# method MainForm.InitializeWebView');
    console.log('  [PASS] 2. Multi-language symbol extraction (ESM, #private methods, C#)');

    // Test 3: PageRank-style Repo Map prioritizes highly imported modules (tool-schema.mjs)
    const repoMap = await engine.generateRepoMap({ maxTokens: 1500 });
    assert(repoMap.structured.totalFiles >= 6);
    const topFile = repoMap.structured.topFiles[0];
    assert.equal(
      topFile.path,
      'lib/local-tools.mjs',
      'local-tools.mjs (entry boost + imported by test) or tool-schema.mjs should rank at top'
    );
    const schemaEntry = repoMap.structured.topFiles.find((f) => f.path === 'lib/tool-schema.mjs');
    assert.equal(schemaEntry.importedByCount, 2, 'tool-schema.mjs is imported by 2 files');
    console.log('  [PASS] 3. Graph-ranked Repo Map generation & token budgeting');

    // Test 4: Go-to-Definition with contextPath import resolution
    const defRes = await engine.findDefinition({
      symbol: 'validateArguments',
      contextPath: 'lib/local-tools.mjs',
    });
    assert.equal(defRes.structured.preferredImportTarget, 'lib/tool-schema.mjs');
    assert.equal(defRes.structured.definitions[0].file, 'lib/tool-schema.mjs');
    assert.equal(defRes.structured.definitions[0].line, 3);
    console.log('  [PASS] 4. Go-to-Definition with ES module import resolution');

    // Test 5: Scope-aware Find References (distinguishing definition, import, and call)
    const refRes = await engine.findReferences({ symbol: 'validateArguments' });
    assert.equal(refRes.structured.countsByKind.definition, 1);
    assert.equal(refRes.structured.countsByKind.import, 2);
    assert.equal(refRes.structured.countsByKind.call, 2);
    const callInLocalTools = refRes.structured.references.find(
      (r) => r.file === 'lib/local-tools.mjs' && r.kind === 'call'
    );
    assert(callInLocalTools, 'Should detect call site in lib/local-tools.mjs');
    assert.equal(
      callInLocalTools.enclosingSymbol,
      'LocalTools.call',
      'Should identify enclosing method LocalTools.call'
    );
    console.log('  [PASS] 5. Scope-aware Find References (definition / import / call + enclosing method)');

    // Test 6: Dependency Graph, Blast Radius, Related Tests & Circular Dependency Detection
    const impactRes = await engine.analyzeDependencies({ path: 'lib/tool-schema.mjs' });
    assert(impactRes.structured.directDependents.includes('lib/local-tools.mjs'));
    assert(impactRes.structured.relatedTests.includes('tests/local-tools.test.mjs'));

    const fullGraph = await engine.analyzeDependencies({ path: '.' });
    assert(fullGraph.structured.circularDependencies.length >= 1, 'Should detect cycle-a <-> cycle-b');
    console.log('  [PASS] 6. Dependency Graph, Transitive Blast Radius, Related Tests & Cycle Detection');

    // Test 7: Static Diagnostics (cross-file missing export + unresolved relative import)
    const diagRes = await engine.runDiagnostics({ path: '.' });
    const codes = diagRes.structured.diagnostics.map((d) => d.code);
    assert(codes.includes('missing_export'), 'Should flag NON_EXISTENT_EXPORT from tool-schema.mjs');
    assert(codes.includes('unresolved_import'), 'Should flag ./does-not-exist.mjs in cycle-b.mjs');
    console.log('  [PASS] 7. Cross-file Static Diagnostics (missing_export & unresolved_import)');

    // Test 8: LocalTools registration compatibility via registerCodeIntelligenceTools
    const registered = new Map();
    const define = (name, spec) => registered.set(name, { name, ...spec });
    registerCodeIntelligenceTools(define, workspace);
    assert.equal(registered.size, CODE_INTELLIGENCE_TOOLS.length);
    for (const toolName of CODE_INTELLIGENCE_TOOLS) {
      assert(registered.has(toolName), `Tool ${toolName} should be registered`);
      const spec = registered.get(toolName);
      assert.equal(spec.category, 'read', `Tool ${toolName} must have category 'read'`);
    }
    const callResult = await registered.get('repo_map').run({ max_tokens: 800 });
    assert.equal(callResult.isError, false);
    assert(callResult.content[0].text.includes('Repository Code Map'));
    console.log('  [PASS] 8. LocalTools #register() integration & MCP output schema');

    // Test 9: Multi-Tier Architecture (Tier 1 LSP -> Tier 2 Tree-sitter/Python AST -> Tier 3 Heuristic Fallback)
    const mockTreeSitterAdapter = {
      parse(source) {
        return {
          rootNode: {
            type: 'program',
            startPosition: { row: 0, column: 0 },
            endPosition: { row: 5, column: 0 },
            namedChildren: [
              {
                type: 'function_declaration',
                startPosition: { row: 2, column: 0 },
                endPosition: { row: 11, column: 1 },
                namedChildren: [
                  {
                    type: 'identifier',
                    startIndex: source.indexOf('validateArguments'),
                    endIndex: source.indexOf('validateArguments') + 'validateArguments'.length,
                    text: 'validateArguments',
                    namedChildren: [],
                  },
                ],
                childForFieldName(field) {
                  if (field === 'name') return this.namedChildren[0];
                  return null;
                },
              },
            ],
            childForFieldName() {
              return null;
            },
          },
        };
      },
    };
    const mockStudioIntelligence = {
      async lspRequest(request) {
        assert.equal(request.method, 'definition');
        assert.equal(request.file, 'lib/local-tools.mjs');
        assert.equal(request.language, 'typescript');
        assert.equal(request.line, 1);
        assert.ok(Number.isInteger(request.column) && request.column > 0);
        const { pathToFileURL } = await import('node:url');
        return {
          result: [{
            uri: pathToFileURL(path.join(root, 'lib/tool-schema.mjs')).href,
            range: { start: { line: 2, character: 16 }, end: { line: 2, character: 33 } },
          }],
        };
      },
    };
    const tieredEngine = new CodeIntelligenceEngine({
      workspace,
      treeSitterAdapter: mockTreeSitterAdapter,
      studioIntelligence: mockStudioIntelligence,
    });
    const tsRecord = await tieredEngine.getParsedFile('lib/tool-schema.mjs');
    assert.equal(tsRecord.tier, 'tree-sitter', 'Should use Tier 2 Tree-sitter when adapter/WASM is available');
    const lspDef = await tieredEngine.findDefinition({
      symbol: 'validateArguments',
      contextPath: 'lib/local-tools.mjs',
    });
    assert.equal(lspDef.structured.definitions[0].tier, 'lsp', 'Should prioritize Tier 1 LSP definition when available');
    const fallbackRecord = await engine.getParsedFile('lib/tool-schema.mjs');
    assert.equal(fallbackRecord.tier, 'heuristic-fallback', 'Should gracefully fall back to Tier 3 heuristic engine when WASM is absent');
    assert.equal(lspDef.structured.provenance.tier, 'lsp');
    assert.equal(lspDef.structured.provenance.fallbackUsed, false);
    console.log('  [PASS] 9. Multi-Tier Architecture (LSP Tier 1 -> Tree-sitter Tier 2 -> Heuristic Tier 3 fallback)');

    // Test 10: Python AST contract (Phase 5) & Router health/provenance (Phase 6)
    await fs.writeFile(
      path.join(root, 'lib', 'sample_unicode.py'),
      `# -*- coding: utf-8 -*-
import os
from math import sqrt

MAX_VAL = 42

class DataProcessor:
    def compute_value(self, x):
        """Doc với ký tự tiếng Việt"""
        return sqrt(x)
`,
      'utf8'
    );
    const pyEngine = new CodeIntelligenceEngine({ workspace });
    const pyRec = await pyEngine.getParsedFile('lib/sample_unicode.py');
    assert.ok(pyRec, 'Should parse Python file');
    assert.ok(['python-ast', 'tree-sitter', 'heuristic-fallback'].includes(pyRec.tier));
    const pySyms = await pyEngine.querySymbols({ path: 'lib/sample_unicode.py' });
    assert.ok(pySyms.structured.provenance, 'querySymbols must include provenance metadata');
    assert.equal(pySyms.structured.provenance.language, 'python');
    const pyNames = pySyms.structured.symbols.map((s) => s.qualifiedName);
    assert(pyNames.includes('DataProcessor'), 'Should extract Python class DataProcessor');
    assert(pyNames.includes('DataProcessor.compute_value'), 'Should extract Python method DataProcessor.compute_value');
    console.log('  [PASS] 10. Python AST contract & provenance metadata');

    console.log('\nALL 10 CODE INTELLIGENCE TEST SUITES PASSED!');
  } finally {
    await cleanup();
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exitCode = 1;
});
