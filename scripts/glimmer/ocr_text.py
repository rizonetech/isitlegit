"""The text an OCR engine reads off each screenshot (D03 T04 §7): what a viewer of a stored sample page's picture
reads, so the leak check can look for a client detail the page text does not hold. Reads a JSON list of image paths on
stdin and writes a JSON list of their texts, one string per image, in order. RapidOCR on the CPU, in its own venv
(`~/.venvs/ocr`), so the project's Python needs no model."""
import json
import sys


def read_all(paths, engine=None):
    if engine is None:
        from rapidocr_onnxruntime import RapidOCR

        engine = RapidOCR()
    texts = []
    for path in paths:
        found, _ = engine(path)
        texts.append("\n".join(line[1] for line in (found or [])))
    return texts


def main() -> int:
    paths = json.load(sys.stdin)
    if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
        print("expected a JSON list of image paths", file=sys.stderr)
        return 2
    json.dump(read_all(paths), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
