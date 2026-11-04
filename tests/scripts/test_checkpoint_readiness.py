"""Synthetic checkpoint readiness tests; no credentials, network or trainer calls."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/glimmer/checkpoint-readiness.py"
spec = importlib.util.spec_from_file_location("readiness", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n")


class Readiness(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Path(self.temp.name)
        self.run = self.store / "runs/loupe-1.1"
        self.input = self.store / "input.jsonl"
        self.input.write_bytes(b'{}\n' * 32)
        self.digest = m.sha(self.input.read_bytes())
        self.owner = {"account": "fiction", "session": "ts-first", "run": "run-first", "checkpoints_before": []}
        self.resource = "accounts/fiction/trainingSessions/ts-first"
        self.saved = {**self.owner, "sessions": [self.owner]}
        write(self.run / "serverless.json", self.saved)
        write(self.run / "cookbook/dataloader.json", {"checkpoints": {"step-2": {"step": 2, "data_consumed": 32}}})
        write(self.run / "selection.json", {"file_sha": self.digest, "dataset_sha": self.digest, "lines": 32})
        self.audit_path = self.store / "runs/audits/verified.json"
        self.audit = {"schema_version": 1, "run": str(self.run), "version": "1.1", "status": "verified", "issues": [], "comparison_ready": True, "trainer_input_matches_selection": True, "files": {"trainer-input": {"sha256": self.digest}, "1.1/train.jsonl": {"sha256": self.digest, "lines": 32}, "selection": {"sha256": m.sha((self.run / "selection.json").read_bytes())}}}
        write(self.audit_path, self.audit)
        self.row = {"name": self.resource + "/checkpoints/run-first-step-2-abc", "promotable": True}
        self.listings = {self.resource: [self.row]}

    def inspect(self, listing=None):
        return m.inspect(self.run, self.input, self.audit_path, listing or (lambda _: self.listings))

    def refused(self, state, operation=None):
        with self.assertRaises(m.Refused) as context:
            (operation or self.inspect)()
        self.assertEqual(context.exception.state, state)

    def test_success_and_absent_only_receipt_leave_inputs_unchanged(self):
        before = {p: p.read_bytes() for p in self.store.rglob('*') if p.is_file()}
        report = self.inspect()
        self.assertEqual(report['candidate']['name'], self.row['name'])
        self.assertEqual(report['candidate']['examples_consumed'], 32)
        self.assertFalse(report['paid_comparison_ready'])
        target = self.store / 'runs/checkpoint-readiness/first.json'
        m.publish(target, report, self.store)
        self.assertEqual(json.loads(target.read_text()), report)
        for p, value in before.items():
            self.assertEqual(p.read_bytes(), value)
        with self.assertRaises(FileExistsError):
            m.publish(target, {}, self.store)

    def test_earlier_resumed_session_keeps_ownership(self):
        second = {'account': 'fiction', 'session': 'ts-second', 'run': 'run-second', 'checkpoints_before': ['step-2']}
        write(self.run / 'serverless.json', {**second, 'sessions': [self.owner, second]})
        self.listings['accounts/fiction/trainingSessions/ts-second'] = []
        report = self.inspect()
        self.assertEqual(report['candidate']['session'], self.resource)
        target = self.store / 'runs/checkpoint-readiness/resumed.json'
        m.publish(target, report, self.store)
        self.assertEqual(json.loads(target.read_text())['candidate']['examples_consumed'], 32)

    def test_available_but_incomplete_preserves_all_blockers(self):
        self.audit.update(status='incomplete', comparison_ready=False, issues=[{'code': 'missing_freeze', 'kind': 'incomplete', 'artifact': '1.1'}])
        write(self.audit_path, self.audit)
        report = self.inspect()
        self.assertEqual(report['status'], 'available')
        self.assertEqual(report['audit_blockers'], self.audit['issues'])
        self.assertFalse(report['comparison_evidence_ready'])
        self.assertFalse(report['paid_comparison_ready'])

    def test_successful_empty_listing_is_confirmed_absence(self):
        self.listings[self.resource] = []
        self.assertEqual(self.inspect()['status'], 'confirmed_absent')

    def test_resume_only_does_not_become_promotable(self):
        self.row['promotable'] = False
        self.assertIsNone(self.inspect()['candidate'])

    def test_missing_explicit_promotability_is_not_absence(self):
        self.row.pop('promotable')
        self.refused('malformed_provider_response')

    def test_provider_only_checkpoint_refuses(self):
        self.row['name'] = self.resource + '/checkpoints/run-first-step-4-abc'
        self.refused('checkpoint_ownership_unproven')

    def test_foreign_resource_refuses(self):
        self.row['name'] = self.row['name'].replace('ts-first', 'ts-other')
        self.refused('ambiguous_or_foreign_checkpoint')

    def test_duplicate_identity_refuses(self):
        self.listings[self.resource].append(dict(self.row))
        self.refused('ambiguous_or_foreign_checkpoint')

    def test_same_step_multiple_promotable_candidates_refuse(self):
        self.listings[self.resource].append({**self.row, 'name': self.row['name'] + 'def'})
        self.refused('ambiguous_checkpoint')

    def test_consumed_more_than_input_refuses(self):
        write(self.run / 'cookbook/dataloader.json', {'checkpoints': {'step-2': {'step': 2, 'data_consumed': 33}}})
        self.refused('invalid_local_checkpoints')

    def test_input_change_refuses(self):
        self.input.write_bytes(b'changed')
        self.refused('invalid_input_binding')

    def test_changed_selection_metadata_refuses(self):
        path = self.run / 'selection.json'
        saved = json.loads(path.read_text())
        saved['seed'] = 42
        write(path, saved)
        self.refused('invalid_input_binding')

    def test_retry_after_is_preserved(self):
        response = mock.Mock(status_code=429, headers={'Retry-After': '600'})
        with self.assertRaises(m.Refused) as context:
            m.provider_page(response)
        self.assertEqual(context.exception.retry_after_seconds, 600)

    def test_missing_audit_refuses(self):
        self.audit_path.unlink()
        self.refused('missing_or_malformed_evidence')

    def test_discovery_exception_never_reports_absence(self):
        def listing(_):
            raise m.Refused('provider_timeout', 'lane_backoff', 2)
        self.refused('provider_timeout', lambda: self.inspect(listing))

    def test_concurrent_trainer_update_refuses(self):
        for name in ('serverless.json', 'cookbook/dataloader.json'):
            with self.subTest(name=name):
                path = self.run / name
                original = path.read_bytes()
                def listing(_):
                    path.write_bytes(original + b' ')
                    return self.listings
                self.refused('concurrent_change', lambda: self.inspect(listing))
                path.write_bytes(original)

    def test_provider_http_states_are_distinct(self):
        for code, state in ((401, 'permission_denied'), (403, 'permission_denied'), (429, 'provider_transient'), (503, 'provider_transient'), (400, 'provider_request_refused')):
            with self.subTest(code=code):
                response = mock.Mock(status_code=code)
                self.refused(state, lambda: m.provider_page(response))

    def test_malformed_provider_page_is_not_empty_success(self):
        for payload in ({}, None, {'checkpoints': 'bad'}, {'checkpoints': [], 'nextPageToken': 42}):
            response = mock.Mock(status_code=200)
            response.json.return_value = payload
            self.refused('malformed_provider_response', lambda: m.provider_page(response))
        response.json.return_value = {'checkpoints': []}
        self.assertEqual(m.provider_page(response), ([], ''))

    def test_credentials_failure_is_sanitized(self):
        with mock.patch.object(m.subprocess, 'check_output', side_effect=OSError('private error')):
            self.refused('credentials_unavailable', m.credential)

    def test_concurrent_publication_has_one_winner(self):
        target = self.store / 'runs/checkpoint-readiness/race.json'
        def publish(_):
            try:
                m.publish(target, {'status': 'available'}, self.store)
                return True
            except FileExistsError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(pool.map(publish, range(2))), 1)

    def test_receipt_outside_store_refuses(self):
        self.refused('invalid_receipt_destination', lambda: m.publish(self.store/'elsewhere.json', {}, self.store))

    def test_cli_snapshot_success_has_readable_identity_receipt(self):
        listing = self.store / 'provider.json'
        write(listing, self.listings)
        target = self.store / 'runs/checkpoint-readiness/cli.json'
        with mock.patch('builtins.print'):
            code = m.main(['--store', str(self.store), '--run', str(self.run), '--trainer-input', str(self.input), '--audit', str(self.audit_path), '--provider-list', str(listing), '--receipt', str(target)])
        self.assertEqual(code, 0)
        report = json.loads(target.read_text())
        self.assertEqual(report['candidate']['name'], self.row['name'])
        self.assertEqual(report['observation'], 'supplied_snapshot')
        self.assertFalse(report['paid_comparison_ready'])
        self.assertEqual(report['sources']['provider_snapshot'], m.sha(listing.read_bytes()))

    def test_cli_failure_does_not_emit_private_provider_exception(self):
        with mock.patch.object(m, 'live_listing', side_effect=m.Refused('provider_timeout', 'lane_backoff', 2)), mock.patch('builtins.print') as printer:
            code = m.main(['--run', str(self.run), '--trainer-input', str(self.input), '--audit', str(self.audit_path), '--live'])
        self.assertEqual(code, 2)
        report = json.loads(printer.call_args.args[0])
        self.assertEqual(report['status'], 'provider_timeout')
        self.assertIsNone(report['candidate'])
