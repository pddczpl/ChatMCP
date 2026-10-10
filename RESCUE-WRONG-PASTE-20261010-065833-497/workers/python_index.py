"""Safe AST-based Python symbol/reference extraction; source comes on stdin.
Never execute or import the indexed project code. JSON in, JSON out.
"""
import ast
import json
import sys


def index_file(entry):
    source = entry['source']
    filename = entry['path']
    symbols = []
    references = []
    imports = []
    try:
        tree = ast.parse(source, filename=filename)
    except (SyntaxError, ValueError) as exc:
        return {'path': filename, 'symbols': [], 'references': [], 'imports': [], 'parseError': str(exc)[:180]}
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node
    for node in ast.walk(tree):
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            container = []
            p = parents.get(id(node))
            while p is not None:
                if isinstance(p, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    container.append(p.name)
                p = parents.get(id(p))
            symbols.append({'name': node.name, 'kind': 'class' if isinstance(node, ast.ClassDef) else 'function',
                            'line': node.lineno, 'column': node.col_offset, 'container': '.'.join(reversed(container))})
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            references.append({'name': node.id, 'line': node.lineno, 'column': node.col_offset})
        elif isinstance(node, ast.Import):
            imports.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.module: imports.append('.'*node.level + node.module)
    return {'path': filename, 'symbols': symbols[:3000], 'references': references[:30000],
            'imports': imports[:300], 'parseError': None}


def main():
    data = json.load(sys.stdin)
    print(json.dumps({'files': [index_file(x) for x in data.get('files', [])][:500]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
