// Which session of the ACP agent is which task of the Hub (plan task ux-21, session/load).
//
// A session id is the agent's own; the task it drives is the Hub's. When the editor starts the agent again and loads a session, the agent needs the task back: so the pair is kept
// in a file of its own in the state folder of the Hub, `acp-sessions.json`, next to the Hub's files and readable by the owner only. It holds ids and folders, never what was said.
// The file is written whole (a temporary file, then a rename) and read again at each look, because two editors may run two agents on one Hub. A file that cannot be read is an empty
// store: the worst that happens is that a session cannot be loaded, and the person starts a new one.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_STORED_SESSIONS = 256;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isEntry = (value) => isObject(value) && typeof value.taskId === 'string' && typeof value.cwd === 'string' && typeof value.workspacePath === 'string';
const shapeOf = ({ taskId, cwd, workspacePath }) => ({ taskId, cwd, workspacePath });

/** @param {{file: string, log?: (line: string) => void}} options */
export function createSessionStore({ file, log = () => {} }) {
  let writing = Promise.resolve();
  const read = async () => {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') log(`could not read ${file}: ${error.code ?? error.message}`); return {}; }
    try {
      const parsed = JSON.parse(text);
      if (isObject(parsed) && parsed.version === 1 && isObject(parsed.sessions)) return parsed.sessions;
    } catch { /* below */ }
    log(`could not read ${file}: it is not a store of sessions; it is taken as empty`);
    return {};
  };
  return {
    async get(id) {
      const entry = (await read())[id];
      return isEntry(entry) ? shapeOf(entry) : null;
    },
    put(id, entry) {
      // One write at a time from this process; the newest MAX_STORED_SESSIONS are kept.
      writing = writing.then(async () => {
        const sessions = Object.fromEntries(Object.entries(await read()).filter(([, value]) => isEntry(value)));
        sessions[id] = { ...shapeOf(entry), at: new Date().toISOString() };
        const kept = Object.entries(sessions).sort(([, a], [, b]) => String(a.at).localeCompare(String(b.at))).slice(-MAX_STORED_SESSIONS);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) }, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, file);
      });
      return writing;
    },
  };
}

/** The same shape, in memory: for the tests, and for a program that has no state folder. */
export function createMemoryStore() {
  const sessions = new Map();
  return {
    async get(id) { return sessions.has(id) ? { ...sessions.get(id) } : null; },
    async put(id, entry) { sessions.delete(id); sessions.set(id, shapeOf(entry)); while (sessions.size > MAX_STORED_SESSIONS) sessions.delete(sessions.keys().next().value); },
  };
}
