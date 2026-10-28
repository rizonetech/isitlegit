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
| 1 | §1 | Better Auth on D1 with email magic link | D01 T01 §1, D01 T02 §1 | [x] |
| 2 | §2 | Passkey sign-in | §1 | [x] |
| 3 | §3 | Organisations, roles, invites and removal | §1 | [x] |
| 4 | §4 | Invite-code signup and daily case caps | §3 | [ ] |
| 5 | §5 | Domain verification and sender lookup | §3, D01 T02 §1 | [ ] |
| 6 | §6 | Sign-in rate limits and auth audit trail | §1 | [ ] |
| 7 | §7 | Sign-in, signup, invite and domain verification pages | §5, D07 T01 §10 | [ ] |
| 8 | §8 | Plans, trial and feature flags | §4 | [ ] |
| 9 | §9 | Account closure and coordinated purge | §1, D01 T01 §1 | [ ] |

## 1. Better Auth on D1 with email magic link

> **Started:** 2026-10-28T00:09Z

Better Auth 1.7.13 owns users and sessions in D1 (stack doc). The magic-link email goes through the SMTP2GO client (D01 T02 §1); the recipient allowlist (D01 T02 §2) is built on top of these tables right after and then admits invitees and members for `signin` mail.

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** (validation before building; then its plan review, P1 1: the sign-in page is `/signin`, design/SPEC.md A1). Migrations 0003 to 0006 are the mail tables (D01 T02), so Better Auth's is `0007_auth.sql`. `better-auth` 1.7.13 (2026-10-25, past pnpm's minimum release age) talks to D1 itself (`@better-auth/kysely-adapter`'s D1 dialect, which uses `batch()` for want of interactive transactions), so `database` takes the `DB` binding directly; and it compiles its own schema SQL (`getMigrations(options).compileMigrations()`), which a script runs against an in-memory SQLite in Node, so no separate CLI is needed and the migration is exactly what Better Auth expects. The base URL is configuration (`APP_URL` in `wrangler.jsonc`, `https://app.isitlegit.co.za`; the tests set their own), since cookies and Better Auth's origin check depend on it. `/cases` and `/signin` do not exist yet (D07 T04 §1, D07 T02 §7), so this section adds the session gate every member page uses (`requireSession`), and the sign-out test proves itself through it.

**Build order:**

1. Configure Better Auth in `src/auth/auth.ts` on the D1 binding and generate its migration from Better Auth itself. Done when: `pnpm db:migrate:local` creates the Better Auth tables and Better Auth finds nothing left to migrate.
2. Send magic links through `sendMail`. Done when: a test requests a link and finds one `signin` send.

- [x] Add exact dependency `better-auth` 1.7.13. Done when: `pnpm install` resolves it and `pnpm typecheck` passes with TypeScript 7.0.2 (or the fallback recorded per D00 T01 §2).
- [x] Configure `betterAuth` in `src/auth/auth.ts` with the `DB` binding, `BETTER_AUTH_SECRET` (Worker secret, 32 random bytes, vault item "IsItLegit Better Auth secret"; a test value in `vitest.config.ts`), base URL from `APP_URL` (`https://app.isitlegit.co.za` in `wrangler.jsonc`), and secure, HTTP-only, same-site cookies. Done when: `test/auth/auth.test.ts` creates a session in the workers pool, its cookie carries `Secure`, `HttpOnly` and `SameSite=Lax`, and a Worker without `BETTER_AUTH_SECRET` refuses to build the auth instance with a `ConfigError`. (**Corrected 2026-10-28**, as above.)
- [x] Generate the Better Auth schema into `src/db/migrations/0007_auth.sql` with `scripts/auth-schema.ts` (Better Auth's `getMigrations(options).compileMigrations()` for the same options as `src/auth/auth.ts`, against an in-memory SQLite; written to a temporary file and renamed) and review it. Done when: the migration applies locally, and `test/auth/auth.test.ts` runs `getMigrations` against the migrated D1 and finds nothing to create or add. (**Corrected 2026-10-28**: 0003 is taken, and the schema comes from Better Auth itself.)
- [x] Enable the magic-link plugin with `sendMagicLink` calling `sendMail({ kind: "signin" })` under the send key `signin:<SHA-256 of the link's token>` (stable for the link it carries, distinct for each link requested, and no secret), link expiry 15 minutes. Only `sent`, or `duplicate` with previous `sent`, is a delivered link; `failed`, `uncertain`, and `duplicate` with previous `uncertain` or `refused` answer the request with an error, never "check your email". Done when: a test sees the send, signs in with the link, finds an expired link refused and a used link refused the second time, gets an error when SMTP2GO refuses the send and when it gives no answer, finds a second request for the same address sending a new, usable link under a new key, and finds a duplicate of an uncertain or refused send reported as an error. Cheaper substitute: a password field. (**Corrected 2026-10-28**, plan review P2 2.)
- [x] Carry the return destination through the link: the link request takes `callbackURL`, accepted only as a same-site path (path and query, no scheme or host, not `//`), and the redeemed link redirects there, else to `/cases`. Done when: a test requests a link with `callbackURL=/cases?verdict=bad`, redeems it and is redirected to exactly that, and a request with an external or protocol-relative destination is refused. §7's sign-in page passes `requireSession`'s `next` as this `callbackURL`. (**Added 2026-10-28**, plan review P2 3.)
- [x] Mount the auth handler at `/api/auth/*` in the Hono app. Done when: `GET /api/auth/ok` (Better Auth health) returns 200, and `test/auth/flow.test.ts` signs in end to end through the Worker's own `fetch` in the workers pool: it POSTs the link request, takes the URL from the stubbed SMTP2GO send, redeems it over HTTP, reads the user and session back from D1, and uses the returned cookie through `requireSession`. (**Corrected 2026-10-28**, plan review P2 4: direct API calls could pass with the HTTP mount broken.)
- [x] Add the session gate every member page uses: `requireSession` in `src/auth/gate.ts`, Hono middleware that puts the signed-in user and session on the context, passes on any `Set-Cookie` Better Auth's session read returns (a renewed session's cookie), sends an anonymous browser request (one that accepts `text/html`) to `303 /signin?next=<the path and query>` and answers any other anonymous request `401`. Done when: `test/auth/gate.test.ts`, on a route mounted for the test, lets a signed-in request through with its user, renews a session past Better Auth's update age (its expiry moved forward in D1 and the renewed cookie on the response), refuses an expired session, sends an anonymous page request to `/signin` with `next` set, answers an anonymous JSON request 401, and refuses a `next` that is not a same-site path. (**Corrected 2026-10-28**, plan review P2 5.) (**Added 2026-10-28**: no section owned the gate, and D07 T04 §1's `/cases` needs it.)
- [x] Add the browser sign-out route the app shell's Sign out form posts to (D07 T01 §3): `POST /auth/sign-out` with `application/x-www-form-urlencoded`, refused unless the request's `Origin` is the app's own, ends the session (cookie cleared, session row removed) and answers `303` to `/signin`; a request with no session also lands on `/signin`. Done when: a test submits the form as a browser would, gets `303` to `/signin` with the session cookie deleted (`Max-Age=0`), finds the session row gone on a read-back and a request through `requireSession` sent to `/signin`; a second post with no session also gets `303` to `/signin`; and a cross-origin post is refused with `403` and the session intact. (D07 T01 §3 plan review P1, 2026-10-27; **corrected 2026-10-28**: `/cases` is D07 T04 §1's, so the gate stands in for it.)
Evidence 2026-10-28 02:35 SAST. `better-auth` 1.7.13 is pinned (`pnpm typecheck` passes on TypeScript 7.0.2). `src/auth/auth.ts` builds Better Auth per request on the `DB` binding with `BETTER_AUTH_SECRET` (a `ConfigError` without it) and `APP_URL`; its table-shaping options live in `src/auth/schema.ts`, from which `scripts/auth-schema.ts` (plain Node, `pnpm db:auth-schema`) has Better Auth compile `src/db/migrations/0007_auth.sql` against an in-memory SQLite (written to a temporary file and renamed; `test/node/auth-schema.test.ts` fails when the two part). The magic link goes through `sendMail` under `signin:<SHA-256 of its token>`, lives 15 minutes, and only a confirmed send counts as delivered. `requireSession` (`src/auth/gate.ts`) passes on Better Auth's renewed cookie; `POST /auth/sign-out` checks the origin. The secret was made straight into the vault ("IsItLegit Better Auth secret", from standard input, never an argument), set on the Worker from the vault, and the smoke check passed on the version that published (`docs/operations.md`, Better Auth secret). `pnpm exec vitest run test/auth test/node/auth-schema.test.ts`: 19 passed: the sign-in end to end through the Worker's fetch (link sent, redeemed over HTTP, user and session read back from D1, returning to `/cases?verdict=bad`), the link stored for 15 minutes, used and expired links refused, a new link and key per request, an error for a refused or unanswered send and for a duplicate of an uncertain or refused one, destinations off the site refused (an absolute URL on the app's own origin included), the cookie `Secure`, `HttpOnly` and `SameSite=Lax`, Better Auth finding nothing to migrate in the D1 that 0007 built, the gate letting a member through, renewing an aged session in D1 and on the cookie, refusing an expired one, sending an anonymous page to `/signin?next=...` and anything else to 401, dropping a `next` that reads as protocol-relative, and sign-out ending the session (row gone, cookie `Max-Age=0`, 303 to `/signin`, again with no session) and refusing another origin. Fourteen mutations each fail them.

Completion review 2026-10-28 (`docs/reviews/07-app/D07-T02-s1.md`): a failed link now goes to `/signin?next=<page>&error=<code>` rather than the protected page, the failure and new-user return paths are set server-side and checked on the link, link tokens are stored hashed, and `docs/operations.md` no longer claims a new secret voids sent links (it gives the D1 delete that does), in `761cbf2`; `test/auth` 22 passed, four more mutations caught. The page that renders the failed-link state and the inbox tab finishing by itself are §7's.

- [x] Commit: `auth: Better Auth on D1 with email magic links`

**Test checkpoint:** `pnpm exec vitest run test/auth` passes (`auth.test.ts`, `flow.test.ts`, `gate.test.ts`) and fails if an expired magic link signs in, the HTTP flow breaks, an undelivered link is reported sent, a renewed cookie is dropped, or sign-out leaves the session. (**Corrected 2026-10-28**, plan review P2 4.)

> **Verified:** 2026-10-28 | §1 | 2d1325de9be51b4c0c71d4036a66f55f7567612e
> **Review:** `docs/reviews/d07-t02-s1.json`

## 2. Passkey sign-in

> **Started:** 2026-10-28T01:07Z

Passkeys give members a phishing-resistant second way in, fitting for a phishing product (stack doc). A member adds a passkey after the first magic-link sign-in.

**Corrected 2026-10-28:** the section said only "enable the passkey plugin with `rpID: "app.isitlegit.co.za"`" and checked registration options and a 401. In Better Auth 1.7 the plugin is its own package, `@better-auth/passkey` (pinned 1.7.13 beside `better-auth`); it adds a `passkey` table, so §1's migration script must now write the next migration rather than rewrite 0007 (already applied locally and pending on the remote D1); it takes the expected origin from the request's `Origin` header unless `origin` is set, and its relying party ID from `baseURL`, so both are pinned to `APP_URL` (a hard-coded `app.isitlegit.co.za` would refuse every passkey in tests and on any other host); and registration needs a fresh session (Better Auth's default, a day). The section is named passkey sign-in, so it now proves the whole ceremony (register, sign in, list, remove) with a software authenticator, and the refusals that keep it phishing-resistant.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Enable the passkey plugin with the right relying party. Done when: registration and authentication options are served for the host in `APP_URL`.
2. Prove the ceremony end to end and its refusals. Done when: a software authenticator registers a passkey for a signed-in member and signs in with it through the Worker's fetch, and every refusal below is a test.

- [x] Add `@better-auth/passkey` pinned to `1.7.13` (the version of `better-auth`). Done when: `package.json` lists it exactly and `pnpm typecheck` passes. (Added with this correction.)
- [x] Enable the plugin in `schemaOptions` (`src/auth/schema.ts`) with `rpName: "IsItLegit"`, `rpID` the hostname of `APP_URL` and `origin` its origin, passed in from `authOptions` (the schema script passes the production `APP_URL`), and `authenticatorSelection: { residentKey: "required", userVerification: "preferred" }`: sign-in asks for a passkey anonymously with no `allowCredentials`, so only a discoverable credential can answer it (WebAuthn Level 3, non-discoverable credentials). Done when: `test/auth/passkey.test.ts` gets registration options for a signed-in member whose `rp.id` is the test `APP_URL`'s host and whose `authenticatorSelection.residentKey` is `required`, and authentication options anonymously with no `allowCredentials`.
- [x] Make `scripts/auth-schema.ts` incremental: apply the committed auth migrations (`0007_auth.sql` and later `*_auth*.sql`) in order to an in-memory SQLite, have Better Auth compile what is still missing, and write it as the next numbered migration (`pnpm db:auth-schema <name>`, temporary file then rename), writing nothing when nothing is missing; then generate `src/db/migrations/0008_auth_passkey.sql`. Done when: the file holds only the `passkey` table and its indexes, and `test/node/auth-schema.test.ts` (rewritten) fails when Better Auth finds anything missing after the committed migrations; `test/auth/auth.test.ts` still finds nothing to migrate on D1. The generator itself is tested in a temporary migrations folder holding only `0007_auth.sql`: it writes `0008_<name>.sql` holding only the passkey schema, which applies cleanly after 0007; 0007's bytes are unchanged; and a second run creates and rewrites nothing.
- [x] Refuse registration without a session, and with a stale one, at both steps. Done when: an anonymous request gets 401 and a session older than a day gets Better Auth's fresh-session refusal (403), for the registration options and for `/passkey/verify-registration` given a valid attestation from the software authenticator (options taken while the session was fresh, then the session aged or signed out before completing), and no `passkey` row is written in either case.
- [x] Prove the ceremony with a software authenticator (`test/auth/webauthn.ts`: an ES256 key, `none` attestation, assertions signed over the client data hash, and credential discovery like a real one: it answers an empty `allowCredentials` only from credentials it registered as resident for that relying party ID, never from a credential ID the test hands it): register a passkey while signed in, list it, sign out, request authentication options anonymously, sign in with it, and pass `requireSession`. Done when: `test/auth/passkey.test.ts` covers that path through the Worker's fetch.
- [x] Refuse a forged or replayed sign-in. Done when: tests refuse an assertion signed by another key, one whose client data names another origin, one for another relying party ID, and a replay of a used challenge; none sets a session cookie.
- [x] Refuse a credential ID already registered to anyone (WebAuthn Level 3 §7.1, registration step "verify that the credentialId is not yet registered"; the plugin does not, and its schema cannot declare the column unique): a unique index in `src/db/migrations/0009_passkey_credential_unique.sql`, and a Better Auth before hook on `/passkey/verify-registration` in `src/auth/auth.ts` answering 400 for a known ID. Done when: a second member registering a passkey under the first member's credential ID is refused, no row is written, and the first member still signs in with theirs. Added 2026-10-28 while building: found reading the plugin's registration.
- [x] Let a member remove a passkey, and only their own. Done when: deleting their passkey succeeds and signing in with it is then refused, and deleting another member's passkey is refused and leaves it in place.
Evidence 2026-10-28. `@better-auth/passkey` 1.7.13 is enabled in `schemaOptions` (`src/auth/schema.ts`) with the relying party ID and origin from `APP_URL` and a discoverable credential required. `scripts/auth-schema.ts` now applies the committed auth migrations and has Better Auth compile only what is missing (from its own `toBeCreated` and `toBeAdded`), written as `0008_auth_passkey.sql` (the `passkey` table and two indexes). `0009_passkey_credential_unique.sql` makes `credentialID` unique, and a before hook refuses a known one with 400. `test/auth/webauthn.ts` is a software authenticator (ES256, `none` attestation, DER signatures, discovery only from resident credentials). `pnpm exec vitest run test/auth test/node/auth-schema.test.ts`: 5 files, 41 passed, covering registration options for `localhost` requiring a resident key, anonymous authentication options naming no credential, register, list, sign out and sign in with the passkey, 401 and 403 (stale) for options and for verification with no row written, a taken credential ID refused, another key, another origin (header and client data), another relying party and a replay refused with no cookie, a non-discoverable credential unreachable, the client data checked against `APP_URL` through the server API, removal of one's own passkey and refusal of another's; and the generator writing 0008 byte for byte from 0007 alone, leaving 0007 untouched, writing nothing a second time, numbering after any migration, refusing an unsafe name. Full suite 500 passed, 2 skipped. Seven mutations each fail them (resident key preferred, origin from the request, production rpID, no known-ID refusal, registration without a session, an authenticator answering non-resident credentials, and the generator's empty check).

Completion review 2026-10-28 (`docs/reviews/07-app/D07-T02-s2.md`): a passkey's session now passes `requireSession` in the ceremony test; listing and renaming are proven member-only (and refused anonymously); a sign-in response is checked for shape before the plugin consumes the challenge or looks the credential up (a 400 that leaves the attempt usable). **Decision 2026-10-28:** user verification is required, not preferred (**Corrected 2026-10-28** after the final review, which found the item above still saying "preferred" and this line a bare 401): registration options and sign-in options both ask for it, and `src/auth/passkey.ts` refuses a response from a device that was present but not unlocked, 400 at registration and 401 at sign-in, each with the code `USER_VERIFICATION_REQUIRED` so §7 can say what to do; the industry reading of a passkey as proof of the device and its unlocked owner; the plugin itself verifies with it off. Reversing it is one line in `schemaOptions` and the check in `src/auth/auth.ts`; the cost of keeping it is that a security key with no PIN cannot sign in (the email link still can). `test/auth/passkey.test.ts`: 15 passed; four more mutations caught.

- [x] Commit: `auth: passkey sign-in`

**Test checkpoint:** `pnpm exec vitest run test/auth test/node/auth-schema.test.ts` passes, and fails if a passkey registers (options or verification) without a fresh session, registration options stop requiring a resident key (whether a credential is discoverable is not in what the authenticator attests, so the server can ask for it but not check it; **Corrected 2026-10-28**, the line claimed more), an assertion from another origin or key signs in, a member removes another member's passkey, or the schema generator rewrites an applied migration or writes one when nothing is missing.

> **Verified:** 2026-10-28 | §2 | f743b035bc9bd52d96319a272691deff85c62085
> **Review:** `docs/reviews/d07-t02-s2.json`

## 3. Organisations, roles, invites and removal

> **Started:** 2026-10-28T02:09Z

One organisation per client company, roles owner, admin and member (spec 4.8). Invites go by email through the allowlist; owners and admins can revoke an invite and remove a member, which ends that member's sessions.

**Corrected 2026-10-28:** checked against Better Auth 1.7.13's organisation plugin (`better-auth/plugins/organization`, part of `better-auth`). It adds `organization`, `member` and `invitation` tables and `activeOrganizationId` on `session`, so the generator writes migration 0010. It lets any signed-in user create an organisation unless told not to, while the spec creates one only through invite-code signup (§4), so creation is closed to members and left to the server path §4 calls. It runs `sendInvitationEmail` through `runInBackgroundOrAwait`, which logs and swallows a failure, so an invite would report success with no email sent; the invite answer now reflects the send. A new session has no active organisation, so one is chosen when the session is made. Invites go through `sendMail`, which the allowlist (D01 T02 §2, open) will guard for every send when it ships. The browser switch route and `requireOrg` were already specified; `requireOrg` now also checks membership on every request, so removal takes effect at once.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Enable the organisation plugin. Done when: a user creates an organisation and is its owner.
2. Add invites, revocation and removal with role checks. Done when: tests prove a member cannot invite and a removed member loses access.

- [x] Enable the Better Auth organisation plugin in `schemaOptions` (`src/auth/schema.ts`) with roles `owner`, `admin`, `member` (its defaults: the creator is `owner`), `allowUserToCreateOrganization: false`, `disableOrganizationDeletion: true` (deleting an organisation is §9's closure and purge; the plugin's own delete would leave its cases, which carry no foreign key), and generate `src/db/migrations/0010_auth_organization.sql` with `pnpm db:auth-schema organization`. Done when: `test/auth/org.test.ts` creates an organisation through the server API for a user (the path §4's signup will call) with that user as owner, a member's own `POST /api/auth/organization/create` gets 403, an owner's `POST /api/auth/organization/delete` is refused with the organisation, its members and a case row of its still there, and `test/node/auth-schema.test.ts` finds nothing missing after 0010.
- [x] Choose the active organisation when a session is made: Better Auth's `databaseHooks.session.create.before` sets `activeOrganizationId` to the user's earliest membership, or leaves it empty for a user with none. Done when: a member of two organisations signs in with the older one active, and a user with none signs in with none.
- [x] Send invites with `sendMail({ kind: "signin" })` under the send key `invite:<invitation id>:<expiresAt>` (one per send, so a resend is a new send), linking to `/invite/<invitation id>` on `APP_URL` (the page is §7's `invite.tsx`), expiring after 48 hours (the plugin default; **Corrected 2026-10-26:** no expiry was set), and accept them by signing in with the invited address and calling Better Auth's accept-invitation. Done when: an invitee joins as `member`, including one with no account yet, who signs in by magic link with the invited address (account creation for a pending invitation's address is the exemption §4 keeps when it restricts sign-up to codes), joins without any new organisation being made; a signed-in user with another address cannot accept it (refused, no membership); and a 49-hour-old invite is refused.
- [x] Report an invite whose email did not go: an after hook on `/organization/invite-member` reads that send's outcome from `mail_sends` and answers 502 ("the invitation is saved but its email could not be sent; send it again") unless it was confirmed, the invitation kept. Sending it again is the same request with `resend: true` (Better Auth refuses a second invite to a pending address without it, and with it extends the expiry, so the send key is new); D07 T04 §3's team page makes that request. Done when: a refused and an unanswered SMTP2GO each give 502 with the invitation still pending, and the `resend: true` request after SMTP2GO recovers answers 200 with the same invitation id, a new send key in `mail_sends`, and the send confirmed.
- [x] Allow invite and removal for owners and admins only. Done when: a member's attempt gets 403.
- [x] Revoke an invite and remove a member, deleting the member's sessions for that organisation (the plugin's `organizationHooks.afterRemoveMember` deletes that user's sessions whose `activeOrganizationId` is the organisation; **Corrected 2026-10-28:** built as a Better Auth after hook on `/organization/remove-member` in `src/auth/auth.ts`, the same request the plugin's hook runs in, with Better Auth's adapter). Done when: a revoked invite cannot be accepted, and the removed member's session rows for that organisation are gone, so their next request is refused by `requireSession` (401, or 303 to `/signin` for a page; **Corrected 2026-10-28:** said 403, which `requireOrg` cannot answer for a session that no longer exists).
- [x] Write `requireOrg` (`src/auth/org.ts`), Hono middleware after `requireSession`, putting the active organisation id and the member's role on the context for every app route from the session's `activeOrganizationId` only, and checking the membership on every request. Done when: every later route test can use it, a request for another organisation's case gets 404 (a probe route reading `cases` by id and the context's organisation), a session with no active organisation gets 403, a still-valid session whose membership of its active organisation was deleted (directly, without the removal hook) gets 403, and a request naming another organisation in its query string still reads the session's. Cheaper substitute: reading the organisation id from a query parameter.
- [x] Add the browser organisation-switch route the app shell's switcher posts to (D07 T01 §3): `POST /orgs/switch` with `application/x-www-form-urlencoded` field `organizationId`, refused unless the request's `Origin` is the app's own, sets the session's active organisation only when the member belongs to it, and answers `303` to `/cases`; a non-member's request answers `403` with the active organisation unchanged. Done when: a test switches between two organisations and reads the active one back from the session and from `/cases`, a switch to a foreign organisation is refused with the active one unchanged, and a switch to the member's own other organisation posted from another origin, and with no `Origin` header, is refused (403) with the active one unchanged. (D07 T01 §3 plan review P1, 2026-10-27.) (`/cases` is D07 T04 §1, not built: the read-back is through the session and a `requireOrg` probe until it is.)
Evidence 2026-10-28 (after the reviews; it replaces the build's first paragraph). The organisation plugin is in `schemaOptions` with member creation and plugin deletion closed; migration `0010_auth_organization.sql` came from `pnpm db:auth-schema organization`; `0011_member_unique.sql` holds one membership per user and organisation and `0012_invitation_uses.sql` records an invitation's one use. `src/auth/auth.ts`: invitations through `sendMail` under `invite:<id>:<expiresAt>`, the send read back (502, saying whether it failed or may have gone); inviting again, by a signed-in owner or admin only, cancels a spent invitation still pending so a fresh one is made; an acceptance records the use first for the recipient only, the insert being the one check (409 for a second use, Better Auth refusing an accepted one); removal deletes the member's sessions in that organisation; each new session starts in the earliest organisation; a switch to a foreign organisation is refused before Better Auth clears the active one. `src/auth/org.ts`: `requireOrg` (the session's organisation only, membership read through Better Auth's adapter on every request, 403 refused, 503 when D1 fails) and `POST /orgs/switch` (the app's origin only, the session read first, 503 on an outage); `src/auth/gate.ts` answers a session-store outage 503. `pnpm exec vitest run test/auth test/node/auth-schema.test.ts`: 62 auth tests and the schema tests pass; full suite 525 passed, 2 skipped. The mutations named in the review commits each fail them.

**Decision 2026-10-28 (review rounds 1 and 2):** an invitation is used once. Its use is recorded in `invitation_uses` (migration 0012) before Better Auth accepts it, only for the signed-in recipient of a pending, unexpired invitation, and a second use is refused (409) whatever the invitation's status says, because Better Auth moves that status both ways (it resets an acceptance to pending when its membership write fails). An acceptance interrupted between Better Auth's two writes is recovered by an owner sending a new invitation, not by reopening the old one: the completion review's recovery that did reopen it let a removed member come back and two acceptances both proceed, and was withdrawn. Migration 0011 holds one membership per user and organisation. Reversing it means a self-service recovery with its own proof of first use; the cost of keeping it is one more invitation from an owner after a rare interruption.

- [x] Commit: `auth: organisations, roles, invites and removal`

**Test checkpoint:** `pnpm exec vitest run test/auth test/node/auth-schema.test.ts` passes and fails if `requireOrg` trusts a query parameter, a member can create an organisation or invite, an invite reports success when its email did not go, or a removed member keeps access.

> **Verified:** 2026-10-28 | §3 | 7603dc0807588d9942b73a8323986c6525998d91
> **Review:** `docs/reviews/d07-t02-s3.json`

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
- [ ] Refuse the Better Auth sign-up hook unless a valid unexpired code with uses left is supplied, and increment `uses` atomically, except for an address with a pending, unexpired organisation invitation (§3), whose account is created without a code and joins only that organisation (no new organisation); an expired, revoked or other-address invitation gives no exemption. (§3 plan review P1, 2026-10-28.) Done when: `test/auth/invite.test.ts` covers valid, used-up, expired and missing codes, and an invited address signing up with no code joins its inviting organisation only, while an expired, revoked or other-address invitation is refused like a missing code.
- [ ] Make a signup's address a member before its magic link is sent: the recipient allowlist (D01 T02 §2) mails `signin` links only to members, pending invitees and the demo domains, so signup creates the user, its organisation and its owner membership first, then sends the link. Done when: `test/auth/invite.test.ts` signs up a new `@example.org` address with a valid code and its link is sent (not refused), while the same address without a code is refused and no user is made. Membership, not `emailVerified`, is what admits the address, so the first link goes before the address is verified; a failed first send is retried by asking for the link again. (D01 T02 §2 correction and plan review, 2026-10-28.)
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

- [ ] Add migration `src/db/migrations/<next number>_auth_events.sql` (**Corrected 2026-10-28:** said `0006_auth_events.sql`; 0006 is `0006_mail_searched_at.sql` and 0010 is the newest) with `auth_events` (`at`, `kind`, `org_id`, `user_id`, `ip_hash`, `detail_json` without secrets). Done when: it applies locally.
- [ ] Rate-limit magic-link and verification-code requests to 5 per address and 20 per IP per 10 minutes with KV counters (the per-address limit on sign-in mail already holds inside `sendMail`, D01 T02 §2, counted from `mail_sends`; this adds the per-IP limit, the verification-code limits and their audit rows, and answers a limited request the same as a sent one so it reveals nothing). Done when: `test/auth/ratelimit.test.ts` sees the sixth request refused with 429.
- [ ] Write an `auth_events` row for sign-in, failure, invite, removal, verification and rate-limit refusal. Done when: the test finds one row per kind.
- [ ] Record team changes with who did them and to whom, and let owners read them: role changes, invitation revocations and removals each write one `auth_events` row naming the organisation, the actor, the target, the action and the time (after hooks on `/organization/update-member-role`, `/organization/cancel-invitation` and `/organization/remove-member`, beside §3's), kept after the target leaves; an owner-only, organisation-scoped read (`requireOrg`, newest first, filtered by action and date) serves it to D07 T04 §3. Done when: `test/auth/audit.test.ts` finds one attributable row per change, still there after the member is removed, an owner reads them filtered and a member or another organisation's owner is refused. Source: D07 T02 §3 completion review (Part 2 item 3).
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

- [ ] Build `src/web/pages/signin.tsx` (email field, magic-link button, passkey button, "check your inbox" state), passing the `next` that `requireSession` (§1) puts on `/signin` as the link request's `callbackURL`, so signing in returns to the page asked for (§1 validates it as a same-site path). Done when: the page test finds each control by accessible name. Cheaper substitute: Better Auth's default unstyled form. The "check your inbox" state says "If this address can sign in to IsItLegit, a link is on its way", never that a link was sent: a refused or rate-limited address is answered exactly as a sent one (D01 T02 §2).
- [ ] Render the failed-link state on `src/web/pages/signin.tsx`: when §1 sends a used, expired or unknown link to `/signin?next=<page>&error=<code>` (`INVALID_TOKEN`, or Better Auth's other magic-link codes, `src/auth/auth.ts` `recoveryPath`), show that the link no longer works and why in plain words, with the email field and "Email me a new link" ready, keeping `next` as the new request's `callbackURL`, and announce the message (`role="alert"`). Done when: `test/web/auth-pages.test.ts` renders `/signin?next=%2Fcases%2F42&error=INVALID_TOKEN`, finds the message and the button by role and name, and a new link requested from it carries `callbackURL=/cases/42`; an unknown `error` code shows the generic wording, never the raw code. Cheaper substitute: a generic "something went wrong" banner, or dropping `next`, fails the test. Source: D07 T02 §1 completion review (`docs/reviews/07-app/D07-T02-s1.md`, Part 1 item 9 and Part 2 item 1).
- [ ] Finish the sign-in in the tab that asked for the link: the "check your inbox" state on `src/web/pages/signin.tsx` listens for the session (a `BroadcastChannel("isitlegit-auth")` message from the tab the link opened, with a `/api/auth/get-session` check every 5 seconds while the page is visible as the fallback) and goes to `next` once signed in, with no reload or second click. Done when: a browser test requests a link, redeems it in a second tab, and the first tab reaches `next` within 2 seconds; with no session it stays on the inbox state. Cheaper substitute: a "refresh after clicking the link" note fails the test. Source: D07 T02 §1 completion review (Part 2 item 3, the initiating-tab completion Clerk documents).
- [ ] Run the passkey sign-in from `src/web/pages/signin.tsx`'s "Sign in with a passkey" button in one activation (no email entry): `navigator.credentials.get` with the options from `/api/auth/passkey/generate-authenticate-options`, then `verify-authentication`, then `next`; cancellation and "no passkey on this device" return at once to the page with the email field focused and a plain message, an expired challenge retries with new options, and a refusal for a device that was not unlocked (401 with the code `USER_VERIFICATION_REQUIRED`, §2) says to unlock the device or use the email link, announced (`role="alert"`). Done when: a browser test with a virtual authenticator signs in and lands on `next`, and cancels, has none, and is refused, each ending on the email field with the message; post-approval navigation to `next` stays within 2 seconds p95 on a throttled mid-range mobile profile. Cheaper substitute: a passkey button that reloads the page or drops `next` fails the test. Source: D07 T02 §2 completion review (Part 2 items 2 and 3).
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

## 9. Account closure and coordinated purge

Spec 4.8 promises that case summaries are deleted within 30 days of an organisation closing its account. The case tables cascade (D01 T01 §1), but nothing starts the deletion or removes the case's R2 objects (completion review of D01 T01 §1, item 11).

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Close an account and purge it on schedule. Done when: a closed organisation's cases, rows and R2 objects are gone within 30 days, and another organisation's are untouched.

- [ ] Add the owner's Close account control to `design/SPEC.md` (where it sits, the confirmation naming the 30-day purge, what members see afterwards) and build it on that page, posting to the closure route. Done when: the SPEC section and its board exist, and a rendered-page test finds the control by role and name for an owner only, refuses it without the confirmation, and closes the organisation with it. Cheaper substitute: a route with no control, or a control for every member, fails the test. Source: D07 T02 §1 completion review (Part 1 item 14), which found no control to start the closure.
- [ ] Record an organisation's closure (`closed_at`) when its owner closes the account, and refuse new cases for it from then on. Done when: a test closes an organisation and its next case is refused.
- [ ] Write the purge: a scheduled Worker run deletes, for each organisation closed 30 days or more, its R2 objects listed by each case's prefixes (`raw/<caseId>/` and `art/<caseId>/`, so an object whose row was never written goes too; D01 T01 §2) and then its cases (the child rows cascade), in batches that resume after a failure. Done when: a test with two organisations purges only the closed one's cases, rows and objects, and a purge interrupted halfway finishes on the next run. The purge also deletes the organisation's `invitation_uses` rows (migration 0012, which has no foreign key to `invitation`), so a spent invitation's user and time go with it (D07 T02 §3 final review).
- [ ] State the period on the privacy page and in `docs/operations.md`. Done when: both name 30 days from closure.
- [ ] Commit: `app: account closure and the 30-day purge`

**Test checkpoint:** `pnpm exec vitest run test/auth/closure.test.ts` passes, and fails if the purge touches an open organisation.

## Verification

- An invited user signs up, verifies a domain and gets mail from it accepted; uninvited signup, a foreign case and over-limit use are refused.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
