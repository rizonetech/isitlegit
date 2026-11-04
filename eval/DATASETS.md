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

The challenge set (`eval/sets/synthetic-challenge/`, D08 T01 §7) is 60 messages in 30 pairs: a subtle attack and its matched benign control, five pairs in each of the six attack categories. Each pair shares its parties, its sender domain (the attack is the message a compromised or abused genuine mailbox sends), its topic, its length band and one risk cue (an urgency or amount phrase both messages carry verbatim); the attack differs from its control only in its tell (`details.tell`), and the control states the benign counterpart (`details.counter`). Authentication passes on every message, so no check can separate a pair by its headers: 23 of the 30 attacks have no tell a check names and are labelled `basis: "model"`, and the other 7 carry the evidence a check raises. Method: 60 scenario specs built in code (`eval/generate/challenge.ts`), every party fictional and every domain under the reserved `.example` (RFC 2606); subject and body written by `muse-spark-1.3` at low reasoning effort (`node eval/generate/run.ts generate challenge`, 2026-11-01, 168 calls over four passes, US$1.0134 settled in the shared ledger as run `eval-synthetic-challenge-1`, hard cap US$2.00 (raised from US$1.00 by the operator at 01:31 SAST after review found defects that needed the set asked again); the passes followed review findings: the pairs' sender domains differed, then attacks and controls differed in register and a control called itself a control, then eleven messages stated checks or completed work only one of a pair carried or ran past 80 words), each body checked by the main set's rules plus the challenge rules (`challengeProblems` in `eval/generate/realism.ts`: an attack carries its tell and a control its counter and cue verbatim, a control never changes an account or asks for secrecy; no message names its role in the test set, claims that anything was checked, received or completed, or runs over 80 words); all 60 were accepted, with no replacement variant. Headers, authentication results and attachments are built in code as for the main set, with opaque transport identifiers (no scenario id, category or label in a Message-ID, Received id, MIME boundary or unsubscribe token). Every label is annotated from its scenario and read a second time by the pinned reviewer, each pair read together. This set is scored apart from the main set (D08 T02 §2). No real mail, person or client detail was used.

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

## Frontier: doctored POP stamps and signatures (D08 T03 §2)

| Item | Source | Licence |
| ---- | ------ | ------- |
| `eval/frontier/sets/stamps/*.png` | `eval/frontier/stamps.ts` (`buildSet`, SVG rasterised by `sharp`) | Project's own |
| `manifest.json`, `results.json` beside them | `eval/frontier/stamps.ts` | Project's own |

- Provenance: 20 synthetic proof-of-payment PNG pairs (40 pages: 20 genuine controls and 20 doctored pages: 7 `stamp-date`, 7 `signature-swap`, 6 `stamp-colour`) plus `reference-stamp.png` (cropped over `REFERENCE_BOX` containing both the genuine signature and the genuine stamp), all using the fictional Protea Bank and Fynbos Freight, stamped SYNTHETIC TEST DOCUMENT. No real document, stamp, signature or client detail was used.
- Rebuild: `node eval/frontier/stamps.ts build` reproduces the 40 PNGs, `reference-stamp.png` and `manifest.json`.

[1]: https://monkey.org/~jose/phishing/
[2]: https://monkey.org/~jose/phishing/README.txt
[3]: https://www.cs.cmu.edu/~enron/
[4]: https://spamassassin.apache.org/old/publiccorpus/readme.html
[5]: https://www.phishtank.com/developer_info.php
[6]: https://github.com/rf-peixoto/phishing_pot
[7]: https://plg.uwaterloo.ca/~gvcormac/treccorpus07/
[8]: http://www.aueb.gr/users/ion/data/enron-spam/
[9]: https://github.com/rizonetech/isitlegit/tree/main/eval/generate

## Voice fixture: director urgent payment (D01 T03 §3)

| File | Made by | Rights |
| --- | --- | --- |
| `test/fixtures/audio/director-urgent-payment.ogg` | `scripts/fixtures/make-voice.ts` from `test/fixtures/audio/director-urgent-payment.json` | Project's own |

- Provenance: a two-speaker voice note synthesised offline on 2026-10-31 by Windows' own speech synthesis (`System.Speech`, the "Microsoft David Desktop" and "Microsoft Zira Desktop" voices, called through `powershell.exe` from WSL), each turn as 48 kHz mono 16-bit PCM, joined with half a second of silence and encoded as Ogg Opus with libopus (`opusscript`). Same bytes on every run (sha256 `ad13ce23b5d0a9a075e7be2c10cc78d3ee7f33e1e3ee1b894ef3c688bf00d8c2`).
- Content: invented throughout. The caller ("Pieter Botha, the managing director of Karoo Fresh Produce"), the clerk ("Thandi"), the invoice, the amount and the account number are fictional; no real person's voice, no voice clone and no outbound service was used.

## Attachment fixtures: 7z archives (D02 T04 §7)

| File | Made by | Rights |
| --- | --- | --- |
| `test/fixtures/attachments/lzma.ts` | `scripts/fixtures/make-7z-lzma.ts`, with XZ Utils 5.8.3's raw LZMA1 encoder | Project's own |
| `test/fixtures/attachments/seven-zip.ts` | `scripts/fixtures/make-7z-real.ts`, with 7-Zip 25.01's `7zz` | Project's own |

- Provenance: `lzma.ts` holds raw LZMA1 streams of `lzmaInputs()` (generated bytes) and two hand-built archives whose header is LZMA-compressed; the same bytes on every run. `seven-zip.ts` holds three archives 7-Zip itself made on 2026-10-31 with its defaults (plain files; files encrypted with visible names, `-mhe=off`; encrypted names, `-mhe=on`), each passing `7zz t`; AES gives them a random salt and IV, so a new run writes other bytes of the same structure. 7-Zip 25.01 is the official Linux build `7z2501-linux-x64.tar.xz` from https://www.7-zip.org/a/ (sha256 `4ca3b7c6f2f67866b92622818b58233dc70367be2f36b498eb0bdeaaa44b53f4`), run only to make these files; it is not shipped and not a dependency.
- Content: two fictional files (an invoice line naming an invented company, and a run of one character); the archives' password is a test-only string named in the fixture module. No real document or mail was used.

## Attachment fixtures: ZIP archives (D02 T04 §8)

| File | Made by | Rights |
| --- | --- | --- |
| `test/fixtures/attachments/zips.ts` | `scripts/fixtures/make-zips.py`, with Python's own `zipfile` | Project's own |

- Provenance: ZIP archives Python's standard `zipfile` wrote on 2026-10-31 (deflated unless named stored, fixed times, so the same bytes every run), each tested with 7-Zip 25.01 (`7zz t`, the build named in the 7z fixtures above) before it is kept: a renamed program among PDFs (deflated and stored), a ZIP of PDFs, a program in a ZIP in a ZIP, a ZIP of PDFs in a ZIP, three levels of ZIPs, a nested ZIP whose declared size is under its 9 MiB, three nested 6 MiB ZIPs, and a damaged member before a program; the last two kinds are made damaged on purpose after 7-Zip's test.
- Content: fictional throughout: an invoice line naming an invented company, runs of zeros, and a "program" that is a DOS header and filler, never runnable code.

## Attachment fixtures: RTF documents with embedded objects (D02 T04 §9)

| File | Made by | Rights |
| --- | --- | --- |
| `test/fixtures/attachments/rtf.ts` | `scripts/fixtures/make-rtf.ts` | Project's own |

- Provenance: RTF documents written on 2026-10-31 by `scripts/fixtures/make-rtf.ts`, each embedding OLE 1.0 objects (MS-OLEDS 2.2) in hex, in `\bin` runs or both; each document read back by oletools 0.60.2 (`rtfobj`, `oleobj`, installed from PyPI into a scratch environment) before it is kept, the class, packaged file name and bytes equal to what was packed, the damaged and truncated objects read as not OLE and the linked one by its FormatID. The macro documents' compound file is `makeDecoyCompoundFile` from `scripts/fixtures/msg-builder.ts` with a `_VBA_PROJECT` stream.
- Content: fictional throughout: a letter line naming an invented company, a "program" that is a DOS header and filler, a script line, and a compound file holding no real macro code.

## Attachment fixtures: PDFs (D02 T05 §4)

| File | Made by | Rights |
| --- | --- | --- |
| `test/fixtures/attachments/pdfs.ts` | `scripts/fixtures/make-pdfs.py` | Project's own |

- Provenance: PDFs built object by object on 2026-10-31 by `scripts/fixtures/make-pdfs.py` (ISO 32000-1), each read back by pdfminer.six 20240706 (installed from PyPI into a scratch environment) before it is kept: a WinAnsi font, a composite font with a `ToUnicode` map, split `TJ` runs, positioned fragments, an inherited font, a Form XObject with its own font through `/Differences`, a font in an object stream (read by this repository's own test), an undecodable font, an encrypted file and a plain one.
- Content: fictional throughout: an instruction line and an invoice line.

## Payment document pairs (D06 T02 §4)

| File | Made by | Rights |
| --- | --- | --- |
| `test/fixtures/payment-docs/*-genuine.png` (20) | `scripts/fixtures/make-doctored.ts` (SVG, sharp) | Project's own |
| `test/fixtures/payment-docs/*-doctored.png` (19) | Muse Image `muse-image-1.0` edits of the genuine files | Project's own synthetic inputs; model output on them |
| `test/fixtures/payment-docs/pair-01-doctored.png` | `scripts/fixtures/make-doctored.ts` in code, after its model edit failed | Project's own |
| `labels.json`, `measurement.json` beside them | the same scripts | Project's own |

- Provenance: generated 2026-11-02. Every document is fictional (invented suppliers, Kestrel Bank (fictional), invented account numbers) and stamped SYNTHETIC TEST DOCUMENT. Each label names its pair, the edited field, the old and new values and whether the model or code made the doctored file. The measurement record names, per file, what the §2 extraction read and whether it named the new value.

## PDF forensic component corpus (D08 T02 section 6)

`eval/forensics/sets/pdf-forensics/manifest.json` pins 14 native PDFs and inventories 40 raster payment-document files separately with SHA-256 hashes. Eight PDFs are the existing Ghostscript 10.06.0 and Chromium/Skia fixtures described in `test/fixtures/pdf-forensics/PROVENANCE.md`; their generators have AGPL-3.0 and BSD-3-Clause licences respectively, and their synthetic document content is the project's own. Six additional native PDFs are three genuine/doctored pairs (proof of payment, bank letter, invoice), generated by `node eval/forensics/build.ts` using the project's own `test/invoice/pdf-writer.ts` and fictional Kestrel Bank and Hadeda Couriers content. Each pair changes an amount by an incremental update and substitutes its font. No real customer data is used.

The 40 D06 T02 section 4 raster files retain their existing payment-pair provenance above. Some `.png` paths contain WebP bytes from the image provider; the scorer validates image bytes and inventories them as raster inputs, never native PDF coverage. They are excluded from PDF denominators. The engineering PDFs include single-signal and combined-signal alterations, not a representative held-out fraud population. The published results separate any forensic finding from high/critical evidence that raises the deterministic verdict; incomplete coverage prevents a final target claim. Seven genuine PDFs cannot establish a population false-positive rate of 2%.

Corpus regeneration uses `node eval/forensics/build.ts` on Linux/WSL with util-linux `flock`. It stages all generated PDFs and the manifest, validates their hashes/formats and current external inputs, then retains the prior generated directory in `eval/forensics/sets/.pdf-forensics-previous` while publishing. A retry recovers an interrupted directory swap automatically; write or validation errors propagate. The lock waits at most two seconds before refusing another active builder, and the kernel releases it after process death. Staging directories and the saved previous generation are local recovery artifacts, not datasets to publish. External fixture inputs remain versioned at their source; regenerating pins after a legitimate fixture change does not alter the saved historical results, which must be remeasured separately.

Corpus location correction, 4 November 2026: native component PDFs now live under `eval/forensics/sets/`, outside the mail-only `eval/sets/` contract. All six moved PDF byte hashes are unchanged. The original report is preserved byte-for-byte at `eval/forensics/history/2026-11-04-before-corpus-relocation.md`; local remeasurement after relocation retains 3/7 detections, 0/7 false positives and 13/14 complete coverage. This repairs dataset integration only, not detector targets or the outstanding completion gaps.

Upgrade recovery: the builder also holds the original `eval/sets/.pdf-forensics.lock` while publishing. It moves only the legacy `pdf-forensics`, `.pdf-forensics-previous` and `.pdf-forensics-stage-*` directories into unique generations under `eval/forensics/legacy-publication/`, outside the mail dataset tree. Every legacy byte and original manifest path is retained, including partial staging; these are recovery archives, not new measurement inputs. Interrupted moves resume on retry without replacing prior archives. A failed new generation leaves archived recovery bytes intact. The old lock file is retained so older builders cannot bypass exclusion by opening a replacement inode. Keep these local archives until their recovery data has been explicitly assessed; they are not publication artifacts or proof of machine-crash durability.

## Hidden instruction component corpus (D02 T05 §7)

Generated offline on 2026-11-04 by `eval/hidden-text/corpus.ts`: 410 project-owned synthetic cases (205 attacks, 205 controls), eight languages of business context, English and explicitly labelled translated steering probes. Source fixtures: `test/checks/sparse-invisible.test.ts`, `test/checks/document-text.test.ts`, `test/fixtures/attachments/archives.ts` and `test/fixtures/attachments/pdfs.ts`. Licence: project-owned, no external content or client mail. Corpus: `eval/hidden-text/corpus.json`, SHA-256 `e4ca3e470ed35c925aa15bf0921d5c9cb916cf7f18b5511e7dbe52ded301ce53`; every case also records its stored-payload SHA-256. Generator and production readers measured at `73880735a3f0fb343b8e9c4df6099df2aed89cd9`. Method and correlated-template limitations: `eval/hidden-text/README.md`; per-case observations and honest target failures: `eval/hidden-text/observations.json` and `eval/hidden-text/results.md`. This is offline evidence-level component measurement, not verdict accuracy, independent language validation or a competitor comparison.

## Link extraction (D02 T07 §6)

`eval/components/links/` contains 10 project-owned synthetic component inputs (text, HTML, SVG and PDF), including damaged, boundary and capped cases. All destinations use reserved `.invalid` names and are never fetched. `labels.json` uses the existing strict D08 label schema; `manifest.json` binds exact byte hashes, normalized expected links and coverage. These are offline extraction measurements, not verdict samples or production accuracy claims. Results are recorded in `docs/eval/links.md`.

## Accent-insensitive lookalikes (D02 T03 §5)

`test/fixtures/lookalikes/` contains 29 fictional protected names, 203 synthetic positive labels (seven mutation families per target) and 60 independently named fictional accented benign businesses. Project-owned, generated offline by `scripts/fixtures/make-lookalikes.ts` with seed 20261104, with source digests and deterministic `--check`. Every candidate is scored against every target; no benign case is removed because it flags. This is a component corpus, not genuine mail or a representative business sample. Measurement and limits: `docs/evals/lookalikes.md`. The reference comparator uses the existing vendored Unicode 18.0.0 table under Unicode License v3 (`NOTICE.md`). No client data or paid model output.
