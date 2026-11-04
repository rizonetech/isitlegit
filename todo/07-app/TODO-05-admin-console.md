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
| 1 | §1 | Access application and JWT verification | D07 T01 §10 | [x] |
| 2 | §2 | Overview, spend and invite codes | §1, D03 T01 §2 | [x] |
| 3 | §3 | Service health tiles on | §2 | [ ] |
| 4 | §4 | Find organisations by domain or ID | §2 | [x] |
| 5 | §5 | Filter the organisations | §2 | [ ] |
| 6 | §6 | Independent gateway relay revision review | §2 | [ ] |
| 7 | §7 | Admin typeahead design proposal | §4 | [x] |

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
- [x] Store `CF_ACCESS_AUD` and the team domain as Worker vars in `wrangler.jsonc` (`CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_EMAIL` for the operator's own sign-in address; the aud and team domain are identifiers, not secrets). Done when: the vars are in `wrangler.jsonc`, `pnpm types` regenerates `worker-configuration.d.ts`, and the values match the read-back.
- [x] Write `requireAccess(c)` in `src/auth/access.ts` verifying the RS256 JWT with keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached 1 hour), checking `aud`, `iss`, `exp` and `email` against the admitted addresses (`OPERATOR_EMAIL` and `CF_ACCESS_EMAIL`), and mount it on `/admin` and `/admin/*` in `src/index.ts` so an unverified request is refused before any admin page exists. Done when: `test/web/access.test.ts` covers the four refusals (missing, expired, wrong audience, wrong issuer) and one pass, and fails if the email claim is not compared. Cheaper substitute: trusting the `Cf-Access-Authenticated-User-Email` header.
- [x] Prove the signature itself (**Added 2026-11-01, plan review P1**): the test signs real RS256 tokens with a test key and serves its JWKS through the stubbed certs endpoint. Done when: a tampered payload, a signature from an unrelated key, an unsigned token, a disallowed algorithm, and a token missing a required claim are each refused, and both admitted addresses pass.
- [x] Prove the mount, not only the guard (**Added 2026-11-01, plan review P1**): requests through the Worker entry (`src/index.ts`) to `/admin` and a nested admin path, GET and POST, are refused by the guard's own answer and never reach the downstream handler; the same on the `workers.dev` hostname, and with a forged `Cf-Access-Authenticated-User-Email` header and no valid JWT. Done when: removing either middleware mount fails the test, and a downstream 404 does not count as the refusal.
- [x] Survive key rotation (**Added 2026-11-01, plan review P2**): keys are chosen by the token's `kid` from the returned set, and an absent `kid` triggers one bounded refresh past the cache before refusing. Done when: a token signed by a rotated-in key passes against a warm cache that lacks it, and a `kid` no refreshed set holds is refused.
- [x] Fail closed when verification cannot run (**Added 2026-11-01, plan review P2**): a cert fetch that times out (a bounded fetch), answers non-success, or returns malformed keys, and missing configuration (`CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, the admitted addresses), each refuse without reaching downstream: a bad token answers 403, an unavailable verifier or missing configuration answers 503, and neither exposes the token or the provider's error. Done when: each failure is tested, and authentication passes again once the certs endpoint recovers.
- [x] Commit: `admin: Access application and JWT verification`

**Test checkpoint:** `pnpm exec vitest run test/web/access.test.ts` passes and fails if the email claim is not compared.

> **Verified:** 2026-11-01 | §1 | e21646719ebec2f2c9caa4f7f235b23e80e07663
> **Review:** `docs/reviews/d07-t05-s1.json`

## 2. Overview, spend and invite codes

> **Started:** 2026-11-01T18:20:43Z

**Corrected 2026-11-01:** measured against the tree at start. (1) The route is behind D07 T05 §1's `requireAccess`, mounted in `src/index.ts` before every other handler; the pages use the admin shell (`AppShell` variant `admin`, D07 T01 §3). (2) "Top threat" reads the most frequent problem check among the organisation's suspicious and malicious cases this week (`check_outcomes` joined to `case_verdicts`), because no case-level threat kind is stored (D07 T04 §18, deferred); an organisation with none reads "None yet". (3) Invite codes are made in the Worker (`src/auth/invite-codes.ts`: the script's alphabet and SHA-256 hashing from `scripts/invite-code.ts`, reimplemented on Web Crypto), shown once on the page that creates them, and never stored in plain text. (4) The six service-health tiles of SPEC X1 need thresholds no document defines; they are filed as §3 below, so this section's overview carries the organisations, spend and incidents only. (5) Organisation names open X2 (`/admin/orgs/:id`, D07 T08 §5), which is not built yet; the link stands and that section builds the page. (6) The auth-trail incident review is a panel on the overview, not a new route, so no new board is needed.

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

- [x] Build `src/web/pages/admin.tsx` with the organisation table and CSV export. Done when: `test/web/admin-page.test.ts` checks rows and the CSV.
- [x] Prove every aggregate the overview promises (**Added 2026-11-01, plan review P2**): seeded fixtures assert each organisation column (plan, domains verified, members, cases this week, the top-check ranking, feedback count) and each summary tile (organisations with a verified domain, cases today and in total, median and p95 time to verdict, open feedback), not only that rows exist. The CSV exports the table as filtered by the search, with every column, CSV escaping, and a leading `'` on a cell that starts with `=`, `+`, `-` or `@`. Done when: the test reads the exact seeded values in the page and in the CSV.
- [x] Show spend today and in total per provider against the caps and the reserve. Done when: a seeded spend renders the right percentages. **Corrected 2026-11-01 (plan review P1):** Meta reads `model_spend` against `src/meta/caps.ts` (day, total and the reserve through `totalLimitFor`); Fireworks reads the `glimmer_runtime` minutes through `src/vision/glimmer-minutes.ts` at the checked rate against `FIREWORKS_DAY_CAP_USD` and `FIREWORKS_TOTAL_CAP_USD` in `src/vision/glimmer-caps.ts`. Done when: the test seeds both providers and reads all four bars' amounts and percentages, on a reserve day and before it.
- [x] Add invite-code management (create with label and uses, list with uses and expiry, revoke by setting its expiry to now in `invite_codes`, migration 0013, D07 T02 §4). Done when: a revoked code is refused at signup and accounts made with it are unaffected.
- [x] Build the X3 invite form as the board draws it (**Corrected 2026-11-01, plan review P1**): Label, Organisations (uses), and an Expires date (empty reads Never), validated under the fields with what was typed kept; the board's Daily cap each is not built, because a code admits organisations whose cap the operator sets per organisation (the overview's cap control, and X2's plan card): record that as a Deviation in `design/SPEC.md` X3. The created code is shown once with a Copy control beside it; no later visit can copy it, because only its hash is stored: record that too as an X3 Deviation, with the lost-code recovery (revoke it and make a new one). **Corrected 2026-11-02 (round 1 P2):** each form carries a single-use creation key (table `invite_creation_keys`, migration number asked of the coordinator): the first POST for a key creates exactly one code and shows it once, and any repeat POST of the same key (refresh, resubmission, transport retry) renders an already-submitted page naming the label instead of a second code; an unknown or stale key re-renders the form with the typed values kept and a fresh key. Done when: the page test creates a code through the form, copies the shown code, signs up with it, and reads the use counted after a reload; and a repeat POST of the same key creates no second code.
- [x] Tell a revoked code apart from an expired one (**Added 2026-11-01, plan review P2**): revocation stamps `invite_codes.revoked_at` (migration 0074, assigned to this lane by the coordinator 2026-11-01; nullable, old rows null), and the list reads Active, Used up, Expired and Revoked, with Copy and Revoke only where they can act. Done when: the test reads each status back and a revoked code's earlier signups are unaffected.
- [x] Prove the forms' failure and recovery states (**Added 2026-11-01, plan review P2**): an invalid invite field is refused under the field with the typed values kept and nothing stored; a cap outside 0 to 50 is refused the same way and the stored cap is unchanged; a search with no match says so with a clear-search link; no invite codes yet says so. Done when: `test/web/admin-page.test.ts` reads each state and the stored rows after it.
- [x] Set an organisation's daily case cap over its plan's (`org_limits.daily_cases_override` through `setDailyCapOverrideStatement` in `src/auth/plan-sql.ts`, D07 T08 §8) from the organisation table, 0 to 50 (the event maximum), read back after saving; show each cap as the plan's or as an override; and a "Use plan limit" control that clears it (`clearDailyCapOverrideStatement`). Done when: `test/web/admin-page.test.ts` lowers a cap, reads it back marked as an override, the next `admitCase` for that organisation is refused at the new limit, and Use plan limit reads back the plan's cap with admission following it. Cheaper substitute: writing `org_limits.daily_cases`, which admission no longer reads. Source: D07 T02 §4 completion review (Part 1 item 11); **Corrected 2026-10-31** by D07 T08 §8 (the cap follows the plan; this item read `org_limits.daily_cases`).
- [x] Give the operator incident review of the auth trail (D07 T02 §6's `auth_events`), including rows with no organisation (refused sign-ins, rate limits), behind the operator's own gate and never through any organisation's owner read. Done when: the operator reads a refused sign-in and a rate-limit row, and an organisation owner's read never returns a row without its organisation. Source: D07 T02 §6 plan review.
- [x] Draw the overview to board `Admin-Overview` in the admin shell (`src/web/pages/admin.tsx`): the four summary tiles (organisations, cases today, median time to verdict, open feedback), the spend bars, the organisations table with a search that filters by name (`?q=`), Export CSV and a New invite code link to `/admin/invites`, and the recent-incidents panel. Done when: the browser test reads the tiles, bars, a searched table and the panel at 360 px and 1280 px in both themes, and the empty state (no organisations) says so. Cheaper substitute: the table alone.
- [x] Commit: `admin: cross-organisation overview, spend and invite codes`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-page.test.ts` and `pnpm exec vitest run --project browser test/node/admin-browser.test.tsx` pass.

> **Deferred:** the six service-health tiles of SPEC X1 -> XREF: D07 T05 §3

> **Verified:** 2026-11-02 | §2 | 0ec71c94e113c9a8060e25af55b58ace0436a73a
> **Review:** `docs/reviews/d07-t05-s2.json`

## 3. Service health tiles on

SPEC X1 draws six service-health tiles (email intake, workflows, Meta Model API, Browser Run, Google Web Risk, outbound mail), each with a status dot, a word (Healthy, Slow, Down) and a detail line, and a red tile emails the operator. No document defines the thresholds or the checked-every-minute job behind them, so §2 did not invent them. Filed 2026-11-01 from D07 T05 §2.

**Phase:** 7
**Operator decision 2026-11-02:** Each tile reads its own measured signal with two thresholds (Slow, Down) recorded per tile in the section from live measurements; one email when a tile first reads Down.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` X1 (board `Admin-Overview`)
**Job:** the operator sees a failing part of the service on the overview
**Treatment:** six tiles in the board's shape, each from a measured signal
**Chrome:** §2's overview

**Build order:**

1. Decide each tile's signal and Healthy, Slow and Down thresholds, and record the operator's decision in this section. Done when: every tile names its table or probe and its two thresholds.
2. Read the six signals on the overview (`src/web/pages/admin.tsx`). Done when: `test/web/admin-page.test.ts` seeds each signal across its thresholds and reads the tile's word.
3. Email the operator when a tile first reads Down. Done when: a seeded Down signal sends one operator mail and a second read sends none.

- [ ] Record the six signals and thresholds in this section, with the operator's decision. Done when: each tile's signal and thresholds are named here. Cheaper substitute: thresholds invented in code.
- [ ] Draw the six tiles (`src/web/pages/admin.tsx`) from their signals, each with its detail line. Done when: `test/web/admin-page.test.ts` reads Healthy, Slow and Down for a seeded signal. Cheaper substitute: tiles that always read Healthy.
- [ ] Send the operator one mail when a tile first reads Down, through the operator allowlist. Done when: the test reads one send for a new Down and none for the next read. Cheaper substitute: an email on every read.
- [ ] Commit: `admin: service health tiles on the overview`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-page.test.ts` passes and fails if a Down signal sends no mail.

## 4. Find organisations by domain or ID

> **Started:** 2026-11-04T07:22:58.161817+00:00

The overview search matches the organisation name only (D07 T05 §2), so the operator cannot start from the domain on a certificate or the ID in a log. This section extends the same search box to match a verified domain or the organisation ID too, with the table, the CSV and the empty state reading the same matches.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` X1 (board `Admin-Overview`)
**Job:** the operator finds the client from a domain or an ID
**Treatment:** the search box as drawn, matching three fields
**Chrome:** §2's overview

**Build order:**

1. Match the search against the name, verified domains and the organisation ID in `src/web/pages/admin.tsx`. Done when: `test/web/admin-page.test.ts` seeds an org whose domain and ID differ from its name and reads it back from each of the three.
2. Export the same matches from `GET /admin/organisations.csv`. Done when: the CSV test reads the domain- and ID-matched rows and no other row.
3. Keep the empty state naming what was searched. Done when: a search matching nothing names the searched text with its Clear search link.

- [x] Match name, verified domain and organisation ID in `src/web/pages/admin.tsx`. Done when: `test/web/admin-page.test.ts` reads the org back from each of the three. Cheaper substitute: matching the name twice.
- [x] Export the same matches from the CSV. Done when: the CSV test reads the domain- and ID-matched rows only. Cheaper substitute: exporting the unfiltered table.
- [x] Name the searched text in the empty state. Done when: the no-match test reads the searched domain or ID with its Clear search link.
- [x] Prove verified-only, unique matches in `test/web/admin-page.test.ts` with pending domains, several matching verified domains, unrelated organisations and domainless name/ID matches. Done when: HTML and CSV contain the exact matching organisation identities once and reject pending-only matches; literal wildcard searches stay literal. Cheaper substitute: positive-only substring assertions. Source: Codex plan self-review P2-1.
- [x] Describe name, verified-domain and ID search in `src/web/pages/admin-view.tsx` and use field-neutral no-match wording. Done when: the rendered search explains all three fields and Clear search restores every organisation. Cheaper substitute: keeping name-only wording after changing matching. Source: Codex plan self-review P2-2.
- [x] Commit: `admin: find organisations by domain or ID`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-page.test.ts` passes and fails if a domain search returns no row.

> **Verified:** 2026-11-04 | §4 | d0c7b2fd1aeb31ac5bd34ddd3bf02f3422a29074
> **Review:** `docs/reviews/d07-t05-s4.json`

## 5. Filter the organisations

The organisations table is fixed in alphabetical order (D07 T05 §2), so the operator cannot pull the clients that need attention: a domain waiting on verification, or open feedback. This section adds that filter to the table. The board draws no such control, so the board change goes to the operator first.

**Phase:** 7
**Operator decision 2026-11-02:** One attention filter control above the organisations table in the board's shape, applying to the table, the CSV and the row counts (the control's shape and options approved and named in the section first).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` X1 (board `Admin-Overview`)
**Job:** the operator pulls the clients that need attention
**Treatment:** one filter control in the board's shape, above the table
**Chrome:** §2's overview

**Build order:**

1. Draw the filter control and record the operator's approval of the board change in this section. Done when: the control's shape is approved and named here.
2. Filter the table, the CSV and the row counts to the chosen need in `src/web/pages/admin.tsx`. Done when: `test/web/admin-page.test.ts` seeds a pending-domain org and an open-feedback org and reads only them under the filter.
3. Keep the filter across cap changes and refusals with the search. Done when: setting a cap from a filtered table returns to the same filter.

- [ ] Record the approved filter control shape in this section. Done when: the control and its options are named here. Cheaper substitute: an unapproved control.
- [ ] Filter the table and the CSV by need (`src/web/pages/admin.tsx`). Done when: `test/web/admin-page.test.ts` reads only the matching rows. Cheaper substitute: a control that filters nothing.
- [ ] Keep the filter across cap changes (`src/web/pages/admin.tsx`). Done when: the test sets a cap from a filtered table and lands back filtered.
- [ ] Commit: `admin: filter the organisations table by need`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-page.test.ts` passes and fails if the filter reads every row.

## 6. Independent gateway relay revision review

Coordinator assignment 2026-11-04: platform review surface for D02 T02 §10. Requires its stamped storage contract merged and coordinator approval of `docs/specs/2026-11-04-gateway-relay-surfaces-design.md`; add the resolving dependency at that boundary.

**Phase:** 7
**Needs:** third-party
**Surface:** yes
**Fidelity:** `docs/specs/2026-11-04-gateway-relay-surfaces-design.md` platform review; existing `design/SPEC.md` X1 admin chrome, pending scoped treatment approval
**Job:** an independent platform reviewer approves or rejects exactly the verified proposal they examined
**Treatment:** pending revision list, immutable detail, independent source record and explicit approve/reject actions
**Chrome:** existing Access-protected admin shell

**Build order:**

1. Approve the treatment in `docs/specs/2026-11-04-gateway-relay-surfaces-design.md` and import the checks contract. Done when: approval and dependency are recorded.
2. Build `src/web/pages/admin-gateway-ranges.tsx`. Done when: only independently authenticated platform review can decide the exact current revision.
3. Prove persisted decisions and conflicts. Done when: route and browser tests refuse stale approval and tenant self-approval.

- [ ] Record scoped treatment approval in `docs/specs/2026-11-04-gateway-relay-surfaces-design.md`. Done when: every review state is approved before implementation. Cheaper substitute: unreviewed controls. Source: coordinator delivery decision 2026-11-04.
- [ ] List pending revisions and render immutable details in `src/web/pages/admin-gateway-ranges.tsx`. Done when: the selected organisation, binding, CIDRs and revision equal stored data. Cheaper substitute: approving a mutable latest pointer. Source: gateway relay ranges design.
- [ ] Implement approval/rejection through the checks API in `src/web/pages/admin-gateway-ranges.tsx`. Done when: independent source metadata and safe rejection reasons persist, and authenticated tenant self-approval fails. Cheaper substitute: trusting a tenant-provided source. Source: gateway relay ranges design.
- [ ] Implement stale, removed-claim, changed-binding, read-failure and retry states in `src/web/pages/admin-gateway-ranges.tsx`. Done when: conflict reload never silently approves a new revision and retries retain their idempotency key. Cheaper substitute: last-write-wins approval. Source: scoped surface contract.
- [ ] Test decisions through `test/web/admin-gateway-ranges.test.ts`. Done when: missing Access, tenant identity, stale revisions and deleted claims are refused and valid decisions have one stored audit entry.
- [ ] Test the review controls in `test/node/admin-gateway-ranges-browser.test.tsx`. Done when: keyboard users at 360 px in both themes approve/reject and recover from conflict with stored read-back.
- [ ] Commit: `admin: independently review gateway relay revisions`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-gateway-ranges.test.ts test/node/admin-gateway-ranges-browser.test.tsx` passes and fails if a stale revision or tenant self-approval is accepted.

## 7. Admin typeahead design proposal

> **Started:** 2026-11-04T11:54:25.108271+00:00

Filed from D07 T05 §4 final completion's out-of-scope suggestion under coordinator `console-scope-ownership`, 2026-11-04. The approved X1 Search/Enter interaction remains unchanged. A proposed 500 ms p95 from that review is unmeasured and is not an accepted performance claim or implementation target. This section evaluates the proposal; it does not authorize a new control or close §4's original gaps receipt.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Assess the interaction proposal against the existing approved flow. Done when: a scoped proposal records measured costs, access constraints and recovery, and the coordinator records keep, defer or authorize-design.
2. Record the resulting design boundary. Done when: any authorized future UI implementation has its own resolving section and approved treatment before code changes.

- [x] Capture the current Search/Enter contract and the original suggestion in `docs/specs/2026-11-04-admin-search-interaction-proposal.md`. Done when: existing domain/ID/name search, verified-domain privacy, CSV equivalence and neutral empty recovery are retained, and the 500 ms figure is explicitly unmeasured. Cheaper substitute: treating review prose as approved design. Source: `docs/reviews/07-app/D07-T05-s4.md` and coordinator scope decision.
- [x] Compare measured local submit-flow cost with a documented typeahead proposal in `docs/specs/2026-11-04-admin-search-interaction-proposal.md`. Done when: assumptions, request-load tradeoffs, cancellation/stale-response protection, keyboard/screen-reader behaviour, empty/error recovery and explicit-submit fallback are specified with reproducible evidence rather than an invented competitor claim. Cheaper substitute: adopting a latency number without measurement. Source: §4 completion suggestion.
- [x] Record coordinator keep/defer/authorize-design disposition and reversal cost in `docs/specs/2026-11-04-admin-search-interaction-proposal.md`. Done when: the proposal remains separate from X1 until approved, and any new implementation is filed with its design and tests before starting. Cheaper substitute: silently changing the approved surface or rewriting §4's receipt. Source: coordinator scope decision.
- [x] Commit: `design: record admin search interaction proposal decision`

**Test checkpoint:** `python3 scripts/todo-graph.py validate` passes, and the proposal records reproducible measurements or explicit unknowns plus a coordinator disposition; X1 and §4 review receipts remain unchanged unless a later supported policy decision authorizes their owning changes.

> **Verified:** 2026-11-04 | §7 | f981e6abb1380c237d77aed9aa975f1bb22f65d7
> **Review:** `docs/reviews/d07-t05-s7.json`

## Verification

- `/admin` is double-locked (Access and JWT) and shows organisations, spend against caps and invite codes.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
