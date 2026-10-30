"""Tests for voiceover.py: nothing is sent without setup and consent, clips are reused, the key is never printed."""

import base64
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("voiceover", Path(__file__).with_name("voiceover.py"))
vo = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vo)

KEY = "sk_test_never_printed"


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def reply(seconds: float) -> FakeResponse:
    body = {"audio_base64": base64.b64encode(b"ID3fake").decode(), "alignment": {"character_end_times_seconds": [0.1, seconds]}}
    return FakeResponse(json.dumps(body).encode())


class VoiceoverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patches = [mock.patch.object(vo, "NARRATION", root / "narration"), mock.patch.object(vo, "OUT", root / "out"), mock.patch.object(vo, "MEDIA", root)]
        for p in self.patches:
            p.start()
        (root / "narration").mkdir()
        (root / "narration" / "t.json").write_text(json.dumps({"segments": [{"text": "One."}, {"text": "Two."}]}))
        self.out = root / "out" / "t"

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def run_main(self, args, env):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(vo.os.environ, env, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = vo.main(args)
        return code, out.getvalue() + err.getvalue()

    def test_dry_run_sends_nothing(self):
        with mock.patch.object(vo.urllib.request, "urlopen") as urlopen:
            code, text = self.run_main(["t", "--dry-run"], {})
        self.assertEqual(code, 0)
        urlopen.assert_not_called()
        self.assertIn("2 to generate, 8 characters", text)

    def test_missing_setup_exits_2_and_sends_nothing(self):
        with mock.patch.object(vo.urllib.request, "urlopen") as urlopen:
            code, text = self.run_main(["t", "--yes"], {"ELEVENLABS_API_KEY": KEY})
        self.assertEqual(code, 2)
        urlopen.assert_not_called()
        self.assertIn("ELEVENLABS_VOICE_ID", text)

    def test_declining_sends_nothing(self):
        with mock.patch.object(vo.urllib.request, "urlopen") as urlopen, mock.patch("builtins.input", return_value="n"):
            code, _ = self.run_main(["t"], {"ELEVENLABS_API_KEY": KEY, "ELEVENLABS_VOICE_ID": "v1"})
        self.assertEqual(code, 0)
        urlopen.assert_not_called()

    def test_generates_clips_and_reuses_unchanged_ones(self):
        env = {"ELEVENLABS_API_KEY": KEY, "ELEVENLABS_VOICE_ID": "v1"}
        with mock.patch.object(vo.urllib.request, "urlopen", side_effect=[reply(1.5), reply(2.25)]) as urlopen:
            code, text = self.run_main(["t", "--yes"], env)
        self.assertEqual(code, 0)
        self.assertEqual(urlopen.call_count, 2)
        sent = json.loads(urlopen.call_args_list[1].args[0].data)
        self.assertEqual((sent["text"], sent["previous_text"], sent["next_text"]), ("Two.", "One.", ""))
        manifest = json.loads((self.out / "manifest.json").read_text())
        self.assertEqual([c["seconds"] for c in manifest["clips"]], [1.5, 2.25])
        self.assertEqual((self.out / "00.mp3").read_bytes(), b"ID3fake")
        self.assertNotIn(KEY, text)
        with mock.patch.object(vo.urllib.request, "urlopen") as again:
            code, _ = self.run_main(["t", "--yes"], env)
        self.assertEqual(code, 0)
        again.assert_not_called()

    def test_a_failed_segment_exits_1_without_printing_the_key(self):
        env = {"ELEVENLABS_API_KEY": KEY, "ELEVENLABS_VOICE_ID": "v1"}
        err = vo.urllib.error.HTTPError("u", 401, "bad key", {}, None)
        with mock.patch.object(vo.urllib.request, "urlopen", side_effect=[err, reply(1.0)]):
            code, text = self.run_main(["t", "--yes"], env)
        self.assertEqual(code, 1)
        self.assertIn("segment 00 failed (401)", text)
        self.assertNotIn(KEY, text)

    def test_an_empty_segment_is_refused(self):
        (vo.NARRATION / "t.json").write_text(json.dumps({"segments": [{"text": " "}]}))
        code, _ = self.run_main(["t", "--dry-run"], {})
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
