#!/usr/bin/env python3
"""The sample redaction's entity pass (D03 T04 §19): people and places a page names that no header or list gave.

    ~/.venvs/presidio/bin/python -I scripts/glimmer/entities.py --model-sha256 <digest>

A long-lived process: its first line on stdout is `{"ready": true, "model": ..., "model_sha256": ..., "language":
"en"}`, then each JSON line on stdin, `{"text": ...}`, gets one line back: `{"spans": [{"start", "end", "label"}]}` for
every person and place spaCy's English model finds (offsets into the text, in characters), or `{"refused": <reason>}`.
It refuses, rather than answer clean, a text over 200,000 characters and a text holding any letter or mark in a script the
English model does not read (every script but Latin, Common and Inherited, by the Unicode Script property, from
`unread-scripts.json`, the table `redact.ts` reads too): a name written there, however short, would go unseen. The
caller folds look-alike letters to Latin first (`skeleton()` in `redact.ts`), so a lure's `Thаndi` arrives as `Thandi`.
It does not start when the model is not installed, its files are not the pinned digest, or an installed package is not
the version `requirements-entities.txt` pins (`pins.py`). Failures name their kind, never the text. The caller
(`openEntityPass()` in `redact.ts`) bounds the time and size of each answer.
"""
import argparse
import bisect
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

MAX_TEXT = 200_000
MODEL = "en_core_web_lg"
LABELS = {"PERSON": "person", "GPE": "place", "LOC": "place", "FAC": "place"}
# The letters and marks the English model cannot read, as [first, last, script] code point ranges in order: one of them
# anywhere refuses the text. Built by `unread-scripts.ts` from the Unicode Script property.
UNREAD = [tuple(r) for r in json.loads((Path(__file__).resolve().parent / "unread-scripts.json").read_text())["ranges"]]
UNREAD_STARTS = [r[0] for r in UNREAD]
# The packages this environment must hold, at these versions, or the pass does not start (`pins.py`).
REQUIREMENTS = Path(__file__).resolve().parent / "requirements-entities.txt"


def load_pins():
    """`pins.py`, beside this file, loaded by path: `python -I` puts no script directory on the path."""
    spec = importlib.util.spec_from_file_location("pins", Path(__file__).resolve().parent / "pins.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def model_digest(name):
    """The model package's identity: SHA-256 over every file's relative path and bytes, in path order."""
    import spacy.util

    root = Path(spacy.util.get_package_path(name))
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file() and "__pycache__" not in p.parts):
        digest.update(str(path.relative_to(root)).encode() + b"\0")
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1 << 20), b""):
                digest.update(block)
    return digest.hexdigest()


def unread_script(text):
    """The script of the first letter or mark in `text` the model cannot read, or None."""
    for char in text:
        code = ord(char)
        at = bisect.bisect_right(UNREAD_STARTS, code) - 1
        if at >= 0 and UNREAD[at][1] >= code:
            return UNREAD[at][2]
    return None


def answer(nlp, request):
    text = request.get("text") if isinstance(request, dict) else None
    if not isinstance(text, str):
        return {"refused": "a request must hold text"}
    if len(text) > MAX_TEXT:
        return {"refused": f"the text is over {MAX_TEXT} characters"}
    script = unread_script(text)
    if script:
        return {"refused": f"a name in {script} script would go unread"}
    spans = [{"start": e.start_char, "end": e.end_char, "label": LABELS[e.label_]}
             for e in nlp(text).ents if e.label_ in LABELS]
    return {"spans": spans}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model-sha256", required=True, help="the pinned digest of the model's files")
    args = parser.parse_args(argv)
    try:
        import spacy

        digest = model_digest(MODEL)
    except (ImportError, OSError):  # spaCy or the model package is not installed in this interpreter
        print(json.dumps({"refused": "the model is not installed"}), flush=True)
        return 1
    unpinned = load_pins().mismatch(REQUIREMENTS)
    if unpinned:  # an upgraded or partly installed environment: what it would find was never audited
        print(json.dumps({"refused": unpinned}), flush=True)
        return 1
    if digest != args.model_sha256:
        print(json.dumps({"refused": "the model is not the pinned one"}), flush=True)
        return 1
    nlp = spacy.load(MODEL, exclude=["lemmatizer"])
    print(json.dumps({"ready": True, "model": MODEL, "model_sha256": digest, "language": "en"}), flush=True)
    for line in sys.stdin:
        try:
            reply = answer(nlp, json.loads(line))
        except Exception as error:  # one request's failure is its answer; the process goes on
            reply = {"refused": f"the request failed ({error.__class__.__name__})"}
        print(json.dumps(reply), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
