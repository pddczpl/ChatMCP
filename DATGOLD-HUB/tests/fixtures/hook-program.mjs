// The hook the hooks suites start: a real program that behaves as the JSON in argv[2] says. Not a suite.
//
//   log        append one line {pid, event, tool, id, session, cwd} to this file (how a test counts invocations)
//   dump       write the JSON it received on stdin to this file
//   env        write its environment to this file
//   where      write its working directory to this file
//   argv       write the arguments after the spec to this file
//   pids       start a long-lived process and write both pids to this file (a tree to kill)
//   sleepMs    wait before answering
//   write      create this file (a side effect only the hook itself can have)
//   stdout / stderr / stdoutRepeat / stderrRepeat / fill / exit   what it answers
//   ignoreStdin   exit without reading its input
//   logPayload    append the whole JSON it received, as one line, to this file (one line per invocation)
//   plan          { file, steps: [spec, ...] }  answer differently on each run: the number of runs so far is kept in `file`, and steps[n]
//                 is laid over this spec (the last step repeats). {steps: [{exit: 2, stderr: 'fix it'}, {exit: 0}]} blocks once, then passes.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const given = JSON.parse(process.argv[2] ?? '{}');
let spec = given;
if (given.plan) {
  let runs = 0;
  try { runs = Number(fs.readFileSync(given.plan.file, 'utf8')) || 0; } catch { /* the first run */ }
  fs.writeFileSync(given.plan.file, String(runs + 1));
  spec = { ...given, ...given.plan.steps[Math.min(runs, given.plan.steps.length - 1)] };
}
const chunks = [];
if (!spec.ignoreStdin) { for await (const chunk of process.stdin) chunks.push(chunk); }
const input = Buffer.concat(chunks).toString('utf8');
let payload = {};
try { payload = JSON.parse(input); } catch { /* not JSON: the dump shows it */ }
if (spec.log) fs.appendFileSync(spec.log, `${JSON.stringify({ pid: process.pid, event: payload.hook_event_name, tool: payload.tool_name, id: payload.tool_use_id, session: payload.session_id, cwd: payload.cwd })}\n`);
if (spec.logPayload) fs.appendFileSync(spec.logPayload, `${input.endsWith('\n') ? input.slice(0, -1) : input}\n`);
if (spec.dump) fs.writeFileSync(spec.dump, input);
if (spec.env) fs.writeFileSync(spec.env, JSON.stringify(process.env));
if (spec.where) fs.writeFileSync(spec.where, process.cwd());
if (spec.argv) fs.writeFileSync(spec.argv, JSON.stringify(process.argv.slice(3)));
if (spec.write) fs.writeFileSync(spec.write, 'written by the hook');
if (spec.pids) {
  // On Windows a Node parent puts the children it starts in a job object that dies with it, so the process that proves "the whole tree is
  // killed" must be detached from that job; its parent link stays, which is what taskkill /T follows. On POSIX it stays in the group.
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform === 'win32' });
  fs.writeFileSync(spec.pids, JSON.stringify({ hook: process.pid, grandchild: grandchild.pid }));
}
if (spec.sleepMs) await new Promise((resolve) => setTimeout(resolve, spec.sleepMs));
if (spec.fill) { // a long string is built here: a Windows command line cannot carry 30 KB
  let target = spec.stdout;
  for (const key of spec.fill.path.slice(0, -1)) target = target[key];
  target[spec.fill.path.at(-1)] = spec.fill.text.repeat(spec.fill.times);
}
if (spec.stdout !== undefined) process.stdout.write(typeof spec.stdout === 'string' ? spec.stdout : JSON.stringify(spec.stdout));
if (spec.stdoutRepeat) { for (let i = 0; i < spec.stdoutRepeat.times; i += 1) process.stdout.write(spec.stdoutRepeat.text); }
if (spec.stderr) process.stderr.write(spec.stderr);
if (spec.stderrRepeat) { for (let i = 0; i < spec.stderrRepeat.times; i += 1) process.stderr.write(spec.stderrRepeat.text); }
process.exitCode = spec.exit ?? 0;
