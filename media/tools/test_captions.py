"""Tests for captions.py: cues fit two lines and fill their clip, timestamps are SRT's, chapters follow YouTube's rules."""

import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("captions", Path(__file__).with_name("captions.py"))
cap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cap)


class CaptionsTest(unittest.TestCase):
    def test_cues_hold_two_short_lines_and_span_the_clip_exactly(self):
        text = "Forward a suspicious email to IsItLegit, and get a plain-language verdict with the evidence behind it, in minutes."
        out = cap.cues(text, 10.0, 6.0, width=30)
        self.assertTrue(all(len(line) <= 30 for _, _, block in out for line in block.split("\n")))
        self.assertTrue(all(block.count("\n") <= 1 for _, _, block in out))
        self.assertEqual(out[0][0], 10.0)
        self.assertAlmostEqual(out[-1][1], 16.0)
        self.assertEqual(" ".join(block.replace("\n", " ") for _, _, block in out), text)

    def test_captions_drop_pause_tags(self):
        import json, tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "h.json").write_text(json.dumps({"segments": [{"text": 'A fake login page. <break time="0.5s" /> Spot it?'}]}))
            with mock.patch.object(cap.vo, "NARRATION", Path(d)), mock.patch.object(cap.vo, "facts", return_value={}):
                self.assertEqual(cap.written("h"), ["A fake login page. Spot it?"])

    def test_srt_timestamps(self):
        self.assertEqual(cap.stamp(3725.5), "01:02:05,500")
        self.assertEqual(cap.srt([(0.5, 1.25, "Hi")]), "1\n00:00:00,500 --> 00:00:01,250\nHi\n\n")

    def test_chapters_start_at_zero_and_drop_any_shorter_than_ten_seconds(self):
        points = [(0, "Intro"), (300, "Kept"), (450, "Too soon"), (900, "Kept too"), (2950, "Too near the end")]
        self.assertEqual(cap.chapters(points, 3000), "0:00 Intro\n0:10 Kept\n0:30 Kept too\n")

    def test_scene_reading_time_matches_the_storyboard_rule(self):
        bullets = {"type": "bullets", "title": "One two three", "items": ["four five six seven"]}
        self.assertEqual(cap.scene_seconds(bullets, {}, {}), 7)  # 7 words: ceil(7 / 3.6 + 2) = 4, raised to the 7 s floor
        long = {"type": "flow", "title": " ".join(["w"] * 40), "steps": [{"title": "a", "sub": "b"}]}
        self.assertEqual(cap.scene_seconds(long, {}, {}), 17)  # 42 words: ceil(42 / 3.6 + 5) = ceil(16.67) = 17
        self.assertEqual(cap.scene_seconds({"type": "chapter", "number": 1, "title": "x"}, {}, {}), 5)


if __name__ == "__main__":
    unittest.main()
