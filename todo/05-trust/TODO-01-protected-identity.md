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

**Corrected 2026-10-31** (plan review, 4 P1 and 4 P2, `docs/reviews/05-trust/D05-T01-s1.md`): (7) the finance contact is also the identity's alert recipient (D05 T02 §4, D05 T04 §5 read it through `identityContact`); verifying an address proves the organisation owns it, and whether mail may go to it is decided at send time by `isAllowedRecipient` (`src/mail/allowlist.ts`, spec 11), never here; (8) protection is effective only while its prerequisites hold: `getIdentity` and `findIdentityByClaim` read a verified domain and a still-verified finance contact at read time, so removing either through the domain routes (`src/auth/domains.ts`) ends protection without touching this table; (9) a logo is written under a fresh key `ident/<org>/logo-<id>.<ext>` and referenced by a conditional update in one batch with its event, the previous object deleted only after that commit; (10) these are internal helpers whose `orgId` always comes from the caller's authenticated organisation (D07 T02's session), never from request input, and a claim match returns only `{ orgId, name, matchedBy }`, never a contact, logo or bank field; (11) a change and its audit event commit together in one D1 batch.

**Build order:**

1. Add the identity and audit tables. Done when: the migration applies, its constraints refuse malformed rows, and a test creates an identity and reads its events.
2. Store the logo. Done when: a PNG or SVG upload is validated, sanitised, stored under a fresh key and referenced only after it is written, with removal as its reverse.

- [x] Add migration `0047_identity.sql` with `identities` (`org_id` primary key referencing `organization` on delete cascade, `display_names_json` a JSON array, `finance_contact_email` lower-case or null, `logo_r2_key` and `logo_media_type` both null or both set with the key under `ident/<org_id>/`, `protected` 0 or 1, `updated_at`, `updated_by`) and `trust_events` (`id`, `org_id` referencing `organization`, `actor`, `kind` from a closed list, `detail_json` a JSON object, `created_at`). Done when: `test/trust/identity.test.ts` stores a valid row in each and D1 refuses a row for a missing organisation, a non-array name list, a key outside its organisation's prefix, a key without a media type, and an unknown event kind. Done 2026-10-31: `src/db/migrations/0047_identity.sql`; test "the schema".
- [x] Write `src/trust/identity.ts` with `getIdentity(db, orgId)` and `setIdentity(db, orgId, actor, input)` (a strict zod schema: 1 to 10 display names of 1 to 120 characters, none empty or duplicated once normalised, the finance contact, the protected switch; unknown fields refused), the change and its `trust_events` row in one `db.batch`. Done when: the test reads back a stored identity, replaces its names (a removed name gone), and sees each schema refusal: zero names, eleven names, a 121-character name, a name of punctuation only, two names equal once normalised, an unknown field. Done 2026-10-31: `getIdentity`, `setIdentity`, `IdentityInput`; tests "setIdentity".
- [x] Prove the change and its event commit together. Done when: with a test trigger that aborts `trust_events` inserts, `setIdentity` fails and the identity reads back unchanged. Done 2026-10-31: test "commits a change and its event together, or neither".
- [x] Refuse a finance contact that is not a verified address of this organisation (`org_addresses`, state `verified`), naming the refusal; expose it as the alert recipient through `identityContact(db, orgId)`, which re-reads its verification. Done when: an unverified address and another organisation's verified address are refused, a verified one is stored and returned by `identityContact`, and a verified contact that `isAllowedRecipient(..., "verify")` refuses (not a demo alias) is still stored, eligibility being the mail layer's. Done 2026-10-31: `identityContact`; tests "the finance contact".
- [x] Refuse to switch `protected` on without a verified domain and a finance contact, each missing piece named, and allow switching it off at any time. Done when: each missing piece gives its own refusal, the complete identity is protected, and switching off reads back off. Done 2026-10-31: tests "protection".
- [x] Compute effective protection at read time: `getIdentity` returns `effective` (true only while the switch is on, a domain is verified and the finance contact is still verified, else the reason), and `identityContact` returns null when the contact is no longer verified. Done when: after activation, deleting the last verified domain and, separately, the contact's verified address (as `src/auth/domains.ts` does) each make `effective` false with its reason and remove the identity from claim matches. Done 2026-10-31: `effectiveOf`; test "ends when the last verified domain or the contact's verified address is removed".
- [x] Write `findIdentityByClaim(db, { displayName, domain })` returning `{ orgId, name, matchedBy }[]` for effectively protected identities: a display name matched after normalisation (Unicode NFKC, case folded, punctuation removed, white space collapsed) or a domain in registrable form (`registrable` from `src/auth/senders.ts`) against the organisation's verified domains. Done when: the test matches "Hadeda Couriers (Pty) Ltd" by "hadeda  couriers pty ltd" and by a subdomain of its domain, finds two identities that share a name, finds none for an unrelated name, an unrelated domain, an unprotected identity or an unverified domain, and the result has exactly those three keys. Done 2026-10-31: `findIdentityByClaim`, `normaliseName`; test "findIdentityByClaim".
- [x] Prove tenancy with two organisations. Done when: `setIdentity` and `storeLogo` for one never change the other's row, events or objects, and `getIdentity` of one never returns the other's fields. Done 2026-10-31: test "tenancy" and the logo keys under each organisation's prefix ("storeLogo and removeLogo").
- [x] Write `storeLogo(bucket, db, orgId, actor, bytes, claimedType)` in `src/trust/logo.ts`: the claimed type must match the bytes; PNG read chunk by chunk (signature, IHDR first with a valid CRC and at most 4096 by 4096, at least one IDAT, IEND last) and SVG by its root element; at most 2 MiB. Done when: a valid PNG and SVG round-trip, and a truncated PNG, a bad IHDR CRC, a PNG 4097 pixels wide or high, a 2 MiB plus one byte file, a GIF claiming to be PNG and a PNG claiming to be SVG are each refused with the previous logo intact. Done 2026-10-31: `storeLogo`, `pngProblem`; tests "validation" and "refuses an oversized file".
- [x] Rebuild an SVG from an allowlist of elements and attributes (no `script`, `foreignObject`, event handlers, `style` with `url(` or `@import`, any `href` that is not a `#` fragment, no external entities), refusing one left with no drawable element. Done when: a hostile SVG fixture is stored without its script, handler, external image or styled URL and with its paths and text intact, and one that is only a script is refused. Cheaper substitute: storing SVG as uploaded. Done 2026-10-31: `sanitiseSvg`; tests "rebuilds a hostile SVG" and "refuses an SVG with nothing left to draw".
- [x] Replace a logo safely: put the new object under `ident/<org>/logo-<id>.<ext>`, then in one batch update the identity conditionally on the previous key and write the event, then delete the previous object; delete the new object when the update loses a race or fails, and record a failed delete of the old one in the event. Done when: the test injects a failing R2 put (identity unchanged), a failing D1 batch (new object deleted, old intact and referenced), a lost race (the winner's logo referenced, the loser's object gone) and a failing old-object delete (new logo referenced, the event naming the orphan). Done 2026-10-31: tests "keeps the previous logo", "deletes the new object", "lets the first of two uploads win", "names the orphan".
- [x] Write `removeLogo(bucket, db, orgId, actor)`: clear the reference and write the event in one batch, then delete the object. Done when: the test removes a logo, reads no reference and no object, and finds the event. Done 2026-10-31: `removeLogo`; test "stores a PNG and an SVG under fresh keys".
- [x] Log every identity change, logo store and removal to `trust_events` (who, which fields changed, never the values of a bank field). Done when: the test reads one event per change naming its fields. Done 2026-10-31: `eventStatement`; the events read in "setIdentity" and "storeLogo and removeLogo".
- [x] Close the completion review's gaps (`docs/reviews/05-trust/D05-T01-s1.md`): protection switched off without repairing a revoked contact; SVG names kept in their case and every attribute value checked decoded (`src/trust/svg.ts`); one root and no stray text or undeclared entity; PNG pixel data decoded against its header (`pngPixelsProblem`); a failed cleanup recorded on its own event or as `identity.logo_orphaned`; two organisations' logos kept apart. Done when: `test/trust/logo.test.ts` "completion review" and `test/node/logo-render.test.ts` (Chromium draws each sanitised logo pixel for pixel as uploaded, and a lowercased name breaks it) pass. **Added 2026-10-31** (completion review).
- [ ] Commit: `trust: protected identity model and logo upload`

**Test checkpoint:** `pnpm exec vitest run test/trust/identity.test.ts test/trust/logo.test.ts test/node/logo-render.test.ts` passes, and fails if an SVG script survives, an unverified finance contact is stored, protection outlives its domain, or a failed write leaves a reference to a missing logo. (**Corrected 2026-10-31**, completion review: the render test added.)

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
- [ ] Make registration one journey and measure it against Microsoft Defender's impersonation-protection settings (the completion review of §1, Part 2): every required field and its refusal on one page, one save once they are filled, the verified domains of D07 T02 §15 reused, and keyboard and screen-reader paths for every control and refusal state. Done when: `test/web/identity-page.test.ts` completes registration with one save and reaches every control and refusal by keyboard with an accessible name. **Added 2026-10-31** (D05 T01 §1's completion review).
- [ ] Gate the identity page with `requireFeature("identity")` (D07 T02 §8). Done when: a free and an expired organisation get the plan refusal and no change is made, a trial or Protect organisation edits its identity, and removing the gate fails the test. Source: D07 T02 §8 plan review.
- [ ] Commit: `web: protected identity console page`

**Test checkpoint:** `pnpm exec vitest run test/web/identity-page.test.ts` passes and fails if a member can post an edit.

## Verification

- Identities are registered with encrypted, match-only bank accounts; no surface reveals a stored number.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
