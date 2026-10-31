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
| 1 | §1 | Label format and loader | D00 T01 §3 | [ ] |
| 2 | §2 | Public corpora chosen by licence | §1 | [ ] |
| 3 | §3 | Synthetic South African mail set | §1, D03 T01 §5 | [ ] |

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

## 2. Public corpora chosen by licence

Public phishing and genuine-mail corpora are used only if their licence allows our use in a public repository and a commercial product (spec 4.9). Each candidate's licence is read on its own page; anything unclear is not used.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Research candidates and record decisions. Done when: `eval/DATASETS.md` lists each candidate with accept or reject and the licence text it rests on.
2. Import the accepted ones. Done when: their samples are in `eval/sets/<source>/` with labels.

- [ ] Research at least five candidate corpora (for example the Enron corpus for genuine mail, Nazario phishing corpus, SpamAssassin public corpus, PhishTank-derived sets) and record licence, URL and decision in `eval/DATASETS.md`. Done when: each row has the licence quote or link. Cheaper substitute: assuming "public" means "allowed".
- [ ] Import up to 60 samples from accepted corpora, removing any real personal address or bank detail beyond what the corpus itself publishes, and label them. Done when: the labels validate.
- [ ] If no corpus is acceptable, record that and raise the synthetic target in §3 to 150. Done when: either imports exist or the decision is recorded.
- [ ] Commit: `eval: public corpora chosen by licence`

**Test checkpoint:** `pnpm exec vitest run test/eval/datasets-doc.test.ts` passes, checking every set folder has a row in `eval/DATASETS.md` with a licence.

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
- [ ] Commit: `eval: synthetic South African mail set`

**Test checkpoint:** `pnpm exec vitest run test/eval/synthetic.test.ts` passes and fails on a planted real bank name.

## Verification

- At least 150 labelled samples with recorded sources and licences; no real client mail.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
