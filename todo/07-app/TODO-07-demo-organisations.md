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

Fynbos Freight (the impersonated supplier), its courier, and three invoice suppliers are seeded as organisations flagged `demo`, with verified domains under `demo.isitlegit.co.za`, registered logos (fictional) and bank accounts at the fictional Protea Bank, and contacts that are the demo aliases.

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Seed the demo businesses with a script through the normal APIs. Done when: each identity exists and reads back.

- [ ] Write `scripts/seed-demo.ts` creating the organisations, identities, logos and accounts through the same functions members use, flagged `demo`. Done when: a run against production creates them and a second run changes nothing (idempotent).
- [ ] Use only fictional names, the fictional bank and `demo.isitlegit.co.za` addresses. Done when: `python3 scripts/check-publication.py` stays clean and a test greps the seed for real bank names.
- [ ] Commit: `demo: fictional demo businesses as protected identities`

**Test checkpoint:** `pnpm exec tsx scripts/seed-demo.ts --check` prints each demo identity with `protected: true` and exits 0.

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
