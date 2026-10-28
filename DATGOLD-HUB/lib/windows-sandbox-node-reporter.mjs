// A correctness check for the pinned Node built-in runner, not an OS security
// boundary. Node's child-to-parent reporter protocol is not authenticated.
// In particular, a Node file wrapper can pass without registering any tests.
// Require actual registered/completed tests and each file's own final summary.
export const NODE_TEST_SUMMARY_PREFIX = 'CHATMCP_NODE_TEST_SUMMARY:';
const MAX_EVENTS = 100000;
const MAX_TESTS = 10000;
const diagnosticText = (value, limit) => typeof value === 'string' ?
  value.slice(0, limit).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') : '';
const keyFor = data => JSON.stringify([data.file, data.line, data.column,
  data.name, data.nesting, data.testId]);
const positiveCounts = counts => counts && Number.isSafeInteger(counts.tests) &&
  counts.tests > 0 && counts.tests <= MAX_TESTS && counts.passed === counts.tests &&
  ['failed', 'cancelled', 'skipped', 'todo'].every(name => counts[name] === 0);

export default async function* registeredNodeTests(events) {
  const files = new Map();
  const reasons = new Set();
  let finalSummary = null;
  let eventCount = 0;
  for await (const event of events) {
    if (++eventCount > MAX_EVENTS) {
      reasons.add('event_limit_exceeded');
      continue;
    }
    const data = event?.data;
    if (!data || typeof data !== 'object') {
      reasons.add('invalid_runner_event');
      continue;
    }
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const error = data.details?.error;
      yield 'CHATMCP_NODE_TEST_RESULT:' + JSON.stringify({
        type: event.type, name: diagnosticText(data.name, 256),
        ...(event.type === 'test:fail' ? {
          message: diagnosticText(error?.message, 1500),
          code: diagnosticText(error?.code, 128),
        } : {}),
      }) + '\n';
    }
    if (event.type === 'test:enqueue' && typeof data.file === 'string') {
      let file = files.get(data.file);
      if (!file) {
        if (files.size >= MAX_TESTS) { reasons.add('file_limit_exceeded'); continue; }
        // With the pinned process-isolated runner, the first enqueue for a
        // file is its parent wrapper. Never count that as a registered test.
        file = { wrapper: keyFor(data), registered: new Set(), passed: new Set(), summary: null };
        files.set(data.file, file);
      } else if (data.type === 'test') {
        const key = keyFor(data);
        if (key === file.wrapper || file.registered.has(key) || file.registered.size >= MAX_TESTS)
          reasons.add('ambiguous_test_registration');
        else file.registered.add(key);
      }
    } else if (event.type === 'test:pass') {
      const file = files.get(data.file);
      const key = keyFor(data);
      if (!file || key === file.wrapper) { reasons.add('file_pass_without_registered_test'); continue; }
      if (data.details?.type === 'suite') continue;
      if (!file.registered.has(key) || file.passed.has(key) || data.skip !== undefined || data.todo !== undefined)
        reasons.add('unmatched_or_skipped_test');
      else file.passed.add(key);
    } else if (event.type === 'test:fail') {
      reasons.add('test_failed');
    } else if (event.type === 'test:summary') {
      if (typeof data.file === 'string') {
        const file = files.get(data.file);
        if (!file || file.summary) reasons.add('ambiguous_file_summary');
        else file.summary = data;
      } else {
        if (finalSummary) reasons.add('duplicate_final_summary');
        finalSummary = data;
      }
    } else if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      // Escape embedded line breaks. A project's printed marker never becomes
      // a top-level summary line from this reporter.
      yield 'CHATMCP_NODE_TEST_LOG:' + JSON.stringify({ type: event.type,
        file: data.file, message: String(data.message ?? '') }) + '\n';
    }
  }
  let tests = 0;
  let pass = 0;
  for (const file of files.values()) {
    tests += file.registered.size;
    pass += file.passed.size;
    if (!file.summary?.success || !positiveCounts(file.summary?.counts) ||
        file.registered.size !== file.summary.counts.tests ||
        file.passed.size !== file.registered.size)
      reasons.add('missing_or_incomplete_file_tests');
  }
  if (!files.size || !tests) reasons.add('no_registered_tests');
  if (!finalSummary?.success || !positiveCounts(finalSummary?.counts) ||
      finalSummary.counts.tests !== tests || finalSummary.counts.passed !== pass)
    reasons.add('missing_or_inconsistent_final_summary');
  yield NODE_TEST_SUMMARY_PREFIX + JSON.stringify({
    version: 1, valid: reasons.size === 0, tests, pass, fail: finalSummary?.counts?.failed ?? 0,
    files: files.size, reasons: [...reasons], sourceProven: false,
    productionAuthenticated: false,
  }) + '\n';
}
