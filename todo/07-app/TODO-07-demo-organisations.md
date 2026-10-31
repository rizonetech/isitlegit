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
| 1 | §1 | Fictional demo businesses | D05 T01 §2, D01 T02 §4 | [ ] |
| 2 | §2 | Judge demo organisation | §1, D04 T01 §4 | [ ] |

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

**Test checkpoint:** `pnpm exec tsx scripts/seed-demo.ts --check` prints each demo identity with `protected: true` and exits 0, and `pnpm exec vitest run --project worker test/demo/seed.test.ts` and `pnpm exec vitest run --project node test/node/seed-demo.test.ts` pass and fail when the protected-target guard or the idempotency is removed.

## 2. Judge demo organisation

A judge organisation whose cases are produced by sending synthetic fixtures through the live pipeline (not inserted rows), and an invite code labelled for judges recorded for the submission (code itself stored in the vault, not the repository).

**Phase:** 6
**Needs:** meta-api, live-mail
**Surface:** no

**Build order:**

1. Run the demo fixtures through production. Done when: the judge organisation shows the five sample cases with complete reports.

- [ ] Create the judge organisation and an invite code labelled `judges` with 50 uses, storing the code in the vault as "IsItLegit judge invite code". Done when: the vault item exists.
- [ ] Send the five demo fixtures (walkthrough phishing, tampered invoice, Fynbos impersonation, genuine supplier mail, director voice note) through `check@` and upload as the judge organisation's test address. Done when: five `done` cases exist with reports.
- [ ] Record the case ids and links in `docs/live-checks.md`. Done when: the entries exist.
- [ ] Commit: `demo: judge organisation with live sample cases`

**Test checkpoint:** `pnpm exec tsx scripts/seed-demo.ts --check-judges` prints five cases with status `done` and exits 0.

## Verification

- Judges can sign in with their code and open five real reports on synthetic inputs.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
