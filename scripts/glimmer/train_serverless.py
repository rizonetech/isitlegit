#!/usr/bin/env python3
"""Train Loupe, the LoRA of Muse Glimmer 30B, on Fireworks' Serverless Training API (D03 T04 §11).

    ~/.venvs/fireworks/bin/python scripts/glimmer/train_serverless.py --version 1.1 --measure
        # 50 examples, unpromoted: prints the lines a second it measured and the command for the run itself
    ~/.venvs/fireworks/bin/python scripts/glimmer/train_serverless.py --version 1.1 --lines-per-second <measured>
        # the run; run again with the same command to resume an interrupted one

The training loop is the Fireworks cookbook's own (`recipes/sft_loop.py` in serverless mode: session, batches, Adam,
checkpoints every 200 steps, resume, the final sampler checkpoint and its promotion to `isitlegit-loupe-<version>`).
This script decides whether a run may start and what it trains on, and keeps the run's records:

- no run starts on or after 2026-11-04 20:00 SAST (an interrupted one may resume after it), and none on a
  `train.jsonl` whose SHA-256 is not recorded under `Dataset` in `docs/glimmer/training.md`;
- the tokens to send, priced at US$5.86 a million, are held to US$60 a run; the cap is lifted until
  2026-11-30 23:59 SAST only while the probe's bill reconciliation under `Probe` reads `reconciled: US$0.00`, and it
  applies again from 2026-12-01 by the date below (operator, 2026-10-28 20:50 SAST);
- the set is cut, by source and `lure_type` in proportion with a fixed seed, to what trains before
  2026-11-05 04:00 SAST at the measured tokens a second;
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
START_CUTOFF = datetime(2026, 11, 4, 20, 0, tzinfo=SAST)
TRAIN_UNTIL = datetime(2026, 11, 5, 4, 0, tzinfo=SAST)
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
# Steps the cookbook keeps in flight (`pipeline_depth`), set here so the cap's margin for sent work holds.
PIPELINE_DEPTH = 4


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
        raise Refused("no Loupe run starts on or after 2026-11-04 20:00 SAST; an interrupted one may only resume")
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
        # The cookbook cannot stop and save at once (its SIGTERM skips the final checkpoint), so the set is held under
        # the cap by what a resume may train again (one checkpoint interval and the steps in flight, at the longest
        # line): a run that completes, or resumes once, ends inside the cap with its final checkpoint.
        replay = (CHECKPOINT_EVERY + PIPELINE_DEPTH) * BATCH_SIZE * max(tokens, default=0)
        budget = int(cap / USD_PER_TOKEN) - replay
        if budget <= 0:
            return []
        picked = fit([groups[i] for i in chosen], [tokens[i] for i in chosen], budget, seed)
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
    # A version whose promotion failed is not over: its final checkpoint is promoted again (`promote_final`).
    if outcome == "completed":
        raise Refused(f"{Path(run_dir).name} is {outcome}; a version is never reused, so train the next version")
    if not (Path(run_dir) / "cookbook").is_dir():
        return None
    reference = resume_reference(run_dir)
    if reference is None:
        raise Refused(f"{Path(run_dir).name} failed before its first checkpoint; a version is never reused, a failed "
                      f"one included, so train the next version")
    return reference


def check_cap_left(run_dir, cap, chosen_tokens):
    """A resume under a cap is refused before any session opens when what was sent, with the steps a session sends
    before its first callback can stop it (those in flight and the next, at the longest line), would reach the cap."""
    if cap is None:
        return
    sent = (read_metrics(Path(run_dir) / "metrics.jsonl") or [{}])[-1].get("tokens_sent", 0)
    margin = (PIPELINE_DEPTH + 1) * BATCH_SIZE * max(chosen_tokens, default=0)
    if (sent + margin) * USD_PER_TOKEN >= cap:
        raise Refused(f"{Path(run_dir).name} has sent US${sent * USD_PER_TOKEN:.2f} of its US${cap:.0f} cap; a resume "
                      f"would pass it, so train the next version")


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


def read_metrics(path):
    """A run's metrics lines. A last line cut short (the process killed, or the disk full, mid-write) is dropped and the
    file rewritten without it, so the run can resume on what was recorded whole; a damaged line before the last is
    refused, since what follows it cannot be trusted."""
    path = Path(path)
    if not path.is_file():
        return []
    lines = read_lines(path)
    records = []
    for index, line in enumerate(lines):
        try:
            records.append(json.loads(line))
        except ValueError:
            if index != len(lines) - 1:
                raise Refused(f"{path} line {index + 1} is damaged before its last line; it cannot be resumed on") from None
            write_lines_atomic(path, lines[:-1])
    return records


class Recorder:
    """The run's records: a metrics line a step, a progress line every 50 steps, and the stop at the cap."""

    def __init__(self, run_dir, version, cap, usd_per_token=USD_PER_TOKEN, markdown_path=TRAINING_MD, stop=None,
                 line_tokens=None, batch_size=BATCH_SIZE, pipeline_depth=PIPELINE_DEPTH):
        # Each chosen line's tokens, images included (`selection.json`). The trainer's own token metric counts text
        # only, and it shuffles the lines, so a step is charged a batch at the lines' mean (over a run, every line's
        # tokens once each time it is sent) and the cap is checked against the steps already in flight at the longest
        # line. Without them (the measure run) the metric is all there is.
        self.line_tokens, self.batch_size, self.pipeline_depth = line_tokens, batch_size, pipeline_depth
        self.mean = sum(line_tokens) / len(line_tokens) if line_tokens else None
        self.longest = max(line_tokens) if line_tokens else 0
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
        last = 0
        for record in read_metrics(self.metrics):
            last = record.get("tokens_sent", last)
        return last

    def batch(self, step):
        """Step `step`'s examples and their tokens at the lines' mean; the last step holds what is left."""
        left = len(self.line_tokens) - (step - 1) * self.batch_size
        examples = max(0, min(self.batch_size, left)) if step >= 1 else 0
        return examples, round(examples * self.mean)

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
        # The cap stops the run while the steps already sent (those in flight and the next) still fit it, each at the
        # longest line; a resume starts again at the last 200-step checkpoint, which the set's reserve covers (`choose`).
        upcoming = (self.pipeline_depth + 1) * self.batch_size * self.longest
        if self.cap is not None and (self.tokens + upcoming) * self.rate >= self.cap and not self.stopped_at_cap:
            # The loop's own SIGTERM handler drains and stops: the cookbook saves no checkpoint on it, so its last 200-step
            # checkpoint is where a resume starts.
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
        # Every session the version opened, with the checkpoints that existed as it began: a checkpoint belongs to the
        # session it first appeared under, so a resume names the run that holds it, not the newest session.
        history = sessions(self.path.parent)
        history.append({"session": session, "run": run, "account": account,
                        "checkpoints_before": sorted(checkpoint_steps(self.path.parent))})
        write_atomic(self.path, json.dumps({"session": session, "run": run, "account": account,
                                            "sessions": history}) + "\n")
        if self.started:
            self.started(session)


def checkpoint_steps(run_dir):
    """The checkpoints the cookbook has recorded for this version (`cookbook/dataloader.json`), by name."""
    saved = Path(run_dir) / "cookbook" / "dataloader.json"
    return json.loads(saved.read_text(encoding="utf-8")).get("checkpoints", {}) if saved.is_file() else {}


def sessions(run_dir):
    """The sessions `serverless.json` records, oldest first; one written before the history holds its one session."""
    ids = Path(run_dir) / "serverless.json"
    if not ids.is_file():
        return []
    data = json.loads(ids.read_text(encoding="utf-8"))
    return data.get("sessions") or [{**{k: data[k] for k in ("session", "run", "account")}, "checkpoints_before": []}]


def resume_reference(run_dir):
    """The checkpoint an interrupted run continues from, `<account>/<run>/<checkpoint>`, or None before its first. The
    run is the one whose session the checkpoint appeared under: the last session that began before it existed."""
    checkpoints = checkpoint_steps(run_dir)
    if not checkpoints:
        return None
    history = sessions(run_dir)
    if not history:
        raise Refused(f"{run_dir} has checkpoints but no serverless.json naming their run; it cannot be resumed")
    newest = max(checkpoints, key=lambda name: (checkpoints[name] or {}).get("step", -1))
    owner = owner_of(history, newest)
    return f"{owner['account']}/{owner['run']}/{newest}"


def owner_of(history, checkpoint):
    """The session a checkpoint appeared under: the last one that began before it existed."""
    return ([s for s in history if checkpoint not in s.get("checkpoints_before", [])][-1:] or history[:1])[0]


def final_checkpoint(run_dir, lines):
    """The newest checkpoint when it has consumed every chosen line, or None. Resumed from it, the cookbook trains
    nothing and skips its promotion (it finalizes only past the step it resumed at), so it is promoted directly."""
    checkpoints = checkpoint_steps(run_dir)
    if not checkpoints:
        return None
    newest = max(checkpoints, key=lambda name: (checkpoints[name] or {}).get("step", -1))
    return newest if (checkpoints[newest] or {}).get("data_consumed", 0) >= lines else None


def promote_final(run_dir, version, checkpoint, client, verify):
    """A version trained to its end but not promoted (interrupted after its final checkpoint, or its promotion
    failed): the final checkpoint of the session that saved it is promoted through the SDK (`FireworksClient`'s
    `promote_session_checkpoint`, the call the cookbook's own promotion makes), recorded in `output-model.json` as the
    cookbook records it, and read back (`promotion`)."""
    model_id, _ = names(version)
    owner = owner_of(sessions(run_dir), checkpoint)
    session = f"accounts/{owner['account']}/trainingSessions/{owner['session']}"
    rows = [r for r in client.list_training_session_checkpoints(session)
            if r.get("name", "").rsplit("/", 1)[-1] == checkpoint and r.get("promotable", True)]
    if not rows:
        raise Refused(f"{session} lists no promotable checkpoint {checkpoint}; it cannot be promoted")
    client.promote_session_checkpoint(name=rows[0]["name"], output_model_id=model_id, base_model=BASE_MODEL)
    write_atomic(Path(run_dir) / "output-model.json",
                 json.dumps({"model_id": model_id, "checkpoint": checkpoint, "job_id": owner["session"]}) + "\n")
    return promotion(run_dir, model_id, verify)


def record_attempt(run_dir, attempt, replace_last=False):
    """One attempt at a version (`attempts.json`, written whole): when it started and ended, what it resumed from,
    its outcome and, for one that failed, the error's type and the first 200 characters of its message. It is written
    as `running` before the cookbook starts and replaced when it ends, so an attempt the machine lost (a crash, a kill)
    stays on record; the next attempt marks it `interrupted`."""
    path = Path(run_dir) / "attempts.json"
    attempts = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else []
    if replace_last and attempts:
        attempts[-1] = attempt
    else:
        for earlier in attempts:
            if earlier.get("outcome") == "running":
                earlier.update(outcome="interrupted", ended=None)
        attempts.append(attempt)
    write_atomic(path, json.dumps(attempts, indent=2) + "\n")
    return attempts


def run_json(run_dir, version, model_id, params, started, ended, outcome, session=None, promoted=None, attempts=None):
    lines = read_metrics(Path(run_dir) / "metrics.jsonl")
    attempts = attempts or []
    # The loop names its session only when it returns (its `job_id`); a resumed run's earlier sessions are in its lines.
    sessions = sorted({line["session"] for line in lines if line.get("session")} | ({session} if session else set()))
    data = {
        "version": version,
        # The lines this version trained on: the version gate (§13) promotes only a version that trained on more.
        "lines_trained": params.get("lines_trained"),
        "model_id": model_id,
        "base_model": BASE_MODEL,
        "hyperparameters": params,
        # The first attempt's start, so a resumed version's elapsed time counts from where it began.
        "started": attempts[0]["started"] if attempts else started,
        "ended": ended,
        "outcome": outcome,
        "attempts": attempts,
        # Attempts that ended before the version did: each was resumed by the one after it.
        "interruptions": sum(1 for a in attempts[:-1] if a.get("outcome") != "completed"),
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
        pipeline_depth=PIPELINE_DEPTH,
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

    def attempt(outcome_now, error=None):
        ended = datetime.now(timezone.utc).isoformat(timespec="seconds")
        entry = {"started": started, "ended": ended, "outcome": outcome_now, "resumed_from": resume_from}
        if error is not None:
            entry["error"] = f"{type(error).__name__}: {str(error)[:200]}"
        return ended, record_attempt(run_dir, entry, replace_last=True)

    record_attempt(run_dir, {"started": started, "ended": None, "outcome": "running", "resumed_from": resume_from})

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
        ended, attempts = attempt(outcome)
        return result, run_json(run_dir, version, model_id if promoted else None, params, started, ended, outcome,
                                session, promoted, attempts)
    except BaseException as error:
        final = "stopped at cap" if recorder.stopped_at_cap else outcome
        ended, attempts = attempt(final, error)
        run_json(run_dir, version, None, params, started, ended, final, attempts=attempts)
        raise
    finally:
        loop.wandb_log = original
        named.removeHandler(ids)
        named.setLevel(level)


def main(argv=None, now=None):
    parser = argparse.ArgumentParser(description="Train Loupe on Fireworks' Serverless Training API (D03 T04 §11).")
    parser.add_argument("--version", required=True, help="the Loupe version, like 1.0")
    parser.add_argument("--train", default=None, help="train.jsonl (default: <store>/dataset/<version>/train.jsonl)")
    parser.add_argument("--measure", action="store_true", help=f"train {MEASURE_EXAMPLES} examples, unpromoted, and "
                                                               "print the lines a second measured and the next command")
    parser.add_argument("--lines-per-second", type=float, help="the rate --measure printed; needed for a new run, which "
                                                                  "is cut to what trains before the window closes")
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
            check_cap_left(run_dir, cap, chosen_tokens)
        elif not args.measure:
            import training.renderer.muse_glimmer as _mg
            orig_itc = getattr(_mg, "image_to_chunk", None)
            orig_enc = getattr(renderer, "_encode", None)
            if orig_itc is not None:
                import base64 as _b64, io as _io
                from PIL import Image as _Image
                from fireworks.training import sdk as _sdk
                def _fast_itc(image_or_str, image_processor):
                    if isinstance(image_or_str, str) and image_or_str.startswith("data:image/") and hasattr(
                            image_processor, "get_number_of_image_patches"):
                        b64 = image_or_str.split(",", 1)[1]
                        try:
                            with _Image.open(_io.BytesIO(_b64.b64decode(b64[:4096]))) as im:
                                w, h = im.size
                        except Exception:
                            with _Image.open(_io.BytesIO(_b64.b64decode(b64))) as im:
                                w, h = im.size
                        tok = image_processor.get_number_of_image_patches(h, w, images_kwargs={}) // image_processor.merge_size**2
                        return _sdk.types.ImageChunk(data=b"x", format="jpeg", expected_tokens=tok)
                    return orig_itc(image_or_str, image_processor)
                _mg.image_to_chunk = _fast_itc
            if orig_enc is not None:
                _enc_cache = {}
                def _cached_enc(text):
                    if len(text) < 2048:
                        res = _enc_cache.get(text)
                        if res is None:
                            res = orig_enc(text)
                            _enc_cache[text] = res
                        return res
                    return orig_enc(text)
                renderer._encode = _cached_enc
            try:
                tokens = [line_tokens(line, renderer, TrainOnWhat.LAST_ASSISTANT_MESSAGE) for line in iter_lines(train_file)]
            finally:
                if orig_itc is not None:
                    _mg.image_to_chunk = orig_itc
                if orig_enc is not None:
                    renderer._encode = orig_enc
            groups = read_groups(train_file, len(tokens))
            chosen = choose(groups, tokens, now, args.lines_per_second, cap, args.seed)
            if not chosen:
                raise Refused("no line fits the time window and the cap; nothing would train")
            append_training(f"Loupe {args.version}: {model_id}, set {len(chosen)} of {len(tokens)} lines "
                            f"({sum(tokens[i] for i in chosen)} tokens, seed {args.seed}, cap "
                            f"{'lifted' if cap is None else f'US${cap:.0f}'}), dataset {dataset_sha}", TRAINING_MD)
            train_file = training_file(train_file, chosen, len(tokens), run_dir)
            chosen_tokens = [tokens[i] for i in chosen]
            write_selection(run_dir, dataset_sha, train_file, chosen_tokens, args.seed, args.lines_per_second, cap)
        key = read_key()
        os.environ["FIREWORKS_API_KEY"] = key
        from training.recipes import sft_loop

        if resuming:
            final = final_checkpoint(run_dir, len(chosen_tokens))
            if final:
                from fireworks.training.sdk import FireworksClient
                client = FireworksClient(api_key=key, base_url=os.environ.get("FIREWORKS_BASE_URL",
                                                                               "https://api.fireworks.ai"))
                record = finish(run_dir, args.version, final, client, model_state(key, account_of(run_dir)))
                print(json.dumps(record, indent=2))
                return 0
        recorder = Recorder(run_dir, args.version, cap, markdown_path=TRAINING_MD, line_tokens=chosen_tokens)
        if resume_from:
            append_training(f"Loupe {args.version} resumed from {resume_from.rsplit('/', 1)[-1]}", TRAINING_MD)
        _result, record = train(sft_loop, train_file, args.version, run_dir, recorder,
                                examples=MEASURE_EXAMPLES if args.measure else None, promote=not args.measure,
                                resume_from=resume_from, dataset_sha=dataset_sha,
                                verify=model_state(key, os.environ.get("FIREWORKS_ACCOUNT", "rizonetech")))
    except Refused as refusal:
        print(f"train-serverless: refused: {refusal}", file=sys.stderr)
        return 2
    if args.measure:
        record = {**record, **measured(run_dir, args.version)}
    print(json.dumps(record, indent=2))
    return 0


def account_of(run_dir):
    return (sessions(run_dir) or [{}])[-1].get("account") or os.environ.get("FIREWORKS_ACCOUNT", "rizonetech")


def finish(run_dir, version, checkpoint, client, verify):
    """The promotion-only attempt of a version trained to its end, recorded like any other attempt."""
    model_id, _ = names(version)
    # The training's own parameters (the lines trained among them, which the version gate reads) are kept from the
    # run that trained it, whatever the promotion-only attempt's outcome.
    previous = json.loads((Path(run_dir) / "run.json").read_text(encoding="utf-8")) if (
        Path(run_dir) / "run.json").is_file() else {}
    params = previous.get("hyperparameters") or {}
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    record_attempt(run_dir, {"started": started, "ended": None, "outcome": "running", "resumed_from": checkpoint})
    try:
        promoted = promote_final(run_dir, version, checkpoint, client, verify)
    except BaseException as error:
        ended = datetime.now(timezone.utc).isoformat(timespec="seconds")
        attempts = record_attempt(run_dir, {"started": started, "ended": ended, "outcome": "promotion failed",
                                            "resumed_from": checkpoint,
                                            "error": f"{type(error).__name__}: {str(error)[:200]}"}, replace_last=True)
        run_json(run_dir, version, None, params, started, ended, "promotion failed", attempts=attempts)
        raise
    ended = datetime.now(timezone.utc).isoformat(timespec="seconds")
    attempts = record_attempt(run_dir, {"started": started, "ended": ended, "outcome": "completed",
                                        "resumed_from": checkpoint}, replace_last=True)
    return run_json(run_dir, version, model_id, params, started, ended, "completed",
                    promoted=promoted, attempts=attempts)


def measured(run_dir, version):
    """What a measure run found: its lines over the seconds its steps took, and the command for the run itself."""
    lines = read_metrics(Path(run_dir) / "metrics.jsonl")
    seconds = lines[-1]["seconds"] if lines else 0
    rate = round(MEASURE_EXAMPLES / seconds, 4) if seconds else None
    command = (f"~/.venvs/fireworks/bin/python scripts/glimmer/train_serverless.py --version {version} "
               f"--lines-per-second {rate}") if rate else None
    return {"lines_per_second": rate, "next": command}


if __name__ == "__main__":
    sys.exit(main())
