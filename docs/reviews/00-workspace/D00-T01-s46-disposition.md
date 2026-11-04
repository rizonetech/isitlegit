# D00 T01 §46 completion finding disposition

The genuine combined completion on `3e84885929db6eb45969bafe5aa79caee05b3ffe` returned gaps. Preserve its complete response and the original LOW plan in `D00-T01-s46.md`. This document does not approve or replace either review. The original section obligations and pin remain unchanged.

The P2 parser finding is in scope and repaired at its owning layer, `scripts/lib/todo_graph.py`. Field recognition now detects malformed nested quote and list prefixes before requiring the exact standalone marker. It also tracks backtick and tilde fences with their actual opening length, so fenced examples cannot withdraw work or count as duplicate metadata. The original raw section bytes are used, preserving strict indentation checks. No new withdrawal authority or stamped retirement was added.

Two regression tests reproduce both returned cases and related boundaries: nested `> >` and `>>` quotes, unordered and ordered list prefixes, duplicates concealed by those prefixes, backtick and tilde fences, a shorter inner fence, indented fences, and a valid field after an example. Against the original implementation they failed 16 assertions. After the parser repair all 78 focused withdrawal, graph, query, lane and plan tests pass. Existing dependency blocking, active counts, strict dates, stamp refusal without writes and history-preservation tests remain in that set.

Evidence commands: `python3 -m unittest tests.scripts.test_todo_withdrawal tests.scripts.test_todo_graph.Graph tests.scripts.test_todo_graph.QueryPlan tests.scripts.test_todo_graph.Lanes tests.scripts.test_todo_graph.LaneDomains tests.scripts.test_todo_graph.PlanTable` passed 78 tests. External failing-first and passing logs are in `~/isitlegit-data/handover/todo-withdrawal/reconciliation-failing-first.log` and `reconciliation-targeted.log`. Normal commit hooks validate the full graph and current projection.

There is no additional-scope classification or deferred finding. Canonical user withdrawal rows remain separately owned and are not edited here. Supported reconciliation must verify the entire original contract, original failure and intervening repair before any stamp.

Layer: TODO metadata parser owns the defect; its marker and fence recognition changed directly; no workaround.
