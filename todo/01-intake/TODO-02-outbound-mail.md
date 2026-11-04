---
schema_version: 1
id: outbound-mail
domain: 01-intake
status: active
title: "TODO-02 -- Outbound Mail, Recipient Allowlist and Replies"
track: day-1
---

# TODO-02 -- Outbound Mail, Recipient Allowlist and Replies

> **Goal:** Every message IsItLegit sends (verdict replies, sign-in links, verification requests, impersonation alerts, operator notices) goes through one SMTP2GO client that only delivers to allowed recipients, threads replies to the forwarded message, and records each send; the test-mailbox and demo aliases on `isitlegit.co.za` route to the operator's mailbox.

> **Current state:** Measured 2026-10-26 20:00 SAST. No mail code exists. The vault holds "Rizonetech SMTP2GO"; the IsItLegit sender domain and its restricted key come from D99 T01 §4. No Email Routing aliases exist on the zone.

## Inputs

- `docs/specs/2026-10-26-tech-stack-design.md` "Outbound mail" (SMTP2GO HTTP API `POST https://api.smtp2go.com/v3/email/send`, `In-Reply-To` and `References`).
- Design spec 4.1 (reply), 4.6a (no model decides recipients), 11 (Outbound and Mailbox decisions).
- RFC 5322 section 3.6.4 (`Message-ID`, `In-Reply-To`, `References`).
- -> XREF: D01 T01 §4 -- the forward's path and the count of attached messages not checked, which the reply explains
- -> XREF: D01 T01 §9 -- the live intake smoke that waits for the reply path

## Outcome

- A send to an address outside the allowlist is refused in code and logged, before any network call.
- A verdict reply arrives threaded under the member's forward, from `check@isitlegit.co.za`, with the signed report link.
- `finance@demo.isitlegit.co.za`, `alerts@demo.isitlegit.co.za` and `conduct@isitlegit.co.za` forward to the operator's verified mailbox.

**Adjacency:** list=not-applicable (sends are listed per case in the report's model trace and in SMTP2GO's activity log); document=applicable @ D07 T03 §7; settings=not-applicable (sender addresses and the allowlist are fixed in code by the operator's decision); reporting=not-applicable (delivery counts appear in the member console through case events); notifications=applicable @ D01 T02 §3; permissions=applicable @ D01 T02 §2; audit=applicable @ D01 T02 §1; exchange=not-applicable (no import or export of mail); reverse=not-applicable (a sent message cannot be recalled)

**Adjacency rationale:** This file is the notification channel itself. The allowlist in §2 is its permission boundary and every send writes a `mail_sends` row (§1) as the audit trail. The final reply design lives with the report surface (D07 T03 §7).

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | SMTP2GO client with retries and send log | D01 T01 §1 | [x] |
| 2 | §2 | Recipient allowlist enforced in code | §1, D07 T02 §3 | [x] |
| 3 | §3 | Threaded reply with a signed report link | §2, D01 T01 §7, D01 T01 §8 | [x] |
| 4 | §4 | Test and demo mail aliases | §1 | [x] |
| 5 | §5 | Reconcile uncertain sends | §1 | [x] |
| 6 | §6 | Forwarding failures detected and reported | §1, §4 | [x] |
| 7 | §7 | Automatic recovery of ambiguous sends | §5 | [x] |
| 8 | §8 | Re-deliver a reply settled failed | §3, §5 | [x] |
| 9 | §9 | Forwarding failures proven live | §6 | [x] |
| 10 | §10 | A failed check's reply points to its retry | D01 T01 §17, D07 T03 §20 | [ ] |
| 11 | §11 | Authentication results in the reply | §3 | [x] |
| 12 | §12 | A forwarding refusal alerted within minutes | §9 | [x] |
| 13 | §13 | Destination trace linked | §9 | [ ] |
| 14 | §14 | Refusal-to-alert time measured live | §12 | [x] |
| 15 | §15 | Early refusal alert before attribution | §12 | [ ] |
| 16 | §16 | Reported methods only in the reply | §11, D07 T03 §34, D07 T03 §35 | [x] |
| 17 | §17 | Sender domains for the headers panel | §11, D07 T03 §36 | [x] |

## 1. SMTP2GO client with retries and send log

> **Started:** 2026-10-27T18:30Z

One module owns delivery (stack doc). It calls the SMTP2GO HTTP API with `fetch`, retries transient failures, and records every attempt without message bodies, so a failed reply is visible on the case instead of vanishing.

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-27** (validation against the repository and SMTP2GO's API reference, `https://developers.smtp2go.com/reference/send-standard-email`, read 2026-10-27): migration 0002 is taken (`0002_evidence_order.sql`), so this is 0003; the API key goes in the `X-Smtp2go-Api-Key` header, not the body; SMTP2GO answers 200 even when sending failed, so `data.failed` and `data.failures` decide the outcome; it documents no retry guidance, so a request that got no answer may have been delivered and is recorded as uncertain, never retried (a retry could mail someone twice); and D07 T08 §7 adds a `renewal` kind. `ConfigError` (D01 T01 §8) moves to a shared `src/config.ts` so the mail client refuses a missing key the same way.

**Build order:**

1. Write `src/mail/smtp2go.ts` with `sendMail`. Done when: a stubbed `fetch` test sends one message with the exact JSON body SMTP2GO expects.
2. Log each attempt to `mail_sends`. Done when: success and failure both leave a row.

- [x] Add migration `src/db/migrations/0003_mail.sql` with `mail_sends` (`id`, `send_key` unique and not null, `case_id` nullable referencing `cases` with `ON DELETE CASCADE`, `kind` one of reply, signin, verify, alert, notice, renewal, `to_hash`, `status` one of pending, sent, failed, uncertain, refused, `provider_id`, `attempts`, `error`, `created_at`, `updated_at`); store a SHA-256 of the trimmed, lower-cased recipient, never the address or any body. Done when: `pnpm db:migrate:local` applies it, and `test/db/schema.test.ts` round-trips `refused` (D01 T02 §2 writes it), refuses an unknown kind or status and a repeated `send_key`, and deleting a case with sends removes its rows while another case's sends and those with no case stay. (**Corrected 2026-10-27**, plan review P2 2 and 3.)
- [x] Write `sendMail({ kind, to, from, subject, text, html, headers, caseId })` in `src/mail/smtp2go.ts` posting to `https://api.smtp2go.com/v3/email/send` with the key in `X-Smtp2go-Api-Key`, a body of `sender`, `to` (an array), `subject`, `text_body`, `html_body` and `custom_headers` (`[{ header, value }]`, refusing `Content-Type`, `Content-Transfer-Encoding` and `MIME-Version`, which SMTP2GO forbids), and a bounded timeout; a missing `SMTP2GO_API_KEY` (typed in `src/types/secrets.d.ts`) is a `ConfigError`. Done when: `test/mail/smtp2go.test.ts` asserts the request URL, header and body against the field names of SMTP2GO's documented example.
- [x] Record the intent before any network call: `sendMail` takes a stable `sendKey` from the caller (`reply:<caseId>` for a case's reply), inserts its `pending` row first, and sends nothing if the key already has a row that is `pending`, `sent` or `uncertain` (a pending row left by a stopped Worker is answered as uncertain, never sent again); only a `failed` row may be tried again, by the same row. Done when: tests show that SMTP2GO accepting the message and the outcome write then failing, followed by the caller calling again with the same key, makes exactly one provider call, and that a pending row from a stopped send is reported uncertain with no call. Cheaper substitute: checking for a row after sending, which loses the record when the write fails and mails twice. (**Corrected 2026-10-27**, plan review P1 1.)
- [x] Return a typed outcome callers must read: `sent` (with the provider's `email_id`), `failed` (rejected, with the reason: retries exhausted, a 4xx, or `data.failed` above 0), `uncertain` (no answer, or an answer that cannot be read) or `duplicate` (the key's earlier outcome), never throwing for a provider outcome. `sent` needs a 200 whose body parses, with `data.succeeded` at least 1, `data.failed` 0 and a string `data.email_id`; a 200 that is truncated, not JSON or missing those fields is `uncertain` and not retried. Done when: tests read what the caller gets for success, exhausted retries, a provider rejection, a 200 with a failure, a malformed 200 and a truncated body. (**Corrected 2026-10-27**, plan review P2 4.)
- [x] Retry a 429 only (**corrected 2026-10-27** by the completion review: a 5xx can follow SMTP2GO's acceptance, and SMTP2GO takes no idempotency key, so retrying it could send twice; a 5xx is now `uncertain`), 3 attempts in all ("up to 3 times" was read by its own test as three attempts), each attempt counted on the row as it ends, with backoff (an injectable pause); never retry a 4xx, a 200 whose `data.failed` is above 0, or a request that got no answer (recorded `uncertain`, since it may have been delivered). Done when: tests cover a 503 then 200, a 429 three times then failed, a 400 that fails at once, a 200 with a failure reported, and a timeout recorded uncertain with one attempt.
- [x] Write the `mail_sends` row on every outcome with the provider's `email_id`, the attempts and a short error (never the address, the body or the key). Done when: tests find `sent`, `failed` and `uncertain` rows and no address, body or key in any of them. Cheaper substitute: console logging only.
- [x] Commit: `mail: SMTP2GO client with retries and a send log`

Evidence 2026-10-27 20:45 SAST. `src/db/migrations/0003_mail.sql` (`mail_sends`, a unique `send_key`, `ON DELETE CASCADE` on `case_id`, statuses pending, sent, failed, uncertain and refused) applies with `pnpm db:migrate:local`; `test/db/schema.test.ts` round-trips every status and kind, refuses an unknown one, a repeated key and an address in `to_hash`, and deletes a case's sends with it while another case's and those with no case stay. `src/mail/smtp2go.ts` writes the pending row before any call, posts SMTP2GO's documented fields with the key in `X-Smtp2go-Api-Key`, and returns `sent`, `failed`, `uncertain` or `duplicate`; `ConfigError` moved to `src/config.ts` (re-exported from `src/web/report-link.ts`), and `SMTP2GO_API_KEY` is typed in `src/types/secrets.d.ts`. `pnpm exec vitest run test/mail/smtp2go.test.ts test/db/schema.test.ts`: 18 passed, including SMTP2GO accepting a message whose outcome write then fails, followed by two retries, with exactly one call. Seven mutations (a 400 retried, a timeout retried, the intent written too late, a pending row sent again, any 200 trusted, a reported failure ignored, the address stored unhashed) each fail it.

Evidence after the completion review, 2026-10-27 20:56 SAST. Its three in-scope gaps and its retry conflict are closed in the commit that follows this line: a broken error stream still yields a typed, recorded outcome; each attempt and its reason are on the row as it ends, so a stop during the backoff keeps them, and a send that went through after a retry keeps the reason; tests now wait for the real deadline and send the same key from two callers at once (one call, for a new key and for a failed one); only a 429 is retried, a 5xx is `uncertain`; and every send carries its key in an `X-IsItLegit-Send` header for later reconciliation (§5). `pnpm exec vitest run test/mail/smtp2go.test.ts`: 13 passed; six more mutations (the stream failure escaping, a 5xx retried, attempts not counted as they end, a failed key claimed by two callers, no deadline, no send-key header) each fail it.

**Test checkpoint:** `pnpm exec vitest run test/mail/smtp2go.test.ts test/db/schema.test.ts` passes, and fails if a 400 or an unanswered request is retried, or if a send whose outcome write failed is sent again.

> **Verified:** 2026-10-27 | §1 | 4b44c83d8b59711f5dcda779f712d42f56367395
> **Review:** `docs/reviews/d01-t02-s1.json`

## 2. Recipient allowlist enforced in code

> **Started:** 2026-10-28T03:19Z

The operator decided that during the event the system mails only registered members and Rizonetech-controlled test mailboxes (design spec section 11). Recipients come from code and stored records, never from a model (spec 4.6a). This guard sits inside `sendMail`, so no caller can skip it.

**Corrected 2026-10-28:** checked against the code D07 T02 §1 to §3 shipped. `SendOutcome` has no `refused` case although `mail_sends.status` allows it and §1's magic-link sender already treats an allowlist refusal as undelivered, so the outcome type gains it and its callers are checked. Members and invitees are Better Auth's tables (`user`, `member`, `invitation`, migrations 0007 and 0010). Invite-code signup (D07 T02 §4) mails a link to an address that is not yet a member, so §4 must make it one before the link goes (written into §4). The auth and mail tests mail `example.com` addresses, which this refuses; their fixtures move to `@demo.isitlegit.co.za`, and refusal gets its own tests. A refused sign-in answers as §1 decided (not delivered, an error), which tells the asker the address is not registered; that is accepted for the closed event, with §6's rate limits bounding how fast anyone can ask. **Corrected 2026-10-28** after the final review, which found that bound unbuilt and the refused rows and demo-alias sends unbounded meanwhile: a refused sign-in is now answered exactly as a sent one (no enumeration; this changes §1's stamped "refused is an error" for the refused case only), is not recorded (a stranger's request cannot grow `mail_sends`; refusals of the system's own kinds still are), and no address gets more than 5 sign-in mails in 10 minutes, counted from the sends on record; §6 adds the per-IP limit and the audit trail.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/mail/allowlist.ts` with `isAllowedRecipient`. Done when: members, member invitees, and `*@demo.isitlegit.co.za` aliases pass; everything else is refused.
2. Call it from `sendMail`. Done when: a refused address never reaches `fetch`.

- [x] Write `isAllowedRecipient(db, address, kind, operatorEmail)` in `src/mail/allowlist.ts`, comparing addresses in lower case, by purpose (design spec section 11): a **member** is a `user` with a `member` row in any organisation (membership is the authorisation: it exists only through invite-code signup, D07 T02 §4, or an accepted invitation, so `emailVerified` is not required and a first signup's link is not blocked; **Corrected 2026-10-28** after the plan review, which found requiring it blocked the first signup); a **demo alias** is an address at exactly `isitlegit.co.za` or `demo.isitlegit.co.za` (not look-alikes such as `isitlegit.co.za.evil.example`); the **operator** is var `OPERATOR_EMAIL`. Allowed per kind: `signin` to members, pending unexpired invitees, demo aliases and the operator; `reply`, `notice` and `renewal` to members, demo aliases and the operator; `verify` (closed-loop verification) to demo aliases only; `alert` (impersonation and counterparty alerts, the operator's unsettled-send handover) to demo aliases and the operator only, never a member's own address. Done when: `test/mail/allowlist.test.ts` covers each allowed pair and refuses an unregistered address, a registered user with no organisation, an expired or cancelled invitee, an invitee for a non-`signin` kind, a member for `verify` and for `alert`, and a look-alike domain.
- [x] Call the allowlist first inside `sendMail` (`src/mail/smtp2go.ts`) and record a refused send as `mail_sends.status = refused` under its send key with `INSERT ... ON CONFLICT DO NOTHING`, so a key already on record (sent, pending, uncertain, failed or refused) keeps its row and its delivery evidence and is never sent, returning a new `{ status: "refused" }` outcome; check every caller of `sendMail` handles it (§1's magic link and §3's invitation after hook count it as not delivered; the reconcile and reply paths treat it as final, never retried). Done when: a test with `someone@example.com` shows no `fetch` call and a `refused` row, the same key refused twice leaves one row, a refusal under a key already `sent`, `failed` or `uncertain` leaves that row as it was and calls no `fetch`, the magic-link request to it answers its error, and `pnpm typecheck` passes with the new case. Cheaper substitute: checking at each call site, which one caller will forget.
- [x] Keep the auth and mail tests on real-member addresses: a test helper makes an `example.com` user and its membership through Better Auth (as invite-code signup will) before that address signs in, invitations are created, delivered, accepted and removed through the real handlers and `sendMail`, and the demo domain is used only where a non-member must be mailed (a user with no organisation). Done when: `pnpm exec vitest run` passes with the allowlist on, the member and invitee flows run on `example.com` addresses that the allowlist admits by their records (not by the demo exemption), and no test mails an address it refuses except the refusal tests. (**Corrected 2026-10-28:** said to move every fixture to the demo domain, which would let a broken member path pass.)
- [x] Set `OPERATOR_EMAIL` as a Worker var from the operator's Rizonetech address (design spec section 11, Mailbox). Done when: `wrangler.jsonc` has the var and `pnpm typecheck` sees it. (Already true: `wrangler.jsonc` has `OPERATOR_EMAIL` and `worker-configuration.d.ts` types it, set by D01 T02 §5 for the reconcile handover.)
Evidence 2026-10-28. `src/mail/allowlist.ts` holds `isAllowedRecipient` by purpose (members by their Better Auth membership, pending unexpired invitees for `signin`, the two demo domains exactly, the operator; `verify` to demo aliases only, `alert` to demo aliases and the operator). `sendMail` asks it first: a refusal is a `refused` row under its key (`ON CONFLICT DO NOTHING`, a key on record untouched) and a `{ status: "refused" }` outcome with no fetch, and an unreadable allowlist is a `failed` outcome with nothing sent. The magic-link sender counts a refusal as not delivered; the reconcile handover reports a refused operator alert as a configuration error, never retried. `pnpm exec vitest run test/mail test/auth`: 8 files, 104 passed: `test/mail/allowlist.test.ts` (each kind for members, invitees, demo aliases and the operator; an unregistered address, a user with no organisation, expired and cancelled invitees, four look-alike domains and an unset operator refused), `sendMail` refusing with no fetch and one row however often asked, a refusal leaving a `sent`, `failed` or `uncertain` row as it was, an unreadable allowlist sending nothing; a real `example.com` member signing in by membership and a stranger's link refused; the organisation tests on `example.com` members made through Better Auth, the demo domain only for non-members. Full suite 534 passed, 2 skipped. Ten mutations each fail them.

- [x] Commit: `mail: recipient allowlist enforced inside the sender`

**Test checkpoint:** `pnpm exec vitest run test/mail test/auth` passes and fails if the allowlist call is moved out of `sendMail`, a look-alike domain or an unregistered address is allowed, a member is sent `verify` or `alert` mail, a refused send reaches `fetch`, or a refusal overwrites a send already on record.

> **Verified:** 2026-10-28 | §2 | 10344d67140204d4bc5cc1444e7b7c1b9b60f082
> **Review:** `docs/reviews/d01-t02-s2.json`

## 3. Threaded reply with a signed report link

> **Started:** 2026-10-28T13:50:30Z

The member gets the answer as a reply in the same thread (spec 4.1): verdict, top three reasons, what to do now, and the signed report link. Subject, recipient and template come from code; the model only fills validated fields later (spec 4.6a). The final visual design is D07 T03 §7; this section ships the plain-text and minimal HTML version that works from day one.

**Corrected 2026-10-28:** this section listed only §2 and D01 T01 §8, but its reply step is a step of D01 T01 §7's AnalysisWorkflow (today one `accept` step) and its threading and recipient read the forward's `Message-ID`, `References`, subject and forwarder that intake stores (D01 T01 §3 to §5, before §7); built before them, `buildReply` would invent its input. It now depends on D01 T01 §7, which needs those. No cycle: D01 T01 §9 depends on §7 and on this section.

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** after the plan review (`docs/reviews/01-intake/D01-T02-s3.md`): the reply was built from a verdict view the Workflow does not hand over (only the label), its HTML escaping was unstated, a `mail_sends` row could pass the tests without a correct provider call, a partial reply still needed the raw forward, threading omitted RFC 5322's fallbacks, and the tests' `APP_URL` is `http://localhost`, which an `https` rule refuses. The items below carry each fix.

**Build order:**

1. Write `src/mail/reply.ts` building the reply from a case. Done when: a test produces headers `In-Reply-To` and `References` equal to the forward's `Message-ID`.
2. Wire the Workflow `reply` step to it. Done when: the stub pipeline sends one reply per case.

- [x] Write `buildReply(caseRow, verdictView, reportUrl)` returning subject `Re: <original subject>` (trimmed to 120 characters), `text` and `html` bodies with verdict, headline, up to three reasons and the action. Done when: `test/mail/reply.test.ts` snapshots both bodies for a fixture verdict.
- [x] Escape every value placed in the HTML body for its context (text content and attribute), so a headline, reason or action is always literal text, never markup or a link; the only link in either body is the report link, made by code. Done when: `test/mail/reply.test.ts` builds a reply whose headline, reasons and actions hold `<a href=...>`, `<script>`, quotes and `&`, and finds each escaped in the HTML, literal in the text, and exactly one `href`, the report link's. (**Added 2026-10-28**, plan review P1 2.)
- [x] Read the verdict to reply with inside the `reply` step: `getVerdict` (`src/db/verdicts.ts`) for a `ready` state; a missing row or a database refusal throws so the step retries (then `fail`), never a reply built without it. Done when: a Workflow test with a distinctive stored headline, reasons and actions finds them in the bodies sent to the SMTP2GO stub. (**Added 2026-10-28**, plan review P1 1: the Workflow hands over only the label.)
- [x] Thread with `In-Reply-To: <forward Message-ID>` and `References: <forward References> <forward Message-ID>` (RFC 5322 section 3.6.4). Done when: the test reads both headers. (**Corrected 2026-10-28** after the plan review, P2 5: RFC 5322's fallbacks as well: a parent with no `References` but an `In-Reply-To` holding one message id gives `References: <that id> <parent Message-ID>`; a parent with no `Message-ID` gives no `In-Reply-To` and `References` from its `References` (or single `In-Reply-To`) alone; a parent with none of the three gives neither header. Fixtures for each and for an existing `References` chain.) (**Corrected 2026-10-28** at start: the case stores the forward's `Message-ID` (`cases.message_id`, D01 T01 §3) but not its `References` or subject; the `reply` step reads both from the stored forward's header block (`raw/<case>/message.eml`, read only to its blank line and parsed by `postal-mime` as headers), present for 30 days. When the header block cannot be read (the raw message gone or unreadable, as in a `partial` case that failed on `RawMissing` or storage), the reply still goes: the subject is `Re: your IsItLegit check`, made by code, and threading uses the case's stored `Message-ID` alone. (**Corrected 2026-10-28** after the plan review, P2 4.))
- [x] Explain missing headers when `headers_available = 0`: one sentence on forwarding as an attachment in Outlook and Gmail. Done when: the inline-forward fixture's reply contains it.
- [x] Say when only the first of several attached messages was checked (the parsed summary's `forward.otherOriginals` above 0): one sentence asking the member to forward each on its own. Done when: the `two-originals` fixture's reply (D01 T01 §4) contains it and a single-original reply does not. Source: D01 T01 §4 plan review, 2026-10-28.
- [x] Call `buildReply` and `sendMail({ kind: "reply" })` from the Workflow `reply` step with a link from `signReportLink` (D01 T01 §8), to the case's admitted forwarder (`cases.forwarded_by`), from `IsItLegit <check@isitlegit.co.za>`, under send key `reply:<case id>`. Done when: the Workflow test records one `mail_sends` row of kind `reply`. (**Corrected 2026-10-28** at start: the recipient, sender and key were unstated. A case with no forwarder (an upload) sends no reply and the step says so; a `failed` send throws so the step retries; an `uncertain` one is left to the reconcile job (`src/mail/reconcile.ts`), since it may have gone; a `refused` one (the forwarder no longer allowed) is final. The Workflow tests get test values for `SMTP2GO_API_KEY` and `REPORT_LINK_SECRET` with SMTP2GO stubbed, and a demo alias as the forwarder, which the allowlist admits.)
- [x] Build the reply's report link as an absolute `https://` URL from the trusted public origin in the Worker's configuration (a `PUBLIC_ORIGIN` var in `wrangler.jsonc`, equal to `APP_URL` in production, refused unless it is `https` with no path, query or credentials; **corrected 2026-10-28** after the plan review, P2 6, undoing the start's switch to `APP_URL`: the tests run the app at `http://localhost`, so the Workflow tests set `PUBLIC_ORIGIN` to an `https` test origin, and `test/mail/reply.test.ts` refuses `http`, a path and a malformed value), never from a request's `Host`, joined to `signReportLink`'s path. Done when: `test/mail/reply.test.ts` finds the same absolute link in the `text` and the `html` body, and `verifyReportLink` accepts its path and parameters. (**Added 2026-10-27**, D01 T01 §8's plan review P2 4.)
- [x] Reply to a `partial` case too: the Workflow's `reply` step (D01 T01 §7) passes `{ status: "partial", failedStep, errorClass }` with no verdict and possibly no parsed summary, and the member is told plainly that the check could not finish, what to try (forward again; for an unreadable attachment, forward as `.eml`), with no verdict implied and no internal step or section names. Done when: `test/mail/reply.test.ts` builds the partial reply for a failed `parse` and a failed `checks` without a verdict or summary, and the Workflow test records one `mail_sends` row of kind `reply` for a partial case. (Assigned by D01 T01 §7's plan review, 2026-10-28.)
- [x] Prove each send outcome through the Workflow, reading the SMTP2GO stub's request (recipient, sender, `In-Reply-To`, `References`, both bodies, the signed link) and the resulting `mail_sends` status: sent; a failure then success (one row, sent); failure on every attempt (the case `partial` naming `reply`); uncertain (the case `done`, the row `uncertain` for the reconcile job); refused (no provider call); an upload with no forwarder (no row, no call); and a partial case with neither raw message nor summary (the fallback subject, one call). Done when: each passes, and removing the outcome handling fails at least one. (**Added 2026-10-28**, plan review P1 3: a row alone proved nothing about the call.)
- [x] Never send a second reply for the same case: the step checks `mail_sends` first. Done when: re-running the step sends nothing. Cheaper substitute: none; a retried step would otherwise mail twice. (**Corrected 2026-10-28** at start: `sendMail` already answers a key on record as `duplicate` without sending (D01 T02 §1), so the step's one key per case is the check; the test proves it through the step.)
- [x] Commit: `mail: threaded verdict reply with the signed report link`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply.test.ts test/pipeline/analysis-workflow.test.ts test/pipeline/reply-step.test.ts` passes and fails if the reply step sends twice. (**Corrected 2026-10-28**, completion review: the send and duplicate proofs are in `test/pipeline/reply-step.test.ts`, which the checkpoint had left out.)

> **Verified:** 2026-10-28 | §3 | 2adb8b3c37d9fa7a6116b066a775f96f48879711
> **Review:** `docs/reviews/d01-t02-s3.json`

## 4. Test and demo mail aliases

> **Started:** 2026-10-27T19:08Z

The fictional demo businesses need registered contacts that reach a real inbox, and `CODE_OF_CONDUCT.md` names `conduct@isitlegit.co.za`. All forward to the operator's Rizonetech mailbox once the operator has verified it as an Email Routing destination (D99 T01 §2).

**Phase:** 1
**Needs:** cloudflare
**Surface:** no

**Corrected 2026-10-27** (validation against the live zone, read through the Cloudflare API): the operator's mailbox `hostmaster@rizonetech.com` is already a destination and verified (D99 T01 §2, 2026-10-26 23:02 UTC), and `conduct@isitlegit.co.za` already forwards to it, beside `dmarc@` and `hello@`. The three `@demo.isitlegit.co.za` aliases need Email Routing enabled for that subdomain first (its own MX and SPF records); the zone has MX records for the apex only. No vault token can read Email Routing (the Cloudflare connector cannot create one, D99 T01 §8), and the repository has no `tsx`, so the checkpoint is the rules and DNS read back through the Cloudflare API and recorded, as D99 T01 §2's evidence was, rather than a script nobody here can run.

**Build order:**

1. Add the operator's mailbox as an Email Routing destination address. Done when: the API lists it (verification is the operator's click in D99 T01 §2).
2. Create the alias rules. Done when: each alias reads back with the operator mailbox as its forward target.

- [x] Create the destination address `OPERATOR_EMAIL` on account `f5a529987f8dc7d52ce7aba3da25e226` through the Email Routing API. Done when: it is listed (pending or verified). Already true: `hostmaster@rizonetech.com` is listed, verified 2026-10-26 23:02 UTC (D99 T01 §2).
- [x] Enable Email Routing for `demo.isitlegit.co.za` (`POST /zones/88aeec6df134bc59bfa16a25751241ef/email/routing/dns` with that name), so mail to its addresses is accepted. Done when: the zone's DNS holds the subdomain's Cloudflare MX records and SPF, read back through the API.
- [x] Create forward rules for `finance@demo.isitlegit.co.za`, `alerts@demo.isitlegit.co.za` and `owner@demo.isitlegit.co.za` to that destination, each named for its purpose; `conduct@isitlegit.co.za` already forwards (keep it). Done when: the rules list shows all four enabled, each forwarding to `hostmaster@rizonetech.com`.
- [x] Prove each new alias end to end by `docs/live-checks.md`'s procedure: once the subdomain's MX records resolve publicly (`dig +short MX demo.isitlegit.co.za @1.1.1.1`), send one uniquely named mail from `rizonetech@gmail.com` to each of `finance@`, `alerts@` and `owner@demo.isitlegit.co.za`, find each in `derick@rizonetech.com`, and record its subject, sender, send time and the arriving `internetMessageId`. Done when: all three arrived and are recorded; a missing arrival leaves this item open. `conduct@`'s delivery of 2026-10-26 22:58 UTC stands, its rule unchanged. (**Corrected 2026-10-27**, plan review P1: rules and DNS alone cannot show that mail arrives.)
- [x] Record the alias list and their purpose in `docs/live-checks.md`. Done when: the file lists the four aliases.
- [x] Commit: `mail: test and demo aliases on Email Routing`

Evidence 2026-10-27 21:25 SAST (operator's go-ahead, 21:18 SAST). Email Routing for `demo.isitlegit.co.za` reads `ready` (19:19:10 UTC) with MX `route1` (56), `route2` (9) and `route3` (32) `.mx.cloudflare.net` and SPF `v=spf1 include:_spf.mx.cloudflare.net ~all`, resolving on 1.1.1.1; the apex keeps its three MX records. The rules read back enabled, each forwarding to `hostmaster@rizonetech.com`: `finance@demo` (`53c50578`), `alerts@demo` (`f76e3ed2`), `owner@demo` (`0eecf0c7`), beside `conduct@`, `hello@` and `dmarc@`. A first test sent 15 s after the rules were created was refused `550 5.1.1 Address does not exist` for all three (the rules were not live yet); the second, sent from `rizonetech@gmail.com` about a minute later, arrived in `derick@rizonetech.com`: `IsItLegit routing test 2 (finance@demo) 2026-10-27T19:24Z`, sent 19:20:11 UTC, received 19:20:22 UTC, `<CA+OCnvmKmcQ_BE=jkmo6Vi2qfR-ymniCp-4pHA1BbBr4UnEOug@mail.gmail.com>`; `IsItLegit routing test 2 (alerts@demo) 2026-10-27T19:24Z`, sent 19:20:12 UTC, received 19:20:21 UTC, `<CA+OCnvm4HsE0R7rSXBoLAFHgXK2bM+FUYRQTeCOO3Yp5=MYX0w@mail.gmail.com>`; `IsItLegit routing test 2 (owner@demo) 2026-10-27T19:24Z`, sent 19:20:13 UTC, received 19:20:22 UTC, `<CA+OCnvkzByH6ZX4-jeZTS6vKAqO_Zuaw+PyacfuWd08o8w09eA@mail.gmail.com>`. The subjects' timestamp was written before sending and is not the send time. `docs/live-checks.md` lists the three aliases with their proof times and the propagation note.

> **Resolved:** detecting a forward that fails after Cloudflare accepted it, and telling the operator -> XREF: D01 T02 §6. Resolved 2026-10-30 by D01 T02 §6: refusals read from Email Routing's events as NDR notices, alerted to both operator mailboxes; its live proof is D01 T02 §9.

**Test checkpoint:** the Email Routing rules and the subdomain's MX records, read back through the Cloudflare API (`GET /zones/88aeec6df134bc59bfa16a25751241ef/email/routing/rules` and the zone's MX records), show the four aliases enabled, each forwarding to the verified operator destination, and `demo.isitlegit.co.za` routed to Cloudflare; the read-back is quoted in `docs/live-checks.md`, and each of the three demo aliases has a recorded arrival in `derick@rizonetech.com` (subject, sender, time, `internetMessageId`).

> **Verified:** 2026-10-27 | §4 | 54a60c80310a36f97edd4792d20df4d5295d5c64
> **Review:** `docs/reviews/d01-t02-s4.json`

## 5. Reconcile uncertain sends

> **Started:** 2026-10-27T19:28Z

A send recorded `uncertain` (no answer, an unreadable answer, or a 5xx, §1) may or may not have reached its recipient, and §1 rightly never sends it again blind. Left alone it stays uncertain for ever: a reply that was in fact delivered is reported as unknown, and one that never left is never sent. Every send carries its key in an `X-IsItLegit-Send` header (§1), so SMTP2GO's own record can settle it. Filed from §1's completion review (out-of-scope gap, 2026-10-27), which compared it with providers that replay an idempotent send's result.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Learn whether SMTP2GO can find a send by its header. Done when: the answer and its source are recorded here.
2. Settle uncertain sends from SMTP2GO's record. Done when: a send SMTP2GO has a record of becomes `sent` with its id, one with no record stays uncertain and reaches the operator after 3 days, and no message is ever sent twice.

- [x] Read SMTP2GO's API reference for searching sent mail (its email search or activity endpoints) and record here whether a send can be found by a custom header, by recipient and time, or not at all, with the reference's URL and the date read. Done when: the finding is recorded; if no lookup exists, the section records that and stops, and §1's uncertain rows stay for an operator. Finding, read 2026-10-27: `POST https://api.smtp2go.com/v3/activity/search` (https://developers.smtp2go.com/reference/search-activity.md; key in `X-Smtp2go-Api-Key`, 60 requests a minute, up to 1,000 events a page with `continue_token`) filters by `start_date` (inclusive) and `end_date` (exclusive), subject, sender, recipient and `event_types` (`processed`, `soft-bounced`, `hard-bounced`, `rejected`, `spam`, `delivered`, ...), and returns each event's `email_id`, `event`, `date` and, when `custom_headers: ["X-IsItLegit-Send"]` is asked for, that header's value; it cannot filter by a header's value, so the reconciler pages the send's time window and matches the value itself (the log keeps no recipient, only its hash, so recipient search is not used). The older `POST /v3/email/search` (https://developers.smtp2go.com/reference/view-sent-emails.md) is deprecated; it says to allow about two minutes after sending before an email appears, and the activity search states no delay, so absence is trusted only well past that.
- [x] Record each claim's own start: migration `src/db/migrations/0004_mail_claims.sql` adds `claimed_at` to `mail_sends`, and `sendMail` (`src/mail/smtp2go.ts`, D01 T02 §1) sets it on the first claim and again whenever it claims a `failed` row to try again, so a search looks where the current attempt went, not where the first one did. Done when: `test/mail/smtp2go.test.ts` finds `claimed_at` set on a first send and moved forward on a retry hours later, with `created_at` unchanged. (**Corrected 2026-10-27**, plan review P1 1.)
- [x] Write `reconcileUncertain(deps, { olderThanMinutes, youngerThanDays })` in `src/mail/reconcile.ts` that, for each `uncertain` or stale `pending` row in that age band, searches SMTP2GO's activity from 5 minutes before its `claimed_at` to 30 minutes after with `custom_headers: ["X-IsItLegit-Send"]`, paging with `continue_token` within a page budget, and settles a row only on positive evidence: an event whose header value is the row's send key means SMTP2GO took the message, so `sent` with its `email_id` (a `rejected` or bounce event is still sent, its reason kept). An empty search proves nothing (SMTP2GO states no maximum delay before an email appears), so the row stays `uncertain` and is never made retryable by the reconciler; an error or a page budget run out also leaves it. Done when: `test/mail/reconcile.test.ts` settles a found send and a found-then-bounced send, and leaves an absent send, a delayed one that appears on a later run (then settled), a failed search and a run out of pages, with a stubbed SMTP2GO and the real migration. (**Corrected 2026-10-27**, plan review P1 2.)
- [x] Settle a row only if it is still the same attempt in the same state the reconciler read: `UPDATE ... WHERE send_key = ? AND claimed_at = ? AND status IN ('uncertain', 'pending')`, so a reconciler that read a row before a retry, or two reconcilers at once, cannot overwrite a newer outcome or reopen a sent message. Done when: an interleaving test, with a retry through the real `sendMail` landing between the reconciler's read and its write, keeps the retry's outcome. (**Corrected 2026-10-27**, plan review P1 3.)
- [x] Hand an unresolved send to the operator, never let it age out silently: a row still uncertain when it leaves the age band (3 days) gets one `alert` mail to the operator (`sendMail`, send key `unresolved:<send key>`) naming its kind, its case and its send key, never an address; and `docs/operations.md` gives the resolution: look the send key up in SMTP2GO's activity, then set the row with `scripts/mail-settle.ts <send key> sent|failed` (refused unless the row is uncertain, `failed` only on the operator's word that SMTP2GO has no record). Done when: a test drives repeated search failures through the cutoff and finds one alert, the script's tests settle a row and refuse a sent one, and the page holds the steps. (**Corrected 2026-10-27**, plan review P2 5.)
- [x] Run it from the Worker's scheduled handler every 15 minutes: export `scheduled` from `src/index.ts` beside the HTTP handler, and add the cron trigger `*/15 * * * *` to `wrangler.jsonc`. Done when: a test calls the exported entrypoint's `scheduled` and finds the reconciler called with 3 days and 30 minutes, another reads the cron from `wrangler.jsonc`, and the HTTP routes still answer. (**Corrected 2026-10-27**, plan review P2 4.)
- [x] Never send from the reconciler: it only reads SMTP2GO and writes rows (and the operator alert goes through `sendMail` under its own key). Done when: the test fails if the reconciler makes a request to the send endpoint for the row it reconciles.
- [x] Commit: `mail: reconcile uncertain sends with SMTP2GO's record`

Evidence 2026-10-27 21:40 SAST. Migration `0004_mail_claims.sql` adds `claimed_at` (applied locally); `sendMail` sets it on every claim. `src/mail/reconcile.ts` searches SMTP2GO's activity around the latest claim, settles a row only on an event carrying its send key and only while the row is still the attempt and state it read, keeps an empty search uncertain, and hands a row still unresolved after 3 days to the operator once. `src/index.ts` exports `scheduled` beside `fetch`, and `wrangler.jsonc` adds the cron `*/15 * * * *` and `OPERATOR_EMAIL` (`hostmaster@rizonetech.com`). `scripts/mail-settle.ts` and `docs/operations.md` give the operator's resolution. `pnpm exec vitest run test/mail/reconcile.test.ts test/mail/smtp2go.test.ts test/scheduled.test.ts test/node/mail-settle.test.ts`: all pass, including a retry through the real `sendMail` landing between the reconciler's read and write (the retry's outcome kept) and a send that appears on a later run. Seven mutations (the retry keeping the old claim, a window ignoring the claim, absence made retryable, unconditional settlement, a repeated alert, a cron that does nothing, a settle that reopens a sent row) each fail them. `SMTP2GO_API_KEY` is not yet on the Worker, so the cron does nothing until it is; the live database needs migrations 0003 and 0004 before the next deploy (`docs/operations.md`, database migrations).

Evidence after the completion review, 2026-10-27 21:48 SAST. Its five in-scope gaps and two in-scope improvements are closed: an uncertain operator alert is reconciled like any send and the original counts as handed over only once the alert is known sent, with no alert about an alert; `scripts/mail-settle.ts` takes `--claimed-at` and settles only that attempt (the statement now in `src/mail/settle.ts`), so a repeated command cannot fail a newer one; malformed events are skipped and a match without an `email_id` or type settles nothing; a bounce keeps its event type and SMTP codes, never its text; each cron run logs one `mail-reconcile` line with its state (`disabled`, `ok`, `degraded`); and migration `0005_mail_search_cursor.sql` keeps a row's place in a long window across runs, with requests paced under 60 a minute and capped per run. `pnpm exec vitest run test/mail test/scheduled.test.ts test/node/mail-settle.test.ts`: 32 passed; ten more mutations each fail them. Automatic recovery within a minute needs a provider with idempotency keys: filed as §7.
> **Resolved:** recovering an ambiguous send automatically within a minute, with no operator -> XREF: D01 T02 §7. Resolved 2026-10-29 by D01 T02 §7 in `f3ca74c`, `bae3f7a`, `38bbd52` and `b63bfd4`: the operator kept SMTP2GO and this section's delayed recovery (2026-10-28 22:42 SAST), so no automatic recovery is built; the band is pinned by `test/scheduled.test.ts`.

Evidence after review rounds 1 to 4, 2026-10-27 22:03 SAST. Round 1 (`5cc220d`): operator alerts are keyed by attempt (`unresolved:<send key>@<claim time>`), so a later attempt that ages out gets its own alert; a failed alert makes the run degraded; migration `0006_mail_searched_at.sql` orders a backlog never-searched first, then least recently searched, so a run budget smaller than the backlog reaches every row. Round 2 (`edf767a`): `src/mail/settle.ts` accepts the `@` in alert keys; a spent request budget stops searching and pausing at once. Round 3 (`d42b204`): a run stops at a 10-minute deadline (`RUN_DEADLINE_MS`, under the scheduled handler's 15-minute limit) and cuts each request's timeout to the time left, reporting degraded. Round 4 approved. `pnpm exec vitest run`: 392 passed; every fix's mutation fails it. The live database needs migrations 0003 to 0006 before the next deploy.

**Test checkpoint:** `pnpm exec vitest run test/mail/reconcile.test.ts test/mail/smtp2go.test.ts` passes, and fails if a settled row is wrong, if an empty search makes a row retryable, if a stale reconciler overwrites a retry, or if the reconciler ever sends.

> **Verified:** 2026-10-27 | §5 | 3703516cb561ec3fd10d2fa084dae0db88b4f7ce
> **Review:** `docs/reviews/d01-t02-s5.json`

## 6. Forwarding failures detected and reported

> **Started:** 2026-10-30T13:44Z (restarted: the first start, 2026-10-27T20:02Z, recorded no build before the section waited on the operator's token, so its plan review comes first now)

Cloudflare accepts mail for an alias and then forwards it; a failure after that acceptance (the destination refusing it, a quota, a policy) is not reported to the original sender, because Cloudflare does not forward non-delivery reports (https://developers.cloudflare.com/email-service/reference/postmaster/#non-delivery-reports-ndrs). A judge or a demo contact's mail could then vanish with nobody told. Filed from §4's completion review (out-of-scope gap, 2026-10-27), which compared it with Exchange Online aliases, whose failures come back with a reason.

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-27** (Needs was `none`): the section cannot run unattended. Cloudflare's Email Routing events are in the GraphQL Analytics API (`emailRoutingAdaptive`, per zone, fields `datetime`, `sessionId`, `messageId`, `from`, `to`, `subject`, `status`, `action`, `errorDetail`, `isNDR`, `isSpam` and the authentication results; https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-email-routing/, read 2026-10-27), which publishes no list of `status` values and shows only `delivered`, so the failure values must be read from real events. Reading it needs an API token with Analytics Read; Wrangler's login has `email_routing (write)` but no analytics scope, and the Conclave vault holds no such token for this account. The live check also needs an Exchange Online mail flow rule set up by the operator.

**Operator action (open):** (1) create a Cloudflare API token with Zone Analytics Read on `isitlegit.co.za` and store it in the Conclave vault as "IsItLegit Cloudflare analytics token"; (2) when the live check is due, add the Exchange Online mail flow rule rejecting the test subject, and remove it after. Recording `Operator ready: <what> (YYYY-MM-DD)` here and removing `operator` from Needs releases the section; the 550 5.1.1 bounces of the first demo messages (D01 T02 §4, 2026-10-27, `docs/live-checks.md`) are real failures to read the status values from.

**Operator decision (2026-10-28 22:42 SAST):** build it; the operator creates the Cloudflare API token with Zone Analytics Read on `isitlegit.co.za` and stores it as "IsItLegit Cloudflare analytics token". `operator` stays in Needs until that item holds a credential; then `Operator ready: analytics token (2026-10-28)` is recorded here and the Need lifted.

**Operator ready:** analytics token (2026-10-30). The vault item "IsItLegit Cloudflare analytics token" holds it in its `credential` field; the coordinator verified it on 2026-10-30 at 15:16 SAST: Cloudflare's token verify reads it active, and an `emailRoutingAdaptive` query on the `isitlegit.co.za` zone read 5 events from the last 3 days, with statuses `delivered` and `dropped`, so `dropped` is one real failure value to read.

**Corrected 2026-10-30:** Needs was `operator`; the token is in the vault, so the section runs. Item (2) of the operator action, the Exchange Online mail flow rule, stays the operator's: the coordinator asks for it when the live check is reached.

**Corrected 2026-10-30** (at start, read from the live dataset with the vault token, never printed, 2026-10-30): (1) the finding item 1 asks for: `emailRoutingAdaptive` on the `isitlegit.co.za` zone holds every Email Routing event since 2026-10-26 22:58 UTC (18 in the first four days), with `status` `delivered`, `dropped` or `deliveryFailed`, `action` `forward` (an alias's rule) or `worker` (mail to the Worker), and `errorDetail` holding the reason (`Worker rejected email with reason: ...`, `upstream (worker:isitlegit) temporary error: worker script threw an exception`); one query spans at most 4 weeks 3 days; the token is Zone Analytics Read on the zone (the vault item "IsItLegit Cloudflare analytics token"). No forward has failed after acceptance yet: the 550 5.1.1 bounces of 2026-10-27 were refused before acceptance and left no event, so the status such a failure carries, and the delay before it shows, are read at the live check; until then any `action` `forward` event that is not `delivered` is a failure; (2) no stored "since": each run reads a fixed lookback window (6 hours, so a missed run or a late event is still read) and the send key `forward-failure:<message id>` keeps a repeated check from alerting twice, so no table or migration is needed; (3) it runs in the Worker's existing scheduled run, every 15 minutes (`triggers` in `wrangler.jsonc`), which alerts at detection; a 5-minute cron would run every other scheduled job three times as often; (4) the Worker reads the token from a secret, `CF_ANALYTICS_TOKEN`, and the zone from a variable, `EMAIL_ZONE_ID`; with no token the run logs itself `disabled`, never silent; the coordinator sets the secret from the vault at deploy, piped and never printed; (5) a `deliveryFailed` event with `action` `worker` is a member's mail the Worker failed to take (two were the Worker throwing, on 2026-10-29), so it alerts the operator too, under the same send key; a `dropped` one with `action` `worker` is the intake refusing a sender on purpose and does not.

**Corrected 2026-10-30** (plan review): (6) correction 1's finding is not enough to fix the detector: an Exchange Online rejection sends a non-delivery report, which may leave Cloudflare's event `delivered`, so a controlled failure comes first, before any detector code: the operator's mail flow rule rejects one marked test message forwarded through an alias, and its GraphQL event (status, action, `errorDetail`, the minutes before it is visible) is recorded here; if it stays `delivered`, the section needs another source and is corrected again. Needs is `operator` again until that probe is recorded; (7) the alert must not depend on the mailbox whose failure it reports: `OPERATOR_EMAIL` is `hostmaster@rizonetech.com`, the aliases' own destination, so each alert also goes to a fallback on another provider, `OPERATOR_FALLBACK_EMAIL` (the operator's own `rizonetech@gmail.com`, which `src/mail/allowlist.ts` admits for `alert` beside the operator), decided 2026-10-30 in the unattended run; reversing it is removing the variable; (8) incidents are durable, not a 6-hour window: a D1 table (migration `0036`, given by the coordinator 2026-10-30) holds the scan's last read time and each failure with its alert state, the scan catches up from the last read time in steps within the dataset's 4 weeks 3 days, and an alert `sendMail` did not hand over is tried again on each run until it is sent or refused; (9) the send key is `forward-failure:` and the SHA-256 of the event's message id, or, when it has none, of its session id, time and alias, so it is bounded and two message-id-less failures stay distinct; (10) a Worker failure is its own incident: the run looks for a later `delivered` event, or an admitted intake, for the same message, and the alert says retrying, recovered or unresolved, with Worker steps (its logs, the intake sweep) in `docs/live-checks.md` rather than asking the sender to forward again; (11) the tests assert both failure sources, every alert field, a provider reason holding an address (the address removed), the alert sent in the run that detects the failure, and deduplication through `sendMail`'s own table across two runs, not an in-memory stub.

**Operator action (open, 2026-10-30):** the Exchange Online mail flow rule rejecting the test subject, set for the probe of correction 6 and removed after; the coordinator schedules it with the operator.

**Operator decisions (2026-10-30, through the coordinator):** `OPERATOR_FALLBACK_EMAIL` is `rizonetech@gmail.com`, confirmed. Every operator mailbox, Gmail included, also forwards to `derick@rizonetech.com`, so the fallback is not fully independent of Microsoft 365; it still survives a broken `hostmaster@` route because Gmail keeps its own copy. The probe: an Exchange mail flow rule, "IsItLegit forward probe (delete after test)", rejects any message whose subject contains `ILPROBE-7Q4K9X` with "IsItLegit forward probe: rejected on purpose"; the test message goes to `hello@isitlegit.co.za` once the coordinator says the rule is live, about 15 minutes after it is enabled; the coordinator has the rule removed once the event is recorded here.

**Probe 1 (2026-10-30), not a failure:** one message, subject `ILPROBE-7Q4K9X forward probe (D01 T02 section 6)`, sent at 14:18:14 UTC from `alerts@isitlegit.co.za` through SMTP2GO (email id `1xMnQo-FnQW0hPlB7A-RSRe`) to `hello@isitlegit.co.za`; SMTP2GO handed it to Cloudflare at 14:18:22 (`250 2.0.0 Ok`, `route2.mx.cloudflare.net`); Email Routing recorded it at 14:18:19 as `status` `delivered`, `action` `forward`, `isNDR` 0, no `errorDetail`, first visible to the GraphQL query between 13 and 14 minutes later; and the message reached `derick@rizonetech.com` at 14:18:25 (`internetMessageId` `<E1xMnQo-FnQW0hPlB7A-RSRe@message-id.smtpcorp.com>`). The mail flow rule did not reject it, so no failure was made and the failure status is still unread; the rule is to be checked (that it is applied, and that its condition matches mail reaching `hostmaster@`) and the probe sent again. The visibility delay alone is measured: about 14 minutes, so the scheduled check's lookback must cover at least that.

**Probe 1's cause (2026-10-30, the coordinator):** the operator had created the mail flow rule in another Microsoft 365 tenant, not `rizonetech.com`; it is being created in the right tenant (same token, unscoped), and probe 2 is sent 30 minutes after the time the coordinator gives for it. Probe 1 stands as the `delivered` baseline.

**Credential exposure (2026-10-30):** while reading probe 1's events, the checks lane passed the analytics token to a polling script as a command-line argument, and a process listing it then ran printed that argument into the session's transcript (local only). Fixed in practice: secrets go to a script through its environment or stdin only, never its arguments. **Operator decision (2026-10-30):** keep the token (read-only, `isitlegit.co.za` analytics only).

**Probe 2 (2026-10-30), the failure read:** one message, subject `ILPROBE-7Q4K9X forward probe 2 (D01 T02 section 6)`, sent at 15:20:07 UTC from `alerts@isitlegit.co.za` through SMTP2GO (email id `1xMoOk-FnQW0hPzqTe-BPBx`) to `hello@isitlegit.co.za`, with the operator's rule saved in the `rizonetech.com` tenant at 14:50 UTC. Email Routing recorded three events, all visible to the GraphQL query within 3.2 minutes: the forward at 15:20:12, `status` `delivered`, `action` `forward`, `isNDR` 0, `messageId` `<E1xMoOk-FnQW0hPzqTe-BPBx@message-id.smtpcorp.com>`; then, at 15:20:22, two non-delivery reports from the destination's domain (`rizonetech.com`) to Cloudflare's drop address `cfbounces+ndrdrop@isitlegit.co.za`, each `status` `dropped`, `action` `drop`, `isNDR` 1, `errorDetail` empty, subject `Undeliverable: ` and the original subject, each with its own `messageId` and session. The message did not reach `derick@rizonetech.com`.

**Corrected 2026-10-30** (probe 2): (12) a forward refused after acceptance is not a failed forward event: the forward stays `delivered`, and the refusal arrives as `isNDR` 1 events to `cfbounces+ndrdrop@isitlegit.co.za` from the destination's domain, so the detector reads those NDR events and ties each to its forward by the subject with its `Undeliverable: ` prefix removed, the destination's domain and a window of 30 minutes after the forward; several reports for one forward are one failure (the forward's message id is the incident); an NDR tied to no forward is still an incident, keyed by its own message id, with what it names; analytics carries no reason (`errorDetail` empty), so the alert says the destination refused it after Cloudflare handed it over and names the destination's domain; (13) a refusal is visible within minutes (probe 2: 3.2), a delivered forward within about 14 (probe 1), so the scan's catch-up covers at least 30 minutes; (14) correction 6's probe is done: the section is released, Needs `none`; the live proof item needs the rule again, which the coordinator keeps or recreates with the operator.

**Corrected 2026-10-30** (completion review): (15) the live proof of the deployed detector moves to §9: it needs §6 merged, migration 0036 applied, `CF_ANALYTICS_TOKEN` set and the Worker deployed, which the coordinator does after §6's stamp, so §6 cannot wait for it; probe 2 already proves the event shape the detector reads, and the module's exact query ran against the live API (2026-10-30: accepted, probe 2's three events read with `errorDetail`); (16) a refusal read before its forward waits `MATCH_GRACE_MS` (20 minutes) for it, and reports replayed later join the same incident (subject and destination within the window), so one refusal is one incident and one alert per mailbox; several forwards of the same subject are all named and the incident marked uncertain, never pinned to the latest; (17) an alert counts as sent only once SMTP2GO confirmed it (`sent`, or a duplicate of a `sent`), so an uncertain hand-over stays pending until the reconciler settles it; (18) a Worker retry that arrives after the hour still settles the incident, dropping an alert not yet sent; (19) the scan resumes from the last event it read when its page budget runs out (or a full page does not advance), and says `partial`; (20) the alert names when the original was received (the forward) and when it was refused (the report), a stable incident reference (the first 12 hex digits of its key), and a Worker failure's `errorDetail` with addresses removed; (21) settled incidents are deleted after 90 days, past any replay window; pending ones are kept.

**Build order:**

1. Find where Cloudflare reports a forwarding failure. Done when: the source, its fields and the permission it needs are recorded here.
2. Detect and report each failure. Done when: a failed forward produces one operator alert naming the alias and the message within five minutes of its detection.

- [x] Read Cloudflare's Email Routing analytics (its GraphQL dataset for routing events, or the dashboard's activity log API) and record here how a forward that failed after acceptance appears (status, the alias, the message id, the time), the token permission that reads it, and the delay before an event is visible, with the reference URL and the date read. Done when: the finding is recorded, and a vault item for that read-only token is named (created by the operator if none exists, D99 T01). Done 2026-10-30: correction 1; the failure status and delay of a real forward failure are read at the live check below.
- [x] Write `checkForwarding(deps, now)` in `src/mail/forwarding.ts` that reads the zone's Email Routing events of the last 6 hours (corrections 2 and 5: a `forward` event not `delivered`, a `worker` event `deliveryFailed`) and sends the operator one `alert` through `sendMail` per failed message, with the alias, the time, the status, the reason and the sender's domain (never the body or the sender's address), under the send key `forward-failure:<message id>` so a repeated check alerts once. Done when: `test/mail/forwarding.test.ts` turns a stubbed failure into one alert, sends nothing for a delivered forward or a Worker's deliberate drop, alerts once when checked twice, and reports `disabled` with no token and `degraded` when the query fails. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `src/mail/forwarding.ts` with migration `0036_forward_incidents.sql`, refusals tied to forwards by subject hash (correction 12), Worker failures recovered or unresolved after an hour, both mailboxes (`OPERATOR_FALLBACK_EMAIL`, admitted by `src/mail/allowlist.ts` from a list); `test/mail/forwarding.test.ts` (11 tests); five mutations (reports untied, an unstable send key, a retry that never recovers, no fallback, not scheduled) each fail a test.
- [x] Run it from the Worker's scheduled handler (every 15 minutes, correction 3), declaring `CF_ANALYTICS_TOKEN` and `EMAIL_ZONE_ID` (correction 4). Done when: a test of the scheduled handler calls it, and `pnpm typecheck` passes with the new bindings. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `scheduledForwarding` in `src/index.ts`, `CF_ANALYTICS_TOKEN` in `src/types/secrets.d.ts`, `EMAIL_ZONE_ID` and `OPERATOR_FALLBACK_EMAIL` in `wrangler.jsonc`; `test/scheduled.test.ts` reads the events and alerts both mailboxes from the cron.
- [x] Add to `docs/live-checks.md` what the operator does with such an alert: check the destination's mailbox health, then ask the sender to resend. Done when: the page holds the steps. Done 2026-10-30: "Forwarding failures (D01 T02 §6)", both alerts' steps and the run's log states.
- [x] Commit: `mail: forwarding failures detected and reported to the operator` Done 2026-10-30: 6dc1fc1, then the review fixes to the round-3 commit.

**Test checkpoint:** `pnpm exec vitest run test/mail/forwarding.test.ts` passes, and fails if a failure produces no alert or a repeated check alerts twice.

> **Verified:** 2026-10-30 | §6 | 86f7bcf77bccf3d6df7fc7854190eb1ea2af50ae
> **Review:** `docs/reviews/d01-t02-s6.json`

## 7. Automatic recovery of ambiguous sends

> **Started:** 2026-10-28T22:52:29Z

When SMTP2GO gives no answer or a 5xx, §1 records the send as uncertain and §5 looks it up in SMTP2GO's activity once it is 30 minutes old (on the 15-minute cron, so first at 30 to 45 minutes) and, while no record appears, again on each run; after 3 days it alerts the operator, who settles it by hand. **Corrected 2026-10-29** (final review): said "after 30 minutes" and "by the operator after 3 days", which overstated both. A provider that takes an idempotency key (Resend replays the original response to a repeated request for 24 hours, https://resend.com/docs/dashboard/emails/idempotency-keys) lets the caller retry at once with no duplicate and no operator. SMTP2GO takes none (§1's finding), so this is a choice of provider or of dispatch design. Filed from §5's completion review (out-of-scope gap, 2026-10-27).

**Phase:** 1
**Needs:** none
**Surface:** no

**Operator decision (closed 2026-10-28 22:42 SAST, recorded below):** keep SMTP2GO and accept §5's delayed recovery, move outbound mail to a provider with idempotency keys, or add a dispatch layer of our own that gives the same guarantee. Recording `Recovery design: <choice> (YYYY-MM-DD)` here and removing `operator` from Needs releases the section.

Recovery design: keep SMTP2GO and §5's delayed recovery (2026-10-28). **Operator decision (2026-10-28 22:42 SAST):** an ambiguous send stays settled by §5 from SMTP2GO's activity after 30 minutes, and by the operator after 3 days in the rare case that fails; no provider move and no dispatch layer. Reversing it later means moving outbound mail to a provider with idempotency keys (a new account, domain verification, a key and a privacy-page change). The items below are struck: nothing is built. Final review 2026-10-29: two residual risks of the kept design, recorded honestly: (a) SMTP2GO states no maximum delay before a send appears in its activity, so an operator who settles a send `failed` after 3 days with no record may still see the original delivered if a duplicate is then sent (`docs/operations.md` "Settle an uncertain mail send" says so); (b) settling `failed` changes only the row: nothing sends the reply again, so the member never receives it, filed as §8. Completion review 2026-10-29: the two shortfalls against an idempotent provider (first settlement 30 to 45 minutes after a lost answer, not 60 seconds; an operator settlement after 3 days when the request never reached SMTP2GO) are exactly what this decision accepts, so they are not filed; revisiting them means reversing the decision above.

**Build order:**

1. Choose the design. Done when: the choice is recorded with what it costs to reverse.
2. ~~Recover an ambiguous send automatically. Done when: a send whose answer was lost is settled within 60 seconds of the provider answering again, with no operator action and never a second delivery.~~ **Superseded 2026-10-28 (operator):** SMTP2GO is kept, so an ambiguous send is settled by §5 (30 minutes, then the operator after 3 days); the checkpoint below proves that design instead.

- [x] Record the choice and its reversal cost here, with the provider's idempotency documentation (window, key format, concurrent-request behaviour) if one is chosen. Done when: the `Recovery design:` line is recorded. Done 2026-10-28: the `Recovery design:` line above records keep SMTP2GO with §5's delayed recovery and the cost of reversing it (no provider was chosen, so no idempotency documentation applies).
- [x] ~~Send through the chosen design with the send key as the idempotency key, so an uncertain send is retried at once and the provider's replay settles it. Done when: `test/mail/recovery.test.ts` drives an accepted message whose answer is lost, retries it, and finds one delivery and a `sent` row within 60 seconds of the provider answering, and a concurrent duplicate request refused without a second delivery.~~ **Struck 2026-10-28 (operator):** SMTP2GO is kept with §5's recovery; nothing is built.
- [x] ~~Keep §5's reconciliation for anything older than the provider's idempotency window, and never retry past it blind. Done when: the test shows a send older than the window left to §5.~~ **Struck 2026-10-28 (operator):** SMTP2GO is kept with §5's recovery; nothing is built.
- [x] Commit: `mail: automatic recovery of ambiguous sends` (the decision and its checkpoint landed as `f3ca74c`, `bae3f7a`, `38bbd52` and `b63bfd4`; nothing else is built)

**Test checkpoint:** `pnpm exec vitest run test/mail/reconcile.test.ts test/scheduled.test.ts` passes (the scheduled test pins the cron's band to 30 minutes and 3 days and leaves a younger send untouched, so it fails if the bounds change), and `grep -c '^Recovery design: keep SMTP2GO' todo/01-intake/TODO-02-outbound-mail.md` prints `1`. **Corrected 2026-10-29** (at start, then the final review): the operator kept SMTP2GO, so nothing is built and `test/mail/recovery.test.ts` will not exist; `test/scheduled.test.ts` was added because the reconcile tests pass their own band and would not notice a changed one.

> **Verified:** 2026-10-29 | §7 | b63bfd4af74bba98ef3e061cbb582f20a1d771d8
> **Review:** `docs/reviews/d01-t02-s7.json`


## 8. Re-deliver a reply settled failed

> **Started:** 2026-10-29T10:00Z

When the operator settles an uncertain send `failed` (§5, `scripts/mail-settle.ts`), only the row changes: nothing sends the message again, so a member whose verdict reply was lost never receives it (D01 T02 §7 final review, 2026-10-29). The send log stores no address or body by design (`0003_mail.sql`), but a reply (`reply:<caseId>`) can be rebuilt from its case. Filed from D01 T02 §7's final review.

**Corrected 2026-10-29** (plan fact-check against the code): `reply()` (`src/pipeline/analysis-workflow.ts`) needs the Worker's own bindings (D1, the R2 artefacts, the report-link secret, the SMTP2GO key), and `scripts/mail-settle.ts` reaches D1 only through `wrangler d1 execute`, so the script cannot send. It records the request instead (a resend state on the row, migration `0031`), and the Worker's cron, every 15 minutes, rebuilds each requested reply from its case (the stored verdict, or for a partial case the step and error class of its `failed` event) and sends it through `reply()` under the same send key.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Re-send a settled-failed reply from its case. Done when: one command asks for it, and the next cron run rebuilds the reply from the case record and sends it once under the same send key.

- [x] Give a resend its own state on the row (migration `0031_mail_resend.sql`: `resend_state` of `requested`, `sending`, `done`, `exhausted` or `cancelled`, `resend_runs`, `resend_at`), so the operator and the cron always read where it stands. Done when: it applies locally and the stand-ins carry it. Done 2026-10-29: migration `0031_mail_resend.sql`, applied by the Worker test pool and by `test/node/mail-settle.test.ts`'s SQLite.
- [x] Add `--resend` to `scripts/mail-settle.ts ... failed`, for a `reply:<caseId>` key only: the same statement that settles the row `failed` sets `resend_state = 'requested'`, so a resend is never asked for a row that was not settled; any other kind is refused before anything changes, with the reason (its content is not kept). Done when: `test/node/mail-settle.test.ts` finds the request set with the settlement, refuses `--resend` for an `alert` key and with `sent` with no write, and sets nothing when the row was not settled. Done 2026-10-29: `settleStatement(..., resend)`; the test finds the request with the settlement, refuses an `alert` key and `sent` with nothing written, and asks nothing of a row already `sent`.
- [x] Let the operator read and steer a resend: `mail-settle.ts <key> status` prints the row's send status and resend state; `cancel` moves `requested` to `cancelled` and is refused once the cron has claimed it (`sending`), in one guarded statement, so a confirmed cancel can never still send; `requeue` moves `exhausted` (or `cancelled`) back to `requested` with its runs reset, for after a repair. Done when: the test reads each state back, cancels a request before dispatch and is refused after the claim, and requeues an exhausted one. Done 2026-10-29: `steer` (`status`, `cancel`, `requeue`) over `statusStatement`, `cancelStatement`, `requeueStatement`; the test reads each state, cancels before the claim and is refused after it, and requeues a cancelled and an exhausted one.
- [x] Re-send from the Worker's cron, each request on its own (one that throws leaves the rest processable): claim `requested` as `sending` (one guarded update, so two runs cannot both send), rebuild the case's `ReportState` (its verdict; for a partial case the earliest analysis failure, never the reply step's own, as the workflow keeps the first failure as the report's cause), call `reply()`, and read the send's authoritative outcome (`reply()` returns `sendMail`'s outcome, `previous` included). Sent, refused, or a duplicate of a sent one is `done`; an uncertain or pending send is `done` here and left to the reconciler, with no second send; a failed one goes back to `requested` with its run counted, and after three runs is `exhausted` with an operator alert naming the `requeue` command. Done when: a Worker test (`test/mail/resend.test.ts`) finds one SMTP2GO send, the row `sent` and the state `done`; a second and a concurrent run sending nothing; a partial case rebuilt from its analysis failure though a reply failure follows; a changed allowlist refusing it as `done`; an acceptance whose outcome write fails left to the reconciler; three failing runs across separate cron invocations ending `exhausted` with one alert; a requeue after repair sending. Done 2026-10-29: `resendRequested` in `src/mail/resend.ts` on the cron; `test/mail/resend.test.ts` finds one send and `sent`/`done`, a second and a racing run sending nothing more, a partial case rebuilt from its analysis failure with the day cap's advice, an allowlist refusal ending `done` with nothing sent, three failing runs ending `exhausted` with one alert and a requeue sending, and an accepted send whose outcome write failed left to the reconciler.
- [x] Keep the failure's actionable class where it is stored: `recordEvent` accepts `budget:<cap>:<model>` (the class the workflow raises for a Meta cap, D03 T01 §2) as well as a plain identifier, so a rebuilt partial reply gives the same advice as the first (wait until tomorrow for the day cap). Done when: `test/mail/resend.test.ts` ("recordEvent") stores `budget:day:muse-spark-1.3` intact and still refuses a class with spaces or a message, and the resend test's rebuilt day-cap reply says to forward again tomorrow. Done 2026-10-29: `recordEvent` keeps `budget:<cap>:<model>`; the resend test stores `budget:day:muse-spark-1.3` intact, records a message as `Error`, and the rebuilt reply says to forward again tomorrow.
- [x] Hand the operator the right command: the reconciler's alert for a `reply` key offers `failed --resend` with the duplicate risk (a late original means the member gets it twice), and keeps the plain `failed` for other kinds. Done when: `test/mail/reconcile.test.ts` finds the reply alert's `--resend` command and the risk line, and an alert for another kind without them. Done 2026-10-29: `test/mail/reconcile.test.ts` finds the reply alert's `--resend` command and the twice-received risk, and a notice's alert without them.
- [x] State in `docs/operations.md` "Settle an uncertain mail send" when to resend (only after SMTP2GO shows no record, accepting that a late original would make the member receive it twice), that it goes within 15 minutes, and how to read, cancel and requeue it. Done when: the page holds each command, the timing and the risk. Done 2026-10-29: "Settle an uncertain mail send" holds the four commands, the 15 minutes, the risk, exhaustion and the requeue.
- [x] Close the completion review's gaps (2026-10-29): `resend` asks for a reply already settled failed without `--resend` (G1); each run first recovers a claim a stopped run left, asked for again while unsent and the reconciler's once it may have gone (G2), and retries an exhaustion alert until it has gone, once per exhaustion (G3, migration `0032_mail_resend_outcome.sql`); a run drains every request within its budget (G4); the Worker's own cron sends a request and sends nothing once it was cancelled (G5); `status` says what a resend ended in and the next step (G6). Done when: the "completion review" blocks in `test/mail/resend.test.ts` and `test/node/mail-settle.test.ts` cover each.
- [x] Close round 1 (2026-10-29): a request is tried once a run (a failing one waits for the next, so three runs mean three crons); exhaustion alerts go least recently tried first (`resend_alert_tried_at`, migration `0033_mail_resend_alert_tried.sql`), so uncertain ones never hold the rest back; a resend that ended uncertain and was then settled failed can be asked for again; a case whose only failure was delivering its reply resends its stored verdict; and (round 2) any partial case with a stored verdict resends that verdict, whatever failed after it (finishing the case too); and (round 3) a bookkeeping write that fails after a delivery leaves the claim for recovery, never counted as a failed delivery. Done when: `test/mail/resend.test.ts` "round 1", "round 2" and "round 3" cover each.
- [x] Close the final review (2026-10-29): nothing is settled under a resend in flight (`sending`), and `status` names it first; exhaustion alerts go from each run's alert pass within its budget, never re-entered per exhaustion; a failing claim, recovery or alert pass ends only itself, the run going on; a partial case whose verdict a resend delivered is completed (`completeStored` in `src/db/cases.ts`, the one move out of `partial`, only for a stored verdict that failed after it); a new request clears the last resend's ending; `finish` is fenced by its claim; the budget class takes the workflow's model length; the operations page says the run's budget. Done when: `test/mail/resend.test.ts` "final review" and "completeStored" cover each.
- [x] Commit: `mail: re-deliver a reply the operator settled failed` (landed as `800b474`, with the reviews' fixes in `1222bda`, `6a646cc`, `215a157`, `e039bfa`, `e7fa1e9`, `e9d9e12` and the round-5 cleanup after it)

**Test checkpoint:** `pnpm exec vitest run test/node/mail-settle.test.ts test/mail/resend.test.ts test/mail/reconcile.test.ts` passes, and fails if `--resend` sends a non-reply kind, sends twice, sends without settling, or sends after a confirmed cancel.

> **Verified:** 2026-10-29 | §8 | 04ef8f271bd5d91b741dfbd587ee0f06c6cd89b2
> **Review:** `docs/reviews/d01-t02-s8.json`

## 9. Forwarding failures proven live

Moved from §6 on 2026-10-30 (its correction 15): the deployed detector proven end to end once. It waits on the coordinator's deploy of §6 (migration 0036 applied, `CF_ANALYTICS_TOKEN` set from the vault, the Worker deployed with the operator's go) and on the operator's Exchange mail flow rule, kept since probe 2 for this proof.

> **Started:** 2026-10-30T17:21Z

**Probe 3, 2026-10-30** (deployed at 6d051b3, Worker version 9599a7bb, per the coordinator): sent 16:40:58Z through SMTP2GO (email_id `1xMpez-4o5NDgrlT3m-oy4F`), subject "ILPROBE-7Q4K9X forward probe 3 (D01 T02 section 6)". Email Routing analytics: forward `delivered` at 16:40:59Z, refusal notices (`dropped`, isNDR 1) at 16:41:08Z and 16:41:09Z. The 17:15 UTC scheduled run alerted both mailboxes:
- incident `130199c1f8fb`, "IsItLegit: mail to hello@isitlegit.co.za was refused after forwarding": to `hostmaster@rizonetech.com` sent 17:15:35Z, `<E1xMqCV-FnQW0hPtIz1-iHxO@message-id.smtpcorp.com>`; to `rizonetech@gmail.com` sent 17:15:37Z, `<E1xMqCX-FnQW0hPpFQp-HOIm@message-id.smtpcorp.com>`;
- a second, false incident, "IsItLegit: mail to an alias was refused after forwarding" ("its forward was not found"), for the 16:41:09Z notice: sent 17:15:37Z and 17:15:38Z, `<E1xMqCX-AIkwcC8oOg7-fUIX@message-id.smtpcorp.com>` and `<E1xMqCY-FnQW0hPpFTs-I2wU@message-id.smtpcorp.com>`.

**Corrected 2026-10-30** (from probe 3): (1) the operator mailbox is `hostmaster@rizonetech.com` (`OPERATOR_EMAIL` in `wrangler.jsonc`), not `derick@rizonetech.com`; (2) one refusal's notices can land a second apart, and §6 merged only same-second notices, so the second opened a false "forward not found" incident: notices of the same subject and destination within `NOTICE_SPREAD_MS` (5 s) are now one refusal's, while refusals a minute apart stay two (§6's round 2 test); (3) the analytics give some addresses with their angle brackets, so the alert read "from isitlegit.co.za>" and "refused by rizonetech.com>": `domainOf` now reads the address inside them and keeps a domain only when it is a host name; both fixed in `src/mail/forwarding.ts` with regressions in `test/mail/forwarding.test.ts`, each failing on the old code; (4) the proof therefore needs a probe 4 on the fixed Worker before the rule goes.

**Corrected 2026-10-30** (probe 4): (5) no `event: forwarding` line was captured for the 19:15 UTC run (the coordinator's tail had ended and the Worker keeps no log history), so none is recorded; the proof of the run is live D1, read only by the coordinator at 19:33 UTC: `forward_incidents` row `be3d4494b769…`, kind `refused`, alias `hello@isitlegit.co.za`, uncertain 0, sender_domain `isitlegit.co.za`, destination_domain `rizonetech.com`, occurred 18:28:07Z, detected 18:45:34Z, alert_tries 1; `forward_notices` 4 rows, `forward_incidents` 3; (6) probe 3's rows, written by §6's first deployment, still held the bracketed domains (`130199c1f8fb…`) and the false incident (`43a48a16bf6d…`, alias null): migration `0040_forward_probe_repair.sql` (0040 from the coordinator) makes them what the fixed code writes, idempotent, never folding an incident tied to a forward; it deletes a row on live D1, so it goes in the operator's next deploy question.

**Corrected 2026-10-31** (from the plan review, run late on the Started commit 34db4174, `docs/reviews/01-intake/D01-T02-s9.md`): (6) the test checkpoint is probe 4's, not probe 3's: one incident (`be3d4494b769`), one alert received in each operator mailbox (internetMessageIds recorded in correction 5), on the revision deployed after probe 3's fixes; (7) the incident is proven by live D1 read-back, the coordinator's of 2026-10-30 19:33 UTC (correction 5), both notices linked to it with their domains; (8) probe 3's false second incident and bracketed domains are repaired by migration 0040 (`0040_forward_probe_repair.sql`, reviewed clean, applied to production in the 2026-10-31 deploy), without resending an alert.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Prove the deployed detector alerts on a real refusal. Done when: both alerts are recorded and the rule is gone.

- [x] Once the coordinator says §6 is deployed with the token set, send probe 3 (subject containing `ILPROBE-7Q4K9X`) from `alerts@isitlegit.co.za` through SMTP2GO to `hello@isitlegit.co.za`, and confirm within two scheduled runs that the alert reaches `hostmaster@rizonetech.com` and `rizonetech@gmail.com`, recording each alert's time and `internetMessageId`. Done 2026-10-30: recorded above (Probe 3); both mailboxes alerted at the first run after the grace, and two defects found (corrections 2 and 3). (**Corrected 2026-10-30**, mailbox.)
- [x] Fix the defects probe 3 found (corrections 2 and 3) in `src/mail/forwarding.ts` (`NOTICE_SPREAD_MS`, `domainOf`). Done when: `test/mail/forwarding.test.ts` passes with regressions that fail on the old code, and the fix is reviewed. Done 2026-10-30: 34db417, fc517b7, cac177d, f824e39, a195f54: refusal notices resolved in clusters across scans, one incident per cluster, definitive only with one candidate forward and no resolved sibling, each cluster written in one batch; `domainOf` without the brackets; 35 tests in `test/mail/forwarding.test.ts`, each round's regression failing on the code before it; five review rounds, the fifth clean (`docs/reviews/01-intake/D01-T02-s9.md`).
- [x] Once the coordinator deploys the fix, send probe 4 the same way and confirm one incident, its alert in both mailboxes counting both notices and naming plain domains, recording each alert's time and `internetMessageId`, and the run's `event: forwarding` log line from the coordinator's tail. Done when: both alerts and the log line are recorded here. Done 2026-10-30 (the event log line is the coordinator's tail, asked of it): probe 4 sent 18:27:56Z through SMTP2GO (email_id `1xMrKV-FnQW0hPl2w5-skQT`) to the fixed Worker (c69c8c3, version d184c2a2); analytics: forward `delivered` 18:28:01Z, refusal notices 18:28:07Z and 18:28:12Z; the 19:15 UTC run sent one incident, `be3d4494b769`, "IsItLegit: mail to hello@isitlegit.co.za was refused after forwarding", counting both notices and naming `isitlegit.co.za` and `rizonetech.com` plainly, to `hostmaster@rizonetech.com` (sent 19:15:37Z, `<E1xMs4f-FnQW0hPsr97-GwR1@message-id.smtpcorp.com>`) and `rizonetech@gmail.com` (sent 19:15:38Z, `<E1xMs4g-AIkwcC8oXqp-79JK@message-id.smtpcorp.com>`); no second, false alert.
- [x] Repair probe 3's rows with migration `0040_forward_probe_repair.sql` (correction 6). Done 2026-10-30: `test/db/forward-repair.test.ts` reads two incidents, four notices and clean domains after it, the same after a second run, and no fold of an incident tied to a forward or five seconds from its sibling; two mutations (no forward guard, a wider spread) each fail a test.
- [x] Ask the coordinator to have the operator delete the Exchange mail flow rule "IsItLegit forward probe (delete after test)", and record its removal. Done when: the removal is recorded here. **Corrected 2026-10-31** (the operator's decision, through the coordinator): the rule is kept for future forwarding tests, being harmless (it refuses only mail to the probe's own subject), so its keeping is recorded here instead of its removal.
- [x] Commit: `mail: forwarding failures proven live` Done 2026-10-31: the probe 3 and probe 4 commits, migration 0040, and the live reads recorded in `docs/live-checks.md`.

**Test checkpoint:** `pnpm exec vitest run test/mail/forwarding.test.ts` passes, and both alerts of probe 3 are recorded above.

> **Verified:** 2026-10-31 | §9 | c6b337af7a0baa3e7d2364279a61b890bd09c6c7
> **Review:** `docs/reviews/d01-t02-s9.json`

## 10. A failed check's reply points to its retry

> **Started:** 2026-11-04T00:40Z

Filed 2026-10-31 from D01 T01 §17's completion review (G9): a reply for a check that failed for a passing reason tells the member to forward the message again, though the case can now be retried from its report (D01 T01 §17, the report's "Retry the check", D07 T03 §20). The reply leads to the report instead, keeping its own advice for a message that cannot be read and for a spent daily allowance.

**Corrected 2026-10-31** (at start, checked against the graph): the item waits for D07 T03 §20's "Retry the check" control on the report (the app lane's, open), but the section named only D01 T01 §17 as its dependency, so `query ready` listed it as runnable. D07 T03 §20 is now a dependency in the Implementation Order row; the section waits for it to be stamped and merged into `checks-lane`. Before: Depends On `D01 T01 §17`.

**Corrected 2026-11-04 (plan review):** (1) a signed report link opened without a session shows the public view where "Retry the check" is hidden, so the passing-failure reply states in both plain text and HTML (`nextStep`) to open the report, sign in if asked, and select "Retry the check", and `test/mail/reply.test.ts` proves the signed-out-to-signed-in report view transitions from the `/login?next=/cases/<id>` sign-in link to the `POST /cases/<id>/retry` form; (2) failure classification aligns with the report's `UNMENDABLE` set (`RawMissing` and `MimeRejected`, plus `parse` step failures) so replacement-required failures tell the member to forward a clean copy, capacity pauses (`budget:day:...`, `budget:spend:...`) keep their pause wording, and only retryable failures direct the member to "Retry the check".

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Point a passing failure's reply to the retry. Done when: the text and HTML of a partial reply for a passing failure link the report and say to retry there, and the unreadable-message and spent-allowance replies keep their advice.

- [x] Change the passing-failure advice in `src/mail/reply.ts` to open the report and retry the check there, once D07 T03 §20's control is on main. Done when: `test/mail/reply.test.ts` asserts the text and HTML for each failure kind.
- [x] Commit: `mail: a failed check's reply points to its retry`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply.test.ts` passes.

## 11. Authentication results in the reply

> **Started:** 2026-10-31T14:55Z

Filed 2026-10-31 at the app lane's request through the coordinator (for D07 T03 §7's reply template, whose design draws a "Headers checked" panel): the reply's input carries the verdict and its reasons but not the original's authentication results, so the panel has nothing to show.

**Corrected 2026-10-31** (at start, checked against the repository): (1) the input field already exists: D07 T03 §7 (the app lane, `a19d888f`) added `design.headers?: ReplyDesign["headers"]` to `ReplyInput` in `src/mail/reply.ts` and `AuthState` (the seven RFC 8601 values) to `src/mail/templates/reply.ts`, and `buildReply` already draws it in both bodies (`headersWords`); what is missing is the producer: `reply()` in `src/pipeline/analysis-workflow.ts` builds the input without it, so no sent reply ever carries it. The item is rewritten to that missing piece; (2) the operator's resend (`src/mail/resend.ts`) goes through `reply()`, so the one change covers both; (3) the stored evidence holds a method's overall `detail.state` (`passed`, `failed`, `inconclusive`, `unavailable`, `src/checks/auth.ts`) and each result's raw, lower-cased RFC 8601 value in `detail.results[].result`. A method's one value is read as `auth.ts` reads its overall state: `passed` is `pass`; `failed` is `softfail` when a result says `softfail` and none says `fail`, else `fail`; `inconclusive` is the first result that says `temperror`, `permerror` or `neutral`, else `temperror` (a DMARC fail its receiver marked as an error, or DKIM's `policy`); `unavailable` is `none` (no result for the method, or `none`). The panel is drawn only when all three items are stored for the run (the checks ran on trusted results); one missing, or all skipped (no headers, no trusted receiver), carries none. A default, cheap to change: it lives in one function.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/01-intake/D01-T02-s11.md`; correction 3 refined): (4) `unavailable` covers two cases, and only one is `none`: a result the receiver wrote as `none` (or Microsoft's DMARC `bestguesspass`, no record published) is `none`, which the template draws as "not set up"; a method the receiver did not report at all (no result stored for it) is unknown, not "not set up", and the template (D07 T03 §7, the app lane's) has no word for it, so such a reply carries no panel rather than a claim the evidence does not make. A "not reported" state in the panel is asked of the app lane through the coordinator; (5) the tests prove the values, not only the panel: `test/mail/reply.test.ts` builds replies from stored-shaped evidence with distinct SPF, DKIM and DMARC values and asserts each one's exact words in the text and the HTML, and `test/pipeline/reply-step.test.ts` stores three distinct outcomes for a case, sends its reply and asserts each value's words in both bodies sent to SMTP2GO, the panel absent when one item is missing or a method is unreported, and the same results carried in a partial reply whose run stored them before a later step failed.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Carry the authentication results into the reply's input. Done when: a reply for a message whose headers were checked carries SPF, DKIM and DMARC each as one of the values below, and one whose headers were not available carries none.

- [x] Add `replyHeaders(evidence)` to `src/mail/reply.ts`, reading the run's stored `auth.spf`, `auth.dkim` and `auth.dmarc` evidence (D02 T02) into `{ spf, dkim, dmarc }` of `AuthState` by corrections 3 and 4, or `undefined` when any of the three is not stored or a method has no reported result; have `reply()` in `src/pipeline/analysis-workflow.ts` pass it as `design.headers` from the evidence it already reads. Done when: `test/mail/reply.test.ts` reads each `AuthState` from stored-shaped evidence, `undefined` with one item missing, all missing or a method unreported, and asserts distinct values' exact words in both bodies; `test/pipeline/reply-step.test.ts` sends, for a case with three distinct outcomes stored, a reply whose text and HTML name each value's words, none for a case without them, and the same for a partial reply after authentication was stored (correction 5).
- [x] Commit: `mail: authentication results in the reply`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply.test.ts test/pipeline/reply-step.test.ts` passes.

> **Verified:** 2026-10-31 | §11 | d423d5cbc08739e673edc519b9c00e377ab7de63
> **Review:** `docs/reviews/d01-t02-s11.json`

## 12. A forwarding refusal alerted within minutes

> **Started:** 2026-10-31T14:50Z

Filed 2026-10-31 from §9's completion review (out of scope): probe 4's first refusal reached the Worker's mail at 18:28:07 UTC and its alert went at 19:15:37, 47 minutes later, since refusal notices are read on the quarter-hour schedule and wait out a grace that keeps a late notice from claiming the wrong forward (`src/mail/forwarding.ts`). An operator should hear of a refused forward within minutes, without losing that protection.

**Corrected 2026-10-31** (at start, checked against the plan's Needs and the lanes' rules): the measurement item needs the fix deployed (the coordinator's, AGENTS.md) and five probes through live mail (`live-mail`), while the section named no Need, so `query ready` offered a row this session could finish only halfway. It moves to §14 (Needs `live-mail`, after §12), and §12's Done when becomes the attribution proof the code can give here: a refusal alerted from its notice's arrival, its grace kept, with no wait for the quarter-hour scan. Before: Done when "a refused forward's alert goes within five minutes at the 95th percentile in a measured run".

**Corrected 2026-10-31** (at start, against `src/mail/forwarding.ts` and probe 4's record): (1) the item's premise does not hold: Cloudflare drops a destination's refusal notice (`cfbounces+ndrdrop@`, the file's header and Cloudflare's postmaster page), so the Worker's mail handler never receives one and Email Routing's events are the only source; (2) five minutes from refusal to alert cannot be met from that source without dropping the attribution: a forward's own event shows about 14 minutes late (probe 1), which `MATCH_GRACE_MS` (20 minutes) waits out before a refusal is tied to its forward. A sooner, unattributed first alert is a change to what the operator is told, filed as §15 (`owner-decision`); (3) what the code does wrongly is where the 47 minutes went: the grace counted from the scan that first read the notice (`detected_at`, 18:45 for probe 4's 18:28 refusal), not from the refusal, and scans run each quarter-hour, so the alert went at 19:15. The grace now counts from the refusal (`occurred_at`), a refusal waits `SEEN_MS` (4 minutes) after its first reading so a forward shown a little after it is still read, and a forwarding scan runs every five minutes between the quarter-hours (`FORWARD_CRON`, never with `MAIN_CRON`): probe 4 would have alerted at 18:50, 22 minutes on. The target becomes the grace plus one scan: an alert within 25 minutes of the refusal; §14 measures it live. Before: "within five minutes at the 95th percentile", read from the mail handler. A default, cheap to reverse: three constants and one cron.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/01-intake/D01-T02-s12.md`; correction 3 refined): (4) waiting proves time passed, not that the forward was read: `checkForwarding` settles refusals even after a failed or partial read, so a refusal could be tied to whatever forwards happened to be recorded. Refusals are settled only in a run whose read was complete and fully recorded (`read.complete` and every event written); a failed or partial run leaves them waiting, and the next complete run settles them; (5) a refusal is due at the later of its occurrence plus `MATCH_GRACE_MS` and its first reading plus `SEEN_MS`, and settled at the first complete scan from then on. While analytics and D1 are healthy, a refusal is read before its grace ends, so its alert goes within 25 minutes of it (the grace plus one five-minute scan). One read later than that, after an outage, alerts at the first complete scan `SEEN_MS` after the reading; (6) probe 4's first due scan is the five-minute tick at 18:50, about 22 minutes after its 18:28:07 refusal, not "the scan 20 minutes after the refusal".

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Shorten refusal-to-alert time. Done when: a refusal is alerted at the first complete scan after it is due (correction 5), within 25 minutes of it while the service is healthy, never from a failed or partial read, and the attribution tests of §6 and §9 still pass.

- [x] Count `MATCH_GRACE_MS` from the refusal (`occurred_at`) in `resolveRefusals` (`src/mail/forwarding.ts`), settle no sooner than `SEEN_MS` after a notice's first reading, and add `FORWARD_CRON` (`src/schedules.ts`, `wrangler.jsonc`, dispatched alone in `scheduled()` in `src/index.ts`) at the five-minute marks between quarter-hours. Settle only in a complete, fully recorded run (correction 4). Done when: `test/mail/forwarding.test.ts`, on five-minute ticks, alerts probe 4's timeline at the 18:50-equivalent tick (failing when the grace counts from the reading), holds a refusal first read after an outage for `SEEN_MS` and ties it to the forward shown at the next tick (failing without the wait), leaves a due refusal waiting through a failed and a partial read and alerts it once, with its forward's alias, at the first complete one (failing when a failed or partial run settles), and §6's and §9's attribution tests still pass; `test/scheduled.test.ts` runs only the forwarding check on `FORWARD_CRON`, and `test/node/crons.test.ts` pins the three schedules and that `FORWARD_CRON` is on no quarter-hour.
- [x] ~~Measure refusal-to-alert time over five live probes and record it in `docs/live-checks.md`.~~ **Moved 2026-10-31** to §14 (correction above): it needs the deploy and live mail.
- [x] Commit: `mail: a forwarding refusal alerted within minutes`

**Test checkpoint:** `pnpm exec vitest run test/mail/forwarding.test.ts test/scheduled.test.ts test/node/crons.test.ts` passes.

> **Verified:** 2026-10-31 | §12 | 4897c378f1c4237e0dcbce3d330dfba4e44def95
> **Review:** `docs/reviews/d01-t02-s12.json`

## 13. Destination trace linked

**Operator decision 2026-11-01 03:30 SAST (`docs/coordinator.md`):** deferred until after the competition.

Filed 2026-10-31 from §9's completion review (out of scope): a forwarding refusal's alert says to check the destination's quota, rules and filtering, then to contact a sender named only by domain, though the destination's own message trace names the rule and action that refused it. The alert should take an authorised operator to that trace in one action, without putting a sender's address in the alert.

**Phase:** 7
**Needs:** operator
**Surface:** no

**Build order:**

1. Link the alert to the destination's trace. Done when: an alert for a refusal at a Microsoft 365 destination carries a link to that tenant's message trace for the refused message's time and recipient, and the operator has confirmed it opens to the cause.

- [ ] Add to the alert (`src/mail/forwarding.ts`) a link to the destination's message trace (Exchange admin centre for a Microsoft 365 destination, chosen by the notice's reporting system) filtered by recipient and time, never the sender's address. Done when: `test/mail/forwarding.test.ts` reads the link from an alert built from a recorded Exchange notice.
- [ ] Have the operator follow one live alert's link and record the time to the cause in `docs/live-checks.md`. Done when: the record shows the cause found within two minutes.
- [ ] Commit: `mail: destination trace linked from the alert`

**Test checkpoint:** `pnpm exec vitest run test/mail/forwarding.test.ts` passes.

## 14. Refusal-to-alert time measured live

> **Started:** 2026-11-01T00:53Z

Split 2026-10-31 from §12 (its correction): §12's alert from a notice's arrival, proven where it was meant to be, on the deployed Worker with real refusals.

**Corrected 2026-11-01** (at start, checked against `src/mail/forwarding.ts`, `wrangler.jsonc` and the coordinator's word that §12 is live since the 6b08a4c3 deploy, 2026-10-31 22:47 UTC): (1) §12 is deployed, so the item's precondition holds; (2) the times are read, not taken from a log: each refusal from Email Routing's events (`emailRoutingAdaptive`, the query `checkForwarding` runs, the `isNDR` 1 event to `cfbounces+` naming the probe's subject) and each alert's send from SMTP2GO's activity (the subject `IsItLegit: mail to hello@isitlegit.co.za was refused after forwarding` to `OPERATOR_EMAIL`), by `scripts/forward-probe.py` (`send`, then `read`), the SMTP2GO key and the analytics token read from Conclave into request headers only, never printed; (3) the alert names only the alias, so alerts are matched to refusals in time order, each to the first alert after it no earlier refusal took, and the probes go a minute apart so each is its own incident; a probe with no alert fails the run; (4) the p95 of five is the slowest (nearest rank), so every probe must alert within 25 minutes; (5) the record in `docs/live-checks.md` carries each probe's subject, SMTP2GO email id, send, refusal and alert times; no message id is read for the alert, since SMTP2GO's activity gives its email id, which is recorded instead. (6) the script's matching and percentile are proven offline by `tests/scripts/test_forward_probe.py` (each refusal takes the first alert after it, none twice, only the probe's own refusal notice counts; nearest rank), run with the section's gates.

**Corrected 2026-11-01** (plan review, `docs/reviews/01-intake/D01-T02-s14.md`; corrections 2 and 3 above are refined): (7) an alert is tied to its probe through the Worker's own records, never by time order: each probe's subject is unique to its run, its incident is the `forward_incidents` row of kind `refused` whose `subject_hash` is the probe subject's (`subjectKey` in `src/mail/forwarding.ts`), every one of its refusal notices resolves to that one incident (`forward_notices.incident_key`), and its alert is the `mail_sends` row whose `send_key` is `forward-failure:<incident key>:1` (the operator copy), with its `status`, `updated_at` and SMTP2GO `provider_id`, which SMTP2GO's activity confirms by email id; (8) these are read with one fixed read-only `SELECT` against production D1 (`wrangler d1 execute isitlegit --remote`, the local login, no write), printed with keys as 8-character prefixes as `docs/live-checks.md` records the coordinator's reads; (9) a probe passes only with exactly one incident, all its notices on it, and one sent alert; a second incident for the same subject (§9's probe 3), a notice on another incident, or a missing alert fails the run, whatever other alerts were sent meanwhile; the refusal time is the probe's earliest notice (`occurred_at`); (10) `tests/scripts/test_forward_probe.py` proves the pairing offline: unrelated alerts and reordered sends never pair, a probe with a second incident or with no alert fails though five alerts exist, and several notices of one probe count once. Before: alerts paired to refusals in time order by alias (corrections 2 and 3).

**Phase:** 3
**Needs:** live-mail
**Surface:** no

**Build order:**

1. Measure the refusal-to-alert time. Done when: five live probes show the p95 from a refusal to its alert under 25 minutes (§12's correction 3), recorded with each probe's times and `internetMessageId`s.

- [x] Once the coordinator deploys §12, send five probes (subject containing `ILPROBE-7Q4K9X`, which the operator's kept Exchange rule refuses, §9's correction of 2026-10-31) from `alerts@isitlegit.co.za` through SMTP2GO to `hello@isitlegit.co.za`, with `scripts/forward-probe.py send`, read the times with `scripts/forward-probe.py read`, and record each refusal notice's arrival and its alert's send time in `docs/live-checks.md`. Done when: the record shows a p95 under 25 minutes and one incident per probe.
- [x] Commit: `mail: refusal-to-alert time measured live`

**Test checkpoint:** `docs/live-checks.md` records five probes with a p95 under 25 minutes.

> **Verified:** 2026-11-01 | §14 | de0de331f05197136a9c49e0d235abc7c872198f
> **Review:** `docs/reviews/d01-t02-s14.json`

## 15. Early refusal alert before attribution

> **Started:** 2026-11-04T00:40Z

**Coordinator decision 2026-11-03 (Wave 2 dispatch):** the Phase 7 deferral is lifted; build option A now.

**Operator decision 2026-11-01 03:30 SAST (`docs/coordinator.md`):** deferred until after the competition.

**Operator decision 2026-11-01 (through the coordinator):** option A, two alerts. A refused forward alerts at its first reading, naming the destination domain and the time but not yet the alias, to the same operator mailbox as the attributed alert; the attributed alert follows after the grace, or none when the first already said all. Recorded as the decision for the deferred build: the deferral above stands, and nothing in this section is built until it lifts.

**Corrected 2026-11-04 (plan review):** (1) `sendEarlyAlerts` clusters waiting `refused` incidents by `subject_hash`, `destination_domain`, and `MATCH_WINDOW_MS` before sending under `forward-early:<cluster first key>:<mailbox index>`, and checks `isEarlyAlertTerminal` across every member key of the cluster (plus any sibling waiting/settled incident in the window), so multiple refusal notices in the same scan or across later scans send at most one early alert per refusal; (2) per-recipient `mail_sends` outcomes are read back so a failed early send retries on the next scan without duplicating a delivered mailbox, while `uncertain` and `pending` rows are left to the reconciler without blocking the incident's `waiting` state; (3) when attribution finds no forward (`!found.length`) after the grace and `isEarlyAlertDelivered` confirms the early alert was delivered, `resolveRefusals` marks the incident `alert = 'sent'` without sending a redundant unattributed follow-up, whereas an attributed alias (or an undelivered early alert) sends the second alert; (4) clock-controlled tests assert the early alert is sent on the first scan before `MATCH_GRACE_MS` expires (including during a partial scan while attribution remains blocked) and names the destination domain and refusal time with no alias.

Filed 2026-10-31 from §12's correction 2: an operator told of a refused forward within five minutes needs an alert before the grace that ties the refusal to its forward has passed, so the first alert would name the destination's domain and the time but not yet the alias, and a second (or none, when the first already said all) follow once it is tied. Whether two alerts for one refusal are wanted, and which mailbox gets the first, is needed before building.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Decide, then build, the early alert. Done when: the operator's answer is recorded here, and when it is yes, a refusal's first alert goes at the first scan that reads it.

- [x] Ask the operator through the coordinator whether a refused forward should alert at its first reading, before its alias is known, and record the answer with its date. Done when: the answer is recorded and the Need removed.
- [x] If yes, send the early alert from `checkForwarding` (`src/mail/forwarding.ts`) under its own send key, and the attributed one after the grace as now. Done when: `test/mail/forwarding.test.ts` reads both alerts for one refusal, the first naming no alias, and one alert when the first already said all (unattributed refusal after grace).
- [x] Commit: `mail: early refusal alert before attribution`

**Test checkpoint:** `pnpm exec vitest run test/mail/forwarding.test.ts` passes.

## 16. Reported methods only in the reply

> **Started:** 2026-11-01T14:10Z

Filed 2026-10-31 from §11's completion review (gaps 1 to 4), the producer half of D07 T03 §34 and §35 (the app lane's): §11 gives the reply no Headers checked panel when the receiver reported one method but not another, so a stored SPF failure disappears whenever DKIM was not reported. Once the template draws a per-method "not reported by the receiving system" sentence (and no panel for `headers: {}`), `replyHeaders` passes each method the receiver reported and leaves out the rest. §11's round 1 also withholds the panel for a reported DKIM `none` (an unsigned message, which "not set up" would overstate); once §35 words it ("found no signature"), a reported DKIM `none` is passed again, kept apart from a DKIM the receiver did not report.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Pass what was reported. Done when: a reply for a message whose receiver reported SPF only carries SPF's result and the template's words for the other two, in both bodies.

- [x] Have `replyHeaders` in `src/mail/reply.ts` return the methods the receiver reported (each `AuthState` as §11 reads it) and omit an unreported one, `{}` when none was, to the shape D07 T03 §34 takes. Pass a reported DKIM `none` as `none` again. Done when: `test/pipeline/reply-step.test.ts` stores SPF alone, then SPF and DMARC, then all three with DKIM `none`, sends each reply through `reply()` and reads each reported value's words (DKIM `none` as §35's), the unreported methods' words, in the text and the HTML, and no panel for none.
- [x] Commit: `mail: reported methods only in the reply`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply.test.ts test/pipeline/reply-step.test.ts` passes.

> **Verified:** 2026-11-01 | §16 | 3556e928a75ee726a8ff07320b31c1c6a7bf2893
> **Review:** `docs/reviews/d01-t02-s16.json`

## 17. Sender domains for the headers panel

> **Started:** 2026-11-01T14:26Z

Filed 2026-10-31 from §11's completion review (gap 5), the input D07 T03 §36 (the app lane's) asks for: to attribute the results to the receiving system and say what was checked, the template needs the original's From domain and the domain each SPF and DKIM pass was for, which the stored `auth.spf`, `auth.dkim` and `auth.dmarc` evidence holds (`src/checks/auth.ts`) and the reply's input does not carry.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Carry the domains. Done when: a reply whose SPF and DKIM passed for domains other than the From domain, with DMARC failing, carries the three domains in the shape D07 T03 §36 takes.

- [x] Read the From domain and each passing SPF and DKIM identifier's domain from the run's stored evidence in `src/mail/reply.ts`, and pass them in `design.headers.domains` as D07 T03 §36 defines (`{ from?, spf?, dkim? }`, each lower-cased and left out when unknown; the app lane, 2026-10-31). Done when: `test/pipeline/reply-step.test.ts` stores SPF and DKIM passing for `mailer.example` and DMARC failing for `bank.example`, sends the reply through `reply()`, and reads the three domains in the template's words in both bodies. (**Corrected 2026-11-01**, plan review P2, `docs/reviews/01-intake/D01-T02-s17.md`: (1) a method's domain is the identifier of its first passing result in stored order that names a valid domain; a passing result naming none never borrows a failed or other result's identifier, and several passing domains name the first; the stored-evidence tests use different SPF and DKIM domains, and cover mixed pass and fail results, several passes, a passing result with no identifier beside a failing one with one, a missing From domain, and upper-case normalisation; (2) every domain passes `asciiDomain` (`src/checks/auth.ts`, the whole-domain IDNA check) and the 253-character DNS limit in the producer, and a value that fails either (control characters, bidi controls, spaces, a path) is left out, never replaced or cleaned into a domain it is not; a stored-evidence-to-reply test proves a hostile identifier reaches neither body while a valid one does.)
- [x] Commit: `mail: sender domains for the headers panel`

**Test checkpoint:** `pnpm exec vitest run test/pipeline/reply-step.test.ts` passes.

> **Verified:** 2026-11-01 | §17 | 7a0a3d151e558d59f32d2e193121059fb0a54c49
> **Review:** `docs/reviews/d01-t02-s17.json`

## Verification

- A refused recipient never reaches SMTP2GO; a member reply threads under the forward and carries a working signed link.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
