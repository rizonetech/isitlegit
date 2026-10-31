---
schema_version: 1
id: frontier-experiments
domain: 08-eval
status: active
title: "TODO-03 -- Daily Frontier Experiments"
track: day-2
---

# TODO-03 -- Daily Frontier Experiments

> **Goal:** One timeboxed experiment per build day at the edge of what Meta's models can do, on synthetic inputs, logged in `docs/frontier-log.md` with model, settings, inputs, result in numbers and what it means; what works becomes a feature through the TODO system, what fails stays in the log with its evidence.

> **Current state:** Measured 2026-10-26 20:00 SAST. `docs/frontier-log.md` holds the entry format only. The manifesto's first priority and design spec 4.9 require this log.

## Inputs

- `docs/manifesto.md` (first priority: push the boundaries of Meta AI), design spec 4.9 (Frontier log), 11 (Budget).
- Meta docs and cookbooks via `python3 scripts/meta-docs.py find <terms>`.

## Outcome

- Six log entries, one per experiment below, each with numbers and a decision (feature, cut or open question) and, for features, a filed section.

**Adjacency:** all=not-applicable (research log entries; features they produce are filed as their own sections)

**Adjacency rationale:** Experiments produce knowledge and filed sections, not product surfaces.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Experiment: edited invoice digits | D03 T01 §5 | [ ] |
| 2 | §2 | Experiment: SAM and Spark on stamps | §1 | [ ] |
| 3 | §3 | Experiment: Wonder on a multi-step lure | §2, D04 T02 §4 | [ ] |
| 4 | §4 | Experiment: transcribing SA languages | §3, D01 T03 §4 | [ ] |
| 5 | §5 | Experiment: Spark on a scam video | §4 | [ ] |
| 6 | §6 | Experiment: reasoning effort and cost | §5, D08 T02 §1 | [ ] |
| 7 | §7 | Experiment: effort for other calls | §6, D03 T02 §3, D03 T03 §3, D04 T02 §4 | [ ] |

## 1. Experiment: edited invoice digits

> **Started:** 2026-10-31T09:40Z

Can Muse Spark tell, from the image alone, that an account number on a synthetic invoice was edited (mismatched font, spacing, compression artefacts), and how often does it raise false alarms on unedited twins?

**Corrected 2026-10-31** (plan fact-check): the section named `scripts/fixtures/make-invoices.ts`, which does not exist, and `scripts/` is shared tooling the eval lane does not write (`AGENTS.md`, Parallel lanes); the generator and the runner live in the eval lane's own folder, `eval/frontier/`, instead (coordinator, 2026-10-31). The images are built with `sharp` (a pinned dev dependency) from SVG, every company, bank and account fictional (`AGENTS.md`, synthetic data only). The checkpoint was a bare `grep -c` of the log, which an entry with no numbers passes; it now also runs the experiment's own tests and checks the entry against the stored results. Spend goes through `localBudget` and the shared ledger under the owner `eval-frontier` (coordinator, 2026-10-31): one call per image, 20 calls, and a refused reservation stops the run.

**Phase:** 2
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Build 10 invoice pairs (an unedited twin and an edited copy whose account number was pasted in), run all 20 through Spark with a structured answer, and score them. Done when: `eval/sets/frontier/digits/results.json` holds every image's answer, latency and cost, and the log entry records accuracy, false alarms, latency and cost from it.

- [ ] Write `eval/frontier/make-invoices.ts` exporting `invoiceSpecs()`: 10 fictional South African suppliers, each with a fictional bank, account number, invoice number, line items and total, fixed so a rerun builds the same set. Done when: `test/node/eval-frontier-digits.test.ts` finds 10 specs with distinct suppliers and 10-digit-or-shorter numeric account numbers; the pre-commit hook's client-name scan (`scripts/hooks/pre-commit`) passes on the commit that adds them.
- [ ] Render each spec's unedited twin with `renderInvoice(spec)` (SVG to PNG through `sharp`, then saved once as JPEG at quality 90, as a scanned or exported invoice would be). Done when: the test renders a twin whose width and height match `INVOICE_SIZE` and decodes as JPEG.
- [ ] Render each spec's edited copy with `editInvoice(spec, kind)`: the twin rendered with a different account number, then that number's box replaced by a patch carrying the original-looking digits made one of three ways, cycled over the 10 (`font`: another typeface; `spacing`: the same typeface, letter spacing and baseline off by a pixel or two; `recompress`: the same typeface, the patch JPEG-compressed at quality 55 before pasting, as a screenshot pasted over the number would be), and the whole saved as JPEG at quality 90. The manifest records each edit's kind and box. Done when: the test finds the edited image differs from its twin inside the recorded box and matches it, within JPEG noise, outside it (a patch pasted in the wrong place, or none, fails).
- [ ] Write `eval/frontier/digits.ts build`, writing the 20 images and `manifest.json` (file, spec id, `edited`, kind, box, sha256) under `eval/sets/frontier/digits/` through temp-file-then-rename. Done when: the 20 images and the manifest exist, and the test finds the manifest's hashes match the files.
- [ ] Define `DigitsAnswer` (zod, strict): `edited` (boolean), `confidence` (0 to 1), `regions` (each `field` from `account_number`, `amount`, `invoice_number`, `date`, `bank_name`, `other`, and a short `reason`). Done when: the test finds an answer with an unknown field or a confidence over 1 refused.
- [ ] Write the request in `digitsRequest(image)`: a neutral instruction (examine the invoice for signs any text was digitally altered after the document was made; it never says an edit is present or where), the image as an `input_image`, `muse-spark-1.3` at reasoning effort `high`, through `structured()` so the answer passes `DigitsAnswer`. Done when: the test reads the request a stub client receives and finds the model, the effort, `store: false`, the image, and no word of the manifest (`edited`, the kind, `account`) in the instruction.
- [ ] Write `eval/frontier/digits.ts run`: each image in manifest order, reserved first in the shared ledger (`reserveSpend`, run `eval-frontier-digits-<id>`) and in `localBudget("eval-frontier")` under the same id, settled at Meta's reported cost; a refused reservation or an unwritable ledger stops the run with nothing more sent; the answer, latency and cost written to `results.json` after each image (temp-file-then-rename), so an interrupted run resumes without paying twice for an answered image. Done when: the test, with a stubbed client, finds 20 results, a refusal on the 5th image leaving 4 results and no 5th request, and a rerun sending only the unanswered ones.
- [ ] Write `scoreDigits(manifest, results)`: accuracy over 20, detections over the 10 edited (by kind), false alarms over the 10 twins, the edited images whose regions name `account_number`, median and worst latency, total cost. Done when: the test scores a fixed set of answers to the exact numbers.
- [ ] Run `node eval/frontier/digits.ts run` against the live API (20 calls, under the ledger's caps). Done when: `results.json` holds 20 answered images, each with its cost.
- [ ] Write the `docs/frontier-log.md` entry from `node eval/frontier/digits.ts score`: model and settings, inputs, accuracy, false alarms, detections by kind, latency, cost, and the decision (feature, cut or open question); a feature is filed through `add-todo` (D06, the invoice checks). Done when: the entry exists and its numbers equal the score's.
- [ ] Commit: `frontier: Spark on edited invoice digits`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-frontier-digits.test.ts` passes (and fails when the patch is pasted outside its box, the instruction names the edit, or a refused reservation sends a request), and `node eval/frontier/digits.ts score --check docs/frontier-log.md` exits 0, finding a `## 2026-` entry whose accuracy, false alarms and cost equal the score of `results.json` (an entry with no numbers, or numbers that do not match, exits 1).

## 2. Experiment: SAM and Spark on stamps

Does segmenting the stamp and signature with SAM 3.1 and sending the crops with a genuine reference to Muse Spark beat Spark looking at the whole page, for spotting a doctored proof of payment?

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Compare chain and whole-page on 20 synthetic POP pairs. Done when: the log entry records both accuracies and costs.

- [ ] Use the payment-document pairs (D06 T02 §4) or code-made pairs if not yet available. Done when: 20 pairs are chosen.
- [ ] Run the chain (SAM crops plus reference to Spark) and the whole-page prompt on each. Done when: results are stored.
- [ ] Write the log entry and decide whether the chain becomes the default in D06 T02 §2. Done when: the entry exists and a section is filed if adopted.
- [ ] Commit: `frontier: SAM and Spark chain on stamps and signatures`

**Test checkpoint:** `grep -c 'stamp' docs/frontier-log.md` prints at least `1`.

## 3. Experiment: Wonder on a multi-step lure

Can Muse Wonder get through a cookie banner, a fake "verify you are human" click and a two-page lure to the credential page inside the 8-step, 60-second limits, and at what cost?

**Phase:** 4
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Build a three-stage fixture and run five walkthroughs. Done when: the log records success rate, steps used, time and cost.

- [ ] Add `fixtures/nimbusmail-multistep/` (cookie banner, checkbox gate, lure, login) on the fixtures host. Done when: it answers with `noindex`.
- [ ] Run five walkthroughs through the contained driver (D04 T02). Done when: results are stored.
- [ ] Write the log entry; if success is under 4 of 5, propose a driver-side change (for example a cookie-banner auto-dismiss) as a filed section. Done when: the entry exists.
- [ ] Commit: `frontier: Wonder through a multi-step lure`

**Test checkpoint:** `grep -c 'multi-step' docs/frontier-log.md` prints at least `1`.

## 4. Experiment: transcribing SA languages

Muse Voice Transcribe does not list Afrikaans, isiZulu or isiXhosa. What actually comes out for short synthetic voice notes in those languages, and is the request still extractable? The result decides what the report promises.

**Phase:** 5
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Transcribe six synthetic voice notes (two per language) and extract requests. Done when: the log records transcript quality and extraction success.

- [ ] Produce six short synthetic voice notes with consenting speakers from Rizonetech or a licensed synthetic voice, recording provenance in `eval/DATASETS.md`; if none can be produced unattended, record that and use English-accented samples instead. Done when: the audio exists or the substitution is recorded.
- [ ] Run transcription and extraction (D01 T03 §3 and §4). Done when: results are stored.
- [ ] Write the log entry and update the report's limits text if behaviour differs from the documented support. Done when: the entry exists.
- [ ] Commit: `frontier: Voice Transcribe on South African languages`

**Test checkpoint:** `grep -c 'Afrikaans' docs/frontier-log.md` prints at least `1`.

## 5. Experiment: Spark on a scam video

Spec section 8 lists Spark video input for scam screen recordings as a stretch. Can Muse Spark read a 30-second synthetic screen recording of a fake support chat and name the scam and the requested action?

**Phase:** 6
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Record one synthetic screen recording and analyse it. Done when: the log records what Spark found, latency and cost.

- [ ] Produce a 30-second MP4 of a fictional scam chat on the fixtures host with Browser Run screenshots stitched into video, or record that video production is not possible unattended. Done when: the file exists or the gap is recorded.
- [ ] Send it to `muse-spark-1.3` as video input with a structured schema. Done when: results are stored.
- [ ] Write the log entry and file a section if it should become an upload type. Done when: the entry exists.
- [ ] Commit: `frontier: Spark video input on a scam recording`

**Test checkpoint:** `grep -c 'video' docs/frontier-log.md` prints at least `1`.

## 6. Experiment: reasoning effort and cost

Which reasoning effort (`low`, `medium`, `high`, `xhigh`) gives the best verdict accuracy per dollar for the verdict agent on a 30-sample stratified subset? The answer sets the agent's default.

**Phase:** 6
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Run the subset at four efforts. Done when: the log records accuracy, latency and cost per effort.

- [ ] Run the eval subset with the agent at each effort through the runner (D08 T02 §1). Done when: four run rows exist.
- [ ] Write the log entry and set the agent's default effort in `src/agent/loop.ts` with the reason. Done when: the constant and the entry exist.
- [ ] Commit: `frontier: reasoning effort against accuracy and cost`

**Test checkpoint:** `grep -c 'reasoning effort' docs/frontier-log.md` prints at least `1`.

## 7. Experiment: effort for other calls

Filed 2026-10-30 at the operator's prompting, through the coordinator: at the Fireworks workshop the operator heard that medium reasoning effort sometimes beats high. §6 measures only the verdict agent; every other model call that takes an effort gets its default the same way, from accuracy per dollar on its own eval slice, rather than an assumed one. Nothing in `src/` sets an effort yet.

**Phase:** 6
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Measure each call's effort on its own slice. Done when: the log records accuracy, latency and cost per effort for each of the three calls, and each call's default is set from it.

- [ ] Run Muse Spark's structured reading of renders and pages (D03 T02 §3) at each effort on its eval slice through the runner (D08 T02 §1). Done when: one run row per effort exists.
- [ ] Run Muse Spark's logo comparison (D03 T03 §3) at each effort on its slice. Done when: one run row per effort exists.
- [ ] Run Muse Wonder's walkthrough loop (D04 T02 §4) at each effort on its slice. Done when: one run row per effort exists.
- [ ] Write the log entry in `docs/frontier-log.md` and set each call's default effort where the call is made, with the reason; a D03 default goes to the Glimmer lane through the coordinator. Done when: the entry and the three defaults exist.
- [ ] Commit: `frontier: reasoning effort for the screener and walkthrough calls`

**Test checkpoint:** `grep -c 'effort for other calls' docs/frontier-log.md` prints at least `1`.

## Verification

- Six dated log entries with numbers and decisions; adopted ideas are filed as sections.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
