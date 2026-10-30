#!/usr/bin/env python3
"""The statistics of one Loupe dataset version (D03 T04 §10), for the model card (§17).

    ~/.venvs/fireworks/bin/python scripts/glimmer/dataset_stats.py <version>

Reads `<store>/dataset/<version>/` (`train.jsonl`, `eval.jsonl`, their `.meta.jsonl` and `summary.json`, which
`build-dataset.ts` writes) and writes `docs/glimmer/dataset-<version>.json` (temp-then-rename): lines in each split by
origin, source, `lure_type`, South African slice and brand count; screenshots; and tokens counted with Glimmer's own
renderer (`muse_glimmer` with its image processor, as §2's probe and §11 count them): in total, text and image, trained
(the answer) and prompt, and a line's minimum, median and maximum. Nothing is sent anywhere.
"""
import hashlib
import json
import os
import statistics
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOKENIZER = "meta-models/Muse-Glimmer-30B"


def store_dir():
    configured = os.environ.get("GLIMMER_DATA_DIR")
    return Path(configured).expanduser() if configured else Path.home() / "isitlegit-data" / "glimmer"


def lines_of(path):
    with open(path, encoding="utf-8") as handle:
        return [line for line in handle if line.strip()]


def renderer_messages(messages):
    """A training line's messages as the cookbook renderer reads them: an `image_url` part becomes an `image` part."""
    return [{"role": m["role"], "content": [
        {"type": "image", "image": part["image_url"]["url"]} if part.get("type") == "image_url" else part
        for part in m["content"]] if isinstance(m["content"], list) else m["content"]} for m in messages]


def count(messages, renderer, train_on):
    """(text tokens, image tokens, trained tokens) of one training line."""
    model_input, weights = renderer.build_supervised_example(renderer_messages(messages), train_on_what=train_on)
    text = sum(len(c.tokens) for c in model_input.chunks if c.type != "image")
    image = sum(c.expected_tokens for c in model_input.chunks if c.type == "image")
    trained = int(sum(1 for w in weights if w)) if hasattr(weights, "__iter__") else 0
    return text, image, trained


def split_stats(folder, name, renderer, train_on):
    lines = lines_of(folder / f"{name}.jsonl")
    metas = [json.loads(line) for line in lines_of(folder / f"{name}.meta.jsonl")]
    if len(lines) != len(metas):
        raise ValueError(f"{name}.jsonl has {len(lines)} lines and its meta {len(metas)}")
    per_line, text_total, image_total, trained_total, screenshots = [], 0, 0, 0, 0
    for line in lines:
        messages = json.loads(line)["messages"]
        screenshots += sum(1 for m in messages if isinstance(m["content"], list)
                           for part in m["content"] if part.get("type") == "image_url")
        text, image, trained = count(messages, renderer, train_on)
        per_line.append(text + image)
        text_total += text
        image_total += image
        trained_total += trained
    digest = hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()
    return {
        "lines": len(lines),
        "sha256": digest,
        "by_origin": dict(Counter(m.get("origin") for m in metas)),
        "by_source": dict(Counter(m.get("source") for m in metas)),
        "by_lure_type": dict(Counter(m.get("lure_type") for m in metas)),
        "south_africa": sum(1 for m in metas if m.get("south_africa")),
        # The builder's canonical brand identity (`FNB` and `First National Bank` are one); a version built before it kept
        # none, so its raw name is folded instead.
        "brands": len({m.get("brand_identity") or str(m["brand"]).lower() for m in metas if m.get("brand")}),
        "screenshots": screenshots,
        "tokens": {
            "total": text_total + image_total,
            "text": text_total,
            "image": image_total,
            "trained": trained_total,
            "prompt": text_total + image_total - trained_total,
            "per_line": {"min": min(per_line, default=0), "median": statistics.median(per_line) if per_line else 0,
                         "max": max(per_line, default=0)},
        },
    }


def write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def stats(version, folder, renderer, train_on):
    summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
    return {
        "version": version,
        "mode": summary.get("mode"),
        "seed": summary.get("seed"),
        "dropped": summary.get("dropped"),
        "train": split_stats(folder, "train", renderer, train_on),
        "eval": split_stats(folder, "eval", renderer, train_on),
    }


def main(argv=None, renderer=None, train_on=None, out_dir=ROOT / "docs" / "glimmer"):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: dataset_stats.py <version>", file=sys.stderr)
        return 2
    version = args[0]
    folder = store_dir() / "dataset" / version
    if renderer is None:
        cookbook = Path(os.environ.get("FW_COOKBOOK", Path.home() / "src" / "fw-cookbook" / "training")).expanduser()
        sys.path.insert(0, str(cookbook.parent))
        from training.renderer import TrainOnWhat, get_renderer
        from training.renderer.muse_glimmer import MuseGlimmerImageTokenCounter
        from training.renderer.tokenizer import get_tokenizer

        renderer = get_renderer("muse_glimmer", get_tokenizer(TOKENIZER),
                                image_processor=MuseGlimmerImageTokenCounter.from_pretrained(TOKENIZER))
        train_on = TrainOnWhat.LAST_ASSISTANT_MESSAGE
    result = stats(version, folder, renderer, train_on)
    out = Path(out_dir) / f"dataset-{version}.json"
    write_atomic(out, json.dumps(result, indent=2) + "\n")
    print(f"dataset-stats: {result['train']['lines']} training and {result['eval']['lines']} evaluation lines; "
          f"{result['train']['tokens']['total']} training tokens into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
