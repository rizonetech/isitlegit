---
schema_version: 1
id: report-follow-ups
domain: 07-app
status: active
title: "TODO-09 -- Report Follow-ups"
track: day-2
---

# TODO-09 -- Report Follow-ups

> **Goal:** The report page's early authentication card keeps getting faster and clearer after its first version: the results are stored before the slow checks run, and the kinds of authentication error are told apart in plain words.

> **Current state:** Measured 2026-11-01. D07 T03 §37 draws the card from the stored `auth.*` outcomes and items once the checks step stores them; that step also runs slower checks first, and every inconclusive result reads "Could not be checked" on the card.

## Inputs

- `design/SPEC.md` M3 (the early authentication card, board `Report-Running-Early`)
- -> XREF: D07 T03 §37 -- the early card these sections extend; its completion review filed both
- The stored check outcomes (D02 T01 §3) the card reads, whose storage order §1 changes

## Outcome

- A running report shows the authentication card within one poll of the authentication outcomes being stored, before the slow checks finish.
- A temporary error, a permanent error and a result that decides nothing each read in their own plain words on the card.

**Adjacency:** list=not-applicable (no list surface); document=applicable @ D07 T03 §37; settings=not-applicable (no tunables); reporting=not-applicable (no counts change); notifications=not-applicable (no mail); permissions=not-applicable (the report's own rule, unchanged); audit=not-applicable (nothing new is recorded); exchange=not-applicable (no export); reverse=not-applicable (nothing to undo)

**Adjacency rationale:** Both sections change only what the running report draws and when its stored facts land; access, recording and every other surface stay as §37 left them.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Early results first | D07 T03 §37 | [ ] |
| 2 | §2 | Kinds of auth error | D07 T03 §37 | [ ] |
| 3 | §3 | Dispute from inside the mailbox | D07 T03 §22 | [ ] |

## 1. Early results first

Filed 2026-11-01 from D07 T03 §37's completion review: the card can only draw once the checks step stores its outcomes, and that step also runs slower work (link following, landing pages, domain age), so results a member could act on wait behind unrelated work. The pipeline change is the checks lane's; this section owns the report's side and its proof.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the early authentication card, `Report-Running-Early`), unchanged
**Job:** a member sees the authentication results within one poll of them being stored
**Treatment:** the same card, drawn as soon as the authentication outcomes alone are stored
**Chrome:** the early card (D07 T03 §37)

**Build order:**

1. Store authentication outcomes first, then draw from them. Done when: a running case whose slow checks still run shows the card.

- [ ] Ask the checks lane (through the coordinator) to store the `auth.*` outcomes and items before the slower checks run, in `src/pipeline/analysis-workflow.ts`. Done when: the producer stores them first and the run's later outcomes join them under the same run id. Cheaper substitute: a second card fed by a separate read, which can disagree with the stored outcomes.
- [ ] Draw the card from those early outcomes in `ReportLive` (`src/web/pages/report-live.tsx`) with no other change. Done when: `test/web/report-status.test.ts` stores only the auth outcomes through the status route and finds the card while the checks step is still running. Cheaper substitute: polling faster, which shows the same late facts sooner.
- [ ] Prove the timing in `test/node/report-status-browser.test.tsx`: the card appears on the first poll after the auth outcomes land. Done when: the test counts one poll between the store and the card. Cheaper substitute: asserting the card eventually appears, which passes however late it lands.
- [ ] Commit: `web: early authentication results before the slow checks`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/report-status.test.ts` and `pnpm exec vitest run --project browser test/node/report-status-browser.test.tsx` pass with the card drawn from auth outcomes alone.

## 2. Kinds of auth error

Filed 2026-11-01 from D07 T03 §37's completion review: the card reads every inconclusive result (a temporary receiver error, a permanent configuration error, a result that decides nothing) as "Could not be checked" with the item's summary, where Defender's authentication view names the kind. The stored item keeps each result's raw value (`detail.results[].result`), so the kinds can be told apart on the card once the board's words are approved.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the early authentication card, `Report-Running-Early`), its pill words extended once approved
**Job:** a member tells a temporary error from a broken configuration without reading headers
**Treatment:** one plain sentence per kind, from the stored raw result
**Chrome:** the early card (D07 T03 §37)

**Build order:**

1. Record the words, then split the inconclusive state. Done when: each kind draws its own sentence.

- [ ] Ask the operator (through the coordinator) for the pill and sentence for a temporary error, a permanent error and a result that decides nothing; record the answer in `design/SPEC.md` M3. Done when: the words are in the SPEC. Cheaper substitute: the raw header value as the sentence, which a member cannot read.
- [ ] Split `inconclusive` on the early card in `src/web/pages/report-live.tsx` by the stored raw results (`temperror`, `permerror`, `neutral` and their DMARC equivalents). Done when: `test/web/report-status.test.ts` draws each kind with its approved words and a mixed set names the first that applies. Cheaper substitute: one "Could not be checked" for every kind, which is what ships today.
- [ ] Commit: `web: kinds of authentication error on the early card`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/report-status.test.ts` passes with each kind worded apart.

## 3. Dispute from inside the mailbox

Filed 2026-11-01 from D07 T03 §22's completion review: Outlook's Report and Not junk flow lets a reader dispute a classification inside the mailbox, in its existing session, where IsItLegit sends the reader to a browser report and perhaps through sign-in first. A mailbox-native action needs an integration no section owns yet (an Outlook add-in or a mail-client action), so it is recorded here rather than improvised.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the dispute, board `Report-Dispute`) and N1, extended once the operator chooses the surface
**Job:** a member disputes a verdict from the mailbox, in at most two activations
**Treatment:** the mailbox's own action, carrying the same one-press intent to the same stored feedback
**Chrome:** the dispute control (D07 T03 §22)

**Build order:**

1. Choose the surface, then carry the intent through it. Done when: a dispute from the mailbox is stored as the same feedback.

- [ ] Ask the operator (through the coordinator): an Outlook add-in action, a mail-client button, or no mailbox surface; record the answer and its date in `design/SPEC.md`. Done when: the choice is in the SPEC. Cheaper substitute: a second feedback store for the mailbox, which the operator's queue would read twice.
- [ ] Carry the chosen action to `POST /r/:caseId/feedback` (the dispute route, D07 T03 §6) with the member's own authentication. Done when: `test/web/feedback.test.ts` stores a dispute sent through the chosen surface and the operator's notice goes once. Cheaper substitute: an unauthenticated action link, which anyone holding the mail could press.
- [ ] Commit: `web: dispute from inside the mailbox`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/feedback.test.ts` passes with a mailbox dispute stored once.

## Verification

- The card renders from the early outcomes at phone and desktop widths with no accessibility violations.
- `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass.
