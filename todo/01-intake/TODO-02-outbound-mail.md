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
| 2 | §2 | Recipient allowlist enforced in code | §1, D07 T02 §3 | [ ] |
| 3 | §3 | Threaded reply with a signed report link | §2, D01 T01 §8 | [ ] |
| 4 | §4 | Test and demo mail aliases | §1 | [x] |
| 5 | §5 | Reconcile uncertain sends | §1 | [x] |
| 6 | §6 | Forwarding failures detected and reported | §1, §4 | [ ] |
| 7 | §7 | Automatic recovery of ambiguous sends | §5 | [ ] |

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

**Corrected 2026-10-28:** checked against the code D07 T02 §1 to §3 shipped. `SendOutcome` has no `refused` case although `mail_sends.status` allows it and §1's magic-link sender already treats an allowlist refusal as undelivered, so the outcome type gains it and its callers are checked. Members and invitees are Better Auth's tables (`user`, `member`, `invitation`, migrations 0007 and 0010). Invite-code signup (D07 T02 §4) mails a link to an address that is not yet a member, so §4 must make it one before the link goes (written into §4). The auth and mail tests mail `example.com` addresses, which this refuses; their fixtures move to `@demo.isitlegit.co.za`, and refusal gets its own tests. A refused sign-in answers as §1 decided (not delivered, an error), which tells the asker the address is not registered; that is accepted for the closed event, with §6's rate limits bounding how fast anyone can ask.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/mail/allowlist.ts` with `isAllowedRecipient`. Done when: members, member invitees, and `*@demo.isitlegit.co.za` aliases pass; everything else is refused.
2. Call it from `sendMail`. Done when: a refused address never reaches `fetch`.

- [ ] Write `isAllowedRecipient(db, address, kind, operatorEmail)` in `src/mail/allowlist.ts`, comparing addresses in lower case, by purpose (design spec section 11): a **member** is a `user` with a `member` row in any organisation (membership is the authorisation: it exists only through invite-code signup, D07 T02 §4, or an accepted invitation, so `emailVerified` is not required and a first signup's link is not blocked; **Corrected 2026-10-28** after the plan review, which found requiring it blocked the first signup); a **demo alias** is an address at exactly `isitlegit.co.za` or `demo.isitlegit.co.za` (not look-alikes such as `isitlegit.co.za.evil.example`); the **operator** is var `OPERATOR_EMAIL`. Allowed per kind: `signin` to members, pending unexpired invitees, demo aliases and the operator; `reply`, `notice` and `renewal` to members, demo aliases and the operator; `verify` (closed-loop verification) to demo aliases only; `alert` (impersonation and counterparty alerts, the operator's unsettled-send handover) to demo aliases and the operator only, never a member's own address. Done when: `test/mail/allowlist.test.ts` covers each allowed pair and refuses an unregistered address, a registered user with no organisation, an expired or cancelled invitee, an invitee for a non-`signin` kind, a member for `verify` and for `alert`, and a look-alike domain.
- [ ] Call the allowlist first inside `sendMail` (`src/mail/smtp2go.ts`) and record a refused send as `mail_sends.status = refused` under its send key with `INSERT ... ON CONFLICT DO NOTHING`, so a key already on record (sent, pending, uncertain, failed or refused) keeps its row and its delivery evidence and is never sent, returning a new `{ status: "refused" }` outcome; check every caller of `sendMail` handles it (§1's magic link and §3's invitation after hook count it as not delivered; the reconcile and reply paths treat it as final, never retried). Done when: a test with `someone@example.com` shows no `fetch` call and a `refused` row, the same key refused twice leaves one row, a refusal under a key already `sent`, `failed` or `uncertain` leaves that row as it was and calls no `fetch`, the magic-link request to it answers its error, and `pnpm typecheck` passes with the new case. Cheaper substitute: checking at each call site, which one caller will forget.
- [ ] Keep the auth and mail tests on real-member addresses: a test helper makes an `example.com` user and its membership through Better Auth (as invite-code signup will) before that address signs in, invitations are created, delivered, accepted and removed through the real handlers and `sendMail`, and the demo domain is used only where a non-member must be mailed (a user with no organisation). Done when: `pnpm exec vitest run` passes with the allowlist on, the member and invitee flows run on `example.com` addresses that the allowlist admits by their records (not by the demo exemption), and no test mails an address it refuses except the refusal tests. (**Corrected 2026-10-28:** said to move every fixture to the demo domain, which would let a broken member path pass.)
- [ ] Set `OPERATOR_EMAIL` as a Worker var from the operator's Rizonetech address (design spec section 11, Mailbox). Done when: `wrangler.jsonc` has the var and `pnpm typecheck` sees it.
- [ ] Commit: `mail: recipient allowlist enforced inside the sender`

**Test checkpoint:** `pnpm exec vitest run test/mail test/auth` passes and fails if the allowlist call is moved out of `sendMail`, a look-alike domain or an unregistered address is allowed, a member is sent `verify` or `alert` mail, a refused send reaches `fetch`, or a refusal overwrites a send already on record.

## 3. Threaded reply with a signed report link

The member gets the answer as a reply in the same thread (spec 4.1): verdict, top three reasons, what to do now, and the signed report link. Subject, recipient and template come from code; the model only fills validated fields later (spec 4.6a). The final visual design is D07 T03 §7; this section ships the plain-text and minimal HTML version that works from day one.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/mail/reply.ts` building the reply from a case. Done when: a test produces headers `In-Reply-To` and `References` equal to the forward's `Message-ID`.
2. Wire the Workflow `reply` step to it. Done when: the stub pipeline sends one reply per case.

- [ ] Write `buildReply(caseRow, verdictView, reportUrl)` returning subject `Re: <original subject>` (trimmed to 120 characters), `text` and `html` bodies with verdict, headline, up to three reasons and the action. Done when: `test/mail/reply.test.ts` snapshots both bodies for a fixture verdict.
- [ ] Thread with `In-Reply-To: <forward Message-ID>` and `References: <forward References> <forward Message-ID>` (RFC 5322 section 3.6.4). Done when: the test reads both headers.
- [ ] Explain missing headers when `headers_available = 0`: one sentence on forwarding as an attachment in Outlook and Gmail. Done when: the inline-forward fixture's reply contains it.
- [ ] Call `buildReply` and `sendMail({ kind: "reply" })` from the Workflow `reply` step with a link from `signReportLink` (D01 T01 §8). Done when: the Workflow test records one `mail_sends` row of kind `reply`.
- [ ] Build the reply's report link as an absolute `https://` URL from the trusted public origin in the Worker's configuration (a `PUBLIC_ORIGIN` var in `wrangler.jsonc`, refused unless it is `https`), never from a request's `Host`, joined to `signReportLink`'s path. Done when: `test/mail/reply.test.ts` finds the same absolute link in the `text` and the `html` body, and `verifyReportLink` accepts its path and parameters. (**Added 2026-10-27**, D01 T01 §8's plan review P2 4.)
- [ ] Never send a second reply for the same case: the step checks `mail_sends` first. Done when: re-running the step sends nothing. Cheaper substitute: none; a retried step would otherwise mail twice.
- [ ] Commit: `mail: threaded verdict reply with the signed report link`

**Test checkpoint:** `pnpm exec vitest run test/mail/reply.test.ts test/pipeline/analysis-workflow.test.ts` passes and fails if the reply step sends twice.

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

> **Deferred:** detecting a forward that fails after Cloudflare accepted it, and telling the operator -> XREF: D01 T02 §6

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
> **Deferred:** recovering an ambiguous send automatically within a minute, with no operator -> XREF: D01 T02 §7

Evidence after review rounds 1 to 4, 2026-10-27 22:03 SAST. Round 1 (`5cc220d`): operator alerts are keyed by attempt (`unresolved:<send key>@<claim time>`), so a later attempt that ages out gets its own alert; a failed alert makes the run degraded; migration `0006_mail_searched_at.sql` orders a backlog never-searched first, then least recently searched, so a run budget smaller than the backlog reaches every row. Round 2 (`edf767a`): `src/mail/settle.ts` accepts the `@` in alert keys; a spent request budget stops searching and pausing at once. Round 3 (`d42b204`): a run stops at a 10-minute deadline (`RUN_DEADLINE_MS`, under the scheduled handler's 15-minute limit) and cuts each request's timeout to the time left, reporting degraded. Round 4 approved. `pnpm exec vitest run`: 392 passed; every fix's mutation fails it. The live database needs migrations 0003 to 0006 before the next deploy.

**Test checkpoint:** `pnpm exec vitest run test/mail/reconcile.test.ts test/mail/smtp2go.test.ts` passes, and fails if a settled row is wrong, if an empty search makes a row retryable, if a stale reconciler overwrites a retry, or if the reconciler ever sends.

> **Verified:** 2026-10-27 | §5 | 3703516cb561ec3fd10d2fa084dae0db88b4f7ce
> **Review:** `docs/reviews/d01-t02-s5.json`

## 6. Forwarding failures detected and reported

> **Started:** 2026-10-27T20:02Z

Cloudflare accepts mail for an alias and then forwards it; a failure after that acceptance (the destination refusing it, a quota, a policy) is not reported to the original sender, because Cloudflare does not forward non-delivery reports (https://developers.cloudflare.com/email-service/reference/postmaster/#non-delivery-reports-ndrs). A judge or a demo contact's mail could then vanish with nobody told. Filed from §4's completion review (out-of-scope gap, 2026-10-27), which compared it with Exchange Online aliases, whose failures come back with a reason.

**Phase:** 1
**Needs:** operator
**Surface:** no

**Corrected 2026-10-27** (Needs was `none`): the section cannot run unattended. Cloudflare's Email Routing events are in the GraphQL Analytics API (`emailRoutingAdaptive`, per zone, fields `datetime`, `sessionId`, `messageId`, `from`, `to`, `subject`, `status`, `action`, `errorDetail`, `isNDR`, `isSpam` and the authentication results; https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-email-routing/, read 2026-10-27), which publishes no list of `status` values and shows only `delivered`, so the failure values must be read from real events. Reading it needs an API token with Analytics Read; Wrangler's login has `email_routing (write)` but no analytics scope, and the Conclave vault holds no such token for this account. The live check also needs an Exchange Online mail flow rule set up by the operator.

**Operator action (open):** (1) create a Cloudflare API token with Zone Analytics Read on `isitlegit.co.za` and store it in the Conclave vault as "IsItLegit Cloudflare analytics token"; (2) when the live check is due, add the Exchange Online mail flow rule rejecting the test subject, and remove it after. Recording `Operator ready: <what> (YYYY-MM-DD)` here and removing `operator` from Needs releases the section; the 550 5.1.1 bounces of the first demo messages (D01 T02 §4, 2026-10-27, `docs/live-checks.md`) are real failures to read the status values from.

**Build order:**

1. Find where Cloudflare reports a forwarding failure. Done when: the source, its fields and the permission it needs are recorded here.
2. Detect and report each failure. Done when: a failed forward produces one operator alert naming the alias and the message within five minutes of its detection.

- [ ] Read Cloudflare's Email Routing analytics (its GraphQL dataset for routing events, or the dashboard's activity log API) and record here how a forward that failed after acceptance appears (status, the alias, the message id, the time), the token permission that reads it, and the delay before an event is visible, with the reference URL and the date read. Done when: the finding is recorded, and a vault item for that read-only token is named (created by the operator if none exists, D99 T01).
- [ ] Write `checkForwarding(deps, since)` in `src/mail/forwarding.ts` that reads the failures since the last check for this zone's aliases and sends the operator one `alert` through `sendMail` per failed message, with the alias, the time, the reason and the sender's domain (never the body), under the send key `forward-failure:<message id>` so a repeated check alerts once. Done when: `test/mail/forwarding.test.ts` turns a stubbed failure into one alert, sends nothing for a successful forward, and alerts once when checked twice.
- [ ] Run it from the Worker's scheduled handler every 5 minutes. Done when: a test of the scheduled handler calls it.
- [ ] Prove it live once with a failure after acceptance: an active rule to the verified destination, whose mailbox refuses one marked test message after Cloudflare hands it over (an Exchange Online mail flow rule rejecting a unique test subject, set up by the operator for the test and removed after). Send that message from `rizonetech@gmail.com` and confirm the alert arrives in `derick@rizonetech.com`, recording its time and `internetMessageId`. Done when: the alert is recorded and the mail flow rule is gone. (**Corrected 2026-10-27**, D01 T02 §4's round 1: a rule to an unverified destination stays disabled in Cloudflare, so it can never produce a failure after acceptance.)
- [ ] Add to `docs/live-checks.md` what the operator does with such an alert: check the destination's mailbox health, then ask the sender to resend. Done when: the page holds the steps.
- [ ] Commit: `mail: forwarding failures detected and reported to the operator`

**Test checkpoint:** `pnpm exec vitest run test/mail/forwarding.test.ts` passes, and fails if a failure produces no alert or a repeated check alerts twice.

## 7. Automatic recovery of ambiguous sends

When SMTP2GO gives no answer or a 5xx, §1 records the send as uncertain and §5 settles it from SMTP2GO's activity, first after 30 minutes and, failing that, by the operator after 3 days. A provider that takes an idempotency key (Resend replays the original response to a repeated request for 24 hours, https://resend.com/docs/dashboard/emails/idempotency-keys) lets the caller retry at once with no duplicate and no operator. SMTP2GO takes none (§1's finding), so this is a choice of provider or of dispatch design. Filed from §5's completion review (out-of-scope gap, 2026-10-27).

**Phase:** 1
**Needs:** operator
**Surface:** no

**Operator decision (open):** keep SMTP2GO and accept §5's delayed recovery, move outbound mail to a provider with idempotency keys, or add a dispatch layer of our own that gives the same guarantee. Recording `Recovery design: <choice> (YYYY-MM-DD)` here and removing `operator` from Needs releases the section.

**Build order:**

1. Choose the design. Done when: the choice is recorded with what it costs to reverse.
2. Recover an ambiguous send automatically. Done when: a send whose answer was lost is settled within 60 seconds of the provider answering again, with no operator action and never a second delivery.

- [ ] Record the choice and its reversal cost here, with the provider's idempotency documentation (window, key format, concurrent-request behaviour) if one is chosen. Done when: the `Recovery design:` line is recorded.
- [ ] Send through the chosen design with the send key as the idempotency key, so an uncertain send is retried at once and the provider's replay settles it. Done when: `test/mail/recovery.test.ts` drives an accepted message whose answer is lost, retries it, and finds one delivery and a `sent` row within 60 seconds of the provider answering, and a concurrent duplicate request refused without a second delivery.
- [ ] Keep §5's reconciliation for anything older than the provider's idempotency window, and never retry past it blind. Done when: the test shows a send older than the window left to §5.
- [ ] Commit: `mail: automatic recovery of ambiguous sends`

**Test checkpoint:** `pnpm exec vitest run test/mail/recovery.test.ts` passes, and fails if an ambiguous send is delivered twice or needs the operator inside the idempotency window.

## Verification

- A refused recipient never reaches SMTP2GO; a member reply threads under the forward and carries a working signed link.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
