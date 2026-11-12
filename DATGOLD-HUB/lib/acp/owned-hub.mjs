// The entry of a Hub that belongs to the process that started it (lib/launch.mjs launchOwned): the Hub itself, and a watch on its standard input.
//
// The starter holds the other end of the pipe that is this process's stdin and never writes to it. When the starter ends, however it ends (an editor kills the agent that started
// the Hub: TerminateProcess runs nothing, but the system closes the handles of a process that is gone), the pipe breaks, stdin reaches its end, and the Hub shuts down by the graceful
// way it always has: the SIGTERM handler of hub.mjs closes the server, stops the agents, removes the session file and releases the lock of the state folder. A Hub that was stopped by
// force would leave all three behind.
//
// If the end of stdin comes before the Hub has finished starting (its SIGTERM handler is registered at the end of start-up), the stop is made as soon as it has.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { main } from '../../hub.mjs';

const args = process.argv.slice(2);
const logFileIndex = args.indexOf('--log-file');
const logFile = logFileIndex >= 0 && args[logFileIndex + 1] ? path.resolve(args[logFileIndex + 1]) : null;

let started = false;
let ownerGone = false;
const stop = () => {
  if (started) process.emit('SIGTERM');
  else ownerGone = true;
};

process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.on('error', stop);
process.stdin.resume();
process.stdin.unref?.(); // the server keeps the process alive; this watch must not (a Hub that found its port taken returns from main() and has nothing else to wait for)

main(args).then(() => {
  started = true;
  if (ownerGone) process.emit('SIGTERM');
}, (error) => {
  const line = `[CHATMCP-HUB] ${error?.message ?? error}`;
  if (logFile) { try { appendFileSync(logFile, `${line}\n`, { mode: 0o600 }); } catch { /* the log is best effort */ } }
  process.exitCode = 1;
});
