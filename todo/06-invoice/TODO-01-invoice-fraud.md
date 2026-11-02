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
- -> XREF: D07 T03 §2 -- `src/invoice/fixed-actions.ts`, the fixed actions the report draws first, and the report's actions whose ledger links §6 adds (**Corrected 2026-10-31:** was §4, D06 T01 §4's correction 1)

## Outcome

- The tampered invoice fixture (fictional supplier, changed account) is flagged critical with the fixed action; its genuine twin is not.
- A member adds suppliers by hand or CSV and marks an invoice verified from its report, which grows the ledger.

**Adjacency:** list=applicable @ D06 T01 §4; document=applicable @ D07 T03 §3; settings=not-applicable (rules and the fixed action are in code); reporting=applicable @ D07 T04 §2; notifications=applicable @ D05 T03 §1; permissions=applicable @ D06 T01 §4; audit=applicable @ D06 T01 §2; exchange=applicable @ D06 T01 §4; reverse=applicable @ D06 T01 §6

**Adjacency rationale:** The ledger page lists suppliers and imports CSV (§4), and a report undoes a wrong "mark verified" (§6); ledger changes are logged (§2); money at risk caught is reported in the member console; a bank change starts the closed-loop request.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Invoice detection and Muse Spark field extraction | D03 T02 §2, D03 T01 §5 | [ ] |
| 2 | §2 | Supplier ledger model and queries | D07 T02 §3 | [x] |
| 3 | §3 | Bank-change rules with the fixed action | §1, §2, D05 T01 §2 | [ ] |
| 4 | §4 | Supplier ledger page and CSV import | §2, D07 T01 §10 | [x] |
| 5 | §5 | Synthetic invoices in genuine and tampered pairs | §1 | [ ] |
| 6 | §6 | Mark invoices verified, with undo | §3, §4, D05 T03 §1 | [ ] |

## 1. Invoice detection and Muse Spark field extraction

Muse Spark reads the PDF natively (`input_file`) and the page images, decides whether the document is an invoice or payment request, and extracts `supplier name, supplier domain, bank, account holder, account number, branch code, amount, currency, reference, due date` (spec 4.5). The PDF's text is untrusted content.

> **Started:** 2026-11-02T05:20Z

**Corrected 2026-10-31** (the eval lane's D08 T03 §1): Muse Spark caught no spacing edits or recompressed patches on synthetic invoices and wrongly called unchanged fields edited, so it extracts fields and never reports an edit; tamper evidence on an invoice PDF is the deterministic forensics of D06 T02 §1.

**Corrected 2026-11-02** (at start, checked against the tree): (1) `invoice.detected` cannot be a registered check (a model call exceeds `MAX_CHECK_MS` in `src/checks/registry.ts`, whose own note sends it to its own step) and cannot be written by `addEvidence` either, because `invoice` is not in `LATER_PRODUCERS` (`walkthrough`, `agent`, `vision`); this section adds `invoice` to `LATER_PRODUCERS` and writes the item from `src/invoice/extract.ts` through `addEvidence`, the D03 T02 §3 precedent for adding a producer family. (2) The persisted payee account needs its own table; the coordinator's ledger (`docs/coordinator.md`) reads next free 0078, handed to no lane yet, so the number is the coordinator's to confirm before the migration is written: the table is `case_invoice_accounts` (`case_id` referencing `cases` on delete cascade, `org_id`, the sealed number columns of `bank_accounts`, branch code, bank and payee name, `created_at`), and no other number is taken. (3) The live item below named the synthetic set of §5, but §5 depends on this section, so that set cannot exist before this section stamps; the live run for this section uses synthetic invoice PDFs already in the tree (`test/fixtures/pdf-forensics/chromium-invoice.pdf` and the invoice PDFs `src/meta/make-pdfs.py` generates), checks each extracted field against the values those documents were made with, and records accuracy and cost in `docs/frontier-log.md`; the §5 set then widens the same measurement under §5. (4) The schema's decision is explicit: `is_invoice` false (not an invoice or payment request) yields no `invoice.detected` item and no persisted account, proven in `test/invoice/extract.test.ts`. (5) Spend: the coordinator's cap of 2026-11-02 07:14 SAST is US$10.00 total across this section and D05 T04 §4, stated before any paid call and never raised; actual spend per section is recorded in the lane run file and in `docs/frontier-log.md`, and the live run stops at the cap.

**Phase:** 5
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Define `InvoiceFields` and the call. Done when: a stubbed test extracts the fields.
2. Run it live on the synthetic set. Done when: field accuracy and cost are recorded in `docs/frontier-log.md`.

- [ ] Define `InvoiceFields` in `src/invoice/schema.ts` with strict formats (South African account numbers 7 to 11 digits, branch codes 6 digits, ZAR amounts as cents integers). Done when: invalid formats fail validation in `test/invoice/schema.test.ts`.
- [ ] Call `muse-spark-1.3` through `structured()` with the PDF as `input_file` (base64) plus an untrusted note that the document text is data. Done when: `test/invoice/extract.test.ts` checks the request.
- [ ] Register `invoice.detected` (info) with the extracted fields as detail (account number masked to the last three digits in summaries). Done when: the stub yields it with a masked summary.
- [ ] Persist each invoice case's extracted payee account for §6: the number sealed under the bank keys (`sealNumber`, D05 T01 §2) with its branch code, bank and payee name, in a table keyed by case and organisation, written with the case's evidence and deleted with the case. Done when: `test/invoice/extract.test.ts` reads the stored account back for its own organisation only, finds none for another organisation's case or a case with no extraction, and a case deletion removes it. **Added 2026-10-31** (D06 T01 §4's plan review, gap 1: §6 needs a producer of the invoice's account).
- [ ] Wire extraction into `src/pipeline/analysis-workflow.ts` as its own step before the verdict (plan review gap 1), discovering the case's PDF attachments from its artefacts, writing `invoice.detected` and the persisted account before the verdict reads the case; the step's file is another lane's, so the wiring lands only with the coordinator's approval, asked 2026-11-02. Done when: a Workflow test proves an attached invoice yields the persisted extraction before the verdict, and a case with no PDF runs no call.
- [ ] State extraction failure as its own outcome (gap 2): refusal, invalid output after repair, timeout, budget exhaustion and unreadable PDF each write an `invoice.not_checked` item with the reason kind (never the model's words), create no account, and leave the case partial through the existing not-checked path; report cards naming it are D07 T03 §15's. Done when: `test/invoice/extract.test.ts` drives each failure and finds no account and the stated item.
- [ ] Make missing fields honest (gap 3): `supplier_domain`, `reference` and `due_date` are nullable, amount is `amount_cents` with `currency`, and an extraction with no account number or no branch code persists no account. Done when: the schema test accepts a field-absent extraction, preserves leading zeros in account and branch, and the extract test persists no account for an incomplete one.
- [ ] Keep documents apart (gap 4): the persisted account and the evidence detail carry the attachment's artefact key as provenance, one extraction per PDF, and two PDFs with different payees persist two rows, never a merged one; a replay replaces that document's row. Done when: the extract test runs two invoice PDFs and a non-invoice sibling and reads both accounts back apart.
- [ ] Hold the untrusted boundary (gap 5): the task and instructions sit outside the untrusted block, the PDF goes as `input_file`, and any accompanying text goes through `untrusted` in `src/meta/untrusted.ts`; hidden text is already evidence from the checks step before this step runs. Done when: the extract test's injected instruction in the document text changes no field and no instruction leaves the block.
- [ ] Give the stored account the key lifecycle (gap 6): the migration's epoch triggers mirror `0049_ledger.sql`'s, `rekeyAccounts` and `abandonLostKeys` in `src/trust/bank.ts` cover `case_invoice_accounts`, and the evidence write and the account write for one document land in one batch or neither does. Done when: the extract test interrupts the pair, replays it, re-keys it and refuses it under lost keys.
- [ ] Keep the full number out of evidence (gap 7): `invoice.detected` detail carries the account masked to the last three digits and every other field, never the full number; the full number exists only sealed in `case_invoice_accounts`, read back tenant-scoped by `readCaseInvoiceAccount`. Done when: the extract test serialises the stored evidence and finds no full number in it.
- [ ] Bound the call (gap 8): at most 3 PDFs per case, each at most 50 pages (Meta's `input_file` bound) and the intake's own byte caps, one `structured()` call per document under the case budget with owner `invoice`, no retry beyond `structured()`'s repair; a document past a bound is stated in `invoice.not_checked`, never silently skipped. Done when: the extract test proves a fourth PDF and an oversize one are stated, not called.
- [ ] Run the extraction live on the synthetic invoice PDFs already in the tree (gap 9, correcting the generator path to `scripts/fixtures/make-pdfs.py`) after the credit gate: detection right on every document run, and supplier, account, branch and amount exact on every invoice document, or the section does not stamp; per-field accuracy and cost go in `docs/frontier-log.md`. Done when: the entry exists and names each document, its expected and extracted fields, and the spend against the US$10.00 cap.
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
- [x] Commit: `invoice: supplier ledger model`

**Test checkpoint:** `pnpm exec vitest run test/invoice/ledger.test.ts test/trust/bank.test.ts` passes, and fails if a supplier account is stored in plaintext, a match answers more than `{ match }`, a supplier without an account gives a mismatch, `findSupplier` picks one of several suppliers, or `listSupplierDomains` returns a domain other than the registrable ones.

> **Verified:** 2026-10-31 | §2 | c6962b44f427ee3c6412a4f8fce79bca0586a403
> **Review:** `docs/reviews/d06-t01-s2.json`

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

> **Started:** 2026-10-31T19:14Z

**Corrected 2026-10-31** (at start, checked against the repository, `design/SPEC.md` M4 and its board): (1) "mark this invoice as verified", the report's ledger links and the board's "Changed on invoice" status all need an invoice case carrying the extracted, sealed bank details, which §1 (extraction) and §3 (bank-change rules) build and §4 does not depend on (neither is built); they move to the new §6, which depends on §3 and §4, and D07 T03 §2's deferral of the ledger links is retargeted to §6 through the coordinator (a cross-lane XREF); §4 keeps the page, CSV import, provenance, the account change, permissions and the rows' links for §6 to open (`/suppliers#<supplier id>`); (2) the board shows an account's last four digits and searches by them, but D05 T01 §2 and §2 here keep only the last three (`last3`), so the table, the search and the add form's hint use three, recorded as a SPEC M4 Deviation; (3) the add form and the CSV columns carry no account holder, which `supplier_accounts.holder` requires: the holder is the supplier's name (default; a holder field would cost one more input and CSV column); (4) "imported from CSV" cannot be told from "added by hand" in the stored record (only `verified_from_case_id` exists, and it is cleared when the case is deleted): a migration adds `supplier_accounts.source` (`hand`, `csv` or `case`, existing rows backfilled from `verified_from_case_id`), written by `addSupplierAccount`; (5) a CSV is validated in full before anything is written and written in one D1 batch, so a bad row imports nothing; a row naming an existing supplier (by `nameKey`) adds its domain and account to it, an account already recorded for that supplier is skipped as already there (so importing the same file twice changes nothing), and a domain that is a consumer mailbox (a host-level `user_content` entry of the bundled brand table, `src/checks/brands.ts`) is a row error, as the board's "free mail service" row shows; (6) the Treatment's "undo for every change" is met by a confirmed, logged removal, an edit reversed by editing back, and §6's 24-hour undo of "mark verified" (default; a general undo journal would cost a table and a reverse per change kind); (7) the page is gated like the protected identity page: Origin on writes, the active membership, owners and admins edit, members view, and the `bank-change` feature (the ledger exists for that check, spec 4.5; default: an organisation without it sees the plan refusal, a free ledger would cost the gate's removal); (8) the board's supplier count "(5, 4 verified)" counts suppliers with at least one recorded account as verified (default).

**Corrected 2026-10-31** (plan review, 5 P1, 4 P2, `docs/reviews/06-invoice/D06-T01-s4.md`): (9) changing a supplier's account is one operation, `replaceSupplierAccount` in `src/invoice/ledger.ts`: a single D1 batch that removes the account chosen on the row (by id, scoped to the organisation and supplier) and records the new one with both audit events, so a failure in any statement leaves the old account in place; a supplier with several accounts shows Change on each, and its other accounts are untouched (gap 5); (10) "a free mail service" is decided by an explicit list of consumer mailbox providers, `src/invoice/mailboxes.ts` (Gmail, Outlook, Hotmail, Live, Yahoo, iCloud, AOL, Proton, GMX, Yandex and the South African ISP mailboxes such as MWEB, Telkom and Vodamail), not the brand table's `user_content`, which also holds hosted services such as `docusign.net` and `post.xero.com` (gap 6; replaces correction 5's rule); (11) an import is at most 1 MiB and 1,000 rows, refused before parsing with the limit named; it is read as RFC 4180 CSV, and a malformed file (wrong header, an unclosed quote, a row with the wrong number of fields) is a named file or row error with nothing imported (gap 6); (12) an account verified from a case that has since been deleted keeps `source = case` with who and when, and shows "verified from a case no longer available" without a link (gap 7); (13) the page's interactions are proven in Chromium (`test/node/suppliers-page-browser.test.tsx`): Cancel, removal confirmed and cancelled, a search with no match and its recovery, focus on an anchored row, the account change by keyboard with its announcement, refusals announced, and no horizontal scroll at 375 px (gap 9). Gaps 1 to 4 and 8 are §6's, recorded there.

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

- [x] Add migration `src/db/migrations/0061_supplier_account_source.sql` (**Corrected 2026-10-31:** was 0056, which the Glimmer lane holds; 0061 is the coordinator's number) (`supplier_accounts.source`, correction 4) and take a `source` in `addSupplierAccount` (`src/invoice/ledger.ts`), returning it, `added_by` and `added_at` from `listSuppliers`. Done when: `test/invoice/ledger.test.ts` reads each source back and the backfill marks a case-verified row `case`.
- [x] Build `src/web/pages/suppliers.tsx` with search (name, domain or last three digits), the supplier table (masked accounts, status and provenance), add and edit forms, and removal with confirmation, under the gate of correction 7. Done when: `test/web/suppliers-page.test.ts` covers each, the empty state shows Add supplier and Import CSV, and a refused form keeps what was typed with the refusal on its field. Cheaper substitute: an admin-only JSON endpoint.
- [x] Import CSV (`name,domain,bank,branch_code,account_number,phone`), validating every row and reporting row errors without importing a partial file (correction 5), with "Download a template" (`/suppliers/template.csv`). Done when: a file with one bad row imports nothing and lists the error by row, a valid file of three suppliers imports in one batch with source `csv`, importing it again changes nothing, and the template parses as a valid empty import.
- [x] ~~Add "Mark this invoice as verified" on the report~~ **Moved 2026-10-31** to §6 (correction 1): it needs an invoice case's extracted bank details, which §1 and §3 build.
- [x] ~~Add the report's ledger links~~ **Moved 2026-10-31** to §6 (correction 1): they follow an invoice case's bank-change action, which §3 builds. §4 gives every supplier row an anchor, `/suppliers#<supplier id>`, for them to open. Done when: `test/web/suppliers-page.test.ts` opens a supplier's row by its anchor and it receives focus.
- [x] Show each account's provenance in the table, "added by hand", "imported from CSV" or "verified from case <link>" (`verified_from_case_id`, D06 T01 §2), or "verified from a case no longer available" once that case is deleted (correction 12), with who added it and when, so a member can tell a baseline someone typed from one confirmed on a real invoice (D06 T01 §2 completion review, gap 7, `docs/reviews/06-invoice/D06-T01-s2.md`). Done when: `test/web/suppliers-page.test.ts` renders all four. Cheaper substitute: the masked number alone. Default taken: an account is a matching baseline as soon as an owner or admin records it, with no second approval (the ledger is the organisation's own record; live bank verification is out of scope, spec 4.5); a pending state would cost a `status` column on `supplier_accounts` and a filter in `matchSupplierAccount`.
- [x] Reach "change this supplier's bank account" in at most three actions from the supplier's row, keyboard included, excluding the details typed: the add-account form opens prefilled with the supplier, the old account is removed in the same confirmation through `replaceSupplierAccount` (correction 9), and success or failure is announced (D06 T01 §2 completion review, gap 6, against Eftsure's three-click change request). Done when: the browser test counts the actions by keyboard and asserts the announcement, a fresh read shows only the new account among that supplier's changed one (its other accounts kept), `matchSupplierAccount` refuses the old number and matches the new, and a failing statement in the batch leaves the old account in place. Cheaper substitute: separate add and remove forms.
- [x] Classify consumer mailbox domains in `src/invoice/mailboxes.ts` (correction 10) for the import and the add form. Done when: `test/invoice/mailboxes.test.ts` names `gmail.com` and `mweb.co.za` mailboxes and `docusign.net`, `docs.google.com` and `post.xero.com` not.
- [x] Prove the page in Chromium (correction 13). Done when: `test/node/suppliers-page-browser.test.tsx` covers each interaction correction 13 lists.
- [x] Allow owners and admins to edit and members to view. Done when: a member's post gets 403.
- [x] Commit: `web: supplier ledger page, CSV import and mark verified`

**Test checkpoint:** `pnpm exec vitest run test/web/suppliers-page.test.ts` passes and fails if a partial CSV is imported.

> **Verified:** 2026-11-01 | §4 | 7e5a233e68d4d44f635f7931d0e704f29a3fbf81
> **Review:** `docs/reviews/d06-t01-s4.json`

## 5. Synthetic invoices in genuine and tampered pairs

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

## 6. Mark invoices verified, with undo

From an invoice case's report, a member records the invoice's supplier and bank account as verified, growing the ledger (spec 4.5: "grown from invoices the tenant marks as verified"), and can undo it for 24 hours; the report links to the supplier's ledger row, and the ledger shows a supplier whose invoice changed bank details. Moved from §4 (its correction 1), since each needs the invoice case's extracted, sealed bank details that §1 and §3 build.

**Corrected 2026-10-31** (§4's plan review, `docs/reviews/06-invoice/D06-T01-s4.md`): (1) the invoice's account is read from the case's persisted extraction (§1's item "Persist each invoice case's extracted payee account"), tenant-scoped, never from fields the request supplies; a case with no or an unreadable extraction offers no mark and says why (gap 1); (2) marking an account already recorded for the supplier links the existing row to the case (`verified_from_case_id`, `source` unchanged) instead of adding a duplicate, a repeated mark changes nothing, a payee that matches no supplier or several asks the member to choose or add the supplier, and an undo reverses only what that mark changed, never removing an account that existed before it (gap 2); (3) a mark is stored (`supplier_verifications`: case, account, what it changed, who, when, undone when), its 24-hour expiry is the server's, and Undo is found again on the report and the ledger after a reload until then; afterwards the report explains that the undo has expired and the account is removed from the ledger instead (gap 3); (4) mark and undo pass the ledger's whole gate (Origin, active organisation, owner or admin, `bank-change`) and check that the case and the account belong to the organisation; the signed public report draws no control (gap 4); (8) the board's "Asked their finance contact at 09:20, awaiting reply" is the closed-loop request's stored state (D05 T03 §1, now a dependency), shown with "not requested" when none was sent and "request unavailable" when it cannot be read (gap 8).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, M4 supplier ledger (the Undo toast and the "Changed on invoice" status) and the report's invoice actions (D07 T03 §2)
**Job:** a finance clerk confirms a real invoice once, so the next one from that supplier is checked against it
**Treatment:** one action from the report, an Undo that stays 24 hours, the change visible on the ledger
**Chrome:** `AppShell`, `Button` and the toast region from D07 T01, the report's action list from D07 T03 §2

**Build order:**

1. Mark verified and undo. Done when: a rendered test marks an invoice verified from its report and undoes it within 24 hours.
2. Link the report and the ledger. Done when: each report link opens the supplier's row and the ledger shows "Changed on invoice".

- [ ] Add "Mark this invoice as verified" on the report for invoice cases, recording supplier and account with `verified_from_case_id` and source `case` (`addSupplierAccount`, §4's correction 4) as corrections 1 and 2 define, and "Undo" for 24 hours as correction 3 defines (logged). Done when: `test/web/supplier-verify.test.ts`, from a freshly loaded report over persisted data, marks a new account, an existing one and a repeated request, undoes each with unrelated accounts kept, finds Undo again after a reload, refuses a second undo and an expired one with its explanation, and refuses another organisation's case or account, a foreign Origin, a member who is not an owner or admin, and an organisation without `bank-change`, each with records and audit events unchanged. Cheaper substitute: adding the account by hand on the ledger.
- [ ] Add the report's ledger links (D07 T03 §2's deferral): "Open <supplier> in the ledger" after the bank-change action of an invoice case with a matched supplier, opening that supplier's row (`/suppliers#<supplier id>`, §4), and the "supplier ledger" link in a safe invoice case's action, for a member of the case's organisation only (the public signed link draws the words without the link). Done when: `test/web/report-verdict.test.ts` follows each link to its supplier for a member, a signed-link viewer gets no link, and the link is reached by keyboard. **Added 2026-10-31** (D07 T03 §2's plan review; moved from §4).
- [ ] Show "Changed on invoice" on a supplier's ledger row when its latest invoice case raised the bank-change finding (§3), linking the case, with the closed-loop request's state (correction 8). Done when: `test/web/suppliers-page.test.ts` renders the status for such a supplier from stored findings and stored request states (sent and awaiting, not requested, unavailable), and not for one whose invoice matched. Cheaper substitute: the finding on the report alone.
- [ ] Prove mark, undo after a reload and the ledger link in Chromium. Done when: `test/node/supplier-verify-browser.test.tsx` marks from the report, reloads, finds Undo, undoes, follows the ledger link to the focused row, and every step works by keyboard.
- [ ] Commit: `web: mark an invoice verified from its report, with undo`


**Test checkpoint:** `pnpm exec vitest run test/web/supplier-verify.test.ts` passes and fails if the undo outlives 24 hours.

## Verification

- Tampered invoices are critical with the fixed action, genuine ones are clean, and the ledger grows from verified invoices with undo.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
