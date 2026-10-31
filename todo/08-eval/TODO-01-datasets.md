---
schema_version: 1
id: eval-datasets
domain: 08-eval
status: active
title: "TODO-01 -- Evaluation Datasets"
track: day-2
---

# TODO-01 -- Evaluation Datasets

> **Goal:** At least 150 labelled samples (attacks and genuine mail) exist in `eval/sets/`: a synthetic South African set (fictional banks, suppliers and couriers; text by Muse Spark, documents by Muse Image and code) and public phishing corpora whose licences allow our use, each source and licence recorded in `eval/DATASETS.md`, with one label format the runner reads.

> **Current state:** Measured 2026-10-26 20:00 SAST. No `eval/` exists. The data decision is in design spec section 11 (Eval data).

## Inputs

- Design spec 4.9 (dataset, targets, Muse Image set), 11 (Eval data decision), `AGENTS.md` (synthetic data only; corpora licences in `eval/DATASETS.md`).
- -> XREF: D06 T02 §4 -- the Muse Image doctored payment documents that join this set
- -> XREF: D03 T04 §5 -- the Glimmer page datasets chosen under the same licence rule

## Outcome

- `eval/DATASETS.md` lists every source with licence, URL, date taken and how it is used; `eval/sets/*/labels.json` validates against one schema; at least 150 samples, at least 60 genuine.

**Adjacency:** all=not-applicable (evaluation data files in the repository; no product surface)

**Adjacency rationale:** Datasets are committed reference data used by the eval runner.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Label format and loader | D00 T01 §3 | [x] |
| 2 | §2 | Public corpora chosen by licence | §1, D08 T03 §9 | [x] |
| 3 | §3 | Synthetic South African mail set | §1, D03 T01 §5 | [ ] |
| 4 | §4 | Labels for attacks only a model can see | §2, D08 T01 §1 | [ ] |

## 1. Label format and loader

One schema for every set: file path, label (attack or genuine), category (credential phishing, BEC payment, invoice bank change, impersonation, malware attachment, voice lure, genuine business, genuine newsletter), expected critical evidence, and source.

> **Started:** 2026-10-31T08:58Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) the loader reads files from disk, which the Worker test project cannot, so its test is `test/node/eval-load.test.ts` in the Node project (`test/eval/load.test.ts` would run in workerd), and `eval/` is typechecked through it; (2) a set is a folder, `eval/sets/<name>/`, holding `labels.json` (an array of labels) beside the files it names; a label's `path` is relative to its set and refused if it leaves it (`..`, an absolute path) or names no file; (3) a label is `{ path, label: "attack" | "genuine", category, expected, source }`, `expected` the check names whose evidence an attack should raise (empty for genuine mail, refused empty for an attack), `source` the corpus or author it came from; a set's paths are unique; every refusal names the set, the label's index and its path.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/08-eval/D08-T01-s1.md`): (4) the tests are disk-backed and assert whole loaded records and every refusal's diagnostics: a path leaving its set (`..` or absolute), a missing file, a repeated path, an attack without expected evidence, genuine mail with some, a category disagreeing with its label, and `DATASETS.md`'s six columns; (5) a refusal is structured (`SetRefused`'s `set`, `index`, `path` and `reason`, `null` where there is none): a set without `labels.json`, one that is not JSON or not a list, an empty set, a missing sets directory and one holding no set are each refused, and one broken set refuses the whole load, never an incomplete population; (6) each loaded sample carries its set-qualified id (`<set>/<path>`), its set and its resolved file, so two sets may each hold `001.eml`.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Write `eval/schema.ts` and `eval/load.ts`. Done when: a fixture set loads and a malformed label is refused.

- [x] Define the zod `Label` schema and `loadSets()` in `eval/`. Done when: `test/node/eval-load.test.ts` loads a fixture set and refuses an unknown category (corrected from `test/eval/load.test.ts`).
- [x] Create `eval/DATASETS.md` with the table header (source, licence, URL, date, count, use). Done when: the file exists.
- [x] Commit: `eval: label format and loader` Done 2026-10-31: the build commit with the plan review folded in, then the completion review's and the rounds' fixes after it.

**Test checkpoint:** `pnpm exec vitest run --project node test/node/eval-load.test.ts` passes.

> **Verified:** 2026-10-31 | §1 | 5ff1d580ca48c352dd73957cec0aa84a022b2742
> **Review:** `docs/reviews/d08-t01-s1.json`

## 2. Public corpora chosen by licence

> **Started:** 2026-10-31T11:36Z

Public phishing and genuine-mail corpora are used only if their licence allows our use in a public repository and a commercial product (spec 4.9). Each candidate's licence is read on its own page; anything unclear is not used.

**Corrected 2026-10-31** (plan fact-check against the merged loader, D08 T01 §1): a set is a folder `eval/sets/<source>/` holding the sample files and a `labels.json` in `eval/schema.ts`'s `Label` format (path, `attack` or `genuine`, one of the eight categories, the expected check names, source), which `loadSets` (`eval/load.ts`) reads whole; the docs test belongs in the Node project (`test/node/`), since the Worker project's tests cannot read the repository's files; the sets table in `eval/DATASETS.md` (Source, Licence, URL, Date, Count, Use) is the one the loader's test already pins. A corpus sample is real mail someone received: only what the corpus itself publishes is kept, and no personal address, phone number or bank detail it did not already publish is added; a sample whose content is not clearly an attack or clearly genuine is left out rather than guessed.

**Corrected 2026-10-31** (plan review, P1 and 2 P2, `docs/reviews/08-eval/D08-T01-s2.md`): the Outcome's totals (at least 150 samples, at least 60 genuine) no longer rest on this section finding enough: §3 makes up whatever the public sets leave short, whatever their count, and owns the aggregate test; every imported sample's content is parsed as mail, not only its label loaded; and every accepted corpus's licence obligations (attribution, a kept notice) are recorded and met in the committed set.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Research candidates and record decisions. Done when: `eval/DATASETS.md` lists each candidate with accept or reject and the licence text it rests on.
2. Import the accepted ones. Done when: their samples are in `eval/sets/<source>/` with labels that `loadSets` reads.

- [x] Research at least five candidate corpora (for example the Enron corpus for genuine mail, Nazario phishing corpus, SpamAssassin public corpus, PhishTank-derived sets) and record licence, URL and decision in `eval/DATASETS.md`, under a "Candidate corpora" table (Corpus, Licence, URL, Read on, Decision, Why, Obligations). Done when: each row has the licence quote or link and the date it was read. Cheaper substitute: assuming "public" means "allowed". Done 2026-10-31: seven read (Nazario, Enron, SpamAssassin, PhishTank, phishing_pot, TREC/CEAS, Ling/Enron-Spam); only Nazario's (CC BY 4.0, its README and `LICENSE.txt` read on monkey.org) is accepted.
- [x] Import up to 60 samples from accepted corpora into `eval/sets/<source>/`, each file as the corpus publishes it, removing nothing the corpus publishes and adding nothing it does not, with a `labels.json` (label, category and expected checks decided by reading each sample; `source` names the corpus and its file). Done when: `loadSets("eval/sets")` loads them and each source has a row in the sets table with its licence, URL, date, count and use. Done 2026-10-31: **Corrected 2026-10-31** (completion review): a first pick of 49 chose messages our checks can see, which overstates detection; the set is now a random draw of 60 (seed 20261031, 18 messages passed over for holding a client's name), each byte for byte: the 10 that show evidence the label vocabulary names are labelled in `eval/sets/nazario-2025/` (all credential phishing), and the 50 that only a model could judge wait unlabelled in `eval/pending/nazario-2025/` (`pending.json`) for D08 T01 §4.
- [x] Record, for each accepted corpus, the obligations its licence sets (attribution text, a notice or licence file to keep, a share-alike term) in the Candidate corpora table's Obligations column, and meet each in the set itself (its `LICENSE` or `NOTICE` file in `eval/sets/<source>/`, the attribution in its sets-table Use cell). Done when: the docs test finds every obligation recorded for an accepted corpus met in its folder or row. Done 2026-10-31: `LICENSE.txt` (the full CC BY 4.0 text, as published) and `NOTICE.md` (attribution, the changes made, the mailbox's hash) in the set; the sets row points to it.
- [x] Record how many samples, and how many genuine, the public sets hold, for §3 to make up the rest. Done when: the sets table's Count cells give both, and §3's target reads them. Done 2026-10-31: 10 labelled (and 50 pending), 0 genuine; no genuine corpus passes, so §3 makes up all 60 genuine and at least 140 more in all, less what §6 labels.
- [x] Write `test/node/eval-datasets-doc.test.ts`: every folder under `eval/sets/` has a sets-table row naming it, with a licence and a URL, and every sets-table row names a folder that exists with as many samples as its Count; every candidate row has a decision and a licence; every accepted corpus's obligations are met; and every imported sample parses as one email (`postal-mime`, as intake parses mail) with a sender and a body, or is a document type intake accepts. Done when: the test fails on a folder with no row, a row with no folder, a Count that differs, a candidate with no decision, an unmet obligation, and an empty or unparseable sample. Done 2026-10-31: an emptied real sample and a removed notice each fail it; after the completion review it also checks the licence text's title, the notice's source URL, licence and changes, and the pending folder's obligations, manifest and mail.
- [x] Commit: `eval: public corpora chosen by licence`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-datasets-doc.test.ts test/node/eval-load.test.ts` passes, and the datasets test fails when a set folder has no row with a licence, a row's Count differs from its labels, a candidate has no decision, an accepted corpus's obligation is unmet, or a sample is empty or does not parse.

> **Verified:** 2026-10-31 | §2 | d7a64b08f50004c60fd089d0de90042de7e50cd2
> **Review:** `docs/reviews/d08-t01-s2.json`

## 3. Synthetic South African mail set

At least 100 synthetic samples written for South African small businesses: fictional banks (Protea Bank), suppliers, couriers and SARS-style notices without real branding, credential phishing to fictional providers, BEC payment requests, invoice bank changes, voice-lure mails, and genuine business mail and newsletters. Text is generated with Muse Spark from scenario templates and checked by rules; headers are built in code with realistic authentication results for both attack and genuine cases.

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write the generator. Done when: a dry run prints 100 scenarios with labels.
2. Generate and check. Done when: 100 or more `.eml` files with labels exist and pass the realism checks.

- [ ] Write `eval/generate/scenarios.ts` with at least 100 scenario specs (category, fictional parties, trick used, expected critical evidence). Done when: the specs validate.
- [ ] Generate bodies with `muse-spark-1.3` through the budget guard and assemble `.eml` files with code-built headers (SPF, DKIM, DMARC results set per scenario). Done when: the files parse with `parseMessage`.
- [ ] Check each file names no real company, bank or person (a list of real SA bank and big-brand names must not appear) and carries `X-IsItLegit-Synthetic: true`. Done when: `test/eval/synthetic.test.ts` passes.
- [ ] Record the set, method and count in `eval/DATASETS.md`. Done when: the row exists.
- [ ] Make up the Outcome's totals whatever §2's public sets hold: generate as many more synthetic samples as bring every set together to at least 150, at least 60 of them genuine (added 2026-10-31 from §2's plan review). Done when: `test/node/eval-totals.test.ts` loads `eval/sets/` with `loadSets` and finds at least 150 samples and at least 60 genuine, and fails below either.
- [ ] Commit: `eval: synthetic South African mail set`

**Test checkpoint:** `pnpm exec vitest run test/eval/synthetic.test.ts` passes and fails on a planted real bank name.

## 4. Labels for attacks only a model can see

> **Started:** 2026-10-31T12:04Z (re-recorded with the decided contract; first written at 12:01Z in `7b943c2c`, before the decision)

§2's random draw from the Nazario corpus (2026-10-31) found that 50 of 60 real phishing messages show no evidence the label vocabulary names (`eval/schema.ts`: an attack's `expected` lists deterministic check names, refused empty): their attack is visible only to a model reading the page, the text or the image. They wait unlabelled in `eval/pending/nazario-2025/`. Leaving them out would let the evaluation overstate detection, so the label contract needs a way to say "an attack whose evidence a model must find", and these 50 need labels under it.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Extend the label contract for model-found evidence and label the pending messages. Done when: the 50 pending messages are in a labelled set and the runner (D08 T02 §1) can score them.

- [x] Decide, with the coordinator and the checks lane, how a label names model-found evidence. Done 2026-10-31 (coordinator, option A): `Label` gains `basis: "checks" | "model"`, `checks` by default (today's rule unchanged: an attack names the check evidence it should raise); a `model` attack may name none, and the runner (D08 T02) scores it on the verdict alone (suspicious or malicious, or not). `eval/schema.ts` and `eval/load.ts` are in D08 since the split and their section (§1) is stamped, so this section changes them; the existing loader tests pass unchanged.
- [ ] Add `basis` to `Label` in `eval/schema.ts`: optional, `"checks"` or `"model"`, defaulting to `"checks"`; an attack with basis `checks` must name expected evidence (as now), an attack with basis `model` may name none, genuine mail takes basis `checks` and names none. Done when: `test/node/eval-load.test.ts` passes unchanged and a new test finds a `model` attack with no expected evidence loaded, a `checks` attack with none refused, genuine mail with basis `model` refused, and a sample loaded without `basis` read as `checks`.
- [ ] Label each message in `eval/pending/nazario-2025/pending.json` by reading it: its category (credential phishing, impersonation, BEC payment, invoice bank change, malware attachment, voice lure) and basis `model`, moving the file into `eval/sets/nazario-2025/` and its entry out of the manifest; a message whose category is not clear from reading it stays pending with its reason. Done when: `loadSets` loads the set and `pending.json` lists only the unclear ones, each with its reason.
- [ ] Update the sets table's Count, the notice and `eval/DATASETS.md`'s note on the draw. Done when: `test/node/eval-datasets-doc.test.ts` passes.
- [ ] Commit: `eval: labels for attacks only a model can see`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-datasets-doc.test.ts test/node/eval-load.test.ts test/node/eval-label-basis.test.ts` passes (the loader's own tests unchanged), and the basis test fails when a `checks` attack with no expected evidence loads or a `model` attack with none is refused.

## Verification

- At least 150 labelled samples with recorded sources and licences; no real client mail.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
