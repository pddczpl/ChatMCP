// The frame every end-to-end suite (tests/verify-e2e-*.mjs) runs in.
//
// A suite is one scenario: a scratch folder, a scripted model, one or more REAL Hubs (hub-process.mjs), a time budget, checks
// that are counted and printed the same way, and cleanup that happens whether the scenario passed or not. Nothing here knows
// about a particular scenario; what a scenario asserts is written in the suite itself, next to the thing it exercises.
//
// Output follows the other suites: one "  ok - ..." line per check, then "PASS: ..." (exit 0) or "FAIL: ..." (exit 1).
// A scenario that cannot run on this machine prints "CHATMCP_TEST_SKIP: <reason>" and exits 0, which tests/run-all.mjs reports as
// SKIP and never as PASS. A part that cannot be verified at all in this build is reported as "BLOCKED: <what> - <why>".
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockModel } from './mock-model-server.mjs';
import { startHub } from './hub-process.mjs';

const LOG_TAIL_LINES = 60;
const MAX_DETAIL = 500;

class SkipSignal extends Error {}

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Looks for secret strings in every file under `directory`: the Hub's state folder, its log, a workspace. A needle is looked for
 * as written and as it would appear inside JSON. Returns positions only (needle index, relative file), never the text, and the
 * number of files read so that "nothing found" cannot be an empty promise.
 */
export function findNeedles(directory, needles, { skip = [] } = {}) {
  const wanted = needles.map((needle) => [Buffer.from(needle), Buffer.from(JSON.stringify(needle).slice(1, -1))]);
  const hits = [];
  let scanned = 0;
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = path.relative(directory, full).split(path.sep).join('/');
      if (skip.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      let content;
      try { content = fs.readFileSync(full); } catch { continue; }
      scanned += 1;
      wanted.forEach((spellings, index) => { if (spellings.some((spelling) => content.includes(spelling))) hits.push({ needle: index, file: relative }); });
    }
  };
  walk(directory);
  return { scanned, hits };
}

/** Runs `check` every `intervalMs` until it returns something truthy; used for conditions the Hub reaches on its own. */
export async function eventually(check, { timeoutMs = 20_000, intervalMs = 150, label = 'the condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 200)})`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * @param {{name: string, summary: string, budgetMs?: number}} spec
 * @param {(t: object) => Promise<void>} body
 */
export async function runScenario({ name, summary, budgetMs = 150_000 }, body) {
  // The long (not an 8.3 short name such as "USERNA~1") spelling of the folder, so that a path the Hub reports can be compared with ours.
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `chatmcp-e2e-${name}-`)));
  const hubs = [];
  const closers = [];
  const failures = [];
  const blocked = [];
  let checks = 0;
  let finished = false;

  const shortenDetail = (detail) => (detail === undefined || detail === '' ? '' : String(detail).replace(/\s+/g, ' ').slice(0, MAX_DETAIL));
  const dumpHubLogs = () => {
    for (const hub of hubs) {
      const lines = hub.logText().split('\n').filter(Boolean).slice(-LOG_TAIL_LINES);
      console.log(`--- ${path.basename(hub.logFile)} (last ${lines.length} lines) ---\n${lines.join('\n')}\n--- end of log ---`);
    }
  };
  const killEverything = () => { for (const hub of [...hubs].reverse()) { try { hub.killTree(); } catch { /* already gone */ } } };
  const removeScratch = () => {
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 }); } catch (error) {
      console.log(`  note - could not remove ${scratch} (${error.code ?? error.message}); delete it by hand`);
    }
  };

  const t = {
    name,
    scratch,
    /** A folder inside the scratch area (created if needed). */
    dir(...parts) { const target = path.join(scratch, ...parts); fs.mkdirSync(target, { recursive: true }); return target; },
    /**
     * A scripted model server that is closed at the end. See mock-model-server.mjs for the options. It refuses what the real APIs refuse
     * (a tool result in the wrong place, an unknown parameter, ...) on every protocol, Chat Completions included: the Hub talks Chat
     * Completions to the mock in these suites, so a request that OpenAI would answer with HTTP 400 fails the scenario here too.
     */
    async mock(options = {}) { const mock = await startMockModel({ strict: true, ...options }); closers.push(() => mock.close()); return mock; },
    /** A real Hub. Same `stateDir` as an earlier Hub models a restart. Stopped (and its children killed) at the end. */
    async hub(options = {}) {
      const hub = await startHub({ scratch, logName: `hub-${hubs.length + 1}.log`, ...options });
      hubs.push(hub);
      return hub;
    },
    /** Anything else that needs closing (a listener, a child process). `close` may be async. */
    own(close) { closers.push(close); return close; },
    check(condition, label, detail) {
      checks += 1;
      if (condition) { console.log(`  ok - ${label}`); return true; }
      const shown = shortenDetail(detail);
      failures.push(shown ? `${label} (${shown})` : label);
      console.log(`  not ok - ${label}${shown ? ` (${shown})` : ''}`);
      return false;
    },
    equal(actual, expected, label) {
      const same = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
      return t.check(same, label, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    note(text) { console.log(`  note - ${text}`); },
    /** A part of the scenario that cannot be verified in this build; reported, never counted as a pass. */
    blocked(what, why) { blocked.push(`${what} - ${why}`); console.log(`  BLOCKED - ${what}: ${why}`); },
    /** Ends the scenario as "cannot run here" (exit 0, reported as SKIP by run-all). */
    skip(reason) { throw Object.assign(new SkipSignal(reason), { skip: true }); },
    /** Stops the scenario at once when later steps make no sense without this one. */
    must(condition, label, detail) { if (!t.check(condition, label, detail)) throw new Error(`cannot go on: ${label}`); },
  };

  const watchdog = setTimeout(() => {
    if (finished) return;
    console.error(`FAIL: ${name} exceeded its ${budgetMs} ms budget`);
    dumpHubLogs();
    killEverything();
    removeScratch();
    process.exit(2);
  }, budgetMs);
  watchdog.unref();

  let skipped = null;
  try {
    await body(t);
  } catch (error) {
    if (error instanceof SkipSignal) skipped = error.message;
    else {
      failures.push(`the scenario stopped: ${error?.message ?? error}`);
      console.log(`  not ok - the scenario stopped: ${error?.message ?? error}`);
      if (error?.stack && !/cannot go on/.test(String(error.message))) console.log(String(error.stack).split('\n').slice(1, 6).join('\n'));
    }
  }

  if (failures.length) dumpHubLogs();
  // Stop the Hubs politely first (their children go with them), then force whatever is left, then the rest.
  for (const hub of [...hubs].reverse()) { try { await hub.stop({ graceMs: 6000 }); } catch { /* the next line handles it */ } }
  killEverything();
  for (const close of closers.reverse()) { try { await close(); } catch { /* best effort */ } }
  removeScratch();
  finished = true;
  clearTimeout(watchdog);

  if (skipped !== null) {
    console.log(`CHATMCP_TEST_SKIP: ${skipped}`);
    process.exitCode = 0;
  } else if (failures.length) {
    console.log(`FAIL: ${failures.length} of ${checks} checks failed in ${name}`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    for (const item of blocked) console.log(`BLOCKED: ${item}`);
    console.log(`PASS: ${checks} checks (${summary})${blocked.length ? `; ${blocked.length} part(s) BLOCKED, listed above` : ''}`);
    process.exitCode = 0;
  }
  // Anything still holding the event loop (a keep-alive socket) must not keep the run alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 2500).unref();
}
