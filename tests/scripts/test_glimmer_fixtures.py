"""The real JPEG fixture behind Loupe's training-line test decodes (D03 T04 §3).

test/vision/page-screen.test.ts proves a training line carries test/fixtures/glimmer/page.jpg byte for byte; this test
proves those bytes are an image a decoder reads, so a line built from them gives Fireworks a usable screenshot.
"""
import unittest
from pathlib import Path

from PIL import Image  # CI's script-test job installs Pillow (design/tools/requirements.txt)

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "test" / "fixtures" / "glimmer" / "page.jpg"


class GlimmerFixtures(unittest.TestCase):
    def test_the_page_fixture_is_a_decodable_jpeg(self):
        with Image.open(FIXTURE) as image:
            image.load()
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.size, (640, 400))
            # Pixels, not only a header: the decoded image has content.
            self.assertGreater(len(set(image.convert("L").getdata())), 2)


if __name__ == "__main__":
    unittest.main()
