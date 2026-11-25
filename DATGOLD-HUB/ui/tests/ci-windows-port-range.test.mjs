import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The React E2E job of ci.yml widens the dynamic TCP port range on Windows before any browser or Node process of the job starts (docs/CI-HEALTH.md, "A port the
// machine would not give"). The step is a hedge against net::ERR_NO_BUFFER_SPACE (about one run in sixty), not a proven cure: this test only holds that it is there,
// that it is Windows-only, that it comes before everything that installs, builds or opens a socket, and that no port of the range is one fetch refuses to talk to
// (10080, most likely what failed run 45396561711).
const workflow = fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url));
const available = fs.existsSync(workflow);

/** The text of the job `name` of the workflow, and its steps in order (each starts at a "      - " line). */
function jobSteps(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && /^  [a-z][a-z0-9-]*:\s*$/.test(line));
  if (end < 0) end = lines.length;
  const job = lines.slice(start + 1, end);
  const steps = [];
  let current = null;
  let inSteps = false;
  for (const line of job) {
    if (/^    steps:\s*$/.test(line)) { inSteps = true; continue; }
    if (!inSteps) continue;
    if (/^      - /.test(line)) { current = [line]; steps.push(current); } else if (current) current.push(line);
  }
  return steps.map((step) => step.join('\n').trimEnd());
}

/** The ranges that `netsh int ipv4 set dynamicport tcp start=<n> num=<n>` lines of `text` set. */
function dynamicRanges(text) {
  return [...text.matchAll(/set dynamicport tcp start=(\d+) num=(\d+)/g)].map(([, start, num]) => ({ start: Number(start), num: Number(num) }));
}

/** The ports of the range that fetch refuses before it sends anything ("bad port", the block list of the Fetch standard). No request leaves: the dispatcher throws. */
async function refusedPorts({ start, num }) {
  const unsent = 'the request would have been sent';
  const dispatcher = { dispatch() { throw new Error(unsent); } };
  const refused = [];
  for (let port = start; port < start + num; port += 1) {
    const error = await fetch(`http://127.0.0.1:${port}/`, { dispatcher }).then(() => new Error(`port ${port} answered`), (reason) => reason.cause ?? reason);
    if (error.message === 'bad port') refused.push(port);
    else assert.equal(error.message, unsent);
  }
  return refused;
}

test('the React E2E job widens the dynamic TCP port range, on Windows only, before it installs or runs anything', { skip: available ? false : 'ci.yml is not next to DATGOLD-HUB' }, () => {
  const steps = jobSteps(fs.readFileSync(workflow, 'utf8'), 'react-e2e');
  assert.ok(steps && steps.length > 4, 'the job react-e2e and its steps are found');
  const index = (pattern) => steps.findIndex((step) => pattern.test(step));
  const widen = index(/name: Widen the dynamic TCP port range \(Windows\)/);
  assert.ok(widen >= 0, 'the step exists');
  assert.match(steps[widen], /if: runner\.os == 'Windows'/, 'it runs on Windows only (Linux has no such limit and no netsh)');
  assert.match(steps[widen], /netsh int ipv4 set dynamicport tcp start=10081 num=55454/, 'it sets the range 10081-65534');
  for (const later of [/uses: actions\/setup-node@/, /npm ci /, /playwright install/, /npm run test:unit/, /npm run test:e2e/]) {
    const at = index(later);
    assert.ok(at > widen, `the step comes before ${later}`);
  }
});

test('no port of that range is one that fetch refuses: a mock provider or a Hub on it cannot be reached', { skip: available ? false : 'ci.yml is not next to DATGOLD-HUB' }, async () => {
  const ranges = dynamicRanges(fs.readFileSync(workflow, 'utf8'));
  assert.equal(ranges.length, 1, 'one step of ci.yml sets the range');
  const [range] = ranges;
  assert.ok(range.start >= 1025 && range.num >= 255 && range.start + range.num <= 65536, 'netsh takes the range');
  assert.ok(range.num > 3 * 16384, 'it stays more than three times as wide as the default (49152-65535)');
  assert.deepEqual(await refusedPorts(range), []);
});

test('the scan for refused ports finds the ones the Fetch standard blocks, and the reader of ranges finds each range once', async () => {
  assert.deepEqual(await refusedPorts({ start: 10000, num: 200 }), [10080]);
  assert.deepEqual(await refusedPorts({ start: 6660, num: 12 }), [6665, 6666, 6667, 6668, 6669]);
  const text = ['netsh int ipv4 set dynamicport tcp start=1 num=2', 'netsh int ipv4 show dynamicport tcp', 'netsh int ipv4 set dynamicport tcp start=30 num=40'].join('\n');
  assert.deepEqual(dynamicRanges(text), [{ start: 1, num: 2 }, { start: 30, num: 40 }]);
});

test('the helper that reads a job finds the steps of a job and nothing of its neighbours', () => {
  const text = ['jobs:', '  a:', '    steps:', '      - name: one', '        run: x', '  b:', '    steps:', '      - name: two', '        run: y', ''].join('\n');
  assert.deepEqual(jobSteps(text, 'a'), ['      - name: one\n        run: x']);
  assert.deepEqual(jobSteps(text, 'b'), ['      - name: two\n        run: y']);
  assert.equal(jobSteps(text, 'c'), null);
});
