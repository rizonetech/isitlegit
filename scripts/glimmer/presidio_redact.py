#!/usr/bin/env python3
"""Microsoft Presidio as the redaction step, for the redaction benchmark's head-to-head (D03 T04 §19).

    ~/.venvs/presidio/bin/python -I scripts/glimmer/presidio_redact.py

A long-lived process, so the model loads once a run, as the dictionary pipeline's lists do: its first line on stdout
is `{"ready": true, ...}` with the library versions and the model's digest (SHA-256 over the model package's files),
then each JSON line on stdin, `{"html": ..., "deny": [...]}`, gets one line back, `{"html": ...}` with every entity
Presidio finds and every deny-list term (the same names, terms and domains the dictionary pipeline is given) replaced
by `[detail]`, or `{"error": ...}` naming the failure without any of the page's content. Synthetic benchmark pages
only: this never reads `samples/` or the store.
"""
import hashlib
import json
import sys
from importlib.metadata import version
from pathlib import Path

MAX_HTML = 200_000
MODEL = "en_core_web_lg"
ENTITIES = ["PERSON", "LOCATION", "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "IBAN_CODE", "URL", "DOMAIN"]


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


def main():
    from presidio_analyzer import AnalyzerEngine, PatternRecognizer
    from presidio_analyzer.nlp_engine import NlpEngineProvider
    from presidio_anonymizer import AnonymizerEngine
    from presidio_anonymizer.entities import OperatorConfig

    engine = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": MODEL}]}).create_engine()
    analyzer = AnalyzerEngine(nlp_engine=engine, supported_languages=["en"])
    anonymizer = AnonymizerEngine()
    replace = {"DEFAULT": OperatorConfig("replace", {"new_value": "[detail]"})}
    print(json.dumps({
        "ready": True,
        "versions": {name: version(name) for name in ("presidio-analyzer", "presidio-anonymizer", "spacy", MODEL)},
        "model_sha256": model_digest(MODEL),
        "entities": ENTITIES,
    }), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            html, deny = request["html"], request.get("deny", [])
            if not isinstance(html, str) or not isinstance(deny, list) or len(html) > MAX_HTML:
                raise ValueError("a request must hold html (a string of at most 200,000 characters) and a deny list")
            recognizers = [PatternRecognizer(supported_entity="DENIED", deny_list=[t for t in deny if isinstance(t, str) and t])] if deny else []
            results = analyzer.analyze(text=html, language="en", entities=ENTITIES + (["DENIED"] if deny else []),
                                       ad_hoc_recognizers=recognizers)
            answer = {"html": anonymizer.anonymize(text=html, analyzer_results=results, operators=replace).text}
        except Exception as error:  # one page's failure is that page's answer; the process goes on
            answer = {"error": error.__class__.__name__}
        print(json.dumps(answer), flush=True)


if __name__ == "__main__":
    main()
