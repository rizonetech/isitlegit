"""Explicit operator withdrawals stay visible without becoming delivered prerequisites."""
import json
import shutil
import subprocess
import sys
import unittest
from tests.scripts import test_todo_graph as fixtures


tg = fixtures.tg
MARKER = '**Withdrawn:** 2026-11-04 | operator | Submission no longer requires this work.'


class Withdrawal(unittest.TestCase):
    setUp = fixtures.Tree.setUp
    write = fixtures.Tree.write
    index = fixtures.Tree.index

    def document(self, marker=MARKER, needs='none'):
        text = fixtures.todo_file([(1, 'Old work', 0, needs, '--'),
                                   (2, 'Dependent', 0, 'none', '§1'),
                                   (3, 'Transitive', 0, 'none', '§2'),
                                   (4, 'Independent', 0, 'none', '--')])
        return text.replace('## 1. Old work\n', '## 1. Old work\n\n' + marker + '\n')

    def test_parse_preserves_unverified_contract_and_history(self):
        text = self.document()
        self.write(text)
        rows = tg.graph(self.root)
        row = rows['D00 T01 §1']
        self.assertEqual(row.withdrawn, {'date': '2026-11-04', 'authority': 'operator',
                                       'reason': 'Submission no longer requires this work.'})
        self.assertFalse(row.done)
        self.assertEqual(row.receipt, '')
        self.assertIn('- [ ] Work.', row.body)
        self.assertEqual(row.public()['withdrawn'], row.withdrawn)
        self.assertEqual((self.root / row.path).read_text(), text)

    def test_strict_marker_rejects_malformed_duplicate_and_invalid_dates(self):
        for marker in [MARKER + '\n' + MARKER, MARKER.replace('2026-11-04', '2026-02-30'),
                       MARKER.replace('operator', 'coordinator'), MARKER.split(' | ')[0] + ' | operator | ',
                       '> ' + MARKER, ' ' + MARKER, MARKER + ' | more',
                       MARKER.replace('2026-11-04', '26-11-04')]:
            with self.subTest(marker=marker):
                self.write(self.document(marker))
                with self.assertRaisesRegex(tg.Refused, 'Withdrawn'):
                    tg.graph(self.root)

    def test_nested_quotes_and_list_prefixes_cannot_hide_metadata(self):
        for prefix in ('> > ', '>> ', '- ', '* ', '1. ', '1) '):
            for marker in (prefix + MARKER, MARKER + '\n' + prefix + MARKER):
                with self.subTest(marker=marker):
                    self.write(self.document(marker))
                    with self.assertRaisesRegex(tg.Refused, 'Withdrawn'):
                        tg.graph(self.root)

    def test_task_list_prefixes_refuse_malformed_and_concealed_duplicate_fields(self):
        for prefix in ('- [ ] ', '- [x] ', '- [X] ', '> - [ ] ', '1. [ ] ', '- [?] '):
            for body in (prefix + MARKER, MARKER + '\n' + prefix + MARKER):
                with self.subTest(body=body), self.assertRaisesRegex(tg.Refused, 'Withdrawn'):
                    tg.withdrawal(body)

    def test_fenced_examples_do_not_withdraw_or_count_as_duplicate_fields(self):
        examples = ('```markdown\n' + MARKER + '\n```',
                    '~~~~ markdown\n' + MARKER + '\n~~~~',
                    '````markdown\n```\n' + MARKER + '\n````',
                    '   ```markdown\n' + MARKER + '\n   ```')
        for example in examples:
            with self.subTest(example=example):
                self.write(self.document(example))
                rows = tg.graph(self.root)
                self.assertEqual(tg.disposition(rows['D00 T01 §1'], rows), 0)
                self.write(self.document(example + '\n' + MARKER))
                rows = tg.graph(self.root)
                self.assertEqual(tg.disposition(rows['D00 T01 §1'], rows), 5)

    def test_ordinary_prose_does_not_withdraw_and_removal_restores_unmet_work(self):
        self.write(self.document('The operator withdrew this idea in conversation.'))
        rows = tg.graph(self.root)
        self.assertEqual(tg.disposition(rows['D00 T01 §1'], rows), 0)
        self.assertNotIn('withdrawn', rows['D00 T01 §1'].public())
        self.write(self.document().replace(MARKER, ''))
        rows = tg.graph(self.root)
        self.assertEqual(tg.disposition(rows['D00 T01 §1'], rows), 0)
        self.assertEqual(tg.disposition(rows['D00 T01 §2'], rows), 4)

    def test_queues_counts_and_dependency_chain(self):
        self.write(self.document(needs='operator'))
        rows = tg.graph(self.root)
        self.assertEqual([tg.disposition(r, rows) for r in tg.ordered(rows)], [5, 4, 4, 0])
        self.assertFalse(tg.settled('D00 T01 §1', rows))
        self.assertFalse(tg.settled('D00 T01 §3', rows))
        self.assertEqual(tg.manual_rows(rows, {}), [])
        self.assertEqual([r['ref'] for r in tg.lane_query('ready', rows, {}, 'main')], ['D00 T01 §4'])
        self.assertEqual([r['ref'] for r in tg.lane_query('blocked', rows, {}, 'main')],
                         ['D00 T01 §2', 'D00 T01 §3'])
        self.assertEqual(tg.lane_query('stats', rows, {}, 'main'),
                         {'lane': 'main', 'total': 3, 'verified': 0, 'ready': 1, 'blocked': 2, 'withdrawn': 1})

    def test_projection_retains_reason_and_excludes_withdrawn_checklist(self):
        self.write(self.document())
        output = tg.projection(self.root)
        self.assertIn('Withdrawn', output)
        self.assertIn('2026-11-04', output)
        self.assertIn('Submission no longer requires this work.', output)
        self.assertIn('0/3 verified sections', output)
        self.assertIn('Checklist: 0/6 items completed', output)
        self.assertIn('Withdrawn: 1', output)
        row = next(line for line in output.splitlines() if '| D00 T01 §1 ' in line)
        self.assertNotIn('[ ]', row)
        self.assertNotIn('[x]', row)

    def test_stamp_refuses_without_writes_and_never_satisfies_dependency(self):
        self.write(self.document())
        history = self.root / 'docs/reviews/historical.md'
        history.parent.mkdir(parents=True)
        history.write_bytes(b'Original failed review remains unchanged.\n')
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        for ref, reason in [('D00 T01 §1', 'withdrawn'), ('D00 T01 §2', 'prerequisite'),
                            ('D00 T01 §3', 'prerequisite')]:
            with self.subTest(ref=ref), self.assertRaisesRegex(tg.Refused, reason):
                tg.stamp(self.root, ref, 'a' * 40, [], [], '2026-11-04')
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_stamped_marker_and_fabricated_receipt_are_refused(self):
        self.write(self.document().replace('| -- | [ ] |', '| -- | [x] |', 1))
        with self.assertRaisesRegex(tg.Refused, 'Withdrawn'):
            tg.graph(self.root)
        self.write(self.document(MARKER + '\n**Review:** `docs/reviews/fake.json`'))
        with self.assertRaisesRegex(tg.Refused, 'checkbox/stamp/receipt mismatch'):
            tg.graph(self.root)

    def test_cli_plan_resolve_classify_and_active_queries(self):
        self.write(self.document())
        shutil.copytree(fixtures.SCRIPTS, self.root / 'scripts', ignore=shutil.ignore_patterns('__pycache__'))
        def command(*args):
            return subprocess.run([sys.executable, str(self.root / 'scripts/todo-graph.py'), *args],
                                  capture_output=True, text=True, encoding='utf-8')
        plan = command('query', 'plan')
        self.assertEqual(plan.returncode, 0, plan.stderr)
        row = json.loads(plan.stdout)['sections'][0]
        self.assertEqual(row['status'], 'withdrawn')
        self.assertEqual(row['withdrawn']['authority'], 'operator')
        resolved = command('resolve', 'D00 T01 §1')
        self.assertEqual(resolved.returncode, 5, resolved.stderr)
        self.assertEqual(json.loads(resolved.stdout)['exit'], 5)
        self.assertEqual(json.loads(command('classify', 'D00 T01 §1').stdout), {'D00 T01 §1': 5})
        self.assertEqual(json.loads(command('query', 'stats').stdout)['withdrawn'], 1)


if __name__ == '__main__':
    unittest.main()
