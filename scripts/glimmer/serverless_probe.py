#!/usr/bin/env python3
"""Probe Muse Glimmer's training on the Serverless Training API (D03 T04 §2).

    node scripts/fireworks-check.ts --write-probe-lines                          # 1. the two probe files (local)
    ~/.venvs/fireworks/bin/python scripts/glimmer/serverless_probe.py            # 2. the probe (free Glimmer SFT)
    ~/.venvs/fireworks/bin/python scripts/glimmer/serverless_probe.py --dry-run  # render and count, send nothing

Fireworks has closed dataset uploads (support, 2026-10-28), so the probe never uploads: it opens a LoRA session on the
serverless trainer, renders the three probe examples with Fireworks' own Muse Glimmer renderer (the cookbook's
`muse_glimmer`, with Glimmer's image processor, so each screenshot is an `ImageChunk` with its exact token count) and
runs one cross-entropy `forward_backward` on them, then the same on the three text-only controls. There is no
optimiser step and no checkpoint: the base model is never changed.

The answer is the training mode. `image` needs the image step to return a finite loss over examples that each rendered
an image; `text-only` needs the image step refused with an explicit unsupported-capability message and the control to
return a finite loss; anything else (a decode error, an outage, a timeout, no loss) decides nothing, and the probe is
run again once the cause is fixed. A receipt (`build/glimmer/probe-receipt.json`, written temp-then-rename after each
stage, without the key) keeps every finished result, so a failed close or a cancel never costs a finished pass, and an
earlier attempt's receipt is kept under its start time. The session is deleted (freeing its slot) and the client closed
on every path, SIGTERM included. Each pass waits at most 300 seconds. At most 20,000 tokens are sent,
and nothing starts on or after 2026-12-01 SAST, when the free Glimmer training offer has ended. The key is the
operator's own ("IsItLegit Fireworks Owner", through conclave-op), never printed.

Needs the Fireworks training SDK and the cookbook in a venv outside the repository: `~/.venvs/fireworks` with
`fireworks-ai[training]` and `~/src/fw-cookbook/training` installed (`FW_COOKBOOK` overrides the path).
"""
import argparse
import json
import math
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE_MODEL = "accounts/fireworks/models/muse-glimmer-30b"
TOKENIZER = "meta-models/Muse-Glimmer-30B"
RENDERER = "muse_glimmer"
SERVERLESS_URL = "https://api.fireworks.ai/training/v1/serverless"
VAULT_ITEM = "IsItLegit Fireworks Owner"
IMAGE_FILE = ROOT / "build" / "glimmer" / "probe.jsonl"
TEXT_FILE = ROOT / "build" / "glimmer" / "probe-text.jsonl"
RECEIPT = ROOT / "build" / "glimmer" / "probe-receipt.json"
TOKEN_CAP = 20_000
STEP_SECONDS = 300
# The free Glimmer training offer ends 2026-11-30; nothing starts from the first instant of 2026-12-01 in South Africa,
# the cutoff scripts/fireworks-check.ts holds for the managed route.
CUTOFF = datetime(2026, 11, 30, 22, 0, tzinfo=timezone.utc)
LOSS_KEY = "loss:sum"
# Only an explicit statement that image input as such is missing proves text-only. A decode error, an outage, or a
# limit on one image's format, resolution or size is not one: those name something to fix in the input.
UNSUPPORTED = re.compile(
    r"(not supported|unsupported|does not support|doesn't support|cannot accept|can't accept|not accepted|"
    r"not enabled|disabled)[^.\n]{0,60}\b(image inputs?|images|vision|multimodal|imagechunks?|image chunks?)\b"
    r"|\b(image inputs?|images|vision|multimodal|imagechunks?|image chunks?)\b[^.\n]{0,60}(not supported|"
    r"unsupported|not accepted|not enabled|disabled)",
    re.IGNORECASE,
)
INPUT_LIMIT = re.compile(r"\b(format|resolution|size|dimensions?|too (large|big|small)|larger|smaller|exceed\w*|"
                         r"limit\w*|max(imum)?|tokens?|pixels?|jpe?g|png|decode|corrupt\w*)", re.IGNORECASE)


class Refused(Exception):
    """A refusal before anything is sent, with the reason the operator reads."""


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
    """The probe's examples from one file, or a refusal naming the file and the command that writes it."""
    fix = "run node scripts/fireworks-check.ts --write-probe-lines"
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        raise Refused(f"{path} is missing; {fix}") from None
    except OSError as error:
        raise Refused(f"{path} cannot be read ({error.strerror or error}); fix its permissions or {fix}") from None
    try:
        lines = [json.loads(line) for line in raw.splitlines() if line.strip()]
        examples = [conversation(line["messages"]) for line in lines]
    except (ValueError, KeyError, TypeError) as error:
        raise Refused(f"{path} is not probe JSONL ({type(error).__name__}); {fix}") from None
    if not examples:
        raise Refused(f"{path} has no probe lines; {fix}")
    return examples


def image_chunks(model_input):
    return sum(1 for chunk in model_input.chunks if chunk.type == "image")


def tokens_of(model_input):
    return sum(chunk.expected_tokens if chunk.type == "image" else len(chunk.tokens) for chunk in model_input.chunks)


def build(examples, renderer, train_on, datum_type, images):
    """Training datums and their token count; each example must render exactly as its file promises (an image in
    every image example, none in a control), so a text file can never pass as the screenshot proof."""
    if datum_type is None:
        from training.renderer.supervised import datum_from_model_input_weights as datum_type
    datums, total = [], 0
    for number, messages in enumerate(examples, 1):
        model_input, weights = renderer.build_supervised_example(messages, train_on_what=train_on)
        found = image_chunks(model_input)
        if images and found < 1:
            raise Refused(f"image example {number} rendered no image; rewrite the files with --write-probe-lines")
        if not images and found:
            raise Refused(f"text control {number} rendered an image; rewrite the files with --write-probe-lines")
        total += tokens_of(model_input)
        datums.append(datum_type(model_input, weights))
    return datums, total


def step(client, datums, timeout=STEP_SECONDS):
    """One cross-entropy forward and backward pass: a finite loss, or why there is none."""
    started = time.monotonic()
    try:
        output = client.forward_backward(datums, "cross_entropy").result(timeout=timeout)
    except Exception as error:  # the refusal or failure is the finding; it is recorded, and the session still closes
        seconds = round(time.monotonic() - started, 1)
        return {"ok": False, "error": f"{type(error).__name__}: {error}"[:500], "seconds": seconds}
    metrics = dict(getattr(output, "metrics", None) or {})
    loss = metrics.get(LOSS_KEY)
    seconds = round(time.monotonic() - started, 1)
    if isinstance(loss, bool) or not isinstance(loss, (int, float)) or not math.isfinite(loss):
        return {"ok": False, "error": f"no finite {LOSS_KEY} in the result ({loss!r})", "metrics": metrics,
                "seconds": seconds}
    return {"ok": True, "loss": float(loss), "metrics": metrics, "seconds": seconds}


def decide(image, text):
    if image and image["ok"]:
        return "image"
    error = image.get("error", "") if image else ""
    if image and text and text["ok"] and UNSUPPORTED.search(error) and not INPUT_LIMIT.search(error):
        return "text-only"
    return None


def write_receipt(path, receipt):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(f"{path}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


class Cancelled(BaseException):
    """A signal to stop. A BaseException, as KeyboardInterrupt is, so a pass's own error handling never takes it for a
    failed pass and carries on."""


def run(service_factory, renderer, image_examples, text_examples, train_on, datum_type=None, cap=TOKEN_CAP,
        receipt_path=RECEIPT, say=print, timeout=STEP_SECONDS):
    """The probe against whatever service and renderer it is given (the real SDK, or a test's fakes). Every finished
    stage is in the receipt before the next starts; the close's own failure is recorded beside the results."""
    image_datums, image_tokens = build(image_examples, renderer, train_on, datum_type, images=True)
    text_datums, text_tokens = build(text_examples, renderer, train_on, datum_type, images=False)
    sent = image_tokens + text_tokens
    if sent > cap:
        raise Refused(f"{sent} tokens is over the {cap}-token cap")
    # An earlier attempt's receipt is kept under its start time, never replaced: a retry cannot erase a finished
    # pass.
    earlier = Path(receipt_path)
    if earlier.exists():
        try:
            stamp = json.loads(earlier.read_text(encoding="utf-8")).get("started", "unknown")
        except (OSError, ValueError):
            stamp = "unreadable"
        kept = earlier.with_name(f"{earlier.stem}.{re.sub(r'[^0-9A-Za-z]', '', str(stamp)) or 'unknown'}.json")
        if not kept.exists():
            os.replace(earlier, kept)
    receipt = {"started": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tokens": sent,
               "image_tokens": image_tokens, "text_tokens": text_tokens, "stage": "opening"}
    write_receipt(receipt_path, receipt)

    def cancel(signum, _frame):
        raise Cancelled(signal.Signals(signum).name)

    previous = {sig: signal.signal(sig, cancel) for sig in (signal.SIGTERM, signal.SIGHUP)}
    service = None
    try:
        say("serverless-probe: opening a session on Muse Glimmer 30B")
        service = service_factory()
        client = service.create_lora_training_client(base_model=BASE_MODEL, rank=8)
        receipt["session"] = str(service.training_session_id)
        for name, datums in (("image", image_datums), ("text", text_datums)):
            receipt["stage"] = name
            write_receipt(receipt_path, receipt)
            say(f"serverless-probe: {name} pass ({len(datums)} examples), waiting up to {timeout} s")
            receipt[name] = step(client, datums, timeout=timeout)
            outcome = "returned a loss" if receipt[name]["ok"] else "failed"
            say(f"serverless-probe: {name} pass {outcome} after {receipt[name]['seconds']} s")
            write_receipt(receipt_path, receipt)
        receipt["stage"] = "done"
    except (Cancelled, KeyboardInterrupt) as stop:
        receipt["stage"] = f"cancelled ({stop or 'SIGINT'})"
    except Exception as error:  # a session that cannot open is recorded; the receipt keeps what finished
        receipt["stage"] = "failed"
        receipt["error"] = f"{type(error).__name__}: {error}"[:500]
    finally:
        # No signal may cut the cleanup short: SIGINT (Ctrl+C), SIGTERM and SIGHUP wait until the session is deleted,
        # the client closed and the receipt written.
        held = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
        if service is not None:
            # Closing the client does not free the session's slot on Fireworks; deleting the session does
            # (https://docs.fireworks.ai/fine-tuning/training-api/serverless#capacity-and-rate-limits). Both are tried,
            # each failure reported beside the results, never instead of them.
            # The service may own a session even when making the client failed or was interrupted, so cleanup asks the
            # service itself rather than trusting the receipt.
            try:
                owned = getattr(service, "training_session_id", None)
            except Exception:  # an SDK that cannot say has no session to name; the receipt keeps any it recorded
                owned = None
            if owned and not receipt.get("session"):
                receipt["session"] = str(owned)
            if owned or receipt.get("session"):
                try:
                    service.delete_training_session()
                    receipt["deleted"] = True
                except BaseException as error:  # even an interrupt here must leave the close and the receipt to run
                    receipt["deleted"] = False
                    receipt["delete_error"] = f"{type(error).__name__}: {error}"[:300]
            try:
                service.close()
                receipt["closed"] = True
            except BaseException as error:
                receipt["closed"] = False
                receipt["close_error"] = f"{type(error).__name__}: {error}"[:300]
        for sig, handler in held.items():
            signal.signal(sig, handler)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        receipt["mode"] = decide(receipt.get("image"), receipt.get("text"))
        receipt["ended"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        write_receipt(receipt_path, receipt)
    return receipt


def read_key():
    try:
        out = subprocess.run(["conclave-op", "read", f"op://Conclave/{VAULT_ITEM}/credential"], capture_output=True,
                             text=True, timeout=60, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise Refused(f"reading {VAULT_ITEM!r} failed ({type(error).__name__})") from None
    key = out.stdout.strip()
    if not key:
        raise Refused(f"the vault item {VAULT_ITEM!r} has an empty credential")
    return key


def main(argv=None, now=None):
    parser = argparse.ArgumentParser(
        description="Probe Muse Glimmer's training on the Serverless Training API. First write the probe files with "
                    "`node scripts/fireworks-check.ts --write-probe-lines`.")
    parser.add_argument("--dry-run", action="store_true", help="render and count the tokens; send nothing")
    args = parser.parse_args(argv)
    key = None
    try:
        if not args.dry_run and (now or datetime.now(timezone.utc)) >= CUTOFF:
            raise Refused("the free Glimmer training offer ended 2026-11-30; no probe starts on or after 2026-12-01")
        cookbook = Path(os.environ.get("FW_COOKBOOK", Path.home() / "src" / "fw-cookbook" / "training")).expanduser()
        if not (cookbook / "renderer" / "muse_glimmer.py").is_file():
            raise Refused(f"the Fireworks cookbook is not at {cookbook}; set FW_COOKBOOK")
        image_examples, text_examples = load(IMAGE_FILE), load(TEXT_FILE)
        sys.path.insert(0, str(cookbook.parent))
        # The cookbook and the SDK exist only in the venv, so they are imported here, not at the top: the tests drive
        # `run()` with fakes on the system Python.
        from training.renderer import TrainOnWhat, get_renderer
        from training.renderer.muse_glimmer import MuseGlimmerImageTokenCounter
        from training.renderer.tokenizer import get_tokenizer

        renderer = get_renderer(RENDERER, get_tokenizer(TOKENIZER),
                                image_processor=MuseGlimmerImageTokenCounter.from_pretrained(TOKENIZER))
        train_on = TrainOnWhat.LAST_ASSISTANT_TURN
        if args.dry_run:
            _, image_tokens = build(image_examples, renderer, train_on, None, images=True)
            _, text_tokens = build(text_examples, renderer, train_on, None, images=False)
            print(json.dumps({"image_tokens": image_tokens, "text_tokens": text_tokens, "cap": TOKEN_CAP}))
            return 0
        key = read_key()
        from fireworks.training.sdk import FiretitanServiceClient

        def factory():
            return FiretitanServiceClient(api_key=key, base_url=SERVERLESS_URL)

        result = run(factory, renderer, image_examples, text_examples, train_on)
    except Refused as refusal:
        print(f"serverless-probe: refused: {refusal}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2).replace(key, "[key]"))
    return 0 if result.get("mode") else 1


if __name__ == "__main__":
    sys.exit(main())
