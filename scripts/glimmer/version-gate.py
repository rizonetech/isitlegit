#!/usr/bin/env python3
"""Whether a Loupe version may replace the one deployed (D03 T04 §13; operator, 2026-10-28 21:36 SAST: "on each version,
the aim is to increase the instructions, with better quality, less false positives and more detections").

    python3 scripts/glimmer/version-gate.py <new version> <previous version>

Reads each version's `<store>/runs/loupe-<version>/run.json` (the lines it trained on, `lines_trained`) and its held-out
measurement `<store>/runs/eval-<version>/metrics.json`, measured on the same evaluation file:

    {"eval_sha256": "...", "overall": {"lure_recall": 0.93, "false_alarm_rate": 0.02},
     "south_africa": {"lure_recall": 0.9, "false_alarm_rate": 0.03}}

and prints `promote`, or `keep <previous>: <reason>` for the first rule the new version breaks: more training lines, a
lure recall at least the previous one's and a false-alarm rate no higher, overall and on the South African slice, both
measured on the same held-out file. Exit 0 to promote, 1 to keep, 2 when a record is missing or unreadable.
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
    if new_lines <= old_lines:
        return f"it trained on {new_lines} lines, not more than {old_lines}"
    for slice_name in ("overall", "south_africa"):
        new_s, old_s = new_m.get(slice_name) or {}, old_m.get(slice_name) or {}
        for key in ("lure_recall", "false_alarm_rate"):
            if not isinstance(new_s.get(key), (int, float)) or not isinstance(old_s.get(key), (int, float)):
                return f"{slice_name} {key} is missing"
        if new_s["lure_recall"] < old_s["lure_recall"]:
            return f"{slice_name} lure recall {new_s['lure_recall']:.4f} is below {old_s['lure_recall']:.4f}"
        if new_s["false_alarm_rate"] > old_s["false_alarm_rate"]:
            return f"{slice_name} false-alarm rate {new_s['false_alarm_rate']:.4f} is above {old_s['false_alarm_rate']:.4f}"
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
