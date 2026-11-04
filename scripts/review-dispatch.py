#!/usr/bin/env python3
"""Run one review pass with the reviewer and policy pinned in .conclave/reviewers.toml.

    python3 scripts/review-dispatch.py --writer claude --prompt review-prompt.md --record docs/reviews/x.md
    python3 scripts/review-dispatch.py --kind completion --candidate <40-char SHA> --writer claude \
        --prompt completion-prompt.md --record docs/reviews/x.md     the one-pass completion and excellence review
    python3 scripts/review-dispatch.py --check-pin [--json] [--pin <path>]     the pin's verdict; runs no reviewer
    python3 scripts/review-dispatch.py --list-rounds [--json] [--records <dir>]  recorded rounds; runs no reviewer

`--writer` is the agent whose work is under review (claude, codex, gemini or muse); its route in the pin names exactly one
reviewer, of a different model family by default, with no fallback. The explicit `self_review = ["codex"]`
policy permits Codex self-review. The versioned codex-two-pass-v1 route uses plan then combined completion;
older pins retain plan, one implementation round, then completion. Each pass records its policy
and pin; the stamp validates that committed policy and its exact candidate. A reviewer that is not installed, exits non-zero, times out,
returns nothing, or ends its reply `OVERALL: blocked` (it could not reach the candidate, for example a sandbox that
cannot read the repository) returned no review, and the reason is recorded under `failover`: exit 1, which never
counts as approval, and no other reviewer runs. A review that finds problems is still a review (exit 0).

`--check-pin` loads the pin with `load_pin`, the only place the rules live, and reports without running anything:
with `--json`, `{"ok": true, "schema_version", "reviewers", "routes", "schedule", "clis": {cli: on PATH}}` (the
`schedule` key only when the pin has one) and exit 0, or `{"ok": false, "error": "<the Refused message>"}` and exit 2;
without `--json`, `ok` or `refused: <message>`.

Reviewers run read-only in the repository root: Codex in its read-only sandbox, Antigravity in plan mode inside its
sandbox, Claude Code in plan mode, Muse Code with writes, shell and web tools disabled inside its sandbox. The script prints a JSON summary; `--record` also appends a `## Round N` section to
the findings file with an atomic write, and writes nothing (exit 2, the summary still printed) to a findings file it
cannot read back. Works the same from PowerShell and from WSL. Stdlib only.

`--kind completion` runs the one-pass completion and excellence review (`docs/completion-review-prompt.md`) on the
built section before its regular rounds. With `--record` it appends a `## Completion review` section naming the
reviewer, its model and the `--candidate` commit instead of a `## Round N` section, and it is not counted as a round.
A findings file holds one returned completion review: a second is refused (exit 2) and nothing is appended, while a
pass that returned no review (`## Completion review: none`) may be followed by another.

`--kind final` runs the one-pass final review by the reviewer `[schedule.final]` names (Muse Wonder Full through Muse
Code here, a model family neither the writer nor the round reviewer belongs to). It runs only after the regular rounds
have stopped (the last round that returned a review declares no P1 or P2), once per findings file, and is recorded as a
`## Final review` section with its `--candidate`. A P1 or P2 it finds is fixed and proven by one more regular round;
the final review is never repeated.

`--kind plan` runs the one-pass plan review (`docs/plan-review-prompt.md`) on the section as written, before the build:
it asks whether building the section exactly as planned produces a 100% complete feature. It is recorded as a
`## Plan review` section with the same one-pass rule, and it is not counted as a round.

When the pin has a `[schedule]`, the dispatcher owns each pass's effort and lenses: the
plan and completion passes take their scheduled effort, and a round's place in `[[schedule.rounds]]` comes from the
rounds that returned a review already recorded in the `--record` file. Rounds past that list rotate one lens per round
through `[schedule.rotation]` (the design lens only with `--surface`), and a low-effort round whose review reads
`HIGHEST: P1` is followed by the `[schedule.escalation]` step. The scheduled lenses are appended to the prompt and
recorded on an `- Lenses:` line. The JSON summary carries `position`, `escalated` and `severity_stop` (true when a
returned round past `severity_stop_after` reads `HIGHEST: P3`: the loop may stop there; with 0, from round 1).
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import tomllib

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / ".conclave" / "reviewers.toml"
TODO_GRAPH = ROOT / "scripts" / "todo-graph.py"
# A section's findings file, the form `todo-graph.py stamp` demands of --plan: the domain folder's number is the
# section's domain number.
FINDINGS_PATH = re.compile(r"docs/reviews/(\d{2})-[^/]+/D(\d{2})-T(\d{2})-s([1-9]\d*)\.md")
WRITERS = ("claude", "codex", "gemini", "muse")
CLIS = ("codex", "agy", "claude", "muse")
# A reviewer is never of the writer's own model family: its CLI names the family, and so does the writer.
FAMILY = {"codex": "openai", "agy": "google", "claude": "anthropic", "muse": "meta"}
WRITER_FAMILY = {"claude": "anthropic", "codex": "openai", "gemini": "google", "muse": "meta"}
# Antigravity carries the effort in its model name, so it takes none, and a schedule's efforts do not reach it.
EFFORTS = {"codex": ("low", "medium", "high", "xhigh"), "claude": ("low", "medium", "high", "xhigh", "max"),
           "muse": ("minimal", "low", "medium", "high", "xhigh", "max")}
MODEL = re.compile(r"^[a-z0-9][a-z0-9.-]*$")
NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
# Antigravity takes the prompt only as the -p value. Past this size it gets a pointer to the prompt file instead.
# Windows caps a whole command line at 32,767 characters; Linux caps one argument at 128 KiB.
ARGV_PROMPT_LIMIT = 24_000 if os.name == "nt" else 100_000
# A review is prose. Output past this size is a runaway reviewer, not a review.
MAX_OUTPUT_BYTES = 2_000_000
# A reviewer's error output (Codex writes its progress there too) is kept up to this size while it runs, and its last
# ERROR_TAIL_BYTES are saved under ERROR_LOGS when it returns no review, so an outage can be diagnosed.
MAX_ERROR_BYTES = 64_000_000
ERROR_TAIL_BYTES = 16_384
# The prompt's reply format ends with an OVERALL line; `blocked` means the reviewer never saw the work.
BLOCKED = re.compile(r"^\s*(?:OVERALL|COMPLETION):\s*blocked\b", re.IGNORECASE)
POLL_SECONDS = 0.2
CLEANUP_SECONDS = 10


class Refused(Exception):
    """The pin or the arguments are wrong; nothing ran."""


def pin_blob(data):
    """The git blob id of the pin's bytes, computed as `git hash-object` does in a SHA-1 repository (this one), so the
    stamp can read that exact pin back with `git cat-file`; needs no git on PATH."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def load_pin(path=PIN, data=None):
    """The checked pin at `path`, or, given `data`, the pin in those bytes (a committed pin read with `git show`), so
    a read-only caller needs no temporary file."""
    try:
        if data is None:
            with open(path, "rb") as handle:
                data = handle.read()
        pin = tomllib.loads(data.decode("utf-8"))
    except FileNotFoundError:
        raise Refused(f"no reviewer pin at {path}") from None
    except tomllib.TOMLDecodeError as exc:
        raise Refused(f"unreadable reviewer pin: {exc}") from None
    # A directory, a file it may not read, bytes that are not UTF-8, an integer past Python's digit limit, or nesting
    # deep enough to exhaust the parser's recursion: each is a pin that cannot be read, so it is a refusal (exit 2,
    # one JSON object), never a traceback. ValueError comes after its subclasses TOMLDecodeError and UnicodeDecodeError.
    except OSError as exc:
        raise Refused(f"unreadable reviewer pin: {exc.strerror or exc}: {path}") from None
    except UnicodeDecodeError:
        raise Refused("unreadable reviewer pin: not UTF-8 text") from None
    except ValueError as exc:
        raise Refused(f"unreadable reviewer pin: {exc}") from None
    except RecursionError:
        raise Refused("unreadable reviewer pin: nested too deeply to read") from None
    # `type(...) is int`: TOML true is Python True (an int subclass) and 1.0 == 1, so `!= 1` alone let both load.
    # The optional [schedule] is checked below; the refusal text stays the one the VS Code extension matches.
    if not {"schema_version", "reviewers", "routes"} <= set(pin) <= {"schema_version", "reviewers", "routes",
                                                                     "schedule", "self_review", "reconciliation", "self_review_policy", "plan_transition", "reconciliation_extensions", "reconciliation_exceptions"} \
            or type(pin["schema_version"]) is not int or pin["schema_version"] != 1:
        raise Refused("the reviewer pin needs exactly schema_version = 1, [reviewers.*] and [routes]")
    if pin.get("self_review", []) not in ([], ["codex"]):
        raise Refused("self_review must be [] or [\"codex\"]")
    if pin.get("reconciliation", []) not in ([], ["codex"]) or (pin.get("reconciliation") and not self_review_enabled(pin, "codex")):
        raise Refused("reconciliation must be [] or [\"codex\"] with Codex self-review enabled")
    if pin.get("self_review_policy") not in (None, "codex-two-pass-v1"):
        raise Refused("unknown self_review_policy")
    if pin.get("self_review_policy") and not self_review_enabled(pin, "codex"):
        raise Refused("two-pass policy needs Codex self-review")
    extensions = pin.get("reconciliation_extensions", {})
    if not isinstance(extensions, dict) or any(not isinstance(k, str) or not re.fullmatch(r"docs/reviews/\d{2}-[A-Za-z0-9_-]+/D\d{2}-T\d{2}-s[1-9]\d*\.md", k)
                                               or not isinstance(v, str) or not DIGEST.fullmatch(v) for k, v in extensions.items()):
        raise Refused("invalid scoped reconciliation extensions")
    exceptions = pin.get("reconciliation_exceptions", {})
    if not isinstance(exceptions, dict):
        raise Refused("reconciliation_exceptions must be an exact report map")
    for report, identity in exceptions.items():
        _exception_identity_shape(identity, report)
    if pin.get("plan_transition", []) not in ([], ["codex-self-review"]) or (pin.get("plan_transition") and not pin.get("self_review_policy")):
        raise Refused("plan_transition needs the explicit two-pass policy")
    combined = (pin.get("schedule") or {}).get("combined")
    if bool(combined) != (pin.get("self_review_policy") == "codex-two-pass-v1"):
        raise Refused("two-pass policy and schedule.combined are required together")
    if combined is not None and (not isinstance(combined, dict) or combined.get("lenses") != COMBINED_LENSES):
        raise Refused("combined schedule must contain every required lens in order")
    reviewers = pin["reviewers"]
    if not isinstance(reviewers, dict) or not reviewers:
        raise Refused("the reviewer pin defines no reviewers")
    for name, entry in reviewers.items():
        # fullmatch: `$` alone also matches before a trailing newline, which would then break the round heading.
        if not NAME.fullmatch(name) or not isinstance(entry, dict):
            raise Refused(f"invalid reviewer {name!r}")
        unknown = set(entry) - {"cli", "model", "effort"}
        if unknown:
            raise Refused(f"reviewer {name!r} has unknown keys: {', '.join(sorted(unknown))}")
        cli, model, effort = entry.get("cli"), entry.get("model"), entry.get("effort")
        if cli not in CLIS:
            raise Refused(f"reviewer {name!r} needs cli = one of {', '.join(CLIS)}")
        if not isinstance(model, str) or not MODEL.fullmatch(model):
            raise Refused(f"reviewer {name!r} has a malformed model")
        if cli == "agy":
            if effort is not None:
                raise Refused(f"reviewer {name!r}: Antigravity carries the effort in the model name, so set no effort")
        elif effort not in EFFORTS[cli]:
            raise Refused(f"reviewer {name!r} needs effort = one of {', '.join(EFFORTS[cli])}")
    routes = pin["routes"]
    if not isinstance(routes, dict) or set(routes) - set(WRITERS):
        raise Refused(f"[routes] may only name the writers {', '.join(WRITERS)}")
    for writer, chain in routes.items():
        if not isinstance(chain, list) or len(chain) != 1 or not isinstance(chain[0], str):
            raise Refused(f"route {writer!r} must list exactly one reviewer")
        if chain[0] not in reviewers:
            raise Refused(f"route {writer!r} must list a defined reviewer")
        if FAMILY[reviewers[chain[0]]["cli"]] == WRITER_FAMILY[writer] and not self_review_enabled(pin, writer):
            raise Refused(f"route {writer!r} names {chain[0]}, of the writer's own family; "
                          f"a review comes from a different family")
    if self_review_enabled(pin, "codex") and ("codex" not in routes or reviewers[routes["codex"][0]]["cli"] != "codex"):
        raise Refused("self_review needs a codex route to a codex reviewer")
    if "schedule" in pin:
        # The final reviewer must be usable by at least one writer (a family no writer and none of its round
        # reviewers belongs to); a writer it shares a family with is refused at dispatch time, and the stamp
        # rejects a same-family final in any case.
        per_writer = [{WRITER_FAMILY[w], FAMILY[reviewers[c[0]]["cli"]]} for w, c in routes.items()]
        check_schedule(pin["schedule"], {reviewers[chain[0]]["cli"] for chain in routes.values()}, reviewers,
                       set.intersection(*per_writer) if per_writer else set())
    return pin


# The lenses a schedule may name, each with the question the reviewer is given for it. `plan` and `plan-delivery`
# read the section's plan: before the build (is it a complete feature?) and after it (did the build deliver it?).
LENSES = {
    "plan": "Will this section, built exactly as written, produce a 100% complete feature? Name every missing "
            "control, state, setting consumer, error or refusal path, undo or reverse path, Ctrl+K reach, persistence "
            "read-back and test, and every `Done when:` that cannot fail.",
    "plan-delivery": "Did the build deliver every checklist item and `Done when:` of the section, with nothing "
                     "partial, stubbed or quietly narrowed?",
    "adversarial": "How does this fail on hostile input, races, aborts, cancellation, automation or links?",
    "integration": "Do callers and consumers still hold, with every contract (threads, ownership, errors) kept?",
    "source-defect": "Is the upstream specification or design/SPEC.md read accurately, with deviations noted?",
    "consistency": "Does it match the module rules, naming, shared components, settings and sibling code?",
    "quality": "Is the code clear, minimal and maintainable: dead code, duplication, misleading names or comments, "
               "tests that pass without exercising the behaviour?",
    "design": "Does the rendered UI match design/SPEC.md and its tokens: roles, radii, icons, states, accessibility?",
    "optimization": "Where does it waste time, memory, allocations, I/O or redraws on the paths users hit, and what "
                    "measured target does it miss?",
    "record": "Does the evidence match what ran, with owned deferrals and an earned flip of every item?",
}
STEP_KEYS = {"effort", "lenses"}


def check_step(where, step, efforts, lenses=True):
    if not isinstance(step, dict) or set(step) - STEP_KEYS or "effort" not in step \
            or (lenses and "lenses" not in step) or (not lenses and "lenses" in step):
        need = "effort and lenses" if lenses else "only effort"
        raise Refused(f"[schedule] {where} needs {need}")
    if step["effort"] not in efforts:
        raise Refused(f"[schedule] {where} needs effort = one of {', '.join(efforts)}")
    if lenses:
        names = step["lenses"]
        if not isinstance(names, list) or not names or not all(isinstance(n, str) and n in LENSES for n in names) \
                or len(set(names)) != len(names):
            raise Refused(f"[schedule] {where} needs lenses = a list of distinct lenses from "
                          f"{', '.join(LENSES)}")


# How the final review takes part: `required` (the stamp needs it), `optional` (it runs, a reviewer that returns no
# review is a warning rather than a failure, and the stamp may go without it), or `off` (it never runs and the stamp
# takes none). One key in [schedule.final] switches it.
FINAL_MODES = ("required", "optional", "off")


def final_mode(schedule):
    """The final step's mode, or None when the schedule has no final step."""
    final = (schedule or {}).get("final")
    return final.get("mode", "required") if isinstance(final, dict) else None


def check_schedule(schedule, clis, reviewers=None, families=()):
    """The review schedule, as strictly as the reviewers: every effort valid for every routed CLI that takes one (an
    Antigravity reviewer keeps the effort its model name carries), every lens known. The optional `final` step names
    its own reviewer, which must be of a family no writer and no round reviewer belongs to."""
    efforts = [e for e in EFFORTS["claude"] if all(e in EFFORTS[cli] for cli in clis if cli in EFFORTS)]
    keys = {"plan", "completion", "rounds", "rotation", "escalation", "severity_stop_after"}
    if not isinstance(schedule, dict) or not keys <= set(schedule) <= keys | {"final", "light", "reconciliation", "combined"}:
        raise Refused(f"[schedule] needs exactly {', '.join(sorted(keys))}, and may add final and light")
    if "light" in schedule:
        light = schedule["light"]
        if not isinstance(light, dict) or set(light) != {"rounds"} or not isinstance(light["rounds"], list) \
                or not light["rounds"]:
            raise Refused("[schedule.light] needs exactly rounds, a list of at least one round")
        for n, step in enumerate(light["rounds"], 1):
            check_step(f"light round {n}", step, efforts)
    if "final" in schedule:
        final = schedule["final"]
        if not isinstance(final, dict) or not {"reviewer", "effort", "lenses"} <= set(final) <= {
                "reviewer", "effort", "lenses", "mode"}:
            raise Refused("[schedule.final] needs exactly reviewer, effort and lenses, and may add mode")
        if final.get("mode", "required") not in FINAL_MODES:
            raise Refused(f"[schedule.final] mode must be one of {', '.join(FINAL_MODES)}")
        name = final["reviewer"]
        if not isinstance(name, str) or name not in (reviewers or {}):
            raise Refused("[schedule.final] reviewer must be a defined reviewer")
        cli = reviewers[name]["cli"]
        if FAMILY[cli] in families:
            raise Refused(f"[schedule.final] names {name}, of a family a writer or round reviewer belongs to")
        check_step("final", {"effort": final["effort"], "lenses": final["lenses"]}, EFFORTS.get(cli, ()))
    if "combined" in schedule:
        check_step("combined", schedule["combined"], efforts)
    if "reconciliation" in schedule:
        check_step("reconciliation", schedule["reconciliation"], efforts)
    check_step("plan", schedule["plan"], efforts)
    check_step("completion", schedule["completion"], efforts, lenses=False)
    check_step("escalation", schedule["escalation"], efforts)
    check_step("rotation", schedule["rotation"], efforts)
    rounds = schedule["rounds"]
    if not isinstance(rounds, list) or not rounds:
        raise Refused("[schedule] rounds needs at least one round")
    for n, step in enumerate(rounds, 1):
        check_step(f"round {n}", step, efforts)
    stop = schedule["severity_stop_after"]
    if type(stop) is not int or not 0 <= stop <= 33:
        raise Refused("[schedule] severity_stop_after needs a whole number of rounds from 0 to 33")


HIGHEST = re.compile(r"^\s*HIGHEST:\s*(P[123])\b", re.IGNORECASE | re.MULTILINE)


def highest(review):
    """The `HIGHEST:` severity a review declares (`P1`, `P2`, `P3`), or None."""
    found = HIGHEST.findall(review or "")
    return found[-1].upper() if found else None


DECLARED = re.compile(r"^\s*HIGHEST:\s*(P[123]|none)\s*$", re.IGNORECASE | re.MULTILINE)


def declared_highest(review):
    """The severity a review declares on its `HIGHEST:` line: `P1`, `P2`, `P3` or `none`; None when it declares none
    at all, which the round prompt treats as P1 (an untagged finding counts as P1)."""
    found = DECLARED.findall(review or "")
    return (found[-1].upper() if found[-1].lower() != "none" else "none") if found else None


# A second reading's verdict line, as eval/import-readings.ts reads it: "- `path`: agree", or "- `path`: disagree: reason".
SECOND_READING_LINE = re.compile(r"- `[^`]+`: (?:agree(?:: .*)?|disagree: .*\S.*)")


def verdict_lines(review):
    """A reply's non-blank lines, stripped, without one closing `### Second reading` block: the eval lane's second
    readings, which a reviewer may write after the prompt's reply format (D08 T01 §3, 2026-10-31). Only a block of
    well-formed verdict lines (a disagreement with its reason) is set aside; anything else after the verdict stays, so
    the reply has no verdict where one is read. Every reader of a reply's closing lines (rounds, plan, completion and
    final reviews, here and in scripts/lib/todo_graph.py) reads them through this."""
    lines = [x.strip() for x in (review or "").splitlines() if x.strip()]
    heads = [i for i, x in enumerate(lines) if x == "### Second reading"]
    if len(heads) == 1 and 0 < heads[0] < len(lines) - 1 \
            and all(SECOND_READING_LINE.fullmatch(x) for x in lines[heads[0] + 1:]):
        return lines[:heads[0]]
    return lines


def final_reply_ok(review):
    """A final review is a reply that declares its highest severity and ends with the OVERALL verdict line."""
    lines = verdict_lines(review)
    return declared_highest(review) is not None and bool(lines) \
        and lines[-1] in ("OVERALL: approve", "OVERALL: needs-attention")


COMBINED_LENSES = ["adversarial", "integration", "source-defect", "plan-delivery", "consistency", "record", "quality", "optimization", "design"]
SELF_REVIEW_POLICIES = ("codex-self-review", "codex-two-pass-v1")


def review_policy(pin, writer):
    return pin.get("self_review_policy", "codex-self-review") if self_review_enabled(pin, writer) else None


def self_review_enabled(pin, writer):
    """The operator's explicit Codex self-review policy, never inferred from a route."""
    return writer == "codex" and pin.get("self_review") == ["codex"]


def reviewer_allowed(entry):
    """Recognize review identity; stamp also verifies a self-review's committed pin and route."""
    if not entry.get("reviewer") or entry.get("writer") not in WRITER_FAMILY:
        return False
    family = FAMILY.get(entry.get("cli"))
    if family is None:
        return False
    if entry.get("policy") in SELF_REVIEW_POLICIES:
        return entry["writer"] == "codex" and entry.get("cli") == "codex" and bool(entry.get("pin"))
    return family != WRITER_FAMILY[entry["writer"]]


def returned_review(entry):
    """A returned cross-family or explicitly marked Codex self-review with an OVERALL verdict.
    The stamp verifies self-review authorization against the recorded committed pin. Outages and malformed replies
    never advance the schedule; the stamp uses this same predicate to count rounds."""
    lines = verdict_lines(entry.get("review"))
    return reviewer_allowed(entry) and bool(lines) and lines[-1] in ("OVERALL: approve", "OVERALL: needs-attention")


def legacy_returned_review(entry):
    """`returned_review` as the dispatcher ran it before 2026-10-31's `verdict_lines`: the reply's very last line must
    be the OVERALL verdict, so a round that closed with a `### Second reading` block did not move the schedule. A
    round scheduled then is replayed under this rule too (scripts/lib/todo_graph.py `schedule_ok`)."""
    lines = [x.strip() for x in (entry.get("review") or "").splitlines() if x.strip()]
    return bool(entry.get("reviewer")) and entry.get("writer") in WRITER_FAMILY \
        and FAMILY.get(entry.get("cli")) not in (None, WRITER_FAMILY[entry["writer"]]) \
        and bool(lines) and lines[-1] in ("OVERALL: approve", "OVERALL: needs-attention")


# A section's risk (its `**Risk:**` line, D00 T01 §15) names the schedule its rounds run on; `full` when it says none.
SCHEDULES = ("full", "light")
RECORD_NAME = re.compile(r"^D(\d{2})-T(\d{2})-s(\d+)\.md$")


def round_schedule(entry):
    """The schedule a recorded round ran on: its `- Schedule:` line, or `full` for a round recorded without one."""
    return entry.get("schedule") or "full"


def section_risk(record, root=ROOT):
    """The risk of the section a findings file belongs to (`docs/reviews/<domain>/DNN-TNN-sN.md` names it): its
    `**Risk:**` line (quoted or not, as the TODO validator reads a field), or `full` when it has none or the file names
    no section. A duplicate or unknown risk is refused before any reviewer runs, as the validator refuses it."""
    name = RECORD_NAME.match(Path(record).name)
    if not name:
        return "full"
    for todo in sorted((Path(root) / "todo").glob(f"{name[1]}-*/TODO-{name[2]}-*.md")):
        body = re.search(rf"^## {int(name[3])}\. .*?(?=^## |\Z)", todo.read_text(encoding="utf-8"), re.M | re.S)
        if body:
            values = re.findall(r"^(?:> )?\*\*Risk:\*\*[ \t]*(.*?)[ \t]*$", body.group(0), re.M)
            if len(values) > 1 or (values and values[0] not in SCHEDULES):
                raise Refused(f"{todo.name} §{int(name[3])} has a malformed Risk line ({', '.join(values) or 'empty'}); "
                              f"it is one line, full or light: fix it before the review")
            return values[0] if values else "full"
    return "full"


def scheduled(schedule, kind, rounds, surface, risk="full", returned=None, policy=None):
    """The effort and lenses for the next pass, from the pin's schedule and the rounds already recorded.

    The position counts returned reviews only (`returned_review`): an outage, a self-review and a reply without the
    final OVERALL line do not move it. Rounds past the fixed list rotate through `rotation`'s lenses, one per round,
    skipping `design` when the section has no surface. After a low-effort round that declared `HIGHEST: P1`, the next
    round is the `escalation` step instead. scripts/lib/todo_graph.py `stamp` replays this to check every recorded
    pass, so it is the one copy of the schedule rule."""
    if kind in ("plan", "completion", "final", "reconciliation"):
        combined = kind == "completion" and "combined" in schedule and policy in (None, "codex-two-pass-v1")
        step = schedule["combined"] if combined else schedule[kind]
        lenses = list(step.get("lenses", []))
        if combined and not surface:
            lenses.remove("design")
        return {"position": None, "effort": step["effort"], "lenses": lenses,
                "escalated": False}
    if risk not in SCHEDULES:
        raise Refused(f"a section's risk is one of {', '.join(SCHEDULES)}, not {risk!r}")
    if risk == "light" and "light" not in schedule:
        raise Refused("the section is light, but the pin's [schedule] has no light step")
    fixed = schedule["light"]["rounds"] if risk == "light" else schedule["rounds"]
    # The rounds on this schedule since it last changed: a section whose risk changed starts its rounds again on the
    # new schedule, its earlier findings kept in the file (D00 T01 §15).
    segment = []
    for entry in rounds:
        segment = [*segment, entry] if round_schedule(entry) == risk else []
    counts = returned or returned_review  # `stamp` replays a round with the rule its dispatcher ran (legacy_returned_review)
    returned = [r for r in segment if counts(r)]
    position = len(returned) + 1
    last = returned[-1] if returned else None
    if last is not None and last.get("effort") == "low" and highest(last.get("review")) == "P1":
        step, escalated = schedule["escalation"], True
    elif position <= len(fixed):
        step, escalated = fixed[position - 1], False
    else:
        rotation = [n for n in schedule["rotation"]["lenses"] if surface or n != "design"] \
            or schedule["rotation"]["lenses"]
        step = {"effort": schedule["rotation"]["effort"],
                "lenses": [rotation[(position - len(fixed) - 1) % len(rotation)]]}
        escalated = False
    return {"position": position, "effort": step["effort"], "lenses": list(step["lenses"]), "escalated": escalated,
            "schedule": risk}


def lens_block(plan):
    """The prompt section naming this pass's scheduled lenses and effort, appended after the writer's prompt."""
    where = f"Round {plan['position']}" if plan["position"] else "This pass"
    lines = ["", "", "## Lenses for this pass (scheduled by scripts/review-dispatch.py)", "",
             f"{where} runs at {plan['effort']} reasoning effort"
             + (", escalated after a low-effort round found a P1" if plan["escalated"] else "")
             + ". Review through these lenses only, each as its own verdict, and ignore any other lens list above:",
             ""]
    lines += [f"- `{name}`: {LENSES[name]}" for name in plan["lenses"]]
    return "\n".join(lines) + "\n"


EXTENSION = re.compile(r"\.[A-Za-z0-9]+")


def find_cli(name):
    """A reviewer CLI's path, from the absolute directories on PATH only, or None.

    Reviews run from the reviewed repository's root, and Windows `shutil.which` looks in the working directory first
    (always on Python 3.11, and on later ones unless NoDefaultCurrentDirectoryInExePath is set), so a `codex.cmd`
    committed to that repository would be reported as installed and run as the reviewer. Relative PATH entries are
    dropped for the same reason. On Windows the search is done here, by PATHEXT, so no Python version adds the directory.
    """
    directories = [d for d in os.environ.get("PATH", "").split(os.pathsep) if fully_qualified(d)]
    if os.name != "nt":
        return shutil.which(name, path=os.pathsep.join(directories))
    # An empty PATHEXT gets the defaults too, as shutil.which does. The bare name is the last candidate in each
    # directory: npm puts an extensionless shell script beside codex.cmd, and Windows can run only the .cmd.
    # Only entries shaped like an extension: one that holds a separator or ".." would lead out of the PATH directory.
    extensions = [e for e in os.environ.get("PATHEXT", "").split(os.pathsep) if EXTENSION.fullmatch(e)] \
        or [".COM", ".EXE", ".BAT", ".CMD"]
    for directory in directories:
        for candidate in [os.path.join(directory, name + e) for e in extensions] + [os.path.join(directory, name)]:
            if os.path.isfile(candidate):
                return candidate
    return None


def fully_qualified(directory):
    """True for a PATH entry that names one place whatever the working directory: on Windows a drive and a root
    (`C:\\x`) or a UNC share, never `\\x` (the current drive's) or `C:x` (that drive's current directory), which
    os.path.isabs accepts on Python 3.11 and 3.12."""
    if os.name != "nt":
        return os.path.isabs(directory)
    drive, rest = os.path.splitdrive(directory)
    return drive.startswith(("\\\\", "//")) or (len(drive) == 2 and rest[:1] in ("\\", "/"))


def command(reviewer, executable, prompt, prompt_path, output_path, timeout, effort=None):
    """The argv and stdin for one read-only review. The model comes only from the pin, and the effort from the pin's
    reviewer or, when the pin has a [schedule], from the step it schedules for this pass (Antigravity takes none)."""
    cli, model, effort = reviewer["cli"], reviewer["model"], effort or reviewer.get("effort")
    if cli == "codex":
        return [executable, "exec", "-m", model, "-c", f"model_reasoning_effort={effort}", "--sandbox", "read-only",
                "--ephemeral", "--skip-git-repo-check", "-o", str(output_path), "-"], prompt
    if cli == "claude":
        return [executable, "-p", "--model", model, "--effort", effort, "--permission-mode", "plan"], prompt
    if cli == "muse":
        # Read-only like the other reviewers: no file writes, no shell, no web tools, no questions back (its sandbox
        # stays on). Contributor mode off for every review, whatever the operator's own default.
        return [executable, "exec", "--model", model, "--reasoning-effort", effort, "--contributor-mode", "off",
                "--disable-write", "--disable-shell", "--disable-web-tools", "--disable-request-user-input",
                "--prompt-file", str(prompt_path)], None
    text = prompt
    # A Windows .cmd or .bat shim re-parses its arguments through cmd.exe, so prose there could become commands:
    # it only ever gets a pointer to the prompt file. So does a prompt too long for a command line.
    shim = Path(executable).suffix.lower() in (".cmd", ".bat")
    if shim or len(prompt.encode()) > ARGV_PROMPT_LIMIT or len(prompt) > ARGV_PROMPT_LIMIT:
        text = f"Follow the review instructions in the file {prompt_path} exactly. Do not modify any file."
    return [executable, "--model", model, "--mode", "plan", "--sandbox", "--print-timeout", f"{timeout}s",
            f"-p={text}"], None


def kill_tree(process):
    """End a reviewer and everything it started, whether it is still running or has already exited."""
    if os.name == "nt":
        # WORKAROUND: Windows offers no process-group kill without job objects, so taskkill /T reaches the reviewer's
        # children only while the reviewer itself is alive. A child that outlives a reviewer which exited by itself
        # is not reached on Windows; on Linux and WSL the whole session is killed below.
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # nothing in the group is left to kill


def remove_scratch(path):
    """Remove a reviewer's scratch directory. On Windows a file stays locked until every process holding it has
    exited, and a reviewer's helper can outlive the reviewer (see kill_tree) and keep writing into it, so a failed
    removal is retried for a bounded time. A directory that still cannot be removed is left behind with a note: the
    round's outcome is already decided."""
    deadline = time.monotonic() + CLEANUP_SECONDS
    while True:
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError as exc:
            if time.monotonic() > deadline:
                print(f"review-dispatch: left {path} behind ({exc.strerror or type(exc).__name__})", file=sys.stderr)
                return
            time.sleep(POLL_SECONDS)


def feed(pipe, text):
    try:
        pipe.write(text.encode("utf-8"))
        pipe.close()
    except (BrokenPipeError, OSError):
        pass  # the reviewer stopped reading or exited; its exit code and output decide the round


def run(argv, stdin_text, timeout, watched, stderr_path):
    """Run one reviewer in its own process group, watching the size of every file it writes while it runs (its error
    output, to `stderr_path`, against MAX_ERROR_BYTES), so neither a hang nor a flood of output can take the dispatcher
    or the disk down. The group is ended afterwards whatever happened. Returns (exit code, None) or (None, the reason it
    returned no review)."""
    group = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    stdout_path = watched[0]

    def flooded():
        if any(path.is_file() and path.stat().st_size > MAX_OUTPUT_BYTES for path in watched):
            return f"returned more than {MAX_OUTPUT_BYTES} bytes"
        if stderr_path.is_file() and stderr_path.stat().st_size > MAX_ERROR_BYTES:
            return f"wrote more than {MAX_ERROR_BYTES} bytes of error output"
        return None

    with open(stdout_path, "wb") as output, open(stderr_path, "wb") as errors:
        try:
            process = subprocess.Popen(argv, cwd=ROOT,
                                       stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
                                       stdout=output, stderr=errors, **group)
        except (OSError, ValueError) as exc:
            return None, f"could not start: {getattr(exc, 'strerror', None) or type(exc).__name__}"
        try:
            if stdin_text is not None:
                # Fed from a thread: a reviewer that never reads would otherwise block this write past any timeout.
                threading.Thread(target=feed, args=(process.stdin, stdin_text), daemon=True).start()
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                if problem := flooded():
                    return None, problem
                if time.monotonic() > deadline:
                    return None, "timed out"
                time.sleep(POLL_SECONDS)
        finally:
            kill_tree(process)
            process.wait()
    if process.returncode != 0:
        return None, f"exited {process.returncode}"
    if problem := flooded():
        return None, problem
    return process.returncode, None


ERROR_LOGS = ROOT / "build" / "review-logs"


def keep_error_tail(name, stderr_path):
    """Save the last ERROR_TAIL_BYTES of a reviewer's error output under build/review-logs (ignored, never recorded in
    a findings file: it can echo anything the reviewer read) and return the path, or None when it wrote nothing."""
    if not stderr_path.is_file() or stderr_path.stat().st_size == 0:
        return None
    with open(stderr_path, "rb") as source:
        source.seek(max(0, stderr_path.stat().st_size - ERROR_TAIL_BYTES))
        tail = source.read()
    ERROR_LOGS.mkdir(parents=True, exist_ok=True)
    target = ERROR_LOGS / f"{name}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{os.getpid()}.log"
    temporary = target.with_suffix(".tmp")
    temporary.write_bytes(tail)
    os.replace(temporary, target)
    return target


def plan_candidate_refusal(record, candidate):
    """Where the todo kit is installed, the reason a plan review of `candidate` would be refused at `stamp`, or None
    (D00 T01 §30): a review is not spent on a candidate the stamp will refuse. The section is read from `record`, which
    must be its canonical findings file; the check is `todo-graph.py plan-candidate`, the code the stamp runs."""
    if not TODO_GRAPH.is_file():
        return None
    if not record:
        return ("--kind plan needs --record, the section's findings file docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md: "
                "the section is read from it, to check the candidate before the review is paid for")
    # The destination the record is written to is `Path(record)` as the caller's working directory resolves it: the same
    # resolved path is validated here, and one outside this checkout is refused.
    try:
        relative = Path(record).resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return (f"--record {record} resolves outside this repository ({Path(record).resolve()}), so the review would be "
                "recorded where the stamp never reads it")
    found = FINDINGS_PATH.fullmatch(relative)
    if found is None or found[1] != found[2]:
        return (f"--record {record} is not a section's findings file docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md, so "
                "the section the plan candidate is checked against cannot be read from it")
    ref = f"D{found[2]} T{found[3]} \u00a7{found[4]}"
    try:
        checked = subprocess.run([sys.executable, "-B", str(TODO_GRAPH), "plan-candidate", ref, candidate,
                                  "--findings", relative],
                                 cwd=str(ROOT), capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as exc:
        return f"the plan candidate could not be checked ({exc}), so no review was spent"
    if checked.returncode == 0:
        return None
    return (checked.stderr.strip() or checked.stdout.strip() or "todo-graph.py plan-candidate failed").removeprefix(
        "TODO refused: ")


def review(pin, writer, prompt_path, timeout, plan=None, reviewer_name=None):
    """Run the writer's one reviewer. Returns the summary dict: `reviewer` is None when no review came back, and
    `failover` then names the reviewer and why (there is no fallback). `plan` is the scheduled step (see `scheduled`):
    its effort replaces the reviewer's, and its lenses are appended to the prompt and recorded."""
    if writer not in pin["routes"]:
        raise Refused(f"the reviewer pin has no route for writer {writer!r}")
    prompt = Path(prompt_path).read_text(encoding="utf-8")
    if not prompt.strip():
        raise Refused("the review prompt is empty")
    if "\0" in prompt:
        raise Refused("the review prompt contains a NUL byte; no reviewer can be given it")
    (name,) = (reviewer_name,) if reviewer_name else pin["routes"][writer]
    reviewer = pin["reviewers"][name]
    effort = None if reviewer["cli"] == "agy" else (plan["effort"] if plan else reviewer.get("effort"))
    lenses = plan["lenses"] if plan else []
    if lenses:
        prompt = prompt.rstrip("\n") + lens_block(plan)
    scheduled_fields = {"effort": effort, "lenses": lenses} if plan else {}

    def none(reason):
        return {"writer": writer, "reviewer": None, "failover": [{"reviewer": name, "reason": reason}], "review": None,
                **scheduled_fields}

    # The resolved path, not the bare name: on Windows a CLI is often a .cmd shim that Popen cannot find by name.
    executable = find_cli(reviewer["cli"])
    if executable is None:
        return none(f"{reviewer['cli']} is not installed")
    text = None
    tmp = Path(tempfile.mkdtemp())
    try:
        stdout_path, message_path, stderr_path = tmp / "stdout.txt", tmp / "last-message.md", tmp / "stderr.txt"
        prompt_file = Path(prompt_path).resolve()
        if lenses:
            # The pointer an Antigravity shim gets must name the prompt with its scheduled lenses.
            prompt_file = tmp / "prompt.md"
            prompt_file.write_text(prompt, encoding="utf-8", newline="\n")
        argv, stdin_text = command(reviewer, executable, prompt, prompt_file, message_path, timeout, effort)
        with in_flight(name, timeout):
            _, problem = run(argv, stdin_text, timeout, [stdout_path, message_path], stderr_path)
        if problem is not None and (kept := keep_error_tail(name, stderr_path)):
            print(f"review-dispatch: {name} {problem}; the end of its error output is in {kept}", file=sys.stderr)
        if problem is None:
            # Codex writes its final message to the -o file; stdout carries its progress, not the review.
            source = message_path if reviewer["cli"] == "codex" else stdout_path
            text = source.read_text(encoding="utf-8", errors="replace") if source.is_file() else ""
    finally:
        remove_scratch(tmp)
    if problem is None and not (text or "").strip():
        problem = "returned no review"
    if problem is None:
        problem = blocked(text)
    if problem:
        return none(problem)
    return {"writer": writer, "reviewer": name, "cli": reviewer["cli"], "model": reviewer["model"],
            "effort": effort, "failover": [], "review": text.strip(), **({"lenses": lenses} if plan else {})}


IN_FLIGHT = ROOT / "build" / "review-in-flight.json"


class in_flight:
    """While a reviewer runs, build/review-in-flight.json names this dispatcher (pid and a deadline past its timeout),
    so scripts/campaign_guard.py's Stop hook lets the campaign session end its turn to wait for the review instead of
    pushing it on to work that would change the tree under the reviewer. Removed when the reviewer is done."""

    def __init__(self, reviewer, timeout):
        self.doc = {"pid": os.getpid(), "reviewer": reviewer,
                    "started": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "deadline": time.time() + timeout + 60}

    def __enter__(self):
        try:
            atomic_write(IN_FLIGHT, json.dumps(self.doc) + "\n")
        except OSError:
            pass  # only a convenience for the Stop hook: a review never fails for it
        return self

    def __exit__(self, *exc):
        try:
            if json.loads(IN_FLIGHT.read_text(encoding="utf-8")).get("pid") == self.doc["pid"]:
                IN_FLIGHT.unlink()
        except (OSError, ValueError):
            pass
        return False


def blocked(text):
    """Why a reply is not a review, when its last line is `OVERALL: blocked` (or `COMPLETION: blocked`); None for a
    review."""
    lines = [line for line in text.strip().splitlines() if line.strip()]
    if not lines or not BLOCKED.match(lines[-1]):
        return None
    reason = next((line.strip() for line in lines[:-1] if not line.lstrip().startswith("#")), "no reason given")
    return f"could not review: {reason[:300]}"


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        # newline="": the text is written as given, so a review's own "\r" bytes are stored and nothing is translated.
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


# A findings file is read back by `list_rounds`, so the envelope `record` writes around each review is unambiguous:
# the metadata states how many lines the review has (`- Lines: N`, lines split on "\n" only) and a digest of them
# (`- Digest:`, the first 16 hex digits of the SHA-256 of the canonical lines joined with "\n"). The reader skips
# exactly N lines and checks the digest, so neither a quoted heading nor an edit of the same length passes for a round.
# The review is stored byte for byte; a line's trailing "\r" is dropped only to compare, so a CRLF checkout reads the
# same. Rounds recorded before the count have no Lines field and run to the next round heading; rounds recorded
# before the digest have Lines without Digest and are read by their count alone.
# Numbers are ASCII digits of bounded length, so the reader's int() can never raise (`\d` also takes "²", and a number
# past Python's digit limit raises). A review is at most MAX_OUTPUT_BYTES, so it has at most MAX_OUTPUT_BYTES + 1 lines,
# and the count's width follows from that: whatever `record` writes, the reader reads.
ROUND_HEADING = re.compile(r"^## Round ([0-9]{1,6}): (none|([a-z0-9][a-z0-9-]*) \(`([^`]+)` via `([a-z]+)`\))$")
ROUND_LINE = re.compile(r"^- (Writer|Run|Effort|Lenses|Schedule|Policy|Pin|Lines|Digest|Skipped): (\S.*)$")
# The one-pass completion review, recorded beside the rounds and never counted as one. It always carries Lines, Digest
# and the Candidate commit it reviewed; the writer's notes after it (its `- Filed:` lines) run to the next `## ` line.
COMPLETION_HEADING = re.compile(r"^## Completion review: (none|([a-z0-9][a-z0-9-]*) \(`([^`]+)` via `([a-z]+)`\))$")
PLAN_HEADING = re.compile(r"^## Plan review: (none|([a-z0-9][a-z0-9-]*) \(`([^`]+)` via `([a-z]+)`\))$")
FINAL_HEADING = re.compile(r"^## Final review: (none|([a-z0-9][a-z0-9-]*) \(`([^`]+)` via `([a-z]+)`\))$")
COMPLETION_LINE = re.compile(r"^- (Writer|Run|Candidate|Effort|Lenses|Policy|Pin|Lines|Digest|Skipped|Binding): (\S.*)$")
RECONCILIATION_HEADING = re.compile(r"^## Reconciliation review: (none|([a-z0-9][a-z0-9-]*) \(`([^`]+)` via `([a-z]+)`\))$")
# The one-pass reviews, by --kind: the heading each is recorded under and the key read_findings lists them under.
PASSES = {"completion": ("## Completion review", COMPLETION_HEADING, "completions"),
          "plan": ("## Plan review", PLAN_HEADING, "plans"),
          "final": ("## Final review", FINAL_HEADING, "finals"),
          "reconciliation": ("## Reconciliation review", RECONCILIATION_HEADING, "reconciliations")}
RESERVED = ("## Round", *(prefix for prefix, _, _ in PASSES.values()))
RESERVED_NAMES = ("headings starting `## Round`, `## Completion review`, `## Plan review` or `## Final review` are reserved "
                  "for --record")
CANDIDATE = re.compile(r"[0-9a-f]{40}")
SKIPPED = re.compile(r"^([a-z0-9][a-z0-9-]*) \((.*)\)$")
COUNT = re.compile(r"[0-9]{1,%d}" % len(str(MAX_OUTPUT_BYTES + 1)))
DIGEST = re.compile(r"[0-9a-f]{16}")
# The git blob id of the pin a pass ran under (SHA-1 or SHA-256), so the stamp can hold it to that pin (D00 T01 §18).
PIN_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


def repository_relative(text, record=None):
    """A review with every absolute path under the repository root written relative to it. Findings files are
    committed and may be published, and a reviewer (Codex links files by absolute path) would otherwise record the
    checkout's location, which names the user's home folder. A Markdown link to such a path becomes a link relative to
    the findings file `record` (`[a.md:18](/root/a.md:18)` in docs/reviews/x/ becomes `[a.md:18](../../../a.md#L18)`),
    so it opens the file on GitHub at that line; any other mention keeps the repository-relative path as text. Applied
    before the line count and digest, so the record reads back exactly as written."""
    folder = Path(os.path.abspath(record)).parent if record else ROOT
    for root in {str(ROOT), ROOT.as_posix()}:
        prefix = root.rstrip("/\\") + ("\\" if "\\" in root else "/")

        def link(match):
            target = match.group(1).replace("\\", "/")
            relative = Path(os.path.relpath(ROOT / target, folder)).as_posix()
            return f"]({relative}#L{match.group(2)})" if match.group(2) else f"]({relative})"

        text = re.sub(r"\]\(" + re.escape(prefix) + r"([^)\s:]+)(?::(\d+))?\)", link, text)
        text = text.replace(prefix, "")
    # Any other home or user folder a reviewer quotes (a tool under ~/.local/bin, say) is written from `~`, so a
    # published record names no account; the same folders scripts/check-publication.py refuses.
    text = re.sub(r"/home/[A-Za-z0-9._-]+(?=/|\b)", "~", text)
    text = re.sub(r"/mnt/[a-z]/Users/[^/`)\n]+", "~", text)
    return re.sub(r"[A-Z]:\\Users\\[^\\`)\n]+", "~", text)


def raw_lines(text):
    """Lines split on "\n" alone, the one boundary `record` and the reader share, every other byte kept. `str.splitlines`
    also splits on "\r", U+2028, U+0085 and others, which a review may contain."""
    return text.split("\n")


def canonical(line):
    """A line as compared and digested: a CRLF checkout's trailing "\r" dropped."""
    return line[:-1] if line.endswith("\r") else line


def digest(lines):
    return hashlib.sha256("\n".join(canonical(line) for line in lines).encode("utf-8")).hexdigest()[:16]


def _read_findings(text):
    """The rounds and completion reviews `record` and `record_completion` wrote in one findings file, as
    `{"rounds": [...], "completions": [...]}`, or None when anything they write is not as they write it.

    A round is a `## Round` heading, a blank line, and a metadata block to the next blank line in which every line is
    one of `record`'s fields (Writer and Run exactly once, Effort, Lines and Digest at most once, any number of Skipped;
    Digest only with Lines). With Lines, the next N lines are the review, skipped unread, and a blank line or the end of
    the file must follow them; with Digest, they must also hash to it, so a hand edit inside a review shows as
    unreadable even when it keeps the count. Without Lines (a round recorded before the count), the round runs to the
    next reserved heading. A completion review, and a plan review (`## Plan review`), is read the same way, with
    Writer, Run, Candidate, Lines and Digest required; the lines after it up to the next `## ` line are its `notes`,
    the writer's own record of what was done with each gap. Lenses, when present, is the comma-separated list the
    schedule gave the pass. Anything else makes the file unreadable rather than losing a field."""
    found = {"rounds": [], "completions": [], "plans": [], "finals": [], "reconciliations": []}
    raw = raw_lines(text)
    lines = [canonical(line) for line in raw]
    i = 0
    while i < len(lines):
        kind = next((k for k, (prefix, _, _) in PASSES.items() if lines[i].startswith(prefix)), None)
        completion = kind is not None
        if not lines[i].startswith("## Round") and not completion:
            i += 1
            continue
        head = i
        heading = (PASSES[kind][1] if completion else ROUND_HEADING).match(lines[i])
        if not heading or i + 1 >= len(lines) or lines[i + 1] != "":
            return None, head
        if completion:
            entry = {"reviewer": heading.group(2), "model": heading.group(3), "cli": heading.group(4), "writer": None,
                     "run": None, "candidate": None, "effort": None, "lenses": None, "pin": None, "policy": None, "skipped": []}
        else:
            entry = {"number": int(heading.group(1)), "reviewer": heading.group(3), "model": heading.group(4),
                     "cli": heading.group(5), "writer": None, "run": None, "effort": None, "lenses": None,
                     "schedule": None, "pin": None, "policy": None, "skipped": []}
        if kind == "reconciliation":
            entry["binding"] = None
        count = sealed = None
        i += 2
        while i < len(lines) and lines[i] != "":
            field = (COMPLETION_LINE if completion else ROUND_LINE).match(lines[i])
            if not field:
                return None, head
            key, value = field.group(1).lower(), field.group(2)
            if key == "skipped":
                skipped = SKIPPED.match(value)
                if not skipped:
                    return None, head
                entry["skipped"].append({"reviewer": skipped.group(1), "reason": skipped.group(2)})
            elif key == "binding":
                if not (kind == "reconciliation" or kind == "completion" and entry.get("policy") == "codex-two-pass-v1") or entry.get("binding") is not None:
                    return None, head
                try:
                    entry["binding"] = json.loads(value)
                except (ValueError, RecursionError):
                    return None, head
                if not isinstance(entry["binding"], dict):
                    return None, head
            elif key == "lines":
                # ASCII digits only: "²" passes str.isdigit and int() raises on it.
                if count is not None or not COUNT.fullmatch(value):
                    return None, head
                count = int(value)
            elif key == "digest":
                if sealed is not None or not DIGEST.fullmatch(value):
                    return None, head
                sealed = value
            elif entry[key] is not None or (key == "candidate" and not CANDIDATE.fullmatch(value)):
                return None, head
            elif key == "policy" and value not in SELF_REVIEW_POLICIES:
                return None, head
            elif key == "schedule" and value not in SCHEDULES:
                return None, head
            elif key == "pin" and not PIN_ID.fullmatch(value):
                return None, head
            elif key == "lenses":
                names = value.split(", ")
                if not all(name in LENSES for name in names) or len(set(names)) != len(names):
                    return None, head
                entry[key] = names
            else:
                entry[key] = value
            i += 1
        if entry["writer"] is None or entry["run"] is None or (sealed is not None and count is None):
            return None, head
        if (kind == "reconciliation" or kind == "completion" and entry.get("policy") == "codex-two-pass-v1") and entry.get("binding") is None:
            return None, head
        if completion and (entry["candidate"] is None or sealed is None):
            return None, head
        if count is not None:
            start = i + 1  # the blank line after the metadata, then the review, unread
            i = start + count
            if i > len(lines) or (i < len(lines) and lines[i] != ""):
                return None, head
            if sealed is not None and digest(raw[start:i]) != sealed:
                return None, head
            entry["review"] = "\n".join(lines[start:i])
        else:
            end = next((j for j in range(i, len(lines)) if lines[j].startswith(RESERVED)), len(lines))
            entry["review"] = "\n".join(lines[i:end])
            i = end
        if entry.get("policy") in SELF_REVIEW_POLICIES:
            entry["offset"] = head
        if kind == "reconciliation" or kind == "completion" and entry.get("policy") == "codex-two-pass-v1":
            entry["digest"] = sealed
        if completion:
            end = next((j for j in range(i, len(lines)) if lines[j].startswith("## ")), len(lines))
            entry["notes"] = [line for line in lines[i:end] if line.strip()]
            i = end
            found[PASSES[kind][2]].append(entry)
        else:
            found["rounds"].append(entry)
    return found, None


def read_findings(text):
    """See `_read_findings`: the parsed rounds, completion and plan reviews, or None when the file cannot be read."""
    return _read_findings(text)[0]


def unreadable_heading(text):
    """The line where a findings file stops being readable, as `line N: <text>`, so a refusal can name it. A writer's
    own note under a heading that starts `## Round`, `## Completion review` or `## Plan review` is the usual cause:
    those prefixes are reserved for what `--record` writes."""
    found, head = _read_findings(text)
    if found is not None or head is None:
        return ""
    lines = raw_lines(text)
    return f"; the first unreadable record starts at line {head + 1}: {canonical(lines[head])!r}" if head < len(lines) else ""


def read_rounds(text):
    """The rounds `record` wrote in one findings file (completion reviews are not rounds), or None when the file is not
    as `record` and `record_completion` write it (see read_findings)."""
    found = read_findings(text)
    return None if found is None else found["rounds"]


def read_completions(text):
    """The completion reviews `record_completion` wrote in one findings file, or None when it cannot be read back."""
    found = read_findings(text)
    return None if found is None else found["completions"]


def read_plans(text):
    """The plan reviews `--kind plan` recorded in one findings file, or None when it cannot be read back."""
    found = read_findings(text)
    return None if found is None else found["plans"]


def read_finals(text):
    """The final reviews `--kind final` recorded in one findings file, or None when it cannot be read back."""
    found = read_findings(text)
    return None if found is None else found["finals"]


# Rounds recorded after a final review prove its fix; `stamp` accepts at most this many (scripts/lib/todo_graph.py holds
# the same number), so a round past it is refused before it runs, never spent and then refused at the stamp.
POST_FINAL_CAP = 3


def rounds_after_final(text):
    """How many returned reviews a findings file holds after its first final review (0 with none), counted as `stamp`
    counts them; None when the file cannot be read back."""
    rounds = read_rounds(text)
    finals = read_finals(text)
    if rounds is None or finals is None:
        return None
    finals = [f for f in finals if f.get("reviewer")]
    if not finals:
        return 0
    return sum(1 for e in rounds if returned_review(e) and e["run"] > finals[0]["run"])


class Unrecorded(Exception):
    """The findings file cannot be read back, so a round is not appended to it."""


def existing_findings(path, what):
    """A findings file's text as stored, or `Unrecorded` when it cannot be read."""
    try:
        # Bytes, not read_text: universal newlines would turn a stored lone "\r" into a line break and move the
        # line count of an earlier round.
        return path.read_bytes().decode("utf-8") if path.exists() else ""
    except (OSError, UnicodeDecodeError) as exc:
        raise Unrecorded(f"{path} cannot be read back ({exc}), so the {what} was not recorded") from None


def appended_findings(existing, lines):
    # Preserve every existing byte, including blank lines sealed by a reconciliation prefix.
    separator = "" if not existing else ("\n" if existing.endswith("\n") else "\n\n")
    return existing + separator + "\n".join(lines)


def append_findings(path, existing, lines):
    atomic_write(path, appended_findings(existing, lines))


def record(path, result, when):
    """Append one round and return its number. A findings file the reader cannot read back gets nothing appended:
    numbering it would have to guess (counting headings counts quoted ones), so `Unrecorded` is raised instead."""
    existing = existing_findings(path, "round")
    known = read_rounds(existing)
    if known is None:
        raise Unrecorded(f"{path} cannot be read back (a round heading or line is not in the format --record writes"
                         f"{unreadable_heading(existing)}; {RESERVED_NAMES}), so the round was not recorded")
    number = len(known) + 1
    who = f"{result['reviewer']} (`{result['model']}` via `{result['cli']}`)" if result["reviewer"] else "none"
    review = raw_lines(repository_relative(result["review"] or "No reviewer returned a review. This round is not an approval.", path))
    if not COUNT.fullmatch(str(len(review))) or not ROUND_HEADING.match(f"## Round {number}: none"):
        raise Unrecorded(f"the review or the round number is past what {path} can be read back with, "
                         f"so the round was not recorded")
    lines = [f"## Round {number}: {who}", "", f"- Writer: {result['writer']}", f"- Run: {when}"]
    lines += metadata(result)
    lines += [f"- Lines: {len(review)}", f"- Digest: {digest(review)}", "", *review, ""]
    append_findings(path, existing, lines)
    return number


def metadata(result):
    lines = [f"- Effort: {result['effort']}"] if result.get("effort") else []
    if result.get("lenses"):
        lines.append(f"- Lenses: {', '.join(result['lenses'])}")
    # Only a light round says so: a round without the line ran on the full schedule, as every older record did.
    if result.get("schedule") == "light":
        lines.append("- Schedule: light")
    # The pin the pass ran under; a pass recorded without the line is held to the stamped commit's pin, as before.
    if result.get("policy"):
        lines.append(f"- Policy: {result['policy']}")
    if result.get("pin"):
        lines.append(f"- Pin: {result['pin']}")
    return lines + [f"- Skipped: {f['reviewer']} ({f['reason']})" for f in result["failover"]]


def returned_pass(entry, kind):
    """A recorded pass with an allowed reviewer identity, closing with that pass's verdict lines (the stamp's own rule, in scripts/lib/todo_graph.py). A reply that
    never reached its verdict (a malformed or blocked answer) is sealed in the file but is not the one pass, so
    a fresh pass may still be recorded beside it."""
    if not reviewer_allowed(entry):
        return False
    lines = verdict_lines(entry.get("review"))
    if kind == "plan":
        return len(lines) >= 2 and lines[-2] in ("PLAN: complete", "PLAN: gaps") \
            and lines[-1] in ("OVERALL: approve", "OVERALL: needs-attention")
    if kind == "reconciliation":
        return bool(lines) and lines[-1] in ("RECONCILIATION: complete", "RECONCILIATION: gaps")
    if kind == "completion":
        return bool(lines) and lines[-1] in ("COMPLETION: complete", "COMPLETION: gaps")
    return True


def check_self_review_order(kind, record_path, pin=None):
    """Codex runs one plan pass, one implementation round, then a completion pass."""
    if kind == "final":
        raise Refused("Codex self-review ends with --kind completion, not a separate final review")
    if not record_path:
        raise Refused("Codex self-review needs --record to enforce its three-pass order")
    existing = existing_findings(Path(record_path), kind)
    found = read_findings(existing)
    if found is None:
        raise Unrecorded("the Codex self-review findings cannot be read back")
    if pin is not None and review_policy(pin, "codex") == "codex-two-pass-v1":
        if kind == "round":
            raise Refused("two-pass Codex policy forbids an ordinary implementation round")
        if kind == "plan":
            if any(found[k] for k in ("rounds", "completions", "finals", "reconciliations")) or any(returned_pass(e, "plan") for e in found["plans"]):
                raise Refused("two-pass plan runs once before implementation review")
            if any(e.get("policy") != "codex-two-pass-v1" for e in found["plans"]):
                raise Refused("cannot mix plan policies")
            return
        if kind == "completion":
            if any(found[k] for k in ("rounds", "finals", "reconciliations")):
                raise Refused("two-pass completion requires no ordinary round or final attempts")
            if any(returned_pass(e, "completion") for e in found["completions"]):
                raise Refused("two-pass completion runs once")
            return
    entries = [entry for group in found.values() for entry in group]
    if any(entry.get("policy") != "codex-self-review" for entry in entries):
        raise Refused("Codex self-review needs its own findings file, with no earlier review policy")
    plans = [entry for entry in found["plans"] if returned_pass(entry, "plan")]
    rounds = [entry for entry in found["rounds"] if returned_review(entry)]
    completions = [entry for entry in found["completions"] if returned_pass(entry, "completion")]
    if kind == "plan":
        if plans or found["rounds"] or found["completions"]:
            raise Refused("Codex self-review plan must run once, before implementation review")
    elif len(plans) != 1:
        raise Refused("Codex self-review needs exactly one returned plan review before implementation review")
    elif kind == "round" and (rounds or found["completions"]):
        raise Refused("Codex self-review allows exactly one returned implementation round before completion")
    elif kind == "reconciliation":
        if len(rounds) != 1 or len(completions) != 1 or verdict_lines(completions[0]["review"])[-1] != "COMPLETION: gaps":
            raise Refused("reconciliation requires exactly one round and a completion with gaps")
        if any(returned_pass(e, "reconciliation") for e in found["reconciliations"]):
            raise Refused("exactly one returned reconciliation is allowed")
    elif kind == "completion" and (len(rounds) != 1 or completions):
        raise Refused("Codex self-review completion runs once, after exactly one returned implementation round")


def record_completion(path, result, when, candidate, kind="completion"):
    """Append the completion review (or, with kind "plan", the plan review). Each is one pass: a findings file that
    already holds a returned one (see `returned_pass`) gets nothing appended (`Unrecorded`), and neither does one
    the reader cannot read."""
    prefix, _, key = PASSES[kind]
    what = f"{kind} review"
    existing = existing_findings(path, what)
    found = read_findings(existing)
    if found is None:
        raise Unrecorded(f"{path} cannot be read back (a heading or line is not in the format --record writes"
                         f"{unreadable_heading(existing)}; {RESERVED_NAMES}), so the {what} was not recorded")
    if any(returned_pass(entry, kind) for entry in found[key]) and not (kind == "reconciliation" and result.get("binding", {}).get("version") in (2, 3)):
        raise Unrecorded(f"{path} already holds a {what}; it is one pass, so this one was not recorded")
    who = f"{result['reviewer']} (`{result['model']}` via `{result['cli']}`)" if result["reviewer"] else "none"
    review = raw_lines(repository_relative(result["review"] or f"No reviewer returned a {what}. This pass is not an approval.", path))
    if not COUNT.fullmatch(str(len(review))):
        raise Unrecorded(f"the review is past what {path} can be read back with, so it was not recorded")
    lines = [f"{prefix}: {who}", "", f"- Writer: {result['writer']}", f"- Run: {when}", f"- Candidate: {candidate}"]
    lines += metadata(result)
    if kind == "reconciliation" or kind == "completion" and result.get("policy") == "codex-two-pass-v1":
        lines.append("- Binding: " + json.dumps(result["binding"], sort_keys=True, separators=(",", ":")))
    lines += [f"- Lines: {len(review)}", f"- Digest: {digest(review)}", "", *review, ""]
    if kind == "reconciliation" and result["binding"].get("version") in (2, 3):
        report_parts = Path(result["binding"]["report"]).parts
        root = Path(path).resolve().parents[len(report_parts) - 1]
        prospective = appended_findings(existing, lines)
        validate_reconciliation_series(root, prospective)
    append_findings(path, existing, lines)


def reconciliation_enabled(pin, writer):
    return writer == "codex" and pin.get("reconciliation") == ["codex"] and self_review_enabled(pin, writer)


def read_reconciliations(text):
    found = read_findings(text)
    return None if found is None else found["reconciliations"]


def _reconcile_require(ok, message):
    if not ok:
        raise Refused("reconciliation: " + message)


def _reconcile_git(root, *args):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, timeout=60)
    _reconcile_require(result.returncode == 0, "cannot verify git evidence: " + " ".join(args))
    return result.stdout


def _reconcile_path(root, path):
    root = Path(root).resolve()
    path = Path(path)
    if path.is_absolute():
        try:
            path = path.relative_to(root)
        except ValueError:
            raise Refused("reconciliation: path outside repository") from None
    relative = path.as_posix()
    _reconcile_require(re.fullmatch(r"docs/reviews/[A-Za-z0-9_./-]+\.md", relative) is not None
                       and ".." not in path.parts, "invalid evidence path")
    current = root
    for part in path.parts:
        current /= part
        _reconcile_require(not current.is_symlink(), "symlink evidence path")
    _reconcile_require(current.is_file(), "missing evidence: " + relative)
    return relative


def _reconcile_contract(text, number):
    # Reuse the source-of-truth contract extractor without loading the graph or validating receipts recursively.
    import importlib.util
    spec = importlib.util.spec_from_file_location("reconciliation_contract", Path(__file__).parent / "lib/todo_graph.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    _reconcile_require(module.section_text(text, number) is not None, "section is absent from contract")
    contract = module.contract_text(text, number)
    contract = re.sub(r"^(- )\[[xX ]\](?= )", r"\1[ ]", contract, flags=re.M)
    contract = re.sub(r"^(\|[^\n]*\| )\[[xX ]\]( \|)$", r"\1[ ]\2", contract, flags=re.M)
    contract = re.sub(r"^> \*\*(?:Verified|Review):\*\*[^\n]*(?:\n|$)", "", contract, flags=re.M)
    return contract


def _reconcile_chain(text, require_gaps=True, root=None, current_text=None):
    found = read_findings(text)
    _reconcile_require(found is not None, "unreadable original findings")
    if root is not None and any(e.get("policy") == "codex-two-pass-v1" for e in found["completions"]):
        # The immutable original prefix excludes later reconciliation records by design.
        # History preservation must inspect the full current report, where those records remain.
        context = text if current_text is None else current_text
        _reconcile_require(context.startswith(text), "current findings do not preserve the original prefix")
        chain = validate_codex_chain(root, context)
        _reconcile_require(not require_gaps or verdict_lines(chain["completion"]["review"])[-1] == "COMPLETION: gaps", "original completion did not return gaps")
        return found, {"plan": chain["plan"], "completion": chain["completion"]}, [*found["plans"], *found["completions"]]
    chosen = {}
    entries = []
    for kind, key in (("plan", "plans"), ("round", "rounds"), ("completion", "completions")):
        group = found[key]
        valid = [e for e in group if (returned_review(e) if kind == "round" else returned_pass(e, kind))]
        _reconcile_require(len(valid) == 1 and group[-1] is valid[0], "needs exactly one resolved " + kind)
        chosen[kind] = valid[0]
        entries.extend(group)
    _reconcile_require(not found["finals"], "a separate final pass is not a Codex chain")
    _reconcile_require(all(e.get("policy") == "codex-self-review" for e in entries), "original policy is not Codex self-review")
    _reconcile_require(len({e.get("pin") for e in entries}) == 1, "original chain pins differ")
    _reconcile_require(not require_gaps or verdict_lines(chosen["completion"]["review"])[-1] == "COMPLETION: gaps", "original completion did not return gaps")
    offsets = [chosen[k]["offset"] for k in ("plan", "round", "completion")]
    _reconcile_require(offsets == sorted(offsets), "original review order is invalid")
    try:
        times = [datetime.fromisoformat(chosen[k]["run"].replace("Z", "+00:00")) for k in ("plan", "round", "completion")]
        _reconcile_require(all(t.tzinfo is not None for t in times) and times == sorted(times), "original review chronology is invalid")
    except (ValueError, TypeError):
        raise Refused("reconciliation: original review chronology is invalid") from None
    return found, chosen, entries


def _reconcile_tips(root):
    """Only parents of the next commit count, including the incoming parent of an open merge."""
    merging = subprocess.run(["git", "-C", str(root), "rev-parse", "-q", "--verify", "MERGE_HEAD"],
                             capture_output=True, timeout=30)
    return ["HEAD", "MERGE_HEAD"] if merging.returncode == 0 else ["HEAD"]


def _reconcile_reachable(root, candidate):
    _reconcile_require(isinstance(candidate, str) and CANDIDATE.fullmatch(candidate), "invalid evidence commit")
    reachable = any(subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", candidate, tip],
                                  capture_output=True, timeout=30).returncode == 0 for tip in _reconcile_tips(root))
    _reconcile_require(reachable, "evidence commit is not reachable from HEAD or the active merge parent: " + candidate)


def _reconcile_pin(root, blob):
    _reconcile_require(isinstance(blob, str) and PIN_ID.fullmatch(blob), "invalid pin identity")
    raw = _reconcile_git(root, "show", blob)
    log = _reconcile_git(root, "log", "--format=", "--raw", "--no-abbrev", "--no-renames", "--full-history", "-m", *_reconcile_tips(root), "--", ".conclave/reviewers.toml").decode()
    _reconcile_require(any(line.startswith(":") and blob in line.split()[2:4] for line in log.splitlines()), "pin was not committed in current history")
    return load_pin(data=raw)


def _reconcile_identity(root, entry, reconciliation=False):
    pin = _reconcile_pin(root, entry.get("pin"))
    _reconcile_require(review_policy(pin, entry.get("writer")) == entry.get("policy"), "pin does not authorize recorded policy")
    if reconciliation:
        _reconcile_require(reconciliation_enabled(pin, "codex") and "reconciliation" in pin.get("schedule", {}), "pin does not authorize reconciliation")
    if entry.get("reviewer"):
        name = pin["routes"]["codex"][0]
        reviewer = pin["reviewers"][name]
        _reconcile_require((entry["reviewer"], entry["model"], entry["cli"]) == (name, reviewer["model"], reviewer["cli"]), "reviewer identity differs from pin")
    return pin


# Dormant capability: only these two independently authorized cases can use version 3.
EXCEPTION_REPORTS = {
    "docs/reviews/08-eval/D08-T02-s6.md": "contract-amendment",
    "docs/reviews/01-intake/D01-T03-s15.md": "exhausted-chain-successor",
}


def _exception_identity_shape(identity, report):
    _reconcile_require(isinstance(identity, dict) and set(identity) == {"path", "commit", "blob"}
                       and all(isinstance(v, str) for v in identity.values()), "malformed exception document identity")
    _reconcile_require(report in EXCEPTION_REPORTS and identity["path"] == report[:-3] + "-exception.json"
                       and CANDIDATE.fullmatch(identity["commit"]) and PIN_ID.fullmatch(identity["blob"]), "invalid exception document provenance")


def _exception_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            _reconcile_require(key not in result, "duplicate exception field: " + key)
            result[key] = value
        return result
    def invalid(value):
        raise Refused("reconciliation: nonfinite exception value: " + value)
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=invalid)
    except (ValueError, UnicodeDecodeError) as exc:
        raise Refused("reconciliation: unreadable exception document: " + str(exc)) from None


def _exception_authorization(root, pin_id, report, expected=None):
    pin = _reconcile_pin(root, pin_id)
    _reconcile_require(reconciliation_enabled(pin, "codex"), "exception pin does not authorize reconciliation")
    identity = pin.get("reconciliation_exceptions", {}).get(report)
    _exception_identity_shape(identity, report)
    _reconcile_require(expected is None or identity == expected, "exception authorization identity changed")
    _reconcile_reachable(root, identity["commit"])
    raw = _reconcile_git(root, "show", f"{identity['commit']}:{identity['path']}")
    _reconcile_require(pin_blob(raw) == identity["blob"], "committed exception blob mismatch")
    data = _exception_json(raw)
    keys = {"version", "kind", "report", "plan_candidate", "completion_candidate", "completion_digest",
            "original_contract_sha256", "accepted_contract_sha256", "prefix_bytes", "prefix_sha256", "predecessors",
            "repair_base_candidate", "disposition_path", "disposition_blob", "disposition_commit"}
    _reconcile_require(isinstance(data, dict) and set(data) == keys and type(data.get("version")) is int and data["version"] == 1,
                       "malformed exception authorization")
    _reconcile_require(all(isinstance(data[k], str) and bool(data[k]) for k in keys - {"version", "prefix_bytes", "predecessors"}), "invalid exception field types")
    _reconcile_require(data["report"] == report and data["kind"] == EXCEPTION_REPORTS[report], "wrong exception report or kind")
    _reconcile_require(type(data["prefix_bytes"]) is int and data["prefix_bytes"] > 0, "invalid exception prefix length")
    _reconcile_require(all(CANDIDATE.fullmatch(data[k]) for k in ("plan_candidate", "completion_candidate", "repair_base_candidate", "disposition_commit")), "invalid exception candidate")
    _reconcile_require(all(re.fullmatch(r"[0-9a-f]{64}", data[k]) for k in ("original_contract_sha256", "accepted_contract_sha256", "prefix_sha256"))
                       and DIGEST.fullmatch(data["completion_digest"]) and PIN_ID.fullmatch(data["disposition_blob"]), "invalid exception digest")
    predecessors = data["predecessors"]
    _reconcile_require(isinstance(predecessors, list), "invalid exception predecessors")
    for item in predecessors:
        _reconcile_require(isinstance(item, dict) and set(item) == {"candidate", "digest", "binding_version"}
                           and isinstance(item["candidate"], str) and CANDIDATE.fullmatch(item["candidate"])
                           and isinstance(item["digest"], str) and DIGEST.fullmatch(item["digest"])
                           and type(item["binding_version"]) is int and item["binding_version"] in (1, 2), "malformed exception predecessor")
    _reconcile_require(len(predecessors) == (0 if data["kind"] == "contract-amendment" else 2), "wrong exception predecessor count")
    if data["kind"] == "exhausted-chain-successor":
        _reconcile_require([p["binding_version"] for p in predecessors] == [1, 2]
                           and data["original_contract_sha256"] == data["accepted_contract_sha256"], "successor must preserve contract and ordered prior versions")
    return identity, data


def _exception_context(root, text, report, candidate, pin_id, identity=None):
    identity, auth = _exception_authorization(root, pin_id, report, identity)
    raw = text.encode("utf-8")
    size = auth["prefix_bytes"]
    _reconcile_require(size <= len(raw) and hashlib.sha256(raw[:size]).hexdigest() == auth["prefix_sha256"], "exception preceding findings changed")
    try:
        prefix = raw[:size].decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("reconciliation: exception prefix is not UTF-8") from None
    found, chosen, originals = _reconcile_chain(prefix, root=root, current_text=text)
    _reconcile_require(all(e["binding"].get("version") in (1, 2) for e in found["reconciliations"]), "exception cannot follow another exception")
    predecessors = []
    for entry in found["reconciliations"]:
        validate_reconciliation_binding(root, text, entry)
        _reconcile_require(len(predecessors) < 2 and entry["binding"]["version"] == (2 if predecessors else 1), "invalid preceding reconciliation sequence")
        if returned_pass(entry, "reconciliation"):
            _reconcile_require(verdict_lines(entry["review"])[-1] == "RECONCILIATION: gaps", "exception cannot follow successful reconciliation")
            predecessors.append({"candidate": entry["candidate"], "digest": entry["digest"], "binding_version": entry["binding"]["version"]})
    _reconcile_require(predecessors == auth["predecessors"], "exception predecessor identities mismatch")
    if auth["kind"] == "contract-amendment":
        _reconcile_require(not predecessors, "contract amendment cannot follow returned reconciliation")
    completion, plan = chosen["completion"], chosen["plan"]
    _reconcile_require(auth["completion_candidate"] == completion["candidate"] and auth["plan_candidate"] == plan["candidate"]
                       and auth["completion_digest"] == digest(raw_lines(completion["review"])), "exception original review mismatch")
    for entry in originals:
        _reconcile_identity(root, entry)
    _reconcile_reachable(root, candidate)
    _reconcile_reachable(root, plan["candidate"])
    for ancestor in [completion["candidate"], auth["repair_base_candidate"], *[p["candidate"] for p in predecessors]]:
        _reconcile_git(root, "merge-base", "--is-ancestor", ancestor, candidate)
    _, contract_path, number = _completion_location(root, report)
    def contract_hash(sha):
        value = _reconcile_contract(_reconcile_git(root, "show", f"{sha}:{contract_path}").decode("utf-8"), number)
        return hashlib.sha256(value.encode()).hexdigest()
    _reconcile_require(contract_hash(completion["candidate"]) == auth["original_contract_sha256"]
                       and contract_hash(candidate) == auth["accepted_contract_sha256"], "exception contract hash mismatch")
    disposition = _reconcile_path(root, auth["disposition_path"])
    _reconcile_require(disposition != report, "exception disposition must be separate")
    _reconcile_reachable(root, auth["disposition_commit"])
    contents = _reconcile_git(root, "show", f"{auth['disposition_commit']}:{disposition}")
    _reconcile_require(contents.strip() and pin_blob(contents) == auth["disposition_blob"], "exception disposition mismatch")
    all_found = read_reconciliations(text)
    _reconcile_require(all_found is not None, "unreadable exception findings")
    later = [e for e in all_found if e["binding"].get("version") == 3]
    before = "\n".join(raw_lines(text)[:later[0]["offset"]]).encode() if later else raw
    expected_before = raw[:size] if not later or raw[:size].endswith(b"\n") else raw[:size] + b"\n"
    _reconcile_require(before == expected_before, "exception prefix omits preceding evidence")
    _reconciliation_history_preserved(root, report, text)
    return identity, auth, contract_path, contract_hash(plan["candidate"])


def _make_exception_binding(root, report, text, candidate, disposition_path, pin_id):
    identity, auth, contract_path, plan_hash = _exception_context(root, text, report, candidate, pin_id)
    auth_path = Path(root) / identity["path"]
    _reconcile_require(auth_path.is_file() and not auth_path.is_symlink()
                       and pin_blob(auth_path.read_bytes()) == identity["blob"], "exception authorization has uncommitted or missing bytes")
    _reconcile_require(_reconcile_path(root, disposition_path) == auth["disposition_path"], "exception disposition argument differs")
    _reconcile_require((Path(root) / auth["disposition_path"]).read_bytes() == _reconcile_git(root, "show", f"{auth['disposition_commit']}:{auth['disposition_path']}"), "exception disposition has uncommitted changes")
    binding = {"version": 3, "report": report, "prefix_sha256": auth["prefix_sha256"], "prefix_bytes": auth["prefix_bytes"],
               "completion_digest": auth["completion_digest"], "completion_candidate": auth["completion_candidate"],
               "plan_candidate": auth["plan_candidate"], "contract_path": contract_path, "contract_sha256": auth["original_contract_sha256"],
               "plan_contract_sha256": plan_hash, "candidate": candidate, "disposition_path": auth["disposition_path"],
               "disposition_blob": auth["disposition_blob"], "disposition_commit": auth["disposition_commit"],
               "exception_kind": auth["kind"], "accepted_contract_sha256": auth["accepted_contract_sha256"],
               "authorization_path": identity["path"], "authorization_commit": identity["commit"], "authorization_blob": identity["blob"]}
    attempts = read_reconciliations(text)
    for entry in attempts:
        if entry["binding"].get("version") == 3:
            _reconcile_require(not returned_pass(entry, "reconciliation"), "exception already returned; no successor is authorized")
            _reconcile_require(entry["binding"] == binding, "exception outage retry must retain identical binding")
    validate_reconciliation_series(root, text)
    return binding


def _exception_prompt_evidence(root, binding):
    report = (Path(root) / binding["report"]).read_bytes()
    _reconcile_require(hashlib.sha256(report[:binding["prefix_bytes"]]).hexdigest() == binding["prefix_sha256"], "exception evidence changed before invocation")
    number = re.search(r"-s([1-9]\d*)\.md$", binding["report"])[1]
    sections = []
    for label, candidate in (("Original plan contract", binding["plan_candidate"]),
                             ("Original completion contract", binding["completion_candidate"]),
                             ("Exact accepted candidate contract", binding["candidate"])):
        raw = _reconcile_git(root, "show", f"{candidate}:{binding['contract_path']}").decode("utf-8")
        sections.append(label + ":\n" + _reconcile_contract(raw, number))
    sections.append("Preserved findings and preceding attempts:\n" + report.decode("utf-8"))
    for label, commit, path in (("Committed exception authorization", binding["authorization_commit"], binding["authorization_path"]),
                                ("Committed repair disposition", binding["disposition_commit"], binding["disposition_path"])):
        sections.append(label + ":\n" + _reconcile_git(root, "show", f"{commit}:{path}").decode("utf-8"))
    return "\n\n".join(sections)


def _validate_exception_binding(root, text, entry):
    binding = entry["binding"]
    identity = {"path": binding["authorization_path"], "commit": binding["authorization_commit"], "blob": binding["authorization_blob"]}
    _, auth, contract_path, plan_hash = _exception_context(root, text, binding["report"], binding["candidate"], entry.get("pin"), identity)
    _reconcile_identity(root, entry, reconciliation=True)
    expected = {"prefix_bytes": auth["prefix_bytes"], "prefix_sha256": auth["prefix_sha256"], "completion_digest": auth["completion_digest"],
                "completion_candidate": auth["completion_candidate"], "plan_candidate": auth["plan_candidate"], "contract_path": contract_path,
                "contract_sha256": auth["original_contract_sha256"], "plan_contract_sha256": plan_hash,
                "disposition_path": auth["disposition_path"], "disposition_blob": auth["disposition_blob"], "disposition_commit": auth["disposition_commit"],
                "exception_kind": auth["kind"], "accepted_contract_sha256": auth["accepted_contract_sha256"]}
    _reconcile_require(entry.get("candidate") == binding["candidate"] and all(binding[k] == v for k,v in expected.items()), "exception binding differs from authorization")
    return binding


def make_reconciliation_binding(root, record_path, candidate, disposition_path):
    root = Path(root).resolve()
    report = _reconcile_path(root, record_path)
    match = re.fullmatch(r"docs/reviews/(\d{2}-[A-Za-z0-9_-]+)/D(\d{2})-T(\d{2})-s([1-9]\d*)\.md", report)
    _reconcile_require(match is not None and match[1].startswith(match[2] + "-"), "findings path is not canonical")
    text = (root / report).read_bytes().decode("utf-8")
    current_pin = _reconcile_git(root, "rev-parse", "HEAD:.conclave/reviewers.toml").decode().strip()
    pin = _reconcile_pin(root, current_pin)
    if report in pin.get("reconciliation_exceptions", {}):
        return _make_exception_binding(root, report, text, candidate, disposition_path, current_pin)
    attempts = read_reconciliations(text)
    _reconcile_require(attempts is not None and not any(e["binding"].get("version") == 3 for e in attempts), "exception authorization missing or revoked")
    found, chosen, entries = _reconcile_chain(text, root=root)
    for entry in entries:
        _reconcile_identity(root, entry)
    _reconcile_require(isinstance(candidate, str) and CANDIDATE.fullmatch(candidate), "candidate needs a full SHA")
    completion, plan = chosen["completion"], chosen["plan"]
    _reconcile_git(root, "merge-base", "--is-ancestor", completion["candidate"], candidate)
    _reconcile_reachable(root, candidate)
    paths = list((root / "todo" / match[1]).glob(f"TODO-{match[3]}-*.md"))
    _reconcile_require(len(paths) == 1, "cannot identify one owning TODO file")
    contract_path = paths[0].relative_to(root).as_posix()
    def contract(sha):
        return _reconcile_contract(_reconcile_git(root, "show", f"{sha}:{contract_path}").decode("utf-8"), match[4])
    original_contract = contract(completion["candidate"])
    _reconcile_require(original_contract == contract(candidate), "original completion contract changed or narrowed")
    disposition = _reconcile_path(root, disposition_path)
    _reconcile_require(disposition != report, "disposition must be separate from findings")
    disposition_commit = _reconcile_git(root, "rev-parse", "HEAD").decode().strip()
    disposition_bytes = _reconcile_git(root, "show", f"{disposition_commit}:{disposition}")
    _reconcile_require(disposition_bytes.strip() and disposition_bytes == (root / disposition).read_bytes(), "disposition is empty or not committed unchanged")
    _reconciliation_history_preserved(root, report, text)
    returned = validate_reconciliation_series(root, text)
    version, extra = 1, {}
    if returned:
        _reconcile_require(len(returned) == 1, "no third returned reconciliation is allowed")
        predecessor = returned[0]
        pin_id = _reconcile_git(root, "rev-parse", "HEAD:.conclave/reviewers.toml").decode().strip()
        _extension_authorized(root, pin_id, report, predecessor)
        _reconcile_git(root, "merge-base", "--is-ancestor", predecessor["candidate"], candidate)
        version = 2
        extra = {"predecessor_digest": predecessor["digest"], "predecessor_candidate": predecessor["candidate"]}
    attempts = [e for e in found["reconciliations"] if e["binding"].get("version") == version]
    if attempts:
        prefix_size = attempts[0]["binding"]["prefix_bytes"]
        prefix = text.encode()[:prefix_size]
    else:
        prefix = text.encode()
    return {"version": version, **extra, "report": report, "prefix_sha256": hashlib.sha256(prefix).hexdigest(), "prefix_bytes": len(prefix),
            "completion_digest": digest(raw_lines(completion["review"])), "completion_candidate": completion["candidate"],
            "plan_candidate": plan["candidate"], "contract_path": contract_path,
            "contract_sha256": hashlib.sha256(original_contract.encode()).hexdigest(),
            "plan_contract_sha256": hashlib.sha256(contract(plan["candidate"]).encode()).hexdigest(),
            "candidate": candidate, "disposition_path": disposition, "disposition_blob": pin_blob(disposition_bytes),
            "disposition_commit": disposition_commit}


def _reconciliation_binding_shape(binding):
    keys = {"version", "report", "prefix_sha256", "prefix_bytes", "completion_digest", "completion_candidate", "plan_candidate",
            "contract_path", "contract_sha256", "plan_contract_sha256", "candidate", "disposition_path", "disposition_blob", "disposition_commit"}
    if isinstance(binding, dict) and binding.get("version") == 2:
        keys |= {"predecessor_digest", "predecessor_candidate"}
    if isinstance(binding, dict) and binding.get("version") == 3:
        keys |= {"exception_kind", "accepted_contract_sha256", "authorization_path", "authorization_commit", "authorization_blob"}
    _reconcile_require(isinstance(binding, dict) and set(binding) == keys and type(binding.get("version")) is int and binding.get("version") in (1, 2, 3), "malformed binding")
    _reconcile_require(type(binding["prefix_bytes"]) is int and binding["prefix_bytes"] > 0, "binding prefix length must be a positive integer")
    _reconcile_require(all(isinstance(binding[k], str) and bool(binding[k]) for k in keys - {"version", "prefix_bytes"}), "binding fields must be nonempty strings")
    _reconcile_require(all(CANDIDATE.fullmatch(binding[k]) for k in ("candidate", "completion_candidate", "plan_candidate", "disposition_commit")), "invalid bound commit")
    _reconcile_require(all(re.fullmatch(r"[0-9a-f]{64}", binding[k]) for k in ("prefix_sha256", "contract_sha256", "plan_contract_sha256"))
                       and DIGEST.fullmatch(binding["completion_digest"]) and PIN_ID.fullmatch(binding["disposition_blob"]), "invalid bound digest")


def _validate_reconciliation_v1(root, text, entry):
    binding = entry.get("binding")
    _reconciliation_binding_shape(binding)
    size = binding["prefix_bytes"]
    _reconcile_require(type(size) is int and 0 < size <= len(text.encode()), "invalid original prefix size")
    prefix = text.encode()[:size]
    _reconcile_require(hashlib.sha256(prefix).hexdigest() == binding["prefix_sha256"], "original findings prefix changed")
    try:
        found, chosen, entries = _reconcile_chain(prefix.decode("utf-8"), root=root, current_text=text)
    except UnicodeDecodeError:
        raise Refused("reconciliation: prefix is not UTF-8") from None
    _reconcile_require(not found["reconciliations"], "original prefix contains reconciliation")
    all_found = read_findings(text)
    _reconcile_require(all_found is not None and all_found["reconciliations"], "reconciliation record missing")
    first_offset = all_found["reconciliations"][0]["offset"]
    before_heading = "\n".join(raw_lines(text)[:first_offset]).encode()
    _reconcile_require(before_heading.startswith(prefix) and not before_heading[size:].strip(), "prefix does not cover all original findings")
    completion, plan = chosen["completion"], chosen["plan"]
    _reconcile_require(binding["completion_candidate"] == completion["candidate"] and binding["plan_candidate"] == plan["candidate"]
                       and binding["completion_digest"] == digest(raw_lines(completion["review"])), "original review identity mismatch")
    _reconcile_require(entry.get("candidate") == binding["candidate"], "candidate binding mismatch")
    for original in entries:
        _reconcile_identity(root, original)
    _reconcile_identity(root, entry, reconciliation=True)
    _reconcile_git(root, "merge-base", "--is-ancestor", completion["candidate"], binding["candidate"])
    _reconcile_reachable(root, binding["candidate"])
    report = _reconcile_path(root, binding["report"])
    match = re.fullmatch(r"docs/reviews/(\d{2}-[A-Za-z0-9_-]+)/D(\d{2})-T(\d{2})-s([1-9]\d*)\.md", report)
    _reconcile_require(match is not None and match[1].startswith(match[2] + "-"), "noncanonical findings")
    paths = list((Path(root) / "todo" / match[1]).glob(f"TODO-{match[3]}-*.md"))
    _reconcile_require(len(paths) == 1 and paths[0].relative_to(root).as_posix() == binding["contract_path"], "wrong contract path")
    def contract(sha):
        return _reconcile_contract(_reconcile_git(root, "show", f"{sha}:{binding['contract_path']}").decode(), match[4])
    original = contract(completion["candidate"])
    _reconcile_require(original == contract(binding["candidate"]) and hashlib.sha256(original.encode()).hexdigest() == binding["contract_sha256"], "contract changed or narrowed")
    _reconcile_require(hashlib.sha256(contract(plan["candidate"]).encode()).hexdigest() == binding["plan_contract_sha256"], "original plan contract mismatch")
    disposition = _reconcile_path(root, binding["disposition_path"])
    _reconcile_require(disposition != report and CANDIDATE.fullmatch(binding["disposition_commit"]), "invalid disposition identity")
    _reconcile_reachable(root, binding["disposition_commit"])
    contents = _reconcile_git(root, "show", f"{binding['disposition_commit']}:{disposition}")
    _reconcile_require(contents.strip() and pin_blob(contents) == binding["disposition_blob"], "committed disposition mismatch")
    return binding


def _extension_authorized(root, pin_id, report, predecessor):
    _reconcile_require(returned_pass(predecessor, "reconciliation") and verdict_lines(predecessor["review"])[-1] == "RECONCILIATION: gaps", "extension requires a returned gaps predecessor")
    pin = _reconcile_pin(root, pin_id)
    _reconcile_require(pin.get("reconciliation_extensions", {}).get(report) == predecessor["digest"], "no exact scoped predecessor authorization")


def validate_reconciliation_binding(root, text, entry):
    binding = entry.get("binding")
    _reconciliation_binding_shape(binding)
    if binding["version"] == 1:
        return _validate_reconciliation_v1(root, text, entry)
    if binding["version"] == 3:
        return _validate_exception_binding(root, text, entry)
    size = binding["prefix_bytes"]
    _reconcile_require(type(size) is int and 0 < size <= len(text.encode()), "invalid preceding prefix size")
    prefix = text.encode()[:size]
    _reconcile_require(hashlib.sha256(prefix).hexdigest() == binding["prefix_sha256"], "preceding findings prefix changed")
    try:
        previous = read_reconciliations(prefix.decode())
    except UnicodeDecodeError:
        raise Refused("reconciliation: invalid preceding prefix") from None
    _reconcile_require(previous is not None, "unreadable preceding findings")
    returned = [e for e in previous if returned_pass(e, "reconciliation")]
    _reconcile_require(len(returned) == 1 and returned[0]["binding"]["version"] == 1, "extension requires exactly one original returned reconciliation")
    predecessor = returned[0]
    for attempt in previous:
        _reconcile_require(attempt["binding"]["version"] == 1, "preceding prefix includes another extension")
        _validate_reconciliation_v1(root, text, attempt)
    _reconcile_require(binding["predecessor_digest"] == predecessor["digest"] and binding["predecessor_candidate"] == predecessor["candidate"], "predecessor identity mismatch")
    _extension_authorized(root, entry.get("pin"), binding["report"], predecessor)
    _reconcile_git(root, "merge-base", "--is-ancestor", predecessor["candidate"], binding["candidate"])
    attempts = read_reconciliations(text)
    _reconcile_require(attempts is not None, "unreadable current findings")
    extensions = [e for e in attempts if e["binding"].get("version") == 2]
    _reconcile_require(bool(extensions), "extension record missing")
    before = "\n".join(raw_lines(text)[:extensions[0]["offset"]]).encode()
    _reconcile_require(before.startswith(prefix) and not before[size:].strip(), "prefix does not cover every preceding attempt")
    original = predecessor["binding"]
    virtual = {k: v for k, v in binding.items() if k not in ("predecessor_digest", "predecessor_candidate")}
    virtual.update(version=1, prefix_bytes=original["prefix_bytes"], prefix_sha256=original["prefix_sha256"])
    _validate_reconciliation_v1(root, text, {**entry, "binding": virtual})
    return binding


def _reconciliation_history_preserved(root, report, text):
    current = read_findings(text)
    _reconcile_require(current is not None, "unreadable findings history")
    plans = [e for e in current["plans"] if returned_pass(e, "plan")]
    if len(plans) != 1:
        return
    identity = _transition_plan_identity(plans[0])
    retained = {_transition_record_identity(e) for e in current["reconciliations"]}
    for _, old in _transition_history(root, report):
        historical = read_findings(old)
        if historical is None:
            continue
        matching = [e for e in historical["plans"] if returned_pass(e, "plan") and _transition_plan_identity(e) == identity]
        if matching:
            _reconcile_require(all(_transition_record_identity(e) in retained for e in historical["reconciliations"]), "committed reconciliation attempt was removed")


def validate_reconciliation_series(root, text):
    attempts = read_reconciliations(text)
    _reconcile_require(attempts is not None, "unreadable reconciliation series")
    if attempts:
        _reconciliation_history_preserved(root, attempts[0]["binding"]["report"], text)
    returned = []
    exception_binding = None
    exception_returned = False
    for entry in attempts:
        version = entry.get("binding", {}).get("version")
        _reconcile_require(not exception_returned, "exception already returned; no further attempt authorized")
        if version == 3:
            _reconcile_require(exception_binding is None or exception_binding == entry["binding"], "exception retry identity changed")
            exception_binding = entry["binding"]
            expected = 0 if exception_binding.get("exception_kind") == "contract-amendment" else 2
            _reconcile_require(len(returned) == expected, "exception returned predecessor count mismatch")
        else:
            _reconcile_require(exception_binding is None and len(returned) < 2 and version == (2 if returned else 1), "reconciliation attempt exceeds authorized series")
        validate_reconciliation_binding(root, text, entry)
        if returned_pass(entry, "reconciliation"):
            returned.append(entry)
            exception_returned = version == 3
    return returned


def _completion_location(root, report):
    report = _reconcile_path(root, report)
    match = re.fullmatch(r"docs/reviews/(\d{2}-[A-Za-z0-9_-]+)/D(\d{2})-T(\d{2})-s([1-9]\d*)\.md", report)
    _reconcile_require(match is not None and match[1].startswith(match[2] + "-"), "noncanonical completion findings")
    paths = list((Path(root) / "todo" / match[1]).glob(f"TODO-{match[3]}-*.md"))
    _reconcile_require(len(paths) == 1, "cannot identify completion TODO file")
    return report, paths[0].relative_to(root).as_posix(), match[4]


def _completion_plan(prefix):
    found = read_findings(prefix)
    _reconcile_require(found is not None and not any(found[k] for k in ("rounds", "completions", "finals", "reconciliations")), "plan prefix includes an implementation-review attempt")
    plans = [e for e in found["plans"] if returned_pass(e, "plan")]
    _reconcile_require(len(plans) == 1 and found["plans"][-1] is plans[0], "combined completion needs one resolved plan")
    return plans[0], found["plans"]


def _completion_transition(plan, prefix):
    return {"version": 1, "from_policy": "codex-self-review", "to_policy": "codex-two-pass-v1",
            "plan_candidate": plan["candidate"], "plan_pin": plan["pin"], "plan_digest": digest(raw_lines(plan["review"])),
            "prefix_bytes": len(prefix), "prefix_sha256": hashlib.sha256(prefix).hexdigest()}


_COMPLETION_HISTORY = {}


def _transition_record_identity(entry):
    """Identify a sealed attempt independently of its position and subsequent writer notes."""
    return json.dumps({key: value for key, value in entry.items() if key not in ("offset", "notes")},
                      sort_keys=True, separators=(",", ":"))


def _transition_plan_identity(entry):
    return (entry.get("writer"), entry.get("policy"), entry.get("candidate"), entry.get("pin"),
            entry.get("run"), entry.get("reviewer"), entry.get("model"), entry.get("cli"),
            digest(raw_lines(entry.get("review") or "")))


def _transition_history(root, report):
    tips = _reconcile_git(root, "rev-parse", *_reconcile_tips(root)).decode().split()
    key = (str(Path(root).resolve()), tuple(tips), report)
    if key not in _COMPLETION_HISTORY:
        commits = _reconcile_git(root, "log", "--format=%H", "--full-history", "-m", *tips, "--", report).decode().split()
        versions, seen = [], set()
        for commit in dict.fromkeys(commits):
            listed = _reconcile_git(root, "ls-tree", commit, "--", report).decode().strip()
            if not listed:
                continue  # A deletion has no findings bytes; the prior versions are still examined.
            header = listed.split("\t", 1)[0].split()
            _reconcile_require(len(header) == 3 and header[1] == "blob", "historical findings are not a blob")
            blob = header[2]
            if blob in seen:
                continue
            seen.add(blob)
            raw = _reconcile_git(root, "cat-file", "blob", blob)
            try:
                versions.append((commit, raw.decode("utf-8")))
            except UnicodeDecodeError:
                raise Refused("cannot verify non-UTF-8 findings history: " + commit) from None
        _COMPLETION_HISTORY[key] = versions
    return _COMPLETION_HISTORY[key]


def validate_plan_transition_history(root, report, plan, prefix, current_text):
    """A restored file cannot erase an implementation-review attempt from the same original plan chain."""
    report = _reconcile_path(root, report)
    expected_plan = _transition_plan_identity(plan)
    expected_transition = _completion_transition(plan, prefix)
    current = read_findings(current_text)
    _reconcile_require(current is not None, "cannot verify transition against unreadable findings")
    retained = {key: {_transition_record_identity(entry) for entry in current[key]}
                for key in ("completions", "reconciliations")}
    for commit, historical_text in _transition_history(root, report):
        historical, bad_heading = _read_findings(historical_text)
        if historical is None:
            # Preserve fail-closed behavior when a same-chain version is truncated or malformed after its plan.
            prior = read_findings("\n".join(raw_lines(historical_text)[:bad_heading])) if bad_heading is not None else None
            same_plan = prior is not None and any(_transition_plan_identity(e) == expected_plan for e in prior["plans"])
            _reconcile_require(not same_plan, "same-chain findings history is unreadable at " + commit)
            continue
        if not any(_transition_plan_identity(entry) == expected_plan for entry in historical["plans"]):
            continue
        _reconcile_require(not historical["rounds"] and not historical["finals"],
                           "legacy plan has a committed implementation-review attempt at " + commit)
        for entry in historical["completions"]:
            _reconcile_require(entry.get("policy") == "codex-two-pass-v1" and isinstance(entry.get("binding"), dict)
                               and entry["binding"].get("transition") == expected_transition,
                               "legacy plan has a committed completion attempt at " + commit)
            _reconcile_require(_transition_record_identity(entry) in retained["completions"],
                               "a committed combined completion attempt was removed at " + commit)
        for entry in historical["reconciliations"]:
            _reconcile_require(bool(historical["completions"]) and _transition_record_identity(entry) in retained["reconciliations"],
                               "a committed reconciliation attempt was removed at " + commit)


def make_completion_binding(root, record_path, candidate, transition_plan=False):
    root = Path(root).resolve()
    report, contract_path, number = _completion_location(root, record_path)
    text = (root / report).read_bytes().decode("utf-8")
    found = read_findings(text)
    _reconcile_require(found is not None and not any(found[k] for k in ("rounds", "finals", "reconciliations")), "combined completion cannot follow other implementation reviews")
    if found["completions"]:
        _reconcile_require(all(e.get("policy") == "codex-two-pass-v1" for e in found["completions"]), "cannot transition after a legacy completion attempt")
        first = found["completions"][0].get("binding")
        _completion_binding_shape(first)
        prefix = text.encode()[:first["prefix_bytes"]]
        _reconcile_require(hashlib.sha256(prefix).hexdigest() == first["prefix_sha256"], "original plan prefix changed")
    else:
        prefix = text.encode()
    plan, attempts = _completion_plan(prefix.decode())
    pin = load_pin(Path(root) / ".conclave/reviewers.toml")
    pin_id = pin_blob((root / ".conclave/reviewers.toml").read_bytes())
    _reconcile_pin(root, pin_id)
    _reconcile_require(review_policy(pin, "codex") == "codex-two-pass-v1", "combined completion needs explicit two-pass policy")
    for attempt in attempts:
        _reconcile_identity(root, attempt)
    old = plan.get("policy") == "codex-self-review"
    _reconcile_require(plan.get("policy") in SELF_REVIEW_POLICIES, "unsupported plan policy")
    if old:
        _reconcile_require(transition_plan and pin.get("plan_transition") == ["codex-self-review"], "legacy plan transition must be explicit and authorized")
        validate_plan_transition_history(root, report, plan, prefix, text)
    else:
        _reconcile_require(not transition_plan and plan["pin"] == pin_id, "new-policy plan and completion must share one pin")
    _reconcile_require(len({e.get("pin") for e in attempts}) == 1 and len({e.get("policy") for e in attempts}) == 1, "plan attempts changed policy or pin")
    _reconcile_reachable(root, candidate)
    _reconcile_git(root, "merge-base", "--is-ancestor", plan["candidate"], candidate)
    original_contract = _reconcile_contract(_reconcile_git(root, "show", f"{plan['candidate']}:{contract_path}").decode(), number)
    for attempt in found["completions"]:
        validate_completion_binding(root, text, attempt)
        _reconcile_require(attempt["pin"] == pin_id, "completion retry cannot switch pins")
    return {"version": 1, "report": report, "prefix_bytes": len(prefix), "prefix_sha256": hashlib.sha256(prefix).hexdigest(),
            "plan_candidate": plan["candidate"], "plan_pin": plan["pin"], "plan_digest": digest(raw_lines(plan["review"])),
            "plan_contract_sha256": hashlib.sha256(original_contract.encode()).hexdigest(), "contract_path": contract_path,
            "candidate": candidate, "transition": _completion_transition(plan, prefix) if old else None}


def _completion_binding_shape(binding):
    keys = {"version", "report", "prefix_bytes", "prefix_sha256", "plan_candidate", "plan_pin", "plan_digest", "plan_contract_sha256", "contract_path", "candidate", "transition"}
    _reconcile_require(isinstance(binding, dict) and set(binding) == keys and type(binding.get("version")) is int and binding["version"] == 1, "malformed completion binding")
    _reconcile_require(all(isinstance(binding[k], str) and binding[k] for k in keys - {"version", "prefix_bytes", "transition"}), "malformed completion binding fields")
    _reconcile_require(type(binding["prefix_bytes"]) is int and binding["prefix_bytes"] > 0, "invalid plan prefix size")
    _reconcile_require(all(CANDIDATE.fullmatch(binding[k]) for k in ("plan_candidate", "candidate")) and PIN_ID.fullmatch(binding["plan_pin"])
                       and DIGEST.fullmatch(binding["plan_digest"]) and all(re.fullmatch(r"[0-9a-f]{64}", binding[k]) for k in ("prefix_sha256", "plan_contract_sha256")), "invalid completion binding digest")
    transition = binding["transition"]
    transition_keys = {"version", "from_policy", "to_policy", "plan_candidate", "plan_pin", "plan_digest", "prefix_bytes", "prefix_sha256"}
    _reconcile_require(transition is None or isinstance(transition, dict) and set(transition) == transition_keys
                       and type(transition.get("version")) is int and transition["version"] == 1
                       and type(transition.get("prefix_bytes")) is int and transition["prefix_bytes"] > 0
                       and all(isinstance(transition[k], str) and transition[k] for k in transition_keys - {"version", "prefix_bytes"}), "invalid transition binding")


def validate_completion_binding(root, text, entry):
    binding = entry.get("binding")
    _completion_binding_shape(binding)
    _reconcile_require(entry.get("policy") == "codex-two-pass-v1" and entry.get("candidate") == binding["candidate"], "completion candidate or policy mismatch")
    pin = _reconcile_identity(root, entry)
    raw = text.encode()
    size = binding["prefix_bytes"]
    _reconcile_require(size <= len(raw) and hashlib.sha256(raw[:size]).hexdigest() == binding["prefix_sha256"], "original plan prefix changed")
    try:
        plan, attempts = _completion_plan(raw[:size].decode())
    except UnicodeDecodeError:
        raise Refused("completion plan prefix is not UTF-8") from None
    found = read_findings(text)
    _reconcile_require(found is not None and found["completions"], "combined completion missing")
    before = "\n".join(raw_lines(text)[:found["completions"][0]["offset"]]).encode()
    _reconcile_require(before.startswith(raw[:size]) and not before[size:].strip(), "prefix omits original findings")
    for attempt in attempts:
        _reconcile_identity(root, attempt)
    _reconcile_require(len({e.get("pin") for e in attempts}) == 1 and len({e.get("policy") for e in attempts}) == 1, "plan attempts changed policy or pin")
    _reconcile_require(plan["candidate"] == binding["plan_candidate"] and plan["pin"] == binding["plan_pin"]
                       and digest(raw_lines(plan["review"])) == binding["plan_digest"], "plan identity changed")
    if plan["policy"] == "codex-self-review":
        _reconcile_require(pin.get("plan_transition") == ["codex-self-review"] and binding["transition"] == _completion_transition(plan, raw[:size]), "missing or tampered explicit plan transition")
        validate_plan_transition_history(root, binding["report"], plan, raw[:size], text)
    else:
        _reconcile_require(plan["policy"] == "codex-two-pass-v1" and plan["pin"] == entry["pin"] and binding["transition"] is None, "two-pass pin mismatch")
    _, contract_path, number = _completion_location(root, binding["report"])
    _reconcile_require(contract_path == binding["contract_path"], "wrong plan contract path")
    original = _reconcile_contract(_reconcile_git(root, "show", f"{plan['candidate']}:{contract_path}").decode(), number)
    _reconcile_require(hashlib.sha256(original.encode()).hexdigest() == binding["plan_contract_sha256"], "original plan contract changed")
    _reconcile_git(root, "merge-base", "--is-ancestor", plan["candidate"], binding["candidate"])
    _reconcile_reachable(root, binding["candidate"])
    return binding


def validate_codex_chain(root, text):
    found = read_findings(text)
    _reconcile_require(found is not None, "unreadable Codex chain")
    completions = [e for e in found["completions"] if returned_pass(e, "completion")]
    _reconcile_require(len(completions) == 1 and found["completions"][-1] is completions[0], "needs one resolved completion")
    completion = completions[0]
    if completion.get("policy") == "codex-self-review":
        _, chosen, entries = _reconcile_chain(text, require_gaps=False)
        for entry in entries:
            _reconcile_identity(root, entry)
        return {"policy": "codex-self-review", "plan": chosen["plan"], "round": chosen["round"], "completion": completion, "transition": None}
    _reconcile_require(completion.get("policy") == "codex-two-pass-v1" and not found["rounds"] and not found["finals"], "invalid two-pass sequence")
    plans = [e for e in found["plans"] if returned_pass(e, "plan")]
    _reconcile_require(len(plans) == 1 and found["plans"][-1] is plans[0], "needs one resolved plan")
    for entry in found["completions"]:
        validate_completion_binding(root, text, entry)
    _reconcile_require(len({e["pin"] for e in found["completions"]}) == 1, "completion attempts changed pin")
    transitions = [e["binding"]["transition"] for e in found["completions"]]
    _reconcile_require(all(t == transitions[0] for t in transitions), "completion attempts changed transition")
    entries = [*found["plans"], *found["completions"]]
    try:
        times = [datetime.fromisoformat(e["run"].replace("Z", "+00:00")) for e in entries]
        _reconcile_require(all(t.tzinfo is not None for t in times) and times == sorted(times), "two-pass chronology is invalid")
    except (ValueError, TypeError):
        raise Refused("two-pass chronology is invalid") from None
    offsets = [e["offset"] for e in entries]
    _reconcile_require(offsets == sorted(offsets), "two-pass order is invalid")
    return {"policy": "codex-two-pass-v1", "plan": plans[0], "round": None, "completion": completion, "transition": transitions[0]}


def combined_surface(root, report, candidate):
    _, contract_path, number = _completion_location(root, report)
    contract = _reconcile_contract(_reconcile_git(root, "show", f"{candidate}:{contract_path}").decode(), number)
    declarations = re.findall(r"^\*\*Surface:\*\* (yes|no)\s*$", contract, re.M)
    _reconcile_require(len(declarations) == 1, "candidate section needs one explicit Surface declaration")
    return declarations[0] == "yes"


def reconciliation_pending_path(root, report, kind="reconciliation"):
    _reconcile_require(kind in ("reconciliation", "completion"), "invalid durable pass kind")
    return Path(root) / ("build/review-" + kind) / (hashlib.sha256(report.encode()).hexdigest() + ".json")


def _durable_json(path, data, exclusive=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, sort_keys=True, indent=2) + "\n"
    if exclusive:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    else:
        fd, temporary = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    if os.name != "nt":
        # The section lock can create these directories before publication. Persist every
        # directory link, not only directories this call happened to create, before returning.
        parent = path.parent.absolute()
        for directory in (parent, *parent.parents):
            fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)


def reconciliation_pending(root, report, kind="reconciliation"):
    path = reconciliation_pending_path(root, report, kind)
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_bytes().decode("utf-8"))
        if not isinstance(state, dict) or state.get("phase") not in ("calling", "returned", "recorded") or state.get("report") != report:
            raise ValueError("invalid pending state")
        return state
    except (OSError, ValueError, UnicodeDecodeError):
        return {"report": report, "phase": "blocked", "error": "unreadable reconciliation state; no reviewer may run"}


def _result_hash(result):
    return hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _recover_reconciliation(root, record_path, kind="reconciliation"):
    root = Path(root).resolve()
    report = _reconcile_path(root, record_path)
    state = reconciliation_pending(root, report, kind)
    _reconcile_require(state is not None and state.get("phase") in ("returned", "recorded"),
                       "no durable returned response; unresolved call remains blocked, do not invoke another reviewer")
    _reconcile_require(type(state.get("version")) is int and state["version"] == 1, "invalid pending state version")
    (_reconciliation_binding_shape if kind == "reconciliation" else _completion_binding_shape)(state.get("binding"))
    _reconcile_require(state["binding"]["report"] == report, "pending report binding mismatch")
    _reconcile_require(isinstance(state.get("findings_sha256"), str)
                       and re.fullmatch(r"[0-9a-f]{64}", state["findings_sha256"]), "invalid pending findings digest")
    _reconcile_require(isinstance(state.get("run"), str), "invalid pending response timestamp")
    try:
        at = datetime.fromisoformat(state["run"].replace("Z", "+00:00"))
        _reconcile_require(at.tzinfo is not None, "pending timestamp has no timezone")
    except ValueError:
        raise Refused("reconciliation: invalid pending response timestamp") from None
    result = state.get("result")
    _reconcile_require(isinstance(result, dict) and _result_hash(result) == state.get("result_sha256"), "pending response digest mismatch")
    _reconcile_require(result.get("kind") == kind and result.get("writer") == "codex"
                       and result.get("policy") in SELF_REVIEW_POLICIES, "invalid pending response policy")
    _reconcile_require(isinstance(result.get("candidate"), str) and CANDIDATE.fullmatch(result["candidate"]), "invalid pending response candidate")
    _reconcile_require(result.get("review") is None or isinstance(result["review"], str), "invalid pending review text")
    _reconcile_require(result.get("reviewer") is None or isinstance(result["reviewer"], str) and NAME.fullmatch(result["reviewer"]), "invalid pending reviewer")
    _reconcile_require(isinstance(result.get("failover"), list) and all(isinstance(f, dict)
                       and set(f) == {"reviewer", "reason"} and all(isinstance(f[k], str) and "\n" not in f[k] for k in f)
                       for f in result["failover"]), "invalid pending failure metadata")
    _reconcile_require(isinstance(result.get("lenses"), list) and all(isinstance(lens, str) and lens in LENSES for lens in result["lenses"])
                       and len(result["lenses"]) == len(set(result["lenses"])), "invalid pending lenses")
    _reconcile_require(result.get("effort") is None or isinstance(result["effort"], str) and result["effort"] in EFFORTS["codex"], "invalid pending effort")
    _reconcile_identity(root, result, reconciliation=kind == "reconciliation")
    _reconcile_require(not result.get("reviewer") or returned_pass(result, kind), "pending response has no terminal verdict")
    _reconcile_require(result.get("binding") == state.get("binding") and result.get("candidate") == state["binding"]["candidate"], "pending response binding mismatch")
    path = root / report
    text = path.read_bytes().decode("utf-8")
    reader = read_reconciliations if kind == "reconciliation" else read_completions
    found = reader(text)
    _reconcile_require(found is not None, "unreadable findings during recovery")
    rendered = repository_relative(result.get("review") or f"No reviewer returned a {kind} review. This pass is not an approval.", path)
    expected_digest = digest(raw_lines(rendered))
    matches = [entry for entry in found if entry.get("binding") == state["binding"]
               and entry.get("run") == state["run"] and entry.get("digest") == expected_digest]
    if not matches:
        _reconcile_require(hashlib.sha256(text.encode()).hexdigest() == state["findings_sha256"], "findings changed while reconciliation was pending")
        record_completion(path, result, state["run"], result["candidate"], kind)
        text = path.read_bytes().decode("utf-8")
        matches = reader(text)[-1:]
    _reconcile_require(len(matches) == 1, "recovered response is ambiguous")
    (validate_reconciliation_binding if kind == "reconciliation" else validate_completion_binding)(root, text, matches[0])
    if kind == "reconciliation":
        validate_reconciliation_series(root, text)
    state["phase"] = "recorded"
    _durable_json(reconciliation_pending_path(root, report, kind), state)
    return {**result, "run": state["run"], "recorded": True, "recovered": True}


def _run_reconciliation(args, pin, pin_id, kind="reconciliation"):
    _reconcile_require(reconciliation_enabled(pin, args.writer) if kind == "reconciliation" else review_policy(pin, args.writer) == "codex-two-pass-v1", "current pin does not authorize this bounded pass")
    _reconcile_require(args.record and args.candidate and (kind != "reconciliation" or args.disposition), "needs --record, --candidate and --disposition")
    report = _reconcile_path(ROOT, args.record)
    pending = reconciliation_pending(ROOT, report, kind)
    if pending and pending.get("phase") != "recorded":
        raise Refused(f"{kind}: existing pending call; use --recover-{kind}, never call the reviewer again")
    if pending:
        prior = pending.get("result")
        _reconcile_require(isinstance(prior, dict) and _result_hash(prior) == pending.get("result_sha256"), "recorded response journal is malformed")
        if returned_pass(prior, kind):
            _reconcile_require(kind == "reconciliation", "a returned response already exists in the durable journal")
            current = (ROOT / report).read_bytes().decode()
            series = validate_reconciliation_series(ROOT, current)
            _reconcile_require(series and series[-1]["digest"] == digest(raw_lines(repository_relative(prior["review"], ROOT / report))) and series[-1]["binding"] == prior.get("binding"), "returned journal does not match retained predecessor")
            if report in pin.get("reconciliation_exceptions", {}):
                _reconcile_require(series[-1]["binding"]["version"] != 3, "exception already returned")
                _exception_authorization(ROOT, pin_id, report)
            else:
                _reconcile_require(len(series) == 1, "no further reconciliation authorized")
                _extension_authorized(ROOT, pin_id, report, series[0])
    if kind == "reconciliation":
        original = (ROOT / report).read_bytes().decode()
        chain = validate_codex_chain(ROOT, original)
        _reconcile_require(verdict_lines(chain["completion"]["review"])[-1] == "COMPLETION: gaps", "reconciliation needs a failed completion")
        binding = make_reconciliation_binding(ROOT, args.record, args.candidate, args.disposition)
        if binding["version"] == 2:
            _extension_authorized(ROOT, pin_id, report, validate_reconciliation_series(ROOT, original)[0])
        if binding["version"] == 3:
            _exception_authorization(ROOT, pin_id, report, {"path":binding["authorization_path"], "commit":binding["authorization_commit"], "blob":binding["authorization_blob"]})
        surface = args.surface
    else:
        check_self_review_order("completion", args.record, pin)
        binding = make_completion_binding(ROOT, args.record, args.candidate, transition_plan=getattr(args, "transition_plan", False))
        surface = combined_surface(ROOT, args.record, args.candidate)
    _reconcile_pin(ROOT, pin_id)
    plan = scheduled(pin["schedule"], kind, [], surface, policy=review_policy(pin, args.writer) or "legacy")
    prompt = Path(args.prompt).read_text(encoding="utf-8")
    _reconcile_require(bool(prompt.strip()) and "\0" not in prompt, "invalid prompt")
    instructions = ("Read original plan and failed completion, committed disposition and full repair diff; reject narrowed obligations, safety exceptions, unresolved gaps and regressions."
                    if kind == "reconciliation" else
                    "This is the combined final review after implementation and tests. Verify every agreed requirement, every Done when, the original plan and its dispositions, all frozen safety obligations, correct implementation, quality and completion. Inspect the full candidate and integration callers, adversarial failure paths, consistency, regressions and actual test evidence. Optional new scope is separate; missing proof or real defects block completion. Read governing AGENTS.md, manifesto and applicable design/SPEC. Do not invent approval or treat failed tests as passing.")
    if binding.get("version") == 3:
        prompt += "\n\nRead-only exact exception evidence:\n" + _exception_prompt_evidence(ROOT, binding)
        instructions += " This exact exception authorizes one evidence-bound verification only. Read its committed authorization document, every original obligation and all preceding failed findings. Verify the complete approved contract, not only recent examples. No weakened safety, population, target, coverage or recovery requirement is authorized. Returned gaps remain blocked; this is not another ordinary review round."
    verdict = kind.upper()
    prompt += ("\n\nBinding verified by dispatcher:\n" + json.dumps(binding, sort_keys=True) + "\n" + instructions +
               f"\nEnd with {verdict}: complete or {verdict}: gaps. Unreadable evidence is {verdict}: blocked.\n")
    state_path = reconciliation_pending_path(ROOT, report, kind)
    if pending:
        # A recorded outage may retry. Archive it before reserving this distinct attempt.
        archive = state_path.with_name(state_path.stem + "." + hashlib.sha256(json.dumps(pending, sort_keys=True).encode()).hexdigest()[:16] + ".archive")
        _durable_json(archive, pending)
    state = {"version": 1, "phase": "calling", "report": report, "binding": binding,
             "findings_sha256": hashlib.sha256((ROOT / report).read_bytes()).hexdigest(), "pid": os.getpid()}
    _durable_json(state_path, state, exclusive=not bool(pending))
    # The marker remains unresolved on any interruption or uncertain persistence failure.
    with tempfile.TemporaryDirectory() as temporary:
        prompt_path = Path(temporary) / (kind + ".md")
        prompt_path.write_text(prompt, encoding="utf-8")
        result = review(pin, args.writer, prompt_path, args.timeout, plan)
    when = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    result.update(kind=kind, candidate=args.candidate, binding=binding, pin=pin_id, policy=review_policy(pin, args.writer))
    raw_result = dict(result)
    if result.get("reviewer") and not returned_pass(result, kind):
        result = {**result, "reviewer": None, "review": None,
                  "failover": [{"reviewer": result["reviewer"], "reason": f"returned no terminal {kind} verdict"}]}
    state.update(phase="returned", run=when, result=result, result_sha256=_result_hash(result), raw_result=raw_result)
    try:
        _durable_json(state_path, state)
    except OSError as exc:
        print(json.dumps({**result, "run": when, "recorded": False, "persistence_error": str(exc)}))
        raise Refused("reconciliation response persistence failed; retained unresolved call marker") from exc
    try:
        return _recover_reconciliation(ROOT, args.record, kind)
    except (OSError, Refused, Unrecorded) as exc:
        print(json.dumps({**result, "run": when, "recorded": False}))
        raise Refused("returned reconciliation is unrecorded; recover the durable response without another call: " + str(exc)) from exc


class reconciliation_lock:
    """Serialize reservation and recovery without deleting another process's lock inode."""
    def __init__(self, root, report):
        # Both pass kinds share one section lock; their durable journals remain separate.
        self.path = reconciliation_pending_path(root, report).with_suffix(".lock")
        self.handle = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                self.handle.write(b"0")
                self.handle.flush()
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.handle.close()
            raise Refused("reconciliation: another dispatch or recovery owns this section") from exc
        return self

    def __exit__(self, *exc):
        self.handle.close()


def recover_reconciliation(root, record_path, kind="reconciliation"):
    report = _reconcile_path(root, record_path)
    with reconciliation_lock(root, report):
        return _recover_reconciliation(root, record_path, kind)


def run_reconciliation(args, pin, pin_id, kind="reconciliation"):
    _reconcile_require(bool(args.record), "needs --record")
    report = _reconcile_path(ROOT, args.record)
    with reconciliation_lock(ROOT, report):
        return _run_reconciliation(args, pin, pin_id, kind)


def run_completion(args, pin, pin_id):
    return run_reconciliation(args, pin, pin_id, kind="completion")


def recover_completion(root, record_path):
    return recover_reconciliation(root, record_path, kind="completion")


def list_rounds(records_dir):
    """Every findings file under records_dir that holds rounds, with each round as `record` wrote it. A file
    whose round headings or lines are not `record`'s is named in `unreadable`, never dropped."""
    records_dir = Path(records_dir)
    records, unreadable = [], []

    def shown(path):
        # Never resolve: a path being reported as unreadable may be a symlink loop, which resolve() raises on.
        path = Path(os.path.abspath(path))
        return path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix()

    try:
        paths = sorted(records_dir.rglob("*.md")) if records_dir.is_dir() else []
    except OSError:  # a folder that cannot be walked is reported, like a file that cannot be read
        return {"records": [], "unreadable": [shown(records_dir)]}
    for path in paths:
        # One file that cannot be read, or is not UTF-8, is named in `unreadable`; the others are still listed.
        try:
            found = read_findings(path.read_bytes().decode("utf-8"))
        # RuntimeError: a symlink loop on older Pythons. ValueError: anything read_findings meets that int() or the
        # digest cannot take, so one bad file never aborts the listing.
        except (OSError, UnicodeDecodeError, RuntimeError, ValueError):
            found = None
        if found is None:
            unreadable.append(shown(path))
        elif any(found.values()):
            records.append({"path": shown(path), "rounds": found["rounds"],
                            **({"completions": found["completions"]} if found["completions"] else {}),
                            **({"plans": found["plans"]} if found["plans"] else {}),
                            **({"finals": found["finals"]} if found["finals"] else {}),
                            **({"reconciliations": [{**e, "verdict": (verdict_lines(e["review"]) or ["unreturned"])[-1]} for e in found["reconciliations"]]} if found["reconciliations"] else {})})
            pending = reconciliation_pending(ROOT, shown(path))
            if pending:
                records[-1]["reconciliation_status"] = {"phase": pending["phase"], "binding": pending.get("binding"), "error": pending.get("error")}
            pending = reconciliation_pending(ROOT, shown(path), "completion")
            if pending:
                records[-1]["completion_status"] = {"phase": pending["phase"], "binding": pending.get("binding"), "error": pending.get("error")}
    return {"records": records, **({"unreadable": unreadable} if unreadable else {})}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--writer", choices=WRITERS, help="The agent whose work is under review")
    parser.add_argument("--prompt", help="File holding the review prompt")
    parser.add_argument("--record", help="Findings file to append this round (or completion review) to")
    parser.add_argument("--kind", choices=("round", "completion", "plan", "final", "reconciliation"), default="round",
                        help="round (default): one review round; completion: the one-pass completion and excellence "
                             "review, recorded as a ## Completion review section and not counted as a round; plan: "
                             "the one-pass plan review before the build, recorded as a ## Plan review section; final: "
                             "the one-pass final review by [schedule.final]'s reviewer after the rounds have stopped")
    parser.add_argument("--disposition", help="Committed disposition Markdown for a bounded reconciliation")
    parser.add_argument("--transition-plan", action="store_true", help="Explicitly bind a legacy plan-only chain to the two-pass policy")
    parser.add_argument("--recover-completion", action="store_true", help="Replay a durable combined completion response without another reviewer")
    parser.add_argument("--recover-reconciliation", action="store_true", help="Replay a durable returned response without invoking a reviewer")
    parser.add_argument("--candidate", help="With --kind completion, plan or final: the full 40-character commit under "
                                            "review (for a plan review, the commit holding the section as reviewed)")
    parser.add_argument("--surface", action="store_true",
                        help="The section has Surface: yes, so the schedule's rotation includes the design lens")
    parser.add_argument("--timeout", type=int, default=1800,
                        help="Seconds before the reviewer is stopped and the round records no review")
    parser.add_argument("--pin", default=str(PIN), help=argparse.SUPPRESS)
    parser.add_argument("--check-pin", action="store_true",
                        help="Report whether the pin loads, and each CLI's presence, instead of running a review; "
                             "no reviewer runs (exit 0 loads, 2 refused)")
    parser.add_argument("--list-rounds", action="store_true",
                        help="List the recorded review rounds instead of running one; no reviewer runs")
    parser.add_argument("--json", action="store_true", help="With --list-rounds, print the listing as JSON")
    parser.add_argument("--records", default=str(ROOT / "docs" / "reviews"),
                        help="With --list-rounds, the folder of findings files (default docs/reviews)")
    args = parser.parse_args(argv)
    if args.check_pin:
        # load_pin stays the only place the rules live: this reports its verdict and runs nothing.
        try:
            pin = load_pin(args.pin)
        except Refused as exc:
            print(json.dumps({"ok": False, "error": str(exc)}) if args.json else f"refused: {exc}")
            return 2
        clis = {cli: find_cli(cli) is not None for cli in CLIS}
        report = {"ok": True, "schema_version": pin["schema_version"], "reviewers": pin["reviewers"],
                  "routes": pin["routes"], "self_review": pin.get("self_review", []), "self_review_policy": review_policy(pin, "codex"),
                  **({"schedule": pin["schedule"]} if "schedule" in pin else {}), "clis": clis}
        print(json.dumps(report) if args.json else "ok")
        return 0
    if args.list_rounds:
        listing = list_rounds(args.records)
        if args.json:
            print(json.dumps(listing, indent=2))
        else:
            for entry in listing["records"]:
                for p in entry.get("plans", []):
                    who = f"{p['reviewer']} ({p['model']} via {p['cli']})" if p["reviewer"] else "no review"
                    print(f"{entry['path']}  Plan review: {who}, candidate {p['candidate']}, {p['run']}")
                for c in entry.get("completions", []):
                    who = f"{c['reviewer']} ({c['model']} via {c['cli']})" if c["reviewer"] else "no review"
                    print(f"{entry['path']}  Completion review: {who}, candidate {c['candidate']}, {c['run']}")
                for r in entry["rounds"]:
                    who = f"{r['reviewer']} ({r['model']} via {r['cli']})" if r["reviewer"] else "no review"
                    print(f"{entry['path']}  Round {r['number']}: {who}, writer {r['writer']}, {r['run']}")
                for f in entry.get("finals", []):
                    who = f"{f['reviewer']} ({f['model']} via {f['cli']})" if f["reviewer"] else "no review"
                    print(f"{entry['path']}  Final review: {who}, candidate {f['candidate']}, {f['run']}")
                if entry.get("completion_status"):
                    print(f"{entry['path']}  Combined completion state: {json.dumps(entry['completion_status'], sort_keys=True)}")
                for r in entry.get("reconciliations", []):
                    print(f"{entry['path']}  Reconciliation: candidate {r['candidate']}, {r['verdict']}, original {r['binding'].get('completion_candidate')}, digest {r['binding'].get('completion_digest')}")
                if entry.get("reconciliation_status"):
                    status = entry["reconciliation_status"]
                    print(f"{entry['path']}  Reconciliation state: {status['phase']}; binding {json.dumps(status.get('binding'), sort_keys=True)}")
            for path in listing.get("unreadable", []):
                print(f"{path}  unreadable: a round heading or line is not in the record format")
        return 0
    if args.recover_reconciliation and args.recover_completion:
        parser.error("choose one recovery kind")
    if args.transition_plan and args.kind != "completion":
        parser.error("--transition-plan requires --kind completion")
    if args.recover_reconciliation or args.recover_completion:
        try:
            _reconcile_require(bool(args.record), "recovery needs --record")
            result = recover_reconciliation(ROOT, args.record, "completion" if args.recover_completion else "reconciliation")
            print(json.dumps(result, indent=2))
            return 0 if result.get("reviewer") else 1
        except (Refused, Unrecorded, OSError, ValueError) as exc:
            print("review-dispatch refused: " + str(exc), file=sys.stderr)
            return 2
    if args.disposition and args.kind != "reconciliation":
        parser.error("--disposition is only for --kind reconciliation")
    if not args.writer or not args.prompt:
        parser.error("--writer and --prompt are required unless --check-pin or --list-rounds is given")
    one_pass = args.kind in PASSES
    if one_pass and not (args.candidate and CANDIDATE.fullmatch(args.candidate)):
        parser.error(f"--kind {args.kind} needs --candidate, the full 40-character commit under review")
    if args.kind == "round" and args.candidate:
        parser.error("--candidate goes with --kind completion or plan; a round names its candidate in its prompt")
    if args.kind == "plan":
        refusal = plan_candidate_refusal(args.record, args.candidate)
        if refusal:
            parser.exit(2, f"review-dispatch refused: the plan candidate: {refusal}\n")
    try:
        # The pin's bytes are read once: the same bytes are loaded and named by their blob id, so the record names
        # exactly the pin this pass ran under (D00 T01 §18).
        try:
            with open(args.pin, "rb") as handle:
                pin_bytes = handle.read()
        except OSError:
            pin_bytes = None  # load_pin reports a missing or unreadable pin in its own words
        pin = load_pin(args.pin, data=pin_bytes) if pin_bytes is not None else load_pin(args.pin)
        pin_id = pin_blob(pin_bytes)
        if args.kind == "reconciliation" or args.kind == "completion" and review_policy(pin, args.writer) == "codex-two-pass-v1":
            result = run_reconciliation(args, pin, pin_id, args.kind)
            print(json.dumps(result, indent=2))
            return 0 if result.get("reviewer") else 1
        if self_review_enabled(pin, args.writer):
            if review_policy(pin, args.writer) == "codex-two-pass-v1":
                _reconcile_pin(ROOT, pin_id)
            check_self_review_order(args.kind, args.record, pin)
        plan = None
        if "schedule" in pin:
            rounds = []
            if args.record and args.kind == "round":
                # The position in the schedule comes from the rounds already recorded; a file that cannot be read
                # back is refused here, before a review is spent that could not be recorded.
                existing = existing_findings(Path(args.record), "round")
                rounds = read_rounds(existing)
                if rounds is None:
                    raise Unrecorded(f"{args.record} cannot be read back (a round heading or line is not in the "
                                     f"format --record writes{unreadable_heading(existing)}; {RESERVED_NAMES}), so "
                                     f"no round was run")
                after = rounds_after_final(existing)
                if after is not None and after >= POST_FINAL_CAP:
                    raise Refused(f"{args.record} already holds {after} rounds after its final review, the "
                                  f"{POST_FINAL_CAP} that may prove its fix; the stamp would refuse another, so none "
                                  f"was run. Work added after the final review is its own section")
            plan = scheduled(pin["schedule"], args.kind, rounds, args.surface,
                             section_risk(args.record) if args.record else "full", policy=review_policy(pin, args.writer) or "legacy") \
                if args.kind != "final" or "final" in pin["schedule"] else None
        reviewer_name = None
        if args.kind == "final":
            final = (pin.get("schedule") or {}).get("final")
            if not final:
                raise Refused("the pin's [schedule] has no final step, so there is no final reviewer")
            if final_mode(pin["schedule"]) == "off":
                raise Refused('the final review is off ([schedule.final] mode = "off" in .conclave/reviewers.toml); '
                              'stamp without --final, or set mode to "optional" or "required" to run it')
            if not args.record:
                raise Refused("--kind final needs --record, the findings file whose regular rounds it follows")
            existing = existing_findings(Path(args.record), "final review")
            found = read_findings(existing)
            if found is None:
                raise Unrecorded(f"{args.record} cannot be read back ({RESERVED_NAMES}), so no final review was run")
            # One pass, checked before the reviewer runs, so a repeated command never spends another review.
            if any(entry["reviewer"] for entry in found["finals"]):
                raise Refused(f"{args.record} already holds a final review; it is one pass, so none was run")
            returned = [r for r in found["rounds"] if returned_review(r)]
            # The last round must declare its severity: a round without a HIGHEST line counts as P1.
            if not returned or declared_highest(returned[-1]["review"]) not in ("P3", "none"):
                raise Refused("the final review runs once the regular rounds have stopped: the last round that "
                              "returned a review must declare HIGHEST: P3 or HIGHEST: none")
            reviewer_name = final["reviewer"]
            final_family = FAMILY[pin["reviewers"][reviewer_name]["cli"]]
            round_family = FAMILY[pin["reviewers"][pin["routes"][args.writer][0]]["cli"]]
            if final_family in (WRITER_FAMILY[args.writer], round_family):
                raise Refused(f"the final reviewer {reviewer_name} is of the writer's or its round reviewer's "
                              f"family; a final review comes from a different family")
        result = review(pin, args.writer, args.prompt, args.timeout, plan, reviewer_name)
    except (Refused, Unrecorded, OSError) as exc:
        print("review-dispatch refused: " + str(exc), file=sys.stderr)
        return 2
    when = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if args.kind == "final" and result["reviewer"] and not final_reply_ok(result["review"]):
        # A reply without its severity line or verdict is no review: recorded as none, so a retry can still run.
        result = {**result, "reviewer": None, "review": None, "failover": [
            {"reviewer": result["reviewer"], "reason": "returned no HIGHEST line or OVERALL verdict"}]}
    if one_pass:
        result.update(kind=args.kind, candidate=args.candidate)
    result["pin"] = pin_id
    if self_review_enabled(pin, args.writer):
        result["policy"] = review_policy(pin, args.writer)
    if plan and plan["position"]:
        result.update(position=plan["position"], escalated=plan["escalated"], schedule=plan["schedule"])
        stop_after = pin["schedule"]["severity_stop_after"]
        # The severity stop: a returned round past `severity_stop_after` whose worst finding is P3 ends the loop (0:
        # from round 1; todo_graph.SEVERITY_CUTOFF_ROUND is the same number, and `stamp`
        # re-checks it).
        result["severity_stop"] = bool(result["reviewer"]) and plan["position"] > stop_after \
            and highest(result["review"]) == "P3"
    if args.record:
        try:
            if one_pass:
                record_completion(Path(args.record), result, when, args.candidate, args.kind)
                result["recorded"] = True
            else:
                result["round"] = record(Path(args.record), result, when)
        except Unrecorded as exc:
            # The review still reaches stdout; only the findings file is left as it was.
            unrecorded = {"recorded": False} if one_pass else {"round": None}
            print(json.dumps({**result, **unrecorded, "run": when}, indent=2))
            print("review-dispatch refused: " + str(exc), file=sys.stderr)
            return 2
    print(json.dumps({**result, "run": when}, indent=2))
    if not result["reviewer"] and args.kind == "final" and final_mode(pin["schedule"]) == "optional":
        # The soft failure: an optional final reviewer that returned no review does not hold the section up.
        print("review-dispatch: the optional final review returned no review; the section may stamp without --final",
              file=sys.stderr)
        return 0
    return 0 if result["reviewer"] else 1


if __name__ == "__main__":
    sys.exit(main())
