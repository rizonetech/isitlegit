---
schema_version: 1
id: admin-console
domain: 07-app
status: active
title: "TODO-05 -- Rizonetech Admin Console Behind Cloudflare Access"
track: day-6
---

# TODO-05 -- Rizonetech Admin Console Behind Cloudflare Access

> **Goal:** The operator opens `/admin` behind Cloudflare Access (only the operator's Rizonetech address), with the Worker also verifying the Access JWT, and sees every client organisation's onboarding status, volume, top threats, accuracy feedback, model spend against the caps, and invite codes.

> **Current state:** Measured 2026-10-26 20:00 SAST. No Access application exists. The operator's address is the only admitted identity (design spec section 11, Mailbox).

## Inputs

- Design spec 4.8 (MSP console behind Access), 11 (Mailbox, Budget); stack doc "Rizonetech admin console" (Access email one-time PIN; Worker verifies `Cf-Access-Jwt-Assertion`).
- Cloudflare Access docs: validating the JWT (team domain certs endpoint, `aud` tag).

## Outcome

- `/admin` without Access is refused by the Worker even if Access were misconfigured; with the operator's Access session it shows the cross-organisation view.

**Adjacency:** list=applicable @ D07 T05 §2; document=not-applicable (produces no document a user carries or files); settings=not-applicable (budget caps are code constants shown read-only); reporting=applicable @ D07 T05 §2; notifications=not-applicable (sends no notices of its own); permissions=applicable @ D07 T05 §1; audit=applicable @ D07 T02 §6; exchange=applicable @ D07 T05 §2; reverse=applicable @ D07 T05 §2

**Adjacency rationale:** Access plus JWT verification is the permission; the overview lists and reports organisations with a CSV export; invite codes can be revoked (reverse).

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Access application and JWT verification | D07 T01 §10 | [ ] |
| 2 | §2 | Overview, spend and invite codes | §1, D03 T01 §2 | [ ] |

## 1. Access application and JWT verification

An Access self-hosted application on `app.isitlegit.co.za/admin*` admits only the operator's address with email one-time PIN; the Worker verifies `Cf-Access-Jwt-Assertion` against the team's certificates and the application's `aud`, so a misconfigured Access policy still cannot expose the console.

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Create the Access application and policy. Done when: the API reads them back with only the operator's address.
2. Verify the JWT in the Worker. Done when: tests refuse a missing, expired, wrong-audience and wrong-issuer token.

- [ ] Create the Access application for `app.isitlegit.co.za/admin*` with a policy allowing only `OPERATOR_EMAIL` (standing authorisation). Done when: the API returns the app and policy.
- [ ] Store `CF_ACCESS_AUD` and the team domain as Worker secrets or vars. Done when: `wrangler secret list` names the secret.
- [ ] Write `requireAccess(c)` verifying the RS256 JWT with keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached 1 hour), checking `aud`, `iss`, `exp` and `email` equal to `OPERATOR_EMAIL`. Done when: `test/web/access.test.ts` covers the four refusals and one pass. Cheaper substitute: trusting the `Cf-Access-Authenticated-User-Email` header.
- [ ] Commit: `admin: Access application and JWT verification`

**Test checkpoint:** `pnpm exec vitest run test/web/access.test.ts` passes and fails if the email claim is not compared.

## 2. Overview, spend and invite codes

Every organisation (name, created, domains verified, members, cases this week, top threat types, feedback count), today's and total model spend against the caps from `src/meta/caps.ts`, and invite codes (create, list uses, revoke), with a CSV export of the overview.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` admin console
**Job:** the operator sees how every client is doing and what the build is spending
**Treatment:** dense but calm tables, spend as a bar against each cap
**Chrome:** `AppShell` admin variant from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build `GET /admin`. Done when: a seeded database renders every organisation and the spend bars.

- [ ] Build `src/web/pages/admin.tsx` with the organisation table and CSV export. Done when: `test/web/admin-page.test.ts` checks rows and the CSV.
- [ ] Show spend today and in total per provider against the caps and the reserve. Done when: a seeded spend renders the right percentages.
- [ ] Add invite-code management (create with label and uses, list with uses and expiry, revoke by setting its expiry to now in `invite_codes`, migration 0013, D07 T02 §4). Done when: a revoked code is refused at signup and accounts made with it are unaffected.
- [ ] Set an organisation's daily case cap (`org_limits.daily_cases`, D07 T02 §4) from the organisation table, 0 to 50 (the event maximum), read back after saving. Done when: `test/web/admin-page.test.ts` lowers a cap, reads it back, and the next `admitCase` for that organisation is refused at the new limit. Source: D07 T02 §4 completion review (Part 1 item 11).
- [ ] Commit: `admin: cross-organisation overview, spend and invite codes`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-page.test.ts` passes.

## Verification

- `/admin` is double-locked (Access and JWT) and shows organisations, spend against caps and invite codes.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
