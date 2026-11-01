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

> **Current state:** Measured 2026-10-26 20:00 SAST. No Access application exists. The operator's address is the only admitted identity (design spec section 11, Mailbox). **Corrected 2026-11-01:** the Access application exists and Zero Trust is live (§1); what is missing is the Worker's JWT verification and the `/admin` pages (§2).

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

> **Started:** 2026-11-01T17:55:02Z

**Corrected 2026-11-01:** the operator created the Access application and enabled Zero Trust (coordinator, 19:47 SAST). Read back the same day through the vault's Access token: the self-hosted application "IsItLegit Admin" on `app.isitlegit.co.za/admin*`, its policy "Operator only" admitting `hostmaster@rizonetech.com` and `derick@rizonetech.com` (the operator signs in as derick; hostmaster alone was refused), through the built-in Cloudflare provider (this dashboard has no separate One-time PIN method; the text above said email one-time PIN). What is left is the Worker's half below. The Worker admits the same two addresses: `OPERATOR_EMAIL` and `CF_ACCESS_EMAIL` (the operator's own sign-in address) as vars, never the header alone.

An Access self-hosted application on `app.isitlegit.co.za/admin*` admits only the operator's addresses through the built-in Cloudflare provider; the Worker verifies `Cf-Access-Jwt-Assertion` against the team's certificates and the application's `aud`, so a misconfigured Access policy still cannot expose the console.

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Create the Access application and policy. Done when: the API reads them back with only the operator's address.
2. Verify the JWT in the Worker. Done when: tests refuse a missing, expired, wrong-audience and wrong-issuer token.

- [x] Create the Access application for `app.isitlegit.co.za/admin*` with a policy allowing only the operator's addresses (standing authorisation). Done when: the API returns the app and policy. Created by the operator and read back 2026-11-01 (see the correction above).
- [ ] Store `CF_ACCESS_AUD` and the team domain as Worker vars in `wrangler.jsonc` (`CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_EMAIL` for the operator's own sign-in address; the aud and team domain are identifiers, not secrets). Done when: the vars are in `wrangler.jsonc`, `pnpm types` regenerates `worker-configuration.d.ts`, and the values match the read-back.
- [ ] Write `requireAccess(c)` in `src/auth/access.ts` verifying the RS256 JWT with keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached 1 hour), checking `aud`, `iss`, `exp` and `email` against the admitted addresses (`OPERATOR_EMAIL` and `CF_ACCESS_EMAIL`), and mount it on `/admin` and `/admin/*` in `src/index.ts` so an unverified request is refused before any admin page exists. Done when: `test/web/access.test.ts` covers the four refusals (missing, expired, wrong audience, wrong issuer) and one pass, and fails if the email claim is not compared. Cheaper substitute: trusting the `Cf-Access-Authenticated-User-Email` header.
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
- [ ] Set an organisation's daily case cap over its plan's (`org_limits.daily_cases_override` through `setDailyCapOverrideStatement` in `src/auth/plan-sql.ts`, D07 T08 §8) from the organisation table, 0 to 50 (the event maximum), read back after saving; show each cap as the plan's or as an override; and a "Use plan limit" control that clears it (`clearDailyCapOverrideStatement`). Done when: `test/web/admin-page.test.ts` lowers a cap, reads it back marked as an override, the next `admitCase` for that organisation is refused at the new limit, and Use plan limit reads back the plan's cap with admission following it. Cheaper substitute: writing `org_limits.daily_cases`, which admission no longer reads. Source: D07 T02 §4 completion review (Part 1 item 11); **Corrected 2026-10-31** by D07 T08 §8 (the cap follows the plan; this item read `org_limits.daily_cases`).
- [ ] Give the operator incident review of the auth trail (D07 T02 §6's `auth_events`), including rows with no organisation (refused sign-ins, rate limits), behind the operator's own gate and never through any organisation's owner read. Done when: the operator reads a refused sign-in and a rate-limit row, and an organisation owner's read never returns a row without its organisation. Source: D07 T02 §6 plan review.
- [ ] Commit: `admin: cross-organisation overview, spend and invite codes`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-page.test.ts` passes.

## Verification

- `/admin` is double-locked (Access and JWT) and shows organisations, spend against caps and invite codes.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
