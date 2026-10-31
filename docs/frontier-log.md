# Frontier log

One experiment per build day at the edge of what Meta's models can do (design spec 4.9, `docs/manifesto.md`). Each entry records what was tried, on which synthetic inputs, what happened and what it means for IsItLegit. What works becomes a feature through `todo/`; what fails stays here with its evidence, because knowing where a model breaks is as useful as knowing where it shines.

Entry format:

```markdown
## YYYY-MM-DD: <the question, in one line>

- Model and settings: <model ID, reasoning effort, tools, structured output>
- Inputs: <synthetic files or prompts, paths under eval/ or test/>
- Result: <what happened, with numbers: accuracy, time, cost>
- Meaning: <feature, cut, or open question; the TODO section it feeds>
```

The first experiment runs on Tue 27 Oct, once the Meta Model API credit is live.

## 2026-10-31: What do peepdf and ExifTool see on a doctored POP that our forensics explains?

- Model and settings: none (deterministic file forensics, D06 T02 §1, `src/invoice/forensics.ts` at the section's stamped commit); peepdf-3 6.0.3 (`pip install peepdf-3` in a scratch virtual environment) and ExifTool 13.60 (its tarball, run with Perl), both outside the repository.
- Inputs: the Ghostscript and Chromium fixtures in `test/fixtures/pdf-forensics/` (`PROVENANCE.md`), made by `node test/node/make-pdf-forensics.ts`.
- Commands: `exiftool -s -Producer -Creator -CreateDate -ModifyDate <file>`; `peepdf -f <file>`; the analyser through `test/invoice/forensics-generated.test.ts` (`pnpm exec vitest run --project worker test/invoice/forensics-generated.test.ts`).
- Result: ExifTool prints Producer, Creator and both dates for every file (`gs-modified-pop.pdf`: ModifyDate 2026:10:28 14:22:00+02:00; `chromium-pop.pdf`: Producer "Skia/PDF m153"), in about 0.5 s a file including Perl's start. peepdf prints "Updates: 1" and a second version for `gs-edited-pop.pdf` and "Updates: 0" for the others; in its interactive mode it can also list and extract each version's objects, so an expert can diff them by hand. Neither reads the document's own claims: ExifTool does not compare the modification date with the payment date the page states, or the producer with the bank heading; peepdf does not say whether an update changed what the page shows, and neither reports the substituted font in `gs-substituted-font.pdf` or the image over the amount in `gs-pasted-image.pdf`. `analysePdf` names exactly one finding on each altered file (revisions, dates, fonts, overlay, producer) with a sentence and a stated limit, and none on `gs-genuine-pop.pdf`, `gs-logo.pdf` or `chromium-invoice.pdf`, in workerd at a median of 2 to 15 ms and a 95th percentile of 7 to 36 ms a file over 25 runs (the Worker's timer moves in whole milliseconds).
- Meaning: on these eight files the analyser does in one pass what an expert does with both tools and a page reading, and keeps signing and metadata-only saves silent. Eight synthetic files prove the mechanism, not accuracy on real bank documents: that measurement is D08 T02 §6's, and broader filters and encrypted files are D06 T02 §5's.

## 2026-10-31: How fast and how bounded is the reader on the new PDF encodings and RC4 files?

- Model and settings: none (deterministic file forensics, D06 T02 §5, `src/invoice/pdf.ts` with `pdf-filters.ts` and `pdf-crypt.ts`); Ghostscript 10.06.0 `txtwrite` as the mature decoder on hand (qpdf, pikepdf and PyMuPDF are not installed, D06 T02 §5 correction 2).
- Inputs: the proof of payment with its page content in Ghostscript-encoded LZW, `[/ASCII85Decode /LZWDecode]` and RunLength streams, Ghostscript's RC4 revision 2 and 3 files and the revision 3 twin with a later save (`test/fixtures/pdf-encodings/`, `PROVENANCE.md`), and a late-failure file of seven RunLength streams that each expand 7.5 MiB before a damaged run (the completion review's case).
- Commands: `analysePdf` 20 times a file in the Vitest node project (Node 24, `crypto.subtle` MD5 given by Node's `createHash`, since Node's Web Crypto has no MD5 and Workers does), timed with `performance.now` and RSS sampled; `gs -sDEVICE=txtwrite -sOutputFile=/dev/null <file>` 5 times a file, which includes Ghostscript's process start.
- Result: the encoded files read in 0.3 to 0.5 ms at p50 (p95 0.5 to 2.9 ms), the RC4 files in 3.0 to 3.3 ms (p95 6.9 to 9.0 ms), each under 1.5 MiB of RSS growth and with nothing unread; Ghostscript took 51 to 64 ms each. The late-failure file took 143 ms at p50 (p95 169 ms) with exactly 48.0 MiB charged and two named reasons (a damaged RunLength stream, the total cap), 36.5 MiB peak RSS growth; Ghostscript took 306 ms on it. Before the completion fix the same file decoded 52.5 MiB with nothing charged.
- Meaning: the new decoders are cheap next to a mature decoder's start alone, and a hostile file's work now ends at the shared cap however its streams fail. Workers time does not advance during CPU work, so these are Node figures; the Worker's own limit is the budget, which the tests assert.

## 2026-10-31: Can Spark see edited invoice digits from the image alone?

- Instruction: `INSTRUCTION` in `eval/frontier/digits.ts`, neutral (it never says an edit exists, where or how).
- Model and settings: `muse-spark-1.3`, reasoning effort high, `max_output_tokens` 8000, strict structured output (`DigitsAnswer`), `store: false`
- Inputs: 20 images in `eval/frontier/sets/digits/` (10 twins; 10 edits: font 4, spacing 3, recompress 3)
- Fingerprint: `e76784b46874ae29122d4ce51fe939b2de9122bde8bd23da450c2019efc5a3d3`
- Accuracy: 70% (14/20; failed 0, pending 0)
- Detected: 4/10 edited (font 4/4, spacing 0/3, recompress 0/3); account_number named on 4
- False alarms: 0/10 twins
- Unsupported regions: 4 on 4 answers (a field named as altered that was not)
- Latency: median 17.1 s, worst 22.9 s
- Cost: US$0.1663 measured, US$0.0000 uncertain; 20/20 attempts recomputed from their tokens at US$1.25, 0.15 cached and 4.25 output per million
- Baseline (error level, z > 3): detected 1/10 edited, false alarms 0/10 twins
- Set: 10 fictional South African invoices (`eval/frontier/make-invoices.ts`, provenance and font licences in `eval/DATASETS.md`), each as an unedited twin and as an edit whose account number was pasted over, both saved twice at JPEG quality 90; the edits cycle three ways: another typeface, letter spacing and baseline off by 1 to 2 px, the same digits recompressed at quality 55 before pasting. Results: `eval/frontier/sets/digits/results.json`.
- Accounting: the 20 attempts match the shared ledger and the run's own 20 `model_spend` rows (one read-only SELECT by caller `eval-frontier`, all settled and measured), id for id and cost for cost, summing to US$0.1663.
- Result: Spark caught every typeface swap, each with confidence 0.85 to 0.90 and `account_number` named as the region, and raised no false alarm on a twin (all at 0.05 to 0.06). But each of those four answers also accused the branch code of the same pasted serif font, and the branch code was never changed: its pixels are identical to the twin's. So every detection came with a false accusation beside it. Spark missed every spacing shift and every recompressed patch, answering those with the same low confidence as the twins (0.05 to 0.08). The error-level baseline caught one spacing edit and nothing else. One attempt per image, no repair or retry.
- Meaning: on this small set Spark notices a number retyped in another font (4 of 4) and misses the careful edit (0 of 6), and when it notices, it over-attributes the edit to a neighbouring field. With the rule set before the run (feature needs 8 of 10), it is not a feature. Open question: whether the typeface signal holds on scanned and photographed invoices, whether a region-level check (does the named field really differ from the page) removes the false accusations, and whether a JPEG-grid check covers the recompressed patches. The invoice checks (D06) should not claim edit detection on this evidence.
- Decision: open question
- Limit: 10 twins cannot show the 2% false-positive target (design spec 4.9), and these are pristine generated invoices, not scans or photos.
