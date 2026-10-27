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

## Outcome

- A malicious, a safe, a partial and a running fixture case each render to the SPEC at 360 px and 1280 px with no accessibility violations.
- The model trace lists every model call for the case from `case_events`; nothing in it is typed by hand.
- "This was wrong" stores feedback that the eval and provider statistics read.

**Adjacency:** list=applicable @ D07 T04 §1; document=applicable @ D07 T03 §1; settings=not-applicable (the report has no tunables); reporting=applicable @ D08 T02 §2; notifications=applicable @ D07 T03 §7; permissions=applicable @ D07 T03 §1; audit=applicable @ D07 T03 §5; exchange=applicable @ D07 T03 §1; reverse=applicable @ D07 T03 §6

**Adjacency rationale:** The report is the case's document, opened by signed link or session (permission) and printable to PDF (exchange). The reply email is its notification; the model trace is its visible audit; feedback is how a member reverses a wrong verdict, recorded without editing evidence.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Report route with signed-link and session access | D07 T01 §10, D01 T01 §8 | [ ] |
| 2 | §2 | Verdict banner, headline, reasons and actions | §1 | [ ] |
| 3 | §3 | Evidence cards by kind | §2, D02 T01 §1 | [ ] |
| 4 | §4 | Live status, partial and failed states | §2 | [ ] |
| 5 | §5 | Model trace panel | §2, D03 T01 §3 | [ ] |
| 6 | §6 | This-was-wrong feedback | §2 | [ ] |
| 7 | §7 | Reply email matched to the report design | §2, D01 T02 §3 | [ ] |

## 1. Report route with signed-link and session access

`GET /r/:caseId` serves the report to a valid signed link (no session needed) or to a signed-in member of the case's organisation; anything else gets a 404 that reveals nothing (spec 4.8). A print stylesheet makes the report save cleanly as PDF.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` report page
**Job:** a member who forwarded a mail opens the answer from the reply in one tap
**Treatment:** verdict first, nothing private to anyone outside the organisation
**Chrome:** `AppShell` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the route and access rule. Done when: tests cover signed link, member session, other organisation and tampered link.
2. Add the print stylesheet. Done when: the report prints to PDF without the shell's navigation.

- [ ] Write `GET /r/:caseId` in `src/web/pages/report.tsx` accepting a valid `verifyReportLink` or a session with `requireOrg` matching the case. Done when: `test/web/report-access.test.ts` covers the four cases, all failures returning the same 404. Cheaper substitute: case ids as the only secret.
- [ ] Load the case, verdict and evidence with one query each, scoped to the organisation. Done when: the test counts queries.
- [ ] Add a print stylesheet hiding navigation and expanding evidence cards. Done when: a Browser Run PDF render of a fixture has no navigation text.
- [ ] Set `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`. Done when: the test reads both headers.
- [ ] Add the report's phone back link to Cases per `Report-Mobile` (a link to `/cases` above the report title at phone width, for a signed-in member only; the public frame shows none). Done when: a test renders the report at 360 px for a member and finds the link to `/cases`, and renders the signed-link view and finds none. (Assigned by D07 T01 §3's plan review, 2026-10-27.)
- [ ] Commit: `web: report route with signed-link and session access`

**Test checkpoint:** `pnpm exec vitest run test/web/report-access.test.ts` passes and fails if another organisation's member can open the case.

## 2. Verdict banner, headline, reasons and actions

The top of the report answers the question in a glance (spec 4.7, manifesto): verdict badge, headline, up to three reasons each linked to its evidence card, and what to do now (the fixed actions for invoices and POPs included). Confidence is shown in words, not a raw number.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` report page, verdict section
**Job:** a busy owner knows within five seconds whether to act and what to do
**Treatment:** verdict, reasons, action, in that order, in plain words
**Chrome:** `VerdictBadge`, `Button` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the verdict section. Done when: malicious, suspicious and safe fixtures render to the SPEC.

- [ ] Render the `VerdictBadge`, headline and confidence words (high, medium, low from the agent's confidence bands) in `src/web/components/verdict.tsx`. Done when: `test/web/verdict.test.ts` checks each verdict.
- [ ] Render up to three reasons, each with an anchor to its `E<n>` card. Done when: each reason links to an existing card id.
- [ ] Render the actions list, with the fixed invoice and POP actions in a highlighted block. Done when: the tampered invoice fixture shows the phone-the-supplier action first.
- [ ] Commit: `web: verdict banner, reasons and actions`

**Test checkpoint:** `pnpm exec vitest run test/web/verdict.test.ts` passes and fails if a reason links to a missing card.

## 3. Evidence cards by kind

Each evidence item is a card with its severity, summary and artefact (spec 4.7): header excerpt, rendered screenshot, logo crop beside the reference, link chain, walkthrough page chain with the credential target, invoice fields (masked), reputation listing with source, date and delisting link, voice quotes, verification request and answer, and "not checked" items explaining the gap.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` report page, evidence card variants
**Job:** a sceptical reader sees exactly why IsItLegit said what it said
**Treatment:** one card shape, the artefact as proof, severity by icon and word
**Chrome:** `EvidenceCard` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build one renderer per evidence family. Done when: a fixture with every family renders every card.

- [ ] Map each `check` prefix (`auth`, `sender`, `domain`, `attachment`, `content`, `reputation`, `link`, `vision`, `brand`, `walkthrough`, `invoice`, `document`, `voice`, `trust`, `verification`, `not_checked`) to a card renderer in `src/web/components/evidence/`. Done when: `test/web/evidence-cards.test.ts` renders a fixture containing each and fails on an unmapped prefix.
- [ ] Serve artefacts through `GET /a/:caseId/:key` with the same access rule as the report and `Content-Disposition: inline` for images only. Done when: another organisation's request gets 404 and an HTML artefact is served as `text/plain`.
- [ ] Render reputation cards with provider, what was listed, when, and the delisting link (spec 4.3a). Done when: the listing fixture shows all four.
- [ ] Order cards by severity, then by the order the verdict cites them. Done when: the test checks the order.
- [ ] Show an evidence item whose stored object is gone as unavailable, not broken (**added 2026-10-27**, D01 T01 §2's completion review): `readArtefact` answers `missing` for a raw object past the 30-day rule (D00 T01 §5), and the card says the original file was deleted after 30 days for privacy while the finding and the verdict stay readable; a `StoreError` with code `storage` is shown as a temporary failure to retry, never as expiry. Done when: `test/web/evidence-cards.test.ts` renders a missing attachment as expired with the report still whole, and a storage failure as retryable.
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
- [ ] Render failed cases with a retry button for members (re-runs the Workflow for that case once). Done when: the retry creates one new instance and a second click is refused while it runs.
- [ ] Commit: `web: live status, partial and failed states`

**Test checkpoint:** `pnpm exec vitest run test/web/report-status.test.ts` passes and fails if polling continues after `done`.

## 5. Model trace panel

The judges and members see the models at work, from real pipeline events (plan Day 8): each Meta model call with step, model, time, cost, cache hit, and tool calls for the agent, plus the case's total time and cost. Nothing is typed by hand; the demo uses the same panel.

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

## Verification

- Fixture cases in every state render to the SPEC with working evidence cards, model trace and feedback, at phone and desktop widths, with no accessibility violations.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
