#!/usr/bin/env python3
"""Loupe's model card, one part per version, made only from the run's own records (D03 T04 §17; operator,
2026-10-28 18:50 SAST: "the model needs detailed stats").

    python3 scripts/glimmer/model_card.py <version>    # write the version's card
    python3 scripts/glimmer/model_card.py --check      # every version under Training has a complete card

Reads `docs/glimmer/dataset-<version>.json` (§10), `<store>/runs/loupe-<version>/run.json` and `metrics.jsonl` (§11),
`<store>/runs/eval-<version>/metrics.json` (§13: Loupe's figures at the top level, Spark's under `spark`, the bar and
the misses by cause) and the `Deployment` lines of `docs/glimmer/training.md` (§12). Writes
`docs/glimmer/loupe-<version>.json`, the loss chart `docs/glimmer/loupe-<version>-loss.svg` (one point a step) and the
version's part of `docs/glimmer/model-card.md`, each temp-then-rename. A figure is never typed: the check rebuilds every
card from its records and fails when one differs or a part is empty.
"""
import json
import math
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs" / "glimmer"
BASE = "Muse Glimmer 30B (accounts/fireworks/models/muse-glimmer-30b)"
METHOD = "LoRA supervised fine-tuning on Fireworks' Serverless Training API (the Fireworks cookbook's SFT loop)"
USE = ("Screening candidate pages for IsItLegit's impersonation monitor: a first answer on whether a page is a brand "
       "lure with a login or payment form, never the final verdict, which the evidence rules and Muse Spark decide.")
# The project's own standard for Loupe (operator, 2026-10-31 18:49 SAST), set for 1.1 as the target it is built to meet,
# not a promise: false alarms at most 2 percent, and lure recall above Muse Wonder's on the same pages. A Wonder figure
# is shown only once it is measured; until then the card says so.
STANDARD = {"false_alarm_rate_at_most": 0.02, "lure_recall_above": "Muse Wonder", "set_for": "1.1"}
# Where 1.1's work is planned (the loupe lane, operator 2026-10-31 18:55 SAST).
NEXT_WORK = "D03 T04 §25 and §27 to §29"
NOT_TRAINED_ON = ("Live pages that need scripts to show their content (rendered inertly, they were left out), pages behind "
                  "a sign-in, and languages the public datasets hold few pages of.")


def store_dir():
    configured = os.environ.get("GLIMMER_DATA_DIR")
    return Path(configured).expanduser() if configured else Path.home() / "isitlegit-data" / "glimmer"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def section(markdown, heading):
    match = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", markdown, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else ""


def versions_trained(markdown):
    """Every version the Training record names (`Loupe <version>: isitlegit-loupe-...`)."""
    return sorted(set(re.findall(r"Loupe (\d+\.\d+): isitlegit-loupe-", section(markdown, "Training"))),
                  key=lambda v: tuple(int(x) for x in v.split(".")))


def loss_svg(points, width=640, height=260, pad=44):
    """A line chart of loss by step, one point a step, with labelled axes and numeric ticks, drawn from the run's metrics
    (§17 completion review E2); its numbers are also in the step table beside it (`loss_csv`)."""
    if not points:
        return '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="260"></svg>\n'
    steps = [s for s, _ in points]
    losses = [l for _, l in points]
    lo, hi = min(losses), max(losses)
    first, last = min(steps), max(steps)
    span_x = (last - first) or 1
    span_y = (hi - lo) or 1
    xy = [(pad + (s - first) / span_x * (width - 2 * pad), height - pad - (l - lo) / span_y * (height - 2 * pad))
          for s, l in points]
    path = " ".join(f"{x:.1f},{y:.1f}" for x, y in xy)
    circles = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="0.8" fill="currentColor"/>' for x, y in xy)
    # Ticks: three on each axis, each labelled with its number; text and lines take the reader's colour (light or dark).
    xt = [(first, pad), ((first + last) // 2, pad + (width - 2 * pad) / 2), (last, width - pad)]
    yt = [(lo, height - pad), ((lo + hi) / 2, height / 2), (hi, pad)]
    axes = (f'<g stroke="currentColor" stroke-width="1" fill="none"><line x1="{pad}" y1="{height - pad}" x2="{width - pad}" '
            f'y2="{height - pad}"/><line x1="{pad}" y1="{pad}" x2="{pad}" y2="{height - pad}"/></g><g font-size="10" '
            f'fill="currentColor">'
            + "".join(f'<text x="{x:.1f}" y="{height - pad + 14}" text-anchor="middle">{step}</text>' for step, x in xt)
            + "".join(f'<text x="{pad - 6}" y="{y + 3:.1f}" text-anchor="end">{loss:.3f}</text>' for loss, y in yt)
            + f'<text x="{width / 2}" y="{height - 8}" text-anchor="middle">step</text>'
            f'<text x="12" y="{height / 2}" text-anchor="middle" transform="rotate(-90 12 {height / 2})">loss</text></g>')
    summary = f"Training loss by step: {hi:.3f} at step {first} to {lo:.3f} at its lowest, {losses[-1]:.3f} at step {last}."
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" role="img" '
            f'aria-labelledby="t d">\n<title id="t">Training loss by step</title><desc id="d">{summary} The same numbers are '
            f'in the step table beside this chart.</desc>\n{axes}\n<polyline fill="none" stroke="currentColor" '
            f'stroke-width="1.5" points="{path}"/>\n<g>{circles}</g>\n</svg>\n')


def loss_csv(points):
    """The chart's numbers as a table: one row a step, from the same metrics."""
    return "step,loss\n" + "".join(f"{step},{loss}\n" for step, loss in points)


# The deployment's running-time rule (operator, 2026-10-31 22:16 SAST, D03 T04 §34), as the ledger holds it.
MINUTES_RULE = ("30 minutes a day on average since 2026-10-31, with one day borrowed ahead (unused minutes roll over); "
                "warm-up and the 6-minute tail after the last request are counted")


def training_record(version, markdown):
    """What the trainer recorded at training time under `Training`: the lines it trained of the dataset's, and the dataset's
    digest (`Loupe <v>: isitlegit-loupe-..., set N of M lines (...), dataset <sha>`). None when the record names no digest."""
    for line in section(markdown, "Training").splitlines():
        found = re.search(rf"^- Loupe {re.escape(version)}: isitlegit-loupe-\S+, set (\d+) of (\d+) lines.*?dataset ([0-9a-f]{{64}})", line)
        if found:
            return {"trained": int(found.group(1)), "available": int(found.group(2)), "sha256": found.group(3)}
    return None


def bound_to(version, line):
    """Whether a record line is about this version: it names the version's model (`isitlegit-loupe-1-0`) or the version
    in a command or a heading (`ensure 1.0`, `Loupe 1.0`), so a later version never inherits an earlier one's."""
    slug = f"isitlegit-loupe-{version.replace('.', '-')}"
    return slug in line or re.search(rf"(?<![\d.]){re.escape(version)}(?![\d.])", line) is not None


# The benign render lists are kept out of the sources table (their pages are our own renders; docs/glimmer/sources.md,
# the paragraph on them), so their licence and link are stated here from that paragraph.
RENDER_LISTS = {
    "benign-majestic": {"dataset": "https://majestic.com/reports/majestic-million (top 20,576 domains, rendered by us)",
                        "licence": "CC BY 3.0 (Majestic)", "licence_link": "https://majestic.com/reports/majestic-million"},
    "benign-sa": {"dataset": "eval/glimmer/benign-sa-urls.txt (our own list, rendered by us)", "licence": "own list",
                  "licence_link": "not applicable: IsItLegit's own"},
}
# Pilot-client mail is used only redacted and under the client's written consent (D03 T04 §7); the explanation names no
# client and no detail.
PRIVATE_SOURCES = {
    "samples-body": {"dataset": "private pilot-client mail, redacted before any use (D03 T04 §7)",
                     "licence": "the client's written consent for redacted training",
                     "licence_link": "not published: the consent is kept privately and names the client"},
}


def source_records(version_sources):
    """Each training source's dataset, licence and licence link from `docs/glimmer/sources.md`, apart; the render lists
    and the private source from their own records; "not recorded" for one nothing names."""
    text = (DOCS / "sources.md").read_text(encoding="utf-8") if (DOCS / "sources.md").is_file() else ""
    found = {}
    for row in text.splitlines():
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        if row.startswith("|") and len(cells) >= 4 and cells[0].startswith("`"):
            found[cells[0].strip("`")] = {"dataset": cells[1], "licence": cells[2], "licence_link": cells[3]}
    known = {**RENDER_LISTS, **PRIVATE_SOURCES, **found}
    blank = {"dataset": "not recorded", "licence": "not recorded", "licence_link": "not recorded"}
    return {name: known.get(name, blank) for name in sorted(version_sources)}


def recorded_findings(version, store):
    """What else is recorded about the version's mistakes, each labelled with its scope and denominator: the reference
    set's confirmed causes (§13) and the synthetic monitor pages (§1), the latter never a production estimate."""
    found = {}
    refs = store / "runs" / f"eval-{version}" / "reference" / "loupe.causes.json"
    if refs.is_file():
        record = read_json(refs)
        if not record.get("unconfirmed"):
            found["reference_causes"] = {"errors": len(record.get("pages") or []), "confirmed": record.get("confirmed")}
    metrics = ROOT / "eval" / "glimmer" / "monitor-pages" / "runs" / "metrics.json"
    identity = ROOT / "eval" / "glimmer" / "monitor-pages" / "runs" / "loupe.identity.json"
    if metrics.is_file() and identity.is_file() and bound_to(version, read_json(identity).get("model", "")):
        production = read_json(metrics).get("production") or {}
        found["monitor_pages"] = {k: production.get(k) for k in ("pages", "loupe_answered", "spark_fallbacks", "lure_recall",
                                                                  "false_alarm_rate", "latency_median_ms")}
    return found


def warmups(store, deployment, version=None):
    """The cold starts measured on the dedicated deployment: each receipt under `runs/warmup/` (§13), and §12's key
    check, whose cold start is recorded in the `Deployment` lines. None for a figure with no record."""
    folder = store / "runs" / "warmup"
    receipts = [read_json(f) for f in sorted(folder.glob("*.json"))] if folder.is_dir() else []
    receipts = [r for r in receipts if version is None or r.get("version") == version]
    cold = sorted(r["warmup_ms"] / 1000 for r in receipts if r.get("cold") and isinstance(r.get("warmup_ms"), (int, float)))
    zero = sorted(r["zero_ms_after_last_request"] / 1000 for r in receipts
                  if isinstance(r.get("zero_ms_after_last_request"), (int, float)))
    key = None
    for line in deployment:
        found = re.search(r"after \d+ attempts and ([\d.]+) s of cold start", line)
        if found:
            key = float(found.group(1))
    every = sorted(cold + ([key] if key is not None else []))
    middle = len(every) // 2
    median = None if not every else (every[middle] if len(every) % 2 else (every[middle - 1] + every[middle]) / 2)
    return {"cold_starts": len(every), "from_receipts": len(cold), "key_check_s": key,
            "median_s": None if median is None else round(median, 1), "max_s": None if not every else round(every[-1], 1),
            "scale_to_zero_s_min": None if not zero else round(zero[0]), "scale_to_zero_s_max": None if not zero else round(zero[-1])}


def build(version, store, markdown, previous=None):
    """The version's card as data, every figure read from its records."""
    dataset = read_json(DOCS / f"dataset-{version}.json")
    run_dir = store / "runs" / f"loupe-{version}"
    run = read_json(run_dir / "run.json")
    lines = [json.loads(l) for l in (run_dir / "metrics.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    evaluation = read_json(store / "runs" / f"eval-{version}" / "metrics.json")
    causes_file = store / "runs" / f"eval-{version}" / "loupe.causes.json"
    causes = read_json(causes_file) if causes_file.is_file() else {}
    deployment = [l[2:] for l in section(markdown, "Deployment").splitlines() if l.startswith("- ") and bound_to(version, l)]
    # Cross-record validation: a card is never made from records that do not describe one version (§17 plan review).
    if evaluation.get("eval_sha256") != dataset["eval"]["sha256"]:
        raise ValueError(f"the evaluation was run on another held-out file ({evaluation.get('eval_sha256')}) than the "
                         f"dataset record's ({dataset['eval']['sha256']})")
    steps = [l.get("step") for l in lines]
    if len(steps) != len(set(steps)) or (run.get("steps") is not None and len(set(steps)) != run["steps"]):
        raise ValueError(f"metrics.jsonl holds {len(set(steps))} distinct steps in {len(steps)} lines, run.json says "
                         f"{run.get('steps')}")
    # Every recorded step carries a finite loss: the chart and its table would otherwise have fewer points than steps
    # without saying so (round 2). The run's first and last losses are the metrics'.
    unusable = [l.get("step") for l in lines if not (isinstance(l.get("loss"), (int, float)) and math.isfinite(l["loss"]))]
    if unusable:
        raise ValueError(f"metrics.jsonl has no finite loss at {len(unusable)} step(s), the first being step {unusable[0]}")
    if lines and (abs(lines[0]["loss"] - run.get("first_loss", lines[0]["loss"])) > 1e-9
                  or abs(lines[-1]["loss"] - run.get("last_loss", lines[-1]["loss"])) > 1e-9):
        raise ValueError("run.json's first or last loss is not the metrics' (step "
                         f"{lines[0].get('step')} or {lines[-1].get('step')})")
    norms = sorted(l["grad_norm"] for l in lines if isinstance(l.get("grad_norm"), (int, float)))
    # The training record binds to what was trained: the trainer's selection (when kept) names the file's digest, and the
    # lines trained are the dataset's, or the selection's cut (§17 completion review C3).
    trained = training_record(version, markdown)
    if trained is None:
        raise ValueError("the Training record in docs/glimmer/training.md names no dataset digest for this version, so what "
                         "was trained cannot be bound to the dataset record")
    if trained["sha256"] != dataset["train"]["sha256"]:
        raise ValueError(f"the Training record's dataset digest {trained['sha256']} is not the dataset record's "
                         f"{dataset['train']['sha256']}")
    if trained["available"] != dataset["train"]["lines"] or trained["trained"] != run.get("lines_trained"):
        raise ValueError(f"the Training record trained {trained['trained']} of {trained['available']} lines, run.json "
                         f"{run.get('lines_trained')} and the dataset record's file {dataset['train']['lines']}")
    selection = run_dir / "selection.json"
    if selection.is_file():
        chosen = read_json(selection)
        if chosen.get("file_sha") not in (dataset["train"]["sha256"], None) and chosen.get("dataset_sha") != dataset["train"]["sha256"]:
            raise ValueError(f"the trainer's selection names training file {chosen.get('file_sha')}, the dataset record's is "
                             f"{dataset['train']['sha256']}")
        if run.get("lines_trained") != chosen.get("lines"):
            raise ValueError(f"run.json trained {run.get('lines_trained')} lines, the selection chose {chosen.get('lines')}")
    output = run_dir / "output-model.json"
    promoted = read_json(output) if output.is_file() else {}
    if promoted.get("model_id") not in (None, run.get("model_id")):
        raise ValueError(f"output-model.json names {promoted.get('model_id')}, run.json {run.get('model_id')}")
    points = [(l["step"], l["loss"]) for l in lines if isinstance(l.get("loss"), (int, float))]
    hp = run.get("hyperparameters") or {}
    card = {
        "version": version,
        "identity": {
            "model_id": run.get("model_id"), "base_model": BASE, "method": METHOD,
            "rank": hp.get("lora_rank"), "learning_rate": hp.get("learning_rate"), "batch_size": hp.get("batch_size"),
            "epochs": hp.get("epochs"), "started": run.get("started"), "ended": run.get("ended"),
            "sessions": run.get("sessions"),
            # The checkpoint promoted to the model: run.json does not record which; null says so on the card.
            "checkpoint": promoted.get("checkpoint") or run.get("checkpoint") or run.get("promoted_checkpoint"),
        },
        "data": {
            "train": {k: dataset["train"][k] for k in ("lines", "sha256", "by_origin", "by_source", "by_lure_type",
                                                       "south_africa", "brands", "screenshots")},
            "eval": {k: dataset["eval"][k] for k in ("lines", "sha256", "by_origin", "by_source", "by_lure_type",
                                                     "south_africa", "brands", "screenshots")},
            "lines_trained": run.get("lines_trained"),
            # True when the trainer cut the dataset to fit its limits: the breakdowns then describe what was available.
            "subset": run.get("lines_trained") != dataset["train"]["lines"],
        },
        "tokens": {**dataset["train"]["tokens"],
                   "image_per_screenshot": round(dataset["train"]["tokens"]["image"] / max(1, dataset["train"]["screenshots"]))},
        "sources": source_records(dataset["train"]["by_source"]),
        "run": {
            "steps": run.get("steps"), "first_loss": run.get("first_loss"), "last_loss": run.get("last_loss"),
            "tokens_sent": run.get("tokens_sent"), "rated_usd": run.get("rated_usd"), "resumes": run.get("resumes"),
            # What was billed, apart from the list price: null while the bill is pending (§30).
            "billed_usd": billed(version, markdown),
            "seconds_per_step": round(lines[-1]["seconds"] / max(1, len(lines)), 2) if lines else None,
            "wall_seconds": round(lines[-1]["seconds"]) if lines else None,
            "sessions_used": len(run.get("sessions") or []),
            "grad_norm": ({"min": norms[0], "median": norms[len(norms) // 2], "max": norms[-1]} if norms else None),
            "loss_chart": f"loupe-{version}-loss.svg",
            "loss_table": f"loupe-{version}-loss.csv",
        },
        "results": {
            # False alarms by benign source and recall on the redacted samples (D03 T04 §13, from §6 gap 20 and §7
            # gap 18), beside the overall, South African and lure-type figures.
            "loupe": {k: evaluation.get(k) for k in ("overall", "south_africa", "by_lure_type", "by_benign_source",
                                                     "samples")},
            "spark": evaluation.get("spark"),
            "bar": evaluation.get("bar"),
            "bar_withheld": evaluation.get("bar_withheld"),
            # The independent reference set (§13): drawn before any teacher check, so Spark's errors count against it.
            "reference": evaluation.get("reference"),
            "misses_by_cause": evaluation.get("misses_by_cause"),
            # The causes Claude confirmed for each miss and false alarm (§13), by count; null before they are sorted.
            "confirmed_causes": causes.get("confirmed") if causes and not causes.get("unconfirmed") else None,
            "bar_both_sets": evaluation.get("bar_both_sets"),
            "standard": {**STANDARD, "wonder_lure_recall": None, "next_work": NEXT_WORK},
            "eval_sha256": evaluation.get("eval_sha256"),
        },
        "deployment": deployment,
        "warmup": warmups(store, deployment, version),
        "minutes": MINUTES_RULE,
        "limits": {"not_trained_on": NOT_TRAINED_ON, "intended_use": USE,
                   "evaluation_selection": EVALUATION_SELECTION, "recorded": recorded_findings(version, store)},
    }
    if previous:
        card["results"]["previous"] = {
            "version": previous["version"], "lines_trained": previous["data"]["lines_trained"],
            "overall": previous["results"]["loupe"]["overall"],
        }
    return card, loss_svg(points), loss_csv(points)


# Figures whose empty value is itself the record: a cost not known per page (Loupe's deployment is billed by GPU time),
# a list of misses or false alarms that has none, and a withheld-bar reason once the bar is drawn.
RECORDED_EMPTY = {"billed_usd", "cost_per_page_usd", "missed", "false_alarms", "bar_withheld", "wonder_lure_recall", "misses_by_cause",
                  "passed",  # a slice not judged has no `passed`
                  "checkpoint", "grad_norm", "deployment", "recorded", "key_check_s", "median_s", "max_s", "scale_to_zero_s_min", "scale_to_zero_s_max"}  # a measurement not taken has no record


def missing(card):
    """Every empty part or figure of a card, by its path (`RECORDED_EMPTY` aside)."""
    gaps = []

    def walk(value, path, parent=None):
        key = path.rsplit(".", 1)[-1]
        if key in RECORDED_EMPTY and value in (None, [], {}):
            return
        # A ratio with no denominator is empty by definition, not missing: recall and lure-type accuracy on a slice with
        # no lures, false alarms on one with no benign page, and a slice's lure types when it holds no lure.
        if isinstance(parent, dict) and value in (None, {}):
            none_of = {"lure_recall": "lures", "lure_type_accuracy": "lures", "loupe_lure_recall": "lures",
                       "spark_lure_recall": "lures", "false_alarm_rate": "benign", "loupe_false_alarm_rate": "benign",
                       "accuracy": "pages", "latency_median_ms": "pages"}.get(key)
            if none_of and parent.get(none_of) == 0:
                return
        if key == "south_africa_lure_types" and value == {}:
            return
        if value is None or value == "" or value == [] or value == {}:
            gaps.append(path)
        elif isinstance(value, dict):
            for inner_key, inner in value.items():
                walk(inner, f"{path}.{inner_key}", value)

    walk(card, "card")
    return gaps


def billed(version, markdown):
    """What Fireworks billed for the version's training, from its settled line under `Training` (D03 T04 §30:
    `Loupe <version> ... reconciled: US$<amount>`), or None while it is pending. The rated amount is the list price, never
    the spend."""
    found = re.findall(rf"^- .*Loupe {re.escape(version)}\b.*reconciled: US\$(\d+(?:\.\d+)?)", section(markdown, "Training"),
                       re.MULTILINE)
    return float(found[-1]) if found else None


def pct(rate, of):
    """A rate as a percentage with its count: "6.6% (12 of 183)"; "n/a" with no denominator."""
    if rate is None or not of:
        return "n/a"
    return f"{rate * 100:.1f}% ({round(rate * of)} of {of})"


def counts(by):
    """A breakdown as `name n` pairs, largest first."""
    return ", ".join(f"{k} {v}" for k, v in sorted(by.items(), key=lambda kv: (-kv[1], kv[0])))


def anchor(heading):
    """A heading's link target, as the rendered page makes it: lower case, punctuation dropped, spaces as hyphens."""
    return re.sub(r"[^a-z0-9 -]", "", heading.lower()).replace(" ", "-")


def lure_name(name):
    return name.replace("_", " ")


def deployment_summary(card):
    """One line of the version's current deployment state, from its first recorded entry (the creation), or a pointer
    to the record when that entry does not state it (§17 completion review E3)."""
    entry = (card["deployment"] or [""])[0]
    name = re.search(r"created `(accounts/[^`]+/deployments/[^`]+)`", entry)
    gpu = re.search(r"on (\d+ x [A-Z0-9_]+)", entry)
    limits = re.search(r"minimum (\d+), maximum (\d+), scale to zero (\d+)s", entry)
    if not card["deployment"]:
        return "Deployment: not deployed: no deployment is recorded for this version."
    if not (name and gpu and limits):
        return "Deployment: see the record below."
    return (f"Deployment: `{name.group(1)}` on {gpu.group(1)}, minimum {limits.group(1)} and maximum {limits.group(2)} "
            f"replicas, scaling to zero after {limits.group(3)} idle seconds.")


def slice_rows(res):
    """The South African slice and each lure type, Loupe and Muse Spark in turn, every figure with its count."""
    loupe, spark = res["loupe"], (res.get("spark") or {})
    rows = ["", "| Slice | Screener | Pages | Lure recall | False alarms | Accuracy | Median latency | Cost per page |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    named = [("South Africa", loupe["south_africa"], spark.get("south_africa") or {})]
    named += [(lure_name(name), o, (spark.get("by_lure_type") or {}).get(name) or {})
              for name, o in sorted(loupe["by_lure_type"].items())]
    for name, o, sp in named:
        for who, f in (("Loupe", o), ("Muse Spark", sp)):
            rows.append(f"| {name} | {who} | {f.get('pages')} ({f.get('lures')} lures, {f.get('benign')} benign) | "
                        f"{pct(f.get('lure_recall'), f.get('lures'))} | {pct(f.get('false_alarm_rate'), f.get('benign'))} | "
                        f"{pct(f.get('accuracy'), f.get('pages'))} | {seconds(f.get('latency_median_ms'))} | "
                        f"{money(f.get('cost_per_page_usd'), who)} |")
    return rows


def seconds(ms):
    return "n/a" if ms is None else f"{ms / 1000:.1f} s"


def money(usd, who):
    return ("not known per page" if who == "Loupe" else "n/a") if usd is None else f"US${usd:.4f}"


def change(then, now):
    """A rate's move in percentage points, signed; "n/a" when either is missing."""
    return "n/a" if then is None or now is None else f"{(now - then) * 100:+.1f} points"


def known_limits(card):
    """What it gets wrong beyond the headline figures, each recorded run labelled with its scope."""
    out = [f"- Evaluation set: {card['limits']['evaluation_selection']}."]
    rec = card["limits"]["recorded"]
    ref = rec.get("reference_causes")
    if ref:
        out.append(f"- Independent reference set, its {ref['errors']} errors, each confirmed from its screenshot: "
                   + "; ".join(f"{n} {cause}" for cause, n in sorted(ref["confirmed"].items(), key=lambda kv: -kv[1])) + ".")
    mp = rec.get("monitor_pages")
    if mp:
        out.append(f"- Synthetic monitor pages (D03 T04 §1: {mp['pages']} pages of ten fictional brands, 20 lures and 20 "
                   f"benign, none from its training; a hard test of unseen brands, not a production false-alarm estimate): "
                   f"lure recall {mp['lure_recall'] * 100:.0f}%, false alarms {mp['false_alarm_rate'] * 100:.0f}%, "
                   f"median {mp['latency_median_ms'] / 1000:.1f} s.")
    return out


def markdown_part(card):
    i, d, r, res = card["identity"], card["data"], card["run"], card["results"]
    v, t = card["version"], card["tokens"]
    loupe, spark = res["loupe"]["overall"] or {}, (res["spark"] or {}).get("overall") or {}
    heads = {"results": f"Results of Loupe {v}", "training": f"Training of Loupe {v}",
             "deployment": f"Deployment of Loupe {v}", "limits": f"Limits of Loupe {v}"}
    stands = f"Where Loupe {v} stands"
    wall_hours = None if r.get("wall_seconds") is None else r["wall_seconds"] / 3600
    rows = [f"## Loupe {v}", "",
            f"`{i['model_id']}`, a LoRA (rank {i['rank']}) of {BASE}, trained by {METHOD}, {i['started']} to {i['ended']}.",
            "", f"Contents: [{stands}](#{anchor(stands)}), [{heads['results']}](#{anchor(heads['results'])}), "
                f"[{heads['training']}](#{anchor(heads['training'])}), [{heads['deployment']}](#{anchor(heads['deployment'])}), "
                f"[{heads['limits']}](#{anchor(heads['limits'])}).",
            "", f"Intended use: {card['limits']['intended_use']}",
            *standing(card),
            "", f"### {heads['results']}", "", "| Held-out evaluation set | Loupe | Muse Spark |", "| --- | --- | --- |"]
    of = {"lure_recall": "lures", "false_alarm_rate": "benign", "accuracy": "pages"}
    labels = {"lure_recall": "Lure recall", "false_alarm_rate": "False alarm rate", "accuracy": "Accuracy",
              "latency_median_ms": "Median latency", "cost_per_page_usd": "Cost per page"}
    for key in labels:
        if key in of:
            cells = [pct(side.get(key), side.get(of[key])) for side in (loupe, spark)]
        elif key == "latency_median_ms":
            cells = [seconds(side.get(key)) for side in (loupe, spark)]
        else:
            cells = [money(loupe.get(key), "Loupe"), money(spark.get(key), "Muse Spark")]
        rows.append(f"| {labels[key]} | {cells[0]} | {cells[1]} |")
    rows += slice_rows(res)
    by_source = res["loupe"].get("by_benign_source") or {}
    if by_source:
        rows += ["", "False alarms by benign source: " + "; ".join(
            f"{name} {pct(figures.get('false_alarm_rate'), figures.get('benign'))}"
            for name, figures in by_source.items()) + "."]
    samples = res["loupe"].get("samples") or {}
    if samples:
        rows += ["", f"Redacted South African samples: lure recall {pct(samples.get('lure_recall'), samples.get('lures'))}."]
    reference = res.get("reference") or {}
    if reference:
        ref_loupe = (reference.get("loupe") or {}).get("overall") or {}
        ref_spark = ((reference.get("spark") or {}).get("overall")) or {}
        ref_bar = reference.get("bar")
        rows += ["", f"Independent reference set ({ref_loupe.get('pages')} pages, drawn before any teacher check): "
                     f"Loupe lure recall {pct(ref_loupe.get('lure_recall'), ref_loupe.get('lures'))}, false alarms "
                     f"{pct(ref_loupe.get('false_alarm_rate'), ref_loupe.get('benign'))}; Muse Spark "
                     f"{pct(ref_spark.get('lure_recall'), ref_spark.get('lures'))} and "
                     f"{pct(ref_spark.get('false_alarm_rate'), ref_spark.get('benign'))}; "
                     f"bar {ref_bar['result'] if ref_bar else 'withheld: ' + str(reference.get('bar_withheld'))}."]
    if "previous" in res:
        prev = res["previous"]
        po = prev["overall"]
        rows += ["", f"Against Loupe {prev['version']}: training lines {prev['lines_trained']} to {d['lines_trained']} "
                     f"({d['lines_trained'] - prev['lines_trained']:+d}); lure recall {pct(po.get('lure_recall'), po.get('lures'))} "
                     f"to {pct(loupe.get('lure_recall'), loupe.get('lures'))} "
                     f"({change(po.get('lure_recall'), loupe.get('lure_recall'))}); false-alarm rate "
                     f"{pct(po.get('false_alarm_rate'), po.get('benign'))} to "
                     f"{pct(loupe.get('false_alarm_rate'), loupe.get('benign'))} "
                     f"({change(po.get('false_alarm_rate'), loupe.get('false_alarm_rate'))})."]
    bar_line = (res["bar"]["result"] if isinstance(res["bar"], dict) else res["bar"]) if res["bar"] else (
        "withheld: " + str(res.get("bar_withheld")))
    rows += ["", f"Bar (lure recall at least Muse Spark's, false alarms at most 6 percent): {bar_line}."]
    rows += ["", f"### {heads['training']}", "",
             f"Hyperparameters: rank {i['rank']}, learning rate {i['learning_rate']}, batch size {i['batch_size']}, "
             f"{i['epochs']} epoch; sessions {', '.join(i['sessions'] or [])}; promoted checkpoint "
             f"{i['checkpoint'] or 'not recorded'}.",
             "", (f"Trained on {d['lines_trained']} of the dataset's {d['train']['lines']} lines (the trainer's cut to fit its "
                  f"limits); the screenshot, brand, South African, breakdown and token figures below describe the whole "
                  f"available dataset, not the trained subset. Dataset: " if d.get("subset") else
                  f"Trained on {d['lines_trained']} lines. Dataset: ")
                 + f"{d['train']['screenshots']} screenshots, {d['train']['brands']} brands, {d['train']['south_africa']} "
                 f"South African; `train.jsonl` SHA-256 `{d['train']['sha256']}`; "
                 f"held out {d['eval']['lines']} lines ({d['eval']['screenshots']} screenshots, {d['eval']['brands']} "
                 f"brands, {d['eval']['south_africa']} South African), `eval.jsonl` SHA-256 `{d['eval']['sha256']}`.",
             "", f"Training lines by origin: {counts(d['train']['by_origin'])}; by lure type: "
                 f"{counts({lure_name(k): n for k, n in d['train']['by_lure_type'].items()})}; by source: "
                 f"{counts(d['train']['by_source'])}.",
             "", f"Held-out lines by origin: {counts(d['eval']['by_origin'])}; by lure type: "
                 f"{counts({lure_name(k): n for k, n in d['eval']['by_lure_type'].items()})}; by source: "
                 f"{counts(d['eval']['by_source'])}.",
             "", "| Source | Dataset | Licence | Licence link |", "| --- | --- | --- | --- |",
             *[f"| {n} | {x['dataset']} | {x['licence']} | {x['licence_link']} |" for n, x in card["sources"].items()],
             "", f"Tokens: {t['total']} ({t['text']} text, {t['image']} image; {t['trained']} trained, {t['prompt']} "
                 f"prompt); a line holds {t['per_line']['min']} to {t['per_line']['max']} tokens (median "
                 f"{t['per_line']['median']}); {t['image_per_screenshot']} image tokens a screenshot.",
             "", f"Run: {r['steps']} steps, loss {r['first_loss']:.3f} to {r['last_loss']:.3f}; "
                 + ("wall time not recorded" if wall_hours is None else f"wall time {wall_hours:.1f} hours of training")
                 + f", {r['seconds_per_step']} seconds a step; {r['sessions_used']} session"
                 f"{'' if r['sessions_used'] == 1 else 's'}, {r['resumes']} resumes after interruptions; gradient norm "
                 + (f"{r['grad_norm']['min']:.1f} to {r['grad_norm']['max']:.1f} (median {r['grad_norm']['median']:.1f})"
                    if r.get("grad_norm") else "not recorded")
                 + f"; list price US${r['rated_usd']:.2f}; billed "
                 + (f"US${r['billed_usd']:.2f} under the free fine-tuning offer" if r.get("billed_usd") is not None
                    else "pending (Fireworks settles a run's bill about a day after it ends)") + ".",
             "", f"![Training loss by step, with its axes]({r['loss_chart']}) The numbers are in "
                 f"[the step table]({r['loss_table']}) (step, loss).",
             "", f"### {heads['deployment']}", "", deployment_summary(card), "", warmup_line(card["warmup"]),
             "", f"Running time: {card['minutes']}."]
    if card["deployment"]:
        rows += ["", "Deployment record (dated entries, oldest first):", *[f"- {line}" for line in card["deployment"]]]
    rows += ["", f"### {heads['limits']}", "", f"Not trained on: {card['limits']['not_trained_on']}", "", *known_limits(card), ""]
    return "\n".join(rows)


# How the held-out evaluation set was chosen, so its figures are read for what they are (§13).
EVALUATION_SELECTION = ("The held-out evaluation set holds pages whose labels Muse Spark confirmed (the teacher-agreed set); "
                        "the independent reference set was drawn before any Muse Spark check")


def warmup_line(w):
    """The measured warm-up in plain words, with the count of cold starts it rests on."""
    if not w["cold_starts"]:
        return "Warm-up: not measured yet."
    zero = (f"; the deployment read 0 replicas {w['scale_to_zero_s_min']} to {w['scale_to_zero_s_max']} seconds after "
            f"the last request" if w["scale_to_zero_s_min"] is not None else "")
    return (f"Warm-up: {w['cold_starts']} cold starts measured from 0 replicas to the first answer, median "
            f"{w['median_s']} seconds, maximum {w['max_s']} seconds{zero}.")


def standing(card):
    """Where the version stands, derived from its own evidence (operator, 2026-10-31 18:49 SAST; §17 completion review
    C4): the bar it passed or did not, whether it is deployed, and each part of the project's standard met, not met or
    unmeasured, beside the known causes 1.1 is built to answer."""
    res = card["results"]
    v = card["version"]
    bar = res.get("bar") or {}
    reference = res.get("reference") or {}
    rbar = reference.get("bar") or {}
    standard = res.get("standard") or {}
    heading = ["", f"## Where Loupe {v} stands", ""]
    if not bar or not rbar:
        return heading + ["Not judged yet: the bar is withheld until both screeners answer every page of both held-out sets."]

    def figures(name, judged, pages):
        o, sa = judged["overall"], judged["south_africa"]
        sa_part = (f"South African slice: lure recall {pct(sa['loupe_lure_recall'], sa['lures'])} against Muse Spark's "
                   f"{pct(sa['spark_lure_recall'], sa['lures'])}, false alarms {pct(sa['loupe_false_alarm_rate'], sa['benign'])}"
                   if sa["judged"] else
                   f"South African slice not judged ({sa['lures']} lures, {sa['benign']} benign, under the 30 each it needs)")
        return (f"{name} ({pages} pages): Loupe's lure recall {pct(o['loupe_lure_recall'], o['lures'])} against Muse "
                f"Spark's {pct(o['spark_lure_recall'], o['lures'])}, false alarms {pct(o['loupe_false_alarm_rate'], o['benign'])}; "
                f"{sa_part}.")

    loupe = res["loupe"]["overall"]
    ref_loupe = (reference.get("loupe") or {}).get("overall") or {}
    worst = max(loupe.get("false_alarm_rate") or 0, ref_loupe.get("false_alarm_rate") or 0)
    weakest = min(loupe.get("lure_recall") or 0, ref_loupe.get("lure_recall") or 0)
    wonder = standard.get("wonder_lure_recall")
    cap = standard.get("false_alarm_rate_at_most", 0)
    deployed = bool(card["deployment"])
    passed = (res.get("bar_both_sets") or bar.get("result")) == "passed"
    false_ok = worst <= cap
    recall_ok = None if wonder is None else weakest > wonder
    meets = false_ok and recall_ok is True
    if meets:
        verdict = f"Loupe {v} meets the project's own standard on the recorded figures."
    else:
        verdict = f"Loupe {v} does not yet meet the project's own standard."
        if deployed and passed:
            verdict += (" It ships under a time-boxed bar set for the competition deadline, not because the result is "
                        "considered good enough.")
        elif deployed:
            verdict += " It did not pass the bar it was judged on, and is deployed."
        else:
            verdict += " It is not deployed." + ("" if passed else " It did not pass the bar it was judged on.")
    lines = heading + [verdict, "",
             f"The bar it was judged on: lure recall at least Muse Spark's and false alarms at most 6 percent, on the "
             f"held-out evaluation set and on the independent reference set (operator, 2026-10-31). Result: "
             f"{res.get('bar_both_sets') or bar.get('result')}.", "",
             "- " + figures("Evaluation set", bar, loupe.get("pages")),
             "- " + figures("Independent reference set, drawn before any Muse Spark check", rbar, ref_loupe.get("pages")),
             "", f"The project's standard, set for Loupe {standard.get('set_for')} as the target it is built to meet: false "
             f"alarms at most {cap * 100:.0f} percent, and lure recall above {standard.get('lure_recall_above')}'s on the "
             f"same pages.",
             f"- False alarms: {worst * 100:.1f} percent at their highest of the two sets, so the part is "
             f"{'met' if false_ok else 'not met'}.",
             "- Lure recall: " + (f"{standard.get('lure_recall_above')}'s recall on these pages is not measured yet, so "
                                   "this part is a target, not a comparison." if wonder is None else
                                   f"{weakest * 100:.1f} percent at its lowest of the two sets against "
                                   f"{standard.get('lure_recall_above')}'s {wonder * 100:.1f} percent, so the part is "
                                   f"{'met' if recall_ok else 'not met'}."), ""]
    causes = res.get("confirmed_causes") or {}
    if causes:
        top = sorted(causes.items(), key=lambda kv: -kv[1])
        lines += [f"Known causes of its misses and false alarms ({sum(causes.values())} pages, each confirmed): "
                  + "; ".join(f"{n} {cause}" for cause, n in top) + ".", "",
                  f"The work on them for Loupe {standard.get('set_for')}: {standard.get('next_work')}. They name what 1.1 "
                  "is built to answer, not what it will reach."]
    return lines


def write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def earlier_versions(version, markdown):
    return [v for v in versions_trained(markdown) if tuple(map(int, v.split("."))) < tuple(map(int, version.split(".")))]


def previous_card(version, markdown, store):
    """The card of the preceding completed version, which the comparison needs: required when one exists, so the card never
    silently drops it (§17 completion review C5). A failed or interrupted version keeps its number and its explanation
    but is no predecessor (round 1)."""
    for earlier in reversed(earlier_versions(version, markdown)):
        record = store / "runs" / f"loupe-{earlier}" / "run.json"
        if not record.is_file() or read_json(record).get("outcome") != "completed":
            continue
        path = DOCS / f"loupe-{earlier}.json"
        if not path.is_file():
            raise ValueError(f"Loupe {earlier} has no card to compare against; make it first: "
                             f"`python3 scripts/glimmer/model_card.py {earlier}`")
        return read_json(path)
    return None


def card_state(version, store):
    """Whether a version can have a card, and why not: its run must have completed and been evaluated on the held-out
    file. Otherwise the reason and the command that moves it on (§17 plan review): a failed or interrupted run keeps its
    version number and has no card; a completed run awaiting its evaluation gets one after `evaluate.ts`."""
    record = store / "runs" / f"loupe-{version}" / "run.json"
    outcome = read_json(record).get("outcome") if record.is_file() else None
    if outcome != "completed":
        return f"its run is {outcome or 'not recorded'}, so it has no card (a version is never reused: train the next one)"
    if not (store / "runs" / f"eval-{version}" / "metrics.json").is_file():
        return (f"its run completed and awaits its evaluation: `node scripts/glimmer/evaluate.ts loupe {version}`, then "
                f"`python3 scripts/glimmer/model_card.py {version}`")
    return None


def page_text(version, card):
    """The model-card page with this version's section replaced, as it will be published."""
    page = DOCS / "model-card.md"
    text = page.read_text(encoding="utf-8") if page.is_file() else (
        "# Loupe model card\n\nOne part per version, made from the run's own records by `scripts/glimmer/model_card.py`.\n\n")
    text = re.sub(rf"^## Loupe {re.escape(version)}\n.*?(?=^## Loupe |\Z)", "", text, flags=re.MULTILINE | re.DOTALL)
    return text.rstrip("\n") + "\n\n" + markdown_part(card)


def make(version, store, markdown):
    """Builds the card and every artifact in memory, validates them, and only then publishes: the chart, its table, the
    card's JSON and, last, the page. Raises ValueError (nothing written) for records that cannot make a card."""
    try:
        waiting = card_state(version, store)
        if waiting:
            raise ValueError(f"Loupe {version}: {waiting}")
        card, svg, table = build(version, store, markdown, previous_card(version, markdown, store))
        gaps = missing(card)
        if gaps:
            raise ValueError(f"empty {', '.join(gaps)}")
        page = page_text(version, card)
    except (KeyError, TypeError, IndexError, AttributeError, json.JSONDecodeError, OSError) as error:
        raise ValueError(f"a record is missing or malformed ({type(error).__name__}: {error}); read `{store}` for "
                         f"Loupe {version}") from error
    written = []
    try:
        for path, text in ((DOCS / card["run"]["loss_chart"], svg), (DOCS / card["run"]["loss_table"], table),
                           (DOCS / f"loupe-{version}.json", json.dumps(card, indent=2) + "\n"),
                           (DOCS / "model-card.md", page)):
            write_atomic(path, text)
            written.append(path.name)
    except OSError as error:
        raise OSError(f"could not write {path} after {', '.join(written) or 'nothing'}: {error}; run "
                      f"`python3 scripts/glimmer/model_card.py {version}` again, and `--check` names what is out of step") from error
    return card


def check(store, markdown):
    problems = []
    if not re.search(r"\]\((?:\./)?model-card\.md\)", markdown) or not (DOCS / "model-card.md").is_file():
        problems.append("docs/glimmer/training.md does not link the card (model-card.md), or the card is missing")
    for version in versions_trained(markdown):
        path = DOCS / f"loupe-{version}.json"
        if not path.is_file():
            waiting = card_state(version, store)
            problems.append(f"Loupe {version}: " + (f"no card yet: {waiting}" if waiting else "no card; make it with "
                                                     f"`python3 scripts/glimmer/model_card.py {version}`"))
            continue
        stored = read_json(path)
        gaps = missing(stored)
        if gaps:
            problems.append(f"Loupe {version}: empty {', '.join(gaps[:5])}")
        try:
            previous = previous_card(version, markdown, store)
            rebuilt, rebuilt_svg, rebuilt_table = build(version, store, markdown, previous)
        except (OSError, KeyError, TypeError, AttributeError, ValueError) as error:
            problems.append(f"Loupe {version}: its records do not read ({type(error).__name__}: {error})")
            continue
        if rebuilt != stored:
            problems.append(f"Loupe {version}: the card differs from its records; rebuild it")
        # The published artifacts are read back too: the card's Markdown section, its loss chart and the chart's table.
        page = DOCS / "model-card.md"
        text = page.read_text(encoding="utf-8") if page.is_file() else ""
        found = re.search(rf"^## Loupe {re.escape(version)}\n.*?(?=^## Loupe |\Z)", text, flags=re.MULTILINE | re.DOTALL)
        if not found:
            problems.append(f"Loupe {version}: no section in model-card.md")
        elif found.group(0).rstrip("\n") != markdown_part(stored).rstrip("\n"):
            problems.append(f"Loupe {version}: model-card.md differs from its card; rebuild it")
        for name, expected in ((stored["run"]["loss_chart"], rebuilt_svg), (stored["run"]["loss_table"], rebuilt_table)):
            artifact = DOCS / name
            if not artifact.is_file():
                problems.append(f"Loupe {version}: {name} is missing")
            elif artifact.read_text(encoding="utf-8") != expected:
                problems.append(f"Loupe {version}: {name} differs from its metrics; rebuild it")
    return problems


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    markdown = (DOCS / "training.md").read_text(encoding="utf-8")
    if args == ["--check"]:
        problems = check(store_dir(), markdown)
        for problem in problems:
            print(f"model-card: {problem}")
        print("model-card: complete" if not problems else f"model-card: {len(problems)} problems")
        return 1 if problems else 0
    if len(args) != 1 or not re.fullmatch(r"\d+\.\d+", args[0]):
        print("usage: model_card.py <version> | --check", file=sys.stderr)
        return 2
    try:
        make(args[0], store_dir(), markdown)
    except ValueError as error:
        # Records that cannot make a card: nothing is written, the earlier card stands.
        print(f"model-card: refused: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"model-card: {error}", file=sys.stderr)
        return 1
    print(f"model-card: Loupe {args[0]} written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
