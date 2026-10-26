---
schema_version: 1
id: headers-and-sender
domain: 02-checks
status: active
title: "TODO-02 -- Authentication Results and Sender Checks"
track: day-2
---

# TODO-02 -- Authentication Results and Sender Checks

> **Goal:** IsItLegit reads SPF, DKIM, DMARC and ARC results only from the headers the member's own receiving system added, checks alignment, and flags sender tricks (display name naming a different address or brand, Reply-To or Return-Path elsewhere, a first-time sender for this organisation), each as cited evidence.

> **Current state:** Measured 2026-10-26 20:00 SAST. Headers arrive as an ordered list in the parsed summary (D01 T01 §5); the evidence model and runner come from D02 T01.

## Inputs

- Design spec 4.3 (Authentication: trust boundary is the topmost headers from the tenant's MX; Sender checks).
- RFC 8601 (`Authentication-Results`), RFC 7208 (SPF), RFC 6376 (DKIM), RFC 7489 (DMARC alignment), RFC 8617 (ARC), RFC 5322 section 3.6.2 (originator fields).

## Outcome

- A fixture with forged `Authentication-Results` below the receiver's own header is not trusted; the receiver's header is.
- Fixtures for SPF fail, DKIM fail, DMARC fail, misaligned From, display-name spoofing, Reply-To mismatch and a first-time sender each yield the expected evidence with the header excerpt as its artefact.

**Adjacency:** all=not-applicable (pure evidence producers; their output is shown and governed on the report, D07 T03 §3)

**Adjacency rationale:** These checks only add evidence to a case; lists, settings and notifications belong to the report and consoles.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Trusted Authentication-Results parsing | D02 T01 §2 | [ ] |
| 2 | §2 | SPF, DKIM and DMARC alignment evidence | §1 | [ ] |
| 3 | §3 | ARC chain evidence | §1 | [ ] |
| 4 | §4 | Display name, Reply-To and Return-Path checks | D02 T01 §2, D02 T03 §3 | [ ] |
| 5 | §5 | First-time sender per organisation | §4 | [ ] |

## 1. Trusted Authentication-Results parsing

Anyone can write an `Authentication-Results` header into a message. Only the ones added by the member's own receiving system are trusted (spec 4.3): the topmost headers whose `authserv-id` matches a receiver the organisation uses (for Microsoft 365, `*.prod.outlook.com` and `outlook.com`; for Google, `mx.google.com`). The organisation's receivers are learned from its verified domains' MX records and stored.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Parse `Authentication-Results` per RFC 8601. Done when: tests parse the RFC's examples and three synthetic receiver headers.
2. Select only trusted headers. Done when: a forged lower header is ignored.

- [ ] Write `parseAuthResults(value)` in `src/checks/auth-results.ts` returning `authservId` and a list of `{ method, result, props }` (RFC 8601 section 2.2 grammar, comments stripped). Done when: `test/checks/auth-results.test.ts` passes the RFC 8601 appendix B examples.
- [ ] Add `org_receivers` (org id, authserv id pattern) filled from the MX of each verified domain at verification time (D07 T02 §5), with Microsoft 365 and Google patterns as known mappings. Done when: a test domain with MX `*.mail.protection.outlook.com` stores the Microsoft pattern.
- [ ] Write `trustedAuthResults(headers, orgId)` taking only the topmost contiguous `Authentication-Results` whose `authservId` matches a stored pattern. Done when: a fixture with a forged header below the real one returns only the real one. Cheaper substitute: trusting every `Authentication-Results` header.
- [ ] Emit an info evidence item when no trusted header exists, explaining the limit. Done when: the inline-forward and no-receiver fixtures yield it.
- [ ] Commit: `checks: trusted Authentication-Results parsing`

**Test checkpoint:** `pnpm exec vitest run test/checks/auth-results.test.ts` passes and fails if the forged header is trusted.

## 2. SPF, DKIM and DMARC alignment evidence

From the trusted results, produce evidence: SPF and DKIM pass or fail, DMARC result, and whether the passing identifier aligns with the visible From domain (RFC 7489 section 3.1, relaxed alignment by registrable domain via `tldts`).

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Write the auth checks. Done when: each synthetic fixture yields its expected severity.

- [ ] Register check `auth.spf` (fail or softfail medium, pass info) in `src/checks/auth.ts`. Done when: `test/checks/auth.test.ts` covers pass, fail and softfail fixtures.
- [ ] Register check `auth.dkim` (fail medium; pass with signing domain in detail). Done when: the fixtures pass.
- [ ] Register check `auth.dmarc` (fail high when the From domain publishes `p=reject` or `p=quarantine`, medium otherwise) with the From domain's policy read from the result. Done when: the fixtures pass.
- [ ] Register check `auth.alignment`: high when neither SPF nor DKIM passes aligned with the From registrable domain. Done when: a fixture passing SPF for an unrelated domain yields it.
- [ ] Attach the trusted header excerpt as the artefact of each item. Done when: each item's `artefacts` holds the excerpt key.
- [ ] Commit: `checks: SPF, DKIM and DMARC alignment evidence`

**Test checkpoint:** `pnpm exec vitest run test/checks/auth.test.ts` passes and fails if alignment compares full host names instead of registrable domains.

## 3. ARC chain evidence

Forwarders and mailing lists break SPF and DKIM; ARC (RFC 8617) carries the earlier results. The trusted receiver's `arc=` result is read and, when it passes, the earlier authentication results inside the sealed chain are reported as context, not as proof.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Register check `auth.arc`. Done when: fixtures with `arc=pass` and `arc=fail` yield the expected items.

- [ ] Read the trusted receiver's `arc` result and the `ARC-Authentication-Results` with the highest instance `i=` (RFC 8617 section 4.1.1). Done when: `test/checks/arc.test.ts` parses a synthetic two-hop chain.
- [ ] Emit `auth.arc` info with the earlier results when `arc=pass`, and medium when `arc=fail`. Done when: both fixtures pass.
- [ ] Commit: `checks: ARC chain evidence`

**Test checkpoint:** `pnpm exec vitest run test/checks/arc.test.ts` passes.

## 4. Display name, Reply-To and Return-Path checks

Business email compromise often keeps a real-looking display name over a different address, or sends replies elsewhere (spec 4.3 Sender).

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Register the sender checks in `src/checks/sender.ts`. Done when: each fixture yields its item and a normal mail yields none.

- [ ] Register `sender.display_address`: medium when the display name contains an email address or domain different from the actual From address. Done when: `"debtors@fynbosfreight.example" <x@freemail.example>` yields it.
- [ ] Register `sender.display_brand`: medium when the display name names a brand from the brand table (D02 T03 §3) and the From domain is not one of that brand's domains. Done when: a fixture naming a fictional bank from a free mailbox yields it.
- [ ] Register `sender.reply_to`: medium when `Reply-To` has a different registrable domain from From. Done when: the fixture yields it and a same-domain Reply-To does not.
- [ ] Register `sender.return_path`: low when `Return-Path` differs from From's registrable domain and the domain is not a known mail service (SMTP2GO, Microsoft, Google, Mailchimp list in code). Done when: both fixtures behave.
- [ ] Commit: `checks: display name, Reply-To and Return-Path`

**Test checkpoint:** `pnpm exec vitest run test/checks/sender.test.ts` passes and fails if a same-domain Reply-To is flagged.

## 5. First-time sender per organisation

A sender this organisation has never had mail from is a weak but useful signal, especially with a payment request. Senders are remembered per organisation as hashes, never as addresses in clear.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Add `org_senders` and the check. Done when: the first case from a sender flags it and the second does not.

- [ ] Add migration `0008_senders.sql` with `org_senders` (`org_id`, `sender_hash` SHA-256 of the lower-case address with a per-organisation salt, `first_seen`, `count`). Done when: it applies locally.
- [ ] Register `sender.first_time` (low) and record the sender after the check. Done when: `test/checks/first-time.test.ts` sees low on the first case and nothing on the second.
- [ ] Commit: `checks: first-time sender per organisation`

**Test checkpoint:** `pnpm exec vitest run test/checks/first-time.test.ts` passes.

## Verification

- Header and sender fixtures produce exactly the expected evidence with header excerpts; forged headers are never trusted.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
