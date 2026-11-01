"""scripts/forward-probe.py's pairing and percentile (D01 T02 §14), without mail, vault, network or production."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("forward_probe", ROOT / "scripts" / "forward-probe.py")
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)

T0 = datetime.datetime(2026, 11, 1, 1, 0, tzinfo=datetime.UTC)


def at(minutes):
    return T0 + datetime.timedelta(minutes=minutes)


def key(n):
    return hashlib.sha256(f"incident {n}".encode()).hexdigest()


def probes(count):
    return [{"n": i, "subject": f"ILPROBE-7Q4K9X probe {i} of {count} 20261101T0100Z", "sent": fp.iso(at(i))}
            for i in range(1, count + 1)]


def incident(p, n, notices=1, kind="refused", minutes=None):
    return {"key": key(n), "subject_hash": fp.subject_hash(p["subject"]), "kind": kind, "state": "open", "alert": "sent",
            "occurred_at": fp.iso(at(p["n"] if minutes is None else minutes)), "detected_at": fp.iso(at(p["n"] + 5)),
            "notices": notices}


def alert(n, minutes, status="sent", email_id=None, delivered=None):
    events = {"processed": at(minutes)}
    if delivered is not None:
        events["delivered"] = at(delivered)
    return ({"send_key": f"forward-failure:{key(n)}:1", "status": status, "provider_id": email_id or f"mail-{n}",
             "updated_at": fp.iso(at(minutes))}, {email_id or f"mail-{n}": events})


class SubjectHash(unittest.TestCase):
    def test_is_the_workers_subject_key(self):
        # Without a report's prefix, trimmed and lower-cased, as `subjectKey` in src/mail/forwarding.ts reads it.
        plain = fp.subject_hash("ILPROBE-7Q4K9X probe 1")
        self.assertEqual(plain, hashlib.sha256(b"ilprobe-7q4k9x probe 1").hexdigest())
        for prefixed in ("Undeliverable: ILPROBE-7Q4K9X probe 1", "  undelivered mail returned to sender : ILPROBE-7Q4K9X probe 1 "):
            self.assertEqual(fp.subject_hash(prefixed), plain)


class Evaluate(unittest.TestCase):
    def run_all(self, ps, incidents, alerts):
        sends = [a for a, _ in alerts]
        sent_at = {}
        for _, at_ in alerts:
            sent_at.update(at_)
        return fp.evaluate(ps, incidents, sends, sent_at)

    def test_each_probe_is_paired_with_its_own_alert_whatever_order_they_were_sent_in(self):
        ps = probes(3)
        incidents = [incident(p, p["n"]) for p in ps]
        # Alerts sent in the opposite order to the refusals: each still belongs to its own incident.
        alerts = [alert(3, 20), alert(2, 21), alert(1, 22)]
        self.run_all(ps, incidents, alerts)
        self.assertEqual([p["seconds"] / 60 for p in ps], [21.0, 19.0, 17.0])
        self.assertTrue(all(not p["problems"] for p in ps))

    def test_an_unrelated_alert_pairs_with_nothing(self):
        ps = probes(1)
        stranger = alert(99, 5)
        self.run_all(ps, [incident(ps[0], 1)], [stranger])
        self.assertIsNone(ps[0]["seconds"])
        self.assertIn("no sent alert for its incident", ps[0]["problems"])

    def test_a_probe_with_no_alert_fails_though_other_alerts_exist(self):
        ps = probes(5)
        incidents = [incident(p, p["n"]) for p in ps]
        alerts = [alert(n, 20 + n) for n in (1, 2, 3, 4)]
        self.run_all(ps, incidents, alerts)
        self.assertEqual([p["seconds"] is None for p in ps], [False, False, False, False, True])

    def test_a_second_incident_for_one_subject_fails_the_probe(self):
        ps = probes(1)
        incidents = [incident(ps[0], 1), incident(ps[0], 2, minutes=3)]
        self.run_all(ps, incidents, [alert(1, 20), alert(2, 22)])
        self.assertIsNone(ps[0]["seconds"])
        self.assertIn("2 incidents for its subject, one expected", ps[0]["problems"])

    def test_several_notices_on_one_incident_count_once(self):
        ps = probes(1)
        self.run_all(ps, [incident(ps[0], 1, notices=3)], [alert(1, 20)])
        self.assertEqual(ps[0]["seconds"], 19 * 60)

    def test_needs_a_notice_a_refused_incident_a_sent_alert_and_smtp2gos_confirmation(self):
        ps = probes(4)
        incidents = [incident(ps[0], 1, notices=0), incident(ps[1], 2, kind="worker"), incident(ps[2], 3), incident(ps[3], 4)]
        alerts = [alert(1, 20), alert(2, 21), alert(3, 22, status="pending"), alert(4, 23)]
        # Probe 4's alert row is sent, but SMTP2GO's activity does not know its email id.
        sends = [a for a, _ in alerts]
        sent_at = {m: t for _, d in alerts[:3] for m, t in d.items()}
        fp.evaluate(ps, incidents, sends, sent_at)
        self.assertEqual([p["seconds"] for p in ps], [None, None, None, None])
        self.assertIn("no refusal notice is held on its incident", ps[0]["problems"])
        self.assertIn("its incident is worker, not refused", ps[1]["problems"])
        self.assertIn("no sent alert for its incident", ps[2]["problems"])
        self.assertIn("SMTP2GO's activity does not confirm the alert's email id", ps[3]["problems"])

    def test_a_probe_with_no_incident_at_all_fails(self):
        ps = probes(1)
        self.run_all(ps, [], [])
        self.assertIn("0 incidents for its subject, one expected", ps[0]["problems"])


    def test_the_send_time_is_the_processed_event_and_delivery_is_kept_apart(self):
        ps = probes(1)
        sends, events = alert(1, 20, delivered=21)
        fp.evaluate(ps, [incident(ps[0], 1)], [sends], events)
        self.assertEqual((ps[0]["alerted"], ps[0]["delivered"]), (fp.iso(at(20)), fp.iso(at(21))))
        # Only a delivery event: the send time is unavailable, never the delivery time under its name.
        only = {"mail-1": {"delivered": at(21)}}
        fp.evaluate(ps, [incident(ps[0], 1)], [sends], only)
        self.assertIsNone(ps[0]["seconds"])
        self.assertIsNone(ps[0]["alerted"])
        self.assertEqual(ps[0]["delivered"], fp.iso(at(21)))
        self.assertIn("SMTP2GO has no processed event for the alert, so its send time is unavailable", ps[0]["problems"])



class Activity(unittest.TestCase):
    def pages(self, *pages):
        calls = []

        def post(key, endpoint, body):
            calls.append(json.loads(body))
            return 200, pages[len(calls) - 1]

        return post, calls

    def event(self, name, email_id, minutes):
        return {"event": name, "email_id": email_id, "date": fp.iso(at(minutes))}

    def test_follows_every_page_so_an_alert_on_page_two_is_found(self):
        post, calls = self.pages(
            {"events": [self.event("processed", "other", 1)], "continue_token": "next"},
            {"events": [self.event("processed", "mail-1", 20), self.event("delivered", "mail-1", 21)]},
        )
        original = fp.smtp2go._post
        fp.smtp2go._post = post
        try:
            found = fp.activity("key", at(0), at(60))
        finally:
            fp.smtp2go._post = original
        self.assertEqual(found["mail-1"], {"processed": at(20), "delivered": at(21)})
        self.assertEqual([c.get("continue_token") for c in calls], [None, "next"])

    def test_a_search_that_never_finishes_is_an_error_not_a_missing_confirmation(self):
        post = lambda key, endpoint, body: (200, {"events": [], "continue_token": "more"})  # noqa: E731
        original = fp.smtp2go._post
        fp.smtp2go._post = post
        try:
            with self.assertRaises(fp.smtp2go.Unreachable):
                fp.activity("key", at(0), at(60))
        finally:
            fp.smtp2go._post = original


class Record(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = pathlib.Path(self.dir) / "run.json"
        self.original = (fp.smtp2go.read_key, fp.smtp2go._post, fp.time.sleep)
        fp.smtp2go.read_key = lambda: "key"
        fp.time.sleep = lambda s: None

    def tearDown(self):
        fp.smtp2go.read_key, fp.smtp2go._post, fp.time.sleep = self.original
        shutil.rmtree(self.dir, ignore_errors=True)

    def args(self, count=2):
        return argparse.Namespace(count=count, spacing=60, record=str(self.path))

    def test_a_run_is_recorded_before_each_send_and_complete_at_the_end(self):
        seen = []

        def post(key, endpoint, body):
            seen.append(json.loads(self.path.read_text()))
            return 200, {"succeeded": 1, "email_id": f"id-{len(seen)}"}

        fp.smtp2go._post = post
        self.assertEqual(fp.send(self.args(2)), 0)
        self.assertEqual([p["status"] for p in seen[1]["probes"]], ["sent", "sending"])
        done = json.loads(self.path.read_text())
        self.assertEqual((done["intended"], done["complete"], [p["status"] for p in done["probes"]]), (2, True, ["sent", "sent"]))

    def test_an_existing_record_is_never_replaced(self):
        self.path.write_text('{"earlier": "evidence"}')
        fp.smtp2go._post = lambda *a: self.fail("sent")
        self.assertEqual(fp.send(self.args()), 2)
        self.assertEqual(json.loads(self.path.read_text()), {"earlier": "evidence"})

    def test_an_unwritable_record_is_found_before_anything_is_sent(self):
        self.path = pathlib.Path(self.dir) / "no" / "such" / "dir" / "run.json"
        os.chmod(self.dir, 0o500)
        try:
            fp.smtp2go._post = lambda *a: self.fail("sent")
            self.assertEqual(fp.send(self.args()), 2)
        finally:
            os.chmod(self.dir, 0o700)

    def test_a_lost_answer_stops_the_run_with_the_probe_uncertain_and_nothing_resent(self):
        calls = []

        def post(key, endpoint, body):
            calls.append(1)
            raise fp.smtp2go.Unreachable("SMTP2GO could not be reached (TimeoutError)")

        fp.smtp2go._post = post
        self.assertEqual(fp.send(self.args(3)), 2)
        record = json.loads(self.path.read_text())
        self.assertEqual(len(calls), 1)
        self.assertEqual((record["complete"], [p["status"] for p in record["probes"]]), (False, ["uncertain"]))

    def test_the_threshold_is_decided_by_read_on_exact_seconds(self):
        # 24:59 passes and 25:00 fails, though the display rounds the first to 25.0.
        ps = probes(1)
        ps[0].update(status="sent", sent=fp.iso(T0))
        record = {"intended": 1, "complete": True, "probes": ps}
        original = (fp.records, fp.activity)
        try:
            for seconds, expected in ((24 * 60 + 59, 0), (25 * 60, 1), (25 * 60 + 1, 1)):
                self.path.write_text(json.dumps(record))
                fp.records = lambda probes_: ([incident(ps[0], 1, minutes=0)], [alert(1, 0)[0]])
                fp.activity = lambda key, start, end, s_=seconds: {"mail-1": {"processed": at(0) + datetime.timedelta(seconds=s_)}}
                self.assertEqual(fp.read(argparse.Namespace(record=str(self.path))), expected, seconds)
        finally:
            fp.records, fp.activity = original

    def test_an_interrupted_or_partial_run_proves_nothing(self):
        for record in (
            {"intended": 5, "complete": False, "probes": [{"n": 1, "subject": "s", "status": "sent", "sent": fp.iso(T0)}]},
            {"intended": 2, "complete": True, "probes": [{"n": 1, "subject": "s", "status": "sent", "sent": fp.iso(T0)}]},
            {"intended": 1, "complete": True, "probes": [{"n": 1, "subject": "s", "status": "uncertain"}]},
            {"probes": [{"n": 1, "subject": "s", "status": "sent", "sent": fp.iso(T0)}]},
        ):
            self.path.write_text(json.dumps(record))
            fp.smtp2go._post = lambda *a: self.fail("asked")
            self.assertEqual(fp.read(argparse.Namespace(record=str(self.path))), 1)


class Percentile(unittest.TestCase):
    def test_nearest_rank_of_five_is_the_slowest(self):
        self.assertEqual(fp.p95([3, 1, 24.9, 2, 5]), 24.9)

    def test_of_twenty_it_is_the_nineteenth(self):
        self.assertEqual(fp.p95(list(range(1, 21))), 19)


class Bounds(unittest.TestCase):
    def test_send_refuses_a_count_or_spacing_out_of_bounds_before_reading_the_key(self):
        for count, spacing in ((0, 60), (11, 60), (5, 30)):
            self.assertEqual(fp.send(argparse.Namespace(count=count, spacing=spacing, record="unused")), 2)

    def test_only_a_select_is_run_against_production(self):
        for sql in ("DELETE FROM forward_incidents", "UPDATE cases SET x = 1", "  insert into x values (1)"):
            with self.assertRaises(fp.smtp2go.Unreachable):
                fp.d1(sql)


if __name__ == "__main__":
    unittest.main()
