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
| 4 | §4 | Test and demo mail aliases | §1 | [ ] |
| 5 | §5 | Reconcile uncertain sends | §1 | [ ] |

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

The operator decided that during the event the system mails only registered members and Rizonetech-controlled test mailboxes (design spec section 11). Recipients come from code and stored records, never from a model (spec 4.6a). This guard sits inside `sendMail`, so no caller can skip it.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/mail/allowlist.ts` with `isAllowedRecipient`. Done when: members, member invitees, and `*@demo.isitlegit.co.za` aliases pass; everything else is refused.
2. Call it from `sendMail`. Done when: a refused address never reaches `fetch`.

- [ ] Write `isAllowedRecipient(address, kind, env)` allowing: verified members of any organisation (D07 T02), pending invitees for `signin` mail, addresses under `@demo.isitlegit.co.za` and `@isitlegit.co.za`, and the operator address in var `OPERATOR_EMAIL`. Done when: `test/mail/allowlist.test.ts` covers each allowed class and three refused ones.
- [ ] Call the allowlist first inside `sendMail` and record refused sends as `mail_sends.status = refused`. Done when: a test with `someone@example.com` shows no `fetch` call and a `refused` row. Cheaper substitute: checking at each call site, which one caller will forget.
- [ ] Set `OPERATOR_EMAIL` as a Worker var from the operator's Rizonetech address (design spec section 11, Mailbox). Done when: `wrangler.jsonc` has the var and `pnpm typecheck` sees it.
- [ ] Commit: `mail: recipient allowlist enforced inside the sender`

**Test checkpoint:** `pnpm exec vitest run test/mail/allowlist.test.ts` passes and fails if the allowlist call is moved out of `sendMail`.

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

The fictional demo businesses need registered contacts that reach a real inbox, and `CODE_OF_CONDUCT.md` names `conduct@isitlegit.co.za`. All forward to the operator's Rizonetech mailbox once the operator has verified it as an Email Routing destination (D99 T01 §2).

**Phase:** 1
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Add the operator's mailbox as an Email Routing destination address. Done when: the API lists it (verification is the operator's click in D99 T01 §2).
2. Create the alias rules. Done when: each alias reads back with the operator mailbox as its forward target.

- [ ] Create the destination address `OPERATOR_EMAIL` on account `f5a529987f8dc7d52ce7aba3da25e226` through the Email Routing API. Done when: it is listed (pending or verified).
- [ ] Create forward rules for `conduct@isitlegit.co.za`, `finance@demo.isitlegit.co.za`, `alerts@demo.isitlegit.co.za` and `owner@demo.isitlegit.co.za` to that destination. Done when: the rules list shows all four enabled.
- [ ] Record the alias list and their purpose in `docs/live-checks.md`. Done when: the file lists the four aliases.
- [ ] Commit: `mail: test and demo aliases on Email Routing`

**Test checkpoint:** `pnpm exec tsx scripts/cf-email-routing.ts --list` prints the four aliases each with the operator destination.

## 5. Reconcile uncertain sends

A send recorded `uncertain` (no answer, an unreadable answer, or a 5xx, §1) may or may not have reached its recipient, and §1 rightly never sends it again blind. Left alone it stays uncertain for ever: a reply that was in fact delivered is reported as unknown, and one that never left is never sent. Every send carries its key in an `X-IsItLegit-Send` header (§1), so SMTP2GO's own record can settle it. Filed from §1's completion review (out-of-scope gap, 2026-10-27), which compared it with providers that replay an idempotent send's result.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Learn whether SMTP2GO can find a send by its header. Done when: the answer and its source are recorded here.
2. Settle uncertain sends from SMTP2GO's record. Done when: a delivered send becomes `sent` with its id and an absent one becomes `failed`, without any message sent twice.

- [ ] Read SMTP2GO's API reference for searching sent mail (its email search or activity endpoints) and record here whether a send can be found by a custom header, by recipient and time, or not at all, with the reference's URL and the date read. Done when: the finding is recorded; if no lookup exists, the section records that and stops, and §1's uncertain rows stay for an operator.
- [ ] Write `reconcileUncertain(deps, olderThanMinutes)` in `src/mail/reconcile.ts` that, for each `uncertain` or stale `pending` row past the given age, asks SMTP2GO once and settles the row: found means `sent` with the provider's id, a confident absence after SMTP2GO's processing delay means `failed` (which §1 may then retry), anything else stays as it is. Done when: `test/mail/reconcile.test.ts` settles a found send, a confirmed-absent send and leaves an unknown one, with a stubbed SMTP2GO and the real migration.
- [ ] Never send from the reconciler: it only reads SMTP2GO and writes rows. Done when: the test fails if the reconciler makes a request to the send endpoint.
- [ ] Run it from the Worker's scheduled handler every 15 minutes for rows younger than 3 days. Done when: a test of the scheduled handler calls it with those bounds.
- [ ] Commit: `mail: reconcile uncertain sends with SMTP2GO's record`

**Test checkpoint:** `pnpm exec vitest run test/mail/reconcile.test.ts` passes, and fails if a settled row is wrong or the reconciler ever sends.

## Verification

- A refused recipient never reaches SMTP2GO; a member reply threads under the forward and carries a working signed link.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
