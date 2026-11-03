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
- -> XREF: D07 T03 §13 -- the walkthrough card renderer §7 extends
- -> XREF: D04 T02 §6 -- the walk producer whose refusal and reuse shapes §7 draws
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
| 3 | §3 | Dispute from inside the mailbox | D07 T03 §22 | [x] |
| 4 | §4 | Measured phone attribution | D07 T03 §43 | [x] |
| 5 | §5 | Per-provider reputation results | D07 T03 §12 | [ ] |
| 6 | §6 | The voice note's player and transcript | D07 T03 §16 | [x] |
| 7 | §7 | Walkthrough refusal and reuse cards | D07 T03 §13, D04 T02 §6 | [x] |
| 8 | §8 | Bounded preview image transfer | D07 T03 §55 | [x] |
| 9 | §9 | Complete decoded run on the card | D07 T03 §29 | [ ] |
| 10 | §10 | Every target a clean check examined | D07 T03 §44 | [ ] |
| 11 | §11 | Outcome and reason beside each version | D07 T03 §39 | [x] |
| 12 | §12 | Detection data beside each version | D07 T03 §39 | [x] |
| 13 | §13 | A fresh walk from a reused card | §7 | [ ] |
| 14 | §14 | Abandoned preview response during a retry | §8 | [ ] |
| 15 | §15 | Detection data freshness beside the version | §12 | [ ] |
| 16 | §16 | Two activations for a signed-out member | §3 | [ ] |
| 17 | §17 | Human and Defender attribution comparison | §4 | [ ] |
| 18 | §18 | Playback failure, retry and follow-along | §6 | [ ] |

## 1. Early results first

> **Started:** 2026-11-03T01:16:34Z

Filed 2026-11-01 from D07 T03 §37's completion review: the card can only draw once the checks step stores its outcomes, and that step also runs slower work (link following, landing pages, domain age), so results a member could act on wait behind unrelated work. The pipeline change is the checks lane's; this section owns the report's side and its proof.

**Phase:** 7
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

**Phase:** 7
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

> **Started:** 2026-11-02T21:13:35Z

Filed 2026-11-01 from D07 T03 §22's completion review: Outlook's Report and Not junk flow lets a reader dispute a classification inside the mailbox, in its existing session, where IsItLegit sends the reader to a browser report and perhaps through sign-in first. A mailbox-native action needs an integration no section owns yet (an Outlook add-in or a mail-client action), so it is recorded here rather than improvised.

**Phase:** 7
**Operator decision 2026-11-02:** A mail-client action link: an authenticated action link in the reply mail opens the dispute into the same stored feedback (recorded in design/SPEC.md, as the section requires).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the dispute, board `Report-Dispute`) and N1, extended once the operator chooses the surface
**Job:** a member disputes a verdict from the mailbox, in at most two activations
**Treatment:** the mailbox's own action, carrying the same one-press intent to the same stored feedback
**Chrome:** the dispute control (D07 T03 §22)

**Build order:**

1. Choose the surface, then carry the intent through it. Done when: a dispute from the mailbox is stored as the same feedback.

- [x] Record the operator's choice (2026-11-02: a mail-client action link) in `design/SPEC.md` M3 and N1: the signed, expiring report link already in the reply mail (both parts, D07 T03 §22) carrying the dispute intent is the mailbox surface, and opening it saves nothing. Done when: the SPEC names the choice, its date, and that a mail scanner or a forwarded link alone stores no feedback. Cheaper substitute: a second feedback store for the mailbox, which the operator's queue would read twice.
- [x] Carry the chosen action to `POST /r/:caseId/feedback` (the dispute route, D07 T03 §6) with the member's own authentication: activation one opens the link on the report with the dispute intent (signed in, or through sign-in with the intent kept); activation two is the one-press button, posting with the member's session; an expired link, a signed-out reader who is not a member of the case's organisation, and a removed member are refused by the existing checks and store nothing. Done when: `test/web/feedback.test.ts` generates the dispute address from the reply mail's own template, follows it storing nothing, signs in with the intent kept, stores the dispute once with the operator's notice sent once, and refuses a non-member holding the link. Cheaper substitute: an unauthenticated action link, which anyone holding the mail could press.
- [x] Prove the journey in `test/node/feedback-browser.test.tsx`: from the mail's dispute address to the focused one-press button in at most two activations, at phone width, by keyboard, with the sending, saved, and failed-or-uncertain states, the optional note, Change and Withdraw kept, and a reload that reads the saved dispute back without a second notice. Done when: the browser test counts the activations and reads the saved state back after reload. Cheaper substitute: a storage assertion alone, which cannot show the journey a member takes.
**Corrected 2026-11-02:** activation one (the mail link's landing, signed out and signed in) is proven in `test/web/feedback.test.ts`, which follows the generated mail's own address through the real route; the browser test proves activation two on the rendered report. It said both in the browser, whose fixture server cannot exercise the signed route. The signed dispute link also failed verification (`dispute` counted among the signed parameters): fixed in `src/web/pages/report.tsx` in this section.
- [x] Commit: `web: dispute from inside the mailbox`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/feedback.test.ts` and `pnpm exec vitest run --project browser test/node/feedback-browser.test.tsx` pass with a mailbox dispute stored once.

> **Verified:** 2026-11-02 | §3 | 242b00733f831577f9d6e969534c661caddc45e2
> **Review:** `docs/reviews/d07-t09-s3.json`

## 4. Measured phone attribution

> **Started:** 2026-11-02T21:44:19Z

Filed 2026-11-01 from D07 T03 §43's completion review: the phone attribution is placed as the board draws it, but nothing measures whether a phone reader finds who brought a case in faster, or confuses them with the sender, against the strongest comparable surface (Defender's submission views name "Reported by" by default). The section is the measurement, not a redraw.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the phone attribution, board `Report-Mobile-Attribution`), unchanged unless the measurement says otherwise
**Job:** evidence that the attribution does its job on a phone
**Treatment:** a timed identification check against the benchmark's shape
**Chrome:** the report header (D07 T03 §43)

**Build order:**

1. Measure, then record. Done when: the result is in the section or the SPEC, with the numbers.

- [x] Run the identification check in `eval/phone-attribution.ts`: scripted phone readers (a deterministic top-to-bottom viewport scan at 360 px, reading visible text in reading order and scrolling by viewport, the protocol defined in the script) timed identifying who brought a case in, on the shipped report and on the benchmark shape (the same report without the phone attribution line, the submitter named only in Submission details; a versioned fixture in the script, labelled a reconstruction of the pre-§43 surface, matched case content and viewing conditions). Synthetic cases name a distinct sender and submitter across the attribution's channel variants (forwarded by a member, uploaded, forwarded with the original attached). Done when: the check writes its raw observations (per case and run: scroll actions, first identity met, correct identification, scan time, presentation order, stimulus version, app revision) under `eval/` and reports each median and any sender confusion, rerunning reproduces the same medians within the script's stated rounding, and a case whose rendering lacks either identity fails the run rather than timing out quietly. Cheaper substitute: counting the line's presence, which §43 already proves.
- [x] Prove the analysis separately in `test/node/phone-attribution.test.ts`: known-input tests for the median and confusion calculations and for rejecting missing or invalid observations, run against the pure analysis in `eval/phone-attribution.ts`. Done when: a wrong median, a missed confusion, or an accepted invalid observation fails it. Cheaper substitute: asserting that numbers print, which passes on any arithmetic.
- [x] Record the outcome in `design/SPEC.md` M3 against the criteria set here in advance: the placement stands only when the shipped report's median scroll actions are lower, no scripted reader meets the sender first on any shipped case, and its median scan time is not higher; anything else is recorded as inconclusive or adverse with its sample counts and the stated limit (a scripted scan is a proxy for human reading, not human times). An adverse or inconclusive result files the follow-up that owns the redesign and remeasurement; this section does not redraw the board. Done when: the SPEC carries the numbers, their date and app revision, and the verdict against these criteria. Cheaper substitute: a claim without numbers.
- [x] Commit: `eval: phone attribution measured`

**Corrected 2026-11-02:** the confusion criterion above is read as the completion review corrected it (the shipped line presents the sender first and the labelled submitter in the same line, so meeting the sender's name first in that line is not confusion): confusion is needing navigation to tell the submitter from the sender at all. The readers run on the shipped report itself in `test/node/phone-attribution-measure.test.tsx`, which writes the raw observations `eval/phone-attribution.ts` analyses; the human claim is D07 T09 §17's.

**Test checkpoint:** `PHONE_BENCH=1 pnpm exec vitest run --project browser test/node/phone-attribution-measure.test.tsx` writes the observations, `node eval/phone-attribution.ts` reports both medians, and `pnpm exec vitest run --project node test/node/phone-attribution.test.ts` passes.

> **Verified:** 2026-11-03 | §4 | eaa9e008d46e200d22adaadfb7f51176d034b21c
> **Review:** `docs/reviews/d07-t09-s4.json`

## 5. Per-provider reputation results

Filed 2026-11-01 from D07 T03 §12's completion review: the reputation cards show a listing and its counter signals, but not one result per provider per subject (listed, clear, unavailable), nor when each answer was obtained or whether it was cached, where VirusTotal shows a checked and listed count with each provider's own result. That needs a richer producer shape from the checks lane first.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, extended once the producer shape lands
**Job:** a reader weighs how much agreement a listing really has
**Treatment:** one row per provider and subject, with its state and age
**Chrome:** the reputation cards (D07 T03 §12)

**Build order:**

1. Store each provider's answer, then draw it. Done when: a subject shows every provider's state and when it was obtained.

- [ ] Ask the checks lane (through the coordinator) to store one result per provider per subject in the reputation items (listed, clear or unavailable, with the time obtained and whether it was cached). Done when: the stored shape is in the producer and named in this section. Cheaper substitute: deriving a count from the corroboration flag, which §12's review showed invents agreement.
- [ ] Draw the per-provider rows in `src/web/components/evidence/cards.tsx` with the checked and listed counts they support. Done when: `test/web/evidence-cards.test.ts` draws listed, clear and unavailable rows for one subject with their times, and no count is drawn that the rows do not support. Cheaper substitute: the listing alone, which hides how many providers were asked.
- [ ] Commit: `web: per-provider reputation results`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts` passes with per-provider rows drawn.

## 6. The voice note's player and transcript

> **Started:** 2026-11-02T23:38:28Z

Filed 2026-11-01 from D07 T03 §16's validation: the `Report-Voice` board draws a player and a timed transcript with the request highlighted, but no producer stores a transcript or player evidence item, so there is nothing stored to draw. The transcript exists as a case artefact; an evidence item naming its segments is the checks lane's to store first.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 voice note state, board `Report-Voice`
**Job:** a reader hears the recording and reads what was said, with the request marked
**Treatment:** the board's player and timed transcript, from a stored transcript item

> **Deferred:** playback failure wording and retry, and follow-along playback -> XREF: D07 T09 §18
**Chrome:** the voice cards (D07 T03 §16)

**Build order:**

1. Store the transcript as evidence, then draw it. Done when: a stored transcript draws its segments with the request marked.

- [x] Ask the checks lane (through the coordinator) to store a transcript evidence item (its segments with their times, the recording's artefact key, the speaker count and language). Done when: the stored shape is in the producer and named in this section. Cheaper substitute: reading the artefact in the page, which bypasses the evidence contract every other card follows.
- [x] Serve the recording for playback in `src/web/pages/artefacts.tsx`: an `inline=1` ask for an audio file answers with its media type, inline, under the route's existing ownership and signed-link checks. Done when: `test/web/artefacts.test.ts` (or the artefact route's own suite) plays the bytes for a member and for a signed-link holder, and refuses everyone else as before. Cheaper substitute: an attachment download, which no player can play in place.
- [x] Draw the player and transcript in `src/web/components/evidence/cards.tsx`: the recording through the artefact route (`<audio controls>`), each segment at its time with its chunk's speaker label, the request's segments marked, every word as text. The request reaches the card from the case's `voice.request` item's verified quote, matched across the transcript's segments (every segment the quote spans is marked; an absent or unmatched quote marks nothing). `complete: false`, gaps, cut markers (`trimmed` and the omission counts), a malformed transcript and an empty one each draw their own words. Done when: `test/web/evidence-cards.test.ts` draws a stored transcript with its request marked (including across segments), a hostile segment as text, and each incomplete state. Cheaper substitute: the quotes alone, which is what the voice cards already show.
- [x] Prove the player in `test/node/evidence-cards-browser.test.tsx` at 360 px in both themes: the recording loads through the artefact route, plays by keyboard, shows its duration, and an unavailable recording states its failure with a retry; no overflow and no accessibility violations. Done when: the browser test drives the native controls and reads the played state back. Cheaper substitute: a rendered `<audio>` element alone, which passes with playback broken.

**Corrected 2026-11-02 (coordinator, checks D01 T03 §16 stamped):** the stored shape holds no speaker count and no language. One `voice.transcript` item per recording carries timed segments (`chunk`, per-chunk `speaker` label, `startMs`, `endMs`, `text`), the recording and transcript artefact keys, `complete` and `gaps`, per-chunk speaker labels, and cut markers (`trimmed`, `segmentsOmitted`, `gapsOmitted`, `speakersOmitted`); a malformed transcript carries `malformed: true` and no segments. The first micro-step is shipped by D01 T03 §16 and is ticked on its stamp.
- [x] Commit: `web: the voice note's player and transcript`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts` passes with a stored transcript drawn, and `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` passes with the recording played at 360 px.

> **Verified:** 2026-11-03 | §6 | e536349894b40d976f0aa0b5376cbcb75ee0aa10
> **Review:** `docs/reviews/d07-t09-s6.json`

## 7. Walkthrough refusal and reuse cards

> **Started:** 2026-11-02T18:57:37Z

Moved at the gate merge (coordinator, 2026-11-02): filed as D07 T03 §53 from D04 T02 §6's completion review; D07 T03 reached its 55-section cap when both lanes filed into it, so this section's permanent address is D07 T09 §7. The `- Filed: D07 T03 §53` lines in `docs/reviews/04-agent/D04-T02-s6.md` name its first address.

Filed 2026-11-01 from D04 T02 §6's completion review (out-of-scope gaps): the walkthrough family renderer of D07 T03 §13 draws the four checks D07 T03 §5 produces, but a walk that could not run stores `walkthrough.not_checked` (D04 T02 §6), which falls through to the hidden-text card's heading, and a reused walk's items carry `detail.reused.at`, which no card shows, so a member reads an earlier observation as this case's own fresh walk. Both are wording on cards D07 T03 §13 owns; the producer's shapes are fixed by D04 T02 §6.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, board `Main`
**Job:** a member can tell a walk that never ran, and a walk borrowed from an earlier case, from a fresh walk
**Treatment:** the card frame of D07 T03 §3, words only, no new control
**Chrome:** `EvidenceCard` (D07 T01 §7)

> **Deferred:** an authenticated fresh-walk action on a reused card -> XREF: D07 T09 §13

**Build order:**

1. Draw the two cards. Done when: a fixture of each reads true at phone width.

- [x] Draw `walkthrough.not_checked` in the `walkthrough` renderer (`src/web/components/evidence/cards.tsx`): its own heading, never the hidden-text heading, with distinct wording for a walk that never started ("could not run") and a walk that started but did not finish ("did not finish"), preserving the producer's stored distinction in `src/walkthrough/trigger.ts` (its summary and `detail.reason`, `detail.checked: false`). Done when: `test/web/evidence-cards.test.ts` draws both cases from D04 T02 §6's own item shape with their headings and plain reasons, and an incomplete walk's retained findings draw beside it. Cheaper substitute: leaving the fall-through heading, which claims a page was walked.
- [x] Show reuse on every walkthrough card whose item carries `detail.reused.at` (`src/web/components/evidence/cards.tsx`): one line naming that the finding comes from an earlier walk of the same page, with its time, and that no new screenshot or submission exists for this case, on every walkthrough branch (chain, credential target, canary accepted and hidden text). Done when: `test/web/evidence-cards.test.ts` draws reused fixtures for each branch with the line and its time, and a fresh item without it. Cheaper substitute: showing the earlier finding as this case's own.
- [x] Name the walkthrough in the report's progress (`src/web/pages/report-progress.ts`): a conditional step after `checks` in the `CONDITIONAL` list (as `transcribe` is after `parse`), in plain words, drawn only when the case recorded it, never as "Another step" at the end. Done when: the report progress test shows the walkthrough between checks and verdict, running, retrying, recovered, done and failed, absent when unrecorded, with its accessible announcement. Cheaper substitute: leaving the generic fallback, which misorders the investigation.
- [x] Prove the refusal and reuse cards at phone width in `test/node/evidence-cards-browser.test.tsx`. Done when: the browser test draws both at 360 px with no overflow and no accessibility violations. Cheaper substitute: worker-only rendering, which cannot prove the phone layout.
- [x] Commit: `web: walkthrough refusal and reuse cards`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts test/web/report-status.test.ts` and `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` pass with the refusal cards and the reuse line drawn from the producers' own items, the walkthrough named in progress, and both cards proven at phone width.

> **Verified:** 2026-11-02 | §7 | e59ef7d59a370c7aba8486c4811be2c224dcef53
> **Review:** `docs/reviews/d07-t09-s7.json`

## 8. Bounded preview image transfer

> **Started:** 2026-11-02T19:32:12Z

Filed 2026-11-02 from D07 T03 §55's completion review: §55 bounds the full-size viewer's request and the failure classification, but a preview's own image transfer stays unbounded. If classification times out, then the reader retries and that image transfer stalls without emitting `load` or `error`, "Loading the screenshot again." persists and no retry control returns.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the evidence cards' preview images)
**Job:** a reader whose preview transfer stalls gets recovery controls after a bounded wait
**Treatment:** the card's existing temporary-failure words and Try again, shown after the same 15-second bound
**Chrome:** the evidence card figure (§3)

**Build order:**

1. Bound the transfer. Done when: a held preview transfer ends in the failed state with Try again.

- [x] Give the preview image transfer in `src/web/client/app.ts` (the `data-evidence-image` load the figure starts, including after card-level Try again) the same 15-second deadline pattern §55 gave the viewer (`data-deadline-ms` shortens it for a test), showing the card's temporary-failure state with Try again when it fires. The deadline starts only when the transfer starts (a preview the browser has not begun loading, such as a lazy preview in a closed disclosure, is never timed out). Done when: `test/node/evidence-cards-browser.test.tsx` holds a preview transfer past a 300 ms deadline, finds the failed state with Try again, releases it and finds Try again reload the preview, and a mutation removing the deadline fails it.
- [x] Bound every attempt of the preview in `src/web/client/app.ts`: the timer clears when an attempt loads or errors, each Try again arms a fresh deadline, and a late result from an abandoned attempt does not overwrite the current state. Done when: `test/node/evidence-cards-browser.test.tsx` stalls two attempts in a row and each ends in the failed state, a preview that loads stays loaded past the old deadline, and an old response arriving after a retry does not change the retried state. Cheaper substitute: one timer for the card's life, which gives up a retry that is still loading.
- [x] Commit: `web: bounded preview image transfer`

**Test checkpoint:** `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` passes with the stalled preview transfer given up.

> **Verified:** 2026-11-02 | §8 | 7db9ed95d29d8bb1bc02844e1be4dcd1cd855057
> **Review:** `docs/reviews/d07-t09-s8.json`

## 9. Complete decoded run on the card

Filed 2026-11-02 from D07 T03 §29's completion review (out-of-scope excellence item): the card shows the run's opening and the first instruction's excerpt, so a reader still cannot read an instruction that runs past the stored excerpt, or a later instruction in the same run, without decoding the original elsewhere (Embrace The Red's ASCII Smuggler). The producer keeps one excerpt of at most 250 characters (`SPOT_TEXT` in `src/checks/instruction-phrases.ts`), and widening that storage is the checks lane's producer work: this section waits on that row, asked through the coordinator; the field shape below is a proposal for it, not a decision.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards
**Job:** a reader reads the whole decoded run in the report, with any cut named
**Treatment:** the complete decoded run under the card, reached by one activation, truncated only with its cut stated
**Chrome:** `EvidenceCard`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. The producer retains the whole run. Done when: the stored detail carries the run's decoded text (bounded, with its cut marked) from the checks lane's row.
2. Extend `design/SPEC.md` M3 with the full-run view. Done when: M3 names the control and `design/tools/check-design.py` passes.
3. Draw the full run. Done when: a run whose instruction runs past the stored excerpt reads whole in the report.

- [ ] Ask the checks lane, through the coordinator, to retain the decoded run, and record its filed ref here. Done when: a `DNN TNN §N` ref naming the producer row is recorded in this section and the card reads only what that row stores (proposed shape: `detail.run: { text, truncated }` beside `detail.instruction`, bounded by the producer's accepted input limits). Cheaper substitute: decoding the run again in the card from the original message (re-reads hostile bytes in the web layer, so refused).
- [ ] Extend `design/SPEC.md` M3 with the full-run view and record the operator's approval in the section. Done when: M3 names the control, its states and its wording (including the truncation sentence), and `design/tools/check-design.py` passes. Cheaper substitute: drawing the run with no SPEC entry.
- [ ] Draw the stored run in `src/web/components/evidence/cards.tsx`'s invisible-characters card, reached by one activation from the card, with the cut stated when the stored text is truncated, and the card as §29 drew it when the field is absent. Done when: `test/web/evidence-cards.test.ts` draws a run whose instruction continues past the stored excerpt and reads it whole, a truncated run names its cut, and a hostile run text renders as text.
- [ ] Prove the view at both widths in both themes, keyboard-operable with no JavaScript. Done when: `test/node/evidence-cards-browser.test.tsx` opens the full run by keyboard at 360 px and 1280 px in both themes with axe and overflow checked while it is open.
- [ ] Commit: `web: the complete decoded run on the card`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` and `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` pass with the whole run readable.

## 10. Every target a clean check examined

Filed 2026-11-02 from D07 T03 §44's completion review (out-of-scope excellence item, against VirusTotal's URL report, which names the resources its clean analysis contacted): a clean check's stored summary is at most 120 characters, so for a message naming many targets it cannot list them all, and the clean list offers no way to inspect the rest. The examined set lives with the producer: storing it is the checks lane's data contract, asked through the coordinator; this section draws it.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the safe state's Checks that found nothing)
**Job:** a reader inspects every target a clean check examined, with any omission stated
**Treatment:** the complete examined set under the clean list, one activation from it
**Chrome:** `CleanChecks` in `src/web/pages/report-live.tsx` (§18, §44)

**Build order:**

1. The producer stores the examined set. Done when: the stored outcome carries each clean check's examined targets (or its omissions) from the checks lane's row.
2. Extend `design/SPEC.md` M3 with the inspection view. Done when: M3 names the control and `design/tools/check-design.py` passes.
3. Draw the set. Done when: a clean check that examined more targets than its summary holds lists them all, with omissions stated.

- [ ] Ask the checks lane, through the coordinator, to store the examined set, and record its filed ref here. Done when: a `DNN TNN §N` ref naming the producer row is recorded in this section and the list reads only what that row stores (proposed shape: the examined targets as stored text on the outcome, bounded, with omissions named).
- [ ] Extend `design/SPEC.md` M3 with the examined-set view and record the operator's approval in the section. Done when: M3 names the control, its states and its wording (including the omissions sentence), and `design/tools/check-design.py` passes. Cheaper substitute: drawing the set with no SPEC entry.
- [ ] Draw the stored set in `CleanChecks` (`src/web/pages/report-live.tsx`), reached by one keyboard-accessible activation from the clean list, omissions stated, targets drawn as text, and the list as §44 drew it when no set is stored. Done when: `test/web/evidence-cards.test.ts` draws a set longer than a summary holds with its omissions stated, and a hostile target renders as text.
- [ ] Prove the view at both widths in both themes, keyboard-operable with no JavaScript. Done when: `test/node/report-verdict-browser.test.tsx` opens the set by keyboard at 360 px and 1280 px in both themes with axe and overflow checked while it is open.
- [ ] Commit: `web: every target a clean check examined`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts` and `pnpm exec vitest run test/node/report-verdict-browser.test.tsx` pass with the whole set readable.

## 11. Outcome and reason beside each version

> **Started:** 2026-11-02T20:32:59Z

Filed 2026-11-02 from D07 T03 §39's completion review (out-of-scope excellence item): the Check versions list names each check's Worker version but not what the check did, so a skipped or failed check's version reads the same as one that ran clean. The stored outcome and its reason are already kept (`readCheckOutcomes`); this section draws them beside the version.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards (the Check versions disclosure)
**Job:** a reader sees, per check, its outcome and any refusal or failure reason beside its version
**Treatment:** the outcome and reason on each version line, in the same disclosure
**Chrome:** `EvidenceCard`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Extend `design/SPEC.md` M3 with the outcome and reason on the version lines. Done when: M3 names the wording and `design/tools/check-design.py` passes.
2. Draw them. Done when: a skipped check's line names its outcome and its stored reason.

- [x] Extend `design/SPEC.md` M3 with the outcome and refusal/failure reason beside each version and record the operator's approval in the section. Done when: M3 names the control and `design/tools/check-design.py` passes. Cheaper substitute: drawing the outcome with no SPEC entry.
- [x] Draw the stored outcome and reason on each line of the Check versions disclosure in `src/web/components/evidence/cards.tsx`, keeping the version first, for every stored outcome of the run shown: all four outcomes worded (`ran`, `partial` with its unread-input reason, `skipped` with its stored reason, `failed`), the reason drawn as text, and a failed check's stored error class translated to plain words (`Timeout` as it ran out of time, `EvidenceRefused` as its findings could not be stored, any other class as it failed). Done when: `test/web/report-status.test.ts` lists each of the four outcomes inside the disclosure with its wording and reason, scoped to the disclosure so the coverage notice cannot satisfy it.
- [x] Prove the lines at both widths in both themes, keyboard-operable with no JavaScript. Done when: `test/node/report-browser.test.tsx` opens the disclosure by keyboard at 360 px and 1280 px in both themes with axe and overflow checked while it is open, and the opened lines show a skipped and a failed outcome with their words.
- [x] Commit: `web: outcome and reason beside each version`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts` and `pnpm exec vitest run --project browser test/node/report-browser.test.tsx` pass with outcome and reason read from storage.

> **Verified:** 2026-11-02 | §11 | bf2e29da2282f0495562a8360733c0ef7cc1cacb
> **Review:** `docs/reviews/d07-t09-s11.json`

## 12. Detection data beside each version

> **Started:** 2026-11-02T20:54:51Z

Filed 2026-11-02 from D07 T03 §39's completion review (out-of-scope excellence item, against VirusTotal's engine version plus signature-update date): the Worker version alone cannot explain a changed finding when the detection data changed without a deployment. The stored provenance already exists (each outcome's data revision, identity and source, D02 T01 §6, read by `readCheckOutcomes`); this section draws it beside the Worker version, for the checks it applies to, with an explicit unknown when none was stored, never today's dataset.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards (the Check versions disclosure)
**Job:** two runs with the same Worker version but different detection data read differently
**Treatment:** the stored data revision, identity and source beside the version, or "data not recorded"
**Chrome:** `EvidenceCard`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Extend `design/SPEC.md` M3 with the data provenance on the version lines. Done when: M3 names the wording and `design/tools/check-design.py` passes.
2. Draw the stored provenance. Done when: two runs with one Worker version and different data revisions read differently in the report.

- [x] Extend `design/SPEC.md` M3 with the detection-data provenance beside each version and record the operator's approval in the section. Done when: M3 names the control and `design/tools/check-design.py` passes. Cheaper substitute: drawing the provenance with no SPEC entry.
- [x] Carry `data` through the report's `Coverage` view type (`src/web/pages/report-live.tsx`) and draw the stored data revision, identity and source beside the Worker version in the Check versions disclosure in `src/web/components/evidence/cards.tsx`, "data not recorded" where none was stored, drawn as text. The provenance applies only to the checks whose producer reads the brand table (`domain.lookalike`, `sender.display_brand`, `reputation.counter_signal`); every other check's line carries no data claim, however its stored row was written. Done when: `test/web/report-status.test.ts`, reading back from storage, lists two runs under one Worker version with different data revisions read differently, the same revision with different content identities, `kv` and `bundled` sources, an applicable outcome with no provenance as "data not recorded", an unrelated check with no data drawn, and an earlier run's provenance still its own after a newer run is stored; and a hostile stored identity renders as text.
- [x] Prove the lines at both widths in both themes, keyboard-operable with no JavaScript. Done when: `test/node/report-browser.test.tsx` opens the disclosure by keyboard at 360 px and 1280 px in both themes with axe and overflow checked while it is open, with provenance-bearing fixtures whose revision, full content identity and source are visible inside the opened disclosure.
- [x] Commit: `web: detection data beside each version`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts` and `pnpm exec vitest run --project browser test/node/report-browser.test.tsx` pass with data provenance read from storage.

> **Verified:** 2026-11-02 | §12 | 5e10fc3b302e467f1a5d2f87ce51bcdfe574ffbd
> **Review:** `docs/reviews/d07-t09-s12.json`

## 13. A fresh walk from a reused card

Filed 2026-11-02 from D07 T09 §7's completion review (out-of-scope excellence item, against ANY.RUN's restart action): a reader who learns a finding came from an earlier walk cannot ask for a fresh walk, so old evidence stands until another case happens to walk the same page. A fresh walk is a producer and API change (a new walk under the case's budget, bypassing the 24-hour cache), not wording on §7's cards.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, board `Main`, extended before the control is drawn
**Job:** a member replaces reused walk evidence with a fresh observation, or is told plainly why not
**Treatment:** one authenticated action on a reused walkthrough card, running one budget-controlled fresh walk for the case
**Chrome:** `EvidenceCard` (D07 T01 §7)

**Build order:**

1. Extend the SPEC, then run the walk. Done when: the control, its states and its refusal words are named in M3 and one fresh walk replaces the reused items.

- [ ] Extend `design/SPEC.md` M3 with the fresh-walk control on a reused walkthrough card and record the operator's approval in this section. Done when: M3 names the control, its running, done and refused states, and `design/tools/check-design.py` passes. Cheaper substitute: a control with no SPEC entry.
- [ ] Add the authenticated fresh-walk action for the case in `src/pipeline/analysis-workflow.ts` (or the route it names), bypassing the walk cache in `src/walkthrough/trigger.ts` for this case only, under the walk's existing budget and driver limits. Done when: the action stores a fresh walk's items for the case with a new observation time, and a walk that cannot run stores `walkthrough.not_checked` instead. Cheaper substitute: deleting the cache entry for every case, which makes other cases pay for this reader's walk.
- [ ] Draw the control and its states on every reused walkthrough card in `src/web/components/evidence/cards.tsx`, members only, never for a signed-link holder. Done when: `test/web/evidence-cards.test.ts` draws it on a reused card and not on a fresh one, and `test/node/evidence-cards-browser.test.tsx` activates it by keyboard at 360 px in both themes. Cheaper substitute: a control a link holder can press, which spends the case's budget on a stranger's say-so.
- [ ] Commit: `web: a fresh walk from a reused card`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts` and `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` pass with a fresh walk replacing reused items and a refusal stated.

## 14. Abandoned preview response during a retry

Filed 2026-11-02 from D07 T09 §8's round 5 (P3): §8's browser test releases each stalled response before Try again, so it does not prove that an abandoned response arriving while a retry is pending leaves the retry's loading state and deadline intact. §8 cancels the abandoned transfer, so the scenario needs a harness that can deliver the old response after the retry starts (separate routes for the two requests).

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the evidence cards' preview images)
**Job:** proof that a late abandoned response cannot disturb a pending retry
**Treatment:** a browser test with per-request control of the two responses
**Chrome:** the evidence card figure (§3)

**Build order:**

1. Prove the abandoned arrival. Done when: the old response delivered during a held retry changes neither its loading state nor its deadline.

- [ ] Extend the preview route control in `test/node/evidence-cards-browser.test.tsx` so the abandoned attempt's response and the retry's response are held and released separately. Done when: the test can release the abandoned response while the retry is still pending. Cheaper substitute: releasing both together, which §8's test already does and which proves nothing about the ordering.
- [ ] Assert the retry's state in `test/node/evidence-cards-browser.test.tsx`: after the abandoned response arrives during the pending retry, the card still says it is loading again, no failure note appears early, and the retry is given up at its own deadline. Done when: the test fails if a late load or error from the abandoned attempt clears the retry's status or hides its preview. Cheaper substitute: asserting only the final state, which passes however the middle went.
- [ ] Commit: `test: abandoned preview response during a retry`

**Test checkpoint:** `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` passes with the abandoned response delivered during a pending retry.

## 15. Detection data freshness beside the version

Filed 2026-11-02 from D07 T09 §12's completion review (out-of-scope excellence item, against VirusTotal's engine version plus signature-update date): §12 names the stored data revision, identity and source, but nothing says when that dataset was published, so a reader cannot tell a current table from a stale one with the same revision scheme. The stored provenance (D02 T01 §6) holds no update time; storing one is the checks lane's producer work, asked through the coordinator.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the Check versions disclosure), extended before the freshness is drawn
**Job:** a reader tells how fresh the detection data behind a version line is
**Treatment:** the stored dataset update time beside the provenance, or an explicit unknown
**Chrome:** `EvidenceCard`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. The producer stores the update time. Done when: the stored provenance carries when the dataset was published, from the checks lane's row.
2. Draw it. Done when: a version line names its dataset's age from storage, or says it is not recorded.

- [ ] Ask the checks lane, through the coordinator, to store the brand table's publication or update time with its provenance, and record its filed ref here. Done when: a `DNN TNN §N` ref naming the producer row is recorded in this section and the report reads only what that row stores. Cheaper substitute: the analysis time, which says when the check ran, not how fresh its data was.
- [ ] Extend `design/SPEC.md` M3 with the freshness wording and record the operator's approval in this section. Done when: M3 names the wording, including the not-recorded state, and `design/tools/check-design.py` passes. Cheaper substitute: drawing a date with no SPEC entry.
- [ ] Draw the stored update time beside the provenance in `src/web/components/evidence/cards.tsx` for the brand-table checks, as text, "data date not recorded" where none was stored. Done when: `test/web/report-status.test.ts` reads back from storage two runs with different update times read differently, and a run with none says so.
- [ ] Commit: `web: detection data freshness beside the version`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts` passes with dataset freshness read from storage.

## 16. Two activations for a signed-out member

Filed 2026-11-02 from D07 T09 §3's completion review: §3's two-activation journey holds for a member with a browser session; a signed-out member also signs in (the invitation, then authentication itself) before the one press, so the count is not two. Closing that gap without weakening member authorisation (a dispute stores only with the member's own authenticated session) needs an owner decision on the authentication the mail link may carry, so it is recorded here rather than improvised in §3.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the dispute, board `Report-Dispute`) and N1
**Job:** a signed-out member disputes from the reply mail in at most two activations, with member authorisation unweakened
**Treatment:** the owner-chosen authentication bridge from the mail link to the one press
**Chrome:** the dispute control (D07 T03 §22)

**Build order:**

1. Decide the bridge, then build it. Done when: a signed-out member reaches the stored dispute in at most two activations, and a forwarded link alone still stores nothing.

- [ ] Ask the operator (through the coordinator): what authentication, if any, the reply mail's dispute link may carry (a one-time signed sign-in, the existing sign-in flow accepted as outside the count, or no change); record the answer and its date in `design/SPEC.md`. Done when: the choice is in the SPEC. Cheaper substitute: letting the signed report link post feedback, which anyone holding a forwarded mail could press.
- [ ] Build the chosen bridge in `src/web/pages/report.tsx` and `src/web/pages/feedback.tsx`, keeping the member-only store and the link's save-nothing opening. Done when: `test/web/feedback.test.ts` follows the generated mail link signed out to a stored dispute within the chosen activation count, and a non-member is still refused. Cheaper substitute: counting the press alone and calling the journey two activations.
- [ ] Prove the journey in `test/node/feedback-browser.test.tsx` at phone width, counting activations from the mail link. Done when: the count is asserted, not described. Cheaper substitute: the signed-in journey, which §3 already proves.
- [ ] Commit: `web: two activations for a signed-out member`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/feedback.test.ts` passes with the signed-out journey inside the chosen count.

## 17. Human and Defender attribution comparison

Filed 2026-11-02 from D07 T09 §4's completion review: the scripted readers in `eval/phone-attribution.ts` measure navigation and labelled identification, not people, and the benchmark shape is IsItLegit's own earlier layout, not Microsoft Defender's reporter-visible submission surface. A user-level claim (faster correct identification, no sender substitution) needs a participant study and a versioned, source-backed Defender reconstruction, which needs an owner decision on participants and sources.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the phone attribution)
**Job:** user-level evidence for the phone attribution against the strongest comparable surface
**Treatment:** a counterbalanced phone study plus a Defender-shaped reconstruction, measured the same way
**Chrome:** the report header (D07 T03 §43)

**Build order:**

1. Decide participants and sources, then measure people. Done when: correct identification, sender substitution and abandonment are measured under both shapes.

- [ ] Ask the operator (through the coordinator): the participant group and minimum sample, and the Defender source material the reconstruction may be built from; record the answer and its date in `design/SPEC.md`. Done when: both are named. Cheaper substitute: scripted readers, which §4 already ran and which cannot show a person mistaking the sender.
- [ ] Build the Defender-shaped drawing in `eval/phone-attribution.ts` from the recorded source, versioned, and document what it reproduces and omits. Done when: the stimulus version names the source and the drawing's content matches the shipped cases. Cheaper substitute: IsItLegit's earlier layout, which §4 already measured.
- [ ] Run the study protocol recorded in the section (neutral task wording, phone conditions, counterbalanced order, timing boundaries, scoring of wrong answers, abandonment and timeouts) and persist anonymised observations under `eval/`. Done when: medians, error rates and sample counts are reported per shape, and no name or address from a participant is stored. Cheaper substitute: reporting the scripted medians as human performance.
- [ ] Commit: `eval: human attribution comparison`

**Test checkpoint:** the study's observations and summary are persisted under `eval/` and cited in `design/SPEC.md` M3.

## 18. Playback failure, retry and follow-along for the voice note

Filed 2026-11-02 from D07 T09 §6's completion review: the shipped player delegates its failure states to the browser's native controls, so a recording that will not load shows no words of its own and offers no retry in the report, and the transcript does not follow playback or let a reader play the marked request directly.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 voice note state, board `Report-Voice`
**Job:** a reader whose recording will not play is told so in words and can retry, and can follow or replay the marked words
**Treatment:** the transcript card's own failure wording and retry, with the played segment marked as it sounds
**Chrome:** the voice cards (D07 T03 §16)

**Build order:**

1. Give the player its own states. Done when: a failed load reads as a failure with a retry, and the playing segment is the marked one.

- [ ] Draw the recording's failure in `src/web/components/evidence/cards.tsx` and its behaviour in `src/web/client/app.ts`: a load error states that the recording could not be played and offers a retry that reloads it; an unsupported recording says so. Done when: `test/node/evidence-cards-browser.test.tsx` drives a failed load to the wording and a retry to a played state. Cheaper substitute: the browser's broken native control, which says nothing.
- [ ] Follow playback in the transcript: the segment under the playhead is marked while it sounds, and the marked request's segments can be played from their start. Done when: the browser test plays from a marked segment and reads the following mark back. Cheaper substitute: static timestamps the reader must hunt by hand.
- [ ] Commit: `web: voice note playback states`

**Test checkpoint:** `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` passes with the failure wording, the retry and the follow-along mark.

## Verification

- The card renders from the early outcomes at phone and desktop widths with no accessibility violations.
- `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass.
