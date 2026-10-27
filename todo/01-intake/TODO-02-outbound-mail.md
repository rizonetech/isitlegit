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
| 1 | §1 | SMTP2GO client with retries and send log | D01 T01 §1 | [ ] |
| 2 | §2 | Recipient allowlist enforced in code | §1, D07 T02 §3 | [ ] |
| 3 | §3 | Threaded reply with a signed report link | §2, D01 T01 §8 | [ ] |
| 4 | §4 | Test and demo mail aliases | §1 | [ ] |

## 1. SMTP2GO client with retries and send log

One module owns delivery (stack doc). It calls the SMTP2GO HTTP API with `fetch`, retries transient failures, and records every attempt without message bodies, so a failed reply is visible on the case instead of vanishing.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write `src/mail/smtp2go.ts` with `sendMail`. Done when: a stubbed `fetch` test sends one message with the exact JSON body SMTP2GO expects.
2. Log each attempt to `mail_sends`. Done when: success and failure both leave a row.

- [ ] Add migration `src/db/migrations/0002_mail.sql` with `mail_sends` (`id`, `case_id` nullable, `kind` reply, signin, verify, alert, notice, `to_hash`, `status`, `provider_id`, `attempts`, `created_at`); store a SHA-256 of the recipient, not the address. Done when: `pnpm db:migrate:local` applies it.
- [ ] Write `sendMail({ kind, to, from, subject, text, html, headers, caseId })` posting to `https://api.smtp2go.com/v3/email/send` with `SMTP2GO_API_KEY` and `custom_headers` for threading. Done when: `test/mail/smtp2go.test.ts` asserts the request body against a recorded example from the SMTP2GO API docs.
- [ ] Retry 429 and 5xx up to 3 times with backoff; never retry 4xx validation errors. Done when: tests cover a 503 then 200, and a 400 that fails at once.
- [ ] Write the `mail_sends` row on every outcome with the provider's `email_id`. Done when: tests find `sent` and `failed` rows. Cheaper substitute: console logging only.
- [ ] Commit: `mail: SMTP2GO client with retries and a send log`

**Test checkpoint:** `pnpm exec vitest run test/mail/smtp2go.test.ts` passes and fails if a 400 is retried.

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

## Verification

- A refused recipient never reaches SMTP2GO; a member reply threads under the forward and carries a working signed link.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
