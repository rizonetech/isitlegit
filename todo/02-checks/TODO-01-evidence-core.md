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
- -> XREF: D07 T03 §18 -- the report's count line and "Checks that found nothing" panel, which read §3's stored outcomes (`ran` with no findings is clean; `partial`, `skipped` and `failed` are not; null is "coverage not recorded")
- -> XREF: D04 T02 §5 -- the walkthrough's evidence items, the first later producer that §5's `addEvidence` writes for

## Outcome

- Each check is a pure function `(CaseView) => Evidence[]` with its own tests; the runner stores the union and the IDs are stable per case.
- A check that throws or times out yields one `not_checked` evidence item naming the check, never a missing silence and never a guess.

**Adjacency:** all=not-applicable (internal evidence plumbing; evidence is shown on the report, D07 T03 §3, and governed there)

**Adjacency rationale:** This file defines the data every check produces and the step that runs them; it has no surface or user-facing lifecycle of its own.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Evidence type, IDs and registry | D01 T01 §7 | [x] |
| 2 | §2 | Check runner step with failure isolation | §1 | [x] |
| 3 | §3 | Check outcomes stored per case | §2 | [x] |
| 4 | §4 | Check revision stored with each outcome | §3 | [x] |
| 5 | §5 | Evidence added by later pipeline steps | §1 | [x] |
| 6 | §6 | Detection-data revision with each outcome | §4 | [x] |
| 7 | §7 | Each check's result summary with its outcome | §3 | [x] |
| 8 | §8 | Examined set stored for a clean check | §3 | [x] |
| 9 | §9 | Protected-identity candidate for the trust match | §3 | [ ] |

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

- [x] Define `Evidence` with zod in `src/checks/evidence.ts`: `id` (pattern `^E[1-9]\d*$`, the ids `saveEvidence` assigns, so `E0` and `E01` are refused: **corrected 2026-10-29**, final review), `check` (a registered producer's name, or one of the system names the runner writes, `SYSTEM_CHECKS`, `not_checked` first, which `registerCheck` refuses to take: **corrected 2026-10-29**, plan review), `severity` (`info`, `low`, `medium`, `high`, `critical`), `summary` (at most 200 characters, plain words on one line: no control or format characters, line or paragraph separators, or markup), `detail` (JSON object), `artefacts` (R2 keys). Done when: `test/checks/evidence.test.ts` refuses an unknown severity, an over-long summary and an unknown producer name, and accepts a `not_checked` item. Done 2026-10-29: `Evidence` and `SYSTEM_CHECKS` (`src/checks/registry.ts`); `test/checks/evidence.test.ts` "Evidence".
- [x] Define `CaseView` and `caseViewOf(summary, tenant)` in `src/checks/case-view.ts`: headers, the text and HTML bodies, each cut part's artefact key, sizes, media type and charset (the charset decodes the rest of a part, as the UTF-16 fixture in `test/intake/parse.test.ts` shows), the attachments, `omitted`, the source (a forward's path and `otherOriginals`, or an upload's kind and media type) and the tenant (organisation, channel, header state), read from the R2 summary, never raw bytes passed between steps; links and renders join it in D02 T07 §1 and D03 T02 §1. Done when: `test/checks/evidence.test.ts` loads a parsed forward's summary and an upload's into it with field-level assertions (each cut part's media type and charset kept, from the UTF-16 fixture's summary), and a summary of neither shape is refused. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `src/checks/case-view.ts`; tests "caseViewOf" (the UTF-16 fixture's part keeps `utf-16le`).
- [x] Write `registerCheck({ name, needs, timeoutMs, run })` and `allChecks()` in `src/checks/registry.ts`. Done when: a duplicate name throws. Done 2026-10-29: `CheckRegistry`, `registerCheck`, `allChecks` in `src/checks/registry.ts`, the pipeline's checks registered in `src/checks/index.ts`; tests "the registry".
- [x] Write `saveEvidence(db, caseId, items)` in `src/checks/evidence.ts`: assign `E<n>` in order and validate the whole assigned list against `Evidence` (and each `check` against the registry and `SYSTEM_CHECKS`) before anything is written, then replace the case's evidence in one batch (its delete and inserts together, so a failure leaves the previous list), with the same `n` in the `seq` column (D01 T01 §1's migration `0002_evidence_order.sql` ties `id = 'E' || seq` and requires `detail_json` to be a JSON object and `artefact_keys_json` an array; read in order with `ORDER BY seq`, never by the text id), and `readEvidence(db, caseId)` reading it back in that order. Done when: the test, through `saveEvidence` and `readEvidence`, shows an identical retry storing one list, a shorter list and an empty one replacing a longer, another case's list untouched, a refused list (an over-long summary, an unknown name) and a failing batch each leaving the previous list whole, and twelve items read back `E1` to `E12` in numeric order with every field. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `numbered`, `saveEvidence`, `readEvidence`; tests "saveEvidence", proven to fail with the delete taken out of the batch and with the name check removed.
- [x] Write the `intake.forward` evidence item (info severity, `detail_json.path` from the parsed summary's `forward.path`: `rfc822`, `eml`, `msg` or `inline`, and `detail_json.otherOriginals`, the further attached messages not checked) first for every case with a message, and `intake.upload` (info, the file's kind and media type) first for an uploaded file, so the report can say how the case arrived, both as checks registered ahead of every other in `src/checks/intake.ts`. Done when: a test finds it as `E1` with the path for an attached and an inline fixture, and `intake.upload` as `E1` for an upload. (**Corrected 2026-10-29**, at start.) Source: D01 T01 §4 (deferred there 2026-10-28: it has no evidence writer). Done 2026-10-29: `src/checks/intake.ts` (`forwardEvidence`, `uploadEvidence`); tests "the intake items".
- [x] Write the `intake.truncated` evidence item (info severity) when the parsed summary's `truncated` is not empty (D01 T01 §5), stating the cut's facts only: each cut part with its media type and full and kept sizes, that the report's reading of each part was cut there while its whole text is kept for the checks that read it, and, when `omitted` is above 0, that that many further cut parts (past the 50 kept) were stored only up to their cut. It claims no check's coverage: that a check read a full part is that check's own evidence (D02 T07 §1, D02 T05 §1), so a check that is absent or fails leaves no such claim. Done when: the twenty-part fixture yields one item listing every cut part, a summary with `omitted` 3 yields the further-parts sentence, an uncut message yields none, and no `intake.truncated` text says a part was checked. Source: D01 T01 §5 plan review, 2026-10-28; **corrected 2026-10-29**, plan review. Done 2026-10-29: `truncatedEvidence`; tests "the intake items".
- [x] Commit: `checks: evidence type, IDs and registry` Done 2026-10-29: f88f338, then the review fixes.

**Test checkpoint:** `pnpm exec vitest run test/checks/evidence.test.ts` passes and fails if a summary over 200 characters is accepted.

> **Verified:** 2026-10-29 | §1 | 5b97b90684ad0f337e93b8e357b035b5334eb892
> **Review:** `docs/reviews/d02-t01-s1.json`

## 2. Check runner step with failure isolation

The Workflow `checks` step runs every registered check whose inputs are present, each with its own time budget. A failure produces a `not_checked` evidence item (info severity, the check name, the error class) so the report says what was not checked and the verdict knows coverage is incomplete (spec 4.3a "an outage leaves a not-checked line, never a guess").

> **Started:** 2026-10-29T14:16Z

**Corrected 2026-10-29** (at start, checked against the repository): (1) evidence is stored in D1 by `saveEvidence` (§1), so the `checks` step returns only its count and the `verdict` step reads the case's evidence with `readEvidence`, never a list passed between steps (a step's output is at most 1 MiB); (2) the `checks` step runs under `RETRIES`, four attempts of at most 30 seconds each (`src/pipeline/analysis-workflow.ts`), so every check's budget fits inside one attempt: `registerCheck` refuses a budget over `MAX_CHECK_MS` (20 seconds), and a check that calls a model runs in its own step (D03); a retried step replaces the evidence (§1), never adds to it; (3) "inputs present" is defined per input by `available(view, input)`: `headers` only when the header state says they are the original's (`tenant.headersAvailable`), `text` and `html` when not null, the rest always (an empty attachment list is a fact, not a gap); a skip is one `not_checked` item per missing input naming every check it held back, with the reason, since no header check exists yet and the registry's own checks are tested through fakes; (4) a failure is named by its error class only (`error.name`), never its message, which can carry hostile text.

**Corrected 2026-10-29** (final review): (5) a budget is enforced on work that yields: a Worker cannot stop synchronous JavaScript, and its clocks do not move during it, so a check keeps its own synchronous work bounded (bounded inputs, linear-time parsing), and one that never yields runs until the `checks` step's attempt ends and the case is partial, naming `checks` (D01 T01 §7): an outage line, never a guess, at the step rather than the check; (6) each check gets an `AbortSignal` that aborts when its budget runs out, for the I/O it starts; (7) each check reads a frozen copy of the view, so none can change what its peers see; (8) the registry refuses a check with no `run`, with `needs` that are not view inputs (`CHECK_INPUTS`), or past `MAX_CHECKS` (64), and a check returning anything but a list of at most `MAX_ITEMS_PER_CHECK` (50) items is `EvidenceRefused`; `saveEvidence` inserts eleven rows a statement (D1's 100 bound parameters); (9) the retry is proven where it can be: the step's only write is `saveEvidence`'s replacing batch, called twice by the test for one list, since the Workflow test harness replaces a mocked step's callback rather than running it twice.

**Phase:** 2
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/runner.test.ts` passes unchanged.

**Build order:**

1. Replace the stub `checks` step with `runChecks`. Done when: a fixture case stores evidence from every registered check.

- [x] Write `runChecks(view, registry)` in `src/checks/runner.ts` running the registry's checks concurrently with `Promise.allSettled`, each against its own timeout, and returning their evidence in registration order (each check's items together, whatever finished first), and add `MAX_CHECK_MS` to `registerCheck` in `src/checks/registry.ts`. Done when: `test/checks/runner.test.ts` shows, with controlled promises, every eligible check started before any finishes; three fake checks finishing out of order stored in registration order; one check timing out while another with a longer budget, still running, finishes and stores; and a budget over `MAX_CHECK_MS` refused. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `src/checks/runner.ts`, `MAX_CHECK_MS`; `test/checks/runner.test.ts` "runChecks" and "the registry's budget".
- [x] Turn a thrown error, a rejected promise, a timeout or evidence that `Evidence` refuses into `{ check: "not_checked", severity: "info", summary: "<name> could not run", detail: { check, errorClass }, artefacts: [] }` (`errorClass` the error's name, `Timeout` for a timeout, `EvidenceRefused` for malformed items), in the failing check's place. Done when: each failing fake's item is stored by `saveEvidence` and read back by `readEvidence` beside the successful checks' items, no message text is stored, and the others still store. Cheaper substitute: skipping the failed check silently. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `notChecked`, `runOne`; tests "runChecks" (a throw, a rejection, an over-long summary, a borrowed name, an odd error name; no message text stored).
- [x] Write `available(view, input)` and skip a check whose `needs` are not all available, never calling it, with exactly one `not_checked` info item per missing input naming every check it held back and why (for example the original's headers when it was forwarded inline). Done when: the inline-forward fixture with a fake header check yields the "headers not available" item naming it, and the attached fixture runs the same check; a null `text` or `html` is missing while an empty string is not; an empty attachment list stays available; two checks sharing a missing input give one item naming both; a check missing two inputs appears in both items and is not called. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `available`; tests "available".
- [x] Call `caseViewOf`, `runChecks` and `saveEvidence` from the Workflow `checks` step in `src/pipeline/analysis-workflow.ts`, returning only the count, and have the `verdict` step read the case's evidence with `readEvidence` and hand it to the verdict, its result naming the ids and checks it read beside the view (the stub's view unchanged). Done when: `test/pipeline/analysis-workflow.test.ts` sees the fixture's evidence rows (`E1` the `intake.forward` item), the `checks` step's result is `{ evidence: <count> }`, the `verdict` step's result lists that case's evidence in order, `not_checked` items included, a retried `checks` step leaves one list, and a malformed summary still fails the step. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `checks` and `verdict` in `src/pipeline/analysis-workflow.ts`; `test/pipeline/analysis-workflow.test.ts`, proven to fail with the verdict reading another case.
- [x] Commit: `checks: check runner step with failure isolation` Done 2026-10-29: 25e0458, then the review fixes to 9b6dfc9.

**Test checkpoint:** `pnpm exec vitest run test/checks/runner.test.ts` passes and fails if a failing check stops the others.

> **Verified:** 2026-10-29 | §2 | d8f5abfaf04f5fa22457ae82a64e72a62d620cd7
> **Review:** `docs/reviews/d02-t01-s2.json`

## 3. Check outcomes stored per case

Filed 2026-10-31 at the app lane's request through the coordinator (for D07 T03 §18, the report's count line "9 findings · 8 checks ran · nothing skipped" and the safe board's "Checks that found nothing" panel): the runner stores findings only, so a check that ran clean leaves no row, several findings can share a check, and one `not_checked` item can cover several checks. Each case's check outcomes are stored with its evidence, one row per check, and read back without today's registry, so a renamed or retired check still reads.

> **Started:** 2026-10-31T02:36Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) the migration is `0042_check_outcomes.sql` (the coordinator's number, `docs/coordinator.md`), its rows `REFERENCES cases (id) ON DELETE CASCADE` as `evidence`'s are, so deleting a case (the POPIA deletion, spec 4.8) deletes them, with a `seq` column keeping the registry's order; (2) `runChecks` keeps its result, a list of drafts, for the freeze check: the outcomes come from `runChecksWithOutcomes`, which `runChecks` returns the items of; a failed check's reason is its error's class, as its `not_checked` item names it, never its message, a timeout's `Timeout`; a skipped check's reason is the missing input's sentence; `findings` counts the check's own items, so a failed or skipped check counts 0; (3) `saveEvidence` writes outcomes only when given them (a sixth argument), in the same `db.batch` as the evidence, so its callers before this, and a write without outcomes, leave `check_outcomes` alone; the `checks` step passes them.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/02-checks/D02-T01-s3.md`): (4) a check that returns nothing does not always mean it checked something, so a check whose input is not there says so: `Check.applies(view)` in `src/checks/registry.ts` names why it has nothing to check, and the runner stores it `skipped` with that reason without running it; the twenty checks with such returns have one (the authentication checks without trusted results, the sender checks and `domain.lookalike` without the original's headers, the attachment checks without attachments, `content.hidden_text` without HTML, `content.ai_instructions` without read text, `domain.age` without lookups, `intake.forward` and `intake.upload` for the other kind of case), and a test runs every registered check whose `applies` gives a reason on the real fixtures and finds it returns nothing, so the evidence is unchanged; (5) the tests sit in `test/checks/check-outcomes.test.ts`, since the freeze check runs `test/checks/runner.test.ts` and `test/checks/evidence.test.ts` unchanged: the real `checks` step stores and reads back outcomes beside its evidence (failing when the step passes none), an inline forward's authentication checks are skipped beside checks that ran clean, a failed write fails the step, a replacement with different, shorter and empty sets reads back exactly, the combined batch's failure keeps both previous sets, another case is untouched, and deleting the case deletes its rows; (6) `readCheckOutcomes` returns null for a case with no stored outcomes (checked before this section), never an empty list, so a consumer cannot read missing coverage as checks that found nothing; (7) the consumer is the app lane's D07 T03 §18, whose contract and XREF pair the coordinator adds on main once both sections are there (2026-10-31); 0042 is held for this section in `docs/coordinator.md` on main.

**Phase:** 2
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/runner.test.ts test/checks/evidence.test.ts` passes unchanged.

**Build order:**

1. Store and read each check's outcome. Done when: a case with a clean check, a check with two findings, a skipped check and a failed check reads back four rows with the right outcome, reason and count, after the registry has dropped one of them.

- [x] Add `check_outcomes` (`case_id`, `check_name`, `outcome` of `ran`, `skipped` or `failed`, `reason` nullable, `findings` count; primary key `case_id, check_name`) in a migration whose number the coordinator gives. Done when: the migration applies locally and `PRAGMA table_info` lists the columns.
- [x] Have `runChecks` in `src/checks/runner.ts` return each registered check's outcome beside its drafts (ran with its findings count, skipped with the unmet need it names, failed with its error's kind, the timeout included). Done when: `test/checks/runner.test.ts` reads each outcome for a clean, a finding, a skipped and a timed-out check.
- [x] Write the outcomes in `saveEvidence`'s batch in `src/checks/evidence.ts` (the same `db.batch` as the evidence, replacing the case's rows), so a replayed step gives one set and a failed batch leaves the previous set. Done when: `test/checks/evidence.test.ts` replays a step and fails a batch, reading one set each time.
- [x] Read them with `readCheckOutcomes(db, caseId)` from the stored rows alone. Done when: the test reads a check name the registry no longer has.
- [x] Commit: `checks: check outcomes stored per case` Done 2026-10-31: f659cc37, with the completion review's and the rounds' fixes after it.

**Test checkpoint:** `pnpm exec vitest run test/checks/runner.test.ts test/checks/evidence.test.ts` passes.

> **Verified:** 2026-10-31 | §3 | 055cb1428dd0fcc113752f2ee9a8480280671a72
> **Review:** `docs/reviews/d02-t01-s3.json`

## 4. Check revision stored with each outcome

> **Started:** 2026-10-31T15:12Z

Filed 2026-10-31 from §3's completion review (Part 2.3): an outcome row names its check but not which implementation of it ran, so after a check changes under the same name a stored row cannot say which version produced it. An analysis record such as VirusTotal's keeps each engine's version beside its result.

**Corrected 2026-10-31** (at start, checked against the repository): (1) the binding exists: `wrangler.jsonc` binds `version_metadata` as `CF_VERSION_METADATA` (line 39, typed in `worker-configuration.d.ts`), read today by `src/smoke.ts`; nothing to bind, only to read. (2) `check_outcomes` is keyed by run since D01 T01 §19 (`0051_findings_by_run.sql`: `(case_id, run_id, check_name)`), so the column is added to that table and each run's rows carry their own revision. The migration is `0053_check_revision.sql` (the coordinator's number, 2026-10-31), an `ALTER TABLE check_outcomes ADD COLUMN revision TEXT CHECK (revision IS NULL OR length(revision) BETWEEN 1 AND 100)`: rows from before read null. (3) The revision reaches `saveEvidence` from the `checks` step (`checks()` in `src/pipeline/analysis-workflow.ts`, given `this.env.CF_VERSION_METADATA.id` by the Workflow), not read inside `src/checks/evidence.ts`, which takes no env. (4) `saveEvidence` writes outcomes fourteen rows a statement at seven parameters (98 of D1's 100); an eighth parameter makes that 112, so the rows a statement drop to twelve (96), and 24 checks are registered today, so the split is exercised. (5) `readCheckOutcomes` adds `revision` to an outcome only when the row has one, so a case stored before, and every caller that compares outcomes whole, read as they did; the `CheckOutcome` type (`src/checks/runner.ts`) gains an optional `revision`. The Freeze check's two suites stay unchanged.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/02-checks/D02-T01-s4.md`, run on the Started commit `3245d855` before the migration's number was filled in): (6) the migration is `0053_check_revision.sql`, the coordinator's number; (7) the revision is proven to come from the Workflow, not only stored when given: a test runs a case through `env.ANALYSIS` (the real `checks` callback) and reads the binding's `id` on its outcomes, failing when the Workflow stops passing it; (8) each run keeps its own: a case's first run stores revision A, a retry run of the same case stores B, and `readCheckOutcomes(db, caseId, run)` reads A for the first run while the default read gives B.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/runner.test.ts test/checks/evidence.test.ts` passes unchanged.

**Build order:**

1. Store the deployed Worker's version with each outcome. Done when: a case's outcomes read back the version that ran them, and a case checked before the next deploy keeps its own.

- [x] Add the nullable `revision` column to `check_outcomes` (`src/db/migrations/0053_check_revision.sql`, correction 2), and pass `CF_VERSION_METADATA.id` from the Workflow to `checks()` and on to `saveEvidence` (correction 3). Done when: `pnpm db:migrate:local` applies it, `test/db/schema.test.ts` stores a revision and reads null on a row from before, and `test/checks/check-outcomes.test.ts` runs a case through `env.ANALYSIS` and reads `CF_VERSION_METADATA.id` on its outcomes (correction 7).
- [x] Write it with each outcome in `saveEvidence` (twelve rows a statement, correction 4), zero-finding checks included, and read it in `readCheckOutcomes` (correction 5). Done when: `test/checks/check-outcomes.test.ts` reads the revision back on every one of more than twelve outcomes, reads none on a save without one (outcomes compared whole as before), a later save under another revision leaves an earlier case's rows unchanged, and a retry run of the same case keeps each run's own revision (correction 8).
- [x] Commit: `checks: check revision stored with each outcome`

**Test checkpoint:** `pnpm exec vitest run test/checks/check-outcomes.test.ts test/db/schema.test.ts` passes, and the Freeze check's two suites pass unchanged.

> **Verified:** 2026-11-01 | §4 | b6f745b47e7dff13a85594452708b353b502f0fa
> **Review:** `docs/reviews/d02-t01-s4.json`

## 5. Evidence added by later pipeline steps

> **Started:** 2026-10-31T17:48:12Z

Filed 2026-10-31 from D04 T02 §5's validation (walkthrough lane): `saveEvidence` replaces a case's whole evidence list and only the `checks` step calls it, so a later step (the walkthrough first, D04 T02 §5; then vision, D03, and the verdict, D05) has no way to add its items. Each later producer needs to add its own items after the checks' items, numbered on from them, and to replace only its own items when its step is retried, never another producer's or the checks'. The checks step's replacing write stays as it is for its own items.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/runner.test.ts test/checks/evidence.test.ts` passes unchanged.

> **Corrected 2026-10-31 (at start; coordinator 19:41 SAST; checks lane 19:43 SAST):** (1) The walkthrough lane builds this section (coordinator), `src/checks/evidence.ts` and `registry.ts` being the checks lane's files, told before the change. (2) The migration is `0057_evidence_producer.sql`: `evidence.producer` a nullable `ADD COLUMN`, never a table rebuild, since evidence's rows matter; existing rows keep a null producer, which every reader reads as the checks' (`checks`), and a migration test proves every existing row is untouched. (3) Evidence is kept per run (migration 0051, D01 T01 §19): `saveEvidence` replaces only the case's current run's rows (`CURRENT_RUN_OF`), and a case retry (`retryCase`) starts a new run whose evidence begins empty, so a later run never touches an earlier run's evidence or ids. Every operation here is scoped to the current run in the same way: `addEvidence`'s delete, its highest-`seq` lookup and its inserts; `saveEvidence`'s delete of the checks' own rows. Within one run the checks step writes before any later producer (the Workflow's step order), so a later producer's rows in the current run exist only if the checks step writes again in that run; then `saveEvidence` moves them after its new items in their order, in the same batch, never deleting them (`UNIQUE (case_id, run_id, seq)`). (Plan review P1: the first reading moved a previous run's items.) (4) The Freeze check keeps `test/checks/evidence.test.ts` and `runner.test.ts` byte for byte, so this section's tests are a file of their own, `test/checks/evidence-producers.test.ts`. (5) `saveEvidence`'s parameters do not change (the checks lane's D02 T01 §4, on its own branch, adds a trailing `revision`); `addEvidence` is a separate export, and `readEvidence` keeps its return shape: an item's producer is read through `evidenceProducers(db, caseId, run)`, the current run's unless `run` names another, as `readEvidence` does. (7) Every refusal (an unknown producer, an item outside the producer's family, a malformed item) raises `EvidenceRefused` before anything is written (plan review P2). (6) The checks lane's branch holds another D02 T01 §5 ("Detection-data revision with each outcome", not on main); the graph refuses a gap here, so this stays §5 and the coordinator renumbers one at the merge.

**Build order:**

1. Name the later producers. Done when: an item from a later producer's family validates and an unregistered name is refused.
2. Write a later producer's items. Done when: a producer's items read back after the checks' items with ids numbered on, a retried write replaces only that producer's items, and a checks retry keeps them.

- [x] Add `LATER_PRODUCERS` in `src/checks/registry.ts` (`walkthrough` first): a later producer's items have `check` names in its family (`walkthrough.chain`). `evidenceIn` (`src/checks/evidence.ts`) accepts a `check` whose family is a later producer, beside `SYSTEM_CHECKS`; `register` refuses a check under a later producer's family. Done when: `test/checks/evidence-producers.test.ts` accepts `walkthrough.chain`, refuses `walkthrough_chain` and `nonsense.thing`, and registering a check named `walkthrough.x` throws. Cheaper substitute: registering the walkthrough's names as fake CaseView checks.
- [x] Add migration `src/db/migrations/0057_evidence_producer.sql`: `ALTER TABLE evidence ADD COLUMN producer TEXT` with a check that it is null or a family name (lowercase word). Done when: the test applies the migration's own SQL to a table built like `evidence` before it, holding rows, and reads every row back identical with a null producer, and the applied schema refuses a producer `Walk!`. Cheaper substitute: rebuilding the table, or setting `producer` on existing rows.
- [x] Write `addEvidence(db, caseId, producer, items)` in `src/checks/evidence.ts`: refuse a producer not in `LATER_PRODUCERS`, validate every item (`check` in that producer's family) before anything is written, then in one `db.batch` delete the case's rows of that producer and insert the items with `seq` continuing after the highest `seq` of the case's other rows. Done when: the test shows a producer's items read back after the checks' items numbered on (`E13` after twelve), an identical retry leaving one copy with the same ids, a shorter retry and an empty one (`[]`) replacing only that producer's items, a first write of `[]` storing nothing, the checks' items untouched, an unknown producer, an item outside the producer's family and a malformed item each raising `EvidenceRefused` with the previous list whole, a failing batch leaving it whole too, and another case untouched. Cheaper substitute: an insert that appends without deleting the producer's earlier items.
- [x] Keep a run's later producers' items when its checks write again: `saveEvidence` deletes only the current run's rows whose producer is null or `checks`, writes `checks` on its rows, and in the same batch moves the current run's later producers' rows after its new items in their order. Done when: the test saves twelve checks items, adds three walkthrough items (`E13` to `E15`), writes the checks again with fifteen items and reads the walkthrough items as `E16` to `E18` in the same order, and with five reads them as `E6` to `E8`; a failing batch leaves the previous list whole. Cheaper substitute: deleting every row of the run, or numbering the checks after the later items.
- [x] Keep runs apart: a case retry starts a new run that begins with no evidence. Done when: the test saves checks and walkthrough items, runs `retryCase`, finds the new run's evidence empty (`readEvidence` and `evidenceProducers`), writes the new run's checks and walkthrough items, and reads the first run's items, ids and producers unchanged through `readEvidence(db, caseId, firstRun)` and `evidenceProducers(db, caseId, firstRun)`, each run's list on its own.
- [x] Write `evidenceProducers(db, caseId, run = null)`: the run's items' ids and producers in `seq` order (the current run's unless `run` names another), null read as `checks`. Done when: the test reads `checks` for a row written before the migration (null) and for the checks' rows, and `walkthrough` for the walkthrough's, and `readEvidence` returns one ordered list of both unchanged in shape.
- [x] Commit: `checks: evidence added by later pipeline steps`

**Test checkpoint:** `pnpm exec vitest run test/checks/evidence-producers.test.ts test/checks/evidence.test.ts test/checks/runner.test.ts` passes, and fails if `addEvidence` deletes another producer's or another run's items, ignores an empty replace, or the checks' second write deletes or collides with a later producer's.

> **Verified:** 2026-10-31 | §5 | 7ccf02210038587c9d346c27e1dfcab3bc66708c
> **Review:** `docs/reviews/d02-t01-s5.json`

## 6. Detection-data revision with each outcome

> **Started:** 2026-11-01T03:41Z

**Corrected 2026-11-01:** the plan review found the single item too coarse: the provenance had no source rule for the held value or the fallbacks, the batch size was not recalculated (nine bindings become eleven), pre-migration outcomes and the Workflow path were unproven. It is now four items. A test that hands the metadata straight to storage cannot satisfy the Workflow item.

**Corrected 2026-10-31:** numbered §5 when filed; renumbered §6 by the coordinator's ruling, since the walkthrough lane's §5 ("Evidence added by later pipeline steps") holds that number on `main`.

Filed 2026-10-31 from §4's completion review (Part 2.2): a Worker version names the code that ran, not the data it read. The brand table changes in KV without a deploy (`brandTable` in `src/checks/brands.ts`, its `revision` a date in `src/checks/brand-schema.ts`), and falls back to the bundled table when KV is slow or empty, so two runs under one Worker version can judge by different tables with nothing to tell them apart. An analysis record such as VirusTotal's keeps the engine's update beside its version.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/runner.test.ts test/checks/evidence.test.ts` passes unchanged.

**Build order:**

1. Store the data a run's checks read beside the code that ran them. Done when: a case's outcomes read back the brand table's revision and whether it came from KV or the bundle, and two runs under one Worker version with different tables keep their own.

- [x] Return the table's provenance from `brandTable` (`src/checks/brands.ts`): add `brandTableRead(env, now)` returning `{ table, source }` with `source` `"kv"` when a valid KV copy was used (also when it equals the bundle, so a run is never recorded as bundled for reading KV) and `"bundled"` for every fallback reason (stalled, missing, shrunk, invalid, version, refused), and keep `brandTable` returning the table. The 60-second held value keeps its own `source`, so a cache hit reports the source of the read that filled it. Done when: `test/checks/brands.test.ts` reads `source` for a KV table, a KV copy identical to the bundle (still `kv`), each fallback reason (`bundled`), a cache hit within `HELD_MS` (the filling read's source) and after expiry (the new read's), and the held value of one namespace never gives another's.
- [x] Store each run's table beside its outcomes: add `data_revision` and `data_source` (nullable, `data_source` CHECK in `('kv','bundled')`) to `check_outcomes` in a migration under the number the coordinator gives (an `ADD COLUMN` pair, never a rebuild; `src/db/migrations/0060_check_outcome_summary.sql` is the pattern), pass them through `saveEvidence` (`src/checks/evidence.ts`) as one `data` argument beside `revision`, and read them back in `readCheckOutcomes` as `data?: { revision, source }` only when stored. Done when: `test/checks/check-outcomes.test.ts` stores two runs of one case under the same Worker version, one with a KV table and one falling back to the bundled table, and reads each run's own revision and source (the earlier run by its run id); and an outcome written before the migration (inserted without the columns on a populated table) reads back with every field it had and no `data`, never today's table.
- [x] Recalculate the outcome insert size: with two more bindings each row binds eleven parameters, so `OUTCOMES_PER_INSERT` (`src/checks/evidence.ts`) becomes 9 (nine rows keep to D1's hundred). Done when: `test/checks/check-outcomes.test.ts` stores more than 18 outcomes (three statements) and reads every one's revision, source and summary back, and its statement-size assertion states the new bindings per row (11) and fails on a size that exceeds 100 parameters.
- [x] Carry the provenance through the real Workflow: the `checks` step of `src/pipeline/analysis-workflow.ts` reads the table with `brandTableRead` and passes `source` and `revision` to the stored outcomes. Done when: a test through `env.ANALYSIS` runs the Workflow twice over mail whose verdict depends on the table, once with a KV copy that lists a brand the bundle lacks and once with KV empty, and reads from storage both runs' own `data_revision` and `data_source` and the brand-dependent evidence each produced; it fails when the Workflow stops forwarding the provenance, or records a different table from the one the checks used.
- [x] Commit: `checks: detection-data revision with each outcome`

**Test checkpoint:** `pnpm exec vitest run test/checks/check-outcomes.test.ts test/checks/brands.test.ts test/pipeline/analysis-workflow.test.ts` passes.

> **Verified:** 2026-11-01 | §6 | b559682f7942cc4baa69bdd92456f3c5fa5110a8
> **Review:** `docs/reviews/d02-t01-s6.json`

## 7. Each check's result summary with its outcome

> **Started:** 2026-10-31T23:29Z

Filed 2026-10-31 at the app lane's request, through the coordinator (D07 T03 §18, the report's count line and "Checks that found nothing"): a check that ran clean says only `ran` today, since `check_outcomes` (§3) keeps the outcome, its reason and the count of findings. The Report-Safe board shows each clean check saying what it saw ("Links: 1, to fynbosfreight.example", "Logo: matches the registered logo", "First-time sender: no, 14 months of mail").

**Corrected 2026-11-01** (at start, checked against `src/checks/registry.ts`, `src/checks/runner.ts` and `src/checks/evidence.ts`): (1) the migration is `0060_check_outcome_summary.sql`, the number the coordinator holds for this section (`docs/coordinator.md`, 0060); (2) a ninth column makes an outcome row nine parameters, so `OUTCOMES_PER_INSERT` drops from 12 to 11 (99 of D1's 100; 12 rows would be 108), with a test of a case with more outcomes than one statement holds; (3) the summary is computed by the runner (`runChecksWithOutcomes`, `src/checks/runner.ts`), which holds each check's view and its own items, and carried on `CheckOutcome` as `summary`, so `saveEvidence` writes what the runner gives it; (4) no logo check is registered yet (the registered names are the `attachment`, `auth`, `content`, `domain`, `intake`, `link` and `sender` checks), so the logo's summary is written by the section that registers that check, and this section writes one for every check registered today; (5) the Freeze check holds `test/checks/runner.test.ts` and `test/checks/evidence.test.ts` unchanged, so this section's tests go in `test/checks/check-outcomes.test.ts` (existing, extended) and `test/checks/check-summaries.test.ts` (new).

**Corrected 2026-11-01** (plan review, five P2): (6) a summary is stored without its check's label, since D07 T03 §44 draws "<check words>: <summary>" ("Links: 1, to fynbosfreight.example" is stored as "1, to fynbosfreight.example"), so the label is never doubled; (7) a summary is checked before it is stored by the rule an evidence item's summary keeps (`UNPLAIN` in `src/checks/evidence.ts`, exported for it: no control, format, line or paragraph separator character, no markup) and at most 120 characters; one that fails, throws or is empty is stored as null, and the outcome and the check's evidence are kept; (8) the links summary is built to fit: domains are added while the whole stays within 120 characters, the rest counted ("and 3 more"), and when not even one fits it says how many ("5, to 5 domains"); (9) `auth.arc` (`src/checks/arc.ts`) writes no item when the message has no ARC set, and `auth.results` lives in `src/checks/auth-results.ts`, so each of those summaries reads the view the check reads, not an item; (10) each family's test asserts the exact summary for contrasting inputs (a first and a seen sender, a pass and a fail, one domain and many, none and some attachments), so a constant summary fails, and the Test checkpoint runs `test/checks/check-summaries.test.ts`.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/runner.test.ts test/checks/evidence.test.ts` passes unchanged.

**Build order:**

1. Store a short summary of what each check saw with its outcome. Done when: each registered check that ran writes a plain-text summary of at most 120 characters, stored with its outcome and read back with it, holding nothing from the message beyond what that check's own card already shows.

- [x] Add an optional `summary(view, evidence)` to a check's registration (`src/checks/registry.ts`) and store its result in a nullable `summary` column of `check_outcomes` (a length CHECK of at most 120, migration number from the coordinator), written by `saveEvidence` (`src/checks/evidence.ts`) and read by `readCheckOutcomes`; a summary that throws, is empty, is longer than 120 characters or breaks the `UNPLAIN` rule is stored as null and the outcome and evidence are kept (correction 7). Done when: `test/checks/check-outcomes.test.ts` reads a summary back for a check that ran, null for one that was skipped, partial or failed, and null for one whose summary throws, runs past 120 characters, or holds a control, bidirectional or line-separator character, each with its outcome and evidence intact.
- [x] ~~Write the summaries of the checks the Report-Safe board names (links, logo, first-time sender) and of the others that run on every case, each from that check's own evidence and view fields.~~ **Corrected 2026-11-01** (at start: one coarse item split by family, below; the logo's summary is the logo check's section's, correction 4).
- [x] Write the links summary (`link.text_mismatch`, `src/checks/links.ts`): from `view.links`, the count of links read and their distinct registrable domains as its card names them (stored "1, to fynbosfreight.example"), fitted to 120 characters (correction 8). Done when: `test/checks/check-summaries.test.ts` reads the exact summary for one link, for five domains, for long domains that fit only in part, and for one domain longer than the space, and none stored for a body without links, which is `skipped` with its reason ("the case has no links").
- [x] Write the sender summaries (`sender.first_time`, `sender.display_address`, `sender.display_brand`, `sender.reply_to`, `sender.return_path`, `src/checks/sender.ts`) from `view.senderHistory` and the headers each card shows: first-time sender stored as "no, seen before" or "yes" (`view.senderHistory` is `"first"` or `"seen"`, with no span of time: the board's "14 months of mail" needs the familiarity D02 T02 §8 reads, so that wording is written there). Done when: `test/checks/check-summaries.test.ts` reads the exact summary of each for contrasting inputs (a first and a seen sender; a matching and a mismatched display name).
- [x] Write the domain summaries (`domain.age`, `src/checks/domain-age.ts`; `domain.lookalike`, `src/checks/domain-lookalike.ts`) from `view.domainAges` and the domains each card names. Done when: `test/checks/check-summaries.test.ts` reads the exact summary of each for contrasting inputs (an old and a new domain; no lookalike and one).
- [x] Write the authentication summaries (`auth.spf`, `auth.dkim`, `auth.dmarc`, `auth.alignment` in `src/checks/auth.ts`; `auth.arc` in `src/checks/arc.ts`; `auth.results` in `src/checks/auth-results.ts`): each result and the domain it is for, as its card shows it, from the check's own item (each writes one, a pass included: `methodEvidence`, `dmarcEvidence`), shortened to fit, never the receiving system's raw header; `auth.arc` and `auth.results` from the view they read (correction 9). Done when: `test/checks/check-summaries.test.ts` reads the exact summary of each for a pass and a fail, and for a message with no ARC set (`arc=none`) through the runner, storage and read-back.
- [x] Write the attachment, content and intake summaries (`attachment.*`, `content.ai_instructions`, `content.hidden_text`, `intake.*`): the count read and what was found, never a filename or text the card does not show. Done when: `test/checks/check-summaries.test.ts` reads the exact summary of each for contrasting inputs (no attachments and some; no hidden text and some).
- [x] Prove no summary carries more of the message than its card. Done when: `test/checks/check-summaries.test.ts` runs every registered check on a case whose subject, body, link text and filenames carry a marker string, and no stored summary holds it; and fails when any registered check has no summary.
- [x] Commit: `checks: each check's result summary with its outcome`

**Test checkpoint:** `pnpm exec vitest run test/checks/check-outcomes.test.ts test/checks/check-summaries.test.ts test/checks/runner.test.ts` passes.

> **Verified:** 2026-11-01 | §7 | f93e6a88e16b14616d2401af5c7a5079c490d6e1
> **Review:** `docs/reviews/d02-t01-s7.json`

## 8. Examined set stored for a clean check

> **Started:** 2026-11-02T21:12Z

Filed 2026-11-02 from the coordinator's routing (report lane, D07 T09 §10): a check that finds nothing stores its outcome but not what it examined, so a clean result cannot show its targets. This section stores, per clean check, the examined set: the targets as stored text, bounded, with omissions named.

**Corrected 2026-11-02** (at start, checked against the tree): (1) storage is one nullable text column `examined` on `check_outcomes` (the targets as a JSON list with the omitted count), under migration `0089` (the coordinator's, 2026-11-03T00:14, applied through this section's gate, never directly); (2) the mechanism is an optional `examined` hook on a registered check in `src/checks/registry.ts`, read by the runner (`src/checks/runner.ts`) only when the check ran over all its input and found nothing, its targets bounded as stored text with the omitted count named; a check with findings, a partial or skipped check stores none; (3) which checks name targets is settled by a registry audit at build: every check that can list its targets from the case view without a new read implements the hook in this section, and the audit's list is recorded in the section when built.

**Corrected 2026-11-02** (plan review, `docs/reviews/02-checks/D02-T01-s8.md`): (4) the stored shape is `{targets, omitted}`: at most 50 targets, each at most 255 characters as stored, the whole JSON at most 8,000 bytes cut from the end with `omitted` counting what was left out; an examined empty set stores `{targets: [], omitted: 0}` and is never confused with the null of a check that stored none (no hook, findings, partial, skipped, failed, or its hook's data unavailable); (5) a hook that throws or returns malformed entries loses only its examined set, never the outcome or the evidence; (6) the new column makes thirteen bound parameters a row, so outcome batches drop to seven rows (`OUTCOMES_PER_INSERT`), proven by a stored set crossing that boundary; (7) the new tests live in `test/checks/examined.test.ts`, not the frozen suite, and every audited producer gets a contrasting fixture through runner, storage and `readCheckOutcomes`, with exclusion proven for findings, partial, skipped and failed outcomes.

**Corrected 2026-11-03** (registry audit at build, correction 3): of the 38 registered checks, 17 implement the hook: `intake.truncated` (the cut parts), `sender.display_address`, `sender.display_brand`, `sender.reply_to`, `sender.return_path` and `sender.first_time` (the From mailbox or domain, the reply and bounce addresses), `domain.lookalike` (the header and link domains compared), `attachment.type_mismatch` (each attachment compared), `attachment.macro`, `attachment.encrypted_archive` and `attachment.executable` (each attachment read), and `link.text_mismatch`, `link.redirects`, `link.final_domain_changed`, `link.credential_form`, `link.card_form` and `link.lure_button` (each link, followed page and landing page). The other 21 store none: 15 always report or skip instead of running clean (`intake.forward`, `intake.upload`, `auth.results`, `auth.spf`, `auth.dkim`, `auth.dmarc`, `auth.alignment`, `domain.age`, `attachment.html`, `voice.transcript`, `voice.limits`, `voice.lure`, `reputation.listing`, `reputation.counter_signal`, `reputation.coverage`), and 6 examine nothing enumerable from the view (`auth.arc`, `content.hidden_text`, `content.ai_instructions`, `voice.request`, `voice.claimed_identity`, `voice.urgency`).

**Phase:** 7
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/evidence.test.ts` passes unchanged.

**Build order:**

1. Store what a clean check examined. Done when: a clean check's stored outcome names its targets, bounded, with any omission stated.

- [x] Carry an examined set on the check outcome in `src/checks/runner.ts` (the targets as stored text, at the outcome's bound, the count and kind of anything omitted named) through `saveEvidence`'s outcome storage in `src/checks/evidence.ts`, for a check with no items. Done when: `test/checks/examined.test.ts` reads a clean check's targets back through `readCheckOutcomes`, and a set past the bound reads back cut with its omissions named.
- [x] Audit the registry and implement the `examined` hook for every check that can list its targets from the case view without a new read, recording the audit's list here when built. Done when: `test/checks/examined.test.ts` proves each audited producer's exact targets and omissions through runner, storage and read-back, and exclusion for findings, partial, skipped and failed outcomes. (**Corrected 2026-11-02**, plan review, `docs/reviews/02-checks/D02-T01-s8.md`.)
- [x] Commit: `checks: examined set stored for a clean check`

**Test checkpoint:** `pnpm exec vitest run test/checks/examined.test.ts test/checks/evidence.test.ts` passes, and fails if a clean check stores no examined set.

> **Verified:** 2026-11-03 | §8 | ce1236bd13e1e8ff637e6f048fdafeeb10e8825f
> **Review:** `docs/reviews/d02-t01-s8.json`

## 9. Protected-identity candidate for the trust match

> **Started:** 2026-11-03T01:08Z

Filed 2026-11-03 from the coordinator's routing (trust lane, D05 T02 §2): the trust match reads a protected identity's registered facts through a bounded candidate input the checks step fills on the case view, the same form as the document forensics fill trust already takes (D06 T02 §3). This section owns the checks side: the view field, its bound, and the fill; trust builds its matching and claim evidence contract against that input and stamps when the fill gates to main.

**Phase:** 7
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/evidence.test.ts` passes unchanged.

**Build order:**

1. Fill a bounded protected-identity candidate on the case view. Done when: the trust match reads the candidate from the view, and no registered identity detail beyond the candidate's bound reaches a check.

- [ ] Add the candidate field to `CaseView` in `src/checks/case-view.ts`: the protected business's candidate names and domains as stored text, with its registered logo references (artefact keys, never bytes), each list bounded with its omission counted, in the shape trust D05 T02 §2 names at its build. Done when: `test/checks/case-view.test.ts` (or its successor) reads the field back with its bounds held on an over-bound input.
- [ ] Fill the field in the `checks` step in `src/pipeline/analysis-workflow.ts` from the case's own organisation data, beside the fills it already makes, failing as the step's other fills fail. Done when: a checks-step test stores a case whose view carries the candidate, and a case with no protected identity carries none. Cheaper substitute: letting the trust match read the registry itself from the checks step, which crosses the lane's storage boundary.
- [ ] Commit: `checks: protected-identity candidate for the trust match`

**Test checkpoint:** `pnpm exec vitest run test/pipeline/analysis-workflow.test.ts` passes, and fails if a candidate names a business the case's organisation does not protect.

## Verification

- Every check runs under the runner, failures become `not_checked` evidence, and evidence IDs are stable per case.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
