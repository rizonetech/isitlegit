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

    def test_v3_clips_are_sent_without_neighbouring_text(self):
        (Path(self.tmp.name) / "narration" / "t.json").write_text(json.dumps({"model_id": "eleven_v3", "segments": [{"text": "One."}, {"text": "Two."}]}))
        env = {"ELEVENLABS_API_KEY": KEY, "ELEVENLABS_VOICE_ID": "v1"}
        with mock.patch.object(vo.urllib.request, "urlopen", side_effect=[reply(1.5), reply(2.25)]) as urlopen:
            code, _ = self.run_main(["t", "--yes"], env)
        self.assertEqual(code, 0)
        sent = json.loads(urlopen.call_args_list[1].args[0].data)
        self.assertEqual(sent["model_id"], "eleven_v3")
        self.assertNotIn("previous_text", sent)
        self.assertNotIn("next_text", sent)

    def test_a_failed_segment_exits_1_without_printing_the_key(self):
        env = {"ELEVENLABS_API_KEY": KEY, "ELEVENLABS_VOICE_ID": "v1"}
        err = vo.urllib.error.HTTPError("u", 401, "bad key", {}, None)
        with mock.patch.object(vo.urllib.request, "urlopen", side_effect=[err, reply(1.0)]):
            code, text = self.run_main(["t", "--yes"], env)
        self.assertEqual(code, 1)
        self.assertIn("segment 00 failed (401)", text)
        self.assertNotIn(KEY, text)

    def test_an_inserted_segment_never_leaves_a_scene_with_another_scenes_audio(self):
        env = {"ELEVENLABS_API_KEY": KEY, "ELEVENLABS_VOICE_ID": "v1"}
        with mock.patch.object(vo.urllib.request, "urlopen", side_effect=[reply(1.0), reply(2.0)]):
            self.run_main(["t", "--yes"], env)
        (vo.NARRATION / "t.json").write_text(json.dumps({"segments": [{"text": "Zero."}, {"text": "One."}, {"text": "Two."}]}))
        with mock.patch.object(vo.urllib.request, "urlopen", side_effect=[reply(3.0), reply(1.0), reply(2.0)]) as urlopen:
            code, _ = self.run_main(["t", "--yes"], env)
        self.assertEqual(code, 0)
        self.assertEqual([json.loads(c.args[0].data)["text"] for c in urlopen.call_args_list], ["Zero.", "One.", "Two."])
        manifest = json.loads((self.out / "manifest.json").read_text())
        self.assertEqual([(c["file"], c["text"]) for c in manifest["clips"]], [("00.mp3", "Zero."), ("01.mp3", "One."), ("02.mp3", "Two.")])

    def test_a_fact_is_filled_before_sending_and_a_stat_is_refused(self):
        (vo.MEDIA / "data").mkdir()
        (vo.MEDIA / "data" / "x-facts.json").write_text(json.dumps({"facts": {"pages": {"value": "129,892"}}}))
        (vo.NARRATION / "t.json").write_text(json.dumps({"segments": [{"text": "We read {fact.pages} pages."}]}))
        env = {"ELEVENLABS_API_KEY": KEY, "ELEVENLABS_VOICE_ID": "v1"}
        with mock.patch.object(vo.urllib.request, "urlopen", side_effect=[reply(1.0)]) as urlopen:
            self.assertEqual(self.run_main(["t", "--yes"], env)[0], 0)
        self.assertEqual(json.loads(urlopen.call_args.args[0].data)["text"], "We read 129,892 pages.")
        self.assertEqual(json.loads((self.out / "manifest.json").read_text())["clips"][0]["text"], "We read 129,892 pages.")
        for text in ("{stats.commits} commits.", "{fact.missing} pages."):
            (vo.NARRATION / "t.json").write_text(json.dumps({"segments": [{"text": text}]}))
            code, out = self.run_main(["t", "--dry-run"], {})
            self.assertEqual(code, 2, text)
            self.assertIn("t.json", out)

    def test_a_dry_run_without_the_voice_counts_against_the_voice_the_clips_were_made_with(self):
        with mock.patch.object(vo.urllib.request, "urlopen", side_effect=[reply(1.0), reply(2.0)]):
            self.run_main(["t", "--yes"], {"ELEVENLABS_API_KEY": KEY, "ELEVENLABS_VOICE_ID": "v1"})
        (vo.NARRATION / "t.json").write_text(json.dumps({"segments": [{"text": "One."}, {"text": "Two, edited."}]}))
        code, text = self.run_main(["t", "--dry-run"], {})
        self.assertEqual(code, 0)
        self.assertIn("2 segments, 1 to generate", text)

    def test_names_are_said_the_way_the_pronunciation_table_says(self):
        (vo.MEDIA / "data").mkdir(exist_ok=True)
        (vo.MEDIA / "data" / "pronunciation.json").write_text(json.dumps({"say": {"IsItLegit": "Is It Legit", "IsItLegit.co": "Is It Legit dot co"}}))
        (vo.NARRATION / "t.json").write_text(json.dumps({"segments": [{"text": "IsItLegit lives at IsItLegit.co."}]}))
        self.assertEqual(vo.load("t")[1], ["Is It Legit lives at Is It Legit dot co."])

    def test_voice_settings_are_sent_and_only_change_the_files_that_set_them(self):
        self.assertEqual(vo.digest("One.", "v1", "m"), vo.digest("One.", "v1", "m", None))
        settings = {"stability": 0.35, "style": 0.4}
        self.assertNotEqual(vo.digest("One.", "v1", "m"), vo.digest("One.", "v1", "m", settings))
        (vo.NARRATION / "t.json").write_text(json.dumps({"voice_settings": settings, "segments": [{"text": "One."}]}))
        with mock.patch.object(vo.urllib.request, "urlopen", side_effect=[reply(1.0)]) as urlopen:
            self.run_main(["t", "--yes"], {"ELEVENLABS_API_KEY": KEY, "ELEVENLABS_VOICE_ID": "v1"})
        self.assertEqual(json.loads(urlopen.call_args.args[0].data)["voice_settings"], settings)

    def test_an_empty_segment_is_refused(self):
        (vo.NARRATION / "t.json").write_text(json.dumps({"segments": [{"text": " "}]}))
        code, _ = self.run_main(["t", "--dry-run"], {})
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
