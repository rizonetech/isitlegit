#!/usr/bin/env python3
"""Run GPT-6 Astra as the Loupe dataset collector (D03 T04 §4).

    python3 scripts/astra-collect.py             # collect: Codex with network access, rooted at <store>/raw
    python3 scripts/astra-collect.py --dry-run   # print the command and the store, change nothing

Astra follows docs/glimmer/astra-collection-brief.md, given on standard input, in `codex exec --sandbox
workspace-write` with network access, rooted at the Glimmer data store's `raw/` folder: `GLIMMER_DATA_DIR`, default
`~/isitlegit-data/glimmer`, the store scripts/glimmer/store.ts uses. A store inside this repository is refused, so
nothing Astra downloads can be one `git add` from a public leak. The run creates `<store>/raw` first, moves an earlier
`ASTRA-REPORT.md` aside under its UTC stamp so a stale report never stands as this run's, and exits with Codex's own
code. Claude verifies everything Astra collects (D03 T04 §5); Astra never reviews it.

Run it with the Bash tool's run_in_background option (scripts/dispatch_hook.py refuses anything else): a collection
takes hours.
"""
import argparse
import os
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRIEF = ROOT / "docs" / "glimmer" / "astra-collection-brief.md"
MODEL = "gpt-6-astra"
# The operator's Codex config defaults to `max`; research at `high` is this section's choice, changed here alone.
EFFORT = "high"
REPORT = "ASTRA-REPORT.md"


def store_dir(env=None) -> Path:
    """The Glimmer data store, resolved as scripts/glimmer/store.ts resolves it."""
    env = os.environ if env is None else env
    configured = env.get("GLIMMER_DATA_DIR")
    path = Path(configured) if configured else Path(env.get("HOME") or Path.home()) / "isitlegit-data" / "glimmer"
    return path.expanduser().resolve()


def inside_repository(path: Path) -> bool:
    return path == ROOT or ROOT in path.parents


def command(codex: str, raw: Path) -> list[str]:
    return [codex, "exec", "-m", MODEL, "-c", f"model_reasoning_effort={EFFORT}", "--sandbox", "workspace-write",
            "-c", "sandbox_workspace_write.network_access=true", "--skip-git-repo-check", "--ephemeral",
            "--cd", str(raw), "-o", str(raw / REPORT), "-"]


def refuse(reason: str) -> int:
    print(f"astra-collect: refused: {reason}", file=sys.stderr)
    return 2


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Run GPT-6 Astra as the Loupe dataset collector (D03 T04 §4).")
    parser.add_argument("--dry-run", action="store_true", help="print the command and the store; change nothing")
    args = parser.parse_args(argv)

    store = store_dir()
    raw = store / "raw"
    if inside_repository(store):
        return refuse(f"the data store {store} is inside the repository; set GLIMMER_DATA_DIR outside it")
    codex = shutil.which("codex")
    if not codex:
        return refuse("the Codex CLI (`codex`) is not on PATH")
    if not BRIEF.is_file():
        return refuse(f"the brief {BRIEF.relative_to(ROOT)} is missing")
    run = command(codex, raw)
    if args.dry_run:
        print(f"store: {store}")
        print(f"brief: {BRIEF.relative_to(ROOT)} (standard input)")
        print(shlex.join(run))
        return 0

    try:
        raw.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return refuse(f"cannot create {raw}: {error.strerror or error}")
    if not raw.is_dir() or not os.access(raw, os.W_OK | os.X_OK):
        return refuse(f"{raw} is not a writable folder")
    report = raw / REPORT
    if report.exists():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        aside = raw / f"ASTRA-REPORT.{stamp}.md"
        try:
            os.replace(report, aside)
        except OSError as error:
            return refuse(f"cannot move the earlier report aside: {error.strerror or error}")
        print(f"astra-collect: the earlier report is now {aside.name}")
    print(f"astra-collect: running Astra in {raw}; its report goes to {report}", flush=True)
    return subprocess.run(run, input=BRIEF.read_bytes(), cwd=raw, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
