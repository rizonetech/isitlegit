#!/usr/bin/env python3
"""Validate, query, resolve and stamp the canonical TODO graph, and keep todo/implementation-plan.md current.

    python scripts/todo-graph.py validate
    python scripts/todo-graph.py build                       # todo/ -> build/todo-cache.json
    python scripts/todo-graph.py render                      # mermaid dependency graph
    python scripts/todo-graph.py plan --sync | --check
    python scripts/todo-graph.py query ready | blocked | stats | deferred | adjacency | plan | rounds | lane | manual
                                                             # ready, blocked and stats count this checkout's lane
                                                             # (todo/lanes.json); --all the whole plan, --phase N one phase
    python scripts/todo-graph.py resolve 'D02 T01 §1'        # exit 0 ready, 1 no such section,
                                                             # 2 no reference in input, 3 verified,
                                                             # 4 waiting (or another lane's), 5 withdrawn; a pasted plan row works too
    python scripts/todo-graph.py classify 'D02 T01 §1' ...   # dispositions as JSON
    python scripts/todo-graph.py stamp 'D02 T01 §1' --sha <40-char commit> \
        --plan '<findings file>' \
        --completion '<findings file>:<complete|completed|filed|gaps>' \
        --review '<round>:<report path>:<clean|fixed|stopped-at-3|stopped-low-severity>' --check '<command> -> <result>' \
        [--cap-outcome '<what was done when the review cap was reached>']   # required with a stopped verdict
        [--final '<findings file>:<clean|fixed>']   # required when the schedule has a final step
    python scripts/todo-graph.py unstamp 'D02 T01 §1' --reason '<what regressed, and the repair section>'

Format and rules: todo/README.md. Stdlib only.
"""
import argparse
from datetime import date
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from todo_graph import (ROOT, Refused, adjacency_report, atomic, claimable, current_lane,  # noqa: E402
                        deferrals, disposition, extract_ref, graph, lane_info, lane_of, lane_query, lanes, manual_rows,
                        ordered, plan_candidate, plan_config, projections,
                        require, review_rounds, settled, stamp, suspects, unstamp, validate_orphan_receipts)


def review_round(value):
    parts = value.split(":")
    require(len(parts) == 3 and parts[0].isdigit() and parts[1],
            f"--review takes round:report:verdict, not {value!r}")
    return {"round": int(parts[0]), "report": parts[1], "verdict": parts[2]}


def completion_review(value):
    report, _, verdict = value.rpartition(":")
    require(bool(report) and bool(verdict), f"--completion takes <findings file>:<verdict>, not {value!r}")
    return {"report": report, "verdict": verdict}


def final_review(value):
    report, _, verdict = value.rpartition(":")
    require(bool(report) and bool(verdict), f"--final takes <findings file>:<verdict>, not {value!r}")
    return {"report": report, "verdict": verdict}


def plan_status(row, rows):
    """A section's state for readers of `query plan`: verified, withdrawn, deferred (inactive file), ready or blocked."""
    if getattr(row, "withdrawn", None):
        return "withdrawn"
    if row.done:
        return "verified"
    if row.status != "active":
        return "deferred"
    return "ready" if disposition(row, rows) == 0 else "blocked"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("validate", "build", "render"):
        sub.add_parser(name)
    q = sub.add_parser("query")
    q.add_argument("kind", choices=["ready", "blocked", "stats", "deferred", "adjacency", "plan", "rounds", "lane",
                                    "manual"])
    q.add_argument("--all", action="store_true", help="ready, blocked, stats: the whole plan, not this lane's rows")
    q.add_argument("--phase", type=int, help="ready, blocked, stats: one phase's rows")
    r = sub.add_parser("resolve")
    r.add_argument("ref")
    c = sub.add_parser("classify")
    c.add_argument("refs", nargs="+")
    plan = sub.add_parser("plan")
    mode = plan.add_mutually_exclusive_group(required=True)
    mode.add_argument("--sync", action="store_true")
    mode.add_argument("--check", action="store_true")
    s = sub.add_parser("stamp")
    s.add_argument("ref")
    s.add_argument("--sha", required=True)
    s.add_argument("--review", action="append", default=[], type=review_round,
                   help="legacy implementation round; omit only for a validated codex-two-pass-v1 chain")
    s.add_argument("--check", dest="checks", action="append", default=[])
    s.add_argument("--date", default=date.today().isoformat())
    s.add_argument("--cap-outcome", help="with a stopped-at verdict: what was done when the review cap was reached")
    s.add_argument("--plan", help="required: <findings file>, the one-pass plan review before the build")
    s.add_argument("--completion", type=completion_review,
                   help="required: <findings file>:<complete|completed|filed|gaps>, the one-pass completion review")
    s.add_argument("--reconciliation", type=completion_review,
                   help="explicit bounded follow-up: <findings file>:complete; preserves original completion gaps")
    s.add_argument("--final", type=final_review,
                   help="required when the schedule has a final step: <findings file>:<clean|fixed>, the final review")
    pc = sub.add_parser("plan-candidate", help="check a plan review's candidate before the review runs: exit 0 when "
                                               "stamp would accept it, 1 with stamp's own refusal when not")
    pc.add_argument("ref")
    pc.add_argument("sha")
    pc.add_argument("--findings", help="the file the plan review will be recorded in: it must be the section's own "
                                       "findings file, as stamp requires of --plan")
    u = sub.add_parser("unstamp", help="an audit found a stamped section regressed: reopen it, keeping the receipt")
    u.add_argument("ref")
    u.add_argument("--reason", required=True)
    u.add_argument("--date", default=date.today().isoformat())
    args = p.parse_args()
    if args.command == "unstamp":
        revoked = unstamp(ROOT, args.ref, args.reason, args.date)
        print(f"unstamped {args.ref}; receipt kept as {revoked}; plan synchronized")
        for ref in suspects(ROOT, args.ref):
            print(f"suspect until {args.ref} re-stamps: {ref}")
        return 0
    if args.command == "stamp":
        receipt = stamp(ROOT, args.ref, args.sha, args.review, args.checks, args.date, sync_plan=True,
                        cap_outcome=args.cap_outcome, completion=args.completion, plan=args.plan,
                        final=args.final, reconciliation=args.reconciliation)
        print(f"stamped {args.ref}; receipt {receipt}; plan synchronized")
        return 0
    rows = graph()
    if args.command == "plan-candidate":
        try:
            after = plan_candidate(ROOT, rows, args.ref, args.sha, args.findings)
        except Refused as exc:
            print("TODO refused: " + str(exc), file=sys.stderr)
            return 1
        print("ok" if after is None else "ok " + json.dumps(after, sort_keys=True))
        return 0
    if args.command == "plan":
        projections(sync=args.sync)
        print("plan synchronized" if args.sync else "plan current")
    elif args.command == "resolve":
        ref, code = extract_ref(args.ref, rows)
        if code == 2:
            print("TODO refused: no section reference in input: " + args.ref, file=sys.stderr)
            return 2
        if code == 1:
            print("TODO refused: no such section: " + ref, file=sys.stderr)
            return 1
        row = rows[ref]
        unmet = [d for d in row.depends if not settled(d, rows)]
        config, here = lanes(), current_lane()
        owner = lane_of(row, config)
        code = claimable(row, rows, config, here)
        lane = {"lane": owner, "this_lane": here}
        if owner != here:
            # Another lane's row is claimed only in that lane's worktree (todo/lanes.json; AGENTS.md, Parallel lanes).
            where = config[owner] if owner in config else {"branch": "main", "worktree": "the main checkout"}
            lane["lane_note"] = f"{ref} belongs to lane {owner} (branch {where['branch']}, {where['worktree']})"
        print(json.dumps({**row.public(), "body": row.body, "unmet_depends": unmet, **lane,
                          "skill_arg": ref, "exit": code},
                         indent=2, ensure_ascii=False))
        return code
    elif args.command == "classify":
        out = {}
        config, here = lanes(), current_lane()
        for item in args.refs:
            ref, code = extract_ref(item, rows)
            out[item] = claimable(rows[ref], rows, config, here) if code == 0 else code
        print(json.dumps(out, ensure_ascii=False))
    elif args.command == "query":
        require(not (args.all or args.phase is not None) or args.kind in ("ready", "blocked", "stats"),
                "--all and --phase go with query ready, blocked or stats")
        if args.kind in ("ready", "blocked", "stats"):
            # A lane counts only its own rows (todo/lanes.json; AGENTS.md, Parallel lanes).
            result = lane_query(args.kind, rows, lanes(), current_lane(), everything=args.all, phase=args.phase)
        elif args.kind == "lane":
            result = lane_info()
        elif args.kind == "manual":
            # The coordinator's list (docs/specs/2026-10-30-four-lanes-design.md, Manual work): every lane's open rows
            # that wait on the operator or on a paid or attended environment.
            result = manual_rows(rows, lanes())
        elif args.kind == "deferred":
            result = deferrals()
        elif args.kind == "adjacency":
            result = adjacency_report()
        elif args.kind == "plan":
            # The plan's names come from plan_config and every section from the graph, so a reader such as the
            # editor extension never parses todo/ itself (plan R34). graph() has already loaded todo/plan.json
            # strictly, so an unreadable one refused before this point.
            config = plan_config()
            result = {"title": config["title"], "acceptance": config["acceptance"],
                      "phases": {str(n): name for n, name in sorted(config["phases"].items())},
                      "sections": [{"ref": r.ref, "path": r.path, "title": r.title, "phase": r.phase,
                                    "status": plan_status(r, rows), "depends": r.depends,
                                    **({"withdrawn": r.withdrawn} if r.withdrawn else {})} for r in ordered(rows)]}
        else:
            result = review_rounds()
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif args.command == "build":
        atomic(ROOT / "build/todo-cache.json",
               json.dumps([r.public() for r in ordered(rows)], indent=2, ensure_ascii=False) + "\n")
        print(f"built {len(rows)} sections")
    elif args.command == "render":
        node = lambda ref: re.sub(r"[^A-Za-z0-9]", "", ref)  # noqa: E731
        lines = ["```mermaid", "flowchart LR"]
        for row in ordered(rows):
            lines.append(f'    {node(row.ref)}["{row.ref}: {row.title}"]')
            for dep in row.depends:
                lines.append(f"    {node(dep)} --> {node(row.ref)}")
        lines.append("```")
        print("\n".join(lines))
    else:
        validate_orphan_receipts(ROOT, rows)
        print(f"valid: {len(rows)} sections")
    return 0


if __name__ == "__main__":
    # The output is a contract other programs parse; JSON is UTF-8, whatever the console's code page.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        sys.exit(main())
    except (Refused, OSError, ValueError) as exc:
        print("TODO refused: " + str(exc), file=sys.stderr)
        sys.exit(2)
