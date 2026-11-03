---
schema_version: 1
id: demo-organisations
domain: 07-app
status: active
title: "TODO-07 -- Demo Businesses and the Judge Demo Organisation"
track: day-6
---

# TODO-07 -- Demo Businesses and the Judge Demo Organisation

> **Goal:** The fictional demo businesses (Fynbos Freight and the invoice suppliers) exist as protected identities whose contacts are Rizonetech aliases, and a judge demo organisation holds ready sample cases (phishing walkthrough, invoice bank change, impersonation, safe mail, voice note) with an invite code for the submission, so judges can see the product working without real mail.

> **Current state:** Measured 2026-10-26 20:00 SAST. Aliases come from D01 T02 §4; identities from D05 T01; invite codes from D07 T02 §4.

## Inputs

- Design spec 2a (demo case), 5 (demo script), 11 (Signup: judge demo organisation; Outbound: demo contacts are aliases; Fixtures: fictional brands).

## Outcome

- Signing in with the judge code shows a populated organisation whose cases were produced by the real pipeline on synthetic inputs.

**Adjacency:** all=not-applicable (seed data for demonstration; every surface it uses is governed by its own file)

**Adjacency rationale:** This file creates fictional organisations and cases through the real code paths.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Fictional demo businesses | D05 T01 §2, D01 T02 §4 | [x] |
| 2 | §2 | Judge demo organisation | §1, D04 T01 §4 | [ ] |
| 3 | §3 | Production demo seed | §1 | [ ] |

## 1. Fictional demo businesses

> **Started:** 2026-10-31T20:44Z

Fynbos Freight (the impersonated supplier), its courier, and three invoice suppliers are seeded as organisations flagged `demo`, with verified domains under `demo.isitlegit.co.za`, registered logos (fictional) and bank accounts at the fictional Protea Bank, and contacts that are the demo aliases.

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Corrected 2026-10-31 (site lane, at start):** the section had two build items. Decomposed after reading the code and the operator's standing rules: (1) **Fynbos Freight already exists** as a live organisation (id `ZF5SufztotybeXIWVncExFAVu9GYZ8Fu`, owner `demo@rizonetech.com`), protected with `derick@rizonetech.com` (`src/auth/protected.ts`); the seed finds it by that id, fills in only what is absent (verified domain `fynbosfreight.demo.isitlegit.co.za`, accounts address, identity, logo A1, the Protea Bank account), and never replaces, resets or deletes anything it finds, with a test. (2) The courier and the three invoice suppliers are not defined anywhere: their facts go in `data/demo/businesses.json` (fictional names, registration numbers in 2099, postcode 0000, domains under `demo.isitlegit.co.za`, accounts at the fictional Protea Bank), and their logos are plain SVG monograms. (3) An organisation is made by Better Auth's `createOrganization` for a user; a demo owner is the user whose address is the business's accounts alias, made as the allowlist admits demo aliases (`src/auth/auth.ts`). (4) A verified domain and address are written to `org_domains` and `org_addresses` as `method: 'dns'`/verified, because the demo suffix cannot be proven by a member's TXT record; this is the one place the seed does not use the member path, and it applies only to names under `demo.isitlegit.co.za`. (5) **Plan review corrections (docs/reviews/07-app/D07-T07-s1.md, 2026-10-31):** the `demo` flag is the organisation's Better Auth `metadata` (`{"demo":true}`, the `organization.metadata` column), written at creation and read back by `--check` and a test, apart from identity protection; the seed is resumable (an organisation is found by its slug `demo-<slug>` and its owner by address, so a rerun after an interruption completes the missing parts and duplicates nothing), and a failure names the business and the unfinished step; `--check` is read-only, reads persisted records only (organisation and owner, verified domain and address, identity with `protected`, the logo object in R2, the account) and exits 1 naming each missing or conflicting part, a conflicting Fynbos identity included (left as found, the operator decides); a local rehearsal starts with `--local-bootstrap`, which creates the Fynbos Freight organisation at its fixed id and its owner in the local database only and refuses `--remote`, and `--remote` with the organisation missing exits 1 and writes nothing; whether mail to the business subdomain addresses is admitted is the mail lane's recipient policy (`src/mail/allowlist.ts` admits demo aliases only at `isitlegit.co.za` and `demo.isitlegit.co.za`), asked of the coordinator as a prerequisite of the hero case's closed-loop verification, and this section proves the seeded records, not delivery (coordinator, 2026-10-31 22:50 SAST: `brand.json` stays, the finance contact sits on Fynbos Freight's own verified domain, and delivery to the subdomain is the coordinator's to route; this section does not wait on it). (6) The coordinator approved the build on 2026-10-31 22:08 SAST; the production run (`--remote`) is the coordinator's, from gated `main`, after this section merges, and this lane never runs it.

**Build order:**

1. Define the businesses as data. Done when: a test reads five businesses (Fynbos Freight from `brand.json`, four from `businesses.json`), each fictional by the README's rules.
2. Seed them through the same functions members use, idempotently, never touching a protected account or organisation. Done when: a Worker test seeds twice and the second run changes nothing, and a protected target is refused by id.
3. Run it by script against the real bindings, with `--check` read-only. Done when: `--check` prints each business with `protected: true` and exits 0 against a local database.

- [x] Write `data/demo/businesses.json` (courier and three suppliers: legal name, trade, registration number, address, domain, accounts and finance alias, Protea Bank account and branch code) and four plain SVG monogram logos in `data/demo/businesses/logo/`. Done when: `test/node/seed-demo.test.ts` reads every field, every domain ends `.demo.isitlegit.co.za`, every account number is in the `0000` range at branch `000000` and no name matches a list of real South African banks and well-known suppliers.
- [x] Write `src/demo/seed.ts` with `seedDemo(env, businesses, now)`: for each business find or create its organisation (Fynbos Freight by its fixed id, never created), write its verified domain and address, set its identity protected with `setIdentity`, store its logo with `storeLogo`, add its account with `addAccount` when none holds that number, and return what each step did (`created`, `present`). Done when: a Worker test (`test/demo/seed.test.ts`) reads every row after one run, and a second run reports `present` throughout and changes no row (a before and after dump of the demo tables is equal).
- [x] Refuse protected targets by id: `seedDemo` throws `PROTECTED_TARGET` when any business in the data file resolves to a protected organisation other than Fynbos Freight, or names a protected account as an owner of a new organisation, and for Fynbos Freight it only adds, never replaces (an identity or logo already set is left as it is). Done when: tests seed a database where the protected organisation already holds a different identity, logo and account and read all three unchanged, and read the refusal for a data file that reuses `ZF5SufztotybeXIWVncExFAVu9GYZ8Fu` or `derick@rizonetech.com` for another business; each fails when the guard is removed.
- [x] Make the seed resumable and strict: an organisation found by slug `demo-<slug>`, an owner by address, every step independent, a failure naming the business and step, the `demo` flag in `organization.metadata`. Done when: tests inject a failure after the organisation, after the logo and after the account, rerun, and read one organisation, one membership and one account per business and the flag `{"demo":true}` read back, with the protected organisation unchanged; each fails when the lookup is replaced by an unconditional insert.
- [x] Write `scripts/seed-demo.ts`: `--check` (read-only from persisted records, prints each business with `protected: true` and its parts, exits 1 naming each missing or conflicting part, and writes nothing), `--local-bootstrap` (a local database only, creating the Fynbos Freight organisation at its fixed id for rehearsal, refused with `--remote`), the default (a local database, for rehearsal) and `--remote` (the production bindings through Wrangler's remote bindings, the bank keys read from `BANK_KEY` and `BANK_MATCH_KEY` in the environment, never argv, and refusing to start without them). Done when: a node test runs the documented sequence from an empty local directory (`--local-bootstrap`, default, `--check`) and reads exit 0 and the output; `--check` exits 1 for a missing logo object, a missing account, a missing flag, a conflicting Fynbos identity and a database failure, and leaves every table unchanged; `--remote` without the keys, or with the Fynbos organisation absent, exits 1 and writes nothing.
- [x] Add the live-check rows to `docs/live-checks.md` for the coordinator's production run (the command, the vault item that supplies the keys, the expected `--check` output, and "never run by the site lane"). Done when: the rows exist and the live-checks test accepts them.
- [x] Run `python3 scripts/check-publication.py` and the real-names test. Done when: both are clean.
- [x] Commit: `demo: fictional demo businesses as protected identities`

**Test checkpoint:** `node scripts/seed-demo.ts --check` (against a local database made by `--local-bootstrap` and a seed run; tsx is not a dependency) prints each demo identity with `protected: true` and exits 0, and `pnpm exec vitest run --project worker test/demo/seed.test.ts` and `pnpm exec vitest run --project node test/node/seed-demo.test.ts` pass and fail when the protected-target guard or the idempotency is removed.

> **Verified:** 2026-10-31 | §1 | feccc92bcb9671694a80beb21492d5a02eaf2f18
> **Review:** `docs/reviews/d07-t07-s1.json`

## 2. Judge demo organisation

> **Started:** 2026-11-02T17:51Z

A judge organisation whose cases are produced by sending synthetic fixtures through the live pipeline (not inserted rows), and an invite code labelled for judges recorded for the submission (code itself stored in the vault, not the repository).

**Phase:** 6
**Needs:** meta-api, live-mail
**Surface:** no

**Corrected 2026-11-02 (site lane, at start):** the invite code is ONE code labelled `meta-hackathon-2026` (not `judges`), 50 uses (coordinator decisions 2026-11-02 02:16 and 02:18, superseding 02:14's five-code scheme and 02:17's label); the code value is still stored in the vault only. Judges never see the label.

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** (1) The test checkpoint below cannot run: `tsx` is not a dependency (this file's §1 checkpoint says so) and `--check-judges` does not exist in `scripts/seed-demo.ts` (it parses only `check`, `remote`, `local-bootstrap`, `state-dir` at line 59); the build needs a new item: add `--check-judges` to `scripts/seed-demo.ts` with the `node` runner and stub tests, printing the five judge cases. (2) The Outcome (line 22, signing in with the judge code shows a populated organisation) contradicts the shipped invite path: `src/auth/signup.ts:128` creates a fresh organisation per redemption (slug `org-<redemption.id>`), so each judge lands in an empty organisation, not the populated one; this section cannot ship as written until the coordinator decides the mechanism (a signup change owned by D07 T02, or a reworded outcome), recorded here before `Started:`. (3) The five fixtures are named by type only and no fixture files exist (`data/demo/` holds businesses and brand data only); the build needs an item designating each fixture file (nearest candidates: `eval/sets/synthetic-sa/*.eml`, `test/fixtures/audio/director-urgent-payment.ogg`). (4) The invite code's expiry is unstated; `scripts/invite-code.ts` defaults to 14 days, which can lapse before judging, so the creation item must name an expiry past the judging window. (5) The live steps (vault item, `--remote` code creation, sends to `check@`, uploads) are coordinator or operator run, as §1's production run is; they are not marked so here, and `docs/live-checks.md` has no judge rows yet for item 3.

**Corrected 2026-11-02 (coordinator decisions 2026-11-02T17:50:58Z and 18:31:03Z, site lane):** the judge access mechanism is settled. Signup creating a fresh organisation per judge stands (`src/auth/signup.ts:128` unchanged); the judge invite code (label `meta-hackathon-2026`) marks the new organisation as a judge demo organisation, and the demo pack (the Fynbos Freight fixtures and the five cases) is seeded into that judge's own fresh organisation at signup, so the judge opens the five reports from their own organisation's case list like any member. No shared organisation, no cross-org link, and registered bank details stay match-or-no-match. This lane builds the marking and the pack through the seed-demo path (`src/demo/judges.ts`); the org-create hook itself sits in `src/auth/signup.ts` (the app lane's D07 T02 area), named to the coordinator for routing, as the decision allows.

**Corrected 2026-11-02 (coordinator decision 2026-11-02T17:08:12Z, site lane):** the section splits in two. The local half builds now from this lane: the five fixtures as synthetic files in the tree, `--check-judges` in the seed-demo path with stub tests, and this plan correction. The live half (creating the judge organisation and invite code on production, the five fixture sends, vaulting the code) runs from a session with the mail connectors and an admin session at submission validation time (the D09 T02 §10 path), owned by the coordinator or operator, not by this lane. This section stamps when both halves are proven, the live half by its recorded run. The checkpoint's `pnpm exec tsx` was wrong: `tsx` is not a dependency (§1); the runner is `node`, as every other seed-demo invocation. Two facts the live half must settle, recorded here so they are not discovered live: the invite code needs an expiry past the judging window (`scripts/invite-code.ts` defaults to 14 days), and invite signup creates a fresh organisation per redemption (`src/auth/signup.ts:128`), so how a judge signing up with the code sees the five cases (membership of the judge organisation, or a reworded Outcome) is the coordinator's decision at the live run.

**Build order:**

1. Build the local half: fixtures and the read-only judge check. Done when: the stub tests pass and `--check-judges` against a stubbed database prints each expected case or names the missing one.
2. Run the demo fixtures through production (live half, coordinator or operator). Done when: the judge organisation shows the five sample cases with complete reports.

- [x] Create the five demo fixtures as synthetic files under `data/demo/judge/` with a manifest (`fixtures.json`: name, file, sender, subject for mail or upload name for the voice note, expected verdict, and the scenario prerequisite each case needs, such as the controlled phishing page, the invoice comparison baseline and the protected impersonated identity): walkthrough phishing, tampered invoice, Fynbos impersonation, genuine supplier mail, director voice note. Done when: a test reads the manifest, every file exists, is synthetic (`.example` addresses, `X-IsItLegit-Synthetic: true` on mail), the voice note is intelligible audio, and no real name or address appears. (Live setup of any prerequisite is the coordinator's, at the live run.)
- [x] Add `checkJudges` to `src/demo/judges.ts`: given the judge organisation id, read only that organisation's cases and match each manifest case by its subject (mail) or upload name (voice note, `cases.upload_name`), returning per case its id, status and problems (missing, not `done`, verdict other than the manifest's expected verdict). Done when: `test/demo/judges.test.ts` passes on a stubbed database with five `done` cases (an audio-upload-shaped record among them) and fails naming the case on a missing, running, wrong-verdict or another organisation's case.
- [x] Wire `--check-judges --org <id>` into `scripts/seed-demo.ts` (read-only, like `--check`; refuses without `--org`; exits 1 when any case has a problem or the database cannot be read). Done when: the node test in `test/node/seed-demo.test.ts` covers the argument refusal, the nonzero exits and the printed lines.
- [x] Before any live creation, the coordinator settles how a judge who redeems the code opens the five reports (invite signup creates a fresh organisation per redemption, `src/auth/signup.ts:128`): the mechanism is recorded here with its owning lane, and any implementation is that lane's before the live run. Done when: the decision and owner are recorded in this section. (Settled 2026-11-02T17:50:58Z and 18:31:03Z above: fresh org per judge, code marks it, pack seeded into it at signup.)
- [x] Add the judge marking to `src/demo/judges.ts`: `JUDGE_CODE_LABEL` (`meta-hackathon-2026`) and `markJudgeOrg(db, orgId)`, which merges `{"judgeDemo": true}` into the organisation's `metadata` without dropping keys already there, and reports a missing organisation. Done when: `test/demo/judges.test.ts` reads the flag back on a marked organisation, keeps an existing `demo` flag beside it, and names a missing one.
- [x] Wire the marking and the pack at signup: when a redemption's code label is `JUDGE_CODE_LABEL`, the fresh organisation is marked and the five fixtures are submitted for it through the real pipeline (the org-create hook in `src/auth/signup.ts`, the app lane's file, routed through the coordinator). Done when: a Worker test redeems a judge-labelled code and reads the marked organisation with its five cases started, and an ordinary code's organisation unmarked with none. (Hook: app lane, through the coordinator; the marking and pack are this lane's.)
- [x] Create the judge organisation and one invite code labelled `meta-hackathon-2026` with 50 uses, storing the code in the vault as "IsItLegit judge invite code"; the coordinator records the judging window and the chosen expiry (past that window) before creation, then reads back the production organisation and the invite's label, maximum uses, expiry and revocation state without exposing the code. Done when: the vault item and the read-back are recorded. (Live half: coordinator or operator.)
- [x] Send the five demo fixtures (walkthrough phishing, tampered invoice, Fynbos impersonation, genuine supplier mail, director voice note) through `check@` and upload as the judge organisation's test address. Done when: five `done` cases exist with reports. (Live half: coordinator or operator.)
- [x] Record the live proof in `docs/live-checks.md`: dated, with the fixture-to-case mapping, the deployed commit, the `--check-judges --remote` output, and a newly redeemed judge account opening all five reports through the settled access path. Done when: the entries carry that evidence, not only ids and links. (Live half: coordinator or operator.)
- [x] Commit: `demo: judge organisation with live sample cases`

**Test checkpoint:** `node scripts/seed-demo.ts --check-judges --remote --org <judge organisation id>` prints five cases with status `done` and exits 0 (local half proven on stubbed tests; live half proven by the coordinator's recorded run).

## 3. Production demo seed

The coordinator runs the production seed from gated `main` after §1 merges and records its read-back. Filed 2026-10-31 by D07 T07 §1's completion review (gap 7); the site lane never runs `--remote`.

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** this already ran: the production seed ran 2026-10-31 23:55 SAST from gated main `46b47906` and the passing read-back (`--remote --check` exits 0, five businesses `protected: true`) is recorded at `docs/live-checks.md:273` under D07 T06 §20, not cross-referenced here. What remains is formal closure only (the dated output filed under this section and the stamp), not a production rerun.

**Phase:** 7
**Needs:** cloudflare, operator
**Surface:** no

**Build order:**

1. Run the seed against production and read it back. Done when: `--remote --check` exits 0 with each business `protected: true`.

- [ ] Run the steps of `docs/live-checks.md` "Fictional demo businesses" (check, seed, rerun, check) with the bank keys from the vault item "IsItLegit bank key" and record the outputs there. Done when: the rows carry the dated outputs, the rerun changed nothing and the final check exits 0.
- [ ] Commit: `demo: record the production demo seed`

**Test checkpoint:** `BANK_KEY=... BANK_MATCH_KEY=... node scripts/seed-demo.ts --remote --check` exits 0 and prints five businesses with `protected: true`.

## Verification

- Judges can sign in with their code and open five real reports on synthetic inputs.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
