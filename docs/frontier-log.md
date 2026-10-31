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

- Model and settings: `muse-spark-1.3`, reasoning effort high, `max_output_tokens` 8000, structured output (`DigitsAnswer`, strict JSON schema), `store: false`; the neutral instruction (it never says an edit exists, where or how) is `INSTRUCTION` in `eval/frontier/digits.ts`.
- Inputs: 10 fictional South African invoices in `eval/sets/frontier/digits/` (`eval/frontier/make-invoices.ts`), each as an unedited twin and as an edit whose account number was pasted over, both saved twice at JPEG quality 90; the edits cycle three ways: another typeface (4), letter spacing and baseline off by 1 to 2 px (3), the same digits recompressed at quality 55 before pasting (3). Results: `eval/sets/frontier/digits/results.json`.
- Fingerprint: `e76784b46874ae29122d4ce51fe939b2de9122bde8bd23da450c2019efc5a3d3`
- Accuracy: 70% (14/20; failed 0, pending 0)
- Detected: 4/10 edited (font 4/4, spacing 0/3, recompress 0/3); account_number named on 4
- False alarms: 0/10 twins
- Latency: median 17.1 s, worst 22.9 s
- Cost: US$0.1663 measured, US$0.0000 uncertain
- Baseline (error level, z > 3): detected 1/10 edited, false alarms 0/10 twins
- Result: Spark caught every typeface swap, each with confidence 0.85 to 0.90 and `account_number` named as the region, and never cried wolf on a twin (all at 0.05 to 0.06). It missed every spacing shift and every recompressed patch, answering those with the same low confidence as the twins (0.05 to 0.08), so it gave no sign of seeing them at all. The error-level baseline caught one spacing edit and nothing else. One attempt per image, no repair or retry.
- Meaning: On this small set Spark catches the crude edit (a number retyped in another font, 4 of 4) with no false alarm on clean twins, and misses the careful one (0 of 6); with the rule set before the run (feature needs 8 of 10), it is not yet a feature. Open question: whether the typeface signal holds on scanned and photographed invoices, and whether pairing it with a JPEG-grid check (the recompressed patches) covers what it misses; the invoice checks (D06) should not claim edit detection on this evidence.
- Decision: open question
- Limit: 10 twins cannot show the 2% false-positive target (design spec 4.9), and these are pristine generated invoices, not scans or photos.
