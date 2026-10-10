// Conservative risk classification of shell command text for the permission gate.
//
// This is a heuristic, NOT a sandbox. It never tries to prove a command safe:
// anything that is not positively recognised is 'exec' (always asks the user).
// A command is auto-approvable only when every segment is a known program and
// every argument is a plain, workspace-relative token.
//
//   read       inspect only            git status, ls, cat <file>, node --version
//   verify     project checks / runs   npm test, pytest, node app.js, cargo build
//   edit       local workspace edits   git add/commit, mkdir, echo x > file
//   exec       unknown / network / installs / expansions / nested shells
//   dangerous  deletion, push, history rewrite, system changes, pipe into interpreter

import { isProtectedPath, mayExpandToProtected } from './protected-paths.mjs';

export const KINDS = Object.freeze(['read', 'verify', 'edit', 'exec', 'dangerous']);
const RANK = Object.freeze(Object.fromEntries(KINDS.map((kind, index) => [kind, index])));
export const maxKind = (a, b) => (RANK[a] >= RANK[b] ? a : b);

const result = (kind, reason) => ({ kind, reason });
const read = (reason = 'Chỉ đọc') => result('read', reason);
const verify = (reason = 'Kiểm thử/build/chạy mã dự án') => result('verify', reason);
const edit = (reason = 'Sửa file trong workspace') => result('edit', reason);
const exec = (reason) => result('exec', reason);
const danger = (reason) => result('dangerous', reason);

// ---------------------------------------------------------------- tokenizer

/**
 * Split shell text into segments of tokens. Quoting is resolved per shell style
 * ('posix' for bash/sh, 'powershell'). Constructs whose result cannot be known
 * statically (variables, command substitution, grouping, call operator,
 * heredocs, unterminated quotes) are reported through `flags`.
 */
export function tokenize(text, style = 'posix') {
  const ps = style === 'powershell';
  const segments = [];
  const flags = new Set();
  let tokens = [];
  let redirects = [];
  let redirect = null;
  let current = '';
  let started = false;
  let quote = null;

  const endToken = () => {
    if (!started) return;
    if (redirect) { redirects.push({ op: redirect, target: current }); redirect = null; } else tokens.push(current);
    current = '';
    started = false;
  };
  const endSegment = (operator) => {
    endToken();
    if (redirect) { redirects.push({ op: redirect, target: '' }); redirect = null; }
    if (tokens.length || redirects.length) segments.push({ tokens, redirects, operatorAfter: operator });
    tokens = [];
    redirects = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote === "'") {
      if (ch !== "'") current += ch;
      else if (ps && next === "'") { current += "'"; i += 1; } else quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        if (ps && next === '"') { current += '"'; i += 1; } else quote = null;
      } else if (ps && ch === '`') {
        flags.add('escape');
        if (next !== undefined) { current += next; i += 1; }
      } else if (!ps && ch === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        current += next;
        i += 1;
      } else {
        if (ch === '$') flags.add('variable');
        if (ch === '`') flags.add('substitution');
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === '\\' && !ps) {
      if (next !== undefined) { current += next; started = true; i += 1; }
      continue;
    }
    if (ch === '`') {
      flags.add(ps ? 'escape' : 'substitution');
      if (ps && next !== undefined && next !== '\n') { current += next; started = true; i += 1; }
      continue;
    }
    if (ch === '$') { flags.add('variable'); current += ch; started = true; continue; }
    if (ch === '%' && /^%[A-Za-z_][A-Za-z0-9_]*%/.test(text.slice(i))) flags.add('variable');
    if (ch === '\n' || ch === '\r') { endSegment('newline'); continue; }
    if (/\s/.test(ch)) { endToken(); continue; }
    if (ch === '#' && !started) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i += 1;
      continue;
    }
    if (ch === ';') { endSegment(';'); continue; }
    if (ch === '&' && next === '>') {
      endToken();
      i += 1;
      redirect = '&>';
      continue;
    }
    if (ch === '&') {
      if (next === '&') { i += 1; endSegment('&&'); } else { endSegment('&'); flags.add('background-or-call'); }
      continue;
    }
    if (ch === '|') {
      if (next === '|') { i += 1; endSegment('||'); } else endSegment('|');
      continue;
    }
    if (ch === '>' || ch === '<') {
      if (started && /^\d$/.test(current)) { current = ''; started = false; } else endToken();
      let op = ch;
      if (next === ch) {
        op += ch;
        i += 1;
        if (ch === '<' && text[i + 1] === '<') { op += '<'; i += 1; }
      }
      if (op.startsWith('<<')) flags.add('heredoc');
      if (ch === '>' && text[i + 1] === '&' && /[\d-]/.test(text[i + 2] ?? '')) { i += 2; continue; } // 2>&1
      redirect = op;
      continue;
    }
    if ('(){}'.includes(ch)) flags.add('grouping');
    current += ch;
    started = true;
  }
  if (quote) flags.add('unterminated-quote');
  endSegment(null);
  return { segments, flags: [...flags] };
}

// ---------------------------------------------------------------- argument checks

const isAbsoluteLike = (value) => /^(?:[A-Za-z]:|\\\\|\/)/.test(value);
const hasParent = (value) => value.split(/[\\/]+/).includes('..');
const hasGlob = (value) => /[*?[]/.test(value);
const NULL_DEVICES = /^(?:\/dev\/null|nul|\$null)$/i;

/** The value carried by an option token: "--out=x" -> "x", "-Path:C:\\x" -> "C:\\x", "-o/etc/x" -> "/etc/x". */
function flagOperand(value) {
  const match = /^(--?[A-Za-z][\w-]*)[=:](.*)$/.exec(value);
  if (match) return match[2];
  if (/^-[A-Za-z]/.test(value) && /[\\/]/.test(value)) return value.slice(2);
  return '';
}

/** Why a (non-secret) argument is not a plain workspace-relative token, or null. */
function argProblem(arg, { glob = 'extension' } = {}) {
  const value = String(arg);
  const operand = value.startsWith('-') ? flagOperand(value) : value;
  if (!operand) return null;
  if (hasGlob(operand)) {
    if (glob === 'none') return 'wildcard';
    if (glob === 'extension' && !/\.[A-Za-z0-9]{1,8}$/.test(operand)) return 'wildcard';
  }
  if (isAbsoluteLike(operand)) return 'absolute path';
  if (hasParent(operand)) return 'parent directory';
  if (operand.startsWith('~')) return 'home directory';
  if (mayExpandToProtected(operand)) return 'protected path';
  return null;
}
const plain = (args, options) => args.every((arg) => argProblem(arg, options) === null);
const firstProblem = (args, options) => {
  for (const arg of args) {
    const problem = argProblem(arg, options);
    if (problem) return `${problem}: ${String(arg).slice(0, 60)}`;
  }
  return null;
};
const operands = (args) => args.filter((arg) => !String(arg).startsWith('-'));
const flagSet = (args) => new Set(args.filter((arg) => String(arg).startsWith('-')).map((arg) => String(arg).toLowerCase()));
const hasFlag = (args, ...names) => { const flags = flagSet(args); return names.some((name) => flags.has(name)); };
/** Short-option clusters such as -rn or -Rn contain the letter. */
const clusterHas = (args, letters) => args.some((arg) => /^-[A-Za-z0-9]+$/.test(String(arg)) && [...letters].some((letter) => String(arg).includes(letter)));

// ---------------------------------------------------------------- program tables

const DANGEROUS_PROGRAMS = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'format', 'format-volume', 'diskpart', 'mkfs', 'dd', 'fdisk', 'shred',
  'reg', 'regedit', 'sc', 'net', 'net1', 'netsh', 'schtasks', 'shutdown', 'restart-computer', 'stop-computer', 'taskkill',
  'stop-process', 'kill', 'pkill', 'killall', 'chmod', 'chown', 'chgrp', 'icacls', 'takeown', 'cacls', 'sudo', 'su', 'doas', 'runas',
  'iex', 'invoke-expression', 'set-executionpolicy', 'setx', 'set-service', 'new-service', 'remove-service', 'wmic', 'cipher',
  'vssadmin', 'bcdedit', 'mklink', 'ln', 'mount', 'umount', 'crontab',
]);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'powershell', 'pwsh', 'cmd', 'wsl', 'python', 'python3', 'py', 'node', 'perl', 'ruby', 'php', 'iex', 'invoke-expression', 'env', 'xargs', 'start', 'start-process', 'invoke-command', 'invoke-item', 'ii', 'eval', 'exec', 'source', '.']);
const NETWORK_PROGRAMS = new Set([
  'curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'nc', 'ncat', 'nmap',
  'ping', 'nslookup', 'tracert', 'traceroute', 'rsync', 'bitsadmin', 'certutil', 'start-bitstransfer', 'gh', 'az', 'aws', 'gcloud',
  'kubectl', 'terraform', 'docker', 'podman', 'winget', 'choco', 'scoop', 'apt', 'apt-get', 'yum', 'dnf', 'brew', 'snap', 'pacman', 'npx', 'pnpx', 'bunx',
]);
const LIST_PROGRAMS = new Set(['ls', 'dir', 'tree', 'pwd', 'where', 'which', 'whoami', 'hostname', 'date', 'uname', 'get-childitem', 'gci', 'get-location', 'gl', 'test-path', 'resolve-path', 'get-date', 'get-item', 'gi', 'get-command', 'ps', 'get-process', 'tasklist', 'basename', 'dirname', 'find', 'fd']);
const CONTENT_PROGRAMS = new Set(['cat', 'type', 'head', 'tail', 'more', 'less', 'wc', 'get-content', 'gc', 'select-string', 'sls', 'grep', 'egrep', 'fgrep', 'rg', 'findstr', 'sort', 'uniq', 'diff', 'fc', 'comm', 'nl', 'tac', 'md5sum', 'sha1sum', 'sha256sum', 'get-filehash', 'file', 'stat', 'du', 'df', 'measure-object', 'jq', 'cut', 'tr']);
const PRINT_PROGRAMS = new Set(['echo', 'write-output', 'write-host', 'printf', 'true', 'false', 'cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'sleep', 'start-sleep', 'clear', 'cls']);
const CD_PROGRAMS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);
const FILE_EDIT_PROGRAMS = new Set(['mkdir', 'md', 'new-item', 'ni', 'touch', 'cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni', 'set-content', 'add-content', 'out-file', 'tee', 'tee-object', 'sed', 'dos2unix', 'unix2dos']);
const VERSION_PROGRAMS = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'py', 'pip', 'pip3', 'git', 'cargo', 'rustc', 'rustup', 'go', 'dotnet', 'java', 'javac', 'mvn', 'gradle', 'tsc', 'ruby', 'gem', 'php', 'composer', 'gcc', 'g++', 'clang', 'cmake', 'make', 'docker', 'gh', 'pwsh', 'powershell']);
const CHECK_TOOLS = new Set(['pytest', 'ruff', 'mypy', 'flake8', 'pylint', 'black', 'isort', 'pyright', 'tox', 'nox', 'coverage', 'tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha', 'ava', 'tap', 'rspec', 'rubocop', 'phpunit', 'ctest', 'shellcheck', 'hadolint', 'golangci-lint', 'staticcheck', 'biome']);
const PYTHON_MODULES = new Set(['pytest', 'unittest', 'mypy', 'pyright', 'ruff', 'black', 'flake8', 'pylint', 'isort', 'coverage', 'compileall', 'doctest', 'py_compile', 'tox', 'nox', 'json.tool', 'timeit', 'cProfile', 'trace']);
const SCRIPT_NAME = /^(?:test|tests|lint|build|check|typecheck|type-check|types|tsc|format|fmt|verify|compile|coverage|e2e|unit|integration|spec|ci|test:[\w:.-]+|lint:[\w:.-]+|build:[\w:.-]+|check:[\w:.-]+|format:[\w:.-]+|typecheck:[\w:.-]+)$/;
const NODE_SAFE_FLAGS = new Set(['--test', '--check', '-c', '--no-warnings', '--enable-source-maps', '--trace-warnings', '--trace-uncaught', '--test-reporter=spec', '--test-reporter=tap', '--test-reporter=dot']);
const SCRIPT_FILE = { node: /^[\w@./\\-]+\.(?:js|mjs|cjs)$/i, python: /^[\w@./\\-]+\.py$/i };

function isScriptPath(value, pattern) {
  return pattern.test(value) && !isAbsoluteLike(value) && !hasParent(value) && !isProtectedPath(value);
}

// ---------------------------------------------------------------- git

const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'cat-file', 'grep', 'diff-tree', 'merge-base', 'name-rev', 'show-ref', 'count-objects', 'whatchanged', 'version', 'check-ignore', 'diff-index', 'for-each-ref', 'annotate']);
const GIT_DISCARD = new Set(['clean', 'filter-branch', 'filter-repo', 'gc', 'prune', 'update-ref', 'worktree', 'submodule', 'rm', 'push', 'send-pack', 'replace', 'reflog']);
const GIT_NETWORK = new Set(['clone', 'fetch', 'pull', 'remote', 'ls-remote', 'lfs', 'archive', 'bundle', 'request-pull']);
const GIT_HISTORY = new Set(['merge', 'rebase', 'cherry-pick', 'revert', 'apply', 'am', 'bisect', 'notes', 'sparse-checkout']);
const GIT_PREFIX_FLAGS = new Set(['--no-pager', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects']);

function classifyGit(args) {
  let rest = [...args];
  while (rest.length && String(rest[0]).startsWith('-')) {
    const option = String(rest[0]);
    if (GIT_PREFIX_FLAGS.has(option)) { rest.shift(); continue; }
    if (option === '-C' && rest.length > 1) {
      const problem = argProblem(rest[1], { glob: 'none' });
      if (problem) return exec(`git -C ngoài workspace (${problem})`);
      rest = rest.slice(2);
      continue;
    }
    if (option === '-c' || option.startsWith('--git-dir') || option.startsWith('--work-tree') || option === '--exec-path' || option === '-p' || option === '--paginate') return exec(`Tùy chọn git có thể chạy lệnh hoặc thoát workspace: ${option}`);
    if (option === '--version' || option === '-v') return read('Phiên bản git');
    break;
  }
  const sub = String(rest[0] ?? '').toLowerCase();
  const tail = rest.slice(1);
  if (!sub) return read('git không đối số');
  const problem = firstProblem(tail, { glob: 'extension' });
  if (GIT_DISCARD.has(sub)) {
    if (sub === 'reflog' && (!tail.length || ['show', 'list', 'exists'].includes(String(tail[0])))) return read('git reflog (đọc)');
    return danger(`git ${sub} có thể xóa dữ liệu, ghi đè lịch sử hoặc gửi mã ra ngoài`);
  }
  if (sub === 'reset') return hasFlag(tail, '--hard', '--merge', '--keep') ? danger('git reset --hard xóa thay đổi chưa commit') : exec('git reset thay đổi chỉ mục/lịch sử');
  if (GIT_NETWORK.has(sub)) return exec(`git ${sub} truy cập mạng`);
  if (GIT_HISTORY.has(sub)) return exec(`git ${sub} thay đổi cây làm việc/lịch sử`);
  if (GIT_READ.has(sub)) {
    if (hasFlag(tail, '--output', '--ext-diff', '--textconv', '-o', '--exec', '--open-files-in-pager', '-O') || tail.some((arg) => /^--output=/.test(String(arg)))) return exec(`git ${sub} với tùy chọn ghi file/chạy chương trình`);
    return problem ? exec(`git ${sub}: tham số không an toàn (${problem})`) : read(`git ${sub}`);
  }
  if (problem) return exec(`git ${sub}: tham số không an toàn (${problem})`);
  switch (sub) {
    case 'branch': {
      const names = operands(tail);
      if (hasFlag(tail, '-d', '-D', '--delete', '-f', '--force')) return danger('git branch -d/-D xóa nhánh');
      if (!names.length || hasFlag(tail, '--list', '-l')) return read('Liệt kê nhánh');
      return edit('Tạo/đổi tên nhánh cục bộ');
    }
    case 'tag':
      if (hasFlag(tail, '-d', '--delete', '-f', '--force')) return danger('git tag -d/-f xóa hoặc ghi đè tag');
      return !operands(tail).length || hasFlag(tail, '-l', '--list') ? read('Liệt kê tag') : edit('Tạo tag cục bộ');
    case 'stash': {
      const action = String(operands(tail)[0] ?? 'push').toLowerCase();
      if (['list', 'show'].includes(action)) return read('git stash (đọc)');
      if (['drop', 'clear'].includes(action)) return danger('git stash drop/clear xóa stash');
      return ['push', 'save', 'pop', 'apply'].includes(action) ? edit(`git stash ${action}`) : exec(`git stash ${action}`);
    }
    case 'config': {
      const names = operands(tail);
      if (hasFlag(tail, '--global', '--system', '--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e')) return exec('git config ghi cấu hình');
      if (hasFlag(tail, '--get', '--get-all') && /^user\.(?:name|email)$/i.test(String(names[0] ?? ''))) return read('Đọc danh tính git');
      return exec('git config có thể lộ hoặc thay đổi cấu hình');
    }
    case 'add': return edit('git add');
    case 'mv': return edit('git mv');
    case 'init': return edit('git init');
    case 'commit':
      return hasFlag(tail, '--amend') ? exec('git commit --amend viết lại commit gần nhất') : edit('git commit');
    case 'restore':
      return hasFlag(tail, '--staged', '-S') && !hasFlag(tail, '--worktree', '-W') ? edit('git restore --staged') : danger('git restore hủy thay đổi trong cây làm việc');
    case 'switch':
      return hasFlag(tail, '--force', '-f', '--discard-changes') ? danger('git switch --force hủy thay đổi') : edit('git switch');
    case 'checkout':
      if (hasFlag(tail, '-f', '--force') || tail.includes('--') || tail.includes('.')) return danger('git checkout ghi đè file trong cây làm việc');
      return hasFlag(tail, '-b', '-B') || operands(tail).length === 1 ? edit('git checkout nhánh') : exec('git checkout nhiều tham số');
    default:
      return exec(`Lệnh con git chưa được phân loại: ${sub}`);
  }
}

// ---------------------------------------------------------------- project tools

function classifyPackageManager(name, args) {
  const sub = String(operands(args)[0] ?? '').toLowerCase();
  const argsAfter = operands(args).slice(1);
  if (!sub) return hasFlag(args, '-v', '--version') ? read('Phiên bản') : exec(`${name} không đối số`);
  if (['test', 't', 'tst'].includes(sub)) return plain(args) ? verify(`${name} test`) : exec(`${name} test với tham số không an toàn`);
  if (['run', 'run-script', 'rum', 'urn'].includes(sub)) {
    const script = String(argsAfter[0] ?? '');
    return SCRIPT_NAME.test(script) && plain(args) ? verify(`${name} run ${script}`) : exec(`${name} run ${script || '?'}: script chưa được nhận diện là kiểm thử/build`);
  }
  if (['ls', 'list'].includes(sub) && name === 'npm') return plain(args) ? read('npm ls') : exec('npm ls với tham số không an toàn');
  if (name !== 'npm' && SCRIPT_NAME.test(sub) && plain(args)) return verify(`${name} ${sub}`);
  return exec(`${name} ${sub}: mạng, cài đặt hoặc chạy mã chưa rõ`);
}

function classifyNode(args) {
  if (hasFlag(args, '-v', '--version') && args.length === 1) return read('Phiên bản node');
  for (const arg of args) {
    if (!String(arg).startsWith('-')) break;
    if (!NODE_SAFE_FLAGS.has(String(arg))) return exec(`node ${arg}: có thể chạy mã nhúng hoặc nạp mô-đun`);
  }
  const target = operands(args)[0];
  if (hasFlag(args, '--test')) return plain(args) ? verify('node --test') : exec('node --test với tham số không an toàn');
  if (target && isScriptPath(String(target), SCRIPT_FILE.node) && plain(args)) return verify(`Chạy script ${String(target).slice(0, 60)}`);
  return exec('node với tham số chưa nhận diện (mã nhúng hoặc đường dẫn ngoài workspace)');
}

function classifyPython(name, args) {
  const rest = [...args];
  while (rest.length && /^-(?:\d(?:\.\d+)?|u|B|b|E|s|S|I|O|OO|q|W\w*|X\w*)$/.test(String(rest[0]))) {
    const flag = String(rest.shift());
    if ((flag === '-W' || flag === '-X') && rest.length) rest.shift();
  }
  if (hasFlag(rest, '-v', '--version', '-V') && rest.length === 1) return read('Phiên bản python');
  if (String(rest[0]) === '-m') {
    const module = String(rest[1] ?? '');
    if (module === 'venv' && plain(rest.slice(2))) return edit('Tạo môi trường ảo trong workspace');
    if (module === 'pip') {
      const action = String(operands(rest.slice(2))[0] ?? '').toLowerCase();
      return ['list', 'show', 'freeze', 'check', 'debug'].includes(action) ? read(`pip ${action}`) : exec(`pip ${action || '?'}: cài đặt/mạng`);
    }
    if (PYTHON_MODULES.has(module) && plain(rest.slice(2))) return verify(`python -m ${module}`);
    return exec(`python -m ${module || '?'}: mô-đun chưa được nhận diện`);
  }
  const target = operands(rest)[0];
  if (target && !String(rest[0]).startsWith('-') && isScriptPath(String(target), SCRIPT_FILE.python) && plain(rest)) return verify(`Chạy script ${String(target).slice(0, 60)}`);
  return exec(`${name} với tham số chưa nhận diện (mã nhúng -c hoặc đường dẫn ngoài workspace)`);
}

function classifyPip(args) {
  const action = String(operands(args)[0] ?? '').toLowerCase();
  if (!action && hasFlag(args, '--version', '-V')) return read('Phiên bản pip');
  return ['list', 'show', 'freeze', 'check'].includes(action) ? read(`pip ${action}`) : exec(`pip ${action || '?'}: cài đặt/mạng`);
}

const BUILD_TARGETS = {
  cargo: ['test', 'check', 'build', 'clippy', 'fmt', 'doc', 'bench', 'run', 'tree'],
  go: ['test', 'vet', 'build', 'fmt', 'run', 'list', 'env', 'version'],
  dotnet: ['test', 'build', 'run', 'format'],
  deno: ['test', 'lint', 'check', 'fmt'],
  bun: ['test'],
  mvn: ['test', 'verify', 'compile', 'package', 'clean', 'validate'],
  mvnw: ['test', 'verify', 'compile', 'package', 'clean', 'validate'],
  gradle: ['test', 'build', 'check', 'assemble', 'clean', 'classes'],
  gradlew: ['test', 'build', 'check', 'assemble', 'clean', 'classes'],
  make: ['test', 'check', 'lint', 'build', 'all', 'tests'],
};

function classifyBuildTool(name, args) {
  if (hasFlag(args, '--version', '-v', '-version', '--info') && args.length === 1) return read('Phiên bản');
  if (name === 'cmake') return hasFlag(args, '--build') && plain(args) ? verify('cmake --build') : exec('cmake chưa được phân loại');
  if (name === 'ctest') return plain(args) ? verify('ctest') : exec('ctest với tham số không an toàn');
  const allowed = BUILD_TARGETS[name];
  if (!allowed) return exec(`${name} chưa được phân loại`);
  const targets = operands(args).map((value) => String(value).toLowerCase());
  const first = targets[0] ?? '';
  const risky = targets.some((target) => /^(?:install|publish|deploy|login|add|remove|upgrade|release|push)$/.test(target));
  return allowed.includes(first) && !risky && plain(args)
    ? verify(`${name} ${first}`)
    : exec(`${name} ${first || '?'}: chưa được nhận diện là kiểm thử/build an toàn`);
}

// ---------------------------------------------------------------- per program

function classifyProgram(name, args, { ps = false } = {}) {
  if (DANGEROUS_PROGRAMS.has(name)) return danger(`Lệnh có thể xóa dữ liệu hoặc thay đổi hệ thống: ${name}`);
  if (INTERPRETERS.has(name) && !['node', 'python', 'python3', 'py'].includes(name)) return exec(`Trình thông dịch/shell lồng nhau — không thể kiểm tra nội dung: ${name}`);
  if (NETWORK_PROGRAMS.has(name)) return exec(`Truy cập mạng hoặc dịch vụ ngoài: ${name}`);
  if (name === 'git') return classifyGit(args);
  if (['npm', 'pnpm', 'yarn'].includes(name)) return classifyPackageManager(name, args);
  if (name === 'node') return classifyNode(args);
  if (['python', 'python3', 'py'].includes(name)) return classifyPython(name, args);
  if (['pip', 'pip3'].includes(name)) return classifyPip(args);
  if (['cargo', 'go', 'dotnet', 'deno', 'bun', 'mvn', 'mvnw', 'gradle', 'gradlew', 'make', 'cmake', 'ctest'].includes(name)) return classifyBuildTool(name, args);
  if (CHECK_TOOLS.has(name)) return plain(args) ? verify(`Công cụ kiểm tra: ${name}`) : exec(`${name} với tham số không an toàn (${firstProblem(args)})`);

  if (PRINT_PROGRAMS.has(name)) {
    const problem = firstProblem(args, { glob: 'any' });
    return problem && CD_PROGRAMS.has(name) ? exec(`Chuyển thư mục ngoài workspace (${problem})`) : read(`Lệnh nội bộ: ${name}`);
  }
  if (LIST_PROGRAMS.has(name)) {
    if (['find', 'fd'].includes(name) && (hasFlag(args, '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls', '-x', '--exec', '-X', '--exec-batch') || (name === 'fd' && clusterHas(args, 'xX')))) {
      return exec(`${name} với tùy chọn xóa/chạy lệnh/ghi file`);
    }
    // BSD-style `ps e`, `ps auxe`, `ps eww` print the environment of every process: the same API keys `env` would show.
    if (name === 'ps' && !ps && args.some((arg) => /^[a-z]*e[a-z]*$/i.test(String(arg)))) return exec('ps với tùy chọn in biến môi trường của tiến trình (ps e)');
    const problem = firstProblem(args, { glob: 'any' });
    return problem ? exec(`${name}: tham số không an toàn (${problem})`) : read(`Liệt kê: ${name}`);
  }
  if (CONTENT_PROGRAMS.has(name)) {
    const recursive = hasFlag(args, '-r', '-R', '--recursive', '-recurse', '-recursive', '/s', '-hidden', '--hidden', '-uu', '-uuu', '--no-ignore', '--no-ignore-vcs', '--pre', '-f', '--follow', '-wait')
      || (!ps && clusterHas(args, 'rRf')) || (name === 'rg' && clusterHas(args, 'u'));
    if (recursive) return exec(`${name} đệ quy/ẩn/theo dõi có thể in file bí mật hoặc không kết thúc`);
    const problem = firstProblem(args, { glob: 'extension' });
    return problem ? exec(`${name}: tham số không an toàn (${problem})`) : read(`Đọc nội dung: ${name}`);
  }
  if (FILE_EDIT_PROGRAMS.has(name)) {
    if (name === 'sed' && !hasFlag(args, '-i', '--in-place') && !(!ps && clusterHas(args, 'i'))) return plain(args) ? read('sed (đọc, in kết quả)') : exec('sed với tham số không an toàn');
    if (hasFlag(args, '-itemtype') && /symbolic|junction|hardlink/i.test(args.join(' '))) return exec('Tạo liên kết/junction');
    const problem = firstProblem(args, { glob: 'extension' });
    return problem ? exec(`${name}: tham số không an toàn (${problem})`) : edit(`Sửa file: ${name}`);
  }
  if (VERSION_PROGRAMS.has(name) && args.length === 1 && ['--version', '-v', '-V', 'version', '-version'].includes(String(args[0]))) return read('Phiên bản');
  return exec(`Chương trình chưa được phân loại: ${name}`);
}

function programName(token) {
  const raw = String(token);
  if (/[\\/]/.test(raw)) {
    const wrapper = /^\.[\\/](gradlew|mvnw)(?:\.(?:bat|cmd))?$/i.exec(raw);
    return wrapper ? wrapper[1].toLowerCase() : null;
  }
  return raw.toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

const DANGEROUS_TEXT = /(?:\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|:\(\)\s*\{|\bformat\s+[a-z]:|\bdd\s+if=|>\s*\/dev\/(?:sd|nvme)|\binvoke-expression\b|\biex\b|-enc(?:odedcommand)?\b|\bremove-item\b[^|;&]*-recurse|\bgit\s+push\b|\bgit\s+reset\s+--hard|\bgit\s+clean\b|\bcurl\b[^|;&]*\|\s*(?:sh|bash|iex|powershell|pwsh)|\bset-executionpolicy\b)/i;

const shellStyle = (shell) => (shell === 'powershell' || shell === 'pwsh' ? 'powershell' : 'posix');
// In PowerShell, "Get-ChildItem | Select-String x" feeds FILE objects to the consumer, which then
// reads the content of every listed file (including secrets). In POSIX shells the same pipe only
// filters the printed names.
const PS_FILE_CONSUMERS = new Set(['select-string', 'sls', 'get-content', 'gc', 'cat', 'type', 'get-filehash']);

const FLAG_REASONS = {
  variable: 'Biến/mở rộng tham số: không biết giá trị thật khi chạy',
  substitution: 'Thay thế lệnh/dấu backtick',
  grouping: 'Nhóm lệnh, khối script hoặc mở rộng ngoặc',
  escape: 'Ký tự escape của PowerShell',
  heredoc: 'Here-document',
  'background-or-call': 'Toán tử & (chạy nền hoặc gọi lệnh)',
  'unterminated-quote': 'Dấu nháy chưa đóng',
};

/**
 * Classify shell text. `shell` selects quoting rules: 'bash'|'sh' (POSIX) or
 * 'powershell'. 'cmd' is never analysed and always requires a decision.
 */
export function analyzeCommand(command, { shell = process.platform === 'win32' ? 'powershell' : 'bash' } = {}) {
  const text = String(command ?? '');
  if (!text.trim()) return { kind: 'exec', reasons: ['Lệnh rỗng'], segments: [], flags: [] };
  if (shell === 'cmd') return { kind: 'exec', reasons: ['cmd.exe không được phân tích tự động'], segments: [], flags: [] };
  const style = shellStyle(shell);
  const ps = style === 'powershell';
  const { segments: raw, flags } = tokenize(text, style);
  const reasons = [];
  const segments = [];
  let kind = 'read';
  const raise = (candidate, reason) => {
    kind = maxKind(kind, candidate);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };

  if (DANGEROUS_TEXT.test(text)) raise('dangerous', 'Chứa mẫu lệnh nguy hiểm đã biết');
  for (const flag of flags) raise('exec', FLAG_REASONS[flag] ?? flag);

  raw.forEach((segment, index) => {
    const name = segment.tokens.length ? programName(segment.tokens[0]) : null;
    const args = segment.tokens.slice(1);
    let verdict;
    if (!segment.tokens.length) verdict = read('Chỉ có chuyển hướng');
    else if (name === null) verdict = exec(`Chạy tệp theo đường dẫn: ${String(segment.tokens[0]).slice(0, 80)}`);
    else verdict = classifyProgram(name, args, { ps });
    const previous = raw[index - 1];
    if (ps && name && PS_FILE_CONSUMERS.has(name) && previous?.operatorAfter === '|') {
      const upstream = previous.tokens.length ? programName(previous.tokens[0]) : null;
      if (upstream && LIST_PROGRAMS.has(upstream)) verdict = exec(`${name} nhận đối tượng file từ ${upstream} và sẽ đọc nội dung mọi file được liệt kê`);
    }
    for (const { op, target } of segment.redirects) {
      if (NULL_DEVICES.test(target)) continue;
      const protectedTarget = target && (isProtectedPath(target) || mayExpandToProtected(target));
      if (op.startsWith('<')) {
        if (!target || argProblem(target, { glob: 'none' })) verdict = result(maxKind(verdict.kind, 'exec'), `Đọc stdin từ đường dẫn không an toàn: ${target.slice(0, 60)}`);
      } else if (protectedTarget) {
        verdict = danger(`Ghi vào đường dẫn được bảo vệ: ${target.slice(0, 60)}`);
      } else if (!target || argProblem(target, { glob: 'none' })) {
        verdict = result(maxKind(verdict.kind, 'exec'), `Chuyển hướng tới đường dẫn không an toàn: ${target.slice(0, 60)}`);
      } else verdict = result(maxKind(verdict.kind, 'edit'), `Chuyển hướng ghi vào file: ${target.slice(0, 60)}`);
    }
    const next = raw[index + 1];
    if (segment.operatorAfter === '|' && next?.tokens.length) {
      const target = programName(next.tokens[0]);
      if (target !== null && INTERPRETERS.has(target)) verdict = danger(`Đường ống (pipe) vào trình thông dịch: ${target}`);
    }
    raise(verdict.kind, `${name ?? 'đường dẫn'}: ${verdict.reason}`);
    segments.push({ program: name, args: args.map((arg) => String(arg).slice(0, 120)), redirects: segment.redirects.map(({ op, target }) => ({ op, target: String(target).slice(0, 240) })), kind: verdict.kind, reason: verdict.reason });
  });
  return { kind, reasons: reasons.slice(0, 8), segments, flags };
}

/** Gate category for an analysed command kind. */
export function categoryForKind(kind) {
  return { read: 'read', verify: 'workspace_edit', edit: 'workspace_edit', exec: 'execute', dangerous: 'dangerous' }[kind] ?? 'execute';
}
