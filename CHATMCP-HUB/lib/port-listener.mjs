// Which process listens on a loopback TCP port.
//
// The Hub's session file names the process that wrote it. A crash leaves that file behind, and a program that binds the port
// afterwards can answer /api/health like a Hub, so a client must not present the secret to "whatever answers on the port".
// The native clients ask Windows for the owner of the listening socket (HubLifecycle.ListenerPid) and compare it with the
// file's pid; this is the same question for Node.
//
//   Windows  netstat -ano (System32), parsed column by column. The state column is localised on non-English Windows, so a
//            listener is recognised by its wildcard foreign endpoint (0.0.0.0:0 or [::]:0), never by the word LISTENING.
//   Linux    /proc/net/tcp and tcp6 give the inodes of the listening sockets; /proc/<pid>/fd says which process holds each one.
//            A listener whose holder cannot be inspected (another account) is an error, not "nobody".
//   others   no lookup: the answer is an error, so the caller refuses to present the secret.
//
// What counts as a listener on `port`: a socket that a connection to 127.0.0.1:port can reach, that is bound to 127.0.0.1 or to
// the IPv4 or IPv6 wildcard (a dual-stack `listen(port)` is the usual accident); on Windows one bound to 127.0.0.1 itself
// takes precedence over a wildcard one, as it does for the connections. One owner gives its pid, no listener gives null,
// several different owners are ambiguous and throw.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const REACHABLE_NETSTAT = new Set(['127.0.0.1', '0.0.0.0', '[::]']);
// /proc/net/tcp prints each 32-bit word of an address in host (little-endian) order.
const REACHABLE_PROC_V4 = new Set(['0100007F', '00000000']);
const REACHABLE_PROC_V6 = new Set(['00000000000000000000000000000000', '0000000000000000FFFF000000000000', '0000000000000000FFFF00000100007F']);

function endpoint(text) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.%]+\]):(\d{1,5})$/.exec(text);
  return match ? { address: match[1].toLowerCase(), port: Number(match[2]) } : null;
}

/**
 * The process ids that own a listening socket on `port`, from the text of `netstat -ano`. Every TCP row must have the five
 * columns of the documented layout; anything else means the table cannot be trusted and throws.
 */
export function parseNetstat(text, port) {
  const exact = new Set(); // bound to 127.0.0.1 itself
  const wildcard = new Set(); // bound to 0.0.0.0 or [::]
  for (const line of String(text).split(/\r?\n/)) {
    if (!/^\s*TCP\b/i.test(line)) continue; // titles, the header row and UDP rows
    const row = /^\s*TCP\s+(\S+)\s+(\S+)\s+(.+?)\s+(\d+)\s*$/i.exec(line); // the state may be several words in some languages
    const local = row && endpoint(row[1]);
    const remote = row && endpoint(row[2]);
    if (!local || !remote) throw new Error(`unexpected line in the netstat table: ${JSON.stringify(line.trim().slice(0, 80))}`);
    const listening = remote.port === 0 && (remote.address === '0.0.0.0' || remote.address === '[::]');
    if (!listening || local.port !== port || !REACHABLE_NETSTAT.has(local.address)) continue;
    (local.address === '127.0.0.1' ? exact : wildcard).add(Number(row[4]));
  }
  // Windows hands a connection to the most specific listener, so a program that holds the wildcard does not receive what a Hub
  // bound to 127.0.0.1 is serving; it receives it only while nothing is bound to 127.0.0.1.
  return [...(exact.size > 0 ? exact : wildcard)].sort((a, b) => a - b);
}

/** The inodes of the listening sockets on `port` in the text of /proc/net/tcp (or tcp6 with `v6`). */
export function parseProcNetTcp(text, port, { v6 = false } = {}) {
  const reachable = v6 ? REACHABLE_PROC_V6 : REACHABLE_PROC_V4;
  const addressPattern = v6 ? /^([0-9A-F]{32}):([0-9A-F]{4})$/ : /^([0-9A-F]{8}):([0-9A-F]{4})$/;
  const inodes = new Set();
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!/^\s*sl\s+local_address\b/.test(lines[0] ?? '')) throw new Error('unexpected header in /proc/net/tcp');
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    const local = fields.length >= 10 ? addressPattern.exec(fields[1]) : null;
    if (!local || !/^[0-9A-F]{2}$/.test(fields[3]) || !/^\d+$/.test(fields[9])) throw new Error(`unexpected line in /proc/net/tcp: ${JSON.stringify(line.trim().slice(0, 80))}`);
    if (fields[3] === '0A' && parseInt(local[2], 16) === port && reachable.has(local[1]) && fields[9] !== '0') inodes.add(fields[9]);
  }
  return [...inodes];
}

function netstatPath() { return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netstat.exe'); }

/** The text of `netstat -ano`, from the system folder (not PATH: Git for Windows and others ship their own tools). */
function runNetstat() {
  return new Promise((resolve, reject) => {
    execFile(netstatPath(), ['-ano'], { encoding: 'latin1', windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`netstat failed: ${String(error.message).split('\n')[0]}`));
      else resolve(stdout);
    });
  });
}

const realProcfs = { readFile: (file) => fs.readFile(file, 'utf8'), readdir: (directory) => fs.readdir(directory), readlink: (link) => fs.readlink(link) };

/** The owners of the listening sockets on `port`. `procfs` is the three file system calls it needs, so a test can feed a made-up /proc. */
export async function linuxOwners(port, procfs = realProcfs) {
  const wanted = new Set();
  for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    let text;
    try { text = await procfs.readFile(file); }
    catch (error) { if (v6 && error.code === 'ENOENT') continue; throw new Error(`cannot read ${file}: ${error.code ?? error.message}`); }
    for (const inode of parseProcNetTcp(text, port, { v6 })) wanted.add(`socket:[${inode}]`);
  }
  if (wanted.size === 0) return [];
  const owners = new Set();
  const seen = new Set();
  for (const entry of await procfs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let descriptors;
    try { descriptors = await procfs.readdir(`/proc/${entry}/fd`); } catch { continue; } // exited meanwhile, or another account's
    for (const descriptor of descriptors) {
      let target;
      try { target = await procfs.readlink(`/proc/${entry}/fd/${descriptor}`); } catch { continue; }
      if (wanted.has(target)) { owners.add(Number(entry)); seen.add(target); }
    }
  }
  if (seen.size < wanted.size) throw new Error(`a socket that listens on port ${port} belongs to a process this account cannot inspect`);
  return [...owners].sort((a, b) => a - b);
}

/**
 * The process id that listens on `port`, or null when nothing does. Throws when the answer cannot be given with confidence
 * (several owners, an owner that cannot be inspected, an unreadable table, a platform without a lookup).
 */
export async function listenerPid(port, { platform = process.platform, procfs = realProcfs, netstat = runNetstat } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`invalid port ${port}`);
  let owners;
  if (platform === 'win32') owners = parseNetstat(await netstat(), port);
  else if (platform === 'linux') owners = await linuxOwners(port, procfs);
  else throw new Error(`no listener lookup for the platform ${platform} (supported: win32, linux)`);
  if (owners.length > 1) throw new Error(`ambiguous: processes ${owners.join(', ')} all listen on port ${port}`);
  return owners.length === 1 ? owners[0] : null;
}
