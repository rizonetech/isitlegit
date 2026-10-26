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

## 1. Experiment: edited invoice digits

Can Muse Spark tell, from the image alone, that an account number on a synthetic invoice was edited (mismatched font, spacing, compression artefacts), and how often does it raise false alarms on unedited twins?

**Phase:** 2
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Run 10 edited and 10 unedited synthetic invoice images through a structured prompt. Done when: the log entry records accuracy, false alarms, latency and cost.

- [ ] Build 20 synthetic images with `scripts/fixtures/make-invoices.ts` (10 with a pasted account number). Done when: the images exist under `eval/sets/frontier/digits/`.
- [ ] Run them through `muse-spark-1.3` with a schema asking for suspected edited regions and confidence, at reasoning effort `high`. Done when: results are stored.
- [ ] Write the log entry with numbers and the decision, and file a section through `add-todo` if it becomes a feature. Done when: the entry exists.
- [ ] Commit: `frontier: Spark on edited invoice digits`

**Test checkpoint:** `grep -c '^## 2026-' docs/frontier-log.md` prints at least `1` and the entry names accuracy and cost.

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

## Verification

- Six dated log entries with numbers and decisions; adopted ideas are filed as sections.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
