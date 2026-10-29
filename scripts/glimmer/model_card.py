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


def build(version, store, markdown, previous=None):
    """The version's card as data, every figure read from its records."""
    dataset = read_json(DOCS / f"dataset-{version}.json")
    run_dir = store / "runs" / f"loupe-{version}"
    run = read_json(run_dir / "run.json")
    lines = [json.loads(l) for l in (run_dir / "metrics.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    evaluation = read_json(store / "runs" / f"eval-{version}" / "metrics.json")
    deployment = [l[2:] for l in section(markdown, "Deployment").splitlines() if l.startswith("- ")]
    points = [(l["step"], l["loss"]) for l in lines if isinstance(l.get("loss"), (int, float))]
    hp = run.get("hyperparameters") or {}
    card = {
        "version": version,
        "identity": {
            "model_id": run.get("model_id"), "base_model": BASE, "method": METHOD,
            "rank": hp.get("lora_rank"), "learning_rate": hp.get("learning_rate"), "batch_size": hp.get("batch_size"),
            "epochs": hp.get("epochs"), "started": run.get("started"), "ended": run.get("ended"),
            "sessions": run.get("sessions"),
        },
        "data": {
            "train": {k: dataset["train"][k] for k in ("lines", "sha256", "by_origin", "by_source", "by_lure_type",
                                                       "south_africa", "brands", "screenshots")},
            "eval": {k: dataset["eval"][k] for k in ("lines", "sha256", "south_africa", "brands")},
            "lines_trained": run.get("lines_trained"),
        },
        "tokens": dataset["train"]["tokens"],
        "run": {
            "steps": run.get("steps"), "first_loss": run.get("first_loss"), "last_loss": run.get("last_loss"),
            "tokens_sent": run.get("tokens_sent"), "rated_usd": run.get("rated_usd"), "resumes": run.get("resumes"),
            "seconds_per_step": round(lines[-1]["seconds"] / max(1, len(lines)), 2) if lines else None,
            "loss_chart": f"loupe-{version}-loss.svg",
        },
        "results": {
            "loupe": {k: evaluation.get(k) for k in ("overall", "south_africa", "by_lure_type")},
            "spark": evaluation.get("spark"),
            "bar": evaluation.get("bar"),
            "misses_by_cause": evaluation.get("misses_by_cause"),
            "eval_sha256": evaluation.get("eval_sha256"),
        },
        "deployment": deployment,
        "limits": {"not_trained_on": NOT_TRAINED_ON, "intended_use": USE},
    }
    if previous:
        card["results"]["previous"] = {
            "version": previous["version"], "lines_trained": previous["data"]["lines_trained"],
            "overall": previous["results"]["loupe"]["overall"],
        }
    return card, loss_svg(points)


def missing(card):
    """Every empty part or figure of a card, by its path."""
    gaps = []

    def walk(value, path):
        if value is None or value == "" or value == [] or value == {}:
            gaps.append(path)
        elif isinstance(value, dict):
            for key, inner in value.items():
                walk(inner, f"{path}.{key}")

    walk(card, "card")
    return gaps


def markdown_part(card):
    i, d, r, res = card["identity"], card["data"], card["run"], card["results"]
    loupe, spark = res["loupe"]["overall"] or {}, (res["spark"] or {}).get("overall") or {}
    rows = [f"## Loupe {card['version']}", "",
            f"`{i['model_id']}`, a LoRA (rank {i['rank']}) of {BASE}, trained by {METHOD}, {i['started']} to {i['ended']}.",
            "", f"Trained on {d['lines_trained']} lines ({d['train']['screenshots']} screenshots, {d['train']['brands']} "
                f"brands, {d['train']['south_africa']} South African); held out {d['eval']['lines']}.",
            "", f"Tokens: {card['tokens']['total']} ({card['tokens']['image']} image, {card['tokens']['trained']} trained).",
            "", f"Run: {r['steps']} steps, loss {r['first_loss']} to {r['last_loss']}, {r['resumes']} resumes, rated "
                f"US${r['rated_usd']}. ![Loss by step]({r['loss_chart']})", "",
            "| Held-out set | Loupe | Muse Spark |", "| --- | --- | --- |"]
    for key in ("lure_recall", "false_alarm_rate", "accuracy", "latency_ms_median", "usd_per_page"):
        rows.append(f"| {key.replace('_', ' ')} | {loupe.get(key)} | {spark.get(key)} |")
    if "previous" in res:
        prev = res["previous"]
        rows += ["", f"Against Loupe {prev['version']} ({prev['lines_trained']} lines): lure recall "
                     f"{prev['overall'].get('lure_recall')} to {loupe.get('lure_recall')}, false-alarm rate "
                     f"{prev['overall'].get('false_alarm_rate')} to {loupe.get('false_alarm_rate')}."]
    rows += ["", f"Bar (beat Muse Spark): {res['bar']}.", "", "Deployment: " + "; ".join(card["deployment"]), "",
             f"Not trained on: {card['limits']['not_trained_on']}", "", f"Intended use: {card['limits']['intended_use']}", ""]
    return "\n".join(rows)


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


def check(store, markdown):
    problems = []
    for version in versions_trained(markdown):
        path = DOCS / f"loupe-{version}.json"
        if not path.is_file():
            problems.append(f"Loupe {version}: no card")
            continue
        stored = read_json(path)
        gaps = missing(stored)
        if gaps:
            problems.append(f"Loupe {version}: empty {', '.join(gaps[:5])}")
        try:
            rebuilt, _ = build(version, store, markdown, stored.get("results", {}).get("previous") and read_json(
                DOCS / f"loupe-{stored['results']['previous']['version']}.json"))
        except (OSError, KeyError, ValueError) as error:
            problems.append(f"Loupe {version}: its records do not read ({type(error).__name__}: {error})")
            continue
        if rebuilt != stored:
            problems.append(f"Loupe {version}: the card differs from its records; rebuild it")
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
    card = make(args[0], store_dir(), markdown)
    gaps = missing(card)
    print(f"model-card: Loupe {args[0]} written" + (f"; empty: {', '.join(gaps)}" if gaps else ""))
    return 1 if gaps else 0


if __name__ == "__main__":
    sys.exit(main())
