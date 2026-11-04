import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('health', Path(__file__).resolve().parents[2] / 'scripts/codex_lane_health.py')
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'codex-continuation').mkdir()
        self.now = 2000000000
        self.state = dict(lane='checks', session='session', phase='active', updated_at=self.now - 5,
                          observed={'PreToolUse': self.now - 5}, last_ack={'at': self.now - 9})
        self.write_state()
        self.outbox('Resume 2033-05-18T03:33:20Z\nWAITING: none\n')

    def write_state(self):
        (self.root / 'codex-continuation/checks.json').write_text(json.dumps(self.state))

    def outbox(self, value):
        (self.root / 'checks-outbox.md').write_text(value)

    def snapshot(self, native=None):
        return health.snapshot(self.root, ['checks'], self.now,
                               native or (lambda _: {'status': {'type': 'active'}, 'updatedAt': self.now - 3}))

    def test_current_active(self):
        row = self.snapshot()['lanes'][0]
        self.assertEqual(row['classification'], 'active')
        self.assertEqual(row['native_status'], 'active')
        self.assertEqual(row['progress']['hook_at'], self.now - 5)

    def test_pause_wins_over_native_and_time(self):
        self.state['phase'] = 'paused'; self.write_state()
        self.outbox('WAITING: time: 2000-01-01T00:00:00Z\n')
        self.assertEqual(self.snapshot()['lanes'][0]['classification'], 'paused')

    def test_future_and_elapsed_time_not_failed(self):
        self.outbox('WAITING: time: 2099-01-01T00:00:00Z\n')
        native = lambda _: {'status': {'type': 'idle'}}
        self.assertEqual(self.snapshot(native)['lanes'][0]['classification'], 'time_wait')
        self.outbox('WAITING: time: 2000-01-01T00:00:00Z\n')
        self.assertEqual(self.snapshot(native)['lanes'][0]['classification'], 'time_wait_elapsed')

    def test_exact_ack_not_prefix_and_no_body_disclosure(self):
        (self.root / 'checks-inbox.md').write_text('URGENT item 2033-05-18T03:00:00Z: PRIVATE BODY\n')
        self.outbox('ACK item-extra: irrelevant\nWAITING: none\n')
        row = self.snapshot()['lanes'][0]
        self.assertEqual(row['unacknowledged'][0]['id'], 'item')
        self.assertNotIn('PRIVATE BODY', json.dumps(row))
        self.outbox('ACK item: accepted\nWAITING: none\n')
        self.assertEqual(self.snapshot()['lanes'][0]['unacknowledged'], [])

    def test_native_failure_is_unknown_not_lane_failed(self):
        def fail(_): raise TimeoutError('PRIVATE ERROR')
        result = self.snapshot(fail)
        self.assertEqual(result['lanes'][0]['classification'], 'unknown')
        self.assertTrue(result['errors'])
        self.assertNotIn('PRIVATE ERROR', json.dumps(result))

    def test_active_and_idle_different_staleness(self):
        self.state.update(updated_at=self.now - 1200, observed={}); self.write_state()
        self.assertFalse(self.snapshot(lambda _: {'status': {'type': 'active'}})['lanes'][0]['stale_observation'])
        self.assertTrue(self.snapshot(lambda _: {'status': {'type': 'idle'}})['lanes'][0]['stale_observation'])

    def test_invalid_registry_and_missing_owner_remain_visible(self):
        (self.root / 'codex-continuation/checks.json').write_text('{')
        result = self.snapshot()
        self.assertEqual(result['lanes'][0]['classification'], 'unknown')
        self.assertTrue(result['errors'])
        (self.root / 'codex-continuation/checks.json').unlink()
        self.assertEqual(self.snapshot()['lanes'][0]['classification'], 'unregistered')

    def test_blocked_owner_not_stale_or_complete(self):
        self.state.update(updated_at=self.now - 9000, observed={}); self.write_state()
        self.outbox('WAITING: coordinator gate for D07 T09 §2\n')
        row = self.snapshot(lambda _: {'status': {'type': 'idle'}})['lanes'][0]
        self.assertEqual(row['classification'], 'blocked')
        self.assertFalse(row['stale_observation'])
        self.assertIn('not inferred', row['release_evidence'])

    def test_structured_coordinator_request_ack(self):
        (self.root / 'coordinator-inbox.md').write_text('REQUEST decision-1 2033-05-18T03:00:00Z: PRIVATE REQUEST\n')
        result = self.snapshot()
        self.assertEqual(result['coordinator_unacknowledged'][0]['id'], 'decision-1')
        self.assertNotIn('PRIVATE REQUEST', json.dumps(result))
        (self.root / 'coordinator-outbox.md').write_text('ACK decision-1: recorded\n')
        self.assertEqual(self.snapshot()['coordinator_unacknowledged'], [])

    def test_owner_outside_lane_map_is_included(self):
        other = dict(self.state, lane='access')
        (self.root / 'codex-continuation/access.json').write_text(json.dumps(other))
        self.assertEqual([row['lane'] for row in self.snapshot()['lanes']], ['access', 'checks'])

    def test_output_pair_and_narrative_request_unknown(self):
        (self.root / 'coordinator-inbox.md').write_text('Please decide something without an id\n')
        result = self.snapshot()
        health.publish(self.root, result)
        self.assertEqual(json.loads((self.root / 'lane-health.json').read_text()), result)
        self.assertIn('checks: active', (self.root / 'lane-health.txt').read_text())
        self.assertIn('not inferred', result['request_detection_limit'])


if __name__ == '__main__':
    unittest.main()
