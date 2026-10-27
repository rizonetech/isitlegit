---
schema_version: 1
id: auth-and-tenancy
domain: 07-app
status: active
title: "TODO-02 -- Sign-in, Organisations, Invite Codes and Domain Verification"
track: day-1
---

# TODO-02 -- Sign-in, Organisations, Invite Codes and Domain Verification

> **Goal:** Members sign in with an email magic link or a passkey (Better Auth on D1); each client company is an organisation with owner, admin and member roles and invites; signup during the event needs an invite code and each organisation has a daily case cap; an organisation proves it owns an email domain (DNS TXT or an emailed code) before mail from that domain is accepted at `check@`; sign-in routes are rate-limited.

> **Current state:** Measured 2026-10-26 20:00 SAST. No auth code exists. The operator decided invite-code signup with daily caps and a judge demo organisation (design spec section 11).

## Inputs

- Design spec 4.8 (tenancy, domain verification, roles), 11 (Signup decision); stack doc "Client accounts and sign-in" (Better Auth 1.7.13 with D1, magic link, passkeys, organisation plugin).
- Better Auth docs for the D1 adapter, magic link, passkey and organisation plugins (cite the page used in each section's commit).
- -> XREF: D01 T01 §3 -- the email handler that admits mail only through `findMemberBySender`
- -> XREF: D01 T03 §1 -- the upload API that requires a session and the daily cap
- -> XREF: D07 T01 §3 -- the app shell, whose organisation switcher and Sign out post to the routes §1 and §3 here build

## Outcome

- A new user with a valid invite code signs up, gets an organisation, verifies a domain, and mail from that domain is then accepted; without a code signup is refused.
- An organisation over its daily case cap gets a refusal on upload and a polite capped reply on forward.
- Repeated sign-in attempts from one address or IP are slowed and then refused.

**Adjacency:** list=applicable @ D07 T04 §3; document=not-applicable (accounts produce no carried document); settings=applicable @ D07 T04 §4; reporting=applicable @ D07 T05 §2; notifications=applicable @ D07 T02 §1; permissions=applicable @ D07 T02 §3; audit=applicable @ D07 T02 §6; exchange=not-applicable (no member import or export during the event); reverse=applicable @ D07 T02 §3

**Adjacency rationale:** Team and domain lists live in the member console (D07 T04), and the admin console reports onboarding (D07 T05). Sign-in links are the notification; roles are the permission model; invite revocation and member removal (§3) are the reverse paths; sign-in attempts and verification events are the audit trail (§6).

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Better Auth on D1 with email magic link | D01 T01 §1, D01 T02 §1 | [ ] |
| 2 | §2 | Passkey sign-in | §1 | [ ] |
| 3 | §3 | Organisations, roles, invites and removal | §1 | [ ] |
| 4 | §4 | Invite-code signup and daily case caps | §3 | [ ] |
| 5 | §5 | Domain verification and sender lookup | §3, D01 T02 §1 | [ ] |
| 6 | §6 | Sign-in rate limits and auth audit trail | §1 | [ ] |
| 7 | §7 | Sign-in, signup, invite and domain verification pages | §5, D07 T01 §10 | [ ] |
| 8 | §8 | Plans, trial and feature flags | §4 | [ ] |

## 1. Better Auth on D1 with email magic link

Better Auth 1.7.13 owns users and sessions in D1 (stack doc). The magic-link email goes through the SMTP2GO client (D01 T02 §1); the recipient allowlist (D01 T02 §2) is built on top of these tables right after and then admits invitees and members for `signin` mail.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Configure Better Auth in `src/auth/auth.ts` with the D1 adapter and generate its migration. Done when: `pnpm db:migrate:local` creates the Better Auth tables.
2. Send magic links through `sendMail`. Done when: a test requests a link and finds one `signin` send.

- [ ] Add exact dependency `better-auth` 1.7.13. Done when: `pnpm install` resolves it and `pnpm typecheck` passes with TypeScript 7.0.2 (or the fallback recorded per D00 T01 §2).
- [ ] Configure `betterAuth` in `src/auth/auth.ts` with the D1 database, `BETTER_AUTH_SECRET` (Worker secret, vault item "IsItLegit Better Auth secret"), base URL `https://app.isitlegit.co.za`, and secure cookies. Done when: `test/auth/auth.test.ts` creates a session in the workers pool.
- [ ] Generate the Better Auth schema into `src/db/migrations/0003_auth.sql` with its CLI and review it. Done when: the migration applies locally.
- [ ] Enable the magic-link plugin with `sendMagicLink` calling `sendMail({ kind: "signin" })`, link expiry 15 minutes. Done when: a test sees the send and an expired link is refused. Cheaper substitute: a password field.
- [ ] Mount the auth handler at `/api/auth/*` in the Hono app. Done when: `GET /api/auth/ok` (Better Auth health) returns 200.
- [ ] Commit: `auth: Better Auth on D1 with email magic links`

**Test checkpoint:** `pnpm exec vitest run test/auth/auth.test.ts` passes and fails if an expired magic link signs in.

## 2. Passkey sign-in

Passkeys give members a phishing-resistant second way in, fitting for a phishing product (stack doc). A member adds a passkey after the first magic-link sign-in.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Enable the passkey plugin with the right relying party. Done when: registration and authentication options are served for `app.isitlegit.co.za`.

- [ ] Enable the Better Auth passkey plugin with `rpID: "app.isitlegit.co.za"` and `rpName: "IsItLegit"`. Done when: `test/auth/passkey.test.ts` gets registration options for a signed-in user.
- [ ] Refuse passkey registration without an active session. Done when: an anonymous request gets 401.
- [ ] Commit: `auth: passkey sign-in`

**Test checkpoint:** `pnpm exec vitest run test/auth/passkey.test.ts` passes.

## 3. Organisations, roles, invites and removal

One organisation per client company, roles owner, admin and member (spec 4.8). Invites go by email through the allowlist; owners and admins can revoke an invite and remove a member, which ends that member's sessions.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Enable the organisation plugin. Done when: a user creates an organisation and is its owner.
2. Add invites, revocation and removal with role checks. Done when: tests prove a member cannot invite and a removed member loses access.

- [ ] Enable the Better Auth organisation plugin with roles `owner`, `admin`, `member`. Done when: `test/auth/org.test.ts` creates an organisation with the creator as owner.
- [ ] Send invites with `sendMail({ kind: "signin" })`, expiring after 48 hours (the Better Auth organisation plugin default; **Corrected 2026-10-26:** no expiry was set), and accept them through the magic link. Done when: an invitee joins as `member` and a 49-hour-old invite is refused.
- [ ] Allow invite and removal for owners and admins only. Done when: a member's attempt gets 403.
- [ ] Revoke an invite and remove a member, deleting the member's sessions for that organisation. Done when: the removed member's next request to an organisation route gets 403.
- [ ] Write `requireOrg(c)` middleware putting the active organisation id on the context for every app route. Done when: every later route test can use it, and a request for another organisation's case gets 404. Cheaper substitute: reading the organisation id from a query parameter.
- [ ] Commit: `auth: organisations, roles, invites and removal`

**Test checkpoint:** `pnpm exec vitest run test/auth/org.test.ts` passes and fails if `requireOrg` trusts a query parameter.

## 4. Invite-code signup and daily case caps

During the event signup needs an invite code, and each organisation has a daily case cap so strangers cannot spend the Meta credit (design spec section 11). Codes are single-use or limited-use, created by the operator from the admin console or a script.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Add `invite_codes` and enforce them at signup. Done when: signup without a valid code is refused.
2. Enforce the daily cap. Done when: the cap refuses the next case and resets at midnight SAST.

- [ ] Add migration `0004_invites.sql` with `invite_codes` (`code_hash`, `label`, `max_uses`, `uses`, `expires_at`, `created_at`) and `org_limits` (`org_id`, `daily_cases`, default 50). Done when: it applies locally.
- [ ] Write `scripts/invite-code.ts` creating a code (printed once, stored hashed) with a label and use limit. Done when: running it adds a row and prints a code. Cheaper substitute: a shared static code in config.
- [ ] Refuse the Better Auth sign-up hook unless a valid unexpired code with uses left is supplied, and increment `uses` atomically. Done when: `test/auth/invite.test.ts` covers valid, used-up, expired and missing codes.
- [ ] Write `checkDailyCap(orgId)` counting the organisation's cases since 00:00 SAST. Done when: the 51st case of the day is refused in a test and the count resets after midnight.
- [ ] Make the email path reply once per day "daily limit reached" to a capped member instead of analysing. Done when: a capped forward creates no case and sends one notice.
- [ ] Commit: `auth: invite-code signup and daily case caps`

**Test checkpoint:** `pnpm exec vitest run test/auth/invite.test.ts` passes and fails if a used-up code is accepted.

## 5. Domain verification and sender lookup

Mail is accepted at `check@` only from domains an organisation has proven it owns (spec 4.1, 4.8): a DNS TXT record, or a code sent to `admin@` or `postmaster@` the domain. Individual sending addresses can also be registered (for a member using a free mailbox) after a code to that address.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Add `org_domains` and `org_addresses` with verification state. Done when: the migration applies and a pending domain is not admitted.
2. Verify by DNS TXT over DNS-over-HTTPS and by emailed code. Done when: both paths flip the state to verified in tests.
3. Write `findMemberBySender`. Done when: the email handler test admits a verified domain and refuses everything else.

- [ ] Add migration `0005_domains.sql` with `org_domains` (`org_id`, `domain` registrable form via `tldts` 7.4.19, `token`, `state` pending or verified, `method`, `verified_at`) and `org_addresses` (`org_id`, `address`, `state`, `verified_at`), unique per domain across organisations. Done when: a second organisation claiming a verified domain is refused.
- [ ] Verify DNS by querying `https://cloudflare-dns.com/dns-query?name=_isitlegit.<domain>&type=TXT` for `isitlegit-verify=<token>`. Done when: `test/auth/domains.test.ts` with a stubbed DoH response verifies and a wrong token does not.
- [ ] Verify by emailed code to `admin@` or `postmaster@` the domain (allowed by the allowlist for `verify` kind only to these two local parts of a domain being claimed). Done when: entering the code verifies; the code expires after 30 minutes (**Corrected 2026-10-26:** no expiry was set); a wrong code three times locks for an hour.
- [ ] Verify a single sending address outside any verified domain (`org_addresses`, `design/SPEC.md` M8) by a 6-digit code emailed to that address, expiring after 30 minutes, with the same three-try lock. Done when: `test/auth/domains.test.ts` verifies an address by code and refuses an expired one. (**Corrected 2026-10-26:** M8 lists sending addresses but no item verified one.)
- [ ] Write `findMemberBySender(address)` returning the organisation for a verified address, else for a verified registrable domain of the address, else null. Done when: tests cover subdomain senders (`mail.example.co.za` maps to `example.co.za`) and an unverified domain returning null.
- [ ] Record each verification attempt and result in `auth_events` (from §6). Done when: the test finds the rows.
- [ ] Commit: `auth: domain verification and member sender lookup`

**Test checkpoint:** `pnpm exec vitest run test/auth/domains.test.ts test/intake/email.test.ts` passes and fails if a pending domain is admitted.

## 6. Sign-in rate limits and auth audit trail

Sign-in routes are rate-limited per address and per IP (stack doc), and every sign-in, failure, invite, removal and verification is recorded for the admin console and incident review.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Add `auth_events` and rate limiting. Done when: the sixth magic-link request in ten minutes for one address is refused.

- [ ] Add migration `0006_auth_events.sql` with `auth_events` (`at`, `kind`, `org_id`, `user_id`, `ip_hash`, `detail_json` without secrets). Done when: it applies locally.
- [ ] Rate-limit magic-link and verification-code requests to 5 per address and 20 per IP per 10 minutes with KV counters. Done when: `test/auth/ratelimit.test.ts` sees the sixth request refused with 429.
- [ ] Write an `auth_events` row for sign-in, failure, invite, removal, verification and rate-limit refusal. Done when: the test finds one row per kind.
- [ ] Commit: `auth: sign-in rate limits and the audit trail`

**Test checkpoint:** `pnpm exec vitest run test/auth/ratelimit.test.ts` passes and fails if the per-address limit is removed.

## 7. Sign-in, signup, invite and domain verification pages

The pages members see before and around sign-in, built on the shell and components (D07 T01 §3) against `design/SPEC.md`.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` sign-in, signup and domain verification sections
**Job:** a business owner gets in, creates the organisation and proves their domain in a few minutes
**Treatment:** one task per page, plain words, every error says what to do next
**Chrome:** `AppShell`, `Field`, `Button`, `ErrorState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the sign-in and signup pages. Done when: a rendered-page test signs up with a code and signs in with a magic link.
2. Build invite acceptance and domain verification pages. Done when: a test verifies a domain by DNS and by code through the pages.

- [ ] Build `src/web/pages/signin.tsx` (email field, magic-link button, passkey button, "check your inbox" state). Done when: the page test finds each control by accessible name. Cheaper substitute: Better Auth's default unstyled form.
- [ ] Build `src/web/pages/signup.tsx` (invite code, email, organisation name, POPIA notice and consent checkbox). Done when: submitting without consent shows the field error and stores nothing.
- [ ] Build `src/web/pages/invite.tsx` for accepting an invite. Done when: an invitee lands in the organisation.
- [ ] Build `src/web/pages/domains.tsx` with the TXT record to copy, a "check now" button, the emailed-code option, and pending, verified and failed states. Done when: each state renders in the test.
- [ ] Commit: `web: sign-in, signup, invite and domain verification pages`

**Test checkpoint:** `pnpm exec vitest run test/web/auth-pages.test.ts` passes and fails if signup proceeds without the POPIA consent.

## 8. Plans, trial and feature flags

Features carry a plan flag checked in code (spec 2b): free check (counterparty verdicts), Protect (identity, alerts, invoice bank-change detection, closed-loop verification, impersonation monitor, payment document check) and MSP. During the event there is no billing and every new organisation gets a 14-day trial that unlocks everything, so the demo shows all of it.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Add the plan to organisations and a `requireFeature` check. Done when: a trial organisation passes every feature check and an expired free one fails the Protect checks.

- [ ] Add migration `0017_plans.sql` adding `plan` (free, trial, protect, msp) and `trial_ends_at` to `org_limits`, set to `trial` and 14 days at signup. Done when: a new organisation reads back as trial with the right end date.
- [ ] Write `FEATURES` (feature to plans map) and `requireFeature(orgId, feature)` in `src/auth/plans.ts`, treating an expired trial as free. Done when: `test/auth/plans.test.ts` covers trial, expired trial, protect and free.
- [ ] Call `requireFeature` in the identity page (D05 T01 §3), the monitor (D05 T04 §2), the payment document path (D06 T02 §3) and closed-loop verification (D05 T03 §1), each of which lists it in its own checklist. Done when: a grep test finds a `requireFeature` call for each Protect feature.
- [ ] Commit: `auth: plans, trial and feature flags`

**Test checkpoint:** `pnpm exec vitest run test/auth/plans.test.ts` passes and fails if an expired trial keeps Protect features.

## Verification

- An invited user signs up, verifies a domain and gets mail from it accepted; uninvited signup, a foreign case and over-limit use are refused.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
