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

> **Started:** 2026-10-31T12:15Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) the migration is `0047_identity.sql` (the coordinator's number; the plan said `0010`, long since taken); (2) the audit log the Adjacency line places at §2 (`trust_events`) is created here, so identity changes are logged from the first section and §2 adds bank events to the same table; (3) no "demo business" flag exists, and none is needed: a demo business's contacts are aliases on `isitlegit.co.za` (spec 11, Outbound), which verify through the same address claim as any other (D07 T02 §5), so "a verified address of the organisation" covers both; (4) `findIdentityByClaim` returns every protected identity a claim matches (two businesses can share a trading name), and only protected ones, since an unprotected identity is a draft; (5) the logo is stored by `storeLogo` in `src/trust/logo.ts` and served only through §3's page, as an image, never inline; (6) an organisation's own `organization.logo` column (Better Auth) is not this logo and is not touched.

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Add the identity and audit tables. Done when: the migration applies and a test creates an identity and reads its events.
2. Store the logo. Done when: a PNG or SVG upload is sniffed, size-limited, sanitised and stored under `ident/<org>/logo.<ext>`.

- [ ] Add migration `0047_identity.sql` with `identities` (`org_id` primary key referencing `organization`, `display_names_json`, `finance_contact_email`, `logo_r2_key`, `logo_media_type`, `protected` 0 or 1, `updated_at`, `updated_by`) and `trust_events` (`id`, `org_id`, `actor`, `kind`, `detail_json`, `created_at`), with CHECKs on every column's form. Done when: `pnpm db:migrate:local` applies it and `test/trust/identity.test.ts` creates a row in each.
- [ ] Write `src/trust/identity.ts` with `getIdentity(db, orgId)`, `setIdentity(db, orgId, actor, input)` validated by a strict zod schema (1 to 10 display names of 1 to 120 characters, the finance contact, the protected switch), and `findIdentityByClaim(db, { displayName, domain })` matching a display name case-, space- and punctuation-insensitively or a domain in registrable form against the organisation's verified domains, protected identities only. Done when: `test/trust/identity.test.ts` finds an identity by a display name and by a subdomain of its verified domain, finds two that share a name, and finds none for an unprotected identity or an unverified domain.
- [ ] Refuse a finance contact that is not a verified address of the organisation (`org_addresses`, state `verified`), naming the refusal. Done when: an unverified address and another organisation's verified address are refused and a verified one is stored.
- [ ] Refuse to switch `protected` on without at least one verified domain and a finance contact, naming what is missing. Done when: each missing piece gives its own refusal and the complete identity is protected.
- [ ] Write `storeLogo(bucket, db, orgId, actor, bytes, claimedType)` in `src/trust/logo.ts`: PNG by signature and IHDR (at most 4096 by 4096) or SVG by its root element, at most 2 MiB, the SVG rebuilt from an allowlist of elements and attributes (no `script`, `foreignObject`, event handlers, `style` with `url(` or `@import`, or `href` that is not a `#` fragment), stored at `ident/<org>/logo.png` or `.svg` with the other extension removed, and the key recorded on the identity only after the write succeeds. Done when: a hostile SVG fixture is stored without its script, handler, external image or styled URL, a PNG over 4096 pixels wide and a 2 MiB plus one byte file are refused, and a GIF claiming to be PNG is refused. Cheaper substitute: storing SVG as uploaded.
- [ ] Log every identity change and logo store to `trust_events` (who, which fields changed, never the values of a bank field). Done when: the test reads one event per change naming its fields.
- [ ] Commit: `trust: protected identity model and logo upload`

**Test checkpoint:** `pnpm exec vitest run test/trust/identity.test.ts test/trust/logo.test.ts` passes, and fails if an SVG script survives or an unverified finance contact is stored.

## 2. Encrypted bank accounts, match-only

Bank account numbers are encrypted with AES-GCM under `BANK_KEY` (Worker secret, vault item "IsItLegit bank key") and compared by a keyed HMAC so matching never decrypts in bulk (spec 2a, `AGENTS.md`). No function returns a stored number to a caller outside the owning organisation's console, and even there only the last three digits are shown.

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/trust/bank.ts` with `addAccount`, `matchBankAccount` and `maskedAccounts`. Done when: tests show match and no match without exposing numbers.

- [ ] Add migration `0048_bank.sql` (**Corrected 2026-10-31:** was `0011_bank.sql`; the coordinator's number) with `bank_accounts` (`org_id`, `bank_name`, `branch_code`, `holder`, `number_ciphertext`, `number_hmac`, `last3`, `added_by`, `added_at`). Done when: it applies locally.
- [ ] Write `addAccount` normalising the number (digits only), encrypting with AES-GCM (random 96-bit IV) and storing an HMAC-SHA256 under a second key `BANK_MATCH_KEY`. Done when: `test/trust/bank.test.ts` round-trips through `decryptForOwner` only.
- [ ] Write `matchBankAccount(orgId, { number, branchCode })` returning `{ match: boolean }` and nothing else. Done when: the test proves the return value has no other field.
- [ ] Write `maskedAccounts(orgId)` returning bank name, branch code, holder and `***<last3>` for the owner's console. Done when: the test finds no full number in its output.
- [ ] Log every add, remove and match to `trust_events` (created by §1; who, what kind, result; never the number). Done when: the test finds the events and greps them for digits beyond three.
- [ ] Rate-limit `matchBankAccount` per caller organisation and per protected organisation (20 per hour each) to stop enumeration (spec 2a). Done when: the 21st match in an hour is refused.
- [ ] Commit: `trust: encrypted bank accounts with match-only access`

**Test checkpoint:** `pnpm exec vitest run test/trust/bank.test.ts` passes and fails if any function other than `decryptForOwner` returns a full number.

## 3. Protected identity console page

Owners and admins manage the identity: display names, verified domains and addresses (linked from D07 T02 §15, split from §7 on 2026-10-30), logo, finance contact, bank accounts (add, remove, masked view), and the protected switch. Members see it read-only.

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
