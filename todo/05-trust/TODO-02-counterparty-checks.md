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
| 1 | §1 | Counterparty intake path with rate limits | D05 T01 §1, D01 T01 §3 | [ ] |
| 2 | §2 | Claim detection: name, domain, logo, signature, voice | §1, D03 T03 §3 | [ ] |
| 3 | §3 | Registry comparison evidence that reveals nothing | §2, D05 T01 §2 | [ ] |
| 4 | §4 | Impersonation alert to the protected business | §3, D01 T02 §2 | [ ] |
| 5 | §5 | Counterparty reply with the protected line | §3, D01 T02 §3 | [ ] |
| 6 | §6 | Verify-this-email page for a protected business | §1, D05 T01 §3 | [ ] |
| 7 | §7 | Live signature badge and its copy-paste snippet | §6 | [ ] |
| 8 | §8 | Copied-badge detection and alerts | §4, §7 | [ ] |
| 9 | §9 | Domain-locked website seal | §6, §8 | [ ] |

## 1. Counterparty intake path with rate limits

Mail from a non-member is accepted only when it carries a forwarded original that claims a protected identity (display name or domain match in `findIdentityByClaim`); anything else from a non-member is still dropped silently. Limits stop enumeration and abuse (spec 2a).

> **Started:** 2026-10-31T16:35Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) `cases.channel` admits only `email` and `upload` (`0001_core.sql`) and stays the honest transport; a counterparty case is marked by a new nullable column added in migration `0054_counterparty.sql` (the coordinator's number, 2026-10-31 18:35 SAST), `cases.origin TEXT CHECK (origin IS NULL OR origin IN ('counterparty'))`, additive only: `cases` is the parent of evidence, check outcomes, case events and intake messages on delete cascade, and a rebuild's implicit delete would wipe every case's findings, so the table is never rebuilt, and a migration test proves existing cases and their evidence untouched (counts before and after, as 0051's did); (2) the Worker has no KV binding, so the limits count in a D1 table with one atomic upsert per bucket, as the bank limiter does (`bank_match_counts`, D05 T01 §2), in fixed daily windows (SAST days, as the cap notice counts them); (3) the claim is read from the forwarded original found by `extractOriginal` (`src/intake/forward.ts`): its From display name and From domain go to `findIdentityByClaim`, never the forwarder's own, and a forward with no attached original (an inline forward) claims nothing and is dropped; (4) the forwarder, not a member, must authenticate for its own domain (`senderAuthenticated` with `domain`), so neither the per-sender limit nor the reply can be driven by a forged address: an unauthenticated non-member is dropped silently, as now; (5) more than one protected identity can match a claim: the case goes to each match only when exactly one matches, else it is dropped and logged as ambiguous, since a counterparty check answers about one business; (6) the staff-inbox item is decided by the coordinator (2026-10-31 18:36 SAST) from `design/SPEC.md` S5 and its line 807: "Free check" is a plan tier (up to 5 checks a day), not a path for mail with no organisation, so an organisation without `staff-inbox` (Free, or an expired trial) still has its members' forwards filed to it, as Free check cases within the Free tier's daily cap, with the existing daily-cap notice beyond it, and only the features `staff-inbox` adds are off; nothing is dropped and no per-sender product is invented. The cap comes from where intake already reads it (`org_limits.daily_cases`, `admitCase` in `src/db/cases.ts`); no code yet ties a plan tier to its cap, so that row is asked of its owner (D07 T08, the plan pages) through the coordinator, and this item depends on it once named.

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Extend the email handler's gate. Done when: a non-member forward claiming a protected identity creates a counterparty case; one claiming nothing creates nothing.
2. Enforce limits. Done when: the sixth counterparty case from one sender in a day is refused.

- [ ] Extend `handleEmail` so a non-member message proceeds only if its original's display name or From domain matches `findIdentityByClaim`, creating a case with `channel = "email"`, `origin = "counterparty"` (**Corrected 2026-10-31:** was `channel = "counterparty"`, correction 1) and `org_id` of the protected business. Done when: `test/trust/counterparty-intake.test.ts` covers claim, no claim and member mail.
- [ ] Limit counterparty cases to 5 per sender address per day and 50 per protected identity per day with D1 counters (**Corrected 2026-10-31:** was KV counters; the Worker has no KV binding, correction 2), dropping silently past the limit. Done when: the limit tests pass.
- [ ] Mark counterparty cases so their reply goes to the forwarding counterparty (the recipient allowlist admits the address of a counterparty case's sender for that one reply). Done when: the allowlist test admits it once and refuses a second unrelated send.
- [ ] Let staff inbox checks lapse with the plan (**Corrected 2026-10-31**, correction 6: was "answered as a free per-sender check, not filed to the organisation"): a forward from a member of an organisation without `staff-inbox` (an expired trial, free) is still filed to the organisation as a Free check case within the Free tier's daily cap, read from the plan's cap where intake reads it, with the daily-cap notice beyond it; only `staff-inbox`'s own features are off (`hasFeature`, D07 T02 §8). Done when: an expired organisation's member forward is filed until the Free tier's cap, the next one gets the cap notice and no case, nothing is dropped silently, and an entitled organisation's forward is filed under its own cap. Source: D07 T02 §8 plan review; SPEC S5.
- [ ] Commit: `trust: counterparty intake path with rate limits`

**Test checkpoint:** `pnpm exec vitest run test/trust/counterparty-intake.test.ts` passes and fails if non-member mail without a claim is processed.

## 2. Claim detection: name, domain, logo, signature, voice

A mail "claims" a protected identity through its display name, From or Reply-To domain lookalike, its logo (SAM crop matched against the registered logo), its signature block text, or a voice claim (D01 T03 §4). Each claim is evidence the comparison uses.

**Phase:** 5
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Register `trust.claim`. Done when: each claim route on a fixture yields the claimed identity.

- [ ] Detect claims by display name, domain (exact or lookalike from D02 T03 §2), signature text (company name in the last 15 lines), and `voice.claimed_identity`. Done when: `test/trust/claim.test.ts` covers each route.
- [ ] Compare the mail's logo crops with the registered logo using `compareLogo` (D03 T03 §3). Done when: a fixture with the Fynbos Freight logo yields a logo claim.
- [ ] Register `trust.claim` (info) with the routes that matched. Done when: the fixture yields it.
- [ ] Commit: `trust: claim detection`

**Test checkpoint:** `pnpm exec vitest run test/trust/claim.test.ts` passes.

## 3. Registry comparison evidence that reveals nothing

Compare the claiming mail with the registry: sending domain registered or not, address registered or not, bank details match or not (match-only), logo same or not. Findings speak in match or no-match terms only: "Fynbos Freight never sends from gmail.com" is allowed (the domain the mail used is public); "Fynbos Freight's account ends 123" never is (spec 2a).

**Phase:** 5
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

**Phase:** 5
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

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Extend `buildReply` for counterparty cases. Done when: the demo fixture's reply carries the line and the invite link.

- [ ] Add the protected line and the invite link (`https://isitlegit.co.za/?ref=protected`) for counterparty cases in `src/mail/reply.ts`. Done when: `test/trust/counterparty-reply.test.ts` finds both.
- [ ] Give the counterparty a signed report link scoped to that case only, with the protected business's private details absent from the report view. Done when: the test opens the link and finds no registered detail.
- [ ] Commit: `trust: counterparty reply with the protected line`

**Test checkpoint:** `pnpm exec vitest run test/trust/counterparty-reply.test.ts` passes.

## 6. Verify-this-email page for a protected business

The public page a signature badge links to (design spec 2a, Verifiable signature badge): `isitlegit.co.za/v/<slug>` shows the business's name, its verified sending domains, the date verified, and one clear action: forward the email you received to `check@isitlegit.co.za` as an attachment. The badge proves nothing on its own; the forwarded message's DKIM, SPF and DMARC alignment against the registered domains is the proof, through the counterparty path (§1 to §5). It never shows bank details, addresses beyond the domains, or the finance contact.

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

- [ ] Add `public_slug` (unique, lower-case, from the business name, editable once by the owner) to `identities` in migration `0018_verify_page.sql`. Done when: the demo business gets `fynbos-freight`.
- [ ] Build `GET /v/:slug` in `src/web/pages/verify.tsx` on the marketing host with the seal, the business name, its verified sending domains, the verified date, and the forward-as-attachment steps for Outlook and Gmail. Done when: `test/web/verify-page.test.ts` finds each element. Cheaper substitute: a static "this business is verified" image page.
- [ ] Show "This business is not protected by IsItLegit" with status 404 for an unknown, unprotected or lapsed identity, and never echo the requested slug as a business name. Done when: the test covers unknown and lapsed.
- [ ] Prove no private field reaches the page (bank details, addresses, finance contact) with a test that renders a fully populated identity. Done when: the leak test passes and fails on a planted field.
- [ ] Show a business as verified only while its plan includes `identity` (`hasFeature` on the protected organisation, D07 T02 §8), not from a stored switch. Done when: a lapsed organisation's verify page answers "Not verified" while its identity is still stored, and an entitled one's answers verified. Source: D07 T02 §8 plan review.
- [ ] Commit: `trust: verify-this-email page for protected businesses`

**Test checkpoint:** `pnpm exec vitest run test/web/verify-page.test.ts` passes and fails if the finance contact appears on the page.

## 7. Live signature badge and its copy-paste snippet

The badge is served live from `isitlegit.co.za/b/<slug>.png` (and `.svg`), so a lapsed protection changes every copy already sent to "Not verified" (spec 2a). The owner gets a ready signature snippet (HTML for Outlook and Gmail signature editors) with the badge linking to the verify page, built from `design/brand/logo-svg/isitlegit-badge-protected.svg`.

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

- [ ] Add a Not verified badge variant to `design/tools/build-brand.py` (grey seal, "NOT VERIFIED BY IS IT LEGIT") and regenerate the kit. Done when: `design/brand/logo-svg/isitlegit-badge-not-verified.svg` exists.
- [ ] Serve `GET /b/:slug.png` and `.svg` choosing the Protected or Not verified badge from the identity's current state, with `Cache-Control: public, max-age=3600`. Done when: `test/web/badge.test.ts` sees each variant and the header. Cheaper substitute: a static image the business hosts itself, which cannot lapse.
- [ ] Record each badge request's referring context only as a count per slug per day (no IPs, no message data). Done when: the test sees the counter rise and no address stored.
- [ ] Add the signature snippet to the identity page (D05 T01 §3): preview, copy button, and steps for Outlook (desktop and web) and Gmail. Done when: the page test copies HTML whose image source and link point to the slug.
- [ ] Serve the live badge as "Not verified" once the protected organisation's plan lapses (`hasFeature`, D07 T02 §8). Done when: the badge of a lapsed organisation reads "Not verified" and an entitled one's reads verified. Source: D07 T02 §8 plan review.
- [ ] Commit: `trust: live signature badge and snippet`

**Test checkpoint:** `pnpm exec vitest run test/web/badge.test.ts` passes and fails if a lapsed identity still gets the Protected badge.

## 8. Copied-badge detection and alerts

An attacker who copies the badge into a fake email turns it into evidence (spec 2a): when a counterparty case contains a link to `/v/<slug>` or an image from `/b/<slug>`, but the message does not pass DKIM or SPF aligned with that business's registered domains, the case gets critical "copied Protected badge" evidence and the business is alerted with the sending domain.

**Phase:** 5
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

**Phase:** 5
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

## Verification

- The demo impersonation case works end to end: counterparty reply, alert to the protected business, and no registered detail anywhere outside its owner's console.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
