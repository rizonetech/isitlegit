---
schema_version: 1
id: invoice-fraud
domain: 06-invoice
status: active
title: "TODO-01 -- Invoice Extraction, Supplier Ledger and Bank-Change Rules"
track: day-5
---

# TODO-01 -- Invoice Extraction, Supplier Ledger and Bank-Change Rules

> **Goal:** IsItLegit recognises invoices and payment requests, extracts the supplier, bank and payment fields with Muse Spark into a zod-checked structure, compares them with the organisation's supplier ledger and the trust registry, and raises critical evidence with a fixed action ("phone the supplier on the number in your records") when bank details, the supplier domain or the wording suggest a change of bank; members manage the ledger and mark invoices verified.

> **Current state:** Measured 2026-10-26 20:00 SAST. PDF rasterisation (D03 T02 §2) and the registry (D05 T01) are planned before this file. Live account verification with South African banks (AVS) is out of scope (spec 4.5).

## Inputs

- Design spec 4.5 (invoice fraud: fields, ledger, rules, fixed action), 4.6 (floor: bank change is critical), 5 (demo step 3), 8 (cut list: ledger CSV import).
- Meta docs `file-handling.md` (PDF as `input_file`, up to 50 pages fully covered), `structured-output.md`.
- -> XREF: D05 T03 §1 -- the closed-loop verification request this rule starts
- -> XREF: D05 T01 §2 -- the registered accounts matched for protected suppliers
- -> XREF: D07 T03 §2 -- `src/invoice/fixed-actions.ts`, the fixed actions the report draws first, and the report's actions whose ledger links §4 adds

## Outcome

- The tampered invoice fixture (fictional supplier, changed account) is flagged critical with the fixed action; its genuine twin is not.
- A member adds suppliers by hand or CSV and marks an invoice verified from its report, which grows the ledger.

**Adjacency:** list=applicable @ D06 T01 §4; document=applicable @ D07 T03 §3; settings=not-applicable (rules and the fixed action are in code); reporting=applicable @ D07 T04 §2; notifications=applicable @ D05 T03 §1; permissions=applicable @ D06 T01 §4; audit=applicable @ D06 T01 §2; exchange=applicable @ D06 T01 §4; reverse=applicable @ D06 T01 §4

**Adjacency rationale:** The ledger page lists suppliers, imports CSV and undoes a wrong "mark verified" (§4); ledger changes are logged (§2); money at risk caught is reported in the member console; a bank change starts the closed-loop request.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Invoice detection and Muse Spark field extraction | D03 T02 §2, D03 T01 §5 | [ ] |
| 2 | §2 | Supplier ledger model and queries | D07 T02 §3 | [ ] |
| 3 | §3 | Bank-change rules with the fixed action | §1, §2, D05 T01 §2 | [ ] |
| 4 | §4 | Supplier ledger page and CSV import | §2, D07 T01 §10 | [ ] |
| 5 | §5 | Synthetic invoice set with genuine and tampered pairs | §1 | [ ] |

## 1. Invoice detection and Muse Spark field extraction

Muse Spark reads the PDF natively (`input_file`) and the page images, decides whether the document is an invoice or payment request, and extracts `supplier name, supplier domain, bank, account holder, account number, branch code, amount, currency, reference, due date` (spec 4.5). The PDF's text is untrusted content.

**Corrected 2026-10-31** (the eval lane's D08 T03 §1): Muse Spark caught no spacing edits or recompressed patches on synthetic invoices and wrongly called unchanged fields edited, so it extracts fields and never reports an edit; tamper evidence on an invoice PDF is the deterministic forensics of D06 T02 §1.

**Phase:** 5
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Define `InvoiceFields` and the call. Done when: a stubbed test extracts the fields.
2. Run it live on the synthetic set. Done when: field accuracy and cost are recorded in `docs/frontier-log.md`.

- [ ] Define `InvoiceFields` in `src/invoice/schema.ts` with strict formats (South African account numbers 7 to 11 digits, branch codes 6 digits, ZAR amounts as cents integers). Done when: invalid formats fail validation in `test/invoice/schema.test.ts`.
- [ ] Call `muse-spark-1.3` through `structured()` with the PDF as `input_file` (base64) plus an untrusted note that the document text is data. Done when: `test/invoice/extract.test.ts` checks the request.
- [ ] Register `invoice.detected` (info) with the extracted fields as detail (account number masked to the last three digits in summaries). Done when: the stub yields it with a masked summary.
- [ ] Run the extraction on the synthetic set (§5) after the credit gate and record per-field accuracy and cost in `docs/frontier-log.md`. Done when: the entry exists.
- [ ] Commit: `invoice: detection and field extraction`

**Test checkpoint:** `pnpm exec vitest run test/invoice/extract.test.ts test/invoice/schema.test.ts` passes.

## 2. Supplier ledger model and queries

Per-organisation ledger of known suppliers, their domains and verified bank details (spec 4.5), stored with the same encryption and match-only rule as registered accounts (D05 T01 §2).

> **Started:** 2026-10-31T14:51Z

**Corrected 2026-10-31** (at start, checked against the repository and the coordinator's answers): (1) the migration is `0049_ledger.sql` (the coordinator's number; was `0014_ledger.sql`); (2) supplier account numbers use D05 T01 §2's keys, canonical form and HMAC (`bankKeys`, `canonicalAccount` in `src/trust/bank.ts`) and the same key epoch: `supplier_accounts` carries `key_id` and `match_key_id`, migration 0049's triggers refuse a row under other keys than `bank_key_epoch`'s, and `rekeyAccounts` and `abandonLostKeys` move or delete supplier accounts too, so a re-key never strands the ledger; (3) the ledger is the organisation's own record, matched only by its own cases, so `matchSupplierAccount` has no hourly limit and writes no match event (D05 T01 §2's limits guard another business's registry); it answers `{ match }` and refuses `NoBaseline` for a supplier with no account and `KeyMismatch` under other keys, as matching the registry does; (4) the model owns every change the ledger page (§4) and "mark verified" make: `updateSupplier`, `removeSupplier`, `addSupplierAccount` (with `verified_from_case_id`, a case of the same organisation), `removeSupplierAccount` and `listSuppliers` (masked accounts) beside the four named; (5) domains are stored as registrable domains (`registrable` in `src/auth/senders.ts`, the form `domain.lookalike` compares), each refused when it has none; (6) `domain.lookalike` (D02 T03 §2) is stamped and in this branch; its file names this section in prose only, so the two-way cross-reference waits on the checks lane's back-reference, asked through the coordinator.

**Corrected 2026-10-31** (plan review, 1 P1 and 2 P2, `docs/reviews/06-invoice/D06-T01-s2.md`): (7) a supplier's name is unique per organisation by its normalised form (`name_key`: lower case, runs of spaces as one, trimmed), and `findSupplier` never guesses: several suppliers may share a domain (`gmail.com`), so a domain match is narrowed by the name, and a result that is not exactly one supplier, or a domain and a name that point at different suppliers, is a typed `SupplierAmbiguous` refusal, so no bank baseline or phone number is taken from the wrong supplier; (8) every read and change selects by organisation as well as id, and each is tried with another organisation's ids, leaving both tenants' records and events unchanged; (9) the two account tables share one epoch, so re-keying and the lost-key recovery are proven across both: interrupted between the tables and retried, an unreadable supplier ciphertext left refused, an old-key supplier insert refused after the epoch moves, and a failed audit rolling a deletion back, with both kinds of account matching afterwards.

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Add the ledger tables and queries. Done when: tests add a supplier with a domain and account and match against it.

- [x] Add migration `0049_ledger.sql` (**Corrected 2026-10-31:** was `0014_ledger.sql`) with `suppliers` (`id`, `org_id` referencing `organization` on delete cascade, `name` 1 to 120 characters, `name_key` its normalised form unique per organisation (correction 7), `domains_json` a JSON array, `phone`, `notes` up to 1,000 characters, `created_by`, `created_at`, `updated_at`), `supplier_accounts` (the columns of `bank_accounts` plus `supplier_id` on delete cascade and `verified_from_case_id` referencing `cases` on delete set null, unique on `supplier_id` and `number_hmac`, with the key-epoch triggers of 0048) and `ledger_events` (`id`, `org_id`, `actor`, `kind`, `detail_json`, `created_at`). Done when: `test/invoice/ledger.test.ts` stores a supplier and an account, and D1 refuses a duplicate name in another case or spacing, a domains value that is not an array, and an account under keys other than the current ones. Done 2026-10-31: `src/db/migrations/0049_ledger.sql`; test "the schema".
- [x] Write `addSupplier`, `updateSupplier` and `removeSupplier` in `src/invoice/ledger.ts`: a name, up to 20 domains each stored as its registrable domain (deduplicated, a domain without one refused with `SupplierRefused`), a phone of digits with an optional leading `+`, spaces, brackets and dashes (7 to 15 digits), and notes; each change and its event in one batch. Done when: the test adds, edits and removes a supplier, refuses a bad domain, phone and duplicate name (in another case or spacing) with no event, refuses editing or removing another organisation's supplier with both tenants' records and events unchanged, and an injected event failure leaves the ledger as it was. Cheaper substitute: storing domains as typed. Done 2026-10-31: `addSupplier`, `updateSupplier`, `removeSupplier` in `src/invoice/ledger.ts`; tests "suppliers".
- [x] Write `addSupplierAccount` and `removeSupplierAccount`: canonical number and branch (`canonicalAccount`), encrypted and hashed under the current keys as `addAccount` does, `verified_from_case_id` accepted only for a case of the same organisation, each with its event in one batch. Done when: the test stores an account proven encrypted, refuses the same account twice for one supplier, another organisation's supplier or case, and keys other than the current ones (`KeyMismatch`), removes it with its event, and refuses removing another organisation's account with both tenants' records and events unchanged. Done 2026-10-31: `addSupplierAccount`, `removeSupplierAccount`; tests "supplier accounts".
- [x] Write `findSupplier(db, orgId, { name, domain })` (correction 7): the suppliers whose stored domains hold the registrable domain of `domain`, narrowed by `name_key` when a name is given; else the supplier with that `name_key`; exactly one is returned, none is null, and several, or a domain and a name naming different suppliers, refuse with `SupplierAmbiguous`; never another organisation's. Done when: the test finds by a subdomain and by a differently spaced name, narrows two suppliers sharing `gmail.com` by name, refuses the shared domain without a name and a domain and name that disagree, and returns null for another organisation's supplier. Done 2026-10-31: `findSupplier`, `SupplierAmbiguous` in `src/invoice/errors.ts`; tests "findSupplier".
- [x] Write `matchSupplierAccount(db, keys, orgId, supplierId, { number, branchCode })` returning `{ match }` and nothing else, refusing `NoBaseline` for a supplier with no account, `KeyMismatch` for keys other than the current ones, and `SupplierRefused` for another organisation's supplier. Done when: the test proves match, a different number and a different branch not matching, a formatted number matching, and each refusal. Done 2026-10-31: `matchSupplierAccount`; tests "matchSupplierAccount".
- [x] Write `listSuppliers(db, orgId)` returning each supplier with its domains, phone, notes and accounts masked as `***<last3>`. Done when: the test asserts the complete records of two suppliers and none of another organisation's. Done 2026-10-31: `listSuppliers`; asserted in the supplier and account tests.
- [x] Log every ledger change with who and when in `ledger_events` (`supplier.added`, `supplier.updated`, `supplier.removed`, `account.added`, `account.removed`), each payload an allowlist (`supplierId` and `name`; `supplierId`, `accountId`, `bankName`, `last3` and `verifiedFromCaseId`), never a number or key. Done when: the test asserts the exact actor, kind and payload of each event and finds no number in any event or error. Done 2026-10-31: `src/invoice/ledger-events.ts` `ledgerEventStatement`; exact events asserted throughout, and test "keeps every number and key out".
- [x] Move supplier accounts with the registry's keys (correction 9): `rekeyAccounts` re-keys `supplier_accounts` rows as it does `bank_accounts`, and `abandonLostKeys` deletes those under lost keys with an `account.removed` event, in `src/trust/bank.ts`. Done when: with a registered account and a supplier account, a re-key interrupted after the registry's rows and before the ledger's refuses matching both and finishes on a retry with both matching under the new keys, an unreadable supplier ciphertext is counted and left refused, an old-key supplier insert after the epoch moved is refused, the lost-key recovery deletes and audits both kinds, and an injected audit failure rolls its deletion back. Done 2026-10-31: `ACCOUNT_TABLES` in `rekeyAccounts` and `abandonLostKeys`; tests "one epoch across the registry and the ledger".
- [x] Make `listSupplierDomains(db, orgId)` in `src/checks/suppliers.ts` (the checks lane's contract, a stub returning an empty list until the ledger exists; its signature and callers stay as they are, a change asked of the checks lane through the coordinator) return the organisation's supplier domains from the ledger in registrable form, so `domain.lookalike` (the checks lane's D02 T03 §2) compares against them. Done when: a lookalike of a ledger supplier's domain is stored as high by the checks step. **Added 2026-10-30** at the checks lane's request through the coordinator; the XREF to D02 T03 §2 is added once that section is on main and in this branch. Done 2026-10-31: `src/checks/suppliers.ts`; tests "listSupplierDomains and domain.lookalike".
- [x] Keep concurrent edits and name the refused field (**Corrected 2026-10-31**, completion review gaps 1 and 5, `docs/reviews/06-invoice/D06-T01-s2.md`): `updateSupplier` sets only the fields its patch names, so two edits to different fields both stay, and each refusal names its field (name, domains, phone, notes, an unknown field) without echoing the input. Done when: a test pauses one edit at its write while another commits and both changes remain, and each bound is refused with its own reason. Done 2026-10-31: tests "keeps both of two concurrent edits to different fields" and "names the field a refusal is about".
- [ ] Commit: `invoice: supplier ledger model`

**Test checkpoint:** `pnpm exec vitest run test/invoice/ledger.test.ts test/trust/bank.test.ts` passes, and fails if a supplier account is stored in plaintext, a match answers more than `{ match }`, a supplier without an account gives a mismatch, `findSupplier` picks one of several suppliers, or `listSupplierDomains` returns a domain other than the registrable ones.

## 3. Bank-change rules with the fixed action

Rules (spec 4.5): bank details differ from the ledger or the registered account, the supplier's domain differs from the ledger, or the mail says the bank has changed: critical evidence and the fixed instruction "Confirm by phoning the supplier on the number in your records, never one from this email." A protected supplier with a no-match also starts closed-loop verification (D05 T03).

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Register the rules. Done when: the tampered fixture is critical and the genuine twin is clean.

- [ ] Register `invoice.bank_changed` (critical) when the extracted account does not match the ledger or registry for that supplier. Done when: `test/invoice/rules.test.ts` passes for the pair.
- [ ] Register `invoice.supplier_domain_changed` (high) and `invoice.change_language` (high; phrases such as "new banking details", "changed banks", "updated account", also in Afrikaans "nuwe bankbesonderhede"). Done when: fixtures yield each.
- [ ] Attach the fixed action (`bankChangeAction(phone)` from `src/invoice/fixed-actions.ts`, D07 T03 §2) to every critical invoice item and to the verdict's actions, with the ledger phone number when present. Done when: the reply for the tampered fixture contains the action and `fixedActionOf` names it `bank-change`.
- [ ] Start closed-loop verification (D05 T03 §1) when the supplier is a protected identity. Done when: the demo fixture creates a verification request.
- [ ] Apply the bank-change rules only for organisations with `bank-change` (`hasFeature`, D07 T02 §8); the free check's verdict is unchanged. Done when: an expired organisation's invoice gets no bank-change finding, an entitled one's does, and removing the check fails the test. Source: D07 T02 §8 plan review.
- [ ] Commit: `invoice: bank-change rules with the fixed action`

**Test checkpoint:** `pnpm exec vitest run test/invoice/rules.test.ts` passes and fails if a matching account is flagged.

## 4. Supplier ledger page and CSV import

Members see and manage their suppliers (spec 4.5, 4.8 dashboard): list and search, add and edit, CSV import (second on the cut list; seed by hand if cut), and "mark invoice verified" from a report, which records the supplier and account and can be undone.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, supplier ledger section
**Job:** a finance clerk keeps the list of who the business really pays and how
**Treatment:** a table that is quick to scan, masked numbers, undo for every change
**Chrome:** `AppShell`, `Field`, `Button`, `EmptyState`, `ErrorState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the ledger page. Done when: a rendered test adds, edits, searches and removes a supplier.
2. Add CSV import and mark verified. Done when: a CSV of three suppliers imports and a report's "mark verified" adds the account, with undo.

- [ ] Build `src/web/pages/suppliers.tsx` with search, the supplier table (masked accounts), add and edit forms, and removal with confirmation. Done when: `test/web/suppliers-page.test.ts` covers each. Cheaper substitute: an admin-only JSON endpoint.
- [ ] Import CSV (`name,domain,bank,branch_code,account_number,phone`), validating every row and reporting row errors without importing a partial file. Done when: a file with one bad row imports nothing and lists the error.
- [ ] Add "Mark this invoice as verified" on the report for invoice cases, recording supplier and account with `verified_from_case_id`, and "Undo" for 24 hours. Done when: the test marks and undoes.
- [ ] Add the report's ledger links (D07 T03 §2's deferral): "Open <supplier> in the ledger" after the bank-change action of an invoice case with a matched supplier, opening that supplier's row on `src/web/pages/suppliers.tsx`, and the "supplier ledger" link in a safe invoice case's action, for a member of the case's organisation only (the public signed link draws the words without the link). Done when: `test/web/report-verdict.test.ts` follows each link to its supplier for a member, a signed-link viewer gets no link, and the link is reached by keyboard. **Added 2026-10-31** (D07 T03 §2's plan review).
- [ ] Show each account's provenance in the table, "added by hand", "imported from CSV" or "verified from case <link>" (`verified_from_case_id`, D06 T01 §2), with who added it and when, so a member can tell a baseline someone typed from one confirmed on a real invoice (D06 T01 §2 completion review, gap 7, `docs/reviews/06-invoice/D06-T01-s2.md`). Done when: `test/web/suppliers-page.test.ts` renders all three. Cheaper substitute: the masked number alone. Default taken: an account is a matching baseline as soon as an owner or admin records it, with no second approval (the ledger is the organisation's own record; live bank verification is out of scope, spec 4.5); a pending state would cost a `status` column on `supplier_accounts` and a filter in `matchSupplierAccount`.
- [ ] Reach "change this supplier's bank account" in at most three actions from the supplier's row, keyboard included, excluding the details typed: the add-account form opens prefilled with the supplier, the old account is removed in the same confirmation, and success or failure is announced (D06 T01 §2 completion review, gap 6, against Eftsure's three-click change request). Done when: the rendered test counts the actions by keyboard and asserts the announcement. Cheaper substitute: separate add and remove forms.
- [ ] Allow owners and admins to edit and members to view. Done when: a member's post gets 403.
- [ ] Commit: `web: supplier ledger page, CSV import and mark verified`

**Test checkpoint:** `pnpm exec vitest run test/web/suppliers-page.test.ts` passes and fails if a partial CSV is imported.

## 5. Synthetic invoice set with genuine and tampered pairs

Three fictional suppliers (a courier, a stationery wholesaler, a cleaning service) with genuine invoices and tampered twins (changed account, changed domain, change-of-bank letter), generated as PDFs by code so tests and the demo never use real documents (spec 4.5, plan Day 5).

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Generate the PDFs. Done when: `test/fixtures/invoices/` holds 3 genuine and 9 tampered PDFs with a labels file.

- [ ] Write `scripts/fixtures/make-invoices.ts` producing PDFs with a small PDF writer (no network, fictional banks only, each stamped "SYNTHETIC TEST DOCUMENT"). Done when: the script and outputs are committed.
- [ ] Write `test/fixtures/invoices/labels.json` with the expected rule hits per file. Done when: the rules test (§3) reads it.
- [ ] Commit: `invoice: synthetic genuine and tampered invoice set`

**Test checkpoint:** `pnpm exec vitest run test/invoice/fixtures.test.ts` passes, checking each PDF opens and every label names an existing file.

## Verification

- Tampered invoices are critical with the fixed action, genuine ones are clean, and the ledger grows from verified invoices with undo.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
