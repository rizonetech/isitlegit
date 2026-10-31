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

- Model and settings: none (deterministic file forensics, D06 T02 §1); peepdf-3 (installed in a scratch virtual environment) and ExifTool 13.60 (run from its tarball), both outside the repository.
- Inputs: the Ghostscript and Chromium fixtures in `test/fixtures/pdf-forensics/` (`PROVENANCE.md`).
- Result: ExifTool reports Producer, Creator and both dates for every file: it shows `gs-modified-pop.pdf` modified on 2026-10-28 and `chromium-pop.pdf` made by "Skia/PDF m153", but says nothing about the payment date those dates contradict or the bank heading the producer contradicts. peepdf reports "Updates: 1" for `gs-edited-pop.pdf` and 0 for the others, but cannot say whether an update changed the page, only signed it or only rewrote metadata; it says nothing about `gs-substituted-font.pdf` or `gs-pasted-image.pdf`. `analysePdf` names one finding on each altered file (revisions, dates, fonts, overlay, producer) in a sentence a clerk can act on, and none on `gs-genuine-pop.pdf`, `gs-logo.pdf` or `chromium-invoice.pdf`.
- Meaning: the forensics adds what the open tools leave to an expert: the document's own claims (its heading, its payment date, its other amounts) read against the file's structure, and history that is not an edit kept silent. False-positive rates on real genuine documents are D08 T01 §3's to measure.
