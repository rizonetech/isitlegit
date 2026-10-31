# Evaluation datasets

Every dataset, font and asset the evaluation uses, with where it came from and the licence that allows our use (`AGENTS.md`: synthetic data only; `docs/hackathon-criteria.md`: rights to everything used). Real client mail never enters this folder.

## Evaluation sets (D08 T01)

Each set the evaluation reads, one row per source, so every case's origin, licence and use can be traced.

| Source | Licence | URL | Date | Count | Use |
| --- | --- | --- | --- | --- | --- |
| `nazario-2025` | CC BY 4.0 | [link][1] | 2026-10-31 | 55 (0 genuine) | Attacks; NOTICE.md |
| `synthetic-sa` | Project's own | [link][9] | 2026-10-31 | 160 (70 genuine) | Genuine mail; SA attacks |
| `synthetic-challenge` | Project's own | [link][9] | 2026-11-01 | 60 (30 genuine) | Subtle attacks with matched benign controls |

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

The Nazario set is a random draw of 60 messages (seed 20261031), not a choice of the ones our checks can see: 10 are labelled by the evidence our checks name, 45 as attacks only a model can see (basis `model`, scored on the verdict alone, D08 T01 §4; each read a second time by the pinned reviewer, D08 T01 §5), and 5 whose lure is unclear on reading or disputed wait unlabelled in `eval/pending/nazario-2025/`, so the evaluation measures its blind spots too.

No genuine-mail corpus passes, so every genuine sample comes from the synthetic set (D08 T01 §3, which makes up the Outcome's totals: at least 150 samples, at least 60 genuine).

The synthetic set (`eval/sets/synthetic-sa/`, D08 T01 §3) is 160 messages written for South African small businesses: 70 genuine (40 business, 30 newsletters) and 90 attacks (20 credential phishing, 15 BEC payment, 15 invoice bank change, 15 impersonation, 15 voice lure, 10 malware attachment). Method: 160 scenario specs built in code from a fixed seed (`eval/generate/scenarios.ts`), every party fictional and every domain under the reserved `.example` (RFC 2606); subject and body written by `muse-spark-1.3` at low reasoning effort (`node eval/generate/run.ts generate`, 2026-10-31, 186 calls, US$1.1346 settled in the shared ledger and the live budget table); each body checked by the realism rules (`eval/generate/realism.ts`: no real organisation, 40 to 400 words, the scenario's parties and deception details verbatim, no placeholder or model talk, no address or link outside `.example`, each attack making its category's request, no deception marker in genuine mail), one retry and then a fresh variant of the same parties (one scenario, `bec-payment-007`, was replaced by `bec-payment-007-v1`); headers, authentication results and attachments built in code (`eval/generate/assemble.ts`, marked `X-IsItLegit-Synthetic: true`: harmless executables and macro-enabled Word documents for the malware, a PDF for each genuine invoice). 22 messages were written again after the completion review tightened the specs and rules. 36 attacks have no tell in their headers and are labelled `basis: "model"`. Every label is annotated from its scenario and read a second time by the pinned reviewer. The files were assembled again on 2026-11-01 with opaque transport identifiers, because the scenario id in a Message-ID, Received id, MIME boundary or unsubscribe token named each message's label and category (D08 T01 §7); no body, label or second reading changed and nothing was spent. No real mail, person or client detail was used.

The challenge set (`eval/sets/synthetic-challenge/`, D08 T01 §7) is 60 messages in 30 pairs: a subtle attack and its matched benign control, five pairs in each of the six attack categories. Each pair shares its parties, its sender domain (the attack is the message a compromised or abused genuine mailbox sends), its topic, its length band and one risk cue (an urgency or amount phrase both messages carry verbatim); the attack differs from its control only in its tell (`details.tell`), and the control states the benign counterpart (`details.counter`). Authentication passes on every message, so no check can separate a pair by its headers: 23 of the 30 attacks have no tell a check names and are labelled `basis: "model"`, and the other 7 carry the evidence a check raises. Method: 60 scenario specs built in code (`eval/generate/challenge.ts`), every party fictional and every domain under the reserved `.example` (RFC 2606); subject and body written by `muse-spark-1.3` at low reasoning effort (`node eval/generate/run.ts generate challenge`, 2026-11-01, 97 calls over two passes, US$0.5851 settled in the shared ledger as run `eval-synthetic-challenge-1`, cap US$1.00; the first pass was written again after the completion review found its pairs' sender domains differed), each body checked by the main set's rules plus the challenge rules (`challengeProblems` in `eval/generate/realism.ts`: an attack carries its tell and a control its counter and cue verbatim, a control never changes an account or asks for secrecy); all 60 were accepted, 2 of them on a second attempt, with no replacement variant. Headers, authentication results and attachments are built in code as for the main set, with opaque transport identifiers (no scenario id, category or label in a Message-ID, Received id, MIME boundary or unsubscribe token). Every label is annotated from its scenario and read a second time by the pinned reviewer, each pair read together. This set is scored apart from the main set (D08 T02 §2). No real mail, person or client detail was used.

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
[9]: https://github.com/rizonetech/isitlegit/tree/main/eval/generate
