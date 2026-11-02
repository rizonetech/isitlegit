---
schema_version: 1
id: email-intake
domain: 01-intake
status: active
title: "TODO-01 -- Email Intake, Case Store and Pipeline Skeleton"
track: day-1
---

# TODO-01 -- Email Intake, Case Store and Pipeline Skeleton

> **Goal:** A member forwards a suspicious email to `check@isitlegit.co.za`; the Worker accepts it only from a member's verified domain, stores the raw message and its attachments in R2, records a case in D1, parses the MIME (and Outlook `.msg`), knows whether the original headers came along, and runs a durable `AnalysisWorkflow` that ends in a stored verdict (a stub until the checks land) or a clearly marked partial report.

> **Current state:** Measured 2026-10-26 20:00 SAST. No Worker code exists yet; D00 T01 §2 to §5 create the package, the test pool, CI and the Cloudflare bindings (`DB`, `ARTEFACTS`, `CACHE`, `ANALYSIS`, `BROWSER`). Better Auth and the member tables come from D07 T02. Outbound replies come from D01 T02.

## Inputs

- `docs/specs/2026-10-26-phishing-invoice-analyser-design.md` sections 4 (architecture), 4.1 (intake), 4.2 (parsing), 4.8 (tenancy, retention) and 11 (decisions).
- `docs/specs/2026-10-26-tech-stack-design.md`: Workflows over Queues, R2 layout, `postal-mime` 4.1.4, `@kenjiuno/msgreader` 1.29.0.
- RFC 5322 (message format), RFC 2045 to 2049 (MIME), RFC 2046 section 5.2.1 (`message/rfc822`).
- -> XREF: D07 T02 §5 -- the verified member domains and addresses the email handler admits
- -> XREF: D01 T02 §3 -- the reply that closes the loop for every accepted case
- -> XREF: D99 T01 §9 -- the domain recovery runbook whose move off Cloudflare waits on §15
- -> XREF: D07 T03 §9 -- the report header that draws the stored subject and sender
- -> XREF: D07 T04 §7 -- the Cases list rows and search that read them
- -> XREF: D07 T03 §20 -- the report's "Retry the check" button, which calls §17's `retryCase` and polls the new run by `run_id`

## Outcome

- A fixture email from a verified member domain creates exactly one case row, one raw object under `raw/<caseId>/message.eml`, one artefact per attachment, and one Workflow instance whose id is the case id.
- A fixture from an unknown sender creates nothing and sends nothing.
- The Workflow ends every case in `done` (stub verdict) or `partial` (named failed step), never silently.

**Adjacency:** list=applicable @ D07 T04 §1; document=applicable @ D07 T03 §1; settings=not-applicable (intake has no tunables beyond the size limits fixed in code from spec 4.8); reporting=applicable @ D07 T04 §2; notifications=applicable @ D01 T02 §3; permissions=applicable @ D01 T01 §3; audit=applicable @ D01 T01 §7; exchange=not-applicable (cases are created by mail or upload, never imported in bulk); reverse=not-applicable (a forwarded email cannot be unsent; cases expire by retention, spec 4.8)

**Adjacency rationale:** Cases are listed and reported in the member console (D07 T04), the case document is the report page (D07 T03), and the member is notified by the reply (D01 T02). Permission is the sender check in §3. The Workflow's step events in §7 are the audit trail and feed the model trace.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Core D1 schema and migration runner | D00 T01 §5 | [x] |
| 2 | §2 | Case store and R2 artefact layout | §1 | [x] |
| 3 | §3 | Email handler for verified members | §2, D07 T02 §4, D07 T02 §5 | [x] |
| 4 | §4 | Forward-as-attachment detection | §3 | [x] |
| 5 | §5 | MIME parsing and attachment extraction | §4 | [x] |
| 6 | §6 | Outlook .msg parsing | §5 | [x] |
| 7 | §7 | AnalysisWorkflow skeleton, partials | §5 | [x] |
| 8 | §8 | Signed expiring report links | §1 | [x] |
| 9 | §9 | check@ routing and live smoke | §7, D01 T02 §3, D07 T06 §9, D07 T02 §10 | [x] |
| 10 | §10 | Outlook report button for check@ | §9 | [ ] |
| 11 | §11 | Acceptance acknowledgement for a forward | §9, D01 T02 §3 | [ ] |
| 12 | §12 | Several originals in one forward | §7, D01 T02 §3 | [ ] |
| 13 | §13 | Compressed-RTF message bodies | §6 | [ ] |
| 14 | §14 | Near-limit forward on the | §9 | [ ] |
| 15 | §15 | Second inbound mail route | §9 | [ ] |
| 16 | §16 | Original's subject and sender stored on the case | -- | [x] |
| 17 | §17 | Retry of a failed check | D02 T01 §3 | [x] |
| 18 | §18 | Authorised mailbox checking, designed | -- | [ ] |
| 19 | §19 | A retried run's earlier findings kept apart | §17 | [x] |
| 20 | §20 | Earlier attempts readable on | §19 | [ ] |
| 21 | §21 | Mail checked | D02 T04 §8 | [ ] |
| 22 | §22 | Replay-scoped claims for the eval organisation | §3 | [x] |
| 23 | §23 | Auth outcomes stored before slower checks | §9 | [x] |

## 1. Core D1 schema and migration runner

> **Started:** 2026-10-27T12:05Z

Every later domain stores rows against a case. This section creates the first migration and the typed query layer, so cases, artefacts, evidence and step events have one owner (spec 4.8). Auth tables are owned by Better Auth (D07 T02) and are not created here.

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-27** (validation before build): Wrangler looks for migrations in `migrations/` unless the D1 binding names `migrations_dir`, so `wrangler.jsonc` sets it to `src/db/migrations`; the worker tests start from an empty in-memory D1, so they apply the migrations first (`readD1Migrations` in `vitest.config.ts`, `applyD1Migrations` in a setup file, the `@cloudflare/vitest-plugin` way); the tables enforce the spec's values with `CHECK` constraints (verdict `safe`, `suspicious` or `malicious`, the design spec's three verdicts in its opening section; severity `info` to `critical` per 4.3) and their ties with foreign keys (`ON DELETE CASCADE`, so deleting a case deletes its rows, which the POPIA deletion in 4.8 relies on); `case_events` gets an autoincrement `id` so "in order" has a key; the status transitions are named (`received` to `running`, `running` to `done` or `partial`, nothing else); and applying migrations to the live database becomes a written step of the deploy in `docs/operations.md`.

**Build order:**

1. Write `src/db/migrations/0001_core.sql` with `cases`, `artefacts`, `evidence`, `case_events`. Done when: `wrangler d1 migrations apply DB --local` applies it cleanly on an empty database.
2. Write typed helpers in `src/db/cases.ts`. Done when: tests create, read and update a case through them.

- [x] Set `migrations_dir` to `src/db/migrations` on the `DB` binding in `wrangler.jsonc`, and create `src/db/migrations/0001_core.sql` with table `cases` (`id` text primary key, `org_id` text not null, `channel` `CHECK` email or upload, `status` `CHECK` received, running, done or partial, `verdict` nullable `CHECK` safe, suspicious or malicious, `headers_available` integer 0 or 1, `created_at`, `updated_at`) and an index on `org_id, created_at`. Done when: `wrangler d1 migrations apply DB --local` reports the migration applied.
- [x] Add table `artefacts` (`case_id` `NOT NULL` referencing `cases` with `ON DELETE CASCADE`, `kind` `CHECK` raw, attachment, render, crop, page or audio, `r2_key` primary key, `sha256`, `media_type`, `bytes`) to the same migration. Done when: a test inserts and reads one row back, and deleting its case deletes it.
- [x] Add table `evidence` (`case_id` `NOT NULL` referencing `cases` with `ON DELETE CASCADE`, `id` the per-case `E1`, `E2` of D02 T01 §1, primary key `(case_id, id)` (**plan review 2026-10-27, P1**: a global key refuses the second case's `E1`), `check`, `severity` `CHECK` info, low, medium, high or critical, `summary`, `detail_json`, `artefact_keys_json`, `created_at`) per spec 4.3. Done when: a test round-trips one evidence row with its JSON fields intact, two cases each store and read back their own `E1`, a second `E1` in one case is refused, and a row with severity `severe` is refused by the database.
- [x] Add table `case_events` (`id` integer primary key autoincrement, `case_id` `NOT NULL` referencing `cases` with `ON DELETE CASCADE`, `step`, `status`, `model` nullable, `started_at`, `ms`, `cost_usd` nullable, `error` nullable) for the audit trail and the model trace. Done when: a test inserts two events and reads them in `id` order.
- [x] Prove the ownership rules on all three child tables (**plan review 2026-10-27, P2**). Done when: a test refuses a child row with a null `case_id` and one naming a missing case in each table, then deletes one populated case and finds its artefacts, evidence and events gone while another case's rows remain.
- [x] Apply the migrations in the worker tests: `vitest.config.ts` reads them with `readD1Migrations("src/db/migrations")` into a `TEST_MIGRATIONS` binding, and a setup file runs `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` before each test file. Done when: the tests above run against the migrated schema, and removing the setup file fails them.
- [x] Write `src/db/cases.ts` with `createCase`, `getCase`, `setStatus` and `setVerdict`, each validating input with zod and each scoped to an organisation: every member-facing read and mutation takes the `orgId` and matches it in the `WHERE` clause, so another organisation's case reads as missing and is never changed (**plan review 2026-10-27, P1**); the one trusted internal lookup by id alone (`getCaseForPipeline`, for the analysis workflow, which holds no member session) is named as such and exported separately. `setStatus` allows only `received` to `running` and `running` to `done` or `partial`; `setVerdict` takes only `safe`, `suspicious` or `malicious`; a refused transition or value, or a missing case, returns a typed error and changes nothing. Done when: `test/db/cases.test.ts` covers create and read; the allowed transitions with the stored status read back after each; a refused transition (`done` to `running`) and a refused value (`bogus`) with the stored row unchanged; a verdict written and read back, an invalid verdict refused with the stored verdict unchanged; both mutations on a missing case; and another organisation unable to read or change the case (**plan review 2026-10-27, P2**). Cheaper substitute: raw SQL strings at each call site.
- [x] Add the `pnpm db:migrate:local` and `pnpm db:migrate:remote` scripts to `package.json` (`wrangler d1 migrations apply DB --local` and `--remote`), apply `0001_core` to the live database (additive: four new tables), and add a "Database migrations" step to `docs/operations.md` (apply before deploying code that needs a new migration; a rollback never reverts one). Done when: `wrangler d1 migrations list DB --remote` reports no migrations to apply, and the page names the step.
- [x] Close the completion review's gaps: case ids are ULIDs (`src/db/ulid.ts`, which the artefact store in §2 requires); `setStatus` and `setVerdict` each make one statement (`UPDATE ... RETURNING *`) whose stored row is the answer, so a change made meanwhile shows; the migration scripts are operator tools, not CI gates, and no gate may touch the live database; and `docs/operations.md` gives the failed or interrupted migration's recovery (inspect, fix, retry, read back, deploy only after). Done when: `test/db/cases.test.ts` covers ULID ids, an interleaved change in both directions and one statement per successful change, each failing when its fix is mutated; `tests/scripts/test_worker_gates.py` passes and refuses a remote command as a gate; and a local rehearsal of a failing second migration is recorded on the page.
- [x] Close round 1's P3: `setStatus` and `setVerdict` validate the organisation and case ids as `getCase` does, refusing a malformed one before any SQL. Done when: `test/db/cases.test.ts` refuses a missing or empty id in every read and change with no statement prepared, and fails when `setVerdict` skips the check (checked by mutation).
- [x] Close the final review's findings: status and verdict are tied (a verdict only while `running`, `done` only with a verdict, `partial` with or without; a repeated finish answers the stored row, a different verdict after finishing is refused), so the workflow's finish (D01 T01 §7) is retry-safe; every query's database failure is a typed `database` refusal; migration `0002_evidence_order.sql` rebuilds the empty `evidence` table with `seq` tied to the id (creation order past `E9`) and JSON shape checks (`detail` an object, artefact keys an array), applied locally and live; the ULID comment states same-millisecond order truly; and the tests the review found thin now cover a missing id in every read, a change landing inside a call, and a package with a gate that would touch production. Done when: `test/db/cases.test.ts` and `test/db/schema.test.ts` cover each and five mutations (verdict outside running, done without a verdict, no repeated-finish answer, a thrown database error, no id check in the pipeline lookup) each fail them; `tests/scripts/test_worker_gates.py` fails when `--remote` is dropped from its rule; and `wrangler d1 migrations list DB --remote` reads "No migrations to apply" with `evidence` holding `seq` and `json_type`.
- [x] Commit: `db: core schema for cases, artefacts, evidence and step events`

Evidence 2026-10-27 14:30 SAST. `wrangler d1 migrations apply DB --local` (a scratch `--persist-to`) applied `0001_core.sql` ✅; `pnpm db:migrate:remote` applied it to the live `isitlegit` database ✅, `wrangler d1 migrations list DB --remote` then printed "No migrations to apply!", and `sqlite_master` lists `artefacts`, `case_events`, `cases`, `evidence`. `pnpm exec vitest run --project worker test/db`: 11 passed. Mutations, each failing the tests: the setup file removed (11 fail), `setStatus` accepting `bogus`, `setVerdict` storing nothing, a read ignoring `orgId` (1 fails each).

Evidence 2026-10-27 14:45 SAST, after the completion review: `pnpm exec vitest run --project worker test/db` 14 passed; mutations (UUID ids, a read before `setVerdict`, a patched earlier row) each fail it. The local rehearsal (a scratch copy of the config and migrations): `0001` applied and a case row inserted; a `0002` that created a table and then failed exited 1 with `no such table`, left `cases: 1, extra_table: 0, applied: 0001_core.sql` and `0002` pending; fixed, it applied alone and left `cases: 1, extra_table: 1, applied: 0001_core.sql,0002_extra.sql`. CI red at `0e8663f` (the scripts read as gates) fixed in `686930d`.

Evidence 2026-10-27 15:00 SAST, after the final review: `0002_evidence_order.sql` applied to a fresh local database after `0001` ✅; the live `evidence` table held 0 rows, `pnpm db:migrate:remote` applied `0002` ✅, `migrations list --remote` read "No migrations to apply!", and the live table's SQL has `seq` and `json_type`. `pnpm exec vitest run --project worker test/db`: 18 passed. The refused-move answer is read after the failed statement, so a concurrent change can make its message stale but never change the row (final review P3, accepted as stated in `src/db/cases.ts`); `getCaseForPipeline` stays a named, commented trusted lookup as the section requires (P3, accepted).

**Test checkpoint:** `pnpm exec vitest run test/db/cases.test.ts` passes, and fails when `setStatus` accepts `"bogus"`, when `setVerdict` stores nothing, or when a read ignores `orgId`.

> **Verified:** 2026-10-27 | §1 | 7db82ed402cc64ede44c502c93f3a994b85b9fff
> **Review:** `docs/reviews/d01-t01-s1.json`

## 2. Case store and R2 artefact layout

> **Started:** 2026-10-27T12:48Z

Raw mail and every artefact live in R2 under the case id; D1 holds only metadata (spec 4.2). The `raw/` prefix carries the 30-day lifecycle rule from D00 T01 §5, so raw content is never written elsewhere.

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-27** (validation before build): `attachmentKey` names the content's SHA-256, so it takes the hash, not only the name (`attachmentKey(caseId, sha256, name)`; likewise `artefactKey`); the derived kinds are the `artefacts.kind` values other than `raw` and `attachment` (`render`, `crop`, `page`, `audio`); and "in one step" cannot be one transaction across R2 and D1, so the order is fixed instead (**plan review 2026-10-27, P1 and P2**): the object is written first, create-only (`onlyIf` so an existing object is never replaced) with R2 verifying its SHA-256, then the row, inserted only if absent; nothing is ever deleted, so two overlapping puts cannot remove each other's work; an existing object or row is accepted only when its SHA-256 matches, otherwise the put is refused as a conflict; and a failure at either step returns a typed `StoreError` naming the step, never success, while a retry completes whatever is missing. An object left without its row (a row insert that failed and was never retried) is swept with the case by the account purge (D07 T02 §9), which lists objects by the case's prefixes, not by rows. The parsed summary (headers, text, HTML, attachment keys) is the message's content in another form, so it lives under `raw/` with the message and expires with it: `parsedKey(caseId)` is `raw/<caseId>/parsed.json`, kind `raw` (**plan review 2026-10-27, P1**; §5 and D01 T03 §1 corrected to match). Objects under `raw/` expire after 30 days (D00 T01 §5) while their rows stay, so a reader meets a missing object as expired, not as an error; the readers own that (the report, D07 T03).

**Build order:**

1. Write `src/intake/store.ts` with key builders and put helpers that hash content. Done when: tests show the exact keys and the SHA-256 in the artefact row.
2. Refuse writes outside the layout. Done when: a bad kind or case id throws before any R2 call.

- [x] Write `rawKey(caseId)` returning `raw/<caseId>/message.eml`, `parsedKey(caseId)` returning `raw/<caseId>/parsed.json`, `attachmentKey(caseId, sha256, name)` returning `raw/<caseId>/attachments/<sha256>-<safeName>`, and `artefactKey(caseId, kind, sha256, name)` returning `art/<caseId>/<kind>/<sha256>-<safeName>` for derived artefacts (`render`, `crop`, `page`, `audio`) in `src/intake/store.ts`. Done when: `test/intake/store.test.ts` asserts all three formats and fails if an attachment is written outside `raw/`. (**Corrected 2026-10-27**, D00 T01 §5 plan review: attachments were `art/` artefacts, outside the 30-day `raw/` lifecycle rule, though the design spec deletes raw messages and attachments after 30 days.)
- [x] Write `putRaw`, `putParsed`, `putAttachment` and `putArtefact` that compute SHA-256 with WebCrypto, write the object to `ARTEFACTS` create-only with the hash for R2 to verify and the media type, then insert the `artefacts` row if absent, by the rules above, plus `readArtefact(caseId, key)` answering the row and the bytes, or that the object is missing (expired or never completed). Done when: a test with the R2 binding reads each object back with its exact media type, size and SHA-256, and finds the matching row; the same put twice leaves the object's etag and upload time unchanged and one row; two overlapping puts of the same content both succeed and leave one readable object and one row; a second, different message for a case's fixed `raw/` key is refused as a conflict with the first kept; an R2 put that fails leaves no row and a D1 insert that fails is reported, and each completes on retry; an upload whose bytes do not match the hash R2 is given is rejected by R2 and publishes no row; and the parsed summary round-trips through `putParsed` and `readArtefact`. Cheaper substitute: storing bodies in D1 blobs.
- [x] Sanitise attachment names (path separators, control characters, length cap 120) before they enter a key. Done when: a test with `../../x.eml` and a 500-character name yields a safe key.
- [x] Refuse a case id that is not a ULID (`isUlid`, `src/db/ulid.ts`), a derived kind outside `render`, `crop`, `page` and `audio`, and a hash that is not 64 lowercase hex characters, before any R2 or D1 call. Done when: each raises a typed `StoreError` in tests, with no R2 or D1 call made (counted).
- [x] Close the completion review's in-scope gaps: when the object already exists, its stored media type is the one recorded and answered, so R2, D1 and the result agree whichever writer won; reading the body is inside the storage boundary, so a transfer cut off after its headers is a typed `storage` failure; and a 25 MiB attachment, the intake limit, is written and read back with its hash checked, timed. Done when: `test/intake/store.test.ts` covers a later writer declaring the same bytes differently (after a failed row, and overlapping), a body cut off then read on retry, and the 25 MiB round trip; removing either fix fails it (checked by mutation).
- [x] Close round 1's two P3s: the row is checked before anything is written, so other content for a fixed key whose object has expired is refused with nothing written (the same content restores the object), and the 25 MiB test hashes the bytes read back. Done when: `test/intake/store.test.ts` covers the expired-key conflict with no put made, and fails without the row check (checked by mutation).
- [x] Close the final review's findings: restoring an expired object takes its row's media type, so R2, D1 and the answer agree (P2); one read before any write confirms the case exists (an object for no case could never be swept) and finds the key's row; names are cut by characters, never halving one; an object that vanishes mid-write is a retryable `storage` failure, and one without a stored checksum is checked by its bytes; hashing is inside the typed boundary and `putParsed` refuses anything that is not a JSON object; `readArtefact`'s comment names expiry and out-of-band deletion only; and the tests cover all four derived kinds and the read path's ULID refusal. Done when: `test/intake/store.test.ts` covers each and five mutations (no restored media type, no case check, names cut by UTF-16 units, a vanished object as a conflict, no byte check without a checksum) each fail it.
- [x] Close round 2's P3: an object found without a checksum that is gone before its bytes are read is a retryable `storage` failure, like one gone before `head`. Done when: `test/intake/store.test.ts` covers it and fails without the check (checked by mutation).
- [x] Commit: `intake: case store and R2 artefact layout`

Evidence 2026-10-27 15:20 SAST. Probed first in Miniflare's R2: a create-only put (`onlyIf: { etagDoesNotMatch: "*" }`) answers `null` when the object exists and keeps the first content; a put whose bytes do not match `sha256` throws "The SHA-256 checksum you specified did not match"; `head` returns the stored SHA-256. `pnpm exec vitest run --project worker test/intake`: 12 passed. Mutations, each failing it: `rawKey` under `art/`, no `onlyIf`, no `sha256`, no path separators removed from names, no ULID check.

Evidence 2026-10-27 15:15 SAST, after the completion review: `pnpm exec vitest run --project worker test/intake` 15 passed; 25 MiB in local Miniflare, three runs: write 452, 461, 433 ms and read 48, 50, 27 ms, no memory failure (local only: it shows the limit works, not live R2 speed, and no speed claim is made). Mutations: the stored media type not kept, the body read outside the boundary; each fails its test.

**Test checkpoint:** `pnpm exec vitest run test/intake/store.test.ts` passes and fails if `rawKey` stops using the `raw/` prefix.

> **Verified:** 2026-10-27 | §2 | d8e4d99612b1ecaf355a289c08e42bcb52068652
> **Review:** `docs/reviews/d01-t01-s2.json`

## 3. Email handler for verified members

> **Started:** 2026-10-28T06:15Z

The `email()` handler is the front door (spec 4.1). Only mail from a verified member domain or registered sending address is processed; everything else is dropped without a reply, which prevents abuse and backscatter. Counterparty mail for protected identities joins later through D05 T02 §1, which extends this gate.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/intake/email.ts` exporting the `email` handler. Done when: a fixture from a member domain creates a case and starts a Workflow; an unknown sender does neither.
2. Enforce the size limit. Done when: a 26 MiB message is rejected with `setReject` and no case.
3. Claim the delivery, admit the case, store the raw message, start the Workflow, in that order, each failure undone or left to a recoverable claim. Done when: a delivery interrupted at each step is either undone or completed by the sweep, never left as a case with no Workflow. (**Corrected 2026-10-28**, plan review: the order was not stated.)

- [x] Write `handleEmail(message, env, ctx)` in `src/intake/email.ts` reading `message.from` and the raw stream once into an `ArrayBuffer`. Done when: a test passes a synthetic `ForwardableEmailMessage` and gets a case id back.
- [x] Admit the sender only when Email Routing's own authentication of it holds, in `senderAuthenticated(raw, from)` in `src/intake/sender.ts`: the topmost `Authentication-Results` header of the raw message (the one Email Routing adds; lower ones may be written by anyone) shows `spf=pass` with `smtp.mailfrom` at the envelope sender's domain, or `dkim=pass` with a `header.d` whose registrable domain is the sender's. Only `header.d` names the signer; `header.i` is the identity and proves nothing alone, and a header block the parser will not read proves nothing (**Corrected 2026-10-28**, final review). Email Routing rejects only on the sender's own DMARC policy and otherwise needs SPF or DKIM to pass for any domain, so without this check an envelope `boss@member.co.za` signed by an unrelated domain reaches the gate. Done when: `test/intake/sender.test.ts` admits an aligned SPF pass and an aligned DKIM pass, and refuses a DKIM pass for another domain with SPF failing, a pass only in a lower header, a missing header and an unaligned subdomain trick (`member.co.za.evil.com`). Cheaper substitute: trusting `message.from` alone, which anyone can set. **Corrected 2026-10-28** (round 1): a sender admitted by a single verified address, not its domain, must prove the mailbox: the message's From is that address and a DKIM signature by its domain passed; a domain-level pass is not enough there, since any other user of a shared provider passes DKIM for its domain (`memberOfSender` says which). **Corrected 2026-10-28:** added; the section assumed Email Routing authenticated the envelope sender, and its documentation says it does not align it (Postmaster: "The email must either pass SPF or be correctly signed with DKIM").
- [x] Call `findMemberBySender(env.DB, from)` from D07 T02 §5 (**Corrected 2026-10-28:** said `findMemberBySender(from)`; it takes the database) for an authenticated sender, and drop the message (no reply, no case) when the sender is unauthenticated or the lookup returns null. Done when: `test/intake/email.test.ts` shows an unknown sender and a spoofed member sender each leave `cases` empty, store nothing and call no mail sender. Cheaper substitute: replying "not registered", which creates backscatter.
- [x] Reject messages over 25 MiB with `message.setReject("Message too large")` (Email Routing limit, stack doc). Done when: a test with a 26 MiB body is rejected and stores nothing.
- [x] Add migration `src/db/migrations/0016_intake.sql`: `intake_messages` (`org_id`, `message_key`, `state` pending or done, `case_id` nullable, `claimed_at`; primary key `org_id, message_key`) and two `cases` columns, `forwarded_by` (the admitted envelope sender, lowercased; null for uploads) and `message_id` (the forward's `Message-ID`, null when it has none), with `admitCase` taking `forwardedBy` and `messageId`. Done when: `test/node/` applies the migration to a copy of the schema and `test/db/cases.test.ts` reads both columns back from an admitted case. Cheaper substitute: deriving the reply recipient later from the raw `From` or `Reply-To`, which an attacker writes. **Corrected 2026-10-28** (plan review): nothing stored the forwarder D01 T02 §3 replies to.
- [x] Claim the delivery before anything else is written, in one statement on `intake_messages`: a new key is claimed `pending`; a `done` claim younger than 24 hours means a duplicate, dropped with no reply; a `pending` claim younger than five minutes (a delivery still being processed) makes the handler throw so the duplicate is retried later rather than dropped while the first may still fail; an older `pending` claim is taken over and its recorded case reconciled first (Workflow found: mark the claim `done` and drop; not found: delete that case and its raw object, then process afresh). `message_key` is the `Message-ID` or, without one, the SHA-256 of the raw message. Done when: `test/intake/email.test.ts` delivers the same fixture twice in turn (one case), twice at once (one case, the other delivery thrown for retry), after 24 hours (a second case), and over a stale pending claim with and without its Workflow (one case either way). Cheaper substitute: a KV key, which is eventually consistent, so two deliveries close together both pass. **Corrected 2026-10-28:** said a `CACHE` key with no states (plan review: a claim left by a failed delivery suppressed its retry for 24 hours).
- [x] Process a claimed delivery in this order: `admitCase` (§1, D07 T02 §4) with `forwardedBy` and `messageId`, the case id written to the claim, `putRaw` (§2: its artefact row names the case, so the case comes first), `env.ANALYSIS.create({ id: caseId, params: { caseId } })`, then the claim marked `done`. Done when: a test against the migrated D1 and R2 reads back one case with its `forwarded_by` and `message_id`, one raw object at `raw/<caseId>/message.eml` with its artefact row, one Workflow create with the case id as instance id, and a `done` claim naming the case. **Corrected 2026-10-28:** said "store the raw message ..., create the case ..., and start" (plan review: `putRaw` needs the case's id and row first).
- [x] When `admitCase` answers `capped`, delete the claim (so the same message forwarded after midnight SAST is processed) and send the forwarder one `notice` mail a day under the send key `cap:<orgId>:<SAST date>:<forwarder digest>` (**Corrected 2026-10-28**, round 1: the forwarder's address itself could pass the 200-character key limit), naming the organisation's configured cap (`org_limits.daily_cases`, else `DEFAULT_DAILY_CASES`): "today's limit of N checks is reached; it resets at midnight". A notice that `failed` is retried by the next capped forward that day (a failed send key can be claimed again); an `uncertain` one is settled by the reconciler (D01 T02 §5); a `refused` one sends nothing; none fails the delivery. Done when: a capped forward creates no case and sends one notice naming a configured cap of 3; a second capped forward the same day sends none; two capped forwards at once send one; a notice whose send failed is sent by the next capped forward; and the same message forwarded after midnight SAST creates a case. (Moved from D07 T02 §4, 2026-10-28: the email path is this section's.) **Corrected 2026-10-28** (plan review): the claim's fate on a cap, the send outcomes and the configured cap were unstated.
- [x] Let the allowlist in `src/mail/allowlist.ts` admit `reply` and `notice` mail to an address `findMemberBySender` resolves (a verified address, or any address at a verified domain), not only to users with a membership: a verified domain admits all its staff's forwards, and the cap notice and later the verdict reply go back to that forwarder. Done when: `test/mail/allowlist.test.ts` admits `reply` and `notice` to an address at a verified domain and to a verified address, refuses them at a pending or removed domain, and `renewal` stays members only. Cheaper substitute: none; without it a domain-admitted forwarder's notice and reply are refused. **Corrected 2026-10-28:** added; the allowlist (D01 T02 §2, written before D07 T02 §5) knew only users as members.
- [x] Undo or hand over a delivery whose later step fails, then throw so it is retried: an admission failure releases the claim; a raw-store failure deletes the case and any raw object and releases the claim; a Workflow create that throws is checked with `env.ANALYSIS.get(caseId)`, an instance found counting as started (the claim marked `done`), none found undone like a raw-store failure, and a check that itself fails leaving the claim `pending` with its case for the takeover above or the sweep below. A failed undo leaves the same. Done when: tests make the database, the bucket's `put`, `ANALYSIS.create` (once failing outright, once recording the instance and then throwing) and the undo each fail, and every one ends with either no case, raw object or claim, or one case with one Workflow after the retry or sweep. Cheaper substitute: deleting the case whenever create throws, which orphans a Workflow that did start. **Corrected 2026-10-28:** an unconditional undo (plan review: a create can succeed while its answer is lost). Whether Email Routing retries a delivery whose handler threw is not documented; D01 T01 §9's live smoke records what the sender sees.
- [x] Sweep intake claims in the scheduled run (`scheduled()` in `src/index.ts`, every 15 minutes): delete `done` claims older than 24 hours, and reconcile `pending` claims older than five minutes as the takeover does (Workflow found: `done`; not found: the case and raw object deleted, then the claim; a case the pipeline has moved past `received` is left to it and the claim marked `done`), at most 50 a run so a run stays bounded, the rest in the next run 15 minutes later (**Corrected 2026-10-28**, final review: the bound and the moved case were unstated). Done when: a test of the sweep leaves a 25-hour `done` claim deleted and a 1-hour one kept, completes a stale claim whose Workflow exists, removes a stale claim's orphan case and raw object, and touches no other organisation's rows. Cheaper substitute: leaving the rows, which keeps organisation-linked Message-IDs indefinitely. **Corrected 2026-10-28** (plan review): the claims had no deletion owner.
- [x] Export `email` from `src/index.ts` next to `fetch`, calling `handleEmail`. Done when: a test calls the default export's `email` with a synthetic `ForwardableEmailMessage` from a verified member and finds the case, the raw object and the Workflow create, and `pnpm typecheck` passes. Cheaper substitute: a dry-run bundle listing the handler, which an empty handler passes. **Corrected 2026-10-28:** the proof was `wrangler deploy --dry-run` (plan review: it does not exercise delivery).
- [x] Commit: `intake: email handler for verified members`

**Test checkpoint:** `pnpm exec vitest run test/intake/email.test.ts test/intake/sender.test.ts test/mail/allowlist.test.ts test/db/cases.test.ts` passes, and fails if the member check or the sender authentication is removed, a duplicate delivery creates a second case, a failed step leaves a case with no Workflow or a claim that blocks the retry, or the forwarder is not stored.

> **Verified:** 2026-10-28 | §3 | f114a62e87857a73af5a394ca5bac1c895405281
> **Review:** `docs/reviews/d01-t01-s3.json`

## 4. Forward-as-attachment detection

> **Started:** 2026-10-28T07:47Z

A normal Outlook or Gmail forward strips the original headers, which kills the authentication checks; the supported path is "forward as attachment" (spec 4.1). This section finds the original message inside the forward or records that the headers are missing.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/intake/forward.ts` returning the original message bytes, its format, `headersAvailable` and the path taken. Done when: fixtures for an attached `message/rfc822`, an attached `.eml`, an attached `.msg` and an inline forward give the expected result.
2. Store the outcome on the case. Done when: the case row's `headers_available` reads back 1 for an attached original and 0 for an inline forward.

- [x] Add synthetic fixtures `test/fixtures/forward/attached-rfc822.eml`, `attached-eml-file.eml`, `attached-msg.eml` and `inline-forward.eml` built from fictional senders (`AGENTS.md`: synthetic only), plus `attached-rfc822-inline.eml` whose `message/rfc822` part has no `Content-Disposition` (some clients send it so), `nested-forward.eml` whose attached original itself carries an attached message, `rfc822-and-eml.eml` (a `.eml` attachment before a `message/rfc822` part, so the type wins over the order), `eml-and-msg.eml` (a `.msg` before a `.eml`), `two-originals.eml` (two distinct `message/rfc822` parts) and `inline-with-pdf.eml` (an inline forward carrying an ordinary PDF). The `.msg` attachments are placeholder bytes named `*.msg`: §6 parses real ones. Done when: the ten files exist and contain no real address (**Corrected 2026-10-28** at start and after the plan review: the edge and competing-candidate fixtures added).
- [x] Write `extractOriginal(raw)` in `src/intake/forward.ts`, parsing the forward with `postal-mime` 4.1.4 (added by D01 T01 §3; `forceRfc822Attachments: true`, so an attached message is always kept as its own bytes and never merged into the forward's body) and choosing the first `message/rfc822` part, else the first attachment named `*.eml`, else the first `*.msg` (RFC 2046 section 5.2.1), and returning `{ original, format: "eml" | "msg", headersAvailable, path: "rfc822" | "eml" | "msg" | "inline", otherOriginals }`, where `otherOriginals` counts the further attached messages (any of the three kinds) that were not chosen, so a member who forwards two messages together is told only the first was checked rather than having one silently dropped. Only the outermost attachment is taken: an original that itself carries a message stays whole for §5. A forward `postal-mime` refuses (its limits: nesting, part count, header size) is a typed `ParseError`, not a crash. Done when: `test/intake/forward.test.ts` gets the inner message's exact bytes for the three attachment fixtures and the no-disposition one, the outer original for the nested one, the `message/rfc822` part in `rfc822-and-eml` and the `.eml` in `eml-and-msg` (each later in its message than the loser), the first original with `otherOriginals: 1` in `two-originals`, and `ParseError` for a forward past the parser's limits (**Corrected 2026-10-28** at start: said `extractOriginal(parsed)` with no parser named; the parser, its option, the return shape and the refusal were unstated; after the plan review: precedence, byte equality and the count of excluded originals).
- [x] Return `{ original: forwarderMessage, format: "eml", headersAvailable: false, path: "inline", otherOriginals: 0 }` for an inline forward, `original` being the forward's own bytes unchanged. Done when: `inline-forward` and `inline-with-pdf` each yield `headersAvailable: false`, `path: "inline"` and `original` byte-equal to the fixture (a PDF is not a message) (**Corrected 2026-10-28**, plan review: only the flag was checked, so empty or altered bytes passed).
- [x] Write `setHeadersAvailable(db, caseId, available)` in `src/db/cases.ts` (the pipeline's write by case id, like `getCaseForPipeline`: §3 admits every email case with `headers_available = 0` because it reads no MIME), changing only a case still `received` or `running`, in one statement returning the row, with the store's `CaseResult` refusals: `not_found` for no such case, `transition` for a `done` or `partial` one (left as it was), `database` for a failure. Done when: `test/db/cases.test.ts` sets 1 then 0 again (§6's correction) on a `running` case, sets 1 on a `received` one, gets the same row from a repeated write, and gets `transition` for `done` and `partial`, `not_found` for a missing id and `database` for an injected failure. (**Corrected 2026-10-28** after the plan review: the running case, the 1 to 0 correction, `partial`, the refusals and repeats were unproven.) (**Corrected 2026-10-28** at start: "the case row stores `headers_available = 0`" named no writer; the pipeline's `parse` step (§7) calls it.)
- [x] ~~Record which path was taken as an `intake.forward` evidence item (info severity) so the report can explain it.~~ Struck 2026-10-28 at start: evidence ids (`E1`, `E2`) come from `saveEvidence`, which D02 T01 §1 owns and which needs D01 T01 §7 first; writing rows here would duplicate it. The path travels in the result (`path`) and in §5's parsed summary, and D02 T01 §1 writes the `intake.forward` item from it.
> **Resolved:** the `intake.forward` evidence item naming the forward's path and `otherOriginals` -> XREF: D02 T01 §1. Resolved 2026-10-29 by D02 T01 §1 in `f88f338` and `34b5da2`: `forwardEvidence` in `src/checks/intake.ts` is E1 for every message, with the path and the further originals not checked (an uploaded file gets `intake.upload` instead).
> **Resolved:** the reply telling a member who forwarded several messages at once that only the first was checked -> XREF: D01 T02 §3. Resolved 2026-10-28 by D01 T02 §3 in `d15fbf3`: `buildReply` asks for each other original on its own when the summary's `forward.otherOriginals` is above 0, proven by the `two-originals` fixture's reply in `test/pipeline/reply-step.test.ts`.
> **Resolved:** confidence lowered when `headers_available = 0` (design spec 4.1), whichever path makes the verdict -> XREF: D04 T01 §4. Resolved 2026-11-01 by D04 T01 §4: both the agent path and its rules fallback cap confidence at 0.6 without headers (`test/agent/loop.test.ts`).
- [x] Commit: `intake: detect forward-as-attachment and missing headers`

**Test checkpoint:** `pnpm exec vitest run test/intake/forward.test.ts test/db/cases.test.ts` passes for all ten fixtures and the store's refusals, and fails if the inline case reports headers as available, a lower-precedence attachment wins, an excluded original goes uncounted, or inline bytes change (**Corrected 2026-10-28**, plan review).

> **Verified:** 2026-10-28 | §4 | a1780735ece282a620008418b5895daae0ba5547
> **Review:** `docs/reviews/d01-t01-s4.json`

## 5. MIME parsing and attachment extraction

> **Started:** 2026-10-28T09:22Z

`postal-mime` parses the original message into headers, bodies and attachments (spec 4.2). Every attachment and inline image becomes an artefact in R2; the parsed summary passes between Workflow steps by key, never by value (stack doc: 1 MiB step output limit).

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Add `postal-mime` 4.1.4 and write `src/intake/parse.ts`. Done when: a fixture parses into headers, text, HTML and attachments.
2. Store attachments and the parsed summary. Done when: R2 holds each attachment under `raw/<case>/attachments/` and the summary at `raw/<case>/parsed.json` (**Corrected 2026-10-27:** attachments sit under the 30-day `raw/` rule).

- [x] Add exact dependency `postal-mime` 4.1.4 to `package.json`. Done when: `pnpm install` resolves it. (Done in D01 T01 §3, commit `4bcc7fb`, for the sender check; noted at start 2026-10-28.)
- [x] Write `parseMessage(bytes)` in `src/intake/parse.ts` returning headers (as an ordered list, duplicates kept), `text`, `html`, and attachments with filename, media type, content id and bytes, by `postal-mime` 4.1.4 with `forceRfc822Attachments: true` (a message attached to the original stays an attachment, evidence of its own, rather than being merged into the original's body). Done when: `test/intake/parse.test.ts` checks a multipart fixture with two attachments and an inline image, and one carrying an attached message that comes back as an attachment (**Corrected 2026-10-28** at start: the attached-message handling was unstated).
- [x] Store each attachment with `putAttachment(store, caseId, name, bytes, mediaType)` (**corrected 2026-10-28** at start: the store comes first, `src/intake/store.ts`; **corrected 2026-10-27**, D01 T01 §2's plan review: `putArtefact` takes only the derived kinds) and inline images the same way, with their `content_id` in the summary; an attachment with no filename is stored as `attachment-<n>` by its order. Done when: the test reads each stored attachment back byte for byte with its media type, filename (or `attachment-<n>`) and content id as the summary names them, and a storage failure partway leaves no summary written, while the retry completes with one row per attachment and no conflict (the store's writes are create-only and idempotent, D01 T01 §2) (**Corrected 2026-10-28**, plan review: three rows proved neither bytes nor names nor the failure path). Done when: the test finds three artefact rows for the fixture.
- [x] Write the parsed summary (headers, text, html, attachment keys, and `forward` with §4's `path`, `headersAvailable` and `otherOriginals`; **corrected 2026-10-28**, D01 T01 §4 start: the forward's outcome had no home; its completion review: `otherOriginals`, which the evidence (D02 T01 §1) and the reply (D01 T02 §3) read, was missing) with `putParsed(store, caseId, summary)` (**corrected 2026-10-28**, plan review: the store comes first) to `raw/<caseId>/parsed.json`, written last, after every attachment is stored, so a summary never names an attachment that is not there (**corrected 2026-10-27**, D01 T01 §2's plan review: it is the message's content, so it expires with the message under `raw/`; it was `art/<caseId>/parsed/summary.json`). Done when: the test reads it back through the store against D1 and R2, its headers, text, html and attachment keys equal to the fixture's, its `forward` holding §4's three fields for the `two-originals` fixture (`otherOriginals: 1`) and an inline one, and it is under 1 MiB for the fixture.
- [x] Bound what `postal-mime` renders: its full parse turns a plain-text part into HTML, and an 8 MB crafted text part (`('&'.repeat(900)+'\r\n').repeat(8889)`) exhausted a 128 MiB heap (D01 T01 §4 round 1, which walks only the structure for that reason). Cut each text part to a stated limit (default 1 MiB, the rest kept in R2 and marked truncated in the summary) before rendering. How (**corrected 2026-10-28** at start, the "or parse it in a step whose failure ends the case `partial`" alternative struck: a crafted message would then always end without a verdict, an evasion): run `postal-mime`'s first stage (its line reader building the MIME tree, as D01 T01 §4 does, sharing that marked workaround in one module, `src/intake/mime.ts`), cut the body parts it would render (`text/plain` and `text/html` leaves that are not `Content-Disposition: attachment`; a text or HTML attachment is an attachment and keeps all its bytes) to 1 MiB each and to 2 MiB together across the message (the parts past the total cut to nothing), keep each cut part whole in R2 with `putAttachment`, then run `postal-mime`'s own remaining stages (collect, render, build) on the tree. The summary records the cut as `truncated`: one entry a cut part, with its media type, its artefact key, its full and kept byte counts, which D02 T05 §1 and D02 T07 §1 read to check the full parts and D02 T01 §1 reports. Done when: `test/intake/parse.test.ts` parses that message and one with twenty 800 KB text parts and an HTML part (each under the per-part limit, together over the total), `test/node/` parses both under a 128 MiB Node heap, an oversized text attachment keeps every byte, and the summary's `truncated` names each cut part's artefact (**Corrected 2026-10-28**, plan review: a per-part limit alone let twenty permitted parts exhaust 128 MiB; attachments were being cut; the overflow had no reader). Source: D01 T01 §4 round 1, 2026-10-28.
- [x] Treat a parse failure as a typed `ParseError` (§4's, from `src/intake/forward.ts`) that the Workflow turns into a partial report (§7): `postal-mime`'s limits (nesting, part count, header size) refused. Done when: a fixture past each limit raises `ParseError`, not a crash, and a message cut off mid-part parses into what it holds (**Corrected 2026-10-28** at start: said a truncated fixture raises `ParseError`; `postal-mime` reads a cut-off message leniently, so that check could not fail).
- [x] Commit: `intake: MIME parsing with attachments stored in R2`

> **Resolved:** links in a cut part's full text -> XREF: D02 T07 §1. Resolved 2026-10-31 by D02 T07 §1 (CI green on `b765c2e6`): `linksOf` in `src/checks/links.ts` reads each cut plain-text part whole from R2 in 64 KiB chunks carrying a URL across each edge, and each cut HTML part through `HTMLRewriter`, a link past the 1 MiB cut tested in `test/checks/links.test.ts`.
> **Resolved:** hidden text in a cut part's full HTML -> XREF: D02 T05 §1. Resolved 2026-10-31 by D02 T05 §1 in `bbd465d` and its review fixes: `hiddenTextOf` streams each cut HTML part's full artefact from R2 in its own charset through the hidden-text scan, its rules applied to the summary's HTML too, and a part it cannot scan (its object missing, its charset undecodable) is named in the stored coverage item.
> **Resolved:** the evidence item saying a body was cut for reading and that the full part was still checked -> XREF: D02 T01 §1. Resolved 2026-10-29 by D02 T01 §1 in `f88f338` and `34b5da2`: `truncatedEvidence` states the cut (each part, its sizes, the further parts kept only to the cut); its plan review moved the claim that the full part was checked to the checks that read it (D02 T07 §1, D02 T05 §1), so a check that fails leaves no such claim.

**Test checkpoint:** `pnpm exec vitest run test/intake/parse.test.ts` and `pnpm exec vitest run --project node test/node/parse-memory.test.ts` pass, and fail if duplicate headers are collapsed (the `Received` chain needs them), the total budget is passed, an attachment is cut, or a summary is written before its attachments.

> **Verified:** 2026-10-28 | §5 | d829a15dac92b4dac16470e453f9f440e6a1b20c
> **Review:** `docs/reviews/d01-t01-s5.json`

## 6. Outlook .msg parsing

> **Started:** 2026-10-28T10:17Z

Outlook users often drag a message out as `.msg` (OLE compound file). `@kenjiuno/msgreader` must run under `nodejs_compat` in Workers; if it does not, `.msg` is cut and the reply explains how to forward as `.eml` (spec section 8 cut list).

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Prove the library in the workers pool. Done when: a synthetic `.msg` fixture parses in a Vitest workers test, or the failure is recorded and §6 falls back.
2. Convert `.msg` to the same parsed summary as §5. Done when: the summary matches the `.eml` twin of the fixture field by field.

- [x] Add exact dependency `@kenjiuno/msgreader` 1.29.0, and `cfb` 1.2.2 as a development dependency for the fixture generator (it writes OLE compound files; **corrected 2026-10-28** at start: nothing could write a synthetic `.msg`). Done when: `pnpm install` resolves both and `NOTICE.md` lists them.
- [x] Create synthetic fixtures with `scripts/fixtures/msg-builder.ts`, written by `scripts/fixtures/make-msg.ts` (never from real mail; fictional senders): `invoice-request.msg` (transport headers, text, binary HTML in code page 1252 with non-ASCII text, a PDF, an inline image with `PidTagAttachContentId` referenced from the HTML as `cid:`, and an embedded Outlook message, attach method 5), its `.eml` twin, `invoice-request-draft.msg` (no transport headers), `rtf-only.msg` (a body only in `PidTagRtfCompressed`), and as refusals `not-a-msg.msg` (other bytes) and `truncated.msg` (a compound file cut short). Done when: the files exist, the generator is committed, and a test regenerates them and finds them equal to the committed files (**Corrected 2026-10-28**, plan review: inline images, embedded messages, code pages, RTF and unreadable files had no fixture).
- [x] When the `.msg` carries no `PidTagTransportMessageHeaders` (a draft or a message saved before sending), set the case's `headers_available` to 0 with `setHeadersAvailable` (D01 T01 §4), since §4 counts an attached `.msg` as having headers. Done when: a fixture without transport headers leaves the case at 0. Source: D01 T01 §4 start, 2026-10-28. (**Corrected 2026-10-28** at the final review: proven here by applying `parseMsg`'s `headersAvailable` for the draft fixture with `setHeadersAvailable` and reading the case row back as 0 in `test/intake/msg.test.ts`; the parse step that makes this call for every forward is D01 T01 §7's, its item applying the parser's header state.)
- [x] Write `parseMsg(bytes)` in `src/intake/msg.ts` returning §5's `ParsedMessage` with `headersAvailable` (false when there are no transport headers): headers from `PidTagTransportMessageHeaders`, read by `postal-mime` as a header block, in order with repeats; the text body; the HTML body from the binary `PidTagHtml` decoded in `PidTagInternetCodepage` (its label, else UTF-8), else the string `bodyHtml`, the code page's label kept as the `charset` of a cut part; each attachment's filename, declared type, bytes, `contentId` from `PidTagAttachContentId` and disposition (`inline` when it has a content id, else `attachment`); an embedded Outlook message (attach method 5) exported by `msgreader`'s `getAttachment` as `.msg` bytes and stored as an attachment of type `application/vnd.ms-outlook`; the text and HTML bodies cut to §5's limits with the full bytes kept in `truncated`. A file `msgreader` cannot read (it throws, or `getFileData` answers an `error`) is a `ParseError`, as is a message whose body is only compressed RTF (no text and no HTML), so §7 ends it partial naming why rather than as an empty message (**Corrected 2026-10-28**, plan review: embedded messages were to be counted as omitted on the false premise that they had no bytes; inline images, code pages, RTF-only bodies and returned errors were unstated). Done when: `test/intake/msg.test.ts` finds its headers, text, HTML (non-ASCII text intact) and PDF equal to `parseMessage` of the twin; the inline image stored with its content id and the stored HTML's `cid:` reference naming it; the embedded message stored as `.msg` bytes that `msgreader` reopens with its own subject; the draft without headers; a large body cut with its full bytes and code page kept; `rtf-only`, `not-a-msg` and `truncated` each a `ParseError`; and `storeParsed` (§5) storing the result and its summary read back.
> **Deferred:** reading a body held only in compressed RTF -> XREF: D01 T01 §13 (**Corrected 2026-10-28** at start: the "§5 summary shape" is `ParsedMessage`, which `storeParsed` stores; the limits and embedded items were unstated.)
- [x] If the library fails in the workers pool, record the error in `docs/frontier-log.md` style under `docs/decisions.md`, make `parseMsg` throw `UnsupportedFormat`, and have the reply say to forward as attachment in Outlook's default format. Done when: either the parse test passes or the fallback test passes; never neither. (Not needed: probed 2026-10-28 at start, `msgreader` 1.29.0 reads the synthetic fixture inside the workers pool under `nodejs_compat`, subject, transport headers and attachment included; the parse test is the proof. A `.msg` it cannot read is a `ParseError`, which §7 turns partial.)
- [x] Commit: `intake: Outlook .msg parsing`

**Test checkpoint:** `pnpm exec vitest run test/intake/msg.test.ts` passes, and fails if the transport headers are dropped, the draft claims headers, a body passes §5's limits, the attachment's bytes differ from the twin's, an inline image loses its content id, an embedded message is dropped, non-ASCII HTML is garbled, or an RTF-only or unreadable file parses as an empty success (**Corrected 2026-10-28** at start: "passes" alone could not fail).

> **Verified:** 2026-10-28 | §6 | 5ed1fca1d309637b5181bc06a2669c8c4189af71
> **Review:** `docs/reviews/d01-t01-s6.json`

## 7. AnalysisWorkflow skeleton, partials

> **Started:** 2026-10-28T12:32:02Z

Cloudflare Workflows run the pipeline as durable steps (stack doc), so a failure resumes without repeating paid model calls. This section builds the skeleton every later check plugs into: parse, checks, verdict, reply. Each step writes a `case_events` row (the audit trail and the model trace source); any step failure after retries ends the case as `partial` with the failed step named, never as a confident verdict (spec 4.8, manifesto Reliability).

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** after the plan review (`docs/reviews/01-intake/D01-T01-s7.md`): the case was to be marked `done` in `store`, before `reply`, but the lifecycle forbids `done` to `partial`, so a reply failure could never end the case `partial`; a replayed `run` repeated `setStatus(running)` (a `transition` refusal on a running case) and its `done` check skipped an unfinished reply; a failure had no route to `reply`; the typed helpers' refusals (values, not throws) could pass unseen; `limit: 3` is four attempts, not three; the parse checks could pass on the outer forward; and `case_verdicts` lacked its cascade and its conflict proof. The items below are rewritten to the steps and checks that close each.

**Build order:**

1. Write `src/pipeline/analysis-workflow.ts` with steps `admit`, `parse`, `checks`, `verdict`, `store`, `reply` and `finish` (`fail` on a failure). Done when: a test run on a fixture case ends in `done` with a stub verdict.
2. Add the failure path. Done when: a forced failure in `checks` ends the case `partial` with an event naming the step, and the `reply` step still runs with that state.

- [x] Replace the D00 T01 §5 stub (one `accept` step) with `AnalysisWorkflow`, still exported from `src/index.ts` under that class name, which `wrangler.jsonc`'s binding `ANALYSIS` instantiates (`class_name`), with steps `admit`, `parse`, `checks`, `verdict`, `store`, `reply`, `finish`, and `fail` when a step fails, passing R2 keys and small values (never message bytes) between steps. Done when: `pnpm typecheck` passes and the workflow test creates its instances through `env.ANALYSIS`. (**Corrected 2026-10-28**, plan review P3: the class is exported as `AnalysisWorkflow`; `ANALYSIS` is the binding.)
- [x] Make every decision a step result, since Workflows replay `run` from the start with each finished step's result cached ([rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)): code outside a step decides only from step results. Done when: the replay tests below pass.
- [x] Write the `admit` step: `getCaseForPipeline`; `not_found` or `invalid` (no such case: the binding smoke's `smoke-<run>` instances, `src/smoke.ts`, or a case removed since) answers "skip" and the run ends with no further step, event or error; `database` throws so the step retries; a `done` or `partial` case answers "skip" (a finished case is never analysed twice); a `received` case moves to `running` with `setStatus`, and a case already `running` (a replayed or restarted run) is admitted as it is, never refused. Done when: a run for `smoke-test` and one for an unknown ULID both complete with no `case_events` row; a run on a `done` case writes no event; a run on a case left `running` with a stored verdict (a run interrupted between `store` and `reply`) completes `reply` and ends `done`; and an injected lookup failure is retried, not taken as a missing case. (**Corrected 2026-10-28** at start, from `src/smoke.ts` and `src/db/cases.ts` `NEXT`; and after the plan review, P1 2.)
- [x] Write `recordEvent(db, caseId, step, status, extra)` in `src/pipeline/events.ts`, a typed write answering a `CaseResult` with a `database` refusal rather than throwing, whose `error` column holds only an error class, never message content; call it at the start and end of each step with the duration, a refusal throwing so the step retries. Done when: a successful run leaves a `started` and a `done` event per step, read back in order; an injected event failure is retried and the run still ends with its rows; and the stored error of a failed run is a class name. (**Corrected 2026-10-28** at start: D01 T01 §1 completion item 10.)
- [x] Make the `parse` step read the raw message, call `extractOriginal` (§4) and parse the original it returns (§5's `parseMessage`, or §6's `parseMsg` for `format: "msg"`), store it with `storeParsed` (§5), and write the header state with `setHeadersAvailable` (§4): the parser's own `headersAvailable` for a `.msg` (§6: false without transport headers), applied to the case and to the `Forward` passed to `storeParsed`, so the case row and `parsed.json` agree. Any refused result fails the step (retried, then `fail`), so the checks never run on an unknown header state. It returns `parsedKey`. Done when: the inline fixture's case ends with `headers_available = 0` and the attached one's with 1, the attached `.eml`'s `parsed.json` holds the original's subject, body and attachment bytes (not the forward's), an attached draft `.msg` ends with `headers_available = 0` in the case row and `forward.headersAvailable: false` in `parsed.json`, read back from both, a storage failure on the first attempt is retried and the case still ends `done`, and a forced `database` refusal on every attempt ends the case `partial` naming `parse`. Source: D01 T01 §4 start and plan review, 2026-10-28; this section's plan review, P2 6.
- [x] Throw a `ParseError` (§4 to §6: a message the parsers refuse) from `parse` as a `NonRetryableError` (`cloudflare:workflows`), so a message that cannot be read goes to `fail` after one attempt naming `parse` and `ParseError`. Done when: a forward whose attached `.msg` is not a message ends `partial` after one attempt with that event. Source: D01 T01 §5 and §6, 2026-10-28 at start.
- [x] Add a stub `checks` step that reads the summary at the `parsedKey` it is given and returns no evidence, and a stub `verdict` step returning `suspicious` with headline "Analysis in progress: checks are not built yet" and confidence 0. Done when: the fixture case ends `done` with that stub verdict, and a `checks` step given a key with no summary fails (it reads the summary). Cheaper substitute: returning `safe`, which would mislead a member.
- [x] Add migration `0017_case_verdicts.sql` with `case_verdicts` (`case_id` primary key referencing `cases` with `ON DELETE CASCADE`, `verdict`, `headline`, `confidence` from 0 to 1, `reasons` and `actions` JSON arrays, `source`, `created_at`) and `saveVerdict(db, caseId, view)` in `src/db/verdicts.ts`: create-only, the same view again answering the stored row, a different one a `conflict` that changes nothing, a failure a `database` refusal. The `store` step calls `saveVerdict`, then `setVerdict`; it does not finish the case. Done when: `test/db/verdicts.test.ts` round-trips a view with reasons, actions and source, gets the same row from a repeat, gets `conflict` from a different view with the row unchanged, and deleting one case removes its verdict while another case's stays; and the fixture case's row reads back the stub's headline and confidence 0. (**Added 2026-10-28** at start: the verdict's headline, confidence and reasons had no store; D04 T01 §2 and D07 T03 §1 assume one. Default taken: a D1 table, so the report and the eval query it; reversing it costs one migration while no verdict is stored. Plan review P2 7: the cascade, the conflict and the round trip.)
- [x] Configure every step's `retries` as `limit: 3` (four attempts) with `delay: "2 seconds"` and exponential backoff ([sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)), and catch the error a step throws after its last attempt into the `fail` step: `recordEvent` with the step and error class, then `setStatus(partial)` (a repeated `partial` answers the stored row), each refusal retried. Done when: through `env.ANALYSIS` with sleeps disabled (`introspectWorkflowInstance`), `checks` failing three times then succeeding ends `done`, `checks` failing four times ends `partial` with an event naming `checks`, and `store` failing four times ends `partial` naming `store`. (**Corrected 2026-10-28**, plan review P2 5: `limit: 3` is four attempts.) (**Corrected 2026-10-28**, final review: each attempt records `started` then `done` or `error`, so a retried step's attempts balance; a failure is its own step `fail:<step>` with 11 attempts over about 85 minutes and writes its `failed` row once; `store` writes `case_verdicts` and `cases.verdict` in one batch (`storeVerdict`); a re-driven case reuses its stored summary. Not provable in the workers pool, so left to D01 T01 §9's live checks: a storage failure inside a running `parse` attempt, and a live instance interrupted and resumed; a database away for longer than the failure's 85 minutes leaves the case `running`, with no sweep yet.)
- [x] Run `reply` after `store` or after `fail`, with the case's report state: `{ status: "ready", verdict }` or `{ status: "partial", failedStep, errorClass }`, which needs neither a verdict nor a parsed summary. It sends nothing yet (D01 T02 §3 sends it, the partial message included); a reply failure after its last attempt goes to `fail` naming `reply`. Done when: the reply step's recorded input is `ready` on the fixture and `partial` with `checks` on the failed run, the mail stub sees no call, and `reply` failing four times ends the case `partial` naming `reply`. (**Corrected 2026-10-28**, plan review P1 1 and 3.)
- [x] Write the `finish` step, after `reply`: `setStatus(done)` for a run with no failure (a repeated `done` answers the stored row), so a case is `done` only once its reply step has run. Done when: the fixture case is `running` until `reply` has run (read in the reply step's test hook) and `done` after. (**Corrected 2026-10-28**, plan review P1 1: `done` was set in `store`.) (**Corrected 2026-10-28**, round 1: a `finish` that fails after its last attempt is recorded and ends the case `partial` through `fail`, and the reply already handed on stands rather than a second, contradicting one, which D01 T02 §3 could only send twice.)
- [x] Commit: `pipeline: AnalysisWorkflow skeleton with step events and partial reports`

**Test checkpoint:** `pnpm exec vitest run test/pipeline/analysis-workflow.test.ts` passes, and fails if a step failure leaves the case `running`.

> **Verified:** 2026-10-28 | §7 | c634452a308bfc97e086399cdf3a5eb1b3fd5550
> **Review:** `docs/reviews/d01-t01-s7.json`

## 8. Signed expiring report links

> **Started:** 2026-10-27T18:08Z

Reply emails carry a link to the report that opens without a session: HMAC-signed with `REPORT_LINK_SECRET`, scoped to one case and organisation, expiring after 7 days (stack doc, spec 4.8). A tampered or expired link is refused, never served.

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-27** (validation before build): there is no `ConfigError` in `src/` yet, so this section defines it; the Worker's secrets are typed in `src/types/secrets.d.ts`, which needs the new one; the stack doc already lists `REPORT_LINK_SECRET` (line 71); and the signature's input and the way the secret is set without being seen were not stated. The link must bind the case, the organisation and the expiry under a version label, so a signature made for another purpose or another link format can never pass.

**Build order:**

1. Write `src/web/report-link.ts` with `signReportLink` and `verifyReportLink`. Done when: round-trip, tamper, wrong-org and expiry tests pass.

- [x] Write `signReportLink(secret, caseId, orgId, now)` in `src/web/report-link.ts` producing `/r/<caseId>?o=<orgId>&e=<expiry>&s=<base64url HMAC-SHA256>` with WebCrypto, where the expiry is `now` plus 7 days in whole seconds and the signed text is the JSON array `["report-link:v1", caseId, orgId, expiry]` (unambiguous whatever an id holds); the case id must be a ULID (`isUlid`, `src/db/ulid.ts`) and the organisation id keeps the case store's contract (`src/db/cases.ts`: 1 to 200 characters, so `org-a` is valid), percent-encoded in the URL. Done when: `test/web/report-link.test.ts` signs and verifies a link for a case created through `createCase` with organisation `org-a`, matches an HMAC-SHA256 test vector computed independently (outside the code under test) for a fixed secret, case, organisation and expiry, and refuses to sign a non-ULID case id. (**Corrected 2026-10-27**, plan review P1 1 and 2: organisation ids were wrongly required to be ULIDs, and no test proved the signature is keyed.)
- [x] Write `verifyReportLink(secret, url, now)` answering `{ caseId, orgId, expires }` or a refusal reason, comparing signatures in constant time (`crypto.subtle.timingSafeEqual`, as `src/smoke.ts` does) and refusing an expiry in the past, an expiry more than 7 days ahead, a repeated or missing parameter, and a path other than `/r/<caseId>`. A malformed signature (not base64url, or not 32 bytes once decoded) is a refusal, never a thrown decoder or comparison error. Done when: tests refuse a changed case id, a changed org id, a changed expiry, an expired link, an expiry more than 7 days ahead, a path other than `/r/<caseId>`, a missing signature, a signature that is not base64url, one of the wrong length, a repeated parameter, a signature over another version label, and a link signed with a different valid secret. (**Corrected 2026-10-27**, plan review P1 2 and P2 3.)
- [x] Define `ConfigError` in `src/web/report-link.ts` and refuse to sign or verify when the secret is missing or shorter than 32 bytes, and type `REPORT_LINK_SECRET?: string` in `src/types/secrets.d.ts`. Done when: a test with a missing and a 31-byte secret throws `ConfigError` for both calls. Cheaper substitute: a default secret, which would make every link forgeable.
- [x] List `REPORT_LINK_SECRET` among the Worker's secrets in `docs/specs/2026-10-26-tech-stack-design.md`. Already true: line 71 names it (`REPORT_LINK_SECRET` (HMAC)).
- [x] Generate 32 random bytes as base64url, store them in Conclave as "IsItLegit report link secret" through `conclave-op`, read them back, and set them with `wrangler secret put REPORT_LINK_SECRET` from the vault, piping the value so it is never printed or passed as an argument; record in `docs/operations.md` that replacing it invalidates every report link already sent. Done when: `wrangler secret list` names it, the vault item's value is 43 characters (counted, not shown), and the operations page holds the note.
- [x] Commit: `web: signed, expiring report links`

Evidence 2026-10-27 20:16 SAST. `src/web/report-link.ts` signs `/r/<caseId>?o=&e=&s=` with HMAC-SHA256 over `["report-link:v1", caseId, orgId, expiry]` and verifies in constant time; `ConfigError` refuses a missing or short secret; `REPORT_LINK_SECRET` is typed in `src/types/secrets.d.ts`. `pnpm exec vitest run --project worker test/web/report-link.test.ts`: 7 passed, including a case created through `createCase` with organisation `org-a`, the HMAC vector computed in Python (`7CS0TcXh...`), a different secret refused, organisation ids with `&`, `/`, a newline and 200 characters, and every refusal (changed case, organisation or expiry, another version label, expired, more than 7 days ahead, wrong path, eleven malformed shapes). Five mutations (the organisation not signed, an unkeyed hash, no expiry check, no distance check, a short secret allowed) each fail it; a sixth, the decoded-length check, survived because the 43-character pattern already guarantees 32 bytes, so the check was removed as unreachable. The vault item "IsItLegit report link secret" holds a 43-character value (counted, not shown), set on the Worker by a pipe from the vault; `wrangler secret list` names `REPORT_LINK_SECRET`, the new version `93c66446` serves 100%, and `node scripts/smoke.ts` passed on every binding in 14 s. `docs/operations.md` says replacing it invalidates every link sent.

**Test checkpoint:** `pnpm exec vitest run test/web/report-link.test.ts` passes, and fails if the comparison ignores the org id or if the signature is not keyed (the independent test vector and the different-secret refusal).

The absolute `https://` link a reply carries is built by D01 T02 §3 from a trusted origin, never from a request's host (plan review P2 4).

> **Verified:** 2026-10-27 | §8 | 7c100e4770a4a24c45b47b2b3c0a479f7e3161ff
> **Review:** `docs/reviews/d01-t01-s8.json`

## 9. check@ routing and live smoke

> **Started:** 2026-10-28T23:13Z

The zone `isitlegit.co.za` routes `check@` to the Worker's `email()` handler (stack doc). This section creates the rule and proves the whole loop on the live service with a synthetic fixture: forward in, stub reply out.

**Corrected 2026-10-29** (at start, checked against the live account): (1) the Worker has no route on the zone; it serves at `isitlegit.derick-f5a.workers.dev` (D00 T01 §5), so `/health` is read there, and `check@` is reached only through Email Routing; (2) the zone's routing rules today are `hello@`, `dmarc@`, `conduct@` and three `demo.` aliases, all forwarding to the operator's mailbox, with the catch-all disabled, so `check@` has no rule and mail to it is refused; (3) SMTP2GO sends only as isitlegit.co.za (D99 T01 §4) and intake identifies the forwarder by the envelope sender (`message.from`, §3), which for an SMTP2GO send is its return-path domain, not the From address, to be confirmed by the first live send before the test sender is chosen; a forward from the operator's own mailbox (the Microsoft 365 connector's forward) has envelope and From equal, as a member's would; (4) the live D1 was migrated to 0019 on 2026-10-29 (it had stood at 0002), so the case tables exist.

**Corrected 2026-10-29** (plan review): the SMTP2GO fixture send cannot model a member (finding 3 above, confirmed live: its envelope is SMTP2GO's bounce address), so the smoke forwards from the operator's own mailbox, `derick@rizonetech.com`, through the Microsoft 365 connector's forward (envelope and From agree, as for any member's forward), and that address is the one the test organisation verifies; a report link in the reply points at `PUBLIC_ORIGIN` (`https://app.isitlegit.co.za`), which has no route until D07 T06 §9 and no report page until D07 T03 §1, so this section proves the reply carries a link signed for its case and opening it live is D07 T03 §1's; the helper `scripts/send-fixture.ts` never existed and is replaced by `scripts/live-intake.ts`, run with `node` as `scripts/smoke.ts` is.

**Phase:** 1
**Needs:** cloudflare, live-mail
**Surface:** no

**Build order:**

1. Route `check@isitlegit.co.za` to the Worker. Done when: the routing rule reads back with the Worker as its action.
2. Forward a synthetic suspicious message from the operator's mailbox and read the reply. Done when: the reply arrives in that mailbox, threaded under the forward, with a link signed for the run's case.

- [x] Create a rule `check@isitlegit.co.za` to Worker `isitlegit` on zone `88aeec6df134bc59bfa16a25751241ef` (standing authorisation, `AGENTS.md`; Email Routing was enabled by D99 T01 §2). Done when: the Cloudflare API lists the rule enabled. Done 2026-10-28 23:12 UTC: rule `ba3c41f1cb86483d806607ec00f4958e`, enabled, action `worker` `isitlegit`, read back (`docs/live-checks.md`).
- [x] Log why a delivery was not admitted, before admission, without changing what is admitted: one `{"event":"intake","outcome":...}` line per delivery naming the outcome (`dropped`, `automatic`, `too-large`, `duplicate`, `capped`, `admitted`, or `retry` with the error's class when admission failed and was undone; **Corrected 2026-10-29** (final review): `retry` was missing; the platform marks that invocation's outcome `exception` in Workers Logs, since the handler throws for Email Routing to answer a temporary failure), and for a drop whether a member matched, the topmost `Authentication-Results` authserv-id and each method's result and aligned domain (no address, no Message-ID). Done when: `test/intake/email.test.ts` finds the line for a drop by an unknown sender and by a failed check, and no address in either. Done 2026-10-29: `handleEmail` logs `{"event":"intake","outcome":...}` for every delivery (the case id for an admission; for a drop `member` (null, `domain` or `address`) and `auth` from `authenticationSummary` in `src/intake/sender.ts`); `test/intake/email.test.ts` covers an unknown sender, a failed check and an admission with no address or Message-ID in any line, and fails on the previous handler.
- [x] Deploy the Worker after the gates pass (`AGENTS.md` deploy rule, migrations first). Done when: `/health` on `isitlegit.derick-f5a.workers.dev` returns the deployed SHA. Done 2026-10-29: deployed after the gates at each step (migrations first): `18f2cdc` for the live round trip, `66e1e65` and `eca2d4c` with the fault switch set for the fault test, `c949a42` with it empty, and the final review's removal of the switch in the deploy after it; `/health` read back each time.
- [x] Register the Rizonetech test organisation (an invite code from `scripts/invite-code.ts`, sign-up as `derick@rizonetech.com`) and verify that address through the address-claim flow (`POST /api/org/addresses`, the code read from the operator's mailbox). Needs D07 T06 §9 (the sign-in mail links to the app host) and D07 T02 §10 (**Corrected 2026-10-29** (at build): the first sign-in link sent to the operator's mailbox was consumed by its link scanner, so signing in needs links that survive one). Done when: `findMemberBySender` returns the organisation for the address, read back with `wrangler d1 execute --remote`. Done 2026-10-29: the Rizonetech test organisation signed up at 2026-10-28 23:39 UTC (a one-use invite code, never printed); `derick@rizonetech.com` claimed at 01:56:14 UTC through `POST /api/org/addresses`, its code ("Your IsItLegit verification code" from verify@, internetMessageId `<E1xMFNG-4o5NDgrwTl0-luEN@message-id.smtpcorp.com>`) read from the operator's mailbox and verified; `org_addresses` reads `verified` for the organisation.
- [x] Write `scripts/live-intake.ts`: given the forward's `internetMessageId` (read from Sent Items through the connector) and a deadline, it finds that run's case by its `message_id` in the live D1, waits for its status `done` and its `reply:<caseId>` send `sent`, and exits non-zero naming the cause on a timeout, a missing case, a failed analysis or an unsent reply, so an earlier run's case can never satisfy it. Done when: `test/node/live-intake.test.ts` drives it against a stand-in for each outcome. Done 2026-10-29: `test/node/live-intake.test.ts` (5 tests) covers the pass, a missing case at the deadline, a partial analysis, a failed, refused or still uncertain reply, two cases for one Message-ID, a failed read retried to the deadline, and a Message-ID that could leave the SQL literal.
- [x] Forward a synthetic suspicious message (sent first to `hello@isitlegit.co.za` through SMTP2GO, so it lands in the operator's mailbox, with a run token in its subject) from `derick@rizonetech.com` to `check@isitlegit.co.za` with the connector's forward, and run `scripts/live-intake.ts` on it. Done when: it exits 0 with the case id. If the intake log shows a drop, the cause is fixed at its layer and the forward repeated until admitted. Done 2026-10-29: "Updated banking details for invoice INV-2291 (live smoke run-0129a)" sent through SMTP2GO to hello@ (email id `1xMFNt-FnQW0hPzgkc-rPGf`), forwarded from `derick@rizonetech.com` to check@ at 01:57:14 UTC (forward internetMessageId `<ZR6PR08MB999924BA11F51F7848ECEED811B86E2@ZR6PR08MB999924.eurprd08.prod.outlook.com>`); the Worker logged `{"event":"intake","outcome":"admitted","caseId":"01M62P0FCKTGQ4A6YY7XNXE933"}` (envelope domain rizonetech.com, 13643 bytes); `node scripts/live-intake.ts --message-id <that id> --wait 300` exited 0: "case 01M62P0FCKTGQ4A6YY7XNXE933 done and its reply sent".
- [x] Read the reply in the operator's mailbox through the connector: its `In-Reply-To` is the forward's `internetMessageId`, and its report link is signed for the run's case (`verifyReportLink`, D01 T01 §8); record the case id, both message ids and the elapsed seconds in `docs/live-checks.md`. Done when: the file holds them. Opening the link live is D07 T03 §1's. Done 2026-10-29: the reply "Re: FW: Updated banking details for invoice INV-2291 (live smoke run-0129a)" from check@ to derick@rizonetech.com, sent 01:57:28 UTC (14 s after the forward), received 01:58:08, internetMessageId `<E1xMFOS-FnQW0hPzh2n-rLN5@message-id.smtpcorp.com>`, threaded in the forward's conversation; it carries the stub verdict (Suspicious, "checks are not built yet"), the inline-forward note (headers unavailable: forward as an attachment) and a report link `https://app.isitlegit.co.za/r/01M62P0FCKTGQ4A6YY7XNXE933?o=...&e=...&s=...` for the run's case. Recorded in `docs/live-checks.md`. **Corrected 2026-10-29** (at build): the link names the run's case and carries the signed `o`, `e` and `s` parameters; opening it live is D07 T03 §1's. Completion review 2026-10-29: the delivered URL, checked with `verifyReportLink` (`src/web/report-link.ts`) and the vault's "IsItLegit report link secret" (read into the process, never printed), answers `ok` for case `01M62P0FCKTGQ4A6YY7XNXE933` and the test organisation's id read from that case; since the Worker signed it, the vault's secret is the Worker's.
- [x] Record the topmost `Authentication-Results` header of the run's case (its `authserv-id` and the `spf=`, `smtp.mailfrom=`, `dkim=` and `header.d=` fields) from the stored raw message in `docs/live-checks.md`, and add it verbatim as a fixture to `test/intake/sender.test.ts`. Done when: `senderAuthenticated` (§3) admits the recorded header and the fixture test passes. Source: D01 T01 §3's sender check, written from RFC 8601 before a live header was seen. Done 2026-10-29: case `01M62P0FCKTGQ4A6YY7XNXE933`'s stored message (`raw/<case>/message.eml`) carries two Authentication-Results headers; the topmost is `mx.cloudflare.net; dkim=pass header.d=rizonetech.com header.s=selector2 ...; dmarc=pass header.from=rizonetech.com ...; spf=pass ... smtp.helo=...; spf=pass ... smtp.mailfrom=derick@rizonetech.com; arc=pass ...` (verbatim in `test/intake/sender.test.ts` and `docs/live-checks.md`); `senderAuthenticated` admits it as the verified address and as the verified domain, and refuses another address at that domain.
- [x] Deliver a message while the raw store is made to fail (a deployed variable naming one test sender, which makes `putRaw` throw for that sender only) and record what the sending side saw. Done when: the record names the outcome: a 4xx retry (and the retried delivery made exactly one case), a 5xx bounce, or silent loss; silent loss is a defect fixed at the intake's layer (the delivery refused so the sender is told) and the test repeated; afterwards the variable is removed, a deploy reads back without it, and one more forward reaches its reply. Source: D01 T01 §3's undo path; Email Routing does not document a thrown handler's outcome. Done 2026-10-29: with `INTAKE_FAULT_SENDER` naming the test sender (deployed `66e1e65`), a forward at 02:19:47 UTC reached the Worker (`{"event":"intake","outcome":"retry","error":"RetryDelivery"}`, the admission undone: no case, no claim); Email Routing answered the sending server a temporary failure, and Microsoft 365 retried it 32 minutes later, at 02:52:14 UTC, by when the fault was removed; the retry made exactly one case (`01M62S51XXVFCWAEJ541S0XPW8`, the forward's own Message-ID) and its reply was sent. The variable is empty in the deploy of `c949a42` (read back), and a later forward (case `01M62S4D1ZCZEQVE032FZJ6A6W`) reached its reply. **Corrected 2026-10-29** (at build): an 11-minute wait was first read as silent loss, and `eca2d4c` made the delivery refuse instead (a bounce, `555 5.7.1`, seen live at 02:50:56); the retry at 32 minutes showed the thrown retry works, so `c949a42` restored it. **Corrected 2026-10-29** (final review): the switch, a hook in the production handler, was removed once the fault test was done (`src/intake/email.ts`, `wrangler.jsonc`); a future fault test adds it back for its run.
- [x] ~~Send a near-limit forward (about 24 MiB: an attached original carrying twenty large text parts and several MiB of attachments) from a mailbox whose envelope is the verified member (the connector's forward refuses a message with attachments, so the transport is chosen and recorded at build), and confirm the deployed Worker and the Workflow's `parse` step finish it (Workers Logs / Tail). Done when: the record in `docs/live-checks.md` names the received `rawSize`, a successful `parse` event, the stored summary's `truncated` and its attachment records as the fixture predicts, with no `exceededMemory` or `exceededCpu` outcome; a later partial is acceptable only after those hold. Source: D01 T01 §5 completion review (Part 1 item 9: a Node heap limit is not the isolate's memory, which only the deployed Worker shows).~~ **Moved 2026-10-29** to §14: the forward must come from a member's mailbox, and this session has no transport for a 24 MiB message with attachments (the Microsoft 365 connector forwards no message with attachments, a Gmail send would carry the file inside one call, and SMTP2GO's envelope is not a member).
- [x] Bound `scripts/live-intake.ts` by its deadline (completion review, 2026-10-29): each read gets what is left of the budget, and a success seen after the deadline is refused. Done when: `test/node/live-intake.test.ts` reads twice past a one-second budget and finds the late success refused, and wrangler given no more than the read's time.
- [x] Commit: `intake: Email Routing for check@ with a live end-to-end smoke` (landed as `1f09b70`, `66e1e65`, `c949a42`, `04783f5`, `43e1127` and `977d967`, with the live records in `docs/live-checks.md`)

**Test checkpoint:** `node scripts/live-intake.ts --message-id <the forward's internetMessageId> --wait 300` exits 0 after finding that forward's case `done` with its reply `sent`, and `pnpm exec vitest run test/node/live-intake.test.ts test/intake/email.test.ts test/intake/sender.test.ts` passes.

> **Verified:** 2026-10-29 | §9 | 7b534283e9dce6acfcb1b731e4c8f7ba33b00f36
> **Review:** `docs/reviews/d01-t01-s9.json`

## 10. Outlook report button for check@

**Operator decision 2026-11-01 03:30 SAST (`docs/coordinator.md`):** skipped for the competition (a hands-on check).

Forwarding to `check@` takes at least three actions (forward, type the address, send), and keeping the original headers needs one more choice, forward as attachment (spec 4.1). Microsoft's own Report button in Outlook takes two selections from an open message. An IsItLegit button in Outlook can send the open message as an attachment to `check@` in at most two actions, with no address typed and the headers always kept (D01 T01 §3 completion review, Part 2 item 1). The email path stays as it is; the button is another way into it.

**Phase:** 7
**Needs:** attended
**Surface:** yes

**Fidelity:** `design/SPEC.md` gains an "Outlook report button" section (the button in the ribbon and the message's action menu, its confirmation and failure states) with its board; no board yet.
**Job:** a member reports the open message to IsItLegit in at most two actions, by keyboard or screen reader as well as by mouse, and the forward always carries the original as an attachment.
**Treatment:** one button labelled "Check with IsItLegit", one short confirmation, the IsItLegit mark; Outlook's own task-pane layout.
**Chrome:** Outlook's add-in surfaces only (the ribbon button and a task pane), no second window.

**Operator decision (2026-10-28 22:42 SAST):** build it once the core path (forward, verdict, report) is stamped and before the demo footage (D99 T02 §3), so the demo can show it; moved from Phase 7 to Phase 6 (Sun 1 to Wed 4 Nov), before the footage. The operator's Microsoft 365 admin deploys the add-in once (`attended`).

**Build order:**

1. Design the button and its states. Done when: the SPEC section and board name every control and state.
2. Build the add-in and prove it from Outlook on the web and the desktop. Done when: a report from each reaches `check@` as an attachment forward and makes one case.

- [ ] Add the "Outlook report button" section to `design/SPEC.md` (where the button sits, the confirmation, what a member sees when the send fails or the mailbox is not a member's), with its board in `design/mockups/`. Done when: the section and board exist and every control and state is named.
- [ ] Write the add-in manifest `addins/outlook/manifest.json` (unified manifest; read item permission only) with one command, "Check with IsItLegit", in the ribbon and the message action menu. Done when: `test/addins/manifest.test.ts` validates it against the schema and finds the one command and no permission beyond reading the item.
- [ ] Send the open message as an attachment to `check@isitlegit.co.za` from the add-in (`addins/outlook/report.ts`), using Office.js to attach the item, so its headers always travel with it. Done when: a test with a mocked Office.js item builds one message to `check@` with the item attached and no address typed by the member.
- [ ] Show the confirmation or the failure state in the task pane, both reachable by keyboard and announced to a screen reader. Done when: an accessibility test (axe) on the rendered pane finds no violations, and the failure state names what to do next.
- [ ] Sideload and report one fixture message from Outlook on the web and from the desktop, attended, from the operator's test mailbox. Done when: each report creates one case with `headers_available = 1` and the run is recorded in `docs/live-checks.md`.
- [ ] Commit: `intake: Outlook report button for check@`

**Test checkpoint:** `pnpm exec vitest run test/addins` passes and fails if the add-in asks for more than read access to the item, or sends the message inline instead of as an attachment.

## 11. Acceptance acknowledgement for a forward

> **Started:** 2026-11-02T21:20Z

After a forward, the member hears nothing until the verdict reply (D01 T02 §3), so a forward that was accepted and one that was lost look the same for up to a minute or more (D01 T01 §3 completion review, Part 2 item 2). A short acknowledgement can say the forward was received and give the case reference within seconds of admission. Silent refusal stays for senders intake does not admit (spec 4.1: no backscatter).

**Phase:** 7
**Needs:** none
**Surface:** yes

**Fidelity:** `design/SPEC.md` gains the acknowledgement's copy and layout beside the reply's (D07 T03 §7); no board yet.
**Job:** an admitted forward is acknowledged with its case reference within five seconds of admission, and only then; a refused one is never answered.
**Treatment:** plain text, two lines: received, the case reference, and that the answer follows; no verdict and no link.
**Chrome:** the reply's own mail template (D01 T02 §3), not a new one.

**Operator decision (2026-10-28 22:42 SAST):** no acknowledgement is sent: the verdict reply (N1) arrives within about a minute, and a second mail per check doubles the inbox noise for little gain. `design/SPEC.md` 0.7 records it; the send and measure items are struck.

**Build order:**

1. Decide whether the acknowledgement is sent, and its copy, in the SPEC. Done when: the SPEC records the decision and the copy, or records that none is sent and why.
2. Send it after admission and prove it is never sent for a refusal. Done when: an admitted forward gets one acknowledgement and a refused one gets nothing.

- [x] Record in `design/SPEC.md` whether an acknowledgement is sent (weighed against one more mail per check and the reply arriving within a minute), with its copy if so. Done when: the SPEC section states the decision with its reason. Done 2026-10-28: SPEC 0.7 records that none is sent, and why.
- [x] ~~Send the acknowledgement as mail kind `notice` under the send key `ack:<caseId>` from `handleEmail` (`src/intake/email.ts`) after the claim is marked done, its outcome never failing the delivery. Done when: `test/intake/email.test.ts` sees one acknowledgement naming the case reference for an admitted forward, none for a duplicate, a capped, a dropped or a too-large one, and none twice for a retried delivery.~~ **Struck 2026-10-28 (operator):** no acknowledgement is sent.
- [x] ~~Measure the time from the handler's start to the acknowledgement's send in the live smoke (D01 T01 §9's fixture). Done when: `docs/live-checks.md` records it under five seconds.~~ **Struck 2026-10-28 (operator):** no acknowledgement is sent.
- [ ] Commit: `intake: acceptance acknowledgement for a forward`

**Test checkpoint:** `pnpm exec vitest run test/intake/email.test.ts` passes and fails if a refused or duplicate forward is acknowledged, or one forward is acknowledged twice.


## 12. Several originals in one forward

A member who attaches several suspicious messages to one forward gets only the first checked and is asked to forward the rest one by one (§4 counts them; D01 T02 §3 says so). Outlook's own Report button takes several selected messages at once (D01 T01 §4 completion review, Part 2 item 2). Checking each attached original as its own case, with its own outcome, removes that extra work for the member, within the daily cap and the model budget.

**Phase:** 7
**Needs:** none
**Surface:** yes

**Fidelity:** `design/SPEC.md` gains the several-originals outcome: how the reply groups N verdicts, each with its own report link, and what a member sees when the cap admits only some of them; no board yet.
**Job:** one forward carrying N supported originals produces N cases with N independent outcomes, or as many as the daily cap admits with the rest named as not checked.
**Treatment:** one reply listing each original's subject and verdict on its own line with its report link; the existing single-case reply unchanged for one original.
**Chrome:** the reply template (D01 T02 §3) and the report page (D07 T03), no new surface.

**Build order:**

1. Decide the grouped reply and the cap behaviour in the SPEC. Done when: the SPEC section names both.
2. Admit one case per original and reply once. Done when: a forward with two originals yields two cases and one reply naming both.

- [ ] Add the several-originals outcome to `design/SPEC.md` (the grouped reply, each report link, the partly capped case, an upper bound on originals a forward, defaulting to 5). Done when: the section exists with the bound stated.
- [ ] Make `extractOriginal` (`src/intake/forward.ts`, §4) return every supported original in order (up to the bound) rather than the first and a count, keeping the precedence of §4 for each. Done when: `test/intake/forward.test.ts` gets both originals of `two-originals` in order and the bound's excess counted.
- [ ] Admit one case per original under the daily cap in the Workflow's `parse` step (§7), each with its own Workflow, linked to the forward's delivery claim (§3) so a retried delivery makes none twice. Done when: a test with two originals makes two cases and two Workflows, a retry makes none, and a cap of one admits the first and names the second as not checked.
- [ ] Send one grouped reply for the forward once every case has its verdict (D01 T02 §3's template), instead of one reply per case. Done when: the two-originals fixture's reply lists both subjects, verdicts and report links, and a single-original forward's reply is unchanged.
- [ ] Commit: `intake: several originals in one forward`

**Test checkpoint:** `pnpm exec vitest run test/intake/forward.test.ts test/intake/email.test.ts` passes and fails if a second original is dropped unseen, a retried delivery makes a case twice, or the cap is passed.


## 13. Compressed-RTF message bodies

Outlook can store a message's body only as compressed RTF (`PidTagRtfCompressed`), with no plain-text or HTML body (Microsoft, "Supporting formatted text in outgoing messages"). §6 refuses such a `.msg` as a `ParseError`, so its case ends partial naming why rather than as an empty message (D01 T01 §6 plan review, finding 5). This section reads those bodies.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Decompress and de-encapsulate. Done when: an RTF-only fixture yields its text, and one encapsulating HTML (`\fromhtml1`) yields that HTML.

- [ ] Decompress `PidTagRtfCompressed` ([MS-OXRTFCP]) in `src/intake/rtf.ts`, bounded to §5's body limits, refusing a stream whose declared size exceeds them. Done when: `test/intake/rtf.test.ts` decompresses the §6 `rtf-only.msg` body and refuses a stream claiming 50 MiB.
- [ ] De-encapsulate HTML from RTF that carries `\fromhtml1` ([MS-OXRTFEX]), else extract the plain text (control words dropped, `\par` and `\line` as line breaks, `\'xx` decoded in the RTF's code page). Done when: an HTML-encapsulating fixture yields its HTML and a plain RTF one its text, non-ASCII intact.
- [ ] Use it in `parseMsg` (§6) when there is no text and no HTML body, instead of the `ParseError`. Done when: `rtf-only.msg` parses with its text, and a message with text or HTML ignores its RTF.
- [ ] Commit: `intake: compressed-RTF message bodies`

**Test checkpoint:** `pnpm exec vitest run test/intake/rtf.test.ts test/intake/msg.test.ts` passes and fails if an RTF-only message parses empty or a decompression passes the body limits.


## 14. Near-limit forward, live

**Operator decision 2026-11-01 03:30 SAST (`docs/coordinator.md`):** skipped for the competition (a hands-on check).

A forward near Email Routing's 25 MiB limit must finish on the deployed Worker and its Workflow's `parse` step without running out of memory or CPU, which only the deployed isolate shows (D01 T01 §5 completion review, Part 1 item 9: a Node heap limit is not the isolate's memory). Moved from §9 on 2026-10-29: the forward has to come from a member's own mailbox, and this session has no transport for a 24 MiB message with attachments.

**Phase:** 7
**Needs:** operator, live-mail
**Surface:** no

**Operator action (open):** from Outlook as `derick@rizonetech.com` (the Rizonetech test organisation's verified address), forward to check@ the near-limit fixture message this section names, as an attachment, and say when it is sent.

**Build order:**

1. Make the near-limit message. Done when: an .eml of about 24 MiB, an attached original carrying twenty large text parts and several MiB of attachments, is in the operator's mailbox.
2. Forward it live and read the outcome. Done when: the record names the received size, a successful `parse` event and the stored summary.

- [ ] Write the near-limit message (`scripts/near-limit-eml.ts`, deterministic, about 24 MiB: twenty large text parts and several MiB of attachments in an attached original) and send it to `hello@isitlegit.co.za` through SMTP2GO, so it lands in the operator's mailbox. Done when: the operator's mailbox holds it, its size recorded.
- [ ] After the operator forwards it to check@ as an attachment, read the Worker's logs (`wrangler tail`) and the case. Done when: `docs/live-checks.md` names the received `rawSize`, a successful `parse` event, the stored summary's `truncated` and its attachment records as the message predicts, with no `exceededMemory` or `exceededCpu` outcome; a later partial is acceptable only after those hold.
- [ ] Commit: `intake: a near-limit forward proved on the live Worker`

**Test checkpoint:** `docs/live-checks.md` holds the near-limit run's `rawSize`, its `parse` event and its summary, with no memory or CPU outcome.

## 15. Second inbound mail route

**Operator decision 2026-11-01 03:30 SAST (`docs/coordinator.md`):** skipped for the competition (a hands-on check).

`check@isitlegit.co.za` reaches the Worker only through Cloudflare Email Routing (§9), which exists only while Cloudflare serves the zone, so a nameserver move away from Cloudflare would silently end intake. D99 T01 §9's runbook stops a move off Cloudflare at its preparation step for that reason; this section builds the second route that lets the move go ahead. Filed 2026-10-29 from D99 T01 §9's completion review (gap 15, missing-out-of-scope); a campaign scope decision: nothing is planned that needs it before Phase 7, so it sits there, and the runbook's refusal stays until it stamps.

**Phase:** 7
**Needs:** operator
**Surface:** no

**Build order:**

1. Choose the route. Done when: the section records the chosen inbound provider (an MX host that hands each message to an HTTPS endpoint), its size limit against §9's 25 MiB, its authentication of the hand-off, and its cost, with the alternatives weighed.
2. Accept its hand-off in the Worker. Done when: a signed request carrying a raw message reaches the same `handleIncoming` path the `email()` handler uses, and an unsigned or replayed one is refused.
3. Prove it end to end without moving the zone. Done when: a forward to a test address on the new route creates a case and gets its reply.
4. Write the move into the runbook. Done when: D99 T01 §9's procedure (a) names the route switch, its read-back and its rollback in place of the refusal.

- [ ] Record the inbound provider choice in this section (an MX-to-HTTPS service: its message size limit, its hand-off signature, its retry on a failed hand-off, its price), citing each provider's documentation. Done when: the record names the choice and why it beat each alternative.
- [ ] Add the hand-off endpoint (`src/intake/inbound-http.ts`, routed from `src/index.ts`), verifying the provider's signature and a timestamp window before reading the body, and passing the raw message to the same intake function the `email()` handler calls. Done when: `test/intake/inbound-http.test.ts` proves a signed message creates one case, and an unsigned, wrongly signed, stale or replayed request creates nothing. Cheaper substitute: a shared secret in the URL (refused: it leaks into logs).
- [ ] Refuse a message over §9's limit at the endpoint with the same outcome the `email()` path gives. Done when: the test shows an oversized hand-off refused and logged, no case created.
- [ ] Store the provider's signing secret in the vault first and then on the Worker (`wrangler secret put`), never printed. Done when: `pnpm exec wrangler secret list` names it and the vault item exists.
- [ ] Prove the route live on a test address of the new provider, without moving the zone. Done when: `docs/live-checks.md` records a forward that made a case and its reply, with the provider's message id.
- [ ] Replace the refusal in `docs/operations.md` "Domain recovery" (a) with the route switch (the MX change, its read-back, a forward that gets its reply) and its rollback (the MX back to Email Routing). Done when: procedure (a) no longer stops at step 1 for a move off Cloudflare and `tests/scripts/test_check_domain.py`'s runbook test still passes.
- [ ] Commit: `intake: a second inbound route, so the zone can leave Cloudflare`

**Test checkpoint:** `pnpm exec vitest run --project worker test/intake/inbound-http.test.ts` passes, and `python3 -m pytest tests/scripts/test_check_domain.py` passes.

## 16. Original's subject and sender stored on the case

Filed 2026-10-30 at the app lane's request, through the coordinator: the report header (design spec M3; the app lane's D07 T03 §9, "Report header") shows the checked message's subject and its sender, so the case carries them from intake. They come from the original the case was opened for (the attached message of a forward, or an uploaded `.eml` or `.msg`), never the forward around it: a forward's own subject and From are the member's.

> **Started:** 2026-10-30T16:40Z

**Corrected 2026-10-30** (at start, checked against the repository): (1) a `.msg` without transport headers still carries its subject and sender as properties (PidTagSubject, the sender's name and SMTP address), so `parseMsg` in `src/intake/msg.ts` returns them and they are used when the headers lack a Subject or From; (2) an inline forward's "original" is the forward itself (`extractOriginal` in `src/intake/forward.ts`, path `inline`), whose Subject and From are the member's, so all three stay null; (3) the fields are written before the summary is stored, as the header state is, because a re-driven case returns early once its summary exists and would never write them after; (4) "one line" means control and bidirectional formatting characters removed and whitespace runs collapsed, then a cut at 300 code points ending in an ellipsis; (5) an uploaded `.eml` is the original itself, so its Subject and From are taken whatever its header state; (6) `getCase` in `src/db/cases.ts` already scopes by organisation, so the fields join `Case` and its row mapping.

**Corrected 2026-10-30** (plan review): (7) the address is kept only when it is at most 254 characters (RFC 5321's path limit) and has no control or bidirectional formatting character, else null, never cut or rewritten; (8) the tests cover an attached and an uploaded `.msg` without transport headers, headers missing only the Subject or only the From, an uploaded `.eml` without trusted headers, an encoded and an oversized display name, and several or invalid From mailboxes; (9) a refused header write fails the parse attempt before the summary is stored (`must`), so a retry writes it; the tests fail the write, see no summary, retry and read the fields back, and read them unchanged after a replay once the raw message is gone.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Store the fields when the original is parsed. Done when: a case from a forward, an uploaded `.eml` and an uploaded `.msg` each carries the original's subject and From, and a document, image or audio upload carries nulls.

- [x] Add the columns to `cases` (`original_subject`, `original_from_name`, `original_from_address`) in `src/db/migrations/0038_case_original_header.sql` (0038 reserved by the coordinator, 2026-10-30). Done when: the migration applies locally and the columns read null for existing cases. Done 2026-10-30: `src/db/migrations/0038_case_original_header.sql`; the case tests read nulls for a new case.
- [x] Write them in the Workflow's `parse` step (`parse` in `src/pipeline/analysis-workflow.ts`) through `originalHeaderOf` in `src/intake/original-header.ts` and `setOriginalHeader` in `src/db/cases.ts`, before the summary is stored (corrections 1 to 5): the subject decoded (RFC 2047) and made one line, at most 300 characters; the From's display name decoded and bounded likewise, and its address only when it is one valid mailbox (`mailbox` in `src/checks/sender.ts`), else null; a `.msg` without transport headers from its properties. Done when: `test/pipeline/analysis-workflow.test.ts` reads them back for an attached forward, an uploaded `.eml` and an uploaded `.msg`, nulls for a document upload and for an inline forward, a bounded value for an oversized subject, an encoded-word subject decoded, control and bidirectional characters removed, and a retried step the same values. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `originalHeaderOf` in `src/intake/original-header.ts`, `parseMsg`'s `sender`, `setOriginalHeader` before `storeParsed`; `test/intake/original-header.test.ts` (16 tests; the step's paths tested through `parse` there rather than in `test/pipeline/analysis-workflow.test.ts`); five mutations (inline kept, a refused write ignored, no address bound, no .msg sender, no .msg subject) each fail a test.
- [x] Read them through the case accessor the report uses (`src/db/cases.ts`). Done when: `test/db/cases.test.ts` reads the three fields from a stored case, and an organisation never reads another's. Done 2026-10-30: `Case.originalSubject`, `originalFromName`, `originalFromAddress` from `getCase`; another organisation reads not_found (`test/intake/original-header.test.ts`); 429 tests across intake, pipeline, db and checks pass.
- [x] Commit: `intake: the original's subject and sender stored on the case` Done 2026-10-30: da7c52b, with 135d702, the round 1 and round 2 fixes after it.

**Test checkpoint:** `pnpm exec vitest run test/pipeline/analysis-workflow.test.ts test/db/cases.test.ts` passes.

> **Verified:** 2026-10-30 | §16 | 2d82cfe54f4c9d233d76ab42280c574489d2cc53
> **Review:** `docs/reviews/d01-t01-s16.json`

## 17. Retry of a failed check

Filed 2026-10-31 at the app lane's request through the coordinator (for D07 T03 §20, the failed report's "Retry the check" button): a case whose run failed is `partial` with no verdict, and nothing can run it again: `src/db/cases.ts` allows no move out of `partial`, the Workflow instance's id is the case id so a second `ANALYSIS.create` is refused, and `admit` skips a finished case. One function retries it.

> **Started:** 2026-10-31T04:59Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) migration 0044 (the coordinator's) adds `cases.run_id` and `case_events.actor` (the member who acted, at most 200 characters), both nullable; (2) the run id is `<caseId>-r<random>`, so two retries at once that both read the case cannot name the same run; (3) the Workflow reads only `caseId` from its params and the report reads the case row, so a new instance id needs no other lookup changed; intake's claim reconciliation looks up a case's first run by the case id, which `run_id` null still means; (4) what changes is which events belong to the current run: `completeStored` (`src/db/cases.ts`), `recordEvent`'s `once` (`src/pipeline/events.ts`) and the resend's failure read (`src/mail/resend.ts`) each read only the events after the latest retry that started (`retry`/`started` not followed by `retry`/`failed`), so the failed run's failures neither hold back the new run's completion nor stop its own failures being recorded, through one shared fragment, `CURRENT_RUN`; (5) the retry's batch moves the case, records `retry`/`started` with the member, and deletes the failed run's evidence and `check_outcomes` rows, every statement conditioned on the new `run_id` so a retry that lost the race changes nothing; a Workflow that fails to start puts the case back to `partial` and records `retry`/`failed`, so the earlier run's failure is again the case's cause.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/01-intake/D01-T01-s17.md`): (6) each run has its own reply: the send key is `reply:<run id>` for a retried run and `reply:<case id>` for the first, so a retry's verdict is never taken for the first run's notice, and a replayed run still sends once; run ids are letters and digits (`<caseId>R<hex>`) as a send key requires; (7) a retry waits for the failed run's instance to have finished (complete, errored or terminated), since `partial` is set before its reply step runs, and is refused (`not_finished`) while it runs or cannot be told; (8) a start that fails is settled by asking for the instance: found, the retry stands (an answer lost); absent, rolled back; unknown, left `received` and settled by `sweepRetries`, which the scheduled run calls (`src/index.ts`) for every `received` case with a run id older than five minutes, as it settles a retry interrupted between its batch and its start; every rollback is conditioned on the run still owning the case; (9) retry events carry their run (`case_events.run_id`), and `CURRENT_RUN` pairs each failed start with its own attempt, so a later failed start leaves the last run that started current.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Retry a failed case once at a time. Done when: a failed case retried by a member runs again under a new Workflow instance and ends with a verdict, its retry recorded; a second retry while it runs, and a retry of a case with a verdict, are refused.

- [x] Add `cases.run_id`, the case's current Workflow instance id (the case id for its first run, null on rows from before meaning the same), in a migration whose number the coordinator gives. Done when: the migration applies and `getCaseForPipeline` reads it.
- [x] Write `retryCase(db, env, orgId, caseId, memberId)` in `src/pipeline/retry.ts`: in one statement, move a case that is `partial` with no verdict to `received` and set a new `run_id` (`<caseId>-r<n>`), so two retries at once let one through; refuse a case with a verdict, one not `partial`, or one in another organisation, each with its own typed refusal. Done when: `test/pipeline/retry.test.ts` retries a failed case and refuses the four others, two retries at once giving one run.
- [x] Record the retry as a `case_events` row (`step: "retry"`, the member, the time) in the same batch. Done when: the test reads the event back.
- [x] Clear the failed run's evidence and `check_outcomes` rows (D02 T01 §3) and its verdict-less report state in that batch, so the new run starts clean and a reader never mixes two runs. Done when: the test finds none of the failed run's rows after the retry and the new run's after it ends.
- [x] Start the Workflow under the new `run_id`, and read the instance by `run_id` wherever the case's run is looked up (status, the sweep, the report's progress). Done when: the retried case's instance is found by its new id and the Workflow test ends it `done` with a verdict; a failed start leaves the case `partial` again with the event marked failed.
- [x] Commit: `pipeline: retry of a failed check` Done 2026-10-31: the build commit with the plan review folded in, then the completion review's and the rounds' fixes after it.

**Test checkpoint:** `pnpm exec vitest run test/pipeline/retry.test.ts test/db/cases.test.ts` passes.

> **Unstamped:** 2026-10-31: the stamped code exported non-handler constants from the Worker's entry module, so the Worker failed to load (checks-lane CI run 41173224119); fixed and re-reviewed (revoked receipt `docs/reviews/d01-t01-s17.revoked-2026-10-31.json`)

> **Verified:** 2026-10-31 | §17 | e903470dd908ae8d145ca9ee3ec37a7de5644596
> **Review:** `docs/reviews/d01-t01-s17.json`

## 18. Authorised mailbox checking, designed

**Operator decision 2026-11-01 03:30 SAST (`docs/coordinator.md`):** deferred until after the competition.

Filed 2026-10-31 from D02 T04 §5's completion review (out of scope): a member protects themselves only by forwarding or uploading each message; a mail gateway such as Microsoft Defender checks every incoming attachment with no action per message. Checking a mailbox the organisation has authorised would remove that step, but it reads mail the member never chose to send, so its consent, data access and retention need a design before any build.

**Phase:** 7
**Needs:** operator
**Surface:** no

**Build order:**

1. Write the design. Done when: `docs/specs/` holds a design for authorised mailbox checking (Microsoft 365 and Gmail), naming the consent each organisation and member gives, the scopes read, what is kept and for how long under POPIA, how a member stops it, and the sections that would build it, and the operator has decided whether to build it.

- [ ] Write the design document in `docs/specs/YYYY-MM-DD-mailbox-checking-design.md` with the consent flow, the read scopes, retention and the stop path. Done when: the document exists and is reviewed.
- [ ] Record the operator's decision on building it, and file the build sections if it is yes. Done when: the decision is recorded in this section.
- [ ] Commit: `docs: authorised mailbox checking, designed`

**Test checkpoint:** `python3 scripts/todo-graph.py validate` passes.

## 19. A retried run's earlier findings kept apart

Filed 2026-10-31 from §17's completion review (G8): a retry deletes the failed run's evidence and check outcomes before its new run starts, so when the new run cannot start, the earlier findings are gone though the case is the earlier run's again. They are kept apart instead, as the earlier attempt's, never current.

> **Started:** 2026-10-31T12:30Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) `evidence`'s key is `(case_id, id)` with `UNIQUE (case_id, seq)` (migration 0002), and `check_outcomes`' is `(case_id, check_name)` (0042), so neither holds two runs' rows: the migration (its number from the coordinator) rebuilds both with `run_id TEXT NOT NULL` in the key (`(case_id, run_id, id)`, `UNIQUE (case_id, run_id, seq)`, `(case_id, run_id, check_name)`), every existing row given its case's current run; (2) a run is named as `retryCase` names it: the first run by the case id (its Workflow instance id), a retry by its `cases.run_id`, so a case's current run is `COALESCE(cases.run_id, cases.id)`; (3) `saveEvidence` writes its rows under the case's current run, read in the same batch, and replaces only that run's rows (a retry starts only once the earlier run has finished, `src/pipeline/retry.ts`, so a step writes for the current run); (4) `readEvidence` and `readCheckOutcomes` read the current run's rows unless given a run; a retry whose run never started is rolled back to the earlier run (`rollBack` restores `run_id`), whose findings so read as current again; (5) `retryCase` deletes nothing; a started retry reads none as current until its checks step stores them; (6) a verdict's reasons cite evidence ids (`src/web/pages/report-verdict.tsx`), and a case with a verdict is never retried, so the current run's ids are the ones a verdict cites.

**Corrected 2026-10-31** (from the coordinator and the plan review, `docs/reviews/01-intake/D01-T01-s19.md`; correction 1 refined): (7) the migration is `0051` (the coordinator's number, 2026-10-31); it is safe on D1, which enforces foreign keys: `PRAGMA defer_foreign_keys = true`, then for each table create the new one, copy every column by name (no `SELECT *`), drop the old and rename the new, never dropping first; every constraint (the `CHECK`s, the `UNIQUE` on `seq`, the case-deletion cascade) and any index or trigger the old tables had is kept; (8) `test/db/run-findings-migration.test.ts` loads rows into the schema before 0051 (a case never retried, `run_id` null, and one retried, `run_id` set), applies 0051, and asserts every column of every row in both tables, the run each was given, their reading through the default readers, and that deleting a case still deletes its rows; `test/db/schema.test.ts`'s evidence inserts name a run; (9) `test/pipeline/retry.test.ts` keeps run A's rows while run B's are replaced again and again (a replay, a shorter list, an empty one, and a batch that fails, leaving the previous rows whole), for evidence and outcomes alike, and reads the earlier run's findings as current after `sweepRetries` rolls back an unknown start, to the run before it; (10) the section's live-proof note gives the coordinator a read-only check for production before and after 0051: `SELECT COUNT(*) FROM evidence; SELECT COUNT(*) FROM check_outcomes; SELECT COUNT(*) FROM evidence WHERE run_id IS NULL;` with equal counts before and after and no row without a run.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Keep the failed run's findings as its own. Done when: a retry whose run cannot start leaves the earlier findings readable as that attempt's, and a retry whose run starts shows only the new run's findings as current.

- [x] Add a `run_id` to `evidence` and `check_outcomes` (a migration from the coordinator), written by the `checks` step for its run, and have `readEvidence` and `readCheckOutcomes` in `src/checks/evidence.ts` read the current run's by default. Done when: `test/pipeline/retry.test.ts` reads the earlier run's findings after a failed start and none of them as current after a started one.
- [x] Have `retryCase` in `src/pipeline/retry.ts` stop deleting the failed run's rows, and give a reader the earlier attempt's findings by its run. Done when: the test reads both attempts' findings, each by its run.
- [x] Commit: `pipeline: a retried run's earlier findings kept apart`

**Live proof (the coordinator's, at the deploy that applies 0051):** run on production before and after the migration, read-only: `SELECT (SELECT COUNT(*) FROM evidence) AS evidence, (SELECT COUNT(*) FROM check_outcomes) AS outcomes;` and, after it, `SELECT (SELECT COUNT(*) FROM evidence WHERE run_id IS NULL OR run_id = '') AS evidence_without_run, (SELECT COUNT(*) FROM check_outcomes WHERE run_id IS NULL OR run_id = '') AS outcomes_without_run;`. The counts are equal before and after, and no row is without a run; recorded in `docs/live-checks.md`.

**Test checkpoint:** `pnpm exec vitest run test/pipeline/retry.test.ts test/db/run-findings-migration.test.ts test/db/schema.test.ts` passes.

> **Verified:** 2026-10-31 | §19 | 37293ea4a31c989cd21d1acb24acb408211f17a3
> **Review:** `docs/reviews/d01-t01-s19.json`

## 20. Earlier attempts readable on

**Operator decision 2026-11-01 03:30 SAST (`docs/coordinator.md`):** deferred until after the competition.

Filed 2026-10-31 from §19's completion review (out of scope): §19 keeps each run's findings, and `readEvidence` and `readCheckOutcomes` read an earlier run's by its id, but the report shows only the current run's, so a member cannot see what an earlier attempt found. How an earlier attempt is opened, labelled and left is a report design (D07's), decided before it is built.

**Operator decision 2026-11-02:** in-report attempt history; the design names the D07 section (with D07 T03 §47) that builds it.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Decide how earlier attempts appear. Done when: a dated design in `docs/specs/` names the D07 section that builds it: an earlier attempt opened within two actions, labelled as earlier with its date and outcome, and reachable and left by keyboard and screen reader.

- [ ] Write the design in `docs/specs/YYYY-MM-DD-report-attempt-history-design.md` from the run ids `case_events` records (`retry` rows) and the run-scoped readers. Done when: the operator's approval is recorded in it.
- [ ] File the D07 section it names through `add-todo`. Done when: the section is in the plan, depending on §19.
- [ ] Commit: `docs: earlier attempts on the report designed`

**Test checkpoint:** `python3 scripts/todo-graph.py validate` passes with the filed section.

## 21. Mail checked

Filed 2026-10-31 from D02 T04 §8's completion review (Part 2 item 2, out of scope): a member checks a message by forwarding or uploading it, one action per message; Microsoft Defender for Office 365 checks every protected recipient's mail before delivery with none. Checking mail without a submission needs the organisation's consent and a mail integration (for example Microsoft Graph or Gmail's API), which changes what the product reads and stores, so it is a design decision first. The forwarding workflow stays as it is whatever is decided.

**Operator decision 2026-11-02:** design opt-in automatic checking (mailbox integration with organisation consent); the forwarding workflow stays as it is.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Decide whether members' mail is checked without a forward. Done when: a dated design in `docs/specs/` names the integration (or none), the consent and data it needs, what is stored, and the sections that build it, approved by the operator.

- [ ] Write the design in `docs/specs/YYYY-MM-DD-mail-without-forward-design.md` from the intake design (`src/mail/`, design spec 4.1) and D02 T02's filed mail-history section. Done when: the operator's approval is recorded in it.
- [ ] File the sections it names through `add-todo`. Done when: they are in the plan.
- [ ] Commit: `docs: mail checked without a forward decided`

**Test checkpoint:** `python3 scripts/todo-graph.py validate` passes with the filed sections.

## 22. Replay-scoped claims for the eval organisation

> **Started:** 2026-11-02T18:38Z

Filed 2026-11-02 from the coordinator's routing (eval D08 T02 §12): the eval replays the same deliveries to measure the pipeline, but the intake claim (`src/intake/admit.ts`) answers a repeat within a day as a duplicate of the first case, so a replay can never re-run. Mechanism agreed by the coordinator: a replay-scoped claim key for the eval organisation only, the replay run id carried for attribution, ordinary duplicates untouched. Eval D08 T02 §12 unblocks when this gates to main.

**Corrected 2026-11-02** (at start, checked against the tree): (1) no schema change: the scoped claim key itself carries the run id (`replay:<run id>:` before the door key in `intake_messages.message_key`), so the claim row the case is linked from is the attribution record; (2) the server names the eval organisation in a Worker variable `EVAL_ORG_ID` (an identifier, not a secret; the coordinator sets its value at the gate from the eval runner's organisation, and an unset variable disables replay scoping, never silently widens it); (3) the upload route reads the run id from the multipart field `replayRunId` the eval runner sends, and `admitDelivery` honours it only when the delivery's organisation is the named eval organisation, so a member naming a run id for their own organisation is admitted as an ordinary delivery; (4) the email door takes no replay id (the eval runner submits by upload with its session), and ordinary duplicates on both doors are untouched.

**Corrected 2026-11-02** (plan review, `docs/reviews/01-intake/D01-T01-s22.md`): (5) replay claims expire like ordinary ones: `sweepIntake` deletes a completed claim after 24 hours, after which the same run id submitted again makes a new case, as an ordinary redelivery would; durable run-to-case attribution beyond that window is D08 T02 §12's `eval_results`, not the claim, and a read-back test reads the attribution after claim cleanup from where §12 keeps it (this section's tests assert the claim-side behaviour only); (6) the multipart contract is exact: one `file` entry plus at most one textual `replayRunId` entry, in either order; an empty, repeated, file-valued or malformed id (grammar: 1 to 64 characters of letters, digits, `-` and `_`) is refused with a 400 before anything is admitted, and any other field or a second file keeps today's refusal, so an invalid request creates no claim, case, object or Workflow; (7) tenant isolation is proven, not argued: authenticated uploads from two organisations with identical bytes and the same replay id each answer and persist only their own session organisation's claim and case, a test with `EVAL_ORG_ID` unset restores ordinary deduplication without returning a replay case, and removing the organisation predicate fails the isolation test.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Scope a claim to its replay run, for the eval organisation only. Done when: the same delivery admitted twice under two replay run ids makes two cases, and twice under one run id stays one case.

- [x] Carry an optional replay run id on `Delivery` in `src/intake/admit.ts`, read by the upload route from the multipart field `replayRunId`, honoured only when the delivery's organisation equals the `EVAL_ORG_ID` Worker variable (declared in `wrangler.jsonc`, unset until the coordinator sets it at the gate). Done when: a non-eval delivery carrying a replay id is admitted as an ordinary delivery, its id ignored, and an eval delivery with no variable set is ordinary too.
- [x] Scope the claim key with the replay run id (`claimKey` in `src/intake/admit.ts`) only when a replay id is honoured, the scoped key itself carrying the run id for attribution. Done when: the owning intake suites show two run ids making two cases, one run id replayed staying a duplicate, and an ordinary duplicate untouched.
- [x] Enforce the multipart contract in the upload route (`src/intake/upload.ts`): one `file` plus at most one textual `replayRunId` in either order, the id 1 to 64 characters of letters, digits, `-` and `_`; empty, repeated, file-valued or malformed ids refused 400 before admission. Done when: HTTP tests in `test/intake/upload.test.ts` reach admission with a valid replay upload and create no claim, case, object or Workflow for each invalid shape. (**Corrected 2026-11-02**, plan review, `docs/reviews/01-intake/D01-T01-s22.md`.)
- [x] Prove the tenant boundary over HTTP: two organisations upload identical bytes with the same replay id, each answering its own organisation's case with its claim persisted under that organisation; with `EVAL_ORG_ID` unset the second upload is an ordinary duplicate. Done when: `test/intake/upload.test.ts` asserts both organisations' claims and cases apart, and removing the organisation predicate fails it. (**Corrected 2026-11-02**, plan review, `docs/reviews/01-intake/D01-T01-s22.md`.)
- [x] Commit: `intake: replay-scoped claims for the eval organisation`

**Test checkpoint:** `pnpm exec vitest run test/intake/upload.test.ts test/intake/email.test.ts` passes, and fails if a second replay run answers the first run's case or another organisation's.

> **Verified:** 2026-11-02 | §22 | f7ecc89da9ea74d6ffa190fdee8cefa11908cece
> **Review:** `docs/reviews/d01-t01-s22.json`

## 23. Auth outcomes stored before slower checks

> **Started:** 2026-11-02T19:24Z

Filed 2026-11-02 from the coordinator's routing (report lane, D07 T09 §1): the Workflow stores a case's evidence only after the whole checks step, so a slow or failed later check leaves the fast header-authentication outcome (`auth.*`) unstored with it. D07 T09 §1 needs the auth outcomes and items stored before the slower checks run, later outcomes joining under the same run id.

**Corrected 2026-11-02** (at start, checked against the tree): (1) the auth family is the registered checks whose names start `auth.` (`auth.spf`, `auth.dkim`, `auth.dmarc`, `auth.alignment`, `auth.results`, `auth.arc`), run on their own first through `runChecksWithOutcomes` over a subset registry built from `checks.all()`; (2) the checks step in `src/pipeline/analysis-workflow.ts` saves that phase (`saveEvidence` with the auth outcomes) before the full run, and the full run's own save then replaces the checks rows under the same run id (`saveEvidence` already keys both evidence and outcomes by the case's current run), so the final stored set is exactly today's; the auth checks run twice, which is safe here because they read only the stored headers and authentication results and reach no network; (3) a failure in the full run after the auth save leaves the auth items and outcomes stored, which is the state D07 T09 §1 reads.

**Corrected 2026-11-02** (plan review, `docs/reviews/01-intake/D01-T01-s23.md`): (4) the early phase runs immediately after the base view is built from the parsed summary (`caseViewOf` in `checks()`), before any enrichment (attachment reads, Browser Run, RDAP, reputation), so a blocked enrichment cannot hold the auth rows back; (5) the early subset is the registry's prefix, the `intake.` checks and the `auth.` family in registration order, so the early list's Evidence IDs are the full run's own first IDs and no issued ID changes its finding when the full save replaces the rows; the completed case and a checks-step replay prove every early ID keeps its finding.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Store the auth result first, the rest under the same run. Done when: a case whose later checks are still running (or failed) already reads its stored `auth.*` items and outcomes.

- [x] Split the checks step in `src/pipeline/analysis-workflow.ts` into two phases: right after the base view is built, run the registry's `intake.` and `auth.` prefix on its own and save it (`saveEvidence` with its outcomes), then enrich and run the full registry, whose save replaces the checks rows under the same run id so the final set is unchanged and every early Evidence ID keeps its finding. Done when: `test/pipeline/analysis-workflow.test.ts` blocks a later enrichment (a link following that never answers), reads the stored auth items and outcomes while it is blocked, then lets it fail and reads them still stored; and a completed case's evidence and outcomes equal one full run's under one run id, on a replay too. (**Corrected 2026-11-02**, plan review, `docs/reviews/01-intake/D01-T01-s23.md`.)
- [x] Commit: `pipeline: auth outcomes stored before slower checks`

**Test checkpoint:** `pnpm exec vitest run test/pipeline/analysis-workflow.test.ts` passes, and fails if a failed later check leaves no stored auth outcome.

> **Verified:** 2026-11-02 | §23 | 291fd8acaca593d8d3d9c62b5cb48a2704d860f3
> **Review:** `docs/reviews/d01-t01-s23.json`

## Verification

- A synthetic forward to the live `check@` produces a case, R2 objects, step events and a reply with a working signed link.
- `pnpm test` passes, including every test named above; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
