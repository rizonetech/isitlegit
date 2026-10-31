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


def loss_svg(points, width=640, height=240, pad=32):
    """A line chart of loss by step, one point a step, drawn from the run's metrics."""
    if not points:
        return '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"></svg>\n'
    steps = [s for s, _ in points]
    losses = [l for _, l in points]
    lo, hi = min(losses), max(losses)
    span_x = max(steps) - min(steps) or 1
    span_y = (hi - lo) or 1
    xy = [(pad + (s - min(steps)) / span_x * (width - 2 * pad), height - pad - (l - lo) / span_y * (height - 2 * pad))
          for s, l in points]
    path = " ".join(f"{x:.1f},{y:.1f}" for x, y in xy)
    circles = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="1.5"/>' for x, y in xy)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" role="img" '
            f'aria-label="Training loss by step">\n<title>Training loss by step</title>\n'
            f'<polyline fill="none" stroke="currentColor" stroke-width="1.5" points="{path}"/>\n<g>{circles}</g>\n'
            f'<text x="{pad}" y="16" font-size="11">loss {hi:.3f} to {lo:.3f} over {len(points)} steps</text>\n</svg>\n')


# The deployment's running-time rule (operator, 2026-10-31 22:16 SAST, D03 T04 §34), as the ledger holds it.
MINUTES_RULE = ("30 minutes a day on average since 2026-10-31, with one day borrowed ahead (unused minutes roll over); "
                "warm-up and the 6-minute tail after the last request are counted")


def bound_to(version, line):
    """Whether a record line is about this version: it names the version's model (`isitlegit-loupe-1-0`) or the version
    in a command or a heading (`ensure 1.0`, `Loupe 1.0`), so a later version never inherits an earlier one's."""
    slug = f"isitlegit-loupe-{version.replace('.', '-')}"
    return slug in line or re.search(rf"(?<![\d.]){re.escape(version)}(?![\d.])", line) is not None


# The benign render lists are kept out of the sources table (their pages are our own renders; docs/glimmer/sources.md,
# the paragraph on them), so their licence and link are stated here from that paragraph.
RENDER_LISTS = {
    "benign-majestic": {"licence": "CC BY 3.0 (Majestic Million)", "link": "https://majestic.com/reports/majestic-million"},
    "benign-sa": {"licence": "own list", "link": "eval/glimmer/benign-sa-urls.txt"},
}


def source_records(version_sources):
    """Each training source's licence and link from `docs/glimmer/sources.md`; "not recorded" for one it does not name."""
    text = (DOCS / "sources.md").read_text(encoding="utf-8") if (DOCS / "sources.md").is_file() else ""
    found = {}
    for row in text.splitlines():
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        if row.startswith("|") and len(cells) >= 4 and cells[0].startswith("`"):
            found[cells[0].strip("`")] = {"licence": cells[2], "link": cells[3]}
    known = {**RENDER_LISTS, **found}
    return {name: known.get(name, {"licence": "not recorded", "link": "not recorded"}) for name in sorted(version_sources)}


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
    norms = sorted(l["grad_norm"] for l in lines if isinstance(l.get("grad_norm"), (int, float)))
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
            "checkpoint": run.get("checkpoint") or run.get("promoted_checkpoint"),
        },
        "data": {
            "train": {k: dataset["train"][k] for k in ("lines", "sha256", "by_origin", "by_source", "by_lure_type",
                                                       "south_africa", "brands", "screenshots")},
            "eval": {k: dataset["eval"][k] for k in ("lines", "sha256", "south_africa", "brands")},
            "lines_trained": run.get("lines_trained"),
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
            "grad_norm": ({"min": norms[0], "median": norms[len(norms) // 2], "max": norms[-1]} if norms else None),
            "loss_chart": f"loupe-{version}-loss.svg",
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
    return card, loss_svg(points)


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


def slice_rows(res):
    """The South African slice and each lure type, Loupe beside Muse Spark, as table rows with their counts."""
    loupe, spark = res["loupe"], (res.get("spark") or {})
    rows = ["", "| Slice | Pages | Loupe lure recall | Muse Spark lure recall | Loupe false alarms | Muse Spark false alarms |",
            "| --- | --- | --- | --- | --- | --- |"]
    named = [("South Africa", loupe["south_africa"], (spark.get("south_africa") or {}))]
    named += [(name, o, (spark.get("by_lure_type") or {}).get(name) or {}) for name, o in sorted(loupe["by_lure_type"].items())]
    for name, o, sp in named:
        rows.append(f"| {name} | {o.get('pages')} ({o.get('lures')} lures, {o.get('benign')} benign) | "
                    f"{pct(o.get('lure_recall'), o.get('lures'))} | {pct(sp.get('lure_recall'), sp.get('lures'))} | "
                    f"{pct(o.get('false_alarm_rate'), o.get('benign'))} | {pct(sp.get('false_alarm_rate'), sp.get('benign'))} |")
    return rows


def known_limits(card):
    """What it gets wrong beyond the headline figures, each recorded run labelled with its scope."""
    out = ["", f"Evaluation set: {card['limits']['evaluation_selection']}."]
    rec = card["limits"]["recorded"]
    ref = rec.get("reference_causes")
    if ref:
        out += ["", f"Independent reference set, its {ref['errors']} errors, each confirmed from its screenshot: "
                    + "; ".join(f"{n} {cause}" for cause, n in sorted(ref["confirmed"].items(), key=lambda kv: -kv[1])) + "."]
    mp = rec.get("monitor_pages")
    if mp:
        out += ["", f"Synthetic monitor pages (D03 T04 §1: {mp['pages']} pages of ten fictional brands, 20 lures and 20 "
                    f"benign, none from its training; a hard test of unseen brands, not a production false-alarm estimate): "
                    f"lure recall {mp['lure_recall'] * 100:.0f}%, false alarms {mp['false_alarm_rate'] * 100:.0f}%, "
                    f"median {mp['latency_median_ms'] / 1000:.1f} s."]
    return out


def markdown_part(card):
    i, d, r, res = card["identity"], card["data"], card["run"], card["results"]
    loupe, spark = res["loupe"]["overall"] or {}, (res["spark"] or {}).get("overall") or {}
    rows = [f"## Loupe {card['version']}", "",
            f"`{i['model_id']}`, a LoRA (rank {i['rank']}) of {BASE}, trained by {METHOD}, {i['started']} to {i['ended']}.",
            "", f"Trained on {d['lines_trained']} lines ({d['train']['screenshots']} screenshots, {d['train']['brands']} "
                f"brands, {d['train']['south_africa']} South African); held out {d['eval']['lines']}.",
            "", f"Hyperparameters: rank {i['rank']}, learning rate {i['learning_rate']}, batch size {i['batch_size']}, "
                f"{i['epochs']} epoch; sessions {', '.join(i['sessions'] or [])}; promoted checkpoint "
                f"{i['checkpoint'] or 'not recorded in run.json'}.",
            "", f"Training lines by origin: {counts(d['train']['by_origin'])}; by lure type: {counts(d['train']['by_lure_type'])}; "
                f"by source: {counts(d['train']['by_source'])}.",
            "", "Sources (licence, link; `docs/glimmer/sources.md`): "
                + "; ".join(f"{n}: {v['licence']}, {v['link']}" for n, v in card["sources"].items()) + ".",
            "", f"Tokens: {card['tokens']['total']} ({card['tokens']['image']} image, {card['tokens']['trained']} trained, "
                f"{card['tokens']['prompt']} prompt); a line holds {card['tokens']['per_line']['min']} to "
                f"{card['tokens']['per_line']['max']} tokens (median {card['tokens']['per_line']['median']}); "
                f"{card['tokens']['image_per_screenshot']} image tokens a screenshot.",
            "", f"Run: {r['steps']} steps, loss {r['first_loss']:.3f} to {r['last_loss']:.3f}, {r['resumes']} resumes; list price "
                f"US${r['rated_usd']:.2f}; billed "
                + (f"US${r['billed_usd']:.2f} under the free fine-tuning offer" if r.get("billed_usd") is not None
                   else "pending (Fireworks settles a run's bill about a day after it ends)")
                + f"; {r['seconds_per_step']} seconds a step; gradient norm "
                + (f"{r['grad_norm']['min']:.1f} to {r['grad_norm']['max']:.1f} (median {r['grad_norm']['median']:.1f})"
                   if r.get("grad_norm") else "not recorded")
                + f". ![Loss by step]({r['loss_chart']})",
            *standing(card), "", "| Held-out evaluation set | Loupe | Muse Spark |", "| --- | --- | --- |"]
    # The keys `evaluate.ts` writes (`latency_median_ms`, `cost_per_page_usd`); a cost Loupe cannot know per page says so.
    def shown(value, key):
        if value is None:
            return "not known per page" if key == "cost_per_page_usd" else "n/a"
        if key == "latency_median_ms":
            return f"{value / 1000:.1f} s"
        if key == "cost_per_page_usd":
            return f"US${value:.4f}"
        return f"{value:.3f}" if isinstance(value, float) else value
    of = {"lure_recall": "lures", "false_alarm_rate": "benign", "accuracy": "pages"}
    for key in ("lure_recall", "false_alarm_rate", "accuracy", "latency_median_ms", "cost_per_page_usd"):
        cell = (lambda side: pct(side.get(key), side.get(of[key]))) if key in of else (lambda side: shown(side.get(key), key))
        rows.append(f"| {key.replace('_', ' ')} | {cell(loupe)} | {cell(spark)} |")
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
        rows += ["", f"Against Loupe {prev['version']} ({prev['lines_trained']} lines): lure recall "
                     f"{prev['overall'].get('lure_recall')} to {loupe.get('lure_recall')}, false-alarm rate "
                     f"{prev['overall'].get('false_alarm_rate')} to {loupe.get('false_alarm_rate')}."]
    bar_line = (res["bar"]["result"] if isinstance(res["bar"], dict) else res["bar"]) if res["bar"] else (
        "withheld: " + str(res.get("bar_withheld")))
    rows += slice_rows(res)
    rows += known_limits(card)
    rows += ["", f"Bar (lure recall at least Muse Spark's, false alarms at most 6 percent): {bar_line}.", "", "Deployment: " + ("; ".join(card["deployment"]) or "not deployed: no deployment is recorded for this version"), "",
             warmup_line(card["warmup"]), "", f"Running time: {card['minutes']}.", "",
             f"Not trained on: {card['limits']['not_trained_on']}", "", f"Intended use: {card['limits']['intended_use']}", ""]
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
    """Where the version stands, in plain words and the recorded figures (operator, 2026-10-31 18:49 SAST): the
    time-boxed bar it passed, beside the project's own standard, and the known causes 1.1 is built to answer."""
    res = card["results"]
    bar = res.get("bar") or {}
    reference = res.get("reference") or {}
    rbar = reference.get("bar") or {}
    standard = res.get("standard") or {}
    if not bar or not rbar:
        return ["", "## Where this version stands", "", "Not judged yet: the bar is withheld until both screeners answer "
                "every page of both held-out sets."]

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
    wonder = standard.get("wonder_lure_recall")
    meets = (worst <= standard.get("false_alarm_rate_at_most", 0) and wonder is not None
             and min(loupe.get("lure_recall") or 0, ref_loupe.get("lure_recall") or 0) > wonder)
    lines = ["", f"## Where Loupe {card['version']} stands", "",
             (f"Loupe {card['version']} does not yet meet the project's own standard. It ships under a time-boxed bar set "
              "for the competition deadline, not because the result is considered good enough."
              if not meets else f"Loupe {card['version']} meets the project's own standard on the recorded figures."), "",
             f"The bar it was judged on: lure recall at least Muse Spark's and false alarms at most 6 percent, on the "
             f"held-out evaluation set and on the independent reference set (operator, 2026-10-31). Result: "
             f"{res.get('bar_both_sets') or bar.get('result')} on both sets.", "",
             "- " + figures("Evaluation set", bar, loupe.get("pages")),
             "- " + figures("Independent reference set, drawn before any Muse Spark check", rbar, ref_loupe.get("pages")),
             "", f"The project's standard, set for Loupe {standard.get('set_for')} as the target it is built to meet: false "
             f"alarms at most {standard.get('false_alarm_rate_at_most', 0) * 100:.0f} percent, and lure recall above "
             f"{standard.get('lure_recall_above')}'s on the same pages. Loupe {card['version']}'s false alarms are "
             f"{worst * 100:.1f} percent at their highest of the two sets, so it is short of the first part; "
             + (f"{standard.get('lure_recall_above')}'s recall on these pages is {wonder:.3f}." if wonder is not None else
                f"{standard.get('lure_recall_above')}'s recall on these pages is not measured yet, so the second part is "
                "a target, not a comparison."), ""]
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


def make(version, store, markdown):
    trained = versions_trained(markdown)
    earlier = [v for v in trained if tuple(map(int, v.split("."))) < tuple(map(int, version.split(".")))]
    previous = read_json(DOCS / f"loupe-{earlier[-1]}.json") if earlier and (DOCS / f"loupe-{earlier[-1]}.json").is_file() else None
    card, svg = build(version, store, markdown, previous)
    write_atomic(DOCS / f"loupe-{version}.json", json.dumps(card, indent=2) + "\n")
    write_atomic(DOCS / f"loupe-{version}-loss.svg", svg)
    page = DOCS / "model-card.md"
    text = page.read_text(encoding="utf-8") if page.is_file() else "# Loupe model card\n\nOne part per version, made from the run's own records by `scripts/glimmer/model_card.py`.\n\n"
    text = re.sub(rf"^## Loupe {re.escape(version)}\n.*?(?=^## Loupe |\Z)", "", text, flags=re.MULTILINE | re.DOTALL)
    write_atomic(page, text.rstrip("\n") + "\n\n" + markdown_part(card))
    return card


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


def check(store, markdown):
    problems = []
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
            rebuilt, rebuilt_svg = build(version, store, markdown, stored.get("results", {}).get("previous") and read_json(
                DOCS / f"loupe-{stored['results']['previous']['version']}.json"))
        except (OSError, KeyError, ValueError) as error:
            problems.append(f"Loupe {version}: its records do not read ({type(error).__name__}: {error})")
            continue
        if rebuilt != stored:
            problems.append(f"Loupe {version}: the card differs from its records; rebuild it")
        # The published artifacts are read back too: the card's Markdown section and its loss chart (§17 plan review).
        page = DOCS / "model-card.md"
        text = page.read_text(encoding="utf-8") if page.is_file() else ""
        found = re.search(rf"^## Loupe {re.escape(version)}\n.*?(?=^## Loupe |\Z)", text, flags=re.MULTILINE | re.DOTALL)
        if not found:
            problems.append(f"Loupe {version}: no section in model-card.md")
        elif found.group(0).rstrip("\n") != markdown_part(stored).rstrip("\n"):
            problems.append(f"Loupe {version}: model-card.md differs from its card; rebuild it")
        chart = DOCS / stored["run"]["loss_chart"]
        if not chart.is_file():
            problems.append(f"Loupe {version}: the loss chart {stored['run']['loss_chart']} is missing")
        elif chart.read_text(encoding="utf-8") != rebuilt_svg:
            problems.append(f"Loupe {version}: the loss chart differs from its metrics; rebuild it")
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
        card = make(args[0], store_dir(), markdown)
    except ValueError as error:
        # Records that do not describe one version: nothing is written, the earlier card stands.
        print(f"model-card: refused: {error}", file=sys.stderr)
        return 1
    gaps = missing(card)
    print(f"model-card: Loupe {args[0]} written" + (f"; empty: {', '.join(gaps)}" if gaps else ""))
    return 1 if gaps else 0


if __name__ == "__main__":
    sys.exit(main())
