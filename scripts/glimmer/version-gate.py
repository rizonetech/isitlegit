#!/usr/bin/env python3
"""Whether a Loupe version may replace the one deployed (D03 T04 §13; operator, 2026-10-28 21:36 SAST: "on each version,
the aim is to increase the instructions, with better quality, less false positives and more detections").

    python3 scripts/glimmer/version-gate.py <new version> <previous version>

Reads each version's `<store>/runs/loupe-<version>/run.json` (the lines it trained on, `lines_trained`) and its held-out
measurement `<store>/runs/eval-<version>/metrics.json`, measured on the same evaluation file:

    {"eval_sha256": "...", "overall": {"lure_recall": 0.93, "false_alarm_rate": 0.02},
     "south_africa": {"lure_recall": 0.9, "false_alarm_rate": 0.03}}

and prints both versions' figures with their denominators, then `promote`, or `keep <previous>: <reason>`. The one
gate (operator, 2026-11-02, D03 T04 §47) is that the new version is better on the same held-out file: lure recall
higher with false alarms no higher, or false alarms lower with recall no lower. The South African slice prints and
is no longer a gate, and neither is the number of training lines. Exit 0 to promote, 1 to keep, 2 when a record is
missing or unreadable.
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


def figures(label, metrics):
    """One version's measured figures with their denominators, overall and on the South African slice."""
    out = []
    for slice_name in ("overall", "south_africa"):
        s = metrics.get(slice_name) or {}
        lures, benign = s.get("lures"), s.get("benign")
        recall, alarms = s.get("lure_recall"), s.get("false_alarm_rate")
        if isinstance(recall, (int, float)) and isinstance(alarms, (int, float)) and isinstance(lures, int) and isinstance(benign, int):
            out.append(
                f"{label} {slice_name}: lure recall {recall:.4f} ({round(recall * lures)}/{lures} lures), "
                f"false alarms {alarms:.4f} ({round(alarms * benign)}/{benign} benign)"
            )
        elif isinstance(recall, (int, float)) and isinstance(alarms, (int, float)):
            out.append(f"{label} {slice_name}: lure recall {recall:.4f}, false alarms {alarms:.4f} (denominators not recorded)")
    return out


def decide(new, previous):
    """`promote`, or the reason to keep the previous version. Each argument is (run, metrics)."""
    (new_run, new_m), (old_run, old_m) = new, previous
    if new_m.get("eval_sha256") != old_m.get("eval_sha256"):
        return "the two versions were not measured on the same held-out file"
    # Rates from a run with pages unanswered are not the version's figures: an unanswered benign page would lower its
    # false alarms. Both versions' records must be complete before they are compared (§13 completion review gap 1).
    for name, m in (("the new version", new_m), ("the previous version", old_m)):
        if m.get("bar_withheld"):
            return f"{name}'s evaluation is withheld: {m['bar_withheld']}"
        s = m.get("overall") or {}
        if s.get("complete") is not True or s.get("unanswered", 0) != 0:
            return f"{name}'s overall evaluation is incomplete ({s.get('unanswered', '?')} pages unanswered)"
    new_s, old_s = new_m.get("overall") or {}, old_m.get("overall") or {}
    for key in ("lure_recall", "false_alarm_rate"):
        if not isinstance(new_s.get(key), (int, float)) or not isinstance(old_s.get(key), (int, float)):
            return f"overall {key} is missing"
    # The operator's one gate (§47): better, exactly. More training lines and the South African slice are recorded
    # and printed, and neither vetoes a better version.
    better_recall = new_s["lure_recall"] > old_s["lure_recall"] and new_s["false_alarm_rate"] <= old_s["false_alarm_rate"]
    fewer_alarms = new_s["false_alarm_rate"] < old_s["false_alarm_rate"] and new_s["lure_recall"] >= old_s["lure_recall"]
    if better_recall or fewer_alarms:
        return "promote"
    if new_s["lure_recall"] == old_s["lure_recall"] and new_s["false_alarm_rate"] == old_s["false_alarm_rate"]:
        return f"overall lure recall {new_s['lure_recall']:.4f} and false alarms {new_s['false_alarm_rate']:.4f} are equal, not better"
    if new_s["lure_recall"] < old_s["lure_recall"]:
        return f"overall lure recall {new_s['lure_recall']:.4f} is below {old_s['lure_recall']:.4f}"
    return f"overall false-alarm rate {new_s['false_alarm_rate']:.4f} is above {old_s['false_alarm_rate']:.4f}"


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print("usage: python3 scripts/glimmer/version-gate.py <new version> <previous version>", file=sys.stderr)
        return 2
    new_version, old_version = args
    store = store_dir()
    try:
        new_records, old_records = records(store, new_version), records(store, old_version)
        verdict = decide(new_records, old_records)
    except (OSError, ValueError) as error:
        print(f"version-gate: a record is missing or unreadable ({type(error).__name__}: {error})", file=sys.stderr)
        return 2
    for line in figures(f"{new_version} (new)", new_records[1]) + figures(f"{old_version} (previous)", old_records[1]):
        print(line)
    if verdict == "promote":
        print("promote")
        return 0
    print(f"keep {old_version}: {verdict}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
