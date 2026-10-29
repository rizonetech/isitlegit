#!/usr/bin/env python3
"""The downloaded PhreshPhish shards as JSONL rows for scripts/glimmer/import-phreshphish.ts (D03 T04 §5).

    ~/.venvs/fireworks/bin/python scripts/glimmer/phreshphish_rows.py

Reads `<store>/raw/phreshphish/train-*.parquet` (pyarrow, in the Fireworks venv) and writes `rows.jsonl` beside them,
temp-then-rename: one row a page with its sha256, url, html, label and target. Nothing is fetched or rendered here.
The shards are read in batches of 200 rows: a whole shard's HTML at once outgrew the machine's memory (2026-10-28).
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inputs as inputs_module
from inputs import Limits, Receipt, verify
from staging import remove_dead_staging


def store_dir():
    configured = os.environ.get("GLIMMER_DATA_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / "isitlegit-data" / "glimmer"


BATCH_ROWS = 200
COLUMNS = ["sha256", "url", "html", "label", "target"]


def main(parquet=None):
    if parquet is None:
        import pyarrow.parquet as parquet

    folder = store_dir() / "raw" / "phreshphish"
    shards = sorted(folder.glob("train-*.parquet"))
    if not shards:
        print(f"phreshphish-rows: no shards in {folder}", file=sys.stderr)
        return 2
    try:
        # Only shards bound in the manifest, unchanged since, are read.
        _, inputs_digest = verify(folder, [shard.name for shard in shards])
    except inputs_module.Refused as error:
        print(f"phreshphish-rows: refused ({error})", file=sys.stderr)
        return 1
    remove_dead_staging(folder)
    out = folder / "rows.jsonl"
    temporary = out.with_name(f".rows.jsonl.{os.getpid()}.tmp")
    receipt, limits = Receipt(), Limits()
    try:
        with temporary.open("w", encoding="utf-8") as sink:
            for shard in shards:
                for batch in parquet.ParquetFile(shard).iter_batches(batch_size=BATCH_ROWS, columns=COLUMNS):
                    for row in batch.to_pylist():
                        limits.count_entry()
                        sink.write(json.dumps(row, ensure_ascii=False) + "\n")
                        receipt.export()  # every row is exported; the importer accounts for what it stores
        os.replace(temporary, out)
    except inputs_module.Refused as error:
        temporary.unlink(missing_ok=True)
        print(f"phreshphish-rows: refused ({error})", file=sys.stderr)
        return 1
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    receipt.write(folder, out, Path(__file__), inputs_digest)
    print(f"phreshphish-rows: {receipt.exported} rows from {len(shards)} shards into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
