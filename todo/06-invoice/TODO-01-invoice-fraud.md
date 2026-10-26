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
| 4 | §4 | Supplier ledger page and CSV import | §2, D07 T01 §3 | [ ] |
| 5 | §5 | Synthetic invoice set with genuine and tampered pairs | §1 | [ ] |

## 1. Invoice detection and Muse Spark field extraction

Muse Spark reads the PDF natively (`input_file`) and the page images, decides whether the document is an invoice or payment request, and extracts `supplier name, supplier domain, bank, account holder, account number, branch code, amount, currency, reference, due date` (spec 4.5). The PDF's text is untrusted content.

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

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Add the ledger tables and queries. Done when: tests add a supplier with a domain and account and match against it.

- [ ] Add migration `0014_ledger.sql` with `suppliers` (`org_id`, `name`, `domains_json`, `phone`, `notes`, `created_at`) and `supplier_accounts` (encrypted like `bank_accounts`, with `verified_from_case_id`). Done when: it applies locally.
- [ ] Write `src/invoice/ledger.ts` with `addSupplier`, `findSupplier({ name, domain })`, `matchSupplierAccount` and `listSupplierDomains` (used by D02 T03 §2). Done when: `test/invoice/ledger.test.ts` covers each.
- [ ] Log every ledger change with who and when in `ledger_events`. Done when: the test finds the rows.
- [ ] Commit: `invoice: supplier ledger model`

**Test checkpoint:** `pnpm exec vitest run test/invoice/ledger.test.ts` passes.

## 3. Bank-change rules with the fixed action

Rules (spec 4.5): bank details differ from the ledger or the registered account, the supplier's domain differs from the ledger, or the mail says the bank has changed: critical evidence and the fixed instruction "Confirm by phoning the supplier on the number in your records, never one from this email." A protected supplier with a no-match also starts closed-loop verification (D05 T03).

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Register the rules. Done when: the tampered fixture is critical and the genuine twin is clean.

- [ ] Register `invoice.bank_changed` (critical) when the extracted account does not match the ledger or registry for that supplier. Done when: `test/invoice/rules.test.ts` passes for the pair.
- [ ] Register `invoice.supplier_domain_changed` (high) and `invoice.change_language` (high; phrases such as "new banking details", "changed banks", "updated account", also in Afrikaans "nuwe bankbesonderhede"). Done when: fixtures yield each.
- [ ] Attach the fixed action to every critical invoice item and to the verdict's actions, with the ledger phone number when present. Done when: the reply for the tampered fixture contains the action.
- [ ] Start closed-loop verification (D05 T03 §1) when the supplier is a protected identity. Done when: the demo fixture creates a verification request.
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
**Chrome:** `AppShell`, `Field`, `Button`, `EmptyState`, `ErrorState` from D07 T01 §3

**Build order:**

1. Build the ledger page. Done when: a rendered test adds, edits, searches and removes a supplier.
2. Add CSV import and mark verified. Done when: a CSV of three suppliers imports and a report's "mark verified" adds the account, with undo.

- [ ] Build `src/web/pages/suppliers.tsx` with search, the supplier table (masked accounts), add and edit forms, and removal with confirmation. Done when: `test/web/suppliers-page.test.ts` covers each. Cheaper substitute: an admin-only JSON endpoint.
- [ ] Import CSV (`name,domain,bank,branch_code,account_number,phone`), validating every row and reporting row errors without importing a partial file. Done when: a file with one bad row imports nothing and lists the error.
- [ ] Add "Mark this invoice as verified" on the report for invoice cases, recording supplier and account with `verified_from_case_id`, and "Undo" for 24 hours. Done when: the test marks and undoes.
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
