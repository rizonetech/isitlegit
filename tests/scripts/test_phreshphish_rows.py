"""scripts/glimmer/phreshphish_rows.py (D03 T04 §5, §28): shards are read in batches, never whole, a failed export
leaves no temporary file and no half-written rows file, and every read is charged to `inputs.Limits` (row groups,
retained batches, the deadline). The fixtures are real Parquet files written with pyarrow."""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HAVE_DATA_TOOLS = importlib.util.find_spec("openpyxl") is not None and importlib.util.find_spec("pyarrow") is not None
if os.environ.get("REQUIRE_GLIMMER_DATA_TOOLS") == "1" and not HAVE_DATA_TOOLS:
    raise RuntimeError(
        "REQUIRE_GLIMMER_DATA_TOOLS=1 but openpyxl or pyarrow is missing: pip install -r scripts/glimmer/requirements.txt")
# The checks read real workbooks and Parquet files: they skip without those libraries locally and are required in CI,
# which sets REQUIRE_GLIMMER_DATA_TOOLS=1.
needs_data_tools = unittest.skipUnless(HAVE_DATA_TOOLS, "needs scripts/glimmer/requirements.txt (openpyxl, pyarrow)")
if HAVE_DATA_TOOLS:
    import pyarrow as pa
    import pyarrow.parquet as pq


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "phreshphish_rows.py"
spec = importlib.util.spec_from_file_location("phreshphish_rows", SCRIPT)
rows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rows)

SHARDS = ("train-000.parquet", "train-001.parquet")


def recording_parquet(fail_after=None):
    """The real pyarrow.parquet, recording each batch size asked for and optionally failing once `fail_after` rows
    of a shard have been read."""
    asked = []

    class ParquetFile(pq.ParquetFile):
        def iter_batches(self, batch_size=65536, **kwargs):
            asked.append((batch_size, tuple(kwargs["columns"])))
            for number, batch in enumerate(super().iter_batches(batch_size=batch_size, **kwargs)):
                if fail_after is not None and number * batch_size >= fail_after:
                    raise MemoryError("simulated")
                yield batch

    return SimpleNamespace(ParquetFile=ParquetFile), asked


def table(prefix, count, html="<p>page</p>", label="phish"):
    return pa.table({
        "sha256": [f"{prefix}{i}" for i in range(count)],
        "url": [f"https://{prefix}{i}.example/" for i in range(count)],
        "html": [html] * count,
        "label": [label] * count,
        "target": [None] * count,
    })


@needs_data_tools
class Rows(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="phresh-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.folder = self.dir / "raw" / "phreshphish"
        self.folder.mkdir(parents=True)
        patcher = mock.patch.dict(os.environ, {"GLIMMER_DATA_DIR": str(self.dir)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def shards(self, data, row_group_size=None):
        """Writes each named shard from its table and binds them in the manifest."""
        for name, content in data.items():
            pq.write_table(content, self.folder / name, row_group_size=row_group_size)
        rows.inputs_module.build(
            self.folder,
            [{"name": n, "published": None, "pinned": "huggingface: phreshphish/phreshphish, 0123456789abcdef0123456789abcdef01234567"} for n in data],
            "CC BY 4.0",
        )

    def limited(self, **bounds):
        return mock.patch.object(rows, "Limits", lambda: rows.inputs_module.Limits(**bounds))

    def assert_refused_and_earlier_rows_whole(self, pattern, **bounds):
        """The conversion is refused naming its limit; the earlier rows file is whole and nothing else is published."""
        (self.folder / "rows.jsonl").write_text("earlier\n")
        with self.limited(**bounds), mock.patch("sys.stderr") as stderr:
            self.assertEqual(rows.main(), 1)
        self.assertRegex("".join(call.args[0] for call in stderr.write.call_args_list), pattern)
        self.assertEqual((self.folder / "rows.jsonl").read_text(), "earlier\n")
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["INPUTS.json", "rows.jsonl", *SHARDS])

    def test_every_row_of_every_shard_is_written_in_batches(self):
        self.shards({SHARDS[0]: table("a", 450), SHARDS[1]: table("b", 1, label="benign")})
        parquet, asked = recording_parquet()
        with mock.patch("sys.stdout"):
            self.assertEqual(rows.main(parquet), 0)
        written = [json.loads(line) for line in (self.folder / "rows.jsonl").read_text().splitlines()]
        self.assertEqual(len(written), 451)
        self.assertEqual(written[-1]["sha256"], "b0")
        self.assertEqual({size for size, _ in asked}, {rows.BATCH_ROWS})
        self.assertIn("html", asked[0][1])

    def test_a_failure_leaves_no_temporary_or_partial_file(self):
        self.shards({SHARDS[0]: table("a", 450), SHARDS[1]: table("b", 0)})
        parquet, _ = recording_parquet(fail_after=200)
        with self.assertRaises(MemoryError):
            rows.main(parquet)
        # Only the shards and their manifest: no temporary file, no rows file, no receipt.
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["INPUTS.json", *SHARDS])

    def test_writes_a_receipt_and_refuses_a_shard_not_bound(self):
        self.shards({SHARDS[0]: table("a", 1), SHARDS[1]: table("b", 1)})
        with mock.patch("sys.stdout"):
            self.assertEqual(rows.main(), 0)
        receipt = json.loads((self.folder / "EXPORT.json").read_text())
        self.assertEqual((receipt["met"], receipt["exported"]), (2, 2))
        ledger = [json.loads(l) for l in (self.folder / "ITEMS.jsonl").read_text().splitlines()][1:]
        self.assertEqual([e["outcome"] for e in ledger], ["exported", "exported"])  # each row named, §28 G3
        pq.write_table(table("c", 1), self.folder / "train-002.parquet")
        with mock.patch("sys.stderr"):
            self.assertEqual(rows.main(), 1)

    def test_a_row_group_over_the_allocation_limit_is_refused_before_it_is_read(self):
        # One row group of 300 rows, a few KB of HTML each: far over a 1 KB allocation, so it is never decompressed.
        self.shards({SHARDS[0]: table("a", 300, html="<p>" + "x" * 2000 + "</p>"), SHARDS[1]: table("b", 1)})
        self.assert_refused_and_earlier_rows_whole("Parquet row group.*allocation limit", allocation=1000)

    def test_row_groups_are_charged_to_the_expanded_bytes(self):
        # Each group is small enough to read, but together they pass the expanded limit.
        self.shards({SHARDS[0]: table("a", 400, html="<p>" + "x" * 500 + "</p>"), SHARDS[1]: table("b", 1)},
                    row_group_size=100)
        group = pq.ParquetFile(self.folder / SHARDS[0]).metadata.row_group(0).total_byte_size
        self.assert_refused_and_earlier_rows_whole("bytes expanded", expanded=group * 2)

    def test_a_retained_byte_overrun_stops_at_its_limit(self):
        # A 200-row batch holds well over 1 KB; the groups themselves fit the allocation limit.
        self.shards({SHARDS[0]: table("a", 400, html="<p>" + "x" * 500 + "</p>"), SHARDS[1]: table("b", 1)})
        self.assert_refused_and_earlier_rows_whole("bytes retained at once", retained=1000)

    def test_batches_are_released_so_retained_bytes_do_not_add_up_across_a_shard(self):
        self.shards({SHARDS[0]: table("a", 1000, html="<p>" + "x" * 500 + "</p>"), SHARDS[1]: table("b", 1)})
        batch = next(pq.ParquetFile(self.folder / SHARDS[0]).iter_batches(batch_size=rows.BATCH_ROWS)).nbytes
        with self.limited(retained=batch * 2), mock.patch("sys.stdout"):
            self.assertEqual(rows.main(), 0)
        self.assertEqual(len((self.folder / "rows.jsonl").read_text().splitlines()), 1001)

    def test_a_slow_loop_stops_at_the_deadline_and_publishes_nothing(self):
        self.shards({SHARDS[0]: table("a", 1000), SHARDS[1]: table("b", 1)})
        ticks = iter(range(10**6))  # the fake clock advances one second a look
        with self.limited(seconds=50, clock=lambda: next(ticks)):
            (self.folder / "rows.jsonl").write_text("earlier\n")
            with mock.patch("sys.stderr") as stderr:
                self.assertEqual(rows.main(), 1)
        self.assertIn("passed 50 seconds", "".join(call.args[0] for call in stderr.write.call_args_list))
        self.assertEqual((self.folder / "rows.jsonl").read_text(), "earlier\n")
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["INPUTS.json", "rows.jsonl", *SHARDS])


if __name__ == "__main__":
    unittest.main()
