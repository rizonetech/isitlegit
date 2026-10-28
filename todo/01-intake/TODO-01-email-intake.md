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
| 3 | §3 | Email handler for verified members | §2, D07 T02 §4, D07 T02 §5 | [ ] |
| 4 | §4 | Forward-as-attachment detection | §3 | [ ] |
| 5 | §5 | MIME parsing and attachment extraction | §4 | [ ] |
| 6 | §6 | Outlook .msg parsing | §5 | [ ] |
| 7 | §7 | AnalysisWorkflow skeleton, partial reports | §5 | [ ] |
| 8 | §8 | Signed expiring report links | §1 | [x] |
| 9 | §9 | Email Routing for check@ and live smoke | §7, D01 T02 §3 | [ ] |
| 10 | §10 | Outlook report button for check@ | §9 | [ ] |
| 11 | §11 | Acceptance acknowledgement for a forward | §9, D01 T02 §3 | [ ] |

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
- [x] Admit the sender only when Email Routing's own authentication of it holds, in `senderAuthenticated(raw, from)` in `src/intake/sender.ts`: the topmost `Authentication-Results` header of the raw message (the one Email Routing adds; lower ones may be written by anyone) shows `spf=pass` with `smtp.mailfrom` at the envelope sender's domain, or `dkim=pass` with a `header.d` whose registrable domain is the sender's. Email Routing rejects only on the sender's own DMARC policy and otherwise needs SPF or DKIM to pass for any domain, so without this check an envelope `boss@member.co.za` signed by an unrelated domain reaches the gate. Done when: `test/intake/sender.test.ts` admits an aligned SPF pass and an aligned DKIM pass, and refuses a DKIM pass for another domain with SPF failing, a pass only in a lower header, a missing header and an unaligned subdomain trick (`member.co.za.evil.com`). Cheaper substitute: trusting `message.from` alone, which anyone can set. **Corrected 2026-10-28** (round 1): a sender admitted by a single verified address, not its domain, must prove the mailbox: the message's From is that address and a DKIM signature by its domain passed; a domain-level pass is not enough there, since any other user of a shared provider passes DKIM for its domain (`memberOfSender` says which). **Corrected 2026-10-28:** added; the section assumed Email Routing authenticated the envelope sender, and its documentation says it does not align it (Postmaster: "The email must either pass SPF or be correctly signed with DKIM").
- [x] Call `findMemberBySender(env.DB, from)` from D07 T02 §5 (**Corrected 2026-10-28:** said `findMemberBySender(from)`; it takes the database) for an authenticated sender, and drop the message (no reply, no case) when the sender is unauthenticated or the lookup returns null. Done when: `test/intake/email.test.ts` shows an unknown sender and a spoofed member sender each leave `cases` empty, store nothing and call no mail sender. Cheaper substitute: replying "not registered", which creates backscatter.
- [x] Reject messages over 25 MiB with `message.setReject("Message too large")` (Email Routing limit, stack doc). Done when: a test with a 26 MiB body is rejected and stores nothing.
- [x] Add migration `src/db/migrations/0016_intake.sql`: `intake_messages` (`org_id`, `message_key`, `state` pending or done, `case_id` nullable, `claimed_at`; primary key `org_id, message_key`) and two `cases` columns, `forwarded_by` (the admitted envelope sender, lowercased; null for uploads) and `message_id` (the forward's `Message-ID`, null when it has none), with `admitCase` taking `forwardedBy` and `messageId`. Done when: `test/node/` applies the migration to a copy of the schema and `test/db/cases.test.ts` reads both columns back from an admitted case. Cheaper substitute: deriving the reply recipient later from the raw `From` or `Reply-To`, which an attacker writes. **Corrected 2026-10-28** (plan review): nothing stored the forwarder D01 T02 §3 replies to.
- [x] Claim the delivery before anything else is written, in one statement on `intake_messages`: a new key is claimed `pending`; a `done` claim younger than 24 hours means a duplicate, dropped with no reply; a `pending` claim younger than five minutes (a delivery still being processed) makes the handler throw so the duplicate is retried later rather than dropped while the first may still fail; an older `pending` claim is taken over and its recorded case reconciled first (Workflow found: mark the claim `done` and drop; not found: delete that case and its raw object, then process afresh). `message_key` is the `Message-ID` or, without one, the SHA-256 of the raw message. Done when: `test/intake/email.test.ts` delivers the same fixture twice in turn (one case), twice at once (one case, the other delivery thrown for retry), after 24 hours (a second case), and over a stale pending claim with and without its Workflow (one case either way). Cheaper substitute: a KV key, which is eventually consistent, so two deliveries close together both pass. **Corrected 2026-10-28:** said a `CACHE` key with no states (plan review: a claim left by a failed delivery suppressed its retry for 24 hours).
- [x] Process a claimed delivery in this order: `admitCase` (§1, D07 T02 §4) with `forwardedBy` and `messageId`, the case id written to the claim, `putRaw` (§2: its artefact row names the case, so the case comes first), `env.ANALYSIS.create({ id: caseId, params: { caseId } })`, then the claim marked `done`. Done when: a test against the migrated D1 and R2 reads back one case with its `forwarded_by` and `message_id`, one raw object at `raw/<caseId>/message.eml` with its artefact row, one Workflow create with the case id as instance id, and a `done` claim naming the case. **Corrected 2026-10-28:** said "store the raw message ..., create the case ..., and start" (plan review: `putRaw` needs the case's id and row first).
- [x] When `admitCase` answers `capped`, delete the claim (so the same message forwarded after midnight SAST is processed) and send the forwarder one `notice` mail a day under the send key `cap:<orgId>:<SAST date>:<forwarder digest>` (**Corrected 2026-10-28**, round 1: the forwarder's address itself could pass the 200-character key limit), naming the organisation's configured cap (`org_limits.daily_cases`, else `DEFAULT_DAILY_CASES`): "today's limit of N checks is reached; it resets at midnight". A notice that `failed` is retried by the next capped forward that day (a failed send key can be claimed again); an `uncertain` one is settled by the reconciler (D01 T02 §5); a `refused` one sends nothing; none fails the delivery. Done when: a capped forward creates no case and sends one notice naming a configured cap of 3; a second capped forward the same day sends none; two capped forwards at once send one; a notice whose send failed is sent by the next capped forward; and the same message forwarded after midnight SAST creates a case. (Moved from D07 T02 §4, 2026-10-28: the email path is this section's.) **Corrected 2026-10-28** (plan review): the claim's fate on a cap, the send outcomes and the configured cap were unstated.
- [x] Let the allowlist in `src/mail/allowlist.ts` admit `reply` and `notice` mail to an address `findMemberBySender` resolves (a verified address, or any address at a verified domain), not only to users with a membership: a verified domain admits all its staff's forwards, and the cap notice and later the verdict reply go back to that forwarder. Done when: `test/mail/allowlist.test.ts` admits `reply` and `notice` to an address at a verified domain and to a verified address, refuses them at a pending or removed domain, and `renewal` stays members only. Cheaper substitute: none; without it a domain-admitted forwarder's notice and reply are refused. **Corrected 2026-10-28:** added; the allowlist (D01 T02 §2, written before D07 T02 §5) knew only users as members.
- [x] Undo or hand over a delivery whose later step fails, then throw so it is retried: an admission failure releases the claim; a raw-store failure deletes the case and any raw object and releases the claim; a Workflow create that throws is checked with `env.ANALYSIS.get(caseId)`, an instance found counting as started (the claim marked `done`), none found undone like a raw-store failure, and a check that itself fails leaving the claim `pending` with its case for the takeover above or the sweep below. A failed undo leaves the same. Done when: tests make the database, the bucket's `put`, `ANALYSIS.create` (once failing outright, once recording the instance and then throwing) and the undo each fail, and every one ends with either no case, raw object or claim, or one case with one Workflow after the retry or sweep. Cheaper substitute: deleting the case whenever create throws, which orphans a Workflow that did start. **Corrected 2026-10-28:** an unconditional undo (plan review: a create can succeed while its answer is lost). Whether Email Routing retries a delivery whose handler threw is not documented; D01 T01 §9's live smoke records what the sender sees.
- [x] Sweep intake claims in the scheduled run (`scheduled()` in `src/index.ts`, every 15 minutes): delete `done` claims older than 24 hours, and reconcile `pending` claims older than five minutes as the takeover does (Workflow found: `done`; not found: the case and raw object deleted, then the claim). Done when: a test of the sweep leaves a 25-hour `done` claim deleted and a 1-hour one kept, completes a stale claim whose Workflow exists, removes a stale claim's orphan case and raw object, and touches no other organisation's rows. Cheaper substitute: leaving the rows, which keeps organisation-linked Message-IDs indefinitely. **Corrected 2026-10-28** (plan review): the claims had no deletion owner.
- [x] Export `email` from `src/index.ts` next to `fetch`, calling `handleEmail`. Done when: a test calls the default export's `email` with a synthetic `ForwardableEmailMessage` from a verified member and finds the case, the raw object and the Workflow create, and `pnpm typecheck` passes. Cheaper substitute: a dry-run bundle listing the handler, which an empty handler passes. **Corrected 2026-10-28:** the proof was `wrangler deploy --dry-run` (plan review: it does not exercise delivery).
- [ ] Commit: `intake: email handler for verified members`

**Test checkpoint:** `pnpm exec vitest run test/intake/email.test.ts test/intake/sender.test.ts test/mail/allowlist.test.ts test/db/cases.test.ts` passes, and fails if the member check or the sender authentication is removed, a duplicate delivery creates a second case, a failed step leaves a case with no Workflow or a claim that blocks the retry, or the forwarder is not stored.

## 4. Forward-as-attachment detection

A normal Outlook or Gmail forward strips the original headers, which kills the authentication checks; the supported path is "forward as attachment" (spec 4.1). This section finds the original message inside the forward or records that the headers are missing.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/intake/forward.ts` returning the original message bytes and `headersAvailable`. Done when: fixtures for an attached `message/rfc822`, an attached `.eml`, an attached `.msg` and an inline forward give the expected result.

- [ ] Add synthetic fixtures `test/fixtures/forward/attached-rfc822.eml`, `attached-eml-file.eml`, `attached-msg.eml` and `inline-forward.eml` built from fictional senders (`AGENTS.md`: synthetic only). Done when: the four files exist and contain no real address.
- [ ] Write `extractOriginal(parsed)` choosing the first `message/rfc822` part, else the first attachment named `*.eml`, else the first `*.msg` (RFC 2046 section 5.2.1). Done when: the three attachment fixtures return the inner message.
- [ ] Return `{ original: forwarderMessage, headersAvailable: false }` for an inline forward. Done when: the inline fixture yields `headersAvailable: false` and the case row stores `headers_available = 0`.
- [ ] Record which path was taken as an `intake.forward` evidence item (info severity) so the report can explain it. Done when: a test finds the evidence row with `detail_json.path` set.
- [ ] Commit: `intake: detect forward-as-attachment and missing headers`

**Test checkpoint:** `pnpm exec vitest run test/intake/forward.test.ts` passes for all four fixtures and fails if the inline case reports headers as available.

## 5. MIME parsing and attachment extraction

`postal-mime` parses the original message into headers, bodies and attachments (spec 4.2). Every attachment and inline image becomes an artefact in R2; the parsed summary passes between Workflow steps by key, never by value (stack doc: 1 MiB step output limit).

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Add `postal-mime` 4.1.4 and write `src/intake/parse.ts`. Done when: a fixture parses into headers, text, HTML and attachments.
2. Store attachments and the parsed summary. Done when: R2 holds each attachment under `raw/<case>/attachments/` and the summary at `raw/<case>/parsed.json` (**Corrected 2026-10-27:** attachments sit under the 30-day `raw/` rule).

- [ ] Add exact dependency `postal-mime` 4.1.4 to `package.json`. Done when: `pnpm install` resolves it.
- [ ] Write `parseMessage(bytes)` returning headers (as an ordered list, duplicates kept), `text`, `html`, and attachments with filename, media type, content id and bytes. Done when: `test/intake/parse.test.ts` checks a multipart fixture with two attachments and an inline image.
- [ ] Store each attachment with `putAttachment(caseId, name, bytes, mediaType)` (**corrected 2026-10-27**, D01 T01 §2's plan review: `putArtefact` takes only the derived kinds) and inline images the same way, with their `content_id` in the summary. Done when: the test finds three artefact rows for the fixture.
- [ ] Write the parsed summary (headers, text, html, attachment keys) with `putParsed(caseId, summary)` to `raw/<caseId>/parsed.json` (**corrected 2026-10-27**, D01 T01 §2's plan review: it is the message's content, so it expires with the message under `raw/`; it was `art/<caseId>/parsed/summary.json`). Done when: the test reads it back and it is under 1 MiB for the fixture.
- [ ] Treat a parse failure as a typed `ParseError` that the Workflow turns into a partial report (§7). Done when: a truncated fixture raises `ParseError`, not a crash.
- [ ] Commit: `intake: MIME parsing with attachments stored in R2`

**Test checkpoint:** `pnpm exec vitest run test/intake/parse.test.ts` passes, and fails if duplicate headers are collapsed (the `Received` chain needs them).

## 6. Outlook .msg parsing

Outlook users often drag a message out as `.msg` (OLE compound file). `@kenjiuno/msgreader` must run under `nodejs_compat` in Workers; if it does not, `.msg` is cut and the reply explains how to forward as `.eml` (spec section 8 cut list).

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Prove the library in the workers pool. Done when: a synthetic `.msg` fixture parses in a Vitest workers test, or the failure is recorded and §6 falls back.
2. Convert `.msg` to the same parsed summary as §5. Done when: the summary matches the `.eml` twin of the fixture field by field.

- [ ] Add exact dependency `@kenjiuno/msgreader` 1.29.0. Done when: `pnpm install` resolves it.
- [ ] Create synthetic fixture `test/fixtures/msg/invoice-request.msg` and its `.eml` twin from a fictional sender (generate the `.msg` with a script in `scripts/fixtures/`, never from real mail). Done when: both files exist and the generator is committed.
- [ ] Write `parseMsg(bytes)` in `src/intake/msg.ts` mapping sender, recipients, subject, headers (`PidTagTransportMessageHeaders`), bodies and attachments into the §5 summary shape. Done when: `test/intake/msg.test.ts` compares it with `parseMessage` of the twin.
- [ ] If the library fails in the workers pool, record the error in `docs/frontier-log.md` style under `docs/decisions.md`, make `parseMsg` throw `UnsupportedFormat`, and have the reply say to forward as attachment in Outlook's default format. Done when: either the parse test passes or the fallback test passes; never neither.
- [ ] Commit: `intake: Outlook .msg parsing`

**Test checkpoint:** `pnpm exec vitest run test/intake/msg.test.ts` passes.

## 7. AnalysisWorkflow skeleton, partial reports

Cloudflare Workflows run the pipeline as durable steps (stack doc), so a failure resumes without repeating paid model calls. This section builds the skeleton every later check plugs into: parse, checks, verdict, reply. Each step writes a `case_events` row (the audit trail and the model trace source); any step failure after retries ends the case as `partial` with the failed step named, never as a confident verdict (spec 4.8, manifesto Reliability).

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/pipeline/analysis-workflow.ts` with steps `parse`, `checks`, `verdict`, `store`, `reply`. Done when: a test run on a fixture case ends in `done` with a stub verdict.
2. Add the failure path. Done when: a forced failure in `checks` ends the case `partial` with an event naming the step.

- [ ] Replace the D00 T01 §5 stub with an `AnalysisWorkflow` whose `run` calls `step.do` for `parse`, `checks`, `verdict`, `store` and `reply`, passing R2 keys between steps. Done when: `pnpm typecheck` passes and the class is still exported as `ANALYSIS`.
- [ ] Write `recordEvent(caseId, step, status, extra)` in `src/pipeline/events.ts` and call it at the start and end of each step with duration. Done when: a test run leaves two events per step in `case_events`.
- [ ] Add a stub `checks` step returning no evidence and a stub `verdict` step returning `suspicious` with headline "Analysis in progress: checks are not built yet" and confidence 0. Done when: the fixture case ends `done` with that stub verdict. Cheaper substitute: returning `safe`, which would mislead a member.
- [ ] Configure `retries` per step (`limit: 3`, exponential backoff) and catch the final failure into `setStatus(caseId, "partial")` plus an event with the error class (no message content). Done when: a test that throws in `checks` three times ends `partial`.
- [ ] Make re-running a finished instance a no-op by checking `cases.status` first. Done when: a second `run` on a `done` case writes no new events.
- [ ] Commit: `pipeline: AnalysisWorkflow skeleton with step events and partial reports`

**Test checkpoint:** `pnpm exec vitest run test/pipeline/analysis-workflow.test.ts` passes, and fails if a step failure leaves the case `running`.

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

## 9. Email Routing for check@ and live smoke

The zone `isitlegit.co.za` routes `check@` to the Worker's `email()` handler (stack doc). This section creates the rule and proves the whole loop on the live service with a synthetic fixture: forward in, stub reply out.

**Phase:** 1
**Needs:** cloudflare, live-mail
**Surface:** no

**Build order:**

1. Enable Email Routing on the zone and route `check@isitlegit.co.za` to the Worker. Done when: the routing rule reads back with the Worker as its action.
2. Send a synthetic fixture from the operator's verified test mailbox alias and read the reply. Done when: the reply arrives with a working signed report link.

- [ ] Enable Email Routing on zone `88aeec6df134bc59bfa16a25751241ef` and create a rule `check@isitlegit.co.za` to Worker `isitlegit` (standing authorisation, `AGENTS.md`). Done when: the Cloudflare API lists the rule enabled.
- [ ] Deploy the Worker after the gates pass (`AGENTS.md` deploy rule). Done when: `/health` returns the deployed SHA.
- [ ] Register the Rizonetech test organisation and its verified test sending address through the D07 T02 domain verification flow. Done when: `findMemberBySender` returns it.
- [ ] Send `test/fixtures/forward/attached-rfc822.eml` as an attachment from the test sending address through SMTP2GO to `check@isitlegit.co.za` with `scripts/send-fixture.ts`. Done when: a case row appears with `headers_available = 1`.
- [ ] Read the reply where it lands, `derick@rizonetech.com` through the Microsoft 365 connector, and cross-check it in the SMTP2GO activity log (`docs/live-checks.md`, operator 2026-10-27: Claude runs mail tests itself); record the case id, the reply's `internetMessageId` and the reply time in `docs/live-checks.md`. Done when: the file names the case, the reply's `In-Reply-To` and the elapsed seconds.
- [ ] Record the topmost `Authentication-Results` header Email Routing added to the live smoke's case (its `authserv-id` and the `spf=`, `smtp.mailfrom=`, `dkim=` and `header.d=` fields) in `docs/live-checks.md`, and add that header verbatim as a fixture to `test/intake/sender.test.ts`. Done when: `senderAuthenticated` (§3) admits the recorded header and the fixture test passes. Source: D01 T01 §3's sender check, written from RFC 8601 before a live header was seen.
- [ ] Deliver a message while the Worker's raw store is made to fail (a deployed flag that only the operator's test sender trips, removed afterwards) and record what the sending side saw (a 4xx retry or a 5xx bounce) in `docs/live-checks.md`. Done when: the record names the SMTP outcome and, for a retry, that the retried delivery created exactly one case. Source: D01 T01 §3's undo path; Email Routing does not document a thrown handler's outcome.
- [ ] Commit: `intake: Email Routing for check@ with a live end-to-end smoke`

**Test checkpoint:** `pnpm exec tsx scripts/send-fixture.ts test/fixtures/forward/attached-rfc822.eml --wait 120` exits 0 after finding the case in D1 with status `done` and a reply logged in SMTP2GO.


## 10. Outlook report button for check@

Forwarding to `check@` takes at least three actions (forward, type the address, send), and keeping the original headers needs one more choice, forward as attachment (spec 4.1). Microsoft's own Report button in Outlook takes two selections from an open message. An IsItLegit button in Outlook can send the open message as an attachment to `check@` in at most two actions, with no address typed and the headers always kept (D01 T01 §3 completion review, Part 2 item 1). The email path stays as it is; the button is another way into it.

**Phase:** 7
**Needs:** attended
**Surface:** yes

**Fidelity:** `design/SPEC.md` gains an "Outlook report button" section (the button in the ribbon and the message's action menu, its confirmation and failure states) with its board; no board yet.
**Job:** a member reports the open message to IsItLegit in at most two actions, by keyboard or screen reader as well as by mouse, and the forward always carries the original as an attachment.
**Treatment:** one button labelled "Check with IsItLegit", one short confirmation, the IsItLegit mark; Outlook's own task-pane layout.
**Chrome:** Outlook's add-in surfaces only (the ribbon button and a task pane), no second window.

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

After a forward, the member hears nothing until the verdict reply (D01 T02 §3), so a forward that was accepted and one that was lost look the same for up to a minute or more (D01 T01 §3 completion review, Part 2 item 2). A short acknowledgement can say the forward was received and give the case reference within seconds of admission. Silent refusal stays for senders intake does not admit (spec 4.1: no backscatter).

**Phase:** 7
**Needs:** none
**Surface:** yes

**Fidelity:** `design/SPEC.md` gains the acknowledgement's copy and layout beside the reply's (D07 T03 §7); no board yet.
**Job:** an admitted forward is acknowledged with its case reference within five seconds of admission, and only then; a refused one is never answered.
**Treatment:** plain text, two lines: received, the case reference, and that the answer follows; no verdict and no link.
**Chrome:** the reply's own mail template (D01 T02 §3), not a new one.

**Build order:**

1. Decide whether the acknowledgement is sent, and its copy, in the SPEC. Done when: the SPEC records the decision and the copy, or records that none is sent and why.
2. Send it after admission and prove it is never sent for a refusal. Done when: an admitted forward gets one acknowledgement and a refused one gets nothing.

- [ ] Record in `design/SPEC.md` whether an acknowledgement is sent (weighed against one more mail per check and the reply arriving within a minute), with its copy if so. Done when: the SPEC section states the decision with its reason.
- [ ] Send the acknowledgement as mail kind `notice` under the send key `ack:<caseId>` from `handleEmail` (`src/intake/email.ts`) after the claim is marked done, its outcome never failing the delivery. Done when: `test/intake/email.test.ts` sees one acknowledgement naming the case reference for an admitted forward, none for a duplicate, a capped, a dropped or a too-large one, and none twice for a retried delivery.
- [ ] Measure the time from the handler's start to the acknowledgement's send in the live smoke (D01 T01 §9's fixture). Done when: `docs/live-checks.md` records it under five seconds.
- [ ] Commit: `intake: acceptance acknowledgement for a forward`

**Test checkpoint:** `pnpm exec vitest run test/intake/email.test.ts` passes and fails if a refused or duplicate forward is acknowledged, or one forward is acknowledged twice.

## Verification

- A synthetic forward to the live `check@` produces a case, R2 objects, step events and a reply with a working signed link.
- `pnpm test` passes, including every test named above; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
