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
- -> XREF: D07 T09 §7 -- the walkthrough refusal and reuse cards filed from D04 T02 §6, moved there at the 2026-11-02 gate merge when this file reached 55 sections
- -> XREF: D07 T01 §3 -- the app shell and public frame the report sits in; the report's own phone back link to Cases is §1's
- -> XREF: D07 T01 §7 -- `EvidenceFigure`, the preview §8's full-size viewer opens from
- -> XREF: D02 T03 §12 -- the lookalike clean summary naming the domains compared, filed by §44's completion review
- -> XREF: D01 T01 §16 -- the original's subject and sender stored on the case, which the header draws
- -> XREF: D04 T01 §2 -- `case_verdicts.reasons` as `{ text, evidenceIds }[]` (each id an evidence item of the case; old `string[]` rows read as `{ text, evidenceIds: [] }`) and `VerdictView.meaning`, the banner's one sentence (old rows null), which §2's banner draws (cross-lane contract agreed 2026-10-31)
- -> XREF: D04 T01 §5 -- the citation check that refuses a reason with no `evidenceIds` or an id not on the case, so every reason the banner shows has its evidence card
- -> XREF: D02 T01 §3 -- `readCheckOutcomes(db, caseId)`, one `{ check, outcome, reason, findings }` per check in registration order (null for a case checked before it), which §18's count line and "Checks that found nothing" read (cross-lane contract agreed 2026-10-31)
- -> XREF: D01 T01 §17 -- `retryCase(db, env, orgId, caseId, memberId)` (src/pipeline/retry.ts), its typed refusals and the new `run_id` a retried case's progress is read by, which §20's button calls (cross-lane contract agreed 2026-10-31)
- -> XREF: D06 T02 §3 -- the document forensics checks (document.forensics.revisions, producer, dates, fonts, overlay) whose cards §30 draws
- -> XREF: D02 T07 §1 -- the `link.text_mismatch` check whose card §31 draws
- -> XREF: D07 T09 §1, §2 -- the early card's follow-ups (results stored before the slow checks, kinds of authentication error), filed from §37's completion review

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
| 5 | §5 | Model trace panel | §2, D03 T01 §3 | [x] |
| 6 | §6 | This-was-wrong feedback | §2 | [x] |
| 7 | §7 | Reply email matched to the report design | §2, D01 T02 §3 | [x] |
| 8 | §8 | Full-size evidence viewer | §3 | [x] |
| 9 | §9 | Report header | §1, D01 T01 §16 | [x] |
| 10 | §10 | Stored verdict sentence, reasons | §2, D04 T01 §2 | [x] |
| 11 | §11 | Follow-up question from | §2 | [ ] |
| 12 | §12 | Reputation cards | §3, D02 T06 §4 | [x] |
| 13 | §13 | Link and walkthrough cards | §3, D02 T07 §3, D04 T02 §5 | [x] |
| 14 | §14 | Vision and brand cards | §3, D03 T02 §3, D03 T02 §4, D03 T03 §3 | [x] |
| 15 | §15 | Invoice and document cards | §3, D06 T01 §1, D06 T02 §2 | [x] |
| 16 | §16 | Voice cards | §3, D01 T03 §4 | [x] |
| 17 | §17 | Trust and verification cards | §3, D05 T02 §3, D05 T03 §2 | [ ] |
| 18 | §18 | Check count and clean checks | §3, D02 T01 §3 | [x] |
| 19 | §19 | Original message preview | §3 | [x] |
| 20 | §20 | Retry a failed check | §4, D01 T01 §17 | [x] |
| 21 | §21 | Withdraw feedback | §6 | [x] |
| 22 | §22 | One-press dispute | §6 | [x] |
| 23 | §23 | Feedback outcome to the member | §6, D07 T08 §5 | [ ] |
| 24 | §24 | Invisible-character cards | §3 | [x] |
| 25 | §25 | Reply checked in mail clients | §7 | [ ] |
| 26 | §26 | Feedback from a signed link | §6 | [x] |
| 27 | §27 | Reply and report in your language | §7 | [ ] |
| 28 | §28 | Uploaded file's name in the header | §9 | [x] |
| 29 | §29 | Hidden instruction past the opening | §24, D02 T05 §6 | [x] |
| 30 | §30 | Document forensics cards | §3 | [x] |
| 31 | §31 | Link text mismatch card | §3 | [x] |
| 32 | §32 | Link coverage: damaged and further files | §31 | [x] |
| 33 | §33 | Highlighted page for a forensic finding | §8, §30 | [ ] |
| 34 | §34 | Unreported method in Headers checked | §7 | [x] |
| 35 | §35 | DKIM none worded as unsigned | §7 | [x] |
| 36 | §36 | Results attributed to the receiver | §7 | [x] |
| 37 | §37 | Early authentication view | §3, §7 | [x] |
| 38 | §38 | Transcribe step in the report progress | §4 | [x] |
| 39 | §39 | Check versions in the report | §18, §20, D02 T01 §4 | [x] |
| 40 | §40 | Recovery words for a file that never arrived | §4 | [x] |
| 41 | §41 | Upload page usage after a failed upload | D01 T03 §6, D01 T03 §12 | [x] |
| 42 | §42 | Uploader named alike in list and header | §9 | [x] |
| 43 | §43 | Attribution on a phone's report | §9, §42 | [x] |
| 44 | §44 | Clean checks with their result summary | §18, D02 T01 §7 | [x] |
| 45 | §45 | Unverified receiving chain on the auth card | §3, D02 T02 §6 | [x] |
| 46 | §46 | Subject locations on evidence cards | §3, D02 T05 §5 | [x] |
| 47 | §47 | Previous attempt of a | §20 | [ ] |
| 48 | §48 | A real failed admission through the report | §40, D01 T03 §12 | [x] |
| 49 | §49 | A real voice note through the report | §38, D01 T03 §3 | [x] |
| 50 | §50 | Mail refusal reason in the trace | §5 | [ ] |
| 51 | §51 | Walkthrough action to its | §5 | [ ] |
| 52 | §52 | Report address from a | §48, D01 T03 §6 | [ ] |
| 53 | §53 | One-action copy of headers | §19, §54 | [ ] |
| 54 | §54 | All stored headers read in place | §19 | [ ] |
| 55 | §55 | A deadline on the full-size viewer's request | §8 | [x] |

> **Moved at the gate merge (coordinator, 2026-11-02):** the section filed from D04 T02 §6's completion review as §53 of this file (walkthrough refusal and reuse cards) is now D07 T09 §7, because this file reached its 55-section cap when both lanes filed into it. The `- Filed: D07 T03 §53` lines in `docs/reviews/04-agent/D04-T02-s6.md` name its first address; its permanent address is D07 T09 §7.

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
> **Deferred:** the ledger links in the actions ("Open <supplier> in the ledger", the Safe board's "supplier ledger") -> XREF: D06 T01 §6
>
> **Resolved:** the stored one-sentence meaning -> XREF: D07 T03 §10. Resolved 2026-11-03 by D07 T03 §10: the band and both reply bodies draw the stored `meaning`, the fixed sentence only when none is stored.

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
> **Resolved:** the count line and "Checks that found nothing" -> XREF: D07 T03 §18. Resolved 2026-10-31 by D07 T03 §18 in `9b78b978`, `b8e54db3` and `beb13e08`: the count line under Evidence and the safe verdict's clean list, drawn from the stored check outcomes inside the polled live region with the coverage notice on every terminal report; the board's per-check result words are deferred on to D07 T03 §44.

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
> **Resolved:** "Retry the check" on the failed state -> XREF: D07 T03 §20. Resolved 2026-10-31 by D07 T03 §20 in `54c29bf2` and `9ca658dd`: a member re-runs a failed check once from the failed report (`POST /r/:caseId/retry` calling `retryCase`), the page then following the new run; the previous attempt is deferred on to D07 T03 §47.

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

> **Started:** 2026-10-31T22:57Z

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

- [x] Read the trace in `src/db/model-trace.ts` (`readModelTrace(db, caseId)`, for a case the caller has already read in its organisation): the case's `model_spend` rows in the order they were made (`at`), each with its step, model, `ms`, attempt, outcome and error class, `cache = 'hit'`, and its cost (`actual_usd` once settled, else `estimate_usd`, with `cost_certainty` saying which); plus the totals from the same rows (time, measured cost and estimated cost apart, as `caseCost` in `src/meta/budget.ts` keeps them, an estimate never added into the measured). **Corrected 2026-10-31 (at start):** the contract named `case_events` for the rows (stale since 2026-10-29) and `src/web/components/model-trace.tsx` for the reader; the reader is its own module and the component is pure. The reader is pinned to the run the report shows (the same run id the report captured for its evidence): `model_spend` and `walkthrough_actions` carry no run id, so a run's rows are those made between that run's own `retry` start in `case_events` and the next retry's start (the first run, from the beginning), and its mail is the send under that run's key (`reply:<run id>`, as `readReplySend`); the totals are that run's, not the case's lifetime. **Planned 2026-10-31 (plan review P2):** reading by case id alone would mix a failed attempt into the retried report; the earlier attempts stay §47's. Done when: `test/web/model-trace.test.ts` stores five model calls (one cached, one failed, one estimated) and reads five rows in order with the totals; a failed first run followed by a retry reads each run's own rows, walks (sequence numbers restarting at 1 in each walk) and sends under its own run id, with lifetime totals nowhere; and a case with none reads an empty trace.
- [x] Render it in `src/web/components/model-trace.tsx` as the board's table (`Main`, `Report-Safe`: "How Meta's models worked on this case", the total time and cost, then Step, Model, What it did, Time, Cost): the model name in full, the step in plain words (a map for the recorded steps, the recorded name otherwise), time in seconds, cost as the board draws it (`US$0.005`, the totals measured and estimated apart with an "estimated" mark), "cached" for a hit, and a failed call said as failed with its error class in words. **Corrected 2026-10-31 (at start):** the board draws US dollars to three places, not the cents the Treatment named; the approved board wins. "What it did" is derived, never typed: for the verdict step from the stored verdict and evidence ("Weighed 3 findings", with ", cited E1, E2, E3" once a stored verdict carries the evidence ids it cites: **Corrected 2026-10-31 (build):** a stored verdict keeps its reasons as text, so the ids are not stored yet and the panel says only how many findings were weighed), for the walkthrough from its stored actions ("Walked the link: 6 actions"), and for every other step the step's plain words alone; a result that is not stored (no verdict, no walk) says "Result not stored" and never a generic claim. **Planned 2026-10-31 (plan review P1):** `model_spend` holds accounting, not what the model concluded. An empty trace reads "No model was used for this case" (a case can fail before any call); a `refused` call reads refused with its reason words; a call with no recorded time or outcome (an interrupted settlement) reads "not recorded" and is never a measured zero or a success; an unsettled call's cost is marked estimated. Done when: the test renders each row and the totals from the stored calls and finds a cached row, a failed row, a refused row, an incomplete row and an estimated cost each marked, two different verdicts producing two different descriptions with their own cited ids, a case with no verdict and no walk reading "Result not stored", the empty trace reading its words, and a hostile model or step name drawn as text; the same through `/r/:caseId`.
- [x] Show the agent's tool calls in order under its step, read from `walkthrough_actions` (D04 T02 §3: one row per attempted action in a walk, in order within the walk, typed text never stored): each action's kind and outcome in words, never `action_json` raw. **Corrected 2026-10-31 (at start):** the agent's tool calls are the walkthrough's audited actions; `model_spend` records the model call, not the tools. Done when: the test shows a walk of two actions in order, a refused one said refused, and no typed text.
- [x] Draw it on the report for a member only, inside `ReportLive`'s finished and failed branches after the evidence (`src/web/pages/report-live.tsx`), collapsed by default in a native `details` named "How Meta's models worked on this case" and open when the address has `?trace=1` (used in the demo); a link holder, who sees what the organisation shares, sees none. The trace is read only when the report is not running, so the status poll's last answer carries it and a report opened while running receives its trace when it finishes, with no navigation (the poll replaces `#report-live` once, and a collapsed panel has no state to lose). **Planned 2026-10-31 (plan review P1):** an earlier plan left the panel outside the polled region, so a watched report would never receive it. Done when: `test/web/model-trace.test.ts` finds the panel collapsed for a member, open with `?trace=1`, absent for a signed-link reader and absent from a running report's poll, then present in the poll that finishes it, for a finished and for a partly-checked report, through both `/r/:caseId` and `/r/:caseId/status`; and `test/node/report-status-browser.test.tsx` opens a running report and finds the completed trace after the finishing poll without navigation.
- [x] List the case's mail in the panel from `mail_sends` (D01 T02 §1): each send's kind, status in words (sent, failed, may have been sent, refused, waiting), attempts, the last reason and when, never an address, read through the case's own organisation scope; a case with no mail says so. Done when: `test/web/model-trace.test.ts` renders a case with a sent reply, an uncertain one and a failed one, and one with none, and finds no address in any of them. (**Added 2026-10-27**, D01 T02 §1's completion review: the file's Adjacency promises sends in the trace, but the panel read only the model calls.)
- [x] Check the panel in the browser in `test/node/report-verdict-browser.test.tsx`'s matrix: starting collapsed, the summary reached by keyboard with a visible focus and the name "How Meta's models worked on this case", opened and closed by Enter, then open at 360 and 1280 px in both themes with a long unbroken model name and the totals, passing the accessibility gate's rules with no sideways scroll, as a table a screen reader reads by its headers. **Planned 2026-10-31 (plan review P2):** an open-only check can pass when the collapsed panel cannot be opened by keyboard. Done when: the variant is in the matrix and fails with the summary's name removed or the long name's wrapping removed.
- [x] Commit: `web: model trace panel`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/model-trace.test.ts` and `pnpm exec vitest run test/node/report-verdict-browser.test.tsx` pass, and the first fails if a row is not backed by a stored `model_spend` row. **Corrected 2026-10-31 (at start):** the rows are `model_spend`'s, not `case_events`'.

> **Verified:** 2026-11-01 | §5 | 4d6aea71e70088f14bbbe014c5c89d12841d8787
> **Review:** `docs/reviews/d07-t03-s5.json`

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
> **Resolved:** the headers panel's timing and models -> XREF: D07 T03 §5. Resolved 2026-10-31 by D07 T03 §5 in `4c30774d`, `c6240e88`, `120429b9` and `4d6aea71`: each model call's model and time, with the totals, are in the report's model trace panel (a member's, collapsed, open with `?trace=1`); the reply email carries no such panel and links to the report.
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

> **Started:** 2026-11-01T09:45Z

A figure on an evidence card is a 152 px preview with its overflow hidden (D07 T01 §7's `EvidenceFigure`), so a screenshot scaled into it can hide the small domain or form field the finding rests on. The reader opens the full-resolution capture with one activation, reads it, and returns to the same card; an artefact that is gone says so instead of opening nothing. Filed from D07 T01 §7's completion review (out-of-scope gap, 2026-10-27), which compared it with Microsoft Defender for Office 365's email entity page, where a captured screenshot opens from the finding.

**Phase:** 2
**Needs:** none
**Surface:** yes

**Operator decision (2026-11-01 03:30 SAST, recorded in docs/coordinator.md):** built now, with a board and its `design/SPEC.md` entry for the operator's approval first. `owner-decision` is dropped; `operator` stays only as the approval of the board. **Board proposed 2026-11-01:** Report-EvidenceViewer and Report-EvidenceViewer-Mobile, drawn in `design/mockups/proposed/` (outside the approved inventory, which `check-design.py` and `tests/scripts/test_design_spec.py` hold complete) with its SPEC entry and coverage written in that folder's README to apply on approval; nothing is built until the operator approves the viewer (the approval line is recorded in this section, and the board moves into `design/mockups/source/` and `approved.json` as that README says).

**Operator approval (2026-11-01 11:35 SAST, the operator asked directly, recorded in `docs/coordinator.md` on `coordinator-gate`):** the board is approved as drawn; it is imported into `design/mockups/source/` with its PNG, `approved.json` and `coverage.json` entries and the `design/SPEC.md` M3 lines (`python3 design/tools/check-design.py` passes). `operator` is removed from Needs.

Viewer approved: 2026-11-01 (Report-EvidenceViewer, Report-EvidenceViewer-Mobile)
**Fidelity:** `design/SPEC.md` M3 (the viewer, once drawn), a new board `Report-EvidenceViewer` (desktop and `Report-Mobile` width), the preview from board `Main` E7
**Job:** a sceptical reader checks the proof at full size without losing their place in the report
**Treatment:** the approved preview layout unchanged; the full capture at its natural size, scrollable, on the page's own surface; tokens only; the capture's alt text names what it shows
**Chrome:** `EvidenceFigure` (D07 T01 §7), the native `<dialog>` with the shared `Button` (D07 T01 §6) to close it

**Owner decision (open):** the viewer's design (an in-page dialog over the report, or the capture opened in place of the page with a back link) is drawn as a board and approved by the operator first, since it is a new surface (design/SPEC.md: a change to the approved look goes back to the operator). Recording `Viewer approved: YYYY-MM-DD (<board>)` here and removing `operator` from Needs releases the section.

**Operator decision (2026-10-28 22:42 SAST):** the viewer is an in-page dialog over the report: activating a preview opens the full-resolution capture in the native `<dialog>`, scrollable, closed by Escape or the Close button, focus returning to the same card. The `Report-EvidenceViewer` board is drawn in that direction and approved before the build; `operator` stays in Needs until `Viewer approved: YYYY-MM-DD (Report-EvidenceViewer)` is recorded here.

**Corrected 2026-11-01** (after §13 built the screenshot figures and their failure handling, and the board was approved): the viewer is built in the shared app script from the link's own attributes, not as a server-rendered `EvidenceViewer.tsx`, so no per-figure storage read is added to the report; "gone" is read from the artefact route's own 410 (`artefactGone`) rather than a render-time `readArtefact`; the dialog's size comes from the loaded image because the stored finding holds neither the screenshot's number among the walk's captures nor when it was taken (recorded as a SPEC deviation); the first item's `full` prop is `open`, wrapping the preview in a link. The checklist below replaces the earlier items 2 to 5.

**Corrected 2026-11-01 (plan review `docs/reviews/07-app/D07-T03-s8.md`):** (a) a 410 from the artefact route means two things (a retained file gone, and a signed report link that expired), so the route marks its answers with `x-artefact-state` (`gone` from `artefactGone`, `link-expired` from the expired-link 410, `unavailable` from `artefactFailed`) and the app script reads that header, never the status alone: gone says "no longer stored", link-expired says the report link has expired and to ask for a new one, each with nothing to open; (b) the dialog has its own loading, gone, link-expired, temporary-failure and retry states with announcements, and Close always works; (c) recovery controls sit beside the opener link (inside the figure's frame, not inside the link), and a retry press never opens the dialog; (d) the download link is proven for both member and signed-link access (attachment disposition, the capture's bytes); (e) accessible names, alt text, Space activation, arrow-key scrolling and contrast in both themes are asserted.

**Build order:**

1. Draw and approve the viewer. Done when: the board and the SPEC entry exist and the approval line is recorded.
2. Open the capture from its preview and come back. Done when: one activation opens the full-resolution capture and closing returns focus to the same figure.
3. Show a missing or failed capture honestly. Done when: an expired capture says so and offers nothing to open.

- [x] Draw `design/mockups/source/Report-EvidenceViewer.dc.html` (desktop and 360 px) with its PNG export, and add the viewer to `design/SPEC.md` M3 (what opens it, the close control, the unavailable and retry states). Done when: the board and the SPEC entry are committed and the operator's `Viewer approved:` line is recorded here. Cheaper substitute: opening the raw file in a new tab with no way back to the card.
- [x] Give `EvidenceFigure` in `src/web/components/Evidence.tsx` an optional `open` (`{ href, download, id }`: the capture's inline artefact URL from §13's `Shot`, its download URL and the card's id) that wraps the preview in one link named "Open the screenshot at full size: <caption>" with the visible words "Open at full size", keeping the preview's look; without `open` the figure is as before. Done when: `test/node/verdict.test.tsx` renders a figure with and without `open` and finds the link's name, target and `data-evidence-open` marker only when it is given, and `Shot` in `src/web/components/evidence/cards.tsx` passes it for the link and walkthrough screenshots (`test/web/evidence-cards.test.ts`). Cheaper substitute: a click handler on a `div`, which the keyboard cannot reach.
- [x] Build the viewer in the shared app script (`src/web/client/app.ts`, which §13's image handling already lives in): activating a `[data-evidence-open]` link (click, Enter, Space; the link gets `role="button"`) opens a native modal `<dialog>` over the report, headed by the card's id and the caption, with the image's own `W × H px` read from the loaded image and, on a phone, "scrolls both ways", a scrollable focusable region holding the capture at its natural size, the footer line and a "Download the screenshot (PNG)" link, a Close button and Escape; the page behind is inert and does not scroll; focus returns to the link that opened it. Without the script the control stays a plain link that opens the capture. Done when: `test/node/evidence-viewer-browser.test.tsx` opens it with Enter in Chromium, finds the image at its natural width in a region that scrolls, closes it with Close and with Escape and finds focus back on the same link, in both themes, and a link activated with the script held back still navigates to the capture. Cheaper substitute: a scaled image no larger than the preview.
- [x] Mark the artefact route's answers: `artefactGone` sends `x-artefact-state: gone`, the expired-link 410 sends `x-artefact-state: link-expired` and `artefactFailed` sends `unavailable`, in `src/web/pages/artefacts.tsx` and `src/web/pages/errors.tsx`. Done when: a route test reads each header from the real responses (a missing file for a member, an expired signed link, a failed read) and a link holder's download of a stored capture answers with attachment disposition and the capture's bytes, for a member and for a signed link. Cheaper substitute: reading the status alone, which conflates an expired link with a deleted file.
- [x] Say a capture that is gone honestly: when a preview's image fails, the app script asks the same address once; an answer marked `gone` (past its 30 days or missing) replaces the preview with "This screenshot is no longer stored" and "Kept for 30 days. The finding above still stands." and nothing to open, an answer marked `link-expired` says "This report link has expired. Ask for a new one." with nothing to open and no Try again, and any other failure keeps §13's "could not be loaded" with Try again, its recovery controls beside the opener link and never opening the dialog. Done when: the browser test renders each with stubbed marked answers (410 gone, 410 link-expired, 503, a rejected network request), pressing Try again by keyboard through repeated failure and recovery without moving focus from a reader who tabbed elsewhere, and neither offers a control that opens nothing, the 410 state offers no Try again, and a 503 retry that then succeeds shows the preview and its open link again. Cheaper substitute: a broken-image icon.
- [x] Give the dialog its own states: while the full-size image loads it says so (announced), a delayed answer keeps Close usable, and a gone, link-expired, 503 or rejected request shows the same words as the preview with Try again only for the temporary kinds; a successful retry announces completion. Done when: the browser test opens the dialog on a preview that loaded and then answers the viewer's request delayed, gone, link-expired, 503 and network-rejected, retrying successfully, with Close working in every state.
- [x] Assert the viewer's accessibility: the dialog and its scroll region have names, the image keeps its alt text (the caption), Space and Enter open it, arrow keys change the scroll position, and the text and Close have 4.5:1 or more in both themes. Done when: the browser test asserts each against the approved boards and the axe rules pass in both themes.
- [x] Prove the viewer at 360 px: the capture scrolls in both directions inside the frame, Close stays in view, and the page behind does not scroll. Done when: the browser test measures all three at 360 px, and a keyboard reader tabs from Close to the scroll region to the download link and back without leaving the dialog.
- [x] Record the viewer's two departures from the board in `design/SPEC.md` M3 as a `Deviation (D07 T03 §8)` bullet: the dialog's line shows the capture's own size, not "Screenshot N of M" or "taken T s into the walk" (the stored finding holds neither), and the footer line is the board's. Done when: the bullet is in the SPEC and `python3 design/tools/check-design.py` passes.
- [x] Commit: `web: full-size evidence viewer`

**Test checkpoint:** `pnpm exec vitest run test/node/verdict.test.tsx test/web/evidence-cards.test.ts` and `pnpm exec vitest run --project browser test/node/evidence-viewer-browser.test.tsx` pass, the browser test failing when the viewer leaves focus anywhere but the link that opened it.

> **Verified:** 2026-11-01 | §8 | 489251249a9e1e6f68b59c6fd6f985765beabc99
> **Review:** `docs/reviews/d07-t03-s8.json`

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

> **Started:** 2026-11-03T02:19:37Z

The verdict banner's third line is one sentence on what the verdict means for this message (`design/SPEC.md` M3, board `Main`: "The link leads to a lookalike login page that sends your password to someone else. Do not use it."). Filed 2026-10-31 from §2's validation: the stored verdict holds a headline but no such sentence, so §2 draws a fixed sentence per verdict until the verdict carries one (asked of the checks lane through the coordinator for D04 T01 §2's VerdictView change).

> **Corrected 2026-11-03 (plan review):** The prerequisite has shipped: migration `0069_verdict_meaning.sql` and `src/db/verdicts.ts` already store and read `meaning` and structured reasons, so no reader is waited on; the remaining work is consumer rendering and its coverage. The band's "wraps" proof belongs in a browser test (serialized HTML cannot prove layout), the route proof carries the distinctive sentence as well as its reasons, and the reply's hostile stored sentence needs an escaping proof in both bodies: `meaningWords` supplies the plain text, `replyDesign` draws the HTML band independently.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (verdict banner), boards `Main`, `Report-Safe`, `Report-Invoice`, `Report-Voice`
**Job:** a member reads, in one sentence, what this message would do to them
**Treatment:** the stored sentence in the band, the fixed one only for a verdict stored before it existed
**Chrome:** `VerdictBand` (D07 T01 §7)

**Build order:**

1. Draw the stored sentence. Done when: a verdict with its sentence draws it and an older one draws the fixed sentence.

- [x] Draw the verdict's stored meaning sentence as the band's sentence in `src/web/pages/report-verdict.tsx`, and the fixed per-verdict sentence (§2) only when the stored verdict has none. Done when: `test/web/report-verdict.test.ts` draws a stored sentence, an older verdict draws its fixed one, and a hostile sentence (markup, 300 characters) renders as text; its wrapping is proven in the browser item below.
- [x] Read a stored structured reason back through the report route (the checks lane's reader returns `{ text, evidenceIds }`, D04 T01 §2, shipped): the route test stores a structured verdict and finds its pills and its distinctive stored sentence. Done when: `test/web/report-verdict.test.ts` reads one back through the route. **Added 2026-10-31** (D07 T03 §2's plan review).
- [x] Draw the stored sentence in the reply too: `meaningWords` in `src/mail/templates/reply.ts` uses the stored `meaning` for the plain-text body, `replyDesign`'s HTML band uses it too, and the fixed per-verdict sentence only when it is null. Done when: `test/mail/reply-design.test.ts` draws a distinctive stored sentence in both bodies, a null one draws the fixed sentence, and hostile stored markup stays literal in the plain text and escaped text with no injected element in the HTML. Source: D04 T01 §2's completion review, 2026-11-01.
- [x] Prove the long stored sentence in a browser: `test/node/report-verdict-browser.test.tsx` draws a 300-character stored sentence in the band at phone and desktop widths, fully visible with no sideways scroll. Done when: the test passes at both widths. Cheaper substitute: asserting on serialized HTML, which cannot prove the sentence wraps.
- [x] Commit: `web: the verdict banner draws its stored sentence`

**Test checkpoint:** `pnpm exec vitest run test/web/report-verdict.test.ts test/mail/reply-design.test.ts test/node/report-verdict-browser.test.tsx` passes with the stored sentence drawn in the band and the reply.

> **Verified:** 2026-11-03 | §10 | 513ba4477c691fd7030fb791d5c90aacfa580ebc
> **Review:** `docs/reviews/d07-t03-s10.json`


## 11. Follow-up question from

A reader whose situation the fixed advice does not cover ("I already paid; what now?", "I typed my password") asks one follow-up question on the report and gets guidance for that case, its verdict and evidence kept as context. General assistants answer follow-ups (D07 T03 §2's completion review, E2); the report today ends at its list. Filed 2026-10-31 from §2's completion review. It changes the approved report surface, so the operator approves a board for it first.

**Phase:** 7
**Operator decision 2026-11-02:** Approve the follow-up question box on M3 as designed (empty, asking, answered and refused states, one question per case).

**Needs:** none

**Deferred 2026-11-01:** Operator decision, 2026-11-01 03:30 SAST (held sections decided, recorded in docs/coordinator.md): defer until after the competition; the section stays open, `Needs` unchanged, and the lane builds nothing for it now.
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

> **Started:** 2026-11-01T17:40Z

A reputation finding shows the provider, what was listed, when, and the delisting or review link (spec 4.3a, M3 "listed in error? request a review"). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

> **Corrected 2026-11-01 (validation before build):** Producer shapes confirmed with the checks lane (`checks-outbox.md` 17:55, D02 T06 §4 built at `08e1b472`): `reputation.listing` (provider, `listed` exact, `delist_url`, `granularity`, `corroborated` (other evidence agrees with the listing, from an authentication failure, a lookalike or a credential form, never a second provider's word), `cap` "suspicious"; a listing is drawn at high severity only when corroborated, never as a verdict on its own, spec 4.3a; an overflow item carries `more` and `entries` of `{provider, listed, delist_url}`), `reputation.counter_signal` (info; provider one of majestic-million, domain-age, dmarc-aligned, trust-network; `domain`), and `reputation.coverage` (info; `checked: false`, `gaps`). No shape carries a date, so the card shows no "when" rather than inventing one. A counter signal is evidence against suspicion, so its card says what speaks for the sender; a coverage card says what was not checked and why, never "not listed".

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, board `Main`
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

> **Corrected 2026-11-03 (plan review):** The vision items are pipeline evidence, not registered checks, so the registry assertions cannot prove this family: the wiring (wording, family, dispatch) and a fixture per producer name are named as their own steps. The brand finding is `vision.brand_domain_mismatch` (no `brand.*` check exists). The logo item stores only the crop, not which reference variant was compared, so the card draws the brand's current reference beside the crop, labelled as the reference, with the stored differences carrying the comparison; the exact compared variant is the producer's to record (asked of the coordinator for the vision lane). Every operational variant is drawn in plain words: a check that could not run (`checked: false`, coverage losses, a not-checked reason) never reads as a successful comparison. Hostile detail (brand, sender, quotes, differences, domains) renders as escaped text, and a stored `source_url` is never drawn as a link. Images come through the artefact route's inline mode with the link holder's signature parameters kept, in the full-size viewer, with the app script's failure and retry state.

**Build order:**

1. Add the family's renderer. Done when: a fixture of each of its checks draws its card.

- [x] Draw `reputation` cards in `src/web/components/evidence/` with the provider, what was listed, when, and the delisting link (spec 4.3a). Done when: `test/web/evidence-cards.test.ts` draws a fixture of each of the family's registered checks through its renderer, the registry test passes with the family mapped, and the listing fixture shows all four.
- [x] Name the family in `src/web/components/evidence/check-words.ts` (`reputation.listing`, `reputation.counter_signal`, `reputation.coverage` in plain words) and map it in `FAMILIES`/`RENDERERS` (`src/web/components/evidence/cards.tsx`). Done when: `test/web/evidence-cards.test.ts`'s registry test names the three checks with a renderer each. Cheaper substitute: leaving them to the plain card, which shows no provider or review link.
- [x] Draw each listing card in `src/web/components/evidence/cards.tsx`: provider, the exact thing listed, the granularity in words, whether another provider agreed, the listed date when the provider stored one (`detail.listed_at`, spec 4.3a "if the provider says so"; no date is drawn when none is stored, and the lookup time is never substituted), and the review link ("Request a review", only for an http(s) address, a stored address that is not one drawn as text); an overflow item lists each entry the same way with the count of the rest. Done when: the test draws a corroborated and an uncorroborated listing, one with a stored date and one without, an overflow item, and a hostile stored address as text, never markup. Cheaper substitute: the summary alone, which hides the provider a reader would ask for a review.
- [x] Draw the counter-signal and coverage cards: a counter signal names its provider in words (a well-known domain list, the domain's age, an aligned DMARC record, the trust network) and the domain it speaks for, each variant's sentence saying what supports the sender; a coverage card lists each gap it stored. Done when: the test draws all four counter-signal providers with their supporting words and the coverage card never reads "not listed". Cheaper substitute: one generic card for both, which presents what speaks for a sender as a finding against them.
- [x] Prove the cards in a browser and through the report: `test/node/evidence-cards-browser.test.tsx` activates the review link by keyboard at 360 px in both themes with its `href` the stored provider address, a long listed address wrapping, axe clean; and `test/web/report-access.test.ts` reads producer-shaped listing and counter-signal evidence back through `/r/:caseId` for a member and a signed link with the provider, listed subject, date and review address exact. Done when: both suites pass with the review address removed failing them. **Added 2026-11-01 (plan review P2).**
- [x] Commit: `web: reputation cards`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts test/web/report-access.test.ts` and `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` pass with the family's checks drawn.

> **Verified:** 2026-11-02 | §12 | cf7e7528ca247649de5faa48be3e4ee9ab43da8b
> **Review:** `docs/reviews/d07-t03-s12.json`

## 13. Link and walkthrough cards

> **Started:** 2026-11-01T05:15Z

A link finding shows its chain and landing screenshot, and a walkthrough shows each page it walked with the credential target (M3, board `Main` E7). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

**Corrected 2026-11-01** (at start, checked against the repository): (1) the link family's cards exist as interim cards since D02 T07 §2 and §3 (`followed` and `landing` in `src/web/components/evidence/cards.tsx`: the chain, the changed site, the form, the lure, the screenshot as a file); this section completes them with the screenshot drawn as an `EvidenceFigure` beside the finding it belongs to (a missing one says why, as today), and a QR code's decoded link is D02 T07 §4's to store (its card words are added with it, not here); (2) the walkthrough family is new: the walk's evidence is written by `recordWalk` (`src/walkthrough/evidence.ts`, D04 T02 §5), not by a registered check, under `walkthrough.chain`, `walkthrough.credential_target`, `walkthrough.canary_accepted` and `walkthrough.hidden_text`, so `FAMILIES` and `familyOf` learn the prefix and the registry test that every registered check has a renderer is untouched; (3) the producer's `artefacts` are keys with no page numbers, so a screenshot is drawn as a figure only where one key can only mean one thing (the credential target's, its form's page) and the other walk screenshots are listed as files in order; (4) every address, field name, quote and brand the walk found is text, never markup; the credential fields are drawn as names only (the producer stores no values).

**Corrected 2026-11-01** (from the plan review, `docs/reviews/07-app/D07-T03-s13.md`): (5) a screenshot is drawn through the artefact route's inline mode (`?inline=1`, which serves a rendered image's bytes inline and keeps a link holder's signature parameters), never the download URL, and a browser test proves the image loads real bytes; (6) an image that fails to load (the artefact expired after its 30 days, the store failed, the route answered its HTML recovery page) is replaced by a plain state in the figure, "This screenshot could not be loaded", with a Try again that reloads it, written in the app script (`src/web/client/app.ts`) over `img[data-evidence-image]`, so the figure never shows a broken image icon; without script the file link under it still opens the artefact's own recovery page; (7) `walkthrough.canary_accepted` stores `keys(shot, after?.screenshotKey)`, which drops a missing key, so which capture is which cannot be told from one key: its captures are listed as "Screenshots taken around this step", unassigned, and no card claims one is the next page; (8) the credential target also says what became of the submission (`state`: `blocked` "The browser stopped it before it was sent", `failed` "It could not be delivered", `delivered` "It was delivered") beside the page's outcome (accepted, rejected, unknown), each in plain words.

**Phase:** 4
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, board `Main`
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Add the family's renderer. Done when: a fixture of each of its checks draws its card.

- [x] Add the `walkthrough` family: `FAMILIES`/`familyOf` in `src/web/components/evidence/cards.tsx` map `walkthrough.*` to it, and a `walkthrough` renderer draws `walkthrough.chain` (the pages in order with their domains, withheld ones said to be withheld, the outcome in words, a count of what was left out, the walk's screenshots as files) and `walkthrough.hidden_text` (the quote as text, the reason in words, the page). Done when: `test/web/evidence-cards.test.ts` draws each from the producer's own items (`src/walkthrough/evidence.ts`), pages in order, a hostile page address and quote as text.
- [x] Draw `walkthrough.credential_target` and `walkthrough.canary_accepted`: where the test credentials would go (domain and address), the method, the field names only, the outcome in words, whether it is the brand's own site, the submission's state and the page's outcome in words, the form's page as an `EvidenceFigure` for the credential target, and for the accepted one the captures listed as "Screenshots taken around this step" with no claim of which is which. Done when: `test/web/evidence-cards.test.ts` draws a fixture of each severity (own site info, another site high or critical), each submission state and each outcome with its words, no credential value anywhere in the HTML, a missing screenshot saying so, and a canary-accepted fixture with one capture and with two never naming which page it is.
- [x] Draw the link family's landing screenshot, and the walk's credential-target page, as an `EvidenceFigure` holding an `<img data-evidence-image>` at the artefact route's inline URL (the download URL with `inline=1`, the link holder's signature parameters kept), with an alt text naming the page, beside `link.credential_form`, `link.card_form` and `link.lure_button` when the finding has one, falling back to the reason it has none. Done when: `test/web/evidence-cards.test.ts` shows the figure with the inline route and the alt text, for a member's route and a link holder's, and the existing missing-reason fixture still reads.
- [x] Make a figure whose image fails say so and offer to retry: the app script replaces a failed `img[data-evidence-image]` with "This screenshot could not be loaded" and a Try again button that reloads it once, announced politely. Done when: `test/node/evidence-cards-browser.test.tsx` loads a real PNG through a stub of the inline route (the image's `naturalWidth` above 0), then a 404 and a page answering HTML in place of the image: each shows the message and no broken image, Try again loads it when the stub then answers, at 360 and 1280 px in both themes, with a 120-character address and a long page name wrapping, reached and pressed by keyboard, and passing the accessibility rules.
- [x] Prove the cards through the report page: a stored walk and a stored followed link read back through `/r/:caseId` draw their cards, and a link holder sees the same without any member-only control. Done when: `test/web/report-access.test.ts` reads a case with each family's evidence for a member and a signed link, the cards present in both and the screenshots served by the same access rule as every artefact.
- [x] Commit: `web: link and walkthrough cards`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts test/web/report-access.test.ts` and `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` pass with each family's checks drawn and each screenshot loaded or its failure said.

> **Verified:** 2026-11-01 | §13 | c2885fdbd9586b945b86266c5952260fec638ab4
> **Review:** `docs/reviews/d07-t03-s13.json`

## 14. Vision and brand cards

> **Started:** 2026-11-03T02:54:22Z

A vision finding shows the rendered page or the logo crop beside its reference, and a brand finding the claimed brand against its real domains (M3, board `Main`). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, board `Main`
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Wire the family: `vision` in `FAMILIES` and `RENDERERS`, and every producer's check name in `CHECK_WORDS`. Done when: each `vision.*` name the producers write reaches its renderer in a test.
2. Draw each check's card from its producer's stored detail. Done when: a producer-shaped fixture of each check draws its fields, hostile text as text.
3. Serve the brand's reference logo beside the crop through the report's authorised file route. Done when: the crop and the reference draw in a browser from real image bytes, and a missing one reads as missing.
4. Prove it in the browser at both widths in both themes. Done when: the checkpoint below passes.

- [x] Wire the family: add `vision` to `FAMILIES` and `RENDERERS` in `src/web/components/evidence/cards.tsx` and each producer name (`vision.claimed_brand`, `vision.requested_action`, `vision.urgency`, `vision.coverage`, `vision.not_checked`, `vision.logo_match`, `vision.brand_domain_mismatch`) to `CHECK_WORDS` in `src/web/components/evidence/check-words.ts`. Done when: `test/web/evidence-cards.test.ts` asserts each name maps to the vision family and reaches its renderer. Cheaper substitute: leaving the names unmapped, so every vision card stays plain while the registry test passes.
- [x] Draw the reading cards: `vision.claimed_brand` (the picture it was read from as a figure through the artefact route's inline mode, the brand claimed, the visible sender), `vision.requested_action` (what it asks, a payment flag) and `vision.urgency` (its pressure quotes), each with the stored confidence. Done when: producer-shaped fixtures draw each field in `test/web/evidence-cards.test.ts`, hostile brand, sender and quote text as text. Cheaper substitute: the summary alone, which asks the reader to trust a reading they cannot see.
- [x] Draw the statements that are not findings: `vision.coverage` names its losses, `vision.not_checked` its reason, and a `vision.logo_match` or `vision.brand_domain_mismatch` with `checked: false` says the comparison did not run and why. Done when: fixtures of each draw those words and none reads as a match or a clearance.
- [x] Draw the logo card: the crop as a figure beside the brand's reference logo (served by the artefact route for a `ref-logo:` key, under the report's own access rule, labelled with the brand), the differences named, and the domain state in words (the brand's own domain, not its domain, or not judged). Done when: fixtures draw each state, and the browser test below draws real crop and reference bytes side by side. Cheaper substitute: the crop alone, which proves a logo was found but not what it was compared with.
- [x] Draw the brand card: `vision.brand_domain_mismatch` with the brand claimed, its real domains, and each compared address with its kind (sent from, leads to, shown) and its judgement, confirmed and unconfirmed apart; a stored `source_url` is drawn as text, never a link. Done when: producer-shaped fixtures (sender, landing and visible kinds; confirmed and unconfirmed) draw them, hostile domains as text.
- [x] Prove the journey in a browser: stored producer-shaped vision evidence through the member and signed-link report draws in `test/node/evidence-cards-browser.test.tsx` at 360 and 1280 in both themes, the lure (`vision.requested_action`) among them, real image bytes loading, a missing image in the app script's failure state, long hostile text wrapping, keyboard operation and the accessibility gate. Done when: the test passes and fails with the vision dispatch removed.
- [x] Commit: `web: vision and brand cards`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts test/web/report-status.test.ts` and `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` pass with the family's checks drawn, the lure card among them at both widths in both themes.

> **Verified:** 2026-11-03 | §14 | 02b99d1e1e6055ca4767a57745568e66738419f5
> **Review:** `docs/reviews/d07-t03-s14.json`

## 15. Invoice and document cards

> **Started:** 2026-11-03T03:41:30Z

An invoice finding shows the masked comparison of the invoice's bank details with the ledger, and a payment document its fields and the limit statement (M3, board `Report-Invoice`; S3 payment document card). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 invoice state, board `Report-Invoice`, the payment document card on S3
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

> **Corrected 2026-11-03 (plan review):** The producers store only the submitted side masked (`account_last3`, `beneficiary_masked`), the comparison source (`against`: the supplier ledger or the registered account) and the outcome, never the recorded side's masked fields, so the card draws exactly that and never infers which fields differ or what the recorded account ends in; the registered side stays match or no match only (the safety contract). No outlined PDF page is stored either: the card links the document itself through the artefact route (its file states already honest), and an outlined, masked page preview is producer work asked of the coordinator for the trust lane. A stored phone is never drawn, from the ledger or the document: the card tells the reader to phone the number in their own records, so no number from a message or document can become the confirmation contact. Only an allowlist of stored fields is drawn; `supplier_id`, `protected_org_id` and any unexpected key never reach the page.
> **Deferred:** outlined, masked bank-block page preview on invoice and payment cards -> XREF: D07 T09 §20
> **Deferred:** baseline verification provenance on invoice and payment comparisons -> XREF: D07 T09 §21

**Build order:**

1. Wire the families: `invoice` in `FAMILIES` and `RENDERERS`, every producer name in `CHECK_WORDS`, and the payment-document names dispatched in the document renderer beside `document.forensics.*`. Done when: each name reaches its renderer in a test.
2. Draw each check's card from its producer's stored detail, masked and allowlisted. Done when: a producer-shaped fixture of each check draws its fields, and a hostile fixture proves nothing unmasked, internal or unexpected is drawn.
3. State every could-not-run in plain words. Done when: each reason code draws its sentence and none reads as a match, a mismatch or a clearance.
4. Prove it stored, through the report route and in a browser. Done when: the checkpoint below passes.

- [x] Wire the families: add `invoice` to `FAMILIES` and `RENDERERS` in `src/web/components/evidence/cards.tsx`; add `invoice.detected`, `invoice.bank_changed`, `invoice.supplier_domain_changed`, `invoice.change_language`, `invoice.comparison_unavailable`, `invoice.not_checked` and `document.type`, `document.layout_mismatch`, `document.beneficiary_match`, `document.beneficiary_mismatch`, `document.comparison_unavailable`, `document.not_checked`, `document.limit`, `document.proof_of_payment` to `CHECK_WORDS` in `src/web/components/evidence/check-words.ts`, dispatched in the document renderer. Done when: `test/web/evidence-cards.test.ts` asserts each name maps and reaches its renderer. Cheaper substitute: generic cards that name no comparison, which the registry test would still pass.
- [x] Draw the invoice cards: `invoice.detected` (supplier, its domain, bank, account holder, account as `***` plus its last three, branch, amount, reference, due date), `invoice.bank_changed` (the submitted masked account, what it was compared against in words: your supplier ledger or the registered account, and that it differs), `invoice.supplier_domain_changed` (the domain it came from, never used before), `invoice.change_language` (the amount and masked account it arrived with). Done when: producer-shaped fixtures draw each field. Cheaper substitute: the verdict summary alone, which hides which document and which account were compared.
- [x] Draw the payment-document cards: `document.type` (its kind, issuer, amount, dates, reference, beneficiary name and masked account, whether the layout was compared and, when not, why in plain words), `document.layout_mismatch` (each stored difference, and that a difference cannot prove the document was edited), `document.beneficiary_match` and `document.beneficiary_mismatch` (the submitted masked account, the comparison source, the outcome), `document.limit` and `document.proof_of_payment` (the stored limit statement). Done when: producer-shaped fixtures draw each, layout never worded as proof of editing.
- [x] State every could-not-run in plain words: `invoice.comparison_unavailable` and `document.comparison_unavailable` (no recorded account, no account stated, an ambiguous supplier, the comparison keys, the rate limit), `invoice.not_checked` and `document.not_checked` (too large, too many pages or documents, a reading that failed), each saying the comparison did not run and is neither a match nor a mismatch. Done when: fixtures of each code draw its sentence.
- [x] Prove the privacy contract: a fixture whose detail carries a full account number, `supplier_id`, `protected_org_id`, a phone and an unexpected key draws none of them, in the cards and read back through the report route; hostile text draws as text. Done when: `test/web/evidence-cards.test.ts` asserts their absence from the rendered cards and the routed report.
- [x] Prove the journey in a browser: producer-shaped stored invoice and payment-document findings draw in `test/node/evidence-cards-browser.test.tsx` at 360 and 1280 in both themes (the invoice bank-changed card among them), long text wrapping, the document linked through the artefact route, keyboard operation and the accessibility gate. Done when: the test passes and fails with the invoice dispatch removed.
- [x] Commit: `web: invoice and document cards`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts test/web/report-status.test.ts` and `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` pass with the families' checks drawn, the invoice bank-changed card among them at both widths in both themes.

> **Verified:** 2026-11-03 | §15 | d9052a60864f2c8659f65a8146a6ec54c0cc0081
> **Review:** `docs/reviews/d07-t03-s15.json`

## 16. Voice cards

> **Started:** 2026-11-01T17:55Z

A voice finding shows the transcript with the request, the claimed identity and the limits (M3, board `Report-Voice`). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

> **Corrected 2026-11-01 (validation before build):** Fact-checked against the tree and the checks lane's shapes (`checks-outbox.md` 18:29, D01 T03 §5 built at `d8686377`). (1) The four stored voice checks are drawn already (the ticked item below); what is missing is `voice.lure`, a mail check whose card names the attachment, whether it carries a player or a link ("What the attachment claims to be", the voice family, medium). (2) No producer stores a transcript or player evidence item, so the board's player and timed transcript cannot be drawn from stored evidence yet: that card waits on a checks-lane producer shape and is filed rather than improvised here. (3) The limits line for a failed transcription is drawn where the failure is shown: an audio case whose `transcribe` step failed, in the failed and partial states, beside what happened.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 voice note state, board `Report-Voice`
**Job:** a sceptical reader sees the proof behind this kind of finding
**Treatment:** the card frame of §3, the artefact as proof
**Chrome:** `EvidenceCard`, `EvidenceFigure`, `EvidenceQuote` (D07 T01 §7)

**Build order:**

1. Add the family's renderer. Done when: a fixture of each of its checks draws its card.

- [x] Draw `voice` cards (the player, the transcript with the request highlighted, the extracted request and claimed identity, the limits). Done when: `test/web/evidence-cards.test.ts` draws a fixture of each of the family's registered checks through its renderer, the registry test passes with the family mapped, and the transcript draws its marked request as text, never markup.

> **Resolved:** the player and timed transcript -> XREF: D07 T09 §6. Resolved 2026-11-03 by D07 T09 §6 in `3f244d1b`, `9a84a0a5` and `e5363498`: the `voice.transcript` card (`src/web/components/evidence/cards.tsx`) plays the recording through the artefact route and draws its timed segments with the request marked.
- [x] Name and draw `voice.lure` in `src/web/components/evidence/check-words.ts` and the voice renderer (`src/web/components/evidence/cards.tsx`): the attachment's file name, whether it carries a player, whether it carries a link, each said plainly, a hostile file name as text. Done when: `test/web/evidence-cards.test.ts` draws a lure with a player, one with a link and one with neither, and the registry words name the check. Cheaper substitute: the plain card, which shows neither the file nor what it carries.
- [x] Prove the lure through the report: producer-shaped `voice.lure` rows stored as the producer will write them (its registration is D01 T03 §5, the checks lane's, which stamps once this card reaches main, the same sequencing as §12) read back through `/r/:caseId` for a member and a signed link. Done when: `test/web/report-access.test.ts` finds the file name and what it carries in both views. **Added 2026-11-01 (plan review P2).**
- [x] State the limits where a transcription failed: in `ReportLive` (`src/web/pages/report-live.tsx`), a case whose failed step is `transcribe` (an uploaded voice note or a forwarded recording alike; the failed step, not the channel, says a transcription was attempted) shows "The words would have been the speaker's own, and their meaning our reading of them. Languages we cannot read, and cloned or synthetic voices, are not detected." in the failed state and beside a partial verdict. Done when: `test/web/report-status.test.ts` finds it through the report route for a failed transcription and not for another step's failure. Cheaper substitute: the generic failure words, which leave a reader thinking a transcript exists.
- [x] State the voice check's limits beside a failed transcription. Done when: a case that ends partial naming `transcribe` (no checks ran, so no `voice.limits`) shows a plain line on its report saying the quotes would have been the speaker's own words, the meaning the model's reading, and that unsupported languages and cloned voices are not detected, in `test/web/report-status.test.ts` through the report route. Added 2026-11-01 at the checks lane's request (D01 T03 §4).
- [x] Draw the producer's four voice checks from their stored detail (`voice.request` in its asked, payment-only and not-checked states, `voice.claimed_identity`, `voice.urgency`, `voice.limits`) in `src/web/components/evidence/cards.tsx`, with a fixture of each in `test/web/evidence-cards.test.ts`. Done when: the fixtures draw and a hostile quote renders as text. Done 2026-11-01 ahead of the player and transcript so the checks lane's registry tests pass.
- [x] Commit: `web: voice cards`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts test/web/report-status.test.ts` and `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` pass with the family's checks drawn, the lure card among them at both widths in both themes.

> **Verified:** 2026-11-01 | §16 | a86623e198cb6018c6e41a822279051c6dc61e87
> **Review:** `docs/reviews/d07-t03-s16.json`

## 17. Trust and verification cards

A trust finding shows the claim against the registry of the protected business, and a verification card the request sent and the answer (M3; D05). Filed 2026-10-31 from §3's validation: §3 builds the card frame and the renderers for the families that exist, and this family's card waits on its producer's `detail` shape.

**Phase:** 7
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

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts test/web/report-status.test.ts` and `pnpm exec vitest run --project browser test/node/evidence-cards-browser.test.tsx` pass with the family's checks drawn, the lure card among them at both widths in both themes.

## 18. Check count and clean checks

> **Started:** 2026-10-31T19:39Z

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

- [x] ~~Draw the count line ... a grouped skip as each check it covers ...~~ **Corrected 2026-10-31 (plan):** struck as one item and split below. The stored outcomes (`check_outcomes`, D02 T01 §3, read by `readCheckOutcomes` in `src/checks/evidence.ts` and already passed to the report as `coverage`) hold one row per registered check, so no grouped skip exists to count; they hold four outcomes (`ran`, `partial`, `skipped`, `failed`), which the old item did not name.
- [x] Draw the count line as one shared component, `EvidenceCount` in `src/web/pages/report-live.tsx`, above the finished evidence cards inside `ReportLive` (the `#report-live` region that `GET /r/:caseId/status` re-renders on each 2-second poll) and above the cards of the no-verdict branch in `src/web/pages/report-view.tsx`. **Corrected 2026-10-31 (plan review P1):** it named only `report-view.tsx`, which the status poll bypasses, so a running report would finish without its count. The line is from the stored outcomes and the cards drawn: "<n> findings" counts the evidence cards less the `not_checked` card (a check that did not run is not a finding); "<m> checks ran" counts `ran` and `partial` (a check that read part of its input ran, as the coverage notice counts it); then "nothing skipped" when no check was `skipped` or `failed`, else "<k> skipped" for `skipped` and "<j> failed" for `failed`, each said only when above zero; singular and plural in words ("1 finding", "1 check ran"). Done when: `test/web/evidence-cards.test.ts` renders "3 findings · 8 checks ran · nothing skipped" for the safe board's case, counts a check with several findings once among the checks, counts a `partial` check as ran, says "1 skipped · 1 failed", and leaves the `not_checked` card out of the findings. Cheaper substitute: counting outcome rows' `findings` instead of the cards drawn fails a test where a check's findings are grouped into one card.
- [x] Draw no count of checks for a case with no stored outcomes (`coverage` null, a case checked before outcomes were kept): the line says "<n> findings" alone, and the coverage notice's own sentence ("Coverage not recorded for this check: it ran before each check's outcome was kept.") is drawn beside it on every branch, the no-verdict branch of `src/web/pages/report-view.tsx` included, which today draws neither. **Corrected 2026-10-31 (demo branch plan review P2):** the no-verdict branch draws no `CoverageNotice`. Done when: a test renders a case with null coverage and reads "3 findings" with no "checks ran", and `test/web/report-status.test.ts` stores a finished case with evidence, no verdict row and no outcomes, and reads both the count and the coverage sentence through `/r/:caseId`. Cheaper substitute: the count alone on the no-verdict branch fails the route test.
- [x] Count the phone's "N more findings" disclosure (`EvidenceCards` in `src/web/components/evidence/cards.tsx`) by the count line's rule: its summary counts the remaining cards less the `not_checked` card and names that card apart ("5 more findings · 1 not checked"; "1 not checked" alone), the cards themselves unchanged. **Planned 2026-10-31 (demo branch plan review P2).** Done when: a test with findings and a `not_checked` card among the uncited ones reads the summary with both, and its total agrees with the count line.
- [x] Draw "Checks that found nothing" as a shared `CleanChecks` section in `src/web/pages/report-live.tsx`, inside `ReportLive` after the finished evidence cards, on a safe verdict only (a heading `h2` and a list, `aria-labelledby` its heading): each check whose outcome is `ran` with `findings` 0, in run order, named by `CHECK_WORDS` (`src/web/components/evidence/check-words.ts`), and a stored name no longer registered drawn as its stored name, never dropped. A `partial` check is never listed as clean (D02 T01 §3: part of its input went unread). Done when: a test lists a clean check, leaves out a check with a finding, a `partial` one and a `skipped` one, names a retired check by its stored name, and draws no list on a suspicious or malicious verdict nor when every check found something. Cheaper substitute: listing every `ran` check fails the test whose check ran with a finding.
- [x] Prove the refreshed region carries both: in `test/web/report-status.test.ts` (**Corrected 2026-10-31 (build):** named `report-access.test.ts`; the status route's own tests and their member and link setup live in `report-status.test.ts`), a case stored running is read through `GET /r/:caseId/status` (no count line, no list), then its outcomes and safe verdict are stored and the same route returns the count line and the clean list, for a signed-in member and for a signed-link reader (`?t=`). Done when: both readers get the finished count and list from the status route alone, without loading the page. Cheaper substitute: rendering in `report-view.tsx` only fails this test.
- [x] Check the clean list in the browser in `test/node/report-verdict-browser.test.tsx`'s safe variant: at 360 and 1280 px, light and dark, a list holding a retired check's long stored name (100 characters, the column's limit) and the count line pass the accessibility gate's rules with no sideways scroll, and the list reads as a heading and a list. Done when: the variant's matrix passes with the long name present and fails when the list overflows (a `whitespace-nowrap` on its items fails it). **Planned 2026-10-31 (plan review P2).**
- [x] Record the board's per-check result words as a SPEC deviation: `Report-Safe` follows each clean check with what it saw ("Links: 1, to fynbosfreight.example", "Logo: matches the registered logo"), which the outcomes do not store; the list draws "<check words>: nothing found". Add the `Deviation` bullet under `design/SPEC.md` M3 and ask the checks lane, through the coordinator, for a per-check result summary in the stored outcome. Done when: the bullet is in the SPEC with the reason, and the ask is sent and its section ref recorded here as a `Deferred:` line. **Corrected 2026-10-31 (completion review):** the checks lane filed its half as D02 T01 §7 (on checks-lane at 7dbb51f8), which does not resolve on this branch yet; the Deferred owner is D07 T03 §44, filed here, which draws the stored summary, removes the deviation and takes D02 T01 §7 as its dependency once that row reaches this branch.
> **Resolved:** the board's per-check result words in Checks that found nothing (SPEC M3 deviation) -> XREF: D07 T03 §44. Resolved 2026-11-03 by D07 T03 §44 in `50c72859` and `69e3f29b`: `CleanChecks` (`src/web/pages/report-live.tsx`) draws each clean check's stored summary; the lookalike check's words naming the domains it compared follow in D02 T03 §12.

- [x] Commit: `web: the report counts its checks`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts test/web/report-status.test.ts` and `pnpm exec vitest run test/node/report-verdict-browser.test.tsx` pass, the count line and the clean list drawn from outcomes stored through `saveEvidence` and read back by the report route, not hand-built props alone. **Corrected 2026-10-31 (plan):** the route read added, so the storage read is proven, not only the renderer.

> **Verified:** 2026-10-31 | §18 | beb13e08d6879b6df864116fc78761957d33a011
> **Review:** `docs/reviews/d07-t03-s18.json`

## 19. Original message preview

> **Started:** 2026-11-01T10:31Z

A reader opens the original message's safe rendering and its complete headers from a finding in one action, without downloading it, running anything in it or opening a mail client (D07 T03 §3's completion review: an investigation console shows the preview and headers in place, where §3's cards offer the original only as a download). Filed 2026-10-31. It adds a surface to the approved report, so the operator approves its board first.

**Phase:** 6
**Needs:** none
**Surface:** yes

**Operator decision (2026-11-01 03:30 SAST, recorded in docs/coordinator.md):** built now, with a board and its `design/SPEC.md` entry for the operator's approval first. `owner-decision` is dropped; `operator` stays only as the approval of the board. **Board proposed 2026-11-01:** Report-MessagePreview, drawn in `design/mockups/proposed/` (outside the approved inventory, which `check-design.py` and `tests/scripts/test_design_spec.py` hold complete) with its SPEC entry and coverage written in that folder's README to apply on approval; nothing is built until the operator approves the preview (the approval line is recorded in this section, and the board moves into `design/mockups/source/` and `approved.json` as that README says).

**Operator approval (2026-11-01 11:35 SAST, the operator asked directly, recorded in `docs/coordinator.md` on `coordinator-gate`):** the board is approved as drawn; it is imported into `design/mockups/source/` with its PNG, `approved.json` and `coverage.json` entries and the `design/SPEC.md` M3 lines (`python3 design/tools/check-design.py` passes). `operator` is removed from Needs.

Message preview approved: 2026-11-01 (Report-MessagePreview)
**Fidelity:** a new `design/SPEC.md` M3 control and board, approved by the operator before the build
**Job:** a sceptical reader checks the message itself and its headers without leaving the report
**Treatment:** the message as plain, inert text and its headers in full, beside the finding that cites them
**Chrome:** `EvidenceQuote`, the full-size viewer of §8

**Corrected 2026-11-01:** the stored forms are `raw/<case>/visible.txt` (the visible text, hidden text taken out: what a model reads) and `raw/<case>/parsed.json` (the headers in order received), both deleted with the raw message after 30 days, so the preview reads those through a `view` mode of the artefact route, whose access rule it keeps, and never serves the raw bytes inline; the preview opens from the cards that already offer the original, as links that download it without script; the dialog is built in the shared app script like §8's viewer and reuses its failure words.

**Corrected 2026-11-01 (plan review `docs/reviews/07-app/D07-T03-s19.md`):** (a) the headers tab never says the authentication results in them are the receiving server's own (any `Authentication-Results` header in a message can be forged): its line reads "Every header as stored, in the order received. A result written into a header may be forged; the authentication check says which results were the receiving server's.", recorded as a departure from the board; (b) `visible.txt` is the text a model reads, so it also lacks visible instruction-like phrases (`withoutInstructions`, `src/pipeline/analysis-workflow.ts`): the message tab therefore shows the parsed plain-text body as sent (`parsed.json` `text`), and only a message with no plain part falls back to `visible.txt`, saying so on the tab ("This message has only an HTML version. This is its visible text, with hidden text and instruction-like phrases taken out."), the download kept as the way to the original; (c) the dialog tells apart an unavailable text (never stored), an empty body and an empty header list, each in its own announced words, leaving the other tab and the download usable; (d) the download and the no-script link are proven to return the original bytes as an attachment for a member and a signed-link holder; (e) the checkpoint runs the route, card and browser suites, and the browser test proves announcements on success, keyboard scrolling that moves the region, and that a superseded response cannot fill a tab the reader has left.

**Build order:**

1. Approve the surface, then build it. Done when: a member opens a fixture's preview and headers from a card.

- [x] Draw the preview on the M3 board (where it opens, the headers view, a long or hostile message, an unavailable original) and record it in `design/SPEC.md` M3 with the operator's approval. Done when: the board and SPEC entry exist with the approval dated.
- [x] Add a `view` mode to the artefact route for the case's raw message key (`src/web/pages/artefacts.tsx`, under the route's own access rule, the report link's parameters verified with `view` removed): `?view=message` answers the parsed plain-text body as sent (`parsed.json` `text`; `source: "plain"`), or, for a message with no plain part, the stored visible text (`readVisible`, hidden text and instruction-like phrases already taken out; `source: "visible"`) and `?view=headers` the stored header list (`parsed.json`'s `headers`, name and value in order received), each as JSON `{ part, text, truncated, source }` cut to the first 200 KB, with `nosniff`, `sandbox` CSP and no caching; a message text never written answers `text: null` (`source: null`); a message or summary past its 30 days answers the route's marked 410 (`x-artefact-state: gone`); anything else is the route's existing answers. Done when: `test/web/message-preview.test.ts` reads both parts for a member and for a link holder, finds a hostile message (markup, a script, hidden-looking text, a visible instruction phrase, a forged `Authentication-Results` header) as plain JSON text only with the instruction phrase present in the message part, a body over 200 KB cut with `truncated: true`, `text: null` for a message never scanned, the gone mark after the message is deleted, another organisation's 404, a tampered signature's 404 and an expired link's `link-expired` mark. Cheaper substitute: serving the raw `.eml` inline, which a browser may render.
- [x] Offer the preview from the cards that cite the message: where a card already offers "Download the original message" (a raw message key among its artefacts, `Files` in `src/web/components/evidence/cards.tsx`), add two links beside it, "View the original message" and "View complete headers", whose address is the raw file's own download address (so without the app script they download the original) and which carry `data-original-view="message"` or `"headers"`. Done when: `test/web/evidence-cards.test.ts` finds both links, with the right marker and target, on a card with the raw key and on no card without it, and a hostile subject or key never reaches markup.
- [x] Build the dialog in the shared app script (`src/web/client/app.ts`), from the board: a native modal dialog "Original message" with a Close button and Escape, two tabs ("Message", "Complete headers", a real `tablist` opened on the link's tab, arrow keys moving between them), the part drawn as text in a scrollable, focusable `<pre>` region (never as HTML, links not clickable), the board's line under each tab, the 200 KB note when `truncated`, a "Download the original (.eml)" link, and the viewer's states (loading, "The original message is no longer stored", link expired, signed out with one Sign in, a failed read with Try again), announced once; Close and a new request abort the request; focus returns to the link that opened it (or the card's recovery control). Done when: `test/node/message-preview-browser.test.tsx` opens each tab from its link in Chromium, finds the text in the region with a hostile message's markup shown as text and its link not clickable, moves between the tabs by arrow keys, shows the truncation note, the unavailable-text, empty-body and empty-headers states (the other tab and the download still usable), the HTML-only line, the gone, link-expired and signed-out states and a retry that succeeds, announces each settled outcome once, scrolls the region by arrow keys, drops a superseded response when the reader switches tabs while one is pending, activates the download link and finds the original bytes as an attachment for a member and a signed-link holder, opens the capture of the original with JavaScript disabled, closes with Close and Escape with focus back, aborts a held request on close, fits 360 px without sideways scroll, and passes axe in both themes. Cheaper substitute: an `iframe` of the message, which would run it.
- [x] Record the departures in `design/SPEC.md` M3 as a `Deviation (D07 T03 §19)` bullet where the build differs from the board (the headers line is neutral about authentication results, and the message tab shows the parsed plain-text body as sent, falling back to the visible text only for an HTML-only message and saying so). Done when: the bullet is in the SPEC and `python3 design/tools/check-design.py` passes.
- [x] Commit: `web: the original message preview`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/message-preview.test.ts test/web/evidence-cards.test.ts` and `pnpm exec vitest run --project browser test/node/message-preview-browser.test.tsx` pass.

> **Verified:** 2026-11-01 | §19 | 8bb079532165e4ad80f61dad3de1c5998d6bbb99
> **Review:** `docs/reviews/d07-t03-s19.json`

## 20. Retry a failed check

> **Started:** 2026-10-31T19:57Z

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

- [x] ~~Draw "Retry the check" for a member on a failed case ... posting ... to the checks lane's re-run ...~~ **Corrected 2026-10-31 (at start):** struck as one item and split below. The re-run is `retryCase(db, env, orgId, caseId, memberId)` in `src/pipeline/retry.ts` (D01 T01 §17, stamped), with its refusals `not_found`, `has_verdict`, `not_failed` (running, or retried already), `not_finished` (the failed run still writing), `not_started`, `start_unknown` and `database`; no route calls it yet. The board (`Report-Partial`) draws "Retry the check" as the dark button beside "Upload it instead" as a ghost one, with "Retry runs the check once more. While it runs, the button reads "Retrying" and is disabled."; today the failed branch of `ReportLive` (`src/web/pages/report-live.tsx`) draws only "Upload it instead", dark.
- [x] Read the current run only in the report's progress and delivery (`src/db/case-progress.ts`): `readCaseEvents` takes the events after the case's current run began (`CURRENT_RUN`, `src/db/cases.ts`) and leaves out the `retry` bookkeeping rows, and `readReplySend` reads the current run's reply (`send_key` = `reply:` and the case's `run_id`, else its id, as `src/pipeline/analysis-workflow.ts` and `src/mail/resend.ts` name it). **Planned 2026-10-31 (plan review P1):** both read every run, so a retried report would show the failed run's failure, elapsed time and reply beside the new run's. Done when: `test/web/report-retry.test.ts` stores a failed run, retries it, and reads through `/r/:caseId` and `/r/:caseId/status` the new run's steps alone (no earlier failure, its own start time, no earlier reply); a retried run that fails shows its own failure; and a rolled-back retry (its start failed) shows the original failure again. Cheaper substitute: filtering the events in `progressOf` fails the reply-status case.
- [x] Add `POST /r/:caseId/retry` in a new `src/web/pages/report-retry.ts`, mounted in `src/index.ts`: refused 403 unless its `origin` is the app's own, 404 for a malformed id, a signed-out reader, a link holder or a member of another organisation (the report's member rule, any membership in the case's organisation, as `src/web/pages/feedback.tsx`'s `memberCase`); otherwise `retryCase` with the member's user id. Done when: `test/web/report-retry.test.ts` retries a failed fixture once through the route (a new run id on the case, a `retry` event with the member), refuses a foreign origin, a stranger, a signed-out reader and a link holder, each changing nothing.
- [x] Answer by post, redirect, get, the domain page's pattern (`back` and `resultOf` in `src/web/pages/domains.tsx`): a started retry answers 303 to `/r/:caseId`, which then shows the new run running and polling (§4); a refusal answers 303 to `/r/:caseId?retry=<code>&rt=<time>&rs=<signature>`, the code from a fixed set, signed with the report link secret over the case id, code and time, honoured for 10 minutes; an unsigned, stale or unknown result says nothing. Done when: a test follows each answer, and a forged or stale `retry` parameter draws no words. Cheaper substitute: an unsigned `retry` parameter fails the forged-parameter test.
- [x] Say each refusal in words in the failed branch's "What you can do" panel (`role="status"`): `has_verdict` and `not_failed` need none (the page already shows the verdict or the running check); `not_finished`: "The check that failed is still finishing. Try again in a minute."; `not_started` and `database`: "The check could not be started again just now. Nothing changed: try again in a moment."; and a `database` outage before anything was written answers the same 303, never a 500. `start_unknown` leaves the case `received` (the sweep settles it, `sweepRetries`), so its words, "We are confirming whether the check started again. This page updates by itself.", are drawn on the running view from the case's stored state (`received` under a retry's run id with no step recorded yet), inside the polled region so every poll follows the state, clearing the moment the run records a step and never expiring while unresolved. **Corrected 2026-10-31 (completion review):** it followed a signed address, which cleared only on expiry. **Corrected 2026-10-31 (plan review P2):** it was drawn on the failed report only, where that state never is. Done when: a test draws each failed-report code's words on the failed report and none on a finished one; and for `start_unknown` follows the redirect to a running, polling page with its words, then settles it both ways (the run found: the report runs on; rolled back: the failed report again, with no `start_unknown` words).
- [x] Draw the board's controls for a member only, in `ReportLive`'s failed branch: a `<form method="post" action="/r/:caseId/retry" data-busy>` whose submit "Retry the check" is `variant="dark"` with `data-busy-label="Retrying"` (single-submit and busy, `src/web/client/app.ts`) and `data-busy-check="/r/:caseId"` (the busy handler's own "see where things stand" link after two seconds, which opens the report and sends nothing again; **Planned 2026-10-31 (plan review P3)**), "Upload it instead" as the ghost button, and the board's line "Retry runs the check once more. While it runs, the button reads "Retrying" and is disabled."; a link holder (`view === "public"`) sees neither the form nor the line, keeping "Upload it instead" as it is. Done when: `test/web/report-status.test.ts` finds the form for a member on the failed report through the status route and none for a link holder. Cheaper substitute: a form without `data-busy` fails the browser test below.
- [x] Prove the press in the browser in `test/node/report-status-browser.test.tsx`: pressing "Retry the check" posts once, the button reads "Retrying" and is disabled while the post runs, a second press posts nothing, and the page lands on the running report. And with the POST accepted but its answer withheld, the check link appears, opening it sends no second POST, and the report shows the retried run. Done when: the browser test counts one POST for two presses, reads the busy label, and follows the check link to the stored run with still one POST.
- [x] Commit: `web: retry a failed check`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/report-retry.test.ts test/web/report-status.test.ts` and `pnpm exec vitest run test/node/report-status-browser.test.tsx` pass, the retry exercised through the route against a stored failed case. **Corrected 2026-10-31 (at start):** the route's own test and the browser press added.

> **Verified:** 2026-10-31 | §20 | 9ca658dd072ae116c5b584931ee4fad27aa07048
> **Review:** `docs/reviews/d07-t03-s20.json`

## 21. Withdraw feedback

> **Started:** 2026-11-01T00:29Z

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

- [x] Add `withdrawFeedback(db, caseId, userId)` to `src/db/feedback.ts`: delete the member's row for the case, answering whether a row went. **Corrected 2026-11-01 (at start):** the feedback table is read only by its own module (the operator's waiting notices, `feedbackWaiting`, and the providers' false-alarm lists in `providers_json`; D08 T02 is not built), so deleting is the one operation that removes it from the queue and the counts together, with no "withdrawn" state for a later reader to forget; a notice already sent stays sent (the operator was told once). Done when: `test/web/feedback.test.ts` saves feedback, withdraws it, reads it back as none, finds it gone from `waitingNotices` and `feedbackWaiting` (a row whose notice had not yet gone) and from every provider list, leaves another member's feedback on the same case alone, and a second withdrawal changes nothing. **Planned 2026-11-01 (plan review P2):** the cron holds a batch of waiting notices in memory (`sendPendingFeedbackNotices`, `sendFeedbackNotice` in `src/web/pages/feedback.tsx`), so removing the row from the waiting list does not stop one already selected: `sendFeedbackNotice` checks the feedback row still exists just before it hands the notice to the mail service and sends nothing for a withdrawn one. The boundary is stated: a notice whose send has begun goes (the operator is told of a dispute that existed when it began); one still waiting in the batch is skipped. Done when: the test selects a waiting batch, withdraws one of its entries, runs the dispatch, and finds no mail for the withdrawn entry and the other entry's sent.
- [x] Add `POST /r/:caseId/feedback/withdraw` in `src/web/pages/feedback.tsx` (the app's own origin only, 403 otherwise; a member of the case's organisation, 404 for anyone else): withdraw the member's own feedback and answer the control's region, closed and offered again, saying once "You took your feedback back." An outage before anything changed answers the saved state again with "That did not go through. Your feedback is still there: try again in a moment." (503), never a 500; a second press when nothing is saved answers the closed control without the sentence. Done when: the test withdraws through the route, a stranger gets 404 and changes nothing, a foreign origin 403, an outage (a database that fails) leaves the feedback and says so, and the second press is quiet.
- [x] Offer it in the control: in `FeedbackControl` (`src/web/pages/feedback-control.tsx`) the saved state gains a quiet "Withdraw" beside "Change" (a link-variant button posting to the route, replacing the control's own region, `data-swap-errors` so a failed send keeps the saved state and its words), and the withdrawn state says what happened once and shows the closed "This verdict is wrong" again, with focus moved to it (`data-focus`) so a keyboard member continues from where the button was. The Withdraw form is busy and single-submit (`data-busy`, "Withdrawing…", `src/web/client/app.ts`), and a failed send gives the button back. **Planned 2026-11-01 (plan review P2):** the replaced button was the focus; a press must not send twice. Record the entry in `design/SPEC.md` M3 (controls and states). Done when: the saved state in `test/web/feedback.test.ts` shows Withdraw and Change, the withdrawn fragment shows its sentence and the closed control, and `test/node/feedback-browser.test.tsx` withdraws by keyboard (Tab to Withdraw, Enter), finds the sentence announced and the closed control back, and fails with the button's `data-swap-errors` region removed.
- [x] Make the client's in-place failure handling act on the form that failed (`ownFailure` in `src/web/client/app.ts` reads the first form in the region, which in the saved state is Change, so a failed Withdraw would put its words and release on the wrong form): the failed form's own submit gets the words and `busy:release`. Done when: `test/node/feedback-browser.test.tsx` fails Withdraw by the route's 503, by a dropped connection and by a gateway page, each time finding the saved feedback still shown, "That did not go through. Your feedback is still there: try again in a moment." announced beside the Withdraw button, the button given back, and then a successful retry; and it fails with the handler reverted. **Planned 2026-11-01 (plan review P2):** `data-swap-errors` alone proves nothing about the success path.
- [x] Prove the withdrawal holds across a reload: in `test/web/feedback.test.ts` the report page after a withdrawal shows the closed control with no saved state, and new feedback can be submitted again and read back. Done when: the test passes through `/r/:caseId` and the feedback route.
- [x] Commit: `web: withdraw feedback`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/feedback.test.ts` and `pnpm exec vitest run --project browser test/node/feedback-browser.test.tsx` pass with a withdrawn feedback gone from the queue and the counts. **Corrected 2026-11-01 (at start):** the browser press added.

> **Verified:** 2026-11-01 | §21 | caa248ea6ab5763fb161b78ef6f30cac700cfc41
> **Review:** `docs/reviews/d07-t03-s21.json`

## 22. One-press dispute

> **Started:** 2026-11-01T15:05Z

The dispute takes one press from the report for a member who adds no note (an email client's "Not junk" is one or two), the note and correction kept. The approved M3 control is open, choose, Send, so the operator decides the interaction and approves a board first. Filed 2026-10-31 from §6's completion review.

> **Corrected 2026-11-01 (validation before build):** Fact-checked against the tree and the approved board (`Report-Dispute`). (1) The closed control becomes the board's: "Was this verdict wrong?", one ghost button naming the opposite verdict ("I think this is safe" on a malicious or suspicious verdict, "I think this is a scam" on a safe one), and "One press sends it. You can add a note after."; the press posts the kind alone to the existing route (`POST /r/:caseId/feedback`, §6), busy and single-submit as its forms already are. (2) The saved state takes the board's words: "Sent: you said this looks safe." (or "this looks like a scam"), "Thank you. We use this to check our verdicts.", then the optional note with its hint ("Please leave out passwords and card numbers."), Send the note, Change and Withdraw; sending the note posts the saved kind with the note, replacing the row as §6 does. (3) Change keeps §6's choice form (the two kinds, the note, Send), and a refused or failed one-press send answers with that form and its words, so nothing typed is lost. (4) The intent entry is the public report's sign-in line (§26) on a report with a verdict: its return path names the intent (`/r/<id>?dispute=1`, kept same-site by `sameSitePath` as every return is), and the member report drawn with it shows the board's line "You came here from the email to say this verdict is wrong." above the one-press button, focused on load (a `data-focus-on-load` marker the app script honours when nothing else holds focus); an outsider still gets §1's 404, and choosing and pressing stay the member's. (5) §6's and §21's tests that name the old saved words are updated to the board's in this section, the behaviour they prove unchanged.

**Phase:** 6
**Needs:** none
**Surface:** yes

**Operator decision (2026-11-01 03:30 SAST, recorded in docs/coordinator.md):** built now, with a board and its `design/SPEC.md` entry for the operator's approval first. `owner-decision` is dropped; `operator` stays only as the approval of the board. **Board proposed 2026-11-01:** Report-Dispute, drawn in `design/mockups/proposed/` (outside the approved inventory, which `check-design.py` and `tests/scripts/test_design_spec.py` hold complete) with its SPEC entry and coverage written in that folder's README to apply on approval; nothing is built until the operator approves the one-press dispute (the approval line is recorded in this section, and the board moves into `design/mockups/source/` and `approved.json` as that README says).

**Operator approval (2026-11-01 11:35 SAST, the operator asked directly, recorded in `docs/coordinator.md` on `coordinator-gate`):** the board is approved as drawn; it is imported into `design/mockups/source/` with its PNG, `approved.json` and `coverage.json` entries and the `design/SPEC.md` M3 lines (`python3 design/tools/check-design.py` passes). `operator` is removed from Needs.

Dispute approved: 2026-11-01 (Report-Dispute)
**Fidelity:** a new `design/SPEC.md` M3 board for the one-press dispute, approved by the operator before the build
**Job:** a member disputes a wrong verdict in one press
**Treatment:** the dispute as one button whose words name the opposite verdict, the note offered after
**Chrome:** the feedback control (§6), `Button` (D07 T01 §8)

**Build order:**

1. Build it. Done when: a dispute sent in one press.

- [x] Draw the one-press dispute on the M3 board and record it with the operator's approval. Done when: the board and SPEC entry exist with the approval dated.
- [x] Send the dispute in one press, offering the optional note after, single-submit and undoable through Change. Done when: `test/web/feedback.test.ts` disputes in one post with no note and adds a note after.
- [x] Replace the closed control in `FeedbackControl` (`src/web/pages/feedback-control.tsx`) with the board's one-press form: "Was this verdict wrong?", a ghost submit naming the opposite verdict (posting `kind` alone, `data-busy`, busy words "Sending…"), and "One press sends it. You can add a note after." Done when: `test/web/feedback.test.ts` draws it for a malicious, a suspicious and a safe verdict with the right words, and one post with no note stores the dispute. Cheaper substitute: opening the choice form, which is the two extra activations the board removes.
- [x] Bound every send in the control: the one-press, note and Change forms carry the Withdraw form's 10 second `hx-request` timeout and its uncertain-outcome words (`data-not-reached-text`: it may or may not have gone through; reload to see where it stands), never "That did not reach us" for a send that may have stored. Done when: `test/node/feedback-browser.test.tsx` stalls each form past its deadline and finds the words, the typed note kept and the button given back, and a send stored before its answer was lost reads back as saved on reload. **Added 2026-11-01 (plan review P2).**
- [x] Draw the saved state with the board's words and the note offered after: "Sent: you said this looks safe." (or "this looks like a scam"), the thank-you line, the note field with its hint, Send the note (posting the saved kind with the note), Change and Withdraw as §6 and §21 have them. Done when: the test sends a note after the press and reads it back, and the saved words are the board's for both kinds.
- [x] Carry the intent from the email or signed link through sign-in (added 2026-10-31 from §26's completion review): an entry that, once signed in, opens the same report with the dispute control open and focused (a return path naming it, kept same-site by `sameSitePath`), membership and the outsider's 404 unchanged, the choice and Send still explicit. Done when: `test/web/report-access.test.ts` follows the entry through a redeemed link to the member view with the control open, and an outsider still gets the 404; at most three activations besides signing in.
- [x] Name the intent in the return path: the public report's sign-in line (§26, `src/web/pages/report-view.tsx`) returns a verdict report to `/r/<id>?dispute=1`; the member report reads it (`src/web/pages/report.tsx`) and draws the board's line above the button with `data-focus-on-load` on it, the app script (`src/web/client/app.ts`) focusing it on load when nothing else holds focus. Done when: `test/web/report-access.test.ts` follows the entry to the member view with the line and the marker, an outsider gets the 404, and `test/node/feedback-browser.test.tsx` lands with the button focused and presses it once.
- [x] Carry the intent in the reply email itself, for a member who is already signed in: the footer's "Tell us on the report page" (`src/mail/templates/reply.ts`, both parts) links to the report address with `dispute=1` added, and a member opening it by session lands on the focused control without signing in; the Open the full report link keeps no intent. Record it in `design/SPEC.md` N1. Done when: `test/mail/reply-design.test.ts` finds the dispute link beside the plain report link, and `test/web/report-access.test.ts` opens it with a member session and finds the line and marker with nothing sent. **Added 2026-11-01 (plan review P2).**
- [x] Commit: `web: one-press dispute`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/feedback.test.ts test/web/report-access.test.ts` and `pnpm exec vitest run --project browser test/node/feedback-browser.test.tsx` pass with a dispute sent in one press.

> **Verified:** 2026-11-01 | §22 | e9b70e768c4f1c0963fba591bc5c7403b43def69
> **Review:** `docs/reviews/d07-t03-s22.json`

## 23. Feedback outcome to the member

A member who disputed a verdict learns what the review found: when the operator settles the feedback in the queue (D07 T08 §5), the report shows the outcome and the member is told, the original verdict never lowered automatically. Filed 2026-10-31 from §6's completion review.

**Phase:** 7
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
> **Resolved:** the hidden instruction past the stored opening -> XREF: D07 T03 §29. Resolved 2026-11-02 by D07 T03 §29 in `f9b766eb`: the invisible-characters card draws the producer's excerpt under the opening, labelled with the character the instruction starts at, so a reader reads the instruction itself in the report.
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

**Phase:** 7
**Needs:** attended

**Skipped 2026-11-01:** Operator decision, 2026-11-01 03:30 SAST (held sections decided, recorded in docs/coordinator.md): skipped for the competition (a hands-on check); the section stays open, `Needs` unchanged, and the lane builds nothing for it now.
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

**Phase:** 7
**Operator decision 2026-11-02:** English plus Afrikaans, fixed strings only; the verdict's own words are not translated. Afrikaans ships only when a named reviewer for it is recorded in the section; until then the English fallback stands.

**Needs:** none

**Deferred 2026-11-01:** Operator decision, 2026-11-01 03:30 SAST (held sections decided, recorded in docs/coordinator.md): defer until after the competition; the section stays open, `Needs` unchanged, and the lane builds nothing for it now.
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

> **Started:** 2026-11-02T08:20Z

> **Corrected 2026-11-02 (validation before build):** the producer's excerpt is up to 250 characters (`SPOT_TEXT` in `src/checks/instruction-phrases.ts`: 80 before the instruction, the rest after), not 200 as filed; the offset is the character offset in the run's decoded text. The card reads `detail` as `Record<string, unknown>` (`src/web/components/evidence/cards.tsx:16`) with narrow readers, so the excerpt needs a small object reader beside `text()` and `count()`, and a hostile excerpt still renders as text.

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

- [x] Draw `detail.instruction` (the producer's excerpt around the instruction, with its character offset) under the opening in `src/web/components/evidence/cards.tsx`'s invisible-characters card, labelled "The instruction, from character <n>", and keep the card as §24 drew it when the field is absent. Done when: `test/web/evidence-cards.test.ts` draws a run whose instruction starts past the opening with the excerpt and its offset, from the producer's own items, and a hostile excerpt renders as text.
- [x] Commit: `web: the hidden instruction past the opening`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes with the instruction excerpt drawn.

> **Resolved:** the rest of the decoded run beyond the first excerpt (and any later instruction in it) -> XREF: D07 T09 §9. Resolved 2026-11-03 by D07 T09 §9 in `15656175` and `d2f5545e`: the invisible-characters card (`src/web/components/evidence/cards.tsx`) opens the stored decoded run whole under one disclosure, with its cut named.

> **Verified:** 2026-11-02 | §29 | e42119edfe34dc4d752bd58fa2d973c0b3dbbfed
> **Review:** `docs/reviews/d07-t03-s29.json`

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

**Phase:** 7
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
- [x] Record the producer half: `replyHeaders` (`src/mail/reply.ts`, D01 T02 §11, the checks lane's) still withholds the whole panel when a method is unreported, so real replies change only when its D01 row passes the reported methods alone. Ask the checks lane (through the coordinator) for that row's ref, with its dependency on this section and a test sending stored partial authentication results through `reply()` into both bodies, and add a deferral line to this section naming it. Done when: the Deferred line's cross-reference resolves (`python3 scripts/todo-graph.py resolve` exits 0 or 4, not 1 or 2). **Added 2026-10-31 (plan review P1).** **Done 2026-11-01:** the checks lane filed it as D01 T02 §16 (Reported methods only in the reply), which carries the stored-evidence-to-reply test; recorded below.
- [x] Commit: `mail: the reply names a method the receiver did not report`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply-design.test.ts test/mail/reply.test.ts` passes with a panel for each method unreported in turn.

> **Verified:** 2026-11-01 | §34 | 4eb0601969cae5985bdebc19d743a66771dd654b
> **Review:** `docs/reviews/d07-t03-s34.json`

## 35. DKIM none worded as unsigned

> **Started:** 2026-10-31T15:57Z

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

- [x] Replace the single `AUTH` map in `src/mail/templates/reply.ts` with per-method words for `none` (DKIM: "the message was not signed"; SPF and DMARC: "no record published"), sourced from RFC 8601 §2.7.1 (DKIM) and §2.7.2 (SPF) and RFC 7489 §11.2 (DMARC). Done when: `test/mail/reply-design.test.ts` checks each method's `none` sentence in both bodies, and fails with the old shared wording. Cheaper substitute: one word for every method's `none`. **Corrected 2026-10-31:** the words fit the panel's "<method> <result>" sentence ("SPF passed, DKIM passed, DMARC failed"): DKIM "found no signature" (RFC 8601 §2.7.1: the message was not signed), SPF "found no record to check" (RFC 8601 §2.7.2, RFC 7208 §2.6.1) and DMARC "found no policy to apply" (RFC 7489 §11.2: no policy published, or no aligned identifier to look one up; completion review); every other result keeps its words.
- [x] Record the producer half: `replyHeaders` (`src/mail/reply.ts`, D01 T02 §11, the checks lane's) withholds the whole panel when DKIM reports `none` (since `d423d5cb`), so real replies carry these words only when its D01 row passes a reported `none` again, kept apart from a method not reported (§34). Ask the checks lane (through the coordinator) for that row's ref, with its dependency on this section and a test sending stored authentication evidence with DKIM `none` through `reply()` into both bodies, and add a deferral line to this section naming it. Done when: the deferral's cross-reference resolves (`python3 scripts/todo-graph.py resolve` exits 0 or 4, not 1 or 2). **Added 2026-10-31 (plan review P1).** **Done 2026-11-01:** the checks lane filed it as D01 T02 §16 (Reported methods only in the reply: a reported DKIM `none` passed as `none` again); recorded below.
- [x] Commit: `mail: the reply words DKIM none as an unsigned message`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply-design.test.ts` passes with each method's `none` worded.

> **Verified:** 2026-11-01 | §35 | 36d2d1e9565b99d150c8c34ebd96a02261862b95
> **Review:** `docs/reviews/d07-t03-s35.json`

## 36. Results attributed to the receiver

> **Started:** 2026-10-31T16:09Z

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

- [x] Reword `headersWords` (`src/mail/templates/reply.ts`) to attribute the results to the receiving system ("The receiving system's checks recorded: ...") with no claim of who sent the message. Done when: `test/mail/reply-design.test.ts` finds the attribution in both bodies and no "who really sent it". Cheaper substitute: dropping the sentence, which leaves the results unexplained.
- [x] Say when SPF or DKIM passed for a domain other than the From domain, from the domains the producer passes (an input extension of `reply()`: the From domain and each method's domain, asked of the checks lane; until it lands, the alignment sentence keys on DMARC fail alone). Done when: SPF and DKIM pass with DMARC fail draws the sentence naming both domains, and the test fails without it. **Corrected 2026-10-31:** the input is `headers.domains` in `ReplyDesign` (`src/mail/templates/reply.ts`): `{ from?: string; spf?: string; dkim?: string }`, the From domain and the domain each method passed for, as the producer (the checks lane's D01 T02 §17, which depends on this section) passes them. Without domains, DMARC failing while SPF or DKIM passed says the pass was for a domain other than the one the message claims (RFC 7489 §3.1, alignment), naming none; with them it names each. The domains come from the message, so they are escaped in the HTML and cut at 253 characters (the DNS name limit, RFC 1035 §2.3.4), and a domain equal to the From domain is not called other.
- [x] Prove every branch of the alignment sentence in both bodies (`test/mail/reply-design.test.ts`), with the domain values and the method each is attributed to asserted: no domains (DMARC fail with SPF pass, with DKIM pass, with both: the unaligned sentence naming no domain); SPF alone and DKIM alone passing for another domain; both, with the From domain; a pass domain equal to the From domain in another case (not called other); `domains` with the From domain absent (the known pass domains shown, no comparison asserted, no From domain invented); a hostile domain escaped in the HTML and kept as text; a 300-character domain cut at 253; and DMARC pass or no method passing (no alignment sentence). Done when: each case passes and a fixed explanation, a dropped branch or an unescaped domain fails one. **Added 2026-10-31 (plan review P2).**
- [x] Commit: `mail: the reply attributes authentication results to the receiving system`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply-design.test.ts` passes with SPF and DKIM pass and DMARC fail explained.

> **Verified:** 2026-11-01 | §36 | 4914e0533f396ebb3f5f35db16b356479554f8ce
> **Review:** `docs/reviews/d07-t03-s36.json`

## 37. Early authentication view

> **Started:** 2026-11-01T14:20Z

Filed 2026-10-31 at the checks lane's request through the coordinator, from D01 T02 §11's completion review (`docs/reviews/01-intake/D01-T02-s11.md` on `checks-lane`, §11 built at `64166e86`). A member waits for the full investigation to see the authentication results, which are known within seconds of intake. Whether to show them early, on the report page or as a first reply, is a design decision across D07 and D04 (the agent's investigation) that the operator makes first.

> **Corrected 2026-11-01 (validation before build):** Fact-checked against the tree. (1) The operator's choice is recorded (the report page's running state, board `Report-Running-Early`, SPEC M3). (2) A check outcome (`readCheckOutcomes`, `src/checks/evidence.ts`) holds only whether a check ran, not the authentication state: the pill and sentence for each method come from that method's stored evidence item (`auth.spf`, `auth.dkim`, `auth.dmarc` in `src/checks/auth.ts`, each one item with `detail.state` of passed, failed, inconclusive or unavailable and a plain summary), which the running report already reads as "Found so far". The outcomes are the trigger: the card is drawn only while the case is running and at least one `auth.*` outcome is stored, and is absent before that. (3) When the receiving system reported no trusted results, the three auth checks are `skipped` and return no item: the card then says so in its own words, with no pills invented. (4) No outcome or evidence row carries a read time, so the card's "Read at" is the time the report itself was read (`now`, SAST with seconds), not a stored instant. (5) The card sits in `ReportLive`'s running branch between the band and the progress list, as the board draws it, so every 2 second poll can add it and the finished report replaces it with the full evidence cards.

**Phase:** 6
**Needs:** none
**Surface:** yes

**Operator decision (2026-11-01 03:30 SAST, recorded in docs/coordinator.md):** built now, with a board and its `design/SPEC.md` entry for the operator's approval first. `owner-decision` is dropped; `operator` stays only as the approval of the board. **Board proposed 2026-11-01:** Report-Running-Early, drawn in `design/mockups/proposed/` (outside the approved inventory, which `check-design.py` and `tests/scripts/test_design_spec.py` hold complete) with its SPEC entry and coverage written in that folder's README to apply on approval; nothing is built until the operator approves the early view (the report page's running state) (the approval line is recorded in this section, and the board moves into `design/mockups/source/` and `approved.json` as that README says).

**Operator approval (2026-11-01 11:35 SAST, the operator asked directly, recorded in `docs/coordinator.md` on `coordinator-gate`):** the board is approved as drawn; it is imported into `design/mockups/source/` with its PNG, `approved.json` and `coverage.json` entries and the `design/SPEC.md` M3 lines (`python3 design/tools/check-design.py` passes). `operator` is removed from Needs.

Early results approved: 2026-11-01 (Report-Running-Early)
**Fidelity:** `design/SPEC.md` M3 (a new early state, added to the boards once decided)
**Job:** a member sees the authentication results while the investigation runs
**Treatment:** to be decided: the report page's in-progress state, a first reply, or neither
**Chrome:** the report page (§1), the reply template (§7)

**Build order:**

1. Record the decision, then draw the view it names. Done when: the operator's choice is recorded in `design/SPEC.md` and the view it names renders while a case is in progress.

- [x] Ask the operator (through the coordinator): show authentication results before the verdict on the report page's in-progress state, as a first reply, or not at all; record the answer and its date in `design/SPEC.md` M3. Done when: the decision line is in the SPEC.
- [x] Draw the decided view from the stored check outcomes (`check_outcomes`, D02 T01 §3) while the case is in progress. Done when: `test/web/report-status.test.ts` shows the results on an in-progress case and not before they are stored. Cheaper substitute: waiting for the verdict.
- [x] Add `EarlyAuth` to `src/web/pages/report-live.tsx`: drawn in the running branch between the band and the progress grid only when a stored outcome names an `auth.spf`, `auth.dkim` or `auth.dmarc` check; for each method with a stored evidence item, a pill from its `detail.state` (passed: safe "Passed"; failed: malicious "Failed"; inconclusive: partial "Could not be checked"; unavailable: partial, "Not reported", except DKIM whose `detail.results` holds an explicit `none` result: "Not signed"), its board name ("Sending server (SPF)", "Signature (DKIM)", "Domain policy (DMARC)") and its item's summary as the one plain sentence; a method whose outcome is `failed` draws partial "Could not be checked" with "This check did not finish, so there is no result for it yet." and no invented state; the header row with the partial "Early result" pill, the title "What the receiving mail system recorded" and "Read at <SAST time with seconds> · before the investigation ends" from `now`; and the board's closing line verbatim. Done when: the unit in `test/web/report-status.test.ts` below passes and the methods stack at phone width with no raw colour. Cheaper substitute: reading the state from the outcome's `ran`, which cannot tell a pass from a failure. **Corrected 2026-11-01 (plan review P2):** `unavailable` alone does not prove a message was unsigned; only an explicitly reported DKIM `none` does.
- [x] Say no results plainly: when every stored auth outcome is `skipped`, the card draws the stored `auth.results` item's own summary when one is stored (it says which of no headers, an unknown receiver, an untrusted boundary or no header in the zone applies), else "No authentication results from a receiving system this service trusts were stored."; with no method pills invented, and a method whose outcome ran with no stored item left out rather than guessed. Done when: the test covers each producer-shaped branch (an `auth.results` item with `trusted: false` and its sentence, and none stored). **Corrected 2026-11-01 (plan review P2):** a skip has several causes, and only the stored explanation tells them apart.
- [x] Announce the early results once: the running branch's `data-announce` gains " Early authentication results are in." when the card first draws (and " No trusted authentication results were stored." for the skipped state), the read time never part of the announcement, so an unchanged poll stays silent. Done when: `test/web/report-status.test.ts` finds each announcement on the answer that gains the card and the same words on the next, and `test/node/report-status-browser.test.tsx` counts it once. **Added 2026-11-01 (plan review P2).**
- [x] Prove it through the routes: `test/web/report-status.test.ts` renders a running case with the three items stored and finds the card between the band and Progress with each pill, name and sentence; DKIM `none` against DKIM absent; a failed auth check's own row; a running case with outcomes not yet stored and a finished case find no card; and `test/node/report-status-browser.test.tsx` polls a running report that gains the card on a later answer at 360 px and 1280 px in both themes without sideways scroll, axe clean. Done when: both suites pass with the card's title removed failing them.
- [x] Commit: `web: authentication results before the investigation ends`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/report-status.test.ts` and `pnpm exec vitest run --project browser test/node/report-status-browser.test.tsx` pass with the early results drawn.

> **Verified:** 2026-11-01 | §37 | 3c148a1f207a4757d7e4ca4a20b89c38a726583f
> **Review:** `docs/reviews/d07-t03-s37.json`

## 38. Transcribe step in the report progress

> **Started:** 2026-10-31T21:51Z

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

- [x] Add the `transcribe` step to `progressOf` in `src/web/pages/report-progress.ts` as a conditional step, `["transcribe", "Transcribed the voice note"]` placed after `parse`, present only on a case whose events record it, so a message without a voice note keeps its seven steps and the "Step n of 7" announcement. **Corrected 2026-10-31 (at start):** `STEPS` is the always-drawn list and an unrecorded step is appended last as "Another step", so the step is inserted after `parse` by the reducer, not added to `STEPS`. Done when: `test/web/report-status.test.ts` stores the step's events and reads them through both `/r/:caseId` and `/r/:caseId/status`: `started` is running; `error` is retrying; a later `started` is running again; a later `done` is done, with its earlier error cleared, and progress then advances to `checks`; a final `failed` is failed with its error class; the step sits after `parse` in each; a case without it lists none and keeps seven steps; a voice case announces "Step n of 8". **Corrected 2026-10-31 (plan review P2):** the sequence was stated as "error then started is retrying", where the reducer reads the latest `started` as running and `retrying` is an error awaiting another attempt; and successful transcription was untested. The producer (D01 T03 §3, the checks lane's, not on this branch) is joined to the report by D07 T03 §49, filed for the real recording; this section proves the reducer and the routes from stored events (**plan review P1**). Cheaper substitute: an always-drawn step that sits waiting on every email case, or leaving it to the "Another step" fallback after Finished.
- [x] Word the three audio refusals in `errorWords` as the member's to fix, by channel (`came`, as §40): `CorruptAudio` ("The recording is damaged, so it could not be transcribed. Replace it and forward it again.", "upload it again" for an upload), `AudioTooLong` ("The recording is longer than 30 minutes, so it could not be transcribed. Shorten it to 30 minutes or less and forward it again."), `UnsupportedAudio` ("We cannot transcribe this recording's format. Send it as an Ogg, Opus, WAV or MP3 voice note."), none saying "on our side". Done when: the test checks each sentence for an email and an upload and that none matches the generic failure.
- [x] Offer the member's own next step, not a Retry, for these three (`gone` in `ReportLive`'s failed branch extends to them: the same recording would fail again): "Upload again" for an upload, "Upload it instead" for an email, no retry form. **Planned 2026-10-31 (at start):** as §40 for a file that never arrived. Done when: the test finds no retry form and the channel's label for each, and `Retry the check` still for any other failure except `RawMissing`, which keeps §40's own controls (an upload's "Upload again", an email's "Upload it instead", no retry), asserted again here for both channels. **Corrected 2026-10-31 (plan review P2):** "any other failure" ignored §40's exception.
- [x] Commit: `web: the report's progress shows the voice note's transcription`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts` passes with the transcribe step in each state and each audio refusal worded.

> **Unstamped:** 2026-11-01: the checkpoint result was recorded blank (the run was killed by the memory limit before it reported); restamping with the real passing run (revoked receipt `docs/reviews/d07-t03-s38.revoked-2026-11-01.json`)

> **Verified:** 2026-11-01 | §38 | 13d900890cdfa02dc0c74f7b877f110ab57771f5
> **Review:** `docs/reviews/d07-t03-s38.json`

## 39. Check versions in the report

> **Started:** 2026-11-02T08:45Z

> **Corrected 2026-11-02 (validation before build):** (1) The report's `Coverage` view type (`src/web/pages/report-live.tsx:25`) carries no `revision`; `readCheckOutcomes` (src/checks/evidence.ts:331) already returns `revision` when stored (D02 T01 §4), pinned to the run shown (`src/web/pages/report.tsx:209`), so the build carries the field through the view type, never a second read. (2) SPEC M3 names the count line but no "Check versions" control, and this section carried no SPEC step; one is added as the first checklist item (a surface the SPEC does not describe is not built).

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

- [x] Extend `design/SPEC.md` M3 with the "Check versions" disclosure (its control, states and wording) and record the operator's approval in the section. **Approved 2026-11-02 08:56 SAST (coordinator, overnight authority, interim, flagged for the operator's morning review).** Done when: M3 names the control and a `Deviation` records that the disclosure is absent from the approved boards (a board change goes back to the operator, so it is not edited here), `design/tools/check-design.py` passes, and the operator's approval is recorded in this section before any code. Cheaper substitute: building the disclosure with no SPEC entry. **Added 2026-11-02 (plan review P2):** the drafted extension covers terminal reports only: the running report's separate `Found` surface carries no versions, so M3 says "(Terminal reports)", never "All reports". Approval asked through the coordinator 2026-11-02 (the M8b route).
- [x] Add a "Check versions" disclosure to the count line in `src/web/pages/report-live.tsx` (a native `details`, keyboard-reachable), listing each stored outcome of the run shown with its `revision`, and "version not recorded" for an outcome stored before migration 0053 (`revision` absent). Done when: `test/web/report-status.test.ts` lists a revision and the not-recorded words for an older row, and `test/node/report-browser.test.tsx` opens it by keyboard. Cheaper substitute: one version for the whole report, which hides a check run by an older Worker. **Added 2026-11-02 (plan review P2):** when no outcomes are stored for the run (`coverage` null, a legacy case), the disclosure is not drawn at all (there is no list to version, and no checks are invented); the test asserts its absence beside the findings-only count line.
- [x] Show the selected run's versions once a case has more than one run (§20's retry): the list follows the run the report shows. Done when: a retried case lists the newer run's revisions and the test fails when it lists the first run's. Cheaper substitute: the latest run always, whatever is shown.
- [x] Commit: `web: the report lists each check's version`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts test/node/report-browser.test.tsx` passes with a revision, a not-recorded row and a retried run.

> **Verified:** 2026-11-02 | §39 | 95ac016ce6ee584d125aea8b48c14e838bc27cfb
> **Review:** `docs/reviews/d07-t03-s39.json`

## 40. Recovery words for a file that never arrived

> **Started:** 2026-10-31T21:23Z

Filed 2026-10-31 at the checks lane's request, from D01 T03 §12's completion review (`checks-s12b`). A case whose admission failed before its file was stored ends partial with its `admit` step failed with `RawMissing`; the report then says "The original message was not found in storage." (`errorWords`, `src/web/pages/report-progress.ts:65`) and offers "Upload it instead" (`src/web/pages/report-live.tsx:315`), even for an upload, where uploading was what the member did.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the partial state's recovery), board `Report-Running`
**Job:** a member whose file never arrived knows which file and what to do next
**Treatment:** the file named, the channel's own next step ("Upload again", "forward it again")
**Chrome:** the report's progress and failure panel (§4)

**Build order:**

1. Word the recovery by channel. Done when: an upload says "Upload again" naming its file, and an email says to forward it again.

- [x] Pass the case's stored upload name (`cases.upload_name`, `src/db/cases.ts`) to the live region as `uploadName` on `LiveProps` (`src/web/pages/report-live.tsx`) from both the page (`ReportBody`'s `stored`) and the status poll (`src/web/pages/report.tsx`). **Corrected 2026-10-31 (at start):** the live region receives no upload name today. Done when: the failed report for an upload names its file in the page and in the poll.
- [x] Word `RawMissing` by the case's channel in `errorWords` (`src/web/pages/report-progress.ts`, now taking the channel, the source kind and the upload name): an upload says "<name> did not arrive in full, so it could not be checked. Nothing was concluded about it." and an upload with no stored name says "The file did not arrive in full..." (the name drawn as text, wrapped anywhere); an email says "The message did not arrive in full, so it could not be checked. Nothing was concluded about it. Forward it again." Every other error keeps its words. Done when: `test/web/report-status.test.ts` stores a failed `admit` step with error class `RawMissing` (the event the pipeline already writes; D01 T03 §12, the checks lane's producer that makes such a case not count toward the cap, is not on this branch and is added as a dependency when it reaches it) for an email, a document, an image and an audio case, and reads each through both `/r/:caseId` and `/r/:caseId/status` with its own words, a hostile name drawn as text. **Planned 2026-10-31 (plan review P1):** the persisted event, through both routes, not a prop alone. Cheaper substitute: one sentence for every channel fails the test that reads each.
- [x] Offer the channel's own next step on a `RawMissing` failure in the failed branch of `ReportLive`: an upload gets "Upload again" to `/upload` (dark, the first action) and no "Retry the check", since the original is gone and a retry cannot succeed; an email keeps "Upload it instead" beside no Retry, with the forward-again words above. Every other failure keeps §20's controls. **Planned 2026-10-31 (at start):** the board's Retry belongs to failures a second run can mend. Done when: separate assertions in `test/web/report-status.test.ts`: an upload that failed with `RawMissing` has "Upload again" as its first action, no retry form and no "Upload it instead"; an email that failed with `RawMissing` has "Upload it instead" (the board's action, beside the forward-again words), no retry form and no "Upload again"; any case that failed with `ParseError` has "Retry the check" and "Upload it instead". **Corrected 2026-10-31 (plan review P2):** the assertions were stated together and contradicted the labels.
- [x] Check the failed upload's file name in the browser in `test/node/report-status-browser.test.tsx`: a 255-character unbroken name wraps inside the panel at 360 and 1280 px in both themes, with no sideways scroll, and the panel passes the accessibility gate's rules. Done when: the failed-upload variant is in the matrix and fails with the name's `wrap-anywhere` removed. **Planned 2026-10-31 (plan review P3):** a Worker test renders strings and proves no layout.
- [x] Commit: `web: a file that never arrived is named, with its own way to send it again`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/report-status.test.ts` and `pnpm exec vitest run test/node/report-status-browser.test.tsx` pass for the email, document, image and audio cases and the long name.

> **Verified:** 2026-10-31 | §40 | e39a00cd6c4d803dc49b808d9ed519db49fb89c6
> **Review:** `docs/reviews/d07-t03-s40.json`

## 41. Upload page usage after a failed upload

> **Started:** 2026-11-01T04:41Z

Filed 2026-10-31 at the checks lane's request, from D01 T03 §12's completion review. §12 makes a case whose admission failed (`RawMissing`) not count toward the daily cap, and counts the upload page's usage line by the same rule (`todayUsage`, `src/db/case-list.ts`, `COUNTS_TOWARD_CAP`, in §12 itself with this lane's agreement). This section proves it on the page the member sees (`src/web/pages/upload-view.tsx`, the usage line and the paused state).

**Corrected 2026-11-01** (from the plan review, `docs/reviews/07-app/D07-T03-s41.md`): the page draws the daily limit's paused state only from the 429 of an upload past the limit (`status === 429` in `src/web/pages/upload-view.tsx`; a fresh page at the limit stays ready), which is the design §6 recorded in `design/SPEC.md` M2, so this section proves that behaviour and builds no new page state; a failure leaves the slot available (no paused state, no limit warning, the file input usable) and the successful replacement legitimately uses it.

**Corrected 2026-11-01** (at start, checked against the repository; D01 T03 §12 is done on the checks lane and merged here): (1) the failure is made the way production makes it, by the raw store refusing the write during `POST /upload` (`env.ARTEFACTS.put` throwing for a `raw/` key), not by setting a step; (2) the upload page's usage line reads `todayUsage` (`src/db/case-list.ts`), which counts by `COUNTS_TOWARD_CAP` (`src/db/cases.ts`), so the test also proves the line and the database agree and fails when the failed case is counted; (3) the paused state is the `data-state="paused"` zone the page draws at the limit.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M2 (the upload page's usage line and paused state)
**Job:** a member whose upload failed is never told the day is used up by that failure
**Treatment:** the usage line and the paused state read the cap's own count
**Chrome:** the upload page (D01 T03 §6)

**Build order:**

1. Prove the page's count after a failure and its replacement. Done when: the failed last slot leaves the day available, its replacement uses it once, and the page never reads past the limit.

- [x] Add a page-level regression in `test/web/upload-page.test.ts`: with a daily limit of one, make the raw store refuse the write during `POST /upload` (`env.ARTEFACTS.put` throwing for a `raw/` key), so the case is kept `partial` with its `admit` step failed `RawMissing` (D01 T03 §12). Then read the page: "0 of 1", `data-state="ready"` (not paused), no "used all" or "paused" words, the file input usable; and `todayUsage` agrees. Upload the replacement: admitted (303), and a fresh page reads "1 of 1" (still `ready`: the page draws the paused state from the next upload's 429, as §6 designed it), never "2 of 1"; a further upload is answered 429 and drawn `paused` with "used all 1 checks", and `todayUsage` is `{ used: 1, limit: 1 }` throughout. Done when: the test passes on §12's count and fails when `COUNTS_TOWARD_CAP` counts the failed case. Cheaper substitute: the database count alone, which leaves the page unproven.
- [x] Commit: `test: the upload page's usage after a failed upload and its replacement`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/upload-page.test.ts` passes with the failure and its replacement.

> **Verified:** 2026-11-01 | §41 | 5c149180ee9b9e81b79a8478f4cbb4d40f457ba1
> **Review:** `docs/reviews/d07-t03-s41.json`

## 42. Uploader named alike in list and header

> **Started:** 2026-10-31T17:35Z

Filed 2026-10-31 for the production defect the media lane's captures found (app.isitlegit.co.za at 46e92188, org Fynbos Freight): every uploaded case read "Checked by: Not recorded" in the Cases list while its report header named the uploader. Built first, under the coordinator's priority, on `app-lane` in `fec2fa96`; this section carries it to its stamp. The list (`listCases`) matched a member by the forwarding address only and gave no checker to any case but email, while `checkerName` (the header's, §9) also matched the uploader's id.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 (the Cases list's Checked by) and M3 (the report header)
**Job:** a member sees who brought each case in, the same in the list and on the report
**Treatment:** one rule for both views
**Chrome:** the Cases list (D07 T04 §1), the report header (§9)

**Build order:**

1. Read who checked a case by one expression. Done when: an upload's uploader is named in the list and the header alike.

- [x] Prove that the Cases list and the report header name an upload's uploader alike (`test/web/cases-page.test.ts`, "names an upload's uploader alike in the list and the report header": `listCases`, `checkerName` and the page). Done when: the test passes on main's code. **Corrected 2026-10-31:** the list's fix reached main first, in the console lane's D07 T04 §7 (`60bf8799`), with its Former member and email rules, so `fec2fa96`'s `checkerSql` is not carried; one shared read for both views is the console lane's follow-up, agreed 2026-10-31, after which the header reads "Uploaded by a former member".
- [x] Serve both views from one read (`src/db/case-list.ts`, with the console lane's agreement): one SQL expression returning `Checker = { kind: "member"; name } | { kind: "former" } | null` (a current member by forwarding address or uploader id, `name` the trimmed name or the email when blank; `former` an upload whose uploader is no current member; `null` nothing recorded); `listCases` maps it to D07 T04 §7's strings and `checkerName` returns it (the type in `src/db/checker.ts`, free of Worker types, so the header renders in Node tests). Done when: D07 T04 §7's tests in `test/web/cases-page.test.ts` stay green and both views read the one expression. **Added 2026-10-31 (plan review P1).**
- [x] Draw the header from the same `Checker` (`src/web/pages/report-header.tsx`): "Uploaded by <name>", "Uploaded by a former member", "Uploaded"; never shown in the public signed-link view. Done when: one persisted upload, read through `/cases` and its report page, names the same checker for a named member, a blank name (the email), a removed member and no uploader, `test/web/report-access.test.ts` is reconciled to the shared rule, and the signed link shows none. Cheaper substitute: the list alone. **Added 2026-10-31 (plan review P2).**
- [x] Commit: `db: the Cases list names an upload's uploader by the report header's rule`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/cases-page.test.ts test/db/case-list.test.ts test/web/report-access.test.ts` passes with the upload named in both views.

> **Verified:** 2026-10-31 | §42 | c841d922fd4024b80fa32b7fbd8ded6a2199a031
> **Review:** `docs/reviews/d07-t03-s42.json`

## 43. Attribution on a phone's report

> **Started:** 2026-11-01T15:55Z

Filed 2026-10-31 from §42's completion review. On a phone the report's attribution ("Uploaded by", "Forwarded by") is hidden (`hidden md:block`, `src/web/pages/report-header.tsx`), and the phone's `MetaLine` carries the subject, sender and time only, so a phone reader cannot learn who brought the case in without going back to the Cases list. `Report-Mobile` draws no attribution, so showing it is a design change first.

> **Corrected 2026-11-01 (validation before build):** The operator chose option A (attribution under the subject), recorded in `design/SPEC.md` M3. On a phone the subject is the `MetaLine` itself (the title is screen-reader only), so the attribution is a second line directly under it, before the band, in reading order: the desktop header's own words (`arrivalOf`, §9 and §42: "Forwarded by <name>", "Forwarded as an attachment by <name>", "Uploaded by <name>", "Uploaded by a former member", "Uploaded"), the name in ink as the board draws it. `MetaLine` learns the view, since it is drawn for a link holder too and the attribution is a member's only; the desktop header is unchanged.

**Phase:** 6
**Needs:** none
**Surface:** yes

**Operator decision (2026-11-01 03:30 SAST, recorded in docs/coordinator.md):** built now, with a board and its `design/SPEC.md` entry for the operator's approval first. `owner-decision` is dropped; `operator` stays only as the approval of the board. **Board proposed 2026-11-01:** Report-Mobile-Attribution (option A recommended, B alternative), drawn in `design/mockups/proposed/` (outside the approved inventory, which `check-design.py` and `tests/scripts/test_design_spec.py` hold complete) with its SPEC entry and coverage written in that folder's README to apply on approval; nothing is built until the operator approves the phone attribution (the approval line is recorded in this section, and the board moves into `design/mockups/source/` and `approved.json` as that README says).

**Operator approval (2026-11-01 11:35 SAST, the operator asked directly, recorded in `docs/coordinator.md` on `coordinator-gate`):** the board is approved as drawn; it is imported into `design/mockups/source/` with its PNG, `approved.json` and `coverage.json` entries and the `design/SPEC.md` M3 lines (`python3 design/tools/check-design.py` passes). `operator` is removed from Needs.

Attribution approved: 2026-11-01 (Report-Mobile-Attribution, option A: under the subject)
**Fidelity:** `design/SPEC.md` M3 (board `Report-Mobile`), an attribution line added once decided
**Job:** a phone reader sees who brought the case in, as a desktop reader does
**Treatment:** to be decided: the attribution in the phone's line, or under the band
**Chrome:** the report header (§9), `MetaLine`

**Build order:**

1. Record the decision, then draw it. Done when: the operator's choice is in `design/SPEC.md` M3 and a 360 px report shows the attribution it names, concealed from link holders.

- [x] Ask the operator (through the coordinator) where a phone's report shows who brought the case in, and record it in `design/SPEC.md` M3 and the `Report-Mobile` board. Done when: the decision line is in the SPEC.
- [x] Draw the decided attribution in `src/web/pages/report-header.tsx` at phone widths, in the screen reader's reading order, never in the public view. Done when: `test/node/report-header-browser.test.tsx` finds it visible at 360 px for the member view (asserting visibility, not node count) and absent for a link holder. Cheaper substitute: counting nodes that are hidden.
- [x] Give `MetaLine` a `view` and draw the attribution as its second line for a member: `arrivalOf`'s words with the name in ink, phone only (`md:hidden`, never printed), the callers in `src/web/pages/report.tsx` and `src/web/pages/report-view.tsx` passing their view. Done when: the browser test below passes and a desktop report is unchanged. Cheaper substitute: unhiding the desktop line on a phone, which puts it above the subject in reading order.
- [x] Put the phone line where the board puts it: in `ReportLive` (`src/web/pages/report-live.tsx`) the meta element renders before the band in the running and failed branch and before the verdict section in the finished one (the desktop line is `md:hidden`, so no wide layout moves), surviving every status swap because each answer draws it there. Done when: `test/node/report-header-browser.test.tsx` finds the subject and attribution before the band in the DOM and on screen at 360 px, and `test/node/report-status-browser.test.tsx` still finds it after a poll. **Added 2026-11-01 (plan review P2).**
- [x] Prove every attribution at phone width: forwarded, forwarded as an attachment, uploaded by a named member, by a blank-named member (the email), by a former member, and with no uploader, each in `test/node/report-header-browser.test.tsx` at 360 px with the name visible; a link holder's initial and polled content without it; and no second attribution at 1280 px. Done when: the suite passes with the attribution line removed failing it. **Added 2026-11-01 (plan review P2).**
- [x] Commit: `web: a phone's report says who brought the case in`

**Test checkpoint:** `pnpm exec vitest run --project browser test/node/report-header-browser.test.tsx` and `pnpm exec vitest run --project worker test/web/report-access.test.ts` pass with the attribution visible at 360 px for a member and absent for a link holder.

> **Verified:** 2026-11-01 | §43 | aa8ef8d2fe1d1a11175858594ddec7f286d0fa72
> **Review:** `docs/reviews/d07-t03-s43.json`
## 44. Clean checks with their result summary

> **Started:** 2026-11-02T08:58Z

> **Corrected 2026-11-02 (validation before build):** (1) D02 T01 §7 is stamped (receipt `docs/reviews/d02-t01-s7.json`), so the dependency edge is added to the Implementation Order row now, and micro-step 1 is ticked by the resolve below. (2) The report's `Coverage` view type (`src/web/pages/report-live.tsx:24`) carries no `summary`; `readCheckOutcomes` returns `summary` only when stored (`src/checks/evidence.ts:359`), so the build carries the field through the view type, never a second read, and a hostile summary is stored text drawn as text.

Filed 2026-10-31 from D07 T03 §18's completion review: "Checks that found nothing" draws "<check words>: nothing found", where `Report-Safe` draws what each check saw ("Links: 1, to fynbosfreight.example", "Logo: matches the registered logo"), recorded as a deviation under `design/SPEC.md` M3. The checks lane stores each check's result summary in D02 T01 §7 (filed on checks-lane at 7dbb51f8, a nullable `check_outcomes.summary` of at most 120 characters, null for skipped and partial outcomes, read by `readCheckOutcomes`). This section draws it once that row reaches this branch; its dependency on D02 T01 §7 is added then, since the row does not resolve here yet.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the safe state's Checks that found nothing), board `Report-Safe`
**Job:** a reader of a safe report sees what each clean check looked at, not only that it found nothing
**Treatment:** the board's "<check>: <what it saw>" lines, in the same list
**Chrome:** `CleanChecks` in `src/web/pages/report-live.tsx` (§18)

**Build order:**

1. Draw the stored summary. Done when: a clean check with a summary reads "<words>: <summary>" and one without keeps "nothing found".

- [x] Add D02 T01 §7 to this section's dependencies once it resolves on this branch. Done when: `python3 scripts/todo-graph.py resolve 'D07 T03 §44'` names D02 T01 §7 as met. (2026-11-02: resolve names it, unmet empty.)
- [x] Read `summary` from `Coverage` in `CleanChecks` (`src/web/pages/report-live.tsx`) and draw "<check words>: <summary>", keeping "nothing found" for a null summary, the summary drawn as text. Done when: `test/web/evidence-cards.test.ts` draws a summary, keeps "nothing found" for null, and draws a hostile summary (`<script>`) as text. Cheaper substitute: drawing the summary for every outcome fails a test where a check with a finding carries one.
- [x] Remove the §18 deviation from `design/SPEC.md` M3 and check the list in `test/node/report-verdict-browser.test.tsx` at 360 and 1280 px in both themes with a 120-character summary. Done when: the deviation is gone and the matrix passes with no sideways scroll.
- [x] Commit: `web: clean checks say what they saw`

> **Resolved:** the lookalike check's clean words naming the domains it compared -> XREF: D02 T03 §12. Resolved 2026-11-04 by D02 T03 §12 in `55ae27be`: `lookalikeSummary` (`src/checks/domain-lookalike.ts`) names the count of compared domains and the first compared domain inside the 120-character summary bound.

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts test/web/report-status.test.ts` and `pnpm exec vitest run test/node/report-verdict-browser.test.tsx` pass with summaries read from storage.

> **Verified:** 2026-11-03 | §44 | 69e3f29bbddc1e7a61f90c9fa940effcf20da240
> **Review:** `docs/reviews/d07-t03-s44.json`

## 45. Unverified receiving chain on the auth card

> **Started:** 2026-11-02T10:12Z

> **Corrected 2026-11-02 (validation before build):** D02 T02 §6 is stamped and `chain-unverified` is stored (`src/checks/auth-results.ts:23`, `:122`); the dependency edge already names it (resolve: met), so micro-step 1 is ticked by that resolve. The card's `UNTRUSTED` map (`src/web/components/evidence/cards.tsx:211`) has no entry for it, so it falls back to "the results could not be read" today.

> **Corrected 2026-11-02 (plan review P2):** (1) "it clears on a later email" promises a recovery the producer does not guarantee (a DNS failure can recur, `src/auth/receiving-chains.ts`); the words now say a later email is looked up afresh. (2) The unknown-reason fallback "the results could not be read" invents a reading failure (reachable today: `chain-unsupported`, `src/checks/auth-results.ts:122`, has no card words); the fallback now states only that the results were not used, tested with an unrecognised reason and `chain-unsupported`.

Filed 2026-10-31 at the checks lane's request, from D02 T02 §6's completion review: `auth.results` stores a new untrusted reason, `chain-unverified` (the organisation's receiving chain is read from its own DNS, the claim's MX naming its filtering gateway and its records naming the mail provider, and those DNS records could not be read this time, so the provider's Authentication-Results header was not trusted; `UNTRUSTED` in `src/checks/auth-results.ts` on checks-lane, the redesign that superseded d4c55d30). **Corrected 2026-10-31:** the checks lane's round 1 moved chains off forwarded messages onto the organisation's DNS. The report's card (`UNTRUSTED` in `src/web/components/evidence/cards.tsx`) has no words for it and falls back to "the results could not be read", which tells the reader nothing true or useful. Its dependency on D02 T02 §6 is added once that row reaches this branch.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the evidence cards' authentication header excerpt), board `Main`
**Job:** a reader whose header could not be trusted this time learns it was a passing lookup failure on their side, not a sign about the sender
**Treatment:** one plain sentence on the card, apart from the other untrusted reasons
**Chrome:** the `auth` renderer in `src/web/components/evidence/cards.tsx` (§3)

**Build order:**

1. Word the reason. Done when: a `chain-unverified` card says what happened and that it should clear on a later case, and a `no-boundary` card keeps its own words.

- [x] Add D02 T02 §6 to this section's dependencies once it resolves on this branch. Done when: `python3 scripts/todo-graph.py resolve 'D07 T03 §45'` names D02 T02 §6 as met. (2026-11-02: resolve names it, unmet empty.)
- [x] Add `chain-unverified` to the card's `UNTRUSTED` words in `src/web/components/evidence/cards.tsx`: "Not used: your organisation's mail records could not be read this time, so your mail provider's results were not trusted. This is a passing lookup failure, not a sign about the sender, and a later email is looked up afresh." Done when: `test/web/evidence-cards.test.ts` draws a `chain-unverified` card with those words, a `no-boundary` card with its own, and an unknown reason (including `chain-unsupported`) still with the neutral fallback "Not used: the results were not used." Cheaper substitute: reusing `no-boundary`'s words fails the test that draws both.
- [x] Draw it in the browser at 360 and 1280 px in both themes in `test/node/evidence-cards-browser.test.tsx`, passing the accessibility gate's rules with no sideways scroll. Done when: the variant is in the matrix and passes.
- [x] Tell the checks lane, through the coordinator, that the words are in, so D02 T02 §6's `- Filed:` line closes. Done when: the message is sent with the commit. (Sent 2026-11-02 in the app outbox with this build's commit.)
- [x] Commit: `web: the auth card says when the receiving chain could not be verified`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts` and `pnpm exec vitest run test/node/evidence-cards-browser.test.tsx` pass with the new reason drawn.

> **Verified:** 2026-11-02 | §45 | 08e6c157c4b7844b8909b8339664cbe784d1613a
> **Review:** `docs/reviews/d07-t03-s45.json`

## 46. Subject locations on evidence cards

> **Started:** 2026-11-02T10:48Z

> **Corrected 2026-11-02 (validation before build):** D02 T05 §5 is stamped and both locations are stored (`src/checks/ai-instructions.ts:268`, `:270`; `src/checks/hidden-content.ts:92`); the dependency edge already names it (resolve: met), so micro-step 1 is ticked by that resolve. One `placeWords` function (`src/web/components/evidence/cards.tsx:732`) serves the AI-instruction renderer and the invisible-characters card, so two branches word both cards; an unknown location still returns null and draws no place.

Filed 2026-10-31 at the checks lane's request, from D02 T05 §5's plan review: `content.ai_instructions` and `content.hidden_text` items get two new locations, `subject` (an instruction in the subject) and `subject-hidden` (one spelled in invisible tag characters in the subject). The card's location wording in `src/web/components/evidence/cards.tsx` has no entry for either, so both read as an attachment. The checks lane writes "in the subject" and "in text hidden in the subject". Its dependency on D02 T05 §5 is added once that row reaches this branch.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the evidence cards' hidden text quoted), board `Main`
**Job:** a reader told an instruction sits in the email's subject is told it is the subject, not a file
**Treatment:** the card's existing location words, two more entries
**Chrome:** the hidden-text and AI-instruction renderers in `src/web/components/evidence/cards.tsx` (§3)

**Build order:**

1. Word the two locations. Done when: a `subject` item and a `subject-hidden` item each read their own words on both cards, and every existing location keeps its own.

- [x] Add D02 T05 §5 to this section's dependencies once it resolves on this branch. Done when: `python3 scripts/todo-graph.py resolve 'D07 T03 §46'` names D02 T05 §5 as met. (2026-11-02: resolve names it, unmet empty.)
- [x] Add the `subject` and `subject-hidden` locations to the location words in `src/web/components/evidence/cards.tsx`: "in the subject" and "in text hidden in the subject", for both `content.ai_instructions` and `content.hidden_text`. Done when: `test/web/evidence-cards.test.ts` draws both cards with each location and reads the words, draws an existing location with its own, and draws an unknown location without claiming an attachment. Cheaper substitute: leaving the fallback fails the test that reads "in the subject". **Added 2026-11-02 (plan review P2):** table-driven assertions for all six existing location forms (`visible`, `hidden`, `text`, `body`, `attachment:<name>`, `attachment-hidden:<name>`) on both cards with their exact wording kept, and an unknown location rendering no `Where` row on either card.
- [x] Draw the subject cards in the browser at 360 and 1280 px in both themes in `test/node/evidence-cards-browser.test.tsx`, passing the accessibility gate's rules with no sideways scroll, with a long subject quoted. Done when: the variant is in the matrix and passes.
- [x] Tell the checks lane that the words are in, so D02 T05 §5's `- Filed:` line closes. Done when: the message is sent with the commit. (Sent 2026-11-02 in the app outbox with the build commit.)
- [x] Commit: `web: the cards name a subject as the place an instruction sits`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/evidence-cards.test.ts` and `pnpm exec vitest run test/node/evidence-cards-browser.test.tsx` pass with both locations drawn.

> **Verified:** 2026-11-02 | §46 | 4db986491676a3a536c8b593b3150b57f04eca05
> **Review:** `docs/reviews/d07-t03-s46.json`

## 47. Previous attempt of a

Filed 2026-10-31 from D07 T03 §20's completion review: a retried report shows its current run alone (§20's default, so a reader never meets the failed run's failure or reply beside the new run's), though the earlier runs' events, outcomes and evidence are retained (D01 T01 §17 and §19). A member cannot look back at the attempt that failed. This section adds a separately designed way to reach the previous attempt, apart from the current investigation. It needs a drawn surface first: no board shows it, so the SPEC and a board come before any build.

**Phase:** 7
**Operator decision 2026-11-02:** Approve the previous-attempt view on M3 (prior time, outcome and evidence apart from the current run, within two actions), with D01 T01 section 20's attempt-history design.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (a new state, to be drawn)
**Job:** a member whose report was retried can see what the earlier attempt found and why it failed, within two actions, clearly apart from the current run
**Treatment:** to be designed; the current run stays the default
**Chrome:** to be named when the board is drawn

**Build order:**

1. Design the surface. Done when: a board and a SPEC state describe it and the owner approves them.
2. Build it from the retained runs. Done when: the previous attempt's time, outcome and evidence read apart from the current run's.

- [ ] Draw the previous-attempt view as a SPEC state and a board, filed as a design-source change before any code. Done when: the board and `design/SPEC.md` describe how a member reaches the previous attempt in at most two actions, with its time, outcome and evidence apart from the current run's, and the owner has approved them.
- [ ] Read the previous run's events, outcomes and evidence by run id (`readCaseEvents` pinned to a run in `src/db/case-progress.ts`, `readEvidence` and `readCheckOutcomes` with their `run` argument) and draw them in the approved view, for a member only. Done when: `test/web/report-retry.test.ts` retries a failed case and reads the first attempt's failure, outcomes and evidence apart from the current run's, and a link holder sees no way to it.
- [ ] Check the view in the browser at 360 and 1280 px in both themes, passing the accessibility gate's rules. Done when: the variant is in the matrix and passes.
- [ ] Commit: `web: a retried report lets a member see the previous attempt`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/report-retry.test.ts` and `pnpm exec vitest run test/node/report-status-browser.test.tsx` pass with the previous attempt read from its retained run.

## 48. A real failed admission through the report

> **Started:** 2026-11-01T04:41Z

Filed 2026-10-31 from D07 T03 §40's completion review: §40 words a file that never arrived and proves it from a stored failed `admit` step with error class `RawMissing`, set by hand in the test fixture. On this branch the real intake still removes a case whose file could not be stored (`src/intake/admit.ts`, `undo`) and throws, so no report is ever drawn for it; the checks lane's D01 T03 §12 changes that, keeping the case with its failed admit. This section proves the producer's real failed admission through both report routes once §12 reaches this branch, so §40's wording is shown to meet the case the producer actually stores. Its dependency on D01 T03 §12 is added then, since that row does not resolve here yet.

**Corrected 2026-11-01** (at start, checked against the repository): D01 T03 §12 is done and merged here, so the dependency item below is satisfied: the row resolves and `intake/admit.ts` keeps a case whose file never stored, ended `partial` with its `admit` step failed `RawMissing`; the failure is driven through the intake's own entry points (`admitDelivery` for an email, `POST /upload` for an upload) with the raw store refusing the write.

**Phase:** 3
**Needs:** none
**Surface:** no
**Fidelity:** `design/SPEC.md` M3 (the partial state's recovery)
**Job:** a member whose file never arrived really sees the recovery §40 words, from the case the intake actually keeps
**Treatment:** none (a test of the joined path)
**Chrome:** none

**Build order:**

1. Join the producer to the report. Done when: a real failed admission is read through the page and the poll with §40's words.

- [x] Add D01 T03 §12 to this section's dependencies once it resolves on this branch. Done when: `python3 scripts/todo-graph.py resolve 'D07 T03 §48'` names D01 T03 §12 as met.
- [x] Add a test in `test/web/report-status.test.ts` that drives the intake's own failed admission (the storage write failing, through `src/intake/admit.ts`, not a hand-set step) for an email and for an upload, then reads the kept case through `/r/:caseId` and `/r/:caseId/status` with §40's words for each channel, the upload naming its file. Done when: the test passes on §12's retained case and fails when the case is removed instead. Cheaper substitute: setting `partial` and `RawMissing` by hand, which is §40's fixture and leaves the producer unproven.
- [x] Commit: `test: a real failed admission through the report`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/report-status.test.ts` passes with the intake's failed admission read through both routes.

> **Verified:** 2026-11-01 | §48 | d65f7ab497ae7edbacfc528682a5e6f25bf4508c
> **Review:** `docs/reviews/d07-t03-s48.json`

## 49. A real voice note through the report

> **Started:** 2026-11-02T11:12Z

> **Corrected 2026-11-02 (validation before build):** D01 T03 §3 is stamped; the dependency edge already names it (resolve: met). The drive exists: `test/voice/transcribe-step.test.ts` runs the whole Workflow (`env.ANALYSIS`, Meta stubbed at `fetch`) over an uploaded voice note and reads the stored events; this section reuses that drive in `test/web/report-status.test.ts` with the report harness's own org, then reads both report routes, so the events the producer writes (not fixtures) carry §38's words.

Filed 2026-10-31 from D07 T03 §38's plan review: §38 proves the report's transcribe step from stored events, and no Workflow step writes them on this branch (D01 T03 §3, the checks lane's Muse Voice Transcribe client with chunking, records `transcribe` and the error classes `CorruptAudio`, `AudioTooLong` and `UnsupportedAudio`). This section proves the real producer's events through both report routes once §3 reaches this branch, so §38's words are shown to meet what the producer stores. Its dependency on D01 T03 §3 is added then, since that row does not resolve here yet.

**Phase:** 3
**Needs:** none
**Surface:** no
**Fidelity:** `design/SPEC.md` M3 (the running and failed states)
**Job:** a member who forwarded a voice note really sees it transcribed, or the fix for their recording, from what the Workflow stores
**Treatment:** none (a test of the joined path)
**Chrome:** none

**Build order:**

1. Join the producer to the report. Done when: a real voice note's stored events read through both routes with §38's steps and words.

- [x] Add D01 T03 §3 to this section's dependencies once it resolves on this branch. Done when: `python3 scripts/todo-graph.py resolve 'D07 T03 §49'` names D01 T03 §3 as met. (2026-11-02: resolve names it, unmet empty.)
- [x] Add a test in `test/web/report-status.test.ts` that runs the Workflow's own transcribe step (the producer, not hand-set events) on a good, a damaged, an overlong and an unsupported recording, and reads each case through `/r/:caseId` and `/r/:caseId/status` with §38's step and words. Done when: the test passes on the producer's events and fails when the step is not recorded. Cheaper substitute: hand-set events, which is §38's fixture and leaves the producer unproven. (2026-11-02: 42 passed in `test/web/report-status.test.ts`; the drive runs every Workflow before any sign-in, since a SELF dispatch moves step execution into the main isolate where the fetch stub does not apply.)
- [x] Commit: `test: a real voice note through the report`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/report-status.test.ts` passes with the Workflow's transcribe events read through both routes.

> **Verified:** 2026-11-02 | §49 | 941b7a32a69f9bb5c8bbb96529a32a14c2c8bb94
> **Review:** `docs/reviews/d07-t03-s49.json`

## 50. Mail refusal reason in the trace

Filed 2026-10-31 from D07 T03 §5's completion review: the model trace lists a case's mail with each send's status, attempts and last reason, but the intake's allowlist-refusal path stores `status = 'refused'` without its reason (`src/mail/smtp2go.ts`), so the panel cannot say why a send was refused. The reason is the mail producer's to store (the checks lane's D01 T02 §2 family); this section shows it in the trace once stored. Its dependency on that producer is added when it reaches this branch.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` report page, model trace section
**Job:** a member sees why a reply was not sent
**Treatment:** the refused send's reason in plain words in the existing mail row
**Chrome:** `TraceMail` in `src/web/components/model-trace.tsx` (§5)

**Build order:**

1. Show the stored reason. Done when: a refused send in the trace says why, in words.

- [ ] Ask the checks lane to store a refused send's reason in `mail_sends.error` (a short code) and add its section here as a dependency once it resolves. Done when: `python3 scripts/todo-graph.py resolve 'D07 T03 §50'` names the producer section as met.
- [ ] Word the stored refusal codes in `TraceMail`: each known code in plain words, an unknown one as a plain refusal, never the raw code. Done when: `test/web/model-trace.test.ts` renders each stored refusal code with its words and an unknown one without it, through the report route.
- [ ] Commit: `web: why a reply was refused, in the model trace`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/model-trace.test.ts` passes with a refused send's reason read from storage.

## 51. Walkthrough action to its

Filed 2026-10-31 from D07 T03 §5's completion review (out-of-scope excellence item): the trace lists the walkthrough agent's actions but offers no way from an action to the screenshot the walk kept for it (`walkthrough_actions.screenshot_key`, D04 T02 §3), where a comparator's tracing tool opens the observation's recorded context. Adding a control to the panel changes the designed surface, so the board is drawn and approved first.

**Phase:** 7
**Operator decision 2026-11-02:** Approve the action-to-screenshot control as designed (one activation, keyboard reachable, no canary values shown).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` report page, model trace section (a new control, to be drawn)
**Job:** an investigator opens the screenshot behind a walkthrough action in one activation
**Treatment:** to be designed; keyboard reachable, no canary values shown
**Chrome:** `ModelTracePanel` (§5), the authorised file route the evidence cards use

**Build order:**

1. Design the control. Done when: a board and a SPEC state describe it and the owner approves them.
2. Build it. Done when: an action with a retained screenshot opens it in one keyboard-accessible activation.

- [ ] Draw the action-to-screenshot control as a SPEC state and a board, filed as a design-source change before any code. Done when: the board and `design/SPEC.md` describe it and the owner has approved them.
- [ ] Read `screenshot_key` in `readModelTrace` and link each action that kept one through the evidence cards' authorised file route, for a member only. Done when: `test/web/model-trace.test.ts` links an action with a screenshot, offers none for an action without, and refuses another organisation's key.
- [ ] Check the control in the browser at 360 and 1280 px in both themes, passing the accessibility gate's rules. Done when: the variant is in the matrix and passes.
- [ ] Commit: `web: open the screenshot behind a walkthrough action`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/model-trace.test.ts` and `pnpm exec vitest run test/node/report-verdict-browser.test.tsx` pass with the screenshot opened from its action.

## 52. Report address from a

Filed 2026-11-01 from §48's completion review (out-of-scope gap): when an upload's file cannot be stored, the intake keeps the case partial with its failed `admit` step (D01 T03 §12) and §48 words its recovery on the report, but the upload route answers a generic 503 (`src/intake/upload.ts`) and the page offers a retry only; the member is never given the retained case's address, so the recovery panel is reached only by finding the case in their Cases list. The uploader is the case's own member, so its address is theirs to be given; the change adds a link to the approved upload page's failure alert, which is a change to an approved surface and so the operator's to approve first.

**Phase:** 7
**Operator decision 2026-11-02:** A 'See what happened' link in the failure alert to the partial case's report, the retry kept.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M2 (the upload page's alert for a storage failure), a link added once approved
**Job:** a member whose upload failed can open what was kept for it without searching the Cases list
**Treatment:** to be decided: a "See what happened" link in the failure alert, or the page redirecting to the report as it does for a success
**Chrome:** the upload page's alert (D01 T03 §6), the report's recovery panel (§48)

**Build order:**

1. Record the decision, then give the address. Done when: the operator's choice is in `design/SPEC.md` M2 and a failed upload's answer names the kept case's report, for the uploading member only.

- [ ] Ask the operator (through the coordinator): after a storage failure, show a link to the kept report in the alert, redirect to it, or neither; record the answer and its date in `design/SPEC.md` M2. Done when: the decision line is in the SPEC.
- [ ] Return the kept case's report address in the upload route's failure answer (`src/intake/upload.ts`, JSON and the page's form answer), only to the member who uploaded and only when a case was kept, never an address for a case that was not made. Done when: `test/intake/upload.test.ts` reads the address on a refused write for the uploader, and gets none for another member or when no case exists.
- [ ] Draw the decided link or redirect on the upload page (`src/web/pages/upload-view.tsx`, `src/web/client/app.ts`), keeping the retry. Done when: `test/web/upload-page.test.ts` and `test/node/upload-browser.test.tsx` show the link at 360 and 1280 px in both themes, reached by keyboard, with the retry still there.
- [ ] Commit: `web: the report address after a failed upload`

**Test checkpoint:** `pnpm exec vitest run --project worker test/intake/upload.test.ts test/web/upload-page.test.ts` and `pnpm exec vitest run --project browser test/node/upload-browser.test.tsx` pass with the address given to the uploader only.

## 53. One-action copy of headers

> **Started:** 2026-11-04T07:25:18.068914+00:00

Filed 2026-11-01 from §19's completion review (out-of-scope excellence item): the message preview's headers tab shows the headers as text, but a reader who wants them in another tool (a header analyser, a ticket) must select a long scrolling region by hand, which is slow on a phone, where Microsoft Defender for Office 365's email entity page has one Copy message header action. A copy action adds a control to the approved preview board, so the operator approves it first.

**Phase:** 7
**Operator decision 2026-11-02:** Approve 'Copy headers' in the headers tab footer beside download, announcing success or selecting the text on clipboard refusal.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the original message preview, `Report-MessagePreview`), a copy control added once approved
**Job:** a reader copies every stored header in one action and pastes it elsewhere
**Treatment:** a "Copy headers" button in the headers tab's footer beside the download, with its outcome announced and the text left selectable when the clipboard refuses
**Chrome:** the preview dialog's footer (§19), the shared `Button`

**Build order:**

1. Record the decision, then build the control. Done when: the operator's choice is in `design/SPEC.md` M3 and the headers tab copies its text in one keyboard-operable action.

- [ ] Record the existing operator approval of 2026-11-02 in `design/SPEC.md` M3 and the `Report-MessagePreview` board, export its reference and update coverage. Done when: the decision line and copy states are in the SPEC and `python3 design/tools/check-design.py` passes. Cheaper substitute: an unrecorded control outside the approved design.
- [ ] Add the copy action to the headers tab in `src/web/client/app.ts` (`openOriginal`): it retrieves every remaining bounded header slice supplied by §54 under the same access rule before writing the complete text to the clipboard, without requiring manual slice loading, announces "Headers copied" once, and on a refused clipboard selects the text and says so. Done when: `test/node/message-preview-browser.test.tsx` activates it by keyboard, reads the clipboard in Chromium and proves exact equality for stored headers longer than 200 KB, finds the announcement, and with the clipboard denied finds the region's text selected and the refusal announced.
- [ ] Keep the action hidden on the message tab and unavailable while headers load or are missing, empty or failed; guard asynchronous clipboard completion against tab changes and closing in `openOriginal`. Done when: browser tests prove no stale success or selection reaches another tab or a closed dialog, including phone width in both themes, and explicitly assert loading, missing, empty, failed reload after success, and recovery states. Cheaper substitute: copying a cached prior response during a new request.
- [ ] Commit: `web: copy the complete headers in one action`

**Test checkpoint:** `pnpm exec vitest run --project browser test/node/message-preview-browser.test.tsx` passes with the headers copied and the refusal handled.

**Plan self-review disposition (2026-11-04):** P1 accepted: complete copying depends on the bounded header retrieval in §54; added the dependency and long-header equality proof. P2 accepted: unavailable and recovery states now have explicit assertions. Section parked before implementation until §54 ships; no approval or stamp claimed.

## 54. All stored headers read in place

Filed 2026-11-01 from §19's completion review (out-of-scope excellence item): the preview cuts the headers at the same 200 KB as the body and sends the reader to the download for the rest, so a message with a very long received chain or large authentication fields cannot be investigated wholly in place, where Microsoft Defender for Office 365's email entity page documents the entire header. Reading past the approved initial limit changes how the approved preview behaves, so the operator decides it.

**Phase:** 7
**Operator decision 2026-11-02:** Bounded 'Show the next part' slices in place past the 200 KB preview, each slice bounded, to the end of the stored headers.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the original message preview), a "Show the rest" control added once approved
**Job:** a reader reads every stored header without downloading the message
**Treatment:** to be decided: the first 200 KB as now, then a "Show the next part" action loading the following slice, announced, each slice bounded
**Chrome:** the preview dialog (§19)

**Build order:**

1. Record the decision, then load the rest in bounded slices. Done when: the operator's choice is in `design/SPEC.md` M3 and a message whose headers pass the limit can be read to its end in the dialog.

- [ ] Ask the operator (through the coordinator): keep the 200 KB limit with the download as the way to the rest, or add progressive loading of the remaining headers; record the answer and its date in `design/SPEC.md` M3. Done when: the decision line is in the SPEC.
- [ ] Give the artefact route's `view=headers` an `offset` and return the next slice (still cut at a whole character, still under the report's access rule), and add the "Show the next part" action to the headers tab. Done when: `test/web/message-preview.test.ts` reads a header list over the limit in slices whose join equals the stored headers, and `test/node/message-preview-browser.test.tsx` loads the next slice by keyboard with the outcome announced and a superseded slice dropped.
- [ ] Commit: `web: read every stored header in place`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/message-preview.test.ts` and `pnpm exec vitest run --project browser test/node/message-preview-browser.test.tsx` pass with long headers read in slices.

## 55. A deadline on the full-size viewer's request

> **Started:** 2026-11-02T03:53Z

Filed 2026-11-01 from §19's completion review, which found the same weakness in §19's own dialog and fixed it there: the full-size evidence viewer's request (`src/web/client/app.ts`, `openViewer`, §8) and the preview classification have no deadline, so a response that never finishes leaves "Loading the screenshot at full size." indefinitely, with Try again offered only after a failure. §8 is stamped, so the fix is its own section.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the evidence viewer's loading and failure states, `Report-EvidenceViewer`), no new control: the existing failed-read state with Try again
**Job:** a reader whose full-size capture stalls gets the failed-read state with Try again after a bounded wait
**Treatment:** the viewer's existing temporary-failure words and Try again, shown after 15 seconds
**Chrome:** the viewer dialog (§8)

**Build order:**

1. Bound the request. Done when: a held viewer request ends in the failed-read state with Try again, which loads once the answer comes.

- [x] Give `openViewer`'s capture request and `classifyFailure` a 15-second deadline in `src/web/client/app.ts` (`data-deadline-ms` on the opener shortens it for a test), aborting the request and showing the temporary-failure state with Try again; a deadline never fires after the reader closed or retried. Done when: `test/node/evidence-viewer-browser.test.tsx` holds the capture's answer past a 300 ms deadline, finds the failed-read words and Try again, releases the answer and finds Try again load the capture, and a mutation removing the deadline fails it. **Added 2026-11-02 (plan review P2):** (1) the deadline stays armed through body consumption (`answer.blob()`), not just headers, by mirroring the reviewed §19 pattern; a headers-then-stalled-body stall cannot be staged in this harness (the browser launches behind a dead proxy so no real server is reachable, a route stub answers whole, a worker script bypasses stubs: all verified), so the held-answer test covers the stall and the placement rests on the §19 precedent; (2) `classifyFailure` gets its own browser case: the preview fails and the classification request stalls, the card reaches the bounded temporary-failure state with a working Try again, and removing only the classification deadline fails that test; (3) cancellation is observable: closing and reopening before the old deadline leaves one request out, and the old response, arriving late, neither replaces the capture nor introduces failure words nor moves focus.
- [x] Commit: `web: a deadline on the full-size viewer's request`

**Test checkpoint:** `pnpm exec vitest run --project browser test/node/evidence-viewer-browser.test.tsx` passes with the stalled request given up.

> **Verified:** 2026-11-02 | §55 | 64f650cdd2ac90b822849066cf5a6bc5342ff37f
> **Review:** `docs/reviews/d07-t03-s55.json`

## Verification

- Fixture cases in every state render to the SPEC with working evidence cards, model trace and feedback, at phone and desktop widths, with no accessibility violations.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
