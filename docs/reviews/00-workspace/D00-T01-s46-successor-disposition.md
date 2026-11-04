# D00 T01 §46 residual reconciliation finding

The original completion on `3e84885929db6eb45969bafe5aa79caee05b3ffe` and the first reconciliation on `d59b475c533a6977b53bf06fc7fa486c282e786c` both remain `gaps` in the unchanged-prefix canonical report. This document is repair evidence, not approval or authorization for another invocation.

The first reconciliation confirmed the original nested-quote and fenced-example cases were fixed, but returned a residual in-scope P2: task-list prefixes could conceal malformed or duplicate withdrawal fields. The owning parser now recognizes bracketed checkbox/list tokens in its candidate prefix before demanding the exact standalone field. This covers unchecked, checked, uppercase-checked, nested-quote, numbered-list and malformed checkbox tokens. It does not grant any of those tokens withdrawal authority; they all refuse. Fenced and inline-code examples retain their prior behavior.

The new direct parser regression failed 12 assertions against `d59b475c533a6977b53bf06fc7fa486c282e786c`. After the one-pattern repair, all 79 focused withdrawal, graph, query, lane and plan tests pass. Logs are `~/isitlegit-data/handover/todo-withdrawal/successor-failing-first.log` and `successor-targeted.log`. The previous failing-first and repaired cases remain in that set. No original contract, reviewer pin, history, checklist or receipt was rewritten, and no additional-scope deferral was used.

Any successor requires an explicit coordinator authorization through the existing supported exact-predecessor mechanism, preserving every prior response. No review is invoked by this document and the section remains unstamped until that route yields a genuine complete result.

Layer: TODO metadata parser owns the residual defect; its malformed-prefix recognition changed directly; no workaround.
