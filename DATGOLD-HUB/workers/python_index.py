"""Safe AST-based Python symbol/reference extraction; source comes on stdin.
Never execute or import the indexed project code. JSON in, JSON out.
"""
import ast
import json
import sys


SCHEMA_VERSION = 1
MAX_FILES = 500
MAX_SOURCE_CHARS = 2_000_000


def _normalize_path(raw_path):
    if not isinstance(raw_path, str):
        return ''
    return raw_path.replace('\\', '/').strip()


def _format_args(args_node):
    parts = []
    for arg in getattr(args_node, 'posonlyargs', []):
        parts.append(arg.arg)
    for arg in getattr(args_node, 'args', []):
        parts.append(arg.arg)
    if getattr(args_node, 'vararg', None):
        parts.append('*' + args_node.vararg.arg)
    for arg in getattr(args_node, 'kwonlyargs', []):
        parts.append(arg.arg)
    if getattr(args_node, 'kwarg', None):
        parts.append('**' + args_node.kwarg.arg)
    return ', '.join(parts)


def index_file(entry):
    if isinstance(entry, str):
        filename = _normalize_path(entry)
        try:
            with open(entry, 'r', encoding='utf-8') as fh:
                source = fh.read(MAX_SOURCE_CHARS + 1)
        except OSError as exc:
            return {
                'path': filename,
                'symbols': [],
                'references': [],
                'imports': [],
                'parseError': f'IOError: {exc}'[:240],
            }
    elif isinstance(entry, dict):
        filename = _normalize_path(entry.get('path', ''))
        source = entry.get('source', '')
        if not isinstance(source, str):
            return {
                'path': filename,
                'symbols': [],
                'references': [],
                'imports': [],
                'parseError': 'Invalid source: expected string',
            }
    else:
        return {
            'path': '',
            'symbols': [],
            'references': [],
            'imports': [],
            'parseError': 'Invalid file entry',
        }

    if not filename:
        return {
            'path': '',
            'symbols': [],
            'references': [],
            'imports': [],
            'parseError': 'Missing file path',
        }

    if len(source) > MAX_SOURCE_CHARS:
        return {
            'path': filename,
            'symbols': [],
            'references': [],
            'imports': [],
            'parseError': f'Source exceeds limit ({MAX_SOURCE_CHARS} chars)',
        }

    symbols = []
    references = []
    imports = []
    try:
        tree = ast.parse(source, filename=filename)
    except (SyntaxError, ValueError, TypeError) as exc:
        lineno = getattr(exc, 'lineno', None)
        offset = getattr(exc, 'offset', None)
        msg = getattr(exc, 'msg', str(exc))
        loc = f' (line {lineno}, col {offset})' if lineno else ''
        return {
            'path': filename,
            'symbols': [],
            'references': [],
            'imports': [],
            'parseError': f'SyntaxError: {msg}{loc}'[:240],
        }

    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node

    for node in ast.walk(tree):
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            container = []
            enclosing_class = None
            p = parents.get(id(node))
            while p is not None:
                if isinstance(p, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    container.append(p.name)
                    if enclosing_class is None and isinstance(p, ast.ClassDef):
                        enclosing_class = p.name
                p = parents.get(id(p))
            container_path = '.'.join(reversed(container))
            is_class = isinstance(node, ast.ClassDef)
            is_async = isinstance(node, ast.AsyncFunctionDef)
            is_method = (not is_class) and (enclosing_class is not None)
            kind = 'class' if is_class else ('method' if is_method else 'function')
            qualified_name = f'{container_path}.{node.name}' if container_path else node.name
            if is_class:
                bases = [ast.unparse(b) if hasattr(ast, 'unparse') else getattr(b, 'id', '') for b in node.bases]
                base_str = f"({', '.join(b for b in bases if b)})" if bases else ''
                signature = f'class {node.name}{base_str}'
            else:
                prefix = 'async def' if is_async else 'def'
                signature = f'{prefix} {node.name}({_format_args(node.args)})'
            doc = ast.get_docstring(node) or ''
            end_line = getattr(node, 'end_lineno', None) or node.lineno
            symbols.append({
                'name': node.name,
                'qualifiedName': qualified_name,
                'kind': kind,
                'line': node.lineno,
                'endLine': end_line,
                'column': node.col_offset,
                'container': container_path,
                'signature': signature,
                'exported': not node.name.startswith('_'),
                'doc': doc.splitlines()[0].strip()[:200] if doc else '',
            })
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            references.append({'name': node.id, 'line': node.lineno, 'column': node.col_offset})
        elif isinstance(node, ast.Import):
            imports.extend(alias.name for alias in node.names if alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imports.append('.' * (node.level or 0) + node.module)

    symbols.sort(key=lambda s: (s['line'], s['column'], s['name']))
    return {
        'path': filename,
        'symbols': symbols[:3000],
        'references': references[:30000],
        'imports': imports[:300],
        'parseError': None,
    }


def main():
    if hasattr(sys.stdin, 'reconfigure'):
        sys.stdin.reconfigure(encoding='utf-8')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    raw = sys.stdin.read()
    if not raw or not raw.strip():
        print(json.dumps({'schemaVersion': SCHEMA_VERSION, 'tier': 'python-ast', 'files': [], 'symbols': []}, ensure_ascii=False))
        return
    try:
        data = json.loads(raw)
    except Exception as exc:
        print(json.dumps({'schemaVersion': SCHEMA_VERSION, 'tier': 'python-ast', 'files': [], 'symbols': [], 'error': f'Invalid JSON input: {exc}'[:240]}, ensure_ascii=False))
        return

    if isinstance(data, list):
        entries = data[:MAX_FILES]
    elif isinstance(data, dict):
        entries = (data.get('files') or [])[:MAX_FILES]
    else:
        entries = []

    indexed_files = [index_file(x) for x in entries]
    flat_symbols = []
    for f in indexed_files:
        for sym in f.get('symbols', []):
            item = dict(sym)
            item.setdefault('file', f.get('path', ''))
            flat_symbols.append(item)

    out = {
        'schemaVersion': SCHEMA_VERSION,
        'tier': 'python-ast',
        'files': indexed_files,
        'symbols': flat_symbols[:3000],
        'parseError': indexed_files[0]['parseError'] if len(indexed_files) == 1 else None,
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
