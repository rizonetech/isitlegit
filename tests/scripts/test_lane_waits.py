"""Tests for scripts/lane_waits.py (D00 T01 section 33)."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "lane_waits.py"


class LaneWaits(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.handover = root / "handover"
        self.handover.mkdir()
        (root / "lanes.json").write_text(
            json.dumps({"lanes": {"app": {}, "console": {}, "site": {}, "eval": {}}}), encoding="utf-8"
        )
        self.plan = root / "plan.md"
        self.plan.write_text(
            "| D07 T04 section 28 | [x] |\n| D07 T03 section 25 | [ ] |\n", encoding="utf-8"
        )
        for lane in ("app", "console", "site", "eval"):
            (self.handover / f"{lane}-outbox.md").write_text("WAITING: none\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_waits(self, now: str = "2026-11-01T18:00:00+00:00") -> dict:
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--handover-dir",
                str(self.handover),
                "--plan",
                str(self.plan),
                "--lanes",
                str(Path(self.tmp.name) / "lanes.json"),
                "--now",
                now,
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def outbox(self, lane: str, text: str) -> None:
        (self.handover / f"{lane}-outbox.md").write_text(text, encoding="utf-8")

    def test_a_cleared_stamp_wait_is_notified_once(self) -> None:
        self.outbox("app", "Parked.\n\nWAITING: stamp D07 T04 section 28 on main\n")
        result = self.run_waits()
        self.assertEqual([n["lane"] for n in result["notify"]], ["app"])
        (self.handover / "app-inbox.md").write_text(
            "notified: stamp D07 T04 section 28 on main\n", encoding="utf-8"
        )
        result = self.run_waits()
        self.assertEqual(result["notify"], [])
        self.assertEqual([w["lane"] for w in result["waiting"]], ["app"])

    def test_an_uncleared_wait_is_left_alone(self) -> None:
        self.outbox("console", "WAITING: stamp D07 T03 section 25 on main\n")
        result = self.run_waits()
        self.assertEqual(result["notify"], [])
        self.assertEqual([w["lane"] for w in result["waiting"]], ["console"])

    def test_a_time_wait_clears_only_after_its_time(self) -> None:
        self.outbox("eval", "WAITING: time: 2026-11-02T00:07:00+02:00\n")
        self.assertEqual(self.run_waits()["notify"], [])
        result = self.run_waits(now="2026-11-02T01:00:00+00:00")
        self.assertEqual([n["lane"] for n in result["notify"]], ["eval"])

    def test_a_lane_with_no_waiting_line_is_unknown(self) -> None:
        self.outbox("site", "Parked, see the run file.\n")
        result = self.run_waits()
        self.assertEqual([u["lane"] for u in result["unknown"]], ["site"])

    def inbox(self, lane: str, text: str) -> None:
        (self.handover / f"{lane}-inbox.md").write_text(text, encoding="utf-8")

    def test_an_unacknowledged_urgent_message_is_reported_with_its_age(self) -> None:
        self.inbox("loupe", "- URGENT U-loupe-1 2026-11-01T17:55:00+00:00: stop and read this now\n")
        # The fixture lanes file names only app, console, site and eval; loupe rides the same scan.
        result = self.run_waits(now="2026-11-01T18:00:00+00:00")
        urgent = [u for u in result.get("urgent", []) if u["lane"] == "loupe"]
        self.assertEqual(len(urgent), 1)
        self.assertEqual(urgent[0]["id"], "U-loupe-1")
        self.assertEqual(urgent[0]["age_minutes"], 5)
        self.assertFalse(urgent[0]["escalate"])

    def test_an_acknowledged_urgent_message_is_not_reported(self) -> None:
        self.inbox("app", "- URGENT U-app-1 2026-11-01T17:55:00+00:00: read this now\n")
        self.outbox("app", "Working.\nACK U-app-1: read\nWAITING: none\n")
        result = self.run_waits()
        self.assertEqual([u for u in result.get("urgent", []) if u["lane"] == "app"], [])

    def test_a_lane_with_no_heartbeat_record_is_listed(self) -> None:
        (self.handover / "app-outbox.md").write_text(
            "lane heartbeat installed: abc123\nWAITING: none\n", encoding="utf-8"
        )
        result = self.run_waits()
        self.assertNotIn("app", result["heartbeat_missing"])
        self.assertIn("console", result["heartbeat_missing"])

    def test_an_urgent_message_older_than_ten_minutes_escalates(self) -> None:
        self.inbox("app", "- URGENT U-app-2 2026-11-01T17:40:00+00:00: read this now\n")
        result = self.run_waits(now="2026-11-01T18:00:00+00:00")
        urgent = [u for u in result["urgent"] if u["lane"] == "app"]
        self.assertEqual(len(urgent), 1)
        self.assertEqual(urgent[0]["age_minutes"], 20)
        self.assertTrue(urgent[0]["escalate"])


if __name__ == "__main__":
    unittest.main()
