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
| 1 | §1 | Trusted Authentication-Results parsing | D02 T01 §2 | [x] |
| 2 | §2 | SPF, DKIM and DMARC alignment evidence | §1 | [ ] |
| 3 | §3 | ARC chain evidence | §1 | [ ] |
| 4 | §4 | Display name, Reply-To and Return-Path checks | D02 T01 §2, D02 T03 §3 | [ ] |
| 5 | §5 | First-time sender per organisation | §4 | [ ] |
| 6 | §6 | Receiving chains behind a filtering gateway | §1 | [ ] |

## 1. Trusted Authentication-Results parsing

Anyone can write an `Authentication-Results` header into a message. Only the ones added by the member's own receiving system are trusted (spec 4.3): the topmost headers whose `authserv-id` matches a receiver the organisation uses (for Microsoft 365, `*.prod.outlook.com` and `outlook.com`; for Google, `mx.google.com`). The organisation's receivers are learned from its verified domains' MX records and stored.

> **Started:** 2026-10-30T11:24Z

**Corrected 2026-10-30** (at start, checked against the repository and Microsoft Learn): (1) an RFC 8601 parser already exists, `parseAuthenticationResults` in `src/intake/sender.ts` (the intake's check of Email Routing's own header); this section reuses it rather than writing a second one, and extends it for the form Microsoft 365 writes, which has no authserv-id (Microsoft Learn, "Anti-spam message headers in cloud organizations": `Authentication-Results: spf=pass (sender IP is 192.168.0.1) smtp.mailfrom=contoso.com; dkim=pass ...; dmarc=pass action=none header.from=contoso.com; compauth=pass reason=100`): a header whose first part is a result reads with no authserv-id and every part a result, and the intake's own check, which needs Email Routing's authserv-id, is unchanged; (2) so the Microsoft 365 receiver is trusted by shape, not only by pattern: the topmost contiguous headers with no authserv-id that carry `compauth` (Microsoft's own method), or an authserv-id matching `*.prod.outlook.com` or `outlook.com`; Google by `mx.google.com`; any other receiver by an authserv-id equal to one of its MX hosts or inside the registrable domain of one; (3) checks are pure (`src/checks/registry.ts`: a check never reaches the store), so `trustedAuthResults(headers, receivers)` takes the organisation's receivers, which the Workflow's `checks` step reads and puts in the view's tenant, not an org id; (4) the table is `org_receivers` in `src/db/migrations/0034_org_receivers.sql`, the next free number; (5) receivers are learned from MX over DNS-over-HTTPS (`DOH_URL` in `src/auth/domains.ts`) when a domain is verified, by DNS or by code, and a failed lookup never fails the verification; the `checks` step learns them again, within a deadline, for an organisation whose verified domains have none or whose receivers are older than 30 days, keeping the old set when the lookup fails; (6) the info item says which limit applies: the original's headers did not come with it (an inline forward or an upload), the organisation's receiving system is not known yet, or no header was added by it; the inline-forward fixture exists and a no-receiver fixture is added; (7) D07 T02's closure purge names `org_receivers` beside the other domain rows.

**Corrected 2026-10-30** (plan review): (8) a provider match does not prove who wrote a header (RFC 8601 section 7.1): a forged header can carry the receiver's authserv-id or Microsoft's no-id `compauth` shape. So trust is by the receiving boundary: reading from the top, the receiver's zone is the run of `Received` headers its own hosts wrote (a `by` host matching the receiver: the MX hosts, `*.outlook.com` for Microsoft 365, `*.google.com` for Google; a `by` that is an address literal, as Gmail's internal hops write, continues the zone without opening it), and only `Authentication-Results` headers inside that zone, above the first `Received` written by any other host, that also match the receiver (correction 2) are trusted. A message with no receiver-written `Received` at its top, or whose zone holds results from two receiver kinds, has no trusted header: the provenance is ambiguous and is said so, never guessed. A header the receiver wrote cannot sit below one the sender wrote, so a forged one below the boundary, same provider or not, is ignored; an uploaded file's zone is reported as read from the member's file, which IsItLegit cannot confirm; (9) checks run concurrently on a frozen view and return evidence only, so §2 calls the same pure selector, `trustedAuthResults(view.headers, view.tenant.receivers)`, rather than receiving this check's output; `auth.results` itself returns one info item, on success naming the receiver and listing each result as plain JSON (method, result, properties as an object), and the test runs it through the registry, `runChecks`, `saveEvidence` and `readEvidence`; (10) a receiver row is bound to its verified claim (`claim_id`, the `org_domains` row): removing the domain deletes its receivers in the same batch, `learnReceivers` writes only while that claim is still verified (so a lookup finishing after removal writes nothing), and the Workflow reads only receivers whose claim is verified; tested for removal, a late lookup, and delete then re-add without a fresh verification; (11) correction (6) was wrong about uploads: an uploaded `.eml` or readable `.msg` keeps its headers, so the limit is classified by `tenant.headersAvailable`, and `auth.results` declares no `needs`, so it runs to explain a missing header rather than being skipped; tests cover an uploaded original with headers, a headerless upload, an inline forward, an unknown receiver and a known receiver with no header in its zone.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Parse `Authentication-Results` per RFC 8601, Microsoft's no-authserv-id form included. Done when: tests parse the RFC's examples, Microsoft's documented header and three synthetic receiver headers.
2. Learn each organisation's receivers and select only the headers they added. Done when: a forged lower header is ignored, and a case whose receiver is unknown or whose headers did not come says so.

- [x] Extend `parseAuthenticationResults` in `src/intake/sender.ts` so a header whose first part is a result has `authservId: null` and every part a result, and export it for the checks; the intake's Email Routing check is unchanged. Done when: `test/checks/auth-results.test.ts` parses the RFC 8601 appendix B examples and Microsoft's documented header, and `test/intake/sender.test.ts` still passes. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `src/intake/sender.ts`; the appendix B forms and Microsoft's documented header in `test/checks/auth-results.test.ts`; `test/intake/sender.test.ts` passes; fails with the Microsoft form removed.
- [x] Add `org_receivers` (claim id, org id, domain, kind `microsoft`, `google` or `other`, pattern, learned at) in `src/db/migrations/0034_org_receivers.sql`, and `learnReceivers(db, claimId, lookupMx)` in `src/auth/receivers.ts` mapping MX `*.mail.protection.outlook.com` to Microsoft 365, `aspmx.l.google.com`, `*.aspmx.l.google.com` and `smtp.google.com` to Google, and any other MX to its host and registrable domain, replacing the claim's rows in one batch that writes only while the claim is verified. Done when: `test/auth/receivers.test.ts` stores the Microsoft kind for MX `contoso-com.mail.protection.outlook.com`, the Google kind for `aspmx.l.google.com`, an `other` pattern for an unknown MX, nothing new (the old rows kept) when the lookup fails, and nothing when the claim was removed before the lookup finished. (**Corrected 2026-10-30**, at start and plan review.) Done 2026-10-30: `src/db/migrations/0034_org_receivers.sql`, `src/auth/receivers.ts`; `test/auth/receivers.test.ts` covers each kind, a failed lookup, a pending claim and a claim removed mid-lookup (fails with the claim guard removed).
- [x] Learn the receivers when a domain is verified, by DNS (`verifyByDns`) and by code, in `src/auth/domains.ts`, a failed MX lookup leaving the verification done; delete a claim's receivers with the claim in the domain delete route; and in the Workflow's `checks` step (`src/pipeline/analysis-workflow.ts`) read the receivers of the organisation's verified claims into the view's tenant (`Tenant.receivers` in `src/checks/case-view.ts`), learning them again within a deadline when its verified domains have none or they are older than 30 days. Done when: a test verifies a domain by DNS and by code and finds its receivers stored, a verification whose MX lookup fails still succeeds, removing the domain removes its receivers, delete then re-add without verification trusts none, and the `checks` step's view carries the receivers, learned again when missing or stale. (**Corrected 2026-10-30**, at start and plan review.) Done 2026-10-30: `learnedQuietly` on both verify paths and the delete route in `src/auth/domains.ts`, `receiversForOrg` in the `checks` step (two lookups of 3 s at most per case); tests in `test/auth/domains.test.ts`, `test/auth/receivers.test.ts` and `test/pipeline/analysis-workflow.test.ts`, each failing with its branch removed.
- [x] Write `trustedAuthResults(headers, receivers)` in `src/checks/auth-results.ts`, a pure selector returning the trusted results or the reason there are none (headers not with the original, receiving system not known, no receiver-written `Received` at the top, results from two receiver kinds, no header in the receiver's zone), by the receiving boundary of corrections 2 and 8; and register `auth.results` (no `needs`) in `src/checks/index.ts`, returning one info item: the receiver and each result as JSON on success, else the reason, an uploaded file's results marked as read from the file. Done when: `test/checks/auth-results.test.ts` trusts only the real header when a forged one sits below it, with a same-provider forgery for Google and for Microsoft 365 below each boundary, refuses two receiver kinds in one zone and a message whose top was not written by the receiver, and classifies an uploaded original with headers, a headerless upload, an inline forward, an unknown receiver and a known receiver with no header; and a test runs `auth.results` through the registry, `runChecks`, `saveEvidence` and `readEvidence` and reads its item back. Cheaper substitute: trusting every `Authentication-Results` header. (**Corrected 2026-10-30**, at start and plan review.) Done 2026-10-30: `src/checks/auth-results.ts`, registered after the intake checks; every case in `test/checks/auth-results.test.ts`, the read-back through registry, runner and store, and a headerless case through the runner; mutations of the boundary, the topmost choice, the `compauth` rule and the empty `needs` each fail a test.
- [x] Add `org_receivers` to D07 T02's closure purge item in `todo/07-app/TODO-02-auth-and-tenancy.md`. Done when: that item names `org_receivers` beside `org_domains`. (**Corrected 2026-10-30**, at start.) Done 2026-10-30.
- [x] Commit: `checks: trusted Authentication-Results parsing` Done 2026-10-30: 42ac0cf, then the review fixes to 9374ea7.

**Test checkpoint:** `pnpm exec vitest run test/checks/auth-results.test.ts` passes and fails if the forged header is trusted.

> **Verified:** 2026-10-30 | §1 | 54329057ac79d1cfb03322328b04b0d3ef16c283
> **Review:** `docs/reviews/d02-t02-s1.json`

## 2. SPF, DKIM and DMARC alignment evidence

From the trusted results, produce evidence: SPF and DKIM pass or fail, DMARC result, and whether the passing identifier aligns with the visible From domain (RFC 7489 section 3.1, relaxed alignment by registrable domain via `tldts`).

> **Started:** 2026-10-30T13:02Z

**Corrected 2026-10-30** (at start, checked against the repository and Microsoft Learn): (1) checks run side by side on one frozen view and never read each other's output (`src/checks/registry.ts`), so each `auth.*` check calls §1's pure selector, `trustedAuthResults(view.headers, view.tenant.receivers, view.tenant.headersAvailable)`, and returns nothing when it trusts no header (`auth.results` already says why); (2) the From domain's DMARC policy is read where each receiver writes it: Google in the result's comment (`dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=...`), which the parser in `src/intake/sender.ts` drops today, so each result keeps its comment text; Microsoft 365 by its `action` property on a failure (Microsoft Learn, "Anti-spam message headers": `reject`, `oreject`, `quarantine`, `pct.reject`, `pct.quarantine` name the policy applied); a `policy.dmarc` property where a receiver writes one; otherwise the policy is unknown and a failure is medium; (3) checks are pure and cannot write to R2, so no excerpt object exists: each item carries the trusted header's text in its detail (bounded), and its `artefacts` name the stored raw message the header came from (`rawKey` in `src/intake/store.ts`), which the view gains as `raw`; (4) the visible From domain comes from the original's `From` header (postal-mime's `addressParser`); a From naming no single mailbox cannot be aligned and says so; registrable domains come from `registrable` in `src/auth/senders.ts`.

**Corrected 2026-10-30** (plan review): (5) each method's result is one of four states, never two: passed (`pass`), failed (`fail`, and `softfail` for SPF), inconclusive (`temperror`, `permerror`, `neutral`, `policy`, Microsoft's `action=temperror` or `action=permerror` on DMARC) or unavailable (`none`, a method not reported, Microsoft's `bestguesspass`, which says the domain publishes no DMARC record); `auth.alignment` is high only when SPF and DKIM are each failed or unavailable with no aligned pass, medium when either is inconclusive with no aligned pass ("could not be confirmed"), info when one passed aligned; (6) the identifiers: SPF's is the `smtp.mailfrom` domain (mailbox or domain form), or, only when that is absent or the null path, `smtp.helo`, said so in the detail; DKIM's is the signing domain `header.d`, or, when only `header.i` is given, its domain, which RFC 6376 section 3.5 requires to be `d` or under it, so its registrable domain is `d`'s; a signature naming neither has no identifier and aligns nothing; any one aligned pass among several signatures aligns; (7) the applicable DMARC policy: Microsoft's `action` is the policy it applied to this message; Google's comment gives the record's `p` and `sp`, and for a From that is its own registrable domain `p` applies, while for a subdomain the record may be the subdomain's own (`p`) or the organisation's (`sp`), so a failure is high only when both are `reject` or `quarantine`, medium otherwise, the detail naming the uncertainty; (8) the selector keeps each trusted result's own header (`sources` on `Trusted`, one per header with its text and results), so every item cites the header its result came from, never a neighbour; (9) a test runs a stored synthetic message through the Workflow's `checks` entry point and `readEvidence`, asserting each `auth.*` item's check name, severity, header text and an artefact key that exists in R2, and fails when the registration or the raw key's propagation is removed; the checkpoint includes `test/intake/sender.test.ts` and `test/checks/auth-results.test.ts`.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Write the auth checks. Done when: each synthetic fixture yields its expected severity.

- [ ] Keep each result's comment text in `parseAuthenticationResults` (`src/intake/sender.ts`). Done when: `test/checks/auth-results.test.ts` reads Google's `(p=REJECT sp=REJECT dis=NONE)` from its DMARC result. (**Corrected 2026-10-30**, at start.)
- [ ] Register check `auth.spf` (failed medium, inconclusive low, passed and unavailable info) in `src/checks/auth.ts`. Done when: `test/checks/auth.test.ts` covers pass, fail, softfail, temperror, permerror, neutral and none. (**Corrected 2026-10-30**, plan review.)
- [ ] Register check `auth.dkim` (failed medium, inconclusive low; passed with each signing domain in detail). Done when: the fixtures pass, including two signatures and a `header.i`-only one. (**Corrected 2026-10-30**, plan review.)
- [ ] Register check `auth.dmarc` with the applicable policy of correction 7 (Google's comment `p` and `sp`, Microsoft 365's `action`, a `policy.dmarc` property): failed high when that policy is certainly `reject` or `quarantine`, medium otherwise; inconclusive low; unavailable (including `bestguesspass`) info. Done when: the fixtures pass, including `p=reject; sp=none` and `p=none; sp=reject` for a subdomain From, each Microsoft action, and `temperror`. (**Corrected 2026-10-30**, at start and plan review.)
- [ ] Register check `auth.alignment` over the identifiers of correction 6 and the states of correction 5. Done when: an unrelated-SPF pass is high, a DKIM-only aligned pass is info, two signatures with one aligned pass are info, a same-domain failed signature does not align, a mailbox-form `smtp.mailfrom` aligns by its domain, a signature naming no signer aligns nothing, a `temperror` with no aligned pass is medium, and a full-hostname comparison fails the subdomain fixture. (**Corrected 2026-10-30**, plan review.)
- [ ] Keep each trusted result's own header in the selector (`sources` on `Trusted` in `src/checks/auth-results.ts`), and carry that header's text in each item's detail and the stored raw message's key in its `artefacts`, the view gaining `raw` from `caseViewOf`. Done when: with two accepted headers and a rejected forgery beside them, each item cites the header its result came from; and a stored message run through the Workflow's `checks` entry point reads back every `auth.*` item with its severity, header text and a raw key that exists in R2, failing when the registration or the raw key's propagation is removed. (**Corrected 2026-10-30**, at start and plan review.)
- [ ] Commit: `checks: SPF, DKIM and DMARC alignment evidence`

**Test checkpoint:** `pnpm exec vitest run test/checks/auth.test.ts test/checks/auth-results.test.ts test/intake/sender.test.ts test/pipeline/analysis-workflow.test.ts` passes, and fails if alignment compares full host names instead of registrable domains.

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

## 6. Receiving chains behind a filtering gateway

Filed 2026-10-30 from D02 T02 §1's completion review (Part 1 item 12): receivers are learned from MX, so an organisation whose MX points at a filtering gateway (a security service in front of Microsoft 365 or Google, a configuration Microsoft documents as "enhanced filtering for connectors") has only the gateway learned. The mailbox provider's own hops then sit above the gateway's at the top of the message, outside every learned receiver, so `trustedAuthResults` in `src/checks/auth-results.ts` finds no boundary and neither system's results are used. Widening automatic trust would let a sender's headers through; the chain has to be verified. The same holds inside a receiver other than Microsoft 365 or Google (widened 2026-10-30 from §1's rounds 2 to 4): neither a hop's greeting name nor a private connecting address proves a hop is the receiver's own (a proxy hides the peer), so §1 trusts such a receiver's headers only above the message's topmost `Received`, and one that writes its header lower down, between its own hops, is not trusted until its internal chain is verified here.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Learn a verified receiving chain. Done when: an organisation's chain (gateway, then mailbox provider) is stored only from evidence the organisation's own mail proves, never from a guess.
2. Select across the chain. Done when: the zone runs through every hop of the chain, the provider's results are trusted, and an injected result is still refused.

- [ ] Decide how a chain is proven, in `docs/specs/`: from a message the organisation forwards from its own domain to `check@` (the hops above Email Routing's are its chain), or from the provider's documented connector settings; record the choice and its reversal cost. Done when: the decision names its evidence and how a stale chain is noticed.
- [ ] Store the chain beside the receivers (`org_receivers` gains the hop order, or a new table under a number the coordinator gives) and learn it as decided. Done when: `test/auth/receivers.test.ts` stores a gateway-then-Microsoft chain and a gateway-then-Google chain.
- [ ] Have `trustedAuthResults` run the zone through every hop of a stored chain, trusting the mailbox provider's stamp under the rules of §1, and another receiver's headers between the verified hops of its own chain. Done when: `test/checks/auth-results.test.ts` trusts the provider's results behind each gateway and another receiver's header between two verified hops, and refuses an injected result below the gateway's border hop and one under a proxy whose hop is not in the verified chain.
- [ ] Commit: `checks: receiving chains behind a filtering gateway`

**Test checkpoint:** `pnpm exec vitest run test/checks/auth-results.test.ts test/auth/receivers.test.ts` passes, with both gateway fixtures.

## Verification

- Header and sender fixtures produce exactly the expected evidence with header excerpts; forged headers are never trusted.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
