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
| 3 | §3 | Evidence cards by kind | §2, D02 T01 §1 | [ ] |
| 4 | §4 | Live status, partial and failed states | §2 | [ ] |
| 5 | §5 | Model trace panel | §2, D03 T01 §3 | [ ] |
| 6 | §6 | This-was-wrong feedback | §2 | [ ] |
| 7 | §7 | Reply email matched to the report design | §2, D01 T02 §3 | [ ] |
| 8 | §8 | Full-size evidence viewer | §3 | [ ] |
| 9 | §9 | Report header | §1, D01 T01 §16 | [ ] |
| 10 | §10 | Stored verdict sentence, reasons | §2, D04 T01 §2 | [ ] |
| 11 | §11 | Follow-up question from the report | §2 | [ ] |
| 12 | §12 | Reputation cards | §3, D02 T06 §4 | [ ] |
| 13 | §13 | Link and walkthrough cards | §3, D02 T07 §3, D04 T02 §5 | [ ] |
| 14 | §14 | Vision and brand cards | §3, D03 T02 §3, D03 T02 §4, D03 T03 §3 | [ ] |
| 15 | §15 | Invoice and document cards | §3, D06 T01 §1, D06 T02 §2 | [ ] |
| 16 | §16 | Voice cards | §3, D01 T03 §4 | [ ] |
| 17 | §17 | Trust and verification cards | §3, D05 T02 §3, D05 T03 §2 | [ ] |

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
> **Deferred:** "This verdict is wrong" in the footer -> XREF: §6
- [x] Add a print stylesheet hiding navigation and expanding evidence cards (**Corrected 2026-10-30** at build: `print:hidden` on the shell's sidebars and phone header and `print:ml-0` on its main column, `src/web/components/AppShell.tsx`, the shell owning its own print; the cards §3 adds expand there). Done when: `test/node/report-browser.test.tsx` emulates print media in Chromium on a multipage fixture in both themes and finds the case heading, state and every evidence summary visible and unclipped, and no navigation. **Corrected 2026-10-30 (plan review P2):** "no navigation text" passed a blank page; the cards §3 adds carry their own print check there.
- [x] Set `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`. Done when: the test reads both headers.
- [x] Add the report's phone back link to Cases per `Report-Mobile` (a link to `/cases` above the report title at phone width, for a signed-in member only; the public frame shows none). Done when: `test/node/report-browser.test.tsx` at 360 and 1280 px in both themes finds the link visible and reached by Tab for a member and absent from the signed-link view, long evidence summaries wrapping without sideways scroll, and the composed page passing axe-core with the A11y gate's rules. **Corrected 2026-10-30 (plan review P2):** markup alone passed a hidden link. (Assigned by D07 T01 §3's plan review, 2026-10-27.)
> **Deferred:** the report header (subject, sender, who forwarded it and when, Download PDF, Copy link; SPEC M3 anatomy) -> XREF: §9
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

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 evidence cards, boards `Main`, `Report-Safe`, `Report-Partial`, `Report-Mobile`
**Job:** a sceptical reader sees exactly why IsItLegit said what it said
**Treatment:** one card shape, the artefact as proof, severity by icon and word
**Chrome:** `EvidenceCard` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build one renderer per evidence family. Done when: a fixture with every family renders every card.

- [ ] Draw each evidence item as an `EvidenceCard` in `src/web/components/evidence/`, through one renderer per family that exists: `intake` (how the original arrived, other originals not checked, the uploaded file, the cut body parts), `auth` (the authentication header excerpt from the receiver's own `Authentication-Results`, with the results kept), `sender` (display address, display brand, reply-to, return path, first-time sender), `domain` (the lookalike and the domain's registration date from RDAP), `attachment` (type mismatch, executable, macro, encrypted archive, HTML attachment, and an attachment that could not be read), `content` (the hidden text quoted, with its count and reasons) and `not_checked` (the check that did not run and why, shown as Not checked). The renderers read each check's own `detail` fields (`src/checks/*.ts`), and a stored item whose check has no renderer draws the plain card (severity and summary). Done when: `test/web/evidence-cards.test.ts` draws a fixture of each registered check (`checks.names()`) through its family's renderer and fails when a registered check's family has none, and an item with an unknown check name draws the plain card.
- [ ] Replace the report's evidence list with the cards, keeping the `e<n>` anchors the reasons' pills follow, under the "Evidence" heading with its count line ("9 findings · 8 checks ran · nothing skipped", M3). Done when: the report test follows each reason's pill to its card, and the count line counts findings, checks run and checks skipped from the stored items.
- [ ] Serve artefacts through `GET /a/:caseId/:key` with the same access rule as the report (a member of the case's organisation or a valid signed link for that case) and the report's private headers. Only images are served `Content-Disposition: inline` with their own image type, and everything else as an attachment typed `text/plain`. A key that does not belong to the case is a 404. Done when: another organisation's request gets 404, an HTML artefact is served as `text/plain`, and a key of another case gets 404.
- [ ] Order cards by severity, then by the order the verdict's reasons cite them, then by id. Done when: the test checks the order for a fixture with ties.
- [ ] Show an evidence item whose stored object is gone as unavailable, not broken (**added 2026-10-27**, D01 T01 §2's completion review): `readArtefact` answers `missing` for a raw object past the 30-day rule (D00 T01 §5), and the card says the original file was deleted after 30 days for privacy while the finding and the verdict stay readable; a `StoreError` with code `storage` is shown as a temporary failure to retry, never as expiry. Done when: `test/web/evidence-cards.test.ts` renders a missing attachment as expired with the report still whole, and a storage failure as retryable.
- [ ] Prove the cards in Chromium at 360 px and 1280 px in light and dark: no sideways scroll with a long domain or file name, axe clean, a reason's pill focusing its card. Done when: `test/node/evidence-cards-browser.test.tsx` passes.
- [ ] Commit: `web: evidence cards by kind`

**Test checkpoint:** `pnpm exec vitest run test/web/evidence-cards.test.ts` passes and fails if an HTML artefact is served as HTML.

## 4. Live status, partial and failed states

While a case runs, the report shows progress by step and updates itself (htmx polling every 2 seconds, stopping when done); a partial case names what could not run and what that means; a failed case says so plainly and offers to retry (manifesto Reliability: no silent failure).

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

- [ ] Write `GET /r/:caseId/status` returning the step list fragment, polled with `hx-trigger="every 2s"` until `done`, `partial` or `failed`. Done when: `test/web/report-status.test.ts` sees polling stop.
- [ ] Render partial cases with `PartialNotice` naming the steps that did not run and that the verdict is based on what did. Done when: the partial fixture shows it.
- [ ] Announce each state change of a running report once through a polite live region outside the polled fragment (`LoadingState`, D07 T01 §8): the step that started, then the terminal outcome (verdict, partial or failed) by the next 2 s poll, with no repeat on an unchanged poll and keyboard focus kept where it was. Done when: `test/web/report-status.test.ts` drives a running fixture to done, partial and failed and finds each announcement once in order, none on unchanged polls, and focus unmoved. Cheaper substitute: making the swapped fragment itself live, which re-announces every poll. **Added 2026-10-30** (D07 T01 §8 completion review G8; Fluent 2 wait guidance announces state changes).
- [ ] Render failed cases with a retry button for members (re-runs the Workflow for that case once). Done when: the retry creates one new instance and a second click is refused while it runs. (**Noted 2026-10-28**, D01 T01 §7's completion review: the Workflow's `admit` step skips a `done` or `partial` case so a finished case is never analysed twice, so a retry must first return the case to a state `admit` takes, through a lifecycle move `src/db/cases.ts` does not allow yet, and record it; a new instance alone would end at `admit`.)
- [ ] Commit: `web: live status, partial and failed states`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts` passes and fails if polling continues after `done`.

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

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` report page, feedback control
**Job:** a member tells IsItLegit it got one wrong, without effort
**Treatment:** one button, an optional note, a thank-you that says what happens next
**Chrome:** `Button`, `Field` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Add `feedback` and the control. Done when: a member submits feedback and the case is unchanged.

- [ ] Add migration `0015_feedback.sql` with `feedback` (`case_id`, `user_id`, `kind` false_alarm or missed, `note`, `providers_json`, `created_at`). Done when: it applies locally.
- [ ] Build the control with a choice (it is safe, it is a scam) and an optional note, posting with htmx. Done when: `test/web/feedback.test.ts` submits both kinds.
- [ ] Record the providers of `reputation.listing` items the verdict cited. Done when: a listing fixture stores the provider.
- [ ] Notify the operator of each feedback with a `notice` mail (summary and case link only). Done when: the test sees one notice.
- [ ] Commit: `web: this-was-wrong feedback`

**Test checkpoint:** `pnpm exec vitest run test/web/feedback.test.ts` passes and fails if feedback changes the stored verdict.

## 7. Reply email matched to the report design

The reply (D01 T02 §3) gets the SPEC's email design: HTML with inline styles from tokens (email clients ignore stylesheets), the verdict colour band, reasons, actions and the report button, plus a plain-text part that reads well alone.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` reply email
**Job:** a member reads the answer in their mail app without opening anything else
**Treatment:** the report's first screen as an email, working in Outlook, Gmail and Apple Mail
**Chrome:** the email layout defined in `design/SPEC.md`

**Build order:**

1. Build the HTML template from tokens. Done when: the reply snapshot matches the SPEC and has no external CSS.
2. Check rendering. Done when: the HTML passes an email-safety lint (no flex or grid, tables for layout, alt text on images).

- [ ] Build `src/mail/templates/reply.tsx` rendering to an HTML string with inline styles from the token values. Done when: `test/mail/reply-design.test.ts` snapshots it.
- [ ] Lint the HTML for unsupported email CSS and missing alt text. Done when: the lint passes and fails on a planted `display:flex`.
- [ ] Keep the plain-text part complete (verdict, reasons, actions, link). Done when: the text snapshot holds all four.
- [ ] Commit: `mail: reply email matched to the report design`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply-design.test.ts` passes.

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

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 (the header), boards `Main`, `Report-Mobile`
**Job:** a member sees which message the report is about before reading the verdict, and can keep or share it
**Treatment:** the subject as the title, the sender and forwarder in plain words, two quiet actions
**Chrome:** `AppShell`, `Button` and the copy group (D07 T01 §3, §6, §9)

**Build order:**

1. Draw the header from the stored subject and sender. Done when: each fixture's header shows its message.

- [ ] Read the case's subject, sender and forwarder from the columns intake stores (the D01 row) and draw the header above the verdict: the breadcrumb "Cases / <subject>" for a member, the subject as the `h1` (wrapping anywhere), "From <name> <address>", "Forwarded as an attachment by <name> · <SAST time>", Download PDF (the browser's print to PDF, §1's print stylesheet) and Copy link (the copy group with the report's own link). Done when: `test/web/report-access.test.ts` finds each part for an emailed and an uploaded fixture, and a hostile subject (markup, a 2,000-character line) renders as text and wraps. Cheaper substitute: the case id as the title.
- [ ] Commit: `web: the report header`

**Test checkpoint:** `pnpm exec vitest run test/web/report-access.test.ts` passes with the header drawn from stored fields for an emailed and an uploaded case.

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

## Verification

- Fixture cases in every state render to the SPEC with working evidence cards, model trace and feedback, at phone and desktop widths, with no accessibility violations.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
