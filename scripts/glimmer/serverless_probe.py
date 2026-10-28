#!/usr/bin/env python3
"""Probe Muse Glimmer's training on the Serverless Training API (D03 T04 §2).

    ~/.venvs/fireworks/bin/python scripts/glimmer/serverless_probe.py            # the probe (Fireworks, free SFT)
    ~/.venvs/fireworks/bin/python scripts/glimmer/serverless_probe.py --dry-run  # render and count, send nothing

Fireworks has closed dataset uploads (support, 2026-10-28), so the probe never uploads: it opens a LoRA session on the
serverless trainer, renders the three probe examples with Fireworks' own Muse Glimmer renderer (the cookbook's
`muse_glimmer`, with Glimmer's image processor, so each screenshot is an `ImageChunk` with its exact token count) and
runs one cross-entropy `forward_backward` on them, then the same on the three text-only controls. There is no
optimiser step and no checkpoint: the base model is never changed. The session is closed whatever happens.

The answer is the training mode: `image` when the image step returned a loss; `text-only` when it was refused for its
images and the control returned one; none otherwise (the cause is fixed and the probe run again). Both files come from
`node scripts/fireworks-check.ts --write-probe-lines`. At most 20,000 tokens are sent. The key is the operator's own
("IsItLegit Fireworks Owner", through conclave-op), never printed.

Needs the Fireworks training SDK and the cookbook in a venv outside the repository: `~/.venvs/fireworks` with
`fireworks-ai[training]` and `~/src/fw-cookbook/training` installed (`FW_COOKBOOK` overrides the path).
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE_MODEL = "accounts/fireworks/models/muse-glimmer-30b"
TOKENIZER = "meta-models/Muse-Glimmer-30B"
RENDERER = "muse_glimmer"
SERVERLESS_URL = "https://api.fireworks.ai/training/v1/serverless"
VAULT_ITEM = "IsItLegit Fireworks Owner"
IMAGE_FILE = ROOT / "build" / "glimmer" / "probe.jsonl"
TEXT_FILE = ROOT / "build" / "glimmer" / "probe-text.jsonl"
TOKEN_CAP = 20_000
IMAGE_WORDS = re.compile(r"\b(image|images|vision|multimodal|image_url|imagechunk)\b", re.IGNORECASE)


def conversation(messages):
    """OpenAI chat messages as the cookbook renderer reads them: an `image_url` part becomes an `image` part."""
    out = []
    for message in messages:
        content = message["content"]
        if isinstance(content, list):
            content = [{"type": "image", "image": part["image_url"]["url"]} if part.get("type") == "image_url" else part
                       for part in content]
        out.append({"role": message["role"], "content": content})
    return out


def load(path):
    lines = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        raise ValueError(f"{path} has no probe lines; run node scripts/fireworks-check.ts --write-probe-lines")
    return [conversation(line["messages"]) for line in lines]


def tokens_of(model_input):
    return sum(chunk.expected_tokens if chunk.type == "image" else len(chunk.tokens) for chunk in model_input.chunks)


def build(examples, renderer, train_on, datum_type):
    """Training datums for the examples, and how many tokens they hold, images counted exactly."""
    if datum_type is None:
        from training.renderer.supervised import datum_from_model_input_weights as datum_type
    datums, total = [], 0
    for messages in examples:
        model_input, weights = renderer.build_supervised_example(messages, train_on_what=train_on)
        total += tokens_of(model_input)
        datums.append(datum_type(model_input, weights))
    return datums, total


def step(client, datums):
    """One cross-entropy forward and backward pass: its metrics, or the refusal's text."""
    try:
        output = client.forward_backward(datums, "cross_entropy").result()
        return {"ok": True, "metrics": dict(getattr(output, "metrics", {}) or {})}
    except Exception as error:  # the refusal is the finding: it is recorded, never raised past the session's close
        return {"ok": False, "error": f"{type(error).__name__}: {error}"[:500]}


def decide(image, text):
    if image["ok"]:
        return "image"
    if text["ok"] and IMAGE_WORDS.search(image.get("error", "")):
        return "text-only"
    return None


def run(service_factory, renderer, image_examples, text_examples, train_on, datum_type=None, cap=TOKEN_CAP):
    """The probe against whatever service and renderer it is given (the real SDK, or a test's fakes)."""
    image_datums, image_tokens = build(image_examples, renderer, train_on, datum_type)
    text_datums, text_tokens = build(text_examples, renderer, train_on, datum_type)
    sent = image_tokens + text_tokens
    if sent > cap:
        return {"refused": f"{sent} tokens is over the {cap}-token cap", "tokens": sent}
    service = service_factory()
    try:
        client = service.create_lora_training_client(base_model=BASE_MODEL, rank=8)
        result = {"session": str(service.training_session_id), "tokens": sent,
                  "image_tokens": image_tokens, "text_tokens": text_tokens}
        result["image"] = step(client, image_datums)
        result["text"] = step(client, text_datums)
        result["mode"] = decide(result["image"], result["text"])
        return result
    finally:
        service.close()


def read_key():
    try:
        out = subprocess.run(["conclave-op", "read", f"op://Conclave/{VAULT_ITEM}/credential"], capture_output=True,
                             text=True, timeout=60, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f"serverless-probe: reading {VAULT_ITEM!r} failed ({type(error).__name__})") from None
    key = out.stdout.strip()
    if not key:
        raise SystemExit(f"serverless-probe: the vault item {VAULT_ITEM!r} has an empty credential")
    return key


def main(argv=None):
    parser = argparse.ArgumentParser(description="Probe Muse Glimmer's training on the Serverless Training API.")
    parser.add_argument("--dry-run", action="store_true", help="render and count the tokens; send nothing")
    args = parser.parse_args(argv)

    cookbook = Path(os.environ.get("FW_COOKBOOK", Path.home() / "src" / "fw-cookbook" / "training")).expanduser()
    if not (cookbook / "renderer" / "muse_glimmer.py").is_file():
        raise SystemExit(f"serverless-probe: the Fireworks cookbook is not at {cookbook}; set FW_COOKBOOK")
    sys.path.insert(0, str(cookbook.parent))
    # The cookbook and the SDK exist only in the venv, so they are imported here, not at the top: the tests drive
    # `run()` with fakes on the system Python.
    from training.renderer import TrainOnWhat, get_renderer
    from training.renderer.muse_glimmer import MuseGlimmerImageTokenCounter
    from training.renderer.tokenizer import get_tokenizer

    renderer = get_renderer(RENDERER, get_tokenizer(TOKENIZER),
                            image_processor=MuseGlimmerImageTokenCounter.from_pretrained(TOKENIZER))
    image_examples, text_examples = load(IMAGE_FILE), load(TEXT_FILE)
    train_on = TrainOnWhat.LAST_ASSISTANT_TURN
    if args.dry_run:
        _, image_tokens = build(image_examples, renderer, train_on, None)
        _, text_tokens = build(text_examples, renderer, train_on, None)
        print(json.dumps({"image_tokens": image_tokens, "text_tokens": text_tokens, "cap": TOKEN_CAP}))
        return 0

    key = read_key()
    from fireworks.training.sdk import FiretitanServiceClient

    def factory():
        return FiretitanServiceClient(api_key=key, base_url=SERVERLESS_URL)

    result = run(factory, renderer, image_examples, text_examples, train_on)
    print(json.dumps(result, indent=2).replace(key, "[key]"))
    return 0 if result.get("mode") else 1


if __name__ == "__main__":
    sys.exit(main())
