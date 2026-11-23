// The two proof packs the renderers are tested with (docs/PROOF-RENDER.md), and the golden reports made of them:
//   evidenced.pack.json   every criterion evidenced or accepted by the owner, in Vietnamese, a complete cost, permission records;
//   hostile.pack.json     the texts of someone who wants the reader's page: markup, Markdown, links, pipes, fences, bidi and control
//                         characters in commands, folders, criterion texts, reasons, paths and names; every status, every check result.
// Both are pack files that `chatmcp verify check` accepts: the ledger is written by ProofLedger with a fixed clock, the statement is made by
// buildAgentChangeStatement and the file by encodePackFile, so nothing here is a hand-made statement.
//
// To make the packs and the golden reports again (after an intended change of the renderers):
//   node tests/fixtures/proof-render/fixture.mjs --write
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceSha256, parseAcceptance } from '../../../lib/proof/acceptance.mjs';
import { encodePackFile } from '../../../lib/proof/cli/check.mjs';
import { ProofLedger, checkReceipt } from '../../../lib/proof/ledger.mjs';
import { buildAgentChangeStatement } from '../../../lib/proof/pack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN = path.join(HERE, 'golden');
export const PACKS = Object.freeze(['evidenced', 'hostile']);
export const packFile = (name) => path.join(HERE, `${name}.pack.json`);
export const goldenFile = (name, lang, format) => path.join(GOLDEN, `${name}.${lang}.${format}`);

/** How the golden reports are made: the file name shown, and (evidenced) a rate, to show what one looks like. */
export const REPORT_OPTIONS = Object.freeze({
  evidenced: Object.freeze({ packName: 'evidenced.pack.json', vnd: Object.freeze({ rate: '25400', date: '2026-11-20', source: 'Vietcombank, tỷ giá bán ra' }) }),
  hostile: Object.freeze({ packName: 'hostile.pack.json' }),
});

const hex = (label, length = 40) => createHash('sha256').update(label).digest('hex').slice(0, length);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const START = Date.parse('2026-11-23T08:00:00.000Z');

const snapshot = (tree, extra = {}) => ({
  format: 'chatmcp.tree-snapshot/1', status: 'ok', treeAlgorithm: 'git-pinned-v1', tree, rawTree: null, objectFormat: 'sha1', full: true, engineReason: null, ignoreRules: 'git',
  files: 1234, bytes: 5_678_901, excluded: { protected: 2, runs: 1, gitlinks: 0 }, limits: { maxFiles: 200_000, maxBytes: 2 ** 31 },
  limitations: ['untracked-ignored-paths-not-covered'], takenAt: '2026-11-23T08:00:00.000Z', durationMs: 12, ...extra,
});

/** What ShellRunner.run() reports. */
const result = ({ cwd = '.', exitCode = 0, timedOut = false, cancelled = false, signal = null, stdout = '', shell = 'bash', durationMs = 7 } = {}) => ({
  cwd, shell, exitCode, signal, timedOut, cancelled, lingering: false, stdout, stderr: '', truncated: { stdout: false, stderr: false },
  outputSha256: { stdout: sha256(stdout), stderr: sha256('') }, outputBytes: { stdout: Buffer.byteLength(stdout), stderr: 0 }, durationMs,
});

/** The bytes of a ledger of `records` ([type, record]), one second apart from START. */
async function ledgerOf(records) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-render-'));
  try {
    let tick = 0;
    const ledger = new ProofLedger({ file: path.join(folder, 'ledger.jsonl'), now: () => new Date(START + (tick += 1) * 1000) });
    for (const [type, record] of records) await ledger.append(type, record);
    return fs.readFileSync(ledger.file);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

const yaml = (value) => JSON.stringify(value); // a double-quoted scalar of the acceptance file's YAML subset
const TOOLCHAIN = { node: 'v24.4.0', python: null, dotnet: null, git: 'git version 2.49.0' };
const receipt = (command, run, trees, toolchain = TOOLCHAIN) => ['check', checkReceipt({ command, result: result(run), toolchain, treeBefore: trees[0], treeAfter: trees[1] })];

// ------------------------------------------------------------------------------------------------------------------------- evidenced
const VI_DIFF = [
  'diff --git a/src/tính-tổng.mjs b/src/tính-tổng.mjs',
  `index ${hex('v1')}..${hex('v2')} 100644`,
  '--- a/src/tính-tổng.mjs',
  '+++ b/src/tính-tổng.mjs',
  '@@ -1,3 +1,4 @@',
  ' // tổng của hai số',
  '-export const cong = (a, b) => a - b;',
  '+export const cong = (a, b) => a + b;',
  '+export const tru = (a, b) => a - b;',
  ' export default cong;',
  'diff --git a/docs/huong dan.md b/docs/huong dan.md',
  'new file mode 100644',
  `index ${'0'.repeat(40)}..${hex('v3')}`,
  '--- /dev/null',
  '+++ b/docs/huong dan.md\t',
  '@@ -0,0 +1,2 @@',
  '+# Hướng dẫn',
  '+Chạy `node --test`.',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  `index ${hex('v4')}..${'0'.repeat(40)}`,
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-cũ',
  '\\ No newline at end of file',
  'diff --git a/logo.bin b/logo.bin',
  `index ${hex('v5')}..${hex('v6')} 100644`,
  'GIT binary patch',
  'literal 3',
  'Kcmb<$WdZ;I0001u0000',
  '',
  'literal 3',
  'Kcmb<$WdZ;I0001u0000',
  '',
  'diff --git a/run.sh b/run.sh',
  'old mode 100644',
  'new mode 100755',
  '',
].join('\n');

async function evidenced() {
  const before = snapshot(hex('evidenced-before'));
  const after = snapshot(hex('evidenced-after'), { files: 1235 });
  const acceptanceText = [
    'version: 1',
    'criteria:',
    '  - id: kiem-thu',
    `    text: ${yaml('Các kiểm thử đơn vị đều đạt, chạy hai lần liên tiếp')}`,
    '    checks:',
    '      - run: node --test',
    '        repeat: 2',
    '  - id: lint',
    `    text: ${yaml('Không còn cảnh báo lint; mã thoát của bộ kiểm là 3 như tài liệu ghi')}`,
    '    checks:',
    '      - run: npm run lint',
    '        cwd: packages/ui',
    '      - run: node lint.mjs',
    '        expect:',
    '          exit: 3',
    '  - id: giao-dien',
    `    text: ${yaml('Màn hình đăng nhập hiển thị đúng dấu tiếng Việt: ắ ằ ẳ ẵ ặ, ố ồ ổ ỗ ộ, ứ ừ ử ữ ự, đ Đ')}`,
    '    manual:',
    '      inspect:',
    '        - src/đăng-nhập.mjs',
    `      note: ${yaml('Xem ở cỡ chữ 200 %')}`,
    'reproduce:',
    '  setup:',
    '    - npm ci',
    '',
  ].join('\n');
  const ledger = await ledgerOf([
    ['task_start', { note: 'fixture' }],
    ['permission', { decision: 'approved' }],
    ['permission', { decision: 'approved' }],
    ['permission', { decision: 'denied' }],
    ['permission', { decision: 'policy' }],
    receipt('node --test', { exitCode: 0, stdout: '12 đạt\n', durationMs: 1840 }, [after, after]),
    receipt('node --test', { exitCode: 0, stdout: '12 đạt\n', durationMs: 1795 }, [after, after]),
    receipt('npm run lint', { exitCode: 0, cwd: 'packages/ui', durationMs: 912 }, [after, after]),
    receipt('node lint.mjs', { exitCode: 3, durationMs: 61_007 }, [after, after]),
    receipt('git status --short', { exitCode: 0, durationMs: 33 }, [before, before]),
    ['task_end', { note: 'fixture' }],
  ]);
  const acceptance = { ...parseAcceptance(acceptanceText), trusted: true, baselineSha256: acceptanceSha256(acceptanceText), edit: null };
  const clean = acceptance.criteria.map(({ id }) => ({ id, checks_modified: false, reasons: [] }));
  const statement = buildAgentChangeStatement({
    agent: { name: 'DatGold', version: '3.12.0' },
    model: { provider: 'nhà cung cấp mẫu', id: 'mô-hình-1', profileRevision: null },
    baseCommit: hex('base-commit'),
    trees: { before, after },
    diff: VI_DIFF,
    acceptance,
    checkChanges: { format: 'chatmcp.check-changes/1', checks_modified: false, criteria: clean, lockfiles: [{ path: 'package-lock.json', status: 'unchanged', sha256Before: hex('lock', 64), sha256After: hex('lock', 64) }] },
    ledger,
    ownerAcceptances: [{ criterionId: 'giao-dien', treeAlgorithm: after.treeAlgorithm, tree: after.tree, by: 'Nguyễn Thị Ánh', at: '2026-11-23T09:30:00Z' }],
    cost: { currency: 'USD', knownSubtotal: 1234.5678, complete: true },
  });
  return encodePackFile({ statement, diff: Buffer.from(VI_DIFF), ledger, acceptance: Buffer.from(acceptanceText) });
}

// --------------------------------------------------------------------------------------------------------------------------- hostile
/** The hostile texts, by name; the suite also puts each one into every text field of a statement. */
export const HOSTILE = Object.freeze({
  script: '<script>alert(1)</script>',
  closeStyle: '</style></code></td></table><script src=//evil.example/x.js></script>',
  attribute: '"><img src=x onerror=alert(1)>',
  singleQuote: "' onmouseover='alert(1)",
  javascriptUrl: 'javascript:alert(1)',
  markdownLink: '[x](javascript:alert(1))',
  markdownImage: '![x](https://evil.example/pixel.png)',
  referenceLink: '[x]: https://evil.example "t"',
  autolink: '<https://evil.example> www.evil.example mail@evil.example',
  mention: '@octocat @org/team #1 GH-1 pddczpl/ChatMCP#1',
  fence: '```\n# heading\n```',
  backticks: '`` ` ``` ````',
  edgeBackticks: '`x`',
  tableLine: '| a | b | c |',
  tableDelimiter: '|---|---|',
  backslashPipe: '\\| \\\\| \\\\\\| end\\',
  entity: '&lt;script&gt; &#60; &amp; &copy;',
  bidi: 'safe\u202Egpj.exe\u202C \u2066iso\u2069 \u200E\u200F\u061C',
  controls: 'nul\u0000 esc\u001B[31m bel\u0007 cr\r lf\n tab\t del\u007F c1\u0085\u009B',
  invisible: 'zero\u200Bwidth\u200D \u2060 \uFEFF soft\u00ADhyphen \u{E0041} \u2028\u2029 nbsp\u00A0 wide\u3000',
  normalises: '\u1FEF\u1FEF\u1FEF \u037E <\u0338 >\u0338 =\u0338',
  leadingMark: '\u0338\u0301x',
  markers: '⟦U+202E⟧',
  html5: '<svg/onload=alert(1)> <iframe srcdoc="<b>"> <!-- c --> <![CDATA[x]]> <?php ?> {{7*7}} ${7*7}',
  emphasis: '*a* _b_ ~~c~~ **d** $x$ $`y`$ :smile:',
});

const HOSTILE_DIFF = [
  'diff --git a/<img src=x onerror=alert(1)>.js b/<img src=x onerror=alert(1)>.js',
  `index ${hex('h1')}..${hex('h2')} 100644`,
  '--- a/<img src=x onerror=alert(1)>.js\t',
  '+++ b/<img src=x onerror=alert(1)>.js\t',
  '@@ -1,2 +1,2 @@',
  '--- a/decoy',
  '-diff --git a/decoy b/decoy',
  '+++ b/decoy',
  '+| a | b |',
  'diff --git a/safe\u202Egpj.exe b/safe\u202Egpj.exe',
  'new file mode 100644',
  `index ${'0'.repeat(40)}..${hex('h3')}`,
  '--- /dev/null',
  '+++ b/safe\u202Egpj.exe',
  '@@ -0,0 +1 @@',
  '+x',
  'diff --git "a/t\\303\\240i li\\341\\273\\207u\\t|`[x](y)\\n.md" "b/t\\303\\240i li\\341\\273\\207u\\t|`[x](y)\\n.md"',
  'deleted file mode 100644',
  `index ${hex('h4')}..${'0'.repeat(40)}`,
  '--- "a/t\\303\\240i li\\341\\273\\207u\\t|`[x](y)\\n.md"',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-x',
  '',
].join('\n');

async function hostile() {
  const before = snapshot(hex('hostile-before'));
  const after = snapshot(hex('hostile-after'), { engineReason: HOSTILE.script, limitations: ['untracked-ignored-paths-not-covered', 'counts-from-last-full-snapshot'] });
  const other = snapshot(hex('hostile-other'));
  const raw = snapshot(hex('hostile-raw'), { treeAlgorithm: 'raw-v1' });
  const check = (run, extra = []) => ['    checks:', `      - run: ${yaml(run)}`, ...extra];
  const RUN = {
    xss: `echo "<script>alert('xss')</script>" | tee out.txt`,
    attr: 'node -e "\\"><img src=x onerror=alert(1)>"',
    link: 'open "javascript:alert(1)" [x](javascript:alert(1)) ![i](https://evil.example/p.png)',
    fence: "printf '```' | cat `` ` ````",
    pipes: 'a || b | c \\| d \\\\| e \\',
    short: 'mail @octocat #1 https://evil.example',
    evidenced: 'echo "*bold* _it_ ~~s~~ &lt;b&gt;"',
    unrun: '</code></td></tr></table><h1>fake verdict</h1>',
  };
  const acceptanceText = [
    'version: 1',
    'criteria:',
    '  - id: xss', `    text: ${yaml(HOSTILE.script)}`, ...check(RUN.xss),
    '  - id: attr', `    text: ${yaml(HOSTILE.attribute)}`, ...check(RUN.attr),
    '  - id: link', `    text: ${yaml(`${HOSTILE.markdownLink} ${HOSTILE.markdownImage}`)}`, ...check(RUN.link),
    '  - id: fence', `    text: ${yaml('```` ``` ` fenced')}`, ...check(RUN.fence),
    '  - id: pipes', `    text: ${yaml(HOSTILE.backslashPipe)}`, ...check(RUN.pipes),
    '  - id: short', `    text: ${yaml(HOSTILE.mention)}`, ...check(RUN.short, ['        repeat: 2', '        cwd: "src/<b>x</b>"']),
    '  - id: ok', `    text: ${yaml(HOSTILE.emphasis)}`, ...check(RUN.evidenced, ['      - run: "true"']),
    '  - id: unrun', `    text: ${yaml(HOSTILE.closeStyle)}`, ...check(RUN.unrun),
    '  - id: look', `    text: ${yaml('| a | b |')}`, '    manual:', `      note: ${yaml(`${HOSTILE.html5} ${HOSTILE.mention}`)}`, '  - id: accepted', `    text: ${yaml(HOSTILE.singleQuote)}`,
    '    manual:', '      inspect:', '        - "docs/<i>x</i>.md"',
    '  - id: moved', `    text: ${yaml(HOSTILE.entity)}`, '    manual:', '      note: "x"',
    '',
  ].join('\n');
  const ledger = await ledgerOf([
    ['task_start', { note: 'fixture' }],
    ['permission', { decision: 'blocked' }], ['permission', { decision: 'expired' }], ['permission', { decision: 'cancelled' }], ['permission', { decision: HOSTILE.script }],
    ['uncertain', { reason: 'torn_tail' }], ['uncertain', { reason: HOSTILE.script }],
    receipt('git status', { exitCode: 0 }, [before, before]),
    receipt(RUN.xss, { exitCode: 1, durationMs: 1_234_567 }, [after, after]),
    receipt(RUN.attr, { exitCode: 0 }, [other, other]),
    receipt(RUN.link, { exitCode: 0 }, [after, after]),
    receipt(RUN.pipes, { exitCode: 0 }, [raw, raw]),
    receipt(RUN.short, { exitCode: 0, cwd: 'src/<b>x</b>' }, [after, after]),
    receipt(RUN.evidenced, { exitCode: 0 }, [after, after]),
    receipt('true', { exitCode: 0, shell: 'sh' }, [after, after]),
    receipt(HOSTILE.controls, { exitCode: null, timedOut: true, cwd: HOSTILE.bidi, shell: '<b>sh</b>' }, [after, other], { ...TOOLCHAIN, node: HOSTILE.script }),
    receipt(HOSTILE.bidi, { exitCode: null, cancelled: true }, [null, null]),
    receipt(HOSTILE.fence, { exitCode: null, signal: '<b>KILL' }, [before, before]),
    receipt(`${HOSTILE.backticks} ${'x'.repeat(4200)}`, { exitCode: 2 }, [before, after]),
  ]);
  const acceptance = {
    ...parseAcceptance(acceptanceText), trusted: true, baselineSha256: acceptanceSha256(acceptanceText),
    edit: { code: 'acceptance_edited', deleted: false, unparseable: null, removed: [], added: [], changed: ['xss'], sections: [] },
  };
  const rows = acceptance.criteria.map(({ id }) => ({ id, checks_modified: false, reasons: [] }));
  const modified = rows.find((row) => row.id === 'link');
  modified.checks_modified = true;
  modified.reasons = [
    { code: 'assertions_removed', path: `tests/${HOSTILE.markdownLink}.test.mjs` }, { code: 'test_file_deleted', path: `tests/${HOSTILE.attribute}.mjs` },
    { code: 'protected_path_changed', path: `a${HOSTILE.bidi}|b` },
  ];
  const statement = buildAgentChangeStatement({
    agent: { name: HOSTILE.script, version: '1.0 | [x](javascript:alert(1))' },
    model: { provider: HOSTILE.attribute, id: HOSTILE.markdownImage, profileRevision: HOSTILE.bidi },
    baseCommit: null,
    commit: hex('hostile-commit'),
    trees: { before, after },
    diff: HOSTILE_DIFF,
    acceptance,
    checkChanges: {
      format: 'chatmcp.check-changes/1', checks_modified: true, criteria: rows,
      lockfiles: [
        { path: `${HOSTILE.attribute}.lock`, status: 'modified', sha256Before: hex('a', 64), sha256After: hex('b', 64) }, { path: 'new|`lock`', status: 'added', sha256Before: null, sha256After: hex('c', 64) },
        { path: 'gone.lock', status: 'deleted', sha256Before: hex('d', 64), sha256After: null }, { path: 'same.lock', status: 'unchanged', sha256Before: hex('e', 64), sha256After: hex('e', 64) },
      ],
    },
    ledger,
    ownerAcceptances: [
      { criterionId: 'accepted', treeAlgorithm: after.treeAlgorithm, tree: after.tree, by: HOSTILE.markdownLink, at: '2026-11-23T09:30:00Z' },
      { criterionId: 'moved', treeAlgorithm: after.treeAlgorithm, tree: other.tree, by: HOSTILE.script, at: '2026-11-23T09:31:00Z' },
    ],
    cost: { currency: 'USD', knownSubtotal: 0.0000125, complete: false },
    limits: { maxOtherReceipts: 4, maxUncertain: 1 },
  });
  return encodePackFile({ statement, diff: Buffer.from(HOSTILE_DIFF), ledger, acceptance: Buffer.from(acceptanceText) });
}

/** The bytes of a pack, made again (the committed file is what the suite renders). */
export const buildPack = (name) => ({ evidenced, hostile }[name]());

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--write')) {
    console.error('usage: node tests/fixtures/proof-render/fixture.mjs --write');
    process.exit(2);
  }
  fs.mkdirSync(GOLDEN, { recursive: true });
  for (const name of PACKS) fs.writeFileSync(packFile(name), await buildPack(name));
  const { readPackFile } = await import('../../../lib/proof/cli/check.mjs');
  const { buildReport } = await import('../../../lib/proof/render/model.mjs');
  const { renderMarkdown } = await import('../../../lib/proof/render/md.mjs');
  const { renderHtml } = await import('../../../lib/proof/render/html.mjs');
  for (const name of PACKS) {
    const read = readPackFile(fs.readFileSync(packFile(name)));
    for (const lang of ['en', 'vi']) {
      const report = buildReport({ ...read, packChecked: true }, { lang, ...REPORT_OPTIONS[name] });
      fs.writeFileSync(goldenFile(name, lang, 'md'), renderMarkdown(report).text);
      fs.writeFileSync(goldenFile(name, lang, 'html'), renderHtml(report).text);
    }
  }
  console.log(`wrote ${PACKS.length} packs and ${PACKS.length * 4} reports`);
}
