# Evaluation datasets

Every dataset, font and asset the evaluation uses, with where it came from and the licence that allows our use (`AGENTS.md`: synthetic data only; `docs/hackathon-criteria.md`: rights to everything used). Real client mail never enters this folder.

## Evaluation sets (D08 T01)

Each set the evaluation reads, one row per source, so every case's origin, licence and use can be traced.

| Source | Licence | URL | Date | Count | Use |
| --- | --- | --- | --- | --- | --- |

## Frontier: edited invoice digits (D08 T03 §1)

| Item | Source | Licence |
| ---- | ------ | ------- |
| `eval/frontier/sets/digits/*.jpg` | `eval/frontier/make-invoices.ts` | Project's own |
| `manifest.json`, `results.json` beside them | `eval/frontier/digits.ts` | Project's own |
| DejaVu Sans, read to render | Debian `fonts-dejavu-core` | Bitstream Vera |
| Nimbus Roman, read to render | Debian `fonts-urw-base35` | AGPL-3, font exception |

- Provenance: every company, address, VAT number, bank, branch code, account number and line item is invented by a seeded generator (`invoiceSpecs()`); the four banks are fictional names, not South African banks. No real invoice, mail or client detail was used or consulted.
- Fonts: no font file is committed or shipped. The build reads the system-installed files and refuses any other file by its sha256 (`FONT_PINS` in `eval/frontier/make-invoices.ts`); the images carry rendered glyphs only. The Bitstream Vera licence and the URW font exception both allow rendering text with the fonts into documents and images without conditions on those documents.
- Rebuild: `node eval/frontier/digits.ts build --out <new folder>` on a machine with both packages reproduces the published 20 images byte for byte (checked 2026-10-31).
