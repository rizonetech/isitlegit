"""scripts/meta-docs.py: the local mirror of Meta's docs and cookbooks is parsed, searched and read safely."""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("meta_docs", REPO / "scripts/meta-docs.py")
meta_docs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(meta_docs)

LLMS = """# Meta Model API
- [Models](https://dev.meta.ai/docs/models.md): Meta's model lines.
- [Models again](https://dev.meta.ai/docs/models.md): a duplicate link.
- [Auth](https://dev.meta.ai/docs/muse-code/auth.md)
- [Elsewhere](https://example.com/docs/x.md): not a Meta page.
"""


class MetaDocs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.tmp.name)
        self.mirror, self.cookbooks = base / "docs", base / "cookbooks"
        self.saved = meta_docs.MIRROR, meta_docs.COOKBOOK_DIR
        meta_docs.MIRROR, meta_docs.COOKBOOK_DIR = self.mirror, self.cookbooks

    def tearDown(self):
        meta_docs.MIRROR, meta_docs.COOKBOOK_DIR = self.saved
        self.tmp.cleanup()

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = meta_docs.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def mirror_page(self, rel, body):
        (self.mirror / rel).parent.mkdir(parents=True, exist_ok=True)
        (self.mirror / rel).write_text(body, encoding="utf-8")
        index = self.mirror / "index.json"
        pages = json.loads(index.read_text())["pages"] if index.exists() else []
        pages.append({"title": rel, "url": f"https://dev.meta.ai/{rel}", "path": rel})
        index.write_text(json.dumps({"pages": pages}), encoding="utf-8")

    def test_the_index_keeps_each_meta_page_once_in_order(self):
        pages = meta_docs.parse_index(LLMS)
        self.assertEqual([p["url"] for p in pages],
                         ["https://dev.meta.ai/docs/models.md", "https://dev.meta.ai/docs/muse-code/auth.md"])
        self.assertEqual(pages[0]["summary"], "Meta's model lines.")
        self.assertEqual(pages[1]["summary"], "")

    def test_a_page_url_that_climbs_out_of_the_mirror_is_refused(self):
        self.assertEqual(meta_docs.local_path("https://dev.meta.ai/docs/sam/x.md"), "docs/sam/x.md")
        for hostile in ("https://dev.meta.ai/docs/../../etc/passwd.md", "https://dev.meta.ai//home/someone/AGENTS.md",
                        "https://dev.meta.ai/C:\\Users\\x.md", "https://dev.meta.ai/docs\\..\\..\\x.md"):
            with self.subTest(hostile=hostile), self.assertRaises(ValueError):
                meta_docs.local_path(hostile)

    def test_find_needs_every_term_in_one_file_and_searches_docs_and_cookbooks(self):
        self.mirror_page("docs/models.md", "# Models\n\n## Muse Spark\nSet store to false.\n")
        recipe = self.cookbooks / "meta-model-cookbook/07_sam/README.md"
        recipe.parent.mkdir(parents=True)
        recipe.write_text("# SAM recipe\nSegment a logo; store nothing.\n", encoding="utf-8")
        (self.cookbooks / "meta-model-cookbook/.git").mkdir()
        (self.cookbooks / "meta-model-cookbook/.git/config").write_text("store logo\n", encoding="utf-8")
        code, out, _ = self.run_cli("find", "store", "logo")
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines(), [
            "cookbooks/meta-model-cookbook/07_sam/README.md:2 [SAM recipe] Segment a logo; store nothing."])
        code, out, _ = self.run_cli("find", "STORE")
        self.assertIn("docs/docs/models.md:4 [Muse Spark] Set store to false.", out)

    def test_find_without_a_mirror_says_to_sync_and_no_match_exits_1(self):
        code, _, err = self.run_cli("find", "anything")
        self.assertEqual(code, 2)
        self.assertIn("sync", err)
        self.mirror_page("docs/models.md", "# Models\n")
        self.assertEqual(self.run_cli("find", "absent-term")[0], 1)

    def test_show_reads_a_mirrored_file_and_refuses_anything_outside(self):
        self.mirror_page("docs/models.md", "# Models\n")
        code, out, _ = self.run_cli("show", "docs/docs/models.md")
        self.assertEqual((code, out), (0, "# Models\n"))
        self.assertEqual(self.run_cli("show", "../../etc/passwd")[0], 2)
        self.assertEqual(self.run_cli("show", "docs/missing.md")[0], 2)


if __name__ == "__main__":
    unittest.main()
