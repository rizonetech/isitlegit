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
| 1 | §1 | Core D1 schema and migration runner | D00 T01 §5 | [ ] |
| 2 | §2 | Case store and R2 artefact layout | §1 | [ ] |
| 3 | §3 | Email handler for verified members | §2, D07 T02 §5 | [ ] |
| 4 | §4 | Forward-as-attachment detection | §3 | [ ] |
| 5 | §5 | MIME parsing and attachment extraction | §4 | [ ] |
| 6 | §6 | Outlook .msg parsing | §5 | [ ] |
| 7 | §7 | AnalysisWorkflow skeleton, partial reports | §5 | [ ] |
| 8 | §8 | Signed expiring report links | §1 | [ ] |
| 9 | §9 | Email Routing for check@ and live smoke | §7, D01 T02 §3 | [ ] |

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
- [ ] Commit: `db: core schema for cases, artefacts, evidence and step events`

Evidence 2026-10-27 14:30 SAST. `wrangler d1 migrations apply DB --local` (a scratch `--persist-to`) applied `0001_core.sql` ✅; `pnpm db:migrate:remote` applied it to the live `isitlegit` database ✅, `wrangler d1 migrations list DB --remote` then printed "No migrations to apply!", and `sqlite_master` lists `artefacts`, `case_events`, `cases`, `evidence`. `pnpm exec vitest run --project worker test/db`: 11 passed. Mutations, each failing the tests: the setup file removed (11 fail), `setStatus` accepting `bogus`, `setVerdict` storing nothing, a read ignoring `orgId` (1 fails each).

**Test checkpoint:** `pnpm exec vitest run test/db/cases.test.ts` passes, and fails when `setStatus` accepts `"bogus"`, when `setVerdict` stores nothing, or when a read ignores `orgId`.

## 2. Case store and R2 artefact layout

Raw mail and every artefact live in R2 under the case id; D1 holds only metadata (spec 4.2). The `raw/` prefix carries the 30-day lifecycle rule from D00 T01 §5, so raw content is never written elsewhere.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/intake/store.ts` with key builders and put helpers that hash content. Done when: tests show the exact keys and the SHA-256 in the artefact row.
2. Refuse writes outside the layout. Done when: a bad kind or case id throws before any R2 call.

- [ ] Write `rawKey(caseId)` returning `raw/<caseId>/message.eml`, `attachmentKey(caseId, name)` returning `raw/<caseId>/attachments/<sha256>-<safeName>`, and `artefactKey(caseId, kind, name)` returning `art/<caseId>/<kind>/<sha256>-<safeName>` for derived artefacts (screenshots, crops, the parsed summary) in `src/intake/store.ts`. Done when: `test/intake/store.test.ts` asserts all three formats and fails if an attachment is written outside `raw/`. (**Corrected 2026-10-27**, D00 T01 §5 plan review: attachments were `art/` artefacts, outside the 30-day `raw/` lifecycle rule, though the design spec deletes raw messages and attachments after 30 days.)
- [ ] Write `putRaw` and `putArtefact` that compute SHA-256 with WebCrypto, write to `ARTEFACTS` and insert the `artefacts` row in one step. Done when: a test with the R2 binding reads the object back and finds the matching row. Cheaper substitute: storing bodies in D1 blobs.
- [ ] Sanitise attachment names (path separators, control characters, length cap 120) before they enter a key. Done when: a test with `../../x.eml` and a 500-character name yields a safe key.
- [ ] Refuse a case id that is not a ULID and a kind outside the `artefacts.kind` list. Done when: both raise a typed `StoreError` in tests.
- [ ] Commit: `intake: case store and R2 artefact layout`

**Test checkpoint:** `pnpm exec vitest run test/intake/store.test.ts` passes and fails if `rawKey` stops using the `raw/` prefix.

## 3. Email handler for verified members

The `email()` handler is the front door (spec 4.1). Only mail from a verified member domain or registered sending address is processed; everything else is dropped without a reply, which prevents abuse and backscatter. Counterparty mail for protected identities joins later through D05 T02 §1, which extends this gate.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/intake/email.ts` exporting the `email` handler. Done when: a fixture from a member domain creates a case and starts a Workflow; an unknown sender does neither.
2. Enforce the size limit. Done when: a 26 MiB message is rejected with `setReject` and no case.

- [ ] Write `handleEmail(message, env, ctx)` in `src/intake/email.ts` reading `message.from` and the raw stream once into an `ArrayBuffer`. Done when: a test passes a synthetic `ForwardableEmailMessage` and gets a case id back.
- [ ] Call `findMemberBySender(from)` from D07 T02 §5 and drop the message (no reply, no case) when it returns null. Done when: `test/intake/email.test.ts` shows an unknown sender leaves `cases` empty and calls no mail sender. Cheaper substitute: replying "not registered", which creates backscatter.
- [ ] Reject messages over 25 MiB with `message.setReject("Message too large")` (Email Routing limit, stack doc). Done when: a test with a 26 MiB body is rejected and stores nothing.
- [ ] Store the raw message with `putRaw` from §2, create the case with `createCase` from §1, and start `env.ANALYSIS.create({ id: caseId, params: { caseId } })`. Done when: a test sees one raw object, one case row and one Workflow create call with the case id as the instance id.
- [ ] Make the handler idempotent on `Message-ID` per organisation within 24 hours using a `CACHE` key. Done when: delivering the same fixture twice creates one case. Cheaper substitute: none; duplicate deliveries happen on retries.
- [ ] Export `email` from `src/index.ts` next to `fetch`. Done when: `pnpm typecheck` passes and `wrangler deploy --dry-run` lists the email handler.
- [ ] Commit: `intake: email handler for verified members`

**Test checkpoint:** `pnpm exec vitest run test/intake/email.test.ts` passes, and fails if the member check is removed.

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
2. Store attachments and the parsed summary. Done when: R2 holds each attachment under `raw/<case>/attachments/` and `art/<case>/parsed/summary.json` (**Corrected 2026-10-27:** attachments sit under the 30-day `raw/` rule).

- [ ] Add exact dependency `postal-mime` 4.1.4 to `package.json`. Done when: `pnpm install` resolves it.
- [ ] Write `parseMessage(bytes)` returning headers (as an ordered list, duplicates kept), `text`, `html`, and attachments with filename, media type, content id and bytes. Done when: `test/intake/parse.test.ts` checks a multipart fixture with two attachments and an inline image.
- [ ] Store each attachment with `putArtefact(caseId, "attachment", name)` and inline images with kind `attachment` plus `content_id` in the summary. Done when: the test finds three artefact rows for the fixture.
- [ ] Write the parsed summary (headers, text, html, attachment keys) to `art/<caseId>/parsed/summary.json`. Done when: the test reads it back and it is under 1 MiB for the fixture.
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

Reply emails carry a link to the report that opens without a session: HMAC-signed with `REPORT_LINK_SECRET`, scoped to one case and organisation, expiring after 7 days (stack doc, spec 4.8). A tampered or expired link is refused, never served.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/web/report-link.ts` with `signReportLink` and `verifyReportLink`. Done when: round-trip, tamper, wrong-org and expiry tests pass.

- [ ] Write `signReportLink(caseId, orgId, now)` producing `/r/<caseId>?o=<orgId>&e=<expiry>&s=<base64url HMAC-SHA256>` with WebCrypto and `REPORT_LINK_SECRET`. Done when: a test signs and verifies a link.
- [ ] Write `verifyReportLink(url, now)` comparing signatures in constant time and refusing expiry in the past. Done when: tests refuse a changed case id, a changed org id, an expired link and a missing signature.
- [ ] Refuse to sign when `REPORT_LINK_SECRET` is missing or shorter than 32 bytes. Done when: a test with a short secret throws `ConfigError`. Cheaper substitute: a default secret, which would make every link forgeable.
- [ ] Add `REPORT_LINK_SECRET` to the secrets list in `docs/specs/2026-10-26-tech-stack-design.md` check and set it with `wrangler secret put` from a generated 32-byte value stored in the Conclave vault as "IsItLegit report link secret". Done when: `wrangler secret list` names it. 
- [ ] Commit: `web: signed, expiring report links`

**Test checkpoint:** `pnpm exec vitest run test/web/report-link.test.ts` passes and fails if the comparison ignores the org id.

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
- [ ] Commit: `intake: Email Routing for check@ with a live end-to-end smoke`

**Test checkpoint:** `pnpm exec tsx scripts/send-fixture.ts test/fixtures/forward/attached-rfc822.eml --wait 120` exits 0 after finding the case in D1 with status `done` and a reply logged in SMTP2GO.

## Verification

- A synthetic forward to the live `check@` produces a case, R2 objects, step events and a reply with a working signed link.
- `pnpm test` passes, including every test named above; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
