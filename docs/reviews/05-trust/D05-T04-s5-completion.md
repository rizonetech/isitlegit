## Completion review: astra (`gpt-6-astra` via `codex`)

- Writer: muse
- Run: 2026-11-02T21:22:48Z
- Candidate: 4574a97c8edbaf6801547bdf3c6f096b778048ba
- Effort: medium
- Pin: ce29c18a398871b473c634630dbf588c04ec5ef2
- Lines: 17
- Digest: 9e6383479285c451

HIGHEST: P2. Reviewed `4574a97c8edbaf6801547bdf3c6f096b778048ba`; working tree clean.

- **P2: Historical captures reopen dismissed findings.** [findings.ts:85](../../../src/monitor/findings.ts#L85) checks only capture-key inequality while replaying every investigation. After confirmed captures A and B, dismissing B and rerunning without any new capture reopens the finding on A. Require a confirmed capture newer than the dismissal.

- **P2: Delivery recovery ignores recorded outcomes.** [findings.ts:152](../../../src/monitor/findings.ts#L152) ignores `sendMail`’s `duplicate` result. If delivery succeeds but the findings update fails, subsequent runs receive `duplicate(previous: "sent")` and never populate `alerted_at`. The equivalent crash after uncertain delivery leaves its warning unset. Reconcile duplicate outcomes from the durable send record.

- **P2: A site that stops flagging never becomes offline.** [findings.ts:96](../../../src/monitor/findings.ts#L96) considers only DNS resolution. A confirmed lure subsequently captured and screened benign still resolves, produces no new investigation, and remains a live confirmed finding indefinitely. Read the latest settled screen when advancing status.

- **P2: Packs make unsupported accusations.** [takedown.ts:20](../../../src/monitor/takedown.ts#L20) declares confirmed impersonation for every outcome, and line 43 asserts credential or payment collection unconditionally. Both downloads accept unconfirmed and partial findings. Even logo-only confirmation does not establish credential collection. Gate or qualify the pack and derive allegations from evidence. The “Live fake sites” count also includes unconfirmed and partial findings at [monitor-view.tsx:46](../../../src/web/pages/monitor-view.tsx#L46).

- **P2: Registrar abuse contacts are inferred.** [rdap-contacts.ts:62](../../../src/monitor/rdap-contacts.ts#L62) substitutes the registrar’s ordinary email when no abuse entity exists. A sales or general contact is therefore labelled an abuse contact. Preserve “not published” unless RDAP identifies that role.

- **P2: Findings failures report a successful run.** [workflow.ts:269](../../../src/monitor/workflow.ts#L269) logs exhausted findings-step failures and returns the earlier summary unchanged. Findings or alerts can be absent while the run remains successful and the console shows no partial-run warning. This violates the frozen failure-path contract.

- **P2: Alert content omits required evidence.** [findings.ts:145](../../../src/monitor/findings.ts#L145) includes neither a screenshot nor a finding-specific link or pack download. Both links open the general list. The ticked delivery item explicitly requires the screenshot, download button and link to that finding.

Source review only; tests were inspected, not executed.
