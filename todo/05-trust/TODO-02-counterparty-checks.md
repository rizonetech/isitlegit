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

## 1. Counterparty intake path with rate limits

Mail from a non-member is accepted only when it carries a forwarded original that claims a protected identity (display name or domain match in `findIdentityByClaim`); anything else from a non-member is still dropped silently. Limits stop enumeration and abuse (spec 2a).

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Extend the email handler's gate. Done when: a non-member forward claiming a protected identity creates a counterparty case; one claiming nothing creates nothing.
2. Enforce limits. Done when: the sixth counterparty case from one sender in a day is refused.

- [ ] Extend `handleEmail` so a non-member message proceeds only if its original's display name or From domain matches `findIdentityByClaim`, creating a case with `channel = "counterparty"` and `org_id` of the protected business. Done when: `test/trust/counterparty-intake.test.ts` covers claim, no claim and member mail.
- [ ] Limit counterparty cases to 5 per sender address per day and 50 per protected identity per day with KV counters, dropping silently past the limit. Done when: the limit tests pass.
- [ ] Mark counterparty cases so their reply goes to the forwarding counterparty (the recipient allowlist admits the address of a counterparty case's sender for that one reply). Done when: the allowlist test admits it once and refuses a second unrelated send.
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

## Verification

- The demo impersonation case works end to end: counterparty reply, alert to the protected business, and no registered detail anywhere outside its owner's console.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
