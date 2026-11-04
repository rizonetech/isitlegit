"""The canonical TODO graph: parse todo/NN-domain/TODO-NN-*.md, validate it, order it, project the plan.

Installed by the todo kit: Adjacency declarations, bidirectional XREFs, index coverage, frozen
freeze checks, durable deferrals, and stamps that bind a section to its reviewed evidence.
Stamping loads the reviewer kit's scripts/review-dispatch.py. Rules: todo/README.md.
"""
from __future__ import annotations

import atexit
import bisect
import datetime
from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PLAN = "todo/implementation-plan.md"
# What follows each "-> XREF:": one space and exactly one well-formed reference, nothing run into it.
XREF_TARGET = re.compile(r" (?:D(?P<d>\d{2}) )?(?:T(?P<t>\d{2}) )?§(?P<s>[1-9]\d*)(?![\w§]|\.\d)")
REF = re.compile(r"(?:D(?P<d>\d{2})\s+)?(?:T(?P<t>\d{2})\s+)?§(?P<s>[1-9]\d*)")
ROW = re.compile(r"^\|\s*([1-9]\d*)\s*\|\s*§([1-9]\d*)\s*\|\s*([^|]+)\|\s*([^|]*)\|\s*\[([ x])\]\s*\|$")
# What a section needs from outside the repository. The WAITING values are people, companies, or the
# operator's own hands: a section naming one stays blocked until the answer is recorded and the Need
# is removed from the section. The environment values are IsItLegit's: meta-api (a Meta Model API key whose credit
# is applied, since every call costs money), cloudflare (Wrangler signed in to the Rizonetech account), live-mail
# (isitlegit.co.za routes mail to the Worker and SMTP2GO sends from it) and whatsapp (the Meta app's test number).
NEEDS = {"meta-api", "cloudflare", "live-mail", "whatsapp",
         "attended", "owner-decision", "third-party", "operator"}
WAITING = {"owner-decision", "third-party", "operator"}
STATUSES = {"draft", "active", "blocked", "done", "superseded"}
# stopped-at-3 is the current review-round cap (3 regular rounds + plan + completion = 5 reviews total; operator,
# 2026-11-03 20:02 SAST); stopped-at-33, -22, -13 and -8 stay valid on receipts written under earlier caps.
# stopped-low-severity: after SEVERITY_CUTOFF_ROUND, a round whose findings are all P3 or advisory ends the loop and
# its findings are filed as leftovers (review-todo-section). With the cutoff at 0 that is the first such round.
VERDICTS = {"clean", "fixed", "stopped-at-33", "stopped-at-22", "stopped-at-13", "stopped-at-8", "stopped-at-3",
            "stopped-low-severity"}
REVIEW_ROUND_CAP = 3
# Both light and full sections stop at 3 regular rounds (5 reviews total with plan and completion; operator, 2026-11-03).
LIGHT_ROUND_CAP = 3


def round_cap(risk):
    """The review-round cap for a section of this Risk: the full loop for every section the service depends on."""
    return LIGHT_ROUND_CAP if risk == "light" else REVIEW_ROUND_CAP
# Caps a receipt that records round_cap may name: the current one and the earlier ones this repository used.
EARLIER_CAPS = {8, 13, 22, 33}
# Receipts older than the rounds_spent field (stamped under the earlier process). Each is frozen by the
# digest of its content in LEGACY_RECEIPTS, so a new receipt cannot pass by dropping the field. Their round counts vary
# (up to 16), so unlike their verdicts they are not bounded here; the digest is what binds them.
LEGACY_RECEIPTS = "docs/reviews/legacy-receipts.json"
LEGACY_VERDICTS = {"clean", "fixed", "stopped-at-3"}
# The first round with no P1 or P2 finding ends the loop, from round 1 (.conclave/reviewers.toml severity_stop_after,
# which must equal this). Lowering it only loosens the rule, so older receipts hold.
SEVERITY_CUTOFF_ROUND = 0
# The one-pass completion and excellence review, required for every new stamp: complete (no
# gaps), completed (every gap implemented in the section) or filed (some gaps filed as new sections, each listed under
# the completion review as "- Filed: DNN TNN §N"). A receipt without a completion field predates the requirement.
COMPLETION_VERDICTS = ("complete", "completed", "filed")
FILED = re.compile(r"^- Filed: (D\d{2} T\d{2} §[1-9]\d*)(?![\w§]|\.\d)")
# The one-pass plan review before the build and the review schedule: every new receipt records the plan
# review (`plan`) and the pin's [schedule] (`schedule`), and stamp replays the schedule over every recorded pass through
# scripts/review-dispatch.py's own `scheduled`. A receipt without them predates the requirement and is frozen by digest
# under `before_plan` in LEGACY_RECEIPTS, so dropping the fields from a new receipt does not dodge the checks.
# The one-pass final review, required for every new stamp whose schedule has a final step: clean (it declared no P1 or
# P2) or fixed (it declared one, and a regular round recorded after it returned a review, proving the fix; the final
# review itself is never repeated).
FINAL_VERDICTS = ("clean", "fixed")


def final_mode(schedule):
    """The schedule's final step mode (`required`, `optional` or `off`; required when unset), or None without one."""
    final = (schedule or {}).get("final")
    return final.get("mode", "required") if isinstance(final, dict) else None
FINAL_KEYS = {"report", "verdict", "candidate", "reviewer", "model"}
# Rounds recorded after a final review prove its fix; they are bounded on their own, outside the round cap, so a loop
# that came back clean only at the cap can still prove a fix the final review asked for. The dispatcher holds the same
# number (its POST_FINAL_CAP) and refuses a round past it before running it.
POST_FINAL_CAP = 3
PIN = ".conclave/reviewers.toml"
PLAN_KEYS = {"report", "candidate", "reviewer", "model", "effort", "lenses"}
# The paths a commit between the build start and a later plan candidate may change: the TODO tree, the review
# records and the lanes' run files (bookkeeping: a run file holds a run's notes, never a section's contract; 2026-10-31,
# a trust lane run-file note refused D05 T01 §3's stamp), and, as a formatting change only (the same parsed value), an
# existing JSON file under the tests (D00 T01 §28).
QUIET_AFTER_START = ("todo/", "docs/reviews/", "docs/phase-runs/")
FORMAT_ONLY_AFTER_START = ("test/", "tests/")
STARTED = re.compile(r"^> \*\*Started:\*\* .+$", re.M)
# A round scripts/review-dispatch.py recorded in a findings file, reviewed or not ("## Round 2: none").
ROUND_RECORD = re.compile(r"^## Round ([0-9]+): ", re.M)
ADJACENCY_KEYS = ["list", "document", "settings", "reporting", "notifications", "permissions",
                  "audit", "exchange", "reverse"]
# The closed phase list. A project names its phases (and the plan's title and acceptance bar) in
# todo/plan.json; without it the plan shows bare phase numbers.
PHASES = (0, 1, 2, 3, 4, 5, 6, 7, 8, 99)
PLAN_CONFIG = "todo/plan.json"
# Parallel lanes: each a branch worked in its own worktree, alone claiming the TODO files it lists.
LANES = "todo/lanes.json"
MAIN_LANE = "main"
# The Needs that put a row on the coordinator's manual list (`manual_rows`).
MANUAL_NEEDS = {"operator", "owner-decision", "third-party", "attended", "live-mail", "whatsapp", "meta-api"}
PLAN_DEFAULTS = {"title": "Implementation plan", "acceptance": None, "phases": {99: "Manual, operator only"}}
MAX_SECTIONS_PER_FILE = 55
MAX_ITEMS_PER_SECTION = 30
MAX_DELIVERABLE_LEN = 88
# The widest generated plan table row, so the plan never wraps in raw Markdown view.
MAX_TABLE_ROW = 120


class Refused(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def read_text(path):
    return Path(path).read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = data if isinstance(data, bytes) else data.encode("utf-8")
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def normalize(value, domain, todo):
    m = REF.fullmatch(value.strip().strip("`"))
    require(m is not None, f"invalid section reference: {value}")
    return f"D{m['d'] or domain} T{m['t'] or todo} §{m['s']}"


def find_ref(text, domain, todo):
    """The section the whole text names (surrounding spaces and backticks aside), or None: a reference with anything
    run into it does not parse, so a malformed one is never read as a neighbouring section."""
    m = REF.fullmatch(text.strip().strip("`"))
    if m is None:
        return None
    return f"D{m['d'] or domain} T{m['t'] or todo} §{m['s']}"


def xref_target(text, domain, todo):
    """The section the text right after one "-> XREF:" names, or None when it is not exactly one reference."""
    m = XREF_TARGET.match(text)
    return f"D{m['d'] or domain} T{m['t'] or todo} §{m['s']}" if m else None


def extract_ref(text, rows):
    """Resolve whatever the caller had in front of them: a DNN TNN §N reference, a pasted plan row,
    or a '<path> §N' pair (POSIX or Windows path). Returns (ref_or_None, exit_code): 1 no such
    section, 2 no reference."""
    normalized = text.replace("\\", "/")
    # A reference run into more text ("§1oops", "§1.5") is not a reference to §1.
    m = re.search(r"D(\d{2})\s+T(\d{2})\s+§([1-9]\d*)(?![\w§]|\.\d)", normalized)
    if m:
        ref = f"D{m[1]} T{m[2]} §{int(m[3])}"
        return (ref, 0) if ref in rows else (ref, 1)
    m = re.search(r"(\d{2})-[a-z0-9-]+/TODO-(\d{2})-[a-z0-9-]+\.md\s*§([1-9]\d*)(?![\w§]|\.\d)", normalized)
    if m:
        ref = f"D{m[1]} T{m[2]} §{int(m[3])}"
        return (ref, 0) if ref in rows else (ref, 1)
    return None, 2


# The only paths a light section may name (D00 T01 §15), and the words that keep even those on the full schedule:
# tooling, tests and documentation, never the product's code, its stored data, or anything that guards a secret or a
# client's data.
LIGHT_PREFIXES = ("scripts/", "tests/", "test/", "docs/", "todo/", ".claude/", ".github/", "design/", "site/", "media/")
GUARDED_WORDS = ("auth", "mail", "meta", "secret", "credential", "redact", "leak", "migration", "sample", "trust",
                 "bank", "payment")

# The switch the operator keeps for when time runs out (2026-10-31): True also lets member-facing pages (`src/web/`)
# and the eval (`eval/`) take the light schedule, while pages that sign people in, sign links, take uploads or decide
# access, and every other `src/` place, stay full. Off: light covers tooling, tests and docs only. Flip it here, in
# one commit, and tell the lanes.
LIGHT_INCLUDES_PAGES = False
PAGES_LIGHT_PREFIXES = ("src/web/", "eval/")
PAGES_GUARDED_WORDS = ("signin", "sign-in", "signup", "sign-up", "session", "invite", "access", "token", "cookie",
                       "csrf", "link", "upload", "intake", "artefact")


# A root file named without a folder (`wrangler.jsonc`, `package.json`, `AGENTS.md`): only root documents may be light.
ROOT_FILE = re.compile(r"^[\w.-]+\.(?:json|jsonc|toml|ya?ml|ts|tsx|js|mjs|cjs|py|sql|sh|md|txt|css|html|lock)$")


# The product's own places, anywhere in a section's text, prose included: a section that mentions one is never light,
# however its paths are written (round 1: `.dev.vars` and `src/db/migrations/<next number>_x.sql` escaped a reading
# of whole backtick spans).
# `src/` inside the marketing site's or the videos' own folders (site/src/, media/src/) is not the Worker's.
PRODUCT_PLACES = re.compile(r"(?<![\w-])(?<!site/)(?<!media/)(?:src/|\.dev\.vars\b|wrangler\b|package\.json|pnpm-lock|tsconfig|"
                            r"migrations?\b|worker-configuration)", re.IGNORECASE)
# With LIGHT_INCLUDES_PAGES, the same places but `src/web/`.
PRODUCT_PLACES_BUT_PAGES = re.compile(r"(?<![\w-])(?<!site/)(?<!media/)(?:src/(?!web/)|\.dev\.vars\b|wrangler\b|package\.json|pnpm-lock|"
                                      r"tsconfig|migrations?\b|worker-configuration)", re.IGNORECASE)


def light_paths(body):
    """Every path a section names in backticks: each word of each span (a command's arguments too), taken as a path
    when it has a slash (not a web address), starts with a dot, or is a root file; a leading `./` dropped, a leading
    dot (`.claude/`) kept, surrounding punctuation ignored."""
    found = set()
    for span in re.findall(r"`([^`]+)`", body):
        for word in span.split():
            word = word.strip("<>()[]{},;:'\"").removeprefix("./")
            if word and "://" not in word and ("/" in word or word.startswith(".") or ROOT_FILE.match(word)):
                found.add(word)
    return sorted(found)


def light_path(path, pages=None):
    """Whether one named path may sit in a light section; `pages` (default LIGHT_INCLUDES_PAGES) widens it."""
    pages = LIGHT_INCLUDES_PAGES if pages is None else pages
    guarded = GUARDED_WORDS + (PAGES_GUARDED_WORDS if pages else ())
    if any(word in path.lower() for word in guarded):
        return False
    if "/" not in path:
        return path.endswith(".md") and not path.startswith(".")
    return path.startswith(LIGHT_PREFIXES + (PAGES_LIGHT_PREFIXES if pages else ()))


def field(body, name, required=True):
    empty = re.findall(r"^(?:> )?\*\*" + re.escape(name) + r":\*\*[ \t]*$", body, re.M)
    require(not empty, f"missing {name} field")
    values = re.findall(r"^(?:> )?\*\*" + re.escape(name) + r":\*\*[ \t]*(.+)$", body, re.M)
    require(len(values) <= 1, f"duplicate {name} field")
    require(values or not required, f"missing {name} field")
    return values[0].strip() if values else ""


@dataclass
class Section:
    ref: str
    path: str
    number: int
    title: str
    phase: int
    depends: list
    needs: list
    done: bool
    status: str
    body: str
    receipt: str
    order: int = 0

    def public(self):
        return {k: v for k, v in asdict(self).items() if k != "body"}


def front_matter(text, relative):
    parts = text.split("---\n", 2)
    require(len(parts) == 3 and not parts[0], f"missing frontmatter: {relative}")
    front = {}
    for line in parts[1].splitlines():
        m = re.fullmatch(r"([a-z_]+):\s*(.+)", line)
        require(m is not None and m[1] not in front, f"invalid or duplicate frontmatter: {relative}")
        front[m[1]] = m[2].strip().strip('"')
    return front, parts[2]


def _tips(root):
    """The commits the next commit will descend from: HEAD, and MERGE_HEAD while a merge is being concluded, whose
    stamps (a parallel lane merging main, AGENTS.md Parallel lanes) are reachable from it and not yet from HEAD."""
    merging = subprocess.run(["git", "-C", str(root), "rev-parse", "-q", "--verify", "MERGE_HEAD"],
                             capture_output=True, text=True, timeout=30)
    return ["HEAD", "MERGE_HEAD"] if merging.returncode == 0 else ["HEAD"]


def commit_ok(root, sha):
    kind = subprocess.run(["git", "-C", str(root), "cat-file", "-t", sha],
                          capture_output=True, text=True, timeout=30)
    require(kind.returncode == 0 and kind.stdout.strip() == "commit", "not a commit: " + sha)
    on_branch = any(subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", sha, tip],
                                   capture_output=True, timeout=30).returncode == 0 for tip in _tips(root))
    require(on_branch, "commit is not on this branch: " + sha)


def _head_commits(root):
    res = subprocess.run(["git", "-C", str(root), "rev-list", *_tips(root)],
                         capture_output=True, text=True, timeout=30)
    require(res.returncode == 0, f"git repository with HEAD commit required for stamped sections: {root}")
    return set(res.stdout.splitlines())


def receipt_ok(root, receipt, ref, stamp_sha, commits=None, surface=None, risk="full", todo=None, body=None):
    """Check one receipt against its stamp and return it. `surface`: the section's Surface field is yes. `todo` and
    `body`: the section's TODO file and text, which a plan review after Started is proved against."""
    require(re.fullmatch(r"docs/reviews/[a-z0-9][a-z0-9.-]*\.json", receipt or "") is not None,
            f"invalid receipt path: {ref}")
    path = Path(root) / receipt
    require(path.is_file() and not path.is_symlink(), f"missing receipt: {ref}")
    try:
        data = json.loads(read_text(path))
    except ValueError:
        raise Refused(f"receipt is not JSON: {ref}") from None
    # The stamped commit first: a fabricated SHA is named as such before anything the receipt says is compared.
    if commits is None or stamp_sha not in commits:
        commit_ok(root, stamp_sha)
    receipt_data_ok(data, ref, stamp_sha, root=root, commits=commits, surface=surface, risk=risk, todo=todo, body=body)
    return data


_REVIEW_DISPATCH = []
# The reviewer kit's dispatcher, installed beside this script's folder.
DISPATCHER = Path(__file__).resolve().parents[1] / "review-dispatch.py"


def review_dispatch():
    """scripts/review-dispatch.py as a module (its file name is not importable), loaded once."""
    if not _REVIEW_DISPATCH:
        import importlib.util
        if not DISPATCHER.is_file():
            raise Refused(f"{DISPATCHER} is missing: the todo kit stamps through the reviewer kit's dispatcher, "
                          "so install the reviewer kit (python forge.py kit <project> reviewer)")
        spec = importlib.util.spec_from_file_location("review_dispatch", DISPATCHER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _REVIEW_DISPATCH.append(module)
    return _REVIEW_DISPATCH[0]


def receipt_digest(data):
    """The SHA-256 of a receipt's content, independent of key order, spacing and line endings."""
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _frozen(root, key):
    """ref -> digest under `key` in LEGACY_RECEIPTS ("receipts" or "before_plan"); empty when the file or key is absent."""
    path = Path(root) / LEGACY_RECEIPTS
    if not path.is_file():
        return {}
    try:
        data = json.loads(read_text(path))
    except ValueError:
        raise Refused(f"{LEGACY_RECEIPTS} is not JSON") from None
    ok = isinstance(data, dict) and data.get("schema_version") == 1 and "receipts" in data
    maps = {name: data.get(name, {}) for name in ("receipts", "before_plan")} if ok else {}
    require(ok and all(isinstance(m, dict) and all(
        isinstance(k, str) and isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) for k, v in m.items())
        for m in maps.values()),
            f"{LEGACY_RECEIPTS} needs schema_version 1 and receipts (and any before_plan) mapping each ref to a "
            f"SHA-256 digest")
    return maps[key]


def legacy_receipts(root):
    """ref -> digest of every receipt written before rounds_spent existed; empty when the file is absent."""
    return _frozen(root, "receipts")


def receipts_before_plan(root):
    """ref -> digest of every receipt written since rounds_spent but before the plan and schedule fields existed."""
    return _frozen(root, "before_plan")


def report_ok(root, raw_report, ref):
    """A findings file path inside docs/reviews/, reached through no symlink, holding text."""
    root_path = Path(root)
    report = Path(raw_report)
    require(isinstance(raw_report, str) and re.fullmatch(r"docs/reviews/[A-Za-z0-9_./-]+\.md", raw_report) is not None
            and not report.is_absolute() and not report.drive and not report.root and ".." not in report.parts,
            f"invalid review report path ({raw_report}): {ref}")
    cur = root_path
    for part in report.parts:
        cur = cur / part
        require(not cur.is_symlink(), f"invalid review report path ({raw_report}): {ref}")
    report_path = root_path / report
    require(report_path.is_file() and report_path.resolve().is_relative_to(root_path.resolve())
            and bool(read_text(report_path).strip()),
            f"missing or empty review report ({raw_report}): {ref}")
    return report_path


# When verdict_lines (review-dispatch.py, which sets aside a closing second reading block when it counts a returned
# review) reached main: no lane's dispatcher counted that way before it, so only a round run earlier may be held to the
# older count. A round run later on a lane that had not merged it yet is held to today's count only, which refuses it
# rather than letting a loop skip a step.
LEGACY_COUNT_UNTIL = "2026-10-31T17:28:00Z"


def before_legacy_cutoff(entry):
    """Whether a recorded round ran before LEGACY_COUNT_UNTIL: its exact `- Run:` time, compared as an instant."""
    run = entry.get("run")
    if not isinstance(run, str) or RUN_TIME.fullmatch(run) is None:
        return False
    at = datetime.datetime.fromisoformat(run.replace("Z", "+00:00"))
    return at < datetime.datetime.fromisoformat(LEGACY_COUNT_UNTIL.replace("Z", "+00:00"))


def completion_verdict(review):
    """The completion review's verdict line: its last line once one closing `### Second reading` block is set aside
    (review-dispatch.py `verdict_lines`, the one rule every reply's closing lines are read by)."""
    return (review_dispatch().verdict_lines(review) or [""])[-1]


def completion_record(root, completion, ref, stamp_sha, commits=None, reconciliation=None):
    """The receipt's record of the section's completion review, from `--completion <findings file>:<verdict>`: the
    findings file holds exactly one completion review returned by an authorized reviewer, its last line
    `COMPLETION: complete` (verdict complete) or `COMPLETION: gaps` (completed or filed), its candidate a commit at or
    before the stamped one, and, for filed, the `- Filed: DNN TNN §N` lines the writer added under it. Whether each
    filed section resolves is checked against the whole graph by the caller. Codex self-review requires a complete
    result on the exact stamped candidate, or a separately validated reconciliation preserving the gaps verdict."""
    require(isinstance(completion, dict) and isinstance(completion.get("report"), str)
            and isinstance(completion.get("verdict"), str), f"receipt completion is malformed: {ref}")
    report, verdict = completion["report"], completion["verdict"]
    require(verdict in COMPLETION_VERDICTS or (verdict == "gaps" and reconciliation is not None),
            f"--completion verdict must be one of {', '.join(COMPLETION_VERDICTS)}, not {verdict!r}: {ref}")
    path = report_ok(root, report, ref)
    dispatch = review_dispatch()
    found = dispatch.read_completions(path.read_bytes().decode("utf-8"))
    require(found is not None, f"{report} is not a findings file the dispatcher can read: {ref}")
    require(bool(found), f"{report} holds no ## Completion review; run review-dispatch.py --kind completion: {ref}")
    returned = [e for e in found if _allowed_review(root, dispatch, e, ref)
                and completion_verdict(e["review"]) in ("COMPLETION: complete", "COMPLETION: gaps")]
    require(len(returned) == 1, f"{report} must hold exactly one completion review returned by another model family "
                                f"or authorized Codex self-review and ending COMPLETION: complete or COMPLETION: gaps "
                                f"(a closing ### Second reading "
                                f"block may follow it), not {len(returned)}: {ref}")
    (entry,) = returned
    last = completion_verdict(entry["review"])
    expected = "COMPLETION: complete" if verdict == "complete" else "COMPLETION: gaps"
    require(last == expected, f"completion verdict {verdict} needs a review ending {expected}, and {report} ends "
                              f"{last}: {ref}")
    filed = list(dict.fromkeys(m[1] for m in (FILED.match(line) for line in entry["notes"]) if m))
    require((bool(filed) == (verdict == "filed")) or (verdict == "gaps" and reconciliation is not None),
            f"completion verdict filed needs each filed section listed as '- Filed: DNN TNN §N' under the completion "
            f"review in {report}, and only filed lists any: {ref}")
    require(ref not in filed, f"{ref} cannot file a completion gap to itself: {ref}")
    candidate = entry["candidate"]
    if entry.get("policy") in ("codex-self-review", "codex-two-pass-v1"):
        if reconciliation is not None:
            require(verdict == "gaps", f"reconciliation preserves the original completion verdict gaps: {ref}")
            reconciliation_record(root, reconciliation, ref, stamp_sha)
        else:
            require(verdict == "complete", f"Codex self-review needs completion verdict complete: {ref}")
            require(candidate == stamp_sha, f"Codex completion must review the exact stamped commit: {ref}")
    else:
        require(reconciliation is None and verdict != "gaps",
                f"reconciliation is restricted to an authorized Codex chain: {ref}")
    if commits is None or candidate not in commits:
        commit_ok(root, candidate)
    if commits is None:  # stamping: the candidate is the stamped commit or one before it
        ancestor = subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", candidate, stamp_sha],
                                  capture_output=True, timeout=30)
        require(ancestor.returncode == 0,
                f"the completion review's candidate {candidate} is not the stamped commit or an ancestor of it: {ref}")
    return {"report": report, "verdict": verdict, "candidate": candidate, "reviewer": entry["reviewer"],
            "model": entry["model"], "filed": filed}


def reconciliation_record(root, recorded, ref, stamp_sha):
    """Replay a separately returned reconciliation, keeping the original failed completion intact."""
    require(isinstance(recorded, dict) and recorded.get("verdict") == "complete",
            f"reconciliation needs verdict complete: {ref}")
    report = recorded.get("report")
    require(report == section_findings(root, ref),
            f"reconciliation must use the section's own findings file: {ref}")
    text = report_ok(root, report, ref).read_bytes().decode("utf-8")
    dispatch = review_dispatch()
    entries = dispatch.read_reconciliations(text)
    require(entries is not None and entries, f"missing or unreadable reconciliation: {ref}")
    valid = []
    for entry in entries:
        require(isinstance(entry.get("binding"), dict) and entry["binding"].get("report") == report,
                f"reconciliation binding belongs to another section: {ref}")
        try:
            dispatch.validate_reconciliation_binding(root, text, entry)
        except (dispatch.Refused, ValueError) as exc:
            raise Refused(f"invalid reconciliation binding: {exc}: {ref}") from None
        allowed = _allowed_review(root, dispatch, entry, ref)
        if allowed and dispatch.returned_pass(entry, "reconciliation"):
            valid.append(entry)
    try:
        series = dispatch.validate_reconciliation_series(root, text)
    except (dispatch.Refused, ValueError) as exc:
        raise Refused(f"invalid reconciliation series: {exc}: {ref}") from None
    require(valid == series and series and entries[-1] == series[-1],
            f"reconciliation needs its authorized returned series with no unresolved attempt: {ref}")
    entry = series[-1]
    require(completion_verdict(entry["review"]) == "RECONCILIATION: complete",
            f"reconciliation must end RECONCILIATION: complete: {ref}")
    require(entry["candidate"] == stamp_sha, f"reconciliation must review the exact stamped candidate: {ref}")
    return {"report": report, "verdict": "complete", "candidate": entry["candidate"],
            "reviewer": entry["reviewer"], "model": entry["model"], "pin": entry["pin"],
            "binding": entry["binding"], "digest": entry["digest"]}


def final_record(root, final, ref, stamp_sha, commits=None):
    """The receipt's record of the section's final review, from `--final <findings file>:<clean|fixed>`: the findings
    file holds exactly one final review returned by a reviewer of another family than the writer, its candidate a
    commit at or before the stamped one; clean needs it to declare no P1 or P2, fixed needs it to declare one and a
    returned regular round recorded after it."""
    require(isinstance(final, dict) and isinstance(final.get("report"), str) and isinstance(final.get("verdict"), str),
            f"receipt final is malformed: {ref}")
    report, verdict = final["report"], final["verdict"]
    require(verdict in FINAL_VERDICTS, f"--final verdict must be one of {', '.join(FINAL_VERDICTS)}, not {verdict!r}: {ref}")
    expected = section_findings(root, ref)
    require(report == expected, f"--final must be the section's own findings file {expected}, not {report}: {ref}")
    path = report_ok(root, report, ref)
    dispatch = review_dispatch()
    text = path.read_bytes().decode("utf-8")
    found = dispatch.read_finals(text)
    require(found is not None, f"{report} is not a findings file the dispatcher can read: {ref}")
    returned = [e for e in found if _other_family(dispatch, e) and dispatch.final_reply_ok(e["review"])]
    require(len(returned) == 1, f"{report} must hold exactly one final review returned by another model family with "
                                f"its HIGHEST line and OVERALL verdict, not {len(returned)}; run review-dispatch.py "
                                f"--kind final: {ref}")
    (entry,) = returned
    declared = dispatch.declared_highest(entry["review"])
    require((declared in ("P1", "P2")) == (verdict == "fixed"),
            f"final verdict {verdict} does not match the final review, which declares HIGHEST: {declared}: {ref}")
    if verdict == "fixed":
        later = [r for r in dispatch.read_rounds(text) if dispatch.returned_review(r) and r["run"] > entry["run"]]
        require(bool(later), f"final verdict fixed needs a regular round recorded after the final review in {report}, "
                             f"proving the fix: {ref}")
    candidate = entry["candidate"]
    if commits is None or candidate not in commits:
        commit_ok(root, candidate)
    if commits is None:
        ancestor = subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", candidate, stamp_sha],
                                  capture_output=True, timeout=30)
        require(ancestor.returncode == 0,
                f"the final review's candidate {candidate} is not the stamped commit or an ancestor of it: {ref}")
    return {"report": report, "verdict": verdict, "candidate": candidate, "reviewer": entry["reviewer"],
            "model": entry["model"]}


def _other_family(dispatch, entry):
    """A review returned by a reviewer of another model family than the writer: not an outage, not a self-review."""
    return bool(entry["reviewer"]) and entry["writer"] in dispatch.WRITER_FAMILY \
        and dispatch.FAMILY.get(entry["cli"]) not in (None, dispatch.WRITER_FAMILY[entry["writer"]])


def _allowed_review(root, dispatch, entry, ref):
    """A self-review is authorized by its committed pin, never by a prose marker alone."""
    if entry.get("policy") is None:
        return _other_family(dispatch, entry)
    blob = entry.get("pin")
    require(blob is not None and blob in committed_pins(root),
            f"Codex self-review needs a committed Pin: {ref}")
    raw = _object_at(root, blob)
    try:
        pin = dispatch.load_pin(PIN, data=raw)
    except dispatch.Refused as exc:
        raise Refused(f"self-review pin does not load: {exc}: {ref}") from None
    require(entry.get("policy") == dispatch.review_policy(pin, entry["writer"])
            and dispatch.self_review_enabled(pin, entry["writer"]),
            f"pin {blob} does not authorize Codex self-review: {ref}")
    name = pin["routes"][entry["writer"]][0]
    reviewer = pin["reviewers"][name]
    # Failed attempts retain policy and pin but have no returned reviewer identity.
    if not entry["reviewer"]:
        return False
    require(entry["reviewer"] == name and entry["model"] == reviewer["model"]
            and entry["cli"] == reviewer["cli"], f"self-review identity does not match its committed pin: {ref}")
    return dispatch.reviewer_allowed(entry)


def self_review_chain_ok(root, data, ref):
    """Codex owns three passes in order; its final completion proves the single round's fixes."""
    dispatch = review_dispatch()
    reports = {data["plan"]["report"], data["completion"]["report"],
               *(r["report"] for r in data["reviews"])}
    texts = [(Path(root) / r).read_bytes().decode("utf-8") for r in reports]
    records = [dispatch.read_findings(text) for text in texts]
    require(all(found is not None for found in records), f"unreadable review chain: {ref}")
    entries = [entry for found in records for key, group in found.items()
               if key != "reconciliations" for entry in group]
    if any(e.get("policy") == "codex-two-pass-v1" for e in entries):
        require(data.get("review_policy") == "codex-two-pass-v1" and len(reports) == 1,
                f"two-pass chain needs its explicit receipt policy and one findings file: {ref}")
        require(data["reviews"] == [] and data["round_cap"] == 0 and data["rounds_spent"] == 0,
                f"two-pass chain records zero implementation rounds: {ref}")
        try:
            chain = dispatch.validate_codex_chain(root, texts[0])
        except dispatch.Refused as exc:
            raise Refused(f"invalid two-pass chain: {exc}: {ref}") from None
        require(chain["policy"] == "codex-two-pass-v1", f"receipt policy disagrees with completion: {ref}")
        transition = chain.get("transition")
        require(data.get("policy_transition") == transition and ("policy_transition" in data) == (transition is not None),
                f"receipt plan transition does not match actual review evidence: {ref}")
        reconciliations = records[0].get("reconciliations", [])
        require(bool(reconciliations) == ("reconciliation" in data),
                f"two-pass reconciliation must be explicitly recorded: {ref}")
        previous = chain["completion"]
        for entry in reconciliations:
            try:
                at = datetime.datetime.fromisoformat(entry["run"].replace("Z", "+00:00"))
                before = datetime.datetime.fromisoformat(previous["run"].replace("Z", "+00:00"))
                ordered = at.tzinfo is not None and before.tzinfo is not None and at >= before and entry["offset"] > previous["offset"]
            except (ValueError, TypeError, KeyError):
                ordered = False
            require(ordered, f"reconciliation must follow combined completion chronologically: {ref}")
            previous = entry
        return
    require("review_policy" not in data and "policy_transition" not in data,
            f"legacy chain cannot claim the two-pass policy or transition: {ref}")
    if not any(e.get("policy") == "codex-self-review" for e in entries):
        require(data["round_cap"] != 1, f"a one-round cap requires the Codex self-review policy: {ref}")
        return
    require(data["round_cap"] == 1, f"Codex self-review records a one-round cap: {ref}")
    require(len(reports) == 1, f"Codex self-review uses one section findings file: {ref}")
    found = records[0]
    require(not found["finals"], f"Codex self-review ends at completion, with no separate final review: {ref}")
    require(all(e.get("policy") == "codex-self-review" for e in entries),
            f"Codex self-review cannot mix review policies: {ref}")
    require(len({e.get("pin") for e in entries}) == 1,
            f"Codex self-review must use one committed pin throughout: {ref}")
    returned = {}
    for kind, group in (("plan", found["plans"]), ("round", found["rounds"]),
                        ("completion", found["completions"])):
        valid = [e for e in group if (dispatch.returned_review(e) if kind == "round"
                                       else dispatch.returned_pass(e, kind))]
        require(len(valid) == 1, f"Codex self-review needs exactly one returned {kind}: {ref}")
        require(group[-1] is valid[0], f"Codex self-review has an unresolved {kind} attempt: {ref}")
        returned[kind] = valid[0]
        for entry in group:
            _allowed_review(root, dispatch, entry, ref)
    try:
        times = [datetime.datetime.fromisoformat(returned[k]["run"].replace("Z", "+00:00"))
                 for k in ("plan", "round", "completion")]
        ordered = all(t.tzinfo is not None for t in times) and times[0] <= times[1] <= times[2]
    except (ValueError, TypeError):
        ordered = False
    positions = [returned[k]["offset"] for k in ("plan", "round", "completion")]
    require(ordered and positions == sorted(positions),
            f"Codex self-review order is plan, one round, then completion: {ref}")
    require(len(data["reviews"]) == 1 and data["reviews"][0]["verdict"] in ("clean", "fixed"),
            f"Codex self-review records one clean or fixed round, with no cap stop: {ref}")
    reconciliations = found.get("reconciliations", [])
    require(bool(reconciliations) == ("reconciliation" in data),
            f"Codex reconciliation evidence must be explicitly recorded in the receipt: {ref}")
    if reconciliations:
        require(completion_verdict(returned["completion"]["review"]) == "COMPLETION: gaps",
                f"reconciliation requires original completion gaps: {ref}")
        previous = times[-1]
        previous_offset = positions[-1]
        for entry in reconciliations:
            try:
                at = datetime.datetime.fromisoformat(entry["run"].replace("Z", "+00:00"))
                ordered = at.tzinfo is not None and at >= previous and entry["offset"] > previous_offset
            except (ValueError, TypeError, KeyError):
                ordered = False
            require(ordered, f"reconciliation must follow the original completion chronologically: {ref}")
            previous, previous_offset = at, entry["offset"]



def section_text(text, number):
    """Section `number`'s text in a TODO file's text, from its `## N.` heading to the next level-two heading, or None."""
    head = re.search(rf"^## {number}\. ", text, re.M)
    if head is None:
        return None
    end = re.search(r"^##(?:[ \t]|$)", text[head.end():], re.M)
    return text[head.start():head.end() + end.start() if end else len(text)]


def build_start(root, path, body, ref):
    """The commit the section's build began at: the first commit of its TODO file in which the section's own text
    holds its whole `> **Started:**` line (another section's identical or longer Started line does not count), or,
    for a section that never recorded one, the first commit naming the section outside todo/ and docs/. Searched from
    every tip (`_tips`): while a lane concludes a merge of main, the commit that recorded another lane's Started line
    is reachable only from MERGE_HEAD."""
    started = STARTED.search(body or "")
    first = None
    if started:
        line = started[0].rstrip("\r")
        number = ref.rsplit("§", 1)[1]
        out = subprocess.run(["git", "-C", str(root), "log", "--reverse", "--format=%H", *_tips(root), "--", path],
                             capture_output=True, text=True, timeout=60)
        for sha in out.stdout.split() if out.returncode == 0 else []:
            shown = subprocess.run(["git", "-C", str(root), "show", f"{sha}:{path}"], capture_output=True, timeout=30)
            section = section_text(shown.stdout.decode("utf-8", "replace"), number) if shown.returncode == 0 else None
            if section is not None and line in section.splitlines():
                first = sha
                break
    else:
        # The whole reference, so `D01 T02 §2` does not match a commit that names only §22 or §23.
        out = subprocess.run(["git", "-C", str(root), "log", "--reverse", "--format=%H", "-E",
                              f"--grep={ref}([^0-9]|$)", *_tips(root), "--", ".", ":(exclude)todo", ":(exclude)docs"],
                             capture_output=True, text=True, timeout=60)
        first = out.stdout.split()[0] if out.returncode == 0 and out.stdout.split() else None
    require(first is not None, f"cannot find the commit the build began at: record '> **Started:**' in the section "
                               f"before the build: {ref}")
    return first


def contract_text(text, number):
    """What a section is built against in its TODO file's text: the file's preamble (frontmatter, Goal, Inputs,
    Outcome, the Implementation Order without any other section's row) and the section's own text."""
    first = re.search(r"^## [1-9]\d*\. ", text, re.M)
    preamble = text[:first.start()] if first else text
    # An Implementation Order row is `| Order | §N | ...`: kept by its section column, whatever its order.
    preamble = "".join(line for line in preamble.splitlines(True)
                       if not (m := re.match(r"\| *[0-9]+ *\| *§ *([1-9]\d*) *\|", line)) or m[1] == str(number))
    return preamble + (section_text(text, number) or "")


def same_json(old, new):
    """Two versions of a JSON file hold the same value: a reformat, not a change to what a test reads. Compared as the
    canonical text of each parsed value, so a type change Python's `==` hides (`true` against `1`, `1.0` against `1`)
    or a reordered object is a change."""
    def canonical(data):
        return json.dumps(json.loads(data), ensure_ascii=False, separators=(",", ":"))
    try:
        return old is not None and new is not None and canonical(old) == canonical(new)
    except ValueError:
        return False


def quiet_since_start(root, todo, ref, start, candidate):
    """The commits that descend from the build start and lead to a plan candidate that follows it, oldest first, when
    none of them moved what defines or builds the feature: against its first parent, each changes only
    QUIET_AFTER_START paths or reformats an existing FORMAT_ONLY_AFTER_START JSON file to the same parsed value, and the
    section's contract in its TODO file (`contract_text`) is byte for byte what it was at the start. Refuses naming the
    first commit and path that broke the condition."""
    def git(*args):
        return subprocess.run(["git", "-C", str(root), *args], capture_output=True, timeout=60)
    after = git("merge-base", "--is-ancestor", start, candidate)
    require(after.returncode == 0, f"the plan review's candidate {candidate} is not the commit the build began at "
                                   f"({start}), an ancestor of it, or a descendant: review the plan before the build: "
                                   f"{ref}")
    number = ref.rsplit("§", 1)[1]

    def blob(sha, name):
        shown = git("show", f"{sha}:{name}")
        return shown.stdout if shown.returncode == 0 else None

    def contract(sha):
        text = blob(sha, todo)
        return contract_text(text.decode("utf-8", "replace"), number) if text is not None else None
    expected = contract(start)
    # Every commit built on the start, a branch forked after it included; a merge's first-parent diff holds what it
    # brought in from work that never held the Started line, and what its resolution changed.
    listed = git("rev-list", "--reverse", "--topo-order", "--ancestry-path", f"{start}..{candidate}")
    require(listed.returncode == 0, f"cannot list the commits from {start} to {candidate}: {ref}")
    between = listed.stdout.decode("ascii", "replace").split()
    moved = f"the plan review's candidate {candidate} follows the build start {start}, and"
    for sha in between:
        # Against the first parent only: against the other, a merge into the lane would show the lane's own work from
        # before the start. Renames as delete plus add, so both paths are named.
        parent = f"{sha}^1"
        diff = git("diff", "--name-status", "--no-renames", "-z", parent, sha)
        require(diff.returncode == 0, f"cannot read what {sha} changed: {ref}")
        fields = diff.stdout.decode("utf-8", "replace").split("\0")
        for status, name in zip(fields[0::2], fields[1::2]):
            if name.startswith(QUIET_AFTER_START):
                continue
            formatted = status == "M" and name.startswith(FORMAT_ONLY_AFTER_START) and name.endswith(".json") \
                and same_json(blob(parent, name), blob(sha, name))
            require(formatted, f"{moved} {sha} changed {name} in between: after Started and before the plan "
                               f"review only {', '.join(QUIET_AFTER_START)} may change, and a JSON file under "
                               f"{', '.join(FORMAT_ONLY_AFTER_START)} only to the same parsed value: {ref}")
        require(contract(sha) == expected,
                f"{moved} {sha} changed the section's contract in {todo}: review the plan as it will be built: {ref}")
    return between


def section_findings(root, ref):
    """The section's own findings file, `docs/reviews/<NN-domain>/D<NN>-T<NN>-s<N>.md`, the domain being the one
    `todo/<NN-domain>/` folder its domain number names."""
    m = re.fullmatch(r"D(\d{2}) T(\d{2}) §([1-9]\d*)", ref)
    require(m is not None, f"not a full section reference: {ref}")
    domains = sorted(d.name for d in (Path(root) / "todo").iterdir() if d.is_dir() and d.name.startswith(f"{m[1]}-"))
    require(len(domains) == 1, f"no single todo/{m[1]}-<domain> folder for: {ref}")
    return f"docs/reviews/{domains[0]}/D{m[1]}-T{m[2]}-s{m[3]}.md"


def plan_record(root, report, ref, commits=None):
    """The receipt's record of the section's one-pass plan review, from `--plan <findings file>`: the file is the
    section's own findings file (so another section's plan review cannot stand in for it), holds exactly one plan
    review returned by a reviewer of another model family, ending in the plan prompt's `PLAN:` and `OVERALL:` verdict
    lines. Where its candidate sits against the build start is `plan_after_started`'s to check."""
    require(isinstance(report, str), f"receipt plan is malformed: {ref}")
    expected = section_findings(root, ref)
    require(report == expected,
            f"--plan must be the section's own findings file {expected}, not {report}: {ref}")
    path = report_ok(root, report, ref)
    dispatch = review_dispatch()
    found = dispatch.read_plans(path.read_bytes().decode("utf-8"))
    require(found is not None, f"{report} is not a findings file the dispatcher can read: {ref}")
    require(bool(found), f"{report} holds no ## Plan review; run review-dispatch.py --kind plan: {ref}")

    def verdict(entry):
        lines = dispatch.verdict_lines(entry["review"])
        return len(lines) >= 2 and lines[-2] in ("PLAN: complete", "PLAN: gaps") \
            and lines[-1] in ("OVERALL: approve", "OVERALL: needs-attention")
    returned = [e for e in found if _allowed_review(root, dispatch, e, ref) and verdict(e)]
    require(len(returned) == 1, f"{report} must hold exactly one plan review returned by another model family or "
                                f"authorized Codex self-review ending PLAN: complete or gaps, then OVERALL: approve "
                                f"or needs-attention, not "
                                f"{len(returned)}: {ref}")
    (entry,) = returned
    candidate = entry["candidate"]
    if commits is None or candidate not in commits:
        commit_ok(root, candidate)
    return {"report": report, "candidate": candidate, "reviewer": entry["reviewer"], "model": entry["model"],
            "effort": entry["effort"], "lenses": entry["lenses"] or []}


_CAT_FILE = {}


@atexit.register
def _close_cat_files():
    """End each `git cat-file --batch` cleanly: its input closed so it exits, its pipes closed, the process reaped."""
    for proc in _CAT_FILE.values():
        for stream in (proc.stdin, proc.stdout):
            try:
                stream.close()
            except OSError:
                pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    _CAT_FILE.clear()


def _object_at(root, spec, kind=b"blob"):
    """The bytes of the `kind` object `spec` names (`<rev>:<path>` for a blob) through one `git cat-file --batch` per
    repository, or None when there is none."""
    key = str(root)
    proc = _CAT_FILE.get(key)
    if proc is None or proc.poll() is not None:
        proc = _CAT_FILE[key] = subprocess.Popen(["git", "-C", key, "cat-file", "--batch"], stdin=subprocess.PIPE,
                                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    proc.stdin.write(spec.encode("utf-8") + b"\n")
    proc.stdin.flush()
    header = proc.stdout.readline().split()
    if len(header) != 3:
        return None
    data = proc.stdout.read(int(header[2]))
    proc.stdout.read(1)
    return data if header[1] == kind else None


def _after_started_line(root, todo, body, ref, candidate):
    """The plan candidate and one of its parents both hold the section's Started line in `todo`, so the candidate is a
    commit after the one that recorded it (through any parent: a merge can bring the Started commit in as its second)."""
    started = STARTED.search(body or "")
    if started is None:
        return False
    line, number = started[0].rstrip("\r"), ref.rsplit("§", 1)[1]

    def holds(rev):
        data = _object_at(root, f"{rev}:{todo}")
        section = section_text(data.decode("utf-8", "replace"), number) if data is not None else None
        return section is not None and line in section.splitlines()
    commit = _object_at(root, candidate, b"commit") or b""
    head = commit.split(b"\n\n", 1)[0].splitlines()
    parents = [x.split()[1].decode("ascii") for x in head if x.startswith(b"parent ")]
    return holds(candidate) and any(holds(parent) for parent in parents)


def plan_after_started(root, todo, body, ref, candidate):
    """The plan was reviewed before the build began: its candidate is the build start or an ancestor of it (None), or,
    for a section with an explicit `> **Started:**` line, a later commit after which nothing that defines or builds the
    feature moved (`quiet_since_start`), returned as the receipt's `plan.after_started` evidence."""
    start = build_start(root, todo, body, ref)
    ancestor = subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", candidate, start],
                              capture_output=True, timeout=30)
    if ancestor.returncode == 0:
        return None
    # The fallback start is the first commit that built the section, so nothing after it can precede the build.
    require(STARTED.search(body or "") is not None,
            f"the plan review's candidate {candidate} is not the commit the build began at ({start}) or an ancestor "
            f"of it: review the plan before the build: {ref}")
    return {"start": start, "commits": quiet_since_start(root, todo, ref, start, candidate)}


def plan_candidate(root, rows, ref, candidate, findings=None):
    """What `stamp` would make of a plan review whose candidate is `candidate`, before the review is paid for (D00 T01
    §30): the same `commit_ok` and `plan_after_started` the stamp runs. Returns the `plan.after_started` evidence the
    receipt would record (None when the candidate is the build start or an ancestor of it); raises the stamp's own
    refusal otherwise. With `findings` (the file the review is to be recorded in), it must be the section's own findings
    file, exactly as `plan_record` requires of `--plan`."""
    require(ref in rows, f"no such section: {ref}")
    row = rows[ref]
    if findings is not None:
        expected = section_findings(root, ref)
        require(findings == expected,
                f"--plan must be the section's own findings file {expected}, not {findings}: {ref}")
    commit_ok(root, candidate)
    return plan_after_started(root, row.path, row.body, ref, candidate)


def pin_schedule(root, sha, ref):
    """The [schedule] of the reviewer pin committed at `sha`, loaded by the dispatcher's own `load_pin`."""
    shown = subprocess.run(["git", "-C", str(root), "show", f"{sha}:{PIN}"], capture_output=True, timeout=30)
    require(shown.returncode == 0, f"no reviewer pin {PIN} at {sha}: {ref}")
    dispatch = review_dispatch()
    try:
        pin = dispatch.load_pin(PIN, data=shown.stdout)
    except dispatch.Refused as exc:
        raise Refused(f"the reviewer pin at {sha} does not load: {exc}: {ref}") from None
    require("schedule" in pin, f"the reviewer pin at {sha} has no [schedule] to check the reviews against: {ref}")
    return pin["schedule"]


_PIN_SCHEDULES = {}
_COMMITTED_PINS = {}


def committed_pins(root):
    """Every blob a commit in the history of HEAD (and MERGE_HEAD while a merge is being concluded, as `_tips` reads
    it; D00 T01 §22) has held at the pin's path, merge resolutions included: what a fresh clone of this history can
    read back. A blob that is only in the object store (staged, then replaced before a commit) is not among them."""
    tips = _tips(root)
    head = subprocess.run(["git", "-C", str(root), "rev-parse", *tips], capture_output=True, text=True, timeout=30)
    require(head.returncode == 0, f"cannot read HEAD in {root} to find the committed reviewer pins")
    key = (str(root), tuple(head.stdout.split()))
    if key not in _COMMITTED_PINS:
        # --full-history -m: a merge whose resolution wrote a pin of its own (differing from both parents) is listed
        # too, against each parent; plain path-limited history simplifies merges away (round 1).
        log = subprocess.run(["git", "-C", str(root), "log", "--format=", "--raw", "--no-abbrev", "--no-renames",
                              "--full-history", "-m", *tips, "--", PIN], capture_output=True, text=True, timeout=60)
        require(log.returncode == 0, f"cannot read the history of {PIN} in {root}")
        blobs = set()
        for line in log.stdout.splitlines():
            fields = line.split("\t", 1)[0].split()
            if line.startswith(":") and len(fields) >= 4:
                blobs.update(fields[2:4])
        _COMMITTED_PINS[key] = blobs
    return _COMMITTED_PINS[key]


# An exact `- Run:` time, as scripts/review-dispatch.py writes it: a date, a time and a zone. Anything looser (a date
# alone, no zone, `yesterday`) would let Git's permissive parser pick a pin (review of the fix, round 1).
RUN_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})")
_HISTORY = {}
_PIN_TIMELINE = {}


def _history(root):
    """{commit: (committer time, parents)} for every commit in the history of HEAD (and MERGE_HEAD), read once."""
    tips = _tips(root)
    head = subprocess.run(["git", "-C", str(root), "rev-parse", *tips], capture_output=True, text=True, timeout=30)
    require(head.returncode == 0, f"cannot read HEAD in {root} to find the pins in force")
    key = (str(root), tuple(head.stdout.split()))
    if key not in _HISTORY:
        log = subprocess.run(["git", "-C", str(root), "log", "--format=%H %ct %P", *tips],
                             capture_output=True, text=True, timeout=120)
        require(log.returncode == 0, f"cannot read the history of {root}")
        found = {}
        for line in log.stdout.splitlines():
            sha, when, *parents = line.split()
            found[sha] = (int(when), parents)
        _HISTORY[key] = found
    return _HISTORY[key]


def pins_at(root, run, ref, where):
    """The pin blobs a pass with no `- Pin:` line may have run under: every pin some commit in this history held at or
    before its Run time. Which branch the pass ran on is not recorded (refs are not history, and committer clocks
    skew), so any pin in force on some line by then is accepted, including one a later commit superseded. That is no
    looser than a `- Pin:` line, which may name any pin ever committed (`committed_pins`), and no time cut-off is
    possible: lanes went on writing passes without the line (D00 T01 §18, a8f22cad, 2026-10-30 11:01 UTC) until each
    merged it. An empty list means the pass predates this whole history. A pass whose Run is not an exact time, or ran
    when no commit held the pin, is refused (reviews of the fix, rounds 1 and 2)."""
    require(isinstance(run, str) and RUN_TIME.fullmatch(run) is not None,
            f"{where} has no exact Run time ({run!r}) to find the pin it ran under: {ref}")
    when = datetime.datetime.fromisoformat(run.replace("Z", "+00:00")).timestamp()
    times, sets = _pins_by_time(root)
    at = bisect.bisect_right(times, when)
    if not at:
        return []
    require(sets[at - 1], f"{where} ran at {run}, when no commit in this history held {PIN}: {ref}")
    return sorted(sets[at - 1])


def _pins_by_time(root):
    """Every commit's pin, read once in one batch: the commit times in order, and beside each the set of pins held by
    some commit at or before it, so `pins_at` answers each Run time with one search (validate reads hundreds)."""
    history = _history(root)
    key = (str(root), len(history), next(iter(history), ""))
    if key not in _PIN_TIMELINE:
        order = sorted(history, key=lambda sha: history[sha][0])
        batch = subprocess.run(["git", "-C", str(root), "cat-file", "--batch-check=%(objectname) %(objecttype)"],
                               input="".join(f"{sha}:{PIN}\n" for sha in order),
                               capture_output=True, text=True, timeout=120)
        require(batch.returncode == 0, f"cannot read {PIN} across the history of {root}")
        lines = batch.stdout.splitlines()
        require(len(lines) == len(order), f"reading {PIN} across the history of {root} returned a short answer")
        times, sets, held = [], [], frozenset()
        for sha, line in zip(order, lines):
            if line.endswith(" blob") and line.split()[0] not in held:
                held = held | {line.split()[0]}
            times.append(history[sha][0])
            sets.append(held)
        _PIN_TIMELINE[key] = (times, sets)
    return _PIN_TIMELINE[key]


def _pin_schedule(root, blob, ref, where, committed=False):
    """The [schedule] of a pin blob some commit in HEAD's history held (`committed`: the caller read it from that
    history, as `pins_at` does, so the check is not repeated for each of its candidates)."""
    require(committed or blob in committed_pins(root), f"{where} ran under pin {blob}, which no commit in this "
                                                       f"history holds (a pin never committed, or only staged): "
                                                       f"commit the pin before the review runs: {ref}")
    key = (str(root), blob)
    if key not in _PIN_SCHEDULES:
        shown = subprocess.run(["git", "-C", str(root), "cat-file", "blob", blob], capture_output=True, timeout=30)
        require(shown.returncode == 0, f"{where} ran under pin {blob}, which cannot be read back: {ref}")
        dispatch = review_dispatch()
        try:
            pin = dispatch.load_pin(PIN, data=shown.stdout)
        except dispatch.Refused as exc:
            raise Refused(f"the pin {blob} that {where} ran under does not load: {exc}: {ref}") from None
        require("schedule" in pin, f"the pin {blob} that {where} ran under has no [schedule]: {ref}")
        _PIN_SCHEDULES[key] = pin["schedule"]
    return _PIN_SCHEDULES[key]


def pass_schedules(root, entry, stamped, ref, where):
    """The [schedule]s a recorded pass may have run under (D00 T01 §18): that of the pin blob its `- Pin:` line names,
    read back from the repository; for a pass recorded before reviews carried the line, those of the pins in force
    when it ran (`pins_at`), since a pass keeps the schedule of the pin it ran under (.conclave/reviewers.toml;
    2026-10-31: D03 T04 §19's plan review ran at high on 10-29, the pin moved to medium on 10-31). Only a pass older
    than this whole history falls back to the stamped commit's. Only a pin some commit in HEAD's history held counts:
    one never committed, or only staged, is no evidence a fresh clone could check."""
    blob = entry.get("pin")
    if blob is not None:
        return [_pin_schedule(root, blob, ref, where)]
    blobs = pins_at(root, entry.get("run"), ref, where)
    return [_pin_schedule(root, b, ref, where, committed=True) for b in blobs] or [stamped]


def schedule_ok(root, data, ref, surface, risk="full"):
    """Every pass the receipt names ran at the effort and lenses the pin's schedule gave it: every attempt at the plan
    and completion reviews, and each round in each findings file, replayed through the dispatcher's own `scheduled`
    over the rounds recorded before it (outages, unauthorized self-reviews and replies without OVERALL do not advance the
    position). Each pass is held to the pin it recorded running under (`pass_schedule`); the final mode and the
    receipt's schedule stay the stamped commit's."""
    require(isinstance(surface, bool), f"the section's Surface is needed to check the review schedule: {ref}")
    dispatch = review_dispatch()
    schedule = data["schedule"]

    def steps(owns, *args, **kwargs):
        """Each candidate pin's scheduled step for a pass; a pin that cannot schedule it (a light section under a pin
        with no light step) is no candidate, and only when none can is its refusal raised."""
        found, first = [], None
        for own in owns:
            try:
                found.append(dispatch.scheduled(own, *args, **kwargs))
            except dispatch.Refused as exc:
                first = first or exc
        if not found:
            raise first
        return found

    reviewers = dispatch.load_pin(Path(root) / ".conclave" / "reviewers.toml")["reviewers"]

    def agy_pass(recorded):
        """An Antigravity reviewer is sent no effort: its model id carries it (`gemini-4-argon-medium`), so the
        dispatcher records none (`run`, `effort = None if reviewer["cli"] == "agy"`). A returned pass names its cli; an
        attempt every reviewer of which timed out or failed names them in its skipped lines."""
        if recorded.get("cli"):
            return recorded["cli"] == "agy"
        names = [s.get("reviewer") for s in recorded.get("skipped") or []]
        return bool(names) and all(reviewers.get(n, {}).get("cli") == "agy" for n in names)

    def check(where, recorded, expectations):
        """The pass matches the step one of the pins it may have run under scheduled (one, for a pass with a Pin). An
        Antigravity pass is held to the lenses alone, with no effort recorded, as the dispatcher ran it."""
        if recorded.get("policy") is not None:
            _allowed_review(root, dispatch, recorded, ref)
        got = (recorded["effort"], list(recorded["lenses"] or []))
        if agy_pass(recorded):
            if got[0] is None and any(got[1] == e["lenses"] for e in expectations):
                return
        elif any(got == (e["effort"], e["lenses"]) for e in expectations):
            return
        expected = expectations[0]
        position = f" (position {expected['position']}{', escalated' if expected['escalated'] else ''})" \
            if expected["position"] else ""
        others = "".join(f" or {e['effort']} with {e['lenses']}" for e in expectations[1:])
        require(False, f"{where} ran at {got[0]} with lenses {got[1]}; the schedule expects {expected['effort']} "
                       f"with {expected['lenses']}{position}{others}: {ref}")
    # Every attempt the one-pass files record, outages and self-reviews included, ran at that pass's scheduled step.
    plan_report = data["plan"]["report"]
    for entry in dispatch.read_plans((Path(root) / plan_report).read_bytes().decode("utf-8")):
        where = f"the plan review in {plan_report}"
        check(where, entry, steps(pass_schedules(root, entry, schedule, ref, where), "plan", [], surface))
    completion = data["completion"]["report"]
    completions = dispatch.read_completions((Path(root) / completion).read_bytes().decode("utf-8"))
    require(sum(1 for e in completions if _allowed_review(root, dispatch, e, ref)
                and e["candidate"] == data["completion"]["candidate"]
                and completion_verdict(e["review"]) in ("COMPLETION: complete", "COMPLETION: gaps")) == 1,
            f"{completion} must hold exactly one returned completion review: {ref}")
    for entry in completions:
        where = f"the completion review in {completion}"
        check(where, entry, steps(pass_schedules(root, entry, schedule, ref, where), "completion", [], surface,
                                  policy=entry.get("policy") or "legacy"))
    if "reconciliation" in data:
        report = data["reconciliation"]["report"]
        for entry in dispatch.read_reconciliations((Path(root) / report).read_bytes().decode("utf-8")):
            where = f"the reconciliation review in {report}"
            owns = pass_schedules(root, entry, schedule, ref, where)
            check(where, entry, steps(owns, "reconciliation", [], surface))
    if "final" in schedule and "final" in data:
        final = data["final"]["report"]
        for entry in dispatch.read_finals((Path(root) / final).read_bytes().decode("utf-8")):
            where = f"the final review in {final}"
            owns = [own for own in pass_schedules(root, entry, schedule, ref, where) if "final" in own]
            # A pass whose own pin had the final step off or absent was not a final review that pin scheduled.
            require(owns, f"{where} ran under a pin with no final step: {ref}")
            check(where, entry, steps(owns, "final", [], surface))
    for report in dict.fromkeys(r["report"] for r in data["reviews"]):
        recorded = dispatch.read_rounds((Path(root) / report).read_bytes().decode("utf-8"))
        for i, entry in enumerate(recorded):
            # Each round against the schedule it ran on; a change of risk starts the rounds again (D00 T01 §15).
            where = f"{report} round {entry['number']}"
            # A round is held to the step its own dispatcher scheduled: today's, which sets aside a closing second
            # reading block when it counts earlier rounds, or, for a round run before that rule reached main
            # (LEGACY_COUNT_UNTIL), the one before it, which did not (D08 T01 §3). Bounded so a new loop can never
            # take the older count to skip an escalation (review of the change, round 1).
            owns = pass_schedules(root, entry, schedule, ref, where)
            args = ("round", recorded[:i], surface, dispatch.round_schedule(entry))
            legacy = steps(owns, *args, returned=dispatch.legacy_returned_review) if before_legacy_cutoff(entry) else []
            check(where, entry, steps(owns, *args) + legacy)
        last = dispatch.round_schedule(recorded[-1]) if recorded else risk
        require(last == risk, f"{report}'s last rounds ran on the {last} schedule, but the section's Risk is {risk}: "
                              f"run its rounds again, which start from round 1 on the {risk} schedule with the "
                              f"earlier findings kept: {ref}")


def receipt_data_ok(data, ref, stamp_sha, root=None, building=False, commits=None, surface=None, risk="full", todo=None,
                    body=None):
    """building: stamp's first pass over its arguments, before it adds rounds_spent and round_cap. `todo` and `body`:
    the section's TODO file and text, which a plan review after Started is proved against again."""
    require(isinstance(data, dict), f"receipt is not an object: {ref}")
    require(data.get("ref") == ref and data.get("implementation_sha") == stamp_sha,
            f"receipt does not match its stamp: {ref}")
    rounds = data.get("reviews")
    two_pass = data.get("review_policy") == "codex-two-pass-v1"
    require("review_policy" not in data or two_pass, f"unknown receipt review policy: {ref}")
    require(isinstance(rounds, list) and (rounds == [] if two_pass else bool(rounds)) and all(
        isinstance(r, dict) and type(r.get("round")) is int and r["round"] >= 1
        and isinstance(r.get("report"), str) and r["report"]
        and isinstance(r.get("verdict"), str) and r["verdict"] in VERDICTS for r in rounds),
        f"receipt has no valid review rounds (verdict one of {', '.join(sorted(VERDICTS))}): {ref}")
    require(all(r["round"] > SEVERITY_CUTOFF_ROUND for r in rounds if r["verdict"] == "stopped-low-severity"),
            f"stopped-low-severity is allowed only after round {SEVERITY_CUTOFF_ROUND}: {ref}")
    if root is not None:
        for r in rounds:
            report_ok(root, r["report"], ref)
    # Newer receipts record the rounds spent against the cap, and what was done when a review
    # stopped at the cap; earlier receipts carry neither field.
    if "rounds_spent" not in data and not building:
        # Dropping the field must not dodge the checks below: an old receipt holds only what the old process wrote,
        # and is one of the receipts LEGACY_RECEIPTS froze.
        require(all(r["verdict"] in LEGACY_VERDICTS for r in rounds)
                and "round_cap" not in data and "cap_outcome" not in data,
                f"a receipt without rounds_spent may only hold verdicts {', '.join(sorted(LEGACY_VERDICTS))}: {ref}")
        require(root is not None and legacy_receipts(root).get(ref) == receipt_digest(data),
                f"a receipt without rounds_spent must be one of the old receipts {LEGACY_RECEIPTS} freezes: {ref}")
    if "rounds_spent" in data:
        spent, cap = data.get("rounds_spent"), data.get("round_cap")
        require(type(spent) is int and spent >= max((r["round"] for r in rounds), default=0)
                and type(cap) is int and ((spent == 0 and cap == 0) if two_pass
                    else cap in EARLIER_CAPS | {1, REVIEW_ROUND_CAP, LIGHT_ROUND_CAP}),
                f"receipt rounds_spent or round_cap is invalid: {ref}")
        # A cap stop is the current cap, reached: stopped-at-3, -8 and -13 belong to receipts older than this field.
        require(all(r["verdict"] == f"stopped-at-{cap}" for r in rounds if r["verdict"].startswith("stopped-at-")),
                f"a stopped-at verdict must be stopped-at-{cap}: {ref}")
        if root is not None:
            # A claimed round is one scripts/review-dispatch.py recorded with a reviewer, read by the dispatcher's own
            # reader, so a report it would refuse is no evidence here either.
            # The reviewer must also be of another model family than the writer (a self-review is not a round), and
            # must have returned a review: one ending in the prompt's OVERALL approve or needs-attention line, not an
            # empty or blocked reply. Reports are read as the dispatcher wrote them, "\r" bytes and all.
            dispatch = review_dispatch()
            for report in dict.fromkeys(r["report"] for r in rounds):
                recorded = dispatch.read_rounds((Path(root) / report).read_bytes().decode("utf-8"))
                require(recorded is not None, f"{report} is not a findings file the dispatcher can read: {ref}")
                # The dispatcher numbers rounds 1, 2, 3 in order; a repeated or reordered number would let one round
                # stand in for others when they are keyed by number below.
                numbers = [e["number"] for e in recorded]
                require(numbers == list(range(1, len(numbers) + 1)),
                        f"{report} must number its rounds 1 to {len(numbers)} in order, once each: {ref}")
                # A returned review: a reviewer of another model family than the writer ran and replied with the
                # prompt's OVERALL approve or needs-attention line. Outages, self-reviews, empty and blocked replies are
                # recorded rounds but not reviews: they earn no stop and end no loop.
                reviewed = {e["number"]: e for e in recorded if dispatch.returned_review(e)}
                require(reviewed, f"{report} holds no returned review: {ref}")
                # The cap bounds every loop, however it ends: a clean round after the cap's last review is past it.
                finals = [f for f in (dispatch.read_finals((Path(root) / report).read_bytes().decode("utf-8")) or [])
                          if f["reviewer"]]
                final_run = finals[0]["run"] if finals else None
                after = [n for n, e in reviewed.items() if final_run is not None and e["run"] > final_run]
                require(len(reviewed) - len(after) <= cap,
                        f"{report} holds {len(reviewed) - len(after)} returned reviews, over the {cap}-round cap: {ref}")
                require(len(after) <= POST_FINAL_CAP,
                        f"{report} holds {len(after)} rounds after its final review, over the {POST_FINAL_CAP} that may "
                        f"prove its fix: {ref}")
                claimed = sorted((r for r in rounds if r["report"] == report), key=lambda r: r["round"])
                for r in claimed:
                    e = reviewed.get(r["round"])
                    last = (dispatch.verdict_lines(e["review"]) or [""])[-1] if e else ""
                    require(e is not None and _allowed_review(root, dispatch, e, ref)
                            and last == ("OVERALL: approve" if r["verdict"] == "clean" else "OVERALL: needs-attention"),
                            f"round {r['round']} is not a review returned by another model family or authorized "
                            f"Codex self-review with a verdict "
                            f"matching {r['verdict']} (clean needs OVERALL: approve, any other needs-attention) in "
                            f"{report}: {ref}")
                    # A severity stop is for a round whose findings are all P3 or advisory. The reviewer, who tags each
                    # finding (an untagged one counts as P1), declares the highest on the line before OVERALL; reading
                    # severities back out of free prose would guess where the reviewer already said.
                    lines = dispatch.verdict_lines(e["review"])
                    require(r["verdict"] != "stopped-low-severity" or (len(lines) >= 2 and lines[-2] == "HIGHEST: P3"),
                            f"round {r['round']} does not declare HIGHEST: P3 before its OVERALL line, so it cannot "
                            f"stop on severity: {ref}")
                    # Stopping is earned by reviews returned: a round that returned no review (an outage) does not
                    # count toward the severity cutoff or the cap.
                    returned = sum(1 for n in reviewed if n <= r["round"])
                    require(r["verdict"] != "stopped-low-severity" or returned > SEVERITY_CUTOFF_ROUND,
                            f"round {r['round']} follows only {returned} returned reviews, so it cannot stop on "
                            f"severity before {SEVERITY_CUTOFF_ROUND + 1}: {ref}")
                    require(not r["verdict"].startswith("stopped-at-") or returned == cap,
                            f"round {r['round']} follows {returned} returned reviews; a cap stop is the round that "
                            f"returns review {cap}: {ref}")
                # Each findings file is one review loop, and the loop's end is its last reviewed round: the receipt
                # must name it, and it must be clean or a stop, so no later failing review can be left out. Nothing may
                # be recorded after it either: a round run later (even one that returned no review) was run on work
                # the earlier verdict does not cover, so an outage at the end means no stamp until a review returns.
                require(max(reviewed) == len(recorded),
                        f"the review loop in {report} ends with round {len(recorded)}, which returned no review; "
                        f"run another round before stamping: {ref}")
                require(claimed[-1]["round"] == max(reviewed)
                        and (claimed[-1]["verdict"] == "clean" or claimed[-1]["verdict"].startswith("stopped-")
                             or (reviewed[max(reviewed)].get("policy") == "codex-self-review"
                                 and claimed[-1]["verdict"] == "fixed")),
                        f"the review loop in {report} must end at its last reviewed round ({max(reviewed)}), clean or "
                        f"stopped, and the receipt must name that round: {ref}")
            # The count the receipt reports is the count the findings files hold, so query rounds sums real rounds.
            require(spent == rounds_recorded(root, rounds),
                    f"receipt rounds_spent {spent} is not the {rounds_recorded(root, rounds)} rounds its findings files "
                    f"record: {ref}")
        stopped = any(r["verdict"].startswith("stopped-") for r in rounds)
        outcome = data.get("cap_outcome")
        require((isinstance(outcome, str) and bool(outcome.strip())) == stopped,
                f"receipt needs cap_outcome exactly when a review stopped (at the cap or on severity): {ref}")
    # Newer receipts record the completion review; a receipt without the field predates it. The
    # record must be what the findings file still says, so an edit to either refuses.
    if "completion" in data:
        recorded = data["completion"]
        require(isinstance(recorded, dict) and set(recorded) == {"report", "verdict", "candidate", "reviewer", "model",
                                                                 "filed"},
                f"receipt completion is malformed: {ref}")
        if root is not None:
            require(completion_record(root, recorded, ref, stamp_sha, commits if commits is not None else set(),
                                      reconciliation=data.get("reconciliation"))
                    == recorded, f"receipt completion does not match its findings file {recorded['report']}: {ref}")
    if "reconciliation" in data:
        require("completion" in data and "plan" in data,
                f"reconciliation requires the original completion and plan: {ref}")
        if root is not None:
            require(reconciliation_record(root, data["reconciliation"], ref, stamp_sha) == data["reconciliation"],
                    f"receipt reconciliation does not match its findings: {ref}")
    # Newer receipts record the plan review and the pin's schedule, and every pass is replayed
    # against that schedule. A receipt without them predates the requirement and must be frozen by digest, so
    # dropping both fields from a new receipt does not dodge the checks.
    require(("plan" in data) == ("schedule" in data), f"receipt records plan and schedule together or neither: {ref}")
    if "plan" in data and not building:
        recorded = data["plan"]
        require(isinstance(recorded, dict) and set(recorded) - {"after_started"} == PLAN_KEYS,
                f"receipt plan is malformed: {ref}")
        after = recorded.get("after_started")
        require(after is None or (isinstance(after, dict) and set(after) == {"start", "commits"}
                                  and isinstance(after["commits"], list) and after["commits"]
                                  and after["commits"][-1] == recorded["candidate"]),
                f"receipt plan after_started must name the build start and the commits from it to the candidate: {ref}")
        require("completion" in data and "rounds_spent" in data,
                f"a receipt with a plan review also records its completion review and rounds_spent: {ref}")
        require(isinstance(data["schedule"], dict), f"receipt schedule is malformed: {ref}")
        mode = final_mode(data["schedule"])
        require(("final" in data and mode in ("required", "optional"))
                or ("final" not in data and mode in (None, "optional", "off")),
                f"a receipt records a final review when its schedule requires one, may when it is optional, and never "
                f"when it is off or absent: {ref}")
        if "final" in data:
            require(isinstance(data["final"], dict) and set(data["final"]) == FINAL_KEYS, f"receipt final is malformed: {ref}")
            if root is not None:
                require(final_record(root, data["final"], ref, stamp_sha, commits if commits is not None else set())
                        == data["final"], f"receipt final does not match its findings file {data['final']['report']}: {ref}")
        if root is not None:
            # A receipt whose plan candidate follows the Started commit must carry the evidence; this cheap test (the
            # candidate and its first parent both hold the section's Started line) catches it dropped or nulled.
            require(after is not None or todo is None or not _after_started_line(root, todo, body, ref,
                                                                                    recorded["candidate"]),
                    f"receipt plan after_started is missing, but its candidate {recorded['candidate']} follows the "
                    f"commit that records the section's Started line: {ref}")
            # The evidence for a plan review after Started is rebuilt from the repository, never taken on trust.
            if after is not None:
                require(todo is not None, f"a receipt plan with after_started is checked against its section: {ref}")
                require(plan_after_started(root, todo, body, ref, recorded["candidate"]) == after,
                        f"receipt plan after_started is not the build start and the commits from it to the candidate "
                        f"{recorded['candidate']}: {ref}")
            require(plan_record(root, recorded["report"], ref, commits if commits is not None else set())
                    == {k: v for k, v in recorded.items() if k != "after_started"},
                    f"receipt plan does not match its findings file {recorded['report']}: {ref}")
            require(pin_schedule(root, stamp_sha, ref) == data["schedule"],
                    f"receipt schedule is not the [schedule] in {PIN} at the stamped commit: {ref}")
            self_review_chain_ok(root, data, ref)
            schedule_ok(root, data, ref, surface, risk)
    elif not building:
        frozen = root is not None and (legacy_receipts(root).get(ref) == receipt_digest(data)
                                       or receipts_before_plan(root).get(ref) == receipt_digest(data))
        require(frozen, f"a receipt without a plan review must be one of the old receipts {LEGACY_RECEIPTS} freezes: "
                        f"{ref}")
    checks = data.get("checks")
    require(isinstance(checks, list) and checks and all(isinstance(c, str) and c.strip() for c in checks),
            f"receipt has no checks: {ref}")
    require(isinstance(data.get("date"), str)
            and re.fullmatch(r"\d{4}-\d{2}-\d{2}", data["date"]) is not None,
            f"receipt has no valid date: {ref}")


def adjacency_of(body, relative, domain, todo):
    """Parse the one **Adjacency:** line inside ## Outcome. Returns {key: (state, owner_ref_or_None)}."""
    require("## Outcome\n" in body, f"missing Outcome: {relative}")
    outcome = body.split("## Outcome\n", 1)[1].split("\n## ", 1)[0]
    lines = re.findall(r"^\*\*Adjacency:\*\*\s*(.+)$", outcome, re.M)
    require(len(lines) == 1, f"exactly one Adjacency line inside Outcome required: {relative}")
    result = {}
    blanket = re.fullmatch(r"all=not-applicable\s*\((.+)\)", lines[0].strip())
    if blanket:
        require(blanket[1].strip(), f"adjacency blanket needs a reason: {relative}")
        return {key: ("not-applicable", None) for key in ADJACENCY_KEYS}
    entries = [e.strip() for e in re.split(r";\s*(?=[a-z]+=)", lines[0]) if e.strip()]
    for entry in entries:
        m = re.fullmatch(r"([a-z]+)=applicable(?:\s*@\s*(.+))?", entry)
        if m:
            key, owner = m[1], None
            require(key in ADJACENCY_KEYS and key not in result,
                    f"adjacency key unknown or duplicated ({key}): {relative}")
            if m[2]:
                owner = find_ref(m[2], domain, todo)
                require(owner is not None, f"adjacency owner does not parse ({entry}): {relative}")
            result[key] = ("applicable", owner)
            continue
        m = re.fullmatch(r"([a-z]+)=not-applicable\s*\(([^)]+)\)", entry)
        require(m is not None, f"adjacency entry malformed ({entry}): {relative}")
        key = m[1]
        require(key in ADJACENCY_KEYS and key not in result,
                f"adjacency key unknown or duplicated ({key}): {relative}")
        require(m[2].strip(), f"adjacency not-applicable needs a reason ({key}): {relative}")
        result[key] = ("not-applicable", None)
    require(set(result) == set(ADJACENCY_KEYS),
            f"adjacency must declare every key exactly once (missing "
            f"{', '.join(sorted(set(ADJACENCY_KEYS) - set(result)))}): {relative}")
    return result


def xrefs_of(body, domain, todo):
    refs = []
    for line in body.splitlines():
        # Every XREF on the line, each read strictly: a malformed one refuses instead of resolving to whatever
        # reference text happens to follow it.
        for tail in line.split("-> XREF:")[1:]:
            ref = xref_target(tail, domain, todo)
            require(ref is not None, f"XREF must name exactly one well-formed section: {line.strip()}")
            refs.append(ref)
    return refs


def graph(root=ROOT):
    """Parse every TODO file strictly; a malformed row or section refuses, it is never read as empty."""
    root = Path(root)
    plan_config(root)
    lanes(root)
    legacy_receipts(root)  # a malformed freeze list refuses even before any old receipt is read against it
    sections, ids, files = {}, {}, {}
    head_commits = None
    filed_gaps = {}
    paths = sorted((root / "todo").glob("[0-9][0-9]-*/TODO-*.md"))
    require(bool(paths), "canonical TODO tree is missing or empty")
    for path in paths:
        require(not path.is_symlink(), f"symlink TODO: {path}")
        relative = path.relative_to(root).as_posix()
        name = re.fullmatch(r"TODO-(\d{2})-[a-z0-9-]+\.md", path.name)
        require(name is not None, f"invalid TODO filename: {relative}")
        d, t = path.parent.name[:2], name[1]
        front, body = front_matter(read_text(path), relative)
        required = {"schema_version", "id", "domain", "status", "title"}
        optional = {"depends_on", "frozen", "track", "superseded_by"}
        require(required <= front.keys() and not front.keys() - required - optional,
                f"frontmatter fields: {relative}")
        require(front["schema_version"] == "1" and front["domain"] == path.parent.name,
                f"schema/domain mismatch: {relative}")
        require(re.fullmatch(r"[a-z][a-z0-9-]{0,58}[a-z0-9]", front["id"])
                and front["id"] not in ids, f"invalid/duplicate id: {relative}")
        require(front["status"] in STATUSES, f"unknown status: {relative}")
        frozen = front.get("frozen", "false")
        require(frozen in {"true", "false"}, f"frozen must be true or false: {relative}")
        file_deps = json.loads(front.get("depends_on", "[]"))
        require(isinstance(file_deps, list) and all(isinstance(x, str) for x in file_deps),
                "depends_on must be a JSON string array")
        require(re.search(r"\A\n*# TODO-\d{2} -- .+\n", body) is not None,
                f"missing TODO heading: {relative}")
        ids[front["id"]] = relative
        files[relative] = (front, file_deps, [], xrefs_of(body, d, t),
                           adjacency_of(body, relative, d, t))
        for label in ("Goal", "Current state"):
            field(body, label)
        for label in ("Inputs", "Outcome", "Implementation Order", "Verification"):
            require(f"## {label}\n" in body, f"missing {label}: {relative}")
        table = body.split("## Implementation Order\n", 1)[1].split("\n## ", 1)[0]
        rows, orders = {}, []
        for line in table.splitlines():
            if not line.startswith("|"):
                # A row written without its leading pipe would otherwise vanish from the graph.
                require("|" not in line, f"implementation table line without a leading pipe: {relative}")
                continue
            m = ROW.fullmatch(line)
            if not m:
                require("§" not in line and "[" not in line,
                        f"malformed implementation row: {relative}")
                continue
            order, n = int(m[1]), int(m[2])
            require(n not in rows, f"duplicate section row: {relative} §{n}")
            orders.append(order)
            rows[n] = m
        require(rows and orders == list(range(1, len(rows) + 1)),
                f"invalid implementation order: {relative}")
        require(len(rows) <= MAX_SECTIONS_PER_FILE,
                f"over {MAX_SECTIONS_PER_FILE} sections; split into a new file: {relative}")
        headings = list(re.finditer(r"^## (\d+)\. (.+)$", body, re.M))
        numbers = [int(m[1]) for m in headings]
        require(all(n >= 1 for n in numbers) and numbers == sorted(set(numbers)) and set(numbers) == set(rows),
                f"row/body mismatch: {relative}")
        require(body.rfind("## Verification\n") > headings[-1].start(),
                f"Verification must follow numbered sections: {relative}")
        # The level-two headings are exactly the format's, once each and in order: any other, or a repeat, would end
        # the section above it early and hide what follows from the graph.
        level_two = re.findall(r"^##(?:[ \t].*)?$", body, re.M)
        numbered = [line for line in level_two if re.fullmatch(r"## \d+\. \S.*", line)]
        require(level_two == ["## Inputs", "## Outcome", "## Implementation Order", *numbered, "## Verification"],
                f"level-two headings must be Inputs, Outcome, Implementation Order, the sections and Verification, "
                f"once each and in that order: {relative}")
        for h in headings:
            n = int(h[1])
            section_body = body[h.end():].split("\n## ", 1)[0].strip()
            ref = f"D{d} T{t} §{n}"
            require(ref not in sections, f"duplicate address: {ref}")
            deliverable, title = rows[n][3].strip(), h[2].strip()
            require(len(deliverable) <= MAX_DELIVERABLE_LEN and len(title) <= MAX_DELIVERABLE_LEN,
                    f"deliverable/title over {MAX_DELIVERABLE_LEN} chars (wraps raw md table): {ref}")
            phase = field(section_body, "Phase")
            require(phase.isdigit() and int(phase) in PHASES, f"invalid Phase: {ref}")
            raw = field(section_body, "Needs")
            needs = [] if raw == "none" else [v.strip() for v in raw.split(",")]
            require(len(needs) == len(set(needs)) and set(needs) <= NEEDS,
                    f"unknown/duplicate Needs: {ref}")
            dep = rows[n][4].strip()
            deps = [] if dep == "--" else [normalize(v, d, t) for v in dep.split(",")]
            require(len(deps) == len(set(deps)), f"duplicate dependency: {ref}")
            for line in section_body.splitlines():
                # Every checklist-shaped line (a list marker and a box, quoted, numbered or indented) must be the one
                # form the graph counts, so no item can hide in another spelling.
                if re.match(r"^[\s>]*(?:[-*+]|\d+[.)])[ \t]*\[[^\]\n]*\](?!\()", line):
                    require(re.fullmatch(r"- \[([ x])\] \S.*", line) is not None,
                            f"malformed checklist item: {ref}")
            require("**Build order:**\n" in section_body and "\n- [" in section_body,
                    f"executable Build order required: {ref}")
            after_bo = section_body.split("**Build order:**\n", 1)[1]
            for line in after_bo.splitlines():
                if re.match(r"^\s*[-*+](\s|$)", line):
                    require(re.fullmatch(r"- \[([ x])\] \S.*", line) is not None,
                            f"malformed checklist item: {ref}")
            build_block = after_bo.split("\n- [", 1)[0]
            non_empty_bo = [line for line in build_block.splitlines() if line.strip()]
            build_matches = list(re.finditer(r"^(\d+)\. (\S.+)$", build_block, re.M))
            build_steps = [int(m[1]) for m in build_matches]
            require(build_steps and len(build_steps) == len(non_empty_bo)
                    and build_steps == list(range(1, len(build_steps) + 1))
                    and all("Done when:" in m[2] for m in build_matches),
                    f"executable Build order required: {ref}")
            checks = re.findall(r"^- \[([ x])\] (.+)$", section_body, re.M)
            require(2 <= len(checks) <= MAX_ITEMS_PER_SECTION
                    and checks[-1][1].startswith("Commit:")
                    and not any(c[1].startswith("Commit:") for c in checks[:-1]),
                    f"2-{MAX_ITEMS_PER_SECTION} items (at least one work item, Commit last) required: {ref}")
            require("`" in field(section_body, "Test checkpoint"),
                    f"runnable Test checkpoint required: {ref}")
            surface = field(section_body, "Surface")
            require(surface in {"yes", "no"}, f"Surface must be yes/no: {ref}")
            risk = field(section_body, "Risk", False) or "full"
            require(risk in {"full", "light"}, f"Risk must be full/light: {ref}")
            if risk == "light":
                named = light_paths(section_body)
                places = PRODUCT_PLACES_BUT_PAGES if LIGHT_INCLUDES_PAGES else PRODUCT_PLACES
                prefixes = LIGHT_PREFIXES + (PAGES_LIGHT_PREFIXES if LIGHT_INCLUDES_PAGES else ())
                require(bool(named) and all(light_path(p) for p in named) and not places.search(section_body),
                        f"Risk light needs every path the section names to be tooling, tests or docs "
                        f"({', '.join(prefixes)}), and none to touch a guarded area: {ref}")
            if surface == "yes":
                for label in ("Fidelity", "Job", "Treatment", "Chrome"):
                    field(section_body, label)
            freeze_check = field(section_body, "Freeze check", False)
            require(bool(freeze_check) == (frozen == "true"),
                    f"Freeze check must match frozen frontmatter: {ref}")
            done = rows[n][5] == "x"
            stamp_line = field(section_body, "Verified", False)
            receipt = field(section_body, "Review", False).strip("`")
            require(done == bool(stamp_line) == bool(receipt),
                    f"checkbox/stamp/receipt mismatch: {ref}")
            if done:
                require(all(x[0] == "x" for x in checks), f"unfinished stamped checklist: {ref}")
                require(not set(needs) & WAITING, f"stamped section has a waiting Need: {ref}")
                m = re.fullmatch(r"\d{4}-\d{2}-\d{2} \| §" + str(n) + r" \| ([0-9a-f]{40})", stamp_line)
                require(m is not None, f"invalid stamp: {ref}")
                if head_commits is None:
                    head_commits = _head_commits(root)
                data = receipt_ok(root, receipt, ref, m[1], head_commits, surface=surface == "yes", risk=risk,
                                  todo=relative, body=section_body)
                if "completion" in data:
                    filed_gaps[ref] = data["completion"]["filed"]
            sections[ref] = Section(ref, relative, n, h[2], int(phase), deps, needs, done,
                                    front["status"], section_body, receipt, int(rows[n][1]))
            files[relative][2].append(ref)
    for relative, (front, file_deps, refs, xrefs, adjacency) in files.items():
        require(len(set(file_deps)) == len(file_deps), f"duplicate file dependencies: {relative}")
        for dep in file_deps:
            require(dep in ids and ids[dep] != relative,
                    f"unresolved/self file dependency: {relative}")
            for ref in refs:
                sections[ref].depends = list(dict.fromkeys(
                    sections[ref].depends + files[ids[dep]][2]))
        if front["status"] == "superseded":
            successor = front.get("superseded_by", "")
            require(successor in ids and ids[successor] != relative,
                    f"superseded TODO must name its successor: {relative}")
        else:
            require((front["status"] == "done") == all(sections[r].done for r in refs),
                    f"file status disagrees with stamps: {relative}")
        for key, (state, owner) in adjacency.items():
            if owner is not None:
                require(owner in sections, f"adjacency owner unresolved ({key} @ {owner}): {relative}")
        for target in xrefs:
            require(target in sections, f"unresolved XREF target {target}: {relative}")
            target_file = sections[target].path
            if target_file == relative:
                continue
            back = files[target_file][3]
            require(any(sections[b].path == relative for b in back if b in sections),
                    f"one-sided XREF {target} has no pointer back: {relative}")
    # Deferrals carry an owner or they are abandonments; a shipped owner makes a live deferral stale.
    for row in sections.values():
        # Only a blockquoted marker is read below; any other spelling would drop the deferral from every check.
        for line in row.body.splitlines():
            require(len(re.findall(r"\*\*(?:Deferred|Resolved):\*\*", line)) <= 1,
                    f"one Deferred or Resolved marker per line: {row.ref}")
            if re.search(r"\*\*(?:Deferred|Resolved):\*\*", line):
                require(re.match(r"> \*\*(?:Deferred|Resolved):\*\*[ \t]*\S", line) is not None,
                        f"a Deferred or Resolved marker must open a blockquote line and say something: {row.ref}")
        for marker in ("Deferred", "Resolved"):
            for line in re.findall(r"^> \*\*" + marker + r":\*\*[ \t]*(\S.*)$", row.body, re.M):
                owner = xref_target(line.split("-> XREF:", 1)[1], row.ref[1:3], row.ref[5:7]) \
                    if "-> XREF:" in line else None
                require(owner is not None and owner in sections,
                        f"{marker} without a resolving owner: {row.ref}")
                if marker == "Deferred":
                    require(not sections[owner].done,
                            f"stale deferral, owner {owner} shipped; close it as Resolved: {row.ref}")
    for ref, filed in filed_gaps.items():
        for target in filed:
            require(target in sections, f"completion gap filed as {target}, which does not resolve: {ref}")
    _index_coverage(root, files)
    visiting, visited = set(), set()
    for start in sections:
        if start in visited:
            continue
        stack = [(start, 0)]
        visiting.add(start)
        while stack:
            ref, idx = stack[-1]
            deps = sections[ref].depends
            if idx < len(deps):
                dep = deps[idx]
                stack[-1] = (ref, idx + 1)
                require(dep in sections, f"unresolved dependency: {dep}")
                require(dep not in visiting, f"dependency cycle: {dep}")
                require(sections[dep].phase <= sections[ref].phase,
                        f"prerequisite in later phase: {ref} -> {dep}")
                # A stamped section may sit on an open prerequisite only when an audit reopened that prerequisite
                # (its Unstamped note): the consumer is then suspect until the prerequisite re-stamps, not unstamped.
                require(not sections[ref].done or sections[dep].done
                        or re.search(r"^> \*\*Unstamped:\*\* ", sections[dep].body, re.M) is not None,
                        f"stamped section has open dependency: {ref}")
                if dep not in visited:
                    visiting.add(dep)
                    stack.append((dep, 0))
            else:
                stack.pop()
                visiting.remove(ref)
                visited.add(ref)
    return sections


def _index_coverage(root, files):
    root_index = root / "todo/TODO-00-INDEX.md"
    require(root_index.is_file(), "missing todo/TODO-00-INDEX.md")
    root_text = read_text(root_index)
    by_domain = {}
    for relative in files:
        by_domain.setdefault(Path(relative).parent.name, []).append(Path(relative).name)
    for domain, names in by_domain.items():
        index = root / "todo" / domain / "INDEX.md"
        require(index.is_file(), f"missing domain index: todo/{domain}/INDEX.md")
        text = read_text(index)
        for filename in names:
            require(filename in text, f"missing from domain index: {domain}/{filename}")
            require(f"{domain}/{filename}" in root_text, f"missing from root index: {domain}/{filename}")


def settled(ref, rows):
    """A prerequisite that holds: it and every section it depends on, however far back, are stamped. A stamp on top of
    an ancestor an audit reopened is suspect, so new work may not build on it."""
    stack, seen = [ref], set()
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        if not rows[current].done:
            return False
        stack.extend(rows[current].depends)
    return True


def disposition(row, rows):
    """0 ready, 3 already verified, 4 waiting (inactive file, open or suspect prerequisite, or a person to answer)."""
    if row.done:
        return 3
    if row.status != "active" or set(row.needs) & WAITING \
            or any(not settled(d, rows) for d in row.depends):
        return 4
    return 0


def ordered(sections):
    result, placed, pending = [], set(), sorted(
        sections, key=lambda r: (sections[r].phase, sections[r].path, sections[r].order))
    while pending:
        ref = next(r for r in pending if all(d in placed for d in sections[r].depends))
        result.append(ref)
        placed.add(ref)
        pending.remove(ref)
    return [sections[r] for r in result]


def markdown_table(headers, rows):
    cells = [headers, *rows]
    widths = [max(3, *(len(row[i]) for row in cells)) for i in range(len(headers))]

    def render(row):
        return "| " + " | ".join(cell.ljust(width) for cell, width in zip(row, widths)) + " |"

    return [render(headers), render(["-" * width for width in widths]),
            *(render(row) for row in rows)]


def lanes(root=ROOT):
    """The parallel lanes in todo/lanes.json, loaded strictly: each a branch, worked in its own worktree, that alone
    claims the domains (`DNN`), the TODO files and the single sections (`DNN TNN §N`) it lists; every other row is
    the main lane's. A listed section is how one row moves to another lane without being renumbered, so every ref
    that names it (a receipt's `- Filed:` line, an XREF) still resolves. Which rows are ready,
    the plan and its rendering stay the same on every branch: a lane decides only who may claim a row (`claimable`)
    and which rows its queries count (`in_lane`)."""
    path = Path(root) / LANES
    if not path.is_file():
        return {}
    try:
        data = json.loads(read_text(path))
    except ValueError as exc:
        raise Refused(f"unreadable {LANES}: {exc}") from None
    require(isinstance(data, dict) and set(data) == {"lanes"} and isinstance(data["lanes"], dict),
            f"{LANES} holds one object, lanes")
    folders = {d.name[:2]: d.name for d in (Path(root) / "todo").iterdir()
               if d.is_dir() and re.fullmatch(r"\d\d-[^/]+", d.name)}
    result, owner, claimed, sections = {}, {}, {}, {}
    for name, lane in data["lanes"].items():
        require(re.fullmatch(r"[a-z][a-z0-9-]*", name) is not None and name != MAIN_LANE,
                f"{LANES}: lane name {name!r} must be lower-case words joined by hyphens, and not {MAIN_LANE!r}")
        require(isinstance(lane, dict) and {"branch", "worktree"} <= set(lane)
                and set(lane) <= {"branch", "worktree", "domains", "files", "sections"}
                and set(lane) & {"domains", "files", "sections"},
                f"{LANES}: lane {name} holds branch, worktree and domains, files or sections")
        require(all(isinstance(lane[k], str) and lane[k].strip() for k in ("branch", "worktree")),
                f"{LANES}: lane {name}'s branch and worktree must be text")
        require(lane["branch"] not in ("main", "HEAD"), f"{LANES}: lane {name} cannot work branch {lane['branch']}")
        for key in ("domains", "files", "sections"):
            require(key not in lane or (isinstance(lane[key], list) and lane[key]),
                    f"{LANES}: lane {name} must list its {key}")
        for domain in lane.get("domains", []):
            require(isinstance(domain, str) and re.fullmatch(r"D\d\d", domain) is not None,
                    f"{LANES}: lane {name} lists domain {domain!r}; a domain is DNN, such as D01")
            require(domain[1:] in folders, f"{LANES}: lane {name} lists {domain}, which has no todo/{domain[1:]}-* folder")
            require(domain not in claimed, f"{LANES}: {domain} is claimed by lanes {claimed.get(domain)} and {name}")
            claimed[domain] = name
        for file in lane.get("files", []):
            require(isinstance(file, str) and re.fullmatch(r"todo/\d\d-[^/]+/TODO-[^/]+\.md", file) is not None
                    and (Path(root) / file).is_file(), f"{LANES}: lane {name} lists {file!r}, which is not a TODO file")
            require(file not in owner, f"{LANES}: {file} is listed by lanes {owner.get(file)} and {name}")
            owner[file] = name
        for ref in lane.get("sections", []):
            m = re.fullmatch(r"D(\d\d) T(\d\d) §([1-9]\d*)", ref) if isinstance(ref, str) else None
            require(m is not None, f"{LANES}: lane {name} lists section {ref!r}; a section is DNN TNN §N")
            files = sorted(Path(root).glob(f"todo/{m[1]}-*/TODO-{m[2]}-*.md"))
            require(len(files) == 1 and section_text(read_text(files[0]), m[3]) is not None,
                    f"{LANES}: lane {name} lists {ref}, which is no section in todo/")
            require(ref not in sections, f"{LANES}: {ref} is listed by lanes {sections.get(ref)} and {name}")
            sections[ref] = name
        require(all(other["branch"] != lane["branch"] for other in result.values()),
                f"{LANES}: two lanes work branch {lane['branch']}")
        result[name] = lane
    for file, name in owner.items():
        other = claimed.get("D" + file[5:7])
        require(other in (None, name), f"{LANES}: {file} is listed by lane {name} inside {other}'s domain")
    return result


def current_lane(root=ROOT, config=None):
    """The lane this checkout works: TODO_LANE when set, else the lane whose branch is checked out, else main."""
    config = lanes(root) if config is None else config
    named = os.environ.get("TODO_LANE", "").strip()
    if named:
        require(named == MAIN_LANE or named in config, f"TODO_LANE names {named!r}, which is not a lane in {LANES}")
        return named
    try:
        branch = subprocess.run(["git", "-C", str(root), "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True,
                                text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        branch = ""
    return next((name for name, lane in config.items() if lane["branch"] == branch), MAIN_LANE)


def lane_of(row, config):
    """The lane that owns a row: the one listing the section itself, else the one listing its file, else the one
    claiming its domain, else main."""
    domain = "D" + row.path[5:7]
    return next((name for name, lane in config.items() if row.ref in lane.get("sections", [])),
                next((name for name, lane in config.items() if row.path in lane.get("files", [])),
                     next((name for name, lane in config.items() if domain in lane.get("domains", [])), MAIN_LANE)))


def in_lane(row, config, here):
    """Whether a row is counted by lane `here`'s queries: the lane owns it. Readiness is still read over the whole
    graph (`disposition`), so a row waiting on another lane's prerequisite stays blocked."""
    return lane_of(row, config) == here


def lane_query(kind, rows, config, here, everything=False, phase=None):
    """`query ready`, `blocked` or `stats` for lane `here`: only the lane's rows (all of them with `everything`), of
    one phase with `phase`. Readiness is read over the whole graph, so a row waiting on another lane's prerequisite
    stays blocked until that prerequisite is stamped and merged."""
    scope = [r for r in ordered(rows) if (everything or in_lane(r, config, here))
             and (phase is None or r.phase == phase)]
    if kind == "ready":
        return [r.public() for r in scope if disposition(r, rows) == 0]
    if kind == "blocked":
        return [r.public() for r in scope if disposition(r, rows) == 4]
    require(kind == "stats", f"no lane query {kind!r}")
    result = {"lane": "all" if everything else here, "total": len(scope), "verified": sum(r.done for r in scope),
              "ready": sum(disposition(r, rows) == 0 for r in scope),
              "blocked": sum(disposition(r, rows) == 4 for r in scope)}
    if phase is not None:
        result["phase"] = phase
    return result


def manual_rows(rows, config):
    """The coordinator's manual list (`query manual`; docs/specs/2026-10-30-four-lanes-design.md, Manual work): every
    lane's open rows that wait on the operator or on a paid or attended environment, each with its lane."""
    return [{**r.public(), "lane": lane_of(r, config), "disposition": disposition(r, rows)}
            for r in ordered(rows) if not r.done and set(r.needs) & MANUAL_NEEDS]


def lane_info(root=ROOT, config=None, here=None):
    """This checkout's lane as `query lane` prints it: its name, branch, worktree, domains, files and sections;
    main's domains are the ones no lane claims."""
    config = lanes(root) if config is None else config
    here = current_lane(root, config) if here is None else here
    if here != MAIN_LANE:
        lane = config[here]
        return {"lane": here, "branch": lane["branch"], "worktree": lane["worktree"],
                "domains": list(lane.get("domains", [])), "files": list(lane.get("files", [])),
                "sections": list(lane.get("sections", []))}
    claimed = {d for lane in config.values() for d in lane.get("domains", [])}
    folders = sorted("D" + d.name[:2] for d in (Path(root) / "todo").iterdir()
                     if d.is_dir() and re.fullmatch(r"\d\d-[^/]+", d.name))
    return {"lane": MAIN_LANE, "branch": "main", "worktree": None,
            "domains": [d for d in folders if d not in claimed], "files": [], "sections": []}


def claimable(row, rows, config, here):
    """A row's disposition for the lane `here`: a ready row another lane owns waits (4) for that lane."""
    code = disposition(row, rows)
    return 4 if code == 0 and lane_of(row, config) != here else code


def plan_config(root=ROOT):
    """The project's plan title, acceptance bar and phase names from todo/plan.json, loaded strictly."""
    path = Path(root) / PLAN_CONFIG
    if not path.is_file():
        return {**PLAN_DEFAULTS, "phases": dict(PLAN_DEFAULTS["phases"])}
    try:
        data = json.loads(read_text(path))
    except ValueError as exc:
        raise Refused(f"unreadable {PLAN_CONFIG}: {exc}") from None
    require(isinstance(data, dict) and set(data) <= {"title", "acceptance", "phases"},
            f"{PLAN_CONFIG} may only hold title, acceptance and phases")
    title = data.get("title", PLAN_DEFAULTS["title"])
    acceptance = data.get("acceptance")
    phases = data.get("phases", {})
    require(isinstance(title, str) and title.strip() != "", f"{PLAN_CONFIG}: title must be text")
    require(acceptance is None or (isinstance(acceptance, str) and acceptance.strip() != ""),
            f"{PLAN_CONFIG}: acceptance must be text or null")
    require(isinstance(phases, dict), f"{PLAN_CONFIG}: phases must map a phase number to its name")
    names = dict(PLAN_DEFAULTS["phases"])
    for key, name in phases.items():
        require(key.isdigit() and int(key) in PHASES, f"{PLAN_CONFIG}: unknown phase {key!r}")
        require(isinstance(name, str) and name.strip() != "", f"{PLAN_CONFIG}: phase {key} needs a name")
        names[int(key)] = name.strip()
    return {"title": title.strip(), "acceptance": acceptance.strip() if acceptance else None, "phases": names}


def projection(root=ROOT):
    all_rows = graph(root)
    rows = ordered(all_rows)
    config = plan_config(root)
    lines = [f"# {config['title']}", "",
             "Generated by `python scripts/todo-graph.py plan --sync`; do not edit by hand. Edit the "
             "TODO sections (including their Phase and Needs fields) and regenerate. The boxes below "
             "are a projection of each file's Implementation Order table and flip in exactly one "
             "place: the stamp written by review.", ""]
    if config["acceptance"]:
        lines += [f"The acceptance bar is {config['acceptance']}", ""]
    lines += ["Format and rules: `todo/README.md`. Run sections with the `process-plan`, "
              "`process-phase` and `process-todo-section` skills; "
              "`python scripts/todo-graph.py query ready` lists what can run now. Pasting a whole "
              "row from a table below into `process todo section:` is a complete instruction.", ""]
    checks = {row.ref: re.findall(r"^- \[([ x])\] (.+)$", row.body, re.M) for row in rows}
    for phase in sorted({row.phase for row in rows}):
        phase_rows = [row for row in rows if row.phase == phase]
        item_count = sum(len(checks[row.ref]) for row in phase_rows)
        name = config["phases"].get(phase)
        title = f"Phase {phase}: {name}" if name else f"Phase {phase}"
        lines += [f"### {title}", "", f"Sections: {len(phase_rows)} | Checklist items: {item_count}", ""]
        table = markdown_table(
            ["Status", "Reference", "Deliverable", "Needs", "Items"],
            [[f"[{'x' if row.done else ' '}]", row.ref, row.title,
              ", ".join(row.needs) or "none", str(len(checks[row.ref]))] for row in phase_rows],
        )
        # Every row is padded to the widest cell, so one long title wraps the whole table: name the widest section.
        widest = max(phase_rows, key=lambda row: len(row.title) + len(", ".join(row.needs)))
        require(all(len(line) <= MAX_TABLE_ROW for line in table),
                f"plan table for phase {phase} wraps raw md ({max(len(line) for line in table)} > {MAX_TABLE_ROW} "
                f"chars); shorten the heading and Deliverable of {widest.ref} (title {len(widest.title)} chars)")
        lines += table
        lines.append("")
    total_items = sum(len(items) for items in checks.values())
    completed_items = sum(state == "x" for items in checks.values() for state, _ in items)
    ready = sum(disposition(r, all_rows) == 0 for r in rows)
    lines += [f"Progress: {sum(r.done for r in rows)}/{len(rows)} verified sections, "
              f"{ready} ready to run now.", "",
              f"Checklist: {completed_items}/{total_items} items completed (includes Commit items).", ""]
    return "\n".join(lines)


def projections(root=ROOT, sync=False):
    expected = projection(root)
    target = Path(root) / PLAN
    if sync:
        atomic(target, expected)
    else:
        require(target.is_file() and read_text(target) == expected,
                f"stale projection: {PLAN}; run plan --sync")


def deferrals(root=ROOT):
    rows = graph(root)
    found = []
    for row in ordered(rows):
        for marker in ("Deferred", "Resolved"):
            for line in re.findall(r"^> \*\*" + marker + r":\*\*[ \t]*(\S.*)$", row.body, re.M):
                found.append({"ref": row.ref, "state": marker.lower(), "text": line.strip()})
    return found


def adjacency_report(root=ROOT):
    graph(root)  # validation is what makes the declarations trustworthy
    report = {}
    for path in sorted((Path(root) / "todo").glob("[0-9][0-9]-*/TODO-*.md")):
        relative = path.relative_to(root).as_posix()
        _, body = front_matter(read_text(path), relative)
        parsed = adjacency_of(body, relative, path.parent.name[:2],
                              re.fullmatch(r"TODO-(\d{2})-[a-z0-9-]+\.md", path.name)[1])
        report[relative] = {key: (state if owner is None else f"{state} @ {owner}")
                             for key, (state, owner) in parsed.items()}
    return report


def rounds_recorded(root, reviews):
    """Review rounds spent on a section, summed over its findings files (one per review loop): in each, the highest
    round the dispatcher recorded (an outage round that returned no review counts) or the highest round named for
    that file on the command line, whichever is higher."""
    spent = 0
    for report in dict.fromkeys(r["report"] for r in reviews):
        named = max(r["round"] for r in reviews if r["report"] == report)
        path = Path(root) / report
        text = path.read_bytes().decode("utf-8") if path.is_file() else ""  # as written: the dispatcher keeps "\r"
        # The dispatcher's reader, so a round heading quoted inside a review is not counted; a report it cannot read
        # (one older than its format) falls back to the headings, and a new receipt refuses such a report anyway.
        parsed = review_dispatch().read_rounds(text)
        recorded = [e["number"] for e in parsed] if parsed is not None else [int(n) for n in ROUND_RECORD.findall(text)]
        spent += max([named, *recorded])
    return spent


def review_rounds(root=ROOT):
    """Rounds spent per stamped section, from each receipt (or its findings files, for receipts older than the
    rounds_spent field), and a summary for tuning the cap."""
    root = Path(root)
    sections = []
    for row in ordered(graph(root)):
        if not row.done or not row.receipt:
            continue
        data = json.loads(read_text(root / row.receipt))
        spent = data.get("rounds_spent") or rounds_recorded(root, data["reviews"])
        sections.append({"ref": row.ref, "rounds_spent": spent, "round_cap": data.get("round_cap"),
                         "verdicts": [r["verdict"] for r in data["reviews"]],
                         "cap_outcome": data.get("cap_outcome"),
                         "completion": (data.get("completion") or {}).get("verdict")})
    spent = [s["rounds_spent"] for s in sections]
    return {"cap": REVIEW_ROUND_CAP, "sections": sections,
            "summary": {"stamped": len(sections), "rounds": sum(spent),
                        "mean": round(sum(spent) / len(spent), 2) if spent else None,
                        "max": max(spent, default=None),
                        "stopped_at_cap": sum(any(v.startswith("stopped-at-") for v in s["verdicts"])
                                              for s in sections),
                        "stopped_low_severity": sum("stopped-low-severity" in s["verdicts"] for s in sections)}}


def stamp(root, ref, sha, reviews, checks, date, sync_plan=False, cap_outcome=None, completion=None, plan=None,
          final=None, reconciliation=None):
    """Close a section: write its receipt, tick its row and checklist, add the Verified and Review lines. The receipt
    records the plan review (`plan`: its findings file, required), the completion review (`completion`: {"report",
    "verdict"}, required), the pin's review schedule every pass is checked against, the review rounds spent against
    the cap and, when a review stopped at the cap, what was done about it."""
    root = Path(root)
    rows = graph(root)
    require(ref in rows, "unresolved section: " + ref)
    row = rows[ref]
    require(not row.done, f"already verified: {ref}")
    require(all(settled(d, rows) for d in row.depends),
            f"open prerequisite, or one resting on a reopened section: {ref}")
    require(not set(row.needs) & WAITING,
            f"still waiting on {', '.join(sorted(set(row.needs) & WAITING))}: {ref}")
    require(re.fullmatch(r"[0-9a-f]{40}", sha) is not None,
            "the implementation SHA must be a full 40-character commit")
    commit_ok(root, sha)
    open_items = re.findall(r"^- \[ \] (?!Commit:)(.+)$", row.body, re.M)
    require(not open_items,
            f"unticked checklist items in {ref}: {open_items[0] if open_items else ''}")
    slug = re.sub(r"[^a-z0-9]+", "-", ref.lower().replace("§", "s")).strip("-")
    receipt = f"docs/reviews/{slug}.json"
    require(completion is not None,
            f"--completion '<findings file>:<{'|'.join(COMPLETION_VERDICTS)}>' is required: run the one-pass completion "
            f"review (scripts/review-dispatch.py --kind completion) and name its verdict: {ref}")
    require(plan is not None,
            f"--plan '<findings file>' is required: run the one-pass plan review (scripts/review-dispatch.py --kind "
            f"plan) before the build: {ref}")
    stopped = any(isinstance(r, dict) and str(r.get("verdict", "")).startswith("stopped-") for r in reviews)
    require(stopped == bool((cap_outcome or "").strip()),
            "--cap-outcome is required with a stopped verdict (what was done when the review stopped at the cap or on "
            "severity), and only then")
    data = {"ref": ref, "title": row.title, "implementation_sha": sha, "date": date,
            "reviews": reviews, "checks": checks}
    # Empty rounds need actual policy-bound completion evidence before argument validation permits them.
    report = completion.get("report") if isinstance(completion, dict) else None
    if report is not None:
        text = report_ok(root, report, ref).read_bytes().decode("utf-8")
        dispatch = review_dispatch()
        entries = dispatch.read_completions(text)
        if entries and any(e.get("policy") == "codex-two-pass-v1" for e in entries):
            require(report == section_findings(root, ref), f"two-pass completion must use its own findings: {ref}")
            try:
                chain = dispatch.validate_codex_chain(root, text)
            except dispatch.Refused as exc:
                raise Refused(f"invalid two-pass completion: {exc}: {ref}") from None
            require(chain["policy"] == "codex-two-pass-v1", f"two-pass completion policy mismatch: {ref}")
            data["review_policy"] = chain["policy"]
            if chain.get("transition") is not None:
                data["policy_transition"] = chain["transition"]
    receipt_data_ok(data, ref, sha, root=root, building=True)
    if reconciliation is not None:
        data["reconciliation"] = reconciliation_record(root, reconciliation, ref, sha)
    data["completion"] = completion_record(root, completion, ref, sha, reconciliation=reconciliation)
    for target in data["completion"]["filed"]:
        require(target in rows, f"completion gap filed as {target}, which does not resolve: {ref}")
    data["rounds_spent"] = rounds_recorded(root, reviews)
    completion_entries = review_dispatch().read_completions((root / completion["report"]).read_bytes().decode("utf-8"))
    self_review = any(e.get("policy") == "codex-self-review" for e in completion_entries)
    data["round_cap"] = (0 if data.get("review_policy") == "codex-two-pass-v1" else
                         1 if self_review else round_cap(field(row.body, "Risk", False) or "full"))
    if stopped:
        data["cap_outcome"] = cap_outcome.strip()
    data["plan"] = plan_record(root, plan, ref)
    after = plan_after_started(root, row.path, row.body, ref, data["plan"]["candidate"])
    if after is not None:
        data["plan"]["after_started"] = after
    data["schedule"] = pin_schedule(root, sha, ref)
    mode = final_mode(data["schedule"])
    if mode == "required" or (mode == "optional" and final is not None):
        require(final is not None,
                f"--final '<findings file>:<{'|'.join(FINAL_VERDICTS)}>' is required: the schedule has a final step; run "
                f"review-dispatch.py --kind final once the rounds have stopped: {ref}")
        data["final"] = final_record(root, final, ref, sha)
    elif mode == "off":
        require(final is None, f'--final given, but the final review is off at {sha} ([schedule.final] mode = "off"): {ref}')
    else:
        require(final is None, f"--final given, but the schedule at {sha} has no final step: {ref}")
    receipt_data_ok(data, ref, sha, root=root, surface=field(row.body, "Surface") == "yes",
                    risk=field(row.body, "Risk", False) or "full", todo=row.path, body=row.body)
    receipt_path = root / receipt
    require(not receipt_path.exists(), f"receipt already exists: {receipt}")
    path = root / row.path
    original_bytes = path.read_bytes()
    original = read_text(path)
    text = original
    body = row.body
    new_body = re.sub(r"^- \[ \] (Commit:.+)$", r"- [x] \1", body, flags=M_FLAG)
    new_body += f"\n\n> **Verified:** {date} | §{row.number} | {sha}\n> **Review:** `{receipt}`"
    require(text.count(body) == 1, f"section body is not unique in {row.path}")
    text = text.replace(body, new_body)
    line = re.compile(r"^(\|\s*\d+\s*\|\s*§" + str(row.number) + r"\s*\|[^\n]*\|\s*)\[ \](\s*\|)$", re.M)
    require(len(line.findall(text)) == 1, f"implementation row not found: {ref}")
    text = line.sub(r"\1[x]\2", text)
    siblings = [r for r in rows.values() if r.path == row.path and r.ref != ref]
    if all(r.done for r in siblings):
        text, n = re.subn(r"\A(---\n(?:.*\n)*?)status: [a-z]+\n", r"\1status: done\n", text, count=1)
        require(n == 1, f"frontmatter status not found: {row.path}")
    plan_path = root / PLAN
    original_plan_bytes = plan_path.read_bytes() if plan_path.is_file() else None
    try:
        atomic(receipt_path, json.dumps(data, indent=2) + "\n")
        atomic(path, text)
        graph(root)
        if sync_plan or original_plan_bytes is not None:
            projections(root, sync=True)
    except BaseException:  # an interrupt between writes must roll back as an error does
        receipt_path.unlink(missing_ok=True)
        try:
            if not path.is_file() or path.read_bytes() != original_bytes:
                atomic(path, original_bytes)
        finally:
            if original_plan_bytes is not None:
                if not plan_path.is_file() or plan_path.read_bytes() != original_plan_bytes:
                    atomic(plan_path, original_plan_bytes)
            elif plan_path.exists():
                plan_path.unlink(missing_ok=True)
        raise
    return receipt


def unstamp(root, ref, reason, date):
    """Flip a stamped section back to open when an audit finds it regressed: remove its Verified and Review lines,
    untick its Commit item and row, reopen its file, and keep the receipt as evidence under a revoked name, with a dated
    Unstamped note in the section saying why. Re-stamping later writes a fresh receipt."""
    root = Path(root)
    rows = graph(root)
    require(ref in rows, "unresolved section: " + ref)
    row = rows[ref]
    require(row.done, f"not stamped: {ref}")
    require(bool(reason.strip()) and "\n" not in reason, "--reason must be one line saying what regressed")
    require(re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) is not None, f"invalid date: {date}")
    stamp_lines = re.compile(r"\n\n> \*\*Verified:\*\* [^\n]*\n> \*\*Review:\*\* `[^`\n]*`")
    require(len(stamp_lines.findall(row.body)) == 1, f"stamp lines not found: {ref}")
    receipt_path = root / row.receipt
    revoked_path = receipt_path.with_name(f"{receipt_path.stem}.revoked-{date}.json")
    n = 2
    while revoked_path.exists():
        revoked_path = receipt_path.with_name(f"{receipt_path.stem}.revoked-{date}-{n}.json")
        n += 1
    revoked = revoked_path.relative_to(root).as_posix()
    body = stamp_lines.sub("", row.body)
    body = re.sub(r"^- \[x\] (Commit:.+)$", r"- [ ] \1", body, flags=re.M)
    body += f"\n\n> **Unstamped:** {date}: {reason.strip()} (revoked receipt `{revoked}`)"
    path = root / row.path
    original_bytes = path.read_bytes()
    text = read_text(path)
    require(text.count(row.body) == 1, f"section body is not unique in {row.path}")
    text = text.replace(row.body, body)
    line = re.compile(r"^(\|\s*\d+\s*\|\s*§" + str(row.number) + r"\s*\|[^\n]*\|\s*)\[x\](\s*\|)$", re.M)
    require(len(line.findall(text)) == 1, f"implementation row not found: {ref}")
    text = line.sub(r"\1[ ]\2", text)
    text = re.sub(r"\A(---\n(?:.*\n)*?)status: done\n", r"\1status: active\n", text, count=1)
    receipt_bytes = receipt_path.read_bytes()
    plan_path = root / PLAN
    original_plan_bytes = plan_path.read_bytes() if plan_path.is_file() else None
    try:
        atomic(revoked_path, receipt_bytes)
        atomic(path, text)
        receipt_path.unlink()
        graph(root)
        if original_plan_bytes is not None:
            projections(root, sync=True)
    except BaseException:  # an interrupt between writes must roll back as an error does
        try:
            if not receipt_path.is_file():
                atomic(receipt_path, receipt_bytes)
            revoked_path.unlink(missing_ok=True)
            if not path.is_file() or path.read_bytes() != original_bytes:
                atomic(path, original_bytes)
        finally:
            if original_plan_bytes is not None and (not plan_path.is_file()
                                                    or plan_path.read_bytes() != original_plan_bytes):
                atomic(plan_path, original_plan_bytes)
        raise
    return revoked


def suspects(root, ref):
    """Stamped sections that depend on ref, directly or through other sections: suspect while ref is open."""
    rows = graph(root)
    found, frontier = [], [ref]
    while frontier:
        current = frontier.pop()
        for row in ordered(rows):
            if current in row.depends and row.ref not in found:
                found.append(row.ref)
                frontier.append(row.ref)
    return [r for r in found if rows[r].done]

M_FLAG = re.M
