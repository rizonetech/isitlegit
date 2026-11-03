"""scripts/glimmer/inputs.py (D03 T04 §18): a source's inputs are bound before conversion, a file without a published
digest or a pin, or changed since, never reaches it, and an export accounts for every item it met."""
import hashlib
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "inputs.py"
spec = importlib.util.spec_from_file_location("inputs", SCRIPT)
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)


class Manifest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="inputs-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        (self.dir / "a.zip").write_bytes(b"alpha")
        (self.dir / "b.tar.gz").write_bytes(b"bravo")

    def files(self, **over):
        md5 = hashlib.md5(b"bravo").hexdigest()
        files = [
            {"name": "a.zip", "published": None, "pinned": "kaggle: owner/set, version 2"},
            {"name": "b.tar.gz", "published": {"kind": "md5", "value": md5}, "pinned": None},
        ]
        for entry in files:
            entry.update(over.get(entry["name"], {}))
        return files

    def test_binds_published_and_pinned_files_and_verifies_them(self):
        manifest = inputs.build(self.dir, self.files(), "CC BY 4.0")
        self.assertEqual([e["name"] for e in manifest["files"]], ["a.zip", "b.tar.gz"])
        got, digest = inputs.verify(self.dir, ["a.zip"])
        self.assertEqual(digest, inputs.digest_of(manifest))
        self.assertEqual(got["licence"], "CC BY 4.0")

    def test_refuses_a_file_with_neither_a_published_digest_nor_a_pin(self):
        with self.assertRaisesRegex(inputs.Refused, "no published digest and no pinned version"):
            inputs.build(self.dir, self.files(**{"a.zip": {"pinned": None}}), "CC0")

    # §28: a Hugging Face pin names the release's commit, never a branch that moves.
    def test_a_hugging_face_pin_names_a_commit_not_a_branch(self):
        commit = "0123456789abcdef0123456789abcdef01234567"
        good = {"a.zip": {"pinned": f"huggingface: phreshphish/phreshphish, {commit}"}}
        inputs.build(self.dir, self.files(**good), "CC BY 4.0")
        inputs.verify(self.dir, ["a.zip"])
        for branch in ("main", "v1.0", commit[:12]):
            with self.assertRaisesRegex(inputs.Refused, "names a commit id, not a branch|does not move"):
                inputs.build(self.dir, self.files(**{"a.zip": {"pinned": f"huggingface: phreshphish/phreshphish, {branch}"}}), "CC0")
        # A manifest written before the rule, pinned to `main`, is refused when read too.
        manifest = json.loads((self.dir / inputs.INPUTS).read_text())
        manifest["files"][0]["pinned"] = "huggingface: phreshphish/phreshphish, main"
        (self.dir / inputs.INPUTS).write_text(json.dumps(manifest))
        with self.assertRaisesRegex(inputs.Refused, "names a commit id, not a branch|does not move"):
            inputs.verify(self.dir, ["a.zip"])
        # A Kaggle version pin is a pin: a file with no published digest is admitted on it (the digest-or-pin rule).
        inputs.build(self.dir, self.files(), "CC0")

    # §27 finding 4: no pin may name a version that moves, from any publisher.
    def test_a_pin_on_a_moving_name_is_refused_from_any_publisher(self):
        commit = "0123456789abcdef0123456789abcdef01234567"
        inputs.build(self.dir, self.files(**{"a.zip": {"pinned": f"github: owner/repo, {commit}"}}), "MIT")
        # The spelling ScamFerret's manifest uses.
        inputs.build(self.dir, self.files(**{"a.zip": {"pinned": f"github: ScamFerret/artifact, commit {commit}"}}), "GPL-3.0")
        for pinned, why in (("github: owner/repo, main", "does not move"),
                            ("github: owner/repo, v1.2", "GitHub pin names a commit id"),
                            ("kaggle: owner/set, latest", "does not move"),
                            ("zenodo: record 123, LATEST", "does not move")):
            with self.assertRaisesRegex(inputs.Refused, why):
                inputs.build(self.dir, self.files(**{"a.zip": {"pinned": pinned}}), "CC0")

    def test_refuses_a_mismatched_published_digest(self):
        wrong = {"published": {"kind": "md5", "value": "0" * 32}}
        with self.assertRaisesRegex(inputs.Refused, "does not match its published md5"):
            inputs.build(self.dir, self.files(**{"b.tar.gz": wrong}), "CC0")

    def test_refuses_a_changed_file_a_missing_one_and_an_unlisted_one(self):
        inputs.build(self.dir, self.files(), "CC0")
        (self.dir / "a.zip").write_bytes(b"alphX")
        with self.assertRaisesRegex(inputs.Refused, "changed since"):
            inputs.verify(self.dir, [])
        (self.dir / "a.zip").write_bytes(b"alpha")
        with self.assertRaisesRegex(inputs.Refused, "not in the manifest"):
            inputs.verify(self.dir, ["c.zip"])
        (self.dir / "b.tar.gz").unlink()
        with self.assertRaisesRegex(inputs.Refused, "missing"):
            inputs.verify(self.dir, [])

    def test_refuses_without_a_manifest(self):
        with self.assertRaisesRegex(inputs.Refused, "build the manifest first"):
            inputs.verify(self.dir, ["a.zip"])


class ReceiptAndLimits(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="receipt-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        (self.dir / "rows.jsonl").write_text('{"a": 1}\n')
        (self.dir / "conv.py").write_text("# converter\n")

    def test_accounts_for_every_item_by_outcome(self):
        receipt = inputs.Receipt()
        receipt.export()
        receipt.export()
        receipt.sample_out()
        receipt.reject("no capture answered 200")
        written = receipt.write(self.dir, self.dir / "rows.jsonl", self.dir / "conv.py", "d" * 64)
        self.assertEqual((written["met"], written["exported"], written["sampled_out"]), (4, 2, 1))
        self.assertEqual(written["rejected"], {"no capture answered 200": 1})
        self.assertEqual(json.loads((self.dir / inputs.EXPORT).read_text())["inputs"], "d" * 64)

    def test_records_the_recipe_that_made_the_rows(self):
        receipt = inputs.Receipt()
        receipt.export()
        written = receipt.write(self.dir, self.dir / "rows.jsonl", self.dir / "conv.py", "d" * 64, {"seed": 7, "max": 10})
        recipe = json.loads((self.dir / inputs.EXPORT).read_text())["recipe"]
        self.assertEqual(recipe["parameters"], {"max": 10, "seed": 7})
        self.assertEqual(recipe["helper_sha256"], hashlib.sha256(SCRIPT.read_bytes()).hexdigest())
        self.assertEqual(written["recipe"], recipe)

    def test_refuses_a_record_that_does_not_read_back_as_written(self):
        original = inputs.json.load
        inputs.json.load = lambda source: {"changed": True}
        try:
            with self.assertRaisesRegex(inputs.Refused, "did not read back"):
                inputs.write_json(self.dir / "INPUTS.json", {"files": []})
        finally:
            inputs.json.load = original

    def test_refuses_an_export_that_does_not_reconcile(self):
        receipt = inputs.Receipt()
        receipt.export()
        receipt.met += 1  # an item met and never given an outcome
        with self.assertRaisesRegex(inputs.Refused, "accounts for 1 of 2"):
            receipt.write(self.dir, self.dir / "rows.jsonl", self.dir / "conv.py", "d" * 64)
        self.assertFalse((self.dir / inputs.EXPORT).exists())

    def test_limits_stop_a_bomb_an_entry_flood_a_pending_flood_and_a_long_run(self):
        with self.assertRaisesRegex(inputs.Refused, "bytes expanded"):
            limits = inputs.Limits(expanded=100)
            limits.count_entry(60)
            limits.count_entry(60)
        with self.assertRaisesRegex(inputs.Refused, "archive entries"):
            limits = inputs.Limits(entries=2)
            for _ in range(3):
                limits.count_entry()
        with self.assertRaisesRegex(inputs.Refused, "unmatched parts"):
            inputs.Limits(pending=5).count_pending(6)
        now = [0.0]
        limits = inputs.Limits(seconds=10, clock=lambda: now[0])
        now[0] = 11.0
        with self.assertRaisesRegex(inputs.Refused, "passed 10 seconds"):
            limits.count_entry()

    def test_retained_and_allocation_limits_and_the_second_pass(self):
        now = [0.0]
        limits = inputs.Limits(retained=100, allocation=50, seconds=10, clock=lambda: now[0])
        limits.charge_retained(60)
        limits.release_retained(30)
        limits.charge_retained(60)  # 90 held: released bytes are not counted twice
        with self.assertRaisesRegex(inputs.Refused, "more than 100 bytes retained at once"):
            limits.charge_retained(11)
        with self.assertRaisesRegex(inputs.Refused, "a row of 51 bytes passes the 50 byte allocation limit"):
            limits.check_allocation(51, "a row")
        limits.check_allocation(50)
        limits.count_entry(5)
        limits.new_pass()
        self.assertEqual((limits.entries, limits.expanded, limits.retained), (0, 0, 101))  # the counts restart; held bytes (90, and the 11 refused) do not
        now[0] = 11.0
        with self.assertRaisesRegex(inputs.Refused, "passed 10 seconds"):
            limits.check_deadline()
        with self.assertRaisesRegex(inputs.Refused, "passed 10 seconds"):
            limits.count_expanded(1)



class ItemLedger(unittest.TestCase):
    """§28 G3: every item a converter meets, named with its outcome, written whole or not at all."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="ledger-"))
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_names_every_item_with_its_outcome_and_binds_the_ledger(self):
        receipt = inputs.Receipt()
        receipt.export("row-a")
        receipt.sample_out("row-b")
        receipt.reject("over the size limit", "row-c")
        path = receipt.write_items(self.dir, "i" * 64, "r" * 64)
        lines = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertEqual(lines[0], {"inputs": "i" * 64, "rows": "r" * 64})
        self.assertEqual(lines[1:], [{"item": "row-a", "outcome": "exported"}, {"item": "row-b", "outcome": "sampled-out"},
                                     {"item": "row-c", "outcome": "rejected", "reason": "over the size limit"}])

    def test_refuses_an_unnamed_or_twice_named_item_and_leaves_no_ledger(self):
        receipt = inputs.Receipt()
        receipt.export("row-a")
        receipt.reject("no label")  # unnamed
        with self.assertRaisesRegex(inputs.Refused, "names 1 of 2 items"):
            receipt.write_items(self.dir, "i" * 64, "r" * 64)
        twice = inputs.Receipt()
        twice.export("row-a")
        twice.sample_out("row-a")
        with self.assertRaisesRegex(inputs.Refused, "names an item twice"):
            twice.write_items(self.dir, "i" * 64, "r" * 64)
        omitted = inputs.Receipt()
        omitted.note_inventory("row-a")
        omitted.note_inventory("row-b")
        omitted.export("row-a")
        with self.assertRaisesRegex(inputs.Refused, "does not match the input inventory"):
            omitted.write_items(self.dir, "i" * 64, "r" * 64)
        dup_inv = inputs.Receipt()
        dup_inv.note_inventory("row-a")
        dup_inv.note_inventory("row-a")
        dup_inv.export("row-a")
        with self.assertRaisesRegex(inputs.Refused, "input inventory names an item twice"):
            dup_inv.write_items(self.dir, "i" * 64, "r" * 64)
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_charges_lineage_bookkeeping_and_serialization_to_limits_and_writes_inventory(self):
        # Retained limit breached by inventory or outcome bookkeeping (completion review G1).
        tight_retained = inputs.Limits(retained=300)
        bounded = inputs.Receipt(tight_retained)
        bounded.note_inventory("row-a")
        with self.assertRaisesRegex(inputs.Refused, "bytes retained at once"):
            bounded.export("row-a")
        # Allocation limit breached during write_items serialization.
        tight_alloc = inputs.Limits(retained=10_000, allocation=50)
        alloc_receipt = inputs.Receipt(tight_alloc)
        alloc_receipt.note_inventory("row-a")
        alloc_receipt.export("row-a")
        with self.assertRaisesRegex(inputs.Refused, "allocation limit"):
            alloc_receipt.write_items(self.dir, "i" * 64, "r" * 64)
        self.assertEqual(list(self.dir.iterdir()), [])
        # Within limits: writes both ITEMS.jsonl and ITEMS.inventory.jsonl.
        ok = inputs.Receipt(inputs.Limits())
        ok.note_inventory("row-a")
        ok.export("row-a")
        ok.write_items(self.dir, "i" * 64, "r" * 64)
        inv_lines = [json.loads(line) for line in (self.dir / inputs.INVENTORY_ITEMS).read_text().splitlines()]
        self.assertEqual(inv_lines, [{"inputs": "i" * 64}, {"item": "row-a"}])


if __name__ == "__main__":
    unittest.main()
