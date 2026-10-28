"""scripts/glimmer/serverless_probe.py against fakes (D03 T04 §2): the mode follows only from a finite loss or an
explicit unsupported-capability refusal, each file must render as it promises, the token cap and the free-offer cutoff
hold before any session, the session closes on every path, and the receipt keeps every finished pass."""
import importlib.util
import json
import os
import signal
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "serverless_probe.py"
spec = importlib.util.spec_from_file_location("serverless_probe", SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Renderer:
    """Each example renders to one text chunk of 10 tokens and, when it has an image, one image chunk of 100."""

    def build_supervised_example(self, messages, train_on_what=None):
        chunks = [SimpleNamespace(type="encoded_text", tokens=list(range(10)))]
        parts = [p for m in messages if isinstance(m["content"], list) for p in m["content"]]
        if any(p.get("type") == "image" for p in parts):
            chunks.append(SimpleNamespace(type="image", expected_tokens=100))
        return SimpleNamespace(chunks=chunks), [1.0]


def datum(model_input, weights):
    return ("datum", len(model_input.chunks))


class Client:
    def __init__(self, image_error=None, text_error=None, metrics=None, on_call=None):
        self.calls, self.image_error, self.text_error = [], image_error, text_error
        self.metrics = {"loss:sum": 1.5} if metrics is None else metrics
        self.on_call = on_call

    def forward_backward(self, datums, loss):
        self.calls.append((loss, datums))
        if self.on_call:
            self.on_call(len(self.calls))
        has_image = any(chunks == 2 for _, chunks in datums)
        error = self.image_error if has_image else self.text_error
        if error:
            raise RuntimeError(error)
        return SimpleNamespace(result=lambda timeout=None: SimpleNamespace(metrics=self.metrics))


class Service:
    def __init__(self, client=None, fail_client=None, fail_close=None, fail_delete=None):
        self.client, self.fail_client, self.fail_close, self.closed = client or Client(), fail_client, fail_close, False
        self.fail_delete, self.deleted = fail_delete, False
        self.training_session_id = "ts-test"

    def delete_training_session(self):
        self.deleted = True
        if self.fail_delete:
            raise RuntimeError(self.fail_delete)

    def create_lora_training_client(self, base_model, rank):
        if self.fail_client:
            raise RuntimeError(self.fail_client)
        assert base_model == probe.BASE_MODEL
        return self.client

    def close(self):
        self.closed = True
        if self.fail_close:
            raise RuntimeError(self.fail_close)


IMAGE_EXAMPLES = [probe.conversation([
    {"role": "user", "content": [{"type": "text", "text": "q"},
                                 {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]},
    {"role": "assistant", "content": "a"},
])] * 3
TEXT_EXAMPLES = [[{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]] * 3


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="serverless-probe-"))
        self.addCleanup(lambda: [p.unlink() for p in self.dir.glob("*")] and self.dir.rmdir())
        self.receipt = self.dir / "receipt.json"

    def run_probe(self, service, image=IMAGE_EXAMPLES, text=TEXT_EXAMPLES, cap=probe.TOKEN_CAP):
        return probe.run(lambda: service, Renderer(), image, text, "last", datum_type=datum, cap=cap,
                         receipt_path=self.receipt, say=lambda _line: None)

    def saved(self):
        return json.loads(self.receipt.read_text())


class Mode(Base):
    def test_image_parts_become_the_renderers_image_parts(self):
        user = IMAGE_EXAMPLES[0][0]["content"]
        self.assertEqual(user[1], {"type": "image", "image": "data:image/png;base64,AAAA"})

    def test_a_finite_loss_on_the_image_step_means_image_mode(self):
        service = Service()
        result = self.run_probe(service)
        self.assertEqual(result["mode"], "image")
        self.assertEqual(result["image"]["loss"], 1.5)
        self.assertEqual([loss for loss, _ in service.client.calls], ["cross_entropy", "cross_entropy"])
        self.assertEqual((result["image_tokens"], result["text_tokens"], result["tokens"]), (330, 30, 360))
        self.assertTrue(service.closed)
        self.assertEqual(self.saved()["mode"], "image")

    def test_no_finite_loss_decides_nothing(self):
        for metrics in ({}, {"loss:sum": None}, {"loss:sum": float("nan")}, {"loss:sum": float("inf")},
                        {"loss:sum": "1.5"}, {"loss:sum": True}):
            result = self.run_probe(Service(Client(metrics=metrics)))
            self.assertIsNone(result["mode"], metrics)
            self.assertIn("no finite loss:sum", result["image"]["error"])

    def test_only_an_explicit_unsupported_refusal_means_text_only(self):
        explicit = Client(image_error="ImageChunk inputs are not supported for this model")
        self.assertEqual(self.run_probe(Service(explicit))["mode"], "text-only")
        text_ok = Client()
        text_ok.image_error = "vision input is disabled for this base model"
        self.assertEqual(self.run_probe(Service(text_ok))["mode"], "text-only")

    def test_decode_errors_outages_input_limits_and_other_failures_decide_nothing(self):
        for error in ("Image decode failed: invalid PNG", "image service temporarily unavailable", "quota exceeded",
                      "Unsupported image format: only JPEG is accepted", "Image resolution is not supported",
                      "images larger than 4096 tokens are not supported"):
            self.assertIsNone(self.run_probe(Service(Client(image_error=error)))["mode"], error)
        both = Client(image_error="image inputs not supported", text_error="session expired")
        self.assertIsNone(self.run_probe(Service(both))["mode"])


class Inputs(Base):
    def test_a_text_file_cannot_pass_as_the_image_proof(self):
        opened = []
        with self.assertRaises(probe.Refused) as refusal:
            probe.run(lambda: opened.append(1) or Service(), Renderer(), TEXT_EXAMPLES, TEXT_EXAMPLES, "last",
                      datum_type=datum, receipt_path=self.receipt, say=lambda _line: None)
        self.assertIn("rendered no image", str(refusal.exception))
        self.assertEqual(opened, [])

    def test_a_control_with_an_image_is_refused(self):
        with self.assertRaises(probe.Refused) as refusal:
            self.run_probe(Service(), text=IMAGE_EXAMPLES)
        self.assertIn("rendered an image", str(refusal.exception))

    def test_the_cap_refuses_before_a_session_opens(self):
        opened = []
        with self.assertRaises(probe.Refused) as refusal:
            probe.run(lambda: opened.append(1) or Service(), Renderer(), IMAGE_EXAMPLES, TEXT_EXAMPLES, "last",
                      datum_type=datum, cap=100, receipt_path=self.receipt, say=lambda _line: None)
        self.assertIn("over the 100-token cap", str(refusal.exception))
        self.assertEqual(opened, [])

    def test_missing_unreadable_and_malformed_files_are_named_refusals(self):
        with self.assertRaises(probe.Refused) as missing:
            probe.load(self.dir / "absent.jsonl")
        self.assertIn("--write-probe-lines", str(missing.exception))
        bad = self.dir / "bad.jsonl"
        bad.write_text("not json\n")
        with self.assertRaises(probe.Refused) as malformed:
            probe.load(bad)
        self.assertIn("not probe JSONL", str(malformed.exception))
        locked = self.dir / "locked.jsonl"
        locked.write_text('{"messages": []}\n')
        locked.chmod(0)
        self.addCleanup(lambda: locked.chmod(0o600))
        if os.geteuid() != 0:
            with self.assertRaises(probe.Refused) as unreadable:
                probe.load(locked)
            self.assertIn("cannot be read", str(unreadable.exception))

    def test_nothing_starts_on_or_after_the_free_offer_ends(self):
        with mock.patch.object(probe, "read_key") as read_key, mock.patch("sys.stderr"):
            code = probe.main([], now=probe.CUTOFF)
        self.assertEqual(code, 2)
        read_key.assert_not_called()
        self.assertEqual(probe.CUTOFF, datetime(2026, 11, 30, 22, 0, tzinfo=timezone.utc))


class Recovery(Base):
    def test_the_session_is_deleted_to_free_its_slot_and_a_failed_delete_is_reported(self):
        service = Service()
        result = self.run_probe(service)
        self.assertTrue(service.deleted)
        self.assertTrue(result["deleted"])
        failing = Service(fail_delete="not found")
        result = self.run_probe(failing)
        self.assertFalse(result["deleted"])
        self.assertIn("not found", result["delete_error"])
        self.assertTrue(failing.closed)
        self.assertEqual(result["mode"], "image")

    def test_a_retry_keeps_the_earlier_attempts_receipt(self):
        def interrupt(call):
            if call == 2:
                os.kill(os.getpid(), signal.SIGTERM)
        first = self.run_probe(Service(Client(on_call=interrupt)))
        self.assertEqual(first["image"]["loss"], 1.5)
        self.run_probe(Service(fail_client="no capacity"))
        kept = [json.loads(p.read_text()) for p in self.dir.glob("receipt.*.json")]
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["image"]["loss"], 1.5)
        self.assertEqual(self.saved()["stage"], "failed")

    def test_a_failed_close_keeps_both_finished_passes(self):
        service = Service(fail_close="connection reset")
        result = self.run_probe(service)
        self.assertEqual(result["mode"], "image")
        self.assertFalse(result["closed"])
        self.assertIn("connection reset", result["close_error"])
        self.assertEqual(self.saved()["image"]["loss"], 1.5)

    def test_a_session_owned_when_the_client_fails_is_still_recorded_and_deleted(self):
        service = Service(fail_client="TimeoutError: client creation timed out")
        result = self.run_probe(service)
        self.assertEqual(result["session"], "ts-test")
        self.assertTrue(service.deleted)
        self.assertTrue(result["deleted"])
        self.assertTrue(service.closed)

    def test_a_session_that_cannot_open_is_recorded_and_closed(self):
        service = Service(fail_client="no capacity")
        result = self.run_probe(service)
        self.assertEqual(result["stage"], "failed")
        self.assertIn("no capacity", result["error"])
        self.assertTrue(service.closed)
        self.assertIsNone(result["mode"])

    def test_sigterm_between_passes_keeps_the_first_and_closes(self):
        def interrupt(call):
            if call == 2:
                os.kill(os.getpid(), signal.SIGTERM)
        service = Service(Client(on_call=interrupt))
        result = self.run_probe(service)
        self.assertTrue(result["stage"].startswith("cancelled"))
        self.assertTrue(service.closed)
        self.assertEqual(result["image"]["loss"], 1.5)
        self.assertEqual(self.saved()["image"]["loss"], 1.5)
        self.assertIsNot(signal.getsignal(signal.SIGTERM), None)

    def test_the_receipt_is_written_before_the_first_pass(self):
        seen = []

        def look(call):
            if call == 1:
                seen.append(json.loads(self.receipt.read_text())["stage"])
        self.run_probe(Service(Client(on_call=look)))
        self.assertEqual(seen, ["image"])


if __name__ == "__main__":
    unittest.main()
