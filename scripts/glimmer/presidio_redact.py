#!/usr/bin/env python3
"""Microsoft Presidio as the entity pass, for the redaction benchmark's head-to-head (D03 T04 §19).

    ~/.venvs/presidio/bin/python -I scripts/glimmer/presidio_redact.py --model-sha256 <digest>
    ~/.venvs/presidio/bin/python -I scripts/glimmer/presidio_redact.py --versions

The same contract as `entities.py`, so the benchmark runs Presidio through the very path the pass runs on
(`openEntityPass()` and `redactWithEntities()` in `redact.ts`: the same text extracted from the HTML, the same client
lists, the same replacement of each span's text in the HTML, the same post-render and unread-script refusals), and the
two differ in the detector alone (§19 completion review, excellence 7). Its first line on stdout is `{"ready": true,
"model": ..., "model_sha256": ..., "language": "en"}`, then each JSON line on stdin, `{"text": ...}`, gets one line back:
`{"spans": [{"start", "end", "label"}]}` for every PERSON (`person`) and LOCATION (`place`) Presidio's analyzer finds,
or `{"refused": <reason>}` in `entities.py`'s words. Presidio's pattern entities (email, phone, card, IBAN) are left out:
the shared rules in `redact()` already remove those kinds for both, and its URL and domain entities would remove the
link hosts a lure is learnt from. `--versions` prints the library versions and exits, for the benchmark's record.
Synthetic benchmark pages only: this never reads `samples/` or the store.
"""
import argparse
import importlib.util
import json
import sys
from importlib.metadata import version
from pathlib import Path

# `entities.py`'s model digest, text limit and unread-script rule, loaded from beside this file (`-I` keeps the script's
# directory off the import path).
_spec = importlib.util.spec_from_file_location("entities", Path(__file__).resolve().parent / "entities.py")
entities = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(entities)

MODEL = entities.MODEL
LABELS = {"PERSON": "person", "LOCATION": "place"}


def versions():
    return {name: version(name) for name in ("presidio-analyzer", "presidio-anonymizer", "spacy", MODEL)}


def answer(analyzer, request):
    text = request.get("text") if isinstance(request, dict) else None
    if not isinstance(text, str):
        return {"refused": "a request must hold text"}
    if len(text) > entities.MAX_TEXT:
        return {"refused": f"the text is over {entities.MAX_TEXT} characters"}
    script = entities.unread_script(text)
    if script:
        return {"refused": f"a name in {script} script would go unread"}
    found = analyzer.analyze(text=text, language="en", entities=list(LABELS))
    spans = sorted({(r.start, r.end, LABELS[r.entity_type]) for r in found if r.entity_type in LABELS and r.end > r.start})
    return {"spans": [{"start": start, "end": end, "label": label} for start, end, label in spans]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model-sha256", help="the pinned digest of the model's files")
    parser.add_argument("--versions", action="store_true", help="print the library versions and exit")
    args = parser.parse_args(argv)
    if args.versions:
        print(json.dumps(versions()), flush=True)
        return 0
    if not args.model_sha256:
        parser.error("--model-sha256 is required")
    try:
        from presidio_analyzer import AnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider

        digest = entities.model_digest(MODEL)
    except (ImportError, OSError):  # Presidio, spaCy or the model package is not installed in this interpreter
        print(json.dumps({"refused": "the model is not installed"}), flush=True)
        return 1
    if digest != args.model_sha256:
        print(json.dumps({"refused": "the model is not the pinned one"}), flush=True)
        return 1
    engine = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": MODEL}]}).create_engine()
    analyzer = AnalyzerEngine(nlp_engine=engine, supported_languages=["en"])
    print(json.dumps({"ready": True, "model": MODEL, "model_sha256": digest, "language": "en"}), flush=True)
    for line in sys.stdin:
        try:
            reply = answer(analyzer, json.loads(line))
        except Exception as error:  # one request's failure is its answer; the process goes on
            reply = {"refused": f"the request failed ({error.__class__.__name__})"}
        print(json.dumps(reply), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
