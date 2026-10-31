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
- Inputs: the Ghostscript and Chromium fixtures in `test/fixtures/pdf-forensics/` (`PROVENANCE.md`), made by `node test/fixtures/pdf-forensics/make.ts`.
- Commands: `exiftool -s -Producer -Creator -CreateDate -ModifyDate <file>`; `peepdf -f <file>`; the analyser through `test/invoice/forensics-generated.test.ts` (`pnpm exec vitest run --project worker test/invoice/forensics-generated.test.ts`).
- Result: ExifTool prints Producer, Creator and both dates for every file (`gs-modified-pop.pdf`: ModifyDate 2026:10:28 14:22:00+02:00; `chromium-pop.pdf`: Producer "Skia/PDF m153"), in about 0.5 s a file including Perl's start. peepdf prints "Updates: 1" and a second version for `gs-edited-pop.pdf` and "Updates: 0" for the others; in its interactive mode it can also list and extract each version's objects, so an expert can diff them by hand. Neither reads the document's own claims: ExifTool does not compare the modification date with the payment date the page states, or the producer with the bank heading; peepdf does not say whether an update changed what the page shows, and neither reports the substituted font in `gs-substituted-font.pdf` or the image over the amount in `gs-pasted-image.pdf`. `analysePdf` names exactly one finding on each altered file (revisions, dates, fonts, overlay, producer) with a sentence and a stated limit, and none on `gs-genuine-pop.pdf`, `gs-logo.pdf` or `chromium-invoice.pdf`, in workerd at a median of 2 to 15 ms and a 95th percentile of 7 to 36 ms a file over 25 runs (the Worker's timer moves in whole milliseconds).
- Meaning: on these eight files the analyser does in one pass what an expert does with both tools and a page reading, and keeps signing and metadata-only saves silent. Eight synthetic files prove the mechanism, not accuracy on real bank documents: that measurement is D08 T01 §3's, and broader filters and encrypted files are D06 T02 §5's.
