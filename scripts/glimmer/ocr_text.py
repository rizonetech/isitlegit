"""The text an OCR engine reads off each screenshot (D03 T04 §7): what a viewer of a stored sample page's picture
reads, so the leak check can look for a client detail the page text does not hold. Reads a JSON list of image paths on
stdin and writes a JSON list of their texts, one string per image, in order. RapidOCR on the CPU, in its own venv
(`~/.venvs/ocr`), so the project's Python needs no model. An image that is missing or does not load fails the whole run
(a traceback and a non-zero exit), never an empty text: a screenshot nobody read is not a screenshot that reads clean.
It does not start (exit 3, the reason on stderr) when an installed package is not the version `requirements-ocr.txt`
pins (`pins.py`): an upgraded engine was never audited."""
import importlib.util
import json
import sys
from pathlib import Path

REQUIREMENTS = Path(__file__).resolve().parent / "requirements-ocr.txt"


def load_pins():
    """`pins.py`, beside this file, loaded by path: `python -I` puts no script directory on the path."""
    spec = importlib.util.spec_from_file_location("pins", Path(__file__).resolve().parent / "pins.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def unpinned(requirements=REQUIREMENTS, version=None):
    """Why this environment is not the one `requirements` pins, or None. `version` stands in for the installed
    versions in tests."""
    pins = load_pins()
    return pins.mismatch(requirements) if version is None else pins.mismatch(requirements, version)


def read_all(paths, engine=None):
    missing = [p for p in paths if not Path(p).is_file()]
    if missing:
        raise FileNotFoundError(f"{len(missing)} screenshots are missing (first: {missing[0]})")
    if engine is None:
        from rapidocr_onnxruntime import RapidOCR

        engine = RapidOCR()
    texts = []
    for path in paths:
        found, _ = engine(path)
        texts.append("\n".join(line[1] for line in (found or [])))
    return texts


def main() -> int:
    refused = unpinned()
    if refused:
        print(refused, file=sys.stderr)
        return 3
    paths = json.load(sys.stdin)
    if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
        print("expected a JSON list of image paths", file=sys.stderr)
        return 2
    json.dump(read_all(paths), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
