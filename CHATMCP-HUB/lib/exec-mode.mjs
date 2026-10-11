// How the public server runs the programs the agent asks for, and everything the rest of the Hub needs to know to do it that way.
//
//   broker     The programs run under a separate, unprivileged account through the command broker (lib/exec-broker.mjs, started by
//              docker/supervisor.mjs). They cannot read the Hub's environment or state, and nothing they started survives the command.
//   no-shell   The Hub could not get a second account (no root, or the platform forbids switching accounts), so it offers no way to run
//              commands at all: run_command is removed, the terminal and "run verification" refuse. File tools and the Git tools still
//              work (Git runs under the Hub's own account, but nothing can have changed the repository's configuration: the file tools
//              refuse .git and no program of the agent exists).
//   same-user  The programs run under the Hub's own account. They can read the Hub's secrets. It exists for tests on machines without
//              root and is refused unless CHATMCP_UNSAFE_SAME_USER_EXEC=1 confirms it (see public-config.mjs).
//
// The result is a plain object so the callers (hub.mjs, assemble.mjs, workspaces.mjs) do not branch on the mode themselves.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { BrokerClient } from './exec-broker.mjs';
import { setNewFileMode } from './fs-safe.mjs';
import { scrubEnv } from './shell-runner.mjs';

export const AGENT_HOME_DEFAULT = '/home/agent';
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';
// A command is handed to bash as one argument. The kernel refuses a single argument above 128 KiB and a character can take 4 bytes.
const MAX_COMMAND_CHARS_ARGV = 30_000;
const NO_SHELL_MESSAGE = 'Máy chủ không tách được quyền cho lệnh của agent nên chạy lệnh đã bị tắt.';

/**
 * The environment of programs run for the agent: an allow-list, so nothing in the Hub's own environment (the owner token, the model
 * key, the GitHub token, the platform's variables) can reach them by accident.
 */
export function buildAgentEnv({ hostEnv = process.env, home = AGENT_HOME_DEFAULT, name = 'agent' } = {}) {
  return {
    PATH: hostEnv.CHATMCP_AGENT_PATH || DEFAULT_PATH,
    HOME: home,
    USER: name,
    LOGNAME: name,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    TZ: hostEnv.TZ || 'UTC',
    NO_COLOR: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

/**
 * @param {object} config   the public configuration (resolvePublicConfig)
 * @param {object} [options]
 * @param {Function} [options.log]
 * @param {object} [options.env]           the Hub's environment
 * @param {Function} [options.makeClient]  (socketPath) => BrokerClient; replaceable for tests
 * @param {() => string[]} [options.secrets]
 */
export async function createExecution(config, { log = () => {}, env = process.env, makeClient = (socketPath) => new BrokerClient({ socketPath }), secrets = () => [] } = {}) {
  const mode = config.exec.mode;
  const commandMaxMs = config.exec.commandMaxSeconds * 1000;
  const limits = { maxCommandChars: MAX_COMMAND_CHARS_ARGV, maxTimeoutMs: commandMaxMs };
  const terminalLimits = { maxTimeoutMinutes: config.exec.commandMaxSeconds / 60, shellFile: '/bin/sh' };
  const hooksDirectory = env.CHATMCP_NO_HOOKS_DIR || undefined;

  if (mode === 'broker') {
    const client = makeClient(config.exec.broker);
    let hello;
    try { hello = await client.hello(); } catch (error) {
      client.close();
      throw new Error(`CHATMCP_EXEC_MODE=broker nhưng không nói chuyện được với môi giới lệnh (${path.basename(config.exec.broker)}): ${error.message}`);
    }
    // Files the Hub writes into a workspace must stay writable for the agent's account, which shares only the group.
    process.umask(0o002);
    setNewFileMode(0o666);
    const agentEnv = buildAgentEnv({ hostEnv: env, home: hello.agent.home, name: hello.agent.name });
    const spawnAgent = client.spawner;
    log(`Lệnh của agent chạy dưới tài khoản riêng (uid ${hello.agent.uid}) qua môi giới lệnh.`);
    return Object.freeze({
      mode,
      agent: hello.agent,
      spawn: spawnAgent,
      helperSpawn: spawnAgent,
      agentEnv,
      studioOptions: Object.freeze({
        exec: Object.freeze({
          mode, spawn: spawnAgent, env: agentEnv, hooksDirectory, safeDirectory: true, disabledTools: [], sharedWorkspace: true, ...limits,
          terminal: Object.freeze({ ...terminalLimits, disabled: null }),
          terminalEnv: (cwd) => ({ ...agentEnv, CHATMCP_WORKSPACE: cwd }),
        }),
      }),
      describe: () => ({ mode, agentUid: hello.agent.uid }),
      close: async () => { client.close(); },
    });
  }

  if (mode === 'same-user') {
    const home = path.join(os.tmpdir(), 'chatmcp-agent-home');
    const agentEnv = { ...scrubEnv(env, { secrets: secrets() }), HOME: home };
    const spawnPlain = (file, args, options) => spawn(file, args, options);
    log('ATTENTION: lệnh của agent chạy CÙNG tài khoản với Hub (same-user). Chỉ dùng để thử nghiệm.');
    return Object.freeze({
      mode,
      agent: null,
      spawn: undefined, // the runners' own defaults (child_process.spawn) are exactly this mode
      helperSpawn: spawnPlain,
      agentEnv,
      studioOptions: Object.freeze({
        exec: Object.freeze({
          mode, spawn: undefined, env: agentEnv, hooksDirectory: undefined, safeDirectory: false, disabledTools: [], sharedWorkspace: false, ...limits,
          terminal: Object.freeze({ maxTimeoutMinutes: terminalLimits.maxTimeoutMinutes, disabled: null }),
          terminalEnv: (cwd) => ({ ...agentEnv, CHATMCP_WORKSPACE: cwd }),
        }),
      }),
      describe: () => ({ mode }),
      close: async () => {},
    });
  }

  // no-shell
  const spawnPlain = (file, args, options) => spawn(file, args, options);
  const hubEnv = scrubEnv(env, { secrets: secrets() });
  log('Lệnh của agent bị tắt (no-shell): máy chủ không có tài khoản riêng để chạy chúng một cách an toàn.');
  return Object.freeze({
    mode: 'no-shell',
    agent: null,
    spawn: undefined,
    helperSpawn: spawnPlain,
    agentEnv: hubEnv,
    studioOptions: Object.freeze({
      exec: Object.freeze({
        mode: 'no-shell', spawn: undefined, env: undefined, hooksDirectory: undefined, safeDirectory: false, disabledTools: ['run_command', 'tasks_run', 'tasks_status', 'tasks_cancel', 'tasks_list', 'github_action', 'github_read'], sharedWorkspace: false, ...limits,
        terminal: Object.freeze({ maxTimeoutMinutes: terminalLimits.maxTimeoutMinutes, disabled: NO_SHELL_MESSAGE }),
        terminalEnv: undefined,
      }),
    }),
    describe: () => ({ mode: 'no-shell' }),
    close: async () => {},
  });
}
