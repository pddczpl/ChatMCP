// Per-program safe-flag ALLOWLISTS for the programs that Read Only may run without asking.
//
// The v3.9.0 classifier decided "read" by program NAME and then looked for a few bad flags (a denylist). Every flag the list did not
// know was therefore read-only by default, and the GNU tools are full of flags that write files, run programs or read other files:
// `sed 1e CMD`, `sort -o FILE`, `sort --compress-program=sh`, `uniq IN OUT`, `file -C -m X`, `rg --pre=CMD`, `find -fprint0 FILE`,
// `tree -o FILE`, `date -s`, `less -o FILE`, `grep -d recurse`. Here the question is reversed: a program is "read" only when EVERY flag
// is on the allowlist of that program. Matching is exact:
//   * a short cluster is split letter by letter (-rn is -r and -n); a letter that takes a value swallows the rest of the cluster
//   * a long option must be an exact entry (GNU getopt accepts abbreviations, so --out=f for --output=f is simply not listed)
//   * --opt=value is split before the name is checked
//   * anything unknown is refused, never assumed harmless
//
// The parser also tells the caller which words are FILES. Scripts, patterns, filters and option values are data and must not be judged
// as paths (`sed -n '/x/p' f`, `grep /api/ f`), while the file named by `-f`, `--files0-from`, `--rawfile` and friends must be.

import { checkSedScript, isProtectedSedTarget, sedFileTargets } from './sed-script.mjs';

const longTable = (text) => new Map(text.trim().split(/\s+/).filter(Boolean).map((entry) => {
  const match = /^(--[\w-]+)(::|:|\?)?$/.exec(entry);
  if (!match) throw new Error(`bad long option entry: ${entry}`);
  return [match[1], match[2] === '::' ? 3 : match[2] === ':' ? 1 : match[2] === '?' ? 2 : 0];
}));

const COMMON_LONG = '--help --version';

/**
 * flags     short letters without a value
 * valued    short letters that take a value (rest of the cluster, or the next word)
 * long      long options: name, name: (value), name? (optional =value), name:: (two values)
 * fileOpts  options whose value is a file
 * numeric   -NUM is allowed (head, tail, grep context)
 * operands  'files' | 'pattern-first' | 'none' | 'data'
 * patternOpts options that supply the pattern/script, so every operand is a file
 * max       maximum number of operands
 * badOperand an operand that is really a command (less +!cmd)
 * glob      how wildcards in file operands are judged ('extension' | 'any' | 'none')
 */
const SPECS = {
  cat: { flags: 'AbeEnstTuv', long: `--show-all --number-nonblank --show-ends --number --squeeze-blank --show-tabs --show-nonprinting ${COMMON_LONG}` },
  head: { flags: 'qvz', valued: 'nc', numeric: true, long: `--lines: --bytes: --quiet --silent --verbose --zero-terminated ${COMMON_LONG}` },
  tail: { flags: 'qvz', valued: 'nc', numeric: true, long: `--lines: --bytes: --quiet --silent --verbose --zero-terminated ${COMMON_LONG}` },
  tac: { flags: 'br', valued: 's', long: `--before --regex --separator: ${COMMON_LONG}` },
  nl: { flags: 'p', valued: 'bdfhilnsvw', long: `--body-numbering: --section-delimiter: --footer-numbering: --header-numbering: --line-increment: --join-blank-lines: --number-format: --no-renumber --number-separator: --starting-line-number: --number-width: ${COMMON_LONG}` },
  wc: { flags: 'cmlLw', long: `--bytes --chars --lines --max-line-length --words --total: --files0-from: ${COMMON_LONG}`, fileOpts: ['--files0-from'] },
  cut: { flags: 'nsz', valued: 'bcdf', long: `--bytes: --characters: --delimiter: --fields: --complement --only-delimited --output-delimiter: --zero-terminated ${COMMON_LONG}` },
  tr: { flags: 'cCdst', operands: 'data', long: `--complement --delete --squeeze-repeats --truncate-set1 ${COMMON_LONG}` },
  sort: {
    flags: 'bdfghiMnRrVcCmsuz', valued: 'kSt',
    long: `--ignore-leading-blanks --dictionary-order --ignore-case --general-numeric-sort --human-numeric-sort --ignore-nonprinting --month-sort --numeric-sort --random-sort --reverse --version-sort --check? --check-silent --merge --stable --unique --zero-terminated --debug --key: --field-separator: --buffer-size: --parallel: --sort: --batch-size: ${COMMON_LONG}`,
  },
  uniq: { flags: 'cdDiuz', valued: 'fsw', max: 1, long: `--count --repeated --all-repeated? --ignore-case --unique --zero-terminated --skip-fields: --skip-chars: --check-chars: --group? ${COMMON_LONG}` },
  comm: { flags: '123z', long: `--check-order --nocheck-order --output-delimiter: --total --zero-terminated ${COMMON_LONG}` },
  diff: {
    flags: 'abBcdEeHinNpqsTtuwyZ', valued: 'CUWFIL',
    long: `--brief --ignore-case --ignore-space-change --ignore-all-space --ignore-blank-lines --ignore-trailing-space --unified? --context? --side-by-side --text --report-identical-files --new-file --unidirectional-new-file --minimal --speed-large-files --expand-tabs --initial-tab --strip-trailing-cr --ignore-tab-expansion --show-c-function --normal --ed --label: --width: --show-function-line: --ignore-matching-lines: --color? ${COMMON_LONG}`,
  },
  grep: {
    flags: 'EFGPiIvwxyclLnHhoqsabTUzZV', valued: 'ABCemf', numeric: true, operands: 'pattern-first', patternOpts: ['-e', '--regexp', '-f', '--file'], fileOpts: ['-f', '--file'],
    long: `--extended-regexp --fixed-strings --basic-regexp --perl-regexp --ignore-case --no-ignore-case --invert-match --word-regexp --line-regexp --count --color? --colour? --files-without-match --files-with-matches --max-count: --only-matching --quiet --silent --no-messages --byte-offset --with-filename --no-filename --label: --line-number --initial-tab --null --text --binary-files: --after-context: --before-context: --context: --regexp: --file: --include: --exclude: --exclude-dir: --line-buffered --null-data ${COMMON_LONG}`,
  },
  rg: {
    flags: 'nNiSswxvcHIoqFaPUbp', valued: 'ABCmegtTMjdEfr', operands: 'pattern-first', patternOpts: ['-e', '--regexp', '-f', '--file', '--files', '--type-list'], fileOpts: ['-f', '--file'],
    long: `--line-number --no-line-number --ignore-case --smart-case --case-sensitive --word-regexp --line-regexp --invert-match --count --count-matches --files-with-matches --files-without-match --fixed-strings --only-matching --no-heading --heading --with-filename --no-filename --column --json --null --text --multiline --pcre2 --quiet --files --type-list --stats --pretty --byte-offset --color: --colors: --glob: --iglob: --max-count: --max-depth: --type: --type-not: --context: --after-context: --before-context: --regexp: --file: --max-columns: --threads: --replace: --encoding: --sort: --sortr: --max-filesize: ${COMMON_LONG}`,
  },
  file: { flags: 'bhiLnNprkEv', valued: 'F', long: `--brief --mime --mime-type --mime-encoding --no-dereference --dereference --no-pad --keep-going --raw --preserve-date --no-buffer --separator: ${COMMON_LONG}` },
  stat: { flags: 'Lft', valued: 'c', long: `--dereference --file-system --format: --printf: --terse --cached: ${COMMON_LONG}` },
  du: {
    flags: 'abchHkLmPsSx0', valued: 'dBt',
    long: `--all --apparent-size --bytes --total --dereference-args --human-readable --si --summarize --max-depth: --block-size: --threshold: --exclude: --time? --time-style: --count-links --dereference --separate-dirs --one-file-system --inodes --no-dereference --null ${COMMON_LONG}`,
  },
  df: { flags: 'ahHiklPTv', valued: 'Btx', long: `--all --block-size: --human-readable --si --inodes --local --portability --print-type --type: --exclude-type: --output? --total --no-sync ${COMMON_LONG}` },
  // no -c/--check: it reads the names to hash from a file, which would open any file the list names
  md5sum: { flags: 'btwz', long: `--binary --tag --text --zero ${COMMON_LONG}` },
  jq: {
    flags: 'nrjcsSCMaeRh', operands: 'pattern-first',
    long: `--null-input --raw-input --slurp --compact-output --raw-output --join-output --ascii-output --sort-keys --color-output --monochrome-output --tab --indent: --unbuffered --stream --stream-errors --seq --exit-status --arg:: --argjson:: --slurpfile:: --rawfile:: --argfile:: --args --jsonargs ${COMMON_LONG}`,
  },
  tree: {
    flags: 'adfgipqsuvxACDFNSUtrch', valued: 'LPI', glob: 'any',
    long: `--noreport --dirsfirst --filelimit: --charset: --du --prune --si --timefmt: --matchdirs --ignore-case --sort: --inodes --device --gitignore ${COMMON_LONG}`,
  },
  ls: {
    flags: 'aAbBcCdDfFgGhHiklLmnNopqQrRsStuUvxXZ1', valued: 'ITw', glob: 'any',
    long: `--all --almost-all --author --escape --block-size: --ignore-backups --color? --directory --dired --classify --file-type --format: --full-time --group-directories-first --no-group --human-readable --si --dereference-command-line --dereference-command-line-symlink-to-dir --hide: --hyperlink? --indicator-style: --inode --ignore: --kibibytes --dereference --numeric-uid-gid --literal --hide-control-chars --show-control-chars --quote-name --quoting-style: --reverse --recursive --size --sort: --time: --time-style: --tabsize: --width: --context --zero ${COMMON_LONG}`,
  },
  date: { flags: 'uRI', valued: 'dr', operands: 'date', long: `--utc --universal --rfc-email --rfc-2822 --rfc-3339: --iso-8601? --date: --reference: --debug ${COMMON_LONG}`, fileOpts: ['-r', '--reference'] },
  hostname: { flags: 'sfiIaAdy', operands: 'none', long: COMMON_LONG },
  uname: { flags: 'asnrvmpio', operands: 'none', long: `--all --kernel-name --nodename --kernel-release --kernel-version --machine --processor --hardware-platform --operating-system ${COMMON_LONG}` },
  whoami: { flags: '', operands: 'none', long: COMMON_LONG },
  pwd: { flags: 'LP', operands: 'none', long: COMMON_LONG },
  basename: { flags: 'asz', valued: 'S', operands: 'data', long: `--multiple --suffix: --zero ${COMMON_LONG}` },
  dirname: { flags: 'z', operands: 'data', long: `--zero ${COMMON_LONG}` },
  which: { flags: 'as', operands: 'data', long: `--all ${COMMON_LONG}` },
  less: { flags: 'EFiIJmMnNqQRSwWX', long: COMMON_LONG, badOperand: /^\+/ },
  more: { flags: 'dflcspun', numeric: true, long: COMMON_LONG, badOperand: /^\+/ },
  fd: {
    flags: 'HIuisgFpa0', valued: 'teEdScj', operands: 'pattern-first', glob: 'any',
    long: `--hidden --no-ignore --unrestricted --case-sensitive --ignore-case --glob --fixed-strings --full-path --absolute-path --print0 --type: --extension: --exclude: --max-depth: --min-depth: --color: --size: --threads: --changed-within: --changed-before: ${COMMON_LONG}`,
  },
  find: { custom: 'find', glob: 'any' },
  sed: { custom: 'sed' },
};
for (const alias of ['egrep', 'fgrep']) SPECS[alias] = SPECS.grep;
for (const alias of ['sha1sum', 'sha224sum', 'sha256sum', 'sha384sum', 'sha512sum', 'b2sum']) SPECS[alias] = SPECS.md5sum;
for (const spec of Object.values(SPECS)) {
  if (spec.custom) continue;
  spec.longMap = longTable(spec.long ?? '');
  spec.flagSet = new Set(spec.flags ?? '');
  spec.valuedSet = new Set(spec.valued ?? '');
  spec.fileOptSet = new Set(spec.fileOpts ?? []);
  spec.patternOptSet = new Set(spec.patternOpts ?? []);
}

// PowerShell resolves these names to its own cmdlets (Sort-Object, Get-Content, Get-ChildItem, Compare-Object ...), not to the GNU
// programs, so the POSIX allowlists do not apply to them there.
export const POWERSHELL_ALIASES = new Set(['cat', 'type', 'ls', 'dir', 'sort', 'diff', 'fc', 'gc', 'gci', 'gl', 'gi', 'ps', 'where', 'sleep', 'echo', 'cd', 'pwd', 'sl', 'sls']);

/** Whether the allowlist machinery handles this program (and so decides alone). */
export const hasReadSpec = (name, { ps = false } = {}) => Object.hasOwn(SPECS, name) && !(ps && POWERSHELL_ALIASES.has(name));

/**
 * Splits args into options and operands against a spec.
 * @returns {{problem: string} | {operands: string[], options: {name: string, values: string[]}[]}}
 */
function parseWithSpec(args, spec) {
  const operands = [];
  const options = [];
  const words = args.map(String);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') { operands.push(...words.slice(i + 1)); break; }
    if (word === '-' || !word.startsWith('-')) { operands.push(word); continue; }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const name = eq === -1 ? word : word.slice(0, eq);
      const inline = eq === -1 ? undefined : word.slice(eq + 1);
      const arity = spec.longMap.get(name);
      if (arity === undefined) return { problem: `tùy chọn ${name} không nằm trong danh sách an toàn của chế độ chỉ đọc` };
      if (arity === 0) {
        if (inline !== undefined) return { problem: `tùy chọn ${name} không nhận giá trị` };
        options.push({ name, values: [] });
      } else if (arity === 2) {
        options.push({ name, values: inline === undefined ? [] : [inline] });
      } else if (arity === 1) {
        if (inline !== undefined) options.push({ name, values: [inline] });
        else if (i + 1 < words.length) { options.push({ name, values: [words[i + 1]] }); i += 1; } else return { problem: `tùy chọn ${name} thiếu giá trị` };
      } else {
        const values = inline === undefined ? [] : [inline];
        while (values.length < 2 && i + 1 < words.length) { values.push(words[i + 1]); i += 1; }
        if (values.length < 2) return { problem: `tùy chọn ${name} cần hai giá trị` };
        options.push({ name, values });
      }
      continue;
    }
    // short cluster
    const cluster = word.slice(1);
    if (spec.numeric && /^\d+$/.test(cluster)) { options.push({ name: '-NUM', values: [cluster] }); continue; }
    for (let j = 0; j < cluster.length; j += 1) {
      const letter = cluster[j];
      if (spec.flagSet.has(letter)) { options.push({ name: `-${letter}`, values: [] }); continue; }
      if (spec.valuedSet.has(letter)) {
        const rest = cluster.slice(j + 1);
        if (rest) options.push({ name: `-${letter}`, values: [rest] });
        else if (i + 1 < words.length) { options.push({ name: `-${letter}`, values: [words[i + 1]] }); i += 1; } else return { problem: `tùy chọn -${letter} thiếu giá trị` };
        break;
      }
      if (spec.numeric && /^\d$/.test(letter)) continue;
      return { problem: `tùy chọn -${letter} không nằm trong danh sách an toàn của chế độ chỉ đọc` };
    }
  }
  return { operands, options };
}

const isStdin = (word) => word === '-';
const nonStdin = (words) => words.filter((word) => !isStdin(word));

/** jq programs that read the environment or load modules from disk are not "read": `jq -n env` prints every secret in the environment. */
const JQ_UNSAFE_PROGRAM = /(?<![\w."$])env\b|\$ENV\b|(?<![\w."$.])(?:import|include)\b|\$__prog_args|get_search_list/;

function analyzeFind(args) {
  const words = args.map(String);
  const zero = new Set(['-print', '-print0', '-true', '-false', '-empty', '-readable', '-writable', '-executable', '-prune', '-quit', '-nouser', '-nogroup', '-depth', '-mount', '-xdev', '-daystart', '-noleaf', '-ignore_readdir_race', '-noignore_readdir_race', '-ls', '-not', '-and', '-or', '-a', '-o', '-P', '(', ')', '!']);
  const one = new Set(['-name', '-iname', '-lname', '-ilname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-regextype', '-type', '-xtype', '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-perm', '-user', '-group', '-uid', '-gid', '-links', '-inum', '-used', '-fstype', '-printf']);
  const fileValued = new Set(['-newer', '-anewer', '-cnewer', '-samefile']);
  const files = [];
  let i = 0;
  while (i < words.length && words[i] === '-P') i += 1;
  while (i < words.length && !words[i].startsWith('-') && words[i] !== '(' && words[i] !== '!') { files.push(words[i]); i += 1; }
  for (; i < words.length; i += 1) {
    const word = words[i];
    if (zero.has(word)) continue;
    if (one.has(word) || fileValued.has(word)) {
      if (i + 1 >= words.length) return { refused: `find ${word} thiếu giá trị` };
      i += 1;
      if (fileValued.has(word)) files.push(words[i]);
      continue;
    }
    const newer = /^-newer([aBcm])([aBcmt])$/.exec(word);
    if (newer) {
      if (i + 1 >= words.length) return { refused: `find ${word} thiếu giá trị` };
      i += 1;
      if (newer[2] !== 't') files.push(words[i]);
      continue;
    }
    return { refused: `find ${word} không nằm trong danh sách an toàn (ghi file, chạy lệnh, xóa hoặc theo symlink)` };
  }
  return { files };
}

function analyzeSed(args) {
  const words = args.map(String);
  const scripts = [];
  const operands = [];
  let scriptFile = false;
  let sandbox = false;
  let inPlace = false;
  let refused = null;
  const shortFlags = new Set('nErszub');
  const longFlags = new Set(['--quiet', '--silent', '--regexp-extended', '--separate', '--null-data', '--unbuffered', '--posix', '--debug', '--binary', '--follow-symlinks', '--help', '--version']);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') { operands.push(...words.slice(i + 1)); break; }
    if (word === '-' || !word.startsWith('-')) { operands.push(word); continue; }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const name = eq === -1 ? word : word.slice(0, eq);
      const inline = eq === -1 ? undefined : word.slice(eq + 1);
      if (name === '--sandbox' && inline === undefined) { sandbox = true; continue; }
      if (name === '--in-place') { inPlace = true; if (inline && /[\\/]/.test(inline)) refused = refused ?? 'hậu tố sao lưu của sed -i chứa dấu phân cách đường dẫn'; continue; }
      if (longFlags.has(name) && inline === undefined) continue;
      if (name === '--expression' || name === '--file' || name === '--line-length') {
        let value = inline;
        if (value === undefined) { if (i + 1 >= words.length) return { refused: `sed ${name} thiếu giá trị` }; value = words[i + 1]; i += 1; }
        if (name === '--expression') scripts.push(value);
        else if (name === '--file') scriptFile = true;
        continue;
      }
      return { refused: `sed ${name} không nằm trong danh sách an toàn của chế độ chỉ đọc` };
    }
    const cluster = word.slice(1);
    for (let j = 0; j < cluster.length; j += 1) {
      const letter = cluster[j];
      if (letter === 'i') { inPlace = true; const suffix = cluster.slice(j + 1); if (/[\\/]/.test(suffix)) refused = refused ?? 'hậu tố sao lưu của sed -i chứa dấu phân cách đường dẫn'; break; }
      if (shortFlags.has(letter)) continue;
      if (letter === 'e' || letter === 'f' || letter === 'l') {
        let value = cluster.slice(j + 1);
        if (!value) { if (i + 1 >= words.length) return { refused: `sed -${letter} thiếu giá trị` }; value = words[i + 1]; i += 1; }
        if (letter === 'e') scripts.push(value);
        else if (letter === 'f') scriptFile = true;
        break;
      }
      return { refused: `sed -${letter} không nằm trong danh sách an toàn của chế độ chỉ đọc` };
    }
  }
  if (refused) return { refused };
  if (words.some((word) => word === '--version' || word === '--help') && !scripts.length && !operands.length) return { files: [] };
  let files = operands;
  if (!scripts.length && !scriptFile) {
    if (!operands.length) return { refused: 'sed không có script' };
    scripts.push(operands[0]);
    files = operands.slice(1);
  }
  files = nonStdin(files);
  if (scriptFile && !sandbox) return { refused: 'sed -f nạp script từ file, không thể kiểm tra nội dung (dùng --sandbox hoặc -e)', files };
  const script = scripts.join('\n');
  if (!sandbox) {
    const verdict = checkSedScript(script);
    if (!verdict.ok) {
      const targets = sedFileTargets(script);
      const protectedWrite = targets.find((entry) => entry.op === 'write' && isProtectedSedTarget(entry.target));
      if (protectedWrite) return { dangerous: `sed ghi vào đường dẫn được bảo vệ: ${protectedWrite.target.slice(0, 60)}`, files };
      const protectedRead = targets.find((entry) => entry.op === 'read' && isProtectedSedTarget(entry.target));
      if (protectedRead) return { refused: `sed đọc đường dẫn được bảo vệ: ${protectedRead.target.slice(0, 60)}`, files };
      return { refused: `sed: ${verdict.reason}`, files: [...files, ...targets.map((entry) => entry.target)] };
    }
  }
  return { files, edit: inPlace };
}

/**
 * @param {string} name  program name (lower case, no extension)
 * @param {string[]} args
 * @returns {null | {refused?: string, dangerous?: string, files?: string[], edit?: boolean, glob?: string}}
 *   null when the program has no allowlist; otherwise a verdict the caller turns into a kind.
 */
export function analyzeReadProgram(name, args, { ps = false } = {}) {
  const verdict = analyzeUnchecked(name, args, { ps });
  if (!verdict || verdict.refused || verdict.dangerous) return verdict;
  // `sort *.txt` expands, in the shell, to every matching name, and a name such as "--output=x.txt" is then an OPTION. A file operand
  // that starts with a wildcard can therefore carry flags the allowlist never saw; `src/*.py` cannot.
  const lead = (verdict.files ?? []).find((file) => LEADING_GLOB.test(file));
  if (lead !== undefined) return { refused: `${name}: đối số "${lead.slice(0, 40)}" bắt đầu bằng ký tự đại diện nên có thể mở rộng thành tùy chọn (ví dụ --output=...); thêm tiền tố thư mục`, glob: verdict.glob };
  return verdict;
}

const LEADING_GLOB = /^[*?[{]/;

function analyzeUnchecked(name, args, { ps }) {
  if (!hasReadSpec(name, { ps })) return null;
  const spec = SPECS[name];
  if (spec.custom === 'find') return { ...analyzeFind(args), glob: spec.glob };
  if (spec.custom === 'sed') return { ...analyzeSed(args), glob: 'extension' };
  const parsed = parseWithSpec(args, spec);
  if (parsed.problem) return { refused: `${name}: ${parsed.problem}`, glob: spec.glob };
  const { operands, options } = parsed;
  const files = [];
  for (const option of options) {
    if (spec.fileOptSet.has(option.name)) files.push(...nonStdin(option.values));
  }
  let rest = operands;
  const mode = spec.operands ?? 'files';
  if (name === 'jq') {
    for (const option of options) if (['--slurpfile', '--rawfile', '--argfile'].includes(option.name)) files.push(...nonStdin([option.values[1]]));
    const withArgs = options.some((option) => option.name === '--args' || option.name === '--jsonargs');
    const filter = rest[0];
    if (filter === undefined) return { refused: 'jq không có bộ lọc', glob: spec.glob };
    if (JQ_UNSAFE_PROGRAM.test(filter)) return { refused: 'jq đọc biến môi trường hoặc nạp mô-đun từ đĩa (env, $ENV, import, include)', glob: spec.glob };
    rest = withArgs ? [] : rest.slice(1);
    files.push(...nonStdin(rest));
    return { files, glob: spec.glob };
  }
  if (mode === 'pattern-first') {
    const suppliesPattern = options.some((option) => spec.patternOptSet.has(option.name));
    if (!suppliesPattern) rest = rest.slice(1);
  } else if (mode === 'none') {
    if (rest.length) return { refused: `${name} với đối số có thể thay đổi hệ thống (đặt tên máy, ngày giờ)`, glob: spec.glob };
    rest = [];
  } else if (mode === 'data') {
    rest = [];
  } else if (mode === 'date') {
    if (rest.some((word) => !word.startsWith('+'))) return { refused: 'date với đối số không phải định dạng (+FORMAT) có thể đặt giờ hệ thống', glob: spec.glob };
    rest = [];
  }
  if (spec.badOperand) {
    const command = rest.find((word) => spec.badOperand.test(word));
    if (command !== undefined) return { refused: `${name} chạy lệnh khởi động từ đối số ${command.slice(0, 40)}`, glob: spec.glob };
  }
  if (spec.max !== undefined && rest.length > spec.max) return { refused: `${name} với ${rest.length} đối số: đối số thứ hai là file ĐẦU RA`, glob: spec.glob };
  files.push(...nonStdin(rest));
  return { files, glob: spec.glob };
}
