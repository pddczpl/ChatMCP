// Small glob matcher for find_files / search_files: *, **, ?, [abc], [!abc] and {a,b}.
// A pattern without "/" matches the file name at any depth (like ripgrep's --glob).
const MAX_PATTERN = 300;
const MAX_WILDCARDS = 8;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function closingBrace(glob, start) {
  let depth = 0;
  for (let i = start; i < glob.length; i += 1) {
    if (glob[i] === '\\') { i += 1; continue; }
    if (glob[i] === '{') depth += 1;
    else if (glob[i] === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') { current += char + (text[i + 1] ?? ''); i += 1; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

function source(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; out += '(?:[^/]+/)*'; } else out += '.*';
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else if (char === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) { out += '\\['; continue; }
      let body = glob.slice(i + 1, end);
      if (body[0] === '!') body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else if (char === '{') {
      const end = closingBrace(glob, i);
      if (end === -1) { out += '\\{'; continue; }
      out += `(?:${splitTopLevel(glob.slice(i + 1, end)).map(source).join('|')})`;
      i = end;
    } else if (char === '\\' && i + 1 < glob.length) { out += escapeRegex(glob[i + 1]); i += 1; }
    else out += escapeRegex(char);
  }
  return out;
}

/**
 * Compiles a glob into a RegExp tested against a "/"-separated path relative to the search base.
 * Case-insensitive on Windows, where the file system is.
 */
export function compileGlob(glob, { caseInsensitive = process.platform === 'win32' } = {}) {
  if (typeof glob !== 'string' || !glob.trim()) throw Object.assign(new Error('Mẫu glob không được rỗng.'), { code: 'bad_pattern', statusCode: 400 });
  if (glob.length > MAX_PATTERN) throw Object.assign(new Error(`Mẫu glob tối đa ${MAX_PATTERN} ký tự.`), { code: 'bad_pattern', statusCode: 400 });
  if ((glob.match(/\*/g) ?? []).length > MAX_WILDCARDS) throw Object.assign(new Error(`Mẫu glob có tối đa ${MAX_WILDCARDS} dấu *.`), { code: 'bad_pattern', statusCode: 400 });
  // Backslashes are path separators (Windows habit); glob escaping is deliberately not supported.
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const prefix = normalized.includes('/') ? '' : '(?:.*/)?';
  return new RegExp(`^${prefix}${source(normalized)}$`, caseInsensitive ? 'i' : '');
}
