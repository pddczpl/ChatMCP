// A hook runner in a process of its own, so a test can kill it the hard way (no shutdown handler runs) and then load the state it
// left behind in a fresh process. Not a suite: tests/verify-hooks-core.mjs spawns it.
//
//   node hooks-runner-child.mjs <hubDirectory> <workDirectory> <taskId> <event> <count|loop>
//
// The hooks come from <hubDirectory>/hooks.json, written by the test. After every run the child prints one line
// `COUNT <consecutive> <total>`: the counters the runner returned once it had persisted them. With a number it stops after that many
// runs and waits to be killed; with `loop` it keeps running.
import { HookRunner } from '../../lib/hooks.mjs';

const [hubDirectory, workDirectory, taskId, event, mode] = process.argv.slice(2);
const runner = new HookRunner({ hubDirectory });
const limit = mode === 'loop' ? Infinity : Number(mode);
for (let done = 0; done < limit; done += 1) {
  const outcome = await runner.run({ event, taskId, projectRoot: workDirectory, cwd: workDirectory, permissionMode: 'review', executionPolicy: 'host-review' });
  process.stdout.write(`COUNT ${outcome.retries.consecutive} ${outcome.retries.total}\n`);
}
process.stdout.write('IDLE\n');
setInterval(() => {}, 1000);
