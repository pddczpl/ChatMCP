// scripts/verify-release-evidence.mjs is what stands between the sharded Hub run of a release and its publication (docs/RELEASING.md): the
// verify job of .github/workflows/release.yml gives it the evidence each shard uploaded, and it must refuse unless every suite of the commit
// ran exactly once, passed, and was neither skipped nor retried.
//
// The evidence here is real: the runner itself (tests/run-all.mjs --no-skip all --shard i/3 --json ...) runs throw-away suites of a temporary
// folder, so a change of its JSON or of its log that the check cannot read shows up here. Each defect is then put into a copy of that
// evidence and must be refused for its own reason; the untouched copy must be accepted.
//
// What this does NOT show: that GitHub hands the verify job these files. Only a release run on GitHub shows that (docs/RELEASING.md).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(TESTS, 'run-all.mjs');
const SCRIPT = path.resolve(TESTS, '..', '..', 'scripts', 'verify-release-evidence.mjs');
if (!existsSync(path.dirname(SCRIPT))) {
  console.log('CHATMCP_TEST_SKIP: the scripts folder was not found next to DATGOLD-HUB (the check needs the whole repository)');
  process.exit(0);
}
const { checkEvidence } = await import(pathToFileURL(SCRIPT).href);

let checks = 0;
const ok = (label) => { checks += 1; console.log(`  ok - ${label}`); };

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const PREFIX = 'ChatMCP-v0.0.0-hub-evidence-shard';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmcp-release-evidence-'));
const suitesFolder = path.join(root, 'suites');
const good = path.join(root, 'good');
const SUITES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'a-suite-whose-name-is-longer-than-the-column-of-the-log'].map((name) => `verify-${name}.mjs`).sort();

/** Run the real runner on the throw-away suites; the evidence of one shard as the hub-tests job of release.yml leaves it. */
async function makeShard(folder, shard, count) {
  await fs.mkdir(folder, { recursive: true });
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  const run = spawnSync(process.execPath, [RUNNER, '--tests-dir', suitesFolder, '--no-skip', 'all', '--shard', `${shard}/${count}`, '--json', path.join(folder, 'node-summary.json')], { encoding: 'utf8', env });
  assert.equal(run.status, 0, `the runner failed: ${run.stdout}${run.stderr}`);
  await fs.writeFile(path.join(folder, 'node-all.log'), run.stdout.replace(/\r?\n/g, '\r\n')); // Tee-Object of PowerShell writes CRLF
  await fs.writeFile(path.join(folder, 'commit.txt'), `${COMMIT}\r\n`); // Set-Content, the same
  const summary = JSON.parse(await fs.readFile(path.join(folder, 'node-summary.json'), 'utf8'));
  summary.summary.platform = 'win32'; // this suite also runs on Linux; a release runs on Windows only
  await fs.writeFile(path.join(folder, 'node-summary.json'), JSON.stringify(summary, null, 2));
}

const folderOf = (evidence, shard) => path.join(evidence, `${PREFIX}${shard}`);
const summaryFile = (evidence, shard) => path.join(folderOf(evidence, shard), 'node-summary.json');
const logFile = (evidence, shard) => path.join(folderOf(evidence, shard), 'node-all.log');

async function editSummary(evidence, shard, change) {
  const file = summaryFile(evidence, shard);
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify(change(parsed) ?? parsed));
}
async function editLog(evidence, shard, change) {
  const file = logFile(evidence, shard);
  const before = await fs.readFile(file, 'utf8');
  const after = change(before);
  assert.notEqual(after, before, 'the edit of the log changed nothing');
  await fs.writeFile(file, after);
}
/** One result gets another status, and the counts of the summary and the log follow, as the runner would have written them. */
async function restatus(evidence, shard, status) {
  let name;
  await editSummary(evidence, shard, (s) => { name = s.results[0].name; s.results[0].status = status; s.summary.pass -= 1; s.summary[status.toLowerCase()] += 1; });
  await editLog(evidence, shard, (text) => text
    .replace(new RegExp(`^PASS {4}${name.replace(/\./g, '\\.')}`, 'm'), `${status.padEnd(8)}${name}`)
    .replace(/SUMMARY: (\d+) pass/, (_, n) => `SUMMARY: ${Number(n) - 1} pass`)
    .replace(new RegExp(`0 ${status.toLowerCase()}`), `1 ${status.toLowerCase()}`));
}

const argumentsFor = (evidence) => ({ directory: evidence, shards: 3, commit: COMMIT, suites: SUITES });
const runScript = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

try {
  await fs.mkdir(suitesFolder);
  for (const name of SUITES) await fs.writeFile(path.join(suitesFolder, name), "console.log('PASS: nothing to see');\n");
  for (const shard of [1, 2, 3]) await makeShard(folderOf(good, shard), shard, 3);

  // ---- 1. the untouched evidence is accepted ------------------------------------------------------------------------------------------
  {
    const verdict = await checkEvidence(argumentsFor(good));
    assert.deepEqual(verdict.problems, []);
    assert.deepEqual(verdict.shards.map((shard) => shard.index), [1, 2, 3]);
    assert.equal(verdict.shards.reduce((sum, shard) => sum + shard.suites, 0), SUITES.length);
    assert.ok(verdict.shards.every((shard) => shard.seconds >= 0 && /^v\d+\./.test(shard.node)));
    ok(`the evidence of the real runner in 3 shards (${verdict.shards.map((shard) => shard.suites).join(' + ')} suites, CRLF log and commit, one name longer than the log column) is accepted`);
  }

  // ---- 2. the command line: the suite list comes from the runner of this checkout ------------------------------------------------------
  {
    const accepted = runScript(['--evidence', good, '--shards', '3', '--commit', COMMIT, '--tests-dir', suitesFolder]);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.match(accepted.stdout, new RegExp(`^OK: the 3 shards ran each of the ${SUITES.length} Hub suites of ${COMMIT} exactly once on Windows and every one passed`, 'm'));
    assert.match(accepted.stdout, /^\| 1 \| \d+ \| \d+\.\d \| v\d+\.\d+\.\d+ \|$/m, 'a table line per shard for the step summary');
    const extra = path.join(root, 'suites-with-one-more');
    await fs.cp(suitesFolder, extra, { recursive: true });
    await fs.writeFile(path.join(extra, 'verify-h.mjs'), "console.log('PASS');\n");
    const refused = runScript(['--evidence', good, '--shards', '3', '--commit', COMMIT, '--tests-dir', extra]);
    assert.equal(refused.status, 1, 'a suite of the checkout that no shard ran is refused');
    assert.match(refused.stderr, /verify-h\.mjs ran in no shard/);
    const real = runScript(['--evidence', good, '--shards', '3', '--commit', COMMIT]);
    assert.equal(real.status, 1, 'without --tests-dir the list is the one of the Hub beside the script, which the throw-away suites are not');
    assert.match(real.stderr, /verify-release-evidence\.mjs ran in no shard/);
    assert.match(real.stderr, /verify-a\.mjs is not a suite of this commit/);
    const empty = path.join(root, 'no-suites');
    await fs.mkdir(empty);
    const none = runScript(['--evidence', good, '--shards', '3', '--commit', COMMIT, '--tests-dir', empty]);
    assert.equal(none.status, 2, 'an empty list of suites is an error, not "nothing is missing"');
    assert.match(none.stderr, /no suite/i);
    for (const [args, why] of [
      [[], /--evidence/],
      [['--evidence', good, '--shards', '3'], /--commit/],
      [['--evidence', good, '--commit', COMMIT], /--shards/],
      [['--evidence', good, '--shards', '0', '--commit', COMMIT], /--shards/],
      [['--evidence', good, '--shards', '1.5', '--commit', COMMIT], /--shards/],
      [['--evidence', good, '--shards', '3', '--commit', 'main'], /--commit/],
      [['--evidence', good, '--shards', '3', '--commit', ''], /--commit/],
      [['--evidence', good, '--shards', '3', '--commit', COMMIT, '--skip-missing'], /Unknown option: --skip-missing/],
      [['--evidence'], /--evidence requires a value/],
    ]) {
      const run = runScript(args);
      assert.equal(run.status, 2, `usage error expected for ${JSON.stringify(args)}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, why);
    }
    const absent = runScript(['--evidence', path.join(root, 'nowhere'), '--shards', '3', '--commit', COMMIT, '--tests-dir', suitesFolder]);
    assert.equal(absent.status, 1, 'a folder that is not there is refused');
    assert.match(absent.stderr, /could not be read/);
    ok('the command line takes the list from `run-all.mjs --list` of the checkout (a new suite that no shard ran is refused, an empty list is an error), prints one table line per shard, and refuses 9 kinds of wrong usage');
  }

  // ---- 3. each defect of the evidence is refused, for its own reason -------------------------------------------------------------------
  const DEFECTS = [
    // the set of shards
    ['a shard that uploaded nothing', /shard 2: its evidence is missing/, (e) => fs.rm(folderOf(e, 2), { recursive: true })],
    ['a fourth shard', /-shard4: a release run of 3 shards has no shard 4/, (e) => fs.cp(folderOf(e, 1), folderOf(e, 4), { recursive: true })],
    ['one shard twice', /shard 1: its evidence is there 2 times/, (e) => fs.cp(folderOf(e, 1), path.join(e, 'ChatMCP-v0.0.0-other-shard1'), { recursive: true })],
    ['a folder that is no shard', /stray is not the evidence of a shard/, (e) => fs.mkdir(path.join(e, 'stray'))],
    ['a file beside the folders', /node-summary\.json is not the evidence of a shard/, (e) => fs.cp(summaryFile(e, 1), path.join(e, 'node-summary.json'))],
    ['the evidence of shard 1 uploaded as shard 2', /shard 2: the summary says shard 1\/3/, async (e) => { await fs.rm(folderOf(e, 2), { recursive: true }); await fs.cp(folderOf(e, 1), folderOf(e, 2), { recursive: true }); }],
    // what one shard says about itself
    ['a run that was split into another number', /shard 1: the summary says shard 1\/4/, (e) => editSummary(e, 1, (s) => { s.summary.shard.count = 4; })],
    ['a run without --shard', /shard 1: the summary says no shard/, (e) => editSummary(e, 1, (s) => { s.summary.shard = null; })],
    ['a shard of another list of suites', /shard 3: it was split from 9 suites, this commit has 8/, (e) => editSummary(e, 3, (s) => { s.summary.shard.of = 9; })],
    ['a shard that stopped early or was filtered', /shard 1: 2 of the 3 suites of the shard ran|shard 1: \d+ of the \d+ suites of the shard ran/, (e) => editSummary(e, 1, (s) => { s.summary.shard.suites += 1; })],
    ['a run on another system', /shard 2: it ran on linux/, (e) => editSummary(e, 2, (s) => { s.summary.platform = 'linux'; })],
    ['another commit', /shard 2: it ran on commit ffff/, (e) => fs.writeFile(path.join(folderOf(e, 2), 'commit.txt'), `${'f'.repeat(40)}\n`)],
    ['no commit', /shard 2: commit\.txt could not be read/, (e) => fs.rm(path.join(folderOf(e, 2), 'commit.txt'))],
    ['an empty commit file', /shard 2: it ran on commit \(empty\)/, (e) => fs.writeFile(path.join(folderOf(e, 2), 'commit.txt'), '\r\n')],
    ['no summary', /shard 3: node-summary\.json could not be read/, (e) => fs.rm(summaryFile(e, 3))],
    ['a summary that is not JSON', /shard 3: node-summary\.json could not be read/, (e) => fs.writeFile(summaryFile(e, 3), '{"summary": {')],
    ['a summary that is JSON but no summary', /shard 3: node-summary\.json is not a summary of run-all/, (e) => fs.writeFile(summaryFile(e, 3), '[]')],
    ['a summary without results', /shard 3: node-summary\.json is not a summary of run-all/, (e) => editSummary(e, 3, (s) => ({ summary: s.summary }))],
    ['a result that is not an object', /shard 3: node-summary\.json is not a summary of run-all/, (e) => editSummary(e, 3, (s) => { s.results[0] = null; })],
    // every suite passed
    ['a skipped suite', /shard 1: verify-\S+\.mjs is SKIP/, (e) => restatus(e, 1, 'SKIP')],
    ['a failed suite', /shard 1: verify-\S+\.mjs is FAIL/, (e) => restatus(e, 1, 'FAIL')],
    ['a suite that timed out', /shard 1: verify-\S+\.mjs is TIMEOUT/, (e) => restatus(e, 1, 'TIMEOUT')],
    ['a suite that passed only on a retry', /shard 1: verify-\S+\.mjs is FLAKY/, (e) => restatus(e, 1, 'FLAKY')],
    ['a PASS with another exit code', /shard 1: verify-\S+\.mjs is PASS with exit code 3/, (e) => editSummary(e, 1, (s) => { s.results[0].code = 3; })],
    ['a PASS without an exit code', /shard 1: verify-\S+\.mjs is PASS with exit code null/, (e) => editSummary(e, 1, (s) => { s.results[0].code = null; })],
    ['a count that says a suite was skipped', /shard 2: the summary counts 1 skip/, (e) => editSummary(e, 2, (s) => { s.summary.skip = 1; })],
    ['a count that says a suite was flaky', /shard 2: the summary counts 1 flaky/, (e) => editSummary(e, 2, (s) => { s.summary.flaky = 1; })],
    ['a count that says a suite failed', /shard 2: the summary counts 1 fail/, (e) => editSummary(e, 2, (s) => { s.summary.fail = 1; })],
    ['a count that says a suite timed out', /shard 2: the summary counts 1 timeout/, (e) => editSummary(e, 2, (s) => { s.summary.timeout = 1; })],
    ['a summary without the count of skips', /shard 2: the summary counts undefined skip/, (e) => editSummary(e, 2, (s) => { delete s.summary.skip; })],
    ['a count of passes that is too small', /shard 2: the summary counts \d+ pass of \d+, \d+ results are listed/, (e) => editSummary(e, 2, (s) => { s.summary.pass -= 1; })],
    ['a total that is too small', /shard 2: the summary counts \d+ pass of \d+, \d+ results are listed/, (e) => editSummary(e, 2, (s) => { s.summary.total -= 1; })],
    // exactly once
    ['a suite that ran in no shard', /verify-\S+\.mjs ran in no shard/, async (e) => {
      let name;
      await editSummary(e, 2, (s) => { name = s.results.pop().name; s.summary.total -= 1; s.summary.pass -= 1; s.summary.shard.suites -= 1; });
      await editLog(e, 2, (text) => text.split('\r\n').filter((line) => !line.includes(name)).join('\r\n').replace(/SUMMARY: (\d+) pass(.*)\(of \d+ suites/, (_, n, rest) => `SUMMARY: ${Number(n) - 1} pass${rest}(of ${Number(n) - 1} suites`));
    }],
    ['a suite that ran in two shards', /verify-\S+\.mjs ran in shards 1, 2/, async (e) => {
      let moved;
      await editSummary(e, 1, (s) => { moved = s.results[0]; });
      await editSummary(e, 2, (s) => { s.results.push(moved); s.summary.total += 1; s.summary.pass += 1; s.summary.shard.suites += 1; });
      await editLog(e, 2, (text) => text.replace(/\r\n\r\nSUMMARY: (\d+) pass(.*)\(of \d+ suites/, (_, n, rest) => `\r\nPASS    ${moved.name}  0.1s\r\n\r\nSUMMARY: ${Number(n) + 1} pass${rest}(of ${Number(n) + 1} suites`));
    }],
    ['a suite listed twice in one shard', /verify-\S+\.mjs ran in shards 1, 1/, (e) => editSummary(e, 1, (s) => { s.results.push(s.results[0]); s.summary.total += 1; s.summary.pass += 1; s.summary.shard.suites += 1; })],
    ['a suite this commit does not have', /verify-zzz\.mjs is not a suite of this commit/, (e) => editSummary(e, 1, (s) => { s.results[0].name = 'verify-zzz.mjs'; })],
    ['a result without a name', /shard 1: node-summary\.json is not a summary of run-all/, (e) => editSummary(e, 1, (s) => { delete s.results[0].name; })],
    // the log
    ['no log', /shard 3: node-all\.log could not be read/, (e) => fs.rm(logFile(e, 3))],
    ['an empty log', /shard 3: the log lists other suites than the summary/, (e) => fs.writeFile(logFile(e, 3), '')],
    ['the log of another shard', /shard 3: the log lists other suites than the summary/, (e) => fs.cp(logFile(e, 1), logFile(e, 3))],
    ['a log that says SKIP where the summary says PASS', /shard 3: the log lists other suites than the summary/, (e) => editLog(e, 3, (text) => text.replace(/^PASS {4}/m, 'SKIP    '))],
    ['a log without its summary line (a run that was cut off)', /shard 3: the log does not end with the summary of the run/, (e) => editLog(e, 3, (text) => text.replace(/SUMMARY:[^\r\n]*/, ''))],
    ['a log whose summary line counts a skip', /shard 3: the log does not end with the summary of the run/, (e) => editLog(e, 3, (text) => text.replace('0 skip', '1 skip'))],
  ];
  {
    for (const [index, [label, reason, defect]] of DEFECTS.entries()) {
      const evidence = path.join(root, `defect-${index}`);
      await fs.cp(good, evidence, { recursive: true });
      await defect(evidence);
      const { problems } = await checkEvidence(argumentsFor(evidence));
      assert.notDeepEqual(problems, [], `the defect "${label}" was not detected`);
      assert.ok(problems.some((problem) => reason.test(problem)), `the defect "${label}" was refused for another reason than ${reason}: ${problems.join(' / ')}`);
      if (index % 8 === 0) {
        const run = runScript(['--evidence', evidence, '--shards', '3', '--commit', COMMIT, '--tests-dir', suitesFolder]);
        assert.equal(run.status, 1, `the command line accepts the defect "${label}"`);
        assert.doesNotMatch(run.stdout, /^OK:/m);
      }
    }
    ok(`${DEFECTS.length} defects of the evidence (a missing, extra, repeated or exchanged shard; another commit, system, split or list; a run cut short; SKIP, FAIL, TIMEOUT, FLAKY, a wrong exit code or count; a suite in no shard, in two, twice in one or of another commit; a log that is missing, cut off or says otherwise) are each refused for their own reason`);
  }

  // ---- 4. what must not matter: a defect that is none --------------------------------------------------------------------------------------
  {
    const evidence = path.join(root, 'harmless');
    await fs.cp(good, evidence, { recursive: true });
    await fs.writeFile(path.join(folderOf(evidence, 1), 'another.log'), 'a file the check does not know');
    await fs.writeFile(path.join(folderOf(evidence, 2), 'commit.txt'), `\uFEFF${COMMIT}\n`); // Windows PowerShell writes a BOM, PowerShell 7 does not
    await fs.writeFile(summaryFile(evidence, 2), `\uFEFF${await fs.readFile(summaryFile(evidence, 2), 'utf8')}`);
    await editLog(evidence, 2, (text) => `\uFEFF${text.replace(/\r\n/g, '\n')}`);
    await editLog(evidence, 3, (text) => text.replace(/^PASS {4}/m, '    | FAIL    verify-quoted.mjs  1.2s\r\n$&')); // an indented line is what a suite printed, not a result
    assert.deepEqual((await checkEvidence(argumentsFor(evidence))).problems, []);
    ok('another file in a shard, a BOM, LF line ends and an indented quote of a result line in a log are not defects');
  }

  console.log(`PASS: ${checks} release evidence checks (${DEFECTS.length} defects)`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
