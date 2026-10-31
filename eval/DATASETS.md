# Evaluation datasets

Every dataset, font and asset the evaluation uses, with where it came from and the licence that allows our use (`AGENTS.md`: synthetic data only; `docs/hackathon-criteria.md`: rights to everything used). Real client mail never enters this folder.

## Evaluation sets (D08 T01)

Each set the evaluation reads, one row per source, so every case's origin, licence and use can be traced.

| Source | Licence | URL | Date | Count | Use |
| --- | --- | --- | --- | --- | --- |
| `nazario-2025` | CC BY 4.0 | [link][1] | 2026-10-31 | 58 (0 genuine) | Attacks; NOTICE.md |

## Candidate corpora (D08 T01 §2)

Every public corpus considered, its licence as read on its own page, and the decision (spec 4.9: a public repository and a commercial product; anything unclear is not used). Read 2026-10-31.

| Corpus | Licence | URL | Read on | Decision | Why | Obligations |
| --- | --- | --- | --- | --- | --- | --- |
| Nazario | CC BY 4.0 | [link][2] | 2026-10-31 | accept | Commercial use allowed | Credit, licence |
| Enron (CMU) | none | [link][3] | 2026-10-31 | reject | No licence on its page | none |
| SpamAssassin | none | [link][4] | 2026-10-31 | reject | Senders keep rights | none |
| PhishTank | unreadable | [link][5] | 2026-10-31 | reject | URLs only; no terms | none |
| phishing_pot | CC BY-NC 4.0 | [link][6] | 2026-10-31 | reject | Non-commercial only | none |
| TREC, CEAS | research | [link][7] | 2026-10-31 | reject | Research only | none |
| Ling/Enron-Spam | not found | [link][8] | 2026-10-31 | reject | No terms found | none |

The Nazario set is a random draw of 60 messages (seed 20261031), not a choice of the ones our checks can see: 10 are labelled by the evidence our checks name, 48 as attacks only a model can see (basis `model`, scored on the verdict alone, D08 T01 §4), and 2 whose lure is unclear on reading wait unlabelled in `eval/pending/nazario-2025/`, so the evaluation measures its blind spots too.

No genuine-mail corpus passes, so every genuine sample comes from the synthetic set (D08 T01 §3, which makes up the Outcome's totals: at least 150 samples, at least 60 genuine).

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

[1]: https://monkey.org/~jose/phishing/
[2]: https://monkey.org/~jose/phishing/README.txt
[3]: https://www.cs.cmu.edu/~enron/
[4]: https://spamassassin.apache.org/old/publiccorpus/readme.html
[5]: https://www.phishtank.com/developer_info.php
[6]: https://github.com/rf-peixoto/phishing_pot
[7]: https://plg.uwaterloo.ca/~gvcormac/treccorpus07/
[8]: http://www.aueb.gr/users/ion/data/enron-spam/
