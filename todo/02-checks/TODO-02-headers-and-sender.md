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
| 2 | §2 | SPF, DKIM and DMARC alignment evidence | §1 | [x] |
| 3 | §3 | ARC chain evidence | §1 | [x] |
| 4 | §4 | Display name, Reply-To and Return-Path checks | D02 T01 §2, D02 T03 §3 | [x] |
| 5 | §5 | First-time sender per organisation | §4 | [x] |
| 6 | §6 | Receiving chains behind a filtering gateway | §1 | [x] |
| 7 | §7 | First-time sender per recipient | §5 | [ ] |
| 8 | §8 | Familiarity from consented mail | §5 | [ ] |
| 9 | §9 | Gateway relay ranges, decided | §6 | [x] |
| 10 | §10 | Configured relay revision lifecycle | §9 | [ ] |
| 11 | §11 | Configured relay trust consumption | §10 | [ ] |

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

**Corrected 2026-10-30** (round 1): (10) correction 6 read a result without `smtp.mailfrom` as the null path; only an explicitly empty one (`smtp.mailfrom=<>`) is, so a HELO identity aligns only then (RFC 7489 section 3.1.2), and a HELO pass beside a MAIL FROM failure aligns nothing; (11) a domain is checked as a whole before its A-label conversion, so a From such as `a@bank.example/evil.example` names no valid address, and the policy's organisational-domain test uses the A-label form too.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Write the auth checks. Done when: each synthetic fixture yields its expected severity.

- [x] Keep each result's comment text in `parseAuthenticationResults` (`src/intake/sender.ts`). Done when: `test/checks/auth-results.test.ts` reads Google's `(p=REJECT sp=REJECT dis=NONE)` from its DMARC result. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `splitOutside` and `commentsOf` in `src/intake/sender.ts` split before stripping, so a `;` inside a comment stays in it; fails with the comment dropped.
- [x] Register check `auth.spf` (failed medium, inconclusive low, passed and unavailable info) in `src/checks/auth.ts`. Done when: `test/checks/auth.test.ts` covers pass, fail, softfail, temperror, permerror, neutral and none. (**Corrected 2026-10-30**, plan review.) Done 2026-10-30: `src/checks/auth.ts`, `test/checks/auth.test.ts` (seven results, the HELO identity on the null path).
- [x] Register check `auth.dkim` (failed medium, inconclusive low; passed with each signing domain in detail). Done when: the fixtures pass, including two signatures and a `header.i`-only one. (**Corrected 2026-10-30**, plan review.) Done 2026-10-30.
- [x] Register check `auth.dmarc` with the applicable policy of correction 7 (Google's comment `p` and `sp`, Microsoft 365's `action`, a `policy.dmarc` property): failed high when that policy is certainly `reject` or `quarantine`, medium otherwise; inconclusive low; unavailable (including `bestguesspass`) info. Done when: the fixtures pass, including `p=reject; sp=none` and `p=none; sp=reject` for a subdomain From, each Microsoft action, and `temperror`. (**Corrected 2026-10-30**, at start and plan review.) Done 2026-10-30: `policyOf`; the subdomain cases fail when the policy is taken as certain.
- [x] Register check `auth.alignment` over the identifiers of correction 6 and the states of correction 5. Done when: an unrelated-SPF pass is high, a DKIM-only aligned pass is info, two signatures with one aligned pass are info, a same-domain failed signature does not align, a mailbox-form `smtp.mailfrom` aligns by its domain, a signature naming no signer aligns nothing, a `temperror` with no aligned pass is medium, and a full-hostname comparison fails the subdomain fixture. (**Corrected 2026-10-30**, plan review.) Done 2026-10-30: fails when compared by full host name, and when errors read as failures.
- [x] Keep each trusted result's own header in the selector (`sources` on `Trusted` in `src/checks/auth-results.ts`), and carry that header's text in each item's detail and the stored raw message's key in its `artefacts`, the view gaining `raw` from `caseViewOf`. Done when: with two accepted headers and a rejected forgery beside them, each item cites the header its result came from; and a stored message run through the Workflow's `checks` entry point reads back every `auth.*` item with its severity, header text and a raw key that exists in R2, failing when the registration or the raw key's propagation is removed. (**Corrected 2026-10-30**, at start and plan review.) Done 2026-10-30: `sources` on `Trusted`, `raw` on `CaseView`; the pipeline test in `test/pipeline/analysis-workflow.test.ts` fails without the registration or the raw key; 362 tests across the checks, intake, pipeline and auth folders pass.
- [x] Commit: `checks: SPF, DKIM and DMARC alignment evidence` Done 2026-10-30: c2ceba4, then the review fixes to 51f8c3d.

**Test checkpoint:** `pnpm exec vitest run test/checks/auth.test.ts test/checks/auth-results.test.ts test/intake/sender.test.ts test/pipeline/analysis-workflow.test.ts` passes, and fails if alignment compares full host names instead of registrable domains.

> **Verified:** 2026-10-30 | §2 | fa8df3f037fa4ba4aa479807d186fbfd8ebb12db
> **Review:** `docs/reviews/d02-t02-s2.json`

## 3. ARC chain evidence

Forwarders and mailing lists break SPF and DKIM; ARC (RFC 8617) carries the earlier results. The trusted receiver's `arc=` result is read and, when it passes, the earlier authentication results inside the sealed chain are reported as context, not as proof.

> **Started:** 2026-10-30T13:49Z

**Corrected 2026-10-30** (at start, checked against the code and the receivers' header forms): (1) the receiver's ARC verdict is read where each writes it, under §1's provenance rules: Google in its trusted `Authentication-Results` (`arc=pass (i=1 spf=pass ...)`, the comment naming the instance it validated), through `trustedAuthResults`; Microsoft 365 writes no `arc=` there but seals the message on receipt, its verdict inside its own `ARC-Authentication-Results` (authserv-id `mx.microsoft.com`), which is read as Microsoft's topmost stamp is, the topmost of that authserv-id down to the first hop another host wrote; any other receiver's `arc=` only from its trusted header; (2) "the highest instance" can be the receiver's own seal (Microsoft's), so the earlier results are the `ARC-Authentication-Results` of the instance the receiver validated: the `i=` in Google's comment, or the instance just below Microsoft's own; the sealer is the `d=` of the `ARC-Seal` with that instance; (3) an `ARC-Authentication-Results` value is `i=<n>;` then a header of §1's grammar, parsed by the shared parser after the instance; (4) `auth.arc` is pure and reads only the view (`src/checks/registry.ts`); it says nothing when no ARC verdict is trusted, and the earlier results are context with their sealer named, never proof: they do not change §2's items.

**Corrected 2026-10-30** (plan review): (5) `auth.arc` is registered in `src/checks/index.ts` after §2's checks, and a stored synthetic message run through the Workflow's `checks` step and `readEvidence` asserts its severity, earlier results, sealer, the header excerpts it rests on and the raw message key that exists in R2, failing when the registration or the provenance is removed; (6) `arc=none` means no chain arrived, normal for mail sent straight to the receiver: `auth.arc` says nothing for it (no instance zero is ever read), distinct from `temperror` or `permerror`, which are low; (7) the earlier context is found only from what the receiver names: the `i=` in its verdict's comment (any receiver that writes one), or, for Microsoft, the instance below its own; a pass naming no instance, an instance with no `ARC-Authentication-Results` or no `ARC-Seal`, or two of either for one instance, is "the receiver reported a pass; the earlier context is unavailable", never a guessed instance. The boundary selects the receiver's verdict only; the earlier `ARC-Authentication-Results` it names may sit below that boundary, where the earlier hop wrote it; (8) the earlier results are converted to plain JSON (properties as an object), every value in the detail bounded and the summary plain, as §2's items are (`boundedDetail` in `src/checks/auth.ts`), with a runner and store test of oversized and hostile values keeping the outcome.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Register check `auth.arc`. Done when: fixtures with `arc=pass` and `arc=fail` yield the expected items.

- [x] Read the trusted receiver's ARC verdict (correction 1) and the earlier `ARC-Authentication-Results` and sealer of the instance it validated (corrections 2 and 3) in `src/checks/arc.ts`. Done when: `test/checks/arc.test.ts` reads Google's verdict with its instance, Microsoft's from its own seal with the instance below, and a synthetic two-hop chain's earlier results and sealer. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `src/checks/arc.ts` (`arcVerdict`, `readArcResults`, `readArcSeal`), `receiverZone` in `src/checks/auth-results.ts`.
- [x] Emit `auth.arc` info with the earlier results and sealer when the verdict is `pass`, info saying the context is unavailable when it cannot be found (correction 7), medium when `fail`, low when it could not be evaluated, nothing for `none` or no trusted verdict; register it and carry the header excerpts and raw key (corrections 5, 6 and 8). Done when: each fixture passes (a legitimate earlier set below the boundary, an unavailable context, duplicate instances, Microsoft's first set with `arc=none`), a forged verdict below the receiver's boundary is never read, oversized and hostile values keep the item, and the Workflow `checks` test reads it back from the store. (**Corrected 2026-10-30**, at start and plan review.) Done 2026-10-30: `test/checks/arc.test.ts` (10 tests) and the Workflow read-back in `test/pipeline/analysis-workflow.test.ts`; five mutations (registration, `arc=none`, a doubled instance, the Microsoft path for any receiver, Microsoft's set read below the boundary) each fail a test.
- [x] Commit: `checks: ARC chain evidence` Done 2026-10-30: 15bffc4, then the review fixes to 72e916f.

**Test checkpoint:** `pnpm exec vitest run test/checks/arc.test.ts` passes.

> **Verified:** 2026-10-30 | §3 | 7d159c86737ac82b10633ec6d6e5b9067b8bf9c1
> **Review:** `docs/reviews/d02-t02-s3.json`

## 4. Display name, Reply-To and Return-Path checks

Business email compromise often keeps a real-looking display name over a different address, or sends replies elsewhere (spec 4.3 Sender).

> **Started:** 2026-10-30T14:34Z

**Corrected 2026-10-30** (at start, checked against the repository): (1) the brand table is read from KV with the bundled copy as fallback (`brandTable(env)` in `src/checks/brands.ts`), and checks are pure (`src/checks/registry.ts`), so the Workflow's `checks` step reads it and puts it in the view (`brands` on `CaseView`), as it does the receivers; a check never reads KV; (2) the From domain is §2's validated `fromDomain` (`src/checks/auth.ts`), and From, Reply-To and the display name come from postal-mime's `addressParser`; a brand is named in a display name when one of its `display_names` appears in it as whole words, compared case-folded after NFKC; a brand's own domains are its registrable domains, never its `user_content` hosts; (3) `Return-Path` is the topmost one, which the receiving system writes at final delivery; (4) the checks read the original's headers only: with none (an inline forward, a file without them) they say nothing, `auth.results` already saying why; each item carries the header it rests on and the raw message key, its detail fitted to the store as §2's are (`fittedDetail`).

**Corrected 2026-10-30** (plan review): (5) the four checks are registered in `src/checks/index.ts`, and a stored synthetic message run through the Workflow's `checks` entry point and `readEvidence` asserts all four names, severities, header excerpts and an existing raw key; a brand added to KV's table reaches `sender.display_brand` there; hostile and oversized display names keep their items; (6) `sender.display_address` compares a mailbox shown in the display name with the From mailbox as a whole (local part and A-label domain, case-folded), and a bare domain shown with the From's registrable domain: a different mailbox at the same domain is a finding, a matching mailbox or domain is not; (7) brand matching: whole words only (a brand name inside a longer word is not named), NFKC and case-folded; an official domain or its subdomain is the brand's, and a `user_content` host (a consumer mailbox the brand runs) never is; (8) Reply-To: every destination is checked, groups included, so a same-domain first address cannot hide an external second one; when the From domain is unavailable, or a destination cannot be read, `sender.reply_to` says the comparison could not be made (info), never a mismatch and never silence; (9) Return-Path: absent says nothing, `<>` (empty, a valid bounce path) says nothing, an unreadable one says it could not be compared (info); a same-registrable path says nothing; an unrelated one is low, except under a known service's domain (SMTP2GO, Microsoft, Google, Mailchimp: their own registrable domains, so a lookalike such as `smtp2go.com.evil.example` stays flagged); only the topmost Return-Path is read.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Register the sender checks in `src/checks/sender.ts`. Done when: each fixture yields its item and a normal mail yields none.

- [x] Register `sender.display_address` (correction 6) in `src/checks/sender.ts`. Done when: `test/checks/sender.test.ts` flags `"debtors@fynbosfreight.example" <x@freemail.example>`, a domain-only display (`"fynbosfreight.example" <x@freemail.example>`) and a different mailbox at the same domain, and passes a matching mailbox and a matching domain. (**Corrected 2026-10-30**, plan review.) Done 2026-10-30: `src/checks/sender.ts`; fails when mailboxes are compared by domain only.
- [x] Register `sender.display_brand` (corrections 1, 2 and 7) over the view's `brands`. Done when: a fictional bank named from a free mailbox is flagged, the bank's official subdomain is not, a brand name inside a longer word is not, an NFKC and case variant is, and a `user_content` mailbox host is flagged. (**Corrected 2026-10-30**, plan review.) Done 2026-10-30: fails with a substring match or with `user_content` trusted.
- [x] Register `sender.reply_to` (correction 8). Done when: an external Reply-To is flagged, a same-domain one is not, an external address after a same-domain one (and inside a group) is flagged in either order, and an unavailable From or an unreadable destination says the comparison could not be made. (**Corrected 2026-10-30**, plan review.) Done 2026-10-30: fails when only the first destination is read.
- [x] Register `sender.return_path` (correction 9). Done when: absent and `<>` say nothing, unreadable says it could not be compared, same-domain says nothing, an unrelated domain is low, each of the four services' domains says nothing, a lookalike of one is low, and a lower forged Return-Path below the topmost is not read. (**Corrected 2026-10-30**, plan review.) Done 2026-10-30: `MAIL_SERVICES` (SMTP2GO, Microsoft, Google, Mailchimp's own registrable domains); fails without the service exceptions.
- [x] Register the four in `src/checks/index.ts`, read the brand table into the view in the Workflow's `checks` step, and test the stored path (correction 5). Done when: the Workflow `checks` test reads all four back with their excerpts and raw key, a KV brand reaches the check, and a hostile oversized display name keeps its item. (**Corrected 2026-10-30**, plan review.) Done 2026-10-30: `brands` on `CaseView` from `brandTable(this.env)` in the Workflow's `checks` step; the Workflow run test reads a KV-only brand (fails with the bundled table passed instead), and 366 tests across the checks, pipeline and intake folders pass.
- [x] Commit: `checks: display name, Reply-To and Return-Path` Done 2026-10-30: d99a8d2, then the review fixes to 9ae22b3.

**Test checkpoint:** `pnpm exec vitest run test/checks/sender.test.ts test/pipeline/analysis-workflow.test.ts` passes and fails if a same-domain Reply-To is flagged.

> **Verified:** 2026-10-30 | §4 | 1f1785094afd92ae9c2f567d856e5d548fd36b1e
> **Review:** `docs/reviews/d02-t02-s4.json`

## 5. First-time sender per organisation

A sender this organisation has never had mail from is a weak but useful signal, especially with a payment request. Senders are remembered per organisation as hashes, never as addresses in clear.

> **Started:** 2026-10-30T16:17Z

**Corrected 2026-10-30** (at start, checked against the repository): (1) migration `0008` is long taken; the number comes from the coordinator (asked 2026-10-30), and the tables are `org_senders` (org id, sender hash, the case that first recorded it, first seen, count) and `org_sender_salts` (a random 32-byte salt per organisation, made on first use), so a sender is only ever a salted SHA-256 of its lower-cased address; (2) checks are pure (`src/checks/registry.ts`: a check never reaches the store), so the Workflow's `checks` step reads the sender's history into the view (`senderHistory` on `CaseView`: unknown, first, or seen before) and records the sender after the evidence is stored; the record names the case that first saw the sender, so a retried step reads "first" again for that case and never counts it twice; (3) the sender is the original's single From mailbox as §2 validates it (`fromDomain`'s rules in `src/checks/auth.ts`): no valid From, or no headers, means no item and nothing recorded; (4) `sender.first_time` carries the From header excerpt and the raw message key, its detail fitted to the store, as §2's items do; (5) a closed organisation's senders and salt are purged with it: D07 T02's closure purge item is the app lane's, asked of it through the coordinator (2026-10-30).

**Corrected 2026-10-30** (plan review): (6) corrections 1 and 2's `org_senders` and recording after the evidence are replaced by one table, `sender_observations` (org id, case id, sender hash, classification, observed at; one row per case): before the checks, the `checks` step classifies the case in a single statement that inserts its row as `first` unless the organisation has a row for that sender already, else `seen`, and does nothing when the case has its row; D1 runs one write at a time, so of two overlapping cases exactly one is first, a retried step reads its own row back unchanged, and the count of a sender's cases is the count of its rows, never incremented twice; (7) the sender hashed is the canonical mailbox, `mailbox` in `src/checks/sender.ts` (A-label domain, a needless quote removed, case-folded), so `bücher.example` and `xn--bcher-kva.example` are one sender; (8) the item says what IsItLegit can know: this sender has not appeared in the organisation's earlier IsItLegit checks, which says nothing of mail the organisation received without checking it; (9) `org_sender_salts` holds one random 32-byte salt per organisation, inserted only when absent and read back, so concurrent first use never replaces a salt in use; two organisations keep separate salts, hashes and histories; (10) with no headers (an inline forward, whose outer From is the forwarding member's, or a headerless upload), or no single valid From mailbox, there is no item and no row; (11) the stored item carries the From excerpt and the raw key, and an oversized display name keeps it.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Add `org_senders` and the check. Done when: the first case from a sender flags it and the second does not.

- [x] Add the migration (its number from the coordinator) with `org_sender_salts` and `sender_observations` (corrections 6 and 9), and `observeSender(db, orgId, caseId, mailbox)` in `src/checks/senders-seen.ts` returning `first` or `seen`. Done when: `test/checks/first-time.test.ts` shows two organisations each first for the same address with distinct 32-byte salts and hashes, a second case seen, a retried case its own answer, two overlapping first cases one first and one seen, an equivalent A-label mailbox the same sender, a salt never replaced, and no address in clear in D1. (**Corrected 2026-10-30**, at start and plan review.) Done 2026-10-30: `src/db/migrations/0037_sender_observations.sql` (0037 from the coordinator), `src/checks/senders-seen.ts`; four mutations (a retry reclassified, the inline forward's outer From learned, a non-canonical mailbox, a salt replaced) each fail a test.
- [x] Register `sender.first_time` (low) over the view's `senderHistory`, which the Workflow's `checks` step fills from `observeSender` before the checks (corrections 2, 6, 8 and 10). Done when: a stored message through the `checks` step reads the item with its wording, From excerpt and an existing raw key, twice the same for one case, nothing for a second case from the sender; an inline forward, a headerless upload and an invalid or doubled From give no item and no row; an oversized display name keeps the item. (**Corrected 2026-10-30**, at start and plan review.) Done 2026-10-30: `firstTimeEvidence` in `src/checks/sender.ts`, `senderHistory` on `CaseView` filled in the `checks` step; `test/checks/first-time.test.ts` (8 tests); 502 tests across checks, pipeline, intake and mail pass.
- [x] Commit: `checks: first-time sender per organisation` Done 2026-10-30: 0386377.

**Test checkpoint:** `pnpm exec vitest run test/checks/first-time.test.ts` passes.

> **Verified:** 2026-10-30 | §5 | 915bbb712e2d57297767bdeda462a49948189bcf
> **Review:** `docs/reviews/d02-t02-s5.json`

## 6. Receiving chains behind a filtering gateway

> **Started:** 2026-11-01T01:13Z

Filed 2026-10-30 from D02 T02 §1's completion review (Part 1 item 12): receivers are learned from MX, so an organisation whose MX points at a filtering gateway (a security service in front of Microsoft 365 or Google, a configuration Microsoft documents as "enhanced filtering for connectors") has only the gateway learned. The mailbox provider's own hops then sit above the gateway's at the top of the message, outside every learned receiver, so `trustedAuthResults` in `src/checks/auth-results.ts` finds no boundary and neither system's results are used. Widening automatic trust would let a sender's headers through; the chain has to be verified. The same holds inside a receiver other than Microsoft 365 or Google (widened 2026-10-30 from §1's rounds 2 to 4): neither a hop's greeting name nor a private connecting address proves a hop is the receiver's own (a proxy hides the peer), so §1 trusts such a receiver's headers only above the message's topmost `Received`, and one that writes its header lower down, between its own hops, is not trusted until its internal chain is verified here.

**Corrected 2026-10-31** (at start, checked against `src/checks/auth-results.ts`, `src/auth/receivers.ts` and `src/db/migrations/0034_org_receivers.sql`): (1) the decision item is narrowed to what can be proven: a hop's `from` name is the connecting host's greeting, which the sender writes (§1 round 2), and a sender can connect to the mailbox provider directly and skip the gateway, so a chain is proven only by the connecting address the provider itself records in its topmost hop (`from <greeting> (<address>)`), matched against the addresses the gateway's own MX hosts resolve to over DNS-over-HTTPS; a greeting name, an `X-` header, or the provider's `authserv-id` is never evidence; the design in `docs/specs/2026-10-31-receiving-chains-design.md` records this, the default chosen (learn from the organisation's own forwarded originals, the evidence `case_views` already hold, against forwarding-only connector settings the product cannot read), its reversal cost, and how a stale chain is noticed (the gateway's receivers relearned with different hosts, or `RECEIVERS_STALE_MS` passed without the chain seen again, drops it); (2) the chain is stored in a new table `org_receiving_chains` (claim, gateway pattern, provider kind, learned_at, last seen), bound to the verified claim as `org_receivers` is, as migration `0059_org_receiving_chains.sql` (the coordinator's number, 2026-10-31), its claim a foreign key to `org_domains` that cascades on delete; (3) with a chain stored, `trustedAuthResults` treats the provider's hops above the gateway's as the receiver's zone only when the provider's topmost hop's connecting address is one of the gateway's: the provider's topmost stamp is then trusted under §1's rules for Microsoft 365 and Google; a message delivered to the provider directly (its connecting address not the gateway's) keeps today's `no-boundary`; (4) correction 3 covers Microsoft 365 and Google behind a gateway, the case the section was filed for; a receiver other than those two writing its header between its own hops stays untrusted, since nothing it writes can be proven to be its own: struck from this section with that reason and filed through `add-todo` if its completion review shows a source for the proof.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/02-checks/D02-T02-s6.md`; corrections 1 and 3 refined): (5) the provider's ingress hop is not its topmost: Microsoft 365 writes internal hops above its external receipt and Google address-only ones, so the selector walks the provider's own hops down (hosts its patterns cover, `*.prod.outlook.com` among them, and address literals) to the first hop whose `by` is the provider's and whose connecting address is outside it; that hop's parenthesised address (IPv4, IPv6, or bracketed `[IPv6:...]`) is the ingress address; a provider zone with no such hop, or that hop without an address, is unprovable, never a bypass; the fixtures are realistic multi-hop Microsoft 365 and Google traces, with an IPv6 ingress and one without an address; (6) the gateway's sending addresses are not its MX addresses: a chain's addresses are the gateway's MX hosts' A and AAAA records and the addresses its sending domain publishes in SPF (`v=spf1` of the MX hosts' registrable domain, `ip4`, `ip6`, `a`, `mx` and `include` followed within RFC 7208's limit of 10 DNS lookups, section 4.6.4), the source Google's inbound-gateway settings take as configured ranges; a fixture has a gateway receiving on one address and sending from another; a vendor that publishes no SPF for its relays is unprovable here, its ranges' source decided in §9; (7) the production path: in the checks step (`src/pipeline/analysis-workflow.ts`, beside `receiversForOrg`), when the organisation has an `other` receiver and the case's provider ingress hop is found, its address is matched against the gateway's addresses (looked up as correction 9 bounds them) and a proven chain is stored for the claim whose receiver the gateway is; the frozen view carries `tenant.chains` (`{ gateway: pattern, provider: kind, addresses }[]`, read from `org_receiving_chains` and the address cache); `trustedAuthResults` and `receiverZone` both take the chains, so `auth.results`, the alignment check (§2) and `arcVerdict` (§3, `src/checks/arc.ts`) read the same boundary; a Workflow test runs one case that proves a chain, reads the row back, runs a second case that uses it, and reads the second case's stored `auth.results` evidence trusted; (8) lifecycle: `last_seen` is refreshed only by a case whose ingress hop's date is later than it (a replayed old case renews nothing); tests drop a chain past `RECEIVERS_STALE_MS`, when the gateway's receivers are learned again without its pattern, and with its claim's deletion (cascade), refuse a chain whose claim was removed while it was learned, refuse one after a domain is deleted and added again unverified, keep one organisation's chain from another's cases, and each is shown on the next case's selection, not only the rows; (9) lookups are bounded: at most 10 DNS lookups per gateway per case, each `MX_DEADLINE_MS`, answers validated (an address parses as IPv4 or IPv6, a CIDR's prefix within range), the gateway's addresses cached in the chain row with when they were fetched and used for 24 hours; a lookup that fails or times out gives `untrusted: "chain-unverified"`, a new `Untrusted` reason distinct from `no-boundary` (a proven bypass), stored in the evidence, and the next case retries; tests read each of the two reasons back from stored evidence.

**Corrected 2026-10-31** (at build): (10) the provider's ingress hop is found by the host it receives on (Exchange Online Protection's `*.mail.protection.outlook.com`, Gmail's `mx.google.com`), the topmost such hop, every hop above it the provider's own; correction 5's walk past hops by greeting name would let a forged greeting extend it, and a receiving host cannot be forged above the provider's real ingress; (11) a proven chain reads the message with the provider alone as its receiver, so its zone ends at the gateway's hop and a provider-shaped header below the gateway is refused even when the provider wrote no stamp; (12) the design is `docs/specs/2026-10-31-receiving-chains-design.md` (c93783e3); the storage item's tests are in `test/auth/receiving-chains.test.ts`, beside `test/auth/receivers.test.ts`.

**Corrected 2026-10-31** (from the completion review, `docs/reviews/02-checks/D02-T02-s6.md`; corrections 6 to 9 refined): (13) a chain is learned only from a case forwarded by email, never an upload; (14) the gateway's addresses are rules in RFC 7208's evaluation order with their qualifiers kept (`src/checks/receiving-chain.ts` `gatewayAddress`), so a neutral, failing or excluded address is never the gateway's and `+all` proves nothing; (15) the case that first proved a chain (`learned_case`) reads without it on a retry; (16) rules stay fresh a day for learning as for reading, with no DNS, and one budget of 10 lookups and two lookups' time covers a case's gateways together; (17) discovery left incomplete (a failed lookup, a limit, more than 256 rules) stores the chain `unverified`, read as `chain-unverified`; (18) an ingress hop with no valid date, or one more than a day ahead, teaches nothing.

**Corrected 2026-10-31** (from round 1, `docs/reviews/02-checks/D02-T02-s6.md`; corrections 1, 7, 8, 13, 15 and 18 replaced, 14 refined): (19) a chain is read from the organisation's own DNS, never learned from a message: round 1 showed a member's forward can carry a crafted file as its original, so learning from originals (the first design) let one member set trust for every later case; the gateway is the verified claim's MX, the provider is what the claimed domain's records name (Microsoft 365's `MS=ms` verification record or its SPF include `spf.protection.outlook.com`, Google Workspace's SPF include `_spf.google.com`), read in `chainsForOrg` (`src/auth/receiving-chains.ts`) before the view is frozen; each message is still judged by its own provider ingress hop and the gateway's rules (correction 3); there is no learning step, no `learned_case`, no `last_seen` and no date rule; the first message received through the gateway is trusted; (20) a chain is `proven` only from complete discovery, its rules stored with the time they were read and that time written only by a discovery; (21) an `include` keeps its own qualifier (`-include:x` excludes what x passes, RFC 7208 5.2); (22) the design is rewritten in `docs/specs/2026-10-31-receiving-chains-design.md`, and the section filed for a chain proven at onboarding (D01 T01 §22, filed earlier this day from the completion review) is removed unbuilt, since the first message is now trusted.

**Corrected 2026-10-31** (from rounds 2 to 4; the SPF reader re-thought after three rounds of patches): (23) the gateway's SPF is evaluated strictly and fail-closed (`gatewayRules` in `src/auth/receiving-chains.ts`): every term is checked against RFC 7208's grammar, and anything not fully understood makes discovery incomplete, so the chain is unverified, never proven: two records for one domain, an include or redirect whose domain has none, an invalid address or prefix, an unknown mechanism, a macro, `exists`, `ptr`, `+all`, a loop; a repeated include is evaluated again with its exclusions; every node and every DNS-querying term counts toward the limits, cached or not, and traversal stops at once past them.

**Corrected 2026-11-01** (second plan review, P2): (18) an unverified chain says why, because retrying cures one cause and not the other: `unavailable` when a DNS question failed or was cut by the case's limits (the next case asks again and may prove the chain), `unsupported` when the gateway's SPF record can never be read completely here (a construct this reader does not evaluate, an over-long or looping include chain, more rules or lookups than the limits allow, an address it cannot parse); `unsupported` wins when both were seen. The reason is persisted on the chain row (`org_receiving_chains.reason`, null for a proven chain, migration 0059 edited in place since it is not yet on main), carried on the chain (`unverified: "unavailable" | "unsupported"`) and shows as two untrusted states of the authentication result: `chain-unverified` keeps its meaning (the gateway's addresses could not be looked up this time) and `chain-unsupported` says the gateway's SPF record uses something IsItLegit does not read, so the provider's header is not trusted until the address list is stated another way (the limitation is D02 T02 §9's relay ranges from configuration). Done when: `test/auth/receiving-chains.test.ts` reads both reasons back from the stored rows (a failed lookup is `unavailable`; `exists`, a macro, `+all`, a loop and an over-limit chain are `unsupported`; both together is `unsupported`), `test/pipeline/receiving-chain.test.ts` reads each through the checks step into `auth.results` evidence with its own wording, and `test/checks/auth-results.test.ts` has both summaries. The card's words for `chain-unsupported` are the app lane's, filed with D07 T03 §45.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Learn a verified receiving chain. Done when: an organisation's chain (gateway, then mailbox provider) is stored only from evidence the organisation's own mail proves, never from a guess.
2. Select across the chain. Done when: the zone runs through every hop of the chain, the provider's results are trusted, and an injected result is still refused.

- [x] Decide how a chain is proven, in `docs/specs/`: from a message the organisation forwards from its own domain to `check@` (the hops above Email Routing's are its chain), or from the provider's documented connector settings; record the choice and its reversal cost. Done when: the decision names its evidence and how a stale chain is noticed.
- [x] Store the chain beside the receivers (`org_receivers` gains the hop order, or a new table under a number the coordinator gives) and learn it as decided. Done when: `test/auth/receivers.test.ts` stores a gateway-then-Microsoft chain and a gateway-then-Google chain.
- [x] Have `trustedAuthResults` run the zone through every hop of a stored chain, trusting the mailbox provider's stamp under the rules of §1 when its topmost hop's connecting address is the gateway's (correction 3); ~~and another receiver's headers between the verified hops of its own chain~~ (struck 2026-10-31, correction 4: nothing such a receiver writes can be proven its own). Done when: `test/checks/auth-results.test.ts` trusts the provider's results behind each gateway, and refuses an injected result below the gateway's border hop, a message delivered to the provider directly (its connecting address not the gateway's), and a provider hop whose greeting names the gateway from another address.
- [x] Commit: `checks: receiving chains behind a filtering gateway`

**Test checkpoint:** `pnpm exec vitest run test/checks/auth-results.test.ts test/checks/arc.test.ts test/auth/receivers.test.ts test/auth/receiving-chains.test.ts test/pipeline/receiving-chain.test.ts` passes, with both gateway fixtures.

> **Verified:** 2026-11-01 | §6 | 5e20142133e805850d5bae6dd1aa3c88c252729a
> **Review:** `docs/reviews/d02-t02-s6.json`

## 7. First-time sender per recipient

Filed 2026-10-30 from §5's completion review (out of scope): §5 remembers a sender for the whole organisation for good, so one member's earlier check makes the sender familiar to everyone, even after a long silence. Familiarity per recipient (the member who forwarded) and a recency horizon would keep the signal where it still means something.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Decide and build the finer familiarity. Done when: a sender seen only by another member, or not for a long time, still reads as unfamiliar where the decision says it should.

- [ ] Decide, in `docs/specs/`, whether familiarity is per recipient, per organisation with a recency horizon, or both, and what the horizon is, recording the choice and its reversal cost. Done when: the decision is recorded.
- [ ] Extend `sender_observations` (a migration the coordinator numbers) and `observeSender` in `src/checks/senders-seen.ts` as decided, keeping one atomic classification per case. Done when: `test/checks/first-time.test.ts` covers another member's earlier case and a sender silent past the horizon.
- [ ] Commit: `checks: first-time sender per recipient`

**Test checkpoint:** `pnpm exec vitest run test/checks/first-time.test.ts` passes.

## 8. Familiarity from consented mail

Filed 2026-10-30 from §5's completion review (out of scope): IsItLegit sees only the mail members submit, so a long-standing supplier's first checked message reads as first-time. With the organisation's consent, its own mail history (for example through Microsoft Graph or Gmail's API) would say whether the organisation has corresponded with the sender before.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Design consented history and use it. Done when: an organisation that consents has familiarity from its own mail, and one that does not keeps §5's behaviour.

- [ ] Write the design in `docs/specs/`: the consent, the scopes asked for, what is read (sender domains or hashes only), how long it is kept, and how consent is withdrawn and the data deleted. Done when: the design is recorded and its privacy terms checked against `docs/specs/2026-10-26-phishing-invoice-analyser-design.md`.
- [ ] File the build sections the design needs through `add-todo` (the connector in D07, the familiarity read here, and `sender.first_time`'s outcome summary naming the span of mail it read, as the Report-Safe board's "First-time sender: no, 14 months of mail", which D02 T01 §7 leaves to this section since `senderHistory` holds no span). Done when: the sections exist and resolve.
- [ ] Commit: `docs: consented mail history for sender familiarity`

**Test checkpoint:** `python3 scripts/todo-graph.py validate` passes with the filed sections.

## 9. Gateway relay ranges, decided

> **Started:** 2026-11-04T07:14:39+00:00

Filed 2026-10-31 from §6's completion review (Part 2 item 2, out of scope): §6 proves a gateway's relays from the addresses its sending domain publishes in SPF, so a gateway whose relay addresses are not in that SPF cannot be proven, where Microsoft 365's enhanced filtering and Google's inbound-gateway setting take the gateway's ranges as configured. Taking ranges from the organisation, or reading its provider's connector settings, changes who states the trust and what the product reads, so it is a design decision first.

**Phase:** 7
**Operator decision 2026-11-02:** Admin-entered ranges, verified and revocable, as the design's source.

**Needs:** none
**Surface:** no

**Plan review corrections 2026-11-04:** `docs/reviews/02-checks/D02-T02-s9.md` identified missing lifecycle ownership and a non-falsifiable design coverage gate. The design must map every requirement to a resolving section and a concrete acceptance test, including admin entry/edit/removal, validation and verification failure, persistence/read-back, `chainsForOrg` consumption, SPF precedence and immediate invalidation of cached configured trust on edit or revocation. Cross-lane surface ownership is assigned by the coordinator before completion.

**Coordinator disposition 2026-11-04:** coordinator-delivery-decisions approved the independent-source/revision design and allocated migration0094; budget-and-ownership-correction approved console D07 T04 §37 and D07 T05 §6 and their scoped treatment, filed at20f4747f. The design maps both pinned contracts and local lifecycle/consumer sections to falsifiable tests. This is design coverage only; backend, surfaces and consumer remain unstamped implementation work.

**Build order:**

1. Decide where a gateway's relay ranges come from when its SPF does not name them. Done when: a dated design in `docs/specs/` names the source (ranges an organisation admin enters, read from the provider's connector settings, or neither), how they are verified and revoked, and the sections that build it, approved by the operator.

- [x] Write the design in `docs/specs/YYYY-MM-DD-gateway-relay-ranges-design.md` from `docs/specs/2026-10-31-receiving-chains-design.md` and §6's `org_receiving_chains`. Done when: the operator's approval is recorded in it, with a synthetic gateway whose ingress and egress differ and whose relays no SPF names.
- [x] File the complete lifecycle sections through `add-todo`. Done when: admin entry/edit/removal, validation and verification failures, persisted read-back and `chainsForOrg` consumption each have a resolving owner dependent on this section; cross-lane assignments come from the coordinator. Cheaper substitute: a broad implementation placeholder leaves required behavior unowned.
- [x] Map each design requirement in `docs/specs/2026-11-04-gateway-relay-ranges-design.md` to its implementation section and falsifiable acceptance test. Done when: the review checks the mapping against the filed contracts, including a no-SPF relay accepted only after verification, explicit SPF precedence, and edit/revocation removing cached configured trust. Cheaper substitute: graph validation alone cannot prove coverage.
- [x] Commit: `docs: gateway relay ranges from configuration decided`

**Test checkpoint:** `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass with the filed sections; final completion self-review verifies every design requirement maps to a resolving implementation section and a falsifiable test, including verified no-SPF success and cached-trust removal after edit/revocation.

> **Verified:** 2026-11-04 | §9 | d817e025a1cb7f7ed2f7d329715ea6286353f89a
> **Review:** `docs/reviews/d02-t02-s9.json`

## 10. Configured relay revision lifecycle

Implement the configuration service designed in `docs/specs/2026-11-04-gateway-relay-ranges-design.md`. This section owns storage and service authorization; the coordinator assigns the member and platform review surfaces before §9 closes. Obtain a migration number from the coordinator before writing a migration. Do not modify console routes owned by another lane.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Define immutable proposals and current revisions in `src/auth/relay-ranges.ts` and a coordinator-numbered migration in `src/db/migrations/`. Done when: schema validation, tenancy and verified-claim binding are exercised by `test/auth/relay-ranges.test.ts`.
2. Implement the lifecycle service in `src/auth/relay-ranges.ts`. Done when: proposal, exact-revision review, edit, revoke, restore automatic discovery and read-back are authorized, atomic, idempotent and audited.
3. Prove refusals and races in `test/auth/relay-ranges.test.ts`. Done when: stale writes and late verification after claim removal cannot restore trust or lose another revision.

- [ ] Define strict CIDR proposal validation in `src/auth/relay-ranges.ts`. Done when: canonical public IPv4/IPv6 networks round-trip, malformed networks, host bits, zero prefixes, reserved-space overlap and more than 64 CIDRs fail; exact duplicates are deduplicated. Cheaper substitute: syntactic parsing alone accepts dangerously broad ranges. Source: §9's configured-range design, Configuration lifecycle.
- [ ] Add revision persistence in a coordinator-numbered migration under `src/db/migrations/`. Done when: configured records are separate from `org_receiving_chains`, tenant/claim scoped, cascade on claim deletion and cannot reference an unverified claim through the service. Cheaper substitute: writing configuration into the discovery cache loses source ownership. Source: §9's design, Owning layer and Configuration lifecycle.
- [ ] Implement proposal/read-back and exact-revision platform review in `src/auth/relay-ranges.ts`. Done when: an organisation admin can propose only for its verified binding, only the independent platform role can approve/reject, and the stored source URL/digest/retrieval date and actors are required for approval; arbitrary submitted evidence never auto-verifies. Cheaper substitute: a client-supplied verified flag creates trust without proof. Source: §9's design, Trust source.
- [ ] Implement transactional edit/revoke/restore in `src/auth/relay-ranges.ts`. Done when: edit retires the old verified revision immediately, revoke is idempotent, restore invalidates discovery before fresh lookup, and each accepted operation returns stored state and one audit event; conflicting retries fail. Cheaper substitute: deleting a UI row leaves cached trust active. Source: §9's design, Consumption and revocation.
- [ ] Add conflict, failure and deletion tests in `test/auth/relay-ranges.test.ts`. Done when: cross-tenant access, tenant self-approval, stale editor/reviewer, DB failure, claim deletion/unverification, tenant closure and late approval are all refused without partial state; a valid lifecycle and duplicate retry are proven against D1. Cheaper substitute: mocked return values do not prove persistence or atomicity. Source: §9's design, Configuration lifecycle.
- [ ] Commit: `feat: store and govern configured relay revisions`

**Test checkpoint:** `pnpm exec vitest run test/auth/relay-ranges.test.ts` passes, including the invalid-range, cross-tenant, exact-review, idempotency, rollback and claim-removal cases above; `pnpm typecheck` passes.

## 11. Configured relay trust consumption

Consume §10's current revision in `src/auth/receiving-chains.ts`, preserving the existing provider ingress boundary and deterministic verdict floor. Configuration is authoritative for its tuple only while verified and current; pending/rejected/revoked overrides block fallback until the admin explicitly restores automatic discovery. Source: `docs/specs/2026-11-04-gateway-relay-ranges-design.md`.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Load the current configured revision in `src/auth/receiving-chains.ts`. Done when: tests prove scoped exclusive precedence, fail-closed errors and no cached configured rules.
2. Carry the configuration revision through `src/pipeline/analysis-workflow.ts` at the checks evidence persistence boundary. Done when: an edit/revoke between snapshot and save forces fresh checks before authentication evidence is published.
3. Exercise the synthetic no-SPF gateway in `test/auth/relay-range-consumption.test.ts`. Done when: verification enables the exact egress peer and revocation disables it, including a matching old SPF cache and a concurrent revocation.

- [ ] Read current overrides in `src/auth/receiving-chains.ts`. Done when: only verified active revisions for the current org, still-verified claim, gateway and provider produce trusted ranges, and all other explicit states or read failures return unverified without discovered fallback. Cheaper substitute: using the 24-hour cache delays revocation. Source: §9's design, Consumption.
- [ ] Apply exclusive source precedence in `src/checks/receiving-chain.ts` through the assembled chain. Done when: a verified override replaces discovered rules for its tuple, an outside peer fails, and existing provider ingress and lower-header forgery tests still pass. Cheaper substitute: unioning configured and SPF addresses silently broadens trust. Source: §9's design, Consumption.
- [ ] Bind checks evidence persistence to the current configuration revision in `src/pipeline/analysis-workflow.ts`. Done when: a version mismatch before authentication evidence storage retries under current state; evidence records the source revision and completed historical reports retain truthful provenance. Cheaper substitute: checking only when the view is first built misses revocation races. Source: §9's design, Revocation.
- [ ] Add no-SPF and cache/race coverage in `test/auth/relay-range-consumption.test.ts`. Done when: synthetic ingress `192.0.2.10` and egress `198.51.100.7` differ, no SPF names the egress, pending fails, verified succeeds, edit/revoke fails even against cached discovery, and restore automatic still fails for that peer; a test-only fixture adapter admits documentation IPs without weakening production validation. Cheaper substitute: a single happy-path address test cannot prove revocation. Source: §9's design, Synthetic acceptance example.
- [ ] Add isolation and failure coverage in `test/auth/relay-range-consumption.test.ts`. Done when: foreign tenant, removed or unverified claim, changed gateway/provider, configuration read failure and concurrent revision changes cannot confer configured trust; `test/pipeline/receiving-chain.test.ts` retains its existing forged-header and ingress cases. Cheaper substitute: response-only assertions miss stale persisted evidence. Source: §9's design, Requirement coverage.
- [ ] Commit: `feat: consume verified relay ranges without stale trust`

**Test checkpoint:** `pnpm exec vitest run test/auth/relay-range-consumption.test.ts test/pipeline/receiving-chain.test.ts` passes with the no-SPF, precedence, cache and in-flight revocation tests; `pnpm typecheck` passes.

## Verification

- Header and sender fixtures produce exactly the expected evidence with header excerpts; forged headers are never trusted.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
