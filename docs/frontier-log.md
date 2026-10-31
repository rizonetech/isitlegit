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
