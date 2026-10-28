"""scripts/glimmer/phreshphish_rows.py (D03 T04 §5): shards are read in batches, never whole, and a failed export
leaves no temporary file and no half-written rows file."""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "phreshphish_rows.py"
spec = importlib.util.spec_from_file_location("phreshphish_rows", SCRIPT)
rows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rows)


def fake_parquet(per_shard, fail_after=None):
    """A stand-in for pyarrow.parquet whose files yield their rows in batches, recording each batch size asked for."""
    asked = []

    class ParquetFile:
        def __init__(self, path):
            self.path = path

        def iter_batches(self, batch_size, columns):
            asked.append((batch_size, tuple(columns)))
            data = per_shard[Path(self.path).name]
            for start in range(0, len(data), batch_size):
                if fail_after is not None and start >= fail_after:
                    raise MemoryError("simulated")
                yield SimpleNamespace(to_pylist=lambda chunk=data[start:start + batch_size]: chunk)

    return SimpleNamespace(ParquetFile=ParquetFile), asked


class Rows(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="phresh-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.folder = self.dir / "raw" / "phreshphish"
        self.folder.mkdir(parents=True)
        for name in ("train-000.parquet", "train-001.parquet"):
            (self.folder / name).write_bytes(b"")
        patcher = mock.patch.dict(os.environ, {"GLIMMER_DATA_DIR": str(self.dir)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_every_row_of_every_shard_is_written_in_batches(self):
        data = {"train-000.parquet": [{"sha256": f"a{i}", "label": "phish"} for i in range(450)],
                "train-001.parquet": [{"sha256": "b0", "label": "benign"}]}
        parquet, asked = fake_parquet(data)
        with mock.patch("sys.stdout"):
            self.assertEqual(rows.main(parquet), 0)
        written = [json.loads(line) for line in (self.folder / "rows.jsonl").read_text().splitlines()]
        self.assertEqual(len(written), 451)
        self.assertEqual(written[-1]["sha256"], "b0")
        self.assertEqual({size for size, _ in asked}, {rows.BATCH_ROWS})
        self.assertIn("html", asked[0][1])

    def test_a_failure_leaves_no_temporary_or_partial_file(self):
        data = {"train-000.parquet": [{"sha256": f"a{i}"} for i in range(450)], "train-001.parquet": []}
        parquet, _ = fake_parquet(data, fail_after=200)
        with self.assertRaises(MemoryError):
            rows.main(parquet)
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["train-000.parquet", "train-001.parquet"])


if __name__ == "__main__":
    unittest.main()
