"""Complete module-suite partitioning, preserving unittest's own fixture lifecycle."""
import collections
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/ci_unittest_shard.py'


def runner():
    spec = importlib.util.spec_from_file_location('ci_shard_under_test', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Sharding(unittest.TestCase):
    def test_multiset_is_complete_disjoint_and_deterministic_with_duplicate_ids(self):
        m = runner()
        class Case(unittest.TestCase):
            def test_ok(self): pass
        def suite():
            return unittest.TestSuite(unittest.TestSuite(Case('test_ok') for _ in range(n)) for n in (9, 2, 7, 1, 5))
        groups = m.partition(suite(), 4)
        self.assertEqual(collections.Counter(x for g in groups for x in m.test_ids(g)),
                         collections.Counter(m.test_ids(suite())))
        self.assertEqual([m.test_ids(g) for g in groups], [m.test_ids(g) for g in m.partition(suite(), 4)])
        self.assertEqual(sum(len(g._tests) for g in groups), 5)
        for count in (0, -1):
            with self.assertRaises(ValueError): m.partition(suite(), count)

    def test_real_module_class_fixtures_skips_and_failure_exit(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root/'test_lifecycle.py').write_text('''import unittest
from pathlib import Path
LOG=Path(__file__).with_name('events')
def emit(value):
    with LOG.open('a') as f: f.write(value+'\\n')
def setUpModule(): emit('module-up')
def tearDownModule(): emit('module-down')
class Example(unittest.TestCase):
    @classmethod
    def setUpClass(cls): emit('class-up')
    @classmethod
    def tearDownClass(cls): emit('class-down')
    def test_a(self): emit('a')
    def test_b(self): emit('b')
    @unittest.skip('expected')
    def test_c(self): pass
''')
            listings = [self.invoke(root, i, '--list') for i in range(1, 5)]
            self.assertTrue(all(p.returncode == 0 for p in listings), [p.stderr for p in listings])
            docs = [json.loads(p.stdout) for p in listings]
            self.assertEqual(sum(len(p['tests']) for p in docs), 3)
            self.assertFalse((root/'events').exists(), 'collection must not execute fixture/test code')
            for i in range(1, 5):
                p = self.invoke(root, i)
                self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual((root/'events').read_text().splitlines(), ['module-up','class-up','a','b','class-down','module-down'])
            (root/'test_failure.py').write_text('import unittest\nclass Failure(unittest.TestCase):\n def test_failure(self): self.fail("real failure")\n')
            results = [self.invoke(root, i) for i in range(1,5)]
            self.assertEqual(sum(p.returncode != 0 for p in results), 1)
            self.assertTrue(any('real failure' in p.stderr for p in results))
            (root/'test_setup.py').write_text('import unittest\ndef setUpModule(): raise RuntimeError("fixture failure")\nclass Case(unittest.TestCase):\n def test_a(self): pass\n')
            self.assertTrue(any('fixture failure' in self.invoke(root,i).stderr for i in range(1,5)))

    def invoke(self, root, shard, *extra):
        return subprocess.run([sys.executable, str(SCRIPT), '--start', str(root), '--shard', str(shard), '--shards','4',*extra], text=True,capture_output=True)

    def test_invalid_arguments_and_import_errors_fail_even_in_collection(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/'test_broken.py').write_text('raise ImportError("broken discovery")\n')
            for i in range(1,5):
                p=self.invoke(root,i,'--list')
                self.assertNotEqual(p.returncode,0)
                self.assertIn('broken discovery',p.stderr)
            for i in (0,5): self.assertNotEqual(self.invoke(root,i).returncode,0)

    def test_empty_discovery_refuses_but_empty_partition_is_success(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertNotEqual(self.invoke(Path(d),1,'--list').returncode,0)

    def test_repo_root_imports_match_module_unittest_invocation(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'helpers.py').write_text('VALUE = 7\n')
            folder = root / 'suite'
            folder.mkdir()
            (folder / 'test_import.py').write_text('import unittest\nfrom helpers import VALUE\nclass Case(unittest.TestCase):\n def test_value(self): self.assertEqual(VALUE,7)\n')
            done = subprocess.run([sys.executable, str(SCRIPT), '--start', str(folder), '--shard', '1', '--shards', '1'], cwd=root, text=True, capture_output=True)
            self.assertEqual(done.returncode, 0, done.stderr)
