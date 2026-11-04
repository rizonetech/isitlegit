"""Tests for voice-index.py and the narration files: a scene plays its own words or the render stops."""

import contextlib
import importlib.util
import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("voice_index", Path(__file__).with_name("voice-index.py"))
vi = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vi)
vo = vi.vo
MEDIA = Path(__file__).resolve().parent.parent


class VoiceIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patches = [
            mock.patch.object(vo, "NARRATION", root / "narration"),
            mock.patch.object(vo, "OUT", root / "voice"),
            mock.patch.object(vo, "MEDIA", root),
            mock.patch.object(vi, "OUT", root / "voice.ts"),
            mock.patch.object(vi.snd, "OUT", root / "sound"),
            mock.patch.object(vi.snd, "SPEC", root / "sound.json"),
            mock.patch.object(vi, "LEVELS", root / "levels.json"),
            mock.patch.object(vi, "LOGO", root / "logo.mp4"),
            mock.patch.object(vi, "loudness", side_effect=lambda path: -25.0),
        ]
        for p in self.patches:
            p.start()
        (root / "logo.mp4").write_bytes(b"logo sound")
        (root / "narration").mkdir()
        (root / "narration" / "01.json").write_text(json.dumps({"segments": [{"text": "One."}, {"text": "Two."}]}))
        (root / "narration" / "02.json").write_text(json.dumps({"segments": [{"text": "Other."}]}))
        self.root = root

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def voice(self, video, clips):
        out = self.root / "voice" / video
        out.mkdir(parents=True)
        for c in clips:
            (out / c["file"]).write_bytes(b"ID3")
        (out / "manifest.json").write_text(json.dumps({"clips": clips}))

    def run_main(self, argv=None):
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            return vi.main(argv), err.getvalue()

    def test_without_manifests_every_video_renders_silent(self):
        self.assertEqual(self.run_main()[0], 0)
        self.assertIn("export const VOICE: Record<string, { src: string; seconds: number; gain: number }[]> = {\n};", (self.root / "voice.ts").read_text())

    def test_a_complete_voice_is_imported_in_segment_order(self):
        self.voice("01", [{"index": 1, "file": "01.mp3", "seconds": 2.5, "text": "Two."}, {"index": 0, "file": "00.mp3", "seconds": 1.25, "text": "One."}])
        self.assertEqual(self.run_main()[0], 0)
        ts = (self.root / "voice.ts").read_text()
        self.assertIn('import v01_00 from "../../out/voice/01/00.mp3";', ts)
        # -25 LUFS measured, so 6 dB of gain brings each clip to the -19 LUFS reference.
        self.assertIn('"01": [{ src: v01_00, seconds: 1.25, gain: 1.122 }, { src: v01_01, seconds: 2.5, gain: 1.122 }],', ts)
        self.assertNotIn('"02"', ts)

    def test_a_video_name_with_a_dash_imports_as_a_valid_identifier(self):
        ts = vi.module({"01-hook": [{"index": 0, "file": "00.mp3", "seconds": 9.5, "gain": 1.0}]}, {})
        self.assertIn('import v01_hook_00 from "../../out/voice/01-hook/00.mp3";', ts)
        self.assertIn('"01-hook": [{ src: v01_hook_00, seconds: 9.5, gain: 1.0 }],', ts)

    def test_a_sound_name_with_a_dash_imports_as_a_valid_identifier(self):
        ts = vi.module({}, {"demo-bed": {"file": "demo-bed.mp3", "seconds": 150.0, "gain": 1.0}})
        self.assertIn('import s_demo_bed from "../../out/sound/demo-bed.mp3";', ts)
        self.assertIn('"demo-bed": { src: s_demo_bed, seconds: 150.0, gain: 1.0 },', ts)

    def test_each_file_is_measured_once_until_its_content_changes(self):
        self.voice("01", [{"index": 0, "file": "00.mp3", "seconds": 1.0, "text": "One."}, {"index": 1, "file": "01.mp3", "seconds": 1.0, "text": "Two."}])
        self.run_main()
        self.assertEqual(vi.loudness.call_count, 2)  # the logo, and both clips hold the same bytes, so one measurement serves both
        self.run_main()
        self.assertEqual(vi.loudness.call_count, 2)
        (self.root / "voice" / "01" / "01.mp3").write_bytes(b"ID3 new take")
        self.run_main()
        self.assertEqual(vi.loudness.call_count, 3)

    def test_a_missing_or_stale_clip_stops_the_render(self):
        self.voice("01", [{"index": 0, "file": "00.mp3", "seconds": 1.0, "text": "One."}, {"index": 1, "file": "01.mp3", "seconds": 1.0, "text": "Old words."}])
        code, err = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("01.mp3 does not match the narration text; run python3 media/tools/voiceover.py 01", err)
        self.assertFalse((self.root / "voice.ts").exists())
        (self.root / "voice" / "01" / "01.mp3").unlink()
        self.assertIn("segment 01 has no clip", self.run_main()[1])

    def test_naming_a_video_indexes_only_it_so_another_videos_stale_clips_do_not_stop_it(self):
        self.voice("01", [{"index": 0, "file": "00.mp3", "seconds": 1.0, "text": "One."}, {"index": 1, "file": "01.mp3", "seconds": 1.0, "text": "Old words."}])
        self.voice("02", [{"index": 0, "file": "00.mp3", "seconds": 1.0, "text": "Other."}])
        self.assertEqual(self.run_main()[0], 1)
        self.assertEqual(self.run_main(["02"])[0], 0)
        ts = (self.root / "voice.ts").read_text()
        self.assertIn('"02"', ts)
        self.assertNotIn('"01"', ts)


class NarrationFilesTest(unittest.TestCase):
    """The real narration: one segment per sequence, labelled with its scene, every fact defined, no dashes."""

    def segments(self, video):
        return json.loads((MEDIA / "data" / "narration" / f"{video}.json").read_text())["segments"]

    def test_storyboard_videos_have_one_segment_per_scene_in_order(self):
        for video, board in (("01", "01-development-process"), ("02", "02-technical-deep-dive")):
            scenes = json.loads((MEDIA / "data" / "storyboards" / f"{board}.json").read_text())["scenes"]
            self.assertEqual([s["scene"] for s in self.segments(video)], ["title", *(s["title"] for s in scenes), "close"], video)

    def test_video_03_has_one_segment_per_scene(self):
        source = (MEDIA / "src" / "videos" / "LoupeV1.tsx").read_text()
        scenes = re.search(r"export const SCENES = \[([^\]]*)\]", source).group(1).split(",")
        self.assertEqual(len(self.segments("03")), len(scenes))

    def test_every_segment_resolves_and_has_no_dashes(self):
        for path in sorted((MEDIA / "data" / "narration").glob("*.json")):
            _, texts = vo.load(path.stem)
            for text in texts:
                self.assertNotRegex(text, "[\u2013\u2014]", path.name)


if __name__ == "__main__":
    unittest.main()
