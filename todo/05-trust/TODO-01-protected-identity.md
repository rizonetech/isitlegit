---
schema_version: 1
id: protected-identity
domain: 05-trust
status: active
title: "TODO-01 -- Protected Identities and Encrypted Bank Accounts"
track: day-5
---

# TODO-01 -- Protected Identities and Encrypted Bank Accounts

> **Goal:** A member organisation registers itself as a protected identity: its verified domains, sending addresses, logo and bank accounts; bank account numbers are encrypted at rest and can only be matched, never revealed; owners and admins manage the identity on a console page.

> **Current state:** Measured 2026-10-26 20:00 SAST. Verified domains and addresses exist from D07 T02 §5; nothing else of the identity exists.

## Inputs

- Design spec 2a (protected identity, privacy rules: match or no match only), 4.8 (POPIA), 11 (Outbound: demo businesses' contacts are aliases).
- `AGENTS.md` safety contract ("registered bank details are never revealed to a checker").
- -> XREF: D05 T02 §3 -- counterparty checks compare mail against this registry
- -> XREF: D06 T01 §3 -- the invoice bank-change rule matches against registered accounts

## Outcome

- An organisation with a registered logo and bank account exists; `matchBankAccount(org, details)` returns match or no match, and no API, page or log ever returns the stored number.

**Adjacency:** list=applicable @ D05 T01 §3; document=not-applicable (the identity is not a carried document); settings=applicable @ D05 T01 §3; reporting=applicable @ D07 T05 §2; notifications=applicable @ D05 T02 §4; permissions=applicable @ D05 T01 §3; audit=applicable @ D05 T01 §2; exchange=not-applicable (no bulk import of identities during the event); reverse=applicable @ D05 T01 §3

**Adjacency rationale:** The identity page (§3) lists and edits domains, addresses, logo and accounts, with owner and admin permission and removal as the reverse path; every change and match is logged (§2); impersonation alerts are the notification (D05 T02 §4).

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Protected identity data model and logo upload | D07 T02 §5 | [ ] |
| 2 | §2 | Encrypted bank accounts, match-only | §1 | [ ] |
| 3 | §3 | Protected identity console page | §2, D07 T01 §10 | [ ] |

## 1. Protected identity data model and logo upload

The identity record ties together what a business really uses (spec 2a): display names, verified domains and addresses (from D07 T02), the registered logo (R2), and the finance contact who answers bank verification requests.

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Add the identity tables. Done when: the migration applies and a test creates an identity.
2. Store the logo. Done when: a PNG or SVG upload is sniffed, size-limited and stored under `ident/<org>/logo`.

- [ ] Add migration `0010_identity.sql` with `identities` (`org_id`, `display_names_json`, `finance_contact_email`, `logo_r2_key`, `protected` boolean, `updated_at`). Done when: it applies locally.
- [ ] Write `src/trust/identity.ts` with `getIdentity`, `setIdentity` (zod-validated) and `findIdentityByClaim({ displayName, domain })`. Done when: `test/trust/identity.test.ts` finds an identity by a display name and by a domain.
- [ ] Accept a logo upload (PNG or SVG, at most 2 MiB, SVG sanitised by removing scripts and external references) to `ident/<org>/logo.<ext>`. Done when: a hostile SVG fixture is stored without its script. Cheaper substitute: storing SVG as uploaded.
- [ ] Require the finance contact to be a verified address of the organisation (or a demo alias for demo businesses). Done when: an unverified address is refused.
- [ ] Commit: `trust: protected identity model and logo upload`

**Test checkpoint:** `pnpm exec vitest run test/trust/identity.test.ts` passes and fails if an SVG script survives.

## 2. Encrypted bank accounts, match-only

Bank account numbers are encrypted with AES-GCM under `BANK_KEY` (Worker secret, vault item "IsItLegit bank key") and compared by a keyed HMAC so matching never decrypts in bulk (spec 2a, `AGENTS.md`). No function returns a stored number to a caller outside the owning organisation's console, and even there only the last three digits are shown.

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/trust/bank.ts` with `addAccount`, `matchBankAccount` and `maskedAccounts`. Done when: tests show match and no match without exposing numbers.

- [ ] Add migration `0011_bank.sql` with `bank_accounts` (`org_id`, `bank_name`, `branch_code`, `holder`, `number_ciphertext`, `number_hmac`, `last3`, `added_by`, `added_at`). Done when: it applies locally.
- [ ] Write `addAccount` normalising the number (digits only), encrypting with AES-GCM (random 96-bit IV) and storing an HMAC-SHA256 under a second key `BANK_MATCH_KEY`. Done when: `test/trust/bank.test.ts` round-trips through `decryptForOwner` only.
- [ ] Write `matchBankAccount(orgId, { number, branchCode })` returning `{ match: boolean }` and nothing else. Done when: the test proves the return value has no other field.
- [ ] Write `maskedAccounts(orgId)` returning bank name, branch code, holder and `***<last3>` for the owner's console. Done when: the test finds no full number in its output.
- [ ] Log every add, remove and match (`trust_events`: who, what kind, result; never the number). Done when: the test finds the events and greps them for digits beyond three.
- [ ] Rate-limit `matchBankAccount` per caller organisation and per protected organisation (20 per hour each) to stop enumeration (spec 2a). Done when: the 21st match in an hour is refused.
- [ ] Commit: `trust: encrypted bank accounts with match-only access`

**Test checkpoint:** `pnpm exec vitest run test/trust/bank.test.ts` passes and fails if any function other than `decryptForOwner` returns a full number.

## 3. Protected identity console page

Owners and admins manage the identity: display names, verified domains and addresses (linked from D07 T02 §7), logo, finance contact, bank accounts (add, remove, masked view), and the protected switch. Members see it read-only.

**Phase:** 5
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, protected identity section
**Job:** a business owner tells IsItLegit what their real identity is, so impersonation can be caught
**Treatment:** plain words, the privacy promise stated beside the bank fields, every change confirmed
**Chrome:** `AppShell`, `Field`, `Button`, `EmptyState`, `ErrorState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build `src/web/pages/identity.tsx`. Done when: an owner adds and removes each item in a rendered-page test.
2. Enforce roles. Done when: a member's edit attempt gets 403 and sees no edit controls.

- [ ] Build the page sections (names, domains link, logo upload with preview, finance contact, bank accounts with masked numbers, protected switch) against the SPEC. Done when: `test/web/identity-page.test.ts` finds each control by accessible name. Cheaper substitute: one free-text field for everything.
- [ ] Confirm removal of a bank account with a second step and log it. Done when: the test removes an account through the confirmation.
- [ ] Show the privacy statement "We never show your account number to anyone checking a payment. They only see whether it matches." beside the bank fields. Done when: the test finds the text.
- [ ] Refuse edits for the member role on the server and hide the controls. Done when: both assertions pass.
- [ ] Gate the identity page with `requireFeature("identity")` (D07 T02 §8). Done when: a free and an expired organisation get the plan refusal and no change is made, a trial or Protect organisation edits its identity, and removing the gate fails the test. Source: D07 T02 §8 plan review.
- [ ] Commit: `web: protected identity console page`

**Test checkpoint:** `pnpm exec vitest run test/web/identity-page.test.ts` passes and fails if a member can post an edit.

## Verification

- Identities are registered with encrypted, match-only bank accounts; no surface reveals a stored number.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
