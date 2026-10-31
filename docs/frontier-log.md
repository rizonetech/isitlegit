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

## 2026-10-31: How quickly does the supplier ledger open and search with 1,000 suppliers on a phone?

- Model and settings: none (the ledger page, D06 T01 §4, `src/web/pages/suppliers-view.tsx`).
- Inputs: a ledger of 1,000 fictional suppliers, one account each, drawn by the page's own view and served locally (`test/node/suppliers-page-browser.test.tsx`, "opens a ledger of 1,000 suppliers"); Chromium at 375 px with the CPU throttled four times (CDP `Emulation.setCPUThrottlingRate`); and the import of 1,000 suppliers in one D1 batch (`test/invoice/ledger-import.test.ts`).
- Result: before any change the page took 2,279 ms to `load`, past the 2-second target the completion review set; drawing off-screen cards lazily (`content-visibility: auto`) brought it to a first contentful paint of 588 to 600 ms, `load` at 1,892 to 1,920 ms and a search's answer at 702 to 782 ms on two quiet runs. With the machine's load average at 19 (other lanes' suites), one run took 1,068 ms to paint and 1,541 ms to search. The 1,000-supplier import committed in one batch in 392 ms in the Workers test runtime.
- Meaning: a ledger far larger than a small business keeps opens usable within a second on a throttled phone, and the import's largest file lands whole. The test asserts the paint target and keeps a backstop on the search, since shared runners vary.

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

## 2026-10-31: Can Muse Wonder walk a credential lure with our own function tools?

- Model and settings: `muse-wonder-1.0`, eight function tools generated from the driver's action schema (`click`, `double_click`, `move`, `scroll`, `type`, `keypress`, `wait`, `screenshot`), `tool_choice: "auto"`, `parallel_tool_calls: false`, `max_output_tokens` 1024, `store: false`, the latest two screenshots sent as images, page text only in untrusted blocks (D04 T02 §4, `src/walkthrough/wonder.ts`)
- Inputs: the fictional NimbusMail lure in `test/walkthrough/lure.ts` (a "View invoice" page, then a sign-in page), served through the stub `fetch` on local Browser Run behind the contained driver; per-case canary credentials (D04 T02 §2); run by `scripts/walkthrough-live.ts`
- Result: finished in 5 actions and 18.2 s, US$0.1174 measured over 6 calls; the walk reached the sign-in page from the lure and both fields held the case's canary username and password, read back from the page. The run's worst case (US$2.56) was reserved in the shared ledger first and settled at the measured cost.
- Earlier runs the same evening: two runs (5 and 6 calls, US$0.0789 and US$0.1137, settled at the gateway's measured cost) reached Meta but their results were lost, because the Worker test pool drops a passing test's console output; the result now travels on the test's `task.meta` through Vitest's JSON report. One reservation at the three-attempt worst case (US$7.69) was refused by the day cap and sent nothing.
- Screenshots only (after review round 3 removed page text from the model's input, so hidden text can never reach it): finished in 5 actions and 20.2 s, US$0.1022 measured over 6 calls, sign-in reached and both canary fields filled; worst case reserved US$1.09, settled measured.
- Meaning: the function-tool design works end to end on a two-page lure within the 8-step and 60-second limits, at about US$0.02 a step, and the model needs no page text to do it. It feeds D04 T02 §5 (form target and evidence chain) and §6 (trigger and cache). Open: the same flow on the deployed fixture host (§1), longer lures, and real-world pages with cookie banners and captchas.
- Decision: feature (D04 T02 §4)
- Limit: one fictional two-page lure, one successful attempt recorded in full; not a success rate.

## 2026-10-31: Does Loupe 1.0, a LoRA of Muse Glimmer 30B, catch more lures than Muse Spark on held-out pages?

- Model and settings: Loupe 1.0 (`accounts/rizonetech/models/isitlegit-loupe-1-0`, a rank-8 LoRA of Muse Glimmer 30B trained on 52,019 lines, D03 T04 §11) on a preemptible Fireworks deployment at temperature 0; Muse Spark (`muse-spark-1.3`, reasoning effort low, 2,000 output tokens) through the Meta API, every call reserved and settled in the shared ledger. Both receive the same request: the page's host, screenshot and text.
- Inputs: Loupe 1.0's 1,000 held-out evaluation pages (`eval.jsonl` sha256 a23db3ab1f0abae747c6023167b5bcd67a4882002804ff639a00f01cf49716a8; admitted only where Spark agreed with the trusted label, so Spark's figures there are biased upward by construction) and 493 pages of the independent reference set (sha256 dda3c0463e335850b6f035cb302e98fc2753d8153e9e4d2cb9368fa664ece339; drawn before any teacher check and kept whatever Spark answered). Commands: `node scripts/glimmer/evaluate.ts loupe|spark 1.0 [--set reference]`, then `score 1.0` (D03 T04 §13).
- Result:

The evaluation set:

| Slice | Pages | Accuracy | Lure recall | False alarms | Median latency | Cost a page |
| --- | --- | --- | --- | --- | --- | --- |
| Loupe 1.0, overall | 1000 (400 lures, 600 benign) | 0.958 | 0.980 | 0.057 | 3.941 s | not known per page |
| Loupe 1.0, South Africa | 545 (52 lures, 493 benign) | 0.947 | 0.962 | 0.055 | 3.994 s | not known per page |
| Loupe 1.0, credential | 80 (80 lures, 0 benign) | 0.975 | 0.975 | n/a | 3.552 s | not known per page |
| Loupe 1.0, fake_shop | 139 (139 lures, 0 benign) | 0.993 | 0.993 | n/a | 4.010 s | not known per page |
| Loupe 1.0, impersonation | 103 (103 lures, 0 benign) | 0.951 | 0.951 | n/a | 3.782 s | not known per page |
| Loupe 1.0, payment | 78 (78 lures, 0 benign) | 1 | 1 | n/a | 3.651 s | not known per page |
| Muse Spark, overall | 1000 (400 lures, 600 benign) | 0.976 | 0.943 | 0.002 | 8.650 s | US$0.0076 |
| Muse Spark, South Africa | 545 (52 lures, 493 benign) | 0.994 | 0.942 | 0 | 8.575 s | US$0.0072 |
| Muse Spark, credential | 80 (80 lures, 0 benign) | 0.912 | 0.912 | n/a | 8.081 s | US$0.0070 |
| Muse Spark, fake_shop | 139 (139 lures, 0 benign) | 0.971 | 0.971 | n/a | 9.301 s | US$0.0091 |
| Muse Spark, impersonation | 103 (103 lures, 0 benign) | 0.922 | 0.922 | n/a | 9.643 s | US$0.0084 |
| Muse Spark, payment | 78 (78 lures, 0 benign) | 0.949 | 0.949 | n/a | 9.060 s | US$0.0076 |

Loupe 1.0 missed (8): `samples-body-1c7c253598d70ed0`, `scamferret-b85bc428aeb89b14`, `phreshphish-49dc12a7e21e8a88`, `phreshphish-bf6855fb6a2c03c8`, `phreshphish-7be6bd9969c038bd`, `phreshphish-1d4d5c8d90c25010`, `phreshphish-0dee379ee6edadfe`, `ariyadasa-2021-81cb1d88b89feb32`.

Muse Spark missed (23): `kempf-html-a75fe609ffa79a8a`, `phreshphish-4c3afce86588130b`, `scamferret-2607045443ec59f4`, `samples-body-3f9a9acef67ba1e5`, `scamferret-5ca065c8a78ef76b`, `phreshphish-2c7bab99dda52021`, `ariyadasa-2021-5298b416d02b3b71`, `phreshphish-2503730fbeadafa6`, `phreshphish-edf08adc3eb245a3`, `scamferret-ad81aab7fc68308b`, `kempf-html-414ba4abd78b26d8`, `phreshphish-49dc12a7e21e8a88`, `kempf-html-0da909a83acfcb01`, `kempf-html-63af6226c6acd972`, `look-for-mallory-37ebd04a0fe93d4b`, `phreshphish-7be6bd9969c038bd`, `samples-body-7f871c3c0a23e46d`, `phreshphish-1d4d5c8d90c25010`, `scamferret-9696b878796d39be`, `7-days-later-6c725ec5cab6b499`, `phreshphish-a6a5e39f6b4aea84`, `phreshphish-416376a54057191d`, `samples-body-5be6011205a53909`.

The independent reference set:

| Slice | Pages | Accuracy | Lure recall | False alarms | Median latency | Cost a page |
| --- | --- | --- | --- | --- | --- | --- |
| Loupe 1.0, overall | 493 (91 lures, 402 benign) | 0.955 | 0.923 | 0.037 | 3.827 s | not known per page |
| Loupe 1.0, South Africa | 2 (0 lures, 2 benign) | 1 | n/a | 0 | 4.071 s | not known per page |
| Loupe 1.0, credential | 23 (23 lures, 0 benign) | 0.913 | 0.913 | n/a | 3.514 s | not known per page |
| Loupe 1.0, fake_shop | 3 (3 lures, 0 benign) | 1 | 1 | n/a | 3.538 s | not known per page |
| Loupe 1.0, impersonation | 64 (64 lures, 0 benign) | 0.922 | 0.922 | n/a | 3.603 s | not known per page |
| Loupe 1.0, payment | 1 (1 lures, 0 benign) | 1 | 1 | n/a | 3.742 s | not known per page |
| Muse Spark, overall | 493 (91 lures, 402 benign) | 0.903 | 0.615 | 0.032 | 7.934 s | US$0.0077 |
| Muse Spark, South Africa | 2 (0 lures, 2 benign) | 1 | n/a | 0 | 8.820 s | US$0.0062 |
| Muse Spark, credential | 23 (23 lures, 0 benign) | 0.870 | 0.870 | n/a | 7.996 s | US$0.0072 |
| Muse Spark, fake_shop | 3 (3 lures, 0 benign) | 0.667 | 0.667 | n/a | 10.696 s | US$0.0090 |
| Muse Spark, impersonation | 64 (64 lures, 0 benign) | 0.516 | 0.516 | n/a | 8.764 s | US$0.0080 |
| Muse Spark, payment | 1 (1 lures, 0 benign) | 1 | 1 | n/a | 5.576 s | US$0.0062 |

Loupe 1.0 missed (7): `ariyadasa-2021-a49053c5ce2894c0`, `ariyadasa-2021-a6c3cd2d9d7a4406`, `compphish-66656c18e902ecb2`, `kempf-html-e0edf313e7d0768b`, `phreshphish-3d676e9d95f7eb44`, `phreshphish-64f34910f5772d85`, `phreshphish-732ccf74d8ba9dfd`.

Muse Spark missed (35): `ariyadasa-2021-49259111b65bd611`, `ariyadasa-2021-912304fb895fd4b8`, `ariyadasa-2021-a49053c5ce2894c0`, `ariyadasa-2021-a6c3cd2d9d7a4406`, `compphish-02937328cf2d4a83`, `compphish-479e3ad10b1b4010`, `compphish-480a0df6d67fdb65`, `compphish-550b87c076ed9f3d`, `compphish-66656c18e902ecb2`, `compphish-6cea196f9483279c`, `kempf-html-e754caa0f8e0b8c9`, `look-for-mallory-077dcd4e48f4f7bf`, `look-for-mallory-2916c2eb57605ff5`, `look-for-mallory-3753437ae8bb51e8`, `look-for-mallory-47624d0f95bef3f9`, `look-for-mallory-5d40559237e954a8`, `look-for-mallory-67238517dbe7044a`, `look-for-mallory-812f2c953c20b0b3`, `look-for-mallory-8a7cfff02c95e42a`, `look-for-mallory-9cdfec648cfcaad7`, `look-for-mallory-c3b0499dc92b23a8`, `look-for-mallory-c46071e956a32047`, `phreshphish-0f9d979212a52f2f`, `phreshphish-15528fce0e41acea`, `phreshphish-35bbd25efbb8c000`, `phreshphish-3ef64bdf7e068f37`, `phreshphish-80edb907e255b44c`, `phreshphish-9e0b4d1c1a94dc0b`, `phreshphish-d4d5fb52aff3ca97`, `phreshphish-d8d01c03638a4ca3`, `phreshphish-df4824542d892778`, `phreshphish-e3d488115cc7ee6f`, `phreshphish-e5a263356d9e692b`, `phreshphish-f47890aa277d42db`, `scamferret-5280c514c1073290`.

Bar (operator, 2026-10-31 18:46 SAST: lure recall at least Spark's and false alarms at most 6 percent, on both sets, and on the South African slice where it has 30 lures and 30 benign pages): evaluation set passed (South Africa judged, 52 lures and 493 benign), reference set passed (South Africa not judged: 0 lures, 2 benign), both sets passed. The earlier Spark-relative reading (false alarms no higher than Spark's) fails on both sets (failed, failed). Loupe's cost a page is not known per request, since its deployment is billed by GPU time (the reference run took 7.9 minutes on one H200); Spark's is Meta's measured cost.
- Meaning: on pages chosen without Spark, Loupe 1.0 catches 0.923 of lures against Spark's 0.615 at 0.037 false alarms against 0.032, and answers in about half the time; on the evaluation set it catches more (0.980 against 0.943) but raises 0.057 false alarms against Spark's 0.002, which that set's construction flatters. 1.0 meets the time-boxed bar, not the project's own standard (false alarms at most 2 percent, lure recall above Muse Wonder's), which Loupe 1.1 is built to meet (D03 T04 §13's confirmed causes; the loupe lane's §25 and §27 to §29). It feeds D03 T04 §1 (Loupe in the pipeline with Spark failover) and §17 (the model card).

## 2026-10-31: Does the screener, as production runs it, tell 20 fictional-brand lures from 20 benign pages?

- Question: on 40 synthetic candidate pages of ten fictional brands (D03 T04 §1: 20 lures, 8 credential, 5 payment, 4 fake shops, 3 impersonation, and 20 benign, among them the brands' own pages; none drawn from Loupe 1.0's training, 0 screenshots shared with its 50,305), how do Loupe 1.0 (with the screener's own request: the JSON schema format and a 10-second deadline, on the warm deployment) and Muse Spark (as the fallback asks it: `structured()`, low effort, 2,000 tokens) answer?
- Set: `eval/glimmer/monitor-pages/`; runs in its `runs/`; scored by `node scripts/glimmer/monitor-pages.ts score`.

| Screener | Pages answered | Lure recall | False alarms | Median latency | p95 latency | Cost a page |
| --- | --- | --- | --- | --- | --- | --- |
| Loupe 1.0 (schema format) | 40 of 40 | 20 of 20 (1.00) | 19 of 20 (0.95) | 2.3 s | 5.4 s | US$0.0303, the run's 9.1 deployment minutes at US$8.00 an hour over 40 pages; a screening day shares them over its pages |
| Loupe 1.0 (no format, same pages) | 40 of 40 | 20 of 20 | 19 of 20 | 2.2 s | | as above |
| Muse Spark (the fallback's request) | 40 of 40 | 20 of 20 (1.00) | 0 of 20 (0.00) | 7.2 s | | US$0.0042 |

- Result: both catch every lure; Loupe calls 19 of the 20 benign pages lures, every answer at confidence 0.70 (the held-out run's were 0.95 except 24 of 1,000), and the same 19 with and without the JSON schema format, so the format is not the cause. Only the brand's own tracking page (benign-01) passed. Spark flagged none.
- Reading, not proved: the pages carry brands Loupe never saw and almost no surrounding page, and its known cause for false alarms is a real site of a brand absent from training (§13's confirmed causes: 12 of 42 on the held-out set). These 20 benign pages are all of that kind by construction, so this set is a harder test of that cause than the held-out set, not a measure of the held-out false-alarm rate (0.057). A confidence of 0.70 on every answer says Loupe is off its training distribution here.
- Decision: Glimmer stays the screener whatever the result (operator, 2026-10-28 15:26 SAST); a false-alarm rate this far above Spark's on pages of this kind is recorded and answered by retraining (Loupe 1.1, the `loupe` lane's §25 and §27 to §29: fictional or unseen brands' own pages as benign training), never by switching screeners. In production the false alarms go on to Spark's reading (spec 4.11), which found none here; the cost is Spark calls on benign candidates, not wrong findings.
- Warm-up measured with it: cold start 169.1 s, scale to zero 336 s after the last request (§13).

