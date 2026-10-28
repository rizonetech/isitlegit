---
schema_version: 1
id: payment-documents
domain: 06-invoice
status: active
title: "TODO-02 -- Payment Document Check"
track: day-5
---

# TODO-02 -- Payment Document Check

> **Goal:** A member uploads an invoice, a proof of payment (POP) or a bank confirmation letter on its own (web upload, or mail to `check@` with only a PDF or image) and gets a verdict built from file forensics (producer, incremental updates, fonts, dates, pasted images), Muse Spark extraction and layout comparison, and ledger and registry matching, with the fixed POP action "confirm the money has cleared in your own banking app before releasing goods" and the stated limit that a POP check cannot prove payment.

> **Current state:** Measured 2026-10-26 20:00 SAST. Uploads route PDFs and images as `source_kind = document` (D01 T03 §1). Doctored pairs for the eval come from Muse Image (§4).

## Inputs

- Design spec 4.5a (payment document check: forensics, extraction, match, fixed action, limit), 4.9 (Muse Image doctored-document test set), 2b (paid Protect feature; the trial unlocks it).
- ISO 32000-1 (PDF: incremental updates section 7.5.6, document information dictionary section 14.3.3, font resources).
- -> XREF: D08 T01 §3 -- the eval set that uses this file's doctored pairs

## Outcome

- A doctored POP fixture (amount edited, an incremental update after creation, a substituted font in the amount) is flagged with each forensic finding; its genuine twin is not.

**Adjacency:** list=applicable @ D07 T04 §1; document=applicable @ D07 T03 §1; settings=not-applicable (no tunables; limits are fixed in code with the spec reference); reporting=applicable @ D07 T04 §2; notifications=not-applicable (results show on the report; uploads send no mail); permissions=applicable @ D01 T03 §1; audit=applicable @ D01 T01 §7; exchange=not-applicable (nothing is imported or exported); reverse=not-applicable (analysis only)

**Adjacency rationale:** Document cases are ordinary cases on the report and in the cases list; the upload session is the permission boundary.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | PDF forensics | D02 T01 §2 | [ ] |
| 2 | §2 | POP and bank letter extraction and layout comparison | §1, D06 T01 §1 | [ ] |
| 3 | §3 | Standalone document path with the fixed POP action | §2, D01 T03 §1 | [ ] |
| 4 | §4 | Muse Image doctored document pairs | §2 | [ ] |

## 1. PDF forensics

Deterministic file evidence (spec 4.5a): producer and creator against the claimed issuer, incremental updates (edits saved after the original), mixed or substituted fonts in amount and account areas, creation and modification dates against the document date, and images placed over text.

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/invoice/forensics.ts`. Done when: each forensic fixture yields its finding.

- [ ] Count `%%EOF` markers and `startxref` sections to detect incremental updates (ISO 32000-1 section 7.5.6), reporting the number of revisions. Done when: `test/invoice/forensics.test.ts` finds two revisions in the edited fixture.
- [ ] Read the information dictionary and XMP for `Producer`, `Creator`, `CreationDate`, `ModDate`; flag a consumer editor producer on a bank-issued document and a modification after the stated payment date. Done when: fixtures yield both.
- [ ] List fonts per page and flag a font used only in the amount or account lines (font substitution). Done when: the substituted-font fixture yields it.
- [ ] Detect an image XObject overlapping a text region on the same page. Done when: the pasted-image fixture yields it.
- [ ] Register these as `document.forensics.*` evidence (medium each, high when two or more agree). Done when: the doctored fixture is high and the genuine one has none.
- [ ] Commit: `invoice: PDF forensics`

**Test checkpoint:** `pnpm exec vitest run test/invoice/forensics.test.ts` passes and fails if incremental updates are not counted.

## 2. POP and bank letter extraction and layout comparison

Muse Spark (PDF and image input, JSON schema) returns document type, issuer bank, amount, dates, reference and bank fields; for a POP, it compares the layout and wording with a genuine synthetic sample from the same fictional bank and lists differences (spec 4.5a).

**Phase:** 5
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Define `PaymentDocument` and the call. Done when: a stubbed test extracts the fields and the layout differences.

- [ ] Define `PaymentDocument` (`type` invoice, pop, bank_letter, other; `issuer`, `amount_cents`, `paid_at`, `reference`, `beneficiary` fields, `layout_differences` array). Done when: the schema is non-recursive and used with `structured()`.
- [ ] Send the document and, for a POP, the matching genuine reference from `ref/pop/<bank>.pdf` in R2 (synthetic fictional banks only). Done when: `test/invoice/payment-doc.test.ts` checks both parts are sent.
- [ ] Register `document.type`, `document.layout_mismatch` (medium), and run the ledger and registry match on beneficiary details (`document.beneficiary_mismatch`, critical). Done when: the stub cases yield each.
- [ ] Commit: `invoice: payment document extraction and layout comparison`

**Test checkpoint:** `pnpm exec vitest run test/invoice/payment-doc.test.ts` passes.

## 3. Standalone document path with the fixed POP action

A document case skips the mail checks and runs forensics, extraction and matching; the verdict carries the fixed POP action and the limit statement (spec 4.5a). Mail to `check@` whose body is empty and which carries only a PDF or image is treated as a document case too.

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Route document cases. Done when: an uploaded POP fixture runs only document steps and gets the fixed action.

- [ ] In the Workflow, run only document steps for `source_kind = document` and for mail with an empty body and one PDF or image. Done when: `test/invoice/document-path.test.ts` covers both entries. (**Corrected 2026-10-28**, D01 T03 §1's plan review P1 3: uploads record images as `source_kind = image`, so an uploaded screenshot of a POP takes this route too: `document` or `image`, with PNG, JPEG and WebP payment-document fixtures beside the PDF.)
- [ ] Add the fixed POP action and the info item "This check can show a document is likely altered. It cannot prove that a payment was made." Done when: every POP case has both.
- [ ] Commit: `invoice: standalone payment document path`

**Test checkpoint:** `pnpm exec vitest run test/invoice/document-path.test.ts` passes and fails if a POP case lacks the limit statement.

## 4. Muse Image doctored document pairs

Muse Image (`muse-image-1.0`, editing) edits our synthetic invoices and POPs of fictional companies and banks (changed amounts, account numbers, dates), each stamped SYNTHETIC, giving genuine and doctored pairs for the eval (spec 4.9). If the usage policy filter refuses an edit, that pair is made in code and the refusal is recorded.

**Phase:** 5
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Generate 20 doctored images from 20 genuine synthetic documents. Done when: `eval/sets/payment-docs/` holds 40 files with labels and provenance.

- [ ] Write `scripts/fixtures/make-doctored.ts` calling `/v1/images/edits` through `metaRaw` with an edit instruction per document and the budget guard. Done when: a dry run prints 20 requests.
- [ ] Run it after the credit gate, saving each output with a label (`edit`: amount, account, date) and its provenance line in `eval/DATASETS.md`. Done when: 20 doctored files exist or each missing one has a recorded refusal and a code-made replacement.
- [ ] Record cost, refusals and how often forensics alone catches an image edit in `docs/frontier-log.md`. Done when: the entry exists.
- [ ] Commit: `eval: Muse Image doctored payment documents`

**Test checkpoint:** `python3 -c "import json;d=json.load(open('eval/sets/payment-docs/labels.json'));print(len(d))"` prints `40`.

## Verification

- Doctored documents are flagged by forensics and extraction; every POP verdict carries the fixed action and the limit.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
