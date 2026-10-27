// What the suites that run under REAL operating-system accounts (verify-exec-separation.mjs, verify-e2e-public.mjs) have in common:
// finding user and group ids nobody uses, a temporary folder every account can walk through, and the basic tools. Nothing here
// changes the machine; the suites create and remove their own accounts' files and processes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listProcessesOfUid, locateLauncherTools } from '../../lib/exec-broker.mjs';

export const isRootOnLinux = () => process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;

/** The first of /usr/bin, /bin, /usr/sbin, /sbin that has an executable of that name; null when there is none. */
export async function findProgram(name) {
  for (const directory of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    const candidate = path.join(directory, name);
    if (await fs.access(candidate, fs.constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

/** { name: absolute path } for each name, and the list of those that are missing. */
export async function findPrograms(names) {
  const found = {};
  for (const name of names) found[name] = await findProgram(name);
  return { found, missing: Object.entries(found).filter(([, file]) => !file).map(([name]) => name) };
}

/**
 * Four ids (hub, agent, stranger, ws) that no account or group of this machine uses and that no process runs as. The reaper kills every
 * process of the agent's uid, so a uid that somebody else's process already uses must never be chosen.
 */
export async function pickIds() {
  const taken = new Set();
  for (const file of ['/etc/passwd', '/etc/group']) {
    for (const line of (await fs.readFile(file, 'utf8').catch(() => '')).split('\n')) { const id = Number(line.split(':')[2]); if (Number.isInteger(id)) taken.add(id); }
  }
  for (let start = 61100; start < 64000; start += 10) {
    const ids = { hub: start + 1, agent: start + 2, stranger: start + 3, ws: start + 4 };
    if (Object.values(ids).some((id) => taken.has(id))) continue;
    let busy = false;
    for (const id of Object.values(ids)) if ((await listProcessesOfUid(id)).length) busy = true;
    if (!busy) return ids;
  }
  return null;
}

/** A temporary folder (the system's, /tmp or /var/tmp) whose every parent can be walked through by any account; null when there is none. */
export async function walkableTemp() {
  for (const candidate of [os.tmpdir(), '/tmp', '/var/tmp']) {
    let directory = await fs.realpath(candidate).catch(() => null);
    let walkable = directory !== null;
    while (walkable && directory !== path.dirname(directory)) {
      walkable = ((await fs.stat(directory)).mode & 0o001) !== 0;
      directory = path.dirname(directory);
    }
    if (walkable) return await fs.realpath(candidate);
  }
  return null;
}

/**
 * Everything a suite needs before it can switch accounts, or the reason it cannot: { ok: true, tools, ids, tempRoot } or
 * { ok: false, reason }. `tools` is what lib/exec-broker.mjs's launcher uses (prlimit, setpriv, env).
 */
export async function realAccountsAvailable() {
  if (process.platform !== 'linux') return { ok: false, reason: 'the account separation uses Linux accounts, setpriv and /proc; it is not available on this platform' };
  if (!isRootOnLinux()) return { ok: false, reason: 'switching accounts needs root; run this suite as root (the Docker image does) to prove the separation' };
  const tools = await locateLauncherTools();
  if (!tools.prlimit || !tools.setpriv || !tools.env) return { ok: false, reason: 'util-linux (setpriv, prlimit) or env is not installed' };
  const ids = await pickIds();
  if (!ids) return { ok: false, reason: 'no unused user and group ids were found in 61100-63999' };
  const tempRoot = await walkableTemp();
  if (!tempRoot) return { ok: false, reason: 'no temporary folder that every account can walk through' };
  return { ok: true, tools, ids, tempRoot };
}
