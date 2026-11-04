"""Read-only checkpoint evidence audit, using synthetic bytes only."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from concurrent.futures import ThreadPoolExecutor

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/glimmer/checkpoint-audit.py"
spec = importlib.util.spec_from_file_location("checkpoint_audit", SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n")


class Audit(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Path(self.temp.name)
        self.dataset = self.store / "dataset/1.1"
        self.dataset.mkdir(parents=True)
        self.run = self.store / "runs/loupe-1.1"
        self.run.mkdir(parents=True)
        self.rows = {}
        for part in ("train", "eval"):
            image = ("synthetic-image-" + part).encode()
            text = "Fictional example " + part
            page_id = "fixture-" + digest(image + b"\0" + text.encode())[:16]
            nonce = digest(page_id.encode())[:32]
            answer = {"lure": False, "lure_type": "none", "has_login_form": False,
                      "has_payment_form": False}
            line = {"messages": [{"role": "system", "content": "Synthetic test"},
                     {"role": "user", "content": [
                         {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(image).decode()}},
                         {"type": "text", "text": f"Host: none\n\n<<UNTRUSTED:page-text:{nonce}>>\n{text}\n<<END:{nonce}>>"}]},
                     {"role": "assistant", "content": json.dumps(answer)}]}
            meta = {"id": page_id, "source": "fixture", "screenshot": digest(image),
                    "lure_type": "none", "brand_identity": None, "origin": "public"}
            self.rows[part] = meta
            write_json(self.dataset / f"{part}.jsonl", line)
            write_json(self.dataset / f"{part}.meta.jsonl", meta)
            page = self.dataset / "pages" / page_id
            page.mkdir(parents=True)
            (page / "screenshot.jpg").write_bytes(image)
            (page / "text.txt").write_text(text)
            write_json(page / "meta.json", {"host": None, "source": "fixture", "sha256": {"screenshot": digest(image), "text": digest(text.encode())}})
        sha = {"train": digest((self.dataset / "train.jsonl").read_bytes()),
               "evaluation": digest((self.dataset / "eval.jsonl").read_bytes())}
        self.input = self.store / "runs/input/train.jsonl"
        self.input.parent.mkdir()
        self.input.write_bytes((self.dataset / "train.jsonl").read_bytes())
        write_json(self.run / "selection.json", {"dataset_sha": sha["train"], "file_sha": sha["train"], "lines": 1})
        # Baseline fixtures exercise legacy provenance, without applying 1.1 floors retroactively.
        self.summary = {"version": "1.1", "mode": "image", "train": {"lines": 1}, "evaluation": {"lines": 1},
                        "sha256": sha, "freeze": {"pages": 2, "sha256": digest(("\n".join(sorted(r["id"] for r in self.rows.values())) + "\n").encode())},
                        "floors": {"hardNegatives": {k: n for k, n in audit.HARD_FLOORS.items()}, "splitBalance": True},
                        "hardNegatives": {"training": dict(audit.HARD_FLOORS)},
                        "splitBalance": {"status": "MET", "met": True, "tolerance": 0.05},
                        "reference": {"pages": 0, "sha256": digest(b"")}, "heldOut": 1,
                        "metadataProtection": {"pages": 0}}
        write_json(self.store / "raw/FROZEN-1.1.json", {"pages": sorted(r["id"] for r in self.rows.values())})
        write_json(self.dataset / "summary.json", self.summary)
        write_json(self.store / "raw/dataset/1.1.heldout-items.jsonl", {"id": self.rows["eval"]["id"], "source": "fixture", "item": "eval", "items": []})
        ref = self.dataset / "reference"
        ref.mkdir()
        (ref / "eval.jsonl").write_bytes(b"")
        (ref / "eval.meta.jsonl").write_bytes(b"")
        write_json(ref / "summary.json", {"version": "1.1", "pages": 0, "membership": digest(b""), "sha256": {"evaluation": digest(b"")}})

    def run_audit(self):
        return audit.audit(self.store, "1.1", trainer_input=self.input, run=self.run)

    def codes(self):
        return {i["code"] for i in self.run_audit()["issues"]}

    def test_hashes_and_selection_are_measured_without_changes(self):
        before = {p: p.read_bytes() for p in self.store.rglob("*") if p.is_file()}
        report = self.run_audit()
        self.assertEqual(report["files"]["1.1/train.jsonl"]["sha256"], self.summary["sha256"]["train"])
        self.assertTrue(report["trainer_input_matches_selection"])
        self.assertEqual(before, {p: p.read_bytes() for p in self.store.rglob("*") if p.is_file()})

    def test_selection_missing_or_conflicting_blocks(self):
        write_json(self.run / "selection.json", {"dataset_sha": "0" * 64, "file_sha": "0" * 64, "lines": 1})
        self.assertIn("selection_digest_mismatch", self.codes())
        (self.run / "selection.json").unlink()
        self.assertIn("missing_selection", self.codes())

    def test_changed_trainer_input_is_not_hidden_by_matching_path(self):
        self.input.write_bytes(b'{"changed":true}\n')
        self.assertIn("trainer_input_mismatch", self.codes())

    def test_missing_provenance_is_incomplete(self):
        self.summary.pop("freeze")
        write_json(self.dataset / "summary.json", self.summary)
        self.assertIn("missing_freeze", self.codes())

    def test_absent_evidence_is_not_called_conflicting_evidence(self):
        (self.store / "raw/FROZEN-1.1.json").unlink()
        (self.store / "raw/dataset/1.1.heldout-items.jsonl").unlink()
        codes = self.codes()
        self.assertNotIn("invalid_freeze_membership", codes)
        self.assertNotIn("heldout_membership_mismatch", codes)

    def test_malformed_and_unterminated_jsonl_refuse(self):
        for data, code in [(b"{\n", "invalid_json"), (b"{}", "unterminated_line"), (b"[]\n", "not_object")]:
            with self.subTest(code=code):
                (self.dataset / "train.jsonl").write_bytes(data)
                self.assertIn(code, self.codes())

    def test_oversized_row_is_streamed_and_next_row_is_kept(self):
        data = b'{"value":"' + b'x' * 1024 + b'"}\n{}\n'
        path = self.store / "large.jsonl"
        path.write_bytes(data)
        reader = audit.Reader()
        with mock.patch.object(audit, "MAX_JSON_BYTES", 128, create=True):
            self.assertEqual(list(reader.rows(path, "large")), [None, {}])
        self.assertEqual(reader.files["large"], {"sha256": digest(data), "lines": 2})
        self.assertEqual(reader.issues[0]["code"], "oversized_json_line")

    def test_metadata_count_duplicate_and_pairing_refuse(self):
        meta = self.dataset / "train.meta.jsonl"
        original = meta.read_bytes()
        meta.write_bytes(original * 2)
        self.assertIn("duplicate_id", self.codes())
        self.assertIn("metadata_count_mismatch", self.codes())
        meta.write_bytes((self.dataset / "eval.meta.jsonl").read_bytes())
        self.assertIn("screenshot_mismatch", self.codes())
        self.assertIn("nonce_mismatch", self.codes())

    def test_answer_label_must_match_metadata(self):
        row = dict(self.rows["train"], lure_type="credential")
        write_json(self.dataset / "train.meta.jsonl", row)
        self.assertIn("answer_label_mismatch", self.codes())

    def test_malformed_image_url_is_recorded_instead_of_crashing(self):
        path = self.dataset / "train.jsonl"
        row = json.loads(path.read_text())
        row["messages"][1]["content"][0]["image_url"]["url"] = 42
        write_json(path, row)
        self.assertIn("invalid_serialized_example", self.codes())

    def test_empty_reference_summary_cannot_verify(self):
        write_json(self.dataset / "reference/summary.json", {})
        self.assertIn("invalid_reference_summary", self.codes())

    def test_id_only_heldout_items_do_not_prove_source_protection(self):
        write_json(self.store / "raw/dataset/1.1.heldout-items.jsonl", {"id": self.rows["eval"]["id"]})
        self.assertIn("invalid_heldout_source_items", self.codes())

    def test_reference_json_is_validated_even_when_digest_matches(self):
        ref = self.dataset / "reference"
        (ref / "eval.jsonl").write_bytes(b'{\n')
        d = json.loads((ref / "summary.json").read_text())
        d["sha256"]["evaluation"] = digest(b'{\n')
        write_json(ref / "summary.json", d)
        self.assertIn("invalid_json", self.codes())

    def test_matching_image_and_nonce_do_not_hide_changed_page_text(self):
        path = self.dataset / "train.jsonl"
        row = json.loads(path.read_text())
        row["messages"][1]["content"][1]["text"] = row["messages"][1]["content"][1]["text"].replace("Fictional example train", "Changed page")
        write_json(path, row)
        self.assertIn("archive_request_mismatch", self.codes())

    def test_unmet_balance_and_floor_do_not_verify(self):
        self.summary["splitBalance"].update(status="UNMET", met=False)
        self.summary["hardNegatives"]["training"]["own-page"] = 0
        write_json(self.dataset / "summary.json", self.summary)
        self.assertIn("split_balance_unmet", self.codes())
        self.assertIn("hard_negative_floor_unmet", self.codes())

    def test_met_heading_without_rows_is_not_proof(self):
        self.assertIn("missing_balance_row", self.codes())
        self.assertNotEqual(self.run_audit()["status"], "verified")

    def test_malformed_nested_summary_does_not_crash(self):
        for key in ("sha256", "train", "reference", "floors", "hardNegatives"):
            with self.subTest(key=key):
                saved = dict(self.summary)
                saved[key] = ["invalid"]
                write_json(self.dataset / "summary.json", saved)
                self.assertNotEqual(self.run_audit()["status"], "verified")

    def test_complete_legacy_evidence_can_verify(self):
        import shutil
        previous = self.store / "dataset/1.0"
        shutil.copytree(self.dataset, previous)
        summary = dict(self.summary, version="1.0")
        write_json(previous / "summary.json", summary)
        ref_summary = json.loads((previous / "reference/summary.json").read_text())
        ref_summary["version"] = "1.0"
        write_json(previous / "reference/summary.json", ref_summary)
        shutil.copyfile(self.store / "raw/FROZEN-1.1.json", self.store / "raw/FROZEN-1.0.json")
        shutil.copyfile(self.store / "raw/dataset/1.1.heldout-items.jsonl", self.store / "raw/dataset/1.0.heldout-items.jsonl")
        report = audit.audit(self.store, "1.0", trainer_input=self.input, run=self.run)
        self.assertEqual(report["issues"], [])
        self.assertEqual(report["status"], "verified")

    def test_receipt_cannot_overwrite_and_failed_audits_are_recordable(self):
        report = self.run_audit()
        target = self.store / "runs/audits/receipt.json"
        with ThreadPoolExecutor(max_workers=2) as pool:
            def publish():
                try:
                    audit.publish_receipt(target, report, self.store)
                    return True
                except FileExistsError:
                    return False
            self.assertEqual(sorted(pool.map(lambda _: publish(), range(2))), [False, True])
        self.assertEqual(json.loads(target.read_text()), report)
        with self.assertRaises(ValueError):
            audit.publish_receipt(self.dataset / "summary.json", report, self.store)

    def test_receipt_store_inside_repository_is_refused(self):
        (self.store / ".git").mkdir()
        with self.assertRaises(ValueError):
            audit.publish_receipt(self.store / "runs/audits/private.json", {}, self.store)

    def test_page_block_matches_producer_boundaries(self):
        nonce = "a" * 32
        self.assertEqual(audit.page_block("a<<<<ENDENDb", nonce), f"<<UNTRUSTED:page-text:{nonce}>>\nab\n<<END:{nonce}>>")
        self.assertEqual(audit.page_block("x<<untrustedY<<endz", nonce), f"<<UNTRUSTED:page-text:{nonce}>>\nxYz\n<<END:{nonce}>>")
        self.assertEqual(audit.page_block("😀" * 6001, nonce), f"<<UNTRUSTED:page-text:{nonce}>>\n" + "😀" * 6000 + f"\n<<END:{nonce}>>")

    def test_common_set_comparison_refuses_different_files(self):
        previous = self.store / "dataset/1.0"
        import shutil
        shutil.copytree(self.dataset, previous)
        d = json.loads((previous / "summary.json").read_text())
        d["version"] = "1.0"
        write_json(previous / "summary.json", d)
        with (previous / "eval.jsonl").open("ab") as f:
            f.write(b'{}\n')
        report = audit.audit(self.store, "1.1", previous="1.0", trainer_input=self.input, run=self.run)
        self.assertFalse(report["comparison_ready"])
        self.assertIn("different_evaluation_files", {i["code"] for i in report["issues"]})


if __name__ == "__main__":
    unittest.main()
