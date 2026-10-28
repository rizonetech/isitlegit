---
schema_version: 1
id: evidence-core
domain: 02-checks
status: active
title: "TODO-01 -- Evidence Model and Check Runner"
frozen: true
track: day-2
---

# TODO-01 -- Evidence Model and Check Runner

> **Goal:** Every fact IsItLegit states rests on an Evidence item (`id`, `check`, `severity` info to critical, `summary`, `detail`, `artefacts`), produced by a pure check function and stored on the case; a check runner step in the Workflow runs every registered check, isolates failures as "not checked" evidence instead of guesses, and hands the evidence list to the verdict.

> **Current state:** Measured 2026-10-26 20:00 SAST. The `evidence` table comes from D01 T01 §1; the Workflow `checks` step is a stub (D01 T01 §7).

## Inputs

- Design spec 4.3 (Evidence shape: nothing downstream may state a fact that is not an Evidence item), 4.6 (citations), `AGENTS.md` safety contract ("Evidence or nothing").
- -> XREF: D04 T01 §5 -- the citation validator that refuses any claim citing a missing Evidence ID
- -> XREF: D01 T01 §4 -- the forward's path (`rfc822`, `eml`, `msg` or `inline`) that §1 writes as the `intake.forward` evidence item

## Outcome

- Each check is a pure function `(CaseView) => Evidence[]` with its own tests; the runner stores the union and the IDs are stable per case.
- A check that throws or times out yields one `not_checked` evidence item naming the check, never a missing silence and never a guess.

**Adjacency:** all=not-applicable (internal evidence plumbing; evidence is shown on the report, D07 T03 §3, and governed there)

**Adjacency rationale:** This file defines the data every check produces and the step that runs them; it has no surface or user-facing lifecycle of its own.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Evidence type, IDs and registry | D01 T01 §7 | [ ] |
| 2 | §2 | Check runner step with failure isolation | §1 | [ ] |

## 1. Evidence type, IDs and registry

One zod schema defines Evidence; every check registers in one list with a name, the inputs it needs and a time budget. IDs are short, stable within a case (`E1`, `E2` in creation order) so the verdict can cite them and a person can read them.

**Phase:** 2
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/evidence.test.ts` passes unchanged.

**Build order:**

1. Write `src/checks/evidence.ts` and `src/checks/registry.ts`. Done when: a test registers two checks and stores their evidence with IDs `E1`, `E2`.

- [ ] Define `Evidence` with zod in `src/checks/evidence.ts`: `id` (pattern `^E\d+$`), `check` (registered name), `severity` (`info`, `low`, `medium`, `high`, `critical`), `summary` (at most 200 characters, plain words), `detail` (JSON object), `artefacts` (R2 keys). Done when: `test/checks/evidence.test.ts` refuses an unknown severity and an over-long summary.
- [ ] Define `CaseView` (headers, bodies, attachments, links, renders, tenant context) read from the R2 summary, never raw bytes passed between steps. Done when: the type compiles and a fixture loads into it.
- [ ] Write `registerCheck({ name, needs, timeoutMs, run })` and `allChecks()` in `src/checks/registry.ts`. Done when: a duplicate name throws.
- [ ] Write `saveEvidence(caseId, items)` assigning `E<n>` in order, with the same `n` in the `seq` column (**corrected 2026-10-27:** D01 T01 §1's migration `0002_evidence_order.sql` ties `id = 'E' || seq` and requires `detail_json` to be a JSON object and `artefact_keys_json` an array; read in order with `ORDER BY seq`, never by the text id), and inserting rows in one batch. Done when: the test reads IDs `E1` and `E2` back.
- [ ] Write the `intake.forward` evidence item (info severity, `detail_json.path` from the parsed summary's `forward.path`: `rfc822`, `eml`, `msg` or `inline`) first for every case, so the report can say how the forward arrived. Done when: a test finds it as `E1` with the path for an attached and an inline fixture. Source: D01 T01 §4 (deferred there 2026-10-28: it has no evidence writer).
- [ ] Commit: `checks: evidence type, IDs and registry`

**Test checkpoint:** `pnpm exec vitest run test/checks/evidence.test.ts` passes and fails if a summary over 200 characters is accepted.

## 2. Check runner step with failure isolation

The Workflow `checks` step runs every registered check whose inputs are present, each with its own time budget. A failure produces a `not_checked` evidence item (info severity, the check name, the error class) so the report says what was not checked and the verdict knows coverage is incomplete (spec 4.3a "an outage leaves a not-checked line, never a guess").

**Phase:** 2
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/runner.test.ts` passes unchanged.

**Build order:**

1. Replace the stub `checks` step with `runChecks`. Done when: a fixture case stores evidence from every registered check.

- [ ] Write `runChecks(caseView)` in `src/checks/runner.ts` running checks concurrently with `Promise.allSettled` and per-check timeouts. Done when: `test/checks/runner.test.ts` runs three fake checks and stores their evidence.
- [ ] Turn a thrown error or timeout into `{ check: "not_checked", severity: "info", summary: "<name> could not run", detail: { check, errorClass } }`. Done when: a failing fake check yields that item and the others still store. Cheaper substitute: skipping the failed check silently.
- [ ] Skip a check whose `needs` are absent (for example header checks when `headers_available = 0`) with one info item explaining why. Done when: the inline-forward fixture yields the "headers not available" item.
- [ ] Call `runChecks` from the Workflow `checks` step and pass the evidence key to `verdict`. Done when: the Workflow test sees evidence rows for the fixture.
- [ ] Commit: `checks: check runner step with failure isolation`

**Test checkpoint:** `pnpm exec vitest run test/checks/runner.test.ts` passes and fails if a failing check stops the others.

## Verification

- Every check runs under the runner, failures become `not_checked` evidence, and evidence IDs are stable per case.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
