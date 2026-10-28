"""scripts/check-meta-key.py (D99 T01 §1): the key passes only when Meta accepts it, and never reaches the output."""
import importlib.util
import pathlib
import unittest
import urllib.error

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_meta_key", REPO / "scripts/check-meta-key.py")
cmk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cmk)

KEY = "LLM_1234567890_abcdefghijKLMNOP"


def models(status=200, ids=("muse-spark-1.3", "muse-wonder-1.0")):
    return lambda key: (status, list(ids))


class MetaKey(unittest.TestCase):
    def outcome(self, read=lambda: KEY, list_models=None):
        passed, line = cmk.check(read=read, models=list_models or models())
        self.assertNotIn(KEY, line)
        return passed, line

    def test_a_working_key_passes(self):
        self.assertEqual(self.outcome(), (True, "check-meta-key: HTTP 200, 2 models listed, muse-spark-1.3 among them; key shape ok"))

    def test_a_placeholder_or_whitespace_is_refused_before_any_call(self):
        called = []
        for value in ("  ", "placeholder", "LLM_", "sk-something"):
            with self.subTest(value):
                passed, line = cmk.check(read=lambda v=value: v, models=lambda key: called.append(key) or (200, []))
                self.assertFalse(passed)
                self.assertIn("does not hold a Meta key", line)
        self.assertEqual(called, [])

    def test_a_revoked_or_foreign_key_is_refused(self):
        passed, line = self.outcome(list_models=models(status=401))
        self.assertFalse(passed)
        self.assertIn("HTTP 401", line)

    def test_a_list_without_spark_is_refused(self):
        passed, line = self.outcome(list_models=models(ids=("other-model",)))
        self.assertFalse(passed)

    def test_a_stalled_vault_or_network_is_refused_with_a_reason(self):
        def stalled():
            raise RuntimeError("the vault did not answer within 60 s; check conclave-op can reach 1Password")

        passed, line = self.outcome(read=stalled)
        self.assertFalse(passed)
        self.assertIn("did not answer within 60 s", line)

        def unreachable(key):
            raise urllib.error.URLError(f"timed out sending {key}")

        passed, line = self.outcome(list_models=unreachable)
        self.assertFalse(passed)
        self.assertIn("URLError", line)


if __name__ == "__main__":
    unittest.main()
