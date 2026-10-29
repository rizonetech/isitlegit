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
- -> XREF: D01 T01 §5 -- the parsed summary's `truncated` parts, reported as the `intake.truncated` item
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

> **Started:** 2026-10-29T13:46Z

**Corrected 2026-10-29** (at start, checked against the repository): (1) an uploaded file's summary has no forward path (`parse` writes `source` and `forward: { headersAvailable: false }`, `src/pipeline/analysis-workflow.ts`), so the first item says how the case arrived either way: `intake.forward` with the path for a mailed forward or an uploaded message, `intake.upload` with the file's kind and media type for an uploaded document, image or voice note; (2) the Workflow retries a step (`RETRIES`), so `saveEvidence` replaces the case's evidence in one batch, and a retried `checks` step stores the same list once, never a duplicate id; (3) no code extracts links or makes renders yet: links come from `extractLinks(caseView)` (D02 T07 §1) and renders from D03 T02 §1, so `CaseView` carries what they read (headers, both bodies, each cut part's artefact, the attachments, the source and the tenant), and each adds its own field when it is built; (4) the checks are pure, so `CaseView` is built once from the summary by `caseViewOf`, and a check gets the view, never the store.

**Phase:** 2
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/evidence.test.ts` passes unchanged.

**Build order:**

1. Write `src/checks/evidence.ts` and `src/checks/registry.ts`. Done when: a test registers two checks and stores their evidence with IDs `E1`, `E2`.

- [x] Define `Evidence` with zod in `src/checks/evidence.ts`: `id` (pattern `^E\d+$`), `check` (a registered producer's name, or one of the system names the runner writes, `SYSTEM_CHECKS`, `not_checked` first, which `registerCheck` refuses to take: **corrected 2026-10-29**, plan review), `severity` (`info`, `low`, `medium`, `high`, `critical`), `summary` (at most 200 characters, plain words), `detail` (JSON object), `artefacts` (R2 keys). Done when: `test/checks/evidence.test.ts` refuses an unknown severity, an over-long summary and an unknown producer name, and accepts a `not_checked` item. Done 2026-10-29: `Evidence` and `SYSTEM_CHECKS` (`src/checks/registry.ts`); `test/checks/evidence.test.ts` "Evidence".
- [x] Define `CaseView` and `caseViewOf(summary, tenant)` in `src/checks/case-view.ts`: headers, the text and HTML bodies, each cut part's artefact key, sizes, media type and charset (the charset decodes the rest of a part, as the UTF-16 fixture in `test/intake/parse.test.ts` shows), the attachments, `omitted`, the source (a forward's path and `otherOriginals`, or an upload's kind and media type) and the tenant (organisation, channel, header state), read from the R2 summary, never raw bytes passed between steps; links and renders join it in D02 T07 §1 and D03 T02 §1. Done when: `test/checks/evidence.test.ts` loads a parsed forward's summary and an upload's into it with field-level assertions (each cut part's media type and charset kept, from the UTF-16 fixture's summary), and a summary of neither shape is refused. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `src/checks/case-view.ts`; tests "caseViewOf" (the UTF-16 fixture's part keeps `utf-16le`).
- [x] Write `registerCheck({ name, needs, timeoutMs, run })` and `allChecks()` in `src/checks/registry.ts`. Done when: a duplicate name throws. Done 2026-10-29: `CheckRegistry`, `registerCheck`, `allChecks` in `src/checks/registry.ts`, the pipeline's checks registered in `src/checks/index.ts`; tests "the registry".
- [x] Write `saveEvidence(db, caseId, items)` in `src/checks/evidence.ts`: assign `E<n>` in order and validate the whole assigned list against `Evidence` (and each `check` against the registry and `SYSTEM_CHECKS`) before anything is written, then replace the case's evidence in one batch (its delete and inserts together, so a failure leaves the previous list), with the same `n` in the `seq` column (D01 T01 §1's migration `0002_evidence_order.sql` ties `id = 'E' || seq` and requires `detail_json` to be a JSON object and `artefact_keys_json` an array; read in order with `ORDER BY seq`, never by the text id), and `readEvidence(db, caseId)` reading it back in that order. Done when: the test, through `saveEvidence` and `readEvidence`, shows an identical retry storing one list, a shorter list and an empty one replacing a longer, another case's list untouched, a refused list (an over-long summary, an unknown name) and a failing batch each leaving the previous list whole, and twelve items read back `E1` to `E12` in numeric order with every field. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `numbered`, `saveEvidence`, `readEvidence`; tests "saveEvidence", proven to fail with the delete taken out of the batch and with the name check removed.
- [x] Write the `intake.forward` evidence item (info severity, `detail_json.path` from the parsed summary's `forward.path`: `rfc822`, `eml`, `msg` or `inline`, and `detail_json.otherOriginals`, the further attached messages not checked) first for every case with a message, and `intake.upload` (info, the file's kind and media type) first for an uploaded file, so the report can say how the case arrived, both as checks registered ahead of every other in `src/checks/intake.ts`. Done when: a test finds it as `E1` with the path for an attached and an inline fixture, and `intake.upload` as `E1` for an upload. (**Corrected 2026-10-29**, at start.) Source: D01 T01 §4 (deferred there 2026-10-28: it has no evidence writer). Done 2026-10-29: `src/checks/intake.ts` (`forwardEvidence`, `uploadEvidence`); tests "the intake items".
- [x] Write the `intake.truncated` evidence item (info severity) when the parsed summary's `truncated` is not empty (D01 T01 §5), stating the cut's facts only: each cut part with its media type and full and kept sizes, that the report's reading of each part was cut there while its whole text is kept for the checks that read it, and, when `omitted` is above 0, that that many further cut parts (past the 50 kept) were stored only up to their cut. It claims no check's coverage: that a check read a full part is that check's own evidence (D02 T07 §1, D02 T05 §1), so a check that is absent or fails leaves no such claim. Done when: the twenty-part fixture yields one item listing every cut part, a summary with `omitted` 3 yields the further-parts sentence, an uncut message yields none, and no `intake.truncated` text says a part was checked. Source: D01 T01 §5 plan review, 2026-10-28; **corrected 2026-10-29**, plan review. Done 2026-10-29: `truncatedEvidence`; tests "the intake items".
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
