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
| 1 | §1 | Experiment: edited invoice digits | D03 T01 §5 | [x] |
| 2 | §2 | Experiment: SAM and Spark on stamps | §1, D03 T03 §1 | [x] |
| 3 | §3 | Experiment: Wonder on a multi-step lure | §2, D04 T02 §4 | [ ] |
| 4 | §4 | Experiment: transcribing SA languages | §3, D01 T03 §4 | [ ] |
| 5 | §5 | Experiment: Spark on a scam video | §4 | [ ] |
| 6 | §6 | Experiment: reasoning effort and cost | §5, D08 T02 §1 | [ ] |
| 7 | §7 | Experiment: effort for other calls | §6, D03 T02 §3, D03 T03 §3, D04 T02 §4 | [ ] |
| 8 | §8 | Digits runner killed in a child process | §1 | [x] |
| 9 | §9 | Frontier images out of the eval sets folder | §1 | [x] |

## 1. Experiment: edited invoice digits

> **Started:** 2026-10-31T09:40Z

Can Muse Spark tell, from the image alone, that an account number on a synthetic invoice was edited (mismatched font, spacing, compression artefacts), and how often does it raise false alarms on unedited twins?

**Corrected 2026-10-31** (plan fact-check): the section named `scripts/fixtures/make-invoices.ts`, which does not exist, and `scripts/` is shared tooling the eval lane does not write (`AGENTS.md`, Parallel lanes); the generator and the runner live in the eval lane's own folder, `eval/frontier/`, instead (coordinator, 2026-10-31). The images are built with `sharp` (a pinned dev dependency) from SVG, every company, bank and account fictional (`AGENTS.md`, synthetic data only). The checkpoint was a bare `grep -c` of the log, which an entry with no numbers passes; it now also runs the experiment's own tests and checks the entry against the stored results. Spend goes through `localBudget` and the shared ledger under the owner `eval-frontier` (coordinator, 2026-10-31): one structured call per image, 20 in all (a repair or a client retry is its own reserved attempt, under the run's cap), and a refused reservation stops the run.

**Corrected 2026-10-31** (plan review, 8 P2, `docs/reviews/08-eval/D08-T03-s1.md`): the run also needs the operator's Wrangler login, since `localBudget` reserves on the live D1 through `wrangler d1 execute --remote` (kept under `meta-api`, as for every local Meta caller: a `cloudflare` Need would widen the generated Phase 2 table past 100 characters); every attempt, a structured repair and a client retry included, is reserved and settled in both ledgers, under the shared ledger's lock; an image is recorded `pending` before it is sent, and an interrupted one is never resent on its own; twins and edits share one encoding history (both saved twice); results are bound to an experiment fingerprint; a deterministic error-level baseline runs on the same images; the decision rule is set before the run; the log check requires every promised field.

**Phase:** 2
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Build 10 invoice pairs (an unedited twin and an edited copy whose account number was pasted in), run all 20 through Spark with a structured answer and through an error-level baseline, and score both against a rule set before the run. Done when: `eval/sets/frontier/digits/results.json` holds every image's terminal outcome, latency and cost under the experiment's fingerprint, and the log entry records accuracy, false alarms, latency, cost, the baseline and the decision from it.

- [x] Write `eval/frontier/make-invoices.ts` exporting `invoiceSpecs()`: 10 fictional South African suppliers, each with a fictional bank, account number, the different real number an edit covers, invoice number, line items and total, fixed so a rerun builds the same set. Done when: `test/node/eval-frontier-digits.test.ts` finds 10 specs with distinct suppliers and 9 to 11 digit account numbers, each differing from its covered number; the pre-commit hook's client-name scan (`scripts/hooks/pre-commit`) passes on the commit that adds them. Done 2026-10-31: `invoiceSpecs` (seeded, ten suppliers, four fictional banks) in `533bdcba`.
- [x] Render each spec's twin with `renderInvoice(spec)`: SVG through `sharp`, saved as JPEG at quality 90, decoded and saved again at quality 90, so the twin's encoding history matches the edit's. Done when: the test finds a twin of `INVOICE_SIZE` that decodes as JPEG and carries ink both inside `ACCOUNT_BOX` (digits) and across the page (a blank or one-colour page fails). Done 2026-10-31: `renderInvoice` saves twice; ink checked in the box and across the page.
- [x] Render each spec's edit with `editInvoice(spec, kind)`: the invoice issued with the covered number and saved at quality 90, then a white patch carrying `spec.account` pasted over `ACCOUNT_BOX` and the whole saved again at quality 90. The patch is made one of three ways, cycled over the 10: `font` (another typeface), `spacing` (the same typeface, letter spacing and baseline off by a pixel or two), `recompress` (the same typeface and place, the patch JPEG-compressed at quality 55 before pasting). Done when: the test finds each edit differs from its twin inside the box and matches it within JPEG noise outside it, the box carries a digit-like share of ink (a solid rectangle or an empty patch fails), and each kind's patch differs from the twin's box the intended way (`font`: glyph shapes, `spacing`: the ink's horizontal extent, `recompress`: only compression-level noise). Done 2026-10-31: `editInvoice` and `patch`; the test checks the box, the noise outside it, digit-like ink and each kind's mechanism (font: mean difference over 8; spacing: ink extent moved 5 px or more; recompress: extent within 1 px, difference 0.3 to 6).
- [x] Write `eval/frontier/digits.ts build`: the 20 images and `manifest.json` (file, spec id, `edited`, kind, box, the source and replacement numbers, sha256, and the typefaces `fc-match` resolved) under `eval/sets/frontier/digits/`, each written temp-file-then-rename. Done when: the test finds the manifest's hashes match the files and every field is present. Done 2026-10-31: `buildSet`; 20 images, 1.8 MB, fonts resolved to DejaVuSans.ttf and NimbusRoman-Regular.otf (fontconfig's match for Liberation Serif here).
- [x] Define `DigitsAnswer` (zod, strict): `edited` (boolean), `confidence` (0 to 1), `regions` (at most 6, each `field` from `account_number`, `amount`, `invoice_number`, `date`, `bank_name`, `other`, and a `reason` of 1 to 400 characters). Done when: the test finds an unknown field, a confidence over 1 and an unknown property each refused. Done 2026-10-31.
- [x] Write `digitsRequest(image)`: a neutral instruction (it never says an edit is present, where or how), the image as an `input_image`, `muse-spark-1.3` at reasoning effort `high`, `max_output_tokens` 8000, sent through `structured()`. Done when: the test, through the real client and structured helper with a stubbed `fetch`, reads the body sent and finds the model, the effort, the output limit, `store: false`, the image and the `json_schema` format, and no word of the manifest (`edited`, `pasted`, `account`) in the instruction. Done 2026-10-31: read through the real client and `structured()`; the test caught the first draft's instruction naming the answer's `edited` field, reworded.
- [x] Write `ledgeredBudget(guard, ledger, image)`: every attempt the client or the structured repair makes is reserved first in the shared ledger (`metaLedger()`, run `eval-frontier-digits-<fingerprint>`, call `<file>#<n>`) and then in the guard under that entry's `ledgerId`, released in the ledger when the guard refuses, and settled or left uncertain in both; it reports the image's measured and uncertain cost and its attempt count. Done when: the test finds a repair (invalid then valid) recorded as two attempts in both ledgers with both costs summed, a transport retry (503 then 200) as two, and a guard refusal on the second attempt leaving the first settled, the second released and no second request. Done 2026-10-31.
- [x] Hold the shared ledger's lock (`ledgerLock`, as `scripts/glimmer/teacher-label.ts` does: `takeLock` on `<ledger>.lock`) around every read-modify-write of the ledger, re-reading the ledger under it. Done when: the test finds another caller's entry, written between two of this run's updates, still in the ledger after them, and a lock held by a live process stops the run before any request. Done 2026-10-31: `sharedLedger`, each change locked on a fresh read; `ledgerLock` equals the teacher's (tested).
- [x] Write `eval/frontier/digits.ts run`: the fingerprint (sha256 of the instruction, the schema, model, effort, output limit and the manifest's hashes) heads `results.json`; each image is recorded `pending` before it is sent and then `answered`, `failed` (invalid, incomplete, refused, timed out; its kind kept) or, when the run stops between, left `pending`; every write temp-file-then-rename. A rerun sends only images with no record; a `pending` one is reported as ambiguous and resent only with `--retry-pending`; a refused reservation or a held lock stops the run with nothing more sent; nothing is sent once this run's ledger entries reach `RUN_CAP_USD` (US$1.50). Done when: the test, with a stubbed client, finds 20 answered results, a refusal on the 5th image leaving 4 answered and no 5th request, a process stopped after a send leaving that image `pending` and a rerun not resending it, and a rerun sending only images without a record. Done 2026-10-31: `runSet`.
- [x] Refuse stored results that do not match: a different fingerprint, a duplicate or unknown file, a missing manifest image, a changed image hash or a stored answer that fails `DigitsAnswer`. Done when: the test finds each of the six refused by `run` and by `score`, naming the problem. Done 2026-10-31: `resultProblems`, `readResults`, `manifestProblems`; `score` refuses all six, `run` the five that are not a missing image (a run fills missing images by design).
- [x] Write `baselineDigits(image)`: error-level analysis, the image re-saved at quality 90 and the mean absolute difference inside `ACCOUNT_BOX` compared with the other value fields on the same page (bank name, branch code), flagged when it exceeds their mean by `BASELINE_Z` (3) of their spread; no model, no cost. Done when: the test finds the baseline's flag computed on a fixed pair and its threshold a named constant set before the run. Done 2026-10-31: **Corrected 2026-10-31:** the spread floor was a fixed 0.5, ten times every page's spread (levels run near 0.1), so nothing could flag; it is 10% of the page's mean level (`ff4ed5f3`), z > 3 unchanged, with a regression test.
- [x] Write `scoreDigits(manifest, results)`: answered, failed and pending counts; accuracy over the 20 (a failed or pending image counts as wrong); detections over the 10 edits by kind; false alarms over the 10 twins; detections naming `account_number`; median and worst latency; measured and uncertain cost; and the baseline's detections and false alarms. Done when: the test scores a fixed set of answers, failures and baseline flags to exact numbers. Done 2026-10-31.
- [x] Write `decide(score)` from the rule set before the run: `feature` when Spark detects at least 8 of 10 edits, at least 7 naming `account_number`, with at most 1 false alarm, and detects more edits than the baseline; `cut` when it detects no more edits than the baseline or raises 3 or more false alarms; otherwise `open question`. Done when: the test finds each outcome on a score built for it. Done 2026-10-31.
- [x] Run `node eval/frontier/digits.ts run` against the live API (20 images, at most `RUN_CAP_USD`). Done when: `results.json` holds 20 terminal outcomes under the current fingerprint, each with its cost. Done 2026-10-31: 20 answered, one attempt each, US$0.1663 measured, fingerprint `e76784b4`.
- [x] Write the `docs/frontier-log.md` entry from `node eval/frontier/digits.ts score`: model and settings, the instruction (its path and fingerprint), inputs, accuracy, false alarms, detections by kind, account-field naming, latency, cost, the baseline's numbers, the decision by the rule, and the limit that 10 twins cannot show the 2% false-positive target (design spec 4.9) and that the invoices are pristine generated ones; a `feature` decision is filed through `add-todo` (D06, the invoice checks) and named in the entry by its ref. Done when: the entry exists and `score --check` passes on it. Done 2026-10-31: decision `open question` (font 4/4, spacing 0/3, recompress 0/3, 0/10 false alarms; baseline 1/10); nothing filed, the rule files only a feature.
- [x] Write `checkLog(log, score, decision)`: the entry is found by its title and fingerprint, and must carry every metric line exactly as `scoreLines` writes it (accuracy, false alarms, detections by kind, latency, cost, baseline), the instruction's path, the decision as `decide` reads it, the limitation line, and for `feature` a ref that `todo-graph.py resolve` finds. Done when: the test finds an entry missing or changing any one of them fails with that field named. Done 2026-10-31: `checkLog(log, score, resolves)` (the decision is derived from the score by `decide`).
- [x] Close the completion review's gaps (2026-10-31, `docs/reviews/08-eval/D08-T03-s1.md`): each outcome's attempts and cost read back from the shared ledger, so an interrupted attempt retried with `--retry-pending` stays counted (G1); a settlement the ledger could not write stops the run with the attempt kept at its estimate (G2); `run --results <file>` measures afresh beside the published results and `build --out <dir>` builds into a new folder whole, refusing one that exists (G3); `FONT_PINS` pins both font files by sha256 and the build refuses a substitute (G4); `eval/DATASETS.md` records the set's provenance and the fonts' licences (G5); the score counts unsupported regions and the log discloses the four branch-code accusations (G6); `checkLog` requires the model and settings, the inputs and the unsupported-region lines and refuses a contradicting claim (G7); every attempt keeps its tokens and log id and the results their prices, so each cost recomputes (G8; the published run's tokens read back from its own `model_spend` rows by one SELECT, coordinator 2026-10-31). Done when: `test/node/eval-frontier-digits.test.ts` covers each (41 tests; a mutation per gap caught) and `score --check` passes on the regenerated entry. Done 2026-10-31.
- [x] Commit: `frontier: Spark on edited invoice digits`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-frontier-digits.test.ts` passes (and fails when the patch is pasted outside its box or is a solid block, the instruction names the edit, a refused reservation sends a request, a pending image is resent, or results with another fingerprint are scored), and `node eval/frontier/digits.ts score --check docs/frontier-log.md` exits 0 on the committed results and log (an entry missing a metric, the decision or the limitation, or numbers that differ from the score, exits 1).

> **Verified:** 2026-10-31 | §1 | 2a67fad4fbfdf2f655ecbaff6c3b5fef6cabe754
> **Review:** `docs/reviews/d08-t03-s1.json`

## 2. Experiment: SAM and Spark on stamps

> **Started:** 2026-11-02T16:21Z

Does segmenting the stamp and signature with SAM 3.1 and sending the crops with a genuine reference to Muse Spark beat Spark looking at the whole page, for spotting a doctored proof of payment?

**Corrected 2026-10-31** (coordinator): the SAM 3.1 client, its parser and the crops are D03 T03 §1's (the walkthrough lane's), so this experiment uses them and writes no second SAM client in `eval/`: it depends on D03 T03 §1, which sits in Phase 4, so it moves from Phase 3 to Phase 4 (a prerequisite never sits in a later phase than its consumer). Spend is approved up to US$1.50 through `localBudget` and the shared ledger, owner `eval-frontier`, stopping on any refusal or at the cap.

**Phase:** 4
**Needs:** meta-api
**Surface:** no

**Corrected 2026-11-02** (plan review, `docs/reviews/08-eval/D08-T03-s2.md`, 4 P1 and 2 P2 fixed here): (1) the checkpoint is a stubbed behavioural suite plus a log verifier that recomputes both arms' figures from stored results and refuses a missing outcome, a skipped arm or a mismatched input; the old grep already passed on an unrelated line. (2) Pairs are code-made stamp and signature alterations (D06 T02 section 4 edits amounts, accounts and dates, not stamps): 20 labelled genuine/doctored pairs with matching fictional references and reproducible generation, tested to contain the intended alteration and the genuine controls, with the sample's limits stated in the log. (3) Both arms receive the same genuine reference, the same cases and the same Spark settings, labels withheld from prompts; the request payloads are tested. (4) The runner is `node eval/frontier/stamps.ts` on the section 1 pattern: SAM boxes are pixel geometry, crops are cut with `sharp` in Node (no browser), bounded and cleaned up, and a test proves real crop bytes reach the Spark request. (5) Every case and arm stores an explicit outcome (answered, refused, malformed, timeout, budget-stopped) with failure-aware denominators, validated answers, durable progress fingerprinted by input, prompt and settings, and no automatic resend of a paid call. (6) The adoption rule is set before the run: detection and false-positive rates apart, end-to-end latency, and total chain cost including segmentation and failed attempts; the log records prompts, settings, results and limits, and an adopted chain names a resolvable D06 T02 section 2 section.

**Build order:**

1. Compare chain and whole-page on 20 synthetic POP pairs. Done when: the log entry records both accuracies and costs.

- [x] Use the payment-document pairs (D06 T02 §4) or code-made pairs if not yet available. Done when: 20 pairs are chosen. Done 2026-11-02 (expanded to 20 genuine/doctored pairs = 40 pages on 2026-11-04): code-made pairs in `eval/frontier/stamps.ts` (`buildSet`, 20 labelled pairs: 7 `stamp-date`, 7 `signature-swap` and 6 `stamp-colour` alterations plus 20 genuine controls, with the genuine reference stamp/signature band both arms receive); tested in `test/node/eval-frontier-stamps.test.ts`.
- [x] Run the chain (SAM crops plus reference to Spark) and the whole-page prompt on each. Done when: results are stored. Done 2026-11-04: 80 outcomes (40 `whole` answered, 40 `chain` `empty-segmentation` via real `sam-3.1` streaming segmentation without fixed-coordinate fallback) stored in `eval/frontier/sets/stamps/results.json`, bound to `fileSha256` and `fingerprint: baad738ed2b85c3d9febeab94865895824efc794fea285fc60b694d89b74d87b`; whole detection 65.0% (13/20: 7/7 stamp-date, 6/6 stamp-colour, 0/7 signature-swap), whole false positives 0.0% (0/20), settled cost US$0.1335 whole (40 calls, median 4964 ms, worst 7851 ms) vs US$0.2000 chain (80 SAM calls returning 0 boxes on flat vector stamps/signatures, median 1731 ms, worst 3514 ms).
- [x] Write the log entry and decide whether the chain becomes the default in D06 T02 §2. Done when: the entry exists and a section is filed if adopted. Done 2026-11-04: entry in `docs/frontier-log.md` (`score --check` exit 0, `Decision: cut | fingerprint: baad738ed2b85c3d9febeab94865895824efc794fea285fc60b694d89b74d87b`); not adopted into `D06 T02 §2` because SAM 3.1 returns 0 boxes on flat vector-rendered synthetic POP stamps and signatures.
- [x] Commit: `frontier: SAM and Spark chain on stamps and signatures`

**Test checkpoint:** `pnpm exec vitest run --project node test/node/eval-frontier-stamps.test.ts` passes (stubbed arms, payload and completeness refusals) and `node eval/frontier/stamps.ts score --check docs/frontier-log.md` exits 0 on the stored results.

> **Verified:** 2026-11-04 | §2 | 2e3478ee80cea9110c466e538af448f1a4b7c846
> **Review:** `docs/reviews/d08-t03-s2.json`

## 3. Experiment: Wonder on a multi-step lure

Can Muse Wonder pass a cookie banner, a fake human-verification checkbox and a document lure to reach the credential page within the unchanged 8-step, 60-second driver limits, and at what cost?

**Coordinator decisions 2026-11-04 (`eval-decisions-0950`, `budget-and-ownership-correction`):** Eval owns synthetic assets and the harness; checks owns `src/fixtures/redirects.ts` route binding, and the coordinator owns CI-gated integration/deployment. Initial experiment allowance is US$5 total for five walks including every retry/repair attempt. Staged increases to US$10 then US$20 require measured usage, useful remaining attempts, a dated decision and verified owning configuration before reservation; shared-day enforcement remains unchanged. No spend before exact deployed route/driver proof. Reversal cancels unspent attempts; incurred charges cannot be reversed. No fixture or harness implementation exists before this plan review.

**Phase:** 4
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Build harmless synthetic assets and a deterministic no-spend fixture/driver test, with the routing contract sent to checks. Done when: navigation reaches the credential page only through the three gates and no real value is collected or sent.
2. Build and test the bounded five-walk runner, durable accounting and scoring. Done when: interruptions cannot silently repeat a paid identity or lose reserved cost, and scores recompute from validated stored observations.
3. After coordinator deployment proof and shared headroom, run five contained walks and record measured results. Done when: the log names exact candidate/deployment, success numerator/denominator, steps, time, actual versus estimated cost, and any incomplete attempt. Missing deployment or budget proof is a blocker, never a zero-cost success.

- [ ] Add `fixtures/nimbusmail-multistep/{index,lure,login,submitted}.html`: index has a cookie overlay followed by a checkbox leading to lure; lure links to login; login has fictional canary-only fields and client-side submission that discards values before navigating to submitted. Every page visibly says synthetic test fixture, declares noindex/nofollow, uses no external assets and never sends input values. Checks binds these relative paths under the existing secret fixtures prefix, including slash normalization and existing noindex/no-store headers. Done when: a real browser test follows controls, verifies the credential page is reached, confirms no credential-bearing request occurs, and runs with synthetic canaries only. Cheaper substitute: a direct login URL tests no gates.
- [ ] Add `eval/frontier/multistep.ts` with strict `run`, `score`, `--help` and explicit credit confirmation for `run`; runner-specific Worker test/config may live under `eval/frontier/` and tests under `test/eval/` and `test/node/`, without changing shared scripts, routing, driver or global Vitest config. Reuse the actual `walk`/Driver, minted per-case canaries, existing `localBudget("eval-frontier")`, pricing and protected vault reader. Use a dedicated Worker configuration only to supply experiment inputs to the existing real driver. Done when: routine tests make no model calls; the live adapter runs the real loop with no driver/model limit increase, no substituted model output, no download and no unvalidated action. Cheaper substitute: a scripted browser journey is fixture proof, not Wonder success.
- [ ] Persist one experiment with five fixed ordinal attempt identities, exact source/deployed SHA, fixture hashes, model/settings, immutable success rubric and original cap before sending. Hold a kernel-backed experiment lock; write/fsync/rename state and record a pending reservation before child execution. A resume skips measured ordinals, refuses unknown in-flight outcomes until shared-ledger reconciliation, and never resets usage or invents a sixth attempt. Each whole walk reserves its worst-case allowance through the shared ledger before secrets/child execution, every inner model attempt is constrained by that allowance, and settled measured/estimated costs remain attributable to the ordinal. Done when: interruption/unknown-result/cap/concurrency tests fail on duplicate calls or lost cost; invalid/over-allowance reports fail closed with reservation retained. Set the existing MetaContext `transportAttempts` to1, so provider capacity failures cannot start short internal retries. Record a capacity failure without another paid attempt; a later authorized remaining ordinal (never a sixth attempt) observes the persisted not-before time using2,5,10,20,30,60,120minute then doubling intervals with positive jitter and Retry-After as a minimum. Never overlap attempts or erase the failed ordinal. No automatic capacity retry loop is added. Cheaper substitute: rerunning an interrupted five-call loop can double spend.
- [ ] Before any paid attempt, verify the fixture URL is the exact expected path on `fixtures.isitlegit.co.za`, all four deployed page bodies match owned hashes and return noindex/no-store, `/health` matches the recorded deployed SHA, and the local driver/model dependency bytes match that deployed commit. Keep secret-prefix URLs and credentials out of public artifacts and argv; obtain values only through authorized environment/vault handling. Done when: wrong host, path, body, headers, deployment, driver bytes or insufficient shared/local headroom refuses without a model call. Existing ledger cap refusal is retained and escalated, never bypassed. Cheaper substitute: checking only a200 status can test an old fixture or unrelated page.
- [ ] Score success only from the driver's stored current-page/observed-navigation evidence reaching the exact credential route after the cookie/checkbox/lure sequence, within8steps and60seconds; reaching the credential page is distinct from filling/submitting successfully. Store completion outcome separately and include unsuccessful/limited/refused walks in the five-attempt denominator. Publish only after all five ordinals have validated outcomes; an unknown attempt remains explicitly incomplete. Done when: score tests reject a direct-login bypass, reordered/missing gate evidence, wrong URL, excess limits, duplicate/missing ordinal or mismatched manifest, and recompute success, steps, time and cost from stored results. Cheaper substitute: the model saying it succeeded is not browser evidence.
- [ ] Write the measured entry in `docs/frontier-log.md`; if fewer than4of5 reach the credential page, propose an owning driver follow-up through the coordinator, never patch the driver in this lane or relax limits. Done when: the entry names exact evidence and honestly distinguishes local fixture tests from deployed-model measurement. Until required deployment/accounting evidence exists, leave the experiment unstamped and report its blocker.
- [ ] Commit: `frontier: Wonder through a multi-step lure`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run --project node test/node/frontier-multistep.test.ts` passes accounting/resume/scoring refusals; the dedicated no-spend browser/driver fixture test passes; full typecheck, lint and build pass. `node eval/frontier/multistep.ts score --check docs/frontier-log.md` verifies the actual five-walk measurements before completion. No model success is inferred from stubbed tests.

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

## 8. Digits runner killed in a child process

> **Started:** 2026-10-31T10:34Z

The edited-digits runner (§1, `eval/frontier/digits.ts`) records an image `pending` before it is sent and never resends it on its own; its run lock is reclaimed when the process holding it has died (`takeLock` in `scripts/meta-smoke.ts`). §1's test simulates that death inside the test process (it removes the lock by hand and leaves the first run's promise outstanding), so it proves neither real process death nor the dead-holder reclaim (D08 T03 §1 round 5, P3, `docs/reviews/08-eval/D08-T03-s1.md`).

**Corrected 2026-10-31** (plan fact-check): the section planned a stub HTTP Responses server; the child can carry its own stubbed `fetch` instead (as every other runner test does) and announce its third request through a marker file, which proves the same thing (a real process killed mid-request, its lock and results left behind) with no port and no server to clean up. `run` reads vault secrets, so the child is a test entry, `test/node/fixtures/digits-child.ts`, calling `runSet` with a stub guard and a temp shared ledger.

**Corrected 2026-10-31** (plan review, P2 and P3, `docs/reviews/08-eval/D08-T03-s8.md`): every wait on a child is bounded and every child is killed and awaited in a `finally` before the temp folder goes, a child that fails to start or exits early fails the test with its stderr; and the child test replaces §1's in-process simulation rather than sitting beside it, keeping its live-holder refusal and its `--retry-pending` accounting assertions.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Run the runner in a child process, kill it while a request is in flight, and resume against its files. Done when: the test proves the image stays `pending`, the dead child's lock is reclaimed and a rerun resends nothing ambiguous.

- [x] Write `test/node/fixtures/digits-child.ts`: reads the set folder, ledger path and mode from its arguments, runs `runSet` with a stub guard, a `sharedLedger` on that path and a stubbed `fetch` that answers, except in `hang` mode, where the third request writes a marker file and never answers; it prints the run's report and its request count as JSON. Done when: run as `answer`, it prints 20 answered. Done 2026-10-31: modes `answer`, `hang`, `silent` and `--retry-pending`.
- [x] In `test/node/eval-frontier-digits.test.ts`, start the child in `hang` mode, wait for the marker, `SIGKILL` it and await its exit. Done when: the exit's signal is `SIGKILL` and the results file reads `answered`, `answered`, `pending`, with the lock file still naming the dead child's pid. Done 2026-10-31.
- [x] Resume in a second child in `answer` mode against the same folder and ledger, without `retryPending`. Done when: it does not report "being run already" (the dead holder's lock reclaimed), reports `inv-02-twin.jpg` ambiguous, sends 17 requests (none for the pending image) and leaves that image `pending` with its reserved attempt counted in the ledger. Done 2026-10-31: 17 sent, `inv-02-twin.jpg` ambiguous and still pending, its `#1` entry reserved.
- [x] Bound and clean every child: a helper starts the child, collects stdout and stderr, and rejects on a start error, an early exit (naming its code and stderr) or a 30 s deadline; a `finally` kills and awaits every child still running before the temp folder is removed. Done when: a test whose child is given a mode that never writes the marker fails within the deadline with no child left running. Done 2026-10-31: `startChild`, `untilFile`, `finished`, `stopChildren` in `afterEach`; the `silent` child test fails in 1 s with no child left.
- [x] Replace §1's in-process test ("leaves an image pending when the process stops after sending it") with the child test: while the `hang` child is alive, an in-process `runSet` on the same results file is refused ("being run already", no request); after the kill and the resume, a third child with `retryPending` sends one request and the image's outcome counts both attempts (the killed one at its estimate, the retry measured). Done when: the old test is gone and these assertions pass in the child test. Done 2026-10-31: the in-process test is gone; the child test keeps the live-holder refusal and the retry accounting.
- [x] Close the completion review's gaps (2026-10-31, `docs/reviews/08-eval/D08-T03-s8.md`): a child that cannot start is reported at once, not as a marker timeout (`untilFile`); output is read on `close`, after the streams end, so a long report is never cut short; the deadline's timer is cleared on every path (`finished`); and a fresh `answer` child answers all 20 images. Done when: "the child-process harness" tests cover each (a missing binary rejects with ENOENT in under 5 s, a 1 MB output parses, the 30 s deadline timer is cleared, 20 answered). Done 2026-10-31; the spawn-error and timer fixes each fail their test when undone; `close` over `exit` has no deterministic mutation (a cut-short read is timing-dependent), the 1 MB test covers it.
- [x] Commit: `test: digits runner killed in a child process`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-frontier-digits.test.ts` passes (the whole file, the child test included), and fails when the lock's dead-holder reclaim is removed (the second child is refused) or a pending image is resent (18 requests).

> **Verified:** 2026-10-31 | §8 | f4a2f2670ea53d38a511d1ec3ba0d8aede809d0c
> **Review:** `docs/reviews/d08-t03-s8.json`

## 9. Frontier images out of the eval sets folder

> **Started:** 2026-10-31T11:30Z

The edited-digits experiment (§1) keeps its 20 images, manifest and results under `eval/sets/frontier/digits/`, but `eval/sets/` is the evaluation's own folder: `loadSets` (D08 T01 §1, `eval/load.ts`) reads every folder in it as a labelled set and refuses the whole load when one has no `labels.json`, by design (a set never silently shrinks the population). So the first real set D08 T01 §2 adds would make every evaluation load refuse. Found 2026-10-31 while validating D08 T01 §2; the owning fix is where §1 keeps its data, not the loader.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Move the experiment's set to `eval/frontier/sets/digits/` and point everything at it. Done when: nothing under `eval/sets/` is the experiment's, and `score --check` passes against the moved set.

- [x] Move `eval/sets/frontier/digits/` to `eval/frontier/sets/digits/` with `git mv` (images, `manifest.json`, `results.json` byte for byte). Done when: the files' hashes equal the manifest's at the new path and `eval/sets/frontier/` is gone. Done 2026-10-31: `git mv`, 22 files renamed unchanged; `eval/sets/` left empty and removed.
- [x] Point `SET_DIR` and `scoreDigits`'s default `set` in `eval/frontier/digits.ts` at the new folder. Done when: `node eval/frontier/digits.ts score` reads the moved results and the fingerprint is unchanged (`e76784b4...`). Done 2026-10-31: fingerprint unchanged (`e76784b4...`).
- [x] Update the paths in `eval/DATASETS.md` and in the log entry's Inputs line in `docs/frontier-log.md` (generated by `scoreLines` from the set's path). Done when: `node eval/frontier/digits.ts score --check docs/frontier-log.md` passes. Done 2026-10-31.
- [x] Update the entry's Set line, which names the results file (`.../results.json`), and make `checkLog` require that every repository path the entry names in backticks exists. **Corrected 2026-10-31** (plan review, P2): the check read only the generated lines, so a moved results file left the entry pointing at nothing while it passed. Done when: the entry names `eval/frontier/sets/digits/results.json`, and the test finds an entry naming a missing path refused. Done 2026-10-31: `checkLog` takes `exists` and refuses an entry naming a missing `eval/`, `docs/`, `src/`, `scripts/`, `test/` or `todo/` path in backticks.
- [x] Add a test that no folder under `eval/sets/` lacks a `labels.json` in `test/node/eval-frontier-digits.test.ts`. Done when: it fails with the frontier set back under `eval/sets/`. Done 2026-10-31: fails with an unlabelled `eval/sets/frontier/` back.
- [x] Commit: `frontier: experiment images out of the eval sets folder`

**Test checkpoint:** `taskset -c 0,1 pnpm exec vitest run test/node/eval-frontier-digits.test.ts` passes, and fails when an unlabelled folder sits under `eval/sets/`; `node eval/frontier/digits.ts score --check docs/frontier-log.md` exits 0.

> **Verified:** 2026-10-31 | §9 | f7218cdfbd14aa1e1022c8ccb313bc5a209f3145
> **Review:** `docs/reviews/d08-t03-s9.json`

## Verification

- Six dated log entries with numbers and decisions; adopted ideas are filed as sections.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
