"""qpdf's side of the AES reading-time comparison (D06 T02 §6, completion review excellence item 2): each file opened
with the empty password and every stream and string read, 30 times, with p50 and p95 in milliseconds; the reader's own
side is the "AES reading time" test in test/invoice/pdf-filters.test.ts, on the same files. Peak RSS is the
process's, read from getrusage after the runs.

    <venv>/bin/python -I test/node/bench-pdf-aes.py
"""

import json
import resource
import statistics
import sys
import time
from pathlib import Path

import pikepdf

FILES = ["aes-r4.pdf", "aes-r6.pdf", "aes-r6-edited.pdf", "aes-r6-objstm-resaved.pdf"]
OUT = Path(__file__).resolve().parent.parent / "fixtures" / "pdf-encodings"


def read_all(path: Path) -> int:
    seen = 0
    with pikepdf.open(path, password="") as pdf:
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Stream):
                seen += len(obj.read_bytes())
            elif isinstance(obj, pikepdf.Dictionary):
                for v in obj.values():
                    if isinstance(v, pikepdf.String):
                        seen += len(bytes(v))
    return seen


def main() -> int:
    for name in FILES:
        times = []
        for _ in range(30):
            start = time.perf_counter()
            read_all(OUT / name)
            times.append((time.perf_counter() - start) * 1000)
        times.sort()
        print(json.dumps({"event": "aes-timing", "reader": "qpdf", "file": name, "p50": round(statistics.median(times), 2), "p95": round(times[int(len(times) * 0.95) - 1], 2)}))
    print(json.dumps({"peakRssMiB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1), "qpdf": pikepdf.__libqpdf_version__}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
