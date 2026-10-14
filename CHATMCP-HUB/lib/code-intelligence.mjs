// CHATMCP-HUB/lib/code-intelligence.mjs
// Zero-dependency Code Intelligence Engine for ChatMCP Studio Local.
// Provides AST-like structural symbol extraction, PageRank-style Repository Map generation,
// Go-to-Definition, Scope-Aware Find References, Dependency/Impact Graph, and Static Diagnostics.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isProtectedPath } from './protected-paths.mjs';

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.chatmcp',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'coverage',
  'test-results',
  'bin',
  'obj',
  'packages',
  'target',
  'vendor',
]);

const CODE_EXTENSIONS = new Map([
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.py', 'python'],
  ['.cs', 'csharp'],
  ['.ps1', 'powershell'],
  ['.psm1', 'powershell'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
]);

const RESOLVE_EXTENSIONS = ['.mjs', '.js', '.ts', '.tsx', '.jsx', '.cjs', '.mts', '.cts', '.json'];

const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'try', 'catch', 'finally', 'throw', 'new', 'delete', 'typeof', 'instanceof',
  'void', 'in', 'of', 'await', 'yield', 'super', 'this', 'import', 'export', 'from',
  'as', 'function', 'class', 'extends', 'implements', 'interface', 'type', 'enum',
  'const', 'let', 'var', 'static', 'async', 'get', 'set', 'constructor',
]);

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function hashContent(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.8);
}

/**
 * Masks comments and string literals with spaces while strictly preserving newlines (\n)
 * and character offsets so line numbers and brace positions remain 100% accurate.
 */
export function maskCommentsAndStrings(source, language = 'javascript') {
  const len = source.length;
  const out = new Array(len);
  let i = 0;
  const isHashCommentLang = language === 'python' || language === 'powershell';

  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : '';

    // PowerShell block comment <# ... #>
    if (language === 'powershell' && ch === '<' && next === '#') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < len && !(source[i] === '#' && source[i + 1] === '>')) {
        out[i] = source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < len) {
        out[i] = ' ';
        if (i + 1 < len) out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    // Python triple-quoted strings ''' or """
    if (language === 'python' && (ch === '"' || ch === "'") && source[i + 1] === ch && source[i + 2] === ch) {
      const q = ch;
      out[i] = q;
      out[i + 1] = ' ';
      out[i + 2] = ' ';
      i += 3;
      while (i < len && !(source[i] === q && source[i + 1] === q && source[i + 2] === q)) {
        out[i] = source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < len) {
        out[i] = ' ';
        if (i + 1 < len) out[i + 1] = ' ';
        if (i + 2 < len) out[i + 2] = q;
        i += 3;
      }
      continue;
    }

    // Single-line comment // or #
    if ((!isHashCommentLang && ch === '/' && next === '/') || (isHashCommentLang && ch === '#')) {
      while (i < len && source[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }

    // Multi-line C-style comment /* ... */
    if (!isHashCommentLang && ch === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        out[i] = source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < len) {
        out[i] = ' ';
        if (i + 1 < len) out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    // String literals: '...', "...", `...`
    if (ch === '"' || ch === "'" || (!isHashCommentLang && ch === '`')) {
      const quote = ch;
      out[i] = quote;
      i++;
      while (i < len) {
        const c = source[i];
        if (c === '\\') {
          out[i] = ' ';
          if (i + 1 < len) {
            out[i + 1] = source[i + 1] === '\n' ? '\n' : ' ';
            i += 2;
          } else {
            i++;
          }
          continue;
        }
        if (c === quote) {
          out[i] = quote;
          i++;
          break;
        }
        if (c === '\n' && quote !== '`') {
          out[i] = '\n';
          i++;
          break;
        }
        out[i] = c === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    out[i] = ch;
    i++;
  }

  return out.join('');
}

/**
 * Extracts leading JSDoc or comment summary right above a given 0-based line index.
 */
function extractPrecedingDoc(rawLines, lineIndex) {
  const docLines = [];
  let idx = lineIndex - 1;
  while (idx >= 0 && rawLines[idx].trim() === '') {
    if (lineIndex - idx > 2) break;
    idx--;
  }
  while (idx >= 0) {
    const trimmed = rawLines[idx].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      const cleaned = trimmed.replace(/^(\/\/+|#+)\s?/, '').trim();
      if (cleaned) docLines.unshift(cleaned);
      idx--;
    } else if (trimmed.endsWith('*/') || trimmed.startsWith('*') || trimmed.startsWith('/**') || trimmed.startsWith('/*')) {
      const cleaned = trimmed
        .replace(/^\/\*\*?/, '')
        .replace(/\*\/$/, '')
        .replace(/^\*\s?/, '')
        .trim();
      if (cleaned && !cleaned.startsWith('@')) docLines.unshift(cleaned);
      if (trimmed.startsWith('/*')) break;
      idx--;
    } else {
      break;
    }
    if (docLines.length >= 3) break;
  }
  const joined = docLines.join(' ').trim();
  return joined.length > 160 ? `${joined.slice(0, 157)}...` : joined;
}

/**
 * Finds the closing line of a brace-delimited declaration starting at `startLineIdx`.
 * Safely ignores `{}` inside parameter lists `(...)` (such as destructured defaults `args = {}`).
 */
function findBraceBlockEnd(maskedLines, startLineIdx) {
  let braceDepth = 0;
  let parenDepth = 0;
  let opened = false;
  const maxScan = Math.min(maskedLines.length, startLineIdx + 1500);
  for (let i = startLineIdx; i < maxScan; i++) {
    const line = maskedLines[i];
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (!opened) {
        if (c === '(') {
          parenDepth++;
          continue;
        }
        if (c === ')') {
          parenDepth = Math.max(0, parenDepth - 1);
          continue;
        }
        if (parenDepth > 0) continue;
      }

      if (c === '{') {
        braceDepth++;
        opened = true;
      } else if (c === '}' && opened) {
        braceDepth--;
        if (braceDepth <= 0) {
          // Check if there is another '{' later on the same header line (e.g. TS return type `): { a: number } {`)
          const restOfLine = line.slice(j + 1);
          if (i === startLineIdx && restOfLine.includes('{')) {
            opened = false;
            braceDepth = 0;
            continue;
          }
          return i + 1;
        }
      }
    }
    if (!opened && parenDepth === 0 && line.trim().endsWith(';')) {
      return i + 1;
    }
  }
  return startLineIdx + 1;
}

/**
 * Finds the closing line of an indentation-delimited Python block starting at `startLineIdx`.
 */
function findPythonBlockEnd(rawLines, maskedLines, startLineIdx) {
  const headerLine = rawLines[startLineIdx] || '';
  const baseIndent = headerLine.match(/^\s*/)?.[0]?.length ?? 0;
  let lastCodeLine = startLineIdx + 1;
  const maxScan = Math.min(rawLines.length, startLineIdx + 1500);

  for (let i = startLineIdx + 1; i < maxScan; i++) {
    const masked = maskedLines[i].trim();
    if (!masked) continue;
    const indent = rawLines[i].match(/^\s*/)?.[0]?.length ?? 0;
    if (indent <= baseIndent) break;
    lastCodeLine = i + 1;
  }
  return lastCodeLine;
}

function cleanSignature(rawLine) {
  return rawLine
    .trim()
    .replace(/\s*\{\s*$/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 140);
}

/**
 * Extracts structural symbols (classes, interfaces, types, functions, methods, constants)
 * and module imports/exports from source text.
 */
export function parseSourceStructure(source, filePath = '') {
  const ext = path.extname(filePath).toLowerCase();
  const language = CODE_EXTENSIONS.get(ext) || 'javascript';
  const normalized = String(source || '').replace(/\r\n/g, '\n');
  const masked = maskCommentsAndStrings(normalized, language);
  const rawLines = normalized.split('\n');
  const maskedLines = masked.split('\n');

  const symbols = [];
  const imports = [];
  const exportedNames = new Set();

  if (language === 'javascript' || language === 'typescript') {
    parseJsTsStructure(rawLines, maskedLines, symbols, imports, exportedNames);
  } else if (language === 'python') {
    parsePythonStructure(rawLines, maskedLines, symbols, imports, exportedNames);
  } else if (language === 'csharp') {
    parseCSharpStructure(rawLines, maskedLines, symbols, imports, exportedNames);
  } else if (language === 'powershell') {
    parsePowerShellStructure(rawLines, maskedLines, symbols, imports, exportedNames);
  } else {
    parseGenericStructure(rawLines, maskedLines, symbols, imports, exportedNames);
  }

  return {
    language,
    lineCount: rawLines.length,
    symbols,
    imports,
    exportedNames: Array.from(exportedNames),
  };
}

function parseJsTsStructure(rawLines, maskedLines, symbols, imports, exportedNames) {
  // 1. Parse imports & re-exports from raw lines (using masked lines to skip comments)
  const fullText = rawLines.map((raw, idx) => (maskedLines[idx].trim() ? raw : '')).join('\n');

  // Static ESM imports: import ... from 'specifier'
  const importRegex = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRegex.exec(fullText)) !== null) {
    const clause = m[1].trim();
    const specifier = m[2].trim();
    const line = fullText.slice(0, m.index).split('\n').length;
    const names = parseJsImportClause(clause);
    imports.push({ specifier, names, kind: 'import', line });
  }

  // Side-effect imports: import 'specifier'
  const sideEffectRegex = /^\s*import\s+['"]([^'"]+)['"]/gm;
  while ((m = sideEffectRegex.exec(fullText)) !== null) {
    const line = fullText.slice(0, m.index).split('\n').length;
    imports.push({ specifier: m[1].trim(), names: [], kind: 'side-effect', line });
  }

  // Re-exports: export { a, b as c } from 'specifier' or export * from 'specifier'
  const reExportRegex = /\bexport\s+(?:type\s+)?(\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = reExportRegex.exec(fullText)) !== null) {
    const clause = m[1].trim();
    const specifier = m[2].trim();
    const line = fullText.slice(0, m.index).split('\n').length;
    const names = clause === '*' ? [{ imported: '*', exported: '*' }] : parseJsNamedBraceList(clause);
    for (const n of names) {
      if (n.exported && n.exported !== '*') exportedNames.add(n.exported);
    }
    imports.push({
      specifier,
      names: names.map((n) => n.imported),
      kind: 're-export',
      line,
    });
  }

  // Local named exports: export { a, b as c };
  const namedExportRegex = /\bexport\s+\{([^}]+)\}(?!\s*from)/g;
  while ((m = namedExportRegex.exec(fullText)) !== null) {
    const list = parseJsNamedBraceList(`{${m[1]}}`);
    for (const item of list) {
      if (item.exported) exportedNames.add(item.exported);
    }
  }

  // CommonJS require(...)
  const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRegex.exec(fullText)) !== null) {
    const line = fullText.slice(0, m.index).split('\n').length;
    imports.push({ specifier: m[1].trim(), names: [], kind: 'require', line });
  }

  // 2. Line-by-line brace-aware symbol extraction
  let braceDepth = 0;
  const containerStack = []; // [{ name, kind, startDepth, endLine }]

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const masked = maskedLines[i];
    const trimmed = masked.trim();
    const lineNum = i + 1;

    while (containerStack.length > 0 && lineNum > containerStack[containerStack.length - 1].endLine) {
      containerStack.pop();
    }

    if (trimmed) {
      const activeContainer = containerStack[containerStack.length - 1] ?? null;

      // Match class / interface / type / enum
      const typeDeclMatch = trimmed.match(
        /^(export\s+)?(default\s+)?(?:abstract\s+)?(class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
      );
      if (typeDeclMatch) {
        const isExported = Boolean(typeDeclMatch[1]);
        const kind = typeDeclMatch[3];
        const name = typeDeclMatch[4];
        const endLine = findBraceBlockEnd(maskedLines, i);
        const doc = extractPrecedingDoc(rawLines, i);
        if (isExported) exportedNames.add(name);

        symbols.push({
          name,
          qualifiedName: activeContainer ? `${activeContainer.name}.${name}` : name,
          kind,
          parent: activeContainer?.name ?? null,
          exported: isExported,
          async: false,
          line: lineNum,
          endLine,
          signature: cleanSignature(raw),
          doc,
        });

        if (kind === 'class' || kind === 'interface') {
          containerStack.push({ name, kind, startDepth: braceDepth, endLine });
        }
      } else {
        // Match standard function declaration: [export] [default] [async] function[*] name(...)
        const fnMatch = trimmed.match(
          /^(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*[<(]/
        );
        if (fnMatch) {
          const isExported = Boolean(fnMatch[1]);
          const isAsync = Boolean(fnMatch[3]);
          const name = fnMatch[4];
          const endLine = findBraceBlockEnd(maskedLines, i);
          const doc = extractPrecedingDoc(rawLines, i);
          if (isExported) exportedNames.add(name);

          symbols.push({
            name,
            qualifiedName: activeContainer ? `${activeContainer.name}.${name}` : name,
            kind: 'function',
            parent: activeContainer?.name ?? null,
            exported: isExported,
            async: isAsync,
            line: lineNum,
            endLine,
            signature: cleanSignature(raw),
            doc,
          });
        } else {
          // Match arrow function or top-level exported/constant variable
          const arrowMatch = trimmed.match(
            /^(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/
          );
          if (arrowMatch) {
            const isExported = Boolean(arrowMatch[1]);
            const name = arrowMatch[3];
            const isAsync = Boolean(arrowMatch[4]);
            const endLine = findBraceBlockEnd(maskedLines, i);
            const doc = extractPrecedingDoc(rawLines, i);
            if (isExported) exportedNames.add(name);

            symbols.push({
              name,
              qualifiedName: activeContainer ? `${activeContainer.name}.${name}` : name,
              kind: 'function',
              parent: activeContainer?.name ?? null,
              exported: isExported,
              async: isAsync,
              line: lineNum,
              endLine,
              signature: cleanSignature(raw),
              doc,
            });
          } else if (braceDepth === 0) {
            // Top-level exported const or important top-level UPPER_CASE constant
            const constMatch = trimmed.match(/^(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
            if (constMatch && (constMatch[1] || /^[A-Z][A-Z0-9_]{2,}$/.test(constMatch[3]))) {
              const isExported = Boolean(constMatch[1]);
              const name = constMatch[3];
              const endLine = findBraceBlockEnd(maskedLines, i);
              const doc = extractPrecedingDoc(rawLines, i);
              if (isExported) exportedNames.add(name);

              symbols.push({
                name,
                qualifiedName: name,
                kind: 'constant',
                parent: null,
                exported: isExported,
                async: false,
                line: lineNum,
                endLine,
                signature: cleanSignature(raw),
                doc,
              });
            }
          } else if (
            activeContainer &&
            (activeContainer.kind === 'class' || activeContainer.kind === 'interface') &&
            braceDepth === activeContainer.startDepth + 1
          ) {
            // Match class method (including private #method, static, async, get/set)
            const methodMatch = trimmed.match(
              /^(?:(?:public|private|protected|readonly|override|abstract)\s+)*(static\s+)?(async\s+)?(?:(get|set)\s+)?(#?[A-Za-z_$][\w$]*)\s*[<(]/
            );
            if (methodMatch) {
              const isStatic = Boolean(methodMatch[1]);
              const isAsync = Boolean(methodMatch[2]);
              const accessor = methodMatch[3] || '';
              const name = methodMatch[4];
              if (!JS_KEYWORDS.has(name) || name === 'constructor') {
                const endLine = findBraceBlockEnd(maskedLines, i);
                const doc = extractPrecedingDoc(rawLines, i);
                symbols.push({
                  name,
                  qualifiedName: `${activeContainer.name}.${name}`,
                  kind: 'method',
                  parent: activeContainer.name,
                  exported: false,
                  static: isStatic,
                  accessor: accessor || undefined,
                  async: isAsync,
                  line: lineNum,
                  endLine,
                  signature: cleanSignature(raw),
                  doc,
                });
              }
            }
          }
        }
      }
    }

    // Update brace depth at the end of the line
    for (let j = 0; j < masked.length; j++) {
      if (masked[j] === '{') braceDepth++;
      else if (masked[j] === '}') braceDepth = Math.max(0, braceDepth - 1);
    }
  }
}

function parseJsImportClause(clause) {
  const names = [];
  if (!clause) return names;
  const braceMatch = clause.match(/\{([\s\S]*?)\}/);
  if (braceMatch) {
    const items = parseJsNamedBraceList(`{${braceMatch[1]}}`);
    for (const item of items) {
      if (item.imported) names.push(item.imported);
    }
  }
  const withoutBraces = clause.replace(/\{[\s\S]*?\}/, '').replace(/,/g, ' ').trim();
  if (withoutBraces) {
    const nsMatch = withoutBraces.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (nsMatch) {
      names.push(nsMatch[1]);
    } else {
      const defMatch = withoutBraces.match(/^([A-Za-z_$][\w$]*)/);
      if (defMatch) names.push(defMatch[1]);
    }
  }
  return names;
}

function parseJsNamedBraceList(braceBlock) {
  const inner = braceBlock.replace(/^\{|\}$/g, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((part) => part.replace(/\btype\s+/g, '').trim())
    .filter(Boolean)
    .map((part) => {
      const asMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asMatch) {
        return { imported: asMatch[1], exported: asMatch[2] };
      }
      return { imported: part, exported: part };
    });
}

function parsePythonStructure(rawLines, maskedLines, symbols, imports, exportedNames) {
  const classStack = []; // [{ name, indent, endLine }]

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const masked = maskedLines[i];
    const trimmed = masked.trim();
    if (!trimmed) continue;

    const lineNum = i + 1;
    const indent = raw.match(/^\s*/)?.[0]?.length ?? 0;

    while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) {
      classStack.pop();
    }

    const fromImport = trimmed.match(/^from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/);
    if (fromImport) {
      const names = fromImport[2]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      imports.push({ specifier: fromImport[1], names, kind: 'import', line: lineNum });
      continue;
    }

    const directImport = trimmed.match(/^import\s+([A-Za-z0-9_.,\s]+)$/);
    if (directImport) {
      const specs = directImport[1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      for (const spec of specs) {
        imports.push({ specifier: spec, names: [], kind: 'import', line: lineNum });
      }
      continue;
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/);
    if (classMatch) {
      const name = classMatch[1];
      const endLine = findPythonBlockEnd(rawLines, maskedLines, i);
      const activeClass = classStack[classStack.length - 1] ?? null;
      const isExported = !name.startsWith('_') && indent === 0;
      if (isExported) exportedNames.add(name);

      symbols.push({
        name,
        qualifiedName: activeClass ? `${activeClass.name}.${name}` : name,
        kind: 'class',
        parent: activeClass?.name ?? null,
        exported: isExported,
        async: false,
        line: lineNum,
        endLine,
        signature: cleanSignature(raw),
        doc: extractPrecedingDoc(rawLines, i),
      });

      classStack.push({ name, indent, endLine });
      continue;
    }

    const defMatch = trimmed.match(/^(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (defMatch) {
      const isAsync = Boolean(defMatch[1]);
      const name = defMatch[2];
      const endLine = findPythonBlockEnd(rawLines, maskedLines, i);
      const activeClass = classStack[classStack.length - 1] ?? null;
      const isExported = !name.startsWith('_') && !activeClass;
      if (isExported) exportedNames.add(name);

      symbols.push({
        name,
        qualifiedName: activeClass ? `${activeClass.name}.${name}` : name,
        kind: activeClass ? 'method' : 'function',
        parent: activeClass?.name ?? null,
        exported: isExported,
        async: isAsync,
        line: lineNum,
        endLine,
        signature: cleanSignature(raw),
        doc: extractPrecedingDoc(rawLines, i),
      });
    }
  }
}

function parseCSharpStructure(rawLines, maskedLines, symbols, imports, exportedNames) {
  let activeType = null;
  let activeTypeEndLine = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const masked = maskedLines[i];
    const trimmed = masked.trim();
    const lineNum = i + 1;
    if (!trimmed) continue;

    if (activeType && lineNum > activeTypeEndLine) {
      activeType = null;
    }

    const usingMatch = trimmed.match(/^using\s+(?:static\s+)?([A-Za-z0-9_.]+)\s*;/);
    if (usingMatch) {
      imports.push({ specifier: usingMatch[1], names: [], kind: 'using', line: lineNum });
      continue;
    }

    const typeMatch = trimmed.match(
      /^(?:(?:public|internal|private|protected|sealed|abstract|partial|static)\s+)*(class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/
    );
    if (typeMatch) {
      const kind = typeMatch[1];
      const name = typeMatch[2];
      const endLine = findBraceBlockEnd(maskedLines, i);
      const isPublic = /\bpublic\b/.test(trimmed);
      if (isPublic) exportedNames.add(name);

      symbols.push({
        name,
        qualifiedName: name,
        kind,
        parent: null,
        exported: isPublic,
        async: false,
        line: lineNum,
        endLine,
        signature: cleanSignature(raw),
        doc: extractPrecedingDoc(rawLines, i),
      });

      activeType = name;
      activeTypeEndLine = endLine;
      continue;
    }

    if (activeType) {
      const methodMatch = trimmed.match(
        /^(?:(?:public|private|protected|internal|static|virtual|override|async)\s+)+[\w<>[\],?.]+\s+([A-Za-z_]\w*)\s*\(/
      );
      if (methodMatch) {
        const name = methodMatch[1];
        const endLine = findBraceBlockEnd(maskedLines, i);
        symbols.push({
          name,
          qualifiedName: `${activeType}.${name}`,
          kind: 'method',
          parent: activeType,
          exported: /\bpublic\b/.test(trimmed),
          async: /\basync\b/.test(trimmed),
          line: lineNum,
          endLine,
          signature: cleanSignature(raw),
          doc: extractPrecedingDoc(rawLines, i),
        });
      }
    }
  }
}

function parsePowerShellStructure(rawLines, maskedLines, symbols, imports, exportedNames) {
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = maskedLines[i].trim();
    if (!trimmed) continue;
    const fnMatch = trimmed.match(/^(function|filter|class)\s+([A-Za-z0-9_-]+)/i);
    if (fnMatch) {
      const kind = fnMatch[1].toLowerCase() === 'class' ? 'class' : 'function';
      const name = fnMatch[2];
      const endLine = findBraceBlockEnd(maskedLines, i);
      exportedNames.add(name);
      symbols.push({
        name,
        qualifiedName: name,
        kind,
        parent: null,
        exported: true,
        async: false,
        line: i + 1,
        endLine,
        signature: cleanSignature(raw),
        doc: extractPrecedingDoc(rawLines, i),
      });
    }
  }
}

function parseGenericStructure(rawLines, maskedLines, symbols, imports, exportedNames) {
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = maskedLines[i].trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(?:pub\s+)?(?:async\s+)?(fn|func|struct|enum|trait|interface|class)\s+([A-Za-z_]\w*)/);
    if (match) {
      const rawKind = match[1];
      const kind = rawKind === 'fn' || rawKind === 'func' ? 'function' : rawKind;
      const name = match[2];
      const endLine = findBraceBlockEnd(maskedLines, i);
      const isExported = /^pub\b/.test(trimmed) || /^[A-Z]/.test(name);
      if (isExported) exportedNames.add(name);
      symbols.push({
        name,
        qualifiedName: name,
        kind,
        parent: null,
        exported: isExported,
        async: /\basync\b/.test(trimmed),
        line: i + 1,
        endLine,
        signature: cleanSignature(raw),
        doc: extractPrecedingDoc(rawLines, i),
      });
    }
  }
}

/**
 * Core Code Intelligence Engine with SHA-256 content-addressed caching.
 */
export class CodeIntelligenceEngine {
  constructor({ workspace, ignoredDirs = DEFAULT_IGNORED_DIRS, maxFileSizeBytes = 512 * 1024 } = {}) {
    if (!workspace || typeof workspace.resolve !== 'function') {
      throw new TypeError('CodeIntelligenceEngine yêu cầu đối tượng workspace có hàm resolve()');
    }
    this.workspace = workspace;
    this.ignoredDirs = new Set(ignoredDirs);
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.parseCache = new Map(); // relPath -> { sha256, mtimeMs, size, parsed, rawLines, maskedLines }
  }

  get rootPath() {
    // StudioWorkspace has a real root getter; test doubles may expose path.
    const root = this.workspace.root || this.workspace.path;
    if (typeof root !== 'string' || !root) throw new TypeError('Workspace root is unavailable');
    return path.resolve(root);
  }

  async resolveRelative(targetPath = '.') {
    // StudioWorkspace.resolve is async and returns { root, absolute, relative }.
    // The engine also supports the legacy synchronous path-string adapter.
    const resolved = await this.workspace.resolve(targetPath);
    const inputPath = typeof resolved === 'string' ? resolved : resolved?.absolute;
    if (typeof inputPath !== 'string') throw new TypeError('Invalid workspace resolution result');
    const full = path.resolve(inputPath), root = this.rootPath;
    const relative = path.relative(root, full);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('outside_workspace: code intelligence cannot scan outside the selected workspace');
    }
    const rel = toPosix(relative || '.');
    if (isProtectedPath(rel)) throw new Error('protected_path: code intelligence cannot inspect credential files or Git metadata');
    return { full, rel };
  }

  async listSourceFiles(subPath = '.') {
    const { full: startDir } = await this.resolveRelative(subPath);
    const files = [];

    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.ignoredDirs.has(entry.name)) continue;
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!CODE_EXTENSIONS.has(ext)) continue;
          const relPath = toPosix(path.relative(this.rootPath, fullPath));
          if (isProtectedPath(relPath)) continue;
          files.push({ fullPath, relPath, ext });
        }
      }
    };

    const stat = await fs.stat(startDir).catch(() => null);
    if (!stat) return files;
    if (stat.isFile()) {
      const ext = path.extname(startDir).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        files.push({
          fullPath: startDir,
          relPath: toPosix(path.relative(this.rootPath, startDir)),
          ext,
        });
      }
      return files;
    }

    await walk(startDir);
    return files;
  }

  async getParsedFile(relOrInputPath) {
    const { full, rel } = await this.resolveRelative(relOrInputPath);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size > this.maxFileSizeBytes) return null;

    const cached = this.parseCache.get(rel);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached;
    }

    let content;
    try {
      content = await fs.readFile(full, 'utf8');
    } catch {
      return null;
    }
    if (content.includes('\0')) return null; // Skip binary files

    const sha256 = hashContent(content);
    if (cached && cached.sha256 === sha256) {
      cached.mtimeMs = stat.mtimeMs;
      cached.size = stat.size;
      return cached;
    }

    const normalized = content.replace(/\r\n/g, '\n');
    const ext = path.extname(rel).toLowerCase();
    const language = CODE_EXTENSIONS.get(ext) || 'javascript';
    const masked = maskCommentsAndStrings(normalized, language);
    const parsed = parseSourceStructure(normalized, rel);

    const record = {
      relPath: rel,
      fullPath: full,
      sha256,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      parsed,
      rawLines: normalized.split('\n'),
      maskedLines: masked.split('\n'),
    };
    this.parseCache.set(rel, record);
    return record;
  }

  /**
   * Resolves a relative module specifier from `fromRelPath` to an existing workspace `relPath`.
   */
  resolveImportSpecifier(fromRelPath, specifier, knownFilesSet) {
    if (!specifier || !specifier.startsWith('.')) return null;
    const fromDir = path.posix.dirname(toPosix(fromRelPath));
    const baseCandidate = toPosix(path.posix.normalize(path.posix.join(fromDir, specifier)));

    if (knownFilesSet.has(baseCandidate)) return baseCandidate;
    for (const ext of RESOLVE_EXTENSIONS) {
      if (knownFilesSet.has(`${baseCandidate}${ext}`)) return `${baseCandidate}${ext}`;
    }
    // TypeScript ESM convention: importing './foo.js' when source is './foo.ts'
    if (baseCandidate.endsWith('.js') || baseCandidate.endsWith('.mjs')) {
      const stem = baseCandidate.replace(/\.(m?js)$/, '');
      for (const tsExt of ['.ts', '.tsx', '.mts']) {
        if (knownFilesSet.has(`${stem}${tsExt}`)) return `${stem}${tsExt}`;
      }
    }
    for (const ext of RESOLVE_EXTENSIONS) {
      const idxCandidate = toPosix(path.posix.join(baseCandidate, `index${ext}`));
      if (knownFilesSet.has(idxCandidate)) return idxCandidate;
    }
    return null;
  }

  /**
   * 1. Generates a Graph-Ranked Repository Map within a token budget.
   */
  async generateRepoMap({ path: subPath = '.', maxTokens = 2000, focusFiles = [], query = '' } = {}) {
    const fileEntries = await this.listSourceFiles(subPath);
    const knownSet = new Set(fileEntries.map((f) => f.relPath));
    const records = new Map();

    for (const entry of fileEntries) {
      const rec = await this.getParsedFile(entry.relPath);
      if (rec) records.set(entry.relPath, rec);
    }

    // Build dependency centrality scores (in-degree + out-degree + focus/query boosts)
    const inDegree = new Map();
    const outDegree = new Map();
    for (const rel of records.keys()) {
      inDegree.set(rel, 0);
      outDegree.set(rel, 0);
    }

    for (const [rel, rec] of records.entries()) {
      for (const imp of rec.parsed.imports) {
        const resolved = this.resolveImportSpecifier(rel, imp.specifier, knownSet);
        if (resolved && inDegree.has(resolved)) {
          inDegree.set(resolved, (inDegree.get(resolved) || 0) + 1);
          outDegree.set(rel, (outDegree.get(rel) || 0) + 1);
        }
      }
    }

    const focusSet = new Set((focusFiles || []).map((f) => toPosix(f)));
    const queryLower = String(query || '').trim().toLowerCase();

    const rankedFiles = Array.from(records.values()).map((rec) => {
      const rel = rec.relPath;
      let score = 1.0 + (inDegree.get(rel) || 0) * 3.0 + (outDegree.get(rel) || 0) * 0.5;
      if (focusSet.has(rel)) score += 25.0;
      if (/(^|\/)(index|main|server|agent|orchestrator|local-tools)\.[^/]+$/i.test(rel)) {
        score += 4.0;
      }
      if (/^tests?\//i.test(rel) || /\.test\.|\.spec\./i.test(rel)) {
        score *= 0.6;
      }
      if (queryLower) {
        if (rel.toLowerCase().includes(queryLower)) score += 15.0;
        for (const sym of rec.parsed.symbols) {
          if (sym.name.toLowerCase().includes(queryLower)) score += 6.0;
        }
      }
      return {
        relPath: rel,
        score: Number(score.toFixed(2)),
        inDegree: inDegree.get(rel) || 0,
        outDegree: outDegree.get(rel) || 0,
        lineCount: rec.parsed.lineCount,
        symbols: rec.parsed.symbols,
        exportedNames: rec.parsed.exportedNames,
      };
    });

    rankedFiles.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));

    // Render compact Repo Map respecting maxTokens
    const budget = Math.max(250, Number(maxTokens) || 2000);
    const lines = [
      `# Repository Code Map (${rankedFiles.length} source files analyzed, budget: ~${budget} tokens)`,
    ];
    let usedTokens = estimateTokens(lines[0]);
    let includedFiles = 0;
    let includedSymbols = 0;

    for (const file of rankedFiles) {
      const header = `\n## ${file.relPath} (${file.lineCount} lines, imported by ${file.inDegree} files, rank=${file.score})`;
      const headerTokens = estimateTokens(header);
      if (usedTokens + headerTokens > budget) break;

      lines.push(header);
      usedTokens += headerTokens;
      includedFiles++;

      // Prioritize exported symbols & classes/functions first
      const prioritizedSymbols = [...file.symbols].sort((a, b) => {
        if (a.exported !== b.exported) return a.exported ? -1 : 1;
        if (Boolean(a.parent) !== Boolean(b.parent)) return a.parent ? 1 : -1;
        return a.line - b.line;
      });

      for (const sym of prioritizedSymbols) {
        const prefix = sym.parent ? `  - [L${sym.line}-L${sym.endLine}] ` : `- [L${sym.line}-L${sym.endLine}] `;
        const expTag = sym.exported ? 'export ' : '';
        const symLine = `${prefix}${expTag}${sym.kind} ${sym.qualifiedName}: ${sym.signature}`;
        const symTokens = estimateTokens(symLine);
        if (usedTokens + symTokens > budget) break;
        lines.push(symLine);
        usedTokens += symTokens;
        includedSymbols++;
      }
    }

    if (includedFiles < rankedFiles.length) {
      lines.push(`\n... (+${rankedFiles.length - includedFiles} lower-ranked files omitted to fit token budget)`);
    }

    return {
      text: lines.join('\n'),
      structured: {
        totalFiles: rankedFiles.length,
        includedFiles,
        includedSymbols,
        estimatedTokens: usedTokens,
        topFiles: rankedFiles.slice(0, 25).map((f) => ({
          path: f.relPath,
          rankScore: f.score,
          importedByCount: f.inDegree,
          lineCount: f.lineCount,
          symbolCount: f.symbols.length,
        })),
      },
    };
  }

  /**
   * 2. Inspects symbols in a specific file or searches symbols across the workspace.
   */
  async querySymbols({ path: subPath = '.', query = '', kind = '', exportedOnly = false, limit = 100 } = {}) {
    const fileEntries = await this.listSourceFiles(subPath);
    const queryLower = String(query || '').trim().toLowerCase();
    const kindLower = String(kind || '').trim().toLowerCase();
    const maxItems = Math.max(1, Math.min(500, Number(limit) || 100));

    const matched = [];
    for (const entry of fileEntries) {
      const rec = await this.getParsedFile(entry.relPath);
      if (!rec) continue;
      for (const sym of rec.parsed.symbols) {
        if (exportedOnly && !sym.exported) continue;
        if (kindLower && sym.kind.toLowerCase() !== kindLower) continue;
        if (
          queryLower &&
          !sym.name.toLowerCase().includes(queryLower) &&
          !sym.qualifiedName.toLowerCase().includes(queryLower)
        ) {
          continue;
        }
        matched.push({
          file: rec.relPath,
          ...sym,
        });
      }
    }

    // Rank exact matches first, then exported, then file order
    if (queryLower) {
      matched.sort((a, b) => {
        const aExact = a.name.toLowerCase() === queryLower ? 1 : 0;
        const bExact = b.name.toLowerCase() === queryLower ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
        if (a.exported !== b.exported) return a.exported ? -1 : 1;
        return a.file.localeCompare(b.file) || a.line - b.line;
      });
    }

    const sliced = matched.slice(0, maxItems);
    const lines = [
      `Tìm thấy ${matched.length} ký hiệu (symbols)${matched.length > sliced.length ? `, hiển thị ${sliced.length} kết quả đầu` : ''}:`,
    ];
    for (const item of sliced) {
      const exp = item.exported ? '[export] ' : '';
      const docPart = item.doc ? ` // ${item.doc}` : '';
      lines.push(
        `- ${item.file}:${item.line}-${item.endLine} ${exp}(${item.kind}) ${item.qualifiedName} -> ${item.signature}${docPart}`
      );
    }

    return {
      text: lines.join('\n'),
      structured: {
        totalMatches: matched.length,
        symbols: sliced,
      },
    };
  }

  /**
   * 3. Finds the exact definition of a symbol (with import-aware resolution from contextPath).
   */
  async findDefinition({ symbol, contextPath = '', path: subPath = '.' } = {}) {
    const target = String(symbol || '').trim();
    if (!target) {
      throw new Error('Tham số "symbol" không được để trống.');
    }

    const shortTarget = target.includes('.') ? target.split('.').pop() : target;
    const fileEntries = await this.listSourceFiles(subPath);
    const knownSet = new Set(fileEntries.map((f) => f.relPath));

    let preferredFile = null;
    const normalizedContext = contextPath ? toPosix(contextPath) : '';

    if (normalizedContext) {
      const ctxRec = await this.getParsedFile(normalizedContext);
      if (ctxRec) {
        for (const imp of ctxRec.parsed.imports) {
          if (imp.names.includes(shortTarget)) {
            const resolved = this.resolveImportSpecifier(ctxRec.relPath, imp.specifier, knownSet);
            if (resolved) {
              preferredFile = resolved;
              break;
            }
          }
        }
      }
    }

    const candidates = [];
    for (const entry of fileEntries) {
      const rec = await this.getParsedFile(entry.relPath);
      if (!rec) continue;

      for (const sym of rec.parsed.symbols) {
        const isExactQualified = sym.qualifiedName === target;
        const isExactName = sym.name === shortTarget;
        if (!isExactQualified && !isExactName) continue;

        let score = 10;
        if (isExactQualified) score += 20;
        if (sym.exported) score += 10;
        if (preferredFile && rec.relPath === preferredFile) score += 50;
        if (normalizedContext && rec.relPath === normalizedContext) score += 30;

        const snippetStart = Math.max(1, sym.line - 2);
        const snippetEnd = Math.min(rec.rawLines.length, Math.min(sym.endLine, sym.line + 10));
        const snippet = rec.rawLines
          .slice(snippetStart - 1, snippetEnd)
          .map((l, idx) => `${snippetStart + idx}: ${l}`)
          .join('\n');

        candidates.push({
          score,
          file: rec.relPath,
          sha256: rec.sha256,
          ...sym,
          snippet,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);

    if (candidates.length === 0) {
      return {
        text: `Không tìm thấy định nghĩa cho ký hiệu "${target}".`,
        structured: { symbol: target, definitions: [] },
      };
    }

    const lines = [`Tìm thấy ${candidates.length} định nghĩa cho "${target}":`];
    for (const def of candidates.slice(0, 10)) {
      lines.push(`\n### ${def.file}:${def.line}-${def.endLine} (${def.kind} ${def.qualifiedName})`);
      if (def.doc) lines.push(`Doc: ${def.doc}`);
      lines.push(def.snippet);
    }

    return {
      text: lines.join('\n'),
      structured: {
        symbol: target,
        preferredImportTarget: preferredFile,
        definitions: candidates.slice(0, 10),
      },
    };
  }

  /**
   * 4. Finds all references and call-sites of a symbol across the workspace (ignoring comments/strings).
   */
  async findReferences({ symbol, path: subPath = '.', includeDeclarations = true, limit = 150 } = {}) {
    const target = String(symbol || '').trim();
    if (!target) {
      throw new Error('Tham số "symbol" không được để trống.');
    }
    const shortTarget = target.includes('.') ? target.split('.').pop() : target;
    const escaped = shortTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, 'g');

    const fileEntries = await this.listSourceFiles(subPath);
    const maxRefs = Math.max(1, Math.min(500, Number(limit) || 150));
    const references = [];

    for (const entry of fileEntries) {
      const rec = await this.getParsedFile(entry.relPath);
      if (!rec) continue;

      const declLines = new Set(
        rec.parsed.symbols.filter((s) => s.name === shortTarget).map((s) => s.line)
      );
      const importLines = new Set(rec.parsed.imports.map((imp) => imp.line));

      for (let i = 0; i < rec.maskedLines.length; i++) {
        const maskedLine = rec.maskedLines[i];
        wordRegex.lastIndex = 0;
        const match = wordRegex.exec(maskedLine);
        if (!match) continue;

        const lineNum = i + 1;
        const isDecl = declLines.has(lineNum);
        if (isDecl && !includeDeclarations) continue;

        let refKind = 'reference';
        if (isDecl) {
          refKind = 'definition';
        } else if (importLines.has(lineNum) || /^\s*(import|export|from)\b/.test(maskedLine)) {
          refKind = 'import';
        } else {
          const after = maskedLine.slice(match.index + shortTarget.length).trimStart();
          const before = maskedLine.slice(0, match.index).trimEnd();
          if (after.startsWith('(') || /\bnew$/.test(before)) {
            refKind = 'call';
          }
        }

        // Determine innermost enclosing function/method/class scope
        let enclosingSymObj = null;
        for (const sym of rec.parsed.symbols) {
          if (lineNum >= sym.line && lineNum <= sym.endLine) {
            if (!enclosingSymObj || sym.line >= enclosingSymObj.line) {
              enclosingSymObj = sym;
            }
          }
        }

        references.push({
          file: rec.relPath,
          line: lineNum,
          column: match.index + 1,
          kind: refKind,
          enclosingSymbol: enclosingSymObj ? enclosingSymObj.qualifiedName : null,
          code: rec.rawLines[i].trim().slice(0, 160),
        });
      }
    }

    const sliced = references.slice(0, maxRefs);
    const byKind = {
      definition: references.filter((r) => r.kind === 'definition').length,
      import: references.filter((r) => r.kind === 'import').length,
      call: references.filter((r) => r.kind === 'call').length,
      reference: references.filter((r) => r.kind === 'reference').length,
    };

    const lines = [
      `Tìm thấy ${references.length} tham chiếu cho "${shortTarget}" (definitions: ${byKind.definition}, imports: ${byKind.import}, calls: ${byKind.call}, other: ${byKind.reference}):`,
    ];
    for (const ref of sliced) {
      const scopeTag = ref.enclosingSymbol ? ` [in ${ref.enclosingSymbol}]` : '';
      lines.push(`- ${ref.file}:${ref.line}:${ref.column} (${ref.kind})${scopeTag} -> ${ref.code}`);
    }

    return {
      text: lines.join('\n'),
      structured: {
        symbol: shortTarget,
        totalReferences: references.length,
        countsByKind: byKind,
        references: sliced,
      },
    };
  }

  /**
   * 5. Builds the Module Dependency Graph, Impact/Blast-Radius Analysis, Related Tests, and Cycle Detection.
   */
  async analyzeDependencies({ path: targetPath = '.' } = {}) {
    const allEntries = await this.listSourceFiles('.');
    const knownSet = new Set(allEntries.map((f) => f.relPath));
    const records = new Map();

    for (const entry of allEntries) {
      const rec = await this.getParsedFile(entry.relPath);
      if (rec) records.set(entry.relPath, rec);
    }

    const forwardGraph = new Map(); // file -> Set(resolvedTarget)
    const reverseGraph = new Map(); // file -> Set(importerFile)
    const externalPackages = new Map(); // pkg -> Set(importerFile)
    const unresolvedImports = [];

    for (const rel of records.keys()) {
      forwardGraph.set(rel, new Set());
      reverseGraph.set(rel, new Set());
    }

    for (const [rel, rec] of records.entries()) {
      for (const imp of rec.parsed.imports) {
        if (imp.specifier.startsWith('.')) {
          const resolved = this.resolveImportSpecifier(rel, imp.specifier, knownSet);
          if (resolved) {
            forwardGraph.get(rel)?.add(resolved);
            if (!reverseGraph.has(resolved)) reverseGraph.set(resolved, new Set());
            reverseGraph.get(resolved)?.add(rel);
          } else {
            unresolvedImports.push({
              file: rel,
              line: imp.line,
              specifier: imp.specifier,
            });
          }
        } else {
          const pkgName = imp.specifier.startsWith('@')
            ? imp.specifier.split('/').slice(0, 2).join('/')
            : imp.specifier.split('/')[0];
          if (!externalPackages.has(pkgName)) externalPackages.set(pkgName, new Set());
          externalPackages.get(pkgName).add(rel);
        }
      }
    }

    // Detect circular dependencies using DFS
    const cycles = [];
    const visited = new Set();
    const visiting = new Set();
    const stack = [];

    const dfs = (node) => {
      visiting.add(node);
      stack.push(node);
      for (const next of forwardGraph.get(node) || []) {
        if (!visited.has(next)) {
          if (visiting.has(next)) {
            const idx = stack.indexOf(next);
            if (idx !== -1) {
              cycles.push([...stack.slice(idx), next]);
            }
          } else if (records.has(next)) {
            dfs(next);
          }
        }
      }
      stack.pop();
      visiting.delete(node);
      visited.add(node);
    };

    for (const node of records.keys()) {
      if (!visited.has(node)) dfs(node);
    }

    // Check if targetPath points to a specific file for Impact / Blast-Radius analysis
    const { rel: focusRel } = await this.resolveRelative(targetPath);
    if (records.has(focusRel)) {
      const directDeps = Array.from(forwardGraph.get(focusRel) || []);
      const directDependents = Array.from(reverseGraph.get(focusRel) || []);

      // Compute transitive blast radius (all files affected if focusRel changes)
      const transitiveDependents = new Set();
      const queue = [...directDependents];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (transitiveDependents.has(cur)) continue;
        transitiveDependents.add(cur);
        for (const upper of reverseGraph.get(cur) || []) {
          if (!transitiveDependents.has(upper)) queue.push(upper);
        }
      }

      const relatedTests = Array.from(transitiveDependents).filter(
        (f) => /^tests?\//i.test(f) || /\.test\.|\.spec\./i.test(f)
      );

      const lines = [
        `# Phân tích Phụ thuộc & Phạm vi Ảnh hưởng (Blast Radius) cho: ${focusRel}`,
        `- Phụ thuộc trực tiếp (${directDeps.length}): ${directDeps.join(', ') || '(không có)'}`,
        `- Các file import trực tiếp (${directDependents.length}): ${directDependents.join(', ') || '(không có)'}`,
        `- Tổng phạm vi ảnh hưởng bắc cầu (${transitiveDependents.size}): ${Array.from(transitiveDependents).join(', ') || '(không có)'}`,
        `- Các file test liên quan nên chạy (${relatedTests.length}): ${relatedTests.join(', ') || '(không tìm thấy test trực tiếp)'}`,
      ];

      return {
        text: lines.join('\n'),
        structured: {
          targetFile: focusRel,
          directDependencies: directDeps,
          directDependents,
          transitiveBlastRadius: Array.from(transitiveDependents),
          relatedTests,
          circularDependencies: cycles.filter((c) => c.includes(focusRel)),
        },
      };
    }

    const lines = [
      `# Đồ thị Phụ thuộc Workspace (${records.size} files)`,
      `- Số gói external/built-in sử dụng: ${externalPackages.size} (${Array.from(externalPackages.keys()).slice(0, 15).join(', ')})`,
      `- Số vòng lặp phụ thuộc (Circular Dependencies): ${cycles.length}`,
      `- Số import tương đối không phân giải được: ${unresolvedImports.length}`,
    ];
    for (const cyc of cycles.slice(0, 10)) {
      lines.push(`  * Chu trình: ${cyc.join(' -> ')}`);
    }
    for (const unres of unresolvedImports.slice(0, 10)) {
      lines.push(`  * Lỗi import: ${unres.file}:${unres.line} -> "${unres.specifier}"`);
    }

    return {
      text: lines.join('\n'),
      structured: {
        totalFiles: records.size,
        externalPackages: Array.from(externalPackages.keys()),
        circularDependencies: cycles,
        unresolvedImports,
      },
    };
  }

  /**
   * 6. Static Structural & Cross-File Export Contract Diagnostics.
   */
  async runDiagnostics({ path: subPath = '.' } = {}) {
    const allEntries = await this.listSourceFiles('.');
    const knownSet = new Set(allEntries.map((f) => f.relPath));
    const targetEntries = subPath === '.' ? allEntries : await this.listSourceFiles(subPath);

    const diagnostics = [];

    for (const entry of targetEntries) {
      const rec = await this.getParsedFile(entry.relPath);
      if (!rec) continue;

      // Check 1: Balanced braces/brackets/parentheses in masked code
      const delimErrors = checkBalancedDelimiters(rec.maskedLines, rec.relPath);
      diagnostics.push(...delimErrors);

      // Check 2: Duplicate top-level symbol declarations in the same file
      const seenTopLevel = new Map();
      for (const sym of rec.parsed.symbols) {
        if (sym.parent) continue;
        const key = `${sym.kind}:${sym.name}`;
        if (seenTopLevel.has(key)) {
          diagnostics.push({
            severity: 'warning',
            code: 'duplicate_symbol',
            file: rec.relPath,
            line: sym.line,
            message: `Ký hiệu "${sym.name}" (${sym.kind}) bị khai báo trùng lặp trong cùng file (khai báo trước tại dòng ${seenTopLevel.get(key)}).`,
          });
        } else {
          seenTopLevel.set(key, sym.line);
        }
      }

      // Check 3: Cross-file import/export contract verification
      for (const imp of rec.parsed.imports) {
        if (!imp.specifier.startsWith('.')) continue;
        const resolved = this.resolveImportSpecifier(rec.relPath, imp.specifier, knownSet);
        if (!resolved) {
          diagnostics.push({
            severity: 'error',
            code: 'unresolved_import',
            file: rec.relPath,
            line: imp.line,
            message: `Không tìm thấy file đích cho import tương đối "${imp.specifier}".`,
          });
          continue;
        }

        if (imp.names.length > 0 && !resolved.endsWith('.json')) {
          const targetRec = await this.getParsedFile(resolved);
          if (targetRec && targetRec.parsed.exportedNames.length > 0) {
            const targetExports = new Set(targetRec.parsed.exportedNames);
            // Skip if target file has wildcard re-export
            const hasWildcardReExport = targetRec.parsed.imports.some(
              (i) => i.kind === 're-export' && i.names.includes('*')
            );
            if (!hasWildcardReExport) {
              for (const importedName of imp.names) {
                if (importedName === '*' || importedName === 'default') continue;
                // Only flag named imports (which appear inside { ... } in the raw import line)
                const rawImportLine = rec.rawLines[imp.line - 1] || '';
                const isNamedImport = new RegExp(`\\{[^}]*\\b${importedName}\\b[^}]*\\}`).test(rawImportLine);
                if (isNamedImport && !targetExports.has(importedName)) {
                  diagnostics.push({
                    severity: 'error',
                    code: 'missing_export',
                    file: rec.relPath,
                    line: imp.line,
                    message: `"${importedName}" được import từ "${imp.specifier}" nhưng không được export trong ${resolved}.`,
                  });
                }
              }
            }
          }
        }
      }
    }

    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
    const lines = [
      `Kiểm tra chẩn đoán tĩnh trên ${targetEntries.length} files: ${errors} lỗi (errors), ${warnings} cảnh báo (warnings).`,
    ];
    for (const d of diagnostics) {
      lines.push(`- [${d.severity.toUpperCase()}] ${d.file}:${d.line} (${d.code}) -> ${d.message}`);
    }

    return {
      text: lines.join('\n'),
      structured: {
        filesChecked: targetEntries.length,
        errorCount: errors,
        warningCount: warnings,
        diagnostics,
      },
    };
  }
}

function checkBalancedDelimiters(maskedLines, relPath) {
  const issues = [];
  const stack = [];
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const closers = new Set(['}', ')', ']']);

  for (let i = 0; i < maskedLines.length; i++) {
    const line = maskedLines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (pairs[ch]) {
        stack.push({ ch, expected: pairs[ch], line: i + 1, col: j + 1 });
      } else if (closers.has(ch)) {
        const last = stack.pop();
        if (!last) {
          issues.push({
            severity: 'error',
            code: 'unmatched_closing_delimiter',
            file: relPath,
            line: i + 1,
            message: `Dấu đóng "${ch}" tại cột ${j + 1} không có dấu mở tương ứng.`,
          });
          return issues;
        }
        if (last.expected !== ch) {
          issues.push({
            severity: 'error',
            code: 'mismatched_delimiter',
            file: relPath,
            line: i + 1,
            message: `Dấu đóng "${ch}" tại dòng ${i + 1}:${j + 1} không khớp với dấu mở "${last.ch}" tại dòng ${last.line}:${last.col} (cần "${last.expected}").`,
          });
          return issues;
        }
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    issues.push({
      severity: 'error',
      code: 'unclosed_delimiter',
      file: relPath,
      line: unclosed.line,
      message: `Dấu mở "${unclosed.ch}" tại dòng ${unclosed.line}:${unclosed.col} chưa được đóng.`,
    });
  }

  return issues;
}

/**
 * Helper to format tool response in standard ChatMCP LocalTools format.
 */
function formatSuccess(text, structuredContent) {
  return {
    isError: false,
    content: [{ type: 'text', text: String(text) }],
    structuredContent,
  };
}

/**
 * Registers the 6 Code Intelligence tools directly into LocalTools.#register() via `define`.
 */
export function registerCodeIntelligenceTools(define, workspace, { engine: existingEngine } = {}) {
  const engine = existingEngine ?? new CodeIntelligenceEngine({ workspace });

  define('repo_map', {
    description:
      'Generate a PageRank-style repository map of source files and exported symbol signatures within a token budget. Use this first on large codebases to locate relevant modules and line ranges without reading full files.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Subdirectory to map (default: workspace root ".")' },
        max_tokens: { type: 'integer', description: 'Maximum token budget for the output map (default: 2000)' },
        query: { type: 'string', description: 'Optional keyword to boost matching files and symbols' },
        focus_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional relative file paths to boost in ranking',
        },
      },
    },
    category: 'read',
    reason: 'Tạo bản đồ kiến trúc mã nguồn (Repo Map)',
    pathArgs: ['path'],
    summary: (a) => `Bản đồ mã nguồn ${a.path || '.'}`,
    run: async (a) => {
      const res = await engine.generateRepoMap({
        path: a.path ?? '.',
        maxTokens: a.max_tokens ?? 2000,
        query: a.query ?? '',
        focusFiles: a.focus_files ?? [],
      });
      return formatSuccess(res.text, res.structured);
    },
  });

  define('code_symbols', {
    description:
      'List or search structural code symbols (classes, interfaces, types, functions, methods, constants) with exact 1-based start/end line numbers and signatures.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'File or directory path relative to workspace (default: ".")' },
        query: { type: 'string', description: 'Filter symbols by name or qualifiedName substring' },
        kind: {
          type: 'string',
          description: 'Filter by symbol kind: class, interface, type, enum, function, method, constant',
        },
        exported_only: { type: 'boolean', description: 'Only return exported/public symbols' },
        limit: { type: 'integer', description: 'Max symbols to return (default: 100)' },
      },
    },
    category: 'read',
    reason: 'Tra cứu danh sách ký hiệu mã nguồn (AST Symbols)',
    pathArgs: ['path'],
    summary: (a) => `Tra cứu ký hiệu ${a.query || a.path || '.'}`,
    run: async (a) => {
      const res = await engine.querySymbols({
        path: a.path ?? '.',
        query: a.query ?? '',
        kind: a.kind ?? '',
        exportedOnly: Boolean(a.exported_only),
        limit: a.limit ?? 100,
      });
      return formatSuccess(res.text, res.structured);
    },
  });

  define('find_definition', {
    description:
      'Jump to the exact definition of a symbol (class, function, method, type, or constant) across the workspace, resolving ES module / CommonJS imports when context_path is provided.',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Symbol name or Class.method qualified name to locate' },
        context_path: {
          type: 'string',
          description: 'Optional file path where the symbol is referenced, used to resolve imports accurately',
        },
        path: { type: 'string', description: 'Directory scope to search in (default: ".")' },
      },
    },
    category: 'read',
    reason: 'Tìm vị trí định nghĩa ký hiệu (Go to Definition)',
    pathArgs: ['path', 'context_path'],
    summary: (a) => `Tìm định nghĩa ${a.symbol}`,
    run: async (a) => {
      const res = await engine.findDefinition({
        symbol: a.symbol,
        contextPath: a.context_path ?? '',
        path: a.path ?? '.',
      });
      return formatSuccess(res.text, res.structured);
    },
  });

  define('find_references', {
    description:
      'Find all references, imports, and call-sites of a symbol across the workspace (ignoring matches inside comments and strings) along with their enclosing function/class scope.',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Symbol identifier to find references for' },
        path: { type: 'string', description: 'Directory or file path to search in (default: ".")' },
        include_declarations: {
          type: 'boolean',
          description: 'Include declaration lines in results (default: true)',
        },
        limit: { type: 'integer', description: 'Max references to return (default: 150)' },
      },
    },
    category: 'read',
    reason: 'Tìm tất cả tham chiếu và nơi gọi hàm (Find References)',
    pathArgs: ['path'],
    summary: (a) => `Tìm tham chiếu ${a.symbol}`,
    run: async (a) => {
      const res = await engine.findReferences({
        symbol: a.symbol,
        path: a.path ?? '.',
        includeDeclarations: a.include_declarations ?? true,
        limit: a.limit ?? 150,
      });
      return formatSuccess(res.text, res.structured);
    },
  });

  define('dependency_graph', {
    description:
      'Analyze module imports/exports, reverse dependents (blast radius when editing a file), related test files to run, and circular dependency cycles.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Target file path for blast-radius analysis, or "." for full workspace dependency graph',
        },
      },
    },
    category: 'read',
    reason: 'Phân tích đồ thị phụ thuộc và phạm vi ảnh hưởng (Dependency Graph)',
    pathArgs: ['path'],
    summary: (a) => `Phân tích phụ thuộc ${a.path || '.'}`,
    run: async (a) => {
      const res = await engine.analyzeDependencies({ path: a.path ?? '.' });
      return formatSuccess(res.text, res.structured);
    },
  });

  define('code_diagnostics', {
    description:
      'Run fast static structural diagnostics: verify cross-file import/export contracts (missing exports, unresolved relative paths), balanced delimiters, and duplicate declarations.',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'File or directory path to check (default: ".")' },
      },
    },
    category: 'read',
    reason: 'Kiểm tra chẩn đoán tĩnh và hợp đồng import/export (Code Diagnostics)',
    pathArgs: ['path'],
    summary: (a) => `Chẩn đoán mã nguồn ${a.path || '.'}`,
    run: async (a) => {
      const res = await engine.runDiagnostics({ path: a.path ?? '.' });
      return formatSuccess(res.text, res.structured);
    },
  });

  return engine;
}

export const CODE_INTELLIGENCE_TOOLS = [
  'repo_map',
  'code_symbols',
  'find_definition',
  'find_references',
  'dependency_graph',
  'code_diagnostics',
];
