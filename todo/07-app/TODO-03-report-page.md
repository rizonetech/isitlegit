---
schema_version: 1
id: report-page
domain: 07-app
status: active
title: "TODO-03 -- Report Page, Model Trace, Feedback and Reply Design"
track: day-2
---

# TODO-03 -- Report Page, Model Trace, Feedback and Reply Design

> **Goal:** Every case has one report page, opened by a signed link from the reply or from the console: the verdict banner and plain-language headline, the top three reasons, what to do now, evidence cards with their screenshot, crop or header excerpt, a model trace showing which Meta model did what at what cost and speed, live status while the case runs, honest partial and failed states, and a "this was wrong" button; the reply email matches the same design.

> **Current state:** Measured 2026-10-26 20:00 SAST. Signed links exist from D01 T01 §8; the plain reply from D01 T02 §3. The SPEC and shell come from D07 T01.

## Inputs

- Design spec 4.7 (report page), 4.3a (listings show source, date, delisting page), 4.6 (verdict output), 5 (demo), section 11; `docs/manifesto.md` (Experience standards); plan Day 8 (model-trace panel fed by real pipeline events).
- `design/SPEC.md` report and reply sections.
- -> XREF: D02 T06 §4 -- the reputation listings whose disputes the feedback records by provider
- -> XREF: D07 T01 §3 -- the app shell and public frame the report sits in; the report's own phone back link to Cases is §1's
- -> XREF: D07 T01 §7 -- `EvidenceFigure`, the preview §8's full-size viewer opens from
- -> XREF: D01 T01 §16 -- the original's subject and sender stored on the case, which the header draws
- -> XREF: D04 T01 §2 -- `case_verdicts.reasons` as `{ text, evidenceIds }[]` (each id an evidence item of the case; old `string[]` rows read as `{ text, evidenceIds: [] }`) and `VerdictView.meaning`, the banner's one sentence (old rows null), which §2's banner draws (cross-lane contract agreed 2026-10-31)
- -> XREF: D04 T01 §5 -- the citation check that refuses a reason with no `evidenceIds` or an id not on the case, so every reason the banner shows has its evidence card
- -> XREF: D02 T01 §3 -- `readCheckOutcomes(db, caseId)`, one `{ check, outcome, reason, findings }` per check in registration order (null for a case checked before it), which §18's count line and "Checks that found nothing" read (cross-lane contract agreed 2026-10-31)
- -> XREF: D01 T01 §17 -- `retryCase(db, env, orgId, caseId, memberId)` (src/pipeline/retry.ts), its typed refusals and the new `run_id` a retried case's progress is read by, which §20's button calls (cross-lane contract agreed 2026-10-31)
- -> XREF: D06 T02 §3 -- the document forensics checks (document.forensics.revisions, producer, dates, fonts, overlay) whose cards §30 draws
- -> XREF: D02 T07 §1 -- the `link.text_mismatch` check whose card §31 draws

## Outcome

- A malicious, a safe, a partial and a running fixture case each render to the SPEC at 360 px and 1280 px with no accessibility violations.
- The model trace lists every model call for the case from `case_events`; nothing in it is typed by hand.
- "This was wrong" stores feedback that the eval and provider statistics read.

**Adjacency:** list=applicable @ D07 T04 §1; document=applicable @ D07 T03 §1; settings=not-applicable (the report has no tunables); reporting=applicable @ D08 T02 §2; notifications=applicable @ D07 T03 §7; permissions=applicable @ D07 T03 §1; audit=applicable @ D07 T03 §5; exchange=applicable @ D07 T03 §1; reverse=applicable @ D07 T03 §6

**Adjacency rationale:** The report is the case's document, opened by signed link or session (permission) and printable to PDF (exchange). The reply email is its notification; the model trace is its visible audit; feedback is how a member reverses a wrong verdict, recorded without editing evidence.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Report route with signed-link and session access | D07 T01 §10, D01 T01 §8 | [x] |
| 2 | §2 | Verdict banner, headline, reasons and actions | §1 | [x] |
| 3 | §3 | Evidence cards by kind | §2, D02 T01 §1 | [x] |
| 4 | §4 | Live status, partial and failed states | §2 | [x] |
| 5 | §5 | Model trace panel | §2, D03 T01 §3 | [ ] |
| 6 | §6 | This-was-wrong feedback | §2 | [x] |
| 7 | §7 | Reply email matched to the report design | §2, D01 T02 §3 | [x] |
| 8 | §8 | Full-size evidence viewer | §3 | [ ] |
| 9 | §9 | Report header | §1, D01 T01 §16 | [x] |
| 10 | §10 | Stored verdict sentence, reasons | §2, D04 T01 §2 | [ ] |
| 11 | §11 | Follow-up question from the report | §2 | [ ] |
| 12 | §12 | Reputation cards | §3, D02 T06 §4 | [ ] |
| 13 | §13 | Link and walkthrough cards | §3, D02 T07 §3, D04 T02 §5 | [ ] |
| 14 | §14 | Vision and brand cards | §3, D03 T02 §3, D03 T02 §4, D03 T03 §3 | [ ] |
| 15 | §15 | Invoice and document cards | §3, D06 T01 §1, D06 T02 §2 | [ ] |
| 16 | §16 | Voice cards | §3, D01 T03 §4 | [ ] |
| 17 | §17 | Trust and verification cards | §3, D05 T02 §3, D05 T03 §2 | [ ] |
| 18 | §18 | Check count and clean checks | §3, D02 T01 §3 | [ ] |
| 19 | §19 | Original message preview | §3 | [ ] |
| 20 | §20 | Retry a failed check | §4, D01 T01 §17 | [ ] |
| 21 | §21 | Withdraw feedback | §6 | [ ] |
| 22 | §22 | One-press dispute | §6 | [ ] |
| 23 | §23 | Feedback outcome to the member | §6, D07 T08 §5 | [ ] |
| 24 | §24 | Invisible-character cards | §3 | [x] |
| 25 | §25 | Reply checked in mail clients | §7 | [ ] |
| 26 | §26 | Feedback from a signed link | §6 | [x] |
| 27 | §27 | Reply and report in your language | §7 | [ ] |
| 28 | §28 | Uploaded file's name in the header | §9 | [x] |
| 29 | §29 | Hidden instruction past the opening | §24 | [ ] |
| 30 | §30 | Document forensics cards | §3 | [x] |
| 31 | §31 | Link text mismatch card | §3 | [x] |
| 32 | §32 | Link coverage: damaged and further files | §31 | [x] |
| 33 | §33 | Highlighted page for a forensic finding | §8, §30 | [ ] |
| 34 | §34 | Unreported method in Headers checked | §7 | [ ] |
| 35 | §35 | DKIM none worded as unsigned | §7 | [ ] |
| 36 | §36 | Results attributed to the receiver | §7 | [ ] |
| 37 | §37 | Early authentication view | §3, §7 | [ ] |
| 38 | §38 | Transcribe step in the report progress | §4 | [ ] |
| 39 | §39 | Check versions in the report | §18, §20 | [ ] |

## 1. Report route with signed-link and session access

> **Started:** 2026-10-30T16:02:27Z

`GET /r/:caseId` serves the report to a valid signed link (no session needed) or to a signed-in member of the case's organisation; anything else gets a 404 that reveals nothing (spec 4.8). A print stylesheet makes the report save cleanly as PDF.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` report page
**Job:** a member who forwarded a mail opens the answer from the reply in one tap
**Treatment:** verdict first, nothing private to anyone outside the organisation
**Chrome:** `AppShell` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Corrected 2026-10-30** (validation before build): `requireOrg` (`src/auth/org.ts`) checks only the session's active organisation, so the report checks membership itself, in Better Auth's `member` table, and a session opens a case when its user is a member of the case's organisation, any of theirs (**Corrected 2026-10-30**, plan review P3: this said `requireOrg` did not exist); a case does not store its subject or sender (`cases` holds status, verdict, channel, `forwarded_by` and times; the message is in R2), so the report header (subject, sender, who forwarded it and when, Download PDF, Copy link) waits on intake storing them, a D01 row asked of the checks lane, and is filed as §9; until §2 and §3 draw the verdict and evidence, the page shows the case's real state (its verdict badge, status in words, when it arrived, its evidence as a severity pill and summary each), never a placeholder; the shell frame is the member's (`AppShell` member) for a session and the public frame for a signed link.

**Build order:**

1. Build the route and access rule. Done when: tests cover signed link, member session, other organisation and tampered link.
2. Add the print stylesheet. Done when: the report prints to PDF without the shell's navigation.

- [x] Write `GET /r/:caseId` in `src/web/pages/report.tsx`, mounted in `src/index.ts`, accepting a valid `verifyReportLink` (the public frame) or a session whose user is a member of the case's organisation (Better Auth's `member` table; the member frame), a request with neither and no valid link going to `/signin?next=` like any member page. Done when: `test/web/report-access.test.ts` covers the four cases, all failures returning the same 404. Cheaper substitute: case ids as the only secret.
- [x] Decide access in one order (`src/web/pages/report.tsx`): a session whose user is a member of the case's organisation opens the member view, whatever link comes with it; otherwise a valid signed link opens the public view; otherwise an authentic link past its expiry answers 410; otherwise a request with no session and no link parameters goes to `/signin?next=/r/<id>` (the path only, no link parameters); everything else (a session without membership, a tampered, malformed or foreign link, a missing case) answers the same 404. Done when: `test/web/report-access.test.ts` covers an entitled session with an expired link (opens), a valid link with no session and with a non-member session (public view), an unsigned anonymous request (sign-in, then back on the report after signing in), a malformed link, a missing case, membership in a non-active organisation (opens) and a removed membership (404). Cheaper substitute: a link check before the session check. **Added 2026-10-30 (plan review P1).**
- [x] Serve `GET /cases/:caseId` (`design/SPEC.md` 0.4's M3 route) as a 303 to `/r/<id>` behind `requireSession`, so the member's address and the reply's link reach one report. Done when: the test follows it to the report for a member and to the same 404 for a non-member. **Added 2026-10-30 (plan review P2).**
- [x] Answer an authentic link past its expiry (`verifyReportLink` refuses it as `expired`, so its signature held) with the 410 "Link expired" page drawn here with `ErrorState` (D07 T01 §8) in E2's composition ("Sign in to see the case" to `/signin?next=/r/<id>` and the forward-again note), D07 T08 §1 later owning the error pages as a whole, and every other refusal (tampered, malformed, foreign, another organisation's case) with the same 404, so the 410 discloses nothing a stranger could not already know. Done when: `test/web/report-access.test.ts` gets 410 for an expired authentic link with its explanation and a working "Sign in to see the case", and identical 404s (E1's composition) for a tampered link and for another organisation's case, the same but for each page's own reference line (**Corrected 2026-10-30** at build: a support reference and its time differ per request by design, and say nothing about the case). (**Added 2026-10-27**, D01 T01 §8's completion review: this section said every failure is a 404, while the SPEC draws a 410 recovery page for an expired link.)
- [x] Answer an outage as one: a session, membership or report read that fails answers 503 with `ErrorState`'s 500 composition, `Retry-After: 5` and the privacy headers, never a 404 and never a partial report. Done when: the test injects each failure (the session read, the membership query, each report query) and finds the 503 with its headers. **Added 2026-10-30 (plan review P2).**
- [x] Load the case, verdict and evidence with one query each, scoped to the organisation. Done when: the test counts queries, and with two organisations' cases stored (each with evidence `E1` to `E3`), the requested case's exact evidence in order and none of the other case's. **Corrected 2026-10-30 (plan review P2):** a count alone passed hard-coded content.
- [x] Draw the case's state in `src/web/pages/report.tsx` until §2 and §3 draw the report itself: the `VerdictBadge` (D07 T01 §7) for its state, mapped from the stored status and its nullable verdict (received or running: running; done with a verdict: complete; partial with a verdict: partial; partial, or done, with none: failed, "No verdict"), the state in words ("Received", "Checking", "Checked", "Partly checked", "Could not be checked"), when it arrived in SAST, and each piece of evidence as its `SeverityPill` and summary in order, under an `h1` naming the case by its arrival. Done when: `test/web/report-access.test.ts` renders a received case, a running one before and after its verdict is stored, a partial one with and without a verdict, and a done one, finds each one's badge, words and evidence without throwing or inventing a verdict, and the page passes the colour guard. **Corrected 2026-10-30 (plan review P1):** a partial case with no verdict threw. Cheaper substitute: an empty page or "coming soon".
- [x] Draw the report's footer (`design/SPEC.md` M3: retention and access): for a member, "Raw files are deleted after 30 days. This summary stays while your organisation has an account."; for a signed link, "Anyone with this link can read this report until <SAST date>. Raw files are deleted after 30 days."; "This verdict is wrong" is §6's. Done when: the test finds each wording in its view. **Added 2026-10-30 (plan review P2).**
> **Resolved:** "This verdict is wrong" in the footer -> XREF: §6. Resolved 2026-10-31 by D07 T03 §6 in `dd031c61`, `a7d56976` and `9a43573b`: a member of the case's organisation disputes a finished verdict from the report's footer with an optional note, read back with Change; the operator is told once (N9).
- [x] Add a print stylesheet hiding navigation and expanding evidence cards (**Corrected 2026-10-30** at build: `print:hidden` on the shell's sidebars and phone header and `print:ml-0` on its main column, `src/web/components/AppShell.tsx`, the shell owning its own print; the cards §3 adds expand there). Done when: `test/node/report-browser.test.tsx` emulates print media in Chromium on a multipage fixture in both themes and finds the case heading, state and every evidence summary visible and unclipped, and no navigation. **Corrected 2026-10-30 (plan review P2):** "no navigation text" passed a blank page; the cards §3 adds carry their own print check there.
- [x] Set `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`. Done when: the test reads both headers.
- [x] Add the report's phone back link to Cases per `Report-Mobile` (a link to `/cases` above the report title at phone width, for a signed-in member only; the public frame shows none). Done when: `test/node/report-browser.test.tsx` at 360 and 1280 px in both themes finds the link visible and reached by Tab for a member and absent from the signed-link view, long evidence summaries wrapping without sideways scroll, and the composed page passing axe-core with the A11y gate's rules. **Corrected 2026-10-30 (plan review P2):** markup alone passed a hidden link. (Assigned by D07 T01 §3's plan review, 2026-10-27.)
> **Resolved:** the report header (subject, sender, who forwarded it and when, Download PDF, Copy link; SPEC M3 anatomy) -> XREF: §9. Resolved 2026-10-31 by D07 T03 §9 in `990689e1`: the header draws the stored subject and sender, who forwarded or uploaded it, Download PDF and Copy link.
- [x] Close the completion review's in-scope gaps: an outage's "Try again" keeps a link holder's signed link; the 410's sentence says the case stays in the organisation's account (a Deviation in `design/SPEC.md` E2: 30 days is the raw files', not the case's); the support reference the 503 shows is the one its log line carries; the tests follow the sign-in return onto the report and `/cases/:id` to its outcome; and a member's phone paints the largest report (100 findings) within 2.5 s, cold and warm, on a throttled profile (4x CPU, 150 ms, 1.6 Mbit/s). Done when: `test/web/report-access.test.ts` (13) and `test/node/report-browser.test.tsx` (8) cover each, the retry losing its link failing the first (measured 2026-10-30: 264 ms cold, 304 ms warm, the page's own paint; the Worker's reads are `test/web`'s). **Added 2026-10-30 (completion review).**
- [x] Commit: `web: report route with signed-link and session access`

Evidence 2026-10-30 18:18 SAST. `src/web/pages/report.tsx` (`reportRoutes`: `GET /r/:caseId` in one access order, `GET /cases/:caseId` to it, 404, 410 and 503 drawn with `ErrorState`, private headers), `src/web/pages/report-view.tsx` (`shownState`, the body, `ReportDocument`, kept apart so the browser test renders it with no storage), `src/web/pages/member-shell.ts` (the member frame's data, the first page to need it), mounted in `src/index.ts`; the shell's print classes; `test/node/axe.ts` holds the gate's axe rules for every browser test, `test/node/a11y.test.tsx` now importing it. `pnpm exec vitest run --project worker test/web/report-access.test.ts`: 12 passed (the state map and six stored states, a member's own evidence in order and none of another organisation's, a non-active organisation's membership and its removal, a signed link with no session and with an outsider's, an entitled session with an expired link and the 410's recovery, the sign-in redirect, five refusals as one 404, `/cases/:id`, four injected outages as 503s with their headers, one query each, the headers). `pnpm exec vitest run test/node/report-browser.test.tsx`: 7 passed (axe at 360 and 1280 px in both themes for a member and a link holder, the phone back link by keyboard and its absence, print of a 40-finding report in both themes with no navigation and nothing cut). Mutations caught: the sidebar printing, any member's session opening any case, a partial case with no verdict drawn as if it had one. With them: typecheck, lint, `pnpm test:a11y` 14 passed, the gallery, shell, colour and stylesheet tests, and `test/web/` with `test/auth/` (16 files, 234 passed).

**Test checkpoint:** `pnpm exec vitest run test/web/report-access.test.ts test/node/report-browser.test.tsx` passes and fails if another organisation's member can open the case.

> **Verified:** 2026-10-30 | §1 | f82e543db13d4b1a78134ddf023c963994b92cf7
> **Review:** `docs/reviews/d07-t03-s1.json`

## 2. Verdict banner, headline, reasons and actions

The top of the report answers the question in a glance (spec 4.7, manifesto): verdict badge, headline, up to three reasons each linked to its evidence card, and what to do now (the fixed actions for invoices and POPs included). Confidence is shown in words, not a raw number.

> **Started:** 2026-10-31T00:59:01Z
>
> **Corrected 2026-10-31:** The plan is fact-checked against the tree, the boards and the stored contracts. (1) The band and the evidence link exist already: `VerdictBand` (eyebrow, headline, sentence, motion tile) in `src/web/components/Verdict.tsx` and `EvidenceRef` in `src/web/components/Evidence.tsx` (D07 T01 §7). This section composes them in the report's verdict section, `src/web/pages/report-verdict.tsx`, and does not write a new `verdict.tsx`. (2) The verdict comes from `getVerdict` (`src/db/verdicts.ts`, D01 T01 §7, migration 0017), which the report route does not read yet. (3) The checks lane's decision (coordinator, 2026-10-31): a stored reason is `{ text, evidenceIds }`, `evidenceIds` non-empty and every id an evidence item of the same case (writer-guaranteed), with the pill from `evidenceIds[0]`. Old rows hold `string[]`, which the reader maps to `{ text, evidenceIds: [] }`, drawn as plain text without a pill. Until that reader reaches main, the report maps the current `string[]` the same way. (4) The banner's third line, one sentence on what the verdict means (M3, `Main`), is not stored. Until it is, a fixed sentence per verdict is drawn. (5) No confidence bands are defined: high at 0.8 and above, medium at 0.5 and above, low below. The 0.6 cap for missing headers (D04 T01 §4) therefore reads medium. This is recorded as an M3 Deviation, which the coordinator puts to the operator. (6) The fixed actions are this lane's (D06): the bank-change action (D06 T01 §3, spec 4.5) and the POP action (spec 4.5a) live in `src/invoice/fixed-actions.ts`, so the report recognises them and D06 attaches them from the same module. (7) Running, partial-notice and failed states are §4's. This section draws the band for a case with a stored verdict (complete or partial) and leaves the other states as §1 drew them.
>
> **Corrected 2026-10-31 (plan review):** (8) `src/invoice/fixed-actions.ts` does not exist yet: this section creates it and its tests, and D06 T01 §3 and D06 T02 §3 attach their actions from it (items added there). (9) A voice case's actions are also "Do this first" (M3, `Report-Voice`): the call-back action (`callBackAction(name)`, "Call <name> on the number you already have for them, not a number from the voice note.") is a fixed action in the same module, drawn first when present, and a voice case without it still titles its list "Do this first" with its first stored action highlighted. (10) The ledger links in the actions ("Open <supplier> in the ledger" on `Report-Invoice`, "supplier ledger" on `Report-Safe`) need the ledger page and the case's matched supplier, so they are D06 T01 §4's (deferred below). (11) The order is verdict, actions, reasons, as M3 and every board draw it: the Treatment was wrong. (12) The citation proof is positive: a structured-reasons fixture in the view test and the legacy strings through the route. The route's read-back of structured reasons waits on the checks lane's reader (D07 T03 §10).
>
> **Deferred:** the ledger links in the actions ("Open <supplier> in the ledger", the Safe board's "supplier ledger") -> XREF: D06 T01 §4
>
> **Deferred:** the stored one-sentence meaning (asked of the checks lane through the coordinator, 2026-10-31); the fixed per-verdict sentence is drawn until it lands -> XREF: D07 T03 §10

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 Report (boards `Main`, `Report-Safe`, `Report-Invoice`, `Report-Voice`, `Report-Mobile`): verdict banner, headline, three reasons, actions
**Job:** a busy owner knows within five seconds whether to act and what to do
**Treatment:** verdict, then what to do now, then why we say so, in that order (M3 and every board), in plain words
**Chrome:** `VerdictBand`, `EvidenceRef` from D07 T01 §7, proven together in D07 T01 §10

**Build order:**

1. Build the verdict section. Done when: malicious, suspicious and safe fixtures render to the SPEC.

- [x] Read the case's verdict in the report route (`getVerdict`, `src/web/pages/report.tsx`) and hand the view the verdict, its evidence and the case's source kind; a verdict that cannot be read is the 500 page (E5), never a page without its verdict. Done when: `test/web/report-verdict.test.ts` renders a stored verdict through the route and a failing read answers the error page.
- [x] Draw `VerdictBand` with the eyebrow "Verdict · confidence" in words (`confidenceWords`: high ≥ 0.8, medium ≥ 0.5, low below), the kind suffix ("invoice fraud" when the bank-change action is present, "voice note" for an audio case), the stored headline and the meaning sentence, in `src/web/pages/report-verdict.tsx`; extend `VerdictBand` with an optional `kind`. Done when: `test/web/report-verdict.test.ts` checks malicious high, suspicious medium (0.6) and safe, each band's words and its motion tile, and the boundaries 0.5 and 0.8.
- [x] Draw "Why we say so" after the actions: at most three reasons in stored order, each led by its `EvidenceRef` to the card of `evidenceIds[0]` at the evidence's own severity, and a reason with no ids as plain text with no pill (old rows). Map the stored reasons to `{ text, evidenceIds }` (`reasonsOf`), accepting today's `string[]`. Done when: `test/web/report-verdict.test.ts` draws a four-reason structured fixture as exactly its first three texts in order, with three pills naming E7, E4 and E2 at their evidence's severities and each `href` naming an `id` the page holds; a reason citing an id the page lacks fails the test; the legacy `string[]` row read through the route draws plain text with no pill.
- [x] Give each evidence item on the page its card anchor (`id="e<n>"`, the anchor `EvidenceRef` targets) until §3's cards replace the list. Done when: the test finds the anchor for every reason's pill, and removing it fails the test.
- [x] Create `src/invoice/fixed-actions.ts`: `bankChangeAction(phone?)` (spec 4.5, D06 T01 §3: "Confirm by phoning the supplier on the number in your records, never one from this email.", the ledger's number named when given), `POP_ACTION` (spec 4.5a: "Confirm the money has cleared in your own banking app before releasing goods."), `callBackAction(name?)` (the voice call-back) and `fixedActionOf(text)`, which names the kind of a fixed action (`bank-change`, `pop`, `call-back`) or null. Done when: `test/invoice/fixed-actions.test.ts` recognises each action with and without its number or name, and refuses a look-alike sentence.
- [x] Draw "What to do now" right after the band as a numbered list of at most three stored actions. With a fixed action, or for a voice case, title it "Do this first", put the fixed action first (the first stored one for a voice case without one) and mark it as the highlighted block. Done when: `test/web/report-verdict.test.ts` draws the tampered invoice fixture's phone-the-supplier action first under "Do this first", the POP fixture's action and the voice fixture's call-back the same way, a plain case "What to do now" with no highlight, and a verdict with no actions draws no empty list.
- [x] Record the confidence bands as a Deviation in `design/SPEC.md` M3. Done when: the Deviation names the bands and the coordinator's question to the operator.
- [x] Prove the section in Chromium at 360 px and 1280 px in light and dark: the band, the actions and the reasons in that order on the page, no horizontal scroll, axe clean, and each reason's pill followed by keyboard moves focus and scroll to its item. Done when: `test/node/report-verdict-browser.test.tsx` passes, and reversing actions and reasons fails it.
- [x] Close the completion review's in-scope gaps: the fixed action is found among all ten stored actions before the list is cut to three (G1); a call-back names someone by an initial ("J. Visser", G2); following a reason's pill moves focus to its finding, the targets and `EvidenceCard` focusable by `tabindex="-1"` (G3); a voice note's "Do this first" sits beside its listed reasons on a wide page, as `Report-Voice` draws it, and only an invoice or payment document stretches its action across the page (G4); and the throttled-phone paint test draws the verdict section with 100 findings, with a phone's first screen showing the verdict, headline and first action (E1). Done when: `test/web/report-verdict.test.ts` places each fixed action from positions one to ten first, `test/invoice/fixed-actions.test.ts` recognises ordinary names and refuses a sentence as a name, `test/node/report-verdict-browser.test.tsx` finds focus on the finding and the voice layout side by side, `test/node/report-browser.test.tsx` paints within 2.5 s with the verdict and finds the three on the first screen; each fix's removal fails its test. **Added 2026-10-31 (completion review).**
- [x] Commit: `web: verdict banner, reasons and actions`

**Test checkpoint:** `pnpm exec vitest run test/web/report-verdict.test.ts` passes and fails if a reason links to a missing card; `pnpm exec vitest run test/node/report-verdict-browser.test.tsx` passes.

> **Verified:** 2026-10-31 | §2 | 128524fdb9fbaac212165cc4545136c8d9fd6ac4
> **Review:** `docs/reviews/d07-t03-s2.json`

## 3. Evidence cards by kind

Each evidence item is a card with its severity, summary and artefact (spec 4.7): header excerpt, rendered screenshot, logo crop beside the reference, link chain, walkthrough page chain with the credential target, invoice fields (masked), reputation listing with source, date and delisting link, voice quotes, verification request and answer, and "not checked" items explaining the gap.

> **Started:** 2026-10-31T02:06:52Z
>
> **Corrected 2026-10-31:** Fact-checked against the tree. (1) Only the `intake`, `auth`, `sender`, `domain`, `attachment` and `content` checks and the runner's `not_checked` exist (`src/checks/`). The `reputation`, `link`, `walkthrough`, `vision`, `brand`, `invoice`, `document`, `voice`, `trust` and `verification` producers are later sections, so their detail shapes are not defined yet. Their cards are filed as §12 to §17, each depending on its producer, and this section builds the card frame, the renderers for the families that exist, the artefact route, the order and the unavailable states. (2) The mapping test reads the registry itself (`checks.names()`), so a check registered later without its renderer fails the test. A stored item whose check has since been renamed (the stored name is checked for its form only, `StoredEvidence`) draws the frame's plain card with its severity and summary, never an error. (3) `readArtefact` exists in `src/intake/store.ts`. The Fidelity source is M3's evidence cards (boards `Main`, `Report-Safe`, `Report-Partial`) and `EvidenceCard` from D07 T01 §7. (4) The reputation card moves to §12 with its producer (D02 T06 §4).
>
> **Corrected 2026-10-31 (plan review):** (5) The count line and M3's "Checks that found nothing" have no source: the runner stores findings, not each check's outcome, so both wait on a checks-lane row that persists per-case check outcomes (asked through the coordinator) and are §18's. (6) Inline artefacts are passive raster images only (PNG, JPEG, GIF, WebP), recognised by their bytes and not by their declared type. SVG, HTML and anything else, including a file declared as an image whose bytes are not one, is served as an inert download (`application/octet-stream`, `nosniff`, `sandbox`). (7) The artefact URL contract: `/a/<caseId>/<key>` with the key percent-encoded as one path segment, served to a member of the case's organisation by session. A signed-link holder's artefact URLs carry the report link's own signature parameters, verified for that case by the same `verifyReportLink` rule (the signature covers the case and expiry, not the path). Both readers are proven by following a drawn card's URL. (8) The phone layout's "<n> more findings" disclosure (`Report-Mobile`) is this section's. (9) Each renderer is proven by its fields, not its summary, for every variant a check writes. (10) The artefact states are told apart: a key not on the case (404), an object no longer stored (the retention sentence only when the case is past 30 days, otherwise "The original file is no longer available"), and a read that failed (database or storage), which draws Try again, re-reading the card with the reader's own access.
>
> **Deferred:** the count line and "Checks that found nothing" -> XREF: D07 T03 §18

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, boards `Main`, `Report-Safe`, `Report-Partial`, `Report-Mobile`
**Job:** a sceptical reader sees exactly why IsItLegit said what it said
**Treatment:** one card shape, the artefact as proof, severity by icon and word
**Chrome:** `EvidenceCard` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build one renderer per evidence family. Done when: a fixture with every family renders every card.

- [x] Draw each evidence item as an `EvidenceCard` in `src/web/components/evidence/`, through one renderer per family that exists, each drawing its check's own fields: `intake` (how the original arrived, other originals not checked, the uploaded file, the cut body parts), `auth` (the authentication header excerpt from the receiver's own `Authentication-Results`, with the results kept), `sender` (display address, display brand, reply-to, return path, first-time sender), `domain` (the lookalike and the domain's registration date from RDAP), `attachment` (type mismatch, executable, macro, encrypted archive, HTML attachment, and an attachment that could not be read), `content` (the hidden text quoted, with its count and reasons) and `not_checked` (the check that did not run and why, shown as Not checked). The renderers read each check's own `detail` fields (`src/checks/*.ts`), and a stored item whose check has no renderer draws the plain card (severity and summary). Done when: `test/web/evidence-cards.test.ts` draws a fixture of each registered check (`checks.names()`) and each variant its `detail` takes (for example `domain.age` with both dates and an unchecked domain, `content.hidden_text` with quotes, an overflow count and an incomplete scan, both `not_checked` shapes the runner writes), asserting each variant's own fields (a quote, a date, a comparison, a missing check's reason), so removing one fails the test; quoted hostile text renders as text; it fails when a registered check's family has none; an item with an unknown check name draws the plain card; and evidence stored through `saveEvidence` reads back through the report route as the same cards.
- [x] Replace the report's evidence list with the cards, keeping the `e<n>` anchors the reasons' pills follow, under the "Evidence" heading. On a phone (below `md`, `Report-Mobile`), the cards the reasons cite are shown and the rest sit in a "<n> more findings" disclosure naming them, which opens by keyboard. Opening the page at a hidden card's `#e<n>`, or following a pill to one, opens the disclosure and focuses the card. Done when: the report test follows each reason's pill to its card, and `test/node/evidence-cards-browser.test.tsx` opens the disclosure by keyboard, finds the count right, and lands focus on a hidden card from a direct `#e<n>` link.
- [x] Serve artefacts through `GET /a/:caseId/:key` (the key one percent-encoded segment) with the report's access rule: a member of the case's organisation by session, or a link holder by the report link's signature parameters, which the card URLs drawn on a signed-link report carry. Use the report's private headers. Only a passive raster image recognised by its bytes (PNG, JPEG, GIF, WebP) is served `inline` with that type. Everything else, SVG and HTML included, and a declared image whose bytes are not one, is an attachment typed `application/octet-stream` with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`. A key that does not belong to the case is a 404. Done when: `test/web/artefacts.test.ts` stores an artefact, opens the report as a member and as a signed-link holder, follows the drawn card URL and gets the exact bytes and headers; an expired or tampered signature gets the report's refusal; a member with an expired link is still served by session; another organisation's request, and a key of another case, get 404; and HTML, SVG and an HTML file declared `image/png` are served inert.
- [x] Order the cards: those the verdict's reasons cite, in the order they cite them, then the rest by severity, then by id (**Corrected 2026-10-31** from "by severity, then by citation": the boards draw the cited cards first, and one order serves the phone's disclosure, which holds the rest). Done when: the test checks the order for a fixture with ties.
- [x] Show an evidence item whose artefact cannot be shown as unavailable, never broken, in its own state (**added 2026-10-27**, D01 T01 §2's completion review; states told apart 2026-10-31): `readArtefact` answering that the object is gone draws "The original file is no longer available", with the 30-day privacy sentence only for a case past 30 days (D00 T01 §5). A `database` or `storage` failure draws "This file could not be loaded just now" with Try again, which re-reads the card with the reader's own access (session or signature). The card links its file and the artefact route answers these states as pages (**Corrected 2026-10-31**: `readArtefact` reads the whole object, so the report does not read every file to draw its cards). The finding and the verdict stay readable in every state. Done when: `test/web/evidence-cards.test.ts` renders a gone file on a new and on a 31-day-old case, and a failed read whose Try again succeeds once the store answers, with the report whole each time.
- [x] Prove the cards in Chromium at 360 px and 1280 px in light and dark: no sideways scroll with a long domain or file name, axe clean, a reason's pill focusing its card. Done when: `test/node/evidence-cards-browser.test.tsx` passes.
- [x] Close the completion review's in-scope gaps: each cut body part links its file (`intake.truncated`); a renderer is matched by the exact check name (`CHECK_WORDS`), so a retired name in a known family draws the plain card; every check is named in plain words and no card shows an internal name; card links always download, and only an `<img>` asking `?inline=1` gets a whole passive raster image inline, a damaged one staying a download; a failed read says "This file could not be loaded just now" with Try again for a member and a link holder alike, from a storage or a database failure; the cards sit two to a row from `md` (`Main`) and three from `lg` on a safe report (`Report-Safe`); and the checkpoint runs the route tests. Done when: `test/web/evidence-cards.test.ts` and `test/web/artefacts.test.ts` (19) cover each, `test/node/evidence-cards-browser.test.tsx` finds two cards to a row, and each fix's removal fails its test. **Added 2026-10-31 (completion review).**
- [x] Commit: `web: evidence cards by kind`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts test/web/artefacts.test.ts` passes and fails if an HTML artefact is served as HTML (**Corrected 2026-10-31**: the route's tests are `test/web/artefacts.test.ts`).

> **Verified:** 2026-10-31 | §3 | 1efc3bc243348dd14710cd0943cd8d11dd37f458
> **Review:** `docs/reviews/d07-t03-s3.json`

## 4. Live status, partial and failed states

While a case runs, the report shows progress by step and updates itself (htmx polling every 2 seconds, stopping when done); a partial case names what could not run and what that means; a failed case says so plainly and offers to retry (manifesto Reliability: no silent failure).

> **Started:** 2026-10-31T03:55:33Z
>
> **Corrected 2026-10-31:** Fact-checked against the tree. (1) A case's statuses are `received`, `running`, `done` and `partial` (`src/db/cases.ts`); a failed check is `partial` with no verdict (`shownState`, §1), so "failed" is that state, not a stored status. (2) The steps are the Workflow's recorded `case_events` (`admit`, `parse`, `checks`, `verdict`, `store`, `reply`, `finish`, `src/pipeline/analysis-workflow.ts`), each with started, done or error and its error class: the step list and a failed check's "failed at step N of 7" are read from them, never assumed. (3) What a partial check did not run is its `not_checked` evidence and its steps in error. (4) The retry cannot be served by this lane: a finished case has no lifecycle move back (`partial` allows none), the instance id is the case id, and `admit` skips a finished case. The re-run is asked of the checks lane (D01, through the coordinator) and the member's button is §20. This section's failed state shows the reference, what happened and "Upload it instead" (`Report-Partial`). (5) `LoadingState`, `PartialNotice` and `ErrorState` exist in `src/web/components/States.tsx` (D07 T01 §8).
>
> **Corrected 2026-10-31 (plan review):** (6) Coverage is not the lifecycle status: a check that failed or timed out is a `not_checked` item while the case can finish `done`, and a reply that could not be sent finishes `partial` with every check run. Coverage is read from the stored check outcomes (`readCheckOutcomes`, D02 T01 §3; `null` for a case checked before them, said as "coverage not recorded", never as complete), and a delivery failure is its own notice. (7) `case_events` has four statuses (`started`, `done`, `error`, `failed`) and keeps every attempt: progress reduces each step's attempts (a later `done` clears an earlier `error`; `failed` is a step's last word). (8) The poll carries the running board's "Found so far" (the cards stored so far, the provisional sentence and the waiting advice), not only the steps. (9) The finished report replaces the polled region in place, never `HX-Refresh` (a reload loses the live region and focus). (10) A failed or timed-out poll keeps the report, says the progress is not current and tries again; a poll that has lost its access sends the reader to the full report, never to the fragment. (11) Browser behaviour is proven in Chromium.
>
> **Deferred:** "Retry the check" on the failed state -> XREF: D07 T03 §20

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` report page, pending, partial and failed states
**Job:** a member waiting for an answer sees it is working and is never left guessing
**Treatment:** calm progress, honest gaps, one clear retry
**Chrome:** `LoadingState`, `PartialNotice`, `ErrorState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Add the status fragment and polling. Done when: a running fixture shows steps and stops polling at done.
2. Add partial and failed views. Done when: each fixture renders its state with the right text.

- [x] Reduce a case's `case_events` to its progress in `src/web/pages/report-progress.ts`: each step waiting, running, retrying (an `error` with no later `done` or `failed`), done (any `done`) or failed (`failed`), with the elapsed time since the first start, and the failed step if any. Done when: `test/web/report-status.test.ts` reduces `started → error → started → done` to done, exhausted retries to failed, a check failure then a reply failure to the first failed step, and an unknown step name is kept in its recorded order.
- [x] Write `GET /r/:caseId/status` under the report's access rule (a member by session, a link holder by the report link's parameters), answering the polled region while the case is `received` or `running`: the step list, and "Found so far" (the evidence cards stored so far, the sentence that they are early and may change, and the advice to wait before acting), polled with `hx-trigger="every 2s"`. When the case has finished it answers the finished report's body for the same region, with no further trigger, so polling stops. Done when: `test/web/report-status.test.ts` sees the steps advance, evidence stored mid-run appear by the next answer without repeating a card, the finished body answered once with no trigger, another organisation refused, and a link holder served.
- [x] Draw coverage separately from the lifecycle: when any stored outcome is `partial`, `skipped` or `failed`, `PartialNotice` names each such check in words (`CHECK_WORDS`, §3) with why, and `ran` counts `ran` and `partial`. A case with no stored outcomes says "Coverage not recorded for this check". A reply that could not be sent (the `reply` step failed) is its own notice ("We could not email this answer; it is here"), never a missing check. Done when: `test/web/report-status.test.ts` draws `done` with a failed check, grouped missing inputs, partial coverage, `partial` caused only by the reply, and a case with no outcomes, each with its own words.
- [x] Announce each state change of a running report once through a polite live region outside the polled region (`LoadingState`, D07 T01 §8): the step that started, then the terminal outcome (verdict, partial or failed) by the next 2 s poll, with no repeat on an unchanged poll and keyboard focus kept where it was. Done when: `test/web/report-status.test.ts` drives a running fixture to done, partial and failed and finds each announcement once in order, none on unchanged polls, and focus unmoved. Cheaper substitute: making the swapped fragment itself live, which re-announces every poll. **Added 2026-10-30** (D07 T01 §8 completion review G8; Fluent 2 wait guidance announces state changes).
- [x] Render failed cases (`partial` with no verdict) as `Report-Partial`'s failed state: "Check failed · no verdict", the plain sentence, what happened (the failed step and its error class in words, from `case_events`), the reference with the step ("failed at step N of 7") and its SAST time, and "Upload it instead"; the retry is §20's. Done when: `test/web/report-status.test.ts` draws a fixture failed at `parse` with its step, words and reference, and a fixture with no error event says the check did not finish without naming a step.
- [x] Keep the report through a failed poll: the app script leaves a polled request's failure on the page (`data-poll`, not the failed-request navigation of D07 T04 §1), says "Progress is not up to date; trying again" and clears it when a poll answers; a poll answered by sign-in or refusal (the session or membership lost) opens the full report, which handles access. Done when: `test/node/report-status-browser.test.tsx` fails one poll and recovers, and loses the session mid-run and lands on the report's own access answer.
- [x] Prove the running, partial and failed states in Chromium at 360 px and 1280 px in light and dark: the polls actually sent every 2 s, none after the finish, each announcement once in order, an unchanged poll silent, focus kept on a focused control through the finish, keyboard access to the state's controls, reduced motion keeping progress readable, axe clean. Done when: `test/node/report-status-browser.test.tsx` passes.
- [x] Close the completion review's in-scope gaps: an upload is never promised an email; the reply's own outcome is read from `mail_sends` (`readReplySend`) and said apart from coverage, a failed check staying live while its reply is still being sent, and no notice calls an incomplete check complete; a check that read part of its input is named apart and counted as run; a failure keeps its own recorded time; file links keep focus through polls (`e<n>-file-<k>` ids); the phone's disclosure is fitted after the finish as on a report opened finished; a step tried again is said as such, and a poll's recovery says where things stand even on the same step; the running board's progress beside what was found, and the failed board's two cards side by side, with a partial check's notice after the band; and the browser tests count every announcement, drive running to partial and to failed, recover from a timeout and a 503, answer a server slower than the interval, and bound the update latency (measured: median 921 ms, slowest 1532 ms of three finishes of a 100-finding report, bound 3.5 s). Done when: `test/web/report-status.test.ts` (19) and `test/node/report-status-browser.test.tsx` (18) cover each, and each fix's removal fails its test. **Added 2026-10-31 (completion review).**
- [x] Commit: `web: live status, partial and failed states`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts test/node/report-status-browser.test.tsx` passes and fails if polling continues after `done`.

> **Verified:** 2026-10-31 | §4 | c51962849b9c210818a557fc8c6dd4dcb48032eb
> **Review:** `docs/reviews/d07-t03-s4.json`

## 5. Model trace panel

The judges and members see the models at work, from real pipeline events (plan Day 8): each Meta model call with step, model, time, cost, cache hit, and tool calls for the agent, plus the case's total time and cost. Nothing is typed by hand; the demo uses the same panel.

**Corrected 2026-10-29** (D03 T01 §3 completion review): each model call's record is its `model_spend` row (D03 T01 §2, §3: the call and attempt, owner, step, latency, tokens, units, ids, outcome and the cost with its certainty), not a `case_events` row; the trace reads those rows (and `caseCost` for the totals, measured and estimated apart), and `case_events` stays the Workflow's step record.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` report page, model trace section
**Job:** a judge sees which Meta model did what, how fast and at what cost
**Treatment:** a compact timeline, model names in full, cost in US cents
**Chrome:** `EvidenceCard` layout for the panel from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the panel from `case_events`. Done when: a fixture case with five model calls renders five rows and totals.

- [ ] Render a timeline of `case_events` rows with a model, grouped by step, with model name, milliseconds, cost and cache hit in `src/web/components/model-trace.tsx`. Done when: `test/web/model-trace.test.ts` checks rows and totals.
- [ ] Show the agent's tool calls in order under the verdict step. Done when: the agent fixture shows its two tool calls.
- [ ] Show the panel collapsed by default for members and expanded when the URL has `?trace=1` (used in the demo). Done when: both render in the test.
- [ ] List the case's mail in the panel from `mail_sends` (D01 T02 §1): each send's kind, status in words (sent, failed, may have been sent, refused, waiting), attempts, the last reason and when, never an address, read through the case's own organisation scope; a case with no mail says so. Done when: `test/web/model-trace.test.ts` renders a case with a sent reply, an uncertain one and a failed one, and one with none, and finds no address in any of them. (**Added 2026-10-27**, D01 T02 §1's completion review: the file's Adjacency promises sends in the trace, but the panel read only `case_events`.)
- [ ] Commit: `web: model trace panel`

**Test checkpoint:** `pnpm exec vitest run test/web/model-trace.test.ts` passes and fails if a row is not backed by a `case_events` record.

## 6. This-was-wrong feedback

A member disputes a verdict in one tap with an optional note (spec 4.7); feedback never edits the case or its evidence, records which reputation provider the verdict leaned on (spec 4.3a), and feeds the eval and provider false-positive statistics.

> **Started:** 2026-10-31T05:43:14Z
>
> **Corrected 2026-10-31:** Started moved from 2026-10-31T05:39:29Z to the build's real start (569cb432, the plan review's gaps built into the section): the plan review ran on a4f16cd5, which wrote the migration number and the provider field into the section after the first Started commit.
>
> **Corrected 2026-10-31:** Fact-checked against the tree. (1) Migration 0015 is long taken: the feedback table takes the number the coordinator gives (main is past 0044). (2) The boards draw only the footer's "This verdict is wrong" (`Main`; M3 "feedback: Opens the feedback control"); the control itself is not drawn, so it is built from the shared controls (`Field`, `Button`, D07 T01 §6 and §8) and recorded in `design/SPEC.md` M3, as the sign-in code was. (3) Feedback is a member's (it carries the member's `user_id`): a signed-link reader sees no control. One row per member per case: sending again replaces that member's choice and note, and the operator is told once. (4) The reputation producer is D02 T06 (checks lane), not built: the providers come from the cited evidence items whose check starts `reputation.`, by the field its contract names (asked through the coordinator), and are `[]` until such items exist. (5) The operator notice is N9 (`design/SPEC.md`), sent through `sendMail` (src/mail/smtp2go.ts) with `kind: "notice"` and the feedback's own send key, so a retried request sends it once; it carries the summary and the case link only, never the member's note. (6) The post is a form from the app's own origin, with a bounded body (`readSmallForm`, src/auth/form.ts), single-submit and busy while it posts; an outage says so and keeps what was typed.
>
> **Corrected 2026-10-31 (plan review):** (7) A notice is never lost: each feedback row carries `notified_at`, set only when its send went, and the cron sends every row still waiting (`sendPendingFeedbackNotices`, the cap notices' pattern), each under its own send key `feedback:<id>`, so a stopped Worker, a failed send and a race all end in one notice; a replaced choice is the same feedback and sends none. (8) A member reads back what they sent: the footer shows "You said this verdict is wrong: <kind>", with Change, which reopens the control filled with their choice and note. (9) Fields are checked explicitly: a missing or unknown kind and a note over 1000 characters are refused with the error on the field and what was typed kept, never a silent drop by the bounded reader. (10) Only a verdict can be disputed: the control is drawn for a complete or partial check with a verdict, in the finished report the poll swaps in, and the post refuses a case with none. (11) The post takes the report's member rule: a member of the case's organisation by session (any of theirs, the active one or not), the `user_id` from the session only. (12) The providers are those of the `reputation.*` items the verdict's reasons cite (every cited id, not the first only), each once. (13) The notice is N9's feedback state (`Email-Operator-Feedback`): the organisation, the verdict given, what the member says, what the verdict leaned on, the number of feedback still waiting, and "Open the feedback queue" to `/admin/feedback` (X4, D07 T08 §5, behind Access); the note stays in the app.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 footer ("This verdict is wrong", board `Main`); the control is built from the shared controls (not drawn)
**Job:** a member tells IsItLegit it got one wrong, without effort
**Treatment:** one button, an optional note, a thank-you that says what happens next
**Chrome:** `Button`, `Field` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Add `feedback` and the control. Done when: a member submits feedback and the case is unchanged.

- [x] Add migration `0045_feedback.sql` (the number from the coordinator, 2026-10-31): `id`, `case_id` (references `cases`, cascade), `user_id`, `kind` (`false_alarm` or `missed`), `note` (at most 1000 characters, nullable), `providers_json`, `created_at`, `updated_at`, `notified_at` (nullable), unique on (`case_id`, `user_id`). Done when: it applies locally and `test/web/feedback.test.ts` refuses a third kind and a 1001-character note at the table.
- [x] Write `POST /r/:caseId/feedback`: from the app's own origin, a bounded body, a member of the case's organisation by session (any membership, the `user_id` from the session), a case with a verdict; the kind and note checked explicitly (a missing or unknown kind, a note over 1000 characters: 400 with the error on the field and the input kept, nothing written, no notice); one row per member per case, replaced on a second send; the providers of the `reputation.*` items the reasons cite (every cited id, each provider once, `detail.provider`); the stored verdict and evidence never touched. Done when: `test/web/feedback.test.ts` saves both kinds, replaces one, keeps another member's apart, refuses each bad field, another organisation's member, a removed member, a link holder, a case with no verdict, another origin and an oversized body, answers a membership read failure with 503 and no write, records the exact cited providers (cited and uncited listings, two citations, a repeated provider, legacy string reasons recording `[]`), and leaves the verdict and evidence unchanged.
- [x] Draw the control in the finished report's footer for a member with a verdict: "This verdict is wrong" opens it in place (reached by keyboard), offering "It is safe" or "It is a scam" (the one that disputes this verdict first), an optional note, and Send, posting with htmx; the answer is the saved state ("You said this verdict is wrong: It is safe", with Change reopening the control filled), or the form again with its errors. No control for a link holder, a running or a failed check. Done when: `test/web/feedback.test.ts` draws the control for a complete and a partial check, none for running, failed or a link holder, and the saved state with Change filled after a reload.
- [x] Send N9's feedback notice for each feedback row once (`feedback:<id>`), at the post and from the cron for any row whose `notified_at` is still empty (`sendPendingFeedbackNotices`, `src/index.ts`'s scheduled run): the organisation, the verdict given, what the member says, what the verdict leaned on, the number waiting, and "Open the feedback queue" (`/admin/feedback`); never the note. Done when: the test sends one notice for a row whose first send failed and the cron later sent, one for two racing posts, none for a replaced choice, none with no operator address, and the notice's text has no note.
- [x] Record the control in `design/SPEC.md` M3 as built from the shared controls, not drawn. Done when: the entry names its states.
- [x] Prove the control in Chromium at 360 px and 1280 px in light and dark: opened and sent by keyboard, busy and single-submit, the thank-you announced, an outage keeping the note, axe clean. Done when: `test/node/feedback-browser.test.tsx` passes.
- [x] Close the completion review's in-scope gaps: a note is read up to the whole body's limit, so no overlong one is ever saved as no note; a membership read that fails answers with the form, its input kept, and a save that cannot be confirmed says so rather than "Nothing was saved"; a dropped connection or a timeout keeps the page and the note, says so in the form and gives Send back (`[data-swap-errors]`, `busy:release`, `src/web/client/app.ts`); focus lands on Change after a send, on the first field in error, and on the choice when reopened (`data-focus`), and the saved answer is said once through the report's live region; the cron takes the least recently tried notice first (`notice_tried_at`), so uncertain sends cannot starve later ones; the notice is N9's designed HTML with its plain text (`src/web/pages/feedback-notice.ts`), with the confidence in words and the cited listings' providers and evidence ids; and the tests drive Change, a resend and a reload in the browser, a partial check with a verdict, a check still running, a running report that finishes, and the HTML part as sent. Done when: `test/web/feedback.test.ts` (14), `test/node/feedback-browser.test.tsx` (9) and `test/node/report-status-browser.test.tsx` (20) cover each, and each fix's removal fails its test. **Added 2026-10-31 (completion review).**
- [x] Commit: `web: this-was-wrong feedback`

**Test checkpoint:** `pnpm exec vitest run test/web/feedback.test.ts test/node/feedback-browser.test.tsx` passes and fails if feedback changes the stored verdict.

> **Verified:** 2026-10-31 | §6 | ac84b647cbad546a173671548743b00b3e07992f
> **Review:** `docs/reviews/d07-t03-s6.json`

## 7. Reply email matched to the report design

The reply (D01 T02 §3) gets the SPEC's email design: HTML with inline styles from tokens (email clients ignore stylesheets), the verdict colour band, reasons, actions and the report button, plus a plain-text part that reads well alone.

> **Started:** 2026-10-31T07:16:19Z
>
> **Corrected 2026-10-31:** Fact-checked against the tree. (1) The reply is built by `buildReply` (`src/mail/reply.ts`, D01 T02 §3, the checks lane): plain paragraphs today. This section's template is a pure function from the reply's input to its HTML and text, in `src/mail/templates/reply.ts` (a string builder like `src/web/pages/feedback-notice.ts`, its colours from `design/tokens/colors.json`'s light theme, since an email cannot read the stylesheet), and `buildReply` takes its HTML from it, the edit to that file agreed with the checks lane through the coordinator. (2) N1 (`Email-Reply`) draws the member variant: the verdict band ("Verdict · confidence", headline, what it means), What to do now numbered, Why we say so with each reason's evidence pill, the count of further findings, Open the full report with the link to paste, the Headers checked panel and the footer. The confidence, the organisation's name and the findings count are not in `ReplyInput`: they are passed from what the Workflow's reply step already reads. (3) The headers panel's "Checked in 48 seconds by …" needs the model trace (D07 T03 §5): this section draws the panel's first sentence from `headersAvailable`, and the timing and models wait on §5. (4) The counterparty variant (`Email-Reply-Counterparty`) is D05 T02 §5's. (5) A reply with no verdict (the failure advice `buildReply` writes) is not drawn: it takes the same frame with its words, recorded as such in `design/SPEC.md` N1.
>
> **Corrected 2026-10-31 (plan review and the checks lane's answers):** (6) Coverage reaches the reply: the reply step passes the case's stored check outcomes (`readCheckOutcomes`), and a reply with a verdict whose checks were not all complete says which did not run, in both parts. (7) "Headers checked" is drawn from the authentication results D01 T02 §11 adds to the reply's input (`headers`: SPF, DKIM, DMARC), only when present, never from `headersAvailable` alone. (8) The actions follow the report's rule (§2, `orderedActions`): a fixed action anywhere among the stored ones comes first, then the cut to three. (9) The reasons are drawn as `{ text, evidenceIds }` with a pill when a reason cites (§2's `reasonsOf`): stored strings draw no pill and no citation is invented; the route read-back of structured reasons is §10's. The band's sentence is §2's fixed sentence per verdict until §10 draws the stored one. (10) The organisation's name and the findings count are new scoped reads in the reply step (`src/pipeline/analysis-workflow.ts`), a failed read retrying the step; "N more findings" counts the case's items its drawn reasons do not cite, each once, and says nothing at zero. (11) Rendering is proven by drawing the HTML in Chromium at phone and desktop widths, with long content, images off and the link followed; the named mail clients themselves are §25's (attended). (12) Both parts reach the recipient: the template builds the HTML and the text, `buildReply` passing its own notes, failure advice and subject in so their words stay the checks lane's (the agreed edit, through the coordinator), and the Workflow's reply step test reads both from the SMTP request.
>
> **Corrected 2026-10-31 (build):** The template owns the HTML only. The plain text stays `buildReply`'s own lines, since the checks lane's answer keeps every existing text line of `test/mail/reply.test.ts` as it is, and the template exports the lines both parts add (`coverageWords`, `headersWords`, `footerWords`), so the two parts cannot drift. The text gains the coverage line, the moved fixed action, Headers checked when known, and the footer (organisation, the link's 7-day life, "we never ask"), appended after the link so it reads whole alone. The reads are in the exported `reply()`, which the operator's resend calls too (the checks lane's answer). The HTML document's title is the reply's subject (axe's `document-title`).
>
> **Deferred:** the headers panel's timing and models -> XREF: D07 T03 §5
>
> **Deferred:** the counterparty reply's design -> XREF: D05 T02 §5
>
> **Resolved:** feedback from the emailed link for a member who is signed out -> XREF: D07 T03 §26. Resolved 2026-10-31 by D07 T03 §26 in `9f27a155`: the signed link's report invites its reader to sign in, and returns a member to the member view where "This verdict is wrong" is.
>
> **Deferred:** the reply in the member's language -> XREF: D07 T03 §27

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` N1 Verdict reply, board `Email-Reply` (member variant)
**Job:** a member reads the answer in their mail app without opening anything else
**Treatment:** the report's first screen as an email, working in Outlook, Gmail and Apple Mail
**Chrome:** the email layout defined in `design/SPEC.md`

**Build order:**

1. Build the HTML template from tokens. Done when: the reply snapshot matches the SPEC and has no external CSS.
2. Check rendering. Done when: the HTML passes an email-safety lint (no flex or grid, tables for layout, alt text on images).

- [x] Build `src/mail/templates/reply.ts`: the reply's HTML in N1's design (tables only, inline styles from the light theme's tokens, the logo and the verdict's motion art by absolute URL with their alt text) and its plain text, from the reply's input: the band with the verdict, its confidence in words, the headline and §2's sentence; What to do now (§2's order: a fixed action first, then at most three, numbered); Why we say so (at most three, a pill for a cited reason, none for a stored string); "N more findings are in the full report" (the items the drawn reasons do not cite, nothing at zero); a coverage line when a check failed, was skipped or read only part of its input; Open the full report and the link to paste; Headers checked from `headers` when present; the notes and failure advice `buildReply` passes in; and the footer naming the organisation, the link's 7-day life and "Think we got it wrong? Tell us on the report page." Done when: `test/mail/reply-design.test.ts` draws a malicious, a suspicious, a safe, a partly checked and a failed reply, checks each part's words in both bodies, places a fixed action given seventh first, draws no pill for stored strings and one for a structured reason, counts more findings with repeated citations and at zero, and escapes a hostile headline.
- [x] Lint the HTML for what email clients drop: no `<style>`, `<link>` or `<script>`, no `display:flex`, `grid`, `position` or `float`, a `role="presentation"` on every layout table, alt text on every image, and no colour that is not a token. Done when: the lint passes the reply and fails on a planted `display:flex`, a missing alt and a raw colour.
- [x] Draw the reply's HTML in Chromium at 360 px and 640 px: no sideways scroll with a 300-character headline and a long domain, the text readable with images off (alt text in their place), axe's colour-contrast and reading-order rules clean, and Open the full report followed to the report's URL. Done when: `test/node/reply-design-browser.test.tsx` passes for each variant.
- [x] Take both of `buildReply`'s parts from the template, passing its own notes, failure advice and subject, and pass the organisation's name, the findings count and the check outcomes from the reply step (`src/pipeline/analysis-workflow.ts`), each read failing the step to its retry, as agreed with the checks lane. Done when: `test/mail/reply.test.ts` passes with only its HTML assertions replaced, and `test/pipeline/reply-step.test.ts` reads the designed HTML and text, the same signed link in both and the warnings, from the SMTP request.
- [x] Record in `design/SPEC.md` N1 that the reply with no verdict uses the member frame with its own words (not drawn). Done when: the entry exists.
- [x] Commit: `mail: reply email matched to the report design`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply-design.test.ts test/mail/reply.test.ts test/pipeline/reply-step.test.ts test/node/reply-design-browser.test.tsx` passes.

> **Verified:** 2026-10-31 | §7 | 8c5a456e66983b5f0b8075d09accafe1f7f3cb04
> **Review:** `docs/reviews/d07-t03-s7.json`

## 8. Full-size evidence viewer

A figure on an evidence card is a 152 px preview with its overflow hidden (D07 T01 §7's `EvidenceFigure`), so a screenshot scaled into it can hide the small domain or form field the finding rests on. The reader opens the full-resolution capture with one activation, reads it, and returns to the same card; an artefact that is gone says so instead of opening nothing. Filed from D07 T01 §7's completion review (out-of-scope gap, 2026-10-27), which compared it with Microsoft Defender for Office 365's email entity page, where a captured screenshot opens from the finding.

**Phase:** 2
**Needs:** operator
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the viewer, once drawn), a new board `Report-EvidenceViewer` (desktop and `Report-Mobile` width), the preview from board `Main` E7
**Job:** a sceptical reader checks the proof at full size without losing their place in the report
**Treatment:** the approved preview layout unchanged; the full capture at its natural size, scrollable, on the page's own surface; tokens only; the capture's alt text names what it shows
**Chrome:** `EvidenceFigure` (D07 T01 §7), the native `<dialog>` with the shared `Button` (D07 T01 §6) to close it

**Owner decision (open):** the viewer's design (an in-page dialog over the report, or the capture opened in place of the page with a back link) is drawn as a board and approved by the operator first, since it is a new surface (design/SPEC.md: a change to the approved look goes back to the operator). Recording `Viewer approved: YYYY-MM-DD (<board>)` here and removing `operator` from Needs releases the section.

**Operator decision (2026-10-28 22:42 SAST):** the viewer is an in-page dialog over the report: activating a preview opens the full-resolution capture in the native `<dialog>`, scrollable, closed by Escape or the Close button, focus returning to the same card. The `Report-EvidenceViewer` board is drawn in that direction and approved before the build; `operator` stays in Needs until `Viewer approved: YYYY-MM-DD (Report-EvidenceViewer)` is recorded here.

**Build order:**

1. Draw and approve the viewer. Done when: the board and the SPEC entry exist and the approval line is recorded.
2. Open the capture from its preview and come back. Done when: one activation opens the full-resolution capture and closing returns focus to the same figure.
3. Show a missing or failed capture honestly. Done when: an expired capture says so and offers nothing to open.

- [ ] Draw `design/mockups/source/Report-EvidenceViewer.dc.html` (desktop and 360 px) with its PNG export, and add the viewer to `design/SPEC.md` M3 (what opens it, the close control, the unavailable and retry states). Done when: the board and the SPEC entry are committed and the operator's `Viewer approved:` line is recorded here. Cheaper substitute: opening the raw file in a new tab with no way back to the card.
- [ ] Give `EvidenceFigure` in `src/web/components/Evidence.tsx` an optional `full` (the artefact's `/a/:caseId/:key` URL from §3 and the capture's alt text) that makes the preview one native control named "Open full size: <caption>", keeping the preview's look. Done when: `test/node/verdict.test.tsx` renders a figure with and without `full` and finds the control's name and target only when it is given. Cheaper substitute: a click handler on a `div`, which the keyboard cannot reach.
- [ ] Build the viewer as the board draws it, from `src/web/components/EvidenceViewer.tsx`: the capture at its natural size inside a scrollable frame, a `Button` to close, Escape closing it, and focus returning to the figure that opened it; without the app script the control is a plain link to the artefact, so the proof still opens. Done when: `test/node/evidence-viewer-browser.test.tsx` opens it with Enter in Chromium, finds the image at its natural width, closes it with Escape and finds focus back on the same figure, in both themes. Cheaper substitute: a scaled image that is no larger than the preview.
- [ ] Show an artefact that is gone (`readArtefact` answers `missing`, §3) as "Original deleted after 30 days for privacy" with no control to open, and a `storage` failure as a temporary failure with a retry. Done when: the browser test renders both and neither offers a control that opens nothing. Cheaper substitute: a broken-image icon.
- [ ] Prove the viewer at 360 px: the capture scrolls in both directions inside the frame, the close control stays in view, and the page behind does not scroll. Done when: the browser test measures all three at 360 px.
- [ ] Commit: `web: full-size evidence viewer`

**Test checkpoint:** `pnpm exec vitest run test/node/verdict.test.tsx test/node/evidence-viewer-browser.test.tsx` passes, and fails when the viewer leaves focus anywhere but the figure that opened it.

## 9. Report header

The report's header (`design/SPEC.md` M3 anatomy, board `Main`): the breadcrumb back to Cases, the subject as the title, the sender, who forwarded it and when, and Download PDF and Copy link. Filed 2026-10-30 from §1's validation: a case does not store its subject or sender, so the header waits on intake storing them (a D01 row, asked of the checks lane through the coordinator).

> **Started:** 2026-10-31T08:18:46Z
>
> **Corrected 2026-10-31:** Fact-checked against the tree. (1) Intake stores the original's subject and sender (D01 T01 §16: the case's `originalSubject`, `originalFromName` and `originalFromAddress` in `src/db/cases.ts`; the parser's own names are `subject`, `fromName` and `fromAddress`), each nullable: a case parsed before that row, an upload, or a header that would not decode has none, so every part has words for its absence and never invents one. (2) The forwarder's name follows the Cases list's rule (`src/db/case-list.ts`: the member of the case's organisation whose email is `forwarded_by`), moved to one helper both read; an upload names its uploader (`uploaded_by`, a user id) the same way. (3) "Forwarded as an attachment" is said only when the forward carried the original's headers (`headersAvailable`); an inline forward says "Forwarded by". (4) The public view (a signed link) shows the subject and the sender but not who forwarded it or the breadcrumb: a link holder outside the organisation learns nothing about its members. (5) Copy link copies the report's own address: a member's `/r/<id>` (a colleague opens it by session) and a link holder the signed link they hold; a member never mints a new public link here. (6) Download PDF is the browser's print, which the app shell's `print:` rules already strip to the report; it is a button only the app script shows (`[data-print]`), so a page without scripts shows no control that does nothing. (7) On a phone the board (`Report-Mobile`) draws the header as one line under the band: subject, sender's address and time.
>
> **Corrected 2026-10-31 (plan review):** (8) The header catches up with parsing: a case opened before its parse step has no subject or sender yet, so the status poll (§4) also returns the header, swapped out of band (`hx-swap-oob` on `#report-header`), until the case has finished. (9) An upload whose uploader is unknown (no `uploaded_by`, a member who has since left, a blank name, or a user of another organisation) says "Uploaded · <time>", naming no one; a forward whose sender is no member names the forwarding address. (10) The phone line joins only the parts that exist, with no empty label or dangling separator: the subject (or "No subject"), "from <address>", or "from <name>" when only a name was stored, or nothing, then the time. (11) The checkpoint runs the browser test, which works both actions from the keyboard, recovers from a refused clipboard with visible feedback and a selectable address, and checks the header's subject and sender survive print media, in the member and signed-link views at phone and desktop widths in both themes.
>
> **Corrected 2026-10-31 (build):** (12) Every status answer carries the header out of band, not only until the case finishes, so the last answer (the verdict's) settles it too. (13) Download PDF is shown by the stylesheet under a mark the app script sets (`data-script` on the page), not by the script revealing each control: a header the poll swaps in every 2 seconds would otherwise flicker. (14) The forwarder's name is read by `checkerName` in `src/db/case-list.ts` beside the list's own rule (the same match: a member of the case's organisation, a name that is not blank), which also names an upload's uploader; the list keeps its one-query subquery. (15) A stored subject is at most 300 characters (the column's check), so the longest hostile subject tested is 300.
>
> **Corrected 2026-10-31 (completion review):** (16) The status poll sends the header only when its facts changed (`headerKey`, sent by the poll as `h` and taken off the address before a signed link is read), so focus, copy feedback and a hand selection in the header survive every other poll. (17) Copy link, like Download PDF, shows only where the app script runs; without it the report's address is shown to select by hand ("Link to this report:").
>
> **Resolved:** an upload's file name as its header's title -> XREF: D07 T03 §28. Resolved 2026-10-31 by D07 T03 §28 in `fe0d37b7`: an upload is titled by its file name (labelled "Uploaded file"), and an uploaded email by its subject with its file named beside it and in the phone's line.
>
**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the header), boards `Main`, `Report-Mobile`
**Job:** a member sees which message the report is about before reading the verdict, and can keep or share it
**Treatment:** the subject as the title, the sender and forwarder in plain words, two quiet actions
**Chrome:** `AppShell`, `Button` and the copy group (D07 T01 §3, §6, §9)

**Build order:**

1. Draw the header from the stored subject and sender. Done when: each fixture's header shows its message.

- [x] Move the Cases list's forwarder name into one helper, `checkerName` in `src/db/case-list.ts` (the member of the case's organisation whose email is `forwarded_by`, or whose id is `uploaded_by`), and read it for the report in `src/web/pages/report.tsx`. Done when: `test/web/report-access.test.ts` names the forwarding member, the uploading member, and falls back to the forwarding address for a sender who is no member; the Cases list's own tests still pass.
- [x] Draw the header in `src/web/pages/report-view.tsx`: for a member the breadcrumb "Cases / <subject>" (a `nav` with `aria-label="Breadcrumb"`, the subject `aria-current="page"`), the subject as the `h1` wrapping anywhere ("No subject" when it is empty or missing), "From <name> <address>" (whichever parts are stored; nothing when neither is), and "Forwarded as an attachment by <name> · <SAST time>" ("Forwarded by" inline, "Uploaded by" for an upload). Done when: the test finds each part for an attachment forward, an inline forward and an upload, and a hostile subject (markup and a 300-character line, the longest intake stores) renders as text and wraps. Cheaper substitute: the case id as the title.
- [x] Draw the public view's header with the subject and the sender only, no forwarder and no breadcrumb. Done when: the test finds the subject and sender on a signed link and no forwarder's name or address. Cheaper substitute: the member header for everyone.
- [x] Draw Copy link with the copy group (`[data-copy]`, D07 T01 §9) copying the report's absolute address (a member's `/r/<id>`, a link holder's signed link), and Download PDF as a `[data-print]` button the app script shows and binds to `window.print()` (`src/web/client/app.ts`). Done when: the test finds both with the right value, and `test/node/report-header-browser.test.tsx` copies the link, opens the print dialog through a stubbed `window.print`, and sees no Download PDF without the script. Cheaper substitute: a "Save as PDF" hint in text.
- [x] Draw the phone layout (`Report-Mobile`): the header as one line under the band joining only the parts that exist (the subject or "No subject", "from <address>" or "from <name>", the time), the breadcrumb as "← Cases". Done when: the browser test at 360 px finds the line for a full sender, a name only, no sender (an inline forward and an upload), in the member and public views, with no empty label or doubled separator, and no sideways scroll with the 300-character subject.
- [x] Return the header from the status poll out of band (`hx-swap-oob` on `#report-header`, `src/web/pages/report.tsx`'s `serve(c, "status")`) while the case is not finished. Done when: `test/node/report-header-browser.test.tsx` opens a received case, stores its subject and sender as the parse step does, and sees both the desktop and phone headers update without a reload.
- [x] Name no one for an upload whose uploader is unknown ("Uploaded · <time>"): no `uploaded_by`, a member who left, a blank name, or a user of another organisation. Done when: `test/web/report-access.test.ts` covers each and never shows another organisation's member's name.
- [x] Work Copy link and Download PDF from the keyboard, recover from a refused clipboard with the copy group's visible message and selectable address, and keep the header's subject and sender in print media. Done when: the browser test does each in the member and signed-link views at 360 px and 1280 px, light and dark.
- [x] Record in `design/SPEC.md` M3 the absent-field words and the public view's header (not drawn). Done when: the entry exists.
- [x] Commit: `web: the report header`

**Test checkpoint:** `pnpm exec vitest run test/web/report-access.test.ts test/node/report-header-browser.test.tsx` passes with the header drawn from stored fields for an emailed and an uploaded case.

> **Verified:** 2026-10-31 | §9 | 990689e1b6894a434452dca4f311fb8958ea2920
> **Review:** `docs/reviews/d07-t03-s9.json`

## 10. Stored verdict sentence, reasons

The verdict banner's third line is one sentence on what the verdict means for this message (`design/SPEC.md` M3, board `Main`: "The link leads to a lookalike login page that sends your password to someone else. Do not use it."). Filed 2026-10-31 from §2's validation: the stored verdict holds a headline but no such sentence, so §2 draws a fixed sentence per verdict until the verdict carries one (asked of the checks lane through the coordinator for D04 T01 §2's VerdictView change).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (verdict banner), boards `Main`, `Report-Safe`, `Report-Invoice`, `Report-Voice`
**Job:** a member reads, in one sentence, what this message would do to them
**Treatment:** the stored sentence in the band, the fixed one only for a verdict stored before it existed
**Chrome:** `VerdictBand` (D07 T01 §7)

**Build order:**

1. Draw the stored sentence. Done when: a verdict with its sentence draws it and an older one draws the fixed sentence.

- [ ] Draw the verdict's stored meaning sentence as the band's sentence in `src/web/pages/report-verdict.tsx`, and the fixed per-verdict sentence (§2) only when the stored verdict has none. Done when: `test/web/report-verdict.test.ts` draws a stored sentence, an older verdict draws its fixed one, and a hostile sentence (markup, 300 characters) renders as text and wraps.
- [ ] Read a stored structured reason back through the report route once the checks lane's reader returns `{ text, evidenceIds }` (D04 T01 §2): the route test stores a structured verdict and finds its pills. Done when: `test/web/report-verdict.test.ts` reads one back through the route. **Added 2026-10-31** (D07 T03 §2's plan review).
- [ ] Commit: `web: the verdict banner draws its stored sentence`

**Test checkpoint:** `pnpm exec vitest run test/web/report-verdict.test.ts` passes with the stored sentence drawn.

## 11. Follow-up question from the report

A reader whose situation the fixed advice does not cover ("I already paid; what now?", "I typed my password") asks one follow-up question on the report and gets guidance for that case, its verdict and evidence kept as context. General assistants answer follow-ups (D07 T03 §2's completion review, E2); the report today ends at its list. Filed 2026-10-31 from §2's completion review. It changes the approved report surface, so the operator approves a board for it first.

**Phase:** 6
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** a new `design/SPEC.md` M3 control and board, approved by the operator before the build
**Job:** a member who already acted on a bad message learns the next step for their case without phoning anyone
**Treatment:** one question box under What to do now, its answer in plain words citing the case's evidence
**Chrome:** `Field`, `Button` (D07 T01 §6, §8)

**Build order:**

1. Approve the surface, then build it. Done when: a member asks one question on a fixture report and reads an answer for that case.

- [ ] Draw the follow-up control on the M3 board (placement, empty, asking, answered and refused states) and record it in `design/SPEC.md` M3 with the operator's approval. Done when: the board and SPEC entry exist with the approval dated.
- [ ] Answer one question per case through the verdict agent (D04) with the case's verdict, actions and evidence summaries as context, never the raw message, the answer citing evidence ids and stored as a case event. Done when: `test/web/report-follow-up.test.ts` asks on a fixture case, stores the event and draws the answer, and a second question in the same minute is refused.
- [ ] Commit: `web: follow-up question from the report`

**Test checkpoint:** `pnpm exec vitest run test/web/report-follow-up.test.ts` passes.

## 12. Reputation cards

A reputation finding shows the provider, what was listed, when, and the delisting or review link (spec 4.3a, M3 "listed in error? request a review"). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, board `Main`
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Add the family's renderer. Done when: a fixture of each of its checks draws its card.

- [ ] Draw `reputation` cards in `src/web/components/evidence/` with the provider, what was listed, when, and the delisting link (spec 4.3a). Done when: `test/web/evidence-cards.test.ts` draws a fixture of each of the family's registered checks through its renderer, the registry test passes with the family mapped, and the listing fixture shows all four.
- [ ] Commit: `web: reputation cards`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes with the family's checks drawn.

## 13. Link and walkthrough cards

A link finding shows its chain and landing screenshot, and a walkthrough shows each page it walked with the credential target (M3, board `Main` E7). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

**Phase:** 4
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, board `Main`
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Add the family's renderer. Done when: a fixture of each of its checks draws its card.

- [ ] Draw `link` cards (the redirect chain, the landing screenshot, the form found, a QR code's decoded link) and `walkthrough` cards (the steps with their screenshots and where the form sends what is typed). Done when: `test/web/evidence-cards.test.ts` draws a fixture of each of the family's registered checks through its renderer, the registry test passes with the family mapped, and a walkthrough fixture draws its steps in order with the credential target.
- [ ] Commit: `web: link and walkthrough cards`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes with the family's checks drawn.

## 14. Vision and brand cards

A vision finding shows the rendered page or the logo crop beside its reference, and a brand finding the claimed brand against its real domains (M3, board `Main`). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

**Phase:** 4
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, board `Main`
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Add the family's renderer. Done when: a fixture of each of its checks draws its card.

- [ ] Draw `vision` cards (the render with what was read, the logo crop beside the reference) and `brand` cards (the claimed brand, its real domains, the sending domain). Done when: `test/web/evidence-cards.test.ts` draws a fixture of each of the family's registered checks through its renderer, the registry test passes with the family mapped, and a logo fixture draws its crop beside the reference.
- [ ] Commit: `web: vision and brand cards`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes with the family's checks drawn.

## 15. Invoice and document cards

An invoice finding shows the masked comparison of the invoice's bank details with the ledger, and a payment document its fields and the limit statement (M3, board `Report-Invoice`; S3 payment document card). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 invoice state, board `Report-Invoice`, the payment document card on S3
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Add the family's renderer. Done when: a fixture of each of its checks draws its card.

- [ ] Draw `invoice` cards (the masked field comparison with the ledger and the registered account, the PDF page with the bank block outlined) and `document` cards (the extracted fields, the layout finding, the limit statement). Done when: `test/web/evidence-cards.test.ts` draws a fixture of each of the family's registered checks through its renderer, the registry test passes with the family mapped, and an account number is never drawn unmasked.
- [ ] Commit: `web: invoice and document cards`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes with the family's checks drawn.

## 16. Voice cards

A voice finding shows the transcript with the request, the claimed identity and the limits (M3, board `Report-Voice`). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 voice note state, board `Report-Voice`
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Add the family's renderer. Done when: a fixture of each of its checks draws its card.

- [ ] Draw `voice` cards (the player, the transcript with the request highlighted, the extracted request and claimed identity, the limits). Done when: `test/web/evidence-cards.test.ts` draws a fixture of each of the family's registered checks through its renderer, the registry test passes with the family mapped, and the transcript draws its marked request as text, never markup.
- [ ] Commit: `web: voice cards`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes with the family's checks drawn.

## 17. Trust and verification cards

A trust finding shows the claim against the registry of the protected business, and a verification card the request sent and the answer (M3; D05). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, the counterparty board `Report-Counterparty`
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Add the family's renderer. Done when: a fixture of each of its checks draws its card.

- [ ] Draw `trust` cards (the claim, the registry value it was compared with, the copied badge) and `verification` cards (the request sent, to whom, and the answer with its time). Done when: `test/web/evidence-cards.test.ts` draws a fixture of each of the family's registered checks through its renderer, the registry test passes with the family mapped, and a verification fixture draws the request and its answer.
- [ ] Commit: `web: trust and verification cards`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes with the family's checks drawn.

## 18. Check count and clean checks

The report's count line ("9 findings · 8 checks ran · nothing skipped", M3) and the safe board's "Checks that found nothing" panel (`Report-Safe`), read from each case's stored check outcomes. Filed 2026-10-31 from §3's plan review: the runner stores findings, not each check's outcome, so these wait on a checks-lane row persisting per-case check outcomes (asked through the coordinator, who links it here).

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the count line, the safe state's "Checks that found nothing"), boards `Main`, `Report-Safe`
**Job:** a reader sees how much was checked, and on a safe verdict what was checked and found clean
**Treatment:** one quiet count line, a short list of clean checks in words
**Chrome:** the report's evidence section (§3)

**Build order:**

1. Read the stored outcomes. Done when: the count line and the clean list come from them.

- [ ] Draw the count line from the case's stored check outcomes (findings, checks run, checks skipped) and, on a safe verdict, "Checks that found nothing" listing each check that ran clean in words. Done when: `test/web/evidence-cards.test.ts` counts a check that ran clean with no finding, a check with several findings once, a grouped skip as each check it covers, and a historical case's outcomes whose check is no longer registered.
- [ ] Commit: `web: the report counts its checks`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes with the outcomes read from storage.

## 19. Original message preview

A reader opens the original message's safe rendering and its complete headers from a finding in one action, without downloading it, running anything in it or opening a mail client (D07 T03 §3's completion review: an investigation console shows the preview and headers in place, where §3's cards offer the original only as a download). Filed 2026-10-31. It adds a surface to the approved report, so the operator approves its board first.

**Phase:** 6
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** a new `design/SPEC.md` M3 control and board, approved by the operator before the build
**Job:** a sceptical reader checks the message itself and its headers without leaving the report
**Treatment:** the message as plain, inert text and its headers in full, beside the finding that cites them
**Chrome:** `EvidenceQuote`, the full-size viewer of §8

**Build order:**

1. Approve the surface, then build it. Done when: a member opens a fixture's preview and headers from a card.

- [ ] Draw the preview on the M3 board (where it opens, the headers view, a long or hostile message, an unavailable original) and record it in `design/SPEC.md` M3 with the operator's approval. Done when: the board and SPEC entry exist with the approval dated.
- [ ] Render the stored visible text and the complete headers under the report's access rule, as text only (never the message's HTML, never a remote load), opened from a card in one action and closed back to it. Done when: `test/web/message-preview.test.ts` opens a fixture's preview for a member and a link holder, a hostile message renders as text, and another organisation gets 404.
- [ ] Commit: `web: the original message preview`

**Test checkpoint:** `pnpm exec vitest run test/web/message-preview.test.ts` passes.

## 20. Retry a failed check

A member presses "Retry the check" on a failed report (`Report-Partial`'s failed state) and the case runs again once, the page following the new run. Filed 2026-10-31 from §4's validation: a finished case has no lifecycle move back, the Workflow instance id is the case id, and `admit` skips a finished case, so the re-run is a checks-lane row (asked through the coordinator, who links it here).

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 failed state, board `Report-Partial`
**Job:** a member whose check failed gets it run again in one press, and never twice by accident
**Treatment:** one clear retry, said while it runs, refused plainly when it cannot
**Chrome:** `ErrorState`, `Button` (D07 T01 §6, §8)

**Build order:**

1. Wire the retry. Done when: a failed fixture is retried once and the page follows the new run.

- [ ] Draw "Retry the check" for a member on a failed case (never for a link holder, who reads only), posting from the app's own origin to the checks lane's re-run, single-submit and busy while it posts; the page then shows the new run's status (§4). A second press while it runs, a case that now has a verdict, and an outage are each said in words. Done when: `test/web/report-status.test.ts` retries a failed fixture once, a second press is refused while it runs, a link holder sees no button, and the outage is said.
- [ ] Commit: `web: retry a failed check`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts` passes with the retry exercised.

## 21. Withdraw feedback

A member who disputed a verdict by accident takes it back: the feedback leaves the operator queue and the providers' false-alarm counts, and the report shows the control as before. Filed 2026-10-31 from §6's completion review.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 feedback control (§6), an entry for withdrawal added with it
**Job:** a member undoes an accidental dispute in one press
**Treatment:** one quiet Withdraw beside Change, said once when done
**Chrome:** the feedback control (§6), `Button` (D07 T01 §8)

**Build order:**

1. Build it. Done when: a withdrawn feedback gone from the queue and the counts.

- [ ] Add Withdraw to the saved state, removing the member's feedback (or marking it withdrawn, as D08's statistics read it) and dropping it from the queue's waiting count; record the entry in `design/SPEC.md` M3. Done when: `test/web/feedback.test.ts` withdraws a saved feedback, the queue count drops, a withdrawn row is excluded from the provider counts D08 T02 reads, and the control is offered again.
- [ ] Commit: `web: withdraw feedback`

**Test checkpoint:** `pnpm exec vitest run test/web/feedback.test.ts` passes with a withdrawn feedback gone from the queue and the counts.

## 22. One-press dispute

The dispute takes one press from the report for a member who adds no note (an email client's "Not junk" is one or two), the note and correction kept. The approved M3 control is open, choose, Send, so the operator decides the interaction and approves a board first. Filed 2026-10-31 from §6's completion review.

**Phase:** 6
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** a new `design/SPEC.md` M3 board for the one-press dispute, approved by the operator before the build
**Job:** a member disputes a wrong verdict in one press
**Treatment:** the dispute as one button whose words name the opposite verdict, the note offered after
**Chrome:** the feedback control (§6), `Button` (D07 T01 §8)

**Build order:**

1. Build it. Done when: a dispute sent in one press.

- [ ] Draw the one-press dispute on the M3 board and record it with the operator's approval. Done when: the board and SPEC entry exist with the approval dated.
- [ ] Send the dispute in one press, offering the optional note after, single-submit and undoable through Change. Done when: `test/web/feedback.test.ts` disputes in one post with no note and adds a note after.
- [ ] Carry the intent from the email or signed link through sign-in (added 2026-10-31 from §26's completion review): an entry that, once signed in, opens the same report with the dispute control open and focused (a return path naming it, kept same-site by `sameSitePath`), membership and the outsider's 404 unchanged, the choice and Send still explicit. Done when: `test/web/report-access.test.ts` follows the entry through a redeemed link to the member view with the control open, and an outsider still gets the 404; at most three activations besides signing in.
- [ ] Commit: `web: one-press dispute`

**Test checkpoint:** `pnpm exec vitest run test/web/feedback.test.ts` passes with a dispute sent in one press.

## 23. Feedback outcome to the member

A member who disputed a verdict learns what the review found: when the operator settles the feedback in the queue (D07 T08 §5), the report shows the outcome and the member is told, the original verdict never lowered automatically. Filed 2026-10-31 from §6's completion review.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 feedback control (§6) and a member notice, entries added with it
**Job:** a member learns what came of their dispute
**Treatment:** the outcome in plain words beside their feedback, one notice when it is settled
**Chrome:** the feedback control (§6), `Button` (D07 T01 §8)

**Build order:**

1. Build it. Done when: the settled outcome shown and one notice sent.

- [ ] Show the queue's settled outcome on the member's saved feedback and send them one notice within a minute of it being settled, never changing the verdict. Done when: `test/web/feedback.test.ts` settles a feedback through the queue's store, the report shows the outcome, one notice goes, and the verdict is unchanged.
- [ ] Commit: `web: feedback outcome to the member`

**Test checkpoint:** `pnpm exec vitest run test/web/feedback.test.ts` passes with the settled outcome shown and one notice sent.

## 24. Invisible-character cards

Filed 2026-10-31 from D02 T05 §3's review (relayed by the coordinator): `content.hidden_text` has an invisible-characters variant (`detail.reason: "invisible-characters"`, `detail.kind` `tag` or `ignorable`, `detail.quote` the decoded tag text or null, `detail.length`, `detail.location`, which may name an attachment), low for a zero-width run, medium for tag text, high when the tag text reads as an instruction. §3's card titles every hidden-text item "Hidden text aimed at scanners".

> **Started:** 2026-10-31T09:12:21Z
>
> **Corrected 2026-10-31:** Fact-checked against the producer (checks-lane, `src/checks/hidden-content.ts` `invisibleEvidence`, D02 T05 §3, in review): (1) a listed run's detail is `{ reason: "invisible-characters", kind, quote, length, location }`, `quote` the decoded tag text (at most 300 characters, `QUOTE` in the producer) or null for a run of other invisible characters; (2) beyond the listed runs one more item counts the rest, `{ reason: "invisible-characters", more }`, carrying their highest severity, which this card draws as "More invisible characters" with the count, as the AI-instruction card draws its own count; (3) `location` takes the instruction phrases' values (`visible`, `hidden`, `text`, `attachment:<name>`, `attachment-hidden:<name>`), worded by the cards' existing `placeWords`; (4) the producer reaches this branch with the D02 T05 §3 merge, so the cards are built and tested against these shapes, and a detail of any other shape keeps §3's hidden-text card.
>
> **Corrected 2026-10-31 (plan review):** (5) A quote is the run's opening 300 characters, and the producer reads the whole run for an instruction, so a high item's instruction may lie past it: a quote shorter than the run's `length` is labelled "Opening of the hidden text" and the card says the rest is in the original message, never implying the quote is the instruction. (6) Both variants keep the original message's download (`artefacts: [view.raw]`, "Download the original message"), proven through the report route for a member and a signed link. (7) The tests assert the length shown, and draw wrong-typed fields (a numeric quote or location, a string length or count) without throwing and without showing the bad value. (8) The variants are drawn in Chromium beside the existing cards, with a long decoded text and a long attachment name, at both widths and in both themes, the download reached by keyboard.
>
> **Corrected 2026-10-31 (completion review):** (9) The stored quote is not the producer's 300 characters: its detail bounds (`fittedDetail` in `src/checks/auth.ts`) clip any string past 255 characters and end it with "…", and a run's `length` counts nonprinting characters that decode to nothing, so `length > quote.length` falsely labelled a whole quote (a tag run closed by its cancel tag). A quote is cut exactly when it ends with "…", which decoded tag text (printable ASCII only) cannot hold, and it is drawn as stored, with no second "…"; the producer's own items are drawn in the test. (10) The phone's accessibility and width checks open "more findings" so they read the new cards, in both themes. (11) An instruction past the stored opening cannot be read in the report: filed as §29.
>
> **Deferred:** the hidden instruction past the stored opening -> XREF: D07 T03 §29
>
**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards
**Job:** a reader sees invisible characters for what they are, without alarm at a harmless run
**Treatment:** neutral words for a low or medium run, the instruction quoted when it is one, the location named
**Chrome:** `EvidenceCard`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Build it. Done when: the three variants drawn.

- [x] Draw the invisible-characters variant: "Invisible characters" for a low or medium item and "Hidden instruction in invisible characters" for a high one, the decoded text quoted when there is one, its length, and where it sits (the body or the named attachment). Done when: `test/web/evidence-cards.test.ts` draws a zero-width run, tag text and an instruction with their titles, quote, the length shown ("<n> characters") and location, and a hostile decoded text renders as text.
- [x] Label a quote cut short of the run ("Opening of the hidden text", and "The rest is in the original message.") when the quote is shorter than `length`, so a high item's instruction is never implied to be the quoted part. Done when: the test draws a 1,000-character run with a 300-character quote, labelled, and a whole quote unlabelled.
- [x] Keep "Download the original message" on both variants, and prove it through the report route (`test/web/report-access.test.ts`) for a member's and a signed link's view of stored invisible-character evidence. Done when: each view links the raw message with its own access (the signed link's parameters carried).
- [x] Draw the variants in `test/node/evidence-cards-browser.test.tsx`: a long decoded text, a long attachment name, at 360 px and 1280 px in light and dark, no sideways scroll, the accessibility gate's rules clean, and the download reached by Tab. Done when: the browser test passes.
- [x] Draw the count of further runs ("More invisible characters": "<n> more runs, not listed one by one"). Done when: the test draws the `more` item with its count.
- [x] Keep §3's hidden-text card for a `content.hidden_text` detail of any other shape, and draw a detail whose fields are missing or of the wrong type without throwing. Done when: the test draws an ordinary hidden-text item unchanged, an invisible-characters item with no quote, length or location, and one with a numeric quote and location, a string length and a string count, each drawn without the bad value and without throwing.
- [x] Commit: `web: invisible-character cards`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts test/web/report-access.test.ts test/node/evidence-cards-browser.test.tsx` passes with the invisible-character variants drawn.

> **Verified:** 2026-10-31 | §24 | 2ee277630df65782ed16b75629f42e5200ea30da
> **Review:** `docs/reviews/d07-t03-s24.json`

## 25. Reply checked in mail clients

Filed 2026-10-31 from §7's plan review: Chromium proves the reply's HTML, but Outlook (desktop and web), Gmail (web and app) and Apple Mail are what members read it in. Sending the designed reply to real accounts in each and looking is attended work.

**Phase:** 2
**Needs:** attended
**Surface:** yes
**Fidelity:** `design/SPEC.md` N1 Verdict reply, board `Email-Reply`
**Job:** a member's mail app shows the reply as designed
**Treatment:** the same reply sent to each client and seen, a record of what each shows
**Chrome:** the reply template (§7)

**Build order:**

1. Build it. Done when: every client recorded.

- [ ] Send the malicious, safe and failed replies to an Outlook desktop, Outlook web, Gmail web, Gmail app and Apple Mail account and record a screenshot of each in `docs/reviews/07-app/reply-clients/`, fixing in §7's template whatever a client breaks. Done when: each client's screenshots are recorded and none shows a broken layout, a missing image's alt text unreadable, or a dead link.
- [ ] Commit: `mail: reply checked in mail clients`

**Test checkpoint:** the client screenshots recorded in `docs/reviews/07-app/reply-clients/`.

## 26. Feedback from a signed link

Filed 2026-10-31 from §7's completion review (out-of-scope gap). The reply's footer says "Think we got it wrong? Tell us on the report page", but a member who opens the emailed link while signed out gets the public view, which has no feedback control (§6 keeps feedback to a signed-in member of the case's organisation) and no way to sign in and come back. Sign-in already carries a same-site return path (`/signin?next=`, `returnPath` in `src/auth/confirm-page.tsx`), so the public view can offer it without loosening who may send feedback.

> **Started:** 2026-10-31T12:27:48Z
>
> **Corrected 2026-10-31:** Fact-checked against the tree. (1) Sign-in already returns to `next` (`/signin?next=` read by `returnPath`, `src/auth/confirm-page.tsx`), and `test/web/report-access.test.ts` already redeems a link whose `callbackURL` is a report (`requestLink`, `redeem`, `target` in `test/auth/helpers.ts`). (2) The browser tests answer sign-in themselves, since the Worker's stubbed mail is not reachable from a browser (`test/node/sign-in-code-browser.test.ts`): the round trip (signed link, Sign in, a redeemed link, the member view with "This verdict is wrong") is proven in the Worker test through the real routes, and the browser test proves the footer's link on the drawn page (visible, reached by keyboard, its address, the accessibility gate's rules at both widths and themes).
>
> **Corrected 2026-10-31 (plan review):** (3) Feedback is offered only on a report with a verdict (§6), so the invitation says what signing in gives in each state: with a verdict "Is this your organisation's report? Sign in to tell us if we got it wrong."; a running or failed check "Is this your organisation's report? Sign in to see it with your organisation's cases." Either stays true while the footer, outside the polled region, is not redrawn when a running check finishes.
>
**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 report footer (board `Main`), the public frame (D07 T01 §10)
**Job:** a member reading the emailed report signed out can still say the verdict is wrong
**Treatment:** one sign-in link in the public view's footer that returns to this report, where §6's control is
**Chrome:** the public frame's footer, the shared text link (D07 T01 §6)

**Build order:**

1. Offer sign-in from the public view. Done when: the public view links to sign-in with this report as the return.
2. Prove the return. Done when: a member signs in from the link and lands on the member view with §6's control.

- [x] Draw in the public view's footer (`src/web/pages/report-view.tsx`, the `view !== "member"` branch) "Is this your organisation's report? Sign in to tell us if we got it wrong." with "Sign in" linking to `SIGNIN_PATH` with `next` set to the report's own path (`/r/<caseId>`, no link signature). Done when: `test/web/report-access.test.ts` finds the link with that `next` on the public view and not on the member view, the feedback words on a report with a verdict, and the other words on a running and a failed one. Cheaper substitute: telling the reader to find the case in Cases.
- [x] Leave the signature out of the return path, so a signed-in member reaches the member view by session and a non-member gets §1's 404, never the public view by the old link. Done when: the test signs in a member of another organisation through the link and gets the 404. Cheaper substitute: returning to the signed link.
- [x] Prove the round trip through the real routes in `test/web/report-access.test.ts`: the signed link's page names `/signin?next=%2Fr%2F<caseId>`, a sign-in link requested with that return and redeemed lands on `/r/<caseId>`, which draws the member view with "This verdict is wrong" (§6). Done when: the test passes.
- [x] Prove the footer's link in Chromium on the drawn public report: visible, reached by keyboard, its address the sign-in with the report as `next`, and the accessibility gate's rules clean at 360 px and 1280 px in light and dark. Done when: `test/node/report-signin-return-browser.test.tsx` passes.
- [x] Commit: `web: feedback from a signed link`

**Test checkpoint:** `pnpm exec vitest run test/web/report-access.test.ts test/node/report-signin-return-browser.test.tsx` passes.

> **Verified:** 2026-10-31 | §26 | 9f27a155fcf7d41c488d421a016deaa8876759c4
> **Review:** `docs/reviews/d07-t03-s26.json`

## 27. Reply and report in your language

Filed 2026-10-31 from §7's completion review (out-of-scope excellence item). The reply (§7) and the report are English only. Microsoft Defender for Office 365 localises its user-feedback emails to the recipient's preferred language. Which languages to support, and who reviews each translation, is the operator's call; this section holds until it is recorded.

**Phase:** 6
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` N1 Verdict reply and M3 report, every string in them
**Job:** a member reads the verdict in their own language
**Treatment:** the reply and report in the member's chosen language, English where none is set
**Chrome:** the reply template (§7) and the report's shared parts

**Build order:**

1. Record the decision. Done when: the operator's supported languages and reviewer are recorded here.
2. Translate every fixed string. Done when: each supported language has every string, reviewed.
3. Choose by the member's setting. Done when: the reply and report follow it, English otherwise.

- [ ] Record the operator's supported languages, the reviewer of each translation and whether the verdict's own words (D04 T01) are translated too. Done when: a dated **Decided:** line here names them and the `owner-decision` Need is removed.
- [ ] Move the reply's and the report's fixed strings (`src/mail/templates/reply.ts`, `src/mail/reply.ts`'s text through the checks lane, `src/web/pages/report-verdict.tsx`, `src/web/components/evidence/check-words.ts`) into one catalogue per language under `src/web/i18n/`. Done when: a test fails on a key missing from any supported language.
- [ ] Store the member's language (a user setting, D07 T05) and pick the catalogue from it in the reply and the report, English when it is unset or unsupported. Done when: a test sends the reply and draws the report in each supported language and in English for an unset one. Cheaper substitute: the browser's `Accept-Language`, which a mailed reply cannot read.
- [ ] Commit: `web: reply and report in the member's language`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply-design.test.ts test/web/report-access.test.ts` passes in every supported language.

## 28. Uploaded file's name in the header

Filed 2026-10-31 from §9's completion review (out-of-scope gap). An uploaded document, image or voice note has no email subject, so its header reads "No subject", though the case stores the file's name (`uploadName` in `src/db/cases.ts`). Microsoft Defender for Office 365's entity page names the files it inspected; here two uploaded invoices cannot be told apart by their header. The boards draw only an emailed case's header, so the upload's header is a design change first.

> **Started:** 2026-10-31T12:43:04Z
>
> **Corrected 2026-10-31:** Fact-checked against the tree and SPEC's convention. (1) The case stores the file's name (`uploadName` in `src/db/cases.ts`, an upload's only; null for a forward), which the report's `ReportCase` does not carry yet. (2) SPEC records states built from the shared parts as "not drawn" rather than adding to the approved boards (M2's and M3's entries), so the upload's header is recorded that way: the header's own parts (§9) with the file's name in the title's place. (3) The title reads the file's name, labelled for screen readers and in the meta line as "Uploaded file"; the phone's line and the breadcrumb carry it too, and "No subject" stays for a forward with none.
>
> **Corrected 2026-10-31 (completion review):** The phone's line, its only visible title, carries the label and the file too: "Uploaded file <name>" for an upload titled by its file, and "<subject> · Uploaded file <name>" for an uploaded email, so two uploads with one subject are told apart at 360 px with no action, before and after the poll. A hostile file name is proven as text in all three places.
>
> **Corrected 2026-10-31 (plan review):** (4) The title's precedence: a stored subject first (a forward, or an uploaded email once parsed), so an uploaded email reads like a forwarded one with its file named in the meta line as "Uploaded file <name>"; otherwise an upload's file name (a document, image or audio, and an uploaded email before parsing or with no subject); otherwise "No subject". The status poll swaps the title when parsing stores a subject, since the header key covers the subject; the file name is set when the case is made and never changes, so the key does not cover it (corrected 2026-10-31 at build, a mutation showing it carried nothing). (5) The browser proof uses persisted `uploadName` fixtures, in the member and signed-link views, at 360 px and 1280 px and in print, each promised rendering asserted so its removal fails. (6) The design state is SPEC-only ("not drawn"), as Fidelity now says.
>
**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the header), an upload's header recorded as built from §9's parts (not drawn)
**Job:** a member tells two uploaded files apart by their reports' headers
**Treatment:** the file's name as the title of an upload's report, labelled as a file, kept in print
**Chrome:** the report header (§9)

**Build order:**

1. Record the upload's header in the design. Done when: SPEC M3 records it.
2. Title an upload's report by its file name. Done when: the header shows it, safely, in every view.

- [x] Record an upload's header in `design/SPEC.md` M3 (built from §9's parts, not drawn): the file's name as the title, labelled "Uploaded file", the subject rule kept for email. Done when: the SPEC entry exists. Cheaper substitute: the file name in the meta line only.
- [x] Draw the upload's file name as the header's title in `src/web/pages/report-header.tsx` (from `uploadName` through `headerFacts`), wrapping anywhere, kept in print and on the phone's line, "No subject" never shown for an upload with a name. Done when: `test/web/report-access.test.ts` finds the name for an uploaded document, image and voice note, an uploaded email titled by its subject with "Uploaded file <name>" beside it (and by its name before parsing, swapped by the status poll after), a forward with and without a subject unchanged, and a hostile file name rendered as text.
- [x] Prove the upload's header in Chromium from `uploadName` fixtures, member and signed-link views, 360 px and 1280 px and print: the title, the breadcrumb, the phone's line and the "Uploaded file" label, a 255-character name wrapping without sideways scroll. Done when: `test/node/report-header-browser.test.tsx` passes, each rendering asserted.
- [x] Commit: `web: the uploaded file's name in the header`

**Test checkpoint:** `pnpm exec vitest run test/web/report-access.test.ts test/node/report-header-browser.test.tsx` passes with an upload titled by its file name.

> **Verified:** 2026-10-31 | §28 | fe0d37b71aa41258e1f930f2fa9bf4320eadb704
> **Review:** `docs/reviews/d07-t03-s28.json`

## 29. Hidden instruction past the opening

Filed 2026-10-31 from §24's completion review (out-of-scope excellence item). The producer reads a whole invisible-character run for an instruction but stores only its opening (255 characters, clipped with "…"), so an instruction that starts later cannot be read in the report: the reader must download the original, extract its text and decode the tag characters elsewhere (as Embrace The Red's ASCII Smuggler does, by paste and Decode). The excerpt around the instruction is the producer's to store (filed by the checks lane as D02 T05 §6, Phase 3: `detail.instruction: { text, offset }`, `text` up to 200 characters around the first instruction, absent when the run holds none); this section draws it, so it sits in Phase 3 with its producer.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards
**Job:** a reader reads the hidden instruction itself, wherever it sits in the run, without another tool
**Treatment:** the instruction's own excerpt under the opening, labelled with where in the run it starts
**Chrome:** `EvidenceCard`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Draw the instruction excerpt the producer stores. Done when: a run whose instruction lies past the opening shows it.

- [ ] Draw `detail.instruction` (the producer's excerpt around the instruction, with its character offset) under the opening in `src/web/components/evidence/cards.tsx`'s invisible-characters card, labelled "The instruction, from character <n>", and keep the card as §24 drew it when the field is absent. Done when: `test/web/evidence-cards.test.ts` draws a run whose instruction starts past the opening with the excerpt and its offset, from the producer's own items, and a hostile excerpt renders as text.
- [ ] Commit: `web: the hidden instruction past the opening`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes with the instruction excerpt drawn.

## 30. Document forensics cards

Filed 2026-10-31 at the trust lane's request (through the coordinator): `forensicsEvidence` in `src/invoice/forensics.ts` (trust lane, 448b7446) writes five checks that D06 T02 §3 registers, and the registry test (§3) fails while a registered check has no card, so D06 T02 §3 waits on this section. The checks: `document.forensics.revisions`, `.producer`, `.dates`, `.fonts` and `.overlay`; medium, high on every item of a file when two groups agree (history: revisions and dates; tool: producer; page: fonts and overlay); summary "<filename> <finding sentence>." (at most 200 characters); artefacts the PDF's key. Every detail carries `filename`, `issuer` ("bank" or "unknown") and `limits` (a fixed sentence on what the finding can and cannot show, which the card shows). Per kind: revisions `revisions`, `edits`, `afterSignature`, `updates` ("content", "signature" or "other" each) and `linearizedLengthChanged`; producer `tool`, `producer`, `creator`, `xmpProducer`, `xmpCreator`; dates `created`, `modified`, `paymentDate`, `paymentLine`, `infoAndXmpDisagree`; fonts `page`, `line`, `font`, `otherFont`, `rule` ("family" or "subset"); overlay `page`, `covered`, `line`, `onAmountOrAccountLine`, `image` `{ x0, y0, x1, y1 }`. Coverage (`forensicsCoverage`, ran, partial or skipped) reaches the report's coverage line already (§4).

> **Started:** 2026-10-31T11:43:33Z
>
> **Corrected 2026-10-31:** Fact-checked against the producer (`forensicsEvidence` and `LIMITS` in `src/invoice/forensics.ts` on origin/trust-lane): the shapes are as relayed, each detail carrying `filename`, `issuer`, its kind's own fields and `limits`, the summary already plain and bounded, the artefact the PDF's key. No card family covers `document` yet (`FAMILIES` in `src/web/components/evidence/cards.tsx`): this section adds it, with the five checks named, and §15's document cards later extend it. Until D06 T02 §3 registers the checks, the fixtures and a test registry carry them, as §31 did.
>
> **Corrected 2026-10-31 (plan review):** (2) `revisions` is the file's total saves (the producer writes `count + 1`), so 3 reads "saved twice after it was first made"; every conditional fact is proven both ways by contrasting fixtures: after a signature or not, family or subset, a bank or an unknown issuer, on an amount or account line or not, the two date records agreeing or not, and each optional metadata field present or missing. (3) Stored forensic evidence is read back through the member's and the signed link's report, and the PDF's download followed to its bytes in both, the signed link's access kept, as §31 did.
>
> **Corrected 2026-10-31 (completion review):** (4) A font finding's heading follows its rule: "A line in a different typeface" for `family`, "A line set from a second copy of its typeface" for `subset`. (5) All five checks are in the shared fixture list the registry test reads, so D06 T02 §3's registration finds each drawn, and all five pass through both report views and the browser matrix. (6) The producer's `LIMITS.fonts` says the typeface differs even for a subset finding: the trust lane's to correct, asked inside D06 T02 §3. A highlighted page for a finding is filed as §33.
>
> **Deferred:** a forensic finding's highlighted page -> XREF: D07 T03 §33
>
**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards (the payment document card on S3 for its limits line)
**Job:** a sceptical reader sees what in the document was changed, by what, and what that cannot prove
**Treatment:** the card frame of §3: the finding in plain words, its facts, the limits sentence, the PDF to download
**Chrome:** `EvidenceCard`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Draw the five cards. Done when: a fixture of each draws its facts and limits, and the registry test maps the five names.

- [x] Name the five checks in `src/web/components/evidence/check-words.ts` and draw each in `src/web/components/evidence/cards.tsx`'s `document` family: revisions (how many saves after the first, the edits, whether a save came after a signature, what each update changed, a linearisation that no longer matches), producer (the tool, the producer and creator, the XMP's own), dates (created, modified, the payment date and its line, Info and XMP disagreeing), fonts (the page and line, the font and the other, family or subset), overlay (the page, what is covered, the line, whether it is an amount or account line); each with the issuer when it is a bank, the `limits` sentence, and the PDF's download. Done when: `test/web/evidence-cards.test.ts` draws a fixture of each from the trust lane's shapes with contrasting fixtures for every conditional fact (each asserted present and absent), `revisions: 3` read as two later saves, a missing or wrong-typed field drawn without the bad value and without throwing, and hostile text as text.
- [x] Read stored forensic evidence back through the member's and the signed link's report (`test/web/report-access.test.ts`, a test registry until D06 T02 §3 registers the checks) and follow the PDF's download to its bytes in both. Done when: each view draws the cards and the download answers the file, the signed link's parameters carried.
- [x] Prove the cards in Chromium beside the existing ones at 360 px and 1280 px, light and dark: no sideways scroll, the accessibility gate's rules clean, the download reached by keyboard. Done when: `test/node/evidence-cards-browser.test.tsx` passes with the five drawn.
- [x] Commit: `web: document forensics cards`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts test/web/report-access.test.ts test/node/evidence-cards-browser.test.tsx` passes with the five cards drawn.

> **Verified:** 2026-10-31 | §30 | 4d684d2b41b63e87a3794b28995e2f37cedeb610
> **Review:** `docs/reviews/d07-t03-s30.json`

## 31. Link text mismatch card

Filed 2026-10-31 at the checks lane's request (through the coordinator, on the critical path): D02 T07 §1 registers `link.text_mismatch` right after `content.ai_instructions`, and the registry test (§3) fails while a registered check has no card, so D02 T07 §1 cannot reach main before this card; the links unblock the walkthrough and Glimmer lanes. §13's link and walkthrough cards keep their own row. The contract: severity medium; summary "The link showing <shown domain> goes to <target host>."; detail `{ shown, target, href, kind, part }`, `kind` one of `href`, `form`, `frame`, `image`, `refresh`, `text` or `pdf`, `part` `summary`, a cut part's key or an attachment's key; artefacts the attachment's key when the link came from one, else none. An item with `detail.checked === false` carries `more` (links past the first 50) or `unread` (a PDF or part that could not be read); the outcomes (skipped with no links, partial past 50 or unread) reach the report's coverage line already (§4).

> **Started:** 2026-10-31T11:22:40Z
>
> **Corrected 2026-10-31:** Fact-checked against the tree. (1) The producer (D02 T07 §1) is in its plan review and not on any branch yet, so the card is built to the contract the coordinator relayed (2026-10-31) and its fixtures carry exactly that shape. (2) No card family covers `link` yet (`FAMILIES` in `src/web/components/evidence/cards.tsx` is intake, auth, sender, domain, attachment, content and not_checked): this section adds the `link` family and its renderer, which §13's link and walkthrough cards later extend. (3) The registry test (§3) maps every registered check to a family with a renderer; until D02 T07 §1 registers the check, the fixture and the plain-words test carry it.
>
> **Corrected 2026-10-31 (plan review):** (4) An attachment is named by its stored key's name (`attachmentKey` in `src/intake/store.ts` keeps `<sha256>-<safe name>`, the name cleaned and shortened), labelled as the attachment's stored name, and "an attachment" when the key has none; `part` naming the message or a cut part reads "In the message" or "In a part of the message". (5) The not-checked variant draws at the cards' existing not-checked level (`level: "not-checked"`), never the stored medium, with only the counts it has. (6) Stored evidence is read back through the member and signed-link report routes, and the attachment's download followed to the file with the signed link's access kept.
>
> **Corrected 2026-10-31 (the producer's final shape, D02 T07 §1 built at 680a1ecf):** (7) `artefacts` holds the part's key for a cut body part too (`raw/<case>/attachments/<sha>-body-<n>.html`, stored like an attachment by `src/intake/parse.ts`), so the card names the stored file ("In the stored file <name>") and offers its download without guessing whether it was an attachment or a cut part. (8) The coverage item is severity `info` with `{ checked: false, more, unread: { key, why }[] }`: each unread file is named with its reason in plain words (not stored, a character set not read, encrypted, too large, past the number of parts read), and a `more` of zero says nothing.
>
**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards
**Job:** a reader sees that a link says one place and goes to another
**Treatment:** the card frame of §3: what the link shows, where it goes, the full address, how and where it was found
**Chrome:** `EvidenceCard`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Draw the card and its not-checked variant. Done when: a fixture of each draws its words, and the registry test maps the check.

- [x] Name `link.text_mismatch` in `src/web/components/evidence/check-words.ts` and draw it in `src/web/components/evidence/cards.tsx`'s `link` family: "The link shows <shown> but goes to <target>", the full `href` as text that wraps, how it was found (`kind` in plain words: a link, a form's address, a frame, an image's link, a page refresh, an address written in the text, a link in a PDF) and where (`part`: the message, a part of it, or an attachment by name), and the attachment's download when there is one. Done when: `test/web/evidence-cards.test.ts` draws a fixture of each `kind`, an attachment's link with its download, and a hostile `href` and `shown` as text.
- [x] Draw `detail.checked === false` as "Links not fully checked" with the `more` and `unread` counts, and a missing or wrong-typed field without the bad value and without throwing. Done when: the test draws a `more`-only and an `unread`-only item each at the not-checked level with only its count and no mismatch words, and a malformed detail.
- [x] Read a stored mismatch back through the member's and the signed link's report (`test/web/report-access.test.ts`, the check registered in a test registry until D02 T07 §1 registers it) and follow its attachment's download to the stored file in both. Done when: each view draws the card and the download answers the file's bytes, the signed link's parameters carried.
- [x] Prove the card in Chromium beside the existing ones at 360 px and 1280 px, light and dark: no sideways scroll with a long `href`, the accessibility gate's rules clean, the download reached and opened by keyboard. Done when: `test/node/evidence-cards-browser.test.tsx` passes with the card drawn.
- [x] Commit: `web: link text mismatch card`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts test/node/evidence-cards-browser.test.tsx` passes with the card drawn.

> **Verified:** 2026-10-31 | §31 | 78e514c27f1065736cb8f335e1359cae39663006
> **Review:** `docs/reviews/d07-t03-s31.json`

## 32. Link coverage: damaged and further files

Filed 2026-10-31 at the checks lane's request (through the coordinator): D02 T07 §1 (4d4d0c0a) adds a reason to `Unread.why`, `"damaged"` (a PDF whose compressed object stream will not decompress), and to the coverage item's detail `unreadMore`, the count of unread files past the 20 it names. §31's card reads an unknown reason as "it could not be read" and does not count the rest, so it never breaks, but neither is said in its own words.

> **Started:** 2026-10-31T12:03:01Z
>
> **Corrected 2026-10-31:** Fact-checked against the producer (D02 T07 §1, 4d4d0c0a on origin/checks-lane): `unreadMore` is a number beside `unread` (the first 20), and `why` gains `"damaged"`. The not-checked coverage item also joins the shared fixture list the registry test reads (asked by the coordinator), so the card's every variant is drawn there.
>
> **Corrected 2026-10-31 (plan review):** One further file reads "and 1 more file or part was not read for links", more "and <n> more files or parts were not read for links". Only a positive whole count is drawn: a negative or fractional `unreadMore` says nothing (found by the test).
>
**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards
**Job:** a reader knows why a file was not read for links, and how many were not
**Treatment:** §31's not-checked variant, one more reason and one more line
**Chrome:** `EvidenceCard` (D07 T01 §7)

**Build order:**

1. Word the reason and count the rest. Done when: both are drawn.

- [x] Word `why: "damaged"` in `src/web/components/evidence/cards.tsx`'s `UNREAD` ("it is damaged, so it could not be read") and draw `unreadMore` as "and <n> more files or parts were not read for links" (nothing at zero or when missing). Done when: `test/web/evidence-cards.test.ts` draws a damaged file's reason, an `unreadMore` of 3 and of 1 with their lines, and none for 0, a missing value or a wrong type, and the coverage item (`checked: false`) is in the shared fixture list.
- [x] Commit: `web: link coverage, damaged and further files`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes with both drawn.

> **Verified:** 2026-10-31 | §32 | 26523d7a83114b1f0e44cd86e8e844b6de806671
> **Review:** `docs/reviews/d07-t03-s32.json`

## 33. Highlighted page for a forensic finding

Filed 2026-10-31 from §30's completion review (out-of-scope excellence item). A forensic card names the page and quotes the line, and the producer stores an overlay's image box (`detail.image`, `{ x0, y0, x1, y1 }`), but to see the evidence a reader downloads the PDF and finds the place by hand; a document forensics service shows the affected region beside its signal. Rendering the PDF's page is the trust lane's (D06), asked through the coordinator; this section draws it.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards and the full-size viewer (§8), a highlighted page added to the boards
**Job:** a reader sees where in the document the finding is, without leaving the report
**Treatment:** the finding's page shown in §8's viewer with its region outlined, its text equivalent beside it
**Chrome:** `EvidenceFigure`, §8's viewer (D07 T01 §7)

**Build order:**

1. Show the finding's page with its region outlined. Done when: one activation from a forensic card opens the page, outlined, with a text equivalent.

- [ ] Add a highlighted page to `design/SPEC.md` M3 and its board, then open it from a forensic card in §8's viewer: the page rendered by the producer (asked of the trust lane: a `page` artefact per finding), its region outlined from `detail.image` or the line's box, and the text it outlines beside it for screen readers. Done when: `test/web/evidence-cards.test.ts` finds the page's link and outline on an overlay and a font finding, and `test/node/evidence-cards-browser.test.tsx` opens it by keyboard, the outline in place and the text equivalent read.
- [ ] Commit: `web: highlighted page for a forensic finding`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts test/node/evidence-cards-browser.test.tsx` passes with the highlighted page opened.

## 34. Unreported method in Headers checked

> **Started:** 2026-10-31T15:44Z

Filed 2026-10-31 at the checks lane's request through the coordinator, from D01 T02 §11's completion review (`docs/reviews/01-intake/D01-T02-s11.md` on `checks-lane`, §11 built at `64166e86`). The reply's Headers checked panel (`headersWords`, `src/mail/templates/reply.ts`) takes `headers` with all three methods or nothing, so a receiver that reported SPF but not DKIM gets no panel at all and an SPF fail is hidden. The producer half (a method the receiver did not report, passed to `reply()`) is the checks lane's D01 section that depends on this one.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` N1 (board `Email-Reply`, the Headers checked panel)
**Job:** a member sees every authentication result the receiver reported, and which it did not
**Treatment:** each method named once, its result or "not reported by the receiving system", in both bodies
**Chrome:** the reply template (§7)

**Build order:**

1. Draw a per-method not-reported state in both bodies. Done when: a panel with one method unreported is drawn in HTML and plain text, the others' results kept.

- [x] Widen `ReplyDesign["headers"]` in `src/mail/templates/reply.ts` so each of `spf`, `dkim` and `dmarc` may be absent (not reported), and draw the panel whenever at least one method is reported. Done when: `test/mail/reply-design.test.ts` draws the panel for SPF fail with DKIM absent and names SPF's failure. Cheaper substitute: defaulting an absent method to `none`, which says the domain has no record when the receiver only said nothing.
- [x] Word an absent method in `headersWords` as not reported by the receiving system, in the HTML and in `buildReply`'s plain text (`src/mail/reply.ts`, asked of the checks lane if its lines change). **Corrected 2026-10-31:** the plain text already takes its sentence from the template's `headersWords` (`src/mail/reply.ts` `buildReply`), so its lines do not change and the checks lane is not asked; an object with no method reported draws no panel in either body (`headersWords` answers empty). Done when: both bodies carry the same sentence for each of the three methods absent in turn, and a test fails when either body drops it.
- [x] Draw the panel in `replyDesign` (`src/mail/templates/reply.ts`) only when `headersWords` has words, so an object with no method reported draws no "Headers checked." heading. Done when: `test/mail/reply-design.test.ts` sends `headers: {}` through `buildReply` and neither body carries the heading while the reply's other notes remain, and the test fails with the guard on the object alone. **Added 2026-10-31 (plan review P2).** **Corrected 2026-10-31 (build):** the test is this lane's `test/mail/reply-design.test.ts`, which drives `buildReply` too; `test/mail/reply.test.ts` is the checks lane's.
- [ ] Record the producer half: `replyHeaders` (`src/mail/reply.ts`, D01 T02 §11, the checks lane's) still withholds the whole panel when a method is unreported, so real replies change only when its D01 row passes the reported methods alone. Ask the checks lane (through the coordinator) for that row's ref, with its dependency on this section and a test sending stored partial authentication results through `reply()` into both bodies, and add a deferral line to this section naming it. Done when: the Deferred line's cross-reference resolves (`python3 scripts/todo-graph.py resolve` exits 0 or 4, not 1 or 2). **Added 2026-10-31 (plan review P1).**
- [ ] Commit: `mail: the reply names a method the receiver did not report`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply-design.test.ts test/mail/reply.test.ts` passes with a panel for each method unreported in turn.

## 35. DKIM none worded as unsigned

Filed 2026-10-31 at the checks lane's request through the coordinator, from D01 T02 §11's completion review (`docs/reviews/01-intake/D01-T02-s11.md` on `checks-lane`, §11 built at `64166e86`). `AUTH.none` reads "not set up" for every method, so DKIM=none says the domain has no DKIM, where RFC 8601 §2.7.1 means only that the message was not signed. SPF none means no SPF record was found to check (RFC 8601 §2.7.2) and DMARC none no DMARC policy published (RFC 7489 §11.2). Meanwhile the producer withholds the whole panel on DKIM none (checks lane, `d423d5cb`); its D01 row passes `none` again once this section lands.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` N1 (board `Email-Reply`, the Headers checked panel)
**Job:** a member reads what each result really means
**Treatment:** method-specific words for `none`, the rest unchanged
**Chrome:** the reply template (§7)

**Build order:**

1. Word `none` per method. Done when: DKIM none reads as not signed and SPF and DMARC none as no record published.

- [ ] Replace the single `AUTH` map in `src/mail/templates/reply.ts` with per-method words for `none` (DKIM: "the message was not signed"; SPF and DMARC: "no record published"), sourced from RFC 8601 §2.7.1 (DKIM) and §2.7.2 (SPF) and RFC 7489 §11.2 (DMARC). Done when: `test/mail/reply-design.test.ts` checks each method's `none` sentence in both bodies, and fails with the old shared wording. Cheaper substitute: one word for every method's `none`.
- [ ] Commit: `mail: the reply words DKIM none as an unsigned message`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply-design.test.ts` passes with each method's `none` worded.

## 36. Results attributed to the receiver

Filed 2026-10-31 at the checks lane's request through the coordinator, from D01 T02 §11's completion review (`docs/reviews/01-intake/D01-T02-s11.md` on `checks-lane`, §11 built at `64166e86`). The panel says "we could check who really sent it", which claims identity: the results are what the receiving system recorded, and SPF and DKIM pass with DMARC fail means the passes were for a domain other than the one in From (RFC 7489 §3.1, alignment). The member cannot tell that from three words.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` N1 (board `Email-Reply`, the Headers checked panel)
**Job:** a member understands what the results prove and what they do not
**Treatment:** the receiving system named as the source, the From domain and each pass's domain shown when they differ
**Chrome:** the reply template (§7)

**Build order:**

1. Attribute and explain. Done when: the panel names the receiving system's report as the source and explains a pass for another domain.

- [ ] Reword `headersWords` (`src/mail/templates/reply.ts`) to attribute the results to the receiving system ("The receiving system's checks recorded: ...") with no claim of who sent the message. Done when: `test/mail/reply-design.test.ts` finds the attribution in both bodies and no "who really sent it". Cheaper substitute: dropping the sentence, which leaves the results unexplained.
- [ ] Say when SPF or DKIM passed for a domain other than the From domain, from the domains the producer passes (an input extension of `reply()`: the From domain and each method's domain, asked of the checks lane; until it lands, the alignment sentence keys on DMARC fail alone). Done when: SPF and DKIM pass with DMARC fail draws the sentence naming both domains, and the test fails without it.
- [ ] Commit: `mail: the reply attributes authentication results to the receiving system`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply-design.test.ts` passes with SPF and DKIM pass and DMARC fail explained.

## 37. Early authentication view

Filed 2026-10-31 at the checks lane's request through the coordinator, from D01 T02 §11's completion review (`docs/reviews/01-intake/D01-T02-s11.md` on `checks-lane`, §11 built at `64166e86`). A member waits for the full investigation to see the authentication results, which are known within seconds of intake. Whether to show them early, on the report page or as a first reply, is a design decision across D07 and D04 (the agent's investigation) that the operator makes first.

**Phase:** 6
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (a new early state, added to the boards once decided)
**Job:** a member sees the authentication results while the investigation runs
**Treatment:** to be decided: the report page's in-progress state, a first reply, or neither
**Chrome:** the report page (§1), the reply template (§7)

**Build order:**

1. Record the decision, then draw the view it names. Done when: the operator's choice is recorded in `design/SPEC.md` and the view it names renders while a case is in progress.

- [ ] Ask the operator (through the coordinator): show authentication results before the verdict on the report page's in-progress state, as a first reply, or not at all; record the answer and its date in `design/SPEC.md` M3. Done when: the decision line is in the SPEC.
- [ ] Draw the decided view from the stored check outcomes (`check_outcomes`, D02 T01 §3) while the case is in progress. Done when: `test/web/report-status.test.ts` shows the results on an in-progress case and not before they are stored. Cheaper substitute: waiting for the verdict.
- [ ] Commit: `web: authentication results before the investigation ends`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts` passes with the early results drawn.

## 38. Transcribe step in the report progress

Filed 2026-10-31 at the checks lane's request through the coordinator, for D01 T03 §3 (Muse Voice Transcribe client with chunking), whose Deferred line names this section. A voice note is transcribed after `parse`, and the report's progress (`STEPS`, `src/web/pages/report-progress.ts`, §4) has no step for it, so its time shows under the next step and its failures as "A step failed on our side". The producer records the step as `transcribe` with the error classes `CorruptAudio`, `AudioTooLong` and `UnsupportedAudio`; damaged, overlong or unsupported audio is the member's to fix, not a failure on our side.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 running state (board `Report-Running`), a transcribe step in its list
**Job:** a member who forwarded a voice note sees it being transcribed, and what to do when it cannot be
**Treatment:** one more step in the board's plain words; the member's own fix for their recording, never an outage
**Chrome:** the report's progress list (§4)

**Build order:**

1. Name the step and its refusals. Done when: a voice case's progress lists the transcribe step after parse, in each state, and each audio refusal says what to do.

- [ ] Add `["transcribe", "Transcribed the voice note"]` to `STEPS` in `src/web/pages/report-progress.ts` after `parse`, drawn only on a case whose events record it, so a message without a voice note keeps its list. Done when: `test/web/report-status.test.ts` reduces `transcribe` started, error then started, and failed to running, retrying and failed after parse, and a case without the step lists none. Cheaper substitute: an always-drawn step that sits waiting on every email case.
- [ ] Word the three audio refusals in `errorWords` as the member's to fix: `CorruptAudio` (the recording is damaged: replace it and forward it again), `AudioTooLong` (shorten it to 30 minutes or less and forward it again) and `UnsupportedAudio` (send it as an Ogg, Opus, WAV or MP3 voice note), none saying "on our side". Done when: the test checks each sentence and that none matches the generic failure. Cheaper substitute: the generic "failed on our side", which blames the service for the member's file.
- [ ] Commit: `web: the report's progress shows the voice note's transcription`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts` passes with the transcribe step in each state and each audio refusal worded.

## 39. Check versions in the report

Filed 2026-10-31 at the checks lane's request through the coordinator, for D02 T01 §4 (check implementation revision). Each check outcome now stores the Worker version that ran it (`check_outcomes.revision`, migration 0053; `readCheckOutcomes` returns `revision` when one is stored), so a reader can tell which version produced a finding, and which run, after a retry (§20).

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the count line and the checks list, §18), a check's version added to the boards
**Job:** a reader sees which version of each check ran, for the run they are looking at, in one interaction
**Treatment:** a disclosure on the count line listing each check with its version, quiet by default
**Chrome:** the report's evidence section (§3), the count line (§18)

**Build order:**

1. Show each check's version for the run shown. Done when: one activation from the count line lists each check with its version, or "version not recorded".

- [ ] Add a "Check versions" disclosure to the count line in `src/web/pages/report-live.tsx` (a native `details`, keyboard-reachable), listing each stored outcome of the run shown with its `revision`, and "version not recorded" for an outcome stored before migration 0053 (`revision` absent). Done when: `test/web/report-status.test.ts` lists a revision and the not-recorded words for an older row, and `test/node/report-browser.test.tsx` opens it by keyboard. Cheaper substitute: one version for the whole report, which hides a check run by an older Worker.
- [ ] Show the selected run's versions once a case has more than one run (§20's retry): the list follows the run the report shows. Done when: a retried case lists the newer run's revisions and the test fails when it lists the first run's. Cheaper substitute: the latest run always, whatever is shown.
- [ ] Commit: `web: the report lists each check's version`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts test/node/report-browser.test.tsx` passes with a revision, a not-recorded row and a retried run.

## Verification

- Fixture cases in every state render to the SPEC with working evidence cards, model trace and feedback, at phone and desktop widths, with no accessibility violations.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
