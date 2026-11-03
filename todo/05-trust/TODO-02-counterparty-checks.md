---
schema_version: 1
id: counterparty-checks
domain: 05-trust
status: active
title: "TODO-02 -- Counterparty Checks and Impersonation Alerts"
track: day-5
---

# TODO-02 -- Counterparty Checks and Impersonation Alerts

> **Goal:** Anyone can forward mail that claims to be a protected business to `check@isitlegit.co.za` without an account; IsItLegit detects the claim (display name, domain, logo, signature, voice claim), compares the mail with the registered identity without revealing any registered detail, replies with the verdict and a "Protected by IsItLegit" line, and alerts the protected business with the evidence.

> **Current state:** Measured 2026-10-26 20:00 SAST. The email handler admits members only (D01 T01 §3). Identities come from D05 T01.

## Inputs

- Design spec 2a (counterparty checks, impersonation alerts, privacy rules, rate limits), 2b (growth loop), 11 (Outbound: during the event alerts go only to demo businesses whose contacts are aliases).
- -> XREF: D05 T01 §2 -- the match-only registry this file compares against
- -> XREF: D03 T03 §3 -- the logo comparison used against the registered logo
- -> XREF: D07 T03 §7 -- the reply email's template (`src/mail/templates/reply.ts`), whose counterparty variant (`Email-Reply-Counterparty`) §5 draws

## Outcome

- The demo case works: the fictional courier forwards a fake "Fynbos Freight" statement request from a free mailbox; the courier gets "impersonation" back, and the alias for Fynbos Freight receives an alert with the evidence.
- A counterparty sender is limited to 5 checks a day and a protected identity to 50 checks a day about it; registered details never appear in a reply.

**Adjacency:** list=applicable @ D07 T04 §1; document=applicable @ D07 T03 §1; settings=not-applicable (rate limits are fixed in code from spec 2a); reporting=applicable @ D07 T04 §2; notifications=applicable @ D05 T02 §4; permissions=applicable @ D05 T02 §1; audit=applicable @ D05 T01 §2; exchange=not-applicable (nothing is imported or exported); reverse=not-applicable (an alert cannot be unsent; a false alert is disputed through feedback, D07 T03 §6)

**Adjacency rationale:** Counterparty cases appear in the protected business's console as impersonation attempts; the alert is the notification; the counterparty gate and its rate limits are the permission boundary.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Counterparty intake path with rate limits | D05 T01 §1, D01 T01 §3, D07 T08 §8 | [x] |
| 2 | §2 | Claims found: name, domain, logo, | §1, D03 T03 §3, D02 T01 §9 | [x] |
| 3 | §3 | Registry comparison evidence that | §2, D05 T01 §2 | [ ] |
| 4 | §4 | Impersonation alert to the protected business | §3, D01 T02 §2 | [ ] |
| 5 | §5 | Counterparty reply with the protected line | §3, D01 T02 §3 | [ ] |
| 6 | §6 | Verify-this-email page for a protected business | §1, D05 T01 §3 | [x] |
| 7 | §7 | Live signature badge and its copy-paste snippet | §6 | [x] |
| 8 | §8 | Copied-badge detection and alerts | §4, §7 | [ ] |
| 9 | §9 | Domain-locked website seal | §6, §8 | [ ] |
| 10 | §10 | Signature badge checked in real mail editors | §7 | [x] |
| 11 | §11 | Workflow and global registry wiring for claims | §2, D07 T03 §17 | [ ] |
| 12 | §12 | Claim-aware candidate selection before bounds | §2, D02 T01 §9 | [ ] |
| 13 | §13 | Comparative impersonation and logo ablation | §2, D08 T02 §3 | [ ] |

## 1. Counterparty intake path with rate limits

Mail from a non-member is accepted only when it carries a forwarded original that claims a protected identity (display name or domain match in `findIdentityByClaim`); anything else from a non-member is still dropped silently. Limits stop enumeration and abuse (spec 2a).

> **Started:** 2026-10-31T16:38Z
>
> Started corrected 2026-10-31 (coordinator): first recorded at 7c89740b before the at-start corrections; no build happened before e0d0a301, the reviewed contract.

**Corrected 2026-10-31** (at start, checked against the repository): (1) `cases.channel` admits only `email` and `upload` (`0001_core.sql`) and stays the honest transport; a counterparty case is marked by a new nullable column added in migration `0054_counterparty.sql` (the coordinator's number, 2026-10-31 18:35 SAST), `cases.origin TEXT CHECK (origin IS NULL OR origin IN ('counterparty'))`, additive only: `cases` is the parent of evidence, check outcomes, case events and intake messages on delete cascade, and a rebuild's implicit delete would wipe every case's findings, so the table is never rebuilt, and a migration test proves existing cases and their evidence untouched (counts before and after, as 0051's did); (2) the Worker has no KV binding, so the limits count in a D1 table with one atomic upsert per bucket, as the bank limiter does (`bank_match_counts`, D05 T01 §2), in fixed daily windows (SAST days, as the cap notice counts them); (3) the claim is read from the forwarded original found by `extractOriginal` (`src/intake/forward.ts`): its From display name and From domain go to `findIdentityByClaim`, never the forwarder's own, and a forward with no attached original (an inline forward) claims nothing and is dropped; (4) the forwarder, not a member, must authenticate for its own domain (`senderAuthenticated` with `domain`), so neither the per-sender limit nor the reply can be driven by a forged address: an unauthenticated non-member is dropped silently, as now; (5) more than one protected identity can match a claim: the case goes to each match only when exactly one matches, else it is dropped and logged as ambiguous, since a counterparty check answers about one business; (6) the staff-inbox item is decided by the coordinator (2026-10-31 18:36 SAST) from `design/SPEC.md` S5 and its line 807: "Free check" is a plan tier (up to 5 checks a day), not a path for mail with no organisation, so an organisation without `staff-inbox` (Free, or an expired trial) still has its members' forwards filed to it, as Free check cases within the Free tier's daily cap, with the existing daily-cap notice beyond it, and only the features `staff-inbox` adds are off; nothing is dropped and no per-sender product is invented. The cap comes from where intake already reads it (`org_limits.daily_cases`, `admitCase` in `src/db/cases.ts`); no code yet ties a plan tier to its cap, so that row is asked of its owner (D07 T08, the plan pages) through the coordinator, and this item depends on it once named.

**Corrected 2026-10-31** (plan review, 3 P1 and 3 P2, `docs/reviews/05-trust/D05-T02-s1.md`): (7) the tier cap is D07 T08 §8 (the console lane, Phase 5, `dailyCapSql` in `src/auth/plan-sql.ts`), added to this section's dependencies as soon as it is on main and in this branch (the graph cannot name it before), and the staff-inbox item's tests use that real cap, including a trial that expires on its own, never a seeded `daily_cases` alone; (8) the two budgets are independent: a counterparty case belongs to the protected organisation but never counts against that organisation's daily cap (`admitCase` counts only cases whose `origin` is null), and counterparty cases are held only by their own per-sender and per-identity limits, so outside checks cannot exhaust staff checks or the reverse; (9) the gate admits a non-member's forward on a display-name or From-domain claim only, the two read before admission: a logo, signature, voice or copied-badge claim needs the parsed and analysed case (§2, §8), so it applies to cases already admitted (members' mail, and counterparty mail admitted on a name or domain claim), and a non-member forward claiming only by those is not admitted; admitting every non-member message to look for them would make every stranger's mail a free check; §2 and §8 state this scope; (10) the limit counters follow `admitDelivery`'s lifecycle: a slot is taken inside the admission and given back when it is undone (failed storage, failed Workflow creation), a duplicate delivery takes no slot, and both buckets are taken together or neither; (11) the one reply's permission is bound to the case and travels the real sending path: the reply to a counterparty case's forwarder is admitted for that case's reply send key, again on a retry of the same reply, and refused for any other send to that address; (12) the tests use real fixtures through the real extraction and parsing (an attached `.eml` original, an Outlook `.msg` original, an inline forward), authenticated and unauthenticated forwarders, an ambiguous claim, and read the stored case back for its `origin` and protected organisation; a refused message creates no case and no Workflow.

**Corrected 2026-10-31** (while building): (13) the limits count today's counterparty cases themselves, inside the one statement that admits the case (`admitCase`, `src/db/cases.ts`), instead of a separate counter table (was correction 2's D1 counter table): a duplicate delivery makes no case so takes no slot, an undone admission deletes its case so gives its slot back, and two arrivals for the last slot cannot both get in, with nothing to keep in step; migration 0054 adds the two indexes those counts read.

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Extend the email handler's gate. Done when: a non-member forward claiming a protected identity creates a counterparty case; one claiming nothing creates nothing.
2. Enforce limits. Done when: the sixth counterparty case from one sender in a day is refused.

- [x] Extend `handleEmail` so a non-member message proceeds only if its original's display name or From domain matches `findIdentityByClaim`, creating a case with `channel = "email"`, `origin = "counterparty"` (**Corrected 2026-10-31:** was `channel = "counterparty"`, correction 1) and `org_id` of the protected business. Done when: `test/trust/counterparty-intake.test.ts` covers claim, no claim and member mail, with the fixtures and read-back of correction 12 (**Corrected 2026-10-31**, plan review). Done 2026-10-31: `counterparty` and `originalClaim` in `src/intake/email.ts`, `origin` through `src/intake/admit.ts` and `src/db/cases.ts`, migration `0054_counterparty.sql`; tests "the gate" in `test/trust/counterparty-intake.test.ts` (an attached `.eml` and a real `.msg` original, an inline forward, an unauthenticated forwarder, an ambiguous claim, member mail unchanged) and `test/db/counterparty-migration.test.ts`.
- [x] Limit counterparty cases to 5 per sender address per day and 50 per protected identity per day with D1 counters (**Corrected 2026-10-31:** was KV counters; the Worker has no KV binding, correction 2), dropping silently past the limit, the slots following `admitDelivery`'s lifecycle and never counted against the organisation's own cap (corrections 8 and 10). Done when: the limit tests pass, including a duplicate delivery taking no slot, an undone admission giving its slot back, two concurrent arrivals for the last slot admitting one, the second bucket refusing without taking the first, the SAST day rolling over, and mixed member and counterparty traffic each held by its own budget. Done 2026-10-31: `COUNTERPARTY_PER_SENDER`, `COUNTERPARTY_PER_IDENTITY` and the room condition in `admitCase` (correction 13); tests "the limits".
- [x] Mark counterparty cases so their reply goes to the forwarding counterparty (the recipient allowlist admits the address of a counterparty case's sender for that one reply). Done when: the allowlist test admits it once and refuses a second unrelated send, admits a retry of the same reply after a provider failure, and admits each of two cases from the same sender once (correction 11). Done 2026-10-31: `isCounterpartyForwarder` in `src/mail/allowlist.ts`, the case id passed from `sendMail`; tests "the one reply".
- [x] Let staff inbox checks lapse with the plan (**Corrected 2026-10-31**, correction 6: was "answered as a free per-sender check, not filed to the organisation"): a forward from a member of an organisation without `staff-inbox` (an expired trial, free) is still filed to the organisation as a Free check case within the Free tier's daily cap, read from the plan's cap where intake reads it, with the daily-cap notice beyond it; only `staff-inbox`'s own features are off (`hasFeature`, D07 T02 §8). Done when: an expired organisation's member forward is filed until the Free tier's cap, the next one gets the cap notice and no case, nothing is dropped silently, and an entitled organisation's forward is filed under its own cap. Source: D07 T02 §8 plan review; SPEC S5.
- [x] Commit: `trust: counterparty intake path with rate limits`

**Test checkpoint:** `pnpm exec vitest run test/trust/counterparty-intake.test.ts` passes and fails if non-member mail without a claim is processed.

> **Verified:** 2026-10-31 | §1 | deccf1fb39ff72fe08a870dbc41a181a6411611b
> **Review:** `docs/reviews/d05-t02-s1.json`

## 2. Claims found in a check

> **Started:** 2026-11-02T22:44Z

A mail "claims" a protected identity through its display name, From or Reply-To domain lookalike, its logo (SAM crop matched against the registered logo), its signature block text, or a voice claim (D01 T03 §4). Each claim is evidence the comparison uses.

**Scope 2026-10-31** (D05 T02 §1's plan review, correction 9): the logo, signature and voice claims detected here act on cases already admitted; a non-member's forward is admitted only on a display-name or From-domain claim (§1), so one claiming only by logo, signature or voice is not a counterparty case.

**Phase:** 7
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Register `trust.claim`. Done when: each claim route on a fixture yields the claimed identity.

- [x] Detect claims by display name, domain (exact or lookalike from D02 T03 §2), signature text (company name in the last 15 lines), and `voice.claimed_identity`. Done when: `test/trust/claim.test.ts` covers each route. Done 2026-11-03: `detectClaims`, `claimInputFromView` and `persistClaimOutcome` in `src/trust/claim.ts`; `test/trust/claim.test.ts` covers display name (including >300-char headers), From and Reply-To exact and lookalike independently, 15-line signature boundary, and `VoiceRead` states.
- [x] Compare the mail's logo crops with the registered logo using `compareLogo` (D03 T03 §3). Done when: a fixture with the Fynbos Freight logo yields a logo claim. Done 2026-11-03: `compareClaimLogos`, `fitSvgDimensions`, `plainUnavailableReason`, `withClaimLogos` and `runClaimDetectionWithLogos` in `src/trust/claim.ts` read the latest generation of case-owned SAM crop manifests (`art/<caseId>/crop/*-manifest-<n>.json`), distinguish missing crop production from a completed zero-logo manifest, validate registered PNG logos (`pngPixelsProblem`) and sanitise/rasterise registered SVG logos (`sanitiseSvg` + aspect-preserving `rasteriseSvg`) before calling `compareLogo` within a bounded 60-second phase (`MAX_CLAIM_CROPS = 4`, `MAX_CLAIM_LOGO_COMPARISONS = 8`, `MIN_LOGO_CLAIM_CONFIDENCE = 0.5`).
- [x] Register `trust.claim` (info) with the routes that matched. Done when: the fixture yields it. Done 2026-11-03: `registerClaimCheck`, `claimInputFromView`, `claimEvidence` and `readTrustClaimDetail` in `src/trust/claim.ts`; global wiring into `src/checks/index.ts` and `src/pipeline/analysis-workflow.ts` is filed in D05 T02 §11 once `D07 T03 §17` (`trust` family evidence cards on the app lane) lands.
- [x] Commit: `trust: claim detection`

**Corrected 2026-11-02** (plan review, 2 P1 and 4 P2, `docs/reviews/05-trust/D05-T02-s2.md`): (1) a registered check is pure and store-free (`src/checks/registry.ts`), so the protected identities it matches against reach it as a typed `CaseView` input filled by the checks step in `src/pipeline/analysis-workflow.ts` (checks-lane files, coordinator agreement asked 2026-11-02): a bounded candidate set with effective-protection filtering, the registered logo reference for each, working for an admitted member case claiming another business, not only the case's own organisation; trust supplies the matching and evidence contract. (2) The mail's logo crops do not exist yet on a case: the crop producer, its case-owned manifest, registered-logo retrieval and raster conversion, and the bounded comparison phase are specified before the check reads them; checks run before vision in the Workflow, so the ordering is named in the build (the comparison is its own bounded step whose validated judgement the pure check reads). (3) Routes are separate From and Reply-To exact and lookalike routes on the original message's headers; the voice value is `view.voice.claim.claimedIdentity` when its state is `read` (`src/voice/schema.ts`), with silent, failed and incomplete reads named; section 1's admission boundary is unchanged (a Reply-To-only claim does not admit a non-member's mail). (4) The evidence contract section 3 consumes: the claimed organisation and name, every matched route for it, the supporting header text, signature line or voice quote observed, the logo judgement and crop artefact references, at info severity with a plain summary; multiple identities each get their item, routes deduped per identity, and no registered baseline detail or registered-logo storage reference in the evidence. (5) Unavailable is never no-match: a failed identity read, missing or unreadable crop or registered logo, unsupported or oversized image, model refusal, timeout or budget end states itself on the item while textual claims still land. (6) `test/trust/claim.test.ts` asserts the full matrix: display name; From and Reply-To exact and lookalike independently; signature at the 15-line boundary and outside it; voice matched, absent, silent and unavailable; stubbed positive, negative and failed logo comparisons; combined routes, multiple identities, no match, inactive protection; real input population, registry execution, evidence contents, artefact provenance, privacy and stored read-back.

**Corrected 2026-11-03** (after `D02 T01 §9` shipped on `main` at `09816762`): `claimInputFromView` in `src/trust/claim.ts` reads `view.protectedCandidates` (populated by `boundProtectedCandidates(await protectedIdentities(db))` in `src/pipeline/analysis-workflow.ts`, bounded by `MAX_PROTECTED_CANDIDATES = 25`, `MAX_CANDIDATE_NAMES = 10` and `MAX_CANDIDATE_DOMAINS = 10`), `originalHeaderOf(view.headers)` and `Reply-To` headers when `view.tenant.headersAvailable` is true, the last 15 lines of `view.text` (marking truncated plain-text bodies unavailable), `view.voice` (`VoiceRead` in `src/voice/schema.ts`), and `view.claimLogos` (`compareClaimLogos` over `art/<caseId>/crop/*-manifest-<n>.json` and `ident/<orgId>/logo-*`); `readTrustClaimDetail` validates the stored `trust.claim` detail for §3, and global registration in `src/checks/index.ts` waits on `D07 T03 §17` (`trust` family evidence cards).

**Test checkpoint:** `pnpm exec vitest run test/trust/claim.test.ts` passes.

> **Verified:** 2026-11-03 | §2 | 6cebe0b1773f5afb86b72c2fcbeca980d243881a
> **Review:** `docs/reviews/d05-t02-s2.json`

## 3. Registry comparison evidence that

Compare the claiming mail with the registry: sending domain registered or not, address registered or not, bank details match or not (match-only), logo same or not. Findings speak in match or no-match terms only: "Fynbos Freight never sends from gmail.com" is allowed (the domain the mail used is public); "Fynbos Freight's account ends 123" never is (spec 2a).

> **Started:** 2026-11-03T21:34Z

**Corrected 2026-11-03** (at start, checked against the tree): (1) Registered checks in `src/checks/registry.ts` are pure and store-free, and global registration in `src/checks/index.ts` and `src/pipeline/analysis-workflow.ts` is owned by D05 T02 §11 once D07 T03 §17 (`trust` family evidence cards) lands. `src/trust/compare.ts` therefore ships `prepareRegistryComparison` (an async pre-step that reads `readTrustClaimDetail` from `src/trust/claim.ts`, checks the original message's `From` domain/address against the claimed organisation's verified `org_domains` and `org_addresses` while `getIdentity` is effectively on, and calls `matchBankAccount` over extracted bank accounts, returning a sanitized `RegistryComparisonInput` attached via `withRegistryComparison`), `comparisonEvidence` and `registerComparisonChecks` (registering `trust.sender_not_registered`, `trust.bank_mismatch`, and `trust.verified_sender`, plus `trust.impersonation` when a strong claim's logo or sender/bank comparison establishes impersonation), and `persistComparisonOutcomes` for stored evidence/outcome read-back. (2) Sender checks (`trust.sender_not_registered` and `trust.verified_sender`) read the original message's `From` header (`originalHeaderOf(view.headers)`) only when `view.tenant.headersAvailable` is true; when headers are unavailable, they emit no guess and record unavailable coverage (`"the original message's headers were not available"`). `trust.verified_sender` (info) requires both a registered verified domain of the claimed business and a trusted `Authentication-Results` DMARC pass (`dmarcResult` in `src/checks/auth-results.ts`) aligned with that domain; unauthenticated or DMARC-failing mail on a registered domain never yields `trust.verified_sender`. (3) Bank comparisons call `matchBankAccount` (`src/trust/bank.ts`) with the case caller (`{ sender }` for a counterparty case or `{ orgId: view.tenant.orgId }` for a member case). On `{ match: false }`, `trust.bank_mismatch` (critical) states only that the bank details are not the ones the business registered with IsItLegit, never claiming bank/AVS confirmation (`"verified by"`, `"bank confirmed"`, `"account holder confirmed"`), and never carrying any registered account digits. Every typed refusal (`NoBaseline`, `KeyMismatch`, `IdentityRefused`, `MatchLimited`, `BankKeysMissing`) and any lookup failure produces no `trust.bank_mismatch` item and records a plain unavailable coverage reason (`"the business has not registered an account"`, `"account checks are paused while keys are replaced"`, `"the business's protection is not active"`, `"too many checks this hour"`, `"account comparison keys are not configured"`). (4) `test/trust/compare.test.ts` proves the demo Fynbos Freight impersonation fixture, each refusal kind, registry-baseline wording, DMARC-aligned `trust.verified_sender` vs unauthenticated spoof, stored read-back, and a planted-leak detector over every evidence and outcome field.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Register `trust.impersonation`. Done when: the demo fixture yields critical impersonation evidence.
2. Prove nothing leaks. Done when: a test greps every evidence summary and detail for registered values and finds none.

- [ ] Register `trust.sender_not_registered` (critical when the claim is strong and the sending domain or address is not registered). Done when: `test/trust/compare.test.ts` passes for the demo fixture.
- [ ] Register `trust.bank_mismatch` using `matchBankAccount` on any extracted bank details (critical on no match). Done when: a fixture invoice with other details yields it.
- [ ] Treat every typed refusal of `matchBankAccount` (`NoBaseline`, `KeyMismatch`, `IdentityRefused`, `MatchLimited`, `BankKeysMissing`) as a check that could not run: no `trust.bank_mismatch` evidence, and the check's coverage recorded as unavailable with a plain reason ("the business has not registered an account", "account checks are paused while keys are replaced", "too many checks this hour"), so a refusal never reads as a changed bank (D05 T01 §2 completion review, gap 4, `docs/reviews/05-trust/D05-T01-s2.md`). Done when: `test/trust/compare.test.ts` drives each refusal and finds no bank evidence and the matching unavailable reason. Cheaper substitute: catching every error as "no match".
- [ ] Word `trust.bank_mismatch` and any bank match as agreement with what the business registered with IsItLegit ("these bank details are not the ones Hadeda Couriers registered with IsItLegit"), never as a bank's confirmation of the account or its holder, since live account verification (AVS) is out of scope (spec 4.5; D05 T01 §2 completion review, gap 6). Done when: the test asserts the summary names the registry as the baseline and contains none of "verified by", "bank confirmed" or "account holder confirmed". Cheaper substitute: a generic "bank details changed".
- [ ] Register `trust.verified_sender` (info, counter-signal) when the mail comes from a registered domain with DMARC aligned. Done when: a genuine fixture yields it.
- [ ] Write a leak test asserting no evidence field contains any registered domain list, address list, account number fragment or finance contact. Done when: the test passes and fails on a planted leak. Cheaper substitute: reviewing summaries by eye.
- [ ] Commit: `trust: registry comparison that reveals nothing`

**Test checkpoint:** `pnpm exec vitest run test/trust/compare.test.ts` passes and fails if a registered domain list appears in evidence.

## 4. Impersonation alert to the protected business

When a counterparty case finds impersonation, the protected business is told with the evidence, so it can warn its partners (spec 2a). The recipient is the identity's registered alert address (during the event, the demo aliases only; design spec section 11).

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Send the alert. Done when: the demo fixture sends one alert to the Fynbos Freight alias with a link to the case.

- [ ] Build the alert in `src/trust/alert.ts`: subject "Someone is impersonating <business>", the claim routes, the top evidence summaries, and a signed link to the case for the protected business. Done when: `test/trust/alert.test.ts` snapshots it.
- [ ] Send with `sendMail({ kind: "alert" })` to the identity's registered alert address, once per counterparty case. Done when: a retried step sends once.
- [ ] Never include the counterparty's address in the alert, only their organisation domain if they are a member. Done when: the test asserts it.
- [ ] Send an impersonation alert only while the protected organisation has `impersonation-alerts` (`hasFeature`, D07 T02 §8). Done when: an expired organisation's impersonation sends no alert, an entitled one's does, and removing the check fails the test. Source: D07 T02 §8 plan review.
- [ ] Commit: `trust: impersonation alerts`

**Test checkpoint:** `pnpm exec vitest run test/trust/alert.test.ts` passes and fails if the alert is sent twice for one case.

## 5. Counterparty reply with the protected line

The counterparty gets the verdict like a member, plus "Fynbos Freight is protected by IsItLegit" and an invitation to protect their own business (spec 2b growth loop). The reply never names registered details.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Extend `buildReply` for counterparty cases. Done when: the demo fixture's reply carries the line and the invite link.

- [ ] Add the protected line and the invite link (`https://isitlegit.co.za/?ref=protected`) for counterparty cases in `src/mail/reply.ts`. Done when: `test/trust/counterparty-reply.test.ts` finds both.
- [ ] Give the counterparty a signed report link scoped to that case only, with the protected business's private details absent from the report view. Done when: the test opens the link and finds no registered detail.
- [ ] Measure the counterparty journey (D05 T02 §1's completion review, gap 7, `docs/reviews/05-trust/D05-T02-s1.md`): time from a counterparty forward's arrival to its reply sent, p50 and p95 over the synthetic set, recorded in `docs/frontier-log.md` beside the member path's figures. Done when: the entry exists with both figures. Cheaper substitute: no figure.
- [ ] Commit: `trust: counterparty reply with the protected line`

**Test checkpoint:** `pnpm exec vitest run test/trust/counterparty-reply.test.ts` passes.

## 6. Verify-this-email page for a protected business

The public page a signature badge links to (design spec 2a, Verifiable signature badge): `isitlegit.co.za/v/<slug>` shows the business's name, its verified sending domains, the date verified, and one clear action: forward the email you received to `check@isitlegit.co.za` as an attachment. The badge proves nothing on its own; the forwarded message's DKIM, SPF and DMARC alignment against the registered domains is the proof, through the counterparty path (§1 to §5). It never shows bank details, addresses beyond the domains, or the finance contact.

> **Started:** 2026-10-31T21:39Z

**Corrected 2026-10-31** (at start, checked against the repository, `design/SPEC.md` T1 and its four boards): (1) migration `0018_verify_page.sql` is long taken; the coordinator's number is 0062 (`0062_verify_page.sql`, 2026-10-31), and the columns are `identities.public_slug` (unique, lower-case letters, digits and hyphens, 3 to 60) and `identities.public_slug_changed` (0 or 1, for the owner's one change); (2) the slug is assigned on the first save that switches protection on, from the registered name with the company form dropped ("(Pty) Ltd", "Ltd", "Pty", "CC", "Inc", "NPC"), so "Fynbos Freight (Pty) Ltd" gets `fynbos-freight`, and a taken slug gets `-2`, `-3` and so on; (3) the page is a Worker route, `GET /v/:slug`, reached on the apex `isitlegit.co.za/v/*` through D07 T06's route (the site lane's item) and on the app host directly; (4) "verified on" is when protection was switched on (`protectedSince`, D05 T01 §3) and "checked again" is the moment the page is drawn from the live state (a verified domain, the finance contact, the plan), since no stored recheck exists (default; a stored recheck would cost a scheduled job); (5) the domains are the organisation's verified ones (`orgDomains`, verified only); (6) three answers: protected (the identity's effective protection on and `identity` in the plan) draws Verify-Protected with 200; a known slug that is not protected now (switched off, lapsed requirements or plan) draws Verify-NotProtected, "Not verified" with "Sign in to renew your protection", with 404; an unknown slug draws the site's 404 (S11) saying "This business is not protected by IsItLegit", never echoing the slug; (7) the board's foreign-origin state is §9's (its item "Show the verify page's notice"), recorded as a SPEC T1 deviation until then; (8) the copy button is the app's existing copy control (`data-copy-group`, as the member shell's forward box), with its manual fallback; (9) "Protect your own business" opens S4 on the site (`https://isitlegit.co.za/protect`), since `/protect` on the app host is the member page.

**Corrected 2026-10-31** (plan review, 2 P1, 5 P2, `docs/reviews/05-trust/D05-T02-s6.md`): (10) the migration backfills a slug for every identity already protected, by the same rule, with no change to its protection or history, and the assignment is idempotent (gap 1); (11) the slug rule: the registered name lower-cased, letters with accents folded to ASCII, every run of other characters one hyphen, the company form dropped, cut to 50 characters at a hyphen; a result shorter than 3 characters, or empty (a non-Latin name), becomes `business-` and the first 8 characters of the organisation's id; a collision appends `-2`, `-3` and so on within the 60-character limit, and a concurrent collision is retried with the next suffix on the unique index, so a valid identity save never fails on its slug (gap 3); (12) every instruction the page gives is one the intake honours: forward as an attachment from the mailbox that received it (§1's counterparty path needs the attached original), never an inline forward and never an upload (members only); the Not verified state gives no check-and-reply promise, saying that IsItLegit cannot confirm this business and to contact it on a number from its own records, recorded as SPEC T1 deviations for Verify-NotProtected's and Verify-Mobile's wording (gap 2); (13) the one-time change says before it is sent that links to the old address stop working, has Cancel, shows the field read-only with its reason once used, and is enforced and audited in one statement (`public_slug_changed = 0` in its `WHERE`), so two submissions change it once, a refused change keeps the allowance, and an uncertain save asks for a reload (gap 4); (14) the public `AppShell` gains a verification header variant (the origin line "You are on isitlegit.co.za" without the report's link-expiry wording), the report's header unchanged (gap 5); (15) an identity, domain or plan read that fails answers the site's error page (S11) with a retry, status 503, never Not verified or Protected (gap 6); (16) the assembled feature is proven through the exported Worker (protection switched off, the last verified domain lost, the finance contact's verification lost, each restored) and in Chromium at 1280 and 390 px (the copy button, its refusal and manual fallback, keyboard order, the renewal and protection links) (gap 7).

**Corrected 2026-11-01** (at build): correction 10's backfill runs in the Worker's quarter-hour tick (`backfillPublicSlugs` in `src/trust/public-slug.ts`), not in migration 0062, because SQL cannot apply correction 11's rule (accent folding, company forms) the same way; it is idempotent and gives every protected identity without an address its slug within a quarter-hour, and also covers a save whose assignment failed after the identity was stored.

**Phase:** 5
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` verify page and `design/brand/README.md` (seal and badge rules)
**Job:** a recipient who sees the badge confirms in one step whether the email really came from that business
**Treatment:** the business's real domains first, the forward instruction second, nothing private
**Chrome:** `AppShell` public variant, `Button`, `EvidenceCard` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Add a public slug per protected identity and build the page. Done when: a protected demo business's page renders its verified domains and the forward instruction.
2. Refuse what must not show. Done when: an unprotected or unknown slug shows "This business is not protected by IsItLegit" and a 404 status.

- [x] Add `public_slug` and `public_slug_changed` to `identities` in the coordinator's migration (corrections 1 and 2; **Corrected 2026-10-31:** was `0018_verify_page.sql`), and assign the slug in `setIdentity` (`src/trust/identity.ts`) on the first save that switches protection on, by correction 11's rule, with the backfill of correction 10. Done when: `test/trust/public-slug.test.ts` (**Corrected 2026-11-01:** was `test/trust/identity.test.ts`; the slug store is its own module) shows "Fynbos Freight (Pty) Ltd" getting `fynbos-freight`, a second business of that name `fynbos-freight-2`, a short, a non-Latin and a 70-character name each getting a valid slug, a later save keeping the slug, and the migration giving an already-protected identity its slug.
- [x] Let the owner change the slug once on the identity page (`src/web/pages/identity.tsx`, D05 T01 §3): a "Public page address" field with its link, refused when taken, malformed or already changed, the change audited, with correction 13's notice, Cancel and read-only state. Done when: `test/web/identity-page.test.ts` changes it once, refuses a second change, a concurrent pair (one wins) and a taken slug on the field, keeps the allowance after a refused change, shows the new address after a reload, and the old address answers as unknown. Cheaper substitute: a slug fixed at assignment.
- [x] Build `GET /v/:slug` in `src/web/pages/verify.tsx` on the marketing host with the seal, the business name, its verified sending domains, the verified date, and the forward-as-attachment steps for Outlook and Gmail. Done when: `test/web/verify-page.test.ts` finds each element. Cheaper substitute: a static "this business is verified" image page.
- [x] Show "This business is not protected by IsItLegit" with status 404 for an unknown, unprotected or lapsed identity, and never echo the requested slug as a business name. Done when: the test covers unknown and lapsed.
- [x] Prove no private field reaches the page (bank details, addresses, finance contact) with a test that renders a fully populated identity. Done when: the leak test passes and fails on a planted field.
- [x] Show a business as verified only while its plan includes `identity` (`hasFeature` on the protected organisation, D07 T02 §8), not from a stored switch. Done when: a lapsed organisation's verify page answers "Not verified" while its identity is still stored, and an entitled one's answers verified. Source: D07 T02 §8 plan review.
- [x] Give the forward instruction for a phone as well as a desktop (D05 T02 §1's completion review, gap 5): forwarding as an attachment from the Gmail and Outlook apps, in at most three steps each, and what to do when an app cannot attach (forward from a computer, or upload). Done when: the rendered page shows both sets of steps and the test counts the steps. Cheaper substitute: desktop steps only.
- [x] Say what to do when nothing comes back, without revealing why (D05 T02 §1's completion review, gap 6): forward from your own mailbox, as an attachment, with the original's sender visible; a check about the same business is limited each day; no reply never means the email is genuine. Done when: the page carries those three lines and names no limit figure or registered detail. Cheaper substitute: no guidance.
- [x] Answer a failed identity, domain or plan read with the site's error page and a retry, status 503 (correction 15). Done when: `test/web/verify-page.test.ts` injects each failure and finds neither Protected nor Not verified.
- [x] Give the public `AppShell` its verification header (correction 14). Done when: the verify page shows "You are on isitlegit.co.za" without the report's expiry wording and the report page's header test still passes.
- [x] Prove the page through the exported Worker and in Chromium (correction 16). Done when: `test/web/verify-page.test.ts` covers the four state changes and their recovery, and `test/node/verify-page-browser.test.tsx` covers the copy control, its fallback, keyboard order and both widths.
- [x] Commit: `trust: verify-this-email page for protected businesses`

**Test checkpoint:** `pnpm exec vitest run test/web/verify-page.test.ts` passes and fails if the finance contact appears on the page.

> **Verified:** 2026-11-01 | §6 | a04335e6a93e753d1168d79d25bfbad2c8cf8234
> **Review:** `docs/reviews/d05-t02-s6.json`

## 7. Live signature badge and its copy-paste snippet

The badge is served live from `isitlegit.co.za/b/<slug>.png` (and `.svg`), so a lapsed protection changes every copy already sent to "Not verified" (spec 2a). The owner gets a ready signature snippet (HTML for Outlook and Gmail signature editors) with the badge linking to the verify page, built from `design/brand/logo-svg/isitlegit-badge-protected.svg`.

> **Started:** 2026-11-01T00:42Z

**Corrected 2026-11-01** (at start, checked against `design/SPEC.md` T3 and M5, the boards `Badges.png` and `Protect.png`, `design/brand/README.md` and the code): (1) the badge is Protected exactly when the verify page says Protected: `answerFor` in `src/web/pages/verify.tsx` (D05 T02 §6: protection in effect, `identity` in the plan, a verified domain left) decides both, so the plan-lapse item below is the same decision, not a second one; an unknown slug, a lapsed business and a failed read all serve the Not verified badge with status 200 (T3's error state: an image, never a broken one); (2) the Not verified variant follows the board, not the item's wording: a grey question mark with "NOT VERIFIED" and a small "by IsItLegit", grey and never red (board: "we do not accuse a lapsed business, we just stop vouching"); (3) the badge's two heights (T3: 52 px and 36 px, both 2x) come from one PNG drawn 104 px tall, which stays sharp at either, plus the SVG; `design/tools/build-brand.py` renders both variants with `rsvg-convert` (2.61.3, on the machine) into `design/brand/logo-png/`; (4) no assets binding exists (`wrangler.jsonc` serves `./public` with none), so the images are served as bytes from a module `scripts/hash-asset.ts` generates beside `src/web/assets.ts`, the one URL a signature holds being the image itself, never a redirect; (5) the cache is the item's `public, max-age=3600`: a lapse reaches a signature within the hour, longer only where a mail client's image proxy keeps its own copy (Gmail does), which the page says plainly instead of "every copy changes"; (6) the request count is one row per organisation per SAST day (the slug changes once, the organisation never), written after the answer through `waitUntil`, storing no address, referrer or user agent; it needs a migration number from the coordinator; (7) the snippet's copy puts rich HTML on the clipboard (`text/html` with `text/plain`), since Outlook's and Gmail's signature editors paste rendered content, not markup; where the clipboard refuses, the preview is selected for copying by hand; the code block shows the markup; (8) the snippet uses the 36 px height (the board's code shows 44 px, a height T3 does not draw: a SPEC deviation); (9) the card's note says the badge proves nothing by itself and that a lapse turns every badge to Not verified; the board's "a badge copied into a fake turns into an alert to you" waits for copied-badge detection (D05 T02 §8), recorded as a deviation until then; (10) the card shows only while the identity has a public address; otherwise it says to switch protection on first; the steps for Outlook desktop, Outlook on the web and Gmail open in place.

**Corrected 2026-11-01** (plan review, 2 P1 and 2 P2, `docs/reviews/05-trust/D05-T02-s7.md`): (11) the badge is proven through the exported Worker for `.png` and `.svg`: status 200 and no redirect, `image/png` and `image/svg+xml`, PNG bytes that start with the PNG signature and whose IHDR says 104 px tall, an SVG that parses with its title, for a protected business, an unknown slug, a failed read, protection switched off, the last domain lost, the plan lapsed, and recovery after each; the checkpoint fails on a wrong variant or a corrupt image; (12) the copy is proven in Chromium (`test/node/protect-badge-browser.test.tsx`): the button puts `text/html` and `text/plain` on the clipboard, a refused or missing clipboard selects the preview and says so, the result is announced, and the steps open and close by keyboard; installing the snippet in the real Outlook and Gmail signature editors and receiving a synthetic message is filed as D05 T02 §10 (attended); (13) the card has three states: protection never switched on (switch it on first), protection on while the public address is being prepared (as `PublicPageCard` says, it appears within a quarter-hour; reload), and the snippet once the address exists; (14) the image's `alt` is neutral, "Check this business with IsItLegit", since the image may say either; the board's "Protected by IsItLegit" is recorded as a SPEC deviation, and the link's accessible name is tested with images unavailable.


**Phase:** 5
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, protected identity section; `design/brand/README.md` badge rules
**Job:** a business owner adds the badge to every staff signature in a minute
**Treatment:** one copy button, a preview, and plain steps for Outlook and Gmail
**Chrome:** `AppShell`, `Button`, `Field` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Serve the badge. Done when: a protected slug returns the Protected badge and a lapsed one returns the Not verified badge, both with short caching.
2. Give the owner the snippet. Done when: the identity page shows a preview and copies the HTML.

- [x] Add a Not verified badge variant to `design/tools/build-brand.py` (grey seal, "NOT VERIFIED BY IS IT LEGIT") and regenerate the kit. Done when: `design/brand/logo-svg/isitlegit-badge-not-verified.svg` exists.
- [x] Serve `GET /b/:slug.png` and `.svg` choosing the Protected or Not verified badge from the identity's current state, with `Cache-Control: public, max-age=3600`. Done when: `test/web/badge.test.ts` sees each variant and the header. Cheaper substitute: a static image the business hosts itself, which cannot lapse.
- [x] Record each badge request's referring context only as a count per slug per day (no IPs, no message data). Done when: the test sees the counter rise and no address stored.
- [x] Add the signature snippet to the identity page (D05 T01 §3): preview, copy button, and steps for Outlook (desktop and web) and Gmail. Done when: the page test copies HTML whose image source and link point to the slug.
- [x] Serve the live badge as "Not verified" once the protected organisation's plan lapses (`hasFeature`, D07 T02 §8). Done when: the badge of a lapsed organisation reads "Not verified" and an entitled one's reads verified. Source: D07 T02 §8 plan review.
- [x] Commit: `trust: live signature badge and snippet`

**Test checkpoint:** `pnpm exec vitest run test/web/badge.test.ts` passes and fails if a lapsed identity still gets the Protected badge.

> **Verified:** 2026-11-01 | §7 | b946ba74ada6a64785fb5cabe9ec49a57b6491a7
> **Review:** `docs/reviews/d05-t02-s7.json`

## 8. Copied-badge detection and alerts

An attacker who copies the badge into a fake email turns it into evidence (spec 2a): when a counterparty case contains a link to `/v/<slug>` or an image from `/b/<slug>`, but the message does not pass DKIM or SPF aligned with that business's registered domains, the case gets critical "copied Protected badge" evidence and the business is alerted with the sending domain.

**Scope 2026-10-31** (D05 T02 §1's plan review, correction 9): a copied badge is detected on cases already admitted; a non-member's forward claiming only by a badge is not admitted by §1's gate.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Register `trust.badge_copied`. Done when: a fixture fake with a copied badge is critical and a genuine fixture with the badge is clean.
2. Alert the business. Done when: the alert names the lookalike sending domain.

- [ ] Detect badge links and images pointing to `/v/<slug>` or `/b/<slug>` in the HTML and map them to the identity. Done when: `test/trust/badge-copied.test.ts` finds the slug in both forms.
- [ ] Register `trust.badge_copied` (critical) when the message is not DKIM- or SPF-aligned with a registered domain of that identity, and `trust.badge_genuine` (info, counter-signal) when it is. Done when: the fake and genuine fixtures behave.
- [ ] Include the copying domain in the impersonation alert (§4) for a copied badge. Done when: the alert snapshot names it.
- [ ] Commit: `trust: copied-badge detection and alerts`

**Test checkpoint:** `pnpm exec vitest run test/trust/badge-copied.test.ts` passes and fails if an unaligned message with the badge is rated genuine.

## 9. Domain-locked website seal

The seal a protected business shows on its own website, locked to its verified domains by the browser itself (design spec 2a, Domain-locked website seal): `isitlegit.co.za/s/<slug>` serves the seal as a small page meant to be framed, with `Content-Security-Policy: frame-ancestors` listing only the identity's verified domains (and their `www.` and subdomains when verified), so on any counterfeit domain the browser refuses to render it. The seal shows today's date and links to the verify page (§6). A blocked embed still requests the seal, and that request's `Referer` or `Sec-Fetch-Dest: iframe` with an unregistered origin becomes an impersonation lead for the business.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` verify page and seal; `design/brand/logo-svg/isitlegit-seal-protected.svg`
**Job:** a visitor to a protected business's real website sees a live seal that cannot appear on a fake copy of that site
**Treatment:** the seal, the business name and today's date; one click to the verify page
**Chrome:** the seal artwork from `design/brand/`; no app shell inside the frame

**Build order:**

1. Serve the framed seal with the domain lock. Done when: the response carries `frame-ancestors` with exactly the verified domains and a browser test shows it rendering on an allowed origin and blocked on another.
2. Give the owner the embed code. Done when: the identity page shows a one-line embed snippet and a preview.
3. Turn blocked embeds into alerts. Done when: a request from an unregistered origin creates one lead and one alert per origin per day.

- [ ] Serve `GET /s/:slug` in `src/web/pages/seal.tsx`: the Protected seal, the business name, today's date in SAST, and a link to `/v/:slug?from=site` opening in a new tab; `Content-Security-Policy: frame-ancestors <verified origins>`; no `X-Frame-Options` that would conflict. Done when: `test/web/seal.test.ts` checks the header lists exactly the verified origins for a fixture identity. Cheaper substitute: a plain image the business could hotlink from anywhere.
- [ ] Return a neutral "Verify at isitlegit.co.za" seal (no business name, no Protected wording) for a lapsed or unknown slug, and when the request has no `Referer` and no `Sec-Fetch-Site` information. Done when: the test covers lapsed, unknown and referrer-less requests. Cheaper substitute: showing Protected when the origin cannot be told.
- [ ] Prove the lock in a real browser: a Browser Run test page on an allowed origin renders the seal and a page on `fixtures.isitlegit.co.za` (not in the list) is blocked by the browser. Done when: `test/web/seal-frame.browser.test.ts` records both outcomes.
- [ ] Record a request whose `Referer` origin is not a verified domain as `seal_leads` (slug, origin, first seen, count per day; no IPs) and send the business one impersonation alert per origin per day through §4. Done when: `test/trust/seal-leads.test.ts` sees one lead and one alert for two requests from the same origin.
- [ ] Show the verify page's notice "You came from <origin>, which is not a <business> domain" when `/v/:slug` is opened from an unregistered origin. Done when: the verify page test covers it.
- [ ] Add the embed snippet (`<iframe src="https://isitlegit.co.za/s/<slug>" width="220" height="88" title="Protected by IsItLegit" style="border:0"></iframe>`) with a preview and install steps for WordPress and plain HTML to the identity page. Done when: the page test copies a snippet pointing at the slug.
- [ ] Commit: `trust: domain-locked website seal`

**Test checkpoint:** `pnpm exec vitest run test/web/seal.test.ts test/trust/seal-leads.test.ts` passes and fails if `frame-ancestors` admits an unverified origin.

## 10. Signature badge checked in real mail editors

Filed 2026-11-01 from D05 T02 §7's plan review: the snippet installed by hand in the signature editors a business uses, the signature saved and reopened, and a synthetic message received with the badge's PNG and its verify link intact. It needs a person at Outlook (desktop and web) and Gmail accounts, so it is attended.

> **Skipped:** 2026-11-01, by the operator, for the competition (relayed by the coordinator): this section is not built. The signature snippet is tested in Chromium and through the Worker (D05 T02 §7); how it survives the real Outlook and Gmail editors is unchecked. The row stays open so the plan says so, and it waits on a person (`attended`), so the lane never counts it as runnable.
>
> **Started:** 2026-11-01T22:53Z
>
> **Operator decision 2026-11-02:** Outlook on the web only. The operator installed the Fynbos Freight snippet in Outlook on the web and sent "SIGTEST outlook-web badge check" from derick@rizonetech.com to itself; the record is in `docs/operations.md` under "Signature badge in mail editors". Outlook desktop and Gmail are waived for the competition and are named unchecked, not passed. The install timing, reply and images-blocked checks below stay unchecked on that record. The snippet checked used the app host, because the apex routes land with D07 T06 §20.
>
> **Stamp refused 2026-11-02:** `todo-graph.py stamp` refused the narrowed ticks ("unticked checklist items in D05 T02 §10", the install-timing and reply item first, the images-blocked item also unticked). The row stays open with the decision recorded; the unchecked items are not ticked and the record is not widened.
>
> **Coordinator decision 2026-11-02:** the two unticked items below (install timing and reply, images shown and blocked) are waived for the competition, on the same basis as the Outlook-web-only decision above. Each is recorded as waived by this decision, dated 2026-11-02, named unchecked and not passed, never as tested. No test evidence is claimed for them.
>
> **Stamp refused 2026-11-02 (second attempt, with plan and completion reviews recorded in `docs/reviews/05-trust/D05-T02-s10.md`):** `todo-graph.py stamp` refused with "unticked checklist items in D05 T02 §10" naming the paste-and-record item: the completion review found the record does not state the saved signature was reopened and names no editor version, so that item stays unticked and the row stays open. Closing it needs the operator to record the reopen result and editor version, or a coordinator waiver of those two sub-checks on the same basis.
>
> **Coordinator waiver 2026-11-02:** those two sub-checks (the record stating the saved signature was reopened; the editor version) are waived for the competition on the same basis. Both are recorded in `docs/operations.md` and here as waived by this decision, dated 2026-11-02, unchecked and not passed, never as tested. Item 1 below is ticked only on this waiver wording.

**Phase:** 5
**Needs:** attended
**Surface:** no

**Build order:**

1. Install and receive. Done when: each editor keeps the badge and link after saving and reopening, and a received message shows the PNG and opens the verify page.

- [x] Paste the snippet D05 T02 §7 copies into Outlook desktop (File, Options, Mail, Signatures), Outlook on the web (Settings, Accounts, Signatures) and Gmail (Settings, General, Signature), save, reopen, and record each result in `docs/operations.md`. Done when: the record names each editor, its version and the date, and says the image and link survived. Partly done 2026-11-02 as narrowed by the operator decision above: Outlook on the web only (installed by pasting the rendered badge, saved, badge image and `/v/fynbos-freight` link recorded in `docs/operations.md`); Outlook desktop and Gmail waived and unchecked, not passed. Not ticked: the record does not state that the saved signature was reopened, and names no editor version, so this item stays open (completion review, 2026-11-02). Ticked 2026-11-02 only on the coordinator waiver above: the reopen statement and the editor version are waived, unchecked and not passed, never as tested.
- [x] Time the install in each editor from a signature that already exists, with the card's steps alone and no outside help, and send a reply as well as a new message. Done when: the record says each took under a minute (the section's job, D05 T02 §7) or how long it took, and that the badge showed on the new message and the reply. Source: D05 T02 §7's completion review. Waived by coordinator decision 2026-11-02: unchecked and not passed, never tested; no timing or reply evidence is claimed.
- [x] Send a synthetic message from each to a test mailbox and open it with images shown and with images blocked. Done when: the record says the PNG loaded, the link opened `/v/<slug>`, and the neutral alternative text showed with images blocked. Waived by coordinator decision 2026-11-02: unchecked and not passed, never tested; no images-shown or images-blocked evidence is claimed beyond the operator's Outlook-web send recorded in `docs/operations.md`.
- [x] Commit: `docs: signature badge checked in real mail editors`

**Test checkpoint:** `grep -n "Signature badge in mail editors" docs/operations.md && grep -n "Checked 2026-11-02" docs/operations.md && grep -n "only Outlook on the web was checked" docs/operations.md && grep -n "Not checked: Outlook desktop and Gmail" docs/operations.md && grep -n "app.isitlegit.co.za/b/fynbos-freight.png" docs/operations.md` finds the dated, bounded record (**Corrected 2026-11-02:** narrowed by the operator and coordinator decisions above to Outlook on the web only; Outlook desktop and Gmail waived, unchecked and not passed; the check fails if the date, the Outlook-web-only scope, the app-host limit or the unchecked statement is removed).

> **Verified:** 2026-11-02 | §10 | ab5dbed59d4b97ee277f69da5a0fef003e11e293
> **Review:** `docs/reviews/d05-t02-s10.json`

## 11. Workflow and global registry wiring for claims

Filed 2026-11-03 from D05 T02 §2's completion review (`docs/reviews/05-trust/D05-T02-s2.md`, gap G7): `registerClaimCheck` and `runClaimDetectionWithLogos` in `src/trust/claim.ts` are built and tested through `CheckRegistry` and `saveEvidence`, but registering `trust.claim` in the global `defaultRegistry` (`src/checks/index.ts`) and invoking the post-vision registered-logo comparison step in `src/pipeline/analysis-workflow.ts` wait on `D07 T03 §17` (`trust` family evidence cards) and checks-lane workflow coordination.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Register `trust.claim` in the global check registry once `trust` evidence cards (`D07 T03 §17`) are mapped. Done when: `defaultRegistry()` includes `trust.claim` and `test/web/evidence-cards.test.ts` passes.
2. Run the post-vision registered-logo comparison phase in the analysis workflow and persist its updated `trust.claim` evidence and outcomes. Done when: an admitted email, document/image upload, and voice upload each produces persisted `trust.claim` evidence through `AnalysisWorkflow` without manual `CaseView` construction.

- [ ] Register `registerClaimCheck` in `defaultRegistry` (`src/checks/index.ts`) once `D07 T03 §17` maps the `trust` family in `src/web/components/evidence/cards.tsx`. Done when: `test/checks/registry.test.ts` and `test/web/evidence-cards.test.ts` pass with `trust.claim` registered in `defaultRegistry()`. Cheaper substitute: leaving `registerClaimCheck` only in unit tests. Source: D05 T02 §2 completion review (`docs/reviews/05-trust/D05-T02-s2.md`, G7).
- [ ] Invoke `compareClaimLogos` and `withClaimLogos` (`src/trust/claim.ts`) in `src/pipeline/analysis-workflow.ts` after the `vision` step stores SAM crop manifests, updating the case's stored `trust.claim` evidence and check outcome via `saveEvidence` (`src/checks/evidence.ts`). Done when: `test/pipeline/analysis-workflow.test.ts` proves a message with a registered logo crop persists the `"logo"` route on `trust.claim` in D1. Cheaper substitute: running `trust.claim` only before `vision`, which misses SAM logo crops. Source: D05 T02 §2 completion review (`docs/reviews/05-trust/D05-T02-s2.md`, G7).
- [ ] Prove end-to-end workflow execution across an admitted email forward, a document/image upload, and a voice upload in `test/pipeline/analysis-workflow.test.ts`, reading back stored `evidence` and `check_outcomes` rows with `readEvidence`, `readCheckOutcomes` and `readTrustClaimDetail`. Done when: all three intake surfaces persist `trust.claim` evidence and outcomes through `AnalysisWorkflow`. Cheaper substitute: testing `runClaimDetectionWithLogos` only outside the workflow. Source: D05 T02 §2 completion review (`docs/reviews/05-trust/D05-T02-s2.md`, G7).
- [ ] Commit: `trust: workflow and global registry wiring for claims`

**Test checkpoint:** `pnpm exec vitest run --project worker test/pipeline/analysis-workflow.test.ts test/trust/claim.test.ts` passes and fails if `trust.claim` is omitted from `defaultRegistry()`.

## 12. Claim-aware candidate selection before bounds

Filed 2026-11-03 from D05 T02 §2's completion review (`docs/reviews/05-trust/D05-T02-s2.md`, gap G8, against Mimecast Impersonation Protect): `protectedIdentities` (`src/trust/identity.ts`) returns effectively protected businesses in `org_id` order and `boundProtectedCandidates` (`src/checks/case-view.ts`) keeps the first 25 (`MAX_PROTECTED_CANDIDATES`), so once more than 25 businesses are protected, an identity at position 26 or later is omitted even when the message explicitly claims its name or domain. This section pre-selects candidates matching the message's observed names, domains, lookalikes, signature tail, or voice claim before filling the remaining slots up to `MAX_PROTECTED_CANDIDATES`.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Rank and pre-select relevant protected identities against the case's observed headers, signature window, and voice claim before applying `MAX_PROTECTED_CANDIDATES`. Done when: a protected business at registry position 26 or later is included in `view.protectedCandidates` whenever the case claims its display name, domain, lookalike domain, signature, or voice identity.
2. Preserve deterministic ordering and omission accounting for remaining candidates. Done when: `omitted` still counts any unselected protected identities past the 25-candidate bound when registered logos remain uncompared.

- [ ] Add `selectProtectedCandidatesForView` in `src/trust/claim.ts` (and wire it into `boundProtectedCandidates` or the `checks` step in `src/pipeline/analysis-workflow.ts`) so any effectively protected identity whose name or domain matches the message's From/Reply-To headers, lookalike skeleton, last-15-line signature window, or voice claim is placed ahead of unmatched identities before slicing to `MAX_PROTECTED_CANDIDATES`. Done when: `test/trust/claim.test.ts` seeds 40 protected identities in D1 and proves identity #35 is selected and matched when claimed by display name, lookalike domain, signature, or voice. Cheaper substitute: slicing the first 25 rows by `org_id` alone. Source: D05 T02 §2 completion review (`docs/reviews/05-trust/D05-T02-s2.md`, G8).
- [ ] Order each selected candidate's matching display names and domains ahead of non-matching ones before applying `MAX_CANDIDATE_NAMES` (10) and `MAX_CANDIDATE_DOMAINS` (10) in `boundProtectedCandidates` (`src/checks/case-view.ts`). Done when: a business with 15 registered aliases or domains still matches when the message uses alias #14 or domain #14. Cheaper substitute: truncating names and domains in registration order without checking the message. Source: D05 T02 §2 completion review (`docs/reviews/05-trust/D05-T02-s2.md`, G8).
- [ ] Preserve `omitted`, `namesOmitted`, and `domainsOmitted` accounting when unselected identities with registered logos remain outside the 25-candidate bound, so logo-only claims past the bound still report partial coverage honestly. Done when: `test/trust/claim.test.ts` verifies both a pre-selected textual match at position #35 and honest partial coverage when uncompared registered logos remain past the bound. Cheaper substitute: zeroing `omitted` after pre-selection. Source: D05 T02 §2 completion review (`docs/reviews/05-trust/D05-T02-s2.md`, G8).
- [ ] Commit: `trust: claim-aware candidate selection before bounds`

**Test checkpoint:** `pnpm exec vitest run --project worker test/trust/claim.test.ts test/checks/case-view.test.ts` passes and fails if a claimed identity at registry position 35 is dropped by the 25-candidate cap.

## 13. Comparative impersonation and logo ablation

Filed 2026-11-03 from D05 T02 §2's completion review (`docs/reviews/05-trust/D05-T02-s2.md`, gap G10, against Mimecast Impersonation Protect): stubbed unit tests prove functional correctness of `trust.claim`, but do not measure detection rate, false-positive rate, latency, or the incremental contribution of registered-logo comparison (`compareClaimLogos`) on the labelled evaluation corpus against a baseline rules-only indicator set.

**Phase:** 7
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Score `trust.claim` with and without registered-logo comparison (`compareClaimLogos`) and voice claim extraction on the labelled impersonation and benign evaluation sets. Done when: `eval/RESULTS.md` and `docs/frontier-log.md` record detection rate, false-positive rate, median/p95 latency, and the ablation delta for registered-logo comparison.
2. Compare the measured indicators against the documented Mimecast Impersonation Protect indicator baseline (display-name, Reply-To mismatch, and domain similarity). Done when: the dated table records where logo and voice claim routes catch attacks that header/domain rules miss.

- [ ] Add an impersonation claim ablation arm in `eval/` that runs the labelled impersonation and genuine controls with all `trust.claim` routes enabled versus header/domain-only indicators (Mimecast Impersonation Protect baseline: display-name, Reply-To, and domain similarity) and with registered-logo comparison (`compareClaimLogos`) ablated. Done when: `test/node/eval-metrics.test.ts` validates the arm's per-route detection, false-positive, cost, and latency breakdown. Cheaper substitute: unit tests with stubbed model responses only. Source: D05 T02 §2 completion review (`docs/reviews/05-trust/D05-T02-s2.md`, G10).
- [ ] Run the comparative evaluation within the shared Meta budget ledger (`~/isitlegit-data/ledgers/meta-spend.json`) and record the dated results in `eval/RESULTS.md` and `docs/frontier-log.md` against the spec 4.9 targets (at least 95% detection, at most 2% false positives, median under 60 seconds, p95 under 3 minutes). Done when: `eval/RESULTS.md` and `docs/frontier-log.md` contain the dated table with denominators, commit SHA, spend, and registered-logo ablation delta. Cheaper substitute: claiming superiority without a measured ablation table. Source: D05 T02 §2 completion review (`docs/reviews/05-trust/D05-T02-s2.md`, G10).
- [ ] Commit: `eval: comparative impersonation and registered-logo ablation`

**Test checkpoint:** `pnpm exec vitest run --project node test/node/eval-metrics.test.ts && grep -n "registered-logo ablation" docs/frontier-log.md` passes.

## Verification

- The demo impersonation case works end to end: counterparty reply, alert to the protected business, and no registered detail anywhere outside its owner's console.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
