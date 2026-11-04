---
schema_version: 1
id: closed-loop-verification
domain: 05-trust
status: active
title: "TODO-03 -- Closed-Loop Bank Verification"
track: day-5
---

# TODO-03 -- Closed-Loop Bank Verification

> **Goal:** When an invoice's bank details differ from the supplier's registered or ledger account, IsItLegit emails the supplier's registered finance contact from `verify@isitlegit.co.za` asking them to confirm, and attaches their answer to the case, so the member sees the supplier's own word before paying.

> **Current state:** Measured 2026-10-26 20:00 SAST. Bank-change detection comes from D06 T01 §3; the registry from D05 T01. During the event the registered contacts are demo aliases only (design spec section 11).

## Inputs

- Design spec 2a (closed-loop bank verification), 4.6a (recipients from code only), 11 (Outbound decision).
- -> XREF: D06 T01 §3 -- the bank-change rule that starts a verification request

## Outcome

- The tampered-invoice demo case sends one verification request to the fictional supplier's alias; a reply to it is attached to the case and shown on the report.

**Adjacency:** list=applicable @ D07 T03 §3; document=applicable @ D07 T03 §3; settings=not-applicable (the request text and expiry are fixed in code); reporting=not-applicable (verification outcomes are shown per case); notifications=applicable @ D05 T03 §1; permissions=applicable @ D05 T03 §2; audit=applicable @ D05 T03 §1; exchange=not-applicable (nothing is imported or exported); reverse=not-applicable (a request cannot be unsent; it expires after 72 hours)

**Adjacency rationale:** The request and the reply appear on the case's report as evidence cards; only the registered contact's reply, matched by a signed token, can update a case.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Verification request to the contact | D06 T01 §3, D05 T01 §1 | [ ] |
| 2 | §2 | Reply capture into the case | §1 | [ ] |

## 1. Verification request to the contact

> **Started:** 2026-11-04T08:12:11.509439+00:00

The recipient is the supplier's registered finance contact from code and stored records, never from the invoice or a model (spec 4.6a). One request per case; the body states the amount and the last three digits of the account on the invoice (the invoice is the member's document) and asks for a yes or no reply.

**Phase:** 7
**Needs:** none
**Surface:** no

**Delivery decision 2026-11-04:** Coordinator allocated migration 0093; historical 0012 is not available. Coordinator assigned shared workflow/evidence registry and integration tests exclusively to checks (console-scope-ownership, 2026-11-04 10:14 SAST); this section cannot stamp with an uncalled helper. Request evidence and messages disclose only invoice-owned last-three digits, never registered bank details.

**Build order:**

1. Send the request. Done when: the demo fixture sends one `verify` mail with a signed reply token.

- [ ] Add migration `0093_verifications.sql` with `verifications` (`case_id`, `supplier_org_id`, `token_hash`, `sent_at`, `expires_at` 72 hours, `answer` nullable, `answered_at`). Done when: it applies locally.
- [ ] Build the request in `src/trust/verify-request.ts` from `verify@isitlegit.co.za` with `Reply-To: verify+<token>@isitlegit.co.za`. Done when: `test/trust/verify-request.test.ts` snapshots it.
- [ ] Send only to the identity's `finance_contact_email` through the allowlist, once per case. Done when: the test proves the invoice's own contact address is never used. Cheaper substitute: replying to the invoice sender.
- [ ] Add a `verification.requested` evidence item. Done when: the case shows it.
- [ ] Send a verification request only while the organisation has `closed-loop` (`hasFeature`, D07 T02 §8), checked when the queued request runs. Done when: an organisation that lapses before its queued request runs sends nothing, an entitled one sends, and removing the check fails the test. Source: D07 T02 §8 plan review.
- [ ] Persist a unique case request before sending, with a 72-hour expiry, recipient hash, immutable invoice amount/currency/last-three snapshot and token hash; derive the opaque reply token using full 256-bit HMAC-SHA-256, base64url without padding, under the existing auth secret with a versioned domain separator binding case, owner, supplier, source run/evidence/attachment, amount/currency/last-three, recipient hash, request nonce and expiry, permit its plaintext only in transient mail construction and outbound Reply-To, never persisted rows, logs, evidence or Workflow results. Done when: concurrent and replayed attempts never resubmit a sent or uncertain delivery and a resumed request uses the same token; the reply address remains within the mailbox local-part limit, different requests have different tokens, and modified context fails token-hash verification.
- [ ] Select only a stored `invoice.bank_changed` registry mismatch for this case and its actual owning organisation; re-read the supplier's effective protection and verified finance contact and the caller's entitlement at execution. On retry require unchanged source evidence and recipient hash against the pinned request, and refuse sends at or after expiry. Refuse ambiguous multiple supplier/account requests rather than silently confirm all invoices through one reply. Done when: cross-tenant, lapsed, ledger-only, missing/unverified contact, multiple conflicting invoices, changed contacts/source evidence, expired requests and malformed evidence send nothing with explicit outcomes, and the registered account never appears in a message or evidence.
- [ ] Preserve SMTP2GO's sent/failed/refused/uncertain distinction and durable idempotency key, adding `verification.requested` only for a confirmed send and explicit unavailable coverage otherwise. Done when: storage failure, transport uncertainty and replay do not fabricate delivery or send twice; evidence recovery after a confirmed send does not submit again. A bounded delivery refresh after mail reconciliation updates previously uncertain evidence from the persisted provider outcome without issuing mail, including after a case has completed; its shared scheduling hook belongs to checks/coordinator integration.
- [ ] Connect the service after persisted invoice rules in the queued analysis workflow, with the `verification` producer admitted through the evidence registry. Checks exclusively owns shared pipeline/registry integration and its tests; console returns validated-shape evidence drafts to that caller without bypassing addEvidence. Done when: a targeted workflow integration test triggers the service from a stored registry mismatch and proves entitlement is checked when execution occurs, not only when intake queued the case. Reply routing and answer handling remain owned by §2.
- [ ] Commit: `trust: verification request to the registered finance contact`

**Test checkpoint:** `pnpm exec vitest run --project worker test/trust/verify-request.test.ts test/pipeline/verification-request.test.ts` passes and fails if the recipient comes from the invoice, a changed/expired request sends, a token leaks into durable workflow results or logs, or queued invocation and reconciled-delivery recovery are removed. The pipeline test is delivered by checks and is required before completion.

## 2. Reply capture into the case

Replies to `verify+<token>@isitlegit.co.za` arrive through Email Routing (a rule routing `verify@` to the Worker) and are matched by token and by sender (must be the registered contact). The answer (confirmed, denied, unclear) is extracted from the first lines by rules, not a model, and becomes evidence.

**Phase:** 7
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Route `verify@` to the Worker and parse replies. Done when: a fixture reply from the contact updates the case.
2. Refuse forged replies. Done when: a reply from another sender or with a bad token changes nothing.

- [ ] Add an Email Routing rule `verify@isitlegit.co.za` (with subaddressing) to the Worker. Done when: the rule reads back enabled.
- [ ] In the email handler, route `verify+<token>@` to `handleVerificationReply`, matching the token hash and requiring the sender to equal the registered contact. Done when: `test/trust/verify-reply.test.ts` covers valid, wrong sender, wrong token and expired.
- [ ] Read the answer from the reply's first non-quoted lines: yes, correct, confirmed means confirmed; no, not ours, fraud means denied; else unclear. Done when: the test covers each.
- [ ] Add `verification.answered` evidence (critical on denied, info on confirmed, medium on unclear) and notify the member's case page. Done when: the report shows it.
- [ ] Commit: `trust: capture verification replies`

**Test checkpoint:** `pnpm exec vitest run test/trust/verify-reply.test.ts` passes and fails if a reply from an unregistered sender is accepted.

## Verification

- A bank-change case triggers one request to the registered contact and the contact's reply lands on the case; forged replies change nothing.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
