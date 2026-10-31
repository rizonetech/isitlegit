#!/usr/bin/env python3
"""Train Loupe, the LoRA of Muse Glimmer 30B, on Fireworks' Serverless Training API (D03 T04 §11).

    ~/.venvs/fireworks/bin/python scripts/glimmer/train_serverless.py --version 1.0 --measure   # timed 50 examples
    ~/.venvs/fireworks/bin/python scripts/glimmer/train_serverless.py --version 1.0             # the run itself

The training loop is the Fireworks cookbook's own (`recipes/sft_loop.py` in serverless mode: session, batches, Adam,
checkpoints every 200 steps, resume, the final sampler checkpoint and its promotion to `isitlegit-loupe-<version>`).
This script decides whether a run may start and what it trains on, and keeps the run's records:

- no run starts on or after 2026-11-01 12:00 SAST (an interrupted one may resume after it), and none on a
  `train.jsonl` whose SHA-256 is not recorded under `Dataset` in `docs/glimmer/training.md`;
- the tokens to send, priced at US$5.86 a million, are held to US$60 a run; the cap is lifted until
  2026-11-30 23:59 SAST only while the probe's bill reconciliation under `Probe` reads `reconciled: US$0.00`, and it
  applies again from 2026-12-01 by the date below (operator, 2026-10-28 20:50 SAST);
- the set is cut, by source and `lure_type` in proportion with a fixed seed, to what trains before
  2026-11-01 22:00 SAST at the measured tokens a second;
- every step goes to `<store>/runs/loupe-<version>/metrics.jsonl`, a progress line to `Training` every 50 steps, and
  `run.json` at the end;
- a run keeps its training session open when it ends, so its checkpoints outlive a crash, and records the session, run
  and account in `serverless.json`; run again, an interrupted version continues from its newest checkpoint (the
  cookbook's `<account>/<run>/<checkpoint>` reference with the same log path) at the step and data position it saved.

The key is the operator's ("IsItLegit Fireworks Owner") through conclave-op, never printed.
"""
import argparse
import hashlib
import json
import logging
import os
import random
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TRAINING_MD = ROOT / "docs" / "glimmer" / "training.md"
BASE_MODEL = "accounts/fireworks/models/muse-glimmer-30b"
TOKENIZER = "meta-models/Muse-Glimmer-30B"
RENDERER = "muse_glimmer"
VAULT_ITEM = "IsItLegit Fireworks Owner"
SAST = timezone(timedelta(hours=2))
START_CUTOFF = datetime(2026, 11, 1, 12, 0, tzinfo=SAST)
TRAIN_UNTIL = datetime(2026, 11, 1, 22, 0, tzinfo=SAST)
FREE_UNTIL = datetime(2026, 11, 30, 23, 59, 59, tzinfo=SAST)
USD_PER_TOKEN = 5.86 / 1_000_000
CAP_USD = 60.0
PROGRESS_EVERY = 50
CHECKPOINT_EVERY = 200
LORA_RANK = 8
MAX_SEQ_LEN = 8192
BATCH_SIZE = 8
LEARNING_RATE = 1e-4
MEASURE_EXAMPLES = 50


class Refused(Exception):
    """A refusal before anything is sent, with the reason the operator reads."""


def store_dir():
    configured = os.environ.get("GLIMMER_DATA_DIR")
    return Path(configured).expanduser() if configured else Path.home() / "isitlegit-data" / "glimmer"


def names(version):
    """The Fireworks model ID and sampler checkpoint name for a version: `1.0` is `isitlegit-loupe-1-0`."""
    if not re.fullmatch(r"[1-9]\d?\.\d{1,2}", version):
        raise Refused(f"version {version!r} is not like 1.0")
    dashed = version.replace(".", "-")
    return f"isitlegit-loupe-{dashed}", f"loupe-{dashed}"


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def section(markdown, heading):
    match = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", markdown, re.MULTILINE | re.DOTALL)
    return match.group(1) if match else ""


def reconciled(markdown):
    """The probe's reconciled training bill in US dollars, or None before it is recorded."""
    found = re.findall(r"reconciled: US\$(\d+(?:\.\d+)?)", section(markdown, "Probe"))
    return float(found[-1]) if found else None


def cap_usd(now, bill):
    """The run's spend cap: none while training is free and proven free, US$60 otherwise and from 2026-12-01."""
    return None if now <= FREE_UNTIL and bill == 0.0 else CAP_USD


def check_start(now, sha, markdown, resuming):
    if now >= START_CUTOFF and not resuming:
        raise Refused("no Loupe run starts on or after 2026-11-01 12:00 SAST; an interrupted one may only resume")
    if sha not in section(markdown, "Dataset"):
        raise Refused(f"train.jsonl's SHA-256 {sha} is not recorded under Dataset in docs/glimmer/training.md")


def fit(groups, tokens, budget, seed):
    """Indices of a subset whose tokens fit `budget`, each group (source and lure type) cut by the same share, chosen
    with `seed`; everything when it all fits."""
    total = sum(tokens)
    if total <= budget:
        return list(range(len(tokens)))
    share = budget / total
    rng = random.Random(seed)
    by_group = {}
    for index, group in enumerate(groups):
        by_group.setdefault(group, []).append(index)
    chosen = []
    for group in sorted(by_group):
        members = by_group[group][:]
        rng.shuffle(members)
        allowance = share * sum(tokens[i] for i in members)
        used = 0
        for index in members:
            if used + tokens[index] > allowance:
                continue
            chosen.append(index)
            used += tokens[index]
    return sorted(chosen)


def line_tokens(line, renderer, train_on):
    """One training line's tokens as Glimmer's renderer counts them. The line carries OpenAI-style `image_url` parts and
    the cookbook renderer reads `image` parts (its training loop converts them the same way), so they are converted
    first: given raw, a screenshot would not be counted as the image it is."""
    messages = [{"role": m["role"], "content": [
        {"type": "image", "image": part["image_url"]["url"]} if part.get("type") == "image_url" else part
        for part in m["content"]] if isinstance(m["content"], list) else m["content"]}
        for m in json.loads(line)["messages"]]
    model_input, _ = renderer.build_supervised_example(messages, train_on_what=train_on)
    return sum(c.expected_tokens if c.type == "image" else len(c.tokens) for c in model_input.chunks)


def choose(groups, tokens, now, lines_per_second, cap, seed):
    """The lines to train on: cut first to what trains before TRAIN_UNTIL at the measured lines a second (the trainer's
    own token metric counts text only, so time is sized in lines), then, when a cap applies, to the tokens it pays for
    (images included). Each cut keeps sources and lure types in proportion with the seed."""
    chosen = list(range(len(tokens)))
    if lines_per_second:
        window = int(lines_per_second * max(0.0, (TRAIN_UNTIL - now).total_seconds()))
        chosen = [chosen[i] for i in fit([groups[i] for i in chosen], [1] * len(chosen), window, seed)]
    if cap is not None:
        picked = fit([groups[i] for i in chosen], [tokens[i] for i in chosen], int(cap / USD_PER_TOKEN), seed)
        chosen = [chosen[i] for i in picked]
    return chosen


def read_lines(path):
    with open(path, encoding="utf-8") as handle:
        return [line for line in handle if line.strip()]


def iter_lines(path):
    """A file's non-blank lines one at a time: a training file carries its screenshots (some 20 GB for Loupe 1.0), so it
    is never read whole."""
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield line


def count_lines(path):
    return sum(1 for _ in iter_lines(path))


def write_lines_atomic(path, lines):
    """Lines written one at a time to a temporary file, then put in place."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        for line in lines:
            handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def training_file(train_file, chosen, count, run_dir):
    """The file a run trains on: the dataset's own when every line is chosen (no copy of it is made), else the chosen
    lines streamed to `<run>/train.subset.jsonl`, in the dataset's order."""
    subset = Path(run_dir) / "train.subset.jsonl"
    if len(chosen) == count:
        return Path(train_file)
    keep = set(chosen)
    write_lines_atomic(subset, (line for index, line in enumerate(iter_lines(train_file)) if index in keep))
    return subset


def write_selection(run_dir, dataset_sha, train_file, chosen_tokens, seed, lines_per_second, cap):
    """What a run was started on, kept beside it: the dataset's SHA-256, the file trained on and its SHA-256, the seed,
    rate and cap the cut used, and each chosen line's tokens (images included), which the spend is counted in. A
    resume is held to it (`check_resume`)."""
    data = {"dataset_sha": dataset_sha, "file": str(train_file), "file_sha": sha256(train_file),
            "lines": len(chosen_tokens), "seed": seed, "lines_per_second": lines_per_second, "cap_usd": cap,
            "tokens": chosen_tokens}
    write_atomic(Path(run_dir) / "selection.json", json.dumps(data) + "\n")
    return data


def check_resume(run_dir, dataset_sha, train_file):
    """The selection an interrupted run continues on, refused unless it is the one it started with: the same dataset
    and the same training file, byte for byte."""
    saved = Path(run_dir) / "selection.json"
    if not saved.is_file():
        raise Refused(f"{run_dir} has no selection.json naming what it started on; it cannot be resumed")
    selection = json.loads(saved.read_text(encoding="utf-8"))
    if selection.get("dataset_sha") != dataset_sha:
        raise Refused(f"the dataset's SHA-256 is {dataset_sha}, not {selection.get('dataset_sha')}, which the run "
                      f"started on; it cannot be resumed on another dataset")
    if sha256(train_file) != selection.get("file_sha"):
        raise Refused(f"{train_file} is not the file the run started on (its SHA-256 differs); it cannot be resumed")
    return selection


def check_version(run_dir):
    """A version's lifecycle: new (no run yet), interrupted (a checkpoint to continue from: resumed), or over. A
    completed version and a failed one (it stopped before its first checkpoint, or its promotion did not read back) are
    never reused: the next run is the next version."""
    record = Path(run_dir) / "run.json"
    outcome = json.loads(record.read_text(encoding="utf-8")).get("outcome") if record.is_file() else None
    if outcome in ("completed", "promotion failed"):
        raise Refused(f"{Path(run_dir).name} is {outcome}; a version is never reused, so train the next version")
    if not (Path(run_dir) / "cookbook").is_dir():
        return None
    reference = resume_reference(run_dir)
    if reference is None:
        raise Refused(f"{Path(run_dir).name} failed before its first checkpoint; a version is never reused, a failed "
                      f"one included, so train the next version")
    return reference


def resumed_file(train_file, run_dir):
    """The file an interrupted run trained on: its subset when it made one, else the dataset's own."""
    subset = Path(run_dir) / "train.subset.jsonl"
    return subset if subset.is_file() else Path(train_file)


def read_groups(path, count):
    """Each line's source and lure type from §10's `train.meta.jsonl` beside the training file."""
    meta = Path(path).with_name("train.meta.jsonl")
    if not meta.is_file():
        raise Refused(f"{meta} is missing; build-dataset.ts writes it beside train.jsonl")
    rows = [json.loads(line) for line in read_lines(meta)]
    if len(rows) != count:
        raise Refused(f"{meta} has {len(rows)} lines for {count} training lines")
    return [f"{row.get('source')}/{row.get('lure_type')}" for row in rows]


def write_atomic(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def append_training(line, markdown_path=TRAINING_MD):
    """One line at the end of the `Training` section of docs/glimmer/training.md."""
    text = Path(markdown_path).read_text(encoding="utf-8")
    match = re.search(r"^## Training\n", text, re.MULTILINE)
    if not match:
        raise Refused(f"{markdown_path} has no Training section")
    following = re.search(r"^## ", text[match.end():], re.MULTILINE)
    end = match.end() + (following.start() if following else len(text) - match.end())
    body = text[match.end():end].rstrip("\n")
    body = f"{body}\n- {line}\n\n" if body.strip() else f"\n- {line}\n\n"
    write_atomic(markdown_path, text[:match.end()] + body + text[end:])


class Recorder:
    """The run's records: a metrics line a step, a progress line every 50 steps, and the stop at the cap."""

    def __init__(self, run_dir, version, cap, usd_per_token=USD_PER_TOKEN, markdown_path=TRAINING_MD, stop=None,
                 line_tokens=None, batch_size=BATCH_SIZE):
        # Each chosen line's tokens, images included (`selection.json`): a step is charged its batch's lines, since the
        # trainer's own token metric counts text only. Without them (the measure run) the metric is all there is.
        self.line_tokens, self.batch_size = line_tokens, batch_size
        self.run_dir = Path(run_dir)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.metrics = self.run_dir / "metrics.jsonl"
        self.version, self.cap, self.rate, self.markdown_path = version, cap, usd_per_token, markdown_path
        self.stop = stop or (lambda: os.kill(os.getpid(), 15))
        self.tokens = self._tokens_so_far()
        self.started = time.monotonic()
        self.session = None
        self.stopped_at_cap = False

    def _tokens_so_far(self):
        # A resumed run counts what its earlier sessions already sent.
        if not self.metrics.is_file():
            return 0
        last = 0
        for line in read_lines(self.metrics):
            last = json.loads(line).get("tokens_sent", last)
        return last

    def batch(self, step):
        """Step `step`'s lines (one-based, `batch_size` a step, in the file's order) and their tokens."""
        lines = self.line_tokens[(step - 1) * self.batch_size:step * self.batch_size] if step >= 1 else []
        return len(lines), sum(lines)

    def step(self, metrics, step):
        if step is None or "train/total_tokens" not in metrics:
            return  # the loop's own bookkeeping calls carry no training step
        # Every step sent is charged, a step trained again after a resume included.
        examples, charged = self.batch(step) if self.line_tokens is not None else (None, None)
        self.tokens += charged if charged is not None else int(metrics.get("train/total_tokens") or 0)
        record = {
            "step": step,
            "loss": metrics.get("train/ce_loss", metrics.get("train/loss")),
            "grad_norm": metrics.get("optim/grad_norm", metrics.get("train/grad_norm")),
            "tokens": metrics.get("train/total_tokens"),
            "examples": examples,
            "batch_tokens": charged,
            "tokens_per_sec": metrics.get("train/tokens_per_sec"),
            "lr": metrics.get("train/lr"),
            "seconds": round(time.monotonic() - self.started, 1),
            "tokens_sent": self.tokens,
            "spend_usd": round(self.tokens * self.rate, 4),
            "session": self.session,
        }
        with open(self.metrics, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if step % PROGRESS_EVERY == 0:
            append_training(f"Loupe {self.version} step {step}: loss {record['loss']}, {self.tokens} tokens sent, "
                            f"rated US${record['spend_usd']:.2f}", self.markdown_path)
        # The cap stops the run before the batch that would pass it is sent: the next batch is known from the selection.
        upcoming = self.batch(step + 1)[1] if self.line_tokens is not None else 0
        if self.cap is not None and (self.tokens + upcoming) * self.rate >= self.cap and not self.stopped_at_cap:
            # The loop's own SIGTERM handler drains and stops; its last 200-step checkpoint is where a resume starts.
            self.stopped_at_cap = True
            append_training(f"Loupe {self.version} stopped at step {step}: rated spend reached the US${self.cap:.0f} cap",
                            self.markdown_path)
            self.stop()


class ServerlessRun(logging.Handler):
    """Keeps the serverless session, run and account the cookbook names as it starts, which a resume needs."""

    # WORKAROUND: the cookbook gives the run and account ids a new process resumes from only in this log line
    # (`training/utils/serverless.py`, "To continue from one of this run's checkpoints in a new process, pass
    # init_from_checkpoint='<account>/<run>/<checkpoint>'"), so the handler reads the line's own arguments.
    LOGGER = "training.utils.serverless"

    def __init__(self, run_dir, recorder, started=None):
        super().__init__()
        self.path, self.recorder, self.started = Path(run_dir) / "serverless.json", recorder, started

    def emit(self, record):
        if not str(record.msg).startswith("Serverless training session") or len(record.args or ()) != 4:
            return
        session, run, account, _ = record.args
        self.recorder.session = session
        write_atomic(self.path, json.dumps({"session": session, "run": run, "account": account}) + "\n")
        if self.started:
            self.started(session)


def resume_reference(run_dir):
    """The checkpoint an interrupted run continues from, `<account>/<run>/<checkpoint>`, or None before its first."""
    saved = Path(run_dir) / "cookbook" / "dataloader.json"
    checkpoints = json.loads(saved.read_text(encoding="utf-8")).get("checkpoints", {}) if saved.is_file() else {}
    if not checkpoints:
        return None
    ids = Path(run_dir) / "serverless.json"
    if not ids.is_file():
        raise Refused(f"{run_dir} has checkpoints but no serverless.json naming their run; it cannot be resumed")
    run = json.loads(ids.read_text(encoding="utf-8"))
    newest = max(checkpoints, key=lambda name: (checkpoints[name] or {}).get("step", -1))
    return f"{run['account']}/{run['run']}/{newest}"


def run_json(run_dir, version, model_id, params, started, ended, outcome, session=None, promoted=None):
    lines = [json.loads(line) for line in read_lines(Path(run_dir) / "metrics.jsonl")] if (
        Path(run_dir) / "metrics.jsonl").is_file() else []
    # The loop names its session only when it returns (its `job_id`); a resumed run's earlier sessions are in its lines.
    sessions = sorted({line["session"] for line in lines if line.get("session")} | ({session} if session else set()))
    data = {
        "version": version,
        # The lines this version trained on: the version gate (§13) promotes only a version that trained on more.
        "lines_trained": params.get("lines_trained"),
        "model_id": model_id,
        "base_model": BASE_MODEL,
        "hyperparameters": params,
        "started": started,
        "ended": ended,
        "outcome": outcome,
        "steps": lines[-1]["step"] if lines else 0,
        "tokens_sent": lines[-1]["tokens_sent"] if lines else 0,
        "rated_usd": lines[-1]["spend_usd"] if lines else 0.0,
        "first_loss": lines[0]["loss"] if lines else None,
        "last_loss": lines[-1]["loss"] if lines else None,
        "sessions": sessions,
        "resumes": max(0, len(sessions) - 1),
        # The promotion as it read back (`output-model.json` and the model's state), or None when there was none.
        "promoted": promoted,
        # `rated_usd` is the tokens at the list price, an estimate; the bill once it settles is recorded by hand.
        "billed_usd": None,
    }
    write_atomic(Path(run_dir) / "run.json", json.dumps(data, indent=2) + "\n")
    return data


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


def promotion(run_dir, model_id, verify):
    """The promoted model as the cookbook recorded it (`output-model.json`) and as Fireworks reads it back: refused
    unless the record names this version's model and a checkpoint, and `verify(model_id)` reads READY."""
    saved = Path(run_dir) / "output-model.json"
    record = json.loads(saved.read_text(encoding="utf-8")) if saved.is_file() else {}
    if record.get("model_id") != model_id or not record.get("checkpoint"):
        raise Refused(f"the run ended without a promotion of {model_id} on record ({saved.name}: {record or 'none'})")
    state = verify(model_id) if verify else None
    if verify and state != "READY":
        raise Refused(f"{model_id} reads {state}, not READY, after its promotion")
    return {"model_id": model_id, "checkpoint": record["checkpoint"], "state": state}


def model_state(key, account):
    """Reads a model's state from Fireworks (`GET /v1/accounts/<account>/models/<id>`), the key only in its header."""
    def read(model_id):
        request = urllib.request.Request(f"https://api.fireworks.ai/v1/accounts/{account}/models/{model_id}",
                                         headers={"Authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8")).get("state")
        except (urllib.error.URLError, ValueError) as error:
            return f"unreadable ({type(error).__name__})"
    return read


def train(loop, train_file, version, run_dir, recorder, examples=None, promote=True, runner_config=None,
          resume_from=None, dataset_sha=None, verify=None):
    """One cookbook SFT run on `train_file`. `loop` is the cookbook's `recipes.sft_loop` module (a fake in tests)."""
    model_id, _checkpoint = names(version)
    lines = examples if examples is not None else count_lines(train_file) if Path(train_file).is_file() else None
    params = {"lora_rank": LORA_RANK, "learning_rate": LEARNING_RATE, "batch_size": BATCH_SIZE, "epochs": 1,
              "max_seq_len": MAX_SEQ_LEN, "checkpoint_every": CHECKPOINT_EVERY, "warmup_steps": 0,
              "lines_trained": lines}
    if runner_config is None:
        from training.utils.runner import RunnerConfig as runner_config

    config = loop.Config(
        log_path=str(Path(run_dir) / "cookbook"),
        base_model=BASE_MODEL,
        dataset=str(train_file),
        tokenizer_model=TOKENIZER,
        renderer_name=RENDERER,
        train_on_what="last_assistant_message",
        learning_rate=LEARNING_RATE,
        epochs=1,
        batch_size=BATCH_SIZE,
        max_seq_len=MAX_SEQ_LEN,
        max_examples=examples,
        lora_rank=LORA_RANK,
        output_model_id=model_id if promote else None,
        serverless=True,
        # A closed session ends its checkpoints, on the crash path too: only the unpromoted measure closes its own.
        close_session_on_exit=not promote,
        init_from_checkpoint=resume_from,
        dcp_save_interval=CHECKPOINT_EVERY,
        runner=runner_config(status_file=str(Path(run_dir) / "status.json"),
                            metadata_file=str(Path(run_dir) / "metadata.json"),
                            metrics_file=str(Path(run_dir) / "eval-metrics.jsonl"),
                            output_model_path=str(Path(run_dir) / "output-model.json")),
    )
    # WORKAROUND: the cookbook writes a training step's metrics (loss, tokens, gradient norm) only to its W&B logger,
    # with no file or callback for them, so the run's recorder wraps that logger to keep its own copy of each step.
    original = loop.wandb_log

    def recording(metrics, step=None):
        recorder.step(metrics, step)
        return original(metrics, step)

    loop.wandb_log = recording
    def started_line(session):
        # Each version's record under `Training` once its job exists, so a failed one has its line too.
        append_training(f"Loupe {version}: {model_id}, trained {datetime.now(timezone.utc).date().isoformat()}, "
                        f"dataset {dataset_sha}, job {session}", recorder.markdown_path)

    ids = ServerlessRun(run_dir, recorder, started_line if promote else None)
    named = logging.getLogger(ServerlessRun.LOGGER)
    level = named.level
    named.setLevel(logging.INFO)  # the line is INFO, which an unconfigured logger drops before any handler
    named.addHandler(ids)
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    outcome = "failed"
    try:
        result = loop.main(config)
        session = (result or {}).get("job_id") if isinstance(result, dict) else None
        if recorder.stopped_at_cap:
            outcome, promoted = "stopped at cap", None
        elif promote:
            # A run that returned is complete only once its promotion reads back.
            outcome = "promotion failed"
            promoted = promotion(run_dir, model_id, verify)
            outcome = "completed"
        else:
            outcome, promoted = "completed", None
        return result, run_json(run_dir, version, model_id if promoted else None, params, started,
                                datetime.now(timezone.utc).isoformat(timespec="seconds"), outcome, session, promoted)
    except BaseException:
        run_json(run_dir, version, None, params, started, datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 "stopped at cap" if recorder.stopped_at_cap else outcome)
        raise
    finally:
        loop.wandb_log = original
        named.removeHandler(ids)
        named.setLevel(level)


def main(argv=None, now=None):
    parser = argparse.ArgumentParser(description="Train Loupe on Fireworks' Serverless Training API (D03 T04 §11).")
    parser.add_argument("--version", required=True, help="the Loupe version, like 1.0")
    parser.add_argument("--train", default=None, help="train.jsonl (default: <store>/dataset/<version>/train.jsonl)")
    parser.add_argument("--measure", action="store_true", help=f"train {MEASURE_EXAMPLES} examples, unpromoted, to "
                                                               "measure tokens a second")
    parser.add_argument("--lines-per-second", type=float, help="the measured rate (the --measure run's lines over its "
                                                                  "step seconds); the set is cut to the time window")
    parser.add_argument("--seed", type=int, default=20261101)
    args = parser.parse_args(argv)
    now = now or datetime.now(timezone.utc)
    try:
        model_id, _ = names(args.version)
        train_file = Path(args.train) if args.train else store_dir() / "dataset" / args.version / "train.jsonl"
        if not train_file.is_file():
            raise Refused(f"{train_file} is missing; build it with scripts/glimmer/build-dataset.ts")
        markdown = TRAINING_MD.read_text(encoding="utf-8")
        run_dir = store_dir() / "runs" / (f"loupe-{args.version}-measure" if args.measure else f"loupe-{args.version}")
        resume_from = None if args.measure else check_version(run_dir)
        resuming = resume_from is not None
        if not args.measure and not resuming and not (args.lines_per_second and args.lines_per_second > 0):
            raise Refused("a run needs --lines-per-second from the --measure run, so the set fits the time window")
        # Only a run with a checkpoint to continue from is a resume past the cutoff.
        dataset_sha = sha256(train_file)
        check_start(now, dataset_sha, markdown, resume_from is not None)
        cap = cap_usd(now, reconciled(markdown))
        cookbook = Path(os.environ.get("FW_COOKBOOK", Path.home() / "src" / "fw-cookbook" / "training")).expanduser()
        sys.path.insert(0, str(cookbook.parent))
        from training.renderer import TrainOnWhat, get_renderer
        from training.renderer.muse_glimmer import MuseGlimmerImageTokenCounter
        from training.renderer.tokenizer import get_tokenizer

        renderer = get_renderer(RENDERER, get_tokenizer(TOKENIZER),
                                image_processor=MuseGlimmerImageTokenCounter.from_pretrained(TOKENIZER))
        chosen_tokens = None
        if resuming:
            # The set was chosen when the run started; a resume trains on the same file, refused if it changed.
            train_file = resumed_file(train_file, run_dir)
            chosen_tokens = check_resume(run_dir, dataset_sha, train_file)["tokens"]
        elif not args.measure:
            tokens = [line_tokens(line, renderer, TrainOnWhat.LAST_ASSISTANT_MESSAGE) for line in iter_lines(train_file)]
            groups = read_groups(train_file, len(tokens))
            chosen = choose(groups, tokens, now, args.lines_per_second, cap, args.seed)
            if not chosen:
                raise Refused("no line fits the time window and the cap; nothing would train")
            append_training(f"Loupe {args.version}: {model_id}, set {len(chosen)} of {len(tokens)} lines "
                            f"({sum(tokens[i] for i in chosen)} tokens, seed {args.seed}, cap "
                            f"{'lifted' if cap is None else f'US${cap:.0f}'}), dataset {dataset_sha}")
            train_file = training_file(train_file, chosen, len(tokens), run_dir)
            chosen_tokens = [tokens[i] for i in chosen]
            write_selection(run_dir, dataset_sha, train_file, chosen_tokens, args.seed, args.lines_per_second, cap)
        key = read_key()
        os.environ["FIREWORKS_API_KEY"] = key
        from training.recipes import sft_loop

        recorder = Recorder(run_dir, args.version, cap, line_tokens=chosen_tokens)
        if resume_from:
            append_training(f"Loupe {args.version} resumed from {resume_from.rsplit('/', 1)[-1]}", TRAINING_MD)
        _result, record = train(sft_loop, train_file, args.version, run_dir, recorder,
                                examples=MEASURE_EXAMPLES if args.measure else None, promote=not args.measure,
                                resume_from=resume_from, dataset_sha=dataset_sha,
                                verify=model_state(key, os.environ.get("FIREWORKS_ACCOUNT", "rizonetech")))
    except Refused as refusal:
        print(f"train-serverless: refused: {refusal}", file=sys.stderr)
        return 2
    print(json.dumps(record, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
