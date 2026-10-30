"""Tests for sound.py and the sound half of voice-index.py: nothing sent without consent, edits re-made, stale files stop a render."""

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


snd = load("sound", "sound.py")
vi = load("voice_index", "voice-index.py")
KEY = "sk_test_never_printed"
# 128 kbit/s, 44.1 kHz MPEG-1 Layer III frames of 417 bytes, after a 10-byte ID3 header.
FRAME = bytes([0xFF, 0xFB, 0x90, 0x64]) + bytes(413)
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + FRAME * 100


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class SoundTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.spec = root / "sound.json"
        self.spec.write_text(json.dumps({"music": {"bed": {"prompt": "calm", "seconds": 3}}, "sfx": {"whoosh": {"prompt": "soft", "seconds": 1}}}))
        self.patches = [mock.patch.object(snd, "SPEC", self.spec), mock.patch.object(snd, "OUT", root / "sound"), mock.patch.object(snd, "MEDIA", root)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def run_main(self, args, env):
        out = io.StringIO()
        with mock.patch.dict(snd.os.environ, env, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            return snd.main(args), out.getvalue()

    def test_mp3_length_is_counted_from_its_frames(self):
        self.assertEqual(snd.mp3_seconds(MP3), round(100 * 1152 / 44100, 3))

    def test_dry_run_and_missing_key_send_nothing(self):
        with mock.patch.object(snd.urllib.request, "urlopen") as urlopen:
            self.assertEqual(self.run_main(["--dry-run"], {})[0], 0)
            self.assertEqual(self.run_main(["--yes"], {})[0], 2)
        urlopen.assert_not_called()

    def test_makes_each_file_once_and_remakes_an_edited_one(self):
        env = {"ELEVENLABS_API_KEY": KEY}
        with mock.patch.object(snd.urllib.request, "urlopen", side_effect=[FakeResponse(MP3), FakeResponse(MP3)]) as urlopen:
            code, text = self.run_main(["--yes"], env)
        self.assertEqual(code, 0)
        self.assertEqual([json.loads(c.args[0].data).get("force_instrumental") for c in urlopen.call_args_list], [True, None])
        self.assertNotIn(KEY, text)
        manifest = json.loads((snd.OUT / "manifest.json").read_text())["files"]
        self.assertEqual(manifest["bed"]["seconds"], snd.mp3_seconds(MP3))
        self.spec.write_text(self.spec.read_text().replace('"soft"', '"softer"'))
        with mock.patch.object(snd.urllib.request, "urlopen", side_effect=[FakeResponse(MP3)]) as again:
            self.assertEqual(self.run_main(["--yes"], env)[0], 0)
        self.assertEqual(json.loads(again.call_args.args[0].data)["text"], "softer")

    def test_index_imports_the_files_and_stops_on_a_stale_one(self):
        with mock.patch.object(snd.urllib.request, "urlopen", side_effect=[FakeResponse(MP3), FakeResponse(MP3)]):
            self.run_main(["--yes"], {"ELEVENLABS_API_KEY": KEY})
        with mock.patch.object(vi, "snd", snd):
            sound = vi.sounds()
            self.assertEqual(sorted(sound), ["bed", "whoosh"])
            self.assertIn('import s_bed from "../../out/sound/bed.mp3";', vi.module({}, {n: {**f, "gain": 1.0} for n, f in sound.items()}))
            self.spec.write_text(self.spec.read_text().replace('"calm"', '"busy"'))
            with self.assertRaisesRegex(ValueError, "sound bed is missing or older than data/sound.json"):
                vi.sounds()


if __name__ == "__main__":
    unittest.main()
