"""Check source-level regressions that can otherwise silently disable features."""
import ast
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import unittest


ROOT = Path(__file__).resolve().parents[1]


class _Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.sources = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            src = dict(attrs).get('src')
            if src:
                self.sources.append(src)


class SourceContractTests(unittest.TestCase):
    def test_local_browser_scripts_exist(self):
        parser = _Scripts()
        parser.feed((ROOT / 'public/index.html').read_text(encoding='utf-8'))
        for source in parser.sources:
            parsed = urlsplit(source)
            if parsed.scheme or parsed.netloc:
                continue
            path = ROOT / 'public' / unquote(parsed.path).lstrip('/')
            self.assertTrue(path.is_file(), f'Missing browser script: {source}')

    def test_no_overridden_python_methods(self):
        for path in list(ROOT.glob('*.py')) + list((ROOT / 'tools').glob('*.py')):
            tree = ast.parse(path.read_text(encoding='utf-8-sig'), filename=str(path))
            for scope in ast.walk(tree):
                if not isinstance(scope, (ast.ClassDef, ast.Module)):
                    continue
                methods = {}
                for node in scope.body:
                    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        continue
                    # A property's setter/deleter legitimately has the same name.
                    if any(isinstance(d, ast.Attribute) and d.attr in ('setter', 'deleter')
                           for d in node.decorator_list):
                        continue
                    self.assertNotIn(node.name, methods,
                                     f'{path.name}:{node.lineno}: overrides {node.name}')
                    methods[node.name] = node.lineno

    def test_no_global_hdf5_lock_disable(self):
        for name in ('hdf5_tool.py', 'bin_sync_tool.py'):
            tree = ast.parse((ROOT / 'tools' / name).read_text(encoding='utf-8-sig'))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call) or len(node.args) < 2:
                    continue
                args = node.args
                if isinstance(args[0], ast.Constant) and args[0].value == 'HDF5_USE_FILE_LOCKING':
                    self.assertNotEqual(getattr(args[1], 'value', None), 'FALSE', name)


if __name__ == '__main__':
    unittest.main()
