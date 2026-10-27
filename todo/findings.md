# Findings

Unscheduled defects noticed while working on another section. Record each entry with `file:line` and strike it with its `DNN TNN §N` reference once scheduled via `add-todo`.

- `scripts/review-dispatch.py:732` (Conclave-SDK reviewer kit): a findings file made unreadable by a writer line placed directly under a recorded `OVERALL:` line (no blank line) is caught only when the next review is recorded, after the reviewer has already run, so the returned review is discarded and the pass re-runs. Noticed 2026-10-27 in D00 T01 §2 (completion review lost once). An early read-back in `scripts/hooks/pre-commit` for staged `docs/reviews/**/*.md` would catch it at commit; the kit owns both files.
