# Evaluation datasets

Every dataset, font and asset the evaluation uses, with where it came from and the licence that allows our use (`AGENTS.md`: synthetic data only; `docs/hackathon-criteria.md`: rights to everything used). Real client mail never enters this folder.

## Evaluation sets (D08 T01)

Each set the evaluation reads, one row per source, so every case's origin, licence and use can be traced.

| Source | Licence | URL | Date | Count | Use |
| --- | --- | --- | --- | --- | --- |
| `nazario-2025` | CC BY 4.0 | [link][1] | 2026-10-31 | 55 (0 genuine) | Attacks; NOTICE.md |
| `synthetic-sa` | Project's own | [link][9] | 2026-10-31 | 160 (70 genuine) | Genuine mail; SA attacks |

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

The synthetic set (`eval/sets/synthetic-sa/`, D08 T01 §3) is 160 messages written for South African small businesses: 70 genuine (40 business, 30 newsletters) and 90 attacks (20 credential phishing, 15 BEC payment, 15 invoice bank change, 15 impersonation, 15 voice lure, 10 malware attachment). Method: 160 scenario specs built in code from a fixed seed (`eval/generate/scenarios.ts`), every party fictional and every domain under the reserved `.example` (RFC 2606); subject and body written by `muse-spark-1.3` at low reasoning effort (`node eval/generate/run.ts generate`, 2026-10-31, 164 calls, US$0.9989 settled in the shared ledger and the live budget table); each body checked by the realism rules (`eval/generate/realism.ts`: no real organisation, 40 to 400 words, the scenario's parties and deception details verbatim, no placeholder or model talk, no deception marker in genuine mail), one retry and then a fresh variant of the same parties (one scenario, `bec-payment-007`, was replaced by `bec-payment-007-v1`); headers, authentication results and attachments built in code (`eval/generate/assemble.ts`, marked `X-IsItLegit-Synthetic: true`). 36 attacks have no tell in their headers and are labelled `basis: "model"`. Every label is annotated from its scenario and read a second time by the pinned reviewer. No real mail, person or client detail was used.
