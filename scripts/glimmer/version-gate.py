#!/usr/bin/env python3
"""Whether a Loupe version may replace the one deployed (D03 T04 §13; operator, 2026-11-02 00:25 SAST: the
broken-model guard is the only gate; the 5 percent false-alarm figure and the project's 2 percent target are
reporting figures, never blockers).

    python3 scripts/glimmer/version-gate.py <new version> <previous version>

Reads each version's `<store>/runs/loupe-<version>/run.json` (the lines it trained on, `lines_trained`) and its held-out
measurement `<store>/runs/eval-<version>/metrics.json`, measured on the same evaluation file:

    {"eval_sha256": "...", "overall": {"lure_recall": 0.93, "false_alarm_rate": 0.02},
     "south_africa": {"lure_recall": 0.9, "false_alarm_rate": 0.03}}

and prints `promote`, or `keep <previous>: <reason>`. The previous version is kept only when the record cannot be
trusted (the two versions were not measured on the same held-out file, an evaluation is incomplete or withheld, a
metric is missing) or the new version is broken: a false-alarm rate over 10 percent, a lure recall under 40
percent, or systemic invalid answers (an unanswered count in the record), overall or on the South African slice.
The relative figures (lines trained, recall and false alarms beside the previous version's) are read for the
report the caller prints; they never block. Exit 0 to promote, 1 to keep, 2 when a record is missing or unreadable.
"""
import json
import os
import sys
from pathlib import Path


def store_dir():
    configured = os.environ.get("GLIMMER_DATA_DIR")
    return Path(configured).expanduser() if configured else Path.home() / "isitlegit-data" / "glimmer"


def records(store, version):
    run = json.loads((store / "runs" / f"loupe-{version}" / "run.json").read_text(encoding="utf-8"))
    metrics = json.loads((store / "runs" / f"eval-{version}" / "metrics.json").read_text(encoding="utf-8"))
    return run, metrics


def decide(new, previous):
    """`promote`, or the reason to keep the previous version. Each argument is (run, metrics)."""
    (new_run, new_m), (old_run, old_m) = new, previous
    if new_m.get("eval_sha256") != old_m.get("eval_sha256"):
        return "the two versions were not measured on the same held-out file"
    new_lines, old_lines = new_run.get("lines_trained"), old_run.get("lines_trained")
    if not isinstance(new_lines, int) or not isinstance(old_lines, int):
        return "a run.json does not record lines_trained"
    # Rates from a run with pages unanswered are not the version's figures: an unanswered benign page would lower its
    # false alarms. Both versions' records must be complete before they are compared (§13 completion review gap 1).
    for name, m in (("the new version", new_m), ("the previous version", old_m)):
        if m.get("bar_withheld"):
            return f"{name}'s evaluation is withheld: {m['bar_withheld']}"
        for slice_name in ("overall", "south_africa"):
            s = m.get(slice_name) or {}
            if s.get("complete") is not True or s.get("unanswered", 0) != 0:
                return f"{name}'s {slice_name} evaluation is incomplete ({s.get('unanswered', '?')} pages unanswered)"
    for slice_name in ("overall", "south_africa"):
        new_s, old_s = new_m.get(slice_name) or {}, old_m.get(slice_name) or {}
        for key in ("lure_recall", "false_alarm_rate"):
            if not isinstance(new_s.get(key), (int, float)) or not isinstance(old_s.get(key), (int, float)):
                return f"{slice_name} {key} is missing"
    # The broken-model guard (operator, 2026-11-02): the only quality lines that keep the previous version.
    # The new version's figures beside the previous one's are reported by the caller, never compared here.
    for slice_name in ("overall", "south_africa"):
        new_s = new_m.get(slice_name) or {}
        if new_s["false_alarm_rate"] > 0.10:
            return f"{slice_name} false-alarm rate {new_s['false_alarm_rate']:.4f} is over the 10 percent broken line"
        if new_s["lure_recall"] < 0.40:
            return f"{slice_name} lure recall {new_s['lure_recall']:.4f} is under the 40 percent broken line"
    return "promote"


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print("usage: python3 scripts/glimmer/version-gate.py <new version> <previous version>", file=sys.stderr)
        return 2
    new_version, old_version = args
    store = store_dir()
    try:
        verdict = decide(records(store, new_version), records(store, old_version))
    except (OSError, ValueError) as error:
        print(f"version-gate: a record is missing or unreadable ({type(error).__name__}: {error})", file=sys.stderr)
        return 2
    if verdict == "promote":
        print("promote")
        return 0
    print(f"keep {old_version}: {verdict}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
