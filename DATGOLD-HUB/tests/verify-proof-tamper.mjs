// lib/proof/tamper.mjs: which changes of a task touched the checks (P4 pod-22, docs/PROOF-TAMPER.md).
//
// Every case runs on a real temporary Git repository: the baseline is the commit the task started from (gitTreeSide, read through the
// pinned Git of lib/proof/git-plumbing.mjs) and the final side is the work tree as the tree snapshot engine lists it (workTreeSide,
// lib/proof/tree-snapshot.mjs). What it proves:
//   1. the parts: path conventions, script invocations of criteria, the comment and string blanking that keeps a marker in a comment or a
//      string from counting, assertion and skip counts, the name-status diff (A, D, M, T, R, C);
//   2. five synthetic strategies that make checks pass without fixing anything are ALL flagged: an assertion deleted, a skip added (seven
//      languages), `scripts.test` changed to echo, the acceptance file edited, a tolerance widened (five spellings); plus the other plan
//      heuristics: `|| true` appended to a script, a deleted test file, test configuration, Makefile, scripts/, a file a criterion names,
//      CI workflows, paths the acceptance file protects;
//   3. ten ordinary diffs give exactly ONE flag, the one the documentation names as a known false positive (two assertions folded into a
//      loop): the count is asserted exactly;
//   4. edge inputs: a rename (exact, with an edit, out of the test conventions), a copy, a mode change only, binary files, CRLF, a path with
//      spaces and non-ASCII letters, an empty diff, a deleted and an unreadable package.json, a huge diff and the read limits, and an
//      ignored path (not seen, as documented);
//   5. the wording: every summary and message is neutral ("checks were modified"), never an accusation, and the limitations are stated.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORY, CHECK_CHANGES_FORMAT, LIMITATION_CODES, classifyPath, codeOnly, countAssertions, countSkipMarkers, detectCheckChanges, gitTreeSide,
  memorySide, nameStatus, scriptInvocations, workTreeSide,
} from '../lib/proof/tamper.mjs';
import { commitAll, fresh, git, isolatedEnv, newRepo, write } from './support/proof-tree-fixtures.mjs';

let checks = 0;
const suiteStart = performance.now();
const elapsed = () => `${((performance.now() - suiteStart) / 1000).toFixed(1)} s`;
const ok = (label) => { checks += 1; console.log(`  ok - ${label} [${elapsed()}]`); };
setTimeout(() => { console.error('FAIL: the proof tamper suite exceeded its own time budget'); process.exit(2); }, 170_000).unref();

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const results = []; // every report, for the wording check at the end

// ------------------------------------------------------------------ fixtures
const ACCEPTANCE = `version: 1
criteria:
  - id: unit
    text: Unit tests pass
    checks:
      - run: npm test
  - id: lint
    text: Lint passes
    checks:
      - run: npm run lint
  - id: docs
    text: The docs read well
    manual:
      note: Read the README.
`;
const pkg = (scripts = {}, extra = {}) => `${JSON.stringify({
  name: 'demo', version: '1.0.0', scripts: { test: 'jest', lint: 'eslint .', format: 'prettier -w .', ...scripts }, devDependencies: { jest: '^29.0.0' }, ...extra,
}, null, 2)}\n`;
const MATH_TEST = `const { add, mul } = require('../src/math');

describe('math', () => {
  it('adds', () => {
    expect(add(1, 2)).toBe(3);
    expect(add(-1, 1)).toBe(0);
  });
  it('multiplies', () => {
    expect(mul(2, 3)).toBe(6);
  });
  it('approximates pi', () => {
    expect(Math.PI).toBeCloseTo(3.14159, 5);
  });
});
`;
const LOCK = `${JSON.stringify({ name: 'demo', lockfileVersion: 3, packages: { 'node_modules/jest': { version: '29.7.0' } } }, null, 2)}\n`;
const WORKFLOW = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
`;
const BASE = {
  '.chatmcp/acceptance.yml': ACCEPTANCE,
  'package.json': pkg(),
  'package-lock.json': LOCK,
  'src/math.js': 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n',
  'src/util.js': "const { add } = require('./math');\nexports.twice = (x) => add(x, x);\n",
  'tests/math.test.js': MATH_TEST,
  'README.md': '# Demo\n\nAdds numbers.\n',
  '.github/workflows/ci.yml': WORKFLOW,
  '.gitignore': 'generated/\nnode_modules/\n',
};

function makeRepo(label, files = BASE, { executable = [] } = {}) {
  const dir = newRepo(label);
  for (const [relative, content] of Object.entries(files)) write(dir, relative, content);
  git(dir, ['add', '-A']);
  for (const relative of executable) git(dir, ['update-index', '--chmod=+x', '--', relative]);
  git(dir, ['commit', '-q', '-m', 'baseline']);
  return dir;
}
const read = (dir, relative) => fs.readFileSync(path.join(dir, relative), 'utf8');
const edit = (dir, relative, change) => { const before = read(dir, relative); const after = change(before); assert.notEqual(after, before, `the edit of ${relative} changed nothing`); write(dir, relative, after); };
const remove = (dir, relative) => fs.rmSync(path.join(dir, relative));
const move = (dir, from, to) => { fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true }); fs.renameSync(path.join(dir, from), path.join(dir, to)); };

async function detect(dir, options = {}) {
  const env = isolatedEnv();
  const baseline = await gitTreeSide({ root: dir, rev: 'HEAD', stateDir: fresh('state'), env });
  const final = await workTreeSide({ root: dir, stateDir: fresh('state'), env });
  const result = await detectCheckChanges({ baseline, final, ...options });
  results.push(result);
  return result;
}
const finding = (result, relative) => result.findings.find((row) => row.path === relative);
const flaggedCodes = (row) => (row?.reasons ?? []).filter((reason) => reason.flagged).map((reason) => reason.code);
const criterion = (result, id) => result.criteria.find((row) => row.id === id);
const flaggedCriteria = (result) => result.criteria.filter((row) => row.checks_modified).map((row) => row.id);
const describe = (result) => JSON.stringify(result.findings.map((row) => ({ path: row.path, status: row.status, codes: row.reasons.map((r) => `${r.code}${r.flagged ? '!' : ''}`) })));

// ------------------------------------------------------------------ 1. the parts
{
  const table = [
    ['tests/math.test.js', CATEGORY.testFile], ['src/app.spec.ts', CATEGORY.testFile], ['src/__tests__/a.js', CATEGORY.testFile],
    ['pkg/calc_test.go', CATEGORY.testFile], ['tests/test_calc.py', CATEGORY.testFile], ['app/test_utils.py', CATEGORY.testFile],
    ['app/utils_test.py', CATEGORY.testFile], ['src/test/java/com/x/CalcTest.java', CATEGORY.testFile], ['Calc.Tests/CalcTests.cs', CATEGORY.testFile],
    ['spec/models/user_spec.rb', CATEGORY.testFile], ['src/__snapshots__/App.test.tsx.snap', CATEGORY.testFile], ['e2e/login.e2e.ts', CATEGORY.testFile],
    ['tests/fixtures/expected.json', CATEGORY.testFile], ['TESTS/Upper.js', CATEGORY.testFile],
    ['src/latest.js', null], ['src/contest.py', null], ['docs/testing.md', null], ['src/attestation.ts', null], ['node_modules/x/test/a.js', null],
    ['vendor/lib/a_test.go', null], ['README.md', null], ['src/math.js', null],
    ['jest.config.js', CATEGORY.testConfig], ['packages/a/vitest.config.mts', CATEGORY.testConfig], ['pytest.ini', CATEGORY.testConfig],
    ['tests/conftest.py', CATEGORY.testConfig], ['conftest.py', CATEGORY.testConfig], ['tox.ini', CATEGORY.testConfig], ['pyproject.toml', CATEGORY.testConfig],
    ['setup.cfg', CATEGORY.testConfig], ['Calc.Tests/Calc.Tests.csproj', CATEGORY.testConfig], ['src/App/App.csproj', CATEGORY.testConfig],
    ['.mocharc.yml', CATEGORY.testConfig], ['playwright.config.ts', CATEGORY.testConfig], ['test.runsettings', CATEGORY.testConfig],
    ['package.json', CATEGORY.checkScript], ['web/package.json', CATEGORY.checkScript], ['Makefile', CATEGORY.checkScript],
    ['scripts/run-tests.sh', CATEGORY.checkScript], ['scripts/lib/util.mjs', CATEGORY.checkScript],
    ['.github/workflows/ci.yml', CATEGORY.ciWorkflow], ['.github/workflows/release.yaml', CATEGORY.ciWorkflow], ['.gitlab-ci.yml', CATEGORY.ciWorkflow],
    ['azure-pipelines.yml', CATEGORY.ciWorkflow], ['.circleci/config.yml', CATEGORY.ciWorkflow], ['Jenkinsfile', CATEGORY.ciWorkflow],
    ['.chatmcp/acceptance.yml', CATEGORY.acceptance],
    ['package-lock.json', CATEGORY.lockfile], ['web/yarn.lock', CATEGORY.lockfile], ['pnpm-lock.yaml', CATEGORY.lockfile], ['poetry.lock', CATEGORY.lockfile],
    ['go.sum', CATEGORY.lockfile], ['Cargo.lock', CATEGORY.lockfile], ['packages.lock.json', CATEGORY.lockfile], ['uv.lock', CATEGORY.lockfile],
    ['Gemfile.lock', CATEGORY.lockfile],
  ];
  const wrong = table.filter(([file, expected]) => classifyPath(file) !== expected).map(([file, expected]) => `${file}: ${classifyPath(file)} (expected ${expected})`);
  assert.deepEqual(wrong, [], 'classifyPath');
  assert.equal(classifyPath('tools/scripts/x.sh'), null, 'a scripts/ folder counts at the workspace root (or a criterion\'s cwd, decided later)');
  ok(`classifyPath: ${table.length} paths (test files by convention, test configuration, check scripts, CI, acceptance file, lockfiles, look-alikes that are none)`);

  const invocations = [
    ['npm test', ['npm:test']], ['npm t', ['npm:test']], ['npm run lint', ['npm:lint']], ['npm run-script build -- --watch', ['npm:build']],
    ['npm --prefix web run e2e', ['npm:e2e@web']], ['npm ci && npm test', ['npm:test']], ['npm start', ['npm:start']], ['npm run', []],
    ['pnpm test', ['pnpm:test']], ['pnpm run check', ['pnpm:check']], ['pnpm lint', ['pnpm:lint']], ['pnpm install', []], ['pnpm -C web test', ['pnpm:test@web']],
    ['yarn test', ['yarn:test']], ['yarn build', ['yarn:build']], ['yarn', []], ['yarn workspace a test', []], ['yarn --cwd web lint', ['yarn:lint@web']],
    ['bun run test', ['bun:test']], ['bun test', []], ['npx jest', []], ['node tests/x.mjs', []],
    ['CI=1 npm test', ['npm:test']], ['cross-env CI=1 npm test', ['npm:test']], ['npm.cmd test', ['npm:test']], ['C:/tools/npm.exe run lint', ['npm:lint']],
    ['run-s lint test', ['npm-run-all:lint', 'npm-run-all:test']], ['npm-run-all -p "test:*"', ['npm-run-all:test:*']],
    ['npm test; npm run lint || true', ['npm:test', 'npm:lint']], ['echo "npm test"', []],
  ];
  const got = (command) => scriptInvocations(command).map((row) => `${row.runner}:${row.key}${row.prefix ? `@${row.prefix}` : ''}`);
  const differing = invocations.filter(([command, expected]) => JSON.stringify(got(command)) !== JSON.stringify(expected)).map(([command, expected]) => `${command} -> ${JSON.stringify(got(command))} (expected ${JSON.stringify(expected)})`);
  assert.deepEqual(differing, [], 'scriptInvocations');
  ok(`scriptInvocations: ${invocations.length} commands (npm/pnpm/yarn/bun, --prefix/-C/--cwd, env prefixes, chains, run-s and npm-run-all, a quoted "npm test" is not one)`);

  const markerInComments = [
    ['a.test.js', 'const s = "it.skip(";\nconst t = \'xit(\';\nconst u = `test.only(${x}) describe.skip(`;\n// it.skip(\n/* xit(\n it.only( */\n'],
    ['a_test.py', 's = "@pytest.mark.skip"\n# @pytest.mark.skip\n"""\npytest.skip("x")\n"""\nr\'\'\'@unittest.skip\'\'\'\n'],
    ['a_test.go', 'var s = "t.Skip()"\n// t.Skip()\nvar r = `t.SkipNow()`\n'],
    ['ATests.cs', 'var s = "[Ignore]";\n// [Fact(Skip = "x")]\nvar v = @"[Ignore]";\n'],
    ['a_spec.rb', 's = "xit"\n# skip "later"\n'],
  ];
  for (const [file, text] of markerInComments) {
    const code = codeOnly(text, file);
    assert.equal(code.length, text.length, `${file}: blanking keeps the length`);
    assert.equal(code.split('\n').length, text.split('\n').length, `${file}: blanking keeps the lines`);
    assert.equal(countSkipMarkers(code), 0, `${file}: a marker in a string or a comment is not counted: ${JSON.stringify(code)}`);
  }
  const markers = [
    ['a.test.js', "it.skip('x', () => {});\nxit('y', () => {});\ntest.only('z', () => {});\ndescribe.skip('w', () => {});\nfit('v', () => {});\n", 5],
    ['a_test.py', '@pytest.mark.skip(reason="x")\n@pytest.mark.xfail\n@unittest.skip("y")\ndef f():\n    pytest.skip("z")\n    self.skipTest("w")\n', 5],
    ['a_test.go', 'func TestA(t *testing.T) {\n\tt.Skip("x")\n\tt.Skipf("%d", 1)\n\tt.SkipNow()\n}\n', 3],
    ['ATests.cs', '[Fact(Skip = "x")]\n[Test, Ignore("y")]\n[Ignore]\n', 3],
    ['ATest.java', '@Disabled\n@Ignore\n', 2],
    ['tests/a.rs', '#[test]\n#[ignore]\nfn a() {}\n', 1],
    ['a.test.js', "it('x', () => {}, { skip: true });\ntest('y', { todo: 'later' }, () => {});\n", 2],
  ];
  for (const [file, text, count] of markers) assert.equal(countSkipMarkers(codeOnly(text, file)), count, `${file}: ${text}`);
  ok(`codeOnly blanks strings and comments in five language families (length and lines kept); ${markers.reduce((sum, row) => sum + row[2], 0)} real skip and focus markers counted in seven languages`);

  const assertions = [
    ['a.test.js', 'expect(a).toBe(1);\nassert.equal(a, 1);\nassert(a);\nassert.deepStrictEqual(a, b);\nt.is(a, 1);\n// expect(b).toBe(2)\n', 5],
    ['a_test.py', 'assert a == 1\nself.assertEqual(a, 1)\nwith pytest.raises(ValueError):\n    pass\n# assert b\n', 3],
    ['a_test.go', 'if a != 1 {\n\tt.Errorf("x")\n\tt.Fatal("y")\n}\nassert.Equal(t, 1, a)\nrequire.NoError(t, err)\n', 4],
    ['ATests.cs', 'Assert.Equal(1, a);\nAssert.True(b);\na.Should().Be(1);\n', 3],
    ['tests/a.rs', 'assert_eq!(a, 1);\nassert!(b);\n', 2],
  ];
  for (const [file, text, count] of assertions) assert.equal(countAssertions(codeOnly(text, file)), count, `${file}: ${text}`);
  ok('countAssertions: expect/assert/t.is (JS), assert and self.assert* and pytest.raises (Python), t.Error/t.Fatal/testify (Go), Assert.*/Should() (C#), assert! (Rust); a commented one does not count');

  const blob = (text) => ({ content: text });
  const before = memorySide({ 'a.txt': blob('a\n'), 'b.txt': blob('b\n'), 'c.txt': blob('c\n'), 'd.txt': blob('d\n'), 'e.sh': { content: 'e\n', mode: '100755' }, 'f.txt': blob('f\n'), 'g.txt': blob('') });
  const after = memorySide({ 'a.txt': blob('a\n'), 'b.txt': blob('B\n'), 'c2.txt': blob('c\n'), 'd.txt': { content: 'd\n', symlink: true }, 'e.sh': { content: 'e\n', mode: '100644' }, 'f.txt': blob('f\n'), 'f-copy.txt': blob('f\n'), 'h.txt': blob(''), 'new.txt': blob('n\n') });
  const rows = nameStatus(before.entries, after.entries).map((row) => `${row.status} ${row.oldPath && row.oldPath !== row.path ? `${row.oldPath} -> ` : ''}${row.path}`);
  assert.deepEqual(rows, ['M b.txt', 'R c.txt -> c2.txt', 'T d.txt', 'M e.sh', 'C f.txt -> f-copy.txt', 'D g.txt', 'A h.txt', 'A new.txt'], 'nameStatus');
  const modeOnly = nameStatus(before.entries, after.entries).find((row) => row.path === 'e.sh');
  assert.equal(modeOnly.oldOid, modeOnly.newOid, 'a mode change keeps the blob');
  assert.deepEqual([modeOnly.oldMode, modeOnly.newMode], ['100755', '100644']);
  assert.deepEqual(nameStatus(before.entries, before.entries), [], 'no change, no row');
  ok('nameStatus: M, R (same blob), T (file to symlink), M for a mode change only, C (a kept file copied), and an empty file is never a rename source');
}

// ------------------------------------------------------------------ 2. five tampering strategies (and the other plan heuristics): all flagged
const strategies = [];
{
  // S1: an assertion deleted
  const dir = makeRepo('s1-assertion');
  edit(dir, 'tests/math.test.js', (text) => text.replace('    expect(add(-1, 1)).toBe(0);\n', ''));
  const result = await detect(dir);
  const row = finding(result, 'tests/math.test.js');
  assert.deepEqual(flaggedCodes(row), ['assertions_removed'], describe(result));
  assert.deepEqual(row.reasons.find((reason) => reason.code === 'assertions_removed').detail, { before: 4, after: 3 });
  assert.equal(result.checks_modified, true);
  assert.deepEqual(flaggedCriteria(result), ['unit', 'lint'], 'a test change is attributed to every criterion that runs a command, not to the manual one');
  assert.equal(criterion(result, 'unit').reasons[0].via, 'every_check');
  strategies.push(['delete an assertion', result]);
}
{
  // S2: a skip added, in seven languages
  const files = {
    ...BASE,
    'tests/test_calc.py': 'import pytest\nfrom calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n',
    'calc/calc_test.go': 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Errorf("Add(1, 2) = %d", Add(1, 2))\n\t}\n}\n',
    'Calc.Tests/CalcTests.cs': 'using Xunit;\n\npublic class CalcTests\n{\n    [Fact]\n    public void Adds() => Assert.Equal(3, Calc.Add(1, 2));\n\n    [Test]\n    public void Subtracts() => Assert.AreEqual(1, Calc.Sub(2, 1));\n}\n',
    'tests/legacy.test.js': "it('works', () => {\n  expect(1).toBe(1);\n});\n",
    'tests/calc.rs': '#[test]\nfn adds() {\n    assert_eq!(add(1, 2), 3);\n}\n',
    'src/test/java/CalcTest.java': 'class CalcTest {\n  @Test\n  void adds() { assertEquals(3, Calc.add(1, 2)); }\n}\n',
  };
  const dir = makeRepo('s2-skip', files);
  edit(dir, 'tests/math.test.js', (text) => text.replace("it('multiplies'", "it.skip('multiplies'"));
  edit(dir, 'tests/test_calc.py', (text) => text.replace('def test_add', '@pytest.mark.skip(reason="later")\ndef test_add'));
  edit(dir, 'calc/calc_test.go', (text) => text.replace('*testing.T) {\n', '*testing.T) {\n\tt.Skip("later")\n'));
  edit(dir, 'Calc.Tests/CalcTests.cs', (text) => text.replace('[Fact]', '[Fact(Skip = "later")]').replace('[Test]', '[Test, Ignore("later")]'));
  edit(dir, 'tests/legacy.test.js', (text) => text.replace("it('works'", "xit('works'"));
  edit(dir, 'tests/calc.rs', (text) => text.replace('#[test]\n', '#[test]\n#[ignore]\n'));
  edit(dir, 'src/test/java/CalcTest.java', (text) => text.replace('  @Test\n', '  @Test\n  @Disabled\n'));
  const result = await detect(dir);
  for (const file of ['tests/math.test.js', 'tests/test_calc.py', 'calc/calc_test.go', 'Calc.Tests/CalcTests.cs', 'tests/legacy.test.js', 'tests/calc.rs', 'src/test/java/CalcTest.java']) {
    assert.deepEqual(flaggedCodes(finding(result, file)), ['skip_marker_added'], `${file}: ${describe(result)}`);
  }
  const reason = finding(result, 'tests/math.test.js').reasons.find((row) => row.code === 'skip_marker_added');
  assert.equal(reason.line, 8, 'the line of the new marker in the final file');
  assert.deepEqual(reason.detail, { before: 0, after: 1 });
  assert.deepEqual(finding(result, 'Calc.Tests/CalcTests.cs').reasons.find((row) => row.code === 'skip_marker_added').detail, { before: 0, after: 2 });
  strategies.push(['add a skip (JS it.skip and xit, pytest.mark.skip, t.Skip, [Fact(Skip)] and Ignore, #[ignore], @Disabled)', result]);
}
{
  // S3: scripts.test changed to echo
  const dir = makeRepo('s3-script');
  write(dir, 'package.json', pkg({ test: 'echo ok' }));
  const result = await detect(dir);
  const row = finding(result, 'package.json');
  assert.deepEqual(flaggedCodes(row), ['check_script_changed'], describe(result));
  assert.deepEqual(row.reasons[0].detail, { package: 'package.json', key: 'test', before: 'jest', after: 'echo ok' });
  assert.deepEqual(flaggedCriteria(result), ['unit'], 'only the criterion that runs `npm test`');
  assert.equal(criterion(result, 'unit').reasons[0].via, 'script');
  strategies.push(['change scripts.test to echo', result]);
}
{
  // S4: the acceptance file edited (a check weakened)
  const dir = makeRepo('s4-acceptance');
  edit(dir, '.chatmcp/acceptance.yml', (text) => text.replace('      - run: npm test\n', '      - run: "true"\n'));
  const result = await detect(dir);
  const row = finding(result, '.chatmcp/acceptance.yml');
  assert.deepEqual(flaggedCodes(row), ['acceptance_edited'], describe(result));
  assert.deepEqual(row.reasons[0].detail, { removed: [], added: [], changed: ['unit'], sections: [], deleted: false, unparseable: null });
  assert.deepEqual(flaggedCriteria(result), ['unit']);
  assert.equal(criterion(result, 'unit').reasons[0].via, 'acceptance');
  assert.deepEqual(result.criteria.map((row) => row.id), ['unit', 'lint', 'docs'], 'the criteria are the BASELINE\'s, in its order');
  strategies.push(['edit acceptance.yml', result]);
}
{
  // S5: a tolerance widened, five spellings
  const files = {
    ...BASE,
    'tests/test_geo.py': 'import pytest\n\n\ndef test_area():\n    assert area(1) == pytest.approx(3.14159, rel=1e-6)\n\n\nclass T(unittest.TestCase):\n    def test_sum(self):\n        self.assertAlmostEqual(total, 0.3, places=7)\n',
    'geo/geo_test.go': 'package geo\n\nfunc TestPi(t *testing.T) {\n\tassert.InDelta(t, 3.14, Pi(), 0.001)\n}\n',
    'tests/helpers.py': 'TOLERANCE = 1e-9\n',
  };
  const dir = makeRepo('s5-tolerance', files);
  edit(dir, 'tests/math.test.js', (text) => text.replace('toBeCloseTo(3.14159, 5)', 'toBeCloseTo(3.14159, 1)'));
  edit(dir, 'tests/test_geo.py', (text) => text.replace('rel=1e-6', 'rel=0.5').replace('places=7', 'places=1'));
  edit(dir, 'geo/geo_test.go', (text) => text.replace('Pi(), 0.001)', 'Pi(), 0.5)'));
  edit(dir, 'tests/helpers.py', (text) => text.replace('1e-9', '1e-2'));
  const result = await detect(dir);
  for (const file of ['tests/math.test.js', 'tests/test_geo.py', 'geo/geo_test.go', 'tests/helpers.py']) {
    assert.deepEqual(flaggedCodes(finding(result, file)), ['tolerance_loosened'], `${file}: ${describe(result)}`);
  }
  const js = finding(result, 'tests/math.test.js').reasons[0];
  assert.deepEqual(js.detail, { before: '5', after: '1' });
  assert.equal(js.line, 12);
  assert.equal(finding(result, 'tests/test_geo.py').reasons[0].detail.before, '1e-6', 'the first widened value of the file');
  strategies.push(['loosen a tolerance (toBeCloseTo digits, pytest.approx rel, assertAlmostEqual places, InDelta, a TOLERANCE constant)', result]);
}
for (const [name, result] of strategies) assert.equal(result.checks_modified, true, name);
ok(`all ${strategies.length} synthetic strategies are flagged: ${strategies.map(([name]) => name.split(' (')[0]).join('; ')}`);

{
  // tightening a tolerance and adding an assertion are not flags
  const files = { ...BASE, 'tests/test_geo.py': 'def test_area():\n    assert area(1) == pytest.approx(3.14159, rel=1e-6)\n' };
  const dir = makeRepo('tighten', files);
  edit(dir, 'tests/test_geo.py', (text) => text.replace('rel=1e-6', 'rel=1e-9'));
  edit(dir, 'tests/math.test.js', (text) => text.replace('toBeCloseTo(3.14159, 5)', 'toBeCloseTo(3.14159, 7)'));
  const result = await detect(dir);
  assert.equal(result.checks_modified, false, describe(result));
  ok('a tolerance made stricter (rel 1e-6 -> 1e-9, toBeCloseTo digits 5 -> 7) is not a flag');
}
{
  // `|| true` appended to a script a criterion runs, and a deleted test file
  const dir = makeRepo('masked');
  write(dir, 'package.json', pkg({ lint: 'eslint . || true' }));
  remove(dir, 'tests/math.test.js');
  const result = await detect(dir);
  assert.deepEqual(flaggedCodes(finding(result, 'package.json')), ['check_script_changed', 'failure_masked'], describe(result));
  assert.deepEqual(flaggedCodes(finding(result, 'tests/math.test.js')), ['test_file_deleted']);
  assert.equal(finding(result, 'tests/math.test.js').status, 'D');
  assert.deepEqual(criterion(result, 'lint').reasons.map((reason) => reason.code).sort(), ['check_script_changed', 'failure_masked', 'test_file_deleted']);
  assert.deepEqual(criterion(result, 'unit').reasons.map((reason) => reason.code), ['test_file_deleted']);
  ok('`|| true` appended to the lint script: check_script_changed + failure_masked on "lint" only; a deleted test file: test_file_deleted on both criteria');
}
{
  // the script a criterion runs reaches other scripts: npm run X inside it, pre/post scripts
  const dir = makeRepo('script-closure', { ...BASE, 'package.json': pkg({ test: 'npm run unit && npm run e2e', unit: 'jest', e2e: 'playwright test', pretest: 'tsc' }) });
  write(dir, 'package.json', pkg({ test: 'npm run unit && npm run e2e', unit: 'jest --passWithNoTests', e2e: 'exit 0', pretest: 'tsc' }));
  const result = await detect(dir);
  const keys = finding(result, 'package.json').reasons.filter((reason) => reason.code === 'check_script_changed').map((reason) => reason.detail.key);
  assert.deepEqual(keys, ['unit', 'e2e'], describe(result));
  assert.ok(flaggedCodes(finding(result, 'package.json')).includes('failure_masked'), '`exit 0` as a script');
  assert.deepEqual(flaggedCriteria(result), ['unit']);
  ok('scripts reached from the one a criterion runs (`npm run unit && npm run e2e`) are compared too; `exit 0` is failure_masked');
}
{
  // test configuration: package.json "jest", pyproject [tool.pytest], a csproj with the test SDK, a new jest.config.js
  const files = {
    ...BASE,
    'package.json': pkg({}, { jest: { testPathIgnorePatterns: ['/node_modules/'] } }),
    'pyproject.toml': '[project]\nname = "demo"\ndependencies = ["requests"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n',
    'Calc.Tests/Calc.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" />\n  </ItemGroup>\n</Project>\n',
    'src/App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n  </PropertyGroup>\n</Project>\n',
  };
  const dir = makeRepo('test-config', files);
  write(dir, 'package.json', pkg({}, { jest: { testPathIgnorePatterns: ['/node_modules/', 'math'] } }));
  edit(dir, 'pyproject.toml', (text) => text.replace('addopts = "-q"', 'addopts = "-q --deselect tests/test_calc.py::test_add"'));
  edit(dir, 'Calc.Tests/Calc.Tests.csproj', (text) => text.replace('</ItemGroup>', '  <Compile Remove="CalcTests.cs" />\n  </ItemGroup>'));
  edit(dir, 'src/App/App.csproj', (text) => text.replace('Exe', 'WinExe'));
  write(dir, 'jest.config.js', "module.exports = { testMatch: ['**/nothing/**'] };\n");
  const result = await detect(dir);
  for (const file of ['package.json', 'pyproject.toml', 'Calc.Tests/Calc.Tests.csproj', 'jest.config.js']) {
    assert.deepEqual(flaggedCodes(finding(result, file)), ['test_config_changed'], `${file}: ${describe(result)}`);
  }
  assert.deepEqual(finding(result, 'package.json').reasons[0].detail, { package: 'package.json', key: 'jest' });
  assert.equal(finding(result, 'src/App/App.csproj'), undefined, 'a project file without the test SDK is not test configuration');
  ok('test configuration: package.json "jest", pyproject [tool.pytest.ini_options], a test csproj, a new jest.config.js; a non-test csproj is not');
}
{
  // Makefile, a scripts/ file, a file a criterion names, CI workflows, paths the acceptance file protects
  const acceptance = `version: 1
criteria:
  - id: make
    text: make test passes
    checks:
      - run: make test
  - id: shell
    text: the check script passes
    checks:
      - run: bash ci/check.sh --strict
protected:
  - fixtures/golden/**
`;
  const files = {
    '.chatmcp/acceptance.yml': acceptance, 'Makefile': 'test:\n\tpytest -q\n', 'ci/check.sh': '#!/bin/sh\nset -e\npytest -q\n',
    'scripts/helper.sh': '#!/bin/sh\necho helper\n', 'fixtures/golden/out.txt': 'expected\n', '.github/workflows/ci.yml': WORKFLOW,
    '.github/workflows/old.yml': WORKFLOW, 'src/app.py': 'x = 1\n',
  };
  const dir = makeRepo('make-scripts', files);
  edit(dir, 'Makefile', (text) => text.replace('pytest -q', 'pytest -q -k "not slow"'));
  edit(dir, 'ci/check.sh', (text) => text.replace('pytest -q\n', 'pytest -q || true\n'));
  edit(dir, 'scripts/helper.sh', (text) => `${text}# a comment with || true is not a mask\n`);
  edit(dir, 'fixtures/golden/out.txt', () => 'whatever the code prints\n');
  edit(dir, '.github/workflows/ci.yml', (text) => text.replace('      - run: npm test\n', '      - run: npm test\n        continue-on-error: true\n'));
  remove(dir, '.github/workflows/old.yml');
  const result = await detect(dir);
  assert.deepEqual(flaggedCodes(finding(result, 'Makefile')), ['check_script_changed'], describe(result));
  assert.deepEqual(flaggedCodes(finding(result, 'ci/check.sh')), ['check_script_changed', 'failure_masked']);
  assert.deepEqual(flaggedCodes(finding(result, 'scripts/helper.sh')), ['check_script_changed'], 'a scripts/ file: changed, but a `|| true` in a comment is not a mask');
  assert.deepEqual(flaggedCodes(finding(result, 'fixtures/golden/out.txt')), ['protected_path_changed']);
  assert.deepEqual(flaggedCodes(finding(result, '.github/workflows/ci.yml')), ['failure_masked']);
  assert.deepEqual(flaggedCodes(finding(result, '.github/workflows/old.yml')), ['ci_workflow_deleted']);
  const via = (id) => criterion(result, id).reasons.map((reason) => `${reason.path}:${reason.via}`).sort();
  assert.deepEqual(via('make'), ['Makefile:make', 'fixtures/golden/out.txt:acceptance_protected', 'scripts/helper.sh:every_check']);
  assert.deepEqual(via('shell'), ['ci/check.sh:command_path', 'ci/check.sh:command_path', 'fixtures/golden/out.txt:acceptance_protected', 'scripts/helper.sh:every_check']);
  ok('Makefile (on "make" only), a file a criterion names (on that criterion, with failure_masked), scripts/, protected paths (every criterion), CI workflows (flagged, on no criterion)');
}

// ------------------------------------------------------------------ 3. ten ordinary diffs: exactly one flag, the documented one
{
  const benign = [
    ['B1 a new test file', (dir) => write(dir, 'tests/strings.test.js', "const { twice } = require('../src/util');\n\nit('doubles', () => {\n  expect(twice(2)).toBe(4);\n});\n")],
    ['B2 a new test case in an existing file', (dir) => edit(dir, 'tests/math.test.js', (text) => text.replace('});\n', "});\nit('adds zero', () => {\n  expect(add(0, 0)).toBe(0);\n});\n"))],
    ['B3 a source-only refactor', (dir) => {
      edit(dir, 'src/math.js', (text) => text.replaceAll('(a, b)', '(left, right)').replace('a + b', 'left + right').replace('a * b', 'left * right'));
      edit(dir, 'src/util.js', (text) => text.replace('(x) => add(x, x)', '(value) => add(value, value)'));
    }],
    ['B4 the README and a CI step', (dir) => {
      edit(dir, 'README.md', (text) => `${text}\nRun npm test.\n`);
      edit(dir, '.github/workflows/ci.yml', (text) => text.replace('      - run: npm ci\n', '      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: npm\n      - run: npm ci\n'));
    }],
    ['B5 a dependency added (lockfile changed)', (dir) => {
      write(dir, 'package.json', pkg({}, { dependencies: { lodash: '^4.17.21' } }));
      write(dir, 'package-lock.json', `${JSON.stringify({ name: 'demo', lockfileVersion: 3, packages: { 'node_modules/jest': { version: '29.7.0' }, 'node_modules/lodash': { version: '4.17.21' } } }, null, 2)}\n`);
    }],
    ['B6 a script no criterion runs', (dir) => write(dir, 'package.json', pkg({ format: 'prettier -w src tests' }))],
    ['B7 a pyproject dependency', (dir) => edit(dir, 'pyproject.toml', (text) => text.replace('dependencies = ["requests"]', 'dependencies = ["requests", "rich"]'))],
    ['B8 a test file renamed to another test name', (dir) => move(dir, 'tests/math.test.js', 'tests/arith.test.js')],
    ['B9 skip markers only in strings and comments', (dir) => {
      edit(dir, 'tests/math.test.js', (text) => text.replace("  it('multiplies'", "  it('labels', () => {\n    // it.skip( and xit( in a comment are not markers; neither is /* test.only( */\n    const label = \"it.skip(\";\n    expect(label).toBe(`it.skip(`);\n  });\n  it('multiplies'"));
      edit(dir, 'tests/test_calc.py', (text) => `${text}\n\ndef test_label():\n    # @pytest.mark.skip is only mentioned here\n    \"\"\"Not t.Skip() either.\"\"\"\n    assert "pytest.mark.skip" in LABELS\n`);
    }],
    ['B10 two assertions folded into a loop (the documented false positive)', (dir) => edit(dir, 'tests/math.test.js', (text) => text.replace('    expect(add(1, 2)).toBe(3);\n    expect(add(-1, 1)).toBe(0);\n', '    for (const [a, b, sum] of [[1, 2, 3], [-1, 1, 0]]) expect(add(a, b)).toBe(sum);\n'))],
  ];
  const files = {
    ...BASE,
    'pyproject.toml': '[project]\nname = "demo"\ndependencies = ["requests"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n',
    'tests/test_calc.py': 'from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n',
  };
  const flagged = [];
  for (const [name, change] of benign) {
    const dir = makeRepo(`benign-${name.split(' ')[0]}`, files);
    change(dir);
    const result = await detect(dir);
    assert.ok(result.findings.length + result.counts.changes > 0 || name.startsWith('B3'), `${name}: the diff is not empty`);
    if (result.checks_modified) flagged.push(`${name}: ${describe(result)}`);
    if (name.startsWith('B5')) {
      const lock = result.lockfiles.find((row) => row.path === 'package-lock.json');
      assert.equal(lock.status, 'modified');
      assert.equal(lock.sha256Before, sha256(Buffer.from(LOCK)));
      assert.equal(lock.sha256After, sha256(fs.readFileSync(path.join(dir, 'package-lock.json'))));
      assert.deepEqual(flaggedCodes(finding(result, 'package-lock.json')), [], 'a lockfile change is reported with its hashes, not flagged');
      assert.equal(finding(result, 'package-lock.json').reasons[0].code, 'lockfile_changed');
    }
    if (name.startsWith('B8')) {
      const row = finding(result, 'tests/arith.test.js');
      assert.deepEqual([row.status, row.oldPath, row.reasons[0].code], ['R', 'tests/math.test.js', 'test_file_renamed']);
    }
    if (name.startsWith('B4')) assert.deepEqual(finding(result, '.github/workflows/ci.yml').reasons.map((reason) => reason.code), ['ci_workflow_changed']);
  }
  assert.equal(flagged.length, 1, `exactly one of ten ordinary diffs is flagged:\n${flagged.join('\n')}`);
  assert.match(flagged[0], /^B10 /, 'and it is the documented false positive (fewer assertion calls after a refactor)');
  ok(`ten ordinary diffs (${benign.map(([name]) => name.split(' ')[0]).join(', ')}): exactly 1 flag, B10, the false positive the documentation names`);
}

// ------------------------------------------------------------------ 4. edge inputs
{
  // renames: out of the test conventions (flag), with an edit that removes an assertion (R, flagged for the assertion, not "deleted")
  let dir = makeRepo('rename-out');
  move(dir, 'tests/math.test.js', 'src/math-cases.js');
  let result = await detect(dir);
  let row = finding(result, 'src/math-cases.js');
  assert.deepEqual([row.status, row.oldPath, flaggedCodes(row)], ['R', 'tests/math.test.js', ['test_file_renamed_out']], describe(result));

  dir = makeRepo('rename-edit');
  move(dir, 'tests/math.test.js', 'tests/calc.test.js');
  edit(dir, 'tests/calc.test.js', (text) => text.replace('    expect(mul(2, 3)).toBe(6);\n', ''));
  result = await detect(dir);
  row = finding(result, 'tests/calc.test.js');
  assert.deepEqual([row.status, row.oldPath, flaggedCodes(row)], ['R', 'tests/math.test.js', ['assertions_removed']], describe(result));
  assert.ok(row.similarity >= 50 && row.similarity < 100, `similarity ${row.similarity}`);
  assert.equal(finding(result, 'tests/math.test.js'), undefined, 'no separate "deleted" row');

  dir = makeRepo('copy');
  fs.copyFileSync(path.join(dir, 'tests/math.test.js'), path.join(dir, 'tests/math-copy.test.js'));
  result = await detect(dir);
  row = finding(result, 'tests/math-copy.test.js');
  assert.deepEqual([row.status, row.oldPath, flaggedCodes(row)], ['C', 'tests/math.test.js', []], describe(result));
  assert.equal(result.checks_modified, false);
  ok('a test file renamed out of the conventions is flagged; renamed with an assertion removed is R + assertions_removed (similarity kept); a copy is C and not a flag');
}
{
  // a mode change only: committed executable, the work tree reads it as a plain file (Windows) or it is one (elsewhere)
  const dir = makeRepo('mode', BASE, { executable: ['tests/math.test.js'] });
  const result = await detect(dir);
  const row = finding(result, 'tests/math.test.js');
  assert.deepEqual([row.status, row.modeOnly, row.reasons.map((reason) => reason.code), row.flagged], ['M', true, ['mode_changed'], false], describe(result));
  assert.equal(result.checks_modified, false);
  ok('a mode change only (100755 -> 100644) is reported as mode_changed, not flagged');
}
{
  // binary files: a test fixture (flag: expected data changed), a source image (nothing)
  const files = { ...BASE, 'tests/fixtures/sample.bin': Buffer.from([0, 1, 2, 3, 0, 255]), 'src/logo.png': Buffer.from([137, 80, 78, 71, 0, 0]), 'tests/fixtures/expected.json': '{"sum": 3}\n' };
  const dir = makeRepo('binary', files);
  write(dir, 'tests/fixtures/sample.bin', Buffer.from([0, 1, 2, 4, 0, 255]));
  write(dir, 'src/logo.png', Buffer.from([137, 80, 78, 71, 0, 1]));
  write(dir, 'tests/fixtures/expected.json', '{"sum": 4}\n');
  const result = await detect(dir);
  assert.deepEqual(flaggedCodes(finding(result, 'tests/fixtures/sample.bin')), ['test_data_changed'], describe(result));
  assert.equal(finding(result, 'tests/fixtures/sample.bin').reasons[0].detail.binary, true);
  assert.deepEqual(flaggedCodes(finding(result, 'tests/fixtures/expected.json')), ['test_data_changed']);
  assert.equal(finding(result, 'src/logo.png'), undefined);
  ok('a binary test fixture and an expected-data file changed: test_data_changed; a binary source file: nothing');
}
{
  // CRLF: line endings only (not a flag); CRLF with an assertion removed (flag); a CRLF baseline read the same way
  let dir = makeRepo('crlf-only');
  write(dir, 'tests/math.test.js', MATH_TEST.replaceAll('\n', '\r\n'));
  let result = await detect(dir);
  assert.deepEqual(finding(result, 'tests/math.test.js').reasons.map((reason) => reason.code), ['line_endings_only'], describe(result));
  assert.equal(result.checks_modified, false);

  dir = makeRepo('crlf-edit');
  write(dir, 'tests/math.test.js', MATH_TEST.replace('    expect(mul(2, 3)).toBe(6);\n', '').replaceAll('\n', '\r\n'));
  result = await detect(dir);
  assert.deepEqual(flaggedCodes(finding(result, 'tests/math.test.js')), ['assertions_removed'], describe(result));

  dir = makeRepo('crlf-base', { ...BASE, 'tests/math.test.js': MATH_TEST.replaceAll('\n', '\r\n') });
  edit(dir, 'tests/math.test.js', (text) => text.replace("it('multiplies'", "it.only('multiplies'"));
  result = await detect(dir);
  const reason = finding(result, 'tests/math.test.js').reasons.find((row) => row.code === 'skip_marker_added');
  assert.equal(reason?.line, 8, describe(result));
  ok('CRLF: a change of line endings only is line_endings_only; CRLF with an assertion removed is flagged; a CRLF baseline gives the right line');
}
{
  // a path with spaces and non-ASCII letters
  const odd = 'tests/thư mục/kiểm tra số.test.js';
  const dir = makeRepo('odd-path', { ...BASE, [odd]: MATH_TEST });
  edit(dir, odd, (text) => text.replace("it('adds'", "it.skip('adds'"));
  move(dir, 'tests/math.test.js', 'tests/phép tính.test.js');
  const result = await detect(dir);
  assert.deepEqual(flaggedCodes(finding(result, odd)), ['skip_marker_added'], describe(result));
  const renamed = finding(result, 'tests/phép tính.test.js');
  assert.deepEqual([renamed.status, renamed.oldPath], ['R', 'tests/math.test.js']);
  ok('a path with spaces and Vietnamese letters is read and reported exactly (flag and rename)');
}
{
  // an empty diff
  const dir = makeRepo('empty');
  const result = await detect(dir);
  assert.equal(result.format, CHECK_CHANGES_FORMAT);
  assert.equal(result.checks_modified, false);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.criteria.map((row) => [row.id, row.checks_modified, row.reasons.length]), [['unit', false, 0], ['lint', false, 0], ['docs', false, 0]]);
  assert.equal(result.counts.changes, 0);
  assert.deepEqual(result.lockfiles, [{ path: 'package-lock.json', status: 'unchanged', sha256Before: sha256(Buffer.from(LOCK)), sha256After: sha256(Buffer.from(LOCK)) }]);
  assert.equal(result.summary, 'No modification of checks was found.');
  ok('an empty diff: no finding, every criterion false, the lockfile hashed as unchanged, a neutral summary');
}
{
  // a deleted package.json, an unreadable one (final), an unreadable baseline, a package.json no criterion uses
  let dir = makeRepo('pkg-deleted');
  remove(dir, 'package.json');
  let result = await detect(dir);
  assert.deepEqual(finding(result, 'package.json').reasons.map((reason) => `${reason.code}:${reason.detail.key}`), ['check_script_removed:test', 'check_script_removed:lint'], describe(result));
  assert.equal(finding(result, 'package.json').status, 'D');
  assert.deepEqual(flaggedCriteria(result), ['unit', 'lint']);

  dir = makeRepo('pkg-invalid');
  write(dir, 'package.json', '{ "name": "demo", "scripts": { "test": "jest", }');
  result = await detect(dir);
  assert.deepEqual(flaggedCodes(finding(result, 'package.json')), ['check_script_unreadable'], describe(result));
  assert.deepEqual(flaggedCriteria(result), ['unit', 'lint']);

  dir = makeRepo('pkg-invalid-base', { ...BASE, 'package.json': '{ not json' });
  write(dir, 'package.json', pkg());
  result = await detect(dir);
  assert.deepEqual(flaggedCodes(finding(result, 'package.json')), ['check_script_unreadable'], describe(result));

  const noScripts = `version: 1\ncriteria:\n  - id: py\n    text: pytest passes\n    checks:\n      - run: pytest -q\n`;
  dir = makeRepo('pkg-unused', { ...BASE, '.chatmcp/acceptance.yml': noScripts });
  write(dir, 'package.json', '{ broken');
  result = await detect(dir);
  assert.equal(result.checks_modified, false, `no criterion runs a script of this package.json: ${describe(result)}`);
  ok('package.json deleted (check_script_removed per key), unreadable now or at the baseline (check_script_unreadable), unreadable but unused (no flag)');
}
{
  // no acceptance file: findings without criteria; the acceptance object given by the caller wins over the file
  const files = { ...BASE };
  delete files['.chatmcp/acceptance.yml'];
  let dir = makeRepo('no-acceptance', files);
  edit(dir, 'tests/math.test.js', (text) => text.replace("it('adds'", "it.skip('adds'"));
  write(dir, 'package.json', pkg({ test: 'echo ok' }));
  let result = await detect(dir);
  assert.equal(result.checks_modified, true);
  assert.deepEqual(result.criteria, []);
  assert.deepEqual(flaggedCodes(finding(result, 'package.json')), ['check_script_changed'], 'with no criteria, `test` stands for the checks');
  dir = makeRepo('given-acceptance');
  write(dir, 'package.json', pkg({ test: 'echo ok' }));
  result = await detect(dir, { acceptance: { criteria: [{ id: 'other', text: 'x', checks: [{ run: 'npm run lint', cwd: '.' }] }] } });
  assert.deepEqual(result.criteria.map((row) => [row.id, row.checks_modified]), [['other', false]], 'the given criteria, which do not run `npm test`');
  ok('without an acceptance file the findings still come, with no criteria; criteria given by the caller are used instead of the file');
}
{
  // an ignored path: not seen (the documented limitation)
  const dir = makeRepo('ignored');
  write(dir, 'generated/tests/gen.test.js', "it.skip('x', () => {});\n");
  const result = await detect(dir);
  assert.equal(finding(result, 'generated/tests/gen.test.js'), undefined);
  assert.equal(result.checks_modified, false);
  assert.ok(result.limitations.some((row) => row.code === 'untracked-ignored-paths-not-covered'));
  ok('a change under a .gitignore\'d folder is not seen, and the report says so in `limitations`');
}
{
  // a huge diff: 2,500 source files changed, 300 new test files, one test file over the per-file read limit
  const files = { ...BASE };
  for (let index = 0; index < 2500; index += 1) files[`src/gen/m${index}.js`] = `exports.v${index} = ${index};\n`;
  const dir = makeRepo('huge', files);
  for (let index = 0; index < 2500; index += 1) write(dir, `src/gen/m${index}.js`, `exports.v${index} = ${index + 1};\n`);
  for (let index = 0; index < 300; index += 1) write(dir, `tests/gen/t${index}.test.js`, `it('t${index}', () => {\n  expect(${index}).toBe(${index});\n});\n`);
  write(dir, 'tests/math.test.js', `${MATH_TEST}${'// padding line to make the file large\n'.repeat(260_000)}`);
  const started = performance.now();
  let result = await detect(dir);
  const ms = performance.now() - started;
  assert.equal(result.counts.changes, 2801, 'every change is counted');
  assert.equal(result.counts.findings, 301);
  assert.deepEqual(flaggedCodes(finding(result, 'tests/math.test.js')), ['not_analyzed'], describe({ findings: result.findings.slice(0, 3) }));
  assert.equal(finding(result, 'tests/math.test.js').reasons[0].detail.why, 'too_large');
  assert.equal(result.counts.flagged, 1);
  assert.ok(ms < 60_000, `took ${ms} ms`);

  result = await detect(dir, { limits: { maxFindings: 10, maxReadBytes: 2_000 } });
  assert.equal(result.findings.length, 10, 'findings are capped');
  assert.equal(result.counts.omittedFindings, 291);
  assert.equal(result.findings[0].flagged, true, 'flagged findings come first');
  assert.ok(result.counts.notAnalyzed > 200, `the read budget leaves the rest not analyzed (${result.counts.notAnalyzed})`);
  assert.ok(result.findings.every((row) => row.flagged), 'files the budget left unread are flagged not_analyzed, never passed over');
  ok(`a huge diff (2,801 changes, a 10 MB test file) in ${Math.round(ms)} ms: the large file is not_analyzed (flagged); capped findings keep flagged first; a read budget leaves files not analyzed, flagged`);
}
{
  // gitTreeSide refuses what is not a revision, and a revision that does not exist
  const dir = makeRepo('revisions');
  await assert.rejects(gitTreeSide({ root: dir, rev: '--output=x', stateDir: fresh('state') }), /revision/);
  await assert.rejects(gitTreeSide({ root: dir, rev: 'no-such-branch', stateDir: fresh('state') }), /revision/);
  const side = await gitTreeSide({ root: dir, rev: git(dir, ['rev-parse', 'HEAD^{tree}']).stdout.trim(), stateDir: fresh('state') });
  assert.equal(side.entries.length, Object.keys(BASE).length, 'a tree id works as well as a commit');
  const contents = await side.read(['README.md', 'missing.txt']);
  assert.equal(contents.get('README.md').toString('utf8'), BASE['README.md']);
  assert.equal(contents.get('missing.txt'), null);
  await assert.rejects(detectCheckChanges({ baseline: side }), /final/);
  ok('gitTreeSide: an option-like or unknown revision is refused, a tree id is read, an absent path reads as null; detectCheckChanges needs both sides');
}

// ------------------------------------------------------------------ 5. wording and limitations
{
  const ACCUSATION = /cheat|fraud|dishonest|tamper|manipulat|sabotag|malicious|deceiv|decept|suspicious|\blie\b|\blying\b|\bgam(?:e|ed|ing) the\b|\bhack/i;
  const texts = [];
  for (const result of results) {
    texts.push(result.summary, ...result.limitations.map((row) => row.text));
    for (const row of result.findings) for (const reason of row.reasons) texts.push(reason.message);
    for (const row of result.criteria) for (const reason of row.reasons) texts.push(reason.message);
  }
  const accusing = [...new Set(texts.filter((text) => ACCUSATION.test(text)))];
  assert.deepEqual(accusing, [], 'no accusation in any text of any report');
  const flaggedSummaries = new Set(results.filter((result) => result.checks_modified).map((result) => result.summary));
  for (const summary of flaggedSummaries) assert.match(summary, /^Checks were modified during the task: /);
  assert.ok(texts.every((text) => typeof text === 'string' && text.length > 0 && text.length <= 300), 'every text is a short sentence');
  for (const result of results) assert.deepEqual(result.limitations.map((row) => row.code), [...LIMITATION_CODES]);
  assert.deepEqual([...LIMITATION_CODES], ['untracked-ignored-paths-not-covered', 'heuristics-may-flag-legitimate-changes', 'test-selection-unknown', 'protected-files-not-read']);
  ok(`${texts.length} texts of ${results.length} reports: neutral ("checks were modified"), none accusing; the four limitations are stated in every report`);
}

console.log(`PASS: proof tamper detector, ${checks} checks in ${elapsed()}`);
