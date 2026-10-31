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
| 4 | §4 | Labels for attacks only a model can see | §2, D08 T01 §1 | [x] |
| 5 | §5 | Label rationales and adjudication | §4 | [x] |
| 6 | §6 | Second readings imported from the review | §5 | [x] |

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

> **Started:** 2026-10-31T13:24Z

At least 100 synthetic samples written for South African small businesses: fictional banks (Protea Bank), suppliers, couriers and SARS-style notices without real branding, credential phishing to fictional providers, BEC payment requests, invoice bank changes, voice-lure mails, and genuine business mail and newsletters. Text is generated with Muse Spark from scenario templates and checked by rules; headers are built in code with realistic authentication results for both attack and genuine cases.

**Corrected 2026-10-31** (at start, validated against the tree): the section said `test/eval/synthetic.test.ts`, which the Worker project would run (vitest's `worker` project takes `test/**`), where the generated files cannot be read from disk; the tests are `test/node/eval-synthetic.test.ts` and `test/node/eval-totals.test.ts`. "Expected critical evidence" is bound to what the deterministic checks can raise from code-built headers and parts, by their registered names (`auth.spf`, `auth.dkim`, `auth.dmarc`, `sender.reply_to`, `sender.return_path`, `attachment.executable`, `attachment.macro`, `attachment.html`): fictional parties sit outside the brand table, so `sender.display_brand` and `domain.lookalike` cannot fire on them and are never expected, and an attack whose only tell is its text (a BEC request with passing authentication) is labelled `basis: "model"` with no expected evidence (D08 T01 §4). Fictional parties use domains under the reserved `.example` top-level domain (RFC 2606), so no generated address belongs to anyone; `domain.age` is therefore never expected either. Headers are written as Google Workspace records them (`Received` by `mx.google.com` on top, `Authentication-Results: mx.google.com`), so a tenant with a Google receiver trusts them; whether the deployed pipeline raises each expected item is scored by D08 T02 §1, the eval runner. The real-name list is the curated brand table (`data/brands.json`: names, display names and domain labels) plus the South African banks, insurers, retailers, couriers, telecoms and utilities it does not hold, in `eval/generate/real-names.ts`. The mix is set by the totals: Nazario gives 55 attacks and no genuine mail, so the set is 160 (70 genuine: 40 business, 30 newsletters; 90 attacks: 20 credential phishing, 15 BEC payment, 15 invoice bank change, 15 impersonation, 15 voice lure, 10 malware attachment), bringing the sets to 215 with 70 genuine. Spending follows the frontier runner (D08 T03 §1): `muse-spark-1.3` through `localBudget("eval-synthetic")` and the shared Meta ledger, a hard run cap of US$1.50 (estimate about US$0.93), a results file that resumes without paying twice, and no call before the coordinator approves the spend.

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write the generator. Done when: a dry run prints 160 scenarios with labels and spends nothing.
2. Generate and check. Done when: 160 `.eml` files with labels exist and pass the realism checks.

- [ ] Write `eval/generate/scenarios.ts` with the 160 scenario specs (category, fictional parties from `eval/generate/parties.ts`, the trick used, the authentication results, the expected evidence or `basis: "model"`). Done when: `test/node/eval-synthetic.test.ts` finds every spec valid, the mix as stated, every party domain under `.example`, and every expected name one of the eight above, consistent with its spec (a failing result for each `auth.*`, a differing Reply-To for `sender.reply_to`, a differing Return-Path for `sender.return_path`, the attachment for each `attachment.*`).
- [ ] Write `eval/generate/real-names.ts` and the rule checks in `eval/generate/realism.ts`: no real name (case-insensitive, whole word), 40 to 400 words of body, the scenario's own parties named, no placeholder (`[`, `{{`, `<insert`), no model talk ("as an AI", "here is"). Done when: the test finds each rule refusing a planted case, a planted real bank name included.
- [ ] Write `eval/generate/run.ts`: the dry run (no key read, nothing spent) and the generate run, `muse-spark-1.3` through `localBudget("eval-synthetic")` and the shared ledger under its lock, a US$1.50 run cap, one realism retry per scenario, results resumable by scenario id. Done when: the test, with a fake model, finds the dry run spending nothing, the cap refusing the call that would pass it, a resumed run paying nothing for answered scenarios, and a body failing realism twice left out and named.
- [ ] Assemble the `.eml` files in code (`eval/generate/assemble.ts`): headers built per spec with `X-IsItLegit-Synthetic: true`, the body from the model, attachments built in code. Done when: the test parses every assembled file with `parseMessage` and reads back the spec's headers, the marker and its parts.
- [ ] Generate the set into `eval/sets/synthetic-sa/` (160 files, `labels.json`) after the coordinator's approval, the approval recorded in the run file. Done when: the files exist, `loadSets` loads the set, and every file passes the realism checks and names no real name.
- [ ] Record the set, method and count in `eval/DATASETS.md`. Done when: the row exists and `test/node/eval-datasets-doc.test.ts` passes.
- [ ] Make up the Outcome's totals whatever §2's public sets hold: generate as many more synthetic samples as bring every set together to at least 150, at least 60 of them genuine (added 2026-10-31 from §2's plan review). Done when: `test/node/eval-totals.test.ts` loads `eval/sets/` with `loadSets` and finds at least 150 samples and at least 60 genuine, and fails below either.
- [ ] Commit: `eval: synthetic South African mail set`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-synthetic.test.ts test/node/eval-totals.test.ts test/node/eval-datasets-doc.test.ts` passes, and fails on a planted real bank name and on totals below 150 or 60 genuine.

## 4. Labels for attacks only a model can see

> **Started:** 2026-10-31T12:04Z (re-recorded with the decided contract; first written at 12:01Z in `7b943c2c`, before the decision)

§2's random draw from the Nazario corpus (2026-10-31) found that 50 of 60 real phishing messages show no evidence the label vocabulary names (`eval/schema.ts`: an attack's `expected` lists deterministic check names, refused empty): their attack is visible only to a model reading the page, the text or the image. They wait unlabelled in `eval/pending/nazario-2025/`. Leaving them out would let the evaluation overstate detection, so the label contract needs a way to say "an attack whose evidence a model must find", and these 50 need labels under it.

**Corrected 2026-10-31** (plan review, P1 and 2 P2, `docs/reviews/08-eval/D08-T01-s4.md`): `basis` is optional and its absence is read as `checks`, never written into a loaded record, so the loader's exact-record tests stay unchanged; every message of the original draw is reconciled (exactly once, labelled or pending, bytes unchanged, a reason for each pending one, the manifest's counts true); this section ends when every drawn message is accounted for and the eligible labels load, and scoring a `model` label on the verdict alone is D08 T02 §2's (added there).

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Extend the label contract for model-found evidence and label the pending messages. Done when: every message of the draw is accounted for, labelled or pending with a reason, and the labels load.

- [x] Decide, with the coordinator and the checks lane, how a label names model-found evidence. Done 2026-10-31 (coordinator, option A): `Label` gains `basis: "checks" | "model"`, `checks` by default (today's rule unchanged: an attack names the check evidence it should raise); a `model` attack may name none, and the runner (D08 T02) scores it on the verdict alone (suspicious or malicious, or not). `eval/schema.ts` and `eval/load.ts` are in D08 since the split and their section (§1) is stamped, so this section changes them; the existing loader tests pass unchanged.
- [x] Add `basis` to `Label` in `eval/schema.ts`: optional, `"checks"` or `"model"`, its absence read as `checks` (not written into the loaded record); an attack read as `checks` must name expected evidence (as now), a `model` attack may name none, genuine mail is never `model` and names none. Done when: `test/node/eval-load.test.ts` passes unchanged and `test/node/eval-label-basis.test.ts` finds a `model` attack with no expected evidence loaded, a `checks` attack with none refused, genuine mail with basis `model` refused, and a sample without `basis` loaded as it was before, held to the `checks` rule. Done 2026-10-31: `test/node/eval-load.test.ts` untouched and passing; `test/node/eval-label-basis.test.ts` (4 tests).
- [x] Label each message in `eval/pending/nazario-2025/pending.json` by reading it: its category (credential phishing, impersonation, BEC payment, invoice bank change, malware attachment, voice lure) and basis `model`, moving the file into `eval/sets/nazario-2025/` and its entry out of the manifest; a message whose category is not clear from reading it stays pending with its reason. Done when: `loadSets` loads the set and `pending.json` lists only the unclear ones, each with its reason. Done 2026-10-31: 48 labelled by reading (40 credential phishing, 8 impersonation: refund and callback scams with phone numbers, a tax-fine lure), basis `model`; 2 stay pending (message 18 reads as Netflix's own price notice, message 249 is a Chinese-language invoice whose lure cannot be told).
- [x] Record the whole draw in `eval/pending/nazario-2025/draw.json` (every drawn message's number and sha256) and reconcile it in `test/node/eval-datasets-doc.test.ts`: each drawn message exactly once across the labelled set (by its label's source) and the pending manifest, each file's bytes matching its recorded hash, each pending entry with a reason, and `pending.json`'s `labelled` count equal to the labels. Done when: the test passes and fails on a dropped message, a duplicated one, a changed byte and an empty reason. Done 2026-10-31: `drawProblems`; the fixture test fails on a dropped, duplicated and changed message and an empty reason.
- [x] Update the sets table's Count, the notice and `eval/DATASETS.md`'s note on the draw. Done when: `test/node/eval-datasets-doc.test.ts` passes. Done 2026-10-31: 58 (0 genuine).
- [x] Close the completion review's gaps (2026-10-31, `docs/reviews/08-eval/D08-T01-s4.md`): reconciliation binds each label's path to the file drawn for its message, so two labels trading files are refused (a swapped-path fixture fails it); per-label rationales and adjudication filed as D08 T01 §5. Done when: the swapped-path case fails the datasets check. Done 2026-10-31.
- [x] Commit: `eval: labels for attacks only a model can see`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-datasets-doc.test.ts test/node/eval-load.test.ts test/node/eval-label-basis.test.ts` passes (the loader's own tests unchanged), the basis test fails when a `checks` attack with no expected evidence loads or a `model` attack with none is refused, and the reconciliation fails on a dropped, duplicated or changed drawn message.

> **Verified:** 2026-10-31 | §4 | ec653c8d381d4ac3da3667a7f46fa60f0cf84713
> **Review:** `docs/reviews/d08-t01-s4.json`

## 5. Label rationales and adjudication

> **Started:** 2026-10-31T12:14Z

Filed 2026-10-31 from D08 T01 §4's completion review (out of its scope): the 48 Nazario labels accepted by reading carry a category and a basis but no recorded reason tied to what the message shows, no reviewer and no review date, while the pending ones carry their reasons; a disputed label is then hard to review. Each label read by a person or a model needs a short rationale from the message's own content and a record of who decided it and when, and a disagreement keeps its resolution or stays pending.

**Corrected 2026-10-31** (plan fact-check): the second reader is the pinned reviewer of another model family (`.conclave/reviewers.toml`), reading every rationale against its message in this section's completion review and first round, as it reads the rest of the candidate; its verdict per label is recorded in the annotation (`second_reading`: reviewer, round, agree or disagree with the resolution), so no review channel outside `scripts/review-dispatch.py` is needed.

**Corrected 2026-10-31** (plan review, P1 and 2 P2, `docs/reviews/08-eval/D08-T01-s5.md`): the second reading has its own boundary: the build commit writes every annotation with `second_reading: null` (awaiting); the completion review is asked for one verdict per path in a fixed form (`<path>: agree` or `<path>: disagree: <why>`); a later commit records each verdict with the reviewer's name from the pin, the review it came from (the findings file and its heading) and the verdict's text; round 1 then checks the recorded decisions against the review. The datasets check refuses a missing or awaiting reading, a duplicate annotation, a reader who is not the pinned reviewer (the writer, `claude`, never), a reading whose review does not hold that path's verdict, and a recorded verdict that differs from it. A label disputed and not resolved leaves the scored set for `eval/pending/`, its file unchanged and its annotation (rationale and both readings) kept in its `pending.json` entry.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Give every read label a rationale and an adjudication record. Done when: every label of basis `model` in `eval/sets/` names its rationale, reviewer and date, and the datasets check refuses one without.

- [x] Add an annotations file beside each labelled set, `eval/sets/<set>/annotations.json` (path, rationale quoting what in the message decided the category, reviewer, date, and `disputed` with its resolution), not a change to `Label`, so the loader's contract stays as §1 and §4 left it. Done when: a schema for it in `eval/schema.ts` validates a fixture and refuses a rationale under 20 characters or an unknown path. Done 2026-10-31: `Annotation` and `SecondReading` in `eval/schema.ts`.
- [x] Write the rationale for each of the 48 `model`-basis labels in `eval/sets/nazario-2025/` from the message itself. Done when: every one has its entry, reviewer and date. Done 2026-10-31: `eval/sets/nazario-2025/annotations.json`, 48 rationales from the messages, reader `claude`.
- [x] Commit every annotation with `second_reading: null`, then ask the completion review for a verdict per path in the fixed form. Done when: the completion review in `docs/reviews/08-eval/D08-T01-s5.md` holds one verdict line for each annotated path. Done 2026-10-31: committed in `b1fe2362`; the completion review's `### Second reading` holds 48 verdict lines (42 agree, 6 disagree).
- [x] Record each verdict in its annotation's `second_reading` (`reviewer` from `.conclave/reviewers.toml`, `review` as `<findings file>#<heading>`, `verdict`, `note`) in a new commit; resolve each `disagree` by correcting the label with its reason, or move the label to `eval/pending/` with its file unchanged and its annotation kept in its `pending.json` entry. Done when: every annotation (or pending entry) records its second reading and round 1 confirms the recorded decisions. Done 2026-10-31: 6 disagreements settled: messages 121 and 209 keep impersonation with their rationales corrected (the message cannot show the reader did not buy); 318 relabelled impersonation; 146, 172 and 239 moved to pending, unchanged, with their whole annotation. The set is 55 (45 `model`), pending 5. Round 1 confirms.
- [x] Make `test/node/eval-datasets-doc.test.ts` refuse a `model`-basis label with no annotation, an annotation for no label, a duplicate annotation, a missing or awaiting second reading, a reader who is not the pinned reviewer, a reading whose review does not hold that path's verdict, a recorded verdict that differs from the review's, and a disputed one with no resolution; and prove the transition to pending keeps the file's bytes and the whole annotation, with the draw reconciliation, manifest counts and sets table still consistent. Done when: each fails the test, and the transition fixture passes. Done 2026-10-31: and, after the completion review, the reading's reviewer and note are bound to the review (its author heading, its verdict line), and a disputed pending entry must keep its own annotation (deleted, misbound and awaiting each refused).
- [x] Commit: `eval: label rationales and adjudication`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-datasets-doc.test.ts test/node/eval-load.test.ts` passes on the final candidate, and fails when a `model`-basis label has no annotation, a reading is missing, awaiting, by the writer or not backed by the named review, or a disputed one has no resolution.

> **Verified:** 2026-10-31 | §5 | f4de3e65970d2c2a202d7862d705afbfee52fdc9
> **Review:** `docs/reviews/d08-t01-s5.json`

## 6. Second readings imported from the review

> **Started:** 2026-10-31T12:33Z

Filed 2026-10-31 from D08 T01 §5's completion review (out of its scope): the pinned reviewer's per-path verdicts (`- \`<path>\`: agree` or `disagree: <why>` under a review's `### Second reading`) are transcribed into each annotation by a one-off script; a validated import would take them straight from the findings file, refusing a missing or duplicate verdict, so no reading is copied by hand.

**Corrected 2026-10-31** (at start): the dispatcher needs no change (decided here, sent to the coordinator, who judges shared tooling): the fixed form comes from the review prompt, which asks for it, and the import validates it, so `scripts/review-dispatch.py` and its other consumers stay as they are. The import is proved on the real record too: importing `docs/reviews/08-eval/D08-T01-s5.md`'s second reading must reproduce every reading §5 committed.

**Corrected 2026-10-31** (plan review, P1 and 2 P2, `docs/reviews/08-eval/D08-T01-s6.md`): the real-record proof clears every reading first (in the set's annotations and the pending entries), imports, rereads both files and compares them whole with the committed originals; the import validates each reading against `SecondReading` and the pin (the reviewer named in `.conclave/reviewers.toml`, never `claude`) before anything is written, and refuses with both files unchanged; and it has a command, `node eval/import-readings.ts <findings file> <set folder> [<pending folder>]`, with named diagnostics and a nonzero exit, tested through what it persists.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Write the import and use it for the next labelled set. Done when: an import of a findings file's second reading writes every annotation's `second_reading`, and refuses a missing, duplicate or unknown path.

- [x] Write `eval/import-readings.ts`: read one review's `### Second reading` from a findings file, match each verdict line to an annotation by path, write each `second_reading` (reviewer from the review heading, `review` as `<file>#Second reading`, verdict, note) temp-file-then-rename, and refuse the whole import on a missing, duplicate or unknown path or a malformed line, naming each. Done when: `test/node/eval-import-readings.test.ts` imports a fixture and refuses each fault with nothing written. Done 2026-10-31: `readVerdicts`, `applyVerdicts`, `importReadings`.
- [x] Ask the coordinator whether the dispatcher should emit the fixed form itself (`scripts/review-dispatch.py` is shared tooling, D00); record the answer. Done when: the answer is recorded here. Done 2026-10-31: no dispatcher change (the review prompt asks for the fixed form; the import validates it); sent to the coordinator.
- [x] Check the import against the real record: copy `eval/sets/nazario-2025/annotations.json` and `eval/pending/nazario-2025/pending.json`, set every `second_reading` to `null`, import `docs/reviews/08-eval/D08-T01-s5.md`'s second reading through the command, and reread both files. Done when: `test/node/eval-import-readings.test.ts` finds both equal, field for field, to the committed originals. Done 2026-10-31: all 45 set readings and the 3 pending ones reproduced, both files equal to the committed ones.
- [x] Validate before writing: each reading built is parsed by `SecondReading`, and its reviewer must be one the pin names and never `claude`; an import that fails either is refused with both files byte for byte unchanged. Done when: the test finds a review by `claude`, one by an unpinned name and one with a note over 400 characters each refused, both files unchanged. Done 2026-10-31: `pinnedReviewers` and `SecondReading`; refusals leave both files byte for byte.
- [x] Give the import its command and test it as a process: `node eval/import-readings.ts <findings file> <set folder> [<pending folder>]` exits 0 and writes, or exits 1 naming every problem and writes nothing, or exits 2 on bad arguments. Done when: the test runs the command on a fixture and reads back what it wrote, and runs it on a broken review and finds the exit code, the diagnostics and the files unchanged. Done 2026-10-31: exit 0, 1 (each problem named, nothing written) and 2 tested as a process.
- [x] Write both files or neither, across a kill and a retry with other arguments (completion review; rounds 1 to 3): the import is a transaction recorded first in a journal beside the set's annotations (`annotations.json.import-journal`) that names every file it replaces, whether each existed, and its state; every original is kept on disk (`<file>.before-import`) before any replacement, the journal is marked `committed` once both files are in place, and only then do the backups and the journal go; any later run settles an interrupted import from the journal, never its own arguments, forward when committed and back otherwise (`recoverInterrupted`), clearing that run's temporary files; a failed rollback names the journal and backups really on disk (`writeBoth` in `eval/import-readings.ts`); every step reaches stable storage before the next, each written file flushed before it is renamed and each folder flushed after an entry in it changes (`durableFs`, round 4). Done when: `test/node/eval-import-readings.test.ts` fails each write and rename in turn and finds both files unchanged with nothing beside them, finds the backups on disk when the rollback fails too, and kills a real process between the replacements and during the cleanup and finds a retry without the pending folder settle the whole import, back and forward, and records the disk operations of a real import and finds every flush in its place and the commit on disk before the first original goes. Done 2026-10-31.
- [x] Refuse broken identities before writing (completion review; round 1): a path annotated twice, in the set, in pending or across both, or a pending entry whose annotation names another path (`applyVerdicts`). Done when: the test finds each refused with the files unchanged. Done 2026-10-31.
- [x] Prove the real record through the command (completion review): the command, run on cleared copies of both files, prints `48 readings written (42 agree, 6 disagree)` and writes both byte for byte as committed. Done when: the test compares the persisted text of both files. Done 2026-10-31.
- [x] Say what is left to settle (completion review): the command's output names the counts and each disagreement on a label still in its set with no resolution, and the next step (a resolution, or a move to pending), in the same run (`report`). Done when: the test reads the mixed and the all-agree output. Done 2026-10-31.
- [x] Commit: `eval: second readings imported from the review`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-import-readings.test.ts` passes and fails when a verdict is missing, duplicated or names no annotation.

> **Verified:** 2026-10-31 | §6 | 4534ff51987b468e05b5d2e7e228a9445b2a4664
> **Review:** `docs/reviews/d08-t01-s6.json`

## Verification

- At least 150 labelled samples with recorded sources and licences; no real client mail.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
