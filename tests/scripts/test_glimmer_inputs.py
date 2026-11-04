"""scripts/glimmer/inputs.py (D03 T04 §18): a source's inputs are bound before conversion, a file without a published
digest or a pin, or changed since, never reaches it, and an export accounts for every item it met."""
import hashlib
import importlib.util
import json
import shutil
import tempfile
import unittest
import unittest.mock
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
        # Allocation limit breached during write_items serialization before building a 3,000-byte ledger (Round 1 finding 1).
        tight_alloc = inputs.Limits(retained=100_000, allocation=1000)
        alloc_receipt = inputs.Receipt(tight_alloc)
        for idx in range(60):
            item_id = f"row-{idx:04d}"
            alloc_receipt.note_inventory(item_id)
            alloc_receipt.export(item_id)
        before_retained = tight_alloc.retained
        serialized_chunks = []
        orig_dumps = inputs.json.dumps

        def spy_dumps(*args, **kwargs):
            out = orig_dumps(*args, **kwargs)
            serialized_chunks.append(len(out))
            return out

        with unittest.mock.patch.object(inputs.json, "dumps", side_effect=spy_dumps):
            with self.assertRaisesRegex(inputs.Refused, "ITEMS.jsonl serialization .* passes the 1000 byte allocation limit"):
                alloc_receipt.write_items(self.dir, "i" * 64, "r" * 64)
        self.assertLessEqual(sum(serialized_chunks), 1000)
        self.assertEqual(tight_alloc.retained, before_retained)
        self.assertEqual(list(self.dir.iterdir()), [])
        # Escape-heavy single record (500 NUL or DEL chars -> >3,000 JSON bytes) refused before json.dumps runs on it (Round 2 & 3 finding 1).
        for ch in ("\x00", "\x7f"):
            escape_limits = inputs.Limits(retained=50_000, allocation=1000)
            escape_receipt = inputs.Receipt(escape_limits)
            escape_receipt.note_inventory("row-a")
            escape_receipt.reject(ch * 500, "row-a")
            escape_before = escape_limits.retained
            escape_chunks = []

            def spy_escape_dumps(*args, **kwargs):
                out = orig_dumps(*args, **kwargs)
                escape_chunks.append(len(out))
                return out

            with unittest.mock.patch.object(inputs.json, "dumps", side_effect=spy_escape_dumps):
                with self.assertRaisesRegex(inputs.Refused, "ITEMS.jsonl serialization .* passes the 1000 byte allocation limit"):
                    escape_receipt.write_items(self.dir, "i" * 64, "r" * 64)
            self.assertTrue(all(c < 200 for c in escape_chunks))
            self.assertEqual(escape_limits.retained, escape_before)
            self.assertEqual(list(self.dir.iterdir()), [])
        # Within limits (including U+007F DEL): writes both ITEMS.jsonl and ITEMS.inventory.jsonl and releases all scratch retained bytes.
        ok_limits = inputs.Limits()
        ok = inputs.Receipt(ok_limits)
        ok.reject("bad\x7fbyte", "row-a")
        held_before_write = ok_limits.retained
        ok.write_items(self.dir, "i" * 64, "r" * 64, inventory=["row-a"])
        self.assertEqual(ok_limits.retained, held_before_write)
        inv_lines = [json.loads(line) for line in (self.dir / inputs.INVENTORY_ITEMS).read_text().splitlines()]
        self.assertEqual(inv_lines, [{"inputs": "i" * 64}, {"item": "row-a"}])

        # Round 5 finding 2: Receipt.publish stages and validates ledgers before replacing rows.jsonl or writing EXPORT.json,
        # so a limit refusal during ledger staging leaves pre-existing outputs completely untouched.
        out_rows = self.dir / "rows.jsonl"
        out_rows.write_text('{"sha256":"prev"}\n', encoding="utf-8")
        (self.dir / inputs.EXPORT).write_text('{"rows_sha256":"prev-export"}\n', encoding="utf-8")
        (self.dir / inputs.ITEMS).write_text('{"inputs":"prev","rows":"prev"}\n', encoding="utf-8")
        (self.dir / inputs.INVENTORY_ITEMS).write_text('{"inputs":"prev"}\n', encoding="utf-8")
        staged_rows = self.dir / ".rows.jsonl.99999.tmp"
        staged_rows.write_text('{"sha256":"new-0"}\n' * 60, encoding="utf-8")
        pub_limits = inputs.Limits(retained=40_000, allocation=1000)
        pub_receipt = inputs.Receipt(pub_limits)
        for idx in range(60):
            item_id = f"new-{idx:04d}"
            pub_receipt.note_inventory(item_id)
            pub_receipt.export(item_id)
        with self.assertRaisesRegex(inputs.Refused, "more than 40000 bytes retained at once"):
            pub_receipt.publish(self.dir, staged_rows, out_rows, Path(__file__), "n" * 64)
        self.assertEqual(out_rows.read_text(encoding="utf-8"), '{"sha256":"prev"}\n')
        self.assertEqual((self.dir / inputs.EXPORT).read_text(encoding="utf-8"), '{"rows_sha256":"prev-export"}\n')
        self.assertEqual((self.dir / inputs.ITEMS).read_text(encoding="utf-8"), '{"inputs":"prev","rows":"prev"}\n')
        self.assertEqual((self.dir / inputs.INVENTORY_ITEMS).read_text(encoding="utf-8"), '{"inputs":"prev"}\n')
        self.assertEqual([p.name for p in self.dir.iterdir() if p.name.startswith(".ITEMS")], [])

        # Round 7 finding 1: ENOSPC while staging EXPORT.json or an interrupted replacement mid-sequence preserves
        # the previous generation intact without leaving half-replaced files behind.
        staged_rows2 = self.dir / ".rows.jsonl.99999.tmp"
        staged_rows2.write_text('{"sha256":"new-0"}\n', encoding="utf-8")
        enospc_receipt = inputs.Receipt(inputs.Limits())
        enospc_receipt.note_inventory("new-0")
        enospc_receipt.export("new-0")
        with unittest.mock.patch.object(inputs.json, "dump", side_effect=OSError(28, "No space left on device")):
            with self.assertRaisesRegex(OSError, "No space left on device"):
                enospc_receipt.publish(self.dir, staged_rows2, out_rows, Path(__file__), "n" * 64)
        self.assertEqual(out_rows.read_text(encoding="utf-8"), '{"sha256":"prev"}\n')
        self.assertEqual((self.dir / inputs.EXPORT).read_text(encoding="utf-8"), '{"rows_sha256":"prev-export"}\n')
        self.assertEqual((self.dir / inputs.ITEMS).read_text(encoding="utf-8"), '{"inputs":"prev","rows":"prev"}\n')
        self.assertEqual((self.dir / inputs.INVENTORY_ITEMS).read_text(encoding="utf-8"), '{"inputs":"prev"}\n')

        staged_rows3 = self.dir / ".rows.jsonl.99999.tmp"
        staged_rows3.write_text('{"sha256":"new-0"}\n', encoding="utf-8")
        real_replace = inputs.os.replace
        calls = {"n": 0}

        def fail_third_replace(src, dst):
            calls["n"] += 1
            if calls["n"] == 3:
                raise OSError(5, "Input/output error mid-replacement")
            return real_replace(src, dst)

        with unittest.mock.patch.object(inputs.os, "replace", side_effect=fail_third_replace):
            with self.assertRaisesRegex(OSError, "Input/output error mid-replacement"):
                enospc_receipt.publish(self.dir, staged_rows3, out_rows, Path(__file__), "n" * 64)
        self.assertEqual(out_rows.read_text(encoding="utf-8"), '{"sha256":"prev"}\n')
        self.assertEqual((self.dir / inputs.EXPORT).read_text(encoding="utf-8"), '{"rows_sha256":"prev-export"}\n')
        self.assertEqual((self.dir / inputs.ITEMS).read_text(encoding="utf-8"), '{"inputs":"prev","rows":"prev"}\n')
        self.assertEqual((self.dir / inputs.INVENTORY_ITEMS).read_text(encoding="utf-8"), '{"inputs":"prev"}\n')


class DownloadPins(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.commit = 'a' * 40
        self.pin = 'github: fictional/corpus, ' + self.commit
        self.url = 'https://raw.githubusercontent.com/fictional/corpus/' + self.commit + '/data.zip'

    def receipt(self):
        artifact = inputs.pin_artifact(self.pin, self.url)
        inputs.mark_pin_mode(self.folder)
        data = b'fictional source bytes'
        (self.folder / 'data.zip').write_bytes(data)
        inputs.save_pin_receipt(self.folder, 'data.zip', self.pin, artifact, hashlib.sha256(data).hexdigest(), len(data))
        return artifact

    def test_artifact_identity_distinguishes_files_and_archive_formats(self):
        first = inputs.pin_artifact(self.pin, self.url)
        self.assertNotEqual(first, inputs.pin_artifact(self.pin, self.url.replace('data.zip', 'other.zip')))
        archive = 'https://github.com/fictional/corpus/archive/' + self.commit
        self.assertNotEqual(inputs.pin_artifact(self.pin, archive + '.zip'), inputs.pin_artifact(self.pin, archive + '.tar.gz'))
        with self.assertRaises(inputs.Refused):
            inputs.pin_artifact(self.pin, self.url.replace(self.commit, 'main'))

    def test_new_mode_manifest_consumes_first_digest(self):
        self.receipt()
        entries = [{'name': 'data.zip', 'published': None, 'pinned': self.pin}]
        manifest = inputs.build(self.folder, entries, 'CC0')
        self.assertIn('download_pin', manifest['files'][0])
        inputs.verify(self.folder, ['data.zip'])
        (self.folder / 'data.zip').write_bytes(b'changed source bytes')
        with self.assertRaises(inputs.Refused):
            inputs.build(self.folder, entries, 'CC0')

    def test_missing_receipt_cannot_fall_back_to_legacy_pin(self):
        self.receipt()
        inputs.pin_receipt_path(self.folder, 'data.zip').unlink()
        with self.assertRaises(inputs.Refused):
            inputs.build(self.folder, [{'name': 'data.zip', 'pinned': self.pin}], 'CC0')

    def test_first_receipt_is_never_replaced(self):
        artifact = self.receipt()
        path = inputs.pin_receipt_path(self.folder, 'data.zip')
        original = path.read_bytes()
        with self.assertRaises(inputs.Refused):
            inputs.save_pin_receipt(self.folder, 'data.zip', self.pin, artifact, 'b' * 64, 42)
        self.assertEqual(path.read_bytes(), original)

    def test_manifest_refuses_invalid_canonical_artifact(self):
        self.receipt()
        path = inputs.pin_receipt_path(self.folder, 'data.zip')
        row = json.loads(path.read_text())
        row['artifact']['revision'] = 'b' * 40
        path.write_text(json.dumps(row))
        with self.assertRaises(inputs.Refused):
            inputs.build(self.folder, [{'name': 'data.zip', 'pinned': self.pin}], 'CC0')

    def test_retry_syncs_existing_marker_after_directory_sync_failure(self):
        import os
        original = os.fsync
        def fail_directory(fd):
            if os.fstat(fd).st_ino == (self.folder / '.download-pins').stat().st_ino:
                raise OSError('synthetic directory sync failure')
            return original(fd)
        with unittest.mock.patch.object(inputs.os, 'fsync', side_effect=fail_directory):
            with self.assertRaises(OSError):
                inputs.mark_pin_mode(self.folder)
        self.assertTrue((self.folder / '.download-pins/.mode.json').exists())
        with unittest.mock.patch.object(inputs.os, 'fsync', wraps=original) as sync:
            inputs.mark_pin_mode(self.folder)
            self.assertGreaterEqual(sync.call_count, 2)

    def test_archive_receipt_accepts_null_file_path(self):
        self.url = 'https://github.com/fictional/corpus/archive/' + self.commit + '.zip'
        self.receipt()
        inputs.build(self.folder, [{'name': 'data.zip', 'pinned': self.pin}], 'CC0')
        inputs.verify(self.folder, ['data.zip'])

    def test_provider_redirects_stay_bound_to_artifact(self):
        archive = 'https://github.com/fictional/corpus/archive/' + self.commit + '.zip'
        artifact = inputs.pin_artifact(self.pin, archive)
        inputs.pin_redirect(artifact, self.pin, archive, 'https://codeload.github.com/fictional/corpus/zip/' + self.commit)
        with self.assertRaises(inputs.Refused):
            inputs.pin_redirect(artifact, self.pin, archive, 'https://example.com/data.zip')
        hp = 'huggingface: fictional/corpus, ' + self.commit
        hu = 'https://huggingface.co/datasets/fictional/corpus/resolve/' + self.commit + '/data.zip'
        ha = inputs.pin_artifact(hp, hu)
        inputs.pin_redirect(ha, hp, hu, 'https://cdn-lfs.huggingface.co/opaque')
        with self.assertRaises(inputs.Refused):
            inputs.pin_artifact(hp, 'https://cdn-lfs.huggingface.co/opaque')



if __name__ == "__main__":
    unittest.main()
