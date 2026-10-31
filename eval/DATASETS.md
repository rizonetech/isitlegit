# Evaluation datasets

Every dataset, font and asset the evaluation uses, with where it came from and the licence that allows our use (`AGENTS.md`: synthetic data only; `docs/hackathon-criteria.md`: rights to everything used). Real client mail never enters this folder.

## Evaluation sets (D08 T01)

Each set the evaluation reads, one row per source, so every case's origin, licence and use can be traced.

| Source | Licence | URL | Date | Count | Use |
| --- | --- | --- | --- | --- | --- |
| `nazario-2025` | CC BY 4.0 | [link][1] | 2026-10-31 | 55 (0 genuine) | Attacks; NOTICE.md |

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

